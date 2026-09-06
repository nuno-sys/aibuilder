import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from '../env';

/**
 * The response headers of architecture §S7, on every response this Worker produces.
 *
 * Two of these are corrections rather than defaults, and both are worth stating:
 *
 *  - `interest-cohort=()` is **absent on purpose**. FLoC was withdrawn in 2022 and it was never a
 *    real Permissions-Policy feature; `browsing-topics=()` is the successor opt-out and is the one
 *    that does something.
 *  - `X-Frame-Options: DENY` ships **alongside** the CSP `frame-ancestors` directive on the
 *    surfaces that have one, because `frame-ancestors` does not inherit from `default-src` and
 *    older agents only understand the legacy header.
 *
 * `Strict-Transport-Security` carries `includeSubDomains; preload` because this Worker answers on
 * the control-plane zone, which we own end to end. It must NEVER be sent with those parameters from
 * a customer's custom domain: preloading someone else's apex is close to irreversible and breaks
 * them if they ever leave. That surface (Phase 3) uses `max-age=15768000` and nothing else.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=(), fullscreen=(self)',
  'cross-origin-opener-policy': 'same-origin',
  'x-frame-options': 'DENY',
};

/**
 * Applies `SECURITY_HEADERS` to every response, including errors, 404s and the SSE stream.
 *
 * Mounted outermost so that a response produced by `onError` or `notFound` — the two paths a
 * per-route header helper always misses — carries them too. The headers are written after the
 * handler has run and are set rather than appended, so no route can weaken one by accident.
 */
export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    c.res.headers.set(name, value);
  }
};
