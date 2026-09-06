import { loadSession, slideSession } from '@aibuilder/auth';
import type { SessionRow } from '@aibuilder/db';
import type { MiddlewareHandler } from 'hono';

import type { Env } from '../env';
import { errorResponse } from '../lib/responses';

/**
 * `__Host-aib_session` — the authenticated session, resolved once per request.
 *
 * WHY THIS IS ONE PAGE READ AND NOT A JOIN. `sessions` is `WITHOUT ROWID` on `token_hash`, so the
 * row lives inside the primary-key b-tree; `SQL_GET_SESSION` carries `revoked_at IS NULL AND
 * expires_at > ?2` so a stale session is never returned and then separately validated. Everything
 * this middleware does after the read is arithmetic.
 *
 * WHY THE SLIDE IS HOURLY. Authentication must not cost a D1 write per request — D1's primary is
 * single-threaded and this is the hottest read in the product. `slideSession` writes at most once
 * per hour per session, so the write rate is a function of active users rather than of requests,
 * and the absolute 30-day `expires_at` is what actually bounds the session.
 *
 * WHY A FAILED SLIDE IS NOT A FAILED REQUEST. The slide is a `waitUntil`-shaped concern that
 * happens inline only because it is a single indexed UPDATE. If it loses a race with a concurrent
 * `logout-all`, the session is revoked and the NEXT request will fail authentication — which is the
 * correct outcome, arrived at one request later, and not worth turning this request into a 500.
 */

/**
 * Bindings the Phase 2 authentication surface needs that `src/env.ts` does not declare yet.
 *
 * Declared here rather than added to `Env` because `src/env.ts` and `wrangler.jsonc` are owned by
 * another change in this phase; `PHASE2-BILLING-AUTH.md` §8.2 lists all three as additions to
 * `Env`. Intersecting them at the router keeps this module compiling against today's `Env` and
 * makes the merge a deletion rather than a rewrite: when `Env` gains them, this interface and the
 * `` below are the only things that go.
 *
 * All three are `vars` or bindings, never source constants — the control-plane domain is still a
 * placeholder (`DECISIONS.md` §D1) and `WEBAUTHN_RP_ID` in particular is a one-way door that must
 * be swapped before the first passkey is registered.
 */
/** Request-scoped values this middleware puts on the Hono context. */
export interface SessionVariables {
  /**
   * The live session behind `__Host-aib_session`.
   *
   * `SessionRow | undefined` rather than an optional member: `exactOptionalPropertyTypes` is on, and
   * `optionalSession` legitimately sets it to nothing.
   */
  session: SessionRow | undefined;
}

/** The Hono environment every authenticated router and middleware in this Worker is typed against. */
export type SessionEnv = { Bindings: Env; Variables: SessionVariables };

/** 401 for a missing, forged, revoked or expired session cookie. One answer for four causes. */
export function noSessionResponse(): Response {
  return errorResponse(
    401,
    'no_session',
    'Je bent niet (meer) ingelogd. Log opnieuw in om verder te gaan.',
    'You are not signed in. Sign in again to continue.',
  );
}

/**
 * Resolves the session and puts it on the context, without requiring one.
 *
 * For routes that serve both an authenticated and an anonymous caller — `GET /v1/jobs/:id`, which
 * accepts either the draft cookie or a session with a membership in the job's organisation.
 */
export const optionalSession: MiddlewareHandler<SessionEnv> = async (c, next) => {
  const now = Date.now();
  const session = await loadSession(c.env, c.req.header('Cookie'), now);
  if (session !== null) {
    await slideSession(c.env, session, now);
  }
  c.set('session', session ?? undefined);
  await next();
};

/**
 * Requires a live session and puts it on the context.
 *
 * Guarantees that any handler mounted behind it can call `currentSession(c)` and get a row that was
 * live at the moment of the read — which is the only reason a route may then act on that user's
 * behalf.
 */
export const requireSession: MiddlewareHandler<SessionEnv> = async (c, next) => {
  const now = Date.now();
  const session = await loadSession(c.env, c.req.header('Cookie'), now);
  if (session === null) {
    return noSessionResponse();
  }
  await slideSession(c.env, session, now);
  c.set('session', session);
  await next();
};

/**
 * Reads the session `requireSession` put on the context.
 *
 * @throws Error when called from a handler that is not mounted behind `requireSession`. That is a
 * wiring bug, not a runtime condition, and it must fail at the first request rather than silently
 * treat an anonymous caller as somebody.
 */
export function currentSession(c: { get(key: 'session'): SessionRow | undefined }): SessionRow {
  const session = c.get('session');
  if (session === undefined) {
    throw new Error('currentSession() called on a route that is not behind requireSession');
  }
  return session;
}
