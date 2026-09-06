-- 0005_ai_generation.sql -- Anthropic claude-opus-5 run ledger.

CREATE TABLE generation_jobs (
  id                   TEXT PRIMARY KEY,
  org_id               TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  site_id              TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  site_version_id      TEXT REFERENCES site_versions(id) ON DELETE SET NULL,
  kind                 TEXT NOT NULL CHECK (kind IN
                         ('initial_site','regenerate_site','regenerate_page','translate',
                          'blog_post','legal_docs','image_search','copy_rewrite')),
  -- The paywall flag. 'initial_site' is free; every regenerate_* sets this to 1 and the
  -- dispatcher refuses to run unless organisations.entitlement IN ('trialing','active').
  requires_entitlement INTEGER NOT NULL DEFAULT 0 CHECK (requires_entitlement IN (0,1)),
  status               TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
                         ('queued','running','streaming','succeeded','failed',
                          'cancelled','blocked_paywall','timed_out')),

  -- Idempotency: retrying the same request never bills the customer twice.
  idempotency_key      TEXT NOT NULL,
  prompt_sha256        TEXT NOT NULL,
  -- Hash of the cache_control:{type:'ephemeral'} stable prefix. Anthropic caching is
  -- PREFIX-MATCH, so we pin the prefix and measure hit-rate by grouping on this column.
  cache_prefix_sha256  TEXT,

  -- ---- Anthropic call parameters, recorded verbatim for reproducibility ----
  model                TEXT NOT NULL DEFAULT 'claude-opus-5',
  effort               TEXT NOT NULL DEFAULT 'high'
                         CHECK (effort IN ('low','medium','high','xhigh','max')),
  -- thinking is { type: 'adaptive' } - budget_tokens does not exist and would 400.
  thinking_type        TEXT NOT NULL DEFAULT 'adaptive'
                         CHECK (thinking_type IN ('adaptive','disabled')),
  max_tokens           INTEGER NOT NULL CHECK (max_tokens BETWEEN 1 AND 131072),
  streamed             INTEGER NOT NULL DEFAULT 1 CHECK (streamed IN (0,1)),
  output_format        TEXT CHECK (output_format IS NULL OR output_format IN ('text','json_schema')),
  schema_name          TEXT,
  cache_ttl            TEXT NOT NULL DEFAULT '5m' CHECK (cache_ttl IN ('5m','1h')),

  -- ---- usage + cost (integers only; money never touches REAL) ----
  input_tokens          INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens          >= 0),
  output_tokens         INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens         >= 0),
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_creation_tokens >= 0),
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_tokens     >= 0),
  thinking_tokens       INTEGER NOT NULL DEFAULT 0 CHECK (thinking_tokens       >= 0),
  cost_usd_micro        INTEGER NOT NULL DEFAULT 0 CHECK (cost_usd_micro        >= 0),

  stop_reason          TEXT,
  anthropic_request_id TEXT,
  -- Full request + response transcripts go to R2. A single opus-5 transcript can exceed
  -- D1's 2 MB row cap outright, so these are pointers, never payloads.
  request_sha256       TEXT,
  response_sha256      TEXT,

  error_code           TEXT,
  error_message        TEXT CHECK (error_message IS NULL OR length(error_message) <= 4000),
  attempts             INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  -- Cooperative lease so two Workers never run the same job.
  locked_by            TEXT,
  lock_expires_at      INTEGER,

  queued_at            INTEGER NOT NULL,
  started_at           INTEGER,
  finished_at          INTEGER,
  duration_ms          INTEGER GENERATED ALWAYS AS (finished_at - started_at) VIRTUAL,
  created_by           TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  CHECK (id GLOB 'job_[0-7]*' AND length(id) = 30),
  CHECK (length(prompt_sha256) = 64 AND prompt_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (status NOT IN ('succeeded','failed','cancelled','timed_out') OR finished_at IS NOT NULL),
  CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at),
  CHECK (kind = 'initial_site' OR kind NOT GLOB 'regenerate*' OR requires_entitlement = 1)
) STRICT;

CREATE UNIQUE INDEX uq_jobs_idem      ON generation_jobs(idempotency_key);
-- Queue drain. NOT a partial index: SQLite's partial-index prover cannot show that
-- "status = 'queued'" implies "status IN ('queued','running','streaming')", so the partial
-- version silently degraded to a full table SCAN. status is the leading column, so a plain
-- composite seeks straight to the live range anyway and ORDER BY queued_at needs no sort.
CREATE INDEX idx_jobs_queue           ON generation_jobs(status, queued_at);
-- Stuck-job reaper (a run that outlived its lease).
CREATE INDEX idx_jobs_reaper          ON generation_jobs(lock_expires_at)
  WHERE status IN ('running','streaming');
CREATE INDEX idx_jobs_site            ON generation_jobs(site_id, created_at DESC, status, kind);
CREATE INDEX idx_jobs_org_cost        ON generation_jobs(org_id, created_at DESC, cost_usd_micro);
-- Prompt-cache hit-rate analytics.
CREATE INDEX idx_jobs_prompt_cache    ON generation_jobs(cache_prefix_sha256, created_at DESC)
  WHERE cache_prefix_sha256 IS NOT NULL;
CREATE INDEX idx_jobs_paywalled       ON generation_jobs(org_id, created_at DESC)
  WHERE status = 'blocked_paywall';

-- Streaming progress feed for the "magic popup" UI. Append-only, high volume, purged after 7 days.
-- INTEGER PRIMARY KEY AUTOINCREMENT on purpose: monotonic rowid = perfect b-tree append
-- locality, and ORDER BY id DESC is a free reverse scan with no sort step.
-- AUTOINCREMENT (not bare rowid) so ids are never reused after the purge - the SSE cursor
-- would otherwise replay stale events.
CREATE TABLE generation_job_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL CHECK (seq >= 0),
  phase      TEXT NOT NULL CHECK (phase IN
               ('queued','prompt_built','api_call','thinking','streaming','parsing',
                'pages_written','media_fetch','build','deploy','done','error')),
  message    TEXT CHECK (message IS NULL OR length(message) <= 2000),
  progress   INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  data       TEXT CHECK (data IS NULL OR (json_valid(data) AND length(data) <= 8192)),
  created_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX uq_job_events_seq ON generation_job_events(job_id, seq);
-- SSE poll: "everything after cursor X for this job", covering.
CREATE INDEX idx_job_events_poll ON generation_job_events(job_id, id, phase, progress, message);
CREATE INDEX idx_job_events_gc   ON generation_job_events(created_at);
