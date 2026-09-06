import { assertSingleChange, changedOne } from '../batch';
import { toArrayBuffer } from '../bytes';
import type {
  AuthTokenId,
  AuthTokenPurpose,
  AuthTokenRow,
  LocaleCode,
  MembershipRole,
  MembershipRow,
  OrganisationId,
  SessionId,
  SessionRow,
  Timestamp,
  UserId,
  UserRow,
} from '../types';

/**
 * Statements over `users`, `memberships`, `sessions` and `auth_tokens`.
 *
 * Two of these are load-bearing beyond their apparent simplicity:
 *
 *   - `getSessionByTokenHash` is the hottest read in the product. `sessions` is WITHOUT ROWID on
 *     `token_hash`, so the row lives in the primary-key b-tree and this is a single page read.
 *   - `consumeAuthToken` is the only thing standing between a replayed magic link and a second
 *     session. D1 has no interactive transactions; the `AND consumed_at IS NULL` predicate plus the
 *     `meta.changes` assertion IS the transaction.
 */

/**
 * The live user for a normalized address.
 *
 * Reads through `uq_users_email_live`, which carries the soft-delete predicate. The separate TOTAL
 * unique index means a soft-deleted address still reserves itself, so this returning `null` does
 * NOT mean the address is available — that is `slugs.ts`-style reservation logic, and registration
 * asks the total index, not this statement.
 */
export const SQL_GET_USER_BY_EMAIL = `
SELECT * FROM users WHERE email_normalized = ?1 AND deleted_at IS NULL
`;

/** Reads the live user for a normalized e-mail address. */
export async function getUserByEmail(
  db: D1Database,
  emailNormalized: string,
): Promise<UserRow | null> {
  return db.prepare(SQL_GET_USER_BY_EMAIL).bind(emailNormalized).first<UserRow>();
}

/** Reads one user by id. */
export const SQL_GET_USER = `
SELECT * FROM users WHERE id = ?1
`;

/** Reads one user by id, including a soft-deleted one. */
export async function getUser(db: D1Database, userId: UserId): Promise<UserRow | null> {
  return db.prepare(SQL_GET_USER).bind(userId).first<UserRow>();
}

/**
 * Creates a user.
 *
 * `password_hash` is not a parameter and never will be: the column exists only as a CHECK-enforced
 * tripwire (architecture §5.2 — magic link and passkeys, forever).
 */
export const SQL_INSERT_USER = `
INSERT INTO users (id, email, email_normalized, full_name, locale, country, marketing_opt_in,
                   email_verified_at, created_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
`;

/** Inserts a user. Fails on `uq_users_email_total` if the address was ever registered. */
export async function insertUser(
  db: D1Database,
  args: {
    readonly id: UserId;
    readonly email: string;
    readonly emailNormalized: string;
    readonly fullName: string | null;
    readonly locale: LocaleCode;
    readonly country: string | null;
    readonly marketingOptIn: 0 | 1;
    readonly emailVerifiedAt: Timestamp | null;
    readonly now: Timestamp;
  },
): Promise<void> {
  const result = await db
    .prepare(SQL_INSERT_USER)
    .bind(
      args.id,
      args.email,
      args.emailNormalized,
      args.fullName,
      args.locale,
      args.country,
      args.marketingOptIn,
      args.emailVerifiedAt,
      args.now,
    )
    .run();
  assertSingleChange(result.meta, 'insertUser');
}

/** Creates the user ↔ org edge that makes an organisation reachable. */
export const SQL_INSERT_MEMBERSHIP = `
INSERT INTO memberships (org_id, user_id, role, invited_by, accepted_at, created_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6)
`;

/**
 * Builds the membership insert.
 *
 * Returned as a statement rather than executed, because claim writes it in the same batch as
 * `deprovisionOrganisationStatement()` and the order within that batch is the invariant: membership
 * first, de-provision second.
 */
export function insertMembershipStatement(
  db: D1Database,
  args: {
    readonly orgId: OrganisationId;
    readonly userId: UserId;
    readonly role: MembershipRole;
    readonly invitedBy: UserId | null;
    readonly acceptedAt: Timestamp | null;
    readonly now: Timestamp;
  },
): D1PreparedStatement {
  return db
    .prepare(SQL_INSERT_MEMBERSHIP)
    .bind(args.orgId, args.userId, args.role, args.invitedBy, args.acceptedAt, args.now);
}

/** The authorisation lookup: does this user hold a role in this organisation? */
export const SQL_GET_MEMBERSHIP = `
SELECT org_id, user_id, role, invited_by, accepted_at, created_at
FROM memberships
WHERE user_id = ?1 AND org_id = ?2
`;

/**
 * Reads the caller's membership in one organisation.
 *
 * `null` means no access. Every org-scoped route asks this before touching a shard, because a
 * shard has no foreign key back to the control plane and therefore cannot re-check it.
 */
export async function getMembership(
  db: D1Database,
  args: { readonly userId: UserId; readonly orgId: OrganisationId },
): Promise<MembershipRow | null> {
  return db.prepare(SQL_GET_MEMBERSHIP).bind(args.userId, args.orgId).first<MembershipRow>();
}

/** Covering read over `idx_memberships_user`: never touches the table b-tree. */
export const SQL_LIST_MEMBERSHIPS_FOR_USER = `
SELECT user_id, org_id, role FROM memberships WHERE user_id = ?1 ORDER BY org_id
`;

/** Lists the organisations a user belongs to, and the role they hold in each. */
export async function listMembershipsForUser(
  db: D1Database,
  userId: UserId,
): Promise<readonly Pick<MembershipRow, 'user_id' | 'org_id' | 'role'>[]> {
  const result = await db
    .prepare(SQL_LIST_MEMBERSHIPS_FOR_USER)
    .bind(userId)
    .all<Pick<MembershipRow, 'user_id' | 'org_id' | 'role'>>();
  return result.results;
}

/** Creates a browser session. Only the token's hash is stored. */
export const SQL_INSERT_SESSION = `
INSERT INTO sessions (token_hash, id, user_id, active_org_id, ip_hash, user_agent,
                      created_at, last_seen_at, expires_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)
`;

/**
 * Inserts a session.
 *
 * A fresh session is minted on claim rather than reusing the anonymous one, which is the session
 * fixation fix in architecture §3b step 8.
 */
export async function insertSession(
  db: D1Database,
  args: {
    readonly tokenHash: Uint8Array;
    readonly id: SessionId;
    readonly userId: UserId;
    readonly activeOrgId: OrganisationId | null;
    readonly ipHash: Uint8Array | null;
    readonly userAgent: string | null;
    readonly now: Timestamp;
    readonly expiresAt: Timestamp;
  },
): Promise<void> {
  const result = await db
    .prepare(SQL_INSERT_SESSION)
    .bind(
      toArrayBuffer(args.tokenHash),
      args.id,
      args.userId,
      args.activeOrgId,
      args.ipHash === null ? null : toArrayBuffer(args.ipHash),
      args.userAgent,
      args.now,
      args.expiresAt,
    )
    .run();
  assertSingleChange(result.meta, 'insertSession');
}

/**
 * Authentication. A single page read against the WITHOUT ROWID primary key.
 *
 * The expiry and revocation predicates are in the statement rather than in the caller, so there is
 * no path on which a live session is read and then separately (or never) validated.
 */
export const SQL_GET_SESSION = `
SELECT * FROM sessions WHERE token_hash = ?1 AND revoked_at IS NULL AND expires_at > ?2
`;

/** Reads a live session by token hash. `null` for missing, revoked or expired — all the same. */
export async function getSessionByTokenHash(
  db: D1Database,
  args: { readonly tokenHash: Uint8Array; readonly now: Timestamp },
): Promise<SessionRow | null> {
  return db
    .prepare(SQL_GET_SESSION)
    .bind(toArrayBuffer(args.tokenHash), args.now)
    .first<SessionRow>();
}

/** Slides the session's last-seen stamp; called at most once per idle window, never per request. */
export const SQL_TOUCH_SESSION = `
UPDATE sessions SET last_seen_at = ?2, expires_at = ?3 WHERE token_hash = ?1 AND revoked_at IS NULL
`;

/** Refreshes a session's activity window. Returns false when the session was already revoked. */
export async function touchSession(
  db: D1Database,
  args: { readonly tokenHash: Uint8Array; readonly now: Timestamp; readonly expiresAt: Timestamp },
): Promise<boolean> {
  const result = await db
    .prepare(SQL_TOUCH_SESSION)
    .bind(toArrayBuffer(args.tokenHash), args.now, args.expiresAt)
    .run();
  return changedOne(result.meta);
}

/** Revokes one session. */
export const SQL_REVOKE_SESSION = `
UPDATE sessions SET revoked_at = ?2 WHERE token_hash = ?1 AND revoked_at IS NULL
`;

/** Revokes a session. Returns false when it was already revoked, which is not an error. */
export async function revokeSession(
  db: D1Database,
  args: { readonly tokenHash: Uint8Array; readonly now: Timestamp },
): Promise<boolean> {
  const result = await db
    .prepare(SQL_REVOKE_SESSION)
    .bind(toArrayBuffer(args.tokenHash), args.now)
    .run();
  return changedOne(result.meta);
}

/** Revokes every session of a user — password-less account recovery, and support-side lockout. */
export const SQL_REVOKE_USER_SESSIONS = `
UPDATE sessions SET revoked_at = ?2 WHERE user_id = ?1 AND revoked_at IS NULL
`;

/** Revokes all of a user's sessions and returns how many were live. */
export async function revokeUserSessions(
  db: D1Database,
  args: { readonly userId: UserId; readonly now: Timestamp },
): Promise<number> {
  const result = await db.prepare(SQL_REVOKE_USER_SESSIONS).bind(args.userId, args.now).run();
  return result.meta.changes;
}

/** Creates a magic-link, verification or invite token. Only the hash is stored. */
export const SQL_INSERT_AUTH_TOKEN = `
INSERT INTO auth_tokens (token_hash, id, user_id, email, purpose, org_id, payload, ip_hash,
                         created_at, expires_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
`;

/** Inserts an auth token. */
export async function insertAuthToken(
  db: D1Database,
  args: {
    readonly tokenHash: Uint8Array;
    readonly id: AuthTokenId;
    readonly userId: UserId | null;
    readonly email: string;
    readonly purpose: AuthTokenPurpose;
    readonly orgId: OrganisationId | null;
    readonly payload: string | null;
    readonly ipHash: Uint8Array | null;
    readonly now: Timestamp;
    readonly expiresAt: Timestamp;
  },
): Promise<void> {
  const result = await db
    .prepare(SQL_INSERT_AUTH_TOKEN)
    .bind(
      toArrayBuffer(args.tokenHash),
      args.id,
      args.userId,
      args.email,
      args.purpose,
      args.orgId,
      args.payload,
      args.ipHash === null ? null : toArrayBuffer(args.ipHash),
      args.now,
      args.expiresAt,
    )
    .run();
  assertSingleChange(result.meta, 'insertAuthToken');
}

/**
 * Consumes an auth token, atomically.
 *
 * `AND consumed_at IS NULL` is the mutual exclusion and `RETURNING` gives the caller the row it
 * just won in the same round trip. Two concurrent redeliveries of the same magic link both run this
 * statement; exactly one changes a row, and `consumeAuthToken()` below returns `null` to the other.
 * Without the predicate, both would mint a session.
 */
export const SQL_CONSUME_AUTH_TOKEN = `
UPDATE auth_tokens
SET consumed_at = ?2
WHERE token_hash = ?1 AND consumed_at IS NULL AND expires_at > ?2
RETURNING *
`;

/**
 * Consumes a single-use auth token and returns it, or `null` when it was already used or expired.
 *
 * `null` is a 410 to the caller, never a 500: a link opened twice is a user event.
 */
export async function consumeAuthToken(
  db: D1Database,
  args: { readonly tokenHash: Uint8Array; readonly now: Timestamp },
): Promise<AuthTokenRow | null> {
  return db
    .prepare(SQL_CONSUME_AUTH_TOKEN)
    .bind(toArrayBuffer(args.tokenHash), args.now)
    .first<AuthTokenRow>();
}

/** Deletes expired, unconsumed tokens. Chunked: D1 caps a query at 30 seconds. */
export const SQL_PURGE_AUTH_TOKENS = `
DELETE FROM auth_tokens
WHERE token_hash IN (SELECT token_hash FROM auth_tokens WHERE expires_at < ?1 AND consumed_at IS NULL LIMIT ?2)
`;

/** Purges a chunk of expired tokens and returns how many were removed. */
export async function purgeExpiredAuthTokens(
  db: D1Database,
  args: { readonly before: Timestamp; readonly limit: number },
): Promise<number> {
  const result = await db.prepare(SQL_PURGE_AUTH_TOKENS).bind(args.before, args.limit).run();
  return result.meta.changes;
}
