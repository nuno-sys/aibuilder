import Stripe from 'stripe';

import { readSecret } from '../env';
import type { Env } from '../env';
import { subtleCryptoProvider } from '../stripe';

/**
 * Signature verification, and the four rules that make it correct on this runtime.
 *
 * 1. **`request.text()` FIRST.** Before any parse, any log, any branch. A `Request` body can be
 *    read exactly once; calling `request.json()` first — or letting a framework body parser run —
 *    makes the signature unverifiable and produces the well-known "Body has already been used"
 *    failure on Workers. The HMAC covers the raw string byte for byte, so a re-serialised object is
 *    a different payload even when it is the same JSON.
 * 2. **`constructEventAsync`, never `constructEvent`.** The synchronous form reaches for Node's
 *    `crypto` and throws on workerd.
 * 3. **The crypto provider is the FIFTH positional argument.** `(payload, header, secret,
 *    tolerance, cryptoProvider)`. Passing it fourth supplies it as a tolerance, which does not
 *    error — it disables the five-minute timestamp window, silently accepting replays of an old
 *    signed payload forever. `undefined` in the tolerance slot keeps `DEFAULT_TOLERANCE` (300 s).
 * 4. **A bad signature is 400, never 500.** A 5xx makes Stripe retry for three days and then
 *    disable the endpoint, for a request that will never verify. 400 is final and correct.
 */

/** What verification produced: an event, or the status to answer with. */
export type VerifyResult =
  | { readonly ok: true; readonly event: Stripe.Event; readonly raw: string }
  | { readonly ok: false; readonly status: 400; readonly reason: string };

/**
 * Reads the raw body and verifies the `stripe-signature` header over it.
 *
 * Guarantees that no caller can see a parsed event that was not signed by the configured webhook
 * secret within the tolerance window.
 */
export async function verifyStripeRequest(request: Request, env: Env): Promise<VerifyResult> {
  // FIRST. Rule 1 above; everything else in this function depends on it.
  const raw = await request.text();

  const signature = request.headers.get('stripe-signature');
  if (signature === null) {
    return { ok: false, status: 400, reason: 'missing_signature' };
  }

  const secret = await readSecret(env.STRIPE_WEBHOOK_SECRET, 'STRIPE_WEBHOOK_SECRET');

  try {
    const event = await Stripe.webhooks.constructEventAsync(
      raw,
      signature,
      secret,
      undefined,
      subtleCryptoProvider,
    );
    return { ok: true, event, raw };
  } catch (error) {
    if (error instanceof Stripe.errors.StripeSignatureVerificationError) {
      return { ok: false, status: 400, reason: 'bad_signature' };
    }
    // Anything else is our own failure — a missing secret, a broken crypto provider — and must not
    // be reported to Stripe as a bad signature, because that answer is final and would drop a real
    // event on the floor.
    throw error;
  }
}
