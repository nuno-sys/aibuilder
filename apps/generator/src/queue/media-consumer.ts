import { assertId, mediaImageKey, mediaOriginalKey } from '@aibuilder/core';
import type { ImageFormat, ImageWidth, UploadMimeType } from '@aibuilder/core';
import { shard, shardById } from '@aibuilder/db';

import type { Env, ImagesBinding, MediaVerifyMessage } from '../env';

/**
 * The upload verify/re-encode consumer — the second half of the presigned-upload design (§8).
 *
 * THE FIRST HALF WAS NEVER A SCAN. Bytes go straight from the browser into a separate
 * EU-jurisdiction quarantine bucket against a presigned URL with `content-length` bound into the
 * signature, so no Worker ever sees them on the way in. This is where they are first inspected, and
 * the inspection is three independent gates in a deliberate order:
 *
 *   1. THE MAGIC BYTES MUST *EQUAL* THE DECLARED TYPE. Not "be an image", not "be in the
 *      allowlist" — equal. A file declared `image/png` whose bytes start `FF D8 FF` is not a
 *      mislabelled JPEG that we helpfully fix; it is someone probing what this endpoint will
 *      accept, and the correct answer is `quarantined` plus an abuse signal. Sniffing alone would
 *      also miss the polyglot case entirely, which is the one this ordering exists for.
 *
 *   2. SVG, HTML, XML AND PDF ARE DENIED OUTRIGHT, before anything else looks at them. An SVG is
 *      an HTML document: it can carry `<script>`, `<foreignObject>` and external references, and
 *      served from a media host it is a stored-XSS primitive. There is no configuration under
 *      which this product accepts one.
 *
 *   3. MANDATORY RE-ENCODE THROUGH THE IMAGES BINDING WITH `metadata: 'none'`. This is the step
 *      that does the security work no allowlist can: it destroys polyglots (the output is written
 *      by the encoder, not copied from the input), it strips EXIF — including GPS, and a customer's
 *      home coordinates in a photo of their workshop is a GDPR incident rather than a bug — and it
 *      discards trailing payloads appended after the image data. All without an AV engine, which
 *      cannot run in a Worker.
 *
 * ONLY THEN IS THE ROW PROMOTED, and only then is the quarantine object deleted. The order matters:
 * deleting first and then failing to promote would lose the customer's upload with no way back.
 *
 * FAILURE HANDLING. A CONTENT verdict is terminal — the message is acknowledged, the row moves to
 * `quarantined` or `failed`, and retrying would reach the same verdict at the same cost. An
 * INFRASTRUCTURE failure (R2 unavailable, the shard busy, the encoder erroring) calls `retry()`, and
 * after two of those the message lands in `aibuilder-media-dlq` where a human can look at it —
 * because silently dropping it would leave the row stuck at `verifying` forever and the customer
 * looking at a spinner.
 */

/** Per-file ceiling from §S4, repeated here because a queue message is not a signed URL. */
const MAX_BYTES = 15 * 1024 * 1024;

/** Bytes read to classify a file. Every signature this cares about is inside the first 16. */
const SNIFF_LENGTH = 16;

/**
 * The derivative ladder.
 *
 * Three widths rather than `IMAGE_WIDTHS`' five, and two formats rather than three: every rung is a
 * billed transform and a CPU slice, and the renderer's `srcset` covers the gaps by scaling. The
 * omitted JPEG rung is the sanitised original, which every browser can already read.
 */
const LADDER_WIDTHS: readonly ImageWidth[] = [400, 800, 1600];

/** Best first. AVIF for the browsers that take it, WebP for the rest. */
const LADDER_FORMATS: readonly ImageFormat[] = ['avif', 'webp'];

/** Quality for a derivative. High enough that a hero does not band, low enough to be worth encoding. */
const DERIVATIVE_QUALITY = 80;

/** The three types `POST /v1/media/sign` will issue a signature for. */
const ACCEPTED_TYPES: ReadonlySet<string> = new Set<UploadMimeType>([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

/** What the bytes actually are. `denied` names a format that is refused whatever was declared. */
export type SniffResult =
  | { readonly kind: 'image'; readonly mimeType: UploadMimeType }
  | { readonly kind: 'denied'; readonly format: 'svg' | 'html' | 'xml' | 'pdf' | 'gif' }
  | { readonly kind: 'unknown' };

/** True when `bytes` begins with `signature`. */
function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

/** Reads `length` bytes at `offset` as ASCII, for the container tags that are text. */
function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let index = offset; index < offset + length && index < bytes.length; index += 1) {
    out += String.fromCharCode(bytes[index] ?? 0);
  }
  return out;
}

/**
 * Classifies a file from its first bytes.
 *
 * Guarantees it never returns an accepted type for a markup document: the markup checks run FIRST
 * and are deliberately broad — a leading `<` after optional whitespace or a UTF-8 BOM is enough,
 * because every way of writing an SVG, an XHTML page or an XML document starts that way, and a
 * "clever" narrow check is exactly how a polyglot gets through.
 */
export function sniff(bytes: Uint8Array): SniffResult {
  // Markup first, and over the raw bytes: a file that is BOTH a valid JPEG and a valid HTML
  // document is a polyglot, and it must be refused rather than accepted on its second identity.
  const head = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  let cursor = head;
  while (cursor < bytes.length && cursor < head + 8) {
    const byte = bytes[cursor];
    // Space, tab, CR, LF.
    if (byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a) {
      cursor += 1;
      continue;
    }
    break;
  }
  if (bytes[cursor] === 0x3c) {
    const tag = ascii(bytes, cursor, 9).toLowerCase();
    if (tag.startsWith('<svg')) return { kind: 'denied', format: 'svg' };
    if (tag.startsWith('<?xml')) return { kind: 'denied', format: 'xml' };
    if (tag.startsWith('<!doctype') || tag.startsWith('<html')) {
      return { kind: 'denied', format: 'html' };
    }
    // Any other leading `<` is still markup of some kind. There is no accepted image format that
    // begins with one, so refusing is free.
    return { kind: 'denied', format: 'xml' };
  }
  if (ascii(bytes, 0, 4) === '%PDF') return { kind: 'denied', format: 'pdf' };
  if (ascii(bytes, 0, 4) === 'GIF8') return { kind: 'denied', format: 'gif' };

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { kind: 'image', mimeType: 'image/jpeg' };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: 'image', mimeType: 'image/png' };
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return { kind: 'image', mimeType: 'image/webp' };
  }
  return { kind: 'unknown' };
}

/** The Images output format for one ladder rung. */
function outputFormat(format: ImageFormat): 'image/avif' | 'image/webp' | 'image/jpeg' {
  switch (format) {
    case 'avif':
      return 'image/avif';
    case 'webp':
      return 'image/webp';
    default:
      return 'image/jpeg';
  }
}

/** Wraps bytes in a fresh stream. A `ReadableStream` is single-use; every transform needs its own. */
function streamOf(bytes: ArrayBuffer): ReadableStream<Uint8Array> {
  const body = new Response(bytes).body;
  if (body === null) throw new Error('empty body for an image that has bytes');
  return body;
}

/** Lowercase hex SHA-256 — the content address every derivative key is built from. */
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Hex to bytes, for the `sha256` BLOB column. */
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

/** Re-encodes one rung and returns its bytes. */
async function encode(
  images: ImagesBinding,
  source: ArrayBuffer,
  options: { readonly width?: number; readonly format: ImageFormat },
): Promise<ArrayBuffer> {
  let chain = images.input(streamOf(source));
  if (options.width !== undefined) {
    // `scale-down` and never `cover`: a crop decided by an encoder changes what the customer's
    // photo shows, and the renderer's art direction is the SiteDoc's job, not this step's.
    chain = chain.transform({ width: options.width, fit: 'scale-down' });
  }
  const result = await chain.output({
    format: outputFormat(options.format),
    quality: DERIVATIVE_QUALITY,
    // NOT a default and NOT optional. See the file header.
    metadata: 'none',
  });
  return result.response().arrayBuffer();
}

/** One re-encoded rung, held between encoding and writing so nothing is encoded twice. */
interface Derivative {
  readonly key: string;
  readonly width: ImageWidth;
  readonly format: ImageFormat;
  readonly bytes: ArrayBuffer;
}

/** One verdict for one message. */
type Verdict =
  | { readonly kind: 'promoted' }
  | { readonly kind: 'quarantined'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'retry'; readonly reason: string };

/**
 * Verifies, re-encodes and promotes one upload.
 *
 * Guarantees: nothing is written to the media bucket until the bytes have passed both the deny list
 * and the declared-type equality check; every object written was produced by the encoder rather
 * than copied from the upload; and the quarantine object is deleted only after the row is `ready`.
 *
 * Idempotent: a row already `ready` is acknowledged without work, and the derivative keys are
 * content-addressed, so a redelivery rewrites byte-identical objects.
 */
export async function verifyUpload(env: Env, message: MediaVerifyMessage): Promise<Verdict> {
  const mediaId = assertId('mediaAsset', message.mediaId);
  const db = shardById(message.shardId, env);

  const row = await shard.media.getMediaAsset(db, mediaId);
  if (row === null) return { kind: 'failed', reason: 'media_row_missing' };
  if (row.status === 'ready') return { kind: 'promoted' };
  if (row.status === 'quarantined' || row.status === 'deleted') {
    return { kind: 'quarantined', reason: 'already_terminal' };
  }

  if (!ACCEPTED_TYPES.has(message.declaredMimeType)) {
    return {
      kind: 'quarantined',
      reason: `declared_type_not_accepted:${message.declaredMimeType}`,
    };
  }

  const object = await env.QUARANTINE.get(message.key);
  if (object === null) {
    // The browser never finished the PUT, or the 24-hour lifecycle rule already collected it.
    // Neither is retryable and neither is an attack.
    return { kind: 'failed', reason: 'quarantine_object_missing' };
  }
  const source = await object.arrayBuffer();
  if (source.byteLength === 0) return { kind: 'failed', reason: 'empty_object' };
  if (source.byteLength > MAX_BYTES) {
    return { kind: 'quarantined', reason: `oversize:${String(source.byteLength)}` };
  }

  const sniffed = sniff(new Uint8Array(source.slice(0, SNIFF_LENGTH)));
  if (sniffed.kind === 'denied') {
    return { kind: 'quarantined', reason: `denied_format:${sniffed.format}` };
  }
  if (sniffed.kind === 'unknown') {
    return { kind: 'quarantined', reason: 'unrecognised_format' };
  }
  if (sniffed.mimeType !== message.declaredMimeType) {
    // EQUALITY, not membership. See the file header.
    return {
      kind: 'quarantined',
      reason: `type_mismatch:${message.declaredMimeType}!=${sniffed.mimeType}`,
    };
  }

  let width: number;
  let height: number;
  let sanitised: ArrayBuffer;
  let digest: string;
  const derivatives: Derivative[] = [];
  try {
    const info = await env.IMAGES.info(streamOf(source));
    if (info.width === undefined || info.height === undefined) {
      // A file the encoder cannot measure is a file the encoder does not believe is an image,
      // whatever its first three bytes said.
      return { kind: 'quarantined', reason: 'no_intrinsic_dimensions' };
    }
    width = info.width;
    height = info.height;

    // The sanitised original: same pixels, re-encoded, no metadata. This is the object every
    // derivative and every `srcset` fallback is served from, and the one that guarantees the bytes
    // in the media bucket were written by the encoder rather than copied from the upload.
    sanitised = await encode(env.IMAGES, source, { format: 'webp' });
    // Content-addressed on the SANITISED bytes, not on the upload: two uploads of the same photo
    // with different EXIF are one object after re-encoding, and the address should say so.
    digest = await sha256Hex(sanitised);

    for (const rung of LADDER_WIDTHS) {
      if (rung > width) continue;
      for (const format of LADDER_FORMATS) {
        derivatives.push({
          key: mediaImageKey({ sha256: digest, width: rung, format }),
          width: rung,
          format,
          bytes: await encode(env.IMAGES, source, { width: rung, format }),
        });
      }
    }
  } catch (error) {
    // The encoder failing is our problem, not the customer's: retry, then the DLQ.
    return { kind: 'retry', reason: `encode_failed:${String(error)}` };
  }

  try {
    await env.MEDIA.put(mediaOriginalKey(digest), sanitised, {
      httpMetadata: { contentType: 'image/webp' },
    });
    for (const derivative of derivatives) {
      await env.MEDIA.put(derivative.key, derivative.bytes, {
        httpMetadata: { contentType: outputFormat(derivative.format) },
      });
    }
  } catch (error) {
    return { kind: 'retry', reason: `media_write_failed:${String(error)}` };
  }

  const promoted = await shard.media.promoteMediaAsset(db, {
    mediaId,
    r2Bucket: env.R2_MEDIA_BUCKET,
    r2Key: mediaOriginalKey(digest),
    sha256: hexToBytes(digest),
    mimeType: 'image/webp',
    bytes: sanitised.byteLength,
    width,
    height,
    blurhash: null,
    dominantColor: null,
    variants: JSON.stringify(
      derivatives.map((d) => ({ key: d.key, width: d.width, format: d.format })),
    ),
    durationMs: null,
    now: Date.now(),
  });
  if (!promoted) {
    // The row moved under us — a concurrent redelivery won. The objects are content-addressed and
    // byte-identical, so there is nothing to undo.
    return { kind: 'promoted' };
  }

  // Last, and only now: the unverified copy is no longer the only copy.
  await env.QUARANTINE.delete(message.key);
  return { kind: 'promoted' };
}

/**
 * The queue consumer.
 *
 * Guarantees every message is either acknowledged with a terminal row status or retried, so a row
 * never sits at `verifying` because a message was silently dropped.
 */
export async function handleMediaBatch(
  batch: MessageBatch<MediaVerifyMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    const body = message.body;
    if (body.type !== 'verify') {
      message.ack();
      continue;
    }

    let verdict: Verdict;
    try {
      verdict = await verifyUpload(env, body);
    } catch (error) {
      verdict = { kind: 'retry', reason: `unexpected:${String(error)}` };
    }

    if (verdict.kind === 'retry') {
      message.retry();
      continue;
    }

    if (verdict.kind !== 'promoted') {
      try {
        await shard.media.setMediaStatus(shardById(body.shardId, env), {
          mediaId: assertId('mediaAsset', body.mediaId),
          status: verdict.kind === 'quarantined' ? 'quarantined' : 'failed',
          scanResult: verdict.reason.slice(0, 500),
          now: Date.now(),
        });
        // A refused object is deleted too: it is attacker-controlled content in a bucket we pay
        // for, and the row records what it was.
        await env.QUARANTINE.delete(body.key);
      } catch {
        // The verdict is content-terminal; a failed status write is repaired by the media sweep,
        // which lists rows stuck before `ready`. Retrying here would re-run the whole re-encode.
      }
    }
    message.ack();
  }
}
