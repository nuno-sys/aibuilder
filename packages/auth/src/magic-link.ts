import { assertSingleChange, cp, toBytes } from '@aibuilder/db';
import type { AuthTokenRow, Timestamp, UserId } from '@aibuilder/db';

import { SHA256_BYTES, hashCredential, sha256, timingSafeEqual } from './crypto';
import { toBase64Url } from './encoding';
import type { AuthEnv } from './env';
import { mintAuthTokenId } from './ids';

/**
 * The magic link: the product's only first factor until a passkey is registered.
 *
 * WHY IT IS HAND-ROLLED AND NOT A LIBRARY (`PHASE2-BILLING-AUTH.md` §6.1). `auth_tokens` is already
 * exactly the right shape — `WITHOUT ROWID` on a 32-byte hash, single-use through
 * `UPDATE … WHERE consumed_at IS NULL` plus `meta.changes === 1`, `expires_at`, `ip_hash`, and
 * `idx_auth_tokens_email` for send-rate limiting — and `cp.users` already exports every statement
 * the flow needs. Every general-purpose auth library for Workers wants to own the schema, which
 * here means owning `users`, `sessions` and `organisations`: the three tables the rest of this
 * system's constraints and triggers are built on. Adopting one is a schema rewrite disguised as a
 * dependency.
 *
 * WHAT MAKES IT SINGLE USE. D1 has no interactive transactions, so the `AND consumed_at IS NULL`
 * predicate IS the transaction. Two concurrent openings of the same link both run the UPDATE;
 * exactly one changes a row and the other gets `null`, which is a 410 to the user and never a 500 —
 * a link opened twice is a user event, not an incident.
 *
 * WHAT MAKES A MAIL SCANNER HARMLESS. Two things, and both are needed. The TTL is fifteen minutes.
 * And **nothing consumes a token on `GET`**: the only endpoint that consumes is a JSON `POST`
 * behind `originGuard`, reached by a script on the dashboard page the link points at. A mail
 * client, a link-expander or a security appliance that prefetches the URL performs a `GET` against
 * `app.<domain>` and burns nothing. That is a stronger guarantee than §6.2's interstitial, which it
 * replaces: an interstitial still depends on the scanner not following a form.
 */

/** Bytes of entropy in a magic-link token. */
export const MAGIC_LINK_TOKEN_BYTES = 32;

/** Fifteen minutes. Short enough that a prefetched-and-archived link is dead on arrival. */
export const MAGIC_LINK_TTL_MS = 900_000;

/** The dashboard route the e-mailed link points at. It renders, then POSTs the token to the API. */
export const MAGIC_LINK_VERIFY_PATH = '/inloggen/verifieren';

/** Where a login lands when the request named no destination. */
export const DEFAULT_NEXT_PATH = '/dashboard';

/** `auth_tokens.payload` is `CHECK (json_valid(payload) AND length(payload) <= 512)`. */
const PAYLOAD_MAX = 512;

/**
 * Destinations a magic link is allowed to carry.
 *
 * An open redirect in a login flow is a phishing primitive: the attacker sends a real link to a
 * real login and lands the authenticated user on a page they control. The rule is therefore an
 * ALLOWLIST OF SHAPES, not a denylist of prefixes — a single absolute path, no scheme, no host, no
 * backslash (which several browsers normalise to `/`), no protocol-relative `//host`, and a bounded
 * length. Query strings and fragments are dropped rather than sanitised, because nothing in the
 * dashboard needs one at login and every sanitiser of them eventually has a bug.
 */
const NEXT_PATH_PATTERN = /^\/[A-Za-z0-9\-._~/]{0,127}$/;

/**
 * Normalises a requested post-login destination to something safe to redirect to.
 *
 * Guarantees the result is a same-origin absolute path. Anything else — a full URL, `//evil.test`,
 * `/\evil.test`, a path with a query string — collapses to `DEFAULT_NEXT_PATH` rather than being
 * repaired, because a value that had to be repaired is a value someone chose for a reason.
 */
export function safeNextPath(value: string | null | undefined): string {
  if (typeof value !== 'string' || !NEXT_PATH_PATTERN.test(value) || value.startsWith('//')) {
    return DEFAULT_NEXT_PATH;
  }
  return value;
}

/** Builds the URL that goes in the e-mail. */
export function magicLinkUrl(dashboardOrigin: string, token: string): string {
  const url = new URL(MAGIC_LINK_VERIFY_PATH, dashboardOrigin);
  url.searchParams.set('t', token);
  return url.toString();
}

/** What a sender is handed. It carries the raw token exactly once, on its way to a mailbox. */
export interface MagicLinkInvitation {
  /** The address as the user typed it, for the `To:` header. */
  readonly email: string;
  /** The link, already assembled. */
  readonly url: string;
  /** When the link stops working, so the copy can say so honestly. */
  readonly expiresAt: Timestamp;
}

/**
 * The transport that puts a magic link in a mailbox.
 *
 * A PORT, not an implementation, and deliberately so. Phase 1 states the rule in
 * `apps/api/src/routes/submit.ts`: a credential whose only safe home is a mailbox is minted by the
 * component that can actually deliver it, and that cannot ship before SPF/DKIM/DMARC `p=reject`
 * exists for the control-plane domain (architecture §10 risk 7). Until a transport is wired, the
 * API answers `202` and mints nothing — which is indistinguishable, from outside, from the address
 * having no account.
 */
export interface MagicLinkSender {
  send(invitation: MagicLinkInvitation): Promise<void>;
}

/** Everything `issueMagicLink` binds a token to. */
export interface IssueMagicLinkArgs {
  /** The address as typed. Goes in the mail and into `auth_tokens.email`. */
  readonly email: string;
  /** The user the link signs in. A magic link is never issued for an address with no account. */
  readonly userId: UserId;
  /** `https://app.<control-plane-domain>` — read from `vars`, never hardcoded (§D1). */
  readonly dashboardOrigin: string;
  /** Where to land after login. Passed through `safeNextPath` before it is stored. */
  readonly next: string;
  /** `sha256(ip || daily_salt)`, for the abuse ledger. Never a raw address. */
  readonly ipHash: Uint8Array | null;
  readonly now: Timestamp;
  readonly sender: MagicLinkSender;
}

/**
 * Mints a magic-link token, stores its hash, and hands the link to the sender.
 *
 * The insert happens BEFORE the send. A token that was mailed but not stored is a link that does
 * not work; a token that was stored but not mailed is 32 bytes nobody can guess, which expires in
 * fifteen minutes. Only one of those two failure modes reaches a user.
 */
export async function issueMagicLink(env: AuthEnv, args: IssueMagicLinkArgs): Promise<void> {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(MAGIC_LINK_TOKEN_BYTES));
  const token = toBase64Url(tokenBytes);
  const tokenHash = await sha256(tokenBytes);
  const expiresAt = args.now + MAGIC_LINK_TTL_MS;

  const payload = JSON.stringify({ next: safeNextPath(args.next) });
  if (payload.length > PAYLOAD_MAX) {
    // Unreachable while `NEXT_PATH_PATTERN` caps the path at 128 characters. Asserted anyway,
    // because the alternative is a D1 CHECK violation surfacing as a 500 on the login path.
    throw new Error('magic-link payload exceeds the auth_tokens.payload bound');
  }

  await cp.users.insertAuthToken(env.CP, {
    tokenHash,
    id: mintAuthTokenId(),
    userId: args.userId,
    email: args.email,
    purpose: 'magic_link',
    orgId: null,
    payload,
    ipHash: args.ipHash,
    now: args.now,
    expiresAt,
  });

  await args.sender.send({
    email: args.email,
    url: magicLinkUrl(args.dashboardOrigin, token),
    expiresAt,
  });
}

/** A token that was successfully consumed, and where its holder asked to land. */
export interface ConsumedMagicLink {
  readonly token: AuthTokenRow;
  readonly next: string;
}

/** Reads the `next` out of a stored payload, defensively. A malformed payload is not an error. */
function nextFromPayload(payload: string | null): string {
  if (payload === null) {
    return DEFAULT_NEXT_PATH;
  }
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== 'object' || parsed === null) {
      return DEFAULT_NEXT_PATH;
    }
    const next = (parsed as Record<string, unknown>)['next'];
    return safeNextPath(typeof next === 'string' ? next : null);
  } catch {
    return DEFAULT_NEXT_PATH;
  }
}

/**
 * Consumes a magic-link token, atomically, and returns it — or `null`.
 *
 * `null` means unknown, malformed, expired, already consumed, or issued for a different purpose.
 * The caller answers 410 for all five; distinguishing them would tell an attacker which of their
 * guesses was a real token.
 *
 * THE PURPOSE CHECK IS AFTER THE CONSUME, AND THAT IS A KNOWN, BOUNDED COST. `SQL_CONSUME_AUTH_TOKEN`
 * is shared with `email_verify` and `org_invite` and carries no `purpose` predicate, so presenting
 * an invite token here burns it. Doing so requires already holding that token's 256-bit value —
 * i.e. already holding the credential — so the loss is a re-send, not an escalation. The fix is a
 * purpose-scoped consume statement in `packages/db/src/cp/users.ts`; it is listed in this task's
 * handover notes because that file is owned elsewhere.
 */
export async function consumeMagicLink(
  env: AuthEnv,
  args: { readonly token: string; readonly now: Timestamp },
): Promise<ConsumedMagicLink | null> {
  const tokenHash = await hashCredential(args.token, MAGIC_LINK_TOKEN_BYTES);
  if (tokenHash === null) {
    return null;
  }

  const row = await cp.users.consumeAuthToken(env.CP, { tokenHash, now: args.now });
  if (row === null || row.purpose !== 'magic_link' || row.user_id === null) {
    return null;
  }

  // Integrity assertion, in constant time: the row D1 returned must be the row we asked for. It can
  // only differ if `RETURNING` handed back a different key, but a credential path is the wrong
  // place to assume that never happens.
  const stored = toBytes(row.token_hash);
  if (stored.byteLength !== SHA256_BYTES || !timingSafeEqual(stored, tokenHash)) {
    return null;
  }

  return { token: row, next: nextFromPayload(row.payload) };
}

/**
 * Records that a magic link proved control of a mailbox.
 *
 * `coalesce` on `email_verified_at` keeps the FIRST verification as the verification date, which is
 * what a ROPA and a dispute both want; `last_login_at` moves every time.
 *
 * A consumed magic link is the ONLY thing in this system that may set `email_verified_at`
 * (§6, and §2.4 explains why: Stripe Checkout collects an address and mails a receipt to it, which
 * is not proof of control).
 *
 * TODO(phase-2-db): this statement belongs in `packages/db/src/cp/users.ts` and registered in
 * `packages/db/src/statements.ts` so the `EXPLAIN QUERY PLAN` gate covers it. It lives here because
 * that file is owned by another agent in this change; moving it is a cut-and-paste and one import.
 */
export const SQL_MARK_MAGIC_LINK_LOGIN = `
UPDATE users
SET email_verified_at = coalesce(email_verified_at, ?2), last_login_at = ?2, updated_at = ?2
WHERE id = ?1 AND deleted_at IS NULL
`;

/** Marks a user as verified-and-just-logged-in. Throws unless exactly one row changed. */
export async function markMagicLinkLogin(
  env: AuthEnv,
  args: { readonly userId: UserId; readonly now: Timestamp },
): Promise<void> {
  const result = await env.CP.prepare(SQL_MARK_MAGIC_LINK_LOGIN).bind(args.userId, args.now).run();
  assertSingleChange(result.meta, 'markMagicLinkLogin');
}
