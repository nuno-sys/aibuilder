-- ============================================================================================
-- migrations/cp/0001_identity.sql          database: aibuilder-cp (control plane, --location eu)
--
-- PURPOSE
--   Identity and tenancy: users, organisations, the membership edge between them, and the two
--   credential tables (browser sessions, single-use e-mail tokens). Everything in this file is
--   global-uniqueness territory, which is precisely why it lives in the control plane and not in
--   a shard (architecture §5.1).
--
-- MIGRATION RULE — read before editing anything in migrations/ (architecture §5.4).
--   A cascade-parent table can NEVER be rebuilt in place on D1. `PRAGMA foreign_keys=OFF` is not
--   supported by D1, and `defer_foreign_keys` defers constraint *checking*, not FK *actions*: the
--   12-step table rebuild deletes every child row through the cascade, and `foreign_key_check`
--   passes clean afterwards, so the damage is silent. Forward change is expand -> migrate ->
--   contract, using only `ALTER TABLE ADD COLUMN` / `DROP COLUMN` / `RENAME COLUMN`, none of which
--   rebuild the table. CI gates every migration on a per-table row-count snapshot taken before and
--   after. This applies to CHECK constraints too: widening an enum means a rebuild, so an enum that
--   is expected to grow gets its own table instead (see `site_claim_tokens` in 0005).
--
-- CONVENTIONS (every table in migrations/cp and migrations/shard)
--   * STRICT tables. D1 recommends them and they remove type-affinity surprises entirely.
--   * Timestamps: INTEGER unix-epoch MILLISECONDS. Matches `Date.now()`, sorts numerically.
--   * Booleans: INTEGER + `CHECK (x IN (0,1))`. STRICT has no BOOLEAN type.
--   * Money: INTEGER minor units (Stripe cents) or INTEGER micro-USD (AI cost). Never REAL.
--   * Ids: TEXT, 30 chars — a three-letter prefix, `_`, and a 26-char Crockford base32 ULID. The
--     CHECK is anchored on both ends: the prefix is matched positionally and the body is validated
--     with a NEGATED character class, because `GLOB 'ste_*'` alone accepts `ste_<script>`.
--     `packages/core/src/ids.ts` mints these; the two layers are asserted equal by its tests.
--   * sha256: BLOB of exactly 32 bytes. Never 64-char hex — that doubles every index entry that
--     carries it for no gain, since nothing ever does a prefix match on a hash.
--   * Enums: TEXT + `CHECK (... IN (...))`.
--   * JSON: TEXT + `CHECK (json_valid(...))` plus a length bound. D1 ships the JSON1 extension.
--   * GLOB, never LIKE, for validation: `_` is a LIKE wildcard but a literal in GLOB. D1 caps
--     LIKE/GLOB patterns at 50 bytes; every pattern here is far under that.
--   * Soft delete: a `deleted_at` column ALWAYS comes with a TOTAL unique index on the identity
--     column (so a deleted row keeps reserving its name) AND a partial live index, AND the read
--     path goes through the `live_*` views in 0003 so the predicate is never left to memory.
--   * A CHECK that evaluates to NULL PASSES in SQLite. Any conditional constraint whose left-hand
--     side is nullable therefore uses `IS`, never `=`. Getting this wrong produces a constraint
--     that silently permits exactly the rows it was written to reject.
--   * `WITHOUT ROWID` is applied by ONE rule, not by taste: the table's rows are small and bounded
--     AND the primary key is the access path. That covers `sessions`, `auth_tokens`, `memberships`,
--     `anon_sessions`, `site_claim_tokens`, the Stripe mirror, `content_blobs`, `site_locales`
--     and `usage_counters`, where the row lives IN the primary-key b-tree and a point
--     lookup is a single page read. It deliberately EXCLUDES `organisations`, `sites`,
--     `site_versions`, `pages`, `page_translations`, `media_assets`, `generation_jobs` and `leads`:
--     each has variable-width columns (a 16 KB `jsonld`, an 8 KB lead message, a 2 KB billing
--     address) well past the ~1/20-of-a-page size at which a WITHOUT ROWID primary key starts
--     traversing overflow pages during every index comparison, which costs more than the extra
--     b-tree descent it saves. The cost of the exclusion is one extra descent on a PK lookup plus a
--     duplicate copy of the 30-char key in `sqlite_autoindex_*`; it is accepted knowingly, and it
--     cannot be revisited later because switching a cascade parent to WITHOUT ROWID is a table
--     rebuild, which the MIGRATION RULE above forbids.
-- ============================================================================================

CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL,
  -- Lowercased, gmail-dot-folded form. This is the identity the claim token binds to and the
  -- column prior-trial lookups hit, so it carries both a total and a live unique index below.
  email_normalized  TEXT NOT NULL,
  email_verified_at INTEGER,
  -- Kept as a tripwire, not as storage. Architecture §5.2: authentication is magic link plus
  -- passkeys, forever. The CHECK means any code path that ever tries to write a password hash
  -- aborts at the database instead of quietly introducing a second, weaker first factor.
  password_hash     TEXT CHECK (password_hash IS NULL),
  full_name         TEXT CHECK (full_name IS NULL OR length(full_name) BETWEEN 1 AND 200),
  locale            TEXT NOT NULL DEFAULT 'nl' REFERENCES locales(code) ON DELETE RESTRICT,
  country           TEXT CHECK (country IS NULL OR country GLOB '[A-Z][A-Z]'),
  timezone          TEXT NOT NULL DEFAULT 'Europe/Amsterdam'
                      CHECK (length(timezone) BETWEEN 3 AND 64 AND timezone NOT GLOB '*[^A-Za-z0-9/_+-]*'),
  marketing_opt_in  INTEGER NOT NULL DEFAULT 0 CHECK (marketing_opt_in IN (0,1)),
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','suspended','deleted')),
  last_login_at     INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  CHECK (length(id) = 30 AND id GLOB 'usr_[0-7]*' AND substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  -- Second line of defence only. Zod owns e-mail validation at the Worker boundary; this rejects
  -- the shapes that would corrupt a `mailto:` or an SMTP envelope.
  CHECK (length(email) BETWEEN 6 AND 254 AND email GLOB '?*@?*.?*' AND email NOT GLOB '*[ <>"]*'),
  CHECK (email_normalized = lower(email_normalized)),
  CHECK (deleted_at IS NULL OR status = 'deleted')
) STRICT;

-- TOTAL: a soft-deleted user still reserves the address, so re-registration cannot silently
-- resurrect or collide with an erased identity.
CREATE UNIQUE INDEX uq_users_email_total ON users(email_normalized);
-- Live lookup. Queries that carry `AND deleted_at IS NULL` verbatim seek this one; SQLite's
-- partial-index prover cannot infer the predicate, which is exactly why the read path uses a
-- generated statement rather than a hand-typed WHERE clause.
CREATE UNIQUE INDEX uq_users_email_live ON users(email_normalized) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_created ON users(created_at DESC) WHERE deleted_at IS NULL;

-- The billing and entitlement owner. Created provisionally (zero memberships) during onboarding
-- and de-provisionalised when the claim token is consumed.
CREATE TABLE organisations (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- Which shard database holds this org's sites, versions, pages, media and jobs. Authoritative
  -- here; denormalised onto `sites` in 0003 and kept consistent by a trigger in 0006. This column
  -- and `packages/db/src/shard-router.ts` are the whole of the sharding indirection: adding shard
  -- 001 is a binding plus a constant, never a schema change.
  shard_id          INTEGER NOT NULL DEFAULT 0 CHECK (shard_id >= 0),
  -- 1 until the e-mailed claim link is consumed. A provisional org has no memberships, which is
  -- the isolation invariant: no authenticated path can reach it.
  provisional       INTEGER NOT NULL DEFAULT 1 CHECK (provisional IN (0,1)),
  billing_email     TEXT CHECK (billing_email IS NULL OR length(billing_email) BETWEEN 6 AND 254),
  country           TEXT NOT NULL DEFAULT 'NL' CHECK (country GLOB '[A-Z][A-Z]'),
  vat_number        TEXT CHECK (vat_number IS NULL OR
                      (length(vat_number) BETWEEN 8 AND 20 AND vat_number NOT GLOB '*[^0-9A-Z]*')),
  vat_validated_at  INTEGER,
  billing_address   TEXT CHECK (billing_address IS NULL OR
                      (json_valid(billing_address) AND length(billing_address) <= 2048)),
  plan              TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro')),
  -- Deliberate denormalisation of subscription state. The regenerate paywall must be ONE row read
  -- on the hot path, never a join to `subscriptions`; the Stripe webhook writes both in the same
  -- batch() so they cannot drift (architecture §3c).
  entitlement       TEXT NOT NULL DEFAULT 'none'
                      CHECK (entitlement IN ('none','trialing','active','past_due','canceled')),
  entitlement_until INTEGER,
  sites_limit       INTEGER NOT NULL DEFAULT 1 CHECK (sites_limit > 0),
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','suspended','deleted')),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  CHECK (length(id) = 30 AND id GLOB 'org_[0-7]*' AND substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (deleted_at IS NULL OR status = 'deleted'),
  -- A live entitlement without an expiry is an entitlement nobody can ever revoke by lapse.
  -- `canceled` and `none` are exempt: they may or may not carry a grace deadline.
  CHECK (entitlement NOT IN ('trialing','active','past_due') OR entitlement_until IS NOT NULL)
) STRICT;

-- Drives the "your trial ends in 2 days" and dunning crons without scanning healthy orgs.
CREATE INDEX idx_orgs_entitlement_expiry ON organisations(entitlement_until)
  WHERE entitlement IN ('trialing','past_due');
CREATE INDEX idx_orgs_created ON organisations(created_at DESC) WHERE deleted_at IS NULL;
-- Unclaimed provisional orgs are hard-deleted after 30 days together with their draft and the
-- `drafts/{draft_id}/` R2 prefix (architecture §3b step 8).
CREATE INDEX idx_orgs_provisional ON organisations(created_at) WHERE provisional = 1;

-- user <-> org <-> role. Architecture §5.2: an organisation with zero memberships is unreachable
-- by every authenticated path. That is the tenancy isolation invariant; it is asserted by a test
-- and a lint rule rather than a constraint, because a provisional org must legitimately have none.
CREATE TABLE memberships (
  org_id      TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('owner','admin','editor','viewer')),
  invited_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  accepted_at INTEGER,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
) STRICT, WITHOUT ROWID;

-- Covering: "which orgs do I belong to, and as what" never touches the table b-tree.
CREATE INDEX idx_memberships_user ON memberships(user_id, org_id, role);

-- FOREIGN-KEY CHILD INDEXES. Not for any query.
--
-- SQLite full-scans a child table once per parent row deleted unless the child key column is
-- indexed, and `foreign_key_check` never reports it — the damage is a cron that quietly stops
-- finishing. The daily provisional-organisation purge deletes thousands of parents, so an
-- unindexed child there is thousands of full scans of the busiest tables in the control plane.
--
-- Every FK child column whose parent is deleted IN OPERATION therefore carries one of these,
-- partial on `IS NOT NULL` where the column is nullable: SQLite's prover does infer `col = ?` from
-- that predicate, so the partial form is used for the FK lookup and costs nothing for NULL rows.
--
-- Deliberately NOT indexed: the child columns of `locales`, `industries` and `industry_groups`
-- (`users.locale`, `sites.default_locale`, `onboarding_drafts.ui_locale` / `default_locale` /
-- `industry_key`). Reference data is deactivated with `is_active = 0` and never deleted, so those
-- indexes would cost write throughput on every user, site and draft insert, forever, to speed up
-- an operation that does not happen.
CREATE INDEX idx_memberships_invited_by ON memberships(invited_by) WHERE invited_by IS NOT NULL;
-- At most one owner per org, enforced rather than assumed — ownership transfer is an update, not
-- an insert, and a second owner row would make "who pays" ambiguous.
CREATE UNIQUE INDEX uq_memberships_owner ON memberships(org_id) WHERE role = 'owner';

-- The hottest read in the product. PK is the token hash and the table is WITHOUT ROWID, so the row
-- lives IN the primary-key b-tree and authentication costs a single page read. Raw tokens are
-- never stored.
CREATE TABLE sessions (
  token_hash    BLOB PRIMARY KEY CHECK (length(token_hash) = 32),
  id            TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active_org_id TEXT REFERENCES organisations(id) ON DELETE SET NULL,
  ip_hash       BLOB CHECK (ip_hash IS NULL OR length(ip_hash) = 32),
  user_agent    TEXT CHECK (user_agent IS NULL OR length(user_agent) <= 512),
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  CHECK (length(id) = 30 AND id GLOB 'ses_[0-7]*' AND substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (expires_at > created_at)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_sessions_user ON sessions(user_id, expires_at DESC);
CREATE INDEX idx_sessions_gc   ON sessions(expires_at) WHERE revoked_at IS NULL;
-- FK child index for `organisations` deletes; see the note above `idx_memberships_invited_by`.
CREATE INDEX idx_sessions_org  ON sessions(active_org_id) WHERE active_org_id IS NOT NULL;

-- Magic link and e-mail verification. Single-use, consumed atomically with
-- `UPDATE ... WHERE consumed_at IS NULL` plus an assertion that exactly one row changed
-- (see packages/db/src/batch.ts). D1 has no interactive transactions, so the guard is the WHERE.
--
-- `purpose` deliberately does NOT include site claim: adding a value to this CHECK later would
-- require a 12-step rebuild of a table that is a cascade child of both users and organisations.
-- Site claims get their own table in 0005.
CREATE TABLE auth_tokens (
  token_hash  BLOB PRIMARY KEY CHECK (length(token_hash) = 32),
  id          TEXT NOT NULL,
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL CHECK (length(email) BETWEEN 6 AND 254),
  purpose     TEXT NOT NULL CHECK (purpose IN ('magic_link','email_verify','org_invite')),
  org_id      TEXT REFERENCES organisations(id) ON DELETE CASCADE,
  -- Bounded hard, because this table is WITHOUT ROWID: the row lives in the primary-key b-tree, and
  -- a fat payload column would widen every comparison on the hottest credential lookup there is.
  payload     TEXT CHECK (payload IS NULL OR (json_valid(payload) AND length(payload) <= 512)),
  ip_hash     BLOB CHECK (ip_hash IS NULL OR length(ip_hash) = 32),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  CHECK (length(id) = 30 AND id GLOB 'tok_[0-7]*' AND substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (expires_at > created_at),
  CHECK (purpose <> 'org_invite' OR org_id IS NOT NULL)
) STRICT, WITHOUT ROWID;

-- Send-rate limiting per address, and the "did we already mail this person" check.
CREATE INDEX idx_auth_tokens_email ON auth_tokens(email, purpose, created_at DESC);
CREATE INDEX idx_auth_tokens_gc    ON auth_tokens(expires_at) WHERE consumed_at IS NULL;
-- FK child indexes for `users` and `organisations` deletes.
CREATE INDEX idx_auth_tokens_user  ON auth_tokens(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_auth_tokens_org   ON auth_tokens(org_id)  WHERE org_id IS NOT NULL;
