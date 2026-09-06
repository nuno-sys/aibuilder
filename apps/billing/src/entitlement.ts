import type { Entitlement, OrgPlan } from '@aibuilder/db';

/**
 * The one function that maps a Stripe subscription onto `organisations.entitlement`.
 *
 * PURE, AND DELIBERATELY SO. It takes facts and returns a decision: no bindings, no clock, no
 * network. Every handler that could write an entitlement calls it, so the mapping exists once and a
 * per-event `switch` — the shape in which "trial → active" and "active → past_due" end up
 * disagreeing — cannot grow.
 *
 * PHASE 2 NOTE: design §8.4 places this in `packages/core/src/entitlement.ts`. It is written here
 * because `apps/billing` is its only caller today and the file it names is owned elsewhere; moving
 * it is a copy, an export line and an import change, and nothing about the function needs to
 * change with it.
 *
 * TWO RULES DECIDE EVERY ROW OF THE TABLE BELOW.
 *
 * 1. **A live entitlement always has an expiry.** The schema says so —
 *    `CHECK (entitlement NOT IN ('trialing','active','past_due') OR entitlement_until IS NOT NULL)`
 *    — because an entitlement nobody can revoke by lapse is not an entitlement, it is a permanent
 *    free ride waiting for a webhook to go missing. Every live branch therefore computes a deadline
 *    and falls back to a computed one when Stripe's is absent.
 *
 * 2. **An unrecognised status fails open for the customer and closed for us.** The SDK types
 *    `Subscription.status` as its union plus an open string: Stripe reserves the right to ship a
 *    new status. Such a status maps to `past_due`, which keeps the site serving and keeps
 *    regeneration blocked — the right way round for a state we do not understand — and it expires
 *    in `dunningGraceMs`, so an unnoticed alert cannot become permanent.
 */

/** Fourteen days. Stripe's Smart Retries run well inside it; we mirror its verdict, not our own. */
export const DUNNING_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

/** The trial length Checkout is created with. Only ever used when Stripe reports no `trial_end`. */
const TRIAL_FALLBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** One year: the billing interval of the single Price. Used only when a period end is missing. */
const PERIOD_FALLBACK_MS = 365 * 24 * 60 * 60 * 1000;

/** What the organisation's three entitlement columns become. */
export interface EntitlementDecision {
  readonly entitlement: Entitlement;
  readonly entitlementUntil: number | null;
  readonly plan: OrgPlan;
}

/** The facts the decision is made from. All timestamps are epoch milliseconds. */
export interface EntitlementInput {
  /**
   * NOT a closed union.
   *
   * Typing this as `SubscriptionStatus` would push the open-string problem onto every caller and
   * make the "anything else" branch unreachable — which is precisely the branch that keeps a new
   * Stripe status from becoming a 500 that retries for three days.
   */
  readonly stripeStatus: string;
  readonly trialEndMs: number | null;
  /** From `items.data[0].current_period_end`; the subscription-level field no longer exists. */
  readonly currentPeriodEndMs: number | null;
  readonly endedAtMs: number | null;
  readonly canceledAtMs: number | null;
  readonly nowMs: number;
  readonly dunningGraceMs: number;
}

/** Maps a Stripe subscription status onto the entitlement the paywall reads. */
export function decideEntitlement(input: EntitlementInput): EntitlementDecision {
  const { nowMs } = input;

  switch (input.stripeStatus) {
    case 'trialing':
      return {
        entitlement: 'trialing',
        entitlementUntil: input.trialEndMs ?? nowMs + TRIAL_FALLBACK_MS,
        plan: 'pro',
      };
    case 'active':
      return {
        entitlement: 'active',
        entitlementUntil: input.currentPeriodEndMs ?? nowMs + PERIOD_FALLBACK_MS,
        plan: 'pro',
      };
    case 'past_due':
    case 'unpaid':
      // Not `canceled`: the customer did nothing wrong, an off-session charge failed. Stripe's
      // dunning decides when to give up, and `customer.subscription.deleted` is its verdict.
      return {
        entitlement: 'past_due',
        entitlementUntil: nowMs + input.dunningGraceMs,
        plan: 'pro',
      };
    case 'paused':
      // A paused subscription bills nothing, so it entitles nothing. `entitlement_until` is in the
      // past by construction, which the gate reads as lapsed.
      return { entitlement: 'canceled', entitlementUntil: input.endedAtMs ?? nowMs, plan: 'free' };
    case 'canceled':
      return {
        entitlement: 'canceled',
        entitlementUntil: input.endedAtMs ?? input.canceledAtMs ?? nowMs,
        plan: 'free',
      };
    case 'incomplete':
      // The first payment has not settled. Nothing has been granted yet, so there is nothing to
      // expire — and `none` is the one live-looking state the CHECK allows a NULL deadline on.
      return { entitlement: 'none', entitlementUntil: null, plan: 'free' };
    case 'incomplete_expired':
      return {
        entitlement: 'canceled',
        entitlementUntil: input.canceledAtMs ?? nowMs,
        plan: 'free',
      };
    default:
      return {
        entitlement: 'past_due',
        entitlementUntil: nowMs + input.dunningGraceMs,
        plan: 'pro',
      };
  }
}
