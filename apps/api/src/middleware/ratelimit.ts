import type { MiddlewareHandler } from 'hono';

import type { AppEnv, Env, RateLimitBindingName } from '../env';
import { errorResponse } from '../lib/responses';
import { clientIp, hashIp, toHex } from '../lib/subjects';

/**
 * Layer 4 of the funnel: the Workers Rate Limiting bindings (architecture §8).
 *
 * READ THIS BEFORE RELYING ON A NUMBER HERE. These limits are **approximate** and **per Cloudflare
 * location**. The binding counts inside the colo that served the request, so a client spread across
 * twenty European colos gets twenty times the nominal limit. That is not a defect to be worked
 * around — it is why this is layer 4 of six and not the last one. The strongly consistent limits
 * live in `QuotaDO` (layer 5) and `BudgetDO` (layer 6), which are Durable Objects precisely because
 * a per-colo approximation must never be the thing standing between an attacker and a paid
 * generation.
 *
 * What this layer is genuinely good at is being sub-millisecond and stateless: it absorbs the naive
 * flood — one script, one colo, one IP — before it reaches D1 or a Durable Object at all.
 *
 * The key is a HASHED IP, never a raw one (architecture §8, GDPR posture): the same
 * `sha256(ip || daily_salt)` the abuse ledger uses, so a rate-limit event and an `abuse_events` row
 * describe the same subject without either of them holding an address.
 */

/**
 * The window of each binding, mirroring the `ratelimits` block in `wrangler.jsonc`.
 *
 * Duplicated here only to answer `Retry-After` honestly. The platform does not expose the window
 * through the binding, and a guessed retry hint trains clients to retry at the wrong moment.
 */
const WINDOW_SECONDS: Readonly<Record<RateLimitBindingName, number>> = {
  RL_DRAFT: 60,
  RL_SUBMIT: 60,
  RL_UPLOAD: 60,
  RL_LEADS: 60,
};

/**
 * Consumes one unit against a binding.
 *
 * Returns `true` when the request may proceed. A binding that throws is treated as a pass: this
 * layer is an optimisation in front of the two layers that actually enforce, and failing it closed
 * would turn a platform blip into an outage of the signup funnel.
 */
export async function consumeRateLimit(
  env: Env,
  name: RateLimitBindingName,
  key: string,
): Promise<boolean> {
  try {
    const outcome = await env[name].limit({ key });
    return outcome.success;
  } catch {
    return true;
  }
}

/** The rate-limit key for a request: the hashed client IP, or a constant when there is no IP. */
async function keyForRequest(
  env: Env,
  request: Request,
  name: RateLimitBindingName,
): Promise<string> {
  const ip = clientIp(request);
  if (ip === null) {
    // No `CF-Connecting-IP` means the request did not arrive through the edge. Everything in that
    // bucket shares one key, which is strict rather than lenient — the correct direction here.
    return `${name}:no-ip`;
  }
  return `${name}:${toHex(await hashIp(env, ip))}`;
}

/**
 * Rate-limits a route by hashed client IP.
 *
 * Guarantees the route is not entered when the binding refuses, and answers 429 with an honest
 * `Retry-After` taken from the binding's configured window.
 */
export function rateLimitByIp(name: RateLimitBindingName): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = await keyForRequest(c.env, c.req.raw, name);
    if (!(await consumeRateLimit(c.env, name, key))) {
      const retryAfter = WINDOW_SECONDS[name];
      return errorResponse(
        429,
        'rate_limited',
        'Je gaat iets te snel. Probeer het over een minuut opnieuw.',
        'That was a bit quick. Please try again in a minute.',
        { retryAfterSeconds: retryAfter },
        { 'retry-after': String(retryAfter) },
      );
    }
    await next();
  };
}
