-- ============================================================================================
-- migrations/shard/0006_triggers.sql         database: aibuilder-shard-NNN
--
-- PURPOSE
--   The three shard invariants that cannot be expressed as constraints: version sealing, blob
--   refcounting, and the denormalised-ownership check that the composite foreign keys in 0001 do
--   not cover. D1 has no stored procedures, so each of these is either a trigger or it is only a
--   comment in a design document.
--
--   Triggers live in their own migration on purpose: wrangler's SQL statement splitter has a known
--   failure on trigger bodies (it breaks on `BEGIN` and reports "incomplete input"). Isolated here,
--   a splitter bug can never block a schema migration. `BEGIN` and `END` are always uppercase —
--   lowercase is the reported trigger of that bug.
--
-- MIGRATION RULE (architecture §5.4). A cascade-parent table can NEVER be rebuilt in place on D1:
--   `PRAGMA foreign_keys=OFF` is unsupported there, `defer_foreign_keys` defers constraint
--   *checking* rather than FK *actions*, and the 12-step rebuild therefore cascade-deletes every
--   child row while `foreign_key_check` still passes. Expand -> migrate -> contract, with only
--   `ALTER TABLE ADD/DROP/RENAME COLUMN`. Dropping and recreating a TRIGGER is safe and is the
--   normal way to change one; triggers are not tables.
--
-- CLOCK
--   The refcount triggers stamp `last_ref_at` with `unixepoch() * 1000` rather than with the
--   row's own timestamp, so every mutation to a blob's refcount is measured on ONE clock. The
--   reaper's grace window is hours long, so second granularity is not a limitation, and a single
--   clock means `last_ref_at` can never move backwards between an insert stamped by a Worker and a
--   delete stamped by a cron.
-- ============================================================================================

-- --------------------------------------------------------------------------------------------
-- 1. SEALING. A sealed version is frozen; a published version is always sealed.
--
--    `IS NOT` is SQLite's NULL-safe inequality. Lifecycle columns (`status`, `label`, `updated_at`,
--    `quality_state`, `quality_report`) stay mutable so a published version can still be archived
--    and so the quality gate can record a late verdict; the content columns are frozen.
-- --------------------------------------------------------------------------------------------
CREATE TRIGGER trg_site_versions_frozen
BEFORE UPDATE ON site_versions
FOR EACH ROW
WHEN OLD.sealed_at IS NOT NULL
 AND (NEW.site_id           IS NOT OLD.site_id
   OR NEW.org_id            IS NOT OLD.org_id
   OR NEW.version_no        IS NOT OLD.version_no
   OR NEW.parent_version_id IS NOT OLD.parent_version_id
   OR NEW.origin            IS NOT OLD.origin
   OR NEW.schema_version    IS NOT OLD.schema_version
   OR NEW.theme_tokens      IS NOT OLD.theme_tokens
   OR NEW.features          IS NOT OLD.features
   OR NEW.manifest_sha256   IS NOT OLD.manifest_sha256
   OR NEW.manifest_bytes    IS NOT OLD.manifest_bytes
   OR NEW.bundle_sha256     IS NOT OLD.bundle_sha256
   OR NEW.bundle_bytes      IS NOT OLD.bundle_bytes)
BEGIN
  SELECT RAISE(ABORT, 'site_version is sealed: fork a new version instead');
END;

-- Unsealing is the ONLY way to retire a version, and it is allowed only while archived. That is
-- what makes the delete guards below meaningful: the purge job must first move the version to
-- `archived` (a legal status transition on a sealed row), then unseal it, and only then delete.
-- Without this rule the whole sealing story is one `UPDATE … SET sealed_at = NULL` away from
-- nothing.
CREATE TRIGGER trg_site_versions_unseal
BEFORE UPDATE OF sealed_at ON site_versions
FOR EACH ROW
WHEN OLD.sealed_at IS NOT NULL
 AND NEW.sealed_at IS NOT OLD.sealed_at
 AND NOT (NEW.sealed_at IS NULL AND OLD.status = 'archived' AND NEW.status = 'archived')
BEGIN
  SELECT RAISE(ABORT, 'a sealed version may only be unsealed while archived, by the purge job');
END;

-- Deleting a sealed published version was silently unpublishing a paying customer's site through
-- `sites.published_version_id ON DELETE SET NULL` *and* freeing all of its blobs for GC. Version
-- retirement is a status transition, never a DELETE.
CREATE TRIGGER trg_site_versions_no_delete_published
BEFORE DELETE ON site_versions
FOR EACH ROW
WHEN OLD.sealed_at IS NOT NULL AND OLD.status = 'published'
BEGIN
  SELECT RAISE(ABORT, 'cannot delete a sealed published version: archive it first');
END;

-- The four page-level seal guards. INSERT and DELETE were both missing from the original design:
-- without them a sealed version could gain a page or lose one, which is the same thing as it not
-- being sealed.
--
-- These guard DIRECT writes. A whole-version teardown enters through `site_versions` and is gated
-- there, and by then the parent row is gone so the subqueries below correctly find nothing.
CREATE TRIGGER trg_pages_sealed_ins
BEFORE INSERT ON pages
FOR EACH ROW
WHEN (SELECT sealed_at FROM site_versions WHERE id = NEW.site_version_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'cannot add a page to a sealed site_version');
END;

CREATE TRIGGER trg_pages_sealed_upd
BEFORE UPDATE ON pages
FOR EACH ROW
WHEN (SELECT sealed_at FROM site_versions WHERE id = OLD.site_version_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'page belongs to a sealed site_version');
END;

CREATE TRIGGER trg_pages_sealed_del
BEFORE DELETE ON pages
FOR EACH ROW
WHEN (SELECT sealed_at FROM site_versions WHERE id = OLD.site_version_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'cannot remove a page from a sealed site_version');
END;

CREATE TRIGGER trg_page_tr_sealed_ins
BEFORE INSERT ON page_translations
FOR EACH ROW
WHEN (SELECT sealed_at FROM site_versions WHERE id = NEW.site_version_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'cannot add a translation to a sealed site_version');
END;

CREATE TRIGGER trg_page_tr_sealed_upd
BEFORE UPDATE ON page_translations
FOR EACH ROW
WHEN (SELECT sealed_at FROM site_versions WHERE id = OLD.site_version_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'page_translation belongs to a sealed site_version');
END;

CREATE TRIGGER trg_page_tr_sealed_del
BEFORE DELETE ON page_translations
FOR EACH ROW
WHEN (SELECT sealed_at FROM site_versions WHERE id = OLD.site_version_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'cannot remove a translation from a sealed site_version');
END;

-- --------------------------------------------------------------------------------------------
-- 2. content_blobs REFCOUNTING. This was a live data-loss bug, not a tidiness issue.
--
--    The original design had INSERT and DELETE triggers but no UPDATE pair, so an editor save that
--    repointed `content_sha256` from A to B left A at refcount 1 and B at 0 — and the reaper then
--    deleted B, a live R2 object, while keeping A, a dead one. The `AFTER UPDATE OF` pair below is
--    the fix; it is split into a decrement trigger and an increment trigger because a trigger's
--    `WHEN` clause applies to the whole body, and the two sides have different null guards.
--
--    There is no `max(refcount - 1, 0)` clamp anywhere. `CHECK (refcount >= 0)` on the column means
--    a double-decrement ABORTS the transaction rather than silently drifting toward deleting
--    somebody's live homepage. Loud is the point.
--
--    The increment side RESURRECTS a tombstoned blob (`state = 'live'`, `tombstoned_at = NULL`).
--    Without that, a dedupe hit landing between the reaper's mark phase and its sweep phase would
--    point a brand-new page at an object that is about to be deleted.
--
--    These triggers also fire for rows removed by `ON DELETE CASCADE`, which is exactly what is
--    wanted when a whole version is torn down.
-- --------------------------------------------------------------------------------------------
CREATE TRIGGER trg_blob_ref_page_ins
AFTER INSERT ON page_translations
FOR EACH ROW
BEGIN
  UPDATE content_blobs
     SET refcount      = refcount + 1,
         last_ref_at   = unixepoch() * 1000,
         state         = 'live',
         tombstoned_at = NULL
   WHERE sha256 = NEW.content_sha256;
END;

CREATE TRIGGER trg_blob_ref_page_del
AFTER DELETE ON page_translations
FOR EACH ROW
BEGIN
  UPDATE content_blobs
     SET refcount    = refcount - 1,
         last_ref_at = unixepoch() * 1000
   WHERE sha256 = OLD.content_sha256;
END;

CREATE TRIGGER trg_blob_ref_page_upd_dec
AFTER UPDATE OF content_sha256 ON page_translations
FOR EACH ROW
WHEN NEW.content_sha256 IS NOT OLD.content_sha256
BEGIN
  UPDATE content_blobs
     SET refcount    = refcount - 1,
         last_ref_at = unixepoch() * 1000
   WHERE sha256 = OLD.content_sha256;
END;

CREATE TRIGGER trg_blob_ref_page_upd_inc
AFTER UPDATE OF content_sha256 ON page_translations
FOR EACH ROW
WHEN NEW.content_sha256 IS NOT OLD.content_sha256
BEGIN
  UPDATE content_blobs
     SET refcount      = refcount + 1,
         last_ref_at   = unixepoch() * 1000,
         state         = 'live',
         tombstoned_at = NULL
   WHERE sha256 = NEW.content_sha256;
END;

CREATE TRIGGER trg_blob_ref_blog_ins
AFTER INSERT ON blog_post_translations
FOR EACH ROW
BEGIN
  UPDATE content_blobs
     SET refcount      = refcount + 1,
         last_ref_at   = unixepoch() * 1000,
         state         = 'live',
         tombstoned_at = NULL
   WHERE sha256 = NEW.body_sha256;
END;

CREATE TRIGGER trg_blob_ref_blog_del
AFTER DELETE ON blog_post_translations
FOR EACH ROW
BEGIN
  UPDATE content_blobs
     SET refcount    = refcount - 1,
         last_ref_at = unixepoch() * 1000
   WHERE sha256 = OLD.body_sha256;
END;

CREATE TRIGGER trg_blob_ref_blog_upd_dec
AFTER UPDATE OF body_sha256 ON blog_post_translations
FOR EACH ROW
WHEN NEW.body_sha256 IS NOT OLD.body_sha256
BEGIN
  UPDATE content_blobs
     SET refcount    = refcount - 1,
         last_ref_at = unixepoch() * 1000
   WHERE sha256 = OLD.body_sha256;
END;

CREATE TRIGGER trg_blob_ref_blog_upd_inc
AFTER UPDATE OF body_sha256 ON blog_post_translations
FOR EACH ROW
WHEN NEW.body_sha256 IS NOT OLD.body_sha256
BEGIN
  UPDATE content_blobs
     SET refcount      = refcount + 1,
         last_ref_at   = unixepoch() * 1000,
         state         = 'live',
         tombstoned_at = NULL
   WHERE sha256 = NEW.body_sha256;
END;

-- --------------------------------------------------------------------------------------------
-- 3. DENORMALISED OWNERSHIP. BEFORE INSERT *and* BEFORE UPDATE.
--
--    The composite foreign keys in 0001 and 0003 already guarantee that a translation belongs to a
--    page in the same version — the engine enforces that on every write with no trigger to forget.
--    What they cannot cover is the OTHER denormalised column: `pages.site_id` and
--    `blog_posts.site_id`, which name a control-plane row and so cannot be a foreign key at all.
--
--    Architecture §5.4 adopted the INSERT half specifically: the original trigger was UPDATE-only,
--    and the schema's own documented `defer_foreign_keys` batch-insert path walked straight past
--    it. A page whose `site_id` disagrees with its version's is a cross-tenant read waiting for the
--    first query that trusts the denormalised column.
-- --------------------------------------------------------------------------------------------
CREATE TRIGGER trg_pages_site_ownership_ins
BEFORE INSERT ON pages
FOR EACH ROW
WHEN NEW.site_id IS NOT (SELECT site_id FROM site_versions WHERE id = NEW.site_version_id)
BEGIN
  SELECT RAISE(ABORT, 'page.site_id must equal its site_version site_id');
END;

CREATE TRIGGER trg_pages_site_ownership_upd
BEFORE UPDATE OF site_id, site_version_id ON pages
FOR EACH ROW
WHEN NEW.site_id IS NOT (SELECT site_id FROM site_versions WHERE id = NEW.site_version_id)
BEGIN
  SELECT RAISE(ABORT, 'page.site_id must equal its site_version site_id');
END;

CREATE TRIGGER trg_blog_site_ownership_ins
BEFORE INSERT ON blog_posts
FOR EACH ROW
WHEN NEW.site_id IS NOT (SELECT site_id FROM site_versions WHERE id = NEW.site_version_id)
BEGIN
  SELECT RAISE(ABORT, 'blog_post.site_id must equal its site_version site_id');
END;

CREATE TRIGGER trg_blog_site_ownership_upd
BEFORE UPDATE OF site_id, site_version_id ON blog_posts
FOR EACH ROW
WHEN NEW.site_id IS NOT (SELECT site_id FROM site_versions WHERE id = NEW.site_version_id)
BEGIN
  SELECT RAISE(ABORT, 'blog_post.site_id must equal its site_version site_id');
END;

-- A deployment records a publish of one version of one site; pointing it at another tenant's
-- version would attribute a publish — and a rollback target — to the wrong customer.
CREATE TRIGGER trg_deployments_site_ownership_ins
BEFORE INSERT ON deployments
FOR EACH ROW
WHEN NEW.site_id IS NOT (SELECT site_id FROM site_versions WHERE id = NEW.site_version_id)
BEGIN
  SELECT RAISE(ABORT, 'deployment.site_id must equal its site_version site_id');
END;

CREATE TRIGGER trg_deployments_site_ownership_upd
BEFORE UPDATE OF site_id, site_version_id ON deployments
FOR EACH ROW
WHEN NEW.site_id IS NOT (SELECT site_id FROM site_versions WHERE id = NEW.site_version_id)
BEGIN
  SELECT RAISE(ABORT, 'deployment.site_id must equal its site_version site_id');
END;

-- A job's version pointer must stay inside the job's own site, for the same reason.
CREATE TRIGGER trg_jobs_version_ownership
BEFORE UPDATE OF site_version_id ON generation_jobs
FOR EACH ROW
WHEN NEW.site_version_id IS NOT NULL
 AND NEW.site_id IS NOT (SELECT site_id FROM site_versions WHERE id = NEW.site_version_id)
BEGIN
  SELECT RAISE(ABORT, 'generation_job.site_version_id references another site');
END;
