-- 0008_triggers.sql
-- Triggers live in their OWN migration on purpose: wrangler's SQL statement splitter has a
-- known failure on trigger bodies ("incomplete input") because it breaks on BEGIN. Keeping
-- them isolated means a splitter bug can never block a schema migration. Always uppercase
-- BEGIN / END here - lowercase 'begin' is the reported trigger of that bug.

-- ---------------------------------------------------------------------------
-- 1. IMMUTABILITY of sealed site versions.
--    D1 has no stored procedures, so this invariant has to be a trigger or it is
--    only a comment. 'IS NOT' is SQLite's NULL-safe inequality.
--    Lifecycle columns (status, label, updated_at) stay mutable so a published
--    version can still be archived; content columns are frozen.
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_site_versions_sealed
BEFORE UPDATE ON site_versions
FOR EACH ROW
WHEN OLD.sealed_at IS NOT NULL
 AND (NEW.manifest_sha256 IS NOT OLD.manifest_sha256
   OR NEW.bundle_sha256   IS NOT OLD.bundle_sha256
   OR NEW.theme_tokens    IS NOT OLD.theme_tokens
   OR NEW.features        IS NOT OLD.features
   OR NEW.version_no      IS NOT OLD.version_no
   OR NEW.site_id         IS NOT OLD.site_id
   OR NEW.origin          IS NOT OLD.origin
   OR NEW.sealed_at       IS NOT OLD.sealed_at)
BEGIN
  SELECT RAISE(ABORT, 'site_version is sealed: fork a new version instead');
END;

CREATE TRIGGER trg_page_tr_sealed_update
BEFORE UPDATE ON page_translations
FOR EACH ROW
WHEN (SELECT sealed_at FROM site_versions WHERE id = OLD.site_version_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'page_translation belongs to a sealed site_version');
END;

CREATE TRIGGER trg_page_tr_sealed_insert
BEFORE INSERT ON page_translations
FOR EACH ROW
WHEN (SELECT sealed_at FROM site_versions WHERE id = NEW.site_version_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'cannot add pages to a sealed site_version');
END;

CREATE TRIGGER trg_pages_sealed_update
BEFORE UPDATE ON pages
FOR EACH ROW
WHEN (SELECT sealed_at FROM site_versions WHERE id = OLD.site_version_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'page belongs to a sealed site_version');
END;

-- ---------------------------------------------------------------------------
-- 2. content_blobs refcounting -> drives the R2 garbage collector.
--    Note these also fire for rows removed by ON DELETE CASCADE, which is exactly
--    what we want when a whole site_version is dropped.
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_blob_ref_page_ins
AFTER INSERT ON page_translations
FOR EACH ROW WHEN NEW.content_sha256 IS NOT NULL
BEGIN
  UPDATE content_blobs
     SET refcount = refcount + 1, last_ref_at = NEW.created_at
   WHERE sha256 = NEW.content_sha256;
END;

CREATE TRIGGER trg_blob_ref_page_del
AFTER DELETE ON page_translations
FOR EACH ROW WHEN OLD.content_sha256 IS NOT NULL
BEGIN
  UPDATE content_blobs
     SET refcount = max(refcount - 1, 0)
   WHERE sha256 = OLD.content_sha256;
END;

CREATE TRIGGER trg_blob_ref_blog_ins
AFTER INSERT ON blog_post_translations
FOR EACH ROW WHEN NEW.body_sha256 IS NOT NULL
BEGIN
  UPDATE content_blobs
     SET refcount = refcount + 1, last_ref_at = NEW.created_at
   WHERE sha256 = NEW.body_sha256;
END;

CREATE TRIGGER trg_blob_ref_blog_del
AFTER DELETE ON blog_post_translations
FOR EACH ROW WHEN OLD.body_sha256 IS NOT NULL
BEGIN
  UPDATE content_blobs
     SET refcount = max(refcount - 1, 0)
   WHERE sha256 = OLD.body_sha256;
END;

-- ---------------------------------------------------------------------------
-- 3. A site's published/draft version must belong to that same site.
--    Cross-tenant version pointer = catastrophic data leak. Cheap to make impossible.
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_sites_version_ownership
BEFORE UPDATE OF published_version_id, draft_version_id ON sites
FOR EACH ROW
WHEN (NEW.published_version_id IS NOT NULL
      AND (SELECT site_id FROM site_versions WHERE id = NEW.published_version_id) IS NOT NEW.id)
  OR (NEW.draft_version_id IS NOT NULL
      AND (SELECT site_id FROM site_versions WHERE id = NEW.draft_version_id) IS NOT NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'version pointer references a different site');
END;
