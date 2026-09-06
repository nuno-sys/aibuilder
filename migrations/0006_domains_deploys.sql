-- 0006_domains_deploys.sql -- Cloudflare for SaaS custom hostnames + Pages deployments.

CREATE TABLE custom_domains (
  id                     TEXT PRIMARY KEY,
  site_id                TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  org_id                 TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  hostname               TEXT NOT NULL,
  cf_custom_hostname_id  TEXT,                      -- Cloudflare for SaaS custom_hostname.id
  status                 TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                           ('pending','pending_validation','active','moved','deleted',
                            'blocked','failed')),
  -- Mirrors the Cloudflare custom_hostname.ssl.status enum verbatim.
  ssl_status             TEXT NOT NULL DEFAULT 'initializing' CHECK (ssl_status IN
                           ('initializing','pending_validation','pending_issuance',
                            'pending_deployment','active','deleted','expired',
                            'deactivating','backup_issued','holding_deployment','failed')),
  ssl_method             TEXT NOT NULL DEFAULT 'http'
                           CHECK (ssl_method IN ('http','txt','email')),
  ownership_verified_at  INTEGER,
  -- DCV + ownership records rendered in the dashboard so the user can paste them at their registrar.
  dcv_record_name        TEXT,
  dcv_record_value       TEXT,
  ownership_record_name  TEXT,
  ownership_record_value TEXT,
  target_cname           TEXT NOT NULL DEFAULT 'cname.mijnsaas.com',
  is_primary             INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  redirect_to_primary    INTEGER NOT NULL DEFAULT 1 CHECK (redirect_to_primary IN (0,1)),
  cf_errors              TEXT CHECK (cf_errors IS NULL OR json_valid(cf_errors)),
  last_checked_at        INTEGER,
  check_attempts         INTEGER NOT NULL DEFAULT 0 CHECK (check_attempts >= 0),
  activated_at           INTEGER,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  deleted_at             INTEGER,
  CHECK (id GLOB 'dom_[0-7]*' AND length(id) = 30),
  CHECK (hostname = lower(hostname)
         AND length(hostname) BETWEEN 4 AND 253
         AND hostname GLOB '*.*'
         AND hostname NOT GLOB '*[^a-z0-9.-]*'
         AND hostname NOT GLOB '.*'
         AND hostname NOT GLOB '*.')
) STRICT;

-- GLOBALLY unique: Cloudflare for SaaS will not attach one hostname to two tenants, and
-- neither will we. This index is the thing that prevents a tenant-hijack bug.
CREATE UNIQUE INDEX uq_domains_hostname ON custom_domains(hostname) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_domains_cfid     ON custom_domains(cf_custom_hostname_id)
  WHERE cf_custom_hostname_id IS NOT NULL;
-- At most one primary domain per site.
CREATE UNIQUE INDEX uq_domains_primary  ON custom_domains(site_id)
  WHERE is_primary = 1 AND deleted_at IS NULL;
CREATE INDEX idx_domains_site  ON custom_domains(site_id, created_at DESC) WHERE deleted_at IS NULL;
-- Polling cron for domains still provisioning: partial index keeps it O(pending), not O(all).
CREATE INDEX idx_domains_poll  ON custom_domains(last_checked_at)
  WHERE ssl_status NOT IN ('active','deleted') AND deleted_at IS NULL;
CREATE INDEX idx_domains_org   ON custom_domains(org_id, hostname) WHERE deleted_at IS NULL;

CREATE TABLE deployments (
  id               TEXT PRIMARY KEY,
  site_id          TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  site_version_id  TEXT NOT NULL REFERENCES site_versions(id) ON DELETE CASCADE,
  target           TEXT NOT NULL DEFAULT 'pages'
                     CHECK (target IN ('pages','r2_static','worker')),
  cf_deployment_id TEXT,
  status           TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
                     ('queued','building','deploying','live','failed','rolled_back')),
  bundle_sha256    TEXT,
  url              TEXT,
  error_message    TEXT CHECK (error_message IS NULL OR length(error_message) <= 4000),
  started_at       INTEGER,
  finished_at      INTEGER,
  created_at       INTEGER NOT NULL,
  CHECK (id GLOB 'dep_[0-7]*' AND length(id) = 30)
) STRICT;

CREATE INDEX idx_deploy_site    ON deployments(site_id, created_at DESC, status);
CREATE INDEX idx_deploy_version ON deployments(site_version_id, status);
CREATE INDEX idx_deploy_active  ON deployments(status, created_at)
  WHERE status IN ('queued','building','deploying');
