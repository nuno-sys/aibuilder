import type {
  GenerationJobId,
  GenerationJobRow,
  MediaAssetId,
  MediaAssetRow,
  SiteId,
  SiteVersionId,
  SiteVersionRow,
  Timestamp,
} from '../types';

/**
 * The shard reads the live editor makes — `apps/app` and nothing else.
 *
 * WHAT THE EDITOR NEEDS THAT NOTHING ELSE DOES. The generator writes versions and the renderer
 * serves them; neither ever asks "which version should a human be editing right now", and neither
 * ever lists a site's media library, because the generator holds the manifest it just built and the
 * renderer holds resolved URLs. The editor asks both questions on every page load.
 *
 * EVERY STATEMENT IS SITE-SCOPED, and that is not a convenience. `apps/app` resolves the shard
 * binding from `sites.shard_id` after `cp.dashboard.getSiteForUser` has already proved membership,
 * so `site_id = ?1` here is the second half of one authorisation decision rather than a filter. A
 * statement in this module that took a version id or a media id ALONE would let a loader read
 * another tenant's row on the same shard by guessing an id, so none of them does: the two
 * single-row reads take `(siteId, id)` and match on both.
 *
 * NO WRITES LIVE HERE. Draft edits are held in `SiteDraftDO` — `DECISIONS`/architecture §9 is
 * explicit that every patch goes to Durable Object storage, and that a draft is not a `site_versions`
 * row until the customer publishes it. When publish lands, it writes through
 * `shard/versions.ts`'s existing statements, which already own the seal and its triggers.
 */

/* ── The version the editor opens ────────────────────────────────────────────────────────────── */

/**
 * The newest version of a site a human may edit.
 *
 * `published` first when it exists and `ready` otherwise — expressed as one `ORDER BY` over both,
 * not as two statements with a null check between them, so there is no window in which a publish
 * lands between the two reads and the editor opens the version it just replaced.
 *
 * `manifest_sha256 IS NOT NULL` is not decoration: `migrations/shard/0001` carries
 * `CHECK (status NOT IN ('published','ready') OR manifest_sha256 IS NOT NULL)`, so a row without it
 * cannot be in either status — but the predicate documents that the caller is about to go to R2
 * with `siteDocKey()` and needs the object to exist.
 *
 * Plan: one seek on `uq_site_versions_no (site_id, version_no DESC)`, which is also the ordering,
 * so there is no sort. The `CASE` orders within equal `site_id`; SQLite still uses the index for
 * the seek and sorts at most the handful of versions a site has.
 */
export const SQL_GET_EDITABLE_VERSION = `
SELECT * FROM site_versions
WHERE site_id = ?1
  AND status IN ('published','ready')
  AND manifest_sha256 IS NOT NULL
ORDER BY CASE status WHEN 'published' THEN 0 ELSE 1 END, version_no DESC
LIMIT 1
`;

/** Reads the version the editor should load, or `null` when the site has never finished a build. */
export async function getEditableVersion(
  db: D1Database,
  siteId: SiteId,
): Promise<SiteVersionRow | null> {
  return db.prepare(SQL_GET_EDITABLE_VERSION).bind(siteId).first<SiteVersionRow>();
}

/**
 * One version of one site.
 *
 * Takes BOTH ids and matches on both. A version id is a `ver_<ULID>` and is therefore unguessable
 * in practice, but "unguessable" is not an authorisation model and this statement runs against a
 * shard shared by thousands of tenants.
 */
export const SQL_GET_SITE_VERSION_FOR_SITE = `
SELECT * FROM site_versions WHERE id = ?2 AND site_id = ?1
`;

/** Reads one of a site's versions, or `null` when it belongs to a different site. */
export async function getSiteVersionForSite(
  db: D1Database,
  args: { readonly siteId: SiteId; readonly versionId: SiteVersionId },
): Promise<SiteVersionRow | null> {
  return db
    .prepare(SQL_GET_SITE_VERSION_FOR_SITE)
    .bind(args.siteId, args.versionId)
    .first<SiteVersionRow>();
}

/* ── The media library ───────────────────────────────────────────────────────────────────────── */

/** The columns the editor's media grid renders. Never the whole row: `variants` is a JSON blob. */
export type EditorMediaRow = Pick<
  MediaAssetRow,
  | 'id'
  | 'r2_key'
  | 'kind'
  | 'source'
  | 'mime_type'
  | 'bytes'
  | 'width'
  | 'height'
  | 'blurhash'
  | 'dominant_color'
  | 'alt_text'
  | 'status'
  | 'role'
  | 'created_at'
>;

/**
 * A site's verified media, newest first.
 *
 * `status = 'ready'` is applied here rather than left to the caller because the media page must
 * never render a quarantined object: an asset that has not been through the re-encode is, by the
 * threat model in architecture §8, still attacker-controlled bytes. Pending uploads are shown from
 * the client's own upload state, which is where they actually live until the queue consumer
 * promotes them.
 *
 * Plan: one seek on `idx_media_site (site_id, kind, created_at DESC) WHERE site_id IS NOT NULL AND
 * deleted_at IS NULL`. The `deleted_at IS NULL` predicate is repeated in the statement text
 * verbatim — SQLite's prover needs it there to use a partial index, and `media_assets` has no
 * soft-delete view to hide that behind.
 */
export const SQL_LIST_SITE_MEDIA = `
SELECT id, r2_key, kind, source, mime_type, bytes, width, height, blurhash, dominant_color,
       alt_text, status, role, created_at
FROM media_assets
WHERE site_id = ?1 AND deleted_at IS NULL AND status = 'ready'
ORDER BY created_at DESC
LIMIT ?2
`;

/** Lists a site's usable media. */
export async function listSiteMedia(
  db: D1Database,
  args: { readonly siteId: SiteId; readonly limit: number },
): Promise<readonly EditorMediaRow[]> {
  const result = await db
    .prepare(SQL_LIST_SITE_MEDIA)
    .bind(args.siteId, args.limit)
    .all<EditorMediaRow>();
  return result.results;
}

/**
 * One media asset of one site.
 *
 * Both ids, both matched — the same rule as `getSiteVersionForSite`, and for the same reason: the
 * editor turns this into an R2 key, and an R2 key derived from another tenant's row is a
 * cross-tenant read.
 */
export const SQL_GET_SITE_MEDIA = `
SELECT id, r2_key, kind, source, mime_type, bytes, width, height, blurhash, dominant_color,
       alt_text, status, role, created_at
FROM media_assets
WHERE id = ?2 AND site_id = ?1 AND deleted_at IS NULL
`;

/** Reads one of a site's media assets, or `null` when it belongs to a different site. */
export async function getSiteMedia(
  db: D1Database,
  args: { readonly siteId: SiteId; readonly mediaId: MediaAssetId },
): Promise<EditorMediaRow | null> {
  return db.prepare(SQL_GET_SITE_MEDIA).bind(args.siteId, args.mediaId).first<EditorMediaRow>();
}

/**
 * Sets the alt text of one of a site's media assets.
 *
 * The one write this module does own, and it is here rather than in `shard/media.ts` because alt
 * text is the only property of an asset a *customer* edits — everything else in that table is
 * written by the pipeline from bytes it hashed itself. Guarded on `site_id` for the usual reason.
 *
 * Alt text is deliberately NOT a copy slot in this phase. `MediaAsset.altText` on the `SiteDoc`
 * carries a note that it becomes a per-locale slot once the editor can translate; until it does, a
 * single string on the asset is the honest model, because that is what the renderer reads.
 */
export const SQL_SET_MEDIA_ALT_TEXT = `
UPDATE media_assets SET alt_text = ?3, updated_at = ?4
WHERE id = ?2 AND site_id = ?1 AND deleted_at IS NULL
`;

/** Updates one asset's alt text. Returns false when the asset is not this site's. */
export async function setMediaAltText(
  db: D1Database,
  args: {
    readonly siteId: SiteId;
    readonly mediaId: MediaAssetId;
    readonly altText: string | null;
    readonly now: Timestamp;
  },
): Promise<boolean> {
  const result = await db
    .prepare(SQL_SET_MEDIA_ALT_TEXT)
    .bind(args.siteId, args.mediaId, args.altText, args.now)
    .run();
  return result.meta.changes === 1;
}

/* ── The site overview's activity list ───────────────────────────────────────────────────────── */

/** What the overview page shows about a past or running generation. */
export type SiteJobRow = Pick<
  GenerationJobRow,
  | 'id'
  | 'kind'
  | 'status'
  | 'site_version_id'
  | 'error_code'
  | 'queued_at'
  | 'started_at'
  | 'finished_at'
  | 'created_at'
>;

/**
 * A site's recent generation jobs, newest first.
 *
 * Feeds two things on the overview: "last regenerated at", and the live link into the progress
 * stream when a job is still running. Bounded by `LIMIT` rather than by a time window, because the
 * page renders a fixed-height list and a site that regenerated twice in a year must still show
 * both.
 *
 * Plan: one seek on `idx_jobs_site (site_id, created_at DESC, status, kind)`, which is covering for
 * three of the selected columns and orders the rest.
 */
export const SQL_LIST_JOBS_FOR_SITE = `
SELECT id, kind, status, site_version_id, error_code, queued_at, started_at, finished_at, created_at
FROM generation_jobs
WHERE site_id = ?1
ORDER BY created_at DESC
LIMIT ?2
`;

/** Lists a site's recent generation jobs. */
export async function listJobsForSite(
  db: D1Database,
  args: { readonly siteId: SiteId; readonly limit: number },
): Promise<readonly SiteJobRow[]> {
  const result = await db
    .prepare(SQL_LIST_JOBS_FOR_SITE)
    .bind(args.siteId, args.limit)
    .all<SiteJobRow>();
  return result.results;
}

/**
 * One job of one site.
 *
 * The editor's Regenerate button polls this after the API accepted the request, so it must not be
 * reachable with a job id alone: `generation_jobs` is shared by every tenant on the shard.
 */
export const SQL_GET_JOB_FOR_SITE = `
SELECT id, kind, status, site_version_id, error_code, queued_at, started_at, finished_at, created_at
FROM generation_jobs
WHERE id = ?2 AND site_id = ?1
`;

/** Reads one of a site's jobs, or `null` when it belongs to a different site. */
export async function getJobForSite(
  db: D1Database,
  args: { readonly siteId: SiteId; readonly jobId: GenerationJobId },
): Promise<SiteJobRow | null> {
  return db.prepare(SQL_GET_JOB_FOR_SITE).bind(args.siteId, args.jobId).first<SiteJobRow>();
}
