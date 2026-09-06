-- 0001_core_identity.sql
-- Conventions (apply to EVERY table in this schema):
--   * STRICT tables            -> D1-recommended; kills type-affinity surprises.
--   * Timestamps: INTEGER unix-epoch MILLISECONDS (matches JS Date.now(); sorts numerically).
--   * Booleans:   INTEGER + CHECK (x IN (0,1))   (STRICT has no BOOLEAN type).
--   * Money:      INTEGER minor units (cents) for Stripe; INTEGER micro-USD for AI cost. Never REAL.
--   * IDs:        TEXT, prefixed ULID -> '<3char>_' + 26-char Crockford base32 = 30 chars fixed.
--   * Enums:      TEXT + CHECK (... IN (...)).
--   * JSON:       TEXT + CHECK (json_valid(...)) (D1 ships the JSON1 extension).
--   * GLOB not LIKE for validation: '_' is a LIKE wildcard but a literal in GLOB.
--     (D1 caps LIKE/GLOB patterns at 50 bytes - every pattern here is well under that.)

CREATE TABLE locales (
  code          TEXT PRIMARY KEY,
  english_name  TEXT NOT NULL,
  native_name   TEXT NOT NULL,
  hreflang      TEXT NOT NULL,
  url_segment   TEXT NOT NULL,
  direction     TEXT NOT NULL DEFAULT 'ltr' CHECK (direction IN ('ltr','rtl')),
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order    INTEGER NOT NULL DEFAULT 100,
  created_at    INTEGER NOT NULL,
  CHECK (code GLOB '[a-z][a-z]' OR code GLOB '[a-z][a-z]-[A-Z][A-Z]'),
  CHECK (length(url_segment) BETWEEN 2 AND 12 AND url_segment NOT GLOB '*[^a-z-]*')
) STRICT;

CREATE INDEX idx_locales_active ON locales(sort_order, code) WHERE is_active = 1;

-- Industry catalogue drives the onboarding dropdown AND the per-industry design/prompt.
-- Adding an industry is an INSERT, never a migration.
CREATE TABLE industries (
  key                    TEXT PRIMARY KEY,
  schema_org_type        TEXT NOT NULL DEFAULT 'LocalBusiness',
  design_preset          TEXT NOT NULL CHECK (json_valid(design_preset)),
  default_page_keys      TEXT NOT NULL CHECK (json_valid(default_page_keys)),
  prompt_fragment_sha256 TEXT,
  stock_query            TEXT,
  is_active              INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order             INTEGER NOT NULL DEFAULT 100,
  created_at             INTEGER NOT NULL,
  CHECK (key NOT GLOB '*[^a-z0-9_]*' AND length(key) BETWEEN 2 AND 48),
  CHECK (length(design_preset) <= 8192),
  CHECK (prompt_fragment_sha256 IS NULL
         OR (length(prompt_fragment_sha256) = 64 AND prompt_fragment_sha256 NOT GLOB '*[^0-9a-f]*'))
) STRICT;

CREATE INDEX idx_industries_active ON industries(sort_order, key) WHERE is_active = 1;

CREATE TABLE industry_translations (
  industry_key TEXT NOT NULL REFERENCES industries(key) ON DELETE CASCADE,
  locale       TEXT NOT NULL REFERENCES locales(code) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  search_terms TEXT,
  PRIMARY KEY (industry_key, locale)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_industry_tr_locale ON industry_translations(locale, label, industry_key);

CREATE TABLE reserved_slugs (
  slug   TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT 'system'
) STRICT, WITHOUT ROWID;

CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL,
  email_normalized  TEXT NOT NULL,
  email_verified_at INTEGER,
  password_hash     TEXT,
  full_name         TEXT,
  locale            TEXT NOT NULL DEFAULT 'en' REFERENCES locales(code) ON DELETE RESTRICT,
  country           TEXT CHECK (country IS NULL OR country GLOB '[A-Z][A-Z]'),
  timezone          TEXT NOT NULL DEFAULT 'Europe/Amsterdam',
  marketing_opt_in  INTEGER NOT NULL DEFAULT 0 CHECK (marketing_opt_in IN (0,1)),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  last_login_at     INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  CHECK (id GLOB 'usr_[0-7]*' AND length(id) = 30),
  CHECK (email LIKE '%_@_%._%'),
  CHECK (email_normalized = lower(email_normalized))
) STRICT;

CREATE UNIQUE INDEX uq_users_email     ON users(email_normalized) WHERE deleted_at IS NULL;
CREATE INDEX        idx_users_created  ON users(created_at DESC);

CREATE TABLE organisations (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  billing_email     TEXT,
  country           TEXT NOT NULL DEFAULT 'NL' CHECK (country GLOB '[A-Z][A-Z]'),
  vat_number        TEXT,
  vat_validated_at  INTEGER,
  billing_address   TEXT CHECK (billing_address IS NULL OR json_valid(billing_address)),
  plan              TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro')),
  -- Denormalised entitlement cache: the paywall check must be ONE row read,
  -- never a join to subscriptions. Written by the Stripe webhook in the same batch.
  entitlement       TEXT NOT NULL DEFAULT 'none'
                      CHECK (entitlement IN ('none','trialing','active','past_due','canceled')),
  entitlement_until INTEGER,
  sites_limit       INTEGER NOT NULL DEFAULT 1 CHECK (sites_limit > 0),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  CHECK (id GLOB 'org_[0-7]*' AND length(id) = 30)
) STRICT;

CREATE INDEX idx_orgs_entitlement_expiry ON organisations(entitlement_until)
  WHERE entitlement IN ('trialing','past_due');
CREATE INDEX idx_orgs_created ON organisations(created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE memberships (
  org_id      TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('owner','admin','editor','viewer')),
  invited_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  accepted_at INTEGER,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
) STRICT, WITHOUT ROWID;

-- Covering index for "list the orgs I belong to" - never touches the table b-tree.
CREATE INDEX idx_memberships_user ON memberships(user_id, org_id, role);

-- Auth session. PK is the token hash and the table is WITHOUT ROWID, so the row
-- lives IN the PK b-tree: authentication is a single page read. Hottest query in the app.
CREATE TABLE sessions (
  token_hash    TEXT PRIMARY KEY,
  id            TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active_org_id TEXT REFERENCES organisations(id) ON DELETE SET NULL,
  ip_hash       TEXT,
  user_agent    TEXT,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  CHECK (id GLOB 'ses_[0-7]*' AND length(id) = 30),
  CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (expires_at > created_at)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_sessions_user ON sessions(user_id, expires_at DESC);
CREATE INDEX idx_sessions_gc   ON sessions(expires_at) WHERE revoked_at IS NULL;

CREATE TABLE auth_tokens (
  token_hash  TEXT PRIMARY KEY,
  id          TEXT NOT NULL,
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  purpose     TEXT NOT NULL
                CHECK (purpose IN ('magic_link','email_verify','password_reset','org_invite')),
  org_id      TEXT REFERENCES organisations(id) ON DELETE CASCADE,
  payload     TEXT CHECK (payload IS NULL OR json_valid(payload)),
  ip_hash     TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  CHECK (id GLOB 'tok_[0-7]*' AND length(id) = 30),
  CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (expires_at > created_at)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_auth_tokens_email ON auth_tokens(email, purpose, created_at DESC);
CREATE INDEX idx_auth_tokens_gc    ON auth_tokens(expires_at) WHERE consumed_at IS NULL;
