import type Stripe from 'stripe';

import type { Env } from '../env';
import { alert } from '../ops';
import { stripeClient } from '../stripe';
import type { HandlerContext, HandlerOutcome } from './context';
import {
  archiveEvent,
  claimEvent,
  completeEvent,
  failEvent,
  recordEvent,
  sha256,
  skipEvent,
} from './events';
import { handleCheckoutCompleted, handleCheckoutExpired } from './handlers/checkout';
import {
  handleInvoiceActionRequired,
  handleInvoicePaid,
  handleInvoicePaymentFailed,
} from './handlers/invoice';
import {
  handleCustomerUpdated,
  handleDisputeClosed,
  handleDisputeCreated,
  handleEarlyFraudWarning,
} from './handlers/risk';
import { handleSubscriptionChanged, handleTrialWillEnd } from './handlers/subscription';

/**
 * The webhook's control flow, in the order that makes redelivery safe.
 *
 *   livemode check → record → archive → CLAIM → handle → complete / fail / skip
 *
 * THE LIVEMODE CHECK COMES FIRST AND ANSWERS 200. A test-mode event reaching production means a
 * misconfigured endpoint or a test key pasted into a live Dashboard, and processing it would grant
 * a real entitlement for a test card. It is recorded, acknowledged and never processed. 200 rather
 * than 4xx is deliberate: a 4xx makes the Dashboard show a failing endpoint and eventually disables
 * it, when the correct outcome is "we saw it, it is not ours".
 *
 * THE CLAIM IS THE ONLY THING BETWEEN A REDELIVERY AND A DOUBLE DISPATCH. It is a compare-and-swap
 * with `meta.changes === 1` asserted; a lost claim answers 200 with no side effects, because either
 * a peer is processing the event right now (its 200 is the one that counts) or the work is already
 * done.
 *
 * A THROWN HANDLER ANSWERS 500 ON PURPOSE. That is the one path where a Stripe retry is what we
 * want: the claim is released, `last_error` records the shape of the failure, and the next delivery
 * — or the hourly reconciliation cron — re-claims it. Everything that is not a bug answers 200.
 */

/** Routes one verified event to its handler. Unknown types are recorded and skipped. */
async function routeEvent(ctx: HandlerContext): Promise<HandlerOutcome> {
  const event = ctx.event;
  switch (event.type) {
    case 'checkout.session.completed':
      return handleCheckoutCompleted(ctx, event.data.object);
    case 'checkout.session.expired':
      return handleCheckoutExpired(ctx, event.data.object);
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return handleSubscriptionChanged(ctx, event.data.object);
    case 'customer.subscription.trial_will_end':
      return handleTrialWillEnd(ctx, event.data.object);
    case 'invoice.paid':
      return handleInvoicePaid(ctx, event.data.object);
    case 'invoice.payment_failed':
      return handleInvoicePaymentFailed(ctx, event.data.object);
    case 'invoice.payment_action_required':
      return handleInvoiceActionRequired(ctx, event.data.object);
    case 'charge.dispute.created':
      return handleDisputeCreated(ctx, event.data.object);
    case 'charge.dispute.closed':
      return handleDisputeClosed(ctx, event.data.object);
    case 'radar.early_fraud_warning.created':
      return handleEarlyFraudWarning(ctx, event.data.object);
    case 'customer.updated':
      return handleCustomerUpdated(ctx, event.data.object);
    default:
      // Recorded rather than ignored, so the Dashboard's configured event list can be audited
      // against what actually arrives.
      return { orgId: null, skipped: 'unhandled_type' };
  }
}

/** A JSON-free response. Stripe reads the status code and nothing else. */
function status(code: 200 | 500): Response {
  return new Response(null, { status: code });
}

/** The two things a caller may supply that this function would otherwise derive itself. */
export interface DispatchOptions {
  /** Injectable so a test can drive the claim-expiry window without sleeping. */
  readonly now?: number;
  /**
   * A Stripe client to use instead of building one.
   *
   * The reconciliation path already holds a client when it re-fetches an event, and building a
   * second one per isolate is wasted startup CPU. It is also the seam the suite drives the handlers
   * through, which is what lets the redelivery and ordering tests run without the network.
   */
  readonly stripe?: Stripe;
}

/**
 * Processes one verified event and returns the response Stripe will see.
 *
 * `raw` is the exact bytes the signature covered; it is archived, and its hash goes in the ledger.
 */
export async function handleStripeEvent(
  env: Env,
  event: Stripe.Event,
  raw: string,
  options: DispatchOptions = {},
): Promise<Response> {
  const now = options.now ?? Date.now();
  const payloadSha256 = await sha256(raw);
  const expectLive = env.ENVIRONMENT === 'production';

  if (event.livemode !== expectLive) {
    await recordEvent(env, {
      event,
      payloadSha256,
      status: 'skipped',
      orgId: null,
      lastError: 'livemode_mismatch',
      now,
    });
    return status(200);
  }

  await recordEvent(env, {
    event,
    payloadSha256,
    status: 'received',
    orgId: null,
    lastError: null,
    now,
  });
  await archiveEvent(env, event.id, raw);

  const claim = await claimEvent(env, event.id, now);
  if (claim === null) {
    return status(200);
  }

  const ctx: HandlerContext = {
    env,
    stripe: options.stripe ?? (await stripeClient(env)),
    event,
    eventCreatedMs: event.created * 1000,
    now,
  };

  let outcome: HandlerOutcome;
  try {
    outcome = await routeEvent(ctx);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
    // The full error goes to the log; the column is bounded at 1 KB and is read on every delivery.
    console.error('billing_webhook_failed', { event: event.id, type: event.type, message });
    await failEvent(env, { eventId: event.id, claim, orgId: null, message });
    return status(500);
  }

  if (outcome.skipped !== undefined) {
    await skipEvent(env, event.id, outcome.skipped);
    return status(200);
  }

  await completeEvent(env, { eventId: event.id, claim, orgId: outcome.orgId, now });
  return status(200);
}

/**
 * Re-processes an event the ledger shows as stuck.
 *
 * The safety net for the one failure Stripe cannot help with: we answered 200 and then crashed.
 * The event is re-fetched from the API rather than replayed from the archive, because by now the
 * objects it points at have moved on and the handlers persist current state, not the snapshot.
 */
export async function reprocessStuckEvent(env: Env, eventId: string, now: number): Promise<void> {
  const stripe = await stripeClient(env);
  const event = await stripe.events.retrieve(eventId);
  const response = await handleStripeEvent(env, event, JSON.stringify(event), { now, stripe });
  if (response.status !== 200) {
    alert('dispatch_failed', { event: eventId, reason: 'reconciliation_failed' });
  }
}
