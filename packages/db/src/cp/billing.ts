import { changedOne } from '../batch';
import { toArrayBuffer } from '../bytes';
import type {
  InvoiceRow,
  InvoiceStatus,
  OrganisationId,
  StripeCustomerRow,
  StripeEventRow,
  StripeEventStatus,
  Timestamp,
} from '../types';

/**
 * Statements over the Stripe mirror: `stripe_customers`, `stripe_events`, `invoices`, and the
 * `trial_grants` ledger that outlives all three.
 *
 * WHY UPSERT AND NEVER `INSERT OR REPLACE`. `REPLACE` is a DELETE followed by an INSERT, and every
 * table here is either a cascade parent (`stripe_customers` is the RESTRICT parent of
 * `subscriptions`) or carries a `created_at` that a replace would silently reset. On D1 the delete
 * half fires the foreign-key action, so a replace of a customer row with a live subscription is a
 * constraint failure at best and a lost row at worst. `ON CONFLICT … DO UPDATE` writes exactly the
 * columns Stripe can change and leaves identity and history alone.
 *
 * WHY `org_id` IS NEVER IN AN `ON CONFLICT` UPDATE LIST. The customer → organisation edge is the
 * tenancy mapping every later webhook resolves through (design §3.5). A statement that could
 * re-point it would turn one mistaken `client_reference_id` into a cross-tenant entitlement write.
 * It is set once, by the first event that creates the row, and is immutable thereafter.
 *
 * WHY THE EVENT TABLE IS CLAIMED AND NOT MERELY CHECKED. D1 has no interactive transactions, so
 * `SELECT status …; if (status !== 'processed')` races: two concurrent redeliveries both read
 * `received` and both run the side effects. The guard is a compare-and-swap in the WHERE clause
 * plus a `meta.changes === 1` assertion — the same shape `consumeAuthToken` and `consumeClaimToken`
 * already use.
 */

// ---------------------------------------------------------------------------------------------
// stripe_customers
// ---------------------------------------------------------------------------------------------

/**
 * Creates or refreshes the durable `stripe_customer_id → org_id` mapping.
 *
 * `client_reference_id` bootstraps this row on the first `checkout.session.completed`; every later
 * event resolves its organisation through it and never through metadata, which anyone with
 * Dashboard access can edit (design §3.5).
 */
export const SQL_UPSERT_STRIPE_CUSTOMER = `
INSERT INTO stripe_customers (stripe_customer_id, org_id, email, default_pm_brand, default_pm_last4,
                              default_pm_fingerprint, tax_country, created_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
ON CONFLICT(stripe_customer_id) DO UPDATE SET
  email = excluded.email,
  default_pm_brand = excluded.default_pm_brand,
  default_pm_last4 = excluded.default_pm_last4,
  default_pm_fingerprint = excluded.default_pm_fingerprint,
  tax_country = excluded.tax_country,
  updated_at = excluded.updated_at
`;

/** The Stripe customer fields this system mirrors. Everything else stays in Stripe. */
export interface StripeCustomerMirror {
  readonly stripeCustomerId: string;
  readonly orgId: OrganisationId;
  readonly email: string | null;
  readonly defaultPmBrand: string | null;
  readonly defaultPmLast4: string | null;
  readonly defaultPmFingerprint: string | null;
  readonly taxCountry: string | null;
}

/** Builds the customer upsert, for the webhook's one atomic control-plane batch. */
export function upsertStripeCustomerStatement(
  db: D1Database,
  args: StripeCustomerMirror & { readonly now: Timestamp },
): D1PreparedStatement {
  return db
    .prepare(SQL_UPSERT_STRIPE_CUSTOMER)
    .bind(
      args.stripeCustomerId,
      args.orgId,
      args.email,
      args.defaultPmBrand,
      args.defaultPmLast4,
      args.defaultPmFingerprint,
      args.taxCountry,
      args.now,
    );
}

/** The org resolution every non-checkout event starts from. */
export const SQL_GET_STRIPE_CUSTOMER = `
SELECT * FROM stripe_customers WHERE stripe_customer_id = ?1
`;

/** Reads one mirrored customer. `null` means the event belongs to an organisation we do not know. */
export async function getStripeCustomer(
  db: D1Database,
  stripeCustomerId: string,
): Promise<StripeCustomerRow | null> {
  return db.prepare(SQL_GET_STRIPE_CUSTOMER).bind(stripeCustomerId).first<StripeCustomerRow>();
}

/** Seeks `uq_stripe_customers_org`; the portal route needs the customer id for an organisation. */
export const SQL_GET_STRIPE_CUSTOMER_BY_ORG = `
SELECT * FROM stripe_customers WHERE org_id = ?1
`;

/** Reads the organisation's Stripe customer, or `null` before its first completed Checkout. */
export async function getStripeCustomerByOrg(
  db: D1Database,
  orgId: OrganisationId,
): Promise<StripeCustomerRow | null> {
  return db.prepare(SQL_GET_STRIPE_CUSTOMER_BY_ORG).bind(orgId).first<StripeCustomerRow>();
}

// ---------------------------------------------------------------------------------------------
// stripe_events
// ---------------------------------------------------------------------------------------------

/**
 * Records an event BEFORE it is processed. A duplicate is expected and is not an error.
 *
 * `status` is bound rather than fixed at `'received'` so that the two paths which record an event
 * and deliberately never process it — a livemode mismatch, and an event whose organisation cannot
 * be resolved — are one write instead of an insert followed by an update (design §4.3, §4.6).
 */
export const SQL_INSERT_STRIPE_EVENT = `
INSERT INTO stripe_events (stripe_event_id, type, api_version, livemode, stripe_created_at,
                           object_id, org_id, status, attempts, last_error, payload_sha256,
                           received_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?10, ?11)
ON CONFLICT(stripe_event_id) DO NOTHING
`;

/** The header fields of a Stripe event, as the ledger stores them. */
export interface StripeEventHeader {
  readonly stripeEventId: string;
  readonly type: string;
  readonly apiVersion: string | null;
  readonly livemode: boolean;
  readonly stripeCreatedAt: Timestamp;
  readonly objectId: string | null;
  readonly orgId: OrganisationId | null;
  readonly status: StripeEventStatus;
  readonly lastError: string | null;
  /** `sha256(raw)`. The raw JSON goes to R2: one event can exceed D1's 2 MB row cap. */
  readonly payloadSha256: Uint8Array | null;
  readonly now: Timestamp;
}

/** Inserts the ledger row. Returns false when the event was already recorded. */
export async function insertStripeEvent(db: D1Database, args: StripeEventHeader): Promise<boolean> {
  const result = await db
    .prepare(SQL_INSERT_STRIPE_EVENT)
    .bind(
      args.stripeEventId,
      args.type,
      args.apiVersion,
      args.livemode ? 1 : 0,
      args.stripeCreatedAt,
      args.objectId,
      args.orgId,
      args.status,
      args.lastError,
      args.payloadSha256 === null ? null : toArrayBuffer(args.payloadSha256),
      args.now,
    )
    .run();
  return changedOne(result.meta);
}

/**
 * Claims an event for processing, atomically.
 *
 * The three-way predicate is the whole idempotency story. `received` is a first delivery, `failed`
 * is a delivery we asked Stripe to retry, and an expired `processing` claim is a handler that
 * crashed between claiming and completing — all three are re-claimable. A live `processing` claim
 * and a `processed` row are not, and the caller answers 200 without side effects.
 */
export const SQL_CLAIM_STRIPE_EVENT = `
UPDATE stripe_events
SET status = 'processing', claim_token = ?2, claim_expires_at = ?3, attempts = attempts + 1,
    last_error = NULL
WHERE stripe_event_id = ?1
  AND (status = 'received' OR status = 'failed'
       OR (status = 'processing' AND claim_expires_at < ?4))
`;

/** Takes the claim. `false` means a peer holds it, or the work is already done. */
export async function claimStripeEvent(
  db: D1Database,
  args: {
    readonly stripeEventId: string;
    readonly claimToken: Uint8Array;
    readonly claimExpiresAt: Timestamp;
    readonly now: Timestamp;
  },
): Promise<boolean> {
  const result = await db
    .prepare(SQL_CLAIM_STRIPE_EVENT)
    .bind(args.stripeEventId, toArrayBuffer(args.claimToken), args.claimExpiresAt, args.now)
    .run();
  return changedOne(result.meta);
}

/**
 * Marks a claimed event processed.
 *
 * `AND claim_token = ?3` is not decoration: a handler whose claim expired while it was working must
 * not overwrite the state of the peer that re-claimed and finished the event.
 */
export const SQL_COMPLETE_STRIPE_EVENT = `
UPDATE stripe_events
SET status = 'processed', processed_at = ?2, claim_token = NULL, claim_expires_at = NULL,
    org_id = coalesce(?4, org_id)
WHERE stripe_event_id = ?1 AND claim_token = ?3
`;

/** Completes an event, attaching the organisation it resolved to. */
export async function completeStripeEvent(
  db: D1Database,
  args: {
    readonly stripeEventId: string;
    readonly claimToken: Uint8Array;
    readonly orgId: OrganisationId | null;
    readonly now: Timestamp;
  },
): Promise<boolean> {
  const result = await db
    .prepare(SQL_COMPLETE_STRIPE_EVENT)
    .bind(args.stripeEventId, args.now, toArrayBuffer(args.claimToken), args.orgId)
    .run();
  return changedOne(result.meta);
}

/**
 * Releases a claim after a failure, so Stripe's retry (or the reconciliation cron) can re-claim.
 *
 * `last_error` is truncated by the caller to the column's 1 KB bound: this row is read on every
 * delivery and the table is `WITHOUT ROWID`, so the error text sits in the page the idempotency
 * check pulls. The full error goes to the log.
 */
export const SQL_FAIL_STRIPE_EVENT = `
UPDATE stripe_events
SET status = 'failed', claim_token = NULL, claim_expires_at = NULL, last_error = ?3,
    org_id = coalesce(?4, org_id)
WHERE stripe_event_id = ?1 AND claim_token = ?2
`;

/** Records a processing failure and releases the claim. */
export async function failStripeEvent(
  db: D1Database,
  args: {
    readonly stripeEventId: string;
    readonly claimToken: Uint8Array;
    readonly lastError: string;
    readonly orgId: OrganisationId | null;
  },
): Promise<boolean> {
  const result = await db
    .prepare(SQL_FAIL_STRIPE_EVENT)
    .bind(
      args.stripeEventId,
      toArrayBuffer(args.claimToken),
      args.lastError.slice(0, 1000),
      args.orgId,
    )
    .run();
  return changedOne(result.meta);
}

/**
 * Records an event that is deliberately never processed.
 *
 * A type we do not subscribe to, an event for an organisation nothing resolves to, or a livemode
 * that does not match this deployment. All three answer 200 to Stripe: retrying for three days
 * cannot make an organisation appear, and a 4xx would eventually have the endpoint disabled for
 * every other tenant (design §4.6).
 */
export const SQL_SKIP_STRIPE_EVENT = `
UPDATE stripe_events
SET status = 'skipped', claim_token = NULL, claim_expires_at = NULL, last_error = ?2
WHERE stripe_event_id = ?1 AND status <> 'processed'
`;

/** Marks an event skipped, with the reason. */
export async function skipStripeEvent(
  db: D1Database,
  args: { readonly stripeEventId: string; readonly reason: string },
): Promise<boolean> {
  const result = await db
    .prepare(SQL_SKIP_STRIPE_EVENT)
    .bind(args.stripeEventId, args.reason.slice(0, 1000))
    .run();
  return changedOne(result.meta);
}

/** One ledger row, for the reconciliation cron and for tests. */
export const SQL_GET_STRIPE_EVENT = `
SELECT * FROM stripe_events WHERE stripe_event_id = ?1
`;

/** Reads one recorded event. */
export async function getStripeEvent(
  db: D1Database,
  stripeEventId: string,
): Promise<StripeEventRow | null> {
  return db.prepare(SQL_GET_STRIPE_EVENT).bind(stripeEventId).first<StripeEventRow>();
}

/**
 * The reconciliation cron's input: events we acknowledged and did not finish.
 *
 * Seeks `idx_stripe_events_retry`, which is partial on exactly these three statuses. This is the
 * safety net for the one failure Stripe cannot help with — we returned 200 and then crashed.
 */
export const SQL_LIST_STUCK_STRIPE_EVENTS = `
SELECT stripe_event_id, type, status, attempts, received_at
FROM stripe_events
WHERE status IN ('received','processing','failed') AND received_at < ?1
ORDER BY received_at
LIMIT ?2
`;

/** What the reconciliation cron needs to re-fetch and reprocess an event. */
export type StuckStripeEvent = Pick<
  StripeEventRow,
  'stripe_event_id' | 'type' | 'status' | 'attempts' | 'received_at'
>;

/** Lists events stuck for longer than the caller's window. */
export async function listStuckStripeEvents(
  db: D1Database,
  args: { readonly before: Timestamp; readonly limit: number },
): Promise<readonly StuckStripeEvent[]> {
  const result = await db
    .prepare(SQL_LIST_STUCK_STRIPE_EVENTS)
    .bind(args.before, args.limit)
    .all<StuckStripeEvent>();
  return result.results;
}

// ---------------------------------------------------------------------------------------------
// invoices
// ---------------------------------------------------------------------------------------------

/**
 * Mirrors one invoice.
 *
 * `tax_cents` is `sum(invoice.total_taxes[].amount)` computed by the caller: `Invoice.tax` no
 * longer exists in the Stripe API this product pins (design [V5]), and copying a field that is not
 * there would silently store zero VAT on every invoice.
 */
export const SQL_UPSERT_INVOICE = `
INSERT INTO invoices (stripe_invoice_id, org_id, stripe_subscription_id, number, status, currency,
                      subtotal_cents, tax_cents, total_cents, amount_paid_cents,
                      hosted_invoice_url, invoice_pdf_url, period_start, period_end,
                      issued_at, paid_at, created_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?17)
ON CONFLICT(stripe_invoice_id) DO UPDATE SET
  stripe_subscription_id = excluded.stripe_subscription_id,
  number = excluded.number,
  status = excluded.status,
  subtotal_cents = excluded.subtotal_cents,
  tax_cents = excluded.tax_cents,
  total_cents = excluded.total_cents,
  amount_paid_cents = excluded.amount_paid_cents,
  hosted_invoice_url = excluded.hosted_invoice_url,
  invoice_pdf_url = excluded.invoice_pdf_url,
  period_start = excluded.period_start,
  period_end = excluded.period_end,
  paid_at = excluded.paid_at,
  updated_at = excluded.updated_at
`;

/** The invoice fields this system mirrors. */
export interface InvoiceMirror {
  readonly stripeInvoiceId: string;
  readonly orgId: OrganisationId;
  readonly stripeSubscriptionId: string | null;
  readonly number: string | null;
  readonly status: InvoiceStatus;
  readonly currency: string;
  readonly subtotalCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly amountPaidCents: number;
  readonly hostedInvoiceUrl: string | null;
  readonly invoicePdfUrl: string | null;
  readonly periodStart: Timestamp | null;
  readonly periodEnd: Timestamp | null;
  readonly issuedAt: Timestamp;
  readonly paidAt: Timestamp | null;
}

/** Builds the invoice upsert, for the handler's batch. */
export function upsertInvoiceStatement(
  db: D1Database,
  args: InvoiceMirror & { readonly now: Timestamp },
): D1PreparedStatement {
  return db
    .prepare(SQL_UPSERT_INVOICE)
    .bind(
      args.stripeInvoiceId,
      args.orgId,
      args.stripeSubscriptionId,
      args.number,
      args.status,
      args.currency,
      args.subtotalCents,
      args.taxCents,
      args.totalCents,
      args.amountPaidCents,
      args.hostedInvoiceUrl,
      args.invoicePdfUrl,
      args.periodStart,
      args.periodEnd,
      args.issuedAt,
      args.paidAt,
      args.now,
    );
}

/** The dashboard's billing history, newest first. Covered by `idx_invoices_org`. */
export const SQL_LIST_INVOICES_FOR_ORG = `
SELECT stripe_invoice_id, org_id, stripe_subscription_id, number, status, currency,
       subtotal_cents, tax_cents, total_cents, amount_paid_cents, hosted_invoice_url,
       invoice_pdf_url, period_start, period_end, issued_at, paid_at, created_at, updated_at
FROM invoices
WHERE org_id = ?1
ORDER BY issued_at DESC
LIMIT ?2
`;

/** Lists an organisation's invoices. */
export async function listInvoicesForOrg(
  db: D1Database,
  args: { readonly orgId: OrganisationId; readonly limit: number },
): Promise<readonly InvoiceRow[]> {
  const result = await db
    .prepare(SQL_LIST_INVOICES_FOR_ORG)
    .bind(args.orgId, args.limit)
    .all<InvoiceRow>();
  return result.results;
}

// ---------------------------------------------------------------------------------------------
// organisations, as billing writes it
// ---------------------------------------------------------------------------------------------

/**
 * Writes the tax evidence a `customer.updated` carries.
 *
 * PHASE 2 NOTE: design §8.3 places this beside the other `organisations` statements in `./orgs`.
 * It is here because it has exactly one caller — the Stripe `customer.updated` handler — and
 * keeping the Stripe-written columns with the rest of the Stripe mirror is what makes "who writes
 * this column" answerable by grep. Moving it is an export line.
 *
 * `billing_address` is a JSON document (`CHECK (json_valid(...))`), stored rather than exploded
 * into columns because it is evidence for a tax authority, not something this product queries: for
 * electronically supplied services the EU expects two non-contradicting pieces of location
 * evidence, and the address Stripe collected is one of them exactly as it collected it.
 *
 * `vat_validated_at` is bound rather than defaulted to now: it records when STRIPE validated the
 * number, and the difference matters the day a reverse-charge sale is questioned.
 */
export const SQL_SET_ORG_BILLING_PROFILE = `
UPDATE organisations
SET billing_address = ?2, country = coalesce(?3, country), vat_number = ?4,
    vat_validated_at = ?5, billing_email = coalesce(?6, billing_email), updated_at = ?7
WHERE id = ?1 AND deleted_at IS NULL
`;

/** Builds the billing-profile update. */
export function setOrgBillingProfileStatement(
  db: D1Database,
  args: {
    readonly orgId: OrganisationId;
    /** Already `JSON.stringify`d by the caller, or `null`. */
    readonly billingAddress: string | null;
    readonly country: string | null;
    readonly vatNumber: string | null;
    readonly vatValidatedAt: Timestamp | null;
    readonly billingEmail: string | null;
    readonly now: Timestamp;
  },
): D1PreparedStatement {
  return db
    .prepare(SQL_SET_ORG_BILLING_PROFILE)
    .bind(
      args.orgId,
      args.billingAddress,
      args.country,
      args.vatNumber,
      args.vatValidatedAt,
      args.billingEmail,
      args.now,
    );
}

// ---------------------------------------------------------------------------------------------
// trial_grants
// ---------------------------------------------------------------------------------------------

/**
 * How a granted trial ended.
 *
 * PHASE 2 NOTE: this belongs beside the other control-plane enums in `../types`, and the row type
 * below with them; both are declared here so the ledger ships as one reviewable unit.
 */
export type TrialOutcome = 'granted' | 'converted' | 'churned' | 'refused' | 'disputed';

/**
 * `trial_grants` — the prior-trial ledger.
 *
 * Deliberately NOT a view over `stripe_customers`: those rows are deleted with a purged provisional
 * organisation (`ON DELETE RESTRICT` forces the purge to delete them first), which would take the
 * evidence with them. This table has no foreign key to `organisations` for exactly that reason, and
 * it is the one thing the purge does not touch.
 */
export interface TrialGrantRow {
  readonly id: string;
  readonly email_normalized: string;
  /** `sha256(fingerprint || TRIAL_FINGERPRINT_PEPPER)`. Never the fingerprint in the clear. */
  readonly card_fingerprint_sha256: ArrayBuffer | ArrayBufferView | readonly number[] | null;
  readonly org_id: OrganisationId | null;
  readonly stripe_customer_id: string | null;
  readonly stripe_subscription_id: string | null;
  readonly outcome: TrialOutcome;
  readonly granted_at: Timestamp;
  readonly updated_at: Timestamp;
}

/**
 * The pre-Checkout screen: has this address already had a trial?
 *
 * `granted` and `converted` both count. `refused`, `churned` and `disputed` do not gate a second
 * attempt on their own — a churned customer coming back is a customer, and a refusal that was never
 * granted consumed nothing.
 */
export const SQL_FIND_TRIAL_BY_EMAIL = `
SELECT id, email_normalized, org_id, stripe_customer_id, stripe_subscription_id, outcome, granted_at
FROM trial_grants
WHERE email_normalized = ?1 AND outcome IN ('granted','converted')
ORDER BY granted_at DESC
LIMIT 1
`;

/** What a prior-trial hit tells the caller. The card hash never leaves the database. */
export type TrialGrantSummary = Pick<
  TrialGrantRow,
  | 'id'
  | 'email_normalized'
  | 'org_id'
  | 'stripe_customer_id'
  | 'stripe_subscription_id'
  | 'outcome'
  | 'granted_at'
>;

/** Finds a prior trial for a normalized address. */
export async function findTrialByEmail(
  db: D1Database,
  emailNormalized: string,
): Promise<TrialGrantSummary | null> {
  return db.prepare(SQL_FIND_TRIAL_BY_EMAIL).bind(emailNormalized).first<TrialGrantSummary>();
}

/**
 * The post-Checkout screen: has this CARD already had a trial?
 *
 * The fingerprint does not exist until the customer enters a card inside Checkout, so this runs in
 * `checkout.session.completed` and never at submit (design §5.1). `disputed` is included here and
 * excluded above, because a card that has already charged us back is the one case we refuse
 * outright rather than convert.
 */
export const SQL_FIND_TRIAL_BY_FINGERPRINT = `
SELECT id, email_normalized, org_id, stripe_customer_id, stripe_subscription_id, outcome, granted_at
FROM trial_grants
WHERE card_fingerprint_sha256 = ?1 AND outcome IN ('granted','converted','disputed')
ORDER BY granted_at DESC
LIMIT 1
`;

/** Finds a prior trial for a peppered card fingerprint. */
export async function findTrialByFingerprint(
  db: D1Database,
  fingerprintSha256: Uint8Array,
): Promise<TrialGrantSummary | null> {
  return db
    .prepare(SQL_FIND_TRIAL_BY_FINGERPRINT)
    .bind(toArrayBuffer(fingerprintSha256))
    .first<TrialGrantSummary>();
}

/**
 * Records a granted trial.
 *
 * Written in the same batch as the entitlement, so a trial cannot be granted without being
 * recorded — which is the only thing that makes the two lookups above trustworthy.
 *
 * The bare `ON CONFLICT DO NOTHING` leans on `uq_trial_grants_subscription`: a redelivery whose
 * claim expired mid-flight re-runs this batch with a freshly minted id, and without that index the
 * ledger would hold two grants for one subscription and the conversion update below would touch
 * both. The id itself never collides.
 */
export const SQL_INSERT_TRIAL_GRANT = `
INSERT INTO trial_grants (id, email_normalized, card_fingerprint_sha256, org_id,
                          stripe_customer_id, stripe_subscription_id, outcome,
                          granted_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
ON CONFLICT DO NOTHING
`;

/** Builds the trial-grant insert. */
export function insertTrialGrantStatement(
  db: D1Database,
  args: {
    readonly id: string;
    readonly emailNormalized: string;
    readonly cardFingerprintSha256: Uint8Array | null;
    readonly orgId: OrganisationId | null;
    readonly stripeCustomerId: string | null;
    readonly stripeSubscriptionId: string | null;
    readonly outcome: TrialOutcome;
    readonly now: Timestamp;
  },
): D1PreparedStatement {
  return db
    .prepare(SQL_INSERT_TRIAL_GRANT)
    .bind(
      args.id,
      args.emailNormalized,
      args.cardFingerprintSha256 === null ? null : toArrayBuffer(args.cardFingerprintSha256),
      args.orgId,
      args.stripeCustomerId,
      args.stripeSubscriptionId,
      args.outcome,
      args.now,
    );
}

/** Moves a grant to its final outcome: converted on the first paid cycle, churned, or disputed. */
export const SQL_SET_TRIAL_OUTCOME = `
UPDATE trial_grants
SET outcome = ?2, updated_at = ?3
WHERE stripe_subscription_id = ?1
`;

/** Updates the outcome of every grant for a subscription. */
export async function setTrialOutcome(
  db: D1Database,
  args: {
    readonly stripeSubscriptionId: string;
    readonly outcome: TrialOutcome;
    readonly now: Timestamp;
  },
): Promise<boolean> {
  const result = await db
    .prepare(SQL_SET_TRIAL_OUTCOME)
    .bind(args.stripeSubscriptionId, args.outcome, args.now)
    .run();
  return changedOne(result.meta);
}
