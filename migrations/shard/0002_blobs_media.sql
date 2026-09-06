-- ============================================================================================
-- migrations/shard/0002_blobs_media.sql      database: aibuilder-shard-NNN
--
-- PURPOSE
--   The two R2 ledgers. `content_blobs` refcounts the content-addressed JSON objects (page trees,
--   SiteDocs, blog bodies, AI transcripts) so the garbage collector knows what is safe to delete;
--   `media_assets` and `upload_sessions` track tenant uploads and the multipart uploads that carry
--   them. Neither table is on a read path: the R2 key of a blob is a pure function of its hash
--   (`blobs/<kind>/<sha[0:2]>/<sha[2:4]>/<sha>.json.gz`), so the renderer never joins either one.
--
--   `content_blobs` is SHARD-LOCAL by decision (architecture §5.1). Cross-tenant blob dedupe was
--   worth almost nothing — page trees are per-tenant unique — and media dedupe happens in the R2
--   key itself, which needs no D1 coordination at all. Keeping it shard-local is what unblocks
--   shard 2.
--
-- MIGRATION RULE (architecture §5.4). A cascade-parent table can NEVER be rebuilt in place on D1:
--   `PRAGMA foreign_keys=OFF` is unsupported and `defer_foreign_keys` defers constraint *checking*,
--   not FK *actions*, so the 12-step rebuild cascade-deletes every child while `foreign_key_check`
--   still reports success. Expand -> migrate -> contract using only `ALTER TABLE ADD/DROP/RENAME
--   COLUMN`. `content_blobs` is referenced with ON DELETE RESTRICT rather than CASCADE precisely so
--   that a mistake here fails loudly instead of unlinking live objects.
-- ============================================================================================

-- Refcount and GC ledger for R2 objects.
--
-- THE TWO-PHASE REAPER. The refcount is a HINT, never the delete authority:
--   1. mark   — a row with `refcount = 0` whose `last_ref_at` is older than the grace window is
--               moved to `state = 'tombstoned'` with `tombstoned_at = now`. Nothing is deleted.
--   2. verify — after the grace window has passed again, the reaper re-reads the row IN THE SAME
--               `batch()` as the delete and re-asserts `refcount = 0 AND state = 'tombstoned'`.
--               Only then does it delete the R2 object and the row.
-- A write that dedupes onto a tombstoned blob RESURRECTS it (`state = 'live'`, `tombstoned_at`
-- cleared) rather than skipping the R2 PUT — see the refcount triggers in 0006. Without that,
-- a dedupe hit between phase 1 and phase 2 points a live page at an object about to be deleted.
--
-- There is deliberately NO `max(refcount - 1, 0)` clamp anywhere. `CHECK (refcount >= 0)` means a
-- double-decrement aborts the write loudly instead of silently unlinking somebody's live homepage.
CREATE TABLE content_blobs (
  sha256       BLOB PRIMARY KEY,
  bytes        INTEGER NOT NULL CHECK (bytes > 0 AND bytes <= 268435456),
  content_type TEXT NOT NULL DEFAULT 'application/json'
                 CHECK (length(content_type) BETWEEN 3 AND 100),
  encoding     TEXT NOT NULL DEFAULT 'gzip' CHECK (encoding IN ('identity','gzip','br')),
  kind         TEXT NOT NULL CHECK (kind IN
                 ('page_tree','site_doc','blog_body','locale_bundle','prompt','ai_transcript',
                  'bundle','legal_doc')),
  refcount     INTEGER NOT NULL DEFAULT 0 CHECK (refcount >= 0),
  state        TEXT NOT NULL DEFAULT 'live' CHECK (state IN ('live','tombstoned')),
  tombstoned_at INTEGER,
  created_at   INTEGER NOT NULL,
  -- Bumped on EVERY refcount mutation, including a decrement, so the grace window is measured from
  -- the moment the blob last stopped being referenced rather than from when it was created.
  last_ref_at  INTEGER NOT NULL,
  CHECK (length(sha256) = 32),
  CHECK (state <> 'tombstoned' OR (tombstoned_at IS NOT NULL AND refcount = 0)),
  CHECK (state <> 'live' OR tombstoned_at IS NULL)
) STRICT, WITHOUT ROWID;

-- Phase 1 of the reaper: unreferenced live blobs, oldest first.
CREATE INDEX idx_blobs_mark ON content_blobs(last_ref_at) WHERE refcount = 0 AND state = 'live';
-- Phase 2: tombstoned blobs whose grace window has expired.
CREATE INDEX idx_blobs_sweep ON content_blobs(tombstoned_at) WHERE state = 'tombstoned';
-- `idx_blobs_kind` is deliberately absent (architecture §5.4): no shipped query used it, and the
-- index was larger than several of the tables in this database.

CREATE TABLE media_assets (
  id             TEXT PRIMARY KEY,
  -- NULL until submit: uploads happen during onboarding, before an organisation or a site exists.
  -- The draft's `shard_id` is what routes the row to this database in the meantime.
  site_id        TEXT CHECK (site_id IS NULL OR
                   (length(site_id) = 30 AND site_id GLOB 'ste_[0-7]*'
                    AND substr(site_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
  org_id         TEXT CHECK (org_id IS NULL OR
                   (length(org_id) = 30 AND org_id GLOB 'org_[0-7]*'
                    AND substr(org_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
  draft_id       TEXT CHECK (draft_id IS NULL OR
                   (length(draft_id) = 30 AND draft_id GLOB 'drf_[0-7]*'
                    AND substr(draft_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
  r2_bucket      TEXT NOT NULL CHECK (length(r2_bucket) BETWEEN 3 AND 63),
  -- SERVER-DERIVED, always. `q/{draftId}/{mediaId}.{ext}` from a MIME->extension map while
  -- quarantined, `m/{siteId}/{mediaId}/…` once promoted. The client's filename is never used:
  -- it is attacker-controlled and it is the shortest path to a path-traversal or a content-type
  -- confusion bug.
  r2_key         TEXT NOT NULL CHECK (length(r2_key) BETWEEN 3 AND 1024
                   AND r2_key NOT GLOB '*[^0-9A-Za-z/._-]*' AND r2_key NOT GLOB '*..*'),
  sha256         BLOB CHECK (sha256 IS NULL OR length(sha256) = 32),
  kind           TEXT NOT NULL CHECK (kind IN ('image','video','audio','document','favicon')),
  source         TEXT NOT NULL DEFAULT 'upload'
                   CHECK (source IN ('upload','pexels','unsplash','ai_generated','stock_video')),
  source_ref     TEXT CHECK (source_ref IS NULL OR length(source_ref) <= 200),
  source_url     TEXT CHECK (source_url IS NULL OR length(source_url) <= 1000),
  -- The Pexels/Unsplash licence requires a visible credit. Storing it next to the asset is what
  -- makes the renderer able to emit it without a second lookup.
  attribution    TEXT CHECK (attribution IS NULL OR length(attribution) <= 500),
  license        TEXT CHECK (license IS NULL OR length(license) <= 100),
  mime_type      TEXT NOT NULL CHECK (length(mime_type) BETWEEN 3 AND 100
                   AND mime_type NOT GLOB '*[^0-9a-z/.+-]*'),
  -- A generous sanity bound, not the policy. The API enforces the real per-role limits (15 MB for
  -- an onboarding image, §S4) inside the presigned signature via a bound `content-length`, which is
  -- the only place the limit can actually be enforced — the bytes go browser -> R2 and never
  -- traverse a Worker. This CHECK exists so a corrupt commit cannot record an absurd size.
  bytes          INTEGER NOT NULL CHECK (bytes > 0 AND bytes <= 536870912),
  width          INTEGER CHECK (width IS NULL OR (width > 0 AND width <= 20000)),
  height         INTEGER CHECK (height IS NULL OR (height > 0 AND height <= 20000)),
  duration_ms    INTEGER CHECK (duration_ms IS NULL OR duration_ms > 0),
  blurhash       TEXT CHECK (blurhash IS NULL OR length(blurhash) BETWEEN 6 AND 64),
  dominant_color TEXT CHECK (dominant_color IS NULL OR
                   (length(dominant_color) = 7 AND dominant_color GLOB '#*'
                    AND substr(dominant_color, 2) NOT GLOB '*[^0-9a-f]*')),
  -- Per-locale alt text as one small JSON object: {"nl":"…","en":"…"}. The second deliberate
  -- exception to the translation-table rule (the first is `industry_groups.labels`): alt text is
  -- tiny, always fetched with its asset, and never filtered or sorted by locale.
  alt_text       TEXT CHECK (alt_text IS NULL OR
                   (json_valid(alt_text) AND length(alt_text) <= 4096)),
  variants       TEXT CHECK (variants IS NULL OR
                   (json_valid(variants) AND length(variants) <= 4096)),
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                   ('pending','uploading','verifying','ready','failed','quarantined','deleted')),
  scan_result    TEXT CHECK (scan_result IS NULL OR
                   (json_valid(scan_result) AND length(scan_result) <= 2048)),
  role           TEXT CHECK (role IS NULL OR role IN
                   ('hero_video','hero_image','logo','gallery','og','blog_cover','favicon')),
  created_by     TEXT CHECK (created_by IS NULL OR
                   (length(created_by) = 30 AND created_by GLOB 'usr_[0-7]*'
                    AND substr(created_by, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER,
  CHECK (length(id) = 30 AND id GLOB 'med_[0-7]*' AND substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  -- Every asset is owned by a draft or by a site. An asset owned by neither is an orphan that
  -- nothing will ever bill, authorise or garbage-collect.
  CHECK (draft_id IS NOT NULL OR site_id IS NOT NULL),
  CHECK (status <> 'ready' OR sha256 IS NOT NULL),
  CHECK (kind <> 'image' OR status <> 'ready' OR (width IS NOT NULL AND height IS NOT NULL)),
  CHECK (deleted_at IS NULL OR status = 'deleted')
) STRICT;

CREATE UNIQUE INDEX uq_media_r2 ON media_assets(r2_bucket, r2_key);
CREATE INDEX idx_media_site  ON media_assets(site_id, kind, created_at DESC)
  WHERE site_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_media_draft ON media_assets(draft_id, created_at)
  WHERE draft_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_media_role  ON media_assets(site_id, role)
  WHERE role IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_media_dedup ON media_assets(sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX idx_media_gc    ON media_assets(deleted_at) WHERE deleted_at IS NOT NULL;
-- Per-draft and per-org byte accounting: 12 files / 300 MB per draft (§S4), and the storage line
-- of the org's usage counters.
CREATE INDEX idx_media_org_bytes ON media_assets(org_id, bytes)
  WHERE org_id IS NOT NULL AND deleted_at IS NULL;
-- The quarantine queue and the moderation review list.
CREATE INDEX idx_media_pending ON media_assets(status, updated_at)
  WHERE status IN ('pending','uploading','verifying','quarantined');

-- R2 multipart uploads.
--
-- R2 bills for the parts of an unaborted multipart upload INDEFINITELY, and an abandoned browser
-- tab abandons one. That is a silent recurring cost on a product whose onboarding invites video,
-- so the upload id is durable, `expires_at` is NOT NULL, and a reaper aborts anything past it.
CREATE TABLE upload_sessions (
  id            TEXT PRIMARY KEY,
  media_id      TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  r2_bucket     TEXT NOT NULL CHECK (length(r2_bucket) BETWEEN 3 AND 63),
  r2_key        TEXT NOT NULL CHECK (length(r2_key) BETWEEN 3 AND 1024),
  multipart_upload_id TEXT NOT NULL CHECK (length(multipart_upload_id) BETWEEN 1 AND 512),
  -- [{ partNumber, etag, bytes }] in part order. Bounded because R2 allows 10,000 parts and a
  -- 10,000-entry JSON array would approach D1's 2 MB row cap on its own.
  parts         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(parts)
                  AND json_type(parts) = 'array'
                  AND json_array_length(parts) <= 1000
                  AND length(parts) <= 65536),
  parts_bytes   INTEGER NOT NULL DEFAULT 0 CHECK (parts_bytes >= 0),
  state         TEXT NOT NULL DEFAULT 'open'
                  CHECK (state IN ('open','completed','aborted','expired')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  CHECK (length(id) = 30 AND id GLOB 'ups_[0-7]*' AND substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (expires_at > created_at),
  CHECK (state <> 'completed' OR completed_at IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX uq_upload_sessions_media ON upload_sessions(media_id) WHERE state = 'open';
-- The reaper. Small and sorted: only open sessions are ever scanned.
CREATE INDEX idx_upload_sessions_reap ON upload_sessions(expires_at) WHERE state = 'open';
-- FK child index for `media_assets` deletes: the unique index above is partial on `state`, which
-- the cascade does not carry.
CREATE INDEX idx_upload_sessions_media ON upload_sessions(media_id);
