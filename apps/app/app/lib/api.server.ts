import { SESSION_COOKIE_NAME } from './session.server';
import type { Env } from '../env';

/**
 * Every call this Worker makes to `aibuilder-api`, and the rules they all share.
 *
 * WHY THE DASHBOARD DOES NOT WRITE TENANT STATE ITSELF. The API owns the entitlement gate, the rate
 * limiters, the idempotency keys, the budget reservation and the `QuotaDO` accounting. Duplicating
 * any of that here would mean two implementations of a paywall, and the second one is always the
 * one that is out of date. So: this Worker READS the control plane and the shard directly, because
 * a read is a read and the isolation invariant is in the SQL — and it writes nothing that costs
 * money without going through `env.API`.
 *
 * THE SERVICE BINDING IS NOT A NETWORK CALL. `env.API.fetch()` runs the API Worker in the same
 * request context: no DNS, no TLS, no public route, and no way for an attacker to reach these paths
 * without first reaching this Worker. That is why the internal host below is a constant nobody
 * resolves.
 *
 * TWO HEADERS ARE MANDATORY ON EVERY CALL, and both are easy to forget:
 *
 *   `cookie` — the raw session cookie, forwarded verbatim. The API validates the token by hash
 *              against the same `sessions` table, so a forwarded value authenticates exactly as it
 *              would have from the browser. (`__Host-` constrains what a browser may *set*; it says
 *              nothing about server-to-server forwarding.)
 *   `origin` — `DASHBOARD_ORIGIN`. `apps/api`'s Origin guard compares with `===` against an
 *              allowlist that contains exactly the marketing origin and this one, and it rejects a
 *              *missing* Origin on state-changing methods. A service-binding request carries no
 *              Origin unless we set it, so omitting this turns every dashboard action into a 403.
 */

/** The host used for service-binding requests. Never resolved; the binding routes it. */
const INTERNAL_ORIGIN = 'https://api.internal';

/** What the API answered, decoded far enough for a route to branch on it. */
export interface ApiResult<T> {
  readonly status: number;
  readonly ok: boolean;
  /** Parsed JSON body, or `null` when the response carried none or carried invalid JSON. */
  readonly body: T | null;
}

/** Reads the session cookie exactly as the browser sent it, or `null`. */
function sessionCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (header === null) {
    return null;
  }
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index !== -1 && pair.slice(0, index).trim() === SESSION_COOKIE_NAME) {
      return `${SESSION_COOKIE_NAME}=${pair.slice(index + 1).trim()}`;
    }
  }
  return null;
}

/**
 * Calls the API on behalf of the signed-in customer.
 *
 * Only the session cookie is forwarded, never the whole `Cookie` header: the browser may be
 * carrying an anonymous draft cookie from an earlier onboarding, and passing it along would let a
 * dashboard action authorise itself as that draft's owner — a different identity with different
 * rights. Forwarding one named cookie makes the identity of every internal call explicit.
 */
export async function callApi<T>(
  env: Env,
  request: Request,
  path: string,
  init: { readonly method: 'GET' | 'POST'; readonly body?: unknown },
): Promise<ApiResult<T>> {
  const headers = new Headers({
    accept: 'application/json',
    origin: env.DASHBOARD_ORIGIN,
  });
  const cookie = sessionCookie(request);
  if (cookie !== null) {
    headers.set('cookie', cookie);
  }
  if (init.body !== undefined) {
    headers.set('content-type', 'application/json');
  }

  const response = await env.API.fetch(`${INTERNAL_ORIGIN}${path}`, {
    method: init.method,
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

  let body: T | null;
  try {
    // A non-JSON body is not an error worth throwing over: the caller branches on `status`, and a
    // 502 from a cold service binding legitimately carries HTML.
    body = (await response.json()) as T;
  } catch {
    body = null;
  }
  return { status: response.status, ok: response.ok, body };
}

/* ── The four calls the dashboard actually makes ─────────────────────────────────────────────── */

/** What `POST /v1/sites/:id/regenerate` answers with, in each of its documented shapes. */
export interface RegenerateResponse {
  readonly jobId?: string;
  readonly eventsUrl?: string;
  readonly error?: string;
  readonly message?: string;
  readonly messageEn?: string;
  readonly portalUrl?: string;
  readonly reason?: string;
  readonly retryAfter?: number;
}

/**
 * Asks the API to regenerate a site.
 *
 * THE GATE IS THE API'S AND THIS FUNCTION RENDERS WHATEVER IT SAYS. `PHASE2-BILLING-AUTH.md` §7.3
 * is explicit that the server-side gate on this route is a correctness boundary and not a growth
 * mechanism: a refusal writes `generation_jobs.status='blocked_paywall'` with `finished_at` set and
 * answers 402. The dashboard's job is to show that faithfully — including the 409 the quota
 * produces, which after `DECISIONS` §D2 is the limiter customers actually meet (two regenerations
 * per 30 days), not the paywall.
 */
export function regenerateSite(
  env: Env,
  request: Request,
  siteId: string,
): Promise<ApiResult<RegenerateResponse>> {
  return callApi<RegenerateResponse>(env, request, `/v1/sites/${siteId}/regenerate`, {
    method: 'POST',
  });
}

/** What `POST /v1/billing/portal` answers with. */
export interface PortalResponse {
  readonly url?: string;
  readonly error?: string;
  readonly message?: string;
}

/**
 * Mints a Stripe billing-portal session.
 *
 * The portal URL is single-use and short-lived, so it is fetched on the click and never rendered
 * into a page that might sit in a tab for an hour. `owner` is the minimum role the API enforces;
 * this Worker checks the role too, so an editor never sees the button in the first place.
 */
export function createPortalSession(
  env: Env,
  request: Request,
  orgId: string,
): Promise<ApiResult<PortalResponse>> {
  return callApi<PortalResponse>(env, request, '/v1/billing/portal', {
    method: 'POST',
    body: { orgId },
  });
}

/** What `POST /v1/auth/magic-link` answers with. Always 202, always the same body. */
export interface MagicLinkResponse {
  readonly ok?: boolean;
  readonly error?: string;
  readonly message?: string;
}

/**
 * Requests a sign-in link.
 *
 * PROXIED RATHER THAN IMPLEMENTED HERE because the API owns the three things this needs and this
 * Worker deliberately does not have: the Turnstile secret, the `RL_AUTH` rate-limit binding, and
 * the mail sender. It answers 202 for an unknown address exactly as it does for a known one — a 404
 * would be an account-existence oracle — so this function's caller renders one confirmation screen
 * and never branches on whether the account exists.
 */
export function requestMagicLink(
  env: Env,
  request: Request,
  body: { readonly email: string; readonly turnstileToken: string; readonly next: string },
): Promise<ApiResult<MagicLinkResponse>> {
  return callApi<MagicLinkResponse>(env, request, '/v1/auth/magic-link', {
    method: 'POST',
    body,
  });
}
