/**
 * One byte helper, and the reason it exists rather than being inlined at four call sites.
 *
 * `crypto.subtle.digest`, `.sign` and `.importKey` all take a `BufferSource`. TypeScript 5.7 made
 * `Uint8Array` generic in its backing buffer (`Uint8Array<ArrayBufferLike>`), and `BufferSource`
 * requires `ArrayBufferView<ArrayBuffer>` — so passing a plain `Uint8Array` is now a compile error
 * whose message is four levels of "SharedArrayBuffer is not assignable to ArrayBuffer" and tells you
 * nothing about what to do.
 *
 * COPYING IS ALSO THE CORRECT BEHAVIOUR, not merely the one that compiles. A `Uint8Array` can be a
 * VIEW over a larger buffer, and `subtle.digest(view.buffer)` would hash the whole buffer rather
 * than the view — a bug that produces a stable, wrong hash, which is the worst kind. Copying into a
 * buffer of exactly `byteLength` makes the two agree by construction.
 *
 * `packages/auth/src/crypto.ts` states the same thing at its own `sha256`, and this is the copy of
 * that reasoning for the two places in this Worker that hash and sign outside that package: the
 * preview cookie's HMAC, and the preview grant's token hash inside the Durable Object.
 */

/** Copies a view's bytes into an `ArrayBuffer` of exactly that length. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/** `sha256` of some bytes, as lowercase hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** `sha256` of some bytes, as bytes. */
export async function sha256Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes)));
}

/** UTF-8 bytes of a string, in a buffer Web Crypto accepts. */
export function utf8(text: string): ArrayBuffer {
  return toArrayBuffer(new TextEncoder().encode(text));
}
