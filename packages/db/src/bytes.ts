import { InvalidDigestError, MalformedHexError } from './errors';
import type { BlobColumn } from './types';

/**
 * Conversions between the three shapes a D1 `BLOB` takes.
 *
 * Architecture §5.4 stores every sha256 as `BLOB(32)` rather than as 64 hex characters: nothing
 * ever prefix-matches a hash, so hex only doubles the width of every index entry that carries one.
 * The price is that JavaScript sees three different runtime representations depending on the D1
 * build — a byte array on the wire in older versions, an `ArrayBuffer` in current ones, and a view
 * when the caller built it — so every read goes through `toBytes()` and every bind through
 * `toArrayBuffer()`.
 */

/** Bytes in a sha256 digest. Mirrored by `CHECK (length(x) = 32)` in the DDL. */
export const SHA256_BYTES = 32;

/**
 * Normalises any D1 blob representation to a `Uint8Array`.
 *
 * Copies rather than aliases when handed a view, so the result can never be invalidated by a later
 * write through the original buffer.
 */
export function toBytes(value: BlobColumn): Uint8Array {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0));
  }
  if (ArrayBuffer.isView(value)) {
    const { buffer, byteOffset, byteLength } = value;
    return new Uint8Array(buffer.slice(byteOffset, byteOffset + byteLength));
  }
  return Uint8Array.from(value);
}

/**
 * Copies `bytes` into a standalone `ArrayBuffer` for `D1PreparedStatement.bind()`.
 *
 * The copy is not incidental. Binding `view.buffer` directly sends the WHOLE backing buffer, which
 * for any view produced by slicing a larger allocation writes the wrong value — and for a digest,
 * writes a value that will never match on read.
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

/**
 * Asserts that a blob column holds exactly 32 bytes and returns them.
 *
 * Used wherever a digest crosses into an R2 key: `blobs/<kind>/<sha[0:2]>/<sha[2:4]>/<sha>.json.gz`
 * is a pure function of the hash, so a short digest silently produces a key that resolves to
 * nothing at all.
 */
export function toDigest(value: BlobColumn, context: string): Uint8Array {
  const bytes = toBytes(value);
  if (bytes.byteLength !== SHA256_BYTES) {
    throw new InvalidDigestError(context, bytes.byteLength);
  }
  return bytes;
}

/** Lowercase hex, for logs, R2 keys and cache keys. Never for storage. */
export function toHex(value: BlobColumn): string {
  let out = '';
  for (const byte of toBytes(value)) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Parses hex into bytes, rejecting anything that is not hex.
 *
 * Throws rather than producing `NaN` bytes: a digest that is silently wrong is indistinguishable
 * from a cache miss for as long as it takes someone to notice the storage bill.
 */
export function fromHex(hex: string, context = 'fromHex'): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new MalformedHexError(`${context}: hex string has odd length ${hex.length}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new MalformedHexError(`${context}: not hex at offset ${i * 2}`);
    }
    out[i] = byte;
  }
  return out;
}
