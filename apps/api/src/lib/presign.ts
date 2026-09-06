import { AwsClient } from 'aws4fetch';

/**
 * Presigning a single-object PUT into the EU-jurisdiction quarantine bucket.
 *
 * Four properties of the signature are load-bearing, and all four are decisions from architecture
 * §8 and §1.3 rather than defaults:
 *
 *  1. **The host carries the `.eu.` label.** A jurisdictional bucket is addressed at
 *     `https://<account>.eu.r2.cloudflarestorage.com`; the host is covered by the signature, so a
 *     URL signed against the plain host authenticates and then fails to find the bucket, and it
 *     cannot be repaired after it has been handed out.
 *  2. **`content-length` is inside the signature.** This is what stops a 5 GB body being pushed at
 *     a URL that was issued for a 2 MB avatar. aws4fetch treats `content-length` as unsignable by
 *     default (it is in its `UNSIGNABLE_HEADERS` set), so `allHeaders: true` is not a nicety — it
 *     is the entire point of the call. The browser must then send exactly that many bytes.
 *  3. **The key is server-derived**, from `@aibuilder/core`'s `quarantineUploadKey()`. The user's
 *     filename never reaches an object key. The assertion below is a second line of defence that
 *     mirrors the `r2_key` CHECK in `migrations/shard/0002_blobs_media.sql`.
 *  4. **120 seconds.** Long enough for a browser to start a 15 MB upload, short enough that a URL
 *     leaked through a screenshot or a shared console is worthless.
 *
 * The bucket additionally needs explicit CORS in the dashboard: `AllowedOrigins` exact,
 * `AllowedHeaders` enumerating every signed header, `ExposeHeaders: etag`. Bytes go browser -> R2
 * and never traverse a Worker, so no code here can compensate for a missing CORS rule.
 */

/** R2's S3 API has no regions; `auto` is the documented value and is covered by the signature. */
const R2_REGION = 'auto';

/** Same character class as the `r2_key` CHECK: no traversal, no separator surprises. */
const SAFE_KEY = /^[0-9A-Za-z][0-9A-Za-z/._-]{2,1023}$/;

/** Inputs for `presignPut`. Every one of them is server-derived. */
export interface PresignPutParams {
  /** `https://<account>.eu.r2.cloudflarestorage.com`, from `env.R2_S3_ENDPOINT`. */
  readonly endpoint: string;
  /** Bucket NAME (not the binding), from `env.R2_QUARANTINE_BUCKET`. */
  readonly bucket: string;
  /** Object key, from `quarantineUploadKey()`. */
  readonly key: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Exact byte count the browser is allowed to PUT. Bound into the signature. */
  readonly contentLength: number;
  /** Validity window in seconds. */
  readonly expiresInSeconds: number;
}

/** A presigned upload: the URL, and the headers the browser MUST send with it. */
export interface PresignedUpload {
  readonly url: string;
  /**
   * Headers covered by the signature. The browser has to send every one of them verbatim or R2
   * rejects the PUT — which is exactly why the byte limit is expressed here and not in a check the
   * Worker could never run.
   */
  readonly headers: Readonly<Record<string, string>>;
  /** Epoch milliseconds at which the signature stops being valid. */
  readonly expiresAt: number;
}

/** Raised when a caller tries to sign something that is not a safe, server-derived object key. */
export class UnsafeObjectKeyError extends Error {
  public constructor(key: string) {
    super(`Refusing to presign an unsafe object key of length ${String(key.length)}`);
    this.name = 'UnsafeObjectKeyError';
  }
}

/**
 * Presigns a PUT against the jurisdictional S3 endpoint.
 *
 * Guarantees that the returned URL is valid for `expiresInSeconds` seconds, for that exact object
 * key, and for a body of exactly `contentLength` bytes.
 *
 * @throws UnsafeObjectKeyError when the key is not a single safe path (`..`, control characters,
 * anything outside the `r2_key` CHECK's character class).
 */
export async function presignPut(params: PresignPutParams): Promise<PresignedUpload> {
  if (!SAFE_KEY.test(params.key) || params.key.includes('..')) {
    throw new UnsafeObjectKeyError(params.key);
  }

  const client = new AwsClient({
    accessKeyId: params.accessKeyId,
    secretAccessKey: params.secretAccessKey,
    service: 's3',
    region: R2_REGION,
  });

  const url = new URL(`${params.endpoint.replace(/\/+$/, '')}/${params.bucket}/${params.key}`);
  // aws4fetch reads the expiry from the query string when signing a query-signed request; without
  // it the default is 24 hours, which is 719 minutes longer than an upload URL should live.
  url.searchParams.set('X-Amz-Expires', String(params.expiresInSeconds));

  const contentLength = String(params.contentLength);
  const signed = await client.sign(url.toString(), {
    method: 'PUT',
    headers: { 'content-length': contentLength },
    aws: { signQuery: true, allHeaders: true },
  });

  return {
    url: signed.url,
    headers: { 'content-length': contentLength },
    expiresAt: Date.now() + params.expiresInSeconds * 1000,
  };
}
