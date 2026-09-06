import { setEntitlementStatement } from './orgs';
import type {
  Entitlement,
  OrganisationId,
  OrgPlan,
  SubscriptionRow,
  SubscriptionStatus,
  Timestamp,
} from '../types';

/**
 * Statements over `subscriptions`, the Stripe mirror the paywall is denormalised from.
 *
 * THE INVARIANT THIS MODULE EXISTS TO ENFORCE. `organisations.entitlement` is a denormalisation of
 * a subscription's status (architecture §5.2), and the only thing that keeps a denormalisation
 * honest is writing both sides together. `subscriptionAndEntitlementStatements()` therefore returns
 * BOTH statements and there is no exported way to write one without the other; every caller feeds
 * the pair into a single `batch()`, which on D1 is atomic.
 *
 * THE ORDERING GUARD. Stripe does not guarantee webhook delivery order and the payload is a
 * snapshot from when the event was created rather than from now. Every handler therefore re-reads
 * the object from the Stripe API before persisting, which makes ordering irrelevant. The
 * `stripe_updated_at` predicate below is the second line of defence for the remaining case: two
 * handlers running concurrently, where the LATER event's re-read completes first. It compares
 * against the event's creation time, not against the wall clock.
 *
 * WHY `org_id` AND `stripe_customer_id` ARE NOT UPDATED ON CONFLICT. They are the tenancy edge. A
 * statement able to re-point a live subscription at another organisation turns one bad
 * `client_reference_id` into a cross-tenant entitlement write; the columns are set by the insert
 * that creates the row and are immutable afterwards.
 */

/** The subscription fields this system mirrors. Stripe stays the source of truth for the rest. */
export interface SubscriptionMirror {
  readonly stripeSubscriptionId: string;
  readonly orgId: OrganisationId;
  readonly stripeCustomerId: string;
  /**
   * Already clamped to the schema's closed set by the caller.
   *
   * The Stripe SDK types `Subscription.status` as its union PLUS an open string — Stripe reserves
   * the right to ship a new status — while this column's CHECK is a closed set on a table that can
   * never be rebuilt. An unrecognised status is stored as `past_due` and raises an alert, because
   * the alternative is a webhook that fails its CHECK and then retries for three days.
   */
  readonly status: SubscriptionStatus;
  readonly stripePriceId: string;
  readonly stripeProductId: string | null;
  readonly currency: string;
  readonly unitAmountCents: number;
  readonly billingInterval: 'month' | 'year';
  readonly intervalCount: number;
  readonly quantity: number;
  readonly trialStart: Timestamp | null;
  readonly trialEnd: Timestamp | null;
  /** From `items.data[0].current_period_start`; the subscription-level field no longer exists. */
  readonly currentPeriodStart: Timestamp | null;
  /** From `items.data[0].current_period_end`; likewise. */
  readonly currentPeriodEnd: Timestamp | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly canceledAt: Timestamp | null;
  readonly endedAt: Timestamp | null;
  readonly latestInvoiceId: string | null;
  readonly collectionMethod: 'charge_automatically' | 'send_invoice';
  /** `event.created * 1000`. The ordering guard compares against this, never against `Date.now()`. */
  readonly stripeUpdatedAt: Timestamp;
}

/**
 * Creates or refreshes the mirrored subscription.
 *
 * `WHERE excluded.stripe_updated_at >= subscriptions.stripe_updated_at` is the ordering guard.
 * `>=` and not `>`: `event.created` has one-second resolution, so a redelivery — or a second event
 * created in the same second — must still write the state the handler just re-read from the API,
 * and writing the same current state twice is a no-op by content.
 */
export const SQL_UPSERT_SUBSCRIPTION = `
INSERT INTO subscriptions (stripe_subscription_id, org_id, stripe_customer_id, status,
                           stripe_price_id, stripe_product_id, currency, unit_amount_cents,
                           billing_interval, interval_count, quantity, trial_start, trial_end,
                           current_period_start, current_period_end, cancel_at_period_end,
                           canceled_at, ended_at, latest_invoice_id, collection_method,
                           stripe_updated_at, created_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19,
        ?20, ?21, ?22, ?22)
ON CONFLICT(stripe_subscription_id) DO UPDATE SET
  status = excluded.status,
  stripe_price_id = excluded.stripe_price_id,
  stripe_product_id = excluded.stripe_product_id,
  currency = excluded.currency,
  unit_amount_cents = excluded.unit_amount_cents,
  billing_interval = excluded.billing_interval,
  interval_count = excluded.interval_count,
  quantity = excluded.quantity,
  trial_start = excluded.trial_start,
  trial_end = excluded.trial_end,
  current_period_start = excluded.current_period_start,
  current_period_end = excluded.current_period_end,
  cancel_at_period_end = excluded.cancel_at_period_end,
  canceled_at = excluded.canceled_at,
  ended_at = excluded.ended_at,
  latest_invoice_id = excluded.latest_invoice_id,
  collection_method = excluded.collection_method,
  stripe_updated_at = excluded.stripe_updated_at,
  updated_at = excluded.updated_at
WHERE excluded.stripe_updated_at >= subscriptions.stripe_updated_at
`;

/** Builds the subscription upsert. Private on purpose — see the module header. */
function upsertSubscriptionStatement(
  db: D1Database,
  args: SubscriptionMirror & { readonly now: Timestamp },
): D1PreparedStatement {
  return db
    .prepare(SQL_UPSERT_SUBSCRIPTION)
    .bind(
      args.stripeSubscriptionId,
      args.orgId,
      args.stripeCustomerId,
      args.status,
      args.stripePriceId,
      args.stripeProductId,
      args.currency,
      args.unitAmountCents,
      args.billingInterval,
      args.intervalCount,
      args.quantity,
      args.trialStart,
      args.trialEnd,
      args.currentPeriodStart,
      args.currentPeriodEnd,
      args.cancelAtPeriodEnd ? 1 : 0,
      args.canceledAt,
      args.endedAt,
      args.latestInvoiceId,
      args.collectionMethod,
      args.stripeUpdatedAt,
      args.now,
    );
}

/** The entitlement half of the pair, as `decideEntitlement()` produced it. */
export interface EntitlementWrite {
  readonly entitlement: Entitlement;
  /**
   * `null` only for `none` and `canceled`.
   *
   * `CHECK (entitlement NOT IN ('trialing','active','past_due') OR entitlement_until IS NOT NULL)`
   * — a live entitlement with no expiry is one nobody can revoke by lapse, so the schema refuses it
   * and the decision function always computes a deadline.
   */
  readonly entitlementUntil: Timestamp | null;
  readonly plan: OrgPlan;
}

/**
 * The subscription mirror and the organisation's entitlement, as ONE ordered pair.
 *
 * Returned rather than executed so the caller can put them in a batch alongside the membership
 * insert, the de-provision and the trial grant — which is what makes "the entitlement and the
 * subscription are always written together" a property of the schema access layer rather than a
 * rule handlers are asked to remember.
 */
export function subscriptionAndEntitlementStatements(
  db: D1Database,
  args: {
    readonly subscription: SubscriptionMirror;
    readonly entitlement: EntitlementWrite;
    readonly now: Timestamp;
  },
): readonly D1PreparedStatement[] {
  return [
    upsertSubscriptionStatement(db, { ...args.subscription, now: args.now }),
    setEntitlementStatement(db, {
      orgId: args.subscription.orgId,
      entitlement: args.entitlement.entitlement,
      entitlementUntil: args.entitlement.entitlementUntil,
      plan: args.entitlement.plan,
      now: args.now,
    }),
  ];
}

/** One mirrored subscription by id. */
export const SQL_GET_SUBSCRIPTION = `
SELECT * FROM subscriptions WHERE stripe_subscription_id = ?1
`;

/** Reads one mirrored subscription. */
export async function getSubscription(
  db: D1Database,
  stripeSubscriptionId: string,
): Promise<SubscriptionRow | null> {
  return db.prepare(SQL_GET_SUBSCRIPTION).bind(stripeSubscriptionId).first<SubscriptionRow>();
}

/**
 * An organisation's live subscriptions, newest state first.
 *
 * Seeks `idx_subs_org_status`. Used by the provisional-organisation purge, which must never delete
 * an organisation that still has a live billing relationship, and by the dashboard.
 */
export const SQL_LIST_LIVE_SUBSCRIPTIONS_FOR_ORG = `
SELECT stripe_subscription_id, org_id, stripe_customer_id, status, current_period_end, trial_end,
       cancel_at_period_end
FROM subscriptions
WHERE org_id = ?1 AND status IN ('trialing','active','past_due','unpaid','paused')
`;

/** The subset the purge and the dashboard need. */
export type LiveSubscription = Pick<
  SubscriptionRow,
  | 'stripe_subscription_id'
  | 'org_id'
  | 'stripe_customer_id'
  | 'status'
  | 'current_period_end'
  | 'trial_end'
  // The dashboard's billing page has to be able to say "ends on <date>" rather than
  // "renews on <date>". Without it the two states are indistinguishable to a customer who
  // has already cancelled, which is the single most support-generating ambiguity in billing.
  | 'cancel_at_period_end'
>;

/** Lists an organisation's non-terminal subscriptions. Empty means nothing is being billed. */
export async function listLiveSubscriptionsForOrg(
  db: D1Database,
  orgId: OrganisationId,
): Promise<readonly LiveSubscription[]> {
  const result = await db
    .prepare(SQL_LIST_LIVE_SUBSCRIPTIONS_FOR_ORG)
    .bind(orgId)
    .all<LiveSubscription>();
  return result.results;
}

/**
 * Trials ending inside the caller's window.
 *
 * Seeks `idx_subs_trial_ending`, which is partial on `status = 'trialing'`. Feeds the nightly
 * reconciliation that corrects entitlements whose webhook never arrived — the gate refuses a lapsed
 * entitlement on its own, and this is what puts the column back in agreement with Stripe.
 */
export const SQL_LIST_ENDING_TRIALS = `
SELECT stripe_subscription_id, org_id, stripe_customer_id, status, current_period_end, trial_end
FROM subscriptions
WHERE status = 'trialing' AND trial_end IS NOT NULL AND trial_end < ?1
ORDER BY trial_end
LIMIT ?2
`;

/** Lists trialing subscriptions whose trial ends before `before`. */
export async function listEndingTrials(
  db: D1Database,
  args: { readonly before: Timestamp; readonly limit: number },
): Promise<readonly LiveSubscription[]> {
  const result = await db
    .prepare(SQL_LIST_ENDING_TRIALS)
    .bind(args.before, args.limit)
    .all<LiveSubscription>();
  return result.results;
}
