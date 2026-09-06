import { cp, runBatch } from '@aibuilder/db';
import type Stripe from 'stripe';

import { DUNNING_GRACE_MS, decideEntitlement } from '../../entitlement';
import { findAwaitingPaymentJob } from '../../jobs';
import { invoiceMirror, invoiceSubscriptionId, subscriptionMirror } from '../../mirror';
import { alert } from '../../ops';
import { idOf, resolveOrganisation } from '../context';
import type { HandlerContext, HandlerOutcome } from '../context';
import { releaseAndDispatch } from './checkout';

/**
 * `invoice.paid`, `invoice.payment_failed` and `invoice.payment_action_required`.
 *
 * WHAT AN INVOICE EVENT IS ALLOWED TO DECIDE. It mirrors the invoice, and then it re-reads the
 * SUBSCRIPTION and derives the entitlement from that. It never sets an entitlement from the invoice
 * alone: an invoice says what happened to one payment, while the subscription says what the
 * customer is entitled to, and the two disagree for perfectly ordinary reasons (a retried charge, a
 * proration, an out-of-order delivery).
 *
 * WE DO NOT BUILD A DUNNING ENGINE. Stripe's Smart Retries decide when to give up, and
 * `customer.subscription.deleted` (or `updated` to `unpaid`) is its verdict. `past_due` here keeps
 * the site serving and blocks regeneration for the length of the dunning grace, which is the right
 * way round: the customer's site going dark is a worse first symptom of a failed card than an
 * e-mail about it.
 *
 * THE ONE PLACE AN INVOICE RELEASES A JOB. On the trial-abuse path (design §5.3) the trial is ended
 * immediately and the year is invoiced up front, so `checkout.session.completed` deliberately does
 * NOT release the job. `invoice.paid` is where the money actually arrives, and therefore where the
 * generation becomes affordable.
 */

/** Mirrors the invoice and re-derives the entitlement from its subscription. */
async function handleInvoice(
  ctx: HandlerContext,
  invoice: Stripe.Invoice,
  args: { readonly releaseJobOnPaid: boolean; readonly convertsTrial: boolean },
): Promise<HandlerOutcome> {
  const customerId = idOf(invoice.customer);
  const resolved = await resolveOrganisation(ctx.env, { stripeCustomerId: customerId });
  if (resolved === null) {
    alert('org_unresolved', {
      event: ctx.event.id,
      type: ctx.event.type,
      customer: customerId ?? 'none',
    });
    return { orgId: null, skipped: 'org_unresolved' };
  }

  const statements: D1PreparedStatement[] = [
    cp.billing.upsertInvoiceStatement(ctx.env.CP, {
      ...invoiceMirror(invoice, { orgId: resolved.orgId }),
      now: ctx.now,
    }),
  ];

  const subscriptionId = invoiceSubscriptionId(invoice);
  if (subscriptionId !== null && customerId !== null) {
    const subscription = await ctx.stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['default_payment_method', 'items.data.price'],
    });
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
    statements.push(
      ...cp.subscriptions.subscriptionAndEntitlementStatements(ctx.env.CP, {
        subscription: mirror,
        entitlement,
        now: ctx.now,
      }),
    );
  }

  await runBatch(ctx.env.CP, statements);

  if (args.convertsTrial && subscriptionId !== null) {
    await cp.billing.setTrialOutcome(ctx.env.CP, {
      stripeSubscriptionId: subscriptionId,
      outcome: 'converted',
      now: ctx.now,
    });
  }

  if (args.releaseJobOnPaid) {
    const job = await findAwaitingPaymentJob(resolved.shard, resolved.orgId);
    if (job !== null) {
      await releaseAndDispatch(ctx.env, resolved.shard, job, resolved.orgId, ctx.now);
    }
  }

  return { orgId: resolved.orgId };
}

/**
 * `invoice.paid`.
 *
 * `billing_reason` decides whether this closes a trial. `subscription_cycle` is the renewal that
 * follows a trial (or a previous year); `subscription_create` is the immediate charge on the
 * trial-abuse path. Both mean money arrived, and both convert the grant.
 */
export async function handleInvoicePaid(
  ctx: HandlerContext,
  invoice: Stripe.Invoice,
): Promise<HandlerOutcome> {
  const reason = invoice.billing_reason;
  return handleInvoice(ctx, invoice, {
    releaseJobOnPaid: true,
    convertsTrial: reason === 'subscription_cycle' || reason === 'subscription_create',
  });
}

/** `invoice.payment_failed`. The entitlement follows the subscription, which Stripe has moved. */
export async function handleInvoicePaymentFailed(
  ctx: HandlerContext,
  invoice: Stripe.Invoice,
): Promise<HandlerOutcome> {
  return handleInvoice(ctx, invoice, { releaseJobOnPaid: false, convertsTrial: false });
}

/**
 * `invoice.payment_action_required` — the SCA case.
 *
 * Checkout does not challenge at trial signup; it sets the card up for off-session use, so the
 * authentication risk lands on the first real charge. An off-session charge that needs a challenge
 * cannot be completed without the customer, and there is no server-side workaround: the only honest
 * remedy is to surface `hosted_invoice_url`, which the mirror has just stored for the dashboard.
 */
export async function handleInvoiceActionRequired(
  ctx: HandlerContext,
  invoice: Stripe.Invoice,
): Promise<HandlerOutcome> {
  return handleInvoice(ctx, invoice, { releaseJobOnPaid: false, convertsTrial: false });
}
