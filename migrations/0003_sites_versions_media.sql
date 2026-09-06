-- 0003_sites_versions_media.sql
-- Content placement rule enforced by this file:
--   D1 holds ONLY what you filter/sort/join/authorise on. Page component trees go to R2.
--   Every content column is a POINTER TRIO (sha256 + bytes) or a small inline TEXT, never both.
--   The R2 key is a PURE FUNCTION of the hash -> reads never join content_blobs:
--     blobs/<kind>/<sha[0:2]>/<sha[2:4]>/<sha>.json.gz

-- Content-addressed blob registry. Exists ONLY for garbage collection and byte accounting.
-- Identical content across locales / across site versions dedupes to one row and one R2 object.
CREATE TABLE content_blobs (
  sha256       TEXT PRIMARY KEY,
  bytes        INTEGER NOT NULL CHECK (bytes > 0 AND bytes <= 268435456),
  content_type TEXT NOT NULL DEFAULT 'application/json',
  encoding     TEXT NOT NULL DEFAULT 'gzip' CHECK (encoding IN ('identity','gzip','br')),
  kind         TEXT NOT NULL CHECK (kind IN
                 ('page_tree','site_manifest','blog_body','prompt','ai_transcript',
                  'bundle','legal_doc','stripe_event')),
  refcount     INTEGER NOT NULL DEFAULT 0 CHECK (refcount >= 0),
  created_at   INTEGER NOT NULL,
  last_ref_at  INTEGER NOT NULL,
  CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')
) STRICT, WITHOUT ROWID;

-- Reaper: unreferenced blobs older than the grace window get deleted from R2.
CREATE INDEX idx_blobs_gc   ON content_blobs(last_ref_at) WHERE refcount = 0;
CREATE INDEX idx_blobs_kind ON content_blobs(kind, created_at DESC);

CREATE TABLE sites (
  id                   TEXT PRIMARY KEY,
  org_id               TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  slug                 TEXT NOT NULL,                       -- <slug>.mijnsaas.com
  business_name        TEXT NOT NULL CHECK (length(business_name) BETWEEN 1 AND 200),
  industry_key         TEXT NOT NULL REFERENCES industries(key) ON DELETE RESTRICT,
  default_locale       TEXT NOT NULL REFERENCES locales(code) ON DELETE RESTRICT,
  status               TEXT NOT NULL DEFAULT 'onboarding' CHECK (status IN
                         ('onboarding','generating','draft','published','suspended','deleted')),

  -- ---- onboarding payload: small, structured, actually queried -> stays in D1 ----
  address_line1        TEXT,
  address_line2        TEXT,
  postal_code          TEXT,
  city                 TEXT,
  country              TEXT CHECK (country IS NULL OR country GLOB '[A-Z][A-Z]'),
  latitude             REAL CHECK (latitude  IS NULL OR latitude  BETWEEN  -90 AND  90),
  longitude            REAL CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  phone_e164           TEXT CHECK (phone_e164    IS NULL OR
                         (phone_e164 GLOB '+[0-9]*' AND length(phone_e164) BETWEEN 8 AND 16)),
  whatsapp_e164        TEXT CHECK (whatsapp_e164 IS NULL OR
                         (whatsapp_e164 GLOB '+[0-9]*' AND length(whatsapp_e164) BETWEEN 8 AND 16)),
  contact_email        TEXT,
  gbp_url              TEXT CHECK (gbp_url IS NULL OR gbp_url GLOB 'https://*'),
  opening_hours        TEXT CHECK (opening_hours IS NULL OR
                         (json_valid(opening_hours) AND length(opening_hours) <= 4096)),
  short_description    TEXT CHECK (short_description IS NULL OR length(short_description) <= 2000),

  -- Live-editor theme. Small (<8 KB), read on every editor keystroke, diffed constantly.
  -- Below the 64 KB inline threshold -> an R2 round trip here would be pure latency tax.
  theme_tokens         TEXT CHECK (theme_tokens IS NULL OR
                         (json_valid(theme_tokens) AND length(theme_tokens) <= 8192)),

  -- Mutable pointers into the immutable version DAG. Nullable to break the sites<->site_versions
  -- cycle: INSERT site (NULLs) -> INSERT version -> UPDATE site. Or one batch() with
  -- PRAGMA defer_foreign_keys = on.
  draft_version_id     TEXT REFERENCES site_versions(id) ON DELETE SET NULL,
  published_version_id TEXT REFERENCES site_versions(id) ON DELETE SET NULL,
  published_at         INTEGER,

  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  deleted_at           INTEGER,
  CHECK (id GLOB 'ste_[0-7]*' AND length(id) = 30),
  CHECK (length(slug) BETWEEN 3 AND 63
         AND slug NOT GLOB '*[^a-z0-9-]*'   -- lowercase alnum + hyphen only
         AND slug GLOB '[a-z0-9]*'          -- must start alnum
         AND slug NOT GLOB '*-'             -- must not end with a hyphen
         AND slug NOT GLOB '*--*')          -- no double hyphen (RFC 5891 / punycode clash)
) STRICT;

CREATE UNIQUE INDEX uq_sites_slug   ON sites(slug) WHERE deleted_at IS NULL;
CREATE INDEX        idx_sites_org   ON sites(org_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX        idx_sites_status ON sites(status, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX        idx_sites_pub   ON sites(published_version_id) WHERE published_version_id IS NOT NULL;

-- Immutable snapshot unit. Undo / rollback / regenerate all operate on this table.
-- Blobs are shared between versions, so a new version costs ~1 KB of D1 + only the
-- R2 objects that actually changed.
CREATE TABLE site_versions (
  id                TEXT PRIMARY KEY,
  site_id           TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  version_no        INTEGER NOT NULL CHECK (version_no > 0),
  parent_version_id TEXT REFERENCES site_versions(id) ON DELETE SET NULL,
  origin            TEXT NOT NULL CHECK (origin IN
                      ('generation','regeneration','editor','rollback','import','translation')),
  -- Deliberately NOT a FK: generation_jobs.site_version_id is the authoritative direction.
  -- A second FK here would create a second table cycle for zero benefit.
  generation_job_id TEXT,
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                      ('draft','building','ready','published','archived','failed')),
  label             TEXT,
  theme_tokens      TEXT CHECK (theme_tokens IS NULL OR
                      (json_valid(theme_tokens) AND length(theme_tokens) <= 16384)),
  features          TEXT CHECK (features IS NULL OR
                      (json_valid(features) AND length(features) <= 8192)),
  manifest_sha256   TEXT,          -- full generated site manifest -> R2
  manifest_bytes    INTEGER CHECK (manifest_bytes IS NULL OR manifest_bytes >= 0),
  bundle_sha256     TEXT,          -- built static bundle deployed to Pages -> R2
  bundle_bytes      INTEGER CHECK (bundle_bytes IS NULL OR bundle_bytes >= 0),
  lighthouse_scores TEXT CHECK (lighthouse_scores IS NULL OR json_valid(lighthouse_scores)),
  sealed_at         INTEGER,       -- non-NULL => this row and its children are frozen (see 0008)
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  CHECK (id GLOB 'ver_[0-7]*' AND length(id) = 30),
  CHECK (id <> parent_version_id),
  CHECK (status <> 'published' OR sealed_at IS NOT NULL),
  CHECK (manifest_sha256 IS NULL OR
         (length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*')),
  CHECK (bundle_sha256 IS NULL OR
         (length(bundle_sha256) = 64 AND bundle_sha256 NOT GLOB '*[^0-9a-f]*'))
) STRICT;

-- UNIQUE enforces the per-site sequence; DESC makes "latest version" a single reverse seek.
CREATE UNIQUE INDEX uq_site_versions_no  ON site_versions(site_id, version_no DESC);
CREATE INDEX idx_site_versions_history   ON site_versions(site_id, created_at DESC, status, label);
CREATE INDEX idx_site_versions_building  ON site_versions(status, updated_at)
  WHERE status IN ('building','ready');
CREATE INDEX idx_site_versions_parent    ON site_versions(parent_version_id)
  WHERE parent_version_id IS NOT NULL;

-- Which locales a site publishes. Adding a 7th language = ONE INSERT here + N page_translations.
-- Zero DDL, zero migration.
CREATE TABLE site_locales (
  site_id            TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  locale             TEXT NOT NULL REFERENCES locales(code) ON DELETE RESTRICT,
  url_segment        TEXT NOT NULL,
  is_default         INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  is_enabled         INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0,1)),
  translation_status TEXT NOT NULL DEFAULT 'pending'
                       CHECK (translation_status IN ('pending','machine','ai','human','stale')),
  sort_order         INTEGER NOT NULL DEFAULT 100,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (site_id, locale)
) STRICT, WITHOUT ROWID;

-- Partial UNIQUE index = "exactly one x-default per site", enforced by the database.
CREATE UNIQUE INDEX uq_site_locales_default ON site_locales(site_id) WHERE is_default = 1;
CREATE UNIQUE INDEX uq_site_locales_segment ON site_locales(site_id, url_segment);
CREATE INDEX idx_site_locales_enabled ON site_locales(site_id, sort_order, locale) WHERE is_enabled = 1;

CREATE TABLE media_assets (
  id             TEXT PRIMARY KEY,
  site_id        TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  org_id         TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  r2_bucket      TEXT NOT NULL DEFAULT 'aibuilder-media',
  r2_key         TEXT NOT NULL,
  sha256         TEXT CHECK (sha256 IS NULL OR
                   (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')),
  kind           TEXT NOT NULL CHECK (kind IN ('image','video','audio','document','favicon')),
  source         TEXT NOT NULL DEFAULT 'upload'
                   CHECK (source IN ('upload','pexels','unsplash','ai_generated','stock_video')),
  source_ref     TEXT,
  source_url     TEXT,
  attribution    TEXT,          -- Pexels/Unsplash licence requires visible credit
  license        TEXT,
  mime_type      TEXT NOT NULL,
  bytes          INTEGER NOT NULL CHECK (bytes > 0 AND bytes <= 524288000),
  width          INTEGER CHECK (width  IS NULL OR width  > 0),
  height         INTEGER CHECK (height IS NULL OR height > 0),
  duration_ms    INTEGER CHECK (duration_ms IS NULL OR duration_ms > 0),
  blurhash       TEXT,
  dominant_color TEXT CHECK (dominant_color IS NULL OR
                   (dominant_color GLOB '#*' AND length(dominant_color) = 7)),
  -- Per-locale alt text as one small JSON object: {"en":"...","nl":"..."}.
  -- The ONE deliberate exception to the translation-table rule - alt text is tiny,
  -- always fetched with its asset, and never filtered or sorted by locale.
  alt_text       TEXT CHECK (alt_text IS NULL OR
                   (json_valid(alt_text) AND length(alt_text) <= 4096)),
  variants       TEXT CHECK (variants IS NULL OR json_valid(variants)),
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','uploading','ready','failed','quarantined','deleted')),
  scan_result    TEXT,
  role           TEXT CHECK (role IS NULL OR role IN
                   ('hero_video','hero_image','logo','gallery','og','blog_cover','favicon')),
  created_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER,
  CHECK (id GLOB 'med_[0-7]*' AND length(id) = 30)
) STRICT;

CREATE UNIQUE INDEX uq_media_r2     ON media_assets(r2_bucket, r2_key);
CREATE INDEX idx_media_site         ON media_assets(site_id, kind, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_media_role         ON media_assets(site_id, role)
  WHERE role IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_media_dedup        ON media_assets(sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX idx_media_gc           ON media_assets(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_media_org_bytes    ON media_assets(org_id, bytes) WHERE deleted_at IS NULL;
