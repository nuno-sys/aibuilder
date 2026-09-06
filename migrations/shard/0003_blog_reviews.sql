-- ============================================================================================
-- migrations/shard/0003_blog_reviews.sql     database: aibuilder-shard-NNN
--
-- PURPOSE
--   Blog posts and their per-locale translations — the same version-scoped, composite-FK shape as
--   `pages` / `page_translations` in 0001, for the same reason — plus the review table, which is
--   the one place in this schema where a CHECK constraint is a legal control rather than a data
--   hygiene one.
--
-- MIGRATION RULE (architecture §5.4). A cascade-parent table can NEVER be rebuilt in place on D1:
--   `PRAGMA foreign_keys=OFF` is unsupported there, `defer_foreign_keys` defers constraint
--   *checking* and not FK *actions*, and a 12-step rebuild therefore cascade-deletes every child
--   row while `foreign_key_check` still passes. Expand -> migrate -> contract with
--   `ALTER TABLE ADD/DROP/RENAME COLUMN` only. `blog_posts` is a cascade parent.
-- ============================================================================================

CREATE TABLE blog_posts (
  id              TEXT PRIMARY KEY,
  site_id         TEXT NOT NULL,
  site_version_id TEXT NOT NULL REFERENCES site_versions(id) ON DELETE CASCADE,
  -- Stable across regenerations, exactly like `pages.page_key`: it is what lets a regenerated post
  -- keep the URL, the backlinks and the `content_changed_at` history it already earned.
  post_key        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','scheduled','published','archived')),
  cover_media_id  TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  author_name     TEXT CHECK (author_name IS NULL OR length(author_name) BETWEEN 1 AND 120),
  origin          TEXT NOT NULL DEFAULT 'ai' CHECK (origin IN ('ai','human')),
  published_at    INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  CHECK (length(id) = 30 AND id GLOB 'blp_[0-7]*' AND substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (length(site_id) = 30 AND site_id GLOB 'ste_[0-7]*'
         AND substr(site_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (length(post_key) BETWEEN 2 AND 96 AND post_key NOT GLOB '*[^a-z0-9_-]*'),
  CHECK (status <> 'published' OR published_at IS NOT NULL),
  CHECK (status <> 'scheduled' OR published_at IS NOT NULL),
  -- Composite parent key for `blog_post_translations`; see the note on `pages` in 0001.
  UNIQUE (id, site_version_id)
) STRICT;

CREATE UNIQUE INDEX uq_blog_key  ON blog_posts(site_version_id, post_key);
CREATE INDEX idx_blog_published  ON blog_posts(site_version_id, published_at DESC)
  WHERE status = 'published';
CREATE INDEX idx_blog_scheduled  ON blog_posts(published_at) WHERE status = 'scheduled';
CREATE INDEX idx_blog_site       ON blog_posts(site_id, site_version_id);
-- FK child index for `media_assets` deletes.
CREATE INDEX idx_blog_cover      ON blog_posts(cover_media_id) WHERE cover_media_id IS NOT NULL;

-- Same pointer rule as `page_translations`: the body is ALWAYS in R2, never inline. A 1,200-word
-- post is only ~8 KB, but "sometimes inline" means two read paths, two GC stories and an index that
-- someone will eventually widen to cover the payload.
CREATE TABLE blog_post_translations (
  id               TEXT PRIMARY KEY,
  post_id          TEXT NOT NULL,
  site_version_id  TEXT NOT NULL,
  locale           TEXT NOT NULL,
  slug             TEXT NOT NULL,
  path             TEXT NOT NULL,
  title            TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  excerpt          TEXT CHECK (excerpt IS NULL OR length(excerpt) <= 500),
  meta_description TEXT CHECK (meta_description IS NULL OR length(meta_description) <= 320),
  reading_minutes  INTEGER CHECK (reading_minutes IS NULL OR reading_minutes BETWEEN 1 AND 240),
  body_sha256      BLOB NOT NULL REFERENCES content_blobs(sha256) ON DELETE RESTRICT,
  body_bytes       INTEGER NOT NULL DEFAULT 0 CHECK (body_bytes >= 0),
  render_sha256    BLOB CHECK (render_sha256 IS NULL OR length(render_sha256) = 32),
  content_changed_at INTEGER NOT NULL,
  translation_source TEXT NOT NULL DEFAULT 'ai'
                     CHECK (translation_source IN ('ai','human','machine','copied')),
  is_stale         INTEGER NOT NULL DEFAULT 0 CHECK (is_stale IN (0,1)),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK (length(id) = 30 AND id GLOB 'bpt_[0-7]*' AND substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (locale GLOB '[a-z][a-z]' OR locale GLOB '[a-z][a-z]-[A-Z][A-Z]'),
  CHECK (length(slug) BETWEEN 1 AND 96 AND slug NOT GLOB '*[^a-z0-9-]*'
         AND slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*-'),
  CHECK (length(path) BETWEEN 1 AND 512 AND path GLOB '/*' AND path = lower(path)
         AND path NOT GLOB '*[^a-z0-9/_.-]*' AND path NOT GLOB '*//*'),
  CHECK (length(body_sha256) = 32),
  FOREIGN KEY (post_id, site_version_id)
    REFERENCES blog_posts(id, site_version_id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX uq_blog_tr_locale ON blog_post_translations(post_id, locale);
CREATE UNIQUE INDEX uq_blog_tr_path   ON blog_post_translations(site_version_id, path);
-- Covering: the blog index page for one locale renders straight out of this index.
CREATE INDEX idx_blog_tr_list ON blog_post_translations(
  site_version_id, locale, path, title, excerpt, post_id);
CREATE INDEX idx_blog_tr_blob  ON blog_post_translations(body_sha256);
CREATE INDEX idx_blog_tr_stale ON blog_post_translations(site_version_id, locale) WHERE is_stale = 1;

-- Customer reviews.
--
-- `reviews_source` gating is a LEGAL control, not data hygiene. Publishing an invented testimonial
-- under a real business's name is a misleading-commercial-practice offence across the EU (UCPD
-- Annex I) and an impersonation of the named reviewer. So there is no `ai_placeholder` source, and
-- the CHECK below refuses to make a third-party review visible until it has been verified against
-- the platform it claims to come from. A review the customer typed in themselves is `manual` and is
-- their own statement to make.
CREATE TABLE site_reviews (
  id               TEXT PRIMARY KEY,
  site_id          TEXT NOT NULL,
  platform         TEXT NOT NULL DEFAULT 'manual'
                     CHECK (platform IN ('manual','google','facebook','trustpilot','tripadvisor','yelp')),
  -- The review's id on that platform. Together with `platform` it is what makes a re-import
  -- idempotent instead of duplicating every review on every sync.
  external_id      TEXT CHECK (external_id IS NULL OR length(external_id) <= 200),
  -- Non-NULL means: we fetched this review from `platform` and it matched. Set by the importer,
  -- never by a human form and never by the model.
  verified_at      INTEGER,
  author_name      TEXT NOT NULL CHECK (length(author_name) BETWEEN 1 AND 120),
  author_photo_url TEXT CHECK (author_photo_url IS NULL OR length(author_photo_url) <= 1000),
  rating           INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body             TEXT CHECK (body IS NULL OR length(body) <= 4000),
  locale           TEXT CHECK (locale IS NULL OR
                     locale GLOB '[a-z][a-z]' OR locale GLOB '[a-z][a-z]-[A-Z][A-Z]'),
  reviewed_at      INTEGER,
  is_visible       INTEGER NOT NULL DEFAULT 0 CHECK (is_visible IN (0,1)),
  sort_order       INTEGER NOT NULL DEFAULT 100,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK (length(id) = 30 AND id GLOB 'rev_[0-7]*' AND substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (length(site_id) = 30 AND site_id GLOB 'ste_[0-7]*'
         AND substr(site_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (platform = 'manual' OR external_id IS NOT NULL),
  -- The gate.
  CHECK (is_visible = 0 OR platform = 'manual' OR verified_at IS NOT NULL)
) STRICT;

CREATE INDEX idx_reviews_site ON site_reviews(site_id, sort_order, reviewed_at DESC)
  WHERE is_visible = 1;
CREATE UNIQUE INDEX uq_reviews_external ON site_reviews(site_id, platform, external_id)
  WHERE external_id IS NOT NULL;
