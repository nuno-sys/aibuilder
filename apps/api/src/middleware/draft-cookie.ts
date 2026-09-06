import { cp } from '@aibuilder/db';
import type { AnonSessionRow } from '@aibuilder/db';
import type { MiddlewareHandler } from 'hono';

import { readSecret } from '../env';
import type { AppEnv, Env } from '../env';
import { fromBase64Url, toBase64Url } from '../lib/encoding';
import { unauthorizedResponse } from '../lib/responses';
import { timingSafeEqual } from '../lib/subjects';

/**
 * `__Host-aib_draft` — the anonymous session cookie that owns a draft before an account exists.
 *
 * WHAT IS IN IT. A `kid`, an opaque 32-byte token, and an HMAC-SHA256 over the first two, all
 * base64url: `k1.<token>.<sig>`. Only `sha256(token)` is stored, in `anon_sessions.token_hash`, so
 * a database read cannot mint a cookie.
 *
 * WHY SIGN IT AT ALL when the database already holds a hash. Because verification is then free:
 * a forged or truncated cookie is rejected by one HMAC without touching the single-threaded D1
 * primary, and the expensive endpoints behind this cookie are exactly the ones an attacker would
 * like to make us do a database round trip for.
 *
 * WHY `__Host-`. The prefix is enforced by the browser: `Secure`, `Path=/`, and **no `Domain`
 * attribute**, which makes the cookie host-only. Combined with the two-registrable-domain split in
 * architecture §1.1, that is what stops attacker-influenced tenant HTML on `*.mijnsaas.com` from
 * ever writing a cookie this Worker will read.
 *
 * `SameSite=Lax` and not `Strict`: the modal runs on `www.aibuilder.app` and calls
 * `api.aibuilder.app`, which is cross-origin but same-site, so `Lax` is sent while a genuinely
 * cross-site POST from an attacker's page is not — and the Origin middleware refuses that anyway.
 *
 * ROTATION. `DRAFT_HMAC_KEY` holds one or more comma-separated entries. Each is `kid:material` (or
 * bare `material`, taken as kid `k1`), where `material` is base64url. The FIRST entry signs; ANY
 * entry may verify. Rotation is therefore: prepend the new key, deploy, wait out `Max-Age`, drop
 * the old one. Nobody is signed out, and no cookie is ever accepted under a key that has been
 * removed.
 */

/** The cookie's name. The `__Host-` prefix is a browser-enforced contract, not decoration. */
export const DRAFT_COOKIE_NAME = '__Host-aib_draft';

/**
 * Cookie lifetime, the anonymous session's TTL and the draft's purge window, in seconds.
 *
 * One constant for all three on purpose. Architecture §S4 fixes the cookie at 2 592 000 s and §3b
 * step 8 hard-deletes an unclaimed draft after 30 days; §5.2's note about a 7-day anonymous session
 * would expire the session three weeks before either, which reads to the user as "my work
 * disappeared" while the row it was stored in is still sitting in the database. They are the same
 * window, so they are the same number.
 */
export const DRAFT_SESSION_TTL_SECONDS = 2_592_000;

/** Bytes of entropy in the cookie token. 256 bits, from the platform CSPRNG. */
const TOKEN_BYTES = 32;

/** A `kid` must be short and URL-safe; it is part of the cookie value. */
const KID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;

/** One signing key: its id and its raw material. */
interface DraftKey {
  readonly kid: string;
  readonly material: Uint8Array;
}

/** Imported `CryptoKey`s, per isolate. Keyed by the entry text, which is already in memory. */
const keyCache = new Map<string, CryptoKey>();

/** Raised when `DRAFT_HMAC_KEY` cannot be parsed. Never includes the value. */
export class DraftKeyConfigurationError extends Error {
  public constructor(detail: string) {
    super(`DRAFT_HMAC_KEY is not usable: ${detail}`);
    this.name = 'DraftKeyConfigurationError';
  }
}

/**
 * Parses `DRAFT_HMAC_KEY` into its keys, newest first.
 *
 * @throws DraftKeyConfigurationError when no entry is usable — an unsigned cookie is not a
 * degraded mode, it is an authentication bypass, so this fails loudly rather than falling back.
 */
function parseKeys(secret: string): readonly DraftKey[] {
  const keys: DraftKey[] = [];
  for (const rawEntry of secret.split(',')) {
    const entry = rawEntry.trim();
    if (entry.length === 0) {
      continue;
    }
    const separator = entry.indexOf(':');
    const kid = separator === -1 ? 'k1' : entry.slice(0, separator);
    const encoded = separator === -1 ? entry : entry.slice(separator + 1);
    if (!KID_PATTERN.test(kid)) {
      throw new DraftKeyConfigurationError('a key id is not URL-safe');
    }
    const material = fromBase64Url(encoded);
    if (material === null || material.byteLength < 16) {
      throw new DraftKeyConfigurationError('a key is not at least 16 bytes of base64url');
    }
    keys.push({ kid, material });
  }
  if (keys.length === 0) {
    throw new DraftKeyConfigurationError('no keys configured');
  }
  return keys;
}

/** Imports (and caches) the HMAC key for one entry. */
async function importKey(key: DraftKey): Promise<CryptoKey> {
  const cacheKey = `${key.kid}:${toBase64Url(key.material)}`;
  const cached = keyCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const imported = await crypto.subtle.importKey(
    'raw',
    key.material,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  keyCache.set(cacheKey, imported);
  return imported;
}

/** HMAC-SHA256 over `${kid}.${token}` — the exact bytes the cookie's first two parts spell. */
async function signPayload(key: DraftKey, kid: string, token: string): Promise<Uint8Array> {
  const cryptoKey = await importKey(key);
  const signature = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    new TextEncoder().encode(`${kid}.${token}`),
  );
  return new Uint8Array(signature);
}

/** A newly minted cookie and the hash to store for it. */
export interface MintedDraftCookie {
  /** The full cookie value, `kid.token.signature`. */
  readonly value: string;
  /** `sha256(token bytes)` — exactly what `anon_sessions.token_hash` holds. */
  readonly tokenHash: Uint8Array;
}

/**
 * Mints a signed anonymous-session cookie.
 *
 * Guarantees 256 bits of CSPRNG entropy in the token, a signature under the newest key, and a
 * 32-byte hash suitable for `anon_sessions.token_hash`.
 */
export async function mintDraftCookie(env: Env): Promise<MintedDraftCookie> {
  const keys = parseKeys(await readSecret(env.DRAFT_HMAC_KEY, 'DRAFT_HMAC_KEY'));
  const signingKey = keys[0];
  if (signingKey === undefined) {
    throw new DraftKeyConfigurationError('no keys configured');
  }

  const tokenBytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  const token = toBase64Url(tokenBytes);
  const signature = await signPayload(signingKey, signingKey.kid, token);
  const digest = await crypto.subtle.digest('SHA-256', tokenBytes);

  return {
    value: `${signingKey.kid}.${token}.${toBase64Url(signature)}`,
    tokenHash: new Uint8Array(digest),
  };
}

/**
 * Verifies a cookie value and returns the hash it addresses.
 *
 * Returns `null` for every failure — wrong shape, unknown `kid`, bad signature — because the caller
 * must not be able to tell them apart, and neither must an attacker. The comparison is
 * constant-time: a byte-wise early return would leak the signature one byte at a time to anyone
 * willing to measure.
 *
 * Accepts a signature from ANY configured key, which is what makes key rotation invisible to users.
 */
export async function verifyDraftCookie(env: Env, value: string): Promise<Uint8Array | null> {
  const parts = value.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [kid, token, signature] = parts;
  if (kid === undefined || token === undefined || signature === undefined) {
    return null;
  }
  if (!KID_PATTERN.test(kid)) {
    return null;
  }

  const tokenBytes = fromBase64Url(token);
  const signatureBytes = fromBase64Url(signature);
  if (tokenBytes === null || signatureBytes === null || tokenBytes.byteLength !== TOKEN_BYTES) {
    return null;
  }

  const keys = parseKeys(await readSecret(env.DRAFT_HMAC_KEY, 'DRAFT_HMAC_KEY'));
  const key = keys.find((candidate) => candidate.kid === kid);
  if (key === undefined) {
    return null;
  }

  const expected = await signPayload(key, kid, token);
  if (!timingSafeEqual(expected, signatureBytes)) {
    return null;
  }

  const digest = await crypto.subtle.digest('SHA-256', tokenBytes);
  return new Uint8Array(digest);
}

/**
 * Builds the `Set-Cookie` header value.
 *
 * The attribute set is dictated by the `__Host-` prefix: `Secure`, `Path=/`, no `Domain`. A browser
 * silently ignores a `__Host-` cookie that breaks any of those, so getting this wrong fails as
 * "the user's draft never persists" rather than as an error.
 */
export function draftCookieHeader(
  value: string,
  maxAgeSeconds = DRAFT_SESSION_TTL_SECONDS,
): string {
  return (
    `${DRAFT_COOKIE_NAME}=${value}; Max-Age=${String(maxAgeSeconds)}; ` +
    'Path=/; Secure; HttpOnly; SameSite=Lax'
  );
}

/** Builds the `Set-Cookie` header that deletes the cookie. Used on claim (session fixation). */
export function clearDraftCookieHeader(): string {
  return `${DRAFT_COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

/**
 * Reads one cookie out of a `Cookie` header.
 *
 * Hand-rolled rather than taken from `hono/cookie` so that this module — the one place cookie
 * handling is decided — has no framework dependency and can be tested against a bare string.
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

/**
 * Resolves the request's anonymous session, or `null`.
 *
 * `null` covers every reason equally: no cookie, a forged one, a revoked or expired session. The
 * live-session predicates are in the SQL statement, so there is no path on which a session is read
 * and then separately (or never) validated.
 */
export async function loadAnonSession(
  env: Env,
  cookieHeader: string | undefined,
): Promise<AnonSessionRow | null> {
  const value = readCookie(cookieHeader, DRAFT_COOKIE_NAME);
  if (value === null) {
    return null;
  }
  const tokenHash = await verifyDraftCookie(env, value);
  if (tokenHash === null) {
    return null;
  }
  return cp.drafts.getAnonSession(env.CP, { tokenHash, now: Date.now() });
}

/**
 * Requires a live anonymous session and puts it on the context.
 *
 * Guarantees that any handler mounted behind it can read `c.get('anonSession')` and that the value
 * came from a signed cookie whose session row is live — which is the only reason a route may then
 * scope a draft, a media asset or a job by that session id.
 */
export const requireAnonSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = await loadAnonSession(c.env, c.req.header('Cookie'));
  if (session === null) {
    return unauthorizedResponse();
  }
  c.set('anonSession', session);
  await next();
};
