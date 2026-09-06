/**
 * base64url, the encoding every opaque credential in this package travels in.
 *
 * A session cookie value, a magic-link token in a query string and a WebAuthn challenge in a JSON
 * body all have to survive a `Set-Cookie` header, a URL and `JSON.stringify` untouched, and
 * base64url is the only common encoding that does. Padding is stripped because `=` is the one
 * character of the alphabet a URL would want escaped.
 *
 * WHY THIS DUPLICATES `apps/api/src/lib/encoding.ts`. A package may not import an app (the boundary
 * policy in `eslint.config.js`), and this package must stay usable from `apps/app` and `apps/billing`
 * as well. The two copies are byte-identical in behaviour and are pinned to each other by
 * `apps/api/src/__tests__/auth.test.ts`, which round-trips a value through one and back through the
 * other — so a divergence is a test failure and not a production surprise.
 */

/** Encodes bytes as unpadded base64url. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decodes unpadded base64url.
 *
 * Returns `null` rather than throwing for anything that is not base64url: every caller here decodes
 * attacker-supplied text, and an exception on a malformed cookie would turn a rejection into a 500.
 */
export function fromBase64Url(text: string): Uint8Array | null {
  if (text.length === 0 || !/^[A-Za-z0-9_-]+$/.test(text)) {
    return null;
  }
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

/** Encodes a UTF-8 string as base64url. WebAuthn's `user.id` is `utf8(user.id)` in this form. */
export function utf8ToBase64Url(text: string): string {
  return toBase64Url(new TextEncoder().encode(text));
}

/** `byteLength` bytes from the platform CSPRNG, base64url. */
export function randomToken(byteLength: number): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}
