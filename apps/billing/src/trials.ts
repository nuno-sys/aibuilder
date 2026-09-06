import { cp } from '@aibuilder/db';

import { readSecret } from './env';
import type { Env } from './env';

/**
 * The two prior-trial checks, and the peppering that makes the card half storable.
 *
 * WHY THE TWO CHECKS CANNOT RUN AT THE SAME MOMENT. DECISIONS §D2 asks for a lookup by
 * `email_normalized` AND by `card.fingerprint`. The address is known at submit; the fingerprint is
 * a property of a PaymentMethod that does not exist until the customer has typed a card into
 * Checkout. Pretending otherwise produces a check that never runs, so:
 *
 *   e-mail       → before the Checkout Session is created, in `apps/api` and again here. A hit is a
 *                  REFUSAL (`409 trial_already_used`): no rows, no Stripe objects.
 *   fingerprint  → in `checkout.session.completed`, after the subscription re-read. A hit is a
 *                  CONVERSION, not a refusal (design §5.3) — by then a Customer and a Subscription
 *                  exist and the person is watching the return page.
 *
 * WHY THE FINGERPRINT IS PEPPERED AND NOT STORED IN THE CLEAR. It is a stable identifier for a
 * payment instrument, which makes it pseudonymous personal data under exactly the reading
 * architecture §8 applies to `ip_hash`. A keyed hash means a database copy alone cannot be joined
 * against another merchant's fingerprints, and the pepper lives in the Secrets Store rather than in
 * the same database as the hashes.
 *
 * WHY A MISSING FINGERPRINT IS "NO SIGNAL" AND NOT A REFUSAL. `card.fingerprint` is nullable and on
 * some payment-method shapes absent altogether. A check that failed closed on an optional field
 * would refuse legitimate customers for a reason nobody could explain to them, and the layers that
 * actually bound the loss — `QuotaDO`, `BudgetDO`, Radar — are all still in place.
 */

/** What a prior-trial lookup found, in the only three shapes a caller branches on. */
export type PriorTrial =
  /** No prior trial for this signal, or the signal itself is absent. */
  | { readonly kind: 'none' }
  /** A trial was granted to this identity before. */
  | { readonly kind: 'used'; readonly outcome: 'granted' | 'converted' }
  /** This card has already charged us back. The one case that is refused outright. */
  | { readonly kind: 'disputed' };

/** Hashes a card fingerprint with the pepper. 32 bytes, matching the column's CHECK. */
export async function hashFingerprint(env: Env, fingerprint: string): Promise<Uint8Array> {
  const pepper = await readSecret(env.TRIAL_FINGERPRINT_PEPPER, 'TRIAL_FINGERPRINT_PEPPER');
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(fingerprint + pepper),
  );
  return new Uint8Array(digest);
}

/**
 * Has this address already had a trial?
 *
 * Runs in `apps/api` before any row is written, and again here before `sessions.create` — defence
 * in depth, because this Worker owns the ledger and the API's call could be replayed.
 */
export async function priorTrialForEmail(env: Env, emailNormalized: string): Promise<PriorTrial> {
  const grant = await cp.billing.findTrialByEmail(env.CP, emailNormalized);
  if (grant === null) {
    return { kind: 'none' };
  }
  return grant.outcome === 'converted'
    ? { kind: 'used', outcome: 'converted' }
    : { kind: 'used', outcome: 'granted' };
}

/**
 * Has this CARD already had a trial?
 *
 * `null`/absent fingerprint answers `none`; see the header.
 */
export async function priorTrialForCard(env: Env, fingerprint: string | null): Promise<PriorTrial> {
  if (fingerprint === null || fingerprint.length === 0) {
    return { kind: 'none' };
  }
  const grant = await cp.billing.findTrialByFingerprint(
    env.CP,
    await hashFingerprint(env, fingerprint),
  );
  if (grant === null) {
    return { kind: 'none' };
  }
  if (grant.outcome === 'disputed') {
    return { kind: 'disputed' };
  }
  return grant.outcome === 'converted'
    ? { kind: 'used', outcome: 'converted' }
    : { kind: 'used', outcome: 'granted' };
}
