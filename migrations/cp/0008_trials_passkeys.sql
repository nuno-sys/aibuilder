-- ============================================================================================
-- migrations/cp/0008_trials_passkeys.sql     database: aibuilder-cp
--
-- PURPOSE
--   Two things the trial-first funnel and the dashboard need:
--     trial_grants          the ledger that makes "one trial per identity" enforceable
--     webauthn_credentials  passkeys, offered as an upgrade at first login
--   plus three columns on `sessions` for the authentication method and the in-flight WebAuthn
--   challenge.
--
-- WHY `trial_grants` IS A TABLE AND NOT A VIEW OVER `stripe_customers`
--   `stripe_customers.org_id` is ON DELETE RESTRICT, so those rows go when a provisional
--   organisation is purged — taking the evidence with them, which is exactly when it is needed.
--   `trial_grants` deliberately has NO foreign key to `organisations`, so it outlives the purge.
--   The alternative — a `card` value on `abuse_events.subject_type` — is a CHECK widening, i.e. a
--   table rebuild, for no benefit.
--
-- PRIVACY
--   The card fingerprint is stored as sha256(fingerprint || TRIAL_FINGERPRINT_PEPPER), never in the
--   clear. It is a stable identifier for a payment instrument and is therefore pseudonymous
--   personal data under the same reading architecture §8 applies to `ip_hash`. It is listed as such
--   in the ROPA, and the pepper lives in Secrets Store.
--
-- MIGRATION RULE (architecture §5.4). A cascade-parent table can NEVER be rebuilt in place on D1.
--   Adding a table is always safe; ADD COLUMN never rebuilds. Nothing here is rebuilt. `sessions`
--   is a cascade child only.
-- ============================================================================================

CREATE TABLE trial_grants (
  id                      TEXT PRIMARY KEY,
  email_normalized        TEXT NOT NULL CHECK (email_normalized = lower(email_normalized)),
  card_fingerprint_sha256 BLOB CHECK (card_fingerprint_sha256 IS NULL
                            OR length(card_fingerprint_sha256) = 32),
  -- No FK, by design: this row must survive the organisation it describes.
  org_id                  TEXT,
  stripe_customer_id      TEXT,
  stripe_subscription_id  TEXT,
  outcome                 TEXT NOT NULL DEFAULT 'granted'
                            CHECK (outcome IN ('granted','converted','churned','refused','disputed')),
  granted_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  CHECK (length(id) = 30 AND id GLOB 'trg_[0-7]*'
         AND substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
) STRICT;

CREATE INDEX idx_trial_grants_email ON trial_grants(email_normalized, granted_at DESC);
CREATE INDEX idx_trial_grants_card  ON trial_grants(card_fingerprint_sha256, granted_at DESC)
  WHERE card_fingerprint_sha256 IS NOT NULL;

-- `SQL_INSERT_TRIAL_GRANT` ends in a bare `ON CONFLICT DO NOTHING` that leans on this index: a
-- redelivery whose claim token expired re-runs the batch with a freshly minted id, and without the
-- index the ledger would hold two grants for one subscription while `SQL_SET_TRIAL_OUTCOME` updated
-- both.
CREATE UNIQUE INDEX uq_trial_grants_subscription ON trial_grants(stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

-- The default is 'claim_link' so every Phase 1 row and the Phase 1 code path stay valid with no
-- backfill.
ALTER TABLE sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'claim_link'
  CHECK (auth_method IN ('claim_link','checkout_return','magic_link','passkey'));
ALTER TABLE sessions ADD COLUMN pending_challenge BLOB
  CHECK (pending_challenge IS NULL OR length(pending_challenge) BETWEEN 16 AND 64);
ALTER TABLE sessions ADD COLUMN pending_challenge_expires_at INTEGER;

CREATE TABLE webauthn_credentials (
  credential_id BLOB PRIMARY KEY CHECK (length(credential_id) BETWEEN 16 AND 1023),
  id            TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key    BLOB NOT NULL CHECK (length(public_key) BETWEEN 32 AND 1024),
  counter       INTEGER NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports    TEXT CHECK (transports IS NULL OR
                  (json_valid(transports) AND json_type(transports) = 'array'
                   AND length(transports) <= 128)),
  aaguid        TEXT CHECK (aaguid IS NULL OR length(aaguid) = 36),
  backed_up     INTEGER NOT NULL DEFAULT 0 CHECK (backed_up IN (0,1)),
  device_type   TEXT CHECK (device_type IS NULL OR device_type IN ('singleDevice','multiDevice')),
  nickname      TEXT CHECK (nickname IS NULL OR length(nickname) BETWEEN 1 AND 64),
  -- THE ONE-WAY DOOR (architecture §10 item 7). Recorded per credential so that a future rpID
  -- change is DETECTABLE rather than silently unrecoverable: broadening rpID to an apex after a PSL
  -- entry lands invalidates every credential ever registered, with no recovery path.
  rp_id         TEXT NOT NULL CHECK (length(rp_id) BETWEEN 3 AND 253 AND rp_id = lower(rp_id)),
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  CHECK (length(id) = 30 AND id GLOB 'pky_[0-7]*'
         AND substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
) STRICT, WITHOUT ROWID;

CREATE UNIQUE INDEX uq_webauthn_id    ON webauthn_credentials(id);
CREATE INDEX        idx_webauthn_user ON webauthn_credentials(user_id, created_at DESC);
