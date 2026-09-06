/**
 * base64url, the one encoding every opaque value in this Worker travels in.
 *
 * Cookie values, idempotency keys and claim tokens all end up in a header, a query string or a
 * database column with a `NOT GLOB '*[^0-9A-Za-z_-]*'` CHECK, and base64url is the only common
 * encoding that survives all three untouched. Padding is stripped because `=` is the one character
 * of the alphabet that a URL would want escaped.
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
 * Returns `null` rather than throwing for anything that is not base64url: every caller here is
 * decoding attacker-supplied text, and an exception on a malformed cookie would turn a rejection
 * into a 500.
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

/** Convenience: `toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)))`. */
export function randomToken(byteLength: number): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}
