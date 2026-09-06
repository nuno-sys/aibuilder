import type { MiddlewareHandler } from 'hono';

import type { AppEnv, Env } from '../env';
import { errorResponse } from '../lib/responses';

/**
 * Layer 2 of the funnel: origin and content type (architecture §8).
 *
 * This is the cheapest layer that can refuse a forged request, and it is written to be boring:
 *
 *  - **`Origin` is `APP_ORIGIN` or `DASHBOARD_ORIGIN`, compared with `===`.** No regex, no suffix
 *    match, no `endsWith`. The dashboard joined the list in Phase 2 because it calls the auth and
 *    billing routes on this Worker.
 *    `/mijnsaas\.com$/` matches `evilmijnsaas.com`, and a suffix test on the control-plane domain
 *    is a working CSRF against every state-changing route at once.
 *  - **A missing `Origin` on a state-changing method is a rejection, not a pass.** Treating absence
 *    as "probably a same-origin form post" is how a `<form>` on an attacker's page reaches a
 *    cookie-authenticated endpoint; every browser that can run the modal sends `Origin` on
 *    `fetch()`, so the only callers this refuses are the ones that should be refused.
 *  - **A state-changing request must declare `application/json`.** A body sent as
 *    `text/plain`, `application/x-www-form-urlencoded` or `multipart/form-data` is a CORS *simple
 *    request*: the browser sends it with cookies and without a preflight. Requiring JSON is what
 *    forces the preflight that the Origin check then answers.
 *
 * CORS lives here too, because the marketing island runs on `www.aibuilder.app` and this API on
 * `api.aibuilder.app`: cross-origin, same-site. `__Host-aib_draft` is `SameSite=Lax` and is
 * therefore sent (SameSite is a registrable-domain test), but the browser will not let the island
 * *read* a response without an exact `Access-Control-Allow-Origin` plus
 * `Access-Control-Allow-Credentials: true`. Both are echoed only on an exact match, never `*`,
 * which `Allow-Credentials` forbids anyway.
 */

/** Methods that can change state and therefore need the Origin and content-type guards. */
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Methods the browser may use cross-origin against this API. */
const ALLOWED_METHODS = 'GET, POST, PUT, OPTIONS';

/** Request headers the browser may set cross-origin. `Last-Event-ID` is set by `EventSource`. */
const ALLOWED_HEADERS = 'content-type, last-event-id';

/** How long a preflight may be cached. Ten minutes: long enough to matter, short enough to change. */
const PREFLIGHT_MAX_AGE = '600';

/**
 * The exact origins allowed to call this Worker: the marketing site and the dashboard.
 *
 * Two entries, both compared with `===`. Never a regex and never a suffix test — `/mijnsaas\.com$/`
 * matches `evilmijnsaas.com`, and that is the whole class of bug this function exists to preclude.
 */
export function allowedOrigins(
  env: Pick<Env, 'APP_ORIGIN' | 'DASHBOARD_ORIGIN'>,
): readonly string[] {
  return [env.APP_ORIGIN, env.DASHBOARD_ORIGIN];
}

/**
 * The caller's origin when it is one of ours, otherwise `null`.
 *
 * Returns the MATCHED origin rather than a boolean because the CORS response has to echo the origin
 * that actually called — echoing `APP_ORIGIN` at a dashboard request produces a header the browser
 * rejects, which is a silent, confusing failure at exactly the surface a customer pays on.
 */
export function matchedOrigin(
  origin: string | undefined,
  env: Pick<Env, 'APP_ORIGIN' | 'DASHBOARD_ORIGIN'>,
): string | null {
  if (origin === undefined) return null;
  return allowedOrigins(env).includes(origin) ? origin : null;
}

/** 403 for a request whose `Origin` is absent or not the application's. Never says which. */
function originRejected(): Response {
  return errorResponse(
    403,
    'origin_rejected',
    'Deze aanvraag komt niet van de app en is geweigerd.',
    'This request did not come from the app and was rejected.',
  );
}

/**
 * Answers preflights and attaches the CORS headers the modal needs to read a response.
 *
 * `Vary: Origin` is appended on **every** response, matched or not, so that a shared cache can
 * never hand a response that was allowed for the app origin to a request from another one — the
 * public `GET /v1/bootstrap` is cacheable, which makes this a correctness requirement and not a
 * formality.
 */
export const appCors: MiddlewareHandler<AppEnv> = async (c, next) => {
  const origin = c.req.header('Origin');
  const matched = matchedOrigin(origin, c.env);

  if (c.req.method === 'OPTIONS') {
    if (matched === null) {
      return originRejected();
    }
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': matched,
        'access-control-allow-credentials': 'true',
        'access-control-allow-methods': ALLOWED_METHODS,
        'access-control-allow-headers': ALLOWED_HEADERS,
        'access-control-max-age': PREFLIGHT_MAX_AGE,
        vary: 'Origin',
      },
    });
  }

  await next();

  if (matched !== null) {
    c.res.headers.set('access-control-allow-origin', matched);
    c.res.headers.set('access-control-allow-credentials', 'true');
  }
  c.res.headers.append('vary', 'Origin');
};

/**
 * Rejects any state-changing request whose `Origin` is not one of ours.
 *
 * Guarantees that `POST`, `PUT`, `PATCH` and `DELETE` reach a route handler only with a present,
 * exactly-matching `Origin` header. Safe methods pass through untouched: `GET /claim` is a link in
 * an e-mail and carries no `Origin` at all.
 */
export const originGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!STATE_CHANGING.has(c.req.method)) {
    await next();
    return;
  }
  if (matchedOrigin(c.req.header('Origin'), c.env) === null) {
    return originRejected();
  }
  await next();
};

/**
 * Requires `Content-Type: application/json` on state-changing requests.
 *
 * Guarantees that no state-changing route can be reached by a form post, which is the request shape
 * that crosses origins without a preflight.
 */
export const jsonContentTypeGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!STATE_CHANGING.has(c.req.method)) {
    await next();
    return;
  }
  const contentType = c.req.header('Content-Type') ?? '';
  // `application/json; charset=utf-8` is the common form, so this is a prefix test on the media
  // type only — after lowercasing, and against the type itself rather than against the whole value.
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (mediaType !== 'application/json') {
    return errorResponse(
      415,
      'unsupported_media_type',
      'Deze aanvraag moet JSON zijn.',
      'This request must be JSON.',
    );
  }
  await next();
};
