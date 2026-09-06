-- 0002_billing.sql  -- Stripe mirror. Source of truth is Stripe; D1 is a queryable replica.

CREATE TABLE stripe_customers (
  stripe_customer_id TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  email              TEXT,
  default_pm_brand   TEXT,
  default_pm_last4   TEXT CHECK (default_pm_last4 IS NULL OR length(default_pm_last4) = 4),
  tax_country        TEXT CHECK (tax_country IS NULL OR tax_country GLOB '[A-Z][A-Z]'),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  CHECK (stripe_customer_id GLOB 'cus_*')
) STRICT, WITHOUT ROWID;

-- RESTRICT, not CASCADE: you may not delete an org that still has a billing relationship.
-- Cancel in Stripe first. Silent orphaning of paying customers is a business-critical bug.
CREATE UNIQUE INDEX uq_stripe_customers_org ON stripe_customers(org_id);

CREATE TABLE subscriptions (
  stripe_subscription_id TEXT PRIMARY KEY,
  org_id                 TEXT NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  stripe_customer_id     TEXT NOT NULL
                           REFERENCES stripe_customers(stripe_customer_id) ON DELETE RESTRICT,
  status                 TEXT NOT NULL CHECK (status IN
                           ('trialing','active','past_due','canceled',
                            'incomplete','incomplete_expired','unpaid','paused')),
  stripe_price_id        TEXT NOT NULL,
  stripe_product_id      TEXT,
  currency               TEXT NOT NULL DEFAULT 'eur'
                           CHECK (currency = lower(currency) AND length(currency) = 3),
  unit_amount_cents      INTEGER NOT NULL CHECK (unit_amount_cents >= 0), -- 11988 = EUR 119,88/yr
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
  latest_invoice_id      TEXT,
  collection_method      TEXT NOT NULL DEFAULT 'charge_automatically'
                           CHECK (collection_method IN ('charge_automatically','send_invoice')),
  -- Out-of-order webhook guard. Stripe does NOT guarantee delivery order.
  -- Every mutation is: UPDATE ... WHERE stripe_updated_at < :event_created_ms
  stripe_updated_at      INTEGER NOT NULL DEFAULT 0,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  CHECK (stripe_subscription_id GLOB 'sub_*'),
  CHECK (trial_end IS NULL OR trial_start IS NULL OR trial_end > trial_start),
  CHECK (current_period_end IS NULL OR current_period_start IS NULL
         OR current_period_end > current_period_start)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_subs_org_status    ON subscriptions(org_id, status);
-- Drives the "your trial ends in 2 days" cron: scans ONLY trialing rows.
CREATE INDEX idx_subs_trial_ending  ON subscriptions(trial_end) WHERE status = 'trialing';
CREATE INDEX idx_subs_period_end    ON subscriptions(current_period_end)
  WHERE status IN ('active','past_due');
CREATE INDEX idx_subs_customer      ON subscriptions(stripe_customer_id, status);

-- Webhook idempotency. Handler does:
--   INSERT INTO stripe_events (...) VALUES (...) ON CONFLICT(stripe_event_id) DO NOTHING;
-- and only proceeds when meta.changes === 1. Anything else -> 200, already seen.
CREATE TABLE stripe_events (
  stripe_event_id   TEXT PRIMARY KEY,
  type              TEXT NOT NULL,
  api_version       TEXT,
  livemode          INTEGER NOT NULL DEFAULT 1 CHECK (livemode IN (0,1)),
  stripe_created_at INTEGER NOT NULL,
  object_id         TEXT,
  org_id            TEXT REFERENCES organisations(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'received'
                      CHECK (status IN ('received','processing','processed','failed','skipped')),
  attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 25),
  last_error        TEXT CHECK (last_error IS NULL OR length(last_error) <= 4000),
  payload_sha256    TEXT,   -- raw event JSON archived to R2; never stored in D1
  received_at       INTEGER NOT NULL,
  processed_at      INTEGER,
  CHECK (stripe_event_id GLOB 'evt_*'),
  CHECK (status <> 'processed' OR processed_at IS NOT NULL)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_stripe_events_retry  ON stripe_events(received_at)
  WHERE status IN ('received','processing','failed');
CREATE INDEX idx_stripe_events_object ON stripe_events(object_id, stripe_created_at DESC)
  WHERE object_id IS NOT NULL;
CREATE INDEX idx_stripe_events_gc     ON stripe_events(received_at) WHERE status = 'processed';

CREATE TABLE invoices (
  stripe_invoice_id      TEXT PRIMARY KEY,
  org_id                 TEXT NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  stripe_subscription_id TEXT REFERENCES subscriptions(stripe_subscription_id) ON DELETE SET NULL,
  number                 TEXT,
  status                 TEXT NOT NULL
                           CHECK (status IN ('draft','open','paid','void','uncollectible')),
  currency               TEXT NOT NULL DEFAULT 'eur',
  subtotal_cents         INTEGER NOT NULL DEFAULT 0,
  tax_cents              INTEGER NOT NULL DEFAULT 0,
  total_cents            INTEGER NOT NULL DEFAULT 0,
  amount_paid_cents      INTEGER NOT NULL DEFAULT 0 CHECK (amount_paid_cents >= 0),
  hosted_invoice_url     TEXT,
  invoice_pdf_url        TEXT,
  period_start           INTEGER,
  period_end             INTEGER,
  issued_at              INTEGER NOT NULL,
  paid_at                INTEGER,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  CHECK (stripe_invoice_id GLOB 'in_*'),
  CHECK (status <> 'paid' OR paid_at IS NOT NULL)
) STRICT, WITHOUT ROWID;

-- Covering index for the dashboard invoice list.
CREATE INDEX idx_invoices_org ON invoices(org_id, issued_at DESC, status, total_cents, invoice_pdf_url);
