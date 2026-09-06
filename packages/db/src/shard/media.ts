import { assertSingleChange, changedOne } from '../batch';
import { toArrayBuffer } from '../bytes';
import type {
  DraftId,
  MediaAssetId,
  MediaAssetRow,
  MediaKind,
  MediaRole,
  MediaSource,
  MediaStatus,
  OrganisationId,
  SiteId,
  Timestamp,
  UploadSessionId,
  UploadSessionRow,
} from '../types';

/**
 * Statements over `media_assets` and `upload_sessions`.
 *
 * The upload path is browser -> presigned PUT -> QUARANTINE bucket -> queue consumer -> re-encode
 * -> MEDIA bucket. Bytes never traverse a Worker, which is why the size limit lives in the
 * presigned signature's bound `content-length` rather than in a request-body check, and why the
 * column CHECK here is a sanity bound rather than the policy.
 *
 * An asset is owned by a DRAFT before submit and by a SITE afterwards; `promoteDraftMedia()` is the
 * hand-off. That is also why `media_assets.site_id` is nullable and why the draft carries a
 * `shard_id` from the moment it is created — there is no organisation yet to route by.
 */

/** Registers an asset at the moment its upload URL is signed. */
export const SQL_INSERT_MEDIA_ASSET = `
INSERT INTO media_assets (id, draft_id, site_id, org_id, r2_bucket, r2_key, kind, source,
                          mime_type, bytes, width, height, role, status, created_by,
                          created_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'pending', ?14, ?15, ?15)
`;

/**
 * Inserts a media asset.
 *
 * `r2Key` is SERVER-DERIVED from a MIME→extension map (`q/{draftId}/{mediaId}.{ext}` while
 * quarantined). The client's filename is never used anywhere: it is attacker-controlled and it is
 * the shortest path to a path-traversal or content-type-confusion bug. The column CHECK rejects
 * `..` and any character outside `[0-9A-Za-z/._-]` as a second line of defence.
 */
export async function insertMediaAsset(
  db: D1Database,
  args: {
    readonly id: MediaAssetId;
    readonly draftId: DraftId | null;
    readonly siteId: SiteId | null;
    readonly orgId: OrganisationId | null;
    readonly r2Bucket: string;
    readonly r2Key: string;
    readonly kind: MediaKind;
    readonly source: MediaSource;
    readonly mimeType: string;
    readonly bytes: number;
    readonly width: number | null;
    readonly height: number | null;
    readonly role: MediaRole | null;
    readonly createdBy: string | null;
    readonly now: Timestamp;
  },
): Promise<void> {
  const result = await db
    .prepare(SQL_INSERT_MEDIA_ASSET)
    .bind(
      args.id,
      args.draftId,
      args.siteId,
      args.orgId,
      args.r2Bucket,
      args.r2Key,
      args.kind,
      args.source,
      args.mimeType,
      args.bytes,
      args.width,
      args.height,
      args.role,
      args.createdBy,
      args.now,
    )
    .run();
  assertSingleChange(result.meta, 'insertMediaAsset');
}

/** One asset by id. */
export const SQL_GET_MEDIA_ASSET = `
SELECT * FROM media_assets WHERE id = ?1
`;

/** Reads a media asset. */
export async function getMediaAsset(
  db: D1Database,
  mediaId: MediaAssetId,
): Promise<MediaAssetRow | null> {
  return db.prepare(SQL_GET_MEDIA_ASSET).bind(mediaId).first<MediaAssetRow>();
}

/**
 * The draft-scoped asset read.
 *
 * `GET /v1/media/:id` is reachable with only the draft cookie, so the draft id is a predicate and
 * not a returned field — a media id must never be enough on its own to read another visitor's
 * upload state.
 */
export const SQL_GET_MEDIA_FOR_DRAFT = `
SELECT * FROM media_assets WHERE id = ?1 AND draft_id = ?2
`;

/** Reads an asset, authorised against the draft that owns it. */
export async function getMediaForDraft(
  db: D1Database,
  args: { readonly mediaId: MediaAssetId; readonly draftId: DraftId },
): Promise<MediaAssetRow | null> {
  return db
    .prepare(SQL_GET_MEDIA_FOR_DRAFT)
    .bind(args.mediaId, args.draftId)
    .first<MediaAssetRow>();
}

/** Every live asset of a draft, in upload order. */
export const SQL_LIST_MEDIA_FOR_DRAFT = `
SELECT * FROM media_assets
WHERE draft_id = ?1 AND deleted_at IS NULL
ORDER BY created_at
`;

/** Lists a draft's uploads. */
export async function listMediaForDraft(
  db: D1Database,
  draftId: DraftId,
): Promise<readonly MediaAssetRow[]> {
  const result = await db.prepare(SQL_LIST_MEDIA_FOR_DRAFT).bind(draftId).all<MediaAssetRow>();
  return result.results;
}

/**
 * Per-draft upload quota: 12 files and 300 MB (architecture §S4).
 *
 * One statement rather than a count plus a sum, because the quota check runs before every signature
 * and D1 is single-threaded on writes — two round trips per signed upload is two too many.
 */
export const SQL_SUM_DRAFT_MEDIA = `
SELECT count(*) AS files, coalesce(sum(bytes), 0) AS total_bytes
FROM media_assets
WHERE draft_id = ?1 AND deleted_at IS NULL
`;

/** A draft's upload usage. */
export interface DraftMediaUsage {
  readonly files: number;
  readonly total_bytes: number;
}

/** Reads a draft's file count and byte total. */
export async function sumDraftMedia(db: D1Database, draftId: DraftId): Promise<DraftMediaUsage> {
  const row = await db.prepare(SQL_SUM_DRAFT_MEDIA).bind(draftId).first<DraftMediaUsage>();
  return row ?? { files: 0, total_bytes: 0 };
}

/**
 * `POST /v1/media/:id/commit` — the browser says the PUT finished.
 *
 * Moves to `verifying`, never to `ready`: the client's claimed sha256 is recorded but not trusted.
 * The queue consumer magic-byte-sniffs the object, re-encodes it through the Images binding with
 * `metadata: 'none'`, writes derivatives, and only then promotes the row.
 */
export const SQL_COMMIT_MEDIA_ASSET = `
UPDATE media_assets
SET sha256 = ?2, status = 'verifying', updated_at = ?3
WHERE id = ?1 AND status IN ('pending','uploading')
`;

/** Records a client-claimed digest and moves the asset into verification. */
export async function commitMediaAsset(
  db: D1Database,
  args: { readonly mediaId: MediaAssetId; readonly sha256: Uint8Array; readonly now: Timestamp },
): Promise<boolean> {
  const result = await db
    .prepare(SQL_COMMIT_MEDIA_ASSET)
    .bind(args.mediaId, toArrayBuffer(args.sha256), args.now)
    .run();
  return changedOne(result.meta);
}

/** Promotes a verified asset, with the metadata the renderer needs to avoid layout shift. */
export const SQL_PROMOTE_MEDIA_ASSET = `
UPDATE media_assets
SET status = 'ready', r2_bucket = ?2, r2_key = ?3, sha256 = ?4, mime_type = ?5, bytes = ?6,
    width = ?7, height = ?8, blurhash = ?9, dominant_color = ?10, variants = ?11,
    duration_ms = ?12, updated_at = ?13
WHERE id = ?1 AND status = 'verifying'
`;

/**
 * Promotes an asset out of quarantine.
 *
 * `width` and `height` are not optional for an image: the column CHECK requires them on a `ready`
 * image, because a hero rendered without intrinsic dimensions is a guaranteed CLS failure and the
 * §7 budget treats that as a publish-blocking defect.
 */
export async function promoteMediaAsset(
  db: D1Database,
  args: {
    readonly mediaId: MediaAssetId;
    readonly r2Bucket: string;
    readonly r2Key: string;
    readonly sha256: Uint8Array;
    readonly mimeType: string;
    readonly bytes: number;
    readonly width: number | null;
    readonly height: number | null;
    readonly blurhash: string | null;
    readonly dominantColor: string | null;
    readonly variants: string | null;
    readonly durationMs: number | null;
    readonly now: Timestamp;
  },
): Promise<boolean> {
  const result = await db
    .prepare(SQL_PROMOTE_MEDIA_ASSET)
    .bind(
      args.mediaId,
      args.r2Bucket,
      args.r2Key,
      toArrayBuffer(args.sha256),
      args.mimeType,
      args.bytes,
      args.width,
      args.height,
      args.blurhash,
      args.dominantColor,
      args.variants,
      args.durationMs,
      args.now,
    )
    .run();
  return changedOne(result.meta);
}

/** Marks an asset failed or quarantined, with the scanner's verdict attached. */
export const SQL_SET_MEDIA_STATUS = `
UPDATE media_assets SET status = ?2, scan_result = ?3, updated_at = ?4 WHERE id = ?1
`;

/**
 * Sets an asset's terminal status.
 *
 * `quarantined` is distinct from `failed` on purpose: a failed re-encode is our problem and can be
 * retried, while a quarantined object is a moderation decision that must survive a retry and feeds
 * an `abuse_events` row.
 */
export async function setMediaStatus(
  db: D1Database,
  args: {
    readonly mediaId: MediaAssetId;
    readonly status: MediaStatus;
    readonly scanResult: string | null;
    readonly now: Timestamp;
  },
): Promise<boolean> {
  const result = await db
    .prepare(SQL_SET_MEDIA_STATUS)
    .bind(args.mediaId, args.status, args.scanResult, args.now)
    .run();
  return changedOne(result.meta);
}

/**
 * Hands a draft's uploads to the site created at submit.
 *
 * Runs in the submit batch. The draft id is kept rather than cleared, so the `drafts/{id}/` R2
 * prefix purge can still find everything it must delete if the site is never claimed.
 */
export const SQL_PROMOTE_DRAFT_MEDIA = `
UPDATE media_assets
SET site_id = ?2, org_id = ?3, updated_at = ?4
WHERE draft_id = ?1 AND site_id IS NULL AND deleted_at IS NULL
`;

/** Builds the draft→site media hand-off, for the submit batch. */
export function promoteDraftMediaStatement(
  db: D1Database,
  args: {
    readonly draftId: DraftId;
    readonly siteId: SiteId;
    readonly orgId: OrganisationId;
    readonly now: Timestamp;
  },
): D1PreparedStatement {
  return db.prepare(SQL_PROMOTE_DRAFT_MEDIA).bind(args.draftId, args.siteId, args.orgId, args.now);
}

/** What the verify/re-encode consumer needs to retry an asset stuck before `ready`. */
export type PendingMedia = Pick<
  MediaAssetRow,
  'id' | 'r2_bucket' | 'r2_key' | 'mime_type' | 'status' | 'updated_at'
>;

/** What the multipart reaper needs to call R2's AbortMultipartUpload. */
export type ExpiredUpload = Pick<
  UploadSessionRow,
  'id' | 'media_id' | 'r2_bucket' | 'r2_key' | 'multipart_upload_id' | 'expires_at'
>;

/** Assets awaiting verification, for the queue consumer's retry sweep. */
export const SQL_LIST_PENDING_MEDIA = `
SELECT id, r2_bucket, r2_key, mime_type, status, updated_at
FROM media_assets
WHERE status IN ('pending','uploading','verifying','quarantined') AND updated_at < ?1
ORDER BY updated_at
LIMIT ?2
`;

/** Lists assets stuck before `ready`. */
export async function listPendingMedia(
  db: D1Database,
  args: { readonly before: Timestamp; readonly limit: number },
): Promise<readonly PendingMedia[]> {
  const result = await db
    .prepare(SQL_LIST_PENDING_MEDIA)
    .bind(args.before, args.limit)
    .all<PendingMedia>();
  return result.results;
}

// ---------------------------------------------------------------------------------------------
// Multipart uploads
// ---------------------------------------------------------------------------------------------

/**
 * Records an R2 multipart upload.
 *
 * R2 bills for the parts of an UNABORTED multipart upload indefinitely, and an abandoned browser
 * tab abandons one. The row is durable and `expires_at` is NOT NULL precisely so that a reaper can
 * find it — this is a silent recurring cost on a product whose onboarding invites video.
 */
export const SQL_INSERT_UPLOAD_SESSION = `
INSERT INTO upload_sessions (id, media_id, r2_bucket, r2_key, multipart_upload_id,
                             created_at, updated_at, expires_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)
`;

/** Inserts a multipart upload session. */
export async function insertUploadSession(
  db: D1Database,
  args: {
    readonly id: UploadSessionId;
    readonly mediaId: MediaAssetId;
    readonly r2Bucket: string;
    readonly r2Key: string;
    readonly multipartUploadId: string;
    readonly now: Timestamp;
    readonly expiresAt: Timestamp;
  },
): Promise<void> {
  const result = await db
    .prepare(SQL_INSERT_UPLOAD_SESSION)
    .bind(
      args.id,
      args.mediaId,
      args.r2Bucket,
      args.r2Key,
      args.multipartUploadId,
      args.now,
      args.expiresAt,
    )
    .run();
  assertSingleChange(result.meta, 'insertUploadSession');
}

/** Records the parts uploaded so far. */
export const SQL_UPDATE_UPLOAD_PARTS = `
UPDATE upload_sessions SET parts = ?2, parts_bytes = ?3, updated_at = ?4
WHERE id = ?1 AND state = 'open'
`;

/** Writes the part list. `parts` is a JSON array of `{partNumber, etag, bytes}`. */
export async function updateUploadParts(
  db: D1Database,
  args: {
    readonly id: UploadSessionId;
    readonly parts: string;
    readonly partsBytes: number;
    readonly now: Timestamp;
  },
): Promise<boolean> {
  const result = await db
    .prepare(SQL_UPDATE_UPLOAD_PARTS)
    .bind(args.id, args.parts, args.partsBytes, args.now)
    .run();
  return changedOne(result.meta);
}

/** Closes a multipart upload. */
export const SQL_CLOSE_UPLOAD_SESSION = `
UPDATE upload_sessions SET state = ?2, completed_at = ?3, updated_at = ?3
WHERE id = ?1 AND state = 'open'
`;

/** Marks a session completed, aborted or expired. */
export async function closeUploadSession(
  db: D1Database,
  args: {
    readonly id: UploadSessionId;
    readonly state: 'completed' | 'aborted' | 'expired';
    readonly now: Timestamp;
  },
): Promise<boolean> {
  const result = await db
    .prepare(SQL_CLOSE_UPLOAD_SESSION)
    .bind(args.id, args.state, args.now)
    .run();
  return changedOne(result.meta);
}

/** Abandoned multipart uploads, for the reaper that calls R2's AbortMultipartUpload. */
export const SQL_LIST_EXPIRED_UPLOAD_SESSIONS = `
SELECT id, media_id, r2_bucket, r2_key, multipart_upload_id, expires_at
FROM upload_sessions
WHERE state = 'open' AND expires_at < ?1
ORDER BY expires_at
LIMIT ?2
`;

/** Lists open sessions past their deadline. */
export async function listExpiredUploadSessions(
  db: D1Database,
  args: { readonly now: Timestamp; readonly limit: number },
): Promise<readonly ExpiredUpload[]> {
  const result = await db
    .prepare(SQL_LIST_EXPIRED_UPLOAD_SESSIONS)
    .bind(args.now, args.limit)
    .all<ExpiredUpload>();
  return result.results;
}
