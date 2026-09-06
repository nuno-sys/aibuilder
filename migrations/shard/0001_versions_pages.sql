-- ============================================================================================
-- migrations/shard/0001_versions_pages.sql   database: aibuilder-shard-NNN (--location eu)
--
-- PURPOSE
--   The version DAG and the page projection. `site_versions` is the immutable snapshot unit that
--   undo, rollback and regenerate all operate on; `pages` / `page_translations` are a BUILD-TIME
--   PROJECTION of the SiteDoc, not a request-path table — architecture §3a keeps D1 off the tenant
--   read path entirely (KV -> Cache -> R2). These rows exist so the publish pipeline, the sitemap
--   builder, the hreflang cluster builder and the editor can filter, sort and join. Nothing else.
--
-- MIGRATION RULE (architecture §5.4). A cascade-parent table can NEVER be rebuilt in place on D1.
--   `PRAGMA foreign_keys=OFF` is not supported by D1, and `defer_foreign_keys` defers constraint
--   *checking*, not FK *actions*: the 12-step rebuild deletes every child row through the cascade
--   and `foreign_key_check` passes clean afterwards, so the loss is silent. Forward change is
--   expand -> migrate -> contract, using only `ALTER TABLE ADD COLUMN` / `DROP COLUMN` /
--   `RENAME COLUMN`, none of which rebuild. CI gates every migration on a per-table row-count
--   snapshot taken before and after. `site_versions` and `pages` are the two most dangerous
--   cascade parents in the system: a rebuild of either destroys a paying tenant's published site.
--
-- SHARDING: THERE ARE NO FOREIGN KEYS TO THE CONTROL PLANE.
--   `site_id`, `org_id`, `created_by` and every `locale` name rows in `aibuilder-cp`. A foreign key
--   cannot span two D1 databases, so those columns are plain TEXT with a shape CHECK and the
--   integrity is maintained by ordered writes plus the ownership triggers in 0006. Deleting a site
--   or an organisation therefore does NOT cascade into this database; `packages/db/src/shard/*`
--   owns the explicit teardown. This is the price of §5.1's sharding decision and it is paid here.
--
-- CONVENTIONS
--   Identical to migrations/cp/0001_identity.sql — STRICT tables, INTEGER epoch-millisecond
--   timestamps, INTEGER booleans, sha256 as BLOB(32), anchored id CHECKs with a negated class.
-- ============================================================================================

CREATE TABLE site_versions (
  id                TEXT PRIMARY KEY,
  -- Control-plane rows. See the SHARDING note above: no FK is possible.
  site_id           TEXT NOT NULL,
  org_id            TEXT NOT NULL,
  version_no        INTEGER NOT NULL CHECK (version_no > 0),
  parent_version_id TEXT REFERENCES site_versions(id) ON DELETE SET NULL,
  origin            TEXT NOT NULL CHECK (origin IN
                      ('generation','regeneration','editor','rollback','import','translation')),
  -- Deliberately NOT a foreign key even though `generation_jobs` is shard-local:
  -- `generation_jobs.site_version_id` is the authoritative direction, and a second FK would create
  -- a table cycle that every insert path then has to order around, for no integrity gain.
  generation_job_id TEXT CHECK (generation_job_id IS NULL OR
                      (length(generation_job_id) = 30 AND generation_job_id GLOB 'job_[0-7]*'
                       AND substr(generation_job_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                      ('draft','building','ready','published','archived','failed')),
  label             TEXT CHECK (label IS NULL OR length(label) <= 120),
  -- Architecture §9 one-way door 8: every stored SiteDoc carries its schema version. AI-generated
  -- documents outlive schema revisions and cannot be regenerated for free, so upgrade-on-read
  -- needs to know what it is reading before it reads it.
  schema_version    INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  -- Under 8 KB and read on every editor keystroke. The one content column that stays inline: an R2
  -- round trip here would be pure latency tax on the live-theming path.
  theme_tokens      TEXT CHECK (theme_tokens IS NULL OR
                      (json_valid(theme_tokens) AND length(theme_tokens) <= 16384)),
  features          TEXT CHECK (features IS NULL OR
                      (json_valid(features) AND length(features) <= 8192)),
  -- The SiteDoc itself, in R2 at a key that is a pure function of this hash. The render path never
  -- joins `content_blobs`; that table exists only for refcounting and GC.
  manifest_sha256   BLOB CHECK (manifest_sha256 IS NULL OR length(manifest_sha256) = 32),
  manifest_bytes    INTEGER CHECK (manifest_bytes IS NULL OR manifest_bytes >= 0),
  -- The materialised HTML set for this version, also in R2. Publishing is a KV pointer flip; this
  -- is what the pointer resolves to.
  bundle_sha256     BLOB CHECK (bundle_sha256 IS NULL OR length(bundle_sha256) = 32),
  bundle_bytes      INTEGER CHECK (bundle_bytes IS NULL OR bundle_bytes >= 0),
  lighthouse_scores TEXT CHECK (lighthouse_scores IS NULL OR
                      (json_valid(lighthouse_scores) AND length(lighthouse_scores) <= 2048)),
  -- Facts / thinness / uniqueness / owned-media / doorway gate. WARN-ONLY in Phase 1 (architecture
  -- §10 risk 3): the MinHash threshold is uncalibrated and noindexing a paying customer on an
  -- uncalibrated threshold is worse than shipping a thin page.
  quality_state     TEXT NOT NULL DEFAULT 'pending'
                      CHECK (quality_state IN ('pending','pass','warn','fail','skipped')),
  quality_report    TEXT CHECK (quality_report IS NULL OR
                      (json_valid(quality_report) AND length(quality_report) <= 8192)),
  -- Non-NULL freezes this row and every page under it. See the seal triggers in 0006.
  sealed_at         INTEGER,
  created_by        TEXT CHECK (created_by IS NULL OR
                      (length(created_by) = 30 AND created_by GLOB 'usr_[0-7]*'
                       AND substr(created_by, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  CHECK (length(id) = 30 AND id GLOB 'ver_[0-7]*' AND substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (length(site_id) = 30 AND site_id GLOB 'ste_[0-7]*'
         AND substr(site_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (length(org_id) = 30 AND org_id GLOB 'org_[0-7]*'
         AND substr(org_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (id <> parent_version_id),
  -- A published version is always sealed. The converse is not true: a sealed version may be
  -- archived, which is what makes rollback a pointer flip rather than a rebuild.
  CHECK (status <> 'published' OR sealed_at IS NOT NULL),
  CHECK (status NOT IN ('published','ready') OR manifest_sha256 IS NOT NULL)
) STRICT;

-- UNIQUE enforces the per-site sequence; DESC makes "the latest version" one reverse seek.
CREATE UNIQUE INDEX uq_site_versions_no ON site_versions(site_id, version_no DESC);
CREATE INDEX idx_site_versions_history  ON site_versions(site_id, created_at DESC, status, label);
CREATE INDEX idx_site_versions_building ON site_versions(status, updated_at)
  WHERE status IN ('building','ready');
CREATE INDEX idx_site_versions_parent   ON site_versions(parent_version_id)
  WHERE parent_version_id IS NOT NULL;
-- Version-retirement sweep: archived and unsealed rows are the only ones the purge job may delete.
CREATE INDEX idx_site_versions_purge    ON site_versions(updated_at)
  WHERE status = 'archived' AND sealed_at IS NULL;

-- Which locales THIS site publishes. Adding a seventh language to a live site is one row here plus
-- one `page_translations` row per page: no ALTER TABLE, no deploy, no locale-named column anywhere.
CREATE TABLE site_locales (
  site_id            TEXT NOT NULL,
  locale             TEXT NOT NULL,
  url_segment        TEXT NOT NULL,
  is_default         INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  is_enabled         INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0,1)),
  translation_status TEXT NOT NULL DEFAULT 'pending'
                       CHECK (translation_status IN ('pending','machine','ai','human','stale')),
  sort_order         INTEGER NOT NULL DEFAULT 100,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (site_id, locale),
  CHECK (length(site_id) = 30 AND site_id GLOB 'ste_[0-7]*'
         AND substr(site_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (locale GLOB '[a-z][a-z]' OR locale GLOB '[a-z][a-z]-[A-Z][A-Z]'),
  CHECK (length(url_segment) BETWEEN 2 AND 12 AND url_segment NOT GLOB '*[^a-z-]*')
) STRICT, WITHOUT ROWID;

-- Exactly one x-default per site, enforced by the database rather than by the publish code. An
-- hreflang cluster with two x-default entries is silently dropped by Google.
CREATE UNIQUE INDEX uq_site_locales_default ON site_locales(site_id) WHERE is_default = 1;
CREATE UNIQUE INDEX uq_site_locales_segment ON site_locales(site_id, url_segment);
CREATE INDEX idx_site_locales_enabled ON site_locales(site_id, sort_order, locale)
  WHERE is_enabled = 1;

-- The logical page. LOCALE-INDEPENDENT by construction: `page_key` is the stable join key that
-- survives a rename, a translation and a regeneration.
CREATE TABLE pages (
  id               TEXT PRIMARY KEY,
  site_version_id  TEXT NOT NULL REFERENCES site_versions(id) ON DELETE CASCADE,
  -- Denormalised so shard-local authorisation and per-site sweeps skip the version join. Kept
  -- equal to the version's `site_id` by the ownership triggers in 0006 — BEFORE INSERT as well as
  -- BEFORE UPDATE, because the batch insert path walks straight past an UPDATE-only trigger.
  site_id          TEXT NOT NULL,
  page_key         TEXT NOT NULL,
  -- Mirrors `PageGen.role` in packages/site-schema/src/gen/site-structure.ts. Widening this CHECK
  -- is a rebuild of a cascade parent, which is forbidden — so `custom` exists as the escape hatch
  -- and new first-class roles arrive as a new column, never as a new enum value here.
  role             TEXT NOT NULL CHECK (role IN
                     ('home','about','services','menu','gallery','reviews','team','contact',
                      'booking','blog_index','privacy','terms','cookies','custom')),
  template         TEXT NOT NULL DEFAULT 'default'
                     CHECK (length(template) BETWEEN 1 AND 48 AND template NOT GLOB '*[^a-z0-9_-]*'),
  nav_group        TEXT NOT NULL DEFAULT 'primary'
                     CHECK (nav_group IN ('primary','footer','utility','none')),
  sort_order       INTEGER NOT NULL DEFAULT 100,
  is_indexable     INTEGER NOT NULL DEFAULT 1 CHECK (is_indexable IN (0,1)),
  sitemap_priority REAL NOT NULL DEFAULT 0.5 CHECK (sitemap_priority BETWEEN 0.0 AND 1.0),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK (length(id) = 30 AND id GLOB 'pag_[0-7]*' AND substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (length(site_id) = 30 AND site_id GLOB 'ste_[0-7]*'
         AND substr(site_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (length(page_key) BETWEEN 2 AND 64 AND page_key NOT GLOB '*[^a-z0-9_-]*'),
  -- Composite parent key for `page_translations`. Architecture §5.4 adopted composite FKs over
  -- triggers for cross-tenant integrity: the engine enforces this on every write and there is no
  -- trigger to forget, disable or bypass with a deferred batch.
  UNIQUE (id, site_version_id)
) STRICT;

CREATE UNIQUE INDEX uq_pages_key ON pages(site_version_id, page_key);
-- `sort_order` ahead of `nav_group` serves BOTH "every page of this version in order" (editor,
-- sitemap) and "the primary nav" (render) from one index instead of two.
CREATE INDEX idx_pages_version_order ON pages(site_version_id, sort_order, nav_group, page_key, role);
CREATE INDEX idx_pages_site ON pages(site_id, site_version_id);

-- One row per (page, locale). A build-time projection of `SiteDoc.pages[].perLocale`.
--
-- `content_inline` is deliberately ABSENT (architecture §5.4). The rule "page component trees
-- always go to R2 regardless of size" made the inline branch dead code — confirmed by 28,800 rows
-- of the sizing database containing zero inline values — and an inline column of up to 64 KB is one
-- careless `CREATE INDEX` away from duplicating the entire page payload into a b-tree, because
-- SQLite stores the full key in every index entry. The pointer is therefore NOT NULL.
CREATE TABLE page_translations (
  id               TEXT PRIMARY KEY,
  page_id          TEXT NOT NULL,
  -- Denormalised so the sitemap and hreflang builders resolve a whole version with zero joins.
  -- Its integrity is the composite FK below, not a comment and not a trigger.
  site_version_id  TEXT NOT NULL,
  locale           TEXT NOT NULL,
  -- Full path including the locale segment: '/nl/over-ons/'.
  path             TEXT NOT NULL,
  -- Last path segment, stored so "the slug the customer already has wins on regeneration" is a
  -- direct read on (page_key, locale) instead of string surgery on `path`. Empty for the home page.
  slug             TEXT NOT NULL,
  title            TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  meta_description TEXT CHECK (meta_description IS NULL OR length(meta_description) <= 320),
  og_media_id      TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  -- Built by code from D1 facts plus the model's typed `jsonLdInputs`; the model never authors it
  -- (§4 invariant 4).
  jsonld           TEXT CHECK (jsonld IS NULL OR
                     (json_valid(jsonld) AND length(jsonld) <= 16384)),
  -- The component tree, always in R2. RESTRICT: a blob may not be deleted while a page points at
  -- it, which is the first half of the GC story; the refcount triggers in 0006 are the second.
  content_sha256   BLOB NOT NULL REFERENCES content_blobs(sha256) ON DELETE RESTRICT,
  content_bytes    INTEGER NOT NULL DEFAULT 0 CHECK (content_bytes >= 0),
  -- Hash of the CANONICAL SEMANTIC PROJECTION of the rendered page (packages/core/src/lastmod.ts).
  -- `content_changed_at` only moves when this moves, which is what stops a rebuild with an
  -- identical result from lying to Google about `lastmod`.
  render_sha256    BLOB CHECK (render_sha256 IS NULL OR length(render_sha256) = 32),
  content_changed_at INTEGER NOT NULL,
  translation_source TEXT NOT NULL DEFAULT 'ai'
                     CHECK (translation_source IN ('ai','human','machine','copied')),
  is_stale         INTEGER NOT NULL DEFAULT 0 CHECK (is_stale IN (0,1)),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK (length(id) = 30 AND id GLOB 'ptr_[0-7]*' AND substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (locale GLOB '[a-z][a-z]' OR locale GLOB '[a-z][a-z]-[A-Z][A-Z]'),
  CHECK (length(path) BETWEEN 1 AND 512
         AND path GLOB '/*'
         AND path = lower(path)
         AND path NOT GLOB '*[^a-z0-9/_.-]*'
         AND path NOT GLOB '*//*'),
  CHECK (slug = '' OR (length(slug) BETWEEN 1 AND 96
                       AND slug NOT GLOB '*[^a-z0-9-]*'
                       AND slug GLOB '[a-z0-9]*'
                       AND slug NOT GLOB '*-')),
  CHECK (length(content_sha256) = 32),
  -- Cross-tenant integrity, enforced by the engine on every write. A page translation can only
  -- ever belong to a page in the SAME version, so there is no path by which one tenant's
  -- translation attaches to another tenant's page.
  FOREIGN KEY (page_id, site_version_id) REFERENCES pages(id, site_version_id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX uq_page_tr_locale ON page_translations(page_id, locale);
-- No two pages may collide on a URL within a version, across ALL locales.
CREATE UNIQUE INDEX uq_page_tr_path   ON page_translations(site_version_id, path);
-- Enumeration: sitemap.xml, "every page in locale X", locale-completeness checks. Deliberately
-- narrow — the single-page lookup uses the UNIQUE seek above, which is strictly cheaper than any
-- covering index could be.
CREATE INDEX idx_page_tr_enumerate ON page_translations(site_version_id, locale, path, page_id);
-- hreflang cluster: every sibling locale of one page in one seek plus a short scan.
CREATE INDEX idx_page_tr_hreflang  ON page_translations(page_id, locale, path);
CREATE INDEX idx_page_tr_blob      ON page_translations(content_sha256);
CREATE INDEX idx_page_tr_stale     ON page_translations(site_version_id, locale) WHERE is_stale = 1;
-- FK child index for `media_assets` deletes; see the note in migrations/cp/0001_identity.sql.
-- Partial, because this column is NULL on almost every row.
CREATE INDEX idx_page_tr_og_media  ON page_translations(og_media_id) WHERE og_media_id IS NOT NULL;

-- Retired paths -> 301 forever. Keyed on the SITE and the locale, not on a version: a redirect
-- must outlive the version that retired it, which is precisely why `page_key` exists.
CREATE TABLE page_slug_aliases (
  id         TEXT PRIMARY KEY,
  site_id    TEXT NOT NULL,
  page_key   TEXT NOT NULL,
  locale     TEXT NOT NULL,
  old_path   TEXT NOT NULL,
  -- Resolved at publish, never chained: A->B then B->C is rewritten to A->C, because a redirect
  -- chain costs a round trip per hop and Google stops following after five.
  new_path   TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT 'regeneration'
               CHECK (reason IN ('regeneration','manual_rename','locale_change','merge')),
  created_at INTEGER NOT NULL,
  CHECK (length(id) = 30 AND id GLOB 'psa_[0-7]*' AND substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (length(site_id) = 30 AND site_id GLOB 'ste_[0-7]*'
         AND substr(site_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (locale GLOB '[a-z][a-z]' OR locale GLOB '[a-z][a-z]-[A-Z][A-Z]'),
  CHECK (length(page_key) BETWEEN 2 AND 64 AND page_key NOT GLOB '*[^a-z0-9_-]*'),
  CHECK (length(old_path) BETWEEN 1 AND 512 AND old_path GLOB '/*' AND old_path = lower(old_path)
         AND old_path NOT GLOB '*[^a-z0-9/_.-]*'),
  CHECK (length(new_path) BETWEEN 1 AND 512 AND new_path GLOB '/*' AND new_path = lower(new_path)
         AND new_path NOT GLOB '*[^a-z0-9/_.-]*'),
  CHECK (old_path <> new_path)
) STRICT;

-- One destination per retired path, and the lookup the renderer's 404 fallback performs.
CREATE UNIQUE INDEX uq_page_aliases_old ON page_slug_aliases(site_id, old_path);
CREATE INDEX idx_page_aliases_key ON page_slug_aliases(site_id, page_key, locale);
