-- ============================================================================================
-- migrations/cp/0005_drafts_claims.sql     database: aibuilder-cp
--
-- PURPOSE
--   The pre-account half of onboarding, plus the two ops-signal tables that watch it.
--     anon_sessions      — cookie identity for a visitor who has no user row yet, 7-day TTL.
--     onboarding_drafts  — the server-side draft. Also the Phase 1 system of record for the
--                          business facts, which is why the E.164 and address columns are typed
--                          and CHECK-constrained here rather than buried in a JSON blob.
--     site_claim_tokens  — the single-use link that turns a provisional org into a real one.
--     abuse_events       — the funnel's telemetry, feeding the daily digest.
--     csp_reports        — aggregated, never one row per report.
--
-- WHY THE FACTS LIVE HERE
--   Architecture §5.2 pins `sites` to identity and routing, §5.3 has no facts table, and §3a keeps
--   D1 off the tenant request path entirely. So the intake is captured here with real constraints,
--   publish projects it into `SiteDoc.facts` in R2, and the renderer reads only R2 and KV. §4
--   invariant 2 — "the model cannot author a URL" — depends on `tel:` and `wa.me` hrefs being built
--   by code from the CHECK-constrained `phone_e164` column below, so that CHECK is load-bearing.
--   Phase 2's editor moves the editable copy into `SiteDraftDO` and writes back through here.
--
-- MIGRATION RULE (architecture §5.4). A cascade-parent table can NEVER be rebuilt in place on D1.
--   `PRAGMA foreign_keys=OFF` is unsupported and `defer_foreign_keys` defers constraint *checking*,
--   not FK *actions*: the 12-step rebuild cascade-deletes every child and `foreign_key_check`
--   reports success afterwards. Expand -> migrate -> contract with `ALTER TABLE ADD/DROP/RENAME
--   COLUMN` only. `anon_sessions` is a cascade parent of `onboarding_drafts`.
--
-- RETENTION
--   An unclaimed draft is hard-deleted after 30 days together with its `drafts/{draft_id}/` R2
--   prefix (architecture §3b step 8). A claimed draft is retained as the fact source. Both are
--   driven by `purge_after`, which is NOT NULL so the purge cron can never miss a row.
-- ============================================================================================

-- Pre-account ownership of a draft. The `__Host-aib_draft` cookie carries an opaque token; only
-- its hash is stored, so a database read cannot mint a cookie.
CREATE TABLE anon_sessions (
  token_hash   BLOB PRIMARY KEY CHECK (length(token_hash) = 32),
  id           TEXT NOT NULL,
  ip_hash      BLOB CHECK (ip_hash IS NULL OR length(ip_hash) = 32),
  ip_country   TEXT CHECK (ip_country IS NULL OR ip_country GLOB '[A-Z][A-Z]'),
  user_agent   TEXT CHECK (user_agent IS NULL OR length(user_agent) <= 512),
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER,
  CHECK (length(id) = 30 AND id GLOB 'ans_[0-7]*' AND substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (expires_at > created_at)
) STRICT, WITHOUT ROWID;

-- The parent key of `onboarding_drafts.anon_session_id`. SQLite requires a unique index on the
-- referenced column, and the PK here is the token hash rather than the id.
CREATE UNIQUE INDEX uq_anon_sessions_id ON anon_sessions(id);
CREATE INDEX idx_anon_sessions_gc ON anon_sessions(expires_at) WHERE revoked_at IS NULL;

CREATE TABLE onboarding_drafts (
  id                 TEXT PRIMARY KEY,
  anon_session_id    TEXT NOT NULL REFERENCES anon_sessions(id) ON DELETE CASCADE,
  -- Assigned at draft creation, BEFORE an organisation exists, because media uploads are committed
  -- to a shard during step 4 of the modal. The organisation inherits this value at submit, which
  -- is what keeps a tenant's drafts, media, versions and jobs on one database.
  shard_id           INTEGER NOT NULL DEFAULT 0 CHECK (shard_id >= 0),
  status             TEXT NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','submitted','claimed','abandoned','rejected')),
  -- UI language of the modal. Independent of `default_locale`, which is the language of the
  -- generated site.
  ui_locale          TEXT NOT NULL REFERENCES locales(code) ON DELETE RESTRICT,
  step               INTEGER NOT NULL DEFAULT 1 CHECK (step BETWEEN 1 AND 12),
  furthest_step      INTEGER NOT NULL DEFAULT 1 CHECK (furthest_step BETWEEN 1 AND 12),

  -- ---- intake (§S5 IntakeSchema). Every column is nullable: a draft is partial by definition and
  -- ---- completeness is proven by Zod at submit, not by NOT NULL here. -------------------------
  business_name      TEXT CHECK (business_name IS NULL OR length(business_name) BETWEEN 2 AND 120),
  slug               TEXT CHECK (slug IS NULL OR
                       (length(slug) BETWEEN 3 AND 63
                        AND slug NOT GLOB '*[^a-z0-9-]*'
                        AND slug GLOB '[a-z0-9]*'
                        AND slug NOT GLOB '*-'
                        AND slug NOT GLOB '*--*')),
  industry_key       TEXT REFERENCES industries(key) ON DELETE RESTRICT,
  default_locale     TEXT REFERENCES locales(code) ON DELETE RESTRICT,
  -- Phase 1 allows at most one extra locale; the array shape is already right for Phase 2 fan-out.
  extra_locales      TEXT CHECK (extra_locales IS NULL OR
                       (json_valid(extra_locales) AND json_type(extra_locales) = 'array'
                        AND json_array_length(extra_locales) <= 5 AND length(extra_locales) <= 64)),
  service_area_city  TEXT CHECK (service_area_city IS NULL OR length(service_area_city) BETWEEN 1 AND 80),
  service_area_radius_km INTEGER CHECK (service_area_radius_km IS NULL OR
                       service_area_radius_km IN (5,10,25,50)),
  address_line1      TEXT CHECK (address_line1 IS NULL OR length(address_line1) BETWEEN 1 AND 120),
  address_line2      TEXT CHECK (address_line2 IS NULL OR length(address_line2) <= 120),
  postal_code        TEXT CHECK (postal_code IS NULL OR length(postal_code) BETWEEN 2 AND 16),
  city               TEXT CHECK (city IS NULL OR length(city) BETWEEN 1 AND 80),
  country            TEXT CHECK (country IS NULL OR country GLOB '[A-Z][A-Z]'),
  latitude           REAL CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude          REAL CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  geo_source         TEXT NOT NULL DEFAULT 'none'
                       CHECK (geo_source IN ('none','geocoded','user_pin')),
  opening_hours      TEXT CHECK (opening_hours IS NULL OR
                       (json_valid(opening_hours) AND length(opening_hours) <= 4096)),
  -- E.164, anchored on BOTH ends. A permissive `GLOB '+[0-9]*'` accepts `+31<script>`, which then
  -- lands in a `wa.me` href and in the JSON-LD `telephone` field. The negated class on the digits
  -- after the leading `+` is what makes this a real constraint.
  phone_e164         TEXT CHECK (phone_e164 IS NULL OR
                       (length(phone_e164) BETWEEN 8 AND 16
                        AND phone_e164 GLOB '+[1-9]*'
                        AND substr(phone_e164, 2) NOT GLOB '*[^0-9]*')),
  whatsapp_e164      TEXT CHECK (whatsapp_e164 IS NULL OR
                       (length(whatsapp_e164) BETWEEN 8 AND 16
                        AND whatsapp_e164 GLOB '+[1-9]*'
                        AND substr(whatsapp_e164, 2) NOT GLOB '*[^0-9]*')),
  -- Stored for JSON-LD `sameAs` and NEVER fetched. No GLOB on the scheme: a prefix test is not
  -- URL parsing, and pretending otherwise invites `https://evil@real.example`. The API parses it
  -- with `new URL()` and enforces the https-only scheme allowlist (§4 invariant 2).
  gbp_url            TEXT CHECK (gbp_url IS NULL OR length(gbp_url) BETWEEN 12 AND 500),
  short_description  TEXT CHECK (short_description IS NULL OR length(short_description) <= 600),
  contact_email      TEXT CHECK (contact_email IS NULL OR
                       (length(contact_email) BETWEEN 6 AND 254
                        AND contact_email GLOB '?*@?*.?*'
                        AND contact_email NOT GLOB '*[ <>"]*')),
  marketing_opt_in   INTEGER NOT NULL DEFAULT 0 CHECK (marketing_opt_in IN (0,1)),
  -- Media ids live on the shard; this is the ordered selection the modal made, capped at 12.
  media_ids          TEXT CHECK (media_ids IS NULL OR
                       (json_valid(media_ids) AND json_type(media_ids) = 'array'
                        AND json_array_length(media_ids) <= 12 AND length(media_ids) <= 512)),

  -- ---- server-minted, never accepted from or returned to the client -------------------------
  -- Architecture §S4: the client cannot supply an Idempotency-Key. This value is crypto-random,
  -- minted at draft creation, and is what `generation_jobs.uq_jobs_idem` keys on together with the
  -- org id, so a replayed submit can never bill twice and can never probe another tenant's keys.
  idempotency_key    TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 64
                       AND idempotency_key NOT GLOB '*[^0-9A-Za-z_-]*'),
  turnstile_verified_at INTEGER,
  -- Haiku 4.5 intake policy screen (~$0.001), run before any Opus spend.
  policy_screen      TEXT NOT NULL DEFAULT 'pending'
                       CHECK (policy_screen IN ('pending','pass','reject','error')),
  policy_reason      TEXT CHECK (policy_reason IS NULL OR length(policy_reason) <= 500),
  -- Set by submit. Both rows are created in the same control-plane batch(); the job itself lives
  -- on the shard, so `generation_job_id` is a plain prefixed id with no FK.
  site_id            TEXT REFERENCES sites(id) ON DELETE SET NULL,
  org_id             TEXT REFERENCES organisations(id) ON DELETE SET NULL,
  generation_job_id  TEXT CHECK (generation_job_id IS NULL OR
                       (length(generation_job_id) = 30
                        AND generation_job_id GLOB 'job_[0-7]*'
                        AND substr(generation_job_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
  ip_hash            BLOB CHECK (ip_hash IS NULL OR length(ip_hash) = 32),
  ip_country         TEXT CHECK (ip_country IS NULL OR ip_country GLOB '[A-Z][A-Z]'),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  submitted_at       INTEGER,
  -- Hard-delete deadline for the row AND the `drafts/{id}/` R2 prefix. NOT NULL so the purge cron
  -- has no "rows I forgot about" class.
  purge_after        INTEGER NOT NULL,
  CHECK (length(id) = 30 AND id GLOB 'drf_[0-7]*' AND substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (furthest_step >= step),
  CHECK (purge_after > created_at),
  CHECK (status <> 'submitted' OR (submitted_at IS NOT NULL AND site_id IS NOT NULL
                                   AND org_id IS NOT NULL AND generation_job_id IS NOT NULL)),
  -- Address OR service area, the same `refine` the intake Zod schema applies — asserted here only
  -- once the draft claims to be complete, because a partial draft legitimately has neither.
  CHECK (status = 'open' OR address_line1 IS NOT NULL OR service_area_city IS NOT NULL)
) STRICT;

-- "Whose draft is this cookie?" — one seek, and the only way in without the draft id.
CREATE INDEX idx_drafts_anon    ON onboarding_drafts(anon_session_id, updated_at DESC);
CREATE INDEX idx_drafts_purge   ON onboarding_drafts(purge_after);
CREATE INDEX idx_drafts_site    ON onboarding_drafts(site_id) WHERE site_id IS NOT NULL;
-- Funnel analytics and the abandoned-draft nudge, without scanning submitted drafts.
CREATE INDEX idx_drafts_open    ON onboarding_drafts(updated_at) WHERE status = 'open';
-- Submit is idempotent on this key; the uniqueness that matters is on the shard's job row, but a
-- duplicate here would mean two orgs sharing one key, so it is prevented at the source.
CREATE UNIQUE INDEX uq_drafts_idempotency ON onboarding_drafts(idempotency_key);
-- FK child index; see the note above `idx_memberships_invited_by` in 0001_identity.sql.
CREATE INDEX idx_drafts_org ON onboarding_drafts(org_id) WHERE org_id IS NOT NULL;

-- Site claim. Separate from `auth_tokens` because adding a value to that table's `purpose` CHECK
-- would require a 12-step rebuild of a cascade child of both `users` and `organisations`
-- (architecture §5.2). Single-use, bound to `email_normalized`, 72 h, consumed atomically with
-- `UPDATE ... WHERE consumed_at IS NULL` and `meta.changes === 1`.
CREATE TABLE site_claim_tokens (
  token_hash       BLOB PRIMARY KEY CHECK (length(token_hash) = 32),
  id               TEXT NOT NULL,
  site_id          TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  org_id           TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  draft_id         TEXT REFERENCES onboarding_drafts(id) ON DELETE SET NULL,
  email_normalized TEXT NOT NULL CHECK (email_normalized = lower(email_normalized)
                     AND length(email_normalized) BETWEEN 6 AND 254),
  -- Sending a claim invitation to a third-party address typed into the modal is a spam
  -- amplification vector and a sender-reputation risk (architecture §10 risk 7), so resends are
  -- counted and capped by the API rather than being unbounded.
  send_count       INTEGER NOT NULL DEFAULT 1 CHECK (send_count BETWEEN 1 AND 5),
  last_sent_at     INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  consumed_at      INTEGER,
  consumed_ip_hash BLOB CHECK (consumed_ip_hash IS NULL OR length(consumed_ip_hash) = 32),
  CHECK (length(id) = 30 AND id GLOB 'clm_[0-7]*' AND substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (expires_at > created_at)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_claim_tokens_site  ON site_claim_tokens(site_id, created_at DESC);
CREATE INDEX idx_claim_tokens_email ON site_claim_tokens(email_normalized, created_at DESC);
CREATE INDEX idx_claim_tokens_gc    ON site_claim_tokens(expires_at) WHERE consumed_at IS NULL;
-- FK child index; see the note above `idx_memberships_invited_by` in 0001_identity.sql. The draft one is load-bearing: the 30-day
-- draft purge deletes thousands of parents a day, and without it each one scans this table.
CREATE INDEX idx_claim_tokens_org   ON site_claim_tokens(org_id);
CREATE INDEX idx_claim_tokens_draft ON site_claim_tokens(draft_id) WHERE draft_id IS NOT NULL;

-- Ops signal, not an audit trail. Append-only, INTEGER rowid so inserts land at the right edge of
-- the b-tree and `ORDER BY id DESC` needs no sort step. AUTOINCREMENT rather than a bare rowid so
-- ids are never reused after a purge.
CREATE TABLE abuse_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ulid         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN
                 ('turnstile_fail','rate_limited','quota_exceeded','policy_reject','slug_blocked',
                  'homoglyph_blocked','media_quarantined','url_reputation','manual_report',
                  'takedown','budget_deferred')),
  severity     TEXT NOT NULL DEFAULT 'warn' CHECK (severity IN ('info','warn','block')),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('ip','draft','org','site','email','phone','host')),
  -- sha256 of the subject with the daily salt. Pseudonymous personal data, treated as such in the
  -- ROPA and in the generated privacy policy — not "not personal data".
  subject_hash BLOB NOT NULL CHECK (length(subject_hash) = 32),
  site_id      TEXT REFERENCES sites(id) ON DELETE SET NULL,
  org_id       TEXT REFERENCES organisations(id) ON DELETE SET NULL,
  detail       TEXT CHECK (detail IS NULL OR (json_valid(detail) AND length(detail) <= 4096)),
  created_at   INTEGER NOT NULL,
  purge_after  INTEGER NOT NULL,
  CHECK (length(ulid) = 30 AND ulid GLOB 'abs_[0-7]*' AND substr(ulid, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (purge_after > created_at)
) STRICT;

-- Covering for the escalation read: "how many warn-or-block signals has this subject produced since
-- T". `severity` is last so the count never needs a table lookup.
CREATE INDEX idx_abuse_subject
  ON abuse_events(subject_type, subject_hash, created_at DESC, severity);
CREATE INDEX idx_abuse_digest  ON abuse_events(created_at, kind, severity);
CREATE INDEX idx_abuse_site    ON abuse_events(site_id, id DESC) WHERE site_id IS NOT NULL;
CREATE INDEX idx_abuse_purge   ON abuse_events(purge_after);
-- FK child index; see the note above `idx_memberships_invited_by` in 0001_identity.sql.
CREATE INDEX idx_abuse_org     ON abuse_events(org_id) WHERE org_id IS NOT NULL;

-- CSP violation reports, AGGREGATED. One row per (host, directive, blocked uri) with a counter,
-- never one row per report: a report-uri endpoint is an unauthenticated write amplifier and a
-- misbehaving extension can emit thousands per page view. The handler UPSERTs.
CREATE TABLE csp_reports (
  host                TEXT NOT NULL,
  violated_directive  TEXT NOT NULL CHECK (length(violated_directive) BETWEEN 1 AND 100),
  blocked_uri         TEXT NOT NULL CHECK (length(blocked_uri) <= 500),
  effective_directive TEXT CHECK (effective_directive IS NULL OR length(effective_directive) <= 100),
  disposition         TEXT NOT NULL DEFAULT 'enforce' CHECK (disposition IN ('enforce','report')),
  document_uri        TEXT CHECK (document_uri IS NULL OR length(document_uri) <= 500),
  script_sample       TEXT CHECK (script_sample IS NULL OR length(script_sample) <= 200),
  occurrences         INTEGER NOT NULL DEFAULT 1 CHECK (occurrences > 0),
  first_seen_at       INTEGER NOT NULL,
  last_seen_at        INTEGER NOT NULL,
  CHECK (length(host) BETWEEN 4 AND 253 AND host = lower(host) AND host NOT GLOB '*[^a-z0-9.:-]*'),
  CHECK (last_seen_at >= first_seen_at)
) STRICT;

-- A rowid table with a UNIQUE index, NOT a WITHOUT ROWID table keyed on the same three columns.
-- `blocked_uri` is up to 500 bytes, so that primary key would put a ~1 KB row inside the key b-tree
-- and make every index comparison traverse overflow pages. The UNIQUE index gives the UPSERT its
-- conflict target at a fraction of the width.
CREATE UNIQUE INDEX uq_csp_key ON csp_reports(host, violated_directive, blocked_uri);
CREATE INDEX idx_csp_recent ON csp_reports(last_seen_at DESC, occurrences DESC);
