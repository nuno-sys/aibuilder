import { cp, runBatch } from '@aibuilder/db';
import type Stripe from 'stripe';

import { DUNNING_GRACE_MS, decideEntitlement } from '../../entitlement';
import { clampSubscriptionStatus, subscriptionMirror } from '../../mirror';
import { alert } from '../../ops';
import { idOf, resolveOrganisation } from '../context';
import type { HandlerContext, HandlerOutcome } from '../context';

/**
 * The subscription lifecycle: `created`, `updated`, `deleted`, and `trial_will_end`.
 *
 * ONE CODE PATH FOR THREE EVENTS, ON PURPOSE. Every one of them re-reads the subscription from the
 * Stripe API and persists THAT, so the three handlers differ only in what they do besides the
 * mirror. Applying payloads per event type is how "trial → active delivered after cancelled"
 * resurrects a cancelled subscription: Stripe does not guarantee delivery order, and the payload is
 * a snapshot from when the event was created rather than the object as it is now.
 *
 * `cancel_at_period_end = true` IS NOT A STATE CHANGE. The subscription is still `active` and the
 * customer keeps the period they paid for; the entitlement stays `active` with
 * `entitlement_until = current_period_end`. `customer.subscription.deleted` at the end of that
 * period does the transition, and until it arrives there is nothing to revoke.
 */

/** Re-reads, mirrors and writes the subscription plus the entitlement it implies. */
async function mirrorSubscription(
  ctx: HandlerContext,
  subscriptionId: string,
  customerId: string | null,
): Promise<HandlerOutcome> {
  const resolved = await resolveOrganisation(ctx.env, { stripeCustomerId: customerId });
  if (resolved === null) {
    alert('org_unresolved', {
      event: ctx.event.id,
      type: ctx.event.type,
      customer: customerId ?? 'none',
    });
    return { orgId: null, skipped: 'org_unresolved' };
  }
  if (customerId === null) {
    return { orgId: resolved.orgId, skipped: 'no_customer' };
  }

  const subscription = await ctx.stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['default_payment_method', 'items.data.price'],
  });

  const clamped = clampSubscriptionStatus(subscription.status);
  if (!clamped.recognised) {
    alert('unknown_subscription_status', {
      event: ctx.event.id,
      status: subscription.status,
      subscription: subscription.id,
    });
  }

  const mirror = subscriptionMirror(subscription, {
    orgId: resolved.orgId,
    stripeCustomerId: customerId,
    stripeUpdatedAt: ctx.eventCreatedMs,
    fallbackPriceId: ctx.env.STRIPE_PRICE_ID,
    nowMs: ctx.now,
  });
  const entitlement = decideEntitlement({
    stripeStatus: subscription.status,
    trialEndMs: mirror.trialEnd,
    currentPeriodEndMs: mirror.currentPeriodEnd,
    endedAtMs: mirror.endedAt,
    canceledAtMs: mirror.canceledAt,
    nowMs: ctx.now,
    dunningGraceMs: DUNNING_GRACE_MS,
  });

  await runBatch(
    ctx.env.CP,
    cp.subscriptions.subscriptionAndEntitlementStatements(ctx.env.CP, {
      subscription: mirror,
      entitlement,
      now: ctx.now,
    }),
  );

  // A cancelled subscription closes the trial ledger entry. The row itself is never deleted: it is
  // the prior-trial evidence, and it deliberately outlives both the subscription and the
  // organisation.
  if (clamped.status === 'canceled') {
    await cp.billing.setTrialOutcome(ctx.env.CP, {
      stripeSubscriptionId: subscription.id,
      outcome: 'churned',
      now: ctx.now,
    });
  }

  return { orgId: resolved.orgId };
}

/**
 * `customer.subscription.created` / `.updated` / `.deleted`.
 *
 * `created` is usually redundant with `checkout.session.completed` and is subscribed to anyway: it
 * is the safety net for a lost session event, and both are idempotent.
 */
export async function handleSubscriptionChanged(
  ctx: HandlerContext,
  subscription: Stripe.Subscription,
): Promise<HandlerOutcome> {
  return mirrorSubscription(ctx, subscription.id, idOf(subscription.customer));
}

/**
 * `customer.subscription.trial_will_end` — three days before the first real charge.
 *
 * No state change by design: the subscription is exactly what it was, and writing anything here
 * would be inventing a transition Stripe has not made. Its purpose is one e-mail, and idempotency
 * comes from `stripe_events`, so a redelivery cannot double-mail.
 *
 * PHASE 2 (handover): the mailer is not part of this delivery. Nothing in this product sends
 * transactional e-mail until SPF/DKIM/DMARC `p=reject` are in place (architecture §10 risk 7), and
 * the same is true of the claim link. When the sender lands, it is called from here.
 */
export async function handleTrialWillEnd(
  ctx: HandlerContext,
  subscription: Stripe.Subscription,
): Promise<HandlerOutcome> {
  const resolved = await resolveOrganisation(ctx.env, {
    stripeCustomerId: idOf(subscription.customer),
  });
  if (resolved === null) {
    alert('org_unresolved', { event: ctx.event.id, type: ctx.event.type });
    return { orgId: null, skipped: 'org_unresolved' };
  }
  return { orgId: resolved.orgId, skipped: 'notification_only' };
}
