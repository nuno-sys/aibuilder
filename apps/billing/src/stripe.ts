import Stripe from 'stripe';

import { readSecret } from './env';
import type { Env } from './env';

/**
 * The Stripe client, and the three constructor options that are not optional on this runtime.
 *
 * `httpClient: Stripe.createFetchHttpClient()` — workerd has no `node:http`, and the SDK's default
 * client reaches for it. The `workerd` export condition already resolves the package to its fetch
 * build, so this is belt and braces rather than the only thing standing between the code and a
 * runtime failure; it is written explicitly because a bundler misconfiguration would otherwise
 * surface as a cryptic error inside the SDK.
 *
 * `apiVersion` — pinned, and pinned to the version the installed SDK was generated against
 * (`stripe@22.6.1` ships `2026-08-26.dahlia`). An unpinned client silently follows the account's
 * default version, which means a Dashboard-side version bump can change the shape of the objects
 * this Worker mirrors without a deploy.
 *
 * `maxNetworkRetries: 2` — every call this Worker makes is either idempotent by construction (a
 * `retrieve`) or carries an `idempotencyKey` (`sessions.create`). Retrying is therefore safe, and
 * the alternative — a transient network blip surfacing as a failed webhook — costs a customer a
 * generation they have paid for.
 *
 * ONE CLIENT PER ISOLATE. Constructing the client parses a large module graph; doing it per request
 * would put that on the latency of every webhook. The cached client is keyed by nothing because the
 * key is the isolate: a Worker isolate holds exactly one environment.
 */

/** Matches `stripe@22.6.1`'s own pinned version. Changing this is an API-shape change. */
export const STRIPE_API_VERSION = '2026-08-26.dahlia';

/** Per-isolate memo. Cleared only by the isolate going away. */
let cached: Stripe | null = null;

/** Builds (or returns) the Stripe client for this isolate. */
export async function stripeClient(env: Env): Promise<Stripe> {
  if (cached !== null) {
    return cached;
  }
  const key = await readSecret(env.STRIPE_SECRET_KEY, 'STRIPE_SECRET_KEY');
  cached = new Stripe(key, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 2,
  });
  return cached;
}

/**
 * The crypto provider every signature operation on this runtime needs.
 *
 * `constructEvent` (the synchronous form) reaches for Node's `crypto` and throws on workerd. The
 * async form takes a provider as its FIFTH positional argument — `(payload, header, secret,
 * tolerance, cryptoProvider)` — and passing it in the fourth position silently supplies it as a
 * tolerance, which disables the timestamp window instead of erroring.
 */
export const subtleCryptoProvider = Stripe.createSubtleCryptoProvider();
