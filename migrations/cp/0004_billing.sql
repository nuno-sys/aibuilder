-- ============================================================================================
-- migrations/cp/0004_billing.sql           database: aibuilder-cp
--
-- PURPOSE
--   The Stripe mirror. Stripe is the source of truth; D1 is a queryable replica that exists so the
--   paywall, the dunning cron and the invoice list are local reads. Nothing in this file is on a
--   request-critical path except `organisations.entitlement`, which lives in 0001 precisely
--   because the paywall must be one row read and never a join into this file.
--
--   Phase 2 owns the code that writes these tables (architecture §9). The schema ships in Phase 1
--   because every table here is a cascade child of `organisations`, and adding a cascade child
--   later is free while restructuring one is not.
--
-- MIGRATION RULE (architecture §5.4). A cascade-parent table can NEVER be rebuilt in place on D1:
--   `PRAGMA foreign_keys=OFF` is unsupported, `defer_foreign_keys` defers constraint *checking*
--   and not FK *actions*, and the 12-step rebuild therefore cascade-deletes children while
--   `foreign_key_check` still passes. Expand -> migrate -> contract, using only
--   `ALTER TABLE ADD/DROP/RENAME COLUMN`. `stripe_customers` is a cascade parent of `subscriptions`.
--
-- ORDERING
--   Stripe does not guarantee webhook delivery order. Every mutation here is guarded by
--   `WHERE stripe_updated_at < :event_created_ms`, and the handler re-reads the object from the
--   Stripe API before persisting, which makes ordering irrelevant rather than merely unlikely.
-- ============================================================================================

CREATE TABLE stripe_customers (
  stripe_customer_id TEXT PRIMARY KEY,
  -- RESTRICT, not CASCADE: an organisation with a live billing relationship may not be deleted.
  -- Cancel in Stripe first. Silently orphaning a paying customer is a business-critical bug, and
  -- `ON DELETE CASCADE` here would make it a one-statement accident.
  org_id             TEXT NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  email              TEXT CHECK (email IS NULL OR length(email) BETWEEN 6 AND 254),
  default_pm_brand   TEXT CHECK (default_pm_brand IS NULL OR length(default_pm_brand) <= 32),
  default_pm_last4   TEXT CHECK (default_pm_last4 IS NULL OR
                       (length(default_pm_last4) = 4 AND default_pm_last4 NOT GLOB '*[^0-9]*')),
  -- Stripe's `card.fingerprint`. Prior-trial lookup runs on e-mail AND on this, which is what
  -- actually stops "new address, same card" trial farming (architecture §3c step 4).
  default_pm_fingerprint TEXT CHECK (default_pm_fingerprint IS NULL OR length(default_pm_fingerprint) <= 64),
  tax_country        TEXT CHECK (tax_country IS NULL OR tax_country GLOB '[A-Z][A-Z]'),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  CHECK (stripe_customer_id GLOB 'cus_*' AND length(stripe_customer_id) BETWEEN 8 AND 64
         AND stripe_customer_id NOT GLOB '*[^0-9A-Za-z_]*')
) STRICT, WITHOUT ROWID;

CREATE UNIQUE INDEX uq_stripe_customers_org ON stripe_customers(org_id);
CREATE INDEX idx_stripe_customers_fingerprint ON stripe_customers(default_pm_fingerprint)
  WHERE default_pm_fingerprint IS NOT NULL;

CREATE TABLE subscriptions (
  stripe_subscription_id TEXT PRIMARY KEY,
  org_id                 TEXT NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  stripe_customer_id     TEXT NOT NULL
                           REFERENCES stripe_customers(stripe_customer_id) ON DELETE RESTRICT,
  status                 TEXT NOT NULL CHECK (status IN
                           ('trialing','active','past_due','canceled','incomplete',
                            'incomplete_expired','unpaid','paused')),
  stripe_price_id        TEXT NOT NULL CHECK (length(stripe_price_id) BETWEEN 6 AND 64),
  stripe_product_id      TEXT CHECK (stripe_product_id IS NULL OR length(stripe_product_id) <= 64),
  currency               TEXT NOT NULL DEFAULT 'eur'
                           CHECK (length(currency) = 3 AND currency = lower(currency)),
  unit_amount_cents      INTEGER NOT NULL CHECK (unit_amount_cents >= 0),
  billing_interval       TEXT NOT NULL DEFAULT 'year' CHECK (billing_interval IN ('month','year')),
  interval_count         INTEGER NOT NULL DEFAULT 1 CHECK (interval_count > 0),
  quantity               INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  trial_start            INTEGER,
  trial_end              INTEGER,
  current_period_start   INTEGER,
  current_period_end     INTEGER,
  cancel_at_period_end   INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0,1)),
  canceled_at            INTEGER,
  ended_at               INTEGER,
  latest_invoice_id      TEXT CHECK (latest_invoice_id IS NULL OR length(latest_invoice_id) <= 64),
  collection_method      TEXT NOT NULL DEFAULT 'charge_automatically'
                           CHECK (collection_method IN ('charge_automatically','send_invoice')),
  -- Out-of-order webhook guard; see ORDERING in the header.
  stripe_updated_at      INTEGER NOT NULL DEFAULT 0,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  CHECK (stripe_subscription_id GLOB 'sub_*' AND length(stripe_subscription_id) BETWEEN 8 AND 64
         AND stripe_subscription_id NOT GLOB '*[^0-9A-Za-z_]*'),
  CHECK (trial_end IS NULL OR trial_start IS NULL OR trial_end > trial_start),
  CHECK (current_period_end IS NULL OR current_period_start IS NULL
         OR current_period_end > current_period_start),
  CHECK (status <> 'canceled' OR canceled_at IS NOT NULL)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_subs_org_status   ON subscriptions(org_id, status);
-- "Your trial ends in 2 days" cron: touches only trialing rows.
CREATE INDEX idx_subs_trial_ending ON subscriptions(trial_end) WHERE status = 'trialing';
CREATE INDEX idx_subs_period_end   ON subscriptions(current_period_end)
  WHERE status IN ('active','past_due');
CREATE INDEX idx_subs_customer     ON subscriptions(stripe_customer_id, status);

-- Webhook idempotency and the processing ledger.
--
-- The handler inserts BEFORE processing and then claims the row with a token, not with a bare
-- status test: D1 has no interactive transactions, so two concurrent redeliveries both pass
-- `WHERE status <> 'processed'` and both run the side effects. The claim is
--   UPDATE stripe_events SET status='processing', claim_token=?, claim_expires_at=?
--    WHERE stripe_event_id=? AND (status='received' OR (status='processing' AND claim_expires_at < ?))
-- with `meta.changes === 1` asserted. A crashed handler's claim expires and is re-claimable.
CREATE TABLE stripe_events (
  stripe_event_id   TEXT PRIMARY KEY,
  type              TEXT NOT NULL CHECK (length(type) BETWEEN 3 AND 100),
  api_version       TEXT CHECK (api_version IS NULL OR length(api_version) <= 32),
  livemode          INTEGER NOT NULL DEFAULT 1 CHECK (livemode IN (0,1)),
  stripe_created_at INTEGER NOT NULL,
  object_id         TEXT CHECK (object_id IS NULL OR length(object_id) <= 64),
  org_id            TEXT REFERENCES organisations(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'received'
                      CHECK (status IN ('received','processing','processed','failed','skipped')),
  claim_token       BLOB CHECK (claim_token IS NULL OR length(claim_token) = 16),
  claim_expires_at  INTEGER,
  attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 25),
  -- Bounded at 1 KB: WITHOUT ROWID puts this row in the primary-key b-tree, which the webhook
  -- idempotency check reads on every single delivery. The full error goes to the log, not here.
  last_error        TEXT CHECK (last_error IS NULL OR length(last_error) <= 1000),
  -- The raw event JSON is archived to R2; only its hash is kept here. A Stripe event can exceed
  -- D1's 2 MB row cap outright.
  payload_sha256    BLOB CHECK (payload_sha256 IS NULL OR length(payload_sha256) = 32),
  received_at       INTEGER NOT NULL,
  processed_at      INTEGER,
  CHECK (stripe_event_id GLOB 'evt_*' AND length(stripe_event_id) BETWEEN 8 AND 64
         AND stripe_event_id NOT GLOB '*[^0-9A-Za-z_]*'),
  CHECK (status <> 'processed' OR processed_at IS NOT NULL),
  CHECK (status <> 'processing' OR (claim_token IS NOT NULL AND claim_expires_at IS NOT NULL))
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_stripe_events_retry  ON stripe_events(received_at)
  WHERE status IN ('received','processing','failed');
CREATE INDEX idx_stripe_events_object ON stripe_events(object_id, stripe_created_at DESC)
  WHERE object_id IS NOT NULL;
CREATE INDEX idx_stripe_events_gc     ON stripe_events(received_at) WHERE status = 'processed';
-- FK child index; see the note above `idx_memberships_invited_by` in 0001_identity.sql.
CREATE INDEX idx_stripe_events_org    ON stripe_events(org_id) WHERE org_id IS NOT NULL;

CREATE TABLE invoices (
  stripe_invoice_id      TEXT PRIMARY KEY,
  org_id                 TEXT NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  stripe_subscription_id TEXT REFERENCES subscriptions(stripe_subscription_id) ON DELETE SET NULL,
  number                 TEXT CHECK (number IS NULL OR length(number) <= 64),
  status                 TEXT NOT NULL
                           CHECK (status IN ('draft','open','paid','void','uncollectible')),
  currency               TEXT NOT NULL DEFAULT 'eur'
                           CHECK (length(currency) = 3 AND currency = lower(currency)),
  subtotal_cents         INTEGER NOT NULL DEFAULT 0,
  tax_cents              INTEGER NOT NULL DEFAULT 0,
  total_cents            INTEGER NOT NULL DEFAULT 0,
  amount_paid_cents      INTEGER NOT NULL DEFAULT 0 CHECK (amount_paid_cents >= 0),
  hosted_invoice_url     TEXT CHECK (hosted_invoice_url IS NULL OR length(hosted_invoice_url) <= 500),
  invoice_pdf_url        TEXT CHECK (invoice_pdf_url IS NULL OR length(invoice_pdf_url) <= 500),
  period_start           INTEGER,
  period_end             INTEGER,
  issued_at              INTEGER NOT NULL,
  paid_at                INTEGER,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  CHECK (stripe_invoice_id GLOB 'in_*' AND length(stripe_invoice_id) BETWEEN 8 AND 64
         AND stripe_invoice_id NOT GLOB '*[^0-9A-Za-z_]*'),
  CHECK (status <> 'paid' OR paid_at IS NOT NULL)
) STRICT, WITHOUT ROWID;

-- Narrow on purpose. `invoice_pdf_url` was in this projection and is up to 500 bytes; SQLite
-- stores the full key in EVERY index entry, so including it would duplicate half a kilobyte per
-- invoice into the b-tree to save 25 table lookups on a page nobody loads twice. Same mistake,
-- same fix, as keeping page payloads out of `idx_page_tr_enumerate` in the shard.
CREATE INDEX idx_invoices_org ON invoices(org_id, issued_at DESC, status, total_cents);
-- FK child index; see the note above `idx_memberships_invited_by` in 0001_identity.sql.
CREATE INDEX idx_invoices_subscription ON invoices(stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;
