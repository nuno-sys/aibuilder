-- ============================================================================================
-- migrations/shard/0005_leads_audit.sql      database: aibuilder-shard-NNN
--
-- PURPOSE
--   Everything that grows without bound, and therefore everything that carries a retention
--   deadline: contact and booking submissions, the action audit trail, coarse quota windows and
--   the consent ledger. `leads` and `audit_log` are the two tables that decide this database's
--   real runway, so both carry a NOT NULL `purge_after` and both have a purge cron from day one.
--
-- THE UNDO JOURNAL IS NOT HERE (architecture §5.4).
--   `audit_log` deliberately has no `before_json` / `after_json`. At up to 32 KB per pair, roughly
--   160,000 slider drags fill a 10 GB database, and nothing ever filters or sorts on those columns.
--   The editor's undo ring lives in `SiteDraftDO` storage and in R2 per version. This table records
--   ACTIONS — who published what, when — and nothing else.
--
-- PERSONAL DATA
--   `ip_hash` is sha256(ip || daily_salt). That is PSEUDONYMOUS PERSONAL DATA, not anonymous data:
--   the IPv4 space is small enough to brute-force against a known salt. It is recorded as such in
--   the ROPA and in the generated privacy policy, the salt is rotated daily with only two retained
--   for lookback, and erasure-by-subject is a real, indexed operation (see idx_leads_email /
--   idx_leads_phone below) rather than a full scan someone runs by hand.
--
-- MIGRATION RULE (architecture §5.4). A cascade-parent table can NEVER be rebuilt in place on D1:
--   `PRAGMA foreign_keys=OFF` is unsupported, `defer_foreign_keys` defers constraint *checking* and
--   not FK *actions*, so a 12-step rebuild cascade-deletes children while `foreign_key_check`
--   passes. Expand -> migrate -> contract with `ALTER TABLE ADD/DROP/RENAME COLUMN` only.
-- ============================================================================================

CREATE TABLE leads (
  id                  TEXT PRIMARY KEY,
  site_id             TEXT NOT NULL,
  org_id              TEXT NOT NULL,
  kind                TEXT NOT NULL DEFAULT 'contact'
                        CHECK (kind IN ('contact','booking','callback','quote','newsletter')),
  locale              TEXT CHECK (locale IS NULL OR
                        locale GLOB '[a-z][a-z]' OR locale GLOB '[a-z][a-z]-[A-Z][A-Z]'),
  page_path           TEXT CHECK (page_path IS NULL OR length(page_path) <= 512),
  -- Visitor-supplied and therefore free text. These are NOT the CHECK-constrained business
  -- columns: a visitor's phone number is whatever they typed, and rejecting it at the database
  -- would silently lose the lead the customer is paying us for. Contextual escaping at render and
  -- Zod at the boundary do the work; the bounds here only stop a storage-exhaustion write.
  name                TEXT CHECK (name IS NULL OR length(name) <= 200),
  email               TEXT CHECK (email IS NULL OR length(email) <= 320),
  phone               TEXT CHECK (phone IS NULL OR length(phone) <= 32),
  message             TEXT CHECK (message IS NULL OR length(message) <= 8000),
  fields              TEXT CHECK (fields IS NULL OR
                        (json_valid(fields) AND length(fields) <= 16384)),
  requested_at        INTEGER,
  party_size          INTEGER CHECK (party_size IS NULL OR party_size BETWEEN 1 AND 500),
  booking_status      TEXT CHECK (booking_status IS NULL OR booking_status IN
                        ('requested','confirmed','declined','cancelled','completed')),
  spam_score          REAL NOT NULL DEFAULT 0.0 CHECK (spam_score BETWEEN 0.0 AND 1.0),
  is_spam             INTEGER NOT NULL DEFAULT 0 CHECK (is_spam IN (0,1)),
  turnstile_ok        INTEGER NOT NULL DEFAULT 0 CHECK (turnstile_ok IN (0,1)),
  -- Proof of consent: when, and against which exact wording.
  consent_at          INTEGER,
  consent_text_sha256 BLOB CHECK (consent_text_sha256 IS NULL OR length(consent_text_sha256) = 32),
  ip_hash             BLOB CHECK (ip_hash IS NULL OR length(ip_hash) = 32),
  ip_country          TEXT CHECK (ip_country IS NULL OR ip_country GLOB '[A-Z][A-Z]'),
  user_agent          TEXT CHECK (user_agent IS NULL OR length(user_agent) <= 512),
  purge_after         INTEGER NOT NULL,
  read_at             INTEGER,
  replied_at          INTEGER,
  archived_at         INTEGER,
  notified_at         INTEGER,
  created_at          INTEGER NOT NULL,
  CHECK (length(id) = 30 AND id GLOB 'led_[0-7]*' AND substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (length(site_id) = 30 AND site_id GLOB 'ste_[0-7]*'
         AND substr(site_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (length(org_id) = 30 AND org_id GLOB 'org_[0-7]*'
         AND substr(org_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  -- A lead with no way to reply is not a lead.
  CHECK (email IS NOT NULL OR phone IS NOT NULL OR kind = 'newsletter'),
  CHECK (purge_after > created_at),
  CHECK (kind <> 'booking' OR requested_at IS NOT NULL)
) STRICT;

-- The inbox. Deliberately narrow: carrying `name` (200) + `email` (320) here would add ~500 bytes
-- per lead to the b-tree, and the page fetches 25 rows — 25 table lookups are far cheaper than that
-- payload in every index entry.
CREATE INDEX idx_leads_inbox  ON leads(site_id, created_at DESC, kind, read_at)
  WHERE is_spam = 0 AND archived_at IS NULL;
CREATE INDEX idx_leads_unread ON leads(site_id, created_at DESC)
  WHERE read_at IS NULL AND is_spam = 0 AND archived_at IS NULL;
CREATE INDEX idx_leads_org    ON leads(org_id, created_at DESC);
CREATE INDEX idx_leads_purge  ON leads(purge_after);
CREATE INDEX idx_leads_notify ON leads(created_at) WHERE notified_at IS NULL AND is_spam = 0;
CREATE INDEX idx_leads_booking ON leads(site_id, requested_at)
  WHERE kind = 'booking' AND booking_status IN ('requested','confirmed');
-- Erasure by subject. A GDPR Article 17 request names an e-mail address or a phone number, and
-- without these two indexes answering it is a full scan of the largest table in the database.
CREATE INDEX idx_leads_email ON leads(email) WHERE email IS NOT NULL;
CREATE INDEX idx_leads_phone ON leads(phone) WHERE phone IS NOT NULL;

-- Append-only action trail. INTEGER rowid PK so `ORDER BY id DESC` is newest-first with no sort
-- step and inserts always append to the right edge of the b-tree.
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ulid        TEXT NOT NULL,
  org_id      TEXT,
  site_id     TEXT,
  actor_type  TEXT NOT NULL CHECK (actor_type IN
                ('user','system','stripe','cloudflare','ai','cron','support')),
  actor_id    TEXT CHECK (actor_id IS NULL OR length(actor_id) <= 64),
  -- Dotted lowercase verb: 'site.published', 'domain.added', 'version.rolled_back'.
  action      TEXT NOT NULL CHECK (length(action) BETWEEN 3 AND 64
                AND action NOT GLOB '*[^a-z0-9._]*'),
  target_type TEXT CHECK (target_type IS NULL OR length(target_type) <= 32),
  target_id   TEXT CHECK (target_id IS NULL OR length(target_id) <= 64),
  -- Small, bounded context: which version, which hostname, which price. NOT a diff — see THE UNDO
  -- JOURNAL IS NOT HERE in the header.
  detail      TEXT CHECK (detail IS NULL OR (json_valid(detail) AND length(detail) <= 2048)),
  ip_hash     BLOB CHECK (ip_hash IS NULL OR length(ip_hash) = 32),
  request_id  TEXT CHECK (request_id IS NULL OR length(request_id) <= 64),
  created_at  INTEGER NOT NULL,
  -- A real retention column, not an index on `created_at` described as one. Different actions have
  -- different statutory retention (billing actions outlive editor actions), so the deadline is per
  -- row and the cron reads it rather than applying one global window.
  purge_after INTEGER NOT NULL,
  CHECK (length(ulid) = 30 AND ulid GLOB 'aud_[0-7]*' AND substr(ulid, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (org_id IS NULL OR (length(org_id) = 30 AND org_id GLOB 'org_[0-7]*'
         AND substr(org_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
  CHECK (site_id IS NULL OR (length(site_id) = 30 AND site_id GLOB 'ste_[0-7]*'
         AND substr(site_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
  CHECK (purge_after > created_at)
) STRICT;

CREATE INDEX idx_audit_org    ON audit_log(org_id, id DESC) WHERE org_id IS NOT NULL;
CREATE INDEX idx_audit_site   ON audit_log(site_id, id DESC) WHERE site_id IS NOT NULL;
CREATE INDEX idx_audit_action ON audit_log(action, id DESC);
CREATE INDEX idx_audit_target ON audit_log(target_type, target_id, id DESC)
  WHERE target_id IS NOT NULL;
CREATE INDEX idx_audit_purge  ON audit_log(purge_after);

-- BILLING-PERIOD aggregates. Low write rate, safe on a replicated database.
--
-- This is NOT a rate limiter. Per-request and per-IP limiting uses the Workers Rate Limiting
-- binding, and strongly-consistent spend and quota accounting uses QuotaDO / BudgetDO — a
-- write-per-request into a replicated SQLite database is an architecture bug, not a rate limiter.
-- These counters are the durable reconciliation of what those DOs metered.
CREATE TABLE usage_counters (
  org_id       TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  metric       TEXT NOT NULL CHECK (metric IN
                 ('generations','regenerations','ai_input_tokens','ai_output_tokens',
                  'ai_cache_read_tokens','ai_cost_usd_micro','r2_bytes_stored','r2_bytes_egress',
                  'leads','page_views','blog_posts','media_files')),
  value        INTEGER NOT NULL DEFAULT 0 CHECK (value >= 0),
  limit_value  INTEGER CHECK (limit_value IS NULL OR limit_value >= 0),
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (org_id, period_start, metric),
  CHECK (length(org_id) = 30 AND org_id GLOB 'org_[0-7]*'
         AND substr(org_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_usage_metric     ON usage_counters(metric, period_start, value DESC);
CREATE INDEX idx_usage_over_limit ON usage_counters(org_id, metric, value, limit_value)
  WHERE limit_value IS NOT NULL;

-- Consent accountability. GDPR Article 7(1) puts the burden of proof on the controller, so what is
-- stored is the exact wording's hash and the moment — not a boolean that says "they agreed".
CREATE TABLE consent_log (
  id              TEXT PRIMARY KEY,
  site_id         TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN
                    ('lead_form','cookie_banner','marketing_opt_in','terms','privacy')),
  -- sha256(lowercased e-mail or E.164 phone || daily_salt). Pseudonymous personal data; the same
  -- treatment as `ip_hash` above. Erasure matches on this.
  subject_hash    BLOB NOT NULL CHECK (length(subject_hash) = 32),
  granted         INTEGER NOT NULL CHECK (granted IN (0,1)),
  locale          TEXT CHECK (locale IS NULL OR
                    locale GLOB '[a-z][a-z]' OR locale GLOB '[a-z][a-z]-[A-Z][A-Z]'),
  policy_version  TEXT NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 32),
  consent_text_sha256 BLOB NOT NULL CHECK (length(consent_text_sha256) = 32),
  ip_hash         BLOB CHECK (ip_hash IS NULL OR length(ip_hash) = 32),
  created_at      INTEGER NOT NULL,
  purge_after     INTEGER NOT NULL,
  CHECK (length(id) = 30 AND id GLOB 'cns_[0-7]*' AND substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (length(site_id) = 30 AND site_id GLOB 'ste_[0-7]*'
         AND substr(site_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (purge_after > created_at)
) STRICT;

CREATE INDEX idx_consent_subject ON consent_log(subject_hash, created_at DESC);
CREATE INDEX idx_consent_site    ON consent_log(site_id, kind, created_at DESC);
CREATE INDEX idx_consent_purge   ON consent_log(purge_after);
