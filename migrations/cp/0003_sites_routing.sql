-- ============================================================================================
-- migrations/cp/0003_sites_routing.sql     database: aibuilder-cp
--
-- PURPOSE
--   Routing identity, and nothing else. `sites` answers exactly one question — "which tenant, on
--   which shard, at which version, indexable or not" — and it is the source of the KV routing
--   manifest the renderer reads. Business facts (name, address, phone, hours) are deliberately
--   NOT here: architecture §5.2 pins this table to identity and routing, the renderer never
--   touches D1 on the request path (§3a), and the facts live in `onboarding_drafts` (0005) until
--   publish projects them into `SiteDoc.facts` in R2.
--
--   Also the two soft-delete views. Architecture §5.4 adopted the finding that every partial index
--   on `WHERE deleted_at IS NULL` is unusable unless the query text repeats the predicate
--   verbatim; leaving that to the query author's memory is how a soft-deleted tenant becomes a
--   full table SCAN in production. Reads go through `live_sites` / `live_domains`.
--
-- MIGRATION RULE (architecture §5.4). A cascade-parent table can NEVER be rebuilt in place on D1.
--   `PRAGMA foreign_keys=OFF` is unsupported and `defer_foreign_keys` defers constraint *checking*
--   only, so the 12-step rebuild cascade-deletes every child row while `foreign_key_check` reports
--   success. Expand -> migrate -> contract with `ALTER TABLE ADD/DROP/RENAME COLUMN` is the only
--   safe forward path. `sites` is a cascade parent of `site_claim_tokens` and `custom_domains`.
--
-- CROSS-DATABASE POINTERS
--   `published_version_id` names a row in `site_versions` on the tenant's SHARD. A foreign key
--   cannot span D1 databases, so it is a plain TEXT column with a prefix CHECK, and the invariant
--   "the version belongs to this site" is enforced on the shard side (0006 there) plus by the
--   publish path writing both in one ordered sequence. The same is true of every `site_id` and
--   `org_id` column in migrations/shard.
-- ============================================================================================

CREATE TABLE sites (
  id                   TEXT PRIMARY KEY,
  org_id               TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  -- Denormalised from `organisations.shard_id` so the routing manifest builder resolves a host to
  -- a shard binding without a join. Kept equal to the org's value by a trigger in 0006.
  shard_id             INTEGER NOT NULL DEFAULT 0 CHECK (shard_id >= 0),
  slug                 TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'onboarding'
                         CHECK (status IN ('onboarding','generating','draft','published','suspended','deleted')),
  default_locale       TEXT NOT NULL REFERENCES locales(code) ON DELETE RESTRICT,
  -- Lives on the shard. See CROSS-DATABASE POINTERS above.
  published_version_id TEXT CHECK (published_version_id IS NULL OR
                         (length(published_version_id) = 30
                          AND published_version_id GLOB 'ver_[0-7]*'
                          AND substr(published_version_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
  -- The one host every canonical URL, hreflang entry, sitemap entry and JSON-LD @id is built from.
  -- `<slug>.<SITES_ROOT_DOMAIN>` until a custom domain is verified, then `www.<customer-domain>` —
  -- Cloudflare for SaaS cannot serve a customer's zone apex below Enterprise (architecture §9).
  canonical_host       TEXT NOT NULL,
  -- `noindex` until card-on-file AND a passing quality gate (§7.26). `gone` is the per-tenant kill
  -- switch: the renderer answers 410 and the sitemap drops the host.
  index_state          TEXT NOT NULL DEFAULT 'noindex'
                         CHECK (index_state IN ('noindex','eligible','indexable','gone')),
  published_at         INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  deleted_at           INTEGER,
  CHECK (length(id) = 30 AND id GLOB 'ste_[0-7]*' AND substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  -- LDH label rules, anchored on both ends. The negated class is what stops `mijn<script>salon`;
  -- a bare `GLOB '[a-z0-9]*'` prefix test does not.
  CHECK (length(slug) BETWEEN 3 AND 63
         AND slug NOT GLOB '*[^a-z0-9-]*'
         AND slug GLOB '[a-z0-9]*'
         AND slug NOT GLOB '*-'
         AND slug NOT GLOB '*--*'),
  CHECK (length(canonical_host) BETWEEN 4 AND 253
         AND canonical_host = lower(canonical_host)
         AND canonical_host NOT GLOB '*[^a-z0-9.-]*'
         AND canonical_host GLOB '[a-z0-9]*'
         AND canonical_host GLOB '*.*'
         AND canonical_host NOT GLOB '*[.-]'
         AND canonical_host NOT GLOB '*..*'),
  CHECK (status <> 'published' OR published_version_id IS NOT NULL),
  CHECK (published_at IS NULL OR published_version_id IS NOT NULL),
  CHECK (deleted_at IS NULL OR status = 'deleted')
) STRICT;

-- TOTAL. A soft-deleted site keeps reserving its slug, which is exactly what slug retirement
-- wants: the label can never be handed to a different tenant and re-serve someone else's 301s.
CREATE UNIQUE INDEX uq_sites_slug_total ON sites(slug);
-- Live lookup for host resolution. Only reachable through `live_sites`, which carries the
-- predicate verbatim.
CREATE UNIQUE INDEX uq_sites_slug_live ON sites(slug) WHERE deleted_at IS NULL;
-- TOTAL, not partial on `deleted_at`: this is also the FK child index the daily
-- provisional-organisation purge uses, and a partial index on a predicate the cascade does not
-- carry would leave every one of those deletes scanning `sites`. The live listing still seeks it
-- and filters, which on a handful of rows per organisation is free.
CREATE INDEX idx_sites_org    ON sites(org_id, created_at DESC);
CREATE INDEX idx_sites_status ON sites(status, updated_at DESC) WHERE deleted_at IS NULL;
-- Routing manifest rebuild. Covering, and keyset-ordered on `id` so the cron walks the whole table
-- in pages without an OFFSET re-scan. The partial predicate is repeated verbatim by
-- `SQL_LIST_ROUTING_MANIFEST`, which is the only way SQLite's prover will use a partial index.
CREATE INDEX idx_sites_manifest
  ON sites(id, shard_id, canonical_host, published_version_id, index_state, default_locale, slug)
  WHERE deleted_at IS NULL AND published_version_id IS NOT NULL;

CREATE TABLE custom_domains (
  id                     TEXT PRIMARY KEY,
  site_id                TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  org_id                 TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  hostname               TEXT NOT NULL,
  cf_custom_hostname_id  TEXT CHECK (cf_custom_hostname_id IS NULL OR length(cf_custom_hostname_id) <= 64),
  status                 TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','pending_validation','active','moved','deleted','blocked','failed')),
  -- Mirrors the Cloudflare custom_hostname.ssl.status vocabulary verbatim. Widening this CHECK is
  -- a table rebuild, so the full published enum is present from day one.
  ssl_status             TEXT NOT NULL DEFAULT 'initializing'
                           CHECK (ssl_status IN ('initializing','pending_validation','pending_issuance',
                                                 'pending_deployment','active','deleted','expired',
                                                 'deactivating','backup_issued','holding_deployment','failed')),
  ssl_method             TEXT NOT NULL DEFAULT 'txt' CHECK (ssl_method IN ('http','txt','email')),
  -- Our own `_aibuilder-challenge` TXT proof, checked BEFORE the Custom Hostnames API is called.
  -- Skipping this step is how a SaaS platform gets used to issue certificates for domains the
  -- requester does not control (architecture §9, Phase 3 blocker).
  ownership_verified_at  INTEGER,
  dcv_record_name        TEXT CHECK (dcv_record_name IS NULL OR length(dcv_record_name) <= 253),
  dcv_record_value       TEXT CHECK (dcv_record_value IS NULL OR length(dcv_record_value) <= 255),
  ownership_record_name  TEXT CHECK (ownership_record_name IS NULL OR length(ownership_record_name) <= 253),
  ownership_record_value TEXT CHECK (ownership_record_value IS NULL OR length(ownership_record_value) <= 255),
  target_cname           TEXT NOT NULL CHECK (length(target_cname) BETWEEN 4 AND 253),
  is_primary             INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  redirect_to_primary    INTEGER NOT NULL DEFAULT 1 CHECK (redirect_to_primary IN (0,1)),
  cf_errors              TEXT CHECK (cf_errors IS NULL OR (json_valid(cf_errors) AND length(cf_errors) <= 4096)),
  last_checked_at        INTEGER,
  check_attempts         INTEGER NOT NULL DEFAULT 0 CHECK (check_attempts BETWEEN 0 AND 1000),
  activated_at           INTEGER,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  deleted_at             INTEGER,
  CHECK (length(id) = 30 AND id GLOB 'dom_[0-7]*' AND substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (length(hostname) BETWEEN 4 AND 253
         AND hostname = lower(hostname)
         AND hostname NOT GLOB '*[^a-z0-9.-]*'
         AND hostname GLOB '[a-z0-9]*'
         AND hostname GLOB '*.*'
         AND hostname NOT GLOB '*[.-]'
         AND hostname NOT GLOB '*..*'),
  CHECK (status <> 'active' OR ownership_verified_at IS NOT NULL),
  CHECK (deleted_at IS NULL OR status = 'deleted')
) STRICT;

-- TOTAL, and this index is the thing that prevents a tenant-hijack: Cloudflare for SaaS refuses to
-- attach one hostname to two tenants, and neither do we — including after a soft delete, so a
-- released hostname cannot be silently re-attached while its DNS still points at us.
CREATE UNIQUE INDEX uq_domains_hostname_total ON custom_domains(hostname);
CREATE UNIQUE INDEX uq_domains_hostname_live  ON custom_domains(hostname) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_domains_cfid ON custom_domains(cf_custom_hostname_id)
  WHERE cf_custom_hostname_id IS NOT NULL;
CREATE UNIQUE INDEX uq_domains_primary ON custom_domains(site_id)
  WHERE is_primary = 1 AND deleted_at IS NULL;
-- FK child index; see the note above `idx_memberships_invited_by` in 0001_identity.sql. Total for the same reason as `idx_sites_org`.
CREATE INDEX idx_domains_site ON custom_domains(site_id, created_at DESC);
-- Provisioning poll and the daily dangling-DNS reconciler: O(pending), not O(all).
CREATE INDEX idx_domains_poll ON custom_domains(last_checked_at)
  WHERE ssl_status NOT IN ('active','deleted') AND deleted_at IS NULL;
-- FK child index; see the note above `idx_memberships_invited_by` in 0001_identity.sql.
CREATE INDEX idx_domains_org ON custom_domains(org_id, hostname);

-- --------------------------------------------------------------------------------------------
-- Soft-delete views. Architecture §5.4: the predicate lives here, not in the author's memory.
-- `packages/db/src/cp/*.ts` reads through these; the CI EXPLAIN QUERY PLAN gate fails the build on
-- any statement that produces a SCAN, which is what catches a forgotten predicate.
--
-- `live_domains` filters on soft delete only. "Verified and serving" is `status = 'active'`, and
-- the routing manifest builder states that explicitly rather than hiding it in a view, because a
-- pending domain is still a live row that the dashboard must show.
-- --------------------------------------------------------------------------------------------
CREATE VIEW live_sites AS
  SELECT * FROM sites WHERE deleted_at IS NULL;

CREATE VIEW live_domains AS
  SELECT * FROM custom_domains WHERE deleted_at IS NULL;
