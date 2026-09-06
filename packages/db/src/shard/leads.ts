import { assertSingleChange, changedOne } from '../batch';
import { toArrayBuffer } from '../bytes';
import type {
  LeadId,
  LeadKind,
  LeadRow,
  LocaleCode,
  OrganisationId,
  SiteId,
  Timestamp,
} from '../types';

/**
 * Statements over `leads`.
 *
 * `leads` and `audit_log` are the two tables that decide a shard's real runway, so both carry a
 * NOT NULL `purge_after` and both have a purge cron from day one — a retention column nothing reads
 * is not a retention policy.
 *
 * ERASURE IS A FIRST-CLASS OPERATION here, not an afterthought: a GDPR Article 17 request names an
 * e-mail address or a phone number, and `idx_leads_email` / `idx_leads_phone` exist so answering one
 * is a seek rather than a full scan of the largest table in the database. `ip_hash` is
 * sha256(ip || daily_salt) and is treated as PSEUDONYMOUS PERSONAL DATA in the ROPA and in the
 * generated privacy policy — the IPv4 space is small enough to brute-force against a known salt.
 */

/**
 * Records a visitor submission.
 *
 * `POST /v1/leads/:siteId` arrives from a tenant origin, so the `Origin` is looked up in the
 * per-site allowlist (`cp/sites.listSiteOrigins`) and echoed only on an exact match. Never `*`, and
 * never a regex: `/mijnsaas\.com$/` matches `evilmijnsaas.com`, which is a working CSRF against
 * every tenant at once.
 */
export const SQL_INSERT_LEAD = `
INSERT INTO leads (id, site_id, org_id, kind, locale, page_path, name, email, phone, message,
                   fields, requested_at, party_size, booking_status, spam_score, is_spam,
                   turnstile_ok, consent_at, consent_text_sha256, ip_hash, ip_country, user_agent,
                   purge_after, created_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19,
        ?20, ?21, ?22, ?23, ?24)
`;

/** Inserts a lead. 24 bound parameters, inside D1's cap of 100. */
export async function insertLead(
  db: D1Database,
  args: {
    readonly id: LeadId;
    readonly siteId: SiteId;
    readonly orgId: OrganisationId;
    readonly kind: LeadKind;
    readonly locale: LocaleCode | null;
    readonly pagePath: string | null;
    readonly name: string | null;
    readonly email: string | null;
    readonly phone: string | null;
    readonly message: string | null;
    /** JSON object of extra form fields. */
    readonly fields: string | null;
    readonly requestedAt: Timestamp | null;
    readonly partySize: number | null;
    readonly bookingStatus: 'requested' | 'confirmed' | null;
    readonly spamScore: number;
    readonly isSpam: 0 | 1;
    readonly turnstileOk: 0 | 1;
    readonly consentAt: Timestamp | null;
    readonly consentTextSha256: Uint8Array | null;
    readonly ipHash: Uint8Array | null;
    readonly ipCountry: string | null;
    readonly userAgent: string | null;
    readonly purgeAfter: Timestamp;
    readonly now: Timestamp;
  },
): Promise<void> {
  const result = await db
    .prepare(SQL_INSERT_LEAD)
    .bind(
      args.id,
      args.siteId,
      args.orgId,
      args.kind,
      args.locale,
      args.pagePath,
      args.name,
      args.email,
      args.phone,
      args.message,
      args.fields,
      args.requestedAt,
      args.partySize,
      args.bookingStatus,
      args.spamScore,
      args.isSpam,
      args.turnstileOk,
      args.consentAt,
      args.consentTextSha256 === null ? null : toArrayBuffer(args.consentTextSha256),
      args.ipHash === null ? null : toArrayBuffer(args.ipHash),
      args.ipCountry,
      args.userAgent,
      args.purgeAfter,
      args.now,
    )
    .run();
  assertSingleChange(result.meta, 'insertLead');
}

/**
 * The inbox page.
 *
 * The projection is deliberately narrow and does NOT match `idx_leads_inbox`'s columns: carrying
 * `name` (200) and `email` (320) in the index would add ~500 bytes per lead to the b-tree forever,
 * and the page fetches 25 rows — 25 table lookups are far cheaper than that payload in every entry.
 * The predicate repeats the partial index's WHERE verbatim so SQLite's prover can use it.
 */
export const SQL_LIST_LEAD_INBOX = `
SELECT * FROM leads
WHERE site_id = ?1 AND is_spam = 0 AND archived_at IS NULL AND created_at < ?2
ORDER BY created_at DESC
LIMIT ?3
`;

/** Lists a site's inbox, newest first, keyset-paginated on `created_at`. */
export async function listLeadInbox(
  db: D1Database,
  args: { readonly siteId: SiteId; readonly before: Timestamp; readonly limit: number },
): Promise<readonly LeadRow[]> {
  const result = await db
    .prepare(SQL_LIST_LEAD_INBOX)
    .bind(args.siteId, args.before, args.limit)
    .all<LeadRow>();
  return result.results;
}

/** One lead, scoped to its site so a lead id alone is never sufficient. */
export const SQL_GET_LEAD = `
SELECT * FROM leads WHERE id = ?1 AND site_id = ?2
`;

/** Reads a lead, authorised against its site. */
export async function getLead(
  db: D1Database,
  args: { readonly leadId: LeadId; readonly siteId: SiteId },
): Promise<LeadRow | null> {
  return db.prepare(SQL_GET_LEAD).bind(args.leadId, args.siteId).first<LeadRow>();
}

/** Marks a lead read. */
export const SQL_MARK_LEAD_READ = `
UPDATE leads SET read_at = ?3 WHERE id = ?1 AND site_id = ?2 AND read_at IS NULL
`;

/** Marks a lead read. Returns false when it already was. */
export async function markLeadRead(
  db: D1Database,
  args: { readonly leadId: LeadId; readonly siteId: SiteId; readonly now: Timestamp },
): Promise<boolean> {
  const result = await db
    .prepare(SQL_MARK_LEAD_READ)
    .bind(args.leadId, args.siteId, args.now)
    .run();
  return changedOne(result.meta);
}

/** Records that the owner was e-mailed about a lead. */
export const SQL_MARK_LEAD_NOTIFIED = `
UPDATE leads SET notified_at = ?2 WHERE id = ?1 AND notified_at IS NULL
`;

/**
 * Marks a lead notified.
 *
 * `AND notified_at IS NULL` is the guard that stops a retried notification cron from mailing the
 * same lead twice; `changedOne()` is how the caller knows it won the race and should actually send.
 */
export async function markLeadNotified(
  db: D1Database,
  args: { readonly leadId: LeadId; readonly now: Timestamp },
): Promise<boolean> {
  const result = await db.prepare(SQL_MARK_LEAD_NOTIFIED).bind(args.leadId, args.now).run();
  return changedOne(result.meta);
}

/** Leads awaiting an owner notification. */
export const SQL_LIST_LEADS_TO_NOTIFY = `
SELECT id, site_id, org_id, kind, created_at
FROM leads
WHERE notified_at IS NULL AND is_spam = 0 AND created_at >= ?1
ORDER BY created_at
LIMIT ?2
`;

/** Lists unnotified, non-spam leads since `since`. */
export async function listLeadsToNotify(
  db: D1Database,
  args: { readonly since: Timestamp; readonly limit: number },
): Promise<readonly Pick<LeadRow, 'id' | 'site_id' | 'org_id' | 'kind' | 'created_at'>[]> {
  const result = await db
    .prepare(SQL_LIST_LEADS_TO_NOTIFY)
    .bind(args.since, args.limit)
    .all<Pick<LeadRow, 'id' | 'site_id' | 'org_id' | 'kind' | 'created_at'>>();
  return result.results;
}

/** Deletes leads past their retention deadline, in chunks. */
export const SQL_PURGE_LEADS = `
DELETE FROM leads
WHERE id IN (SELECT id FROM leads WHERE purge_after < ?1 ORDER BY purge_after LIMIT ?2)
`;

/**
 * Purges a chunk of expired leads.
 *
 * Chunked because D1 caps a query at 30 seconds. A purge that times out half-way is not merely slow
 * — it is a retention policy that quietly stops being true above a certain volume.
 */
export async function purgeExpiredLeads(
  db: D1Database,
  args: { readonly before: Timestamp; readonly limit: number },
): Promise<number> {
  const result = await db.prepare(SQL_PURGE_LEADS).bind(args.before, args.limit).run();
  return result.meta.changes;
}

/**
 * Erasure by e-mail (GDPR Article 17).
 *
 * A hard DELETE, not an anonymisation: the columns that would remain — message body, page path,
 * timestamp — are themselves identifying in a small-business context. Runs against
 * `idx_leads_email`; without that index this is a full scan of the largest table in the shard, which
 * is how a one-month statutory deadline turns into an incident.
 */
export const SQL_ERASE_LEADS_BY_EMAIL = `
DELETE FROM leads WHERE email = ?1
`;

/** Erases every lead carrying an e-mail address. Returns how many were removed. */
export async function eraseLeadsByEmail(db: D1Database, email: string): Promise<number> {
  const result = await db.prepare(SQL_ERASE_LEADS_BY_EMAIL).bind(email).run();
  return result.meta.changes;
}

/** Erasure by phone number. Same rules as `eraseLeadsByEmail`. */
export const SQL_ERASE_LEADS_BY_PHONE = `
DELETE FROM leads WHERE phone = ?1
`;

/** Erases every lead carrying a phone number. Returns how many were removed. */
export async function eraseLeadsByPhone(db: D1Database, phone: string): Promise<number> {
  const result = await db.prepare(SQL_ERASE_LEADS_BY_PHONE).bind(phone).run();
  return result.meta.changes;
}

/**
 * Counts the leads that reached a site's inbox in a window.
 *
 * Two decisions are folded into the predicate, and both are deliberate.
 *
 * Spam is EXCLUDED. A spam flood must not consume the customer's quota or distort the "leads this
 * month" number they judge the product by; spam volume is an `abuse_events` question, asked of a
 * table built for it.
 *
 * The predicate is `idx_leads_inbox`'s WHERE clause repeated VERBATIM. SQLite's partial-index
 * prover matches on predicate text, so `AND is_spam = 0 AND archived_at IS NULL` is not redundant
 * with the index — it is the only reason this is a seek instead of a full scan of the largest table
 * in the shard. Paraphrasing it, or dropping it because "spam is rare anyway", silently costs a
 * table scan per site per billing period.
 */
export const SQL_COUNT_LEADS_FOR_SITE = `
SELECT count(*) AS n FROM leads
WHERE site_id = ?1 AND is_spam = 0 AND archived_at IS NULL AND created_at >= ?2
`;

/** Counts a site's non-spam, non-archived leads since `since`. */
export async function countLeadsForSite(
  db: D1Database,
  args: { readonly siteId: SiteId; readonly since: Timestamp },
): Promise<number> {
  const row = await db
    .prepare(SQL_COUNT_LEADS_FOR_SITE)
    .bind(args.siteId, args.since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
