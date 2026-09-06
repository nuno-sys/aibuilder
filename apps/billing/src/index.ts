import { isId } from '@aibuilder/core';

import {
  createCheckoutSession,
  createPortalSession,
  parseCheckoutRequest,
  retrieveCheckoutStatus,
} from './checkout';
import type { Env } from './env';
import { handleStripeEvent } from './webhook/dispatch';
import { verifyStripeRequest } from './webhook/verify';

/**
 * `aibuilder-billing` — the only Worker holding `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.
 *
 * ONE PUBLIC ROUTE, AND THAT IS THE WHOLE AUTHORISATION STORY FOR THE REST.
 * `POST /v1/stripe/webhook` is reachable from the internet because Stripe must reach it, and it
 * authenticates itself: an HMAC over the raw body under a secret only Stripe and this Worker hold.
 * Every other route is served ONLY when the request arrived over the `BILLING` service binding,
 * which is detected by the hostname `apps/api` addresses it with — `billing.internal`. That host is
 * not in any zone, so no request from the internet can carry it: Cloudflare routes to this Worker
 * by the `billing.<domain>/*` pattern, and a request whose Host is `billing.internal` matches no
 * route at all.
 *
 * NO ROUTER LIBRARY. Four routes and a health check do not need one, and the reasoning is the same
 * as `apps/generator/src/index.ts`'s: the startup CPU budget is better spent parsing the Stripe SDK.
 *
 * NO CORS, NO COOKIES, NO `Origin` GUARD. Stripe sends no `Origin` header, and `apps/api`'s
 * `originGuard` rejects a POST without one — which is the second reason this Worker exists
 * separately rather than as a route on the API.
 */

/** The host `apps/api` uses over the service binding. Never resolvable from the internet. */
const INTERNAL_HOST = 'billing.internal';

/** Security headers for every response. This Worker serves no HTML and no scripts, and says so. */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'private, no-store',
  'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'",
};

/** A JSON response carrying the store-nothing headers. */
function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' },
  });
}

/** An empty response, for the webhook and for anything that has nothing to say. */
function empty(status: number): Response {
  return new Response(null, { status, headers: SECURITY_HEADERS });
}

/** Applies the security headers to a response another module built. */
function withHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

/** `POST /v1/stripe/webhook`. Raw body first, then signature, then everything else. */
async function webhook(request: Request, env: Env): Promise<Response> {
  const verified = await verifyStripeRequest(request, env);
  if (!verified.ok) {
    // 400 and never 500: a 5xx makes Stripe retry for three days and then disable the endpoint,
    // for a request that will never verify.
    return new Response(verified.reason, { status: verified.status, headers: SECURITY_HEADERS });
  }
  return withHeaders(await handleStripeEvent(env, verified.event, verified.raw));
}

/** `POST /v1/checkout-sessions` — internal. */
async function checkoutSessions(request: Request, env: Env): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = parseCheckoutRequest(body);
  if (parsed === null) {
    return json({ error: 'invalid_request' }, 400);
  }
  const created = await createCheckoutSession(env, parsed);
  if ('error' in created) {
    return json(created, 409);
  }
  return json(created, 200);
}

/** `POST /v1/portal-sessions` — internal. */
async function portalSessions(request: Request, env: Env): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  const orgId =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['orgId'] : null;
  if (!isId('organisation', orgId)) {
    return json({ error: 'invalid_request' }, 400);
  }
  const url = await createPortalSession(env, orgId);
  return url === null ? json({ error: 'no_customer' }, 404) : json({ url }, 200);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const internal = url.hostname === INTERNAL_HOST;

    if (request.method === 'POST' && url.pathname === '/v1/stripe/webhook') {
      return webhook(request, env);
    }

    if (!internal) {
      // Everything below this line exists for `apps/api` only. A public request for it is answered
      // exactly as a request for a route that does not exist, because as far as the internet is
      // concerned it does not.
      return empty(404);
    }

    if (request.method === 'POST' && url.pathname === '/v1/checkout-sessions') {
      return checkoutSessions(request, env);
    }

    const session = /^\/v1\/checkout-sessions\/(cs_[A-Za-z0-9_]{8,64})$/u.exec(url.pathname);
    if (request.method === 'GET' && session !== null) {
      return json(await retrieveCheckoutStatus(env, session[1] ?? ''), 200);
    }

    if (request.method === 'POST' && url.pathname === '/v1/portal-sessions') {
      return portalSessions(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, environment: env.ENVIRONMENT }, 200);
    }

    return empty(404);
  },
};
