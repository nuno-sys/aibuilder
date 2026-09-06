/**
 * Every cookie the authenticated surface sets, and the attributes that make them safe.
 *
 * THE `__Host-` PREFIX IS A BROWSER-ENFORCED CONTRACT, not decoration. A browser accepts a
 * `__Host-`-prefixed cookie only when it carries `Secure`, carries `Path=/`, and carries **no
 * `Domain` attribute** — which makes it host-only. Combined with the two-registrable-domain split
 * (`DECISIONS.md` §D1: the control plane and `mijnsaas.com` are different registrable domains),
 * that is what stops attacker-influenced tenant HTML on `*.mijnsaas.com` from ever writing a cookie
 * this API will read. Adding a `Domain` attribute does not loosen the cookie, it makes the browser
 * throw the whole cookie away — so the failure mode of getting this wrong is "nobody can log in",
 * which is why it is asserted as a string in `apps/api/src/__tests__/auth.test.ts` rather than
 * trusted to review.
 *
 * `SameSite=Lax` and not `Strict`: `app.<domain>` calls `api.<domain>`, which is cross-origin but
 * same-site, so `Lax` is sent — and `originGuard` already refuses genuinely cross-site
 * state-changing requests, which is the thing `Strict` would have bought.
 */

/** The authenticated session cookie. Phase 1's `GET /claim` already sets this exact name. */
export const SESSION_COOKIE_NAME = '__Host-aib_session';

/** The short-lived WebAuthn ceremony cookie. Carries a challenge, never an identity. */
export const WEBAUTHN_COOKIE_NAME = '__Host-aib_webauthn';

/** Thirty days, matching `sessions.expires_at` and the anonymous window it replaces. */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 2_592_000;

/** Five minutes. A WebAuthn ceremony that takes longer than this has been abandoned. */
export const WEBAUTHN_COOKIE_MAX_AGE_SECONDS = 300;

/** The attribute tail every cookie here shares. The `__Host-` prefix dictates all four. */
const HOST_PREFIX_ATTRIBUTES = 'Path=/; Secure; HttpOnly; SameSite=Lax';

/** Builds a `Set-Cookie` value with the `__Host-` attribute set. */
function hostCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Max-Age=${String(maxAgeSeconds)}; ${HOST_PREFIX_ATTRIBUTES}`;
}

/** Builds the `Set-Cookie` header value for a freshly minted session. */
export function sessionCookieHeader(
  value: string,
  maxAgeSeconds: number = SESSION_COOKIE_MAX_AGE_SECONDS,
): string {
  return hostCookie(SESSION_COOKIE_NAME, value, maxAgeSeconds);
}

/**
 * Builds the `Set-Cookie` header value that deletes the session cookie.
 *
 * The attributes have to match the ones it was set with, or the browser deletes nothing.
 */
export function clearSessionCookieHeader(): string {
  return hostCookie(SESSION_COOKIE_NAME, '', 0);
}

/** Builds the `Set-Cookie` header value carrying a WebAuthn ceremony challenge. */
export function webauthnCookieHeader(value: string): string {
  return hostCookie(WEBAUTHN_COOKIE_NAME, value, WEBAUTHN_COOKIE_MAX_AGE_SECONDS);
}

/** Builds the `Set-Cookie` header value that deletes the WebAuthn ceremony cookie. */
export function clearWebauthnCookieHeader(): string {
  return hostCookie(WEBAUTHN_COOKIE_NAME, '', 0);
}

/**
 * Reads one cookie out of a `Cookie` header.
 *
 * Hand-rolled rather than taken from `hono/cookie` so that this package — which must stay loadable
 * from a plain test runner and from three Workers — has no framework dependency, and so that the
 * one place cookie parsing happens can be tested against a bare string.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) {
    return null;
  }
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index === -1) {
      continue;
    }
    if (pair.slice(0, index).trim() === name) {
      return pair.slice(index + 1).trim();
    }
  }
  return null;
}
