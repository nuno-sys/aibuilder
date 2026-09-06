import { assertSingleChange, changedOne } from '../batch';
import { toArrayBuffer } from '../bytes';
import type {
  DraftId,
  GenerationJobEventRow,
  GenerationJobId,
  GenerationJobRow,
  GenerationKind,
  JobPhase,
  OrganisationId,
  SiteId,
  SiteVersionId,
  Timestamp,
} from '../types';

/**
 * Statements over `generation_jobs` and `generation_job_events`.
 *
 * THE QUEUE SENTINEL. Architecture §5.4 adopted the corrected form: `queue_ready_at` is set on
 * enqueue and NULLed on every terminal transition, with
 * `CREATE INDEX idx_jobs_queue ON generation_jobs(queue_ready_at) WHERE queue_ready_at IS NOT NULL`.
 * Neither alternative worked. A partial index on a status set degraded to a full table SCAN, because
 * SQLite's prover cannot show that `status = 'queued'` implies
 * `status IN ('queued','running','streaming')`. A plain composite on `(status, queued_at)` seeks
 * correctly but grows forever with terminal rows. The sentinel index is small, already sorted, and
 * immune to predicate matching — and the column CHECK
 * `status IN ('queued','running','streaming') OR queue_ready_at IS NULL` makes a terminal
 * transition that forgets to clear it a failed write rather than a job that reappears in the queue.
 * Every terminal statement below therefore clears it explicitly.
 */

/**
 * Enqueues a run.
 *
 * `uq_jobs_idem(org_id, idempotency_key)` makes a replayed submit a failed insert rather than a
 * second paid generation. The key is server-minted and stored on the draft; architecture §5.4
 * adopted the org scoping because a globally unique, client-supplied, ULID-shaped key was
 * simultaneously a cross-tenant denial of service and an existence oracle for other tenants' job
 * ids.
 */
export const SQL_INSERT_GENERATION_JOB = `
INSERT INTO generation_jobs (id, org_id, site_id, draft_id, kind, requires_entitlement, status,
                             idempotency_key, queue_ready_at, prompt_sha256, cache_prefix_sha256,
                             budget_reserved_micro, created_by, queued_at, created_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', ?7, ?8, ?9, ?10, ?11, ?12, ?8, ?8, ?8)
`;

/** Inserts a queued job. Throws on a duplicate `(org_id, idempotency_key)`. */
export async function insertGenerationJob(
  db: D1Database,
  args: {
    readonly id: GenerationJobId;
    readonly orgId: OrganisationId;
    readonly siteId: SiteId;
    readonly draftId: DraftId | null;
    readonly kind: GenerationKind;
    readonly requiresEntitlement: 0 | 1;
    readonly idempotencyKey: string;
    readonly promptSha256: Uint8Array;
    readonly cachePrefixSha256: Uint8Array | null;
    readonly budgetReservedMicro: number;
    readonly createdBy: string | null;
    readonly now: Timestamp;
  },
): Promise<void> {
  const result = await db
    .prepare(SQL_INSERT_GENERATION_JOB)
    .bind(
      args.id,
      args.orgId,
      args.siteId,
      args.draftId,
      args.kind,
      args.requiresEntitlement,
      args.idempotencyKey,
      args.now,
      toArrayBuffer(args.promptSha256),
      args.cachePrefixSha256 === null ? null : toArrayBuffer(args.cachePrefixSha256),
      args.budgetReservedMicro,
      args.createdBy,
    )
    .run();
  assertSingleChange(result.meta, 'insertGenerationJob');
}

/** One job by id. */
export const SQL_GET_GENERATION_JOB = `
SELECT * FROM generation_jobs WHERE id = ?1
`;

/** Reads a job. */
export async function getGenerationJob(
  db: D1Database,
  jobId: GenerationJobId,
): Promise<GenerationJobRow | null> {
  return db.prepare(SQL_GET_GENERATION_JOB).bind(jobId).first<GenerationJobRow>();
}

/**
 * The idempotent-replay lookup.
 *
 * A repeated `POST /v1/onboarding/submit` finds the existing job here and answers 200 with the SAME
 * job id and site URL, rather than 202 with a second one.
 */
export const SQL_FIND_JOB_BY_IDEMPOTENCY = `
SELECT * FROM generation_jobs WHERE org_id = ?1 AND idempotency_key = ?2
`;

/** Finds an existing job for an organisation's idempotency key. */
export async function findJobByIdempotency(
  db: D1Database,
  args: { readonly orgId: OrganisationId; readonly idempotencyKey: string },
): Promise<GenerationJobRow | null> {
  return db
    .prepare(SQL_FIND_JOB_BY_IDEMPOTENCY)
    .bind(args.orgId, args.idempotencyKey)
    .first<GenerationJobRow>();
}

/**
 * The SSE authorisation read.
 *
 * `GET /v1/jobs/:id/events` authorises against the draft cookie on connect AND on every
 * `Last-Event-ID` resume, so this statement carries the draft id as a predicate rather than
 * returning it for the caller to compare. Possession of a job id proves nothing on its own.
 */
export const SQL_GET_JOB_FOR_DRAFT = `
SELECT * FROM generation_jobs WHERE id = ?1 AND draft_id = ?2
`;

/** Reads a job, authorised against the draft that owns it. */
export async function getJobForDraft(
  db: D1Database,
  args: { readonly jobId: GenerationJobId; readonly draftId: DraftId },
): Promise<GenerationJobRow | null> {
  return db.prepare(SQL_GET_JOB_FOR_DRAFT).bind(args.jobId, args.draftId).first<GenerationJobRow>();
}

/** What the queue drain needs to dispatch a run; the rest of the row is read by the Workflow. */
export type QueuedJob = Pick<
  GenerationJobRow,
  'id' | 'org_id' | 'site_id' | 'kind' | 'queue_ready_at'
>;

/** What the stuck-run reaper needs to decide between a requeue and a terminal failure. */
export type StuckJob = Pick<
  GenerationJobRow,
  'id' | 'org_id' | 'site_id' | 'attempts' | 'lock_expires_at'
>;

/** One mirrored progress event, in the shape the SSE resume writes to the wire. */
export type JobEvent = Pick<
  GenerationJobEventRow,
  'job_id' | 'seq' | 'phase' | 'progress' | 'message'
>;

/** The queue drain: a seek on the sentinel index, oldest first. */
export const SQL_LIST_QUEUED_JOBS = `
SELECT id, org_id, site_id, kind, queue_ready_at
FROM generation_jobs
WHERE queue_ready_at IS NOT NULL AND queue_ready_at <= ?1
ORDER BY queue_ready_at
LIMIT ?2
`;

/** A page of runnable jobs. */
export async function listQueuedJobs(
  db: D1Database,
  args: { readonly now: Timestamp; readonly limit: number },
): Promise<readonly QueuedJob[]> {
  const result = await db.prepare(SQL_LIST_QUEUED_JOBS).bind(args.now, args.limit).all<QueuedJob>();
  return result.results;
}

/**
 * Takes a cooperative lease on a queued job.
 *
 * `AND status = 'queued'` is the mutual exclusion. Workflows owns retries, but a redelivered queue
 * message or a manual re-dispatch must not run the same job twice — at roughly a dollar per run,
 * a double-dispatch is a real cost and a duplicate site.
 *
 * The sentinel deliberately stays SET while the job is running, so the reaper below can find a run
 * whose lease expired and put it back rather than losing it.
 */
export const SQL_CLAIM_QUEUED_JOB = `
UPDATE generation_jobs
SET status = 'running', locked_by = ?2, lock_expires_at = ?3, started_at = coalesce(started_at, ?4),
    attempts = attempts + 1, updated_at = ?4
WHERE id = ?1 AND status = 'queued'
RETURNING *
`;

/** Claims a job, or returns `null` when another worker already has it. */
export async function claimQueuedJob(
  db: D1Database,
  args: {
    readonly jobId: GenerationJobId;
    readonly lockedBy: string;
    readonly lockExpiresAt: Timestamp;
    readonly now: Timestamp;
  },
): Promise<GenerationJobRow | null> {
  return db
    .prepare(SQL_CLAIM_QUEUED_JOB)
    .bind(args.jobId, args.lockedBy, args.lockExpiresAt, args.now)
    .first<GenerationJobRow>();
}

/** Marks a claimed job as streaming, and attaches the version it is building. */
export const SQL_MARK_JOB_STREAMING = `
UPDATE generation_jobs
SET status = 'streaming', site_version_id = coalesce(?2, site_version_id), updated_at = ?3
WHERE id = ?1 AND status IN ('running','streaming')
`;

/** Moves a running job to `streaming`. */
export async function markJobStreaming(
  db: D1Database,
  args: {
    readonly jobId: GenerationJobId;
    readonly versionId: SiteVersionId | null;
    readonly now: Timestamp;
  },
): Promise<boolean> {
  const result = await db
    .prepare(SQL_MARK_JOB_STREAMING)
    .bind(args.jobId, args.versionId, args.now)
    .run();
  return changedOne(result.meta);
}

/**
 * Terminal success. Clears the queue sentinel and the lease.
 *
 * The usage columns are a rollup of `generation_calls`, written here from `sumJobUsage()` so the
 * per-job cost is one row read for the ops digest and the org's usage counters.
 */
export const SQL_FINISH_JOB_SUCCEEDED = `
UPDATE generation_jobs
SET status = 'succeeded', queue_ready_at = NULL, locked_by = NULL, lock_expires_at = NULL,
    site_version_id = coalesce(?2, site_version_id), calls_count = ?3, input_tokens = ?4,
    output_tokens = ?5, cache_creation_tokens = ?6, cache_read_tokens = ?7, cost_usd_micro = ?8,
    finished_at = ?9, updated_at = ?9
WHERE id = ?1 AND status IN ('running','streaming')
`;

/** The usage rollup written onto a finished job. */
export interface JobUsageRollup {
  readonly callsCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
  readonly costUsdMicro: number;
}

/** Finishes a job successfully. Returns false when it was already terminal. */
export async function finishJobSucceeded(
  db: D1Database,
  args: {
    readonly jobId: GenerationJobId;
    readonly versionId: SiteVersionId | null;
    readonly usage: JobUsageRollup;
    readonly now: Timestamp;
  },
): Promise<boolean> {
  const u = args.usage;
  const result = await db
    .prepare(SQL_FINISH_JOB_SUCCEEDED)
    .bind(
      args.jobId,
      args.versionId,
      u.callsCount,
      u.inputTokens,
      u.outputTokens,
      u.cacheCreationTokens,
      u.cacheReadTokens,
      u.costUsdMicro,
      args.now,
    )
    .run();
  return changedOne(result.meta);
}

/**
 * Terminal failure. Clears the queue sentinel and the lease.
 *
 * The usage rollup is written even on failure: a run that burned $0.80 before dying still cost
 * that, and a cost model built only from successes is the one that under-prices the product.
 */
export const SQL_FINISH_JOB_FAILED = `
UPDATE generation_jobs
SET status = ?2, queue_ready_at = NULL, locked_by = NULL, lock_expires_at = NULL,
    error_code = ?3, error_message = ?4, calls_count = ?5, input_tokens = ?6, output_tokens = ?7,
    cache_creation_tokens = ?8, cache_read_tokens = ?9, cost_usd_micro = ?10,
    finished_at = ?11, updated_at = ?11
WHERE id = ?1 AND status NOT IN ('succeeded','failed','cancelled','timed_out','blocked_paywall')
`;

/** Finishes a job in a terminal failure state. */
export async function finishJobFailed(
  db: D1Database,
  args: {
    readonly jobId: GenerationJobId;
    readonly status: 'failed' | 'cancelled' | 'timed_out' | 'blocked_paywall';
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
    readonly usage: JobUsageRollup;
    readonly now: Timestamp;
  },
): Promise<boolean> {
  const u = args.usage;
  const result = await db
    .prepare(SQL_FINISH_JOB_FAILED)
    .bind(
      args.jobId,
      args.status,
      args.errorCode,
      args.errorMessage,
      u.callsCount,
      u.inputTokens,
      u.outputTokens,
      u.cacheCreationTokens,
      u.cacheReadTokens,
      u.costUsdMicro,
      args.now,
    )
    .run();
  return changedOne(result.meta);
}

/** Runs whose lease expired: the stuck-job reaper's input. */
export const SQL_LIST_STUCK_JOBS = `
SELECT id, org_id, site_id, attempts, lock_expires_at
FROM generation_jobs
WHERE status IN ('running','streaming') AND lock_expires_at < ?1
ORDER BY lock_expires_at
LIMIT ?2
`;

/** Lists runs that outlived their lease. */
export async function listStuckJobs(
  db: D1Database,
  args: { readonly now: Timestamp; readonly limit: number },
): Promise<readonly StuckJob[]> {
  const result = await db.prepare(SQL_LIST_STUCK_JOBS).bind(args.now, args.limit).all<StuckJob>();
  return result.results;
}

/**
 * Returns a stuck run to the queue.
 *
 * `queue_ready_at` is pushed forward rather than reset to now, so a run that keeps dying backs off
 * instead of spinning against a single-threaded database — and `attempts` is already incremented by
 * the claim, so the caller can give up on it after a bounded number of tries.
 */
export const SQL_REQUEUE_STUCK_JOB = `
UPDATE generation_jobs
SET status = 'queued', queue_ready_at = ?2, locked_by = NULL, lock_expires_at = NULL, updated_at = ?3
WHERE id = ?1 AND status IN ('running','streaming') AND lock_expires_at < ?3
`;

/** Requeues a stuck run with a backoff. */
export async function requeueStuckJob(
  db: D1Database,
  args: { readonly jobId: GenerationJobId; readonly readyAt: Timestamp; readonly now: Timestamp },
): Promise<boolean> {
  const result = await db
    .prepare(SQL_REQUEUE_STUCK_JOB)
    .bind(args.jobId, args.readyAt, args.now)
    .run();
  return changedOne(result.meta);
}

// ---------------------------------------------------------------------------------------------
// Progress events
// ---------------------------------------------------------------------------------------------

/**
 * Mirrors one JobHub DO event.
 *
 * Written on a `waitUntil`, NEVER in the critical path of a streamed line: the SSE `id` on the wire
 * is the DO-assigned `seq`, and using the D1 autoincrement instead would put a write to the single
 * D1 primary between the model's token and the customer's screen.
 *
 * `ON CONFLICT DO NOTHING` makes a redelivered mirror idempotent rather than a duplicate-key error
 * on a background write nobody is watching.
 */
export const SQL_INSERT_JOB_EVENT = `
INSERT INTO generation_job_events (job_id, seq, phase, message, progress, data, created_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
ON CONFLICT(job_id, seq) DO NOTHING
`;

/** Builds a job-event insert, for the batched mirror write. */
export function insertJobEventStatement(
  db: D1Database,
  args: {
    readonly jobId: GenerationJobId;
    readonly seq: number;
    readonly phase: JobPhase;
    readonly message: string | null;
    readonly progress: number;
    readonly data: string | null;
    readonly now: Timestamp;
  },
): D1PreparedStatement {
  return db
    .prepare(SQL_INSERT_JOB_EVENT)
    .bind(args.jobId, args.seq, args.phase, args.message, args.progress, args.data, args.now);
}

/**
 * SSE resume: everything after the client's `Last-Event-ID`.
 *
 * Covering on `idx_job_events_poll`, so a reconnect never touches the table b-tree. This is the
 * path that exists because a Durable Object's lifetime is shorter than a customer leaving the tab
 * open over lunch.
 */
export const SQL_LIST_JOB_EVENTS_AFTER = `
SELECT job_id, seq, phase, progress, message
FROM generation_job_events
WHERE job_id = ?1 AND seq > ?2
ORDER BY seq
LIMIT ?3
`;

/** Lists a job's events after a sequence number. */
export async function listJobEventsAfter(
  db: D1Database,
  args: { readonly jobId: GenerationJobId; readonly afterSeq: number; readonly limit: number },
): Promise<readonly JobEvent[]> {
  const result = await db
    .prepare(SQL_LIST_JOB_EVENTS_AFTER)
    .bind(args.jobId, args.afterSeq, args.limit)
    .all<JobEvent>();
  return result.results;
}

/** Deletes mirrored events past the 7-day window, in chunks. */
export const SQL_PURGE_JOB_EVENTS = `
DELETE FROM generation_job_events
WHERE id IN (SELECT id FROM generation_job_events WHERE created_at < ?1 ORDER BY created_at LIMIT ?2)
`;

/** Purges a chunk of old job events and returns how many were removed. */
export async function purgeJobEvents(
  db: D1Database,
  args: { readonly before: Timestamp; readonly limit: number },
): Promise<number> {
  const result = await db.prepare(SQL_PURGE_JOB_EVENTS).bind(args.before, args.limit).run();
  return result.meta.changes;
}
