-- ============================================================================================
-- migrations/shard/0004_generation.sql       database: aibuilder-shard-NNN
--
-- PURPOSE
--   The Anthropic run ledger and the publish record.
--     generation_jobs       one row per run, with the usage and cost rollup
--     generation_calls      one row per Anthropic call — the table architecture §10 risk 2 exists
--                           to fill, because the cost model is estimated and must become measured
--                           before Phase 2 pricing is fixed
--     generation_job_events durable mirror of the JobHub DO's event log, so an SSE client can
--                           resume past `Last-Event-ID` after the DO's lifetime has ended
--     deployments           publish records
--
--   The Workflow instance id IS the job id (`job_01H…`, which matches Cloudflare's
--   `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`), so there is deliberately no second column holding it: two
--   columns that must always be equal are two columns that will eventually disagree.
--
-- MIGRATION RULE (architecture §5.4). A cascade-parent table can NEVER be rebuilt in place on D1:
--   `PRAGMA foreign_keys=OFF` is unsupported, `defer_foreign_keys` defers constraint *checking*
--   rather than FK *actions*, and the 12-step rebuild therefore cascade-deletes every child while
--   `foreign_key_check` reports success. Expand -> migrate -> contract with `ALTER TABLE
--   ADD/DROP/RENAME COLUMN` only. `generation_jobs` is a cascade parent of both `generation_calls`
--   and `generation_job_events`.
-- ============================================================================================

CREATE TABLE generation_jobs (
  id                   TEXT PRIMARY KEY,
  -- Control-plane rows; no cross-database foreign key is possible (see 0001's SHARDING note).
  org_id               TEXT NOT NULL,
  site_id              TEXT NOT NULL,
  site_version_id      TEXT REFERENCES site_versions(id) ON DELETE SET NULL,
  -- The draft this run belongs to. `GET /v1/jobs/:id/events` authorises the SSE stream against the
  -- draft cookie on connect AND on every `Last-Event-ID` resume, so this is an authorisation
  -- input, not a breadcrumb.
  draft_id             TEXT CHECK (draft_id IS NULL OR
                         (length(draft_id) = 30 AND draft_id GLOB 'drf_[0-7]*'
                          AND substr(draft_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
  kind                 TEXT NOT NULL CHECK (kind IN
                         ('initial_site','regenerate_site','regenerate_page','translate',
                          'blog_post','legal_docs','copy_rewrite')),
  -- The paywall flag. Architecture §3c: the dispatcher refuses to run a job with this set unless
  -- `organisations.entitlement IN ('trialing','active')`. It is a function of expected cost, not of
  -- the word "regenerate", which is why the CHECK below is a floor and not an equality.
  requires_entitlement INTEGER NOT NULL DEFAULT 0 CHECK (requires_entitlement IN (0,1)),
  status               TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
                         ('queued','running','streaming','succeeded','failed','cancelled',
                          'blocked_paywall','timed_out')),

  -- Idempotency. Server-minted (§S4: an `Idempotency-Key` is never accepted from the client) and
  -- scoped to the organisation. Architecture §5.4 adopted this: a globally unique, client-supplied,
  -- ULID-shaped key was simultaneously a cross-tenant denial of service and an existence oracle,
  -- and combined with an unauthenticated events endpoint it handed out other tenants' job ids.
  idempotency_key      TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 64
                         AND idempotency_key NOT GLOB '*[^0-9A-Za-z_-]*'),

  -- QUEUE SENTINEL (architecture §5.4, corrected form). Set on enqueue, NULLed on every terminal
  -- transition. Neither a partial index on a status set (SQLite's prover cannot show that
  -- `status='queued'` implies `status IN ('queued','running','streaming')`, so it degraded to a
  -- full table SCAN) nor a plain composite (which grows forever with terminal rows) is right. This
  -- index is small, already sorted, and immune to predicate matching.
  queue_ready_at       INTEGER,

  prompt_sha256        BLOB NOT NULL CHECK (length(prompt_sha256) = 32),
  -- Hash of the `cache_control: {type:'ephemeral'}` stable prefix. Anthropic's cache is a PREFIX
  -- match, so hit rate is measured by grouping on this. Note the API allows four breakpoints while
  -- one hash attributes only one: the industry fragment and the base system block share a prefix
  -- on purpose so that this column stays meaningful.
  cache_prefix_sha256  BLOB CHECK (cache_prefix_sha256 IS NULL OR length(cache_prefix_sha256) = 32),

  -- ---- usage rollup, summed from generation_calls. Integers only; money never touches REAL. ----
  calls_count           INTEGER NOT NULL DEFAULT 0 CHECK (calls_count >= 0),
  input_tokens          INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens         INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_creation_tokens >= 0),
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cost_usd_micro        INTEGER NOT NULL DEFAULT 0 CHECK (cost_usd_micro >= 0),
  -- What BudgetDO reserved before dispatch, so the reconciler can settle reservation against
  -- actual spend instead of guessing.
  budget_reserved_micro INTEGER NOT NULL DEFAULT 0 CHECK (budget_reserved_micro >= 0),

  error_code           TEXT CHECK (error_code IS NULL OR
                         (length(error_code) BETWEEN 1 AND 64 AND error_code NOT GLOB '*[^a-z0-9_.]*')),
  error_message        TEXT CHECK (error_message IS NULL OR length(error_message) <= 4000),
  attempts             INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  -- Cooperative lease so two Workers never run the same job. Workflows owns retries, but a
  -- redelivered queue message or a manual re-dispatch must not double-spend.
  locked_by            TEXT CHECK (locked_by IS NULL OR length(locked_by) <= 64),
  lock_expires_at      INTEGER,

  queued_at            INTEGER NOT NULL,
  started_at           INTEGER,
  finished_at          INTEGER,
  -- D1 documents generated columns explicitly, VIRTUAL included; this applies cleanly.
  duration_ms          INTEGER GENERATED ALWAYS AS (finished_at - started_at) VIRTUAL,
  created_by           TEXT CHECK (created_by IS NULL OR
                         (length(created_by) = 30 AND created_by GLOB 'usr_[0-7]*'
                          AND substr(created_by, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  CHECK (length(id) = 30 AND id GLOB 'job_[0-7]*' AND substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (length(org_id) = 30 AND org_id GLOB 'org_[0-7]*'
         AND substr(org_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (length(site_id) = 30 AND site_id GLOB 'ste_[0-7]*'
         AND substr(site_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (status NOT IN ('succeeded','failed','cancelled','timed_out','blocked_paywall')
         OR finished_at IS NOT NULL),
  CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at),
  -- The sentinel and the lifecycle cannot disagree: a terminal job is never in the queue.
  CHECK (status IN ('queued','running','streaming') OR queue_ready_at IS NULL),
  -- Every kind except the one free first generation is gated.
  CHECK (kind = 'initial_site' OR requires_entitlement = 1)
) STRICT;

-- Idempotency, scoped to the tenant.
CREATE UNIQUE INDEX uq_jobs_idem ON generation_jobs(org_id, idempotency_key);
-- The queue drain. See QUEUE SENTINEL above.
CREATE INDEX idx_jobs_queue ON generation_jobs(queue_ready_at) WHERE queue_ready_at IS NOT NULL;
-- Stuck-run reaper: a run that outlived its lease.
CREATE INDEX idx_jobs_reaper ON generation_jobs(lock_expires_at)
  WHERE status IN ('running','streaming');
CREATE INDEX idx_jobs_site   ON generation_jobs(site_id, created_at DESC, status, kind);
CREATE INDEX idx_jobs_org_cost ON generation_jobs(org_id, created_at DESC, cost_usd_micro);
CREATE INDEX idx_jobs_draft  ON generation_jobs(draft_id) WHERE draft_id IS NOT NULL;
-- FK child index for `site_versions` deletes. The archived-version purge runs continuously, and
-- without this each purged version scans the whole job ledger.
CREATE INDEX idx_jobs_version ON generation_jobs(site_version_id) WHERE site_version_id IS NOT NULL;
CREATE INDEX idx_jobs_cache  ON generation_jobs(cache_prefix_sha256, created_at DESC)
  WHERE cache_prefix_sha256 IS NOT NULL;
CREATE INDEX idx_jobs_paywalled ON generation_jobs(org_id, created_at DESC)
  WHERE status = 'blocked_paywall';

-- ONE ROW PER ANTHROPIC CALL. This table is the answer to architecture §10 risk 2: the §6.5 cost
-- model is derived, not measured, and thinking tokens dominate output. Twenty real generations are
-- run against this table and §6.5 is rewritten from observation before Phase 2 pricing is fixed.
--
-- There is deliberately NO `thinking_tokens` column. The Messages API `usage` object has exactly
-- four token fields — `input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
-- `cache_read_input_tokens` — and thinking is billed INSIDE `output_tokens`. A `thinking_tokens`
-- column would always be zero, and any cost formula that added it would double-count.
CREATE TABLE generation_calls (
  id               TEXT PRIMARY KEY,
  job_id           TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  -- Mirrors the file names in apps/generator/src/steps/, so a cost row and a stack trace name the
  -- same thing.
  step             TEXT NOT NULL CHECK (step IN
                     ('validate','media','structure','copy','blog','legal','assemble','audit',
                      'render','publish','repair')),
  attempt          INTEGER NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 10),
  -- Recorded verbatim, not inferred: the model id we asked for.
  model            TEXT NOT NULL CHECK (length(model) BETWEEN 3 AND 64
                     AND model NOT GLOB '*[^0-9a-z.-]*'),
  -- What actually served the request. With server-side fallbacks enabled these differ, and a cost
  -- model that assumes they are equal is wrong on exactly the calls that cost the most to debug.
  served_model     TEXT CHECK (served_model IS NULL OR
                     (length(served_model) BETWEEN 3 AND 64 AND served_model NOT GLOB '*[^0-9a-z.-]*')),
  fallback_used    INTEGER NOT NULL DEFAULT 0 CHECK (fallback_used IN (0,1)),
  effort           TEXT NOT NULL DEFAULT 'high'
                     CHECK (effort IN ('low','medium','high','xhigh','max')),
  -- `thinking: { type: 'adaptive' }`. `budget_tokens` does not exist on this API and would 400.
  thinking_type    TEXT NOT NULL DEFAULT 'adaptive'
                     CHECK (thinking_type IN ('adaptive','disabled')),
  thinking_display TEXT CHECK (thinking_display IS NULL OR
                     thinking_display IN ('summarized','omitted','updates')),
  max_tokens       INTEGER NOT NULL CHECK (max_tokens BETWEEN 1 AND 131072),
  -- `task_budget.total` has a documented minimum of 20000; a smaller value is rejected by the API,
  -- so recording one would mean recording a request that was never sent.
  task_budget_total INTEGER CHECK (task_budget_total IS NULL OR task_budget_total >= 20000),
  streamed         INTEGER NOT NULL DEFAULT 1 CHECK (streamed IN (0,1)),
  output_format    TEXT CHECK (output_format IS NULL OR output_format IN ('text','json_schema')),
  schema_name      TEXT CHECK (schema_name IS NULL OR length(schema_name) <= 64),

  -- ---- usage, straight from `response.usage`. Four fields, because the API has four. ----
  input_tokens          INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens         INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_creation_tokens >= 0),
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cost_usd_micro        INTEGER NOT NULL DEFAULT 0 CHECK (cost_usd_micro >= 0),

  -- Branched on BEFORE `msg.content` is read, every time. Deliberately NOT an enum: the vocabulary
  -- belongs to the provider, and widening a CHECK on a cascade child means a table rebuild, which
  -- is not a thing to do because Anthropic shipped a new stop reason.
  stop_reason      TEXT CHECK (stop_reason IS NULL OR length(stop_reason) BETWEEN 1 AND 64),
  -- From `stop_details`, which is populated only when `stop_reason = 'refusal'`.
  refusal_category TEXT CHECK (refusal_category IS NULL OR length(refusal_category) BETWEEN 1 AND 64),
  -- Deterministic repair rounds spent on this call's output. Capped at 2 by packages/ai/src/repair.ts;
  -- a third round costs more than the call it is repairing.
  repair_rounds    INTEGER NOT NULL DEFAULT 0 CHECK (repair_rounds BETWEEN 0 AND 2),

  anthropic_request_id TEXT CHECK (anthropic_request_id IS NULL OR length(anthropic_request_id) <= 128),
  -- Full request and response transcripts go to R2: a single Opus 5 transcript can exceed D1's
  -- 2 MB row cap outright, so these are pointers and never payloads.
  request_sha256   BLOB CHECK (request_sha256 IS NULL OR length(request_sha256) = 32),
  response_sha256  BLOB CHECK (response_sha256 IS NULL OR length(response_sha256) = 32),
  error_code       TEXT CHECK (error_code IS NULL OR
                     (length(error_code) BETWEEN 1 AND 64 AND error_code NOT GLOB '*[^a-z0-9_.]*')),
  error_message    TEXT CHECK (error_message IS NULL OR length(error_message) <= 4000),
  http_status      INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  started_at       INTEGER NOT NULL,
  finished_at      INTEGER,
  duration_ms      INTEGER GENERATED ALWAYS AS (finished_at - started_at) VIRTUAL,
  created_at       INTEGER NOT NULL,
  CHECK (length(id) = 30 AND id GLOB 'gcl_[0-7]*' AND substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  -- Verified against the API: `thinking.type = 'disabled'` returns 400 at `xhigh` and `max`.
  CHECK (thinking_type <> 'disabled' OR effort IN ('low','medium','high')),
  CHECK (finished_at IS NULL OR finished_at >= started_at),
  -- `IS`, not `=`. A CHECK that evaluates to NULL PASSES in SQLite, so `stop_reason = 'refusal'`
  -- with a NULL `stop_reason` would let a refusal category be recorded against a call that never
  -- reported one — which is precisely the row an abuse investigation would trust.
  CHECK (refusal_category IS NULL OR stop_reason IS 'refusal')
) STRICT;

-- One row per (job, step, attempt). A retry that reuses an attempt number is a bookkeeping bug, and
-- a duplicate row here would double-count the rollup into `generation_jobs`.
CREATE UNIQUE INDEX uq_gen_calls_attempt ON generation_calls(job_id, step, attempt);
-- The rollup read, and the per-run cost breakdown in the ops digest.
CREATE INDEX idx_gen_calls_job ON generation_calls(job_id, started_at);
-- "What does step X actually cost, by effort" — the query §6.5 gets rewritten from.
CREATE INDEX idx_gen_calls_cost ON generation_calls(step, effort, created_at DESC, cost_usd_micro);
-- Refusal and stop-reason analytics, without scanning successful calls.
CREATE INDEX idx_gen_calls_stop ON generation_calls(stop_reason, created_at DESC)
  WHERE stop_reason IS NOT NULL AND stop_reason <> 'end_turn';

-- Durable mirror of the JobHub DO's event log. The SSE `id` on the wire is the DO-assigned `seq`,
-- NEVER this autoincrement: using the autoincrement would put a write to the single D1 primary in
-- the critical path of every streamed line. This table exists so a client can resume from a
-- `Last-Event-ID` after the DO's lifetime has ended.
--
-- INTEGER PRIMARY KEY AUTOINCREMENT on purpose: a monotonic rowid appends to the right edge of the
-- b-tree with no page splits, and `ORDER BY id` needs no sort step. AUTOINCREMENT rather than a
-- bare rowid so ids are never reused after the 7-day purge — the SSE cursor would otherwise replay
-- stale events.
CREATE TABLE generation_job_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL CHECK (seq >= 0),
  -- The twelve phases the client maps MANY-TO-ONE onto UI acts. Acts advance monotonically: a
  -- lower-act phase updates the detail line without moving the progress rail backwards.
  phase      TEXT NOT NULL CHECK (phase IN
               ('queued','prompt_built','api_call','thinking','streaming','parsing',
                'pages_written','media_fetch','build','deploy','done','error')),
  message    TEXT CHECK (message IS NULL OR length(message) <= 2000),
  progress   INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  data       TEXT CHECK (data IS NULL OR (json_valid(data) AND length(data) <= 8192)),
  created_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX uq_job_events_seq ON generation_job_events(job_id, seq);
-- Covering: "everything after cursor X for this job" never touches the table b-tree.
CREATE INDEX idx_job_events_poll ON generation_job_events(job_id, seq, phase, progress, message);
CREATE INDEX idx_job_events_gc   ON generation_job_events(created_at);

-- Publish records. Publishing is a KV pointer flip (§3a); this is the audit of when the pointer
-- moved, to what, and whether the materialisation that preceded it succeeded.
CREATE TABLE deployments (
  id               TEXT PRIMARY KEY,
  site_id          TEXT NOT NULL,
  site_version_id  TEXT NOT NULL REFERENCES site_versions(id) ON DELETE CASCADE,
  target           TEXT NOT NULL DEFAULT 'r2_static'
                     CHECK (target IN ('r2_static','pages','worker')),
  status           TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
                     ('queued','building','deploying','live','failed','rolled_back')),
  bundle_sha256    BLOB CHECK (bundle_sha256 IS NULL OR length(bundle_sha256) = 32),
  pages_written    INTEGER NOT NULL DEFAULT 0 CHECK (pages_written >= 0),
  bytes_written    INTEGER NOT NULL DEFAULT 0 CHECK (bytes_written >= 0),
  url              TEXT CHECK (url IS NULL OR length(url) <= 1000),
  error_message    TEXT CHECK (error_message IS NULL OR length(error_message) <= 4000),
  started_at       INTEGER,
  finished_at      INTEGER,
  created_at       INTEGER NOT NULL,
  CHECK (length(id) = 30 AND id GLOB 'dep_[0-7]*' AND substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (length(site_id) = 30 AND site_id GLOB 'ste_[0-7]*'
         AND substr(site_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK (status <> 'live' OR finished_at IS NOT NULL),
  CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
) STRICT;

CREATE INDEX idx_deploy_site    ON deployments(site_id, created_at DESC, status);
CREATE INDEX idx_deploy_version ON deployments(site_version_id, status);
CREATE INDEX idx_deploy_active  ON deployments(created_at)
  WHERE status IN ('queued','building','deploying');
