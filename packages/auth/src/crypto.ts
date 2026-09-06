import { fromBase64Url } from './encoding';

/**
 * The three cryptographic operations authentication in this product performs, and nothing else.
 *
 * There is no signing key here and no encryption. A session token, a magic-link token and a
 * WebAuthn challenge are all **opaque 256-bit values from the platform CSPRNG**; what is stored is
 * `sha256(value)`, so a database read cannot mint a credential. That is a stronger property than
 * "the cookie is signed", and it is why this module is twenty lines instead of a key-rotation
 * schedule: there is no key to rotate.
 *
 * (`__Host-aib_draft` in `apps/api` *is* HMAC-signed, for a different and stated reason: it is the
 * anonymous cookie in front of the expensive un-authenticated endpoints, and rejecting a forgery
 * there without a D1 round trip is worth a key. An authenticated session has to hit D1 anyway.)
 */

/** Bytes in a sha256 digest. Mirrored by `CHECK (length(token_hash) = 32)` in `migrations/cp/0001`. */
export const SHA256_BYTES = 32;

/** Hashes bytes with SHA-256. */
export async function sha256(input: Uint8Array): Promise<Uint8Array> {
  // `crypto.subtle.digest` wants an `ArrayBuffer`; a view's `.buffer` may be larger than the view,
  // so the bytes are copied rather than aliased. Getting this wrong hashes the wrong value.
  const buffer = new ArrayBuffer(input.byteLength);
  new Uint8Array(buffer).set(input);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
}

/**
 * Compares two byte strings in time independent of their contents.
 *
 * Used wherever a comparison decides authentication. The length is compared first and leaks only
 * the length, which is a constant at every call site in this package. A byte-wise early return
 * would hand an attacker the value one byte at a time to anyone willing to measure.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) {
    // `noUncheckedIndexedAccess` types these as `number | undefined`; the bounds are the loop's own.
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Decodes a base64url credential and returns `sha256` of its bytes — the value the database holds.
 *
 * Returns `null` for anything that is not base64url of exactly `expectedBytes` bytes. A length
 * check before the hash is what stops a one-character token from ever reaching a `WHERE
 * token_hash = ?` that could, in principle, collide with a truncated write.
 */
export async function hashCredential(
  token: string,
  expectedBytes: number,
): Promise<Uint8Array | null> {
  const bytes = fromBase64Url(token);
  if (bytes === null || bytes.byteLength !== expectedBytes) {
    return null;
  }
  return sha256(bytes);
}
