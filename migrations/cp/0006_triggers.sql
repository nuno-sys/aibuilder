-- ============================================================================================
-- migrations/cp/0006_triggers.sql          database: aibuilder-cp
--
-- PURPOSE
--   The control-plane invariants that D1 can enforce and application code cannot be trusted to.
--   D1 has no stored procedures, so an invariant is either a trigger or it is only a comment.
--
--   Triggers live in their own migration on purpose: wrangler's SQL statement splitter has a known
--   failure on trigger bodies (it breaks on `BEGIN` and reports "incomplete input"). Isolated here,
--   a splitter bug can never block a schema migration. `BEGIN` and `END` are always uppercase —
--   lowercase is the reported trigger of that bug.
--
-- MIGRATION RULE (architecture §5.4). A cascade-parent table can NEVER be rebuilt in place on D1:
--   `PRAGMA foreign_keys=OFF` is unsupported there, `defer_foreign_keys` defers constraint
--   *checking* rather than FK *actions*, and the 12-step rebuild therefore cascade-deletes every
--   child row while `foreign_key_check` still passes. Expand -> migrate -> contract using only
--   `ALTER TABLE ADD/DROP/RENAME COLUMN`. Note that dropping and recreating a trigger is safe and
--   is the normal way to change one: triggers are not tables.
-- ============================================================================================

-- --------------------------------------------------------------------------------------------
-- 1. Reserved slugs are enforced, not merely listed.
--
--    Before this trigger existed, `reserved_slugs` had no FK, no trigger and no reader, and a site
--    with slug='www' inserted cleanly — which is a live subdomain-takeover of our own MX, ACME and
--    autodiscover labels. The list is seeded in 0007 with system, brand and protocol labels, and
--    grows with every retired tenant slug (trigger 2).
-- --------------------------------------------------------------------------------------------
CREATE TRIGGER trg_sites_slug_reserved_ins
BEFORE INSERT ON sites
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM reserved_slugs WHERE slug = NEW.slug)
BEGIN
  SELECT RAISE(ABORT, 'slug is reserved');
END;

CREATE TRIGGER trg_sites_slug_reserved_upd
BEFORE UPDATE OF slug ON sites
FOR EACH ROW
WHEN NEW.slug <> OLD.slug AND EXISTS (SELECT 1 FROM reserved_slugs WHERE slug = NEW.slug)
BEGIN
  SELECT RAISE(ABORT, 'slug is reserved');
END;

-- --------------------------------------------------------------------------------------------
-- 2. A retired slug is reserved forever.
--
--    The total `uq_sites_slug_total` index already stops reuse while the row exists; this makes the
--    reservation survive a hard delete, so a label whose 301s and backlinks are still in the wild
--    can never be handed to a different tenant.
-- --------------------------------------------------------------------------------------------
CREATE TRIGGER trg_sites_retire_slug
AFTER UPDATE OF deleted_at ON sites
FOR EACH ROW
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO reserved_slugs (slug, reason, note, created_at)
  VALUES (NEW.slug, 'retired', NEW.id, NEW.deleted_at);
END;

-- --------------------------------------------------------------------------------------------
-- 3. Shard assignment is an ownership invariant, and it is BEFORE INSERT *and* BEFORE UPDATE.
--
--    Architecture §5.4 adopted this correction: the original trigger was UPDATE-only, and the
--    schema's own documented `defer_foreign_keys` batch-insert path walked straight past it. A site
--    whose `shard_id` disagrees with its organisation's is a site whose pages, media and jobs are
--    looked up in the wrong database — a cross-tenant read, not a cosmetic drift.
-- --------------------------------------------------------------------------------------------
CREATE TRIGGER trg_sites_shard_ownership_ins
BEFORE INSERT ON sites
FOR EACH ROW
WHEN NEW.shard_id IS NOT (SELECT shard_id FROM organisations WHERE id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'site.shard_id must equal its organisation shard_id');
END;

CREATE TRIGGER trg_sites_shard_ownership_upd
BEFORE UPDATE OF shard_id, org_id ON sites
FOR EACH ROW
WHEN NEW.shard_id IS NOT (SELECT shard_id FROM organisations WHERE id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'site.shard_id must equal its organisation shard_id');
END;

-- Resharding a live organisation means moving every version, page, blob reference, media asset and
-- job to another database. That is the migration this architecture exists to avoid (§9 one-way door
-- 6), so it is refused at the database rather than left to a code review.
CREATE TRIGGER trg_orgs_shard_immutable
BEFORE UPDATE OF shard_id ON organisations
FOR EACH ROW
WHEN NEW.shard_id <> OLD.shard_id
 AND EXISTS (SELECT 1 FROM sites WHERE org_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'shard_id is immutable once the organisation owns a site');
END;

-- --------------------------------------------------------------------------------------------
-- 4. A custom domain belongs to its site's organisation.
--
--    `custom_domains` carries `org_id` denormalised so the dashboard lists a tenant's hostnames
--    without a join. A mismatch would let one org's dashboard mutate another org's hostname.
-- --------------------------------------------------------------------------------------------
CREATE TRIGGER trg_domains_org_ownership_ins
BEFORE INSERT ON custom_domains
FOR EACH ROW
WHEN NEW.org_id IS NOT (SELECT org_id FROM sites WHERE id = NEW.site_id)
BEGIN
  SELECT RAISE(ABORT, 'custom_domain.org_id must equal its site org_id');
END;

CREATE TRIGGER trg_domains_org_ownership_upd
BEFORE UPDATE OF org_id, site_id ON custom_domains
FOR EACH ROW
WHEN NEW.org_id IS NOT (SELECT org_id FROM sites WHERE id = NEW.site_id)
BEGIN
  SELECT RAISE(ABORT, 'custom_domain.org_id must equal its site org_id');
END;

-- --------------------------------------------------------------------------------------------
-- 5. A submitted draft points at a site owned by the draft's own organisation.
--
--    Same shape, and it is the boundary the SSE endpoint authorises against: the draft cookie
--    proves ownership of a draft, and the draft proves ownership of exactly one job.
-- --------------------------------------------------------------------------------------------
CREATE TRIGGER trg_drafts_site_ownership_ins
BEFORE INSERT ON onboarding_drafts
FOR EACH ROW
WHEN NEW.site_id IS NOT NULL
 AND NEW.org_id IS NOT (SELECT org_id FROM sites WHERE id = NEW.site_id)
BEGIN
  SELECT RAISE(ABORT, 'draft.org_id must equal its site org_id');
END;

CREATE TRIGGER trg_drafts_site_ownership_upd
BEFORE UPDATE OF site_id, org_id ON onboarding_drafts
FOR EACH ROW
WHEN NEW.site_id IS NOT NULL
 AND NEW.org_id IS NOT (SELECT org_id FROM sites WHERE id = NEW.site_id)
BEGIN
  SELECT RAISE(ABORT, 'draft.org_id must equal its site org_id');
END;

-- --------------------------------------------------------------------------------------------
-- 6. The tenancy isolation invariant, from the other side.
--
--    Architecture §5.2: an organisation with zero memberships is unreachable by every authenticated
--    path — that is what makes a provisional org safe to create before any e-mail is verified. The
--    converse has to hold too: clearing `provisional` while the org still has no members would
--    produce an organisation that is billable and entitled but that nobody can ever sign in to.
--    Claim writes the membership and this update in the same batch(), in that order.
-- --------------------------------------------------------------------------------------------
CREATE TRIGGER trg_orgs_deprovision_needs_member
BEFORE UPDATE OF provisional ON organisations
FOR EACH ROW
WHEN NEW.provisional = 0 AND OLD.provisional = 1
 AND NOT EXISTS (SELECT 1 FROM memberships WHERE org_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'cannot de-provision an organisation with no memberships');
END;

-- The owner membership is the org's last line of reachability. Removing it must be an ownership
-- transfer (an UPDATE of `role`), never a DELETE that leaves the tenant stranded.
--
-- The two legitimate cascade deletes are both exempted by the WHEN clause rather than by an
-- override: purging an unclaimed provisional org matches `provisional = 0` false, and the GDPR
-- erasure procedure soft-deletes the organisation (setting `deleted_at`) before hard-deleting it,
-- which is the documented order for exactly this reason. Deleting a user who is still the sole
-- owner of a live organisation is refused on purpose — transfer first.
CREATE TRIGGER trg_memberships_keep_owner
BEFORE DELETE ON memberships
FOR EACH ROW
WHEN OLD.role = 'owner'
 AND EXISTS (SELECT 1 FROM organisations WHERE id = OLD.org_id AND provisional = 0 AND deleted_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'transfer ownership before removing the owner membership');
END;
