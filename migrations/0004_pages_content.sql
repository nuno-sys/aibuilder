-- 0004_pages_content.sql
-- THE LOCALE MODEL. There is not one locale-named column anywhere in this schema.
--   pages              = the logical page (locale-INDEPENDENT)
--   page_translations  = one row per (page, locale)
-- Adding Italian to a live site:
--   INSERT INTO locales(code,...) VALUES ('it',...);            -- once, globally
--   INSERT INTO site_locales(site_id,'it',...);                 -- once per site
--   INSERT INTO page_translations(...) x N pages;               -- one per page
-- No ALTER TABLE. No migration. No deploy.

CREATE TABLE pages (
  id               TEXT PRIMARY KEY,
  site_version_id  TEXT NOT NULL REFERENCES site_versions(id) ON DELETE CASCADE,
  -- Denormalised so org-scoped authorisation and per-site queries skip the version join.
  site_id          TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  page_key         TEXT NOT NULL,     -- stable logical id, survives rename/translation
  page_type        TEXT NOT NULL CHECK (page_type IN
                     ('home','about','services','contact','menu','gallery','booking',
                      'blog_index','blog_post','legal','custom')),
  template         TEXT NOT NULL DEFAULT 'default',
  nav_group        TEXT NOT NULL DEFAULT 'primary'
                     CHECK (nav_group IN ('primary','footer','utility','none')),
  sort_order       INTEGER NOT NULL DEFAULT 100,
  is_indexable     INTEGER NOT NULL DEFAULT 1 CHECK (is_indexable IN (0,1)),
  sitemap_priority REAL NOT NULL DEFAULT 0.5 CHECK (sitemap_priority BETWEEN 0.0 AND 1.0),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK (id GLOB 'pag_[0-7]*' AND length(id) = 30),
  CHECK (page_key NOT GLOB '*[^a-z0-9_]*' AND length(page_key) BETWEEN 2 AND 64)
) STRICT;

CREATE UNIQUE INDEX uq_pages_key      ON pages(site_version_id, page_key);
-- sort_order ahead of nav_group: serves both "load every page of this version in order"
-- (editor) and "the primary nav" (render) from ONE index instead of two.
CREATE INDEX idx_pages_version_order  ON pages(site_version_id, sort_order, nav_group, page_key, page_type);
CREATE INDEX idx_pages_site           ON pages(site_id, site_version_id);

CREATE TABLE page_translations (
  id               TEXT PRIMARY KEY,
  page_id          TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  -- Denormalised: the public render path resolves (version, locale, path) with ZERO joins.
  site_version_id  TEXT NOT NULL REFERENCES site_versions(id) ON DELETE CASCADE,
  locale           TEXT NOT NULL REFERENCES locales(code) ON DELETE RESTRICT,
  path             TEXT NOT NULL,     -- full path incl. locale segment: '/nl/over-ons'
  title            TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  meta_description TEXT CHECK (meta_description IS NULL OR length(meta_description) <= 320),
  og_image_id      TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  jsonld           TEXT CHECK (jsonld IS NULL OR
                     (json_valid(jsonld) AND length(jsonld) <= 16384)),   -- LocalBusiness schema

  -- ------------------- THE POINTER PATTERN, ENFORCED BY THE DATABASE -------------------
  -- Component tree lives in R2 at blobs/page_tree/<sha[0:2]>/<sha[2:4]>/<sha>.json.gz
  -- Exactly one of content_sha256 / content_inline is non-NULL. Not "by convention" - by CHECK.
  content_sha256   TEXT REFERENCES content_blobs(sha256) ON DELETE RESTRICT,
  content_inline   TEXT,
  content_bytes    INTEGER NOT NULL DEFAULT 0 CHECK (content_bytes >= 0),
  -- ------------------------------------------------------------------------------------

  translation_source TEXT NOT NULL DEFAULT 'ai'
                       CHECK (translation_source IN ('ai','human','machine','copied')),
  is_stale         INTEGER NOT NULL DEFAULT 0 CHECK (is_stale IN (0,1)),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK (id GLOB 'ptr_[0-7]*' AND length(id) = 30),
  CHECK (path GLOB '/*' AND path = lower(path) AND length(path) <= 512
         AND path NOT GLOB '*[^a-z0-9/_.-]*'),
  CHECK ((content_sha256 IS NULL) <> (content_inline IS NULL)),
  CHECK (content_inline IS NULL OR
         (json_valid(content_inline) AND length(content_inline) <= 65536)),  -- 64 KB threshold
  CHECK (content_sha256 IS NULL OR
         (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'))
) STRICT;

CREATE UNIQUE INDEX uq_page_tr_locale ON page_translations(page_id, locale);
-- No two pages may collide on a URL within a version, across ALL locales.
CREATE UNIQUE INDEX uq_page_tr_path   ON page_translations(site_version_id, path);
-- Enumeration index: sitemap.xml, "every page in locale X", locale-completeness checks.
-- Deliberately NARROW. content_inline is up to 64 KB and must NEVER appear in an index -
-- SQLite stores the full key in every index entry, so including it would duplicate the
-- entire page payload into the b-tree. The single-page render lookup does not need this
-- index at all: uq_page_tr_path is a UNIQUE (site_version_id, path) point seek, which is
-- strictly cheaper than any covering index could be.
CREATE INDEX idx_page_tr_enumerate ON page_translations(site_version_id, locale, path, page_id);
-- hreflang cluster: all sibling locales of one page, one seek + short scan.
CREATE INDEX idx_page_tr_hreflang ON page_translations(page_id, locale, path);
CREATE INDEX idx_page_tr_blob     ON page_translations(content_sha256) WHERE content_sha256 IS NOT NULL;
CREATE INDEX idx_page_tr_stale    ON page_translations(site_version_id, locale) WHERE is_stale = 1;

CREATE TABLE blog_posts (
  id              TEXT PRIMARY KEY,
  site_id         TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  site_version_id TEXT NOT NULL REFERENCES site_versions(id) ON DELETE CASCADE,
  post_key        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','scheduled','published','archived')),
  cover_media_id  TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  author_name     TEXT,
  origin          TEXT NOT NULL DEFAULT 'ai' CHECK (origin IN ('ai','human')),
  published_at    INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  CHECK (id GLOB 'pst_[0-7]*' AND length(id) = 30),
  CHECK (post_key NOT GLOB '*[^a-z0-9_-]*'),
  CHECK (status <> 'published' OR published_at IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX uq_blog_key       ON blog_posts(site_version_id, post_key);
CREATE INDEX idx_blog_published       ON blog_posts(site_version_id, published_at DESC)
  WHERE status = 'published';
CREATE INDEX idx_blog_scheduled       ON blog_posts(published_at) WHERE status = 'scheduled';

CREATE TABLE blog_post_translations (
  id               TEXT PRIMARY KEY,
  post_id          TEXT NOT NULL REFERENCES blog_posts(id) ON DELETE CASCADE,
  site_version_id  TEXT NOT NULL REFERENCES site_versions(id) ON DELETE CASCADE,
  locale           TEXT NOT NULL REFERENCES locales(code) ON DELETE RESTRICT,
  slug             TEXT NOT NULL,
  path             TEXT NOT NULL,
  title            TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  excerpt          TEXT CHECK (excerpt IS NULL OR length(excerpt) <= 500),
  meta_description TEXT CHECK (meta_description IS NULL OR length(meta_description) <= 320),
  reading_minutes  INTEGER CHECK (reading_minutes IS NULL OR reading_minutes > 0),
  -- Same pointer pattern. A 1200-word AI post is ~8 KB -> usually inline; long-form goes to R2.
  body_sha256      TEXT REFERENCES content_blobs(sha256) ON DELETE RESTRICT,
  body_inline      TEXT,
  body_bytes       INTEGER NOT NULL DEFAULT 0 CHECK (body_bytes >= 0),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK (id GLOB 'pts_[0-7]*' AND length(id) = 30),
  CHECK ((body_sha256 IS NULL) <> (body_inline IS NULL)),
  CHECK (body_inline IS NULL OR length(body_inline) <= 65536),
  CHECK (body_sha256 IS NULL OR
         (length(body_sha256) = 64 AND body_sha256 NOT GLOB '*[^0-9a-f]*')),
  CHECK (path GLOB '/*' AND path = lower(path) AND length(path) <= 512),
  CHECK (slug NOT GLOB '*[^a-z0-9-]*')
) STRICT;

CREATE UNIQUE INDEX uq_blog_tr_locale ON blog_post_translations(post_id, locale);
CREATE UNIQUE INDEX uq_blog_tr_path   ON blog_post_translations(site_version_id, path);
CREATE INDEX idx_blog_tr_list ON blog_post_translations(
  site_version_id, locale, path, title, excerpt, post_id);

CREATE TABLE site_reviews (
  id          TEXT PRIMARY KEY,
  site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  source      TEXT NOT NULL DEFAULT 'manual'
                CHECK (source IN ('manual','google','facebook','trustpilot','ai_placeholder')),
  source_ref  TEXT,
  author_name TEXT NOT NULL,
  author_photo_url TEXT,
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body        TEXT CHECK (body IS NULL OR length(body) <= 4000),
  locale      TEXT REFERENCES locales(code) ON DELETE SET NULL,
  reviewed_at INTEGER,
  is_visible  INTEGER NOT NULL DEFAULT 1 CHECK (is_visible IN (0,1)),
  sort_order  INTEGER NOT NULL DEFAULT 100,
  created_at  INTEGER NOT NULL,
  CHECK (id GLOB 'rev_[0-7]*' AND length(id) = 30)
) STRICT;

CREATE INDEX idx_reviews_site ON site_reviews(site_id, sort_order, reviewed_at DESC)
  WHERE is_visible = 1;
CREATE UNIQUE INDEX uq_reviews_source ON site_reviews(site_id, source, source_ref)
  WHERE source_ref IS NOT NULL;
