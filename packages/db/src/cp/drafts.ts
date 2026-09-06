import { assertSingleChange, changedOne } from '../batch';
import { toArrayBuffer } from '../bytes';
import type {
  AnonSessionId,
  AnonSessionRow,
  ClaimTokenId,
  DraftId,
  GenerationJobId,
  LocaleCode,
  OnboardingDraftRow,
  OrganisationId,
  PolicyScreen,
  ShardId,
  SiteClaimTokenRow,
  SiteId,
  Timestamp,
} from '../types';

/**
 * Statements over `anon_sessions`, `onboarding_drafts` and `site_claim_tokens` — the pre-account
 * half of onboarding.
 *
 * `onboarding_drafts` is also the Phase 1 system of record for the business facts (see the WHY THE
 * FACTS LIVE HERE note in `migrations/cp/0005_drafts_claims.sql`), which is why the autosave
 * statement below writes typed columns rather than a JSON blob: the `phone_e164` CHECK is what
 * makes §4 invariant 2 — "`tel:` and `wa.me` hrefs are built by code from the CHECK-constrained
 * column" — true rather than aspirational.
 */

/** Creates the anonymous session behind the `__Host-aib_draft` cookie. */
export const SQL_INSERT_ANON_SESSION = `
INSERT INTO anon_sessions (token_hash, id, ip_hash, ip_country, user_agent,
                           created_at, last_seen_at, expires_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)
`;

/** Inserts an anonymous session. Only the cookie token's hash is stored. */
export async function insertAnonSession(
  db: D1Database,
  args: {
    readonly tokenHash: Uint8Array;
    readonly id: AnonSessionId;
    readonly ipHash: Uint8Array | null;
    readonly ipCountry: string | null;
    readonly userAgent: string | null;
    readonly now: Timestamp;
    readonly expiresAt: Timestamp;
  },
): Promise<void> {
  const result = await db
    .prepare(SQL_INSERT_ANON_SESSION)
    .bind(
      toArrayBuffer(args.tokenHash),
      args.id,
      args.ipHash === null ? null : toArrayBuffer(args.ipHash),
      args.ipCountry,
      args.userAgent,
      args.now,
      args.expiresAt,
    )
    .run();
  assertSingleChange(result.meta, 'insertAnonSession');
}

/** Resolves the draft cookie to its anonymous session. */
export const SQL_GET_ANON_SESSION = `
SELECT * FROM anon_sessions WHERE token_hash = ?1 AND revoked_at IS NULL AND expires_at > ?2
`;

/** Reads a live anonymous session by token hash. */
export async function getAnonSession(
  db: D1Database,
  args: { readonly tokenHash: Uint8Array; readonly now: Timestamp },
): Promise<AnonSessionRow | null> {
  return db
    .prepare(SQL_GET_ANON_SESSION)
    .bind(toArrayBuffer(args.tokenHash), args.now)
    .first<AnonSessionRow>();
}

/**
 * Creates a draft.
 *
 * `idempotency_key` is minted by the caller with a CSPRNG and is NEVER returned to or accepted from
 * the client (architecture §S4). `shard_id` is assigned here, before an organisation exists,
 * because media uploads are committed to a shard during step 4 of the modal; the organisation
 * created at submit inherits this value.
 */
export const SQL_INSERT_DRAFT = `
INSERT INTO onboarding_drafts (id, anon_session_id, shard_id, ui_locale, idempotency_key,
                               turnstile_verified_at, ip_hash, ip_country,
                               created_at, updated_at, purge_after)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10)
`;

/** Inserts a draft owned by an anonymous session. */
export async function insertDraft(
  db: D1Database,
  args: {
    readonly id: DraftId;
    readonly anonSessionId: AnonSessionId;
    readonly shardId: ShardId;
    readonly uiLocale: LocaleCode;
    readonly idempotencyKey: string;
    readonly turnstileVerifiedAt: Timestamp | null;
    readonly ipHash: Uint8Array | null;
    readonly ipCountry: string | null;
    readonly now: Timestamp;
    readonly purgeAfter: Timestamp;
  },
): Promise<void> {
  const result = await db
    .prepare(SQL_INSERT_DRAFT)
    .bind(
      args.id,
      args.anonSessionId,
      args.shardId,
      args.uiLocale,
      args.idempotencyKey,
      args.turnstileVerifiedAt,
      args.ipHash === null ? null : toArrayBuffer(args.ipHash),
      args.ipCountry,
      args.now,
      args.purgeAfter,
    )
    .run();
  assertSingleChange(result.meta, 'insertDraft');
}

/**
 * The cookie-authenticated draft read.
 *
 * Scoped by `anon_session_id` and not only by `id`, so possession of a draft id is never on its own
 * sufficient to read someone's business name, address, phone and e-mail. `GET /v1/bootstrap` must
 * not return this at all — it is `public, max-age=3600` and would serve one visitor's PII to the
 * next from any shared cache (architecture §S4).
 */
export const SQL_GET_DRAFT_FOR_SESSION = `
SELECT * FROM onboarding_drafts WHERE id = ?1 AND anon_session_id = ?2
`;

/** Reads a draft, authorised against the anonymous session that owns it. */
export async function getDraftForSession(
  db: D1Database,
  args: { readonly draftId: DraftId; readonly anonSessionId: AnonSessionId },
): Promise<OnboardingDraftRow | null> {
  return db
    .prepare(SQL_GET_DRAFT_FOR_SESSION)
    .bind(args.draftId, args.anonSessionId)
    .first<OnboardingDraftRow>();
}

/** The most recent draft of an anonymous session, for resume-without-a-draft-id. */
export const SQL_GET_LATEST_DRAFT_FOR_SESSION = `
SELECT * FROM onboarding_drafts WHERE anon_session_id = ?1 ORDER BY updated_at DESC LIMIT 1
`;

/** Reads the newest draft belonging to an anonymous session. */
export async function getLatestDraftForSession(
  db: D1Database,
  anonSessionId: AnonSessionId,
): Promise<OnboardingDraftRow | null> {
  return db
    .prepare(SQL_GET_LATEST_DRAFT_FOR_SESSION)
    .bind(anonSessionId)
    .first<OnboardingDraftRow>();
}

/** The intake fields the modal autosaves. Every one is nullable; a draft is partial by definition. */
export interface DraftIntakePatch {
  readonly step: number;
  readonly furthestStep: number;
  readonly businessName: string | null;
  readonly slug: string | null;
  readonly industryKey: string | null;
  readonly defaultLocale: LocaleCode | null;
  /** JSON array of locale codes, or `null`. Phase 1 allows at most one entry. */
  readonly extraLocales: string | null;
  readonly serviceAreaCity: string | null;
  readonly serviceAreaRadiusKm: number | null;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly postalCode: string | null;
  readonly city: string | null;
  readonly country: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly geoSource: 'none' | 'geocoded' | 'user_pin';
  /** JSON `OpeningHours`, or `null`. */
  readonly openingHours: string | null;
  readonly phoneE164: string | null;
  readonly whatsappE164: string | null;
  readonly gbpUrl: string | null;
  readonly shortDescription: string | null;
  readonly contactEmail: string | null;
  readonly marketingOptIn: 0 | 1;
  /** JSON array of `med_…` ids, or `null`. Capped at 12 by the column CHECK. */
  readonly mediaIds: string | null;
}

/**
 * Autosave. Writes the WHOLE intake, guarded by the caller's view of `updated_at`.
 *
 * Deliberately not a per-field UPDATE. `PUT /v1/drafts/me` carries `Partial<Intake>`, and the API
 * loads the row, merges, and writes it back through this one statement, which buys three things a
 * dynamically-assembled SET list cannot:
 *
 *   - The statement text is constant, so the EXPLAIN QUERY PLAN gate can see it.
 *   - Clearing a field is expressible. A COALESCE-style partial update can only ever set values,
 *     so "I deleted my second address line" would silently not save.
 *   - `AND updated_at <= ?N` is optimistic concurrency: a second tab that autosaves a stale copy
 *     changes zero rows, and `updateDraftIntake` returns false so the route can answer 409 with the
 *     server's copy rather than silently losing the newer edit.
 *
 * 29 bound parameters, comfortably inside D1's cap of 100.
 */
export const SQL_UPDATE_DRAFT_INTAKE = `
UPDATE onboarding_drafts
SET step = ?3, furthest_step = ?4, business_name = ?5, slug = ?6, industry_key = ?7,
    default_locale = ?8, extra_locales = ?9, service_area_city = ?10, service_area_radius_km = ?11,
    address_line1 = ?12, address_line2 = ?13, postal_code = ?14, city = ?15, country = ?16,
    latitude = ?17, longitude = ?18, geo_source = ?19, opening_hours = ?20, phone_e164 = ?21,
    whatsapp_e164 = ?22, gbp_url = ?23, short_description = ?24, contact_email = ?25,
    marketing_opt_in = ?26, media_ids = ?27, updated_at = ?28
WHERE id = ?1 AND anon_session_id = ?2 AND status = 'open' AND updated_at <= ?29
`;

/**
 * Saves the merged intake.
 *
 * Returns false when the server's copy is strictly newer than `ifUnmodifiedSince`, when the draft
 * has already been submitted, or when the cookie does not own it — the route maps the first to 409
 * and the rest to 404 rather than guessing.
 */
export async function updateDraftIntake(
  db: D1Database,
  args: {
    readonly draftId: DraftId;
    readonly anonSessionId: AnonSessionId;
    readonly patch: DraftIntakePatch;
    readonly now: Timestamp;
    readonly ifUnmodifiedSince: Timestamp;
  },
): Promise<boolean> {
  const p = args.patch;
  const result = await db
    .prepare(SQL_UPDATE_DRAFT_INTAKE)
    .bind(
      args.draftId,
      args.anonSessionId,
      p.step,
      p.furthestStep,
      p.businessName,
      p.slug,
      p.industryKey,
      p.defaultLocale,
      p.extraLocales,
      p.serviceAreaCity,
      p.serviceAreaRadiusKm,
      p.addressLine1,
      p.addressLine2,
      p.postalCode,
      p.city,
      p.country,
      p.latitude,
      p.longitude,
      p.geoSource,
      p.openingHours,
      p.phoneE164,
      p.whatsappE164,
      p.gbpUrl,
      p.shortDescription,
      p.contactEmail,
      p.marketingOptIn,
      p.mediaIds,
      args.now,
      args.ifUnmodifiedSince,
    )
    .run();
  return changedOne(result.meta);
}

/** Records the Haiku 4.5 intake policy verdict, before any Opus spend. */
export const SQL_SET_DRAFT_POLICY_SCREEN = `
UPDATE onboarding_drafts
SET policy_screen = ?2, policy_reason = ?3, status = ?4, updated_at = ?5
WHERE id = ?1 AND status IN ('open','rejected')
`;

/** Writes the policy screen verdict. A rejection also moves the draft to `rejected`. */
export async function setDraftPolicyScreen(
  db: D1Database,
  args: {
    readonly draftId: DraftId;
    readonly verdict: PolicyScreen;
    readonly reason: string | null;
    readonly now: Timestamp;
  },
): Promise<boolean> {
  const status = args.verdict === 'reject' ? 'rejected' : 'open';
  const result = await db
    .prepare(SQL_SET_DRAFT_POLICY_SCREEN)
    .bind(args.draftId, args.verdict, args.reason, status, args.now)
    .run();
  return changedOne(result.meta);
}

/**
 * Marks a draft submitted and binds it to the site, org and job that submit created.
 *
 * `AND status = 'open'` makes submission itself idempotent at the database: a replayed
 * `POST /v1/onboarding/submit` changes zero rows, and the route re-reads the draft and returns the
 * SAME job id and site URL with a 200 instead of dispatching a second paid generation.
 */
export const SQL_MARK_DRAFT_SUBMITTED = `
UPDATE onboarding_drafts
SET status = 'submitted', site_id = ?2, org_id = ?3, generation_job_id = ?4,
    submitted_at = ?5, updated_at = ?5
WHERE id = ?1 AND status = 'open'
`;

/** Builds the submit transition, for the submit batch. */
export function markDraftSubmittedStatement(
  db: D1Database,
  args: {
    readonly draftId: DraftId;
    readonly siteId: SiteId;
    readonly orgId: OrganisationId;
    readonly jobId: GenerationJobId;
    readonly now: Timestamp;
  },
): D1PreparedStatement {
  return db
    .prepare(SQL_MARK_DRAFT_SUBMITTED)
    .bind(args.draftId, args.siteId, args.orgId, args.jobId, args.now);
}

/** Moves a submitted draft to `claimed` when its claim token is consumed. */
export const SQL_MARK_DRAFT_CLAIMED = `
UPDATE onboarding_drafts SET status = 'claimed', updated_at = ?2, purge_after = ?3
WHERE id = ?1 AND status = 'submitted'
`;

/**
 * Builds the claim transition.
 *
 * `purge_after` is pushed out here: the 30-day hard delete in architecture §3b step 8 applies to
 * UNCLAIMED drafts. A claimed draft is the fact source that publish projects from, so it lives as
 * long as the site does.
 */
export function markDraftClaimedStatement(
  db: D1Database,
  args: { readonly draftId: DraftId; readonly now: Timestamp; readonly purgeAfter: Timestamp },
): D1PreparedStatement {
  return db.prepare(SQL_MARK_DRAFT_CLAIMED).bind(args.draftId, args.now, args.purgeAfter);
}

/**
 * Drafts whose retention deadline has passed, oldest first.
 *
 * The purge cron deletes the row AND the `drafts/{id}/` R2 prefix. Chunked because D1 caps a query
 * at 30 seconds, and a purge that times out half-way leaves R2 objects nothing points at.
 */
export const SQL_LIST_PURGEABLE_DRAFTS = `
SELECT id, status, purge_after FROM onboarding_drafts
WHERE purge_after < ?1 ORDER BY purge_after LIMIT ?2
`;

/** Lists drafts past their purge deadline. */
export async function listPurgeableDrafts(
  db: D1Database,
  args: { readonly before: Timestamp; readonly limit: number },
): Promise<readonly Pick<OnboardingDraftRow, 'id' | 'status' | 'purge_after'>[]> {
  const result = await db
    .prepare(SQL_LIST_PURGEABLE_DRAFTS)
    .bind(args.before, args.limit)
    .all<Pick<OnboardingDraftRow, 'id' | 'status' | 'purge_after'>>();
  return result.results;
}

/** Hard-deletes one draft, after its R2 prefix has been removed. */
export const SQL_DELETE_DRAFT = `
DELETE FROM onboarding_drafts WHERE id = ?1
`;

/** Deletes a draft row. Call only after the R2 prefix is gone, never before. */
export async function deleteDraft(db: D1Database, draftId: DraftId): Promise<boolean> {
  const result = await db.prepare(SQL_DELETE_DRAFT).bind(draftId).run();
  return changedOne(result.meta);
}

// ---------------------------------------------------------------------------------------------
// Site claim
// ---------------------------------------------------------------------------------------------

/** Creates a claim token: single-use, bound to `email_normalized`, 72 h. */
export const SQL_INSERT_CLAIM_TOKEN = `
INSERT INTO site_claim_tokens (token_hash, id, site_id, org_id, draft_id, email_normalized,
                               send_count, last_sent_at, created_at, expires_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7, ?8)
`;

/** Inserts a claim token. */
export async function insertClaimToken(
  db: D1Database,
  args: {
    readonly tokenHash: Uint8Array;
    readonly id: ClaimTokenId;
    readonly siteId: SiteId;
    readonly orgId: OrganisationId;
    readonly draftId: DraftId | null;
    readonly emailNormalized: string;
    readonly now: Timestamp;
    readonly expiresAt: Timestamp;
  },
): Promise<void> {
  const result = await db
    .prepare(SQL_INSERT_CLAIM_TOKEN)
    .bind(
      toArrayBuffer(args.tokenHash),
      args.id,
      args.siteId,
      args.orgId,
      args.draftId,
      args.emailNormalized,
      args.now,
      args.expiresAt,
    )
    .run();
  assertSingleChange(result.meta, 'insertClaimToken');
}

/**
 * Consumes a claim token, atomically.
 *
 * The whole claim flow hangs off `meta.changes === 1` here: on success the caller creates the owner
 * membership, de-provisions the organisation, deletes the anonymous cookie, mints a FRESH session
 * (session fixation) and promotes `index_state`. Run twice, that would create two memberships and
 * two sessions. `AND consumed_at IS NULL` is what makes it run once.
 */
export const SQL_CONSUME_CLAIM_TOKEN = `
UPDATE site_claim_tokens
SET consumed_at = ?2, consumed_ip_hash = ?3
WHERE token_hash = ?1 AND consumed_at IS NULL AND expires_at > ?2
RETURNING *
`;

/** Consumes a claim token, or returns `null` for used/expired — a 410, never a 500. */
export async function consumeClaimToken(
  db: D1Database,
  args: {
    readonly tokenHash: Uint8Array;
    readonly now: Timestamp;
    readonly ipHash: Uint8Array | null;
  },
): Promise<SiteClaimTokenRow | null> {
  return db
    .prepare(SQL_CONSUME_CLAIM_TOKEN)
    .bind(
      toArrayBuffer(args.tokenHash),
      args.now,
      args.ipHash === null ? null : toArrayBuffer(args.ipHash),
    )
    .first<SiteClaimTokenRow>();
}

/**
 * Records a resend of the claim invitation.
 *
 * `send_count` is capped at 5 by the column CHECK, so this statement is also the rate limit:
 * inviting a third-party address typed into the modal is a spam-amplification and
 * sender-reputation risk (architecture §10 risk 7), and an unbounded resend button is how that
 * becomes someone else's problem.
 */
export const SQL_BUMP_CLAIM_SEND_COUNT = `
UPDATE site_claim_tokens
SET send_count = send_count + 1, last_sent_at = ?2
WHERE token_hash = ?1 AND consumed_at IS NULL AND expires_at > ?2 AND send_count < 5
`;

/** Records a resend. Returns false when the cap is reached or the token is spent. */
export async function bumpClaimSendCount(
  db: D1Database,
  args: { readonly tokenHash: Uint8Array; readonly now: Timestamp },
): Promise<boolean> {
  const result = await db
    .prepare(SQL_BUMP_CLAIM_SEND_COUNT)
    .bind(toArrayBuffer(args.tokenHash), args.now)
    .run();
  return changedOne(result.meta);
}

/** The live claim token for a site, so a resend reuses it rather than minting a second one. */
export const SQL_GET_LIVE_CLAIM_TOKEN_FOR_SITE = `
SELECT * FROM site_claim_tokens
WHERE site_id = ?1 AND consumed_at IS NULL AND expires_at > ?2
ORDER BY created_at DESC LIMIT 1
`;

/** Reads the newest unconsumed claim token for a site. */
export async function getLiveClaimTokenForSite(
  db: D1Database,
  args: { readonly siteId: SiteId; readonly now: Timestamp },
): Promise<SiteClaimTokenRow | null> {
  return db
    .prepare(SQL_GET_LIVE_CLAIM_TOKEN_FOR_SITE)
    .bind(args.siteId, args.now)
    .first<SiteClaimTokenRow>();
}
