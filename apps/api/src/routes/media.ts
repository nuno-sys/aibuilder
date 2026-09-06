import { UPLOAD_MIME_TYPES, isId, mintId, quarantineUploadKey } from '@aibuilder/core';
import type { UploadMimeType } from '@aibuilder/core';
import { fromHex, shard, shardById } from '@aibuilder/db';
import type { MediaAssetRow, MediaRole } from '@aibuilder/db';
import { Hono } from 'hono';
import { z } from 'zod';

import { readSecret } from '../env';
import type { AppEnv } from '../env';
import { presignPut } from '../lib/presign';
import {
  errorResponse,
  jsonResponse,
  notFoundResponse,
  validationErrorFromIssues,
} from '../lib/responses';
import { requireAnonSession } from '../middleware/draft-cookie';
import { rateLimitByIp } from '../middleware/ratelimit';
import { currentDraft } from './drafts';

/**
 * Uploads: sign, commit, poll.
 *
 * BYTES NEVER TRAVERSE A WORKER. The browser PUTs straight into the EU-jurisdiction quarantine
 * bucket against a presigned URL. That single decision is why the size limit is expressed as a
 * `content-length` bound into the signature rather than as a check on a request body — there is no
 * request body here to check — and why the object key is derived entirely server-side from a
 * MIME→extension map. The user's filename is display-only and is HTML-escaped at render; it never
 * reaches an object key, because a key is the only thing standing between one tenant's object and
 * another's.
 *
 * WHAT IS NOT ACCEPTED, and why (architecture §8): SVG, HTML, XML and PDF are denied outright — an
 * SVG is an HTML document. HEIC is denied and converted client-side: iOS Safari transcodes to JPEG
 * when the file input's `accept` lists only JPEG, PNG and WebP, and HEIC ingestion into the Images
 * binding is Enterprise-only.
 *
 * COMMIT DOES NOT MEAN READY. The browser's claimed digest is recorded, never trusted. The queue
 * consumer magic-byte-sniffs the object, re-encodes it through the Images binding with
 * `metadata: 'none'` — which is what destroys polyglots, EXIF GPS (a home-address leak is a GDPR
 * incident) and trailing payloads without an AV engine we cannot run — writes derivatives, and only
 * then promotes the row.
 */

/** Per-file ceiling from architecture §S4. Bound into the presigned signature. */
const MAX_FILE_BYTES = 15 * 1024 * 1024;

/** Per-draft ceilings from architecture §S4. */
const MAX_FILES_PER_DRAFT = 12;
const MAX_BYTES_PER_DRAFT = 300 * 1024 * 1024;

/** Long enough to start a 15 MB upload, short enough that a leaked URL is worthless. */
const UPLOAD_EXPIRY_SECONDS = 120;

/** Largest intrinsic dimension we will record. Mirrors the `media_assets` width/height CHECK. */
const MAX_DIMENSION = 20_000;

/** The upload roles the modal offers, mapped to the column's vocabulary. */
const ROLE_TO_MEDIA_ROLE: Readonly<Record<'hero' | 'gallery' | 'logo', MediaRole>> = {
  hero: 'hero_image',
  gallery: 'gallery',
  logo: 'logo',
};

/**
 * The sign request.
 *
 * `declaredType` is a plain string here rather than an enum on purpose: an unsupported type must
 * answer 415 with a list of what is accepted, not 422 with a generic enum failure, because the
 * former is actionable in the UI and the latter is not.
 */
const SignRequestSchema = z.object({
  role: z.enum(['hero', 'gallery', 'logo']),
  declaredType: z.string().min(3).max(100),
  bytes: z.number().int().positive(),
  width: z.number().int().positive().max(MAX_DIMENSION),
  height: z.number().int().positive().max(MAX_DIMENSION),
});

/** The commit request. The digest is the browser's claim about what it uploaded. */
const CommitRequestSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

/** The status vocabulary `GET /v1/media/:mediaId` answers with (architecture §S4). */
type PublicMediaStatus = 'verifying' | 'ready' | 'failed' | 'quarantined';

/**
 * Maps a row's status to the four the client knows about.
 *
 * `pending` and `uploading` collapse into `verifying`: from the modal's point of view the file is
 * on its way and there is nothing to decide. `deleted` collapses into `failed` for the same reason.
 */
function publicStatus(row: MediaAssetRow): PublicMediaStatus {
  switch (row.status) {
    case 'ready':
      return 'ready';
    case 'quarantined':
      return 'quarantined';
    case 'failed':
    case 'deleted':
      return 'failed';
    default:
      return 'verifying';
  }
}

/** True when the declared type is one this product accepts. */
function isUploadMimeType(value: string): value is UploadMimeType {
  return (UPLOAD_MIME_TYPES as readonly string[]).includes(value);
}

export const mediaRoutes = new Hono<AppEnv>();

mediaRoutes.post('/sign', requireAnonSession, rateLimitByIp('RL_UPLOAD'), async (c) => {
  const draft = await currentDraft(c.env, c.get('anonSession'));
  if (draft === null) {
    return notFoundResponse('no_draft');
  }
  if (draft.status !== 'open') {
    return errorResponse(
      409,
      'draft_closed',
      'Dit formulier is al verzonden; je kunt geen bestanden meer toevoegen.',
      'This form has already been submitted; no more files can be added.',
    );
  }

  const body: unknown = await c.req.json<unknown>().catch(() => null);
  const parsed = SignRequestSchema.safeParse(body);
  if (!parsed.success) {
    return validationErrorFromIssues(parsed.error.issues);
  }
  const { role, declaredType, bytes, width, height } = parsed.data;

  if (!isUploadMimeType(declaredType)) {
    return errorResponse(
      415,
      'unsupported_media_type',
      'Dit bestandstype accepteren we niet. Gebruik JPEG, PNG of WebP.',
      'We do not accept this file type. Use JPEG, PNG or WebP.',
      { accepted: UPLOAD_MIME_TYPES },
    );
  }
  if (bytes > MAX_FILE_BYTES) {
    return errorResponse(
      413,
      'file_too_large',
      'Dit bestand is groter dan 15 MB. Kies een kleinere foto.',
      'This file is larger than 15 MB. Choose a smaller photo.',
      { maxBytes: MAX_FILE_BYTES },
    );
  }

  const db = shardById(draft.shard_id, c.env);
  const usage = await shard.media.sumDraftMedia(db, draft.id);
  if (usage.files >= MAX_FILES_PER_DRAFT || usage.total_bytes + bytes > MAX_BYTES_PER_DRAFT) {
    return errorResponse(
      429,
      'upload_quota_exceeded',
      'Je hebt het maximum aantal foto’s bereikt.',
      'You have reached the maximum number of photos.',
      { maxFiles: MAX_FILES_PER_DRAFT, maxBytes: MAX_BYTES_PER_DRAFT },
    );
  }

  const mediaId = mintId('mediaAsset');
  const key = quarantineUploadKey({ draftId: draft.id, mediaId, mimeType: declaredType });
  const now = Date.now();

  // The row exists before the URL does, so an upload that is never committed is still something the
  // reaper and the per-draft quota can see. `bytes`, `width` and `height` are the client's claims
  // until the consumer re-encodes; the row is `pending` until then and the CHECK on `ready` is what
  // makes that distinction enforceable rather than conventional.
  await shard.media.insertMediaAsset(db, {
    id: mediaId,
    draftId: draft.id,
    siteId: null,
    orgId: null,
    r2Bucket: c.env.R2_QUARANTINE_BUCKET,
    r2Key: key,
    kind: 'image',
    source: 'upload',
    mimeType: declaredType,
    bytes,
    width,
    height,
    role: ROLE_TO_MEDIA_ROLE[role],
    createdBy: null,
    now,
  });

  const [accessKeyId, secretAccessKey] = await Promise.all([
    readSecret(c.env.R2_ACCESS_KEY_ID, 'R2_ACCESS_KEY_ID'),
    readSecret(c.env.R2_SECRET_KEY, 'R2_SECRET_KEY'),
  ]);

  const upload = await presignPut({
    endpoint: c.env.R2_S3_ENDPOINT,
    bucket: c.env.R2_QUARANTINE_BUCKET,
    key,
    accessKeyId,
    secretAccessKey,
    contentLength: bytes,
    expiresInSeconds: UPLOAD_EXPIRY_SECONDS,
  });

  return jsonResponse(
    {
      mediaId,
      uploadUrl: upload.url,
      expiresInSeconds: UPLOAD_EXPIRY_SECONDS,
      headers: upload.headers,
    },
    200,
  );
});

mediaRoutes.post('/:mediaId/commit', requireAnonSession, async (c) => {
  const mediaId = c.req.param('mediaId');
  if (!isId('mediaAsset', mediaId)) {
    return notFoundResponse('media_not_found');
  }

  const draft = await currentDraft(c.env, c.get('anonSession'));
  if (draft === null) {
    return notFoundResponse('no_draft');
  }

  const body: unknown = await c.req.json<unknown>().catch(() => null);
  const parsed = CommitRequestSchema.safeParse(body);
  if (!parsed.success) {
    return validationErrorFromIssues(parsed.error.issues);
  }

  const db = shardById(draft.shard_id, c.env);
  // Scoped by draft, not only by id: possession of a media id must never be enough to move another
  // visitor's upload through the pipeline.
  const asset = await shard.media.getMediaForDraft(db, { mediaId, draftId: draft.id });
  if (asset === null) {
    return notFoundResponse('media_not_found');
  }

  const committed = await shard.media.commitMediaAsset(db, {
    mediaId,
    sha256: fromHex(parsed.data.sha256, 'media.commit'),
    now: Date.now(),
  });
  if (!committed) {
    return errorResponse(
      409,
      'media_not_committable',
      'Dit bestand is al verwerkt.',
      'This file has already been processed.',
      { status: publicStatus(asset) },
    );
  }

  await c.env.MEDIA_Q.send({
    type: 'verify',
    mediaId,
    draftId: draft.id,
    shardId: draft.shard_id,
    bucket: asset.r2_bucket,
    key: asset.r2_key,
    declaredMimeType: asset.mime_type,
    claimedSha256: parsed.data.sha256,
  });

  return jsonResponse({ mediaId, status: 'verifying' }, 202);
});

mediaRoutes.get('/:mediaId', requireAnonSession, async (c) => {
  const mediaId = c.req.param('mediaId');
  if (!isId('mediaAsset', mediaId)) {
    return notFoundResponse('media_not_found');
  }

  const draft = await currentDraft(c.env, c.get('anonSession'));
  if (draft === null) {
    return notFoundResponse('no_draft');
  }

  const asset = await shard.media.getMediaForDraft(shardById(draft.shard_id, c.env), {
    mediaId,
    draftId: draft.id,
  });
  if (asset === null) {
    return notFoundResponse('media_not_found');
  }

  return jsonResponse(
    {
      status: publicStatus(asset),
      width: asset.width,
      height: asset.height,
      blurhash: asset.blurhash,
      dominantColor: asset.dominant_color,
    },
    200,
  );
});
