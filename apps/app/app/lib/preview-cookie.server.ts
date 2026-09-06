import { toArrayBuffer } from './bytes';
import { readSecret } from '../env';
import type { Env, SecretBinding } from '../env';

/**
 * `__Host-aib_preview` — the preview origin's session, and why it is a cookie and not a URL token.
 *
 * THE DECISION, FROM ARCHITECTURE §9: the preview iframe is authorised by "a short-lived HttpOnly
 * host-scoped cookie, **not a query-string token** (which leaks via `Referer` the moment a draft
 * page contains the mandated `wa.me` link)". That is the whole argument, and it is a real one: a
 * generated site's WhatsApp widget is an outbound link to `wa.me`, and a browser sends the current
 * page's URL as `Referer` when it is followed. If the preview's authorisation lived in that URL, a
 * customer clicking their own WhatsApp button would hand a working credential to a third party.
 *
 * SO WHY DOES A TOKEN APPEAR IN A URL AT ALL. Because a cookie for `preview.<domain>` can only be
 * set by a response from `preview.<domain>`, and the editor runs on `app.<domain>` — a different
 * host by design, and `__Host-` forbids a `Domain` attribute precisely so that one host cannot set
 * the other's cookies. Something has to cross the gap once. So the iframe's `src` is a HANDSHAKE:
 *
 *   1. the editor's loader asks `SiteDraftDO` for a one-time grant (60 s, single use, hashed);
 *   2. the iframe loads `https://preview.<domain>/_authorise?g=<siteId>.<token>`;
 *   3. that route spends the grant, sets this cookie, and answers **303** to the preview path.
 *
 * The response that carries the token in its URL renders NO CONTENT — it is a redirect — so there
 * is no document whose `Referer` could carry it anywhere, and by the time any draft markup exists
 * the URL is `https://preview.<domain>/s/<siteId>/...` with no secret in it. The grant is single-use
 * and expires in a minute, so even a URL captured from a proxy log is inert.
 *
 * WHY THE COOKIE IS SIGNED RATHER THAN STORED. Verification is then free: a forged or truncated
 * cookie is rejected by one HMAC without a Durable Object round trip, on a host that serves an
 * image-heavy page and will be hit repeatedly. The value it carries — a site id, a user id and a
 * deadline — is not secret; what matters is that it cannot be forged, and an HMAC over a rotating
 * key is exactly that.
 *
 * ROTATION. `PREVIEW_HMAC_KEY` holds one or more comma-separated `kid:material` entries (or a bare
 * `material`, taken as kid `k1`), `material` base64url. The FIRST entry signs; ANY entry verifies.
 * Rotation is: prepend the new key, deploy, wait out the 30-minute session lifetime, drop the old
 * one. The same shape `apps/api`'s `DRAFT_HMAC_KEY` uses, for the same reason: nobody is signed out
 * and no cookie is accepted under a key that has been removed.
 */

/** The cookie's name. The `__Host-` prefix is a browser-enforced contract, not decoration. */
export const PREVIEW_COOKIE_NAME = '__Host-aib_preview';

/** How long a redeemed preview session lasts. Matches `SiteDraftDO.PREVIEW_SESSION_TTL_MS`. */
export const PREVIEW_SESSION_TTL_MS = 1_800_000;

/** A `kid` must be short and URL-safe; it is part of the cookie value. */
const KID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/u;

/** One signing key. */
interface PreviewKey {
  readonly kid: string;
  readonly material: Uint8Array;
}

/** Imported `CryptoKey`s, per isolate. Keyed by the entry text, which is already in memory. */
const keyCache = new Map<string, CryptoKey>();

/** Raised when `PREVIEW_HMAC_KEY` cannot be parsed. Never includes the value. */
export class PreviewKeyConfigurationError extends Error {
  public constructor(detail: string) {
    super(`PREVIEW_HMAC_KEY is not usable: ${detail}`);
    this.name = 'PreviewKeyConfigurationError';
  }
}

/** What the cookie asserts. Small on purpose: it is a capability, not a profile. */
export interface PreviewClaims {
  /** The site whose draft this cookie may read. Compared against the path on every request. */
  readonly siteId: string;
  /** Who redeemed the grant. Logged, and the reason a revoked account's preview dies with it. */
  readonly userId: string;
  /** Epoch milliseconds. Checked on every verification; the cookie's `Max-Age` is not enough. */
  readonly expiresAt: number;
}

/* ── Encoding ────────────────────────────────────────────────────────────────────────────────── */

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(text)) {
    return null;
  }
  try {
    const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

/** Constant-time comparison. A short-circuit on the first differing byte is a signature oracle. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < a.byteLength; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

/* ── Keys ────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Parses the secret into its keys, newest first.
 *
 * @throws PreviewKeyConfigurationError when no entry is usable. An unsigned preview cookie is not a
 * degraded mode, it is an authorisation bypass, so this fails loudly rather than falling back.
 */
function parseKeys(secret: string): readonly PreviewKey[] {
  const keys: PreviewKey[] = [];
  for (const rawEntry of secret.split(',')) {
    const entry = rawEntry.trim();
    if (entry.length === 0) {
      continue;
    }
    const separator = entry.indexOf(':');
    const kid = separator === -1 ? 'k1' : entry.slice(0, separator);
    const encoded = separator === -1 ? entry : entry.slice(separator + 1);
    if (!KID_PATTERN.test(kid)) {
      throw new PreviewKeyConfigurationError('a key id is not URL-safe');
    }
    const material = fromBase64Url(encoded);
    if (material === null || material.byteLength < 16) {
      throw new PreviewKeyConfigurationError('a key is not at least 16 bytes of base64url');
    }
    keys.push({ kid, material });
  }
  if (keys.length === 0) {
    throw new PreviewKeyConfigurationError('no keys configured');
  }
  return keys;
}

async function importKey(key: PreviewKey): Promise<CryptoKey> {
  const cacheKey = `${key.kid}:${toBase64Url(key.material)}`;
  const cached = keyCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const imported = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(key.material),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  keyCache.set(cacheKey, imported);
  return imported;
}

async function loadKeys(binding: SecretBinding): Promise<readonly PreviewKey[]> {
  return parseKeys(await readSecret(binding, 'PREVIEW_HMAC_KEY'));
}

/* ── Mint and verify ─────────────────────────────────────────────────────────────────────────── */

/** The signed body: `<kid>.<payload>`. Signing the kid too stops a key-substitution attack. */
function signingInput(kid: string, payload: string): ArrayBuffer {
  return toArrayBuffer(new TextEncoder().encode(`${kid}.${payload}`));
}

/** Builds the cookie value `<kid>.<payload>.<signature>`. */
export async function mintPreviewCookie(env: Env, claims: PreviewClaims): Promise<string> {
  const keys = await loadKeys(env.PREVIEW_HMAC_KEY);
  const key = keys[0];
  if (key === undefined) {
    throw new PreviewKeyConfigurationError('no signing key');
  }
  const payload = toBase64Url(
    new TextEncoder().encode(
      JSON.stringify({ s: claims.siteId, u: claims.userId, e: claims.expiresAt }),
    ),
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    await importKey(key),
    signingInput(key.kid, payload),
  );
  return `${key.kid}.${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

/**
 * Verifies a cookie value and returns its claims, or `null`.
 *
 * `null` for every failure — wrong shape, unknown kid, bad signature, expired — because the caller
 * must not be able to tell them apart and neither must an attacker. Expiry is re-checked here and
 * not left to `Max-Age`: a cookie's lifetime is a hint the client can ignore, and this one is a
 * capability.
 */
export async function verifyPreviewCookie(
  env: Env,
  value: string,
  now: number,
): Promise<PreviewClaims | null> {
  const parts = value.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [kid, payload, signature] = parts;
  if (kid === undefined || payload === undefined || signature === undefined) {
    return null;
  }
  const provided = fromBase64Url(signature);
  const decoded = fromBase64Url(payload);
  if (provided === null || decoded === null) {
    return null;
  }

  const keys = await loadKeys(env.PREVIEW_HMAC_KEY);
  const key = keys.find((candidate) => candidate.kid === kid);
  if (key === undefined) {
    return null;
  }
  const expected = new Uint8Array(
    await crypto.subtle.sign('HMAC', await importKey(key), signingInput(kid, payload)),
  );
  if (!timingSafeEqual(expected, provided)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(decoded));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const siteId = record['s'];
  const userId = record['u'];
  const expiresAt = record['e'];
  if (typeof siteId !== 'string' || typeof userId !== 'string' || typeof expiresAt !== 'number') {
    return null;
  }
  if (expiresAt <= now) {
    return null;
  }
  return { siteId, userId, expiresAt };
}

/**
 * The `Set-Cookie` value for a freshly redeemed preview session.
 *
 * `SameSite=Lax` is correct and not a compromise: the dashboard and the preview are two hosts of
 * one registrable domain, so an iframe of one inside the other is SAME-site, and a Lax cookie is
 * sent. `None` would be required only if the preview were framed from a different registrable
 * domain, which is exactly the thing `frame-ancestors` refuses.
 */
export function previewCookieHeader(value: string, maxAgeSeconds: number): string {
  return `${PREVIEW_COOKIE_NAME}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

/** The `Set-Cookie` value that deletes it. The attributes must match, or nothing is deleted. */
export function clearPreviewCookieHeader(): string {
  return `${PREVIEW_COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

/** Reads one cookie out of a `Cookie` header. */
export function readCookie(header: string | null, name: string): string | null {
  if (header === null) {
    return null;
  }
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index !== -1 && pair.slice(0, index).trim() === name) {
      return pair.slice(index + 1).trim();
    }
  }
  return null;
}
