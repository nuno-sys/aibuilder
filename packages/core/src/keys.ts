import { InvalidKeySegmentError } from './errors';
import type { Locale } from './locales';
import { localeUrlSegment } from './locales';

/**
 * Every R2 key shape in the system, in one place.
 *
 * Keys are **never** concatenated at a call site. Two reasons, both of which have cost other
 * products real money: a key is the only thing standing between one tenant's object and another's,
 * so a caller-supplied id containing `../` or a newline must be rejected before it reaches
 * `R2Bucket.get`; and a key shape that lives in three files diverges in two of them the first time
 * it changes, leaving orphaned objects that nothing reads and the GC reaper never collects.
 *
 * Layout (architecture §1.3, §6, §7.7 and dim-aigen "Persistence"):
 *
 * ```text
 * aibuilder-quarantine   q/{draftId}/{mediaId}.{ext}                unverified upload, 24h lifecycle
 * aibuilder-media        orig/{sha256}                              re-encoded original
 *                        img/{sha256}/{width}.{format}              image derivative ladder
 *                        vid/{sha256}/hero.{format}                 hero video rendition
 *                        poster/{sha256}.{format}                   video poster frame
 * aibuilder-blobs        sites/{siteId}/{versionId}/sitedoc.json    the SiteDoc
 *                        sites/{siteId}/{versionId}/{loc}{path}index.html
 *                        sites/{siteId}/{versionId}/index.html      the `/` 200 (§7.2)
 *                        sites/{siteId}/{versionId}/sitemaps/{seg}.xml.br
 *                        sites/{siteId}/{versionId}/sitemaps/index.xml.br
 *                        transcripts/{jobId}/{step}.{attempt}.json  AI transcript, 90d lifecycle
 * ```
 *
 * Every site artefact lives under `sites/{siteId}/{versionId}/`, which is what makes publishing a
 * cache purge (§7 — a new version is a new key, so there is no stale window and no purge call) and
 * what lets version GC delete by prefix.
 */

/** A single safe path segment: no separators, no traversal, no control characters. */
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Lowercase hex SHA-256, as produced by the media pipeline and stored in `media_assets.sha256`. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * A rendered content path: lowercase, leading and trailing slash, no traversal, no doubled slash.
 * Matches invariant I3 in architecture §7.1.
 */
const CONTENT_PATH_PATTERN = /^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)*$/;

/**
 * Validates one interpolated segment.
 *
 * @throws InvalidKeySegmentError when the value could address something other than itself.
 */
function segment(label: string, value: string): string {
  if (!SEGMENT_PATTERN.test(value) || value === '.' || value === '..') {
    throw new InvalidKeySegmentError(label, value);
  }
  return value;
}

/** Validates a lowercase hex SHA-256 digest used as a content address. */
function digest(value: string): string {
  if (!SHA256_PATTERN.test(value)) throw new InvalidKeySegmentError('sha256', value);
  return value;
}

/** Validates a rendered content path (`/`, `/diensten/`, `/blog/mijn-post/`). */
function contentPath(value: string): string {
  if (!CONTENT_PATH_PATTERN.test(value)) throw new InvalidKeySegmentError('path', value);
  return value;
}

/* ── Uploads ─────────────────────────────────────────────────────────────────────────────────── */

/**
 * MIME types accepted by `POST /v1/media/sign`.
 *
 * SVG, HTML, XML, PDF and HEIC are absent on purpose (architecture §8): an SVG is an HTML document,
 * and HEIC ingestion is Enterprise-only — iOS transcodes to JPEG when the file input's `accept`
 * lists only these three.
 */
export const UPLOAD_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** An accepted upload MIME type. */
export type UploadMimeType = (typeof UPLOAD_MIME_TYPES)[number];

/** File extensions the key builder will emit. Derived from the MIME map, never from a filename. */
export type MediaExtension = 'jpg' | 'png' | 'webp' | 'avif' | 'mp4' | 'webm';

/**
 * Declared MIME → extension.
 *
 * The user's filename is display-only and HTML-escaped at render (architecture §8); the object key
 * is derived entirely from server-side values, so a `photo.jpg.svg` cannot become an `.svg` object.
 */
export const MIME_TO_EXTENSION: Readonly<Record<UploadMimeType, MediaExtension>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Key for an unverified upload in the quarantine bucket.
 *
 * The object is deleted once the verify/re-encode consumer has promoted its derivatives; the bucket
 * additionally carries a 24-hour lifecycle rule so an abandoned draft cannot accumulate storage.
 */
export function quarantineUploadKey(params: {
  draftId: string;
  mediaId: string;
  mimeType: UploadMimeType;
}): string {
  const extension = MIME_TO_EXTENSION[params.mimeType];
  const draftId = segment('draftId', params.draftId);
  const mediaId = segment('mediaId', params.mediaId);
  return `q/${draftId}/${mediaId}.${extension}`;
}

/**
 * Prefix holding everything an onboarding draft owns.
 *
 * The 30-day draft purge deletes by this prefix, so nothing may be written for a draft outside it.
 */
export function draftPrefix(draftId: string): string {
  return `drafts/${segment('draftId', draftId)}/`;
}

/* ── Media ───────────────────────────────────────────────────────────────────────────────────── */

/** Widths of the image derivative ladder. Bounded because each width is a billable re-encode. */
export const IMAGE_WIDTHS = [400, 800, 1200, 1600, 2400] as const;

/** A width in the derivative ladder. */
export type ImageWidth = (typeof IMAGE_WIDTHS)[number];

/** Formats the image ladder is rendered in, best first. */
export const IMAGE_FORMATS = ['avif', 'webp', 'jpg'] as const;

/** A rendered image format. */
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

/** Formats a hero video is stored in. */
export const VIDEO_FORMATS = ['mp4', 'webm'] as const;

/** A stored video format. */
export type VideoFormat = (typeof VIDEO_FORMATS)[number];

/**
 * Key for a re-encoded original.
 *
 * Content-addressed, so 300 pizzerias picking the same stock photo store one object — and so every
 * derivative path is immutable and can carry `max-age=31536000, immutable`.
 */
export function mediaOriginalKey(sha256: string): string {
  return `orig/${digest(sha256)}`;
}

/** Key for one rung of the image derivative ladder. */
export function mediaImageKey(params: {
  sha256: string;
  width: ImageWidth;
  format: ImageFormat;
}): string {
  return `img/${digest(params.sha256)}/${params.width}.${params.format}`;
}

/** Key for a hero video rendition. */
export function mediaVideoKey(params: { sha256: string; format: VideoFormat }): string {
  return `vid/${digest(params.sha256)}/hero.${params.format}`;
}

/**
 * Key for a video's poster frame.
 *
 * The poster is the LCP element and must be *larger* in intrinsic area than the video at every
 * breakpoint (architecture §7.17), which is why it is a first-class object rather than a `poster=`
 * attribute on the `<video>`.
 */
export function mediaPosterKey(params: { sha256: string; format: ImageFormat }): string {
  return `poster/${digest(params.sha256)}.${params.format}`;
}

/* ── Site artefacts ──────────────────────────────────────────────────────────────────────────── */

/** Prefix holding every artefact of one site. Used by tenant-deletion sweeps. */
export function sitePrefix(siteId: string): string {
  return `sites/${segment('siteId', siteId)}/`;
}

/** Prefix holding every artefact of one published version. Used by version GC. */
export function siteVersionPrefix(params: { siteId: string; versionId: string }): string {
  return `${sitePrefix(params.siteId)}${segment('versionId', params.versionId)}/`;
}

/** Key for the `SiteDoc` — the renderer input, editor form model and storage shape in one object. */
export function siteDocKey(params: { siteId: string; versionId: string }): string {
  return `${siteVersionPrefix(params)}sitedoc.json`;
}

/**
 * Key for one materialised HTML page.
 *
 * `path` is the locale-local path (`/`, `/diensten/`); the locale's own URL segment is prepended
 * from the registry so a caller cannot pass `de` for a site that publishes `de-AT`.
 */
export function materialisedPageKey(params: {
  siteId: string;
  versionId: string;
  locale: Locale;
  path: string;
}): string {
  const path = contentPath(params.path);
  return `${siteVersionPrefix(params)}${localeUrlSegment(params.locale)}${path}index.html`;
}

/**
 * Key for the bare-domain document.
 *
 * Architecture §7.2: `/` is a **200 serving the default locale's content**, not a 308. The cost is
 * one extra R2 object per publish; the alternative is a redirect on the single most-requested,
 * flyer-printed URL of every tenant site.
 */
export function rootDocumentKey(params: { siteId: string; versionId: string }): string {
  return `${siteVersionPrefix(params)}index.html`;
}

/**
 * Key for one locale's sitemap.
 *
 * Stored brotli-precompressed (`contentEncoding: 'br'`), which is why the extension is `.xml.br`.
 */
export function sitemapKey(params: { siteId: string; versionId: string; locale: Locale }): string {
  return `${siteVersionPrefix(params)}sitemaps/${localeUrlSegment(params.locale)}.xml.br`;
}

/** Key for the sitemap index served at `/sitemap.xml`. */
export function sitemapIndexKey(params: { siteId: string; versionId: string }): string {
  return `${siteVersionPrefix(params)}sitemaps/index.xml.br`;
}

/* ── AI transcripts ──────────────────────────────────────────────────────────────────────────── */

/**
 * Key for one Anthropic call's transcript.
 *
 * One object per `(job, step, attempt)` because Workflow steps are retried and every attempt is
 * billed — an overwritten transcript is a lost cost investigation. The bucket carries a 90-day
 * lifecycle rule (dim-security retention table); transcripts contain tenant business copy, so they
 * are never public and never leave the EU jurisdiction.
 */
export function aiTranscriptKey(params: { jobId: string; step: string; attempt: number }): string {
  if (!Number.isInteger(params.attempt) || params.attempt < 1 || params.attempt > 99) {
    throw new InvalidKeySegmentError('attempt', String(params.attempt));
  }
  const step = segment('step', params.step);
  return `transcripts/${segment('jobId', params.jobId)}/${step}.${params.attempt}.json`;
}
