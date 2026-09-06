import { cp } from '@aibuilder/db';
import type { OrganisationId, StripeEventStatus } from '@aibuilder/db';
import type Stripe from 'stripe';

import type { Env } from '../env';
import { mintClaimToken } from '../ids';

/**
 * `stripe_events` — insert before process, then claim.
 *
 * WHY A CLAIM TOKEN AND NOT A STATUS TEST. D1 has no interactive transactions. `SELECT status …;
 * if (status !== 'processed') { … }` is two statements with a gap in the middle, and two concurrent
 * redeliveries of the same event both read `received`, both pass the test and both run the side
 * effects — one membership becomes two, one dispatch becomes two. The guard has to be a
 * compare-and-swap inside a single UPDATE, with `meta.changes === 1` as the proof, which is exactly
 * the shape `consumeAuthToken` and `consumeClaimToken` already use for single-use tokens.
 *
 * WHY THE CLAIM EXPIRES. A handler that dies between claiming and completing would otherwise wedge
 * the event forever. Two minutes is comfortably above Stripe's 30-second delivery timeout and far
 * below its five-minute first retry, so a crashed handler's claim is re-claimable by the next
 * delivery and never by a concurrent one.
 *
 * WHY THE RAW JSON GOES TO R2. A single Stripe event can exceed D1's 2 MB row cap outright. The
 * ledger keeps `payload_sha256`; the bytes go to `stripe/events/{id}.json`, which is what makes a
 * "what exactly did Stripe send us" question answerable months later.
 */

/** Two minutes. See the header for why this number and not a longer one. */
export const CLAIM_TTL_MS = 120_000;

/** Where the raw event JSON is archived. A pure function of the event id. */
export function eventArchiveKey(eventId: string): string {
  return `stripe/events/${eventId}.json`;
}

/** sha256 of the raw payload, as the ledger stores it. */
export async function sha256(text: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return new Uint8Array(digest);
}

/** Reads `.id` off an event's object without asserting which object it is. */
export function objectIdOf(event: Stripe.Event): string | null {
  const object: unknown = event.data.object;
  if (typeof object !== 'object' || object === null) {
    return null;
  }
  const id = (object as Record<string, unknown>)['id'];
  return typeof id === 'string' ? id : null;
}

/**
 * Archives the raw payload.
 *
 * Best-effort and deliberately swallowed: an archive miss is an observability gap, while failing
 * the webhook over it would make Stripe retry an event we have already processed.
 */
export async function archiveEvent(env: Env, eventId: string, raw: string): Promise<void> {
  try {
    await env.BLOBS.put(eventArchiveKey(eventId), raw, {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });
  } catch {
    // Intentionally ignored; see the JSDoc.
  }
}

/** Records the event, unconditionally. A duplicate is expected and is not an error. */
export async function recordEvent(
  env: Env,
  args: {
    readonly event: Stripe.Event;
    readonly payloadSha256: Uint8Array;
    readonly status: StripeEventStatus;
    readonly orgId: OrganisationId | null;
    readonly lastError: string | null;
    readonly now: number;
  },
): Promise<void> {
  await cp.billing.insertStripeEvent(env.CP, {
    stripeEventId: args.event.id,
    type: args.event.type,
    apiVersion: args.event.api_version,
    livemode: args.event.livemode,
    stripeCreatedAt: args.event.created * 1000,
    objectId: objectIdOf(args.event),
    orgId: args.orgId,
    status: args.status,
    lastError: args.lastError,
    payloadSha256: args.payloadSha256,
    now: args.now,
  });
}

/** A held claim. The token is what every later write on this event is guarded by. */
export interface EventClaim {
  readonly token: Uint8Array;
}

/**
 * Claims the event for processing.
 *
 * `null` means someone else holds it, or it is already processed. Both answer 200 with no side
 * effects: a peer's 200 is the one that counts, and a 500 here would manufacture a retry storm out
 * of correct behaviour.
 */
export async function claimEvent(
  env: Env,
  eventId: string,
  now: number,
): Promise<EventClaim | null> {
  const token = mintClaimToken();
  const claimed = await cp.billing.claimStripeEvent(env.CP, {
    stripeEventId: eventId,
    claimToken: token,
    claimExpiresAt: now + CLAIM_TTL_MS,
    now,
  });
  return claimed ? { token } : null;
}

/** Marks the claimed event processed, attaching the organisation it resolved to. */
export async function completeEvent(
  env: Env,
  args: {
    readonly eventId: string;
    readonly claim: EventClaim;
    readonly orgId: OrganisationId | null;
    readonly now: number;
  },
): Promise<void> {
  await cp.billing.completeStripeEvent(env.CP, {
    stripeEventId: args.eventId,
    claimToken: args.claim.token,
    orgId: args.orgId,
    now: args.now,
  });
}

/** Releases the claim after a failure so the next delivery — or the cron — can re-claim. */
export async function failEvent(
  env: Env,
  args: {
    readonly eventId: string;
    readonly claim: EventClaim;
    readonly orgId: OrganisationId | null;
    readonly message: string;
  },
): Promise<void> {
  await cp.billing.failStripeEvent(env.CP, {
    stripeEventId: args.eventId,
    claimToken: args.claim.token,
    lastError: args.message,
    orgId: args.orgId,
  });
}

/** Records an event we deliberately never process, with its reason. */
export async function skipEvent(env: Env, eventId: string, reason: string): Promise<void> {
  await cp.billing.skipStripeEvent(env.CP, { stripeEventId: eventId, reason });
}
