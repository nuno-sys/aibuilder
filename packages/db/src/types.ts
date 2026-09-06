/**
 * Hand-written row types for every table in `migrations/cp/**` and `migrations/shard/**`.
 *
 * This file is THE typed boundary. There is no ORM and no code generation (VERIFIED-FACTS.md,
 * "Deliberate deviations" 1: Drizzle arrives in Phase 2 with the dashboard's relational reads), so
 * these declarations are the only thing standing between a `SELECT *` and `unknown`. They mirror
 * the DDL exactly — column for column, nullability for nullability, enum for CHECK — and drift is
 * caught by the migration test that compares `PRAGMA table_info` against the keys declared here.
 *
 * Three conventions, all of them consequences of the schema:
 *
 * 1. **Timestamps are `number`**, unix epoch MILLISECONDS, matching `Date.now()`.
 * 2. **Booleans are `0 | 1`.** STRICT tables have no BOOLEAN type and the DDL says `CHECK (x IN
 *    (0,1))`, so the row type says the same rather than lying about a `boolean`.
 * 3. **sha256 columns are `BlobColumn`, not `string`.** They are `BLOB(32)` in the database;
 *    `bytes.ts` converts. A hex string here would be a 64-character lie about a 32-byte column.
 */

// ---------------------------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------------------------

/** Unix epoch milliseconds, as stored in every `*_at` column. */
export type Timestamp = number;

/** A STRICT-table boolean: `CHECK (x IN (0,1))`. */
export type BoolInt = 0 | 1;

/**
 * How D1 hands back a `BLOB` column.
 *
 * The wire format has changed across D1 versions (a byte array in older builds, an `ArrayBuffer`
 * in current ones), and a row type that commits to one of them breaks silently on the other. Every
 * read goes through `toBytes()` in `bytes.ts`, which normalises all three shapes.
 */
export type BlobColumn = ArrayBuffer | ArrayBufferView | readonly number[];

// ---------------------------------------------------------------------------------------------
// Prefixed ids
//
// A 30-character prefixed ULID. The template literal type is not merely documentation: it makes
// passing a `ver_…` where a `ste_…` belongs a compile error, which is the same protection the
// `CHECK (id GLOB 'ste_[0-7]*' …)` constraints give at write time. `packages/core/src/ids.ts` mints
// them; this package cannot import it (the boundary policy in eslint.config.js puts `db` at the
// bottom of the stack with no local dependencies), so the two are kept equal by test, not by import.
// ---------------------------------------------------------------------------------------------

/** `usr_…` */ export type UserId = `usr_${string}`;
/** `org_…` */ export type OrganisationId = `org_${string}`;
/** `ses_…` */ export type SessionId = `ses_${string}`;
/** `tok_…` */ export type AuthTokenId = `tok_${string}`;
/** `ans_…` */ export type AnonSessionId = `ans_${string}`;
/** `drf_…` */ export type DraftId = `drf_${string}`;
/** `clm_…` */ export type ClaimTokenId = `clm_${string}`;
/** `abs_…` */ export type AbuseEventUlid = `abs_${string}`;
/** `ste_…` */ export type SiteId = `ste_${string}`;
/** `dom_…` */ export type CustomDomainId = `dom_${string}`;
/** `ver_…` */ export type SiteVersionId = `ver_${string}`;
/** `pag_…` */ export type PageId = `pag_${string}`;
/** `ptr_…` */ export type PageTranslationId = `ptr_${string}`;
/** `psa_…` */ export type PageSlugAliasId = `psa_${string}`;
/** `blp_…` */ export type BlogPostId = `blp_${string}`;
/** `bpt_…` */ export type BlogPostTranslationId = `bpt_${string}`;
/** `med_…` */ export type MediaAssetId = `med_${string}`;
/** `ups_…` */ export type UploadSessionId = `ups_${string}`;
/** `rev_…` */ export type SiteReviewId = `rev_${string}`;
/** `led_…` */ export type LeadId = `led_${string}`;
/** `job_…` */ export type GenerationJobId = `job_${string}`;
/** `gcl_…` */ export type GenerationCallId = `gcl_${string}`;
/** `dep_…` */ export type DeploymentId = `dep_${string}`;
/** `aud_…` */ export type AuditUlid = `aud_${string}`;
/** `cns_…` */ export type ConsentId = `cns_${string}`;

/**
 * A locale code as stored: ISO 639-1, optionally with a region (`nl`, `pt-BR`).
 *
 * Deliberately `string` and not a union of the six seeded codes. Architecture §5.2 promises that
 * adding a seventh locale is an INSERT and nothing else, and a closed union here would make it a
 * code change in the package at the bottom of the dependency graph.
 */
export type LocaleCode = string;

/** Zero-based shard index. `0` is `aibuilder-shard-000`; see `shard-router.ts`. */
export type ShardId = number;

// ---------------------------------------------------------------------------------------------
// Control-plane enums
// ---------------------------------------------------------------------------------------------

export type AccountStatus = 'active' | 'suspended' | 'deleted';
export type MembershipRole = 'owner' | 'admin' | 'editor' | 'viewer';
export type AuthTokenPurpose = 'magic_link' | 'email_verify' | 'org_invite';
export type OrgPlan = 'free' | 'pro';
export type Entitlement = 'none' | 'trialing' | 'active' | 'past_due' | 'canceled';
export type TextDirection = 'ltr' | 'rtl';
export type ReservedSlugReason = 'system' | 'protocol' | 'brand' | 'abuse' | 'retired';
/**
 * A design-DNA archetype key.
 *
 * Deliberately `string`, and deliberately not a union of the four Phase 1 archetypes. The
 * closed set lives in `packages/site-kit/src/tokens/dna.ts` — Phase 2 adds sixteen more — and
 * `industries` is a cascade parent that can never be rebuilt, so the column carries a shape
 * CHECK rather than an enum. A union here would put the same un-widenable constraint in the
 * package at the bottom of the dependency graph.
 */
export type DnaId = string;
export type SiteStatus =
  'onboarding' | 'generating' | 'draft' | 'published' | 'suspended' | 'deleted';
export type IndexState = 'noindex' | 'eligible' | 'indexable' | 'gone';
export type DomainStatus =
  'pending' | 'pending_validation' | 'active' | 'moved' | 'deleted' | 'blocked' | 'failed';
export type DomainSslStatus =
  | 'initializing'
  | 'pending_validation'
  | 'pending_issuance'
  | 'pending_deployment'
  | 'active'
  | 'deleted'
  | 'expired'
  | 'deactivating'
  | 'backup_issued'
  | 'holding_deployment'
  | 'failed';
export type DraftStatus = 'open' | 'submitted' | 'claimed' | 'abandoned' | 'rejected';
export type GeoSource = 'none' | 'geocoded' | 'user_pin';
export type PolicyScreen = 'pending' | 'pass' | 'reject' | 'error';
export type AbuseKind =
  | 'turnstile_fail'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'policy_reject'
  | 'slug_blocked'
  | 'homoglyph_blocked'
  | 'media_quarantined'
  | 'url_reputation'
  | 'manual_report'
  | 'takedown'
  | 'budget_deferred';
export type AbuseSeverity = 'info' | 'warn' | 'block';
export type AbuseSubjectType = 'ip' | 'draft' | 'org' | 'site' | 'email' | 'phone' | 'host';
export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'unpaid'
  | 'paused';
export type StripeEventStatus = 'received' | 'processing' | 'processed' | 'failed' | 'skipped';
export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';

// ---------------------------------------------------------------------------------------------
// Shard enums
// ---------------------------------------------------------------------------------------------

export type VersionOrigin =
  'generation' | 'regeneration' | 'editor' | 'rollback' | 'import' | 'translation';
export type VersionStatus = 'draft' | 'building' | 'ready' | 'published' | 'archived' | 'failed';
export type QualityState = 'pending' | 'pass' | 'warn' | 'fail' | 'skipped';
export type TranslationStatus = 'pending' | 'machine' | 'ai' | 'human' | 'stale';
export type TranslationSource = 'ai' | 'human' | 'machine' | 'copied';
export type PageRole =
  | 'home'
  | 'about'
  | 'services'
  | 'menu'
  | 'gallery'
  | 'reviews'
  | 'team'
  | 'contact'
  | 'booking'
  | 'blog_index'
  | 'privacy'
  | 'terms'
  | 'cookies'
  | 'custom';
export type NavGroup = 'primary' | 'footer' | 'utility' | 'none';
export type SlugAliasReason = 'regeneration' | 'manual_rename' | 'locale_change' | 'merge';
export type BlobKind =
  | 'page_tree'
  | 'site_doc'
  | 'blog_body'
  | 'locale_bundle'
  | 'prompt'
  | 'ai_transcript'
  | 'bundle'
  | 'legal_doc';
export type BlobEncoding = 'identity' | 'gzip' | 'br';
export type BlobState = 'live' | 'tombstoned';
export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'favicon';
export type MediaSource = 'upload' | 'pexels' | 'unsplash' | 'ai_generated' | 'stock_video';
export type MediaStatus =
  'pending' | 'uploading' | 'verifying' | 'ready' | 'failed' | 'quarantined' | 'deleted';
export type MediaRole =
  'hero_video' | 'hero_image' | 'logo' | 'gallery' | 'og' | 'blog_cover' | 'favicon';
export type UploadSessionState = 'open' | 'completed' | 'aborted' | 'expired';
export type BlogStatus = 'draft' | 'scheduled' | 'published' | 'archived';
export type ReviewPlatform =
  'manual' | 'google' | 'facebook' | 'trustpilot' | 'tripadvisor' | 'yelp';
export type GenerationKind =
  | 'initial_site'
  | 'regenerate_site'
  | 'regenerate_page'
  | 'translate'
  | 'blog_post'
  | 'legal_docs'
  | 'copy_rewrite';
export type GenerationStatus =
  | 'queued'
  | 'running'
  | 'streaming'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'blocked_paywall'
  | 'timed_out';
/** Mirrors the step file names in `apps/generator/src/steps/`. */
export type GenerationStep =
  | 'validate'
  | 'media'
  | 'structure'
  | 'copy'
  | 'blog'
  | 'legal'
  | 'assemble'
  | 'audit'
  | 'render'
  | 'publish'
  | 'repair';
/** `output_config.effort`. `xhigh` and `max` are incompatible with `thinking.type = 'disabled'`. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** `budget_tokens` does not exist on this API and would 400; the type is exactly the two values. */
export type ThinkingType = 'adaptive' | 'disabled';
export type ThinkingDisplay = 'summarized' | 'omitted' | 'updates';
export type OutputFormat = 'text' | 'json_schema';
/** The twelve phases the onboarding modal maps many-to-one onto its progress acts. */
export type JobPhase =
  | 'queued'
  | 'prompt_built'
  | 'api_call'
  | 'thinking'
  | 'streaming'
  | 'parsing'
  | 'pages_written'
  | 'media_fetch'
  | 'build'
  | 'deploy'
  | 'done'
  | 'error';
export type DeploymentTarget = 'r2_static' | 'pages' | 'worker';
export type DeploymentStatus =
  'queued' | 'building' | 'deploying' | 'live' | 'failed' | 'rolled_back';
export type LeadKind = 'contact' | 'booking' | 'callback' | 'quote' | 'newsletter';
export type BookingStatus = 'requested' | 'confirmed' | 'declined' | 'cancelled' | 'completed';
export type AuditActorType =
  'user' | 'system' | 'stripe' | 'cloudflare' | 'ai' | 'cron' | 'support';
export type UsageMetric =
  | 'generations'
  | 'regenerations'
  | 'ai_input_tokens'
  | 'ai_output_tokens'
  | 'ai_cache_read_tokens'
  | 'ai_cost_usd_micro'
  | 'r2_bytes_stored'
  | 'r2_bytes_egress'
  | 'leads'
  | 'page_views'
  | 'blog_posts'
  | 'media_files';
export type ConsentKind = 'lead_form' | 'cookie_banner' | 'marketing_opt_in' | 'terms' | 'privacy';

// ---------------------------------------------------------------------------------------------
// Control-plane rows
// ---------------------------------------------------------------------------------------------

/** `users` — identity. `password_hash` is always NULL by CHECK; see the column comment in 0001. */
export interface UserRow {
  readonly id: UserId;
  readonly email: string;
  readonly email_normalized: string;
  readonly email_verified_at: Timestamp | null;
  readonly password_hash: null;
  readonly full_name: string | null;
  readonly locale: LocaleCode;
  readonly country: string | null;
  readonly timezone: string;
  readonly marketing_opt_in: BoolInt;
  readonly status: AccountStatus;
  readonly last_login_at: Timestamp | null;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly deleted_at: Timestamp | null;
}

/** `organisations` — the billing and entitlement owner, and the shard assignment. */
export interface OrganisationRow {
  readonly id: OrganisationId;
  readonly name: string;
  readonly shard_id: ShardId;
  readonly provisional: BoolInt;
  readonly billing_email: string | null;
  readonly country: string;
  readonly vat_number: string | null;
  readonly vat_validated_at: Timestamp | null;
  readonly billing_address: string | null;
  readonly plan: OrgPlan;
  readonly entitlement: Entitlement;
  readonly entitlement_until: Timestamp | null;
  readonly sites_limit: number;
  readonly status: AccountStatus;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly deleted_at: Timestamp | null;
}

/** The single-row paywall read: `organisations.entitlement` is a deliberate denormalisation. */
export interface EntitlementRow {
  readonly entitlement: Entitlement;
  readonly entitlement_until: Timestamp | null;
  readonly plan: OrgPlan;
  readonly status: AccountStatus;
  readonly shard_id: ShardId;
}

/** `memberships` — the user ↔ org ↔ role edge. Zero rows means the org is unreachable. */
export interface MembershipRow {
  readonly org_id: OrganisationId;
  readonly user_id: UserId;
  readonly role: MembershipRole;
  readonly invited_by: UserId | null;
  readonly accepted_at: Timestamp | null;
  readonly created_at: Timestamp;
}

/** `sessions` — WITHOUT ROWID on `token_hash`, so authentication is a single page read. */
export interface SessionRow {
  readonly token_hash: BlobColumn;
  readonly id: SessionId;
  readonly user_id: UserId;
  readonly active_org_id: OrganisationId | null;
  readonly ip_hash: BlobColumn | null;
  readonly user_agent: string | null;
  readonly created_at: Timestamp;
  readonly last_seen_at: Timestamp;
  readonly expires_at: Timestamp;
  readonly revoked_at: Timestamp | null;
}

/** `auth_tokens` — magic link and e-mail verification. Single-use, atomically consumed. */
export interface AuthTokenRow {
  readonly token_hash: BlobColumn;
  readonly id: AuthTokenId;
  readonly user_id: UserId | null;
  readonly email: string;
  readonly purpose: AuthTokenPurpose;
  readonly org_id: OrganisationId | null;
  readonly payload: string | null;
  readonly ip_hash: BlobColumn | null;
  readonly created_at: Timestamp;
  readonly expires_at: Timestamp;
  readonly consumed_at: Timestamp | null;
}

/** `locales` — the global registry. Zero locale-named columns exist anywhere else. */
export interface LocaleRow {
  readonly code: LocaleCode;
  readonly english_name: string;
  readonly native_name: string;
  readonly hreflang: string;
  readonly url_segment: string;
  readonly direction: TextDirection;
  readonly is_active: BoolInt;
  readonly sort_order: number;
  readonly created_at: Timestamp;
}

/** `industry_groups` — top level of the picker. `labels` is a JSON object keyed by locale. */
export interface IndustryGroupRow {
  readonly key: string;
  readonly icon: string;
  readonly labels: string;
  readonly is_active: BoolInt;
  readonly sort_order: number;
  readonly created_at: Timestamp;
}

/** `industries` — leaf taxonomy. Keys mirror `packages/core/src/industries.ts`. */
export interface IndustryRow {
  readonly key: string;
  readonly group_key: string;
  readonly schema_org_type: string;
  readonly dna_id: DnaId;
  readonly design_preset: string | null;
  /** schema.org `additionalType` URI when no LocalBusiness subtype fits the trade exactly. */
  readonly additional_type: string | null;
  readonly default_page_keys: string;
  readonly prompt_fragment_sha256: BlobColumn | null;
  readonly stock_query: string | null;
  readonly is_active: BoolInt;
  readonly sort_order: number;
  readonly created_at: Timestamp;
}

/** `industry_translations` — localized label plus the alias terms the picker filters on. */
export interface IndustryTranslationRow {
  readonly industry_key: string;
  readonly locale: LocaleCode;
  readonly label: string;
  readonly search_terms: string | null;
}

/** `reserved_slugs` — enforced by the triggers in `migrations/cp/0006_triggers.sql`. */
export interface ReservedSlugRow {
  readonly slug: string;
  readonly reason: ReservedSlugReason;
  readonly note: string | null;
  readonly created_at: Timestamp;
}

/** `sites` — identity and routing ONLY. Business facts live in `onboarding_drafts`. */
export interface SiteRow {
  readonly id: SiteId;
  readonly org_id: OrganisationId;
  readonly shard_id: ShardId;
  readonly slug: string;
  readonly status: SiteStatus;
  readonly default_locale: LocaleCode;
  /** A shard-local `site_versions.id`; no foreign key can span two D1 databases. */
  readonly published_version_id: SiteVersionId | null;
  readonly canonical_host: string;
  readonly index_state: IndexState;
  readonly published_at: Timestamp | null;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly deleted_at: Timestamp | null;
}

/** `custom_domains` — Cloudflare for SaaS hostnames and their DCV state. */
export interface CustomDomainRow {
  readonly id: CustomDomainId;
  readonly site_id: SiteId;
  readonly org_id: OrganisationId;
  readonly hostname: string;
  readonly cf_custom_hostname_id: string | null;
  readonly status: DomainStatus;
  readonly ssl_status: DomainSslStatus;
  readonly ssl_method: 'http' | 'txt' | 'email';
  readonly ownership_verified_at: Timestamp | null;
  readonly dcv_record_name: string | null;
  readonly dcv_record_value: string | null;
  readonly ownership_record_name: string | null;
  readonly ownership_record_value: string | null;
  readonly target_cname: string;
  readonly is_primary: BoolInt;
  readonly redirect_to_primary: BoolInt;
  readonly cf_errors: string | null;
  readonly last_checked_at: Timestamp | null;
  readonly check_attempts: number;
  readonly activated_at: Timestamp | null;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly deleted_at: Timestamp | null;
}

/** `anon_sessions` — pre-account draft ownership behind the `__Host-aib_draft` cookie. */
export interface AnonSessionRow {
  readonly token_hash: BlobColumn;
  readonly id: AnonSessionId;
  readonly ip_hash: BlobColumn | null;
  readonly ip_country: string | null;
  readonly user_agent: string | null;
  readonly created_at: Timestamp;
  readonly last_seen_at: Timestamp;
  readonly expires_at: Timestamp;
  readonly revoked_at: Timestamp | null;
}

/**
 * `onboarding_drafts` — the server-side draft AND the Phase 1 system of record for the business
 * facts that publish projects into `SiteDoc.facts`.
 *
 * Every intake column is nullable because a draft is partial by definition; completeness is proven
 * by Zod at submit, not by NOT NULL here.
 */
export interface OnboardingDraftRow {
  readonly id: DraftId;
  readonly anon_session_id: AnonSessionId;
  readonly shard_id: ShardId;
  readonly status: DraftStatus;
  readonly ui_locale: LocaleCode;
  readonly step: number;
  readonly furthest_step: number;
  readonly business_name: string | null;
  readonly slug: string | null;
  readonly industry_key: string | null;
  readonly default_locale: LocaleCode | null;
  readonly extra_locales: string | null;
  readonly service_area_city: string | null;
  readonly service_area_radius_km: number | null;
  readonly address_line1: string | null;
  readonly address_line2: string | null;
  readonly postal_code: string | null;
  readonly city: string | null;
  readonly country: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly geo_source: GeoSource;
  readonly opening_hours: string | null;
  readonly phone_e164: string | null;
  readonly whatsapp_e164: string | null;
  readonly gbp_url: string | null;
  readonly short_description: string | null;
  readonly contact_email: string | null;
  readonly marketing_opt_in: BoolInt;
  readonly media_ids: string | null;
  /** Server-minted and never returned to the client. See `migrations/cp/0005_drafts_claims.sql`. */
  readonly idempotency_key: string;
  readonly turnstile_verified_at: Timestamp | null;
  readonly policy_screen: PolicyScreen;
  readonly policy_reason: string | null;
  readonly site_id: SiteId | null;
  readonly org_id: OrganisationId | null;
  readonly generation_job_id: GenerationJobId | null;
  readonly ip_hash: BlobColumn | null;
  readonly ip_country: string | null;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly submitted_at: Timestamp | null;
  readonly purge_after: Timestamp;
}

/** `site_claim_tokens` — single-use, bound to `email_normalized`, 72 h. */
export interface SiteClaimTokenRow {
  readonly token_hash: BlobColumn;
  readonly id: ClaimTokenId;
  readonly site_id: SiteId;
  readonly org_id: OrganisationId;
  readonly draft_id: DraftId | null;
  readonly email_normalized: string;
  readonly send_count: number;
  readonly last_sent_at: Timestamp;
  readonly created_at: Timestamp;
  readonly expires_at: Timestamp;
  readonly consumed_at: Timestamp | null;
  readonly consumed_ip_hash: BlobColumn | null;
}

/** `abuse_events` — the funnel's telemetry, feeding the daily ops digest. */
export interface AbuseEventRow {
  readonly id: number;
  readonly ulid: AbuseEventUlid;
  readonly kind: AbuseKind;
  readonly severity: AbuseSeverity;
  readonly subject_type: AbuseSubjectType;
  readonly subject_hash: BlobColumn;
  readonly site_id: SiteId | null;
  readonly org_id: OrganisationId | null;
  readonly detail: string | null;
  readonly created_at: Timestamp;
  readonly purge_after: Timestamp;
}

/** `csp_reports` — aggregated by (host, directive, blocked uri), never one row per report. */
export interface CspReportRow {
  readonly host: string;
  readonly violated_directive: string;
  readonly blocked_uri: string;
  readonly effective_directive: string | null;
  readonly disposition: 'enforce' | 'report';
  readonly document_uri: string | null;
  readonly script_sample: string | null;
  readonly occurrences: number;
  readonly first_seen_at: Timestamp;
  readonly last_seen_at: Timestamp;
}

/** `stripe_customers` — Phase 2 writes this; the schema ships in Phase 1. */
export interface StripeCustomerRow {
  readonly stripe_customer_id: string;
  readonly org_id: OrganisationId;
  readonly email: string | null;
  readonly default_pm_brand: string | null;
  readonly default_pm_last4: string | null;
  readonly default_pm_fingerprint: string | null;
  readonly tax_country: string | null;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

/** `subscriptions` — the Stripe mirror; Stripe remains the source of truth. */
export interface SubscriptionRow {
  readonly stripe_subscription_id: string;
  readonly org_id: OrganisationId;
  readonly stripe_customer_id: string;
  readonly status: SubscriptionStatus;
  readonly stripe_price_id: string;
  readonly stripe_product_id: string | null;
  readonly currency: string;
  readonly unit_amount_cents: number;
  readonly billing_interval: 'month' | 'year';
  readonly interval_count: number;
  readonly quantity: number;
  readonly trial_start: Timestamp | null;
  readonly trial_end: Timestamp | null;
  readonly current_period_start: Timestamp | null;
  readonly current_period_end: Timestamp | null;
  readonly cancel_at_period_end: BoolInt;
  readonly canceled_at: Timestamp | null;
  readonly ended_at: Timestamp | null;
  readonly latest_invoice_id: string | null;
  readonly collection_method: 'charge_automatically' | 'send_invoice';
  readonly stripe_updated_at: Timestamp;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

/** `stripe_events` — insert-before-process with a claim-token guard, not a bare status check. */
export interface StripeEventRow {
  readonly stripe_event_id: string;
  readonly type: string;
  readonly api_version: string | null;
  readonly livemode: BoolInt;
  readonly stripe_created_at: Timestamp;
  readonly object_id: string | null;
  readonly org_id: OrganisationId | null;
  readonly status: StripeEventStatus;
  readonly claim_token: BlobColumn | null;
  readonly claim_expires_at: Timestamp | null;
  readonly attempts: number;
  readonly last_error: string | null;
  readonly payload_sha256: BlobColumn | null;
  readonly received_at: Timestamp;
  readonly processed_at: Timestamp | null;
}

/** `invoices` — the dashboard's billing history. */
export interface InvoiceRow {
  readonly stripe_invoice_id: string;
  readonly org_id: OrganisationId;
  readonly stripe_subscription_id: string | null;
  readonly number: string | null;
  readonly status: InvoiceStatus;
  readonly currency: string;
  readonly subtotal_cents: number;
  readonly tax_cents: number;
  readonly total_cents: number;
  readonly amount_paid_cents: number;
  readonly hosted_invoice_url: string | null;
  readonly invoice_pdf_url: string | null;
  readonly period_start: Timestamp | null;
  readonly period_end: Timestamp | null;
  readonly issued_at: Timestamp;
  readonly paid_at: Timestamp | null;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

// ---------------------------------------------------------------------------------------------
// Shard rows
// ---------------------------------------------------------------------------------------------

/** `site_versions` — the immutable snapshot unit. `sealed_at` freezes it and its pages. */
export interface SiteVersionRow {
  readonly id: SiteVersionId;
  readonly site_id: SiteId;
  readonly org_id: OrganisationId;
  readonly version_no: number;
  readonly parent_version_id: SiteVersionId | null;
  readonly origin: VersionOrigin;
  readonly generation_job_id: GenerationJobId | null;
  readonly status: VersionStatus;
  readonly label: string | null;
  readonly schema_version: number;
  readonly theme_tokens: string | null;
  readonly features: string | null;
  readonly manifest_sha256: BlobColumn | null;
  readonly manifest_bytes: number | null;
  readonly bundle_sha256: BlobColumn | null;
  readonly bundle_bytes: number | null;
  readonly lighthouse_scores: string | null;
  readonly quality_state: QualityState;
  readonly quality_report: string | null;
  readonly sealed_at: Timestamp | null;
  readonly created_by: UserId | null;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

/** `site_locales` — which locales this site publishes, and which one is `x-default`. */
export interface SiteLocaleRow {
  readonly site_id: SiteId;
  readonly locale: LocaleCode;
  readonly url_segment: string;
  readonly is_default: BoolInt;
  readonly is_enabled: BoolInt;
  readonly translation_status: TranslationStatus;
  readonly sort_order: number;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

/** `pages` — the logical, locale-independent page. `page_key` survives regeneration. */
export interface PageRow {
  readonly id: PageId;
  readonly site_version_id: SiteVersionId;
  readonly site_id: SiteId;
  readonly page_key: string;
  readonly role: PageRole;
  readonly template: string;
  readonly nav_group: NavGroup;
  readonly sort_order: number;
  readonly is_indexable: BoolInt;
  readonly sitemap_priority: number;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

/** `page_translations` — one row per (page, locale). The component tree is always in R2. */
export interface PageTranslationRow {
  readonly id: PageTranslationId;
  readonly page_id: PageId;
  readonly site_version_id: SiteVersionId;
  readonly locale: LocaleCode;
  readonly path: string;
  readonly slug: string;
  readonly title: string;
  readonly meta_description: string | null;
  readonly og_media_id: MediaAssetId | null;
  readonly jsonld: string | null;
  readonly content_sha256: BlobColumn;
  readonly content_bytes: number;
  readonly render_sha256: BlobColumn | null;
  readonly content_changed_at: Timestamp;
  readonly translation_source: TranslationSource;
  readonly is_stale: BoolInt;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

/** `page_slug_aliases` — retired paths, 301 forever, site-scoped rather than version-scoped. */
export interface PageSlugAliasRow {
  readonly id: PageSlugAliasId;
  readonly site_id: SiteId;
  readonly page_key: string;
  readonly locale: LocaleCode;
  readonly old_path: string;
  readonly new_path: string;
  readonly reason: SlugAliasReason;
  readonly created_at: Timestamp;
}

/** `content_blobs` — the refcount and GC ledger. `state` drives the two-phase reaper. */
export interface ContentBlobRow {
  readonly sha256: BlobColumn;
  readonly bytes: number;
  readonly content_type: string;
  readonly encoding: BlobEncoding;
  readonly kind: BlobKind;
  readonly refcount: number;
  readonly state: BlobState;
  readonly tombstoned_at: Timestamp | null;
  readonly created_at: Timestamp;
  readonly last_ref_at: Timestamp;
}

/** `media_assets` — R2 keys and derived metadata. Owned by a draft until submit, then by a site. */
export interface MediaAssetRow {
  readonly id: MediaAssetId;
  readonly site_id: SiteId | null;
  readonly org_id: OrganisationId | null;
  readonly draft_id: DraftId | null;
  readonly r2_bucket: string;
  readonly r2_key: string;
  readonly sha256: BlobColumn | null;
  readonly kind: MediaKind;
  readonly source: MediaSource;
  readonly source_ref: string | null;
  readonly source_url: string | null;
  readonly attribution: string | null;
  readonly license: string | null;
  readonly mime_type: string;
  readonly bytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly duration_ms: number | null;
  readonly blurhash: string | null;
  readonly dominant_color: string | null;
  readonly alt_text: string | null;
  readonly variants: string | null;
  readonly status: MediaStatus;
  readonly scan_result: string | null;
  readonly role: MediaRole | null;
  readonly created_by: UserId | null;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly deleted_at: Timestamp | null;
}

/** `upload_sessions` — R2 multipart state plus the reaper's deadline. */
export interface UploadSessionRow {
  readonly id: UploadSessionId;
  readonly media_id: MediaAssetId;
  readonly r2_bucket: string;
  readonly r2_key: string;
  readonly multipart_upload_id: string;
  readonly parts: string;
  readonly parts_bytes: number;
  readonly state: UploadSessionState;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly expires_at: Timestamp;
  readonly completed_at: Timestamp | null;
}

/** `blog_posts` — same version-scoped shape as `pages`. */
export interface BlogPostRow {
  readonly id: BlogPostId;
  readonly site_id: SiteId;
  readonly site_version_id: SiteVersionId;
  readonly post_key: string;
  readonly status: BlogStatus;
  readonly cover_media_id: MediaAssetId | null;
  readonly author_name: string | null;
  readonly origin: 'ai' | 'human';
  readonly published_at: Timestamp | null;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

/** `blog_post_translations` — the body is always in R2. */
export interface BlogPostTranslationRow {
  readonly id: BlogPostTranslationId;
  readonly post_id: BlogPostId;
  readonly site_version_id: SiteVersionId;
  readonly locale: LocaleCode;
  readonly slug: string;
  readonly path: string;
  readonly title: string;
  readonly excerpt: string | null;
  readonly meta_description: string | null;
  readonly reading_minutes: number | null;
  readonly body_sha256: BlobColumn;
  readonly body_bytes: number;
  readonly render_sha256: BlobColumn | null;
  readonly content_changed_at: Timestamp;
  readonly translation_source: TranslationSource;
  readonly is_stale: BoolInt;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

/** `site_reviews` — `is_visible` is gated on verification for every non-manual platform. */
export interface SiteReviewRow {
  readonly id: SiteReviewId;
  readonly site_id: SiteId;
  readonly platform: ReviewPlatform;
  readonly external_id: string | null;
  readonly verified_at: Timestamp | null;
  readonly author_name: string;
  readonly author_photo_url: string | null;
  readonly rating: number;
  readonly body: string | null;
  readonly locale: LocaleCode | null;
  readonly reviewed_at: Timestamp | null;
  readonly is_visible: BoolInt;
  readonly sort_order: number;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

/** `generation_jobs` — one row per run, with the usage rollup summed from `generation_calls`. */
export interface GenerationJobRow {
  readonly id: GenerationJobId;
  readonly org_id: OrganisationId;
  readonly site_id: SiteId;
  readonly site_version_id: SiteVersionId | null;
  readonly draft_id: DraftId | null;
  readonly kind: GenerationKind;
  readonly requires_entitlement: BoolInt;
  readonly status: GenerationStatus;
  readonly idempotency_key: string;
  /** The queue sentinel: set on enqueue, NULL on every terminal transition. */
  readonly queue_ready_at: Timestamp | null;
  readonly prompt_sha256: BlobColumn;
  readonly cache_prefix_sha256: BlobColumn | null;
  readonly calls_count: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_tokens: number;
  readonly cache_read_tokens: number;
  readonly cost_usd_micro: number;
  readonly budget_reserved_micro: number;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly attempts: number;
  readonly locked_by: string | null;
  readonly lock_expires_at: Timestamp | null;
  readonly queued_at: Timestamp;
  readonly started_at: Timestamp | null;
  readonly finished_at: Timestamp | null;
  /** Generated column: `finished_at - started_at`, NULL until the run ends. */
  readonly duration_ms: number | null;
  readonly created_by: UserId | null;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

/**
 * `generation_calls` — one row per Anthropic call.
 *
 * There is no `thinking_tokens` field, because the Messages API `usage` object has none: thinking
 * is billed inside `output_tokens`. Adding one would always read zero and would make every cost
 * formula that summed it double-count.
 */
export interface GenerationCallRow {
  readonly id: GenerationCallId;
  readonly job_id: GenerationJobId;
  readonly step: GenerationStep;
  readonly attempt: number;
  readonly model: string;
  readonly served_model: string | null;
  readonly fallback_used: BoolInt;
  readonly effort: Effort;
  readonly thinking_type: ThinkingType;
  readonly thinking_display: ThinkingDisplay | null;
  readonly max_tokens: number;
  readonly task_budget_total: number | null;
  readonly streamed: BoolInt;
  readonly output_format: OutputFormat | null;
  readonly schema_name: string | null;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_tokens: number;
  readonly cache_read_tokens: number;
  readonly cost_usd_micro: number;
  readonly stop_reason: string | null;
  readonly refusal_category: string | null;
  readonly repair_rounds: number;
  readonly anthropic_request_id: string | null;
  readonly request_sha256: BlobColumn | null;
  readonly response_sha256: BlobColumn | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly http_status: number | null;
  readonly started_at: Timestamp;
  readonly finished_at: Timestamp | null;
  readonly duration_ms: number | null;
  readonly created_at: Timestamp;
}

/** `generation_job_events` — the durable mirror of the JobHub DO log, for SSE resume. */
export interface GenerationJobEventRow {
  readonly id: number;
  readonly job_id: GenerationJobId;
  /** The DO-assigned sequence. This — never `id` — is the SSE `id` on the wire. */
  readonly seq: number;
  readonly phase: JobPhase;
  readonly message: string | null;
  readonly progress: number;
  readonly data: string | null;
  readonly created_at: Timestamp;
}

/** `deployments` — publish records. */
export interface DeploymentRow {
  readonly id: DeploymentId;
  readonly site_id: SiteId;
  readonly site_version_id: SiteVersionId;
  readonly target: DeploymentTarget;
  readonly status: DeploymentStatus;
  readonly bundle_sha256: BlobColumn | null;
  readonly pages_written: number;
  readonly bytes_written: number;
  readonly url: string | null;
  readonly error_message: string | null;
  readonly started_at: Timestamp | null;
  readonly finished_at: Timestamp | null;
  readonly created_at: Timestamp;
}

/** `leads` — visitor submissions. Free text by design; see the column comments in 0005. */
export interface LeadRow {
  readonly id: LeadId;
  readonly site_id: SiteId;
  readonly org_id: OrganisationId;
  readonly kind: LeadKind;
  readonly locale: LocaleCode | null;
  readonly page_path: string | null;
  readonly name: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly message: string | null;
  readonly fields: string | null;
  readonly requested_at: Timestamp | null;
  readonly party_size: number | null;
  readonly booking_status: BookingStatus | null;
  readonly spam_score: number;
  readonly is_spam: BoolInt;
  readonly turnstile_ok: BoolInt;
  readonly consent_at: Timestamp | null;
  readonly consent_text_sha256: BlobColumn | null;
  readonly ip_hash: BlobColumn | null;
  readonly ip_country: string | null;
  readonly user_agent: string | null;
  readonly purge_after: Timestamp;
  readonly read_at: Timestamp | null;
  readonly replied_at: Timestamp | null;
  readonly archived_at: Timestamp | null;
  readonly notified_at: Timestamp | null;
  readonly created_at: Timestamp;
}

/** `audit_log` — actions, not diffs. The editor undo journal lives in the DO and in R2. */
export interface AuditLogRow {
  readonly id: number;
  readonly ulid: AuditUlid;
  readonly org_id: OrganisationId | null;
  readonly site_id: SiteId | null;
  readonly actor_type: AuditActorType;
  readonly actor_id: string | null;
  readonly action: string;
  readonly target_type: string | null;
  readonly target_id: string | null;
  readonly detail: string | null;
  readonly ip_hash: BlobColumn | null;
  readonly request_id: string | null;
  readonly created_at: Timestamp;
  readonly purge_after: Timestamp;
}

/** `usage_counters` — coarse billing-period aggregates, not a rate limiter. */
export interface UsageCounterRow {
  readonly org_id: OrganisationId;
  readonly period_start: Timestamp;
  readonly metric: UsageMetric;
  readonly value: number;
  readonly limit_value: number | null;
  readonly updated_at: Timestamp;
}

/** `consent_log` — GDPR Article 7(1) accountability: the wording's hash and the moment. */
export interface ConsentLogRow {
  readonly id: ConsentId;
  readonly site_id: SiteId;
  readonly kind: ConsentKind;
  readonly subject_hash: BlobColumn;
  readonly granted: BoolInt;
  readonly locale: LocaleCode | null;
  readonly policy_version: string;
  readonly consent_text_sha256: BlobColumn;
  readonly ip_hash: BlobColumn | null;
  readonly created_at: Timestamp;
  readonly purge_after: Timestamp;
}
