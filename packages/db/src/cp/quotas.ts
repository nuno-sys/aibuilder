import { assertSingleChange } from '../batch';
import { toArrayBuffer } from '../bytes';
import type {
  AbuseEventUlid,
  AbuseKind,
  AbuseSeverity,
  AbuseSubjectType,
  OrganisationId,
  SiteId,
  Timestamp,
} from '../types';

/**
 * Control-plane limits and ops signals.
 *
 * WHAT IS NOT HERE, deliberately:
 *
 *   - Per-request and per-IP rate limiting. That is the Workers Rate Limiting binding. A
 *     write-per-request into a replicated SQLite database is an architecture bug, not a rate
 *     limiter, and D1 is single-threaded on writes.
 *   - Strongly-consistent spend and quota accounting. That is `QuotaDO` and `BudgetDO`. Money needs
 *     a strongly-consistent primitive, and a read replica is not one.
 *
 * What IS here: the durable entitlement-shaped limits (how many sites may this organisation own),
 * and the append-only signals that feed the daily abuse digest.
 */

/**
 * Site count against `organisations.sites_limit`.
 *
 * Counts live sites only: a soft-deleted site still reserves its slug but must not consume the
 * customer's allowance, because the alternative is a support ticket every time someone deletes and
 * recreates a site.
 */
export const SQL_COUNT_LIVE_SITES_FOR_ORG = `
SELECT count(*) AS n FROM live_sites WHERE org_id = ?1
`;

/** Counts an organisation's live sites. */
export async function countLiveSitesForOrg(db: D1Database, orgId: OrganisationId): Promise<number> {
  const row = await db.prepare(SQL_COUNT_LIVE_SITES_FOR_ORG).bind(orgId).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Site allowance and current usage in one read, for the "add a site" gate. */
export const SQL_GET_SITE_ALLOWANCE = `
SELECT o.sites_limit AS site_limit,
       (SELECT count(*) FROM live_sites s WHERE s.org_id = o.id) AS used
FROM organisations o
WHERE o.id = ?1 AND o.deleted_at IS NULL
`;

/** An organisation's site allowance and how much of it is used. */
export interface SiteAllowance {
  readonly site_limit: number;
  readonly used: number;
}

/** Reads the site allowance. `null` when the organisation is gone. */
export async function getSiteAllowance(
  db: D1Database,
  orgId: OrganisationId,
): Promise<SiteAllowance | null> {
  return db.prepare(SQL_GET_SITE_ALLOWANCE).bind(orgId).first<SiteAllowance>();
}

/**
 * Records an abuse signal.
 *
 * `subject_hash` is sha256(subject || daily_salt) — pseudonymous personal data, treated as such in
 * the ROPA and in the generated privacy policy. The salt rotates daily with two retained for
 * lookback, which is what bounds how long a signal stays correlatable.
 */
export const SQL_INSERT_ABUSE_EVENT = `
INSERT INTO abuse_events (ulid, kind, severity, subject_type, subject_hash, site_id, org_id,
                          detail, created_at, purge_after)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
`;

/** Inserts one abuse event. */
export async function insertAbuseEvent(
  db: D1Database,
  args: {
    readonly ulid: AbuseEventUlid;
    readonly kind: AbuseKind;
    readonly severity: AbuseSeverity;
    readonly subjectType: AbuseSubjectType;
    readonly subjectHash: Uint8Array;
    readonly siteId: SiteId | null;
    readonly orgId: OrganisationId | null;
    readonly detail: string | null;
    readonly now: Timestamp;
    readonly purgeAfter: Timestamp;
  },
): Promise<void> {
  const result = await db
    .prepare(SQL_INSERT_ABUSE_EVENT)
    .bind(
      args.ulid,
      args.kind,
      args.severity,
      args.subjectType,
      toArrayBuffer(args.subjectHash),
      args.siteId,
      args.orgId,
      args.detail,
      args.now,
      args.purgeAfter,
    )
    .run();
  assertSingleChange(result.meta, 'insertAbuseEvent');
}

/**
 * How many signals a subject has produced since `since`, restricted to a severity set.
 *
 * The escalation input for the funnel: a subject that keeps failing Turnstile or tripping the
 * policy screen gets a harder gate, not merely another log line. Durable, and asked once per
 * expensive operation rather than per request.
 *
 * The severities arrive as a JSON array in ONE bound parameter rather than as a `severity >= ?`
 * comparison. `severity` is TEXT, and TEXT ordering sorts them `'block' < 'info' < 'warn'` — a
 * threshold comparison would silently count the wrong rows in the one query whose job is to decide
 * whether to block somebody.
 */
export const SQL_COUNT_RECENT_ABUSE_FOR_SUBJECT = `
SELECT count(*) AS n FROM abuse_events
WHERE subject_type = ?1 AND subject_hash = ?2 AND created_at >= ?3
  AND severity IN (SELECT value FROM json_each(?4))
`;

/** Counts a subject's recent abuse signals whose severity is in `severities`. */
export async function countRecentAbuseForSubject(
  db: D1Database,
  args: {
    readonly subjectType: AbuseSubjectType;
    readonly subjectHash: Uint8Array;
    readonly since: Timestamp;
    readonly severities: readonly AbuseSeverity[];
  },
): Promise<number> {
  if (args.severities.length === 0) {
    return 0;
  }
  const row = await db
    .prepare(SQL_COUNT_RECENT_ABUSE_FOR_SUBJECT)
    .bind(
      args.subjectType,
      toArrayBuffer(args.subjectHash),
      args.since,
      JSON.stringify(args.severities),
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Deletes abuse events past their retention deadline, in chunks. */
export const SQL_PURGE_ABUSE_EVENTS = `
DELETE FROM abuse_events
WHERE id IN (SELECT id FROM abuse_events WHERE purge_after < ?1 ORDER BY purge_after LIMIT ?2)
`;

/** Purges a chunk of expired abuse events and returns how many were removed. */
export async function purgeAbuseEvents(
  db: D1Database,
  args: { readonly before: Timestamp; readonly limit: number },
): Promise<number> {
  const result = await db.prepare(SQL_PURGE_ABUSE_EVENTS).bind(args.before, args.limit).run();
  return result.meta.changes;
}

/**
 * Records a CSP violation, aggregated.
 *
 * One row per (host, directive, blocked uri) with a counter, never one row per report. A report
 * endpoint is an unauthenticated write amplifier: a single misbehaving browser extension emits
 * thousands of identical reports per page view, and the row-per-report design fills the control
 * plane with someone else's ad blocker.
 */
export const SQL_UPSERT_CSP_REPORT = `
INSERT INTO csp_reports (host, violated_directive, blocked_uri, effective_directive, disposition,
                         document_uri, script_sample, occurrences, first_seen_at, last_seen_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8)
ON CONFLICT(host, violated_directive, blocked_uri) DO UPDATE SET
  occurrences  = occurrences + 1,
  last_seen_at = excluded.last_seen_at,
  document_uri = coalesce(csp_reports.document_uri, excluded.document_uri)
`;

/** Records or increments one CSP violation. */
export async function upsertCspReport(
  db: D1Database,
  args: {
    readonly host: string;
    readonly violatedDirective: string;
    readonly blockedUri: string;
    readonly effectiveDirective: string | null;
    readonly disposition: 'enforce' | 'report';
    readonly documentUri: string | null;
    readonly scriptSample: string | null;
    readonly now: Timestamp;
  },
): Promise<void> {
  const result = await db
    .prepare(SQL_UPSERT_CSP_REPORT)
    .bind(
      args.host,
      args.violatedDirective,
      args.blockedUri,
      args.effectiveDirective,
      args.disposition,
      args.documentUri,
      args.scriptSample,
      args.now,
    )
    .run();
  assertSingleChange(result.meta, 'upsertCspReport');
}
