-- ============================================================================================
-- migrations/shard/0007_billing_gate.sql     database: aibuilder-shard-NNN
--
-- PURPOSE
--   The trial-first funnel (.design/DECISIONS.md §D2). A generation is no longer dispatched by
--   `submit`; it is dispatched by Stripe's `checkout.session.completed` webhook. `generation_jobs`
--   therefore needs a payment state, the Checkout session that gates it, a deadline, and an
--   attempt counter.
--
-- WHY THIS IS A NEW COLUMN AND NOT A NEW `status` VALUE
--   `awaiting_payment` is deliberately NOT added to `generation_jobs.status`. Widening
--   `CHECK (status IN (…))` is a 12-step table rebuild, and `generation_jobs` is a cascade parent
--   of `generation_calls` and `generation_job_events`. D1 rejects `PRAGMA foreign_keys=OFF`, and
--   `defer_foreign_keys` defers constraint *checking* rather than FK *actions*, so the rebuild
--   would cascade-delete every child row while `foreign_key_check` reports success.
--
--   The forward-safe encoding is an added column plus the EXISTING status vocabulary:
--   `status='queued'` with `queue_ready_at IS NULL` is already a legal, non-runnable state — 0004's
--   `CHECK (status IN ('queued','running','streaming') OR queue_ready_at IS NULL)` is satisfied
--   vacuously by the left disjunct — and `idx_jobs_queue` is partial on `queue_ready_at IS NOT NULL`,
--   so the drain cannot see an unpaid job.
--
-- MIGRATION RULE (architecture §5.4). A cascade-parent table can NEVER be rebuilt in place on D1.
--   Expand -> migrate -> contract with `ALTER TABLE ADD/DROP/RENAME COLUMN` only. Every statement
--   below is an ADD COLUMN or a CREATE INDEX; nothing is rebuilt.
-- ============================================================================================

ALTER TABLE generation_jobs ADD COLUMN payment_state TEXT NOT NULL DEFAULT 'not_required'
  CHECK (payment_state IN ('not_required','awaiting_payment','paid','abandoned'));

-- Stripe Checkout session ids are `cs_test_…` / `cs_live_…`. The webhook finds the job it must
-- release by this column rather than by session metadata, which anyone with Dashboard access can
-- edit — a server-side fact beats an attacker-editable one.
ALTER TABLE generation_jobs ADD COLUMN checkout_session_id TEXT
  CHECK (checkout_session_id IS NULL OR
         (checkout_session_id GLOB 'cs_*' AND length(checkout_session_id) BETWEEN 8 AND 66));

-- Stripe's own `expires_at`, in ms. After it passes with no `checkout.session.completed`, the
-- sweeper marks the job `abandoned` and releases the reserved slug.
ALTER TABLE generation_jobs ADD COLUMN payment_deadline_at INTEGER;

-- Bounded so a customer cycling Checkout cannot mint sessions without limit.
ALTER TABLE generation_jobs ADD COLUMN checkout_attempts INTEGER NOT NULL DEFAULT 0
  CHECK (checkout_attempts BETWEEN 0 AND 5);

-- The sweeper's only query: awaiting jobs whose deadline has passed. Partial, so it holds only the
-- jobs actually in flight and does not grow with terminal ones.
CREATE INDEX idx_jobs_awaiting_payment ON generation_jobs(payment_deadline_at)
  WHERE payment_state = 'awaiting_payment';

-- `SQL_GET_JOB_BY_CHECKOUT_SESSION` — the webhook's lookup. Without this index it is a full scan
-- and fails the EXPLAIN QUERY PLAN gate.
CREATE INDEX idx_jobs_checkout_session ON generation_jobs(checkout_session_id)
  WHERE checkout_session_id IS NOT NULL;
