import { boundUserAgent, loadSession, slideSession } from '@aibuilder/auth';
import type { SessionRow, Timestamp } from '@aibuilder/db';

import { sha256Bytes } from './bytes';
import { readSecret } from '../env';
import type { Env } from '../env';

/**
 * How the dashboard knows who is signed in.
 *
 * WHY THIS WORKER READS THE COOKIE ITSELF INSTEAD OF ASKING THE API. `__Host-aib_session` is
 * host-only — that is what the prefix means, and it is a browser-enforced control this system
 * depends on (`PHASE2-BILLING-AUTH.md` §6.4). A cookie set on `api.<domain>` is never sent to
 * `app.<domain>`, so a server-side loader on this Worker cannot see it, and a dashboard whose
 * loaders cannot authenticate is a dashboard that cannot server-render. The design's own answer is
 * in `@aibuilder/auth`'s header: the package exists so that "`apps/api`, `apps/app` and
 * `apps/billing` can all mint a session the same way without any of them owning the rules".
 *
 * So the row in `sessions` is shared and the *cookie* is per host: whichever Worker proves a factor
 * mints the row and sets its own host's cookie. The magic-link interstitial lives here
 * (`/inloggen/verifieren`, which is the URL `@aibuilder/auth`'s `magicLinkUrl()` builds), so the
 * dashboard is where the common login path mints. Only `sha256(token)` is ever stored, so no part
 * of this arrangement lets a database read mint a cookie on either host.
 *
 * WHEN THIS WORKER CALLS THE API, it forwards the raw cookie header. The `__Host-` prefix is a
 * browser contract about what may be *set*; server-side the API validates the token by hash against
 * the same table, so a forwarded value authenticates exactly as it would have from the browser.
 */

/** The session cookie's name. Re-exported from `@aibuilder/auth` so there is one spelling. */
export {
  SESSION_COOKIE_NAME,
  sessionCookieHeader,
  clearSessionCookieHeader,
} from '@aibuilder/auth';

/**
 * Reads the live session behind the request's cookie, sliding its activity window at most hourly.
 *
 * Returns `null` for missing, forged, revoked and expired alike — one answer for four causes, which
 * is the only answer that leaks nothing. The liveness predicates live inside `SQL_GET_SESSION`, so
 * there is no path on which a live session is read and then separately (or never) validated.
 *
 * A MISSING COOKIE COSTS ZERO DATABASE READS. `loadSession` returns before it prepares a statement
 * when the header carries no cookie, which is what makes "an unauthenticated request never reaches
 * data" provable rather than merely intended — `app/__tests__/guard.test.ts` asserts it by counting
 * the statements a D1 double was asked to prepare.
 */
export async function currentSession(
  env: Env,
  request: Request,
  now: Timestamp,
): Promise<SessionRow | null> {
  const session = await loadSession(env, request.headers.get('cookie') ?? undefined, now);
  if (session === null) {
    return null;
  }
  // Best effort: a failed slide must not fail the page. `slideSession` writes at most once an hour,
  // so authentication costs a D1 write per active user rather than per request.
  await slideSession(env, session, now).catch(() => false);
  return session;
}

/** The `User-Agent` as `sessions.user_agent` accepts it: bounded, and empty becomes `null`. */
export function requestUserAgent(request: Request): string | null {
  return boundUserAgent(request.headers.get('user-agent'));
}

/**
 * `sha256(ip || daily_salt)` — the only form an address is ever stored in.
 *
 * Architecture §8's GDPR posture: IPs are never stored raw, the salt rotates daily, and the result
 * is documented as **pseudonymous personal data, not anonymous** — the controller holds the salt
 * and IPv4 is exhaustively enumerable. Returns `null` when the platform gave us no address, which
 * is legitimate: `sessions.ip_hash` is nullable for exactly that case.
 */
export async function requestIpHash(env: Env, request: Request): Promise<Uint8Array | null> {
  const ip = request.headers.get('cf-connecting-ip');
  if (ip === null || ip.length === 0) {
    return null;
  }
  const salt = await readSecret(env.IP_SALT, 'IP_SALT');
  return sha256Bytes(new TextEncoder().encode(`${ip}${salt}`));
}
