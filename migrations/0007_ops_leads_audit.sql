-- 0007_ops_leads_audit.sql -- leads, audit trail, usage counters, coarse rate limiting.

CREATE TABLE leads (
  id                  TEXT PRIMARY KEY,
  site_id             TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  org_id              TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL DEFAULT 'contact'
                        CHECK (kind IN ('contact','booking','callback','quote','newsletter')),
  locale              TEXT REFERENCES locales(code) ON DELETE SET NULL,
  page_path           TEXT,
  name                TEXT CHECK (name    IS NULL OR length(name)    <= 200),
  email               TEXT CHECK (email   IS NULL OR length(email)   <= 320),
  phone               TEXT CHECK (phone   IS NULL OR length(phone)   <= 32),
  message             TEXT CHECK (message IS NULL OR length(message) <= 8000),
  fields              TEXT CHECK (fields IS NULL OR
                        (json_valid(fields) AND length(fields) <= 16384)),
  -- booking-calendar specifics
  requested_at        INTEGER,
  party_size          INTEGER CHECK (party_size IS NULL OR party_size > 0),
  booking_status      TEXT CHECK (booking_status IS NULL OR booking_status IN
                        ('requested','confirmed','declined','cancelled','completed')),
  -- anti-spam
  spam_score          REAL NOT NULL DEFAULT 0.0 CHECK (spam_score BETWEEN 0.0 AND 1.0),
  is_spam             INTEGER NOT NULL DEFAULT 0 CHECK (is_spam IN (0,1)),
  turnstile_ok        INTEGER NOT NULL DEFAULT 0 CHECK (turnstile_ok IN (0,1)),
  -- GDPR: proof of consent, no raw IP at rest, and a hard retention deadline.
  consent_at          INTEGER,
  consent_text_sha256 TEXT,
  ip_hash             TEXT,      -- sha256(ip || daily_salt) - not reversible, not personal data
  ip_country          TEXT CHECK (ip_country IS NULL OR ip_country GLOB '[A-Z][A-Z]'),
  user_agent          TEXT,
  purge_after         INTEGER NOT NULL,   -- cron hard-deletes past this instant
  -- inbox workflow
  read_at             INTEGER,
  replied_at          INTEGER,
  archived_at         INTEGER,
  notified_at         INTEGER,
  created_at          INTEGER NOT NULL,
  CHECK (id GLOB 'led_[0-7]*' AND length(id) = 30),
  CHECK (email IS NOT NULL OR phone IS NOT NULL OR kind = 'newsletter'),
  CHECK (purge_after > created_at)
) STRICT;

-- Narrow on purpose: name (200) + email (320) in the index would add ~500 bytes per lead
-- to the b-tree. The inbox page fetches 25 rows, so 25 table lookups are far cheaper than
-- carrying that payload in every index entry.
CREATE INDEX idx_leads_inbox   ON leads(site_id, created_at DESC, kind, read_at)
  WHERE is_spam = 0 AND archived_at IS NULL;
CREATE INDEX idx_leads_unread  ON leads(site_id, created_at DESC)
  WHERE read_at IS NULL AND is_spam = 0 AND archived_at IS NULL;
CREATE INDEX idx_leads_org     ON leads(org_id, created_at DESC);
CREATE INDEX idx_leads_purge   ON leads(purge_after);
CREATE INDEX idx_leads_notify  ON leads(created_at) WHERE notified_at IS NULL AND is_spam = 0;
CREATE INDEX idx_leads_booking ON leads(site_id, requested_at)
  WHERE kind = 'booking' AND booking_status IN ('requested','confirmed');

-- Append-only. Doubles as the live-editor undo journal (before_json/after_json).
-- INTEGER rowid PK: ORDER BY id DESC == newest-first with no sort step, and inserts
-- always append to the right edge of the b-tree (zero page splits).
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ulid        TEXT NOT NULL,
  org_id      TEXT REFERENCES organisations(id) ON DELETE CASCADE,
  actor_type  TEXT NOT NULL CHECK (actor_type IN
                ('user','system','stripe','cloudflare','ai','cron','support')),
  actor_id    TEXT,
  action      TEXT NOT NULL,   -- 'site.published', 'domain.added', 'subscription.trial_started'
  target_type TEXT,
  target_id   TEXT,
  site_id     TEXT REFERENCES sites(id) ON DELETE CASCADE,
  before_json TEXT CHECK (before_json IS NULL OR
                (json_valid(before_json) AND length(before_json) <= 32768)),
  after_json  TEXT CHECK (after_json IS NULL OR
                (json_valid(after_json) AND length(after_json) <= 32768)),
  ip_hash     TEXT,
  request_id  TEXT,
  created_at  INTEGER NOT NULL,
  CHECK (ulid GLOB 'aud_[0-7]*' AND length(ulid) = 30),
  CHECK (action NOT GLOB '*[^a-z0-9._]*')
) STRICT;

CREATE INDEX idx_audit_org    ON audit_log(org_id, id DESC);
CREATE INDEX idx_audit_site   ON audit_log(site_id, id DESC) WHERE site_id IS NOT NULL;
CREATE INDEX idx_audit_action ON audit_log(action, id DESC);
CREATE INDEX idx_audit_target ON audit_log(target_type, target_id, id DESC)
  WHERE target_id IS NOT NULL;
CREATE INDEX idx_audit_purge  ON audit_log(created_at);

-- BILLING-PERIOD aggregates only. Low write rate, safe on a replicated DB.
-- NOTE: this is NOT a per-request rate limiter. See rate_limit_buckets below.
CREATE TABLE usage_counters (
  org_id       TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  period_start INTEGER NOT NULL,
  metric       TEXT NOT NULL CHECK (metric IN
                 ('generations','regenerations','ai_input_tokens','ai_output_tokens',
                  'ai_cache_read_tokens','ai_cost_usd_micro','r2_bytes_stored',
                  'r2_bytes_egress','leads','page_views','blog_posts')),
  value        INTEGER NOT NULL DEFAULT 0 CHECK (value >= 0),
  limit_value  INTEGER CHECK (limit_value IS NULL OR limit_value >= 0),
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (org_id, period_start, metric)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_usage_metric     ON usage_counters(metric, period_start, value DESC);
CREATE INDEX idx_usage_over_limit ON usage_counters(org_id, metric, value, limit_value)
  WHERE limit_value IS NOT NULL;

-- COARSE, durable quota windows only (per-hour AI generations, per-day leads per site,
-- login attempts per email). Per-request / per-IP limiting MUST use the Workers Rate
-- Limiting binding or a Durable Object - a write-per-request into a replicated SQLite
-- database is an architecture bug, not a rate limiter.
CREATE TABLE rate_limit_buckets (
  bucket_key    TEXT NOT NULL,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  limit_value   INTEGER NOT NULL CHECK (limit_value > 0),
  window_secs   INTEGER NOT NULL CHECK (window_secs > 0),
  blocked_until INTEGER,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (bucket_key, window_start)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_rl_gc      ON rate_limit_buckets(window_start);
CREATE INDEX idx_rl_blocked ON rate_limit_buckets(bucket_key, blocked_until)
  WHERE blocked_until IS NOT NULL;
