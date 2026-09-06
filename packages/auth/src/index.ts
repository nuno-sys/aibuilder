/**
 * `@aibuilder/auth` — magic links, sessions and passkey ceremonies.
 *
 * WHAT THIS PACKAGE IS. The authentication policy of the product, as pure functions over an
 * injected control-plane binding. It owns the session lifecycle (mint, read, slide, rotate,
 * revoke), the `__Host-` cookie attribute set, the single-use magic-link token, and the WebAuthn
 * RP ID invariant that architecture §10 calls a one-way door.
 *
 * WHAT THIS PACKAGE IS NOT. It is not a router, it is not a middleware and it holds no bindings.
 * `eslint.config.js` forbids it from importing `cloudflare:*`, so `apps/api`, `apps/app` and
 * `apps/billing` can all mint a session the same way without any of them owning the rules.
 *
 * THE ONE-LINE SUMMARY OF THE SECURITY MODEL. Every credential here is 256 opaque bits from the
 * platform CSPRNG; the database stores only `sha256` of it; every single-use consume is
 * `UPDATE … WHERE consumed_at IS NULL` with the change count asserted; and every event that changes
 * what a session may do mints a new session rather than mutating the old one.
 *
 * @example
 * ```ts
 * import { loadSession, rotateSession, sessionCookieHeader } from '@aibuilder/auth';
 *
 * const current = await loadSession(env, request.headers.get('Cookie') ?? undefined, Date.now());
 * const minted = await rotateSession(env, { previous: current, userId, activeOrgId, ipHash,
 *                                           userAgent, now: Date.now() });
 * headers.append('set-cookie', sessionCookieHeader(minted.cookieValue));
 * ```
 */

export * from './cookies';
export * from './crypto';
export * from './encoding';
export * from './env';
export * from './ids';
export * from './magic-link';
export * from './session';
export * from './webauthn';
