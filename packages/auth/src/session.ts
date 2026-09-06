import { cp, toBytes } from '@aibuilder/db';
import type {
  MembershipRow,
  OrganisationId,
  SessionId,
  SessionRow,
  Timestamp,
  UserId,
} from '@aibuilder/db';

import { SESSION_COOKIE_NAME, readCookie } from './cookies';
import { SHA256_BYTES, hashCredential, sha256, timingSafeEqual } from './crypto';
import { toBase64Url } from './encoding';
import type { AuthEnv } from './env';
import { mintSessionId } from './ids';

/**
 * The session lifecycle: mint, read, slide, rotate, revoke.
 *
 * WHY A SESSION READ IS ONE PAGE READ. `sessions` is `WITHOUT ROWID` on `token_hash`, so the row
 * lives inside the primary-key b-tree and `SQL_GET_SESSION` is a single descent. That statement
 * also carries `revoked_at IS NULL AND expires_at > ?2` as predicates, so there is no code path on
 * which a live session is read and then separately — or never — validated.
 *
 * WHY ONLY THE HASH IS STORED. The cookie carries 256 bits from the platform CSPRNG; the database
 * holds `sha256` of it. A read of the `sessions` table therefore cannot mint a cookie, which is the
 * property that makes a leaked backup a privacy incident rather than an account-takeover incident.
 *
 * ROTATION IS THE FIXATION FIX. Every event that changes what a session is allowed to do mints a
 * NEW row and revokes the old one — never mutates the old one in place. An attacker who plants a
 * `__Host-aib_session` value in a victim's browser holds a token that is revoked the moment the
 * victim proves a factor. §6.4 lists the seven triggers; `rotateSession()` is the one helper all
 * seven call.
 */

/** Bytes of entropy in a session token. 256 bits, from the platform CSPRNG. */
export const SESSION_TOKEN_BYTES = 32;

/** Absolute session lifetime. Slid by `slideSession`, never extended past a fresh 30 days. */
export const SESSION_TTL_MS = 2_592_000_000;

/**
 * How stale `last_seen_at` may get before a read writes.
 *
 * Authentication must not cost a D1 write per request — `sessions` is the hottest table in the
 * product and D1's primary is single-threaded. One hour makes the write rate a function of active
 * users rather than of requests, and the absolute expiry is what actually bounds the session.
 */
export const SESSION_SLIDE_AFTER_MS = 3_600_000;

/** `sessions.user_agent` is `CHECK (length(user_agent) <= 512)`. */
export const USER_AGENT_MAX = 512;

/** A session that has just been created, and the cookie value that addresses it. */
export interface MintedSession {
  /** The raw token, base64url. Goes into `Set-Cookie` and is never stored. */
  readonly cookieValue: string;
  /** `sha256(token bytes)` — exactly what `sessions.token_hash` holds. */
  readonly tokenHash: Uint8Array;
  /** The `ses_…` id, for logs and for `GET /v1/auth/me`. */
  readonly id: SessionId;
  /** Absolute expiry, in unix-epoch milliseconds. */
  readonly expiresAt: Timestamp;
}

/** What a new session is bound to. */
export interface MintSessionArgs {
  readonly userId: UserId;
  /** The organisation the session acts in. `null` until the user belongs to one. */
  readonly activeOrgId: OrganisationId | null;
  /** `sha256(ip || daily_salt)`. Never a raw address (architecture §8, GDPR posture). */
  readonly ipHash: Uint8Array | null;
  readonly userAgent: string | null;
  readonly now: Timestamp;
}

/**
 * Picks the organisation a freshly authenticated session should act in.
 *
 * Ownership first, then administration, then whatever exists, then `null`. `null` is legitimate and
 * not a broken login: a user whose only organisation is still provisional has no membership at all,
 * which is the tenancy isolation invariant (`migrations/cp/0001` — an organisation with zero
 * memberships is unreachable by every authenticated path).
 *
 * The input is `cp.users.listMembershipsForUser`'s covering read, which is ordered by `org_id`, so
 * the fallback is deterministic: a user with two editor memberships lands in the same one on every
 * login rather than in whichever row D1 happened to return first.
 */
export function preferredOrgId(
  memberships: readonly Pick<MembershipRow, 'org_id' | 'role'>[],
): OrganisationId | null {
  const byRole = (
    role: MembershipRow['role'],
  ): Pick<MembershipRow, 'org_id' | 'role'> | undefined =>
    memberships.find((membership) => membership.role === role);
  const chosen = byRole('owner') ?? byRole('admin') ?? memberships[0];
  return chosen === undefined ? null : chosen.org_id;
}

/** Truncates a `User-Agent` to what the column accepts, and maps the empty string to `null`. */
export function boundUserAgent(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').slice(0, USER_AGENT_MAX);
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Mints a session and inserts it.
 *
 * Guarantees 256 bits of CSPRNG entropy in the cookie, that only its `sha256` reaches D1, and that
 * `expires_at` is exactly `now + SESSION_TTL_MS` — which `migrations/cp/0001`'s
 * `CHECK (expires_at > created_at)` then makes unfalsifiable.
 */
export async function mintSession(env: AuthEnv, args: MintSessionArgs): Promise<MintedSession> {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(SESSION_TOKEN_BYTES));
  const tokenHash = await sha256(tokenBytes);
  const id = mintSessionId();
  const expiresAt = args.now + SESSION_TTL_MS;

  await cp.users.insertSession(env.CP, {
    tokenHash,
    id,
    userId: args.userId,
    activeOrgId: args.activeOrgId,
    ipHash: args.ipHash,
    userAgent: args.userAgent,
    now: args.now,
    expiresAt,
  });

  return { cookieValue: toBase64Url(tokenBytes), tokenHash, id, expiresAt };
}

/**
 * Resolves the `sha256` of the session cookie in a `Cookie` header, or `null`.
 *
 * `null` covers every reason equally — no cookie, a truncated one, one that is not base64url of 32
 * bytes — because the caller must not be able to tell them apart, and neither must an attacker.
 */
export async function sessionTokenHash(
  cookieHeader: string | undefined,
): Promise<Uint8Array | null> {
  const value = readCookie(cookieHeader, SESSION_COOKIE_NAME);
  if (value === null) {
    return null;
  }
  return hashCredential(value, SESSION_TOKEN_BYTES);
}

/**
 * Reads the live session a `Cookie` header addresses, or `null`.
 *
 * The liveness predicates are in `SQL_GET_SESSION`, so `null` means missing, forged, revoked or
 * expired — one answer for four causes, which is the only answer that leaks nothing.
 *
 * The returned row's `token_hash` is compared against the hash we looked up, in constant time. That
 * comparison can only fail if D1 returned a row for a different key, so it is an integrity
 * assertion rather than an authentication step — but it is the kind of assertion whose absence is
 * only ever noticed after an incident.
 */
export async function loadSession(
  env: AuthEnv,
  cookieHeader: string | undefined,
  now: Timestamp,
): Promise<SessionRow | null> {
  const tokenHash = await sessionTokenHash(cookieHeader);
  if (tokenHash === null) {
    return null;
  }
  const row = await cp.users.getSessionByTokenHash(env.CP, { tokenHash, now });
  if (row === null) {
    return null;
  }
  const stored = toBytes(row.token_hash);
  if (stored.byteLength !== SHA256_BYTES || !timingSafeEqual(stored, tokenHash)) {
    return null;
  }
  return row;
}

/**
 * Slides a session's activity window, at most once per `SESSION_SLIDE_AFTER_MS`.
 *
 * Returns `true` when it wrote. A revoked session writes nothing — `SQL_TOUCH_SESSION` carries
 * `revoked_at IS NULL` — which is why the return value is worth having: a `false` from a session
 * that was due a slide means it was revoked between the read and the write.
 */
export async function slideSession(
  env: AuthEnv,
  session: SessionRow,
  now: Timestamp,
): Promise<boolean> {
  if (now - session.last_seen_at < SESSION_SLIDE_AFTER_MS) {
    return false;
  }
  return cp.users.touchSession(env.CP, {
    tokenHash: toBytes(session.token_hash),
    now,
    expiresAt: now + SESSION_TTL_MS,
  });
}

/** Revokes one session by its row. Returns `false` when it was already revoked, which is not an error. */
export async function revokeSession(
  env: AuthEnv,
  session: SessionRow,
  now: Timestamp,
): Promise<boolean> {
  return cp.users.revokeSession(env.CP, { tokenHash: toBytes(session.token_hash), now });
}

/** Revokes every live session of a user and returns how many there were. */
export async function revokeAllSessions(
  env: AuthEnv,
  userId: UserId,
  now: Timestamp,
): Promise<number> {
  return cp.users.revokeUserSessions(env.CP, { userId, now });
}

/** What `rotateSession` needs beyond a new session's bindings. */
export interface RotateSessionArgs extends MintSessionArgs {
  /**
   * The session being replaced, or `null` when there was none.
   *
   * `null` is the common case on a magic-link login from a fresh browser; a row is the case that
   * matters, because that row is the one an attacker may have planted.
   */
  readonly previous: SessionRow | null;
}

/**
 * Replaces a session with a fresh one — the single helper behind all seven §6.4 triggers.
 *
 * ORDER IS THE POINT. The new row is inserted BEFORE the old one is revoked, so a failure between
 * the two leaves the user logged in with the old cookie rather than logged out holding neither.
 * The reverse order turns a transient D1 error into "everyone who logged in during the incident
 * has to start again".
 *
 * A revoke that changes nothing is not an error: the previous session may have expired, or a
 * concurrent `logout-all` may have got there first. Either way the caller now holds a session that
 * is strictly newer than anything an attacker could have planted, which is what fixation requires.
 */
export async function rotateSession(env: AuthEnv, args: RotateSessionArgs): Promise<MintedSession> {
  const minted = await mintSession(env, args);
  if (args.previous !== null) {
    await revokeSession(env, args.previous, args.now);
  }
  return minted;
}
