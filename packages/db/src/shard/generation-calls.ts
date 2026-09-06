import { assertSingleChange, changedOne } from '../batch';
import { toArrayBuffer } from '../bytes';
import type {
  Effort,
  GenerationCallId,
  GenerationCallRow,
  GenerationJobId,
  GenerationStep,
  OutputFormat,
  ThinkingDisplay,
  ThinkingType,
  Timestamp,
} from '../types';

/**
 * Statements over `generation_calls` — one row per Anthropic call.
 *
 * This table is the answer to architecture §10 risk 2: the §6.5 cost model is DERIVED, not measured,
 * thinking tokens dominate output, and twenty real generations are run against these rows before
 * Phase 2 pricing is fixed. Everything here therefore records what actually happened rather than
 * what was intended — `served_model` and `fallback_used` alongside `model`, `stop_reason` verbatim,
 * usage straight from `response.usage`.
 *
 * There is no `thinking_tokens` parameter anywhere in this file. The Messages API `usage` object
 * has exactly four token fields and thinking is billed inside `output_tokens`; a fifth column would
 * always read zero and every cost formula that summed it would double-count.
 */

/** Opens a call row before the request is sent, so a crash mid-call still leaves a trace. */
export const SQL_INSERT_GENERATION_CALL = `
INSERT INTO generation_calls (id, job_id, step, attempt, model, effort, thinking_type,
                              thinking_display, max_tokens, task_budget_total, streamed,
                              output_format, schema_name, started_at, created_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)
`;

/**
 * Inserts a call row at request time.
 *
 * The database refuses `thinking_type = 'disabled'` together with `effort` `xhigh` or `max`
 * (verified: that combination returns 400), so a mis-built request fails here rather than after the
 * round trip and the spend.
 *
 * `uq_gen_calls_attempt(job_id, step, attempt)` means a retry that reuses an attempt number is a
 * failed insert, not a duplicate row that silently doubles the job's rolled-up cost.
 */
export async function insertGenerationCall(
  db: D1Database,
  args: {
    readonly id: GenerationCallId;
    readonly jobId: GenerationJobId;
    readonly step: GenerationStep;
    readonly attempt: number;
    readonly model: string;
    readonly effort: Effort;
    readonly thinkingType: ThinkingType;
    readonly thinkingDisplay: ThinkingDisplay | null;
    readonly maxTokens: number;
    /** `task_budget.total`. The API's documented minimum is 20000; the column CHECK repeats it. */
    readonly taskBudgetTotal: number | null;
    readonly streamed: 0 | 1;
    readonly outputFormat: OutputFormat | null;
    readonly schemaName: string | null;
    readonly now: Timestamp;
  },
): Promise<void> {
  const result = await db
    .prepare(SQL_INSERT_GENERATION_CALL)
    .bind(
      args.id,
      args.jobId,
      args.step,
      args.attempt,
      args.model,
      args.effort,
      args.thinkingType,
      args.thinkingDisplay,
      args.maxTokens,
      args.taskBudgetTotal,
      args.streamed,
      args.outputFormat,
      args.schemaName,
      args.now,
    )
    .run();
  assertSingleChange(result.meta, 'insertGenerationCall');
}

/**
 * Closes a call row with what the API actually returned.
 *
 * `stopReason` is written verbatim and is deliberately not an enum in the schema: the vocabulary
 * belongs to the provider, and widening a CHECK on a cascade child would mean a table rebuild every
 * time Anthropic ships a new stop reason. `refusalCategory` comes from `stop_details`, which is
 * populated only when `stop_reason === 'refusal'` — and the column CHECK uses `IS`, not `=`, so it
 * cannot be recorded against a call that never reported one.
 */
export const SQL_FINISH_GENERATION_CALL = `
UPDATE generation_calls
SET served_model = ?2, fallback_used = ?3, input_tokens = ?4, output_tokens = ?5,
    cache_creation_tokens = ?6, cache_read_tokens = ?7, cost_usd_micro = ?8, stop_reason = ?9,
    refusal_category = ?10, repair_rounds = ?11, anthropic_request_id = ?12, request_sha256 = ?13,
    response_sha256 = ?14, http_status = ?15, finished_at = ?16
WHERE id = ?1 AND finished_at IS NULL
`;

/** The four token fields `response.usage` actually has. */
export interface CallUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
}

/** Records the outcome of a call. Returns false when the row was already closed. */
export async function finishGenerationCall(
  db: D1Database,
  args: {
    readonly id: GenerationCallId;
    readonly servedModel: string | null;
    readonly fallbackUsed: 0 | 1;
    readonly usage: CallUsage;
    readonly costUsdMicro: number;
    readonly stopReason: string | null;
    readonly refusalCategory: string | null;
    readonly repairRounds: number;
    readonly anthropicRequestId: string | null;
    readonly requestSha256: Uint8Array | null;
    readonly responseSha256: Uint8Array | null;
    readonly httpStatus: number | null;
    readonly now: Timestamp;
  },
): Promise<boolean> {
  const u = args.usage;
  const result = await db
    .prepare(SQL_FINISH_GENERATION_CALL)
    .bind(
      args.id,
      args.servedModel,
      args.fallbackUsed,
      u.inputTokens,
      u.outputTokens,
      u.cacheCreationTokens,
      u.cacheReadTokens,
      args.costUsdMicro,
      args.stopReason,
      args.refusalCategory,
      args.repairRounds,
      args.anthropicRequestId,
      args.requestSha256 === null ? null : toArrayBuffer(args.requestSha256),
      args.responseSha256 === null ? null : toArrayBuffer(args.responseSha256),
      args.httpStatus,
      args.now,
    )
    .run();
  return changedOne(result.meta);
}

/** Records a transport or API failure against an open call row. */
export const SQL_FAIL_GENERATION_CALL = `
UPDATE generation_calls
SET error_code = ?2, error_message = ?3, http_status = ?4, finished_at = ?5
WHERE id = ?1 AND finished_at IS NULL
`;

/** Closes a call row with an error. */
export async function failGenerationCall(
  db: D1Database,
  args: {
    readonly id: GenerationCallId;
    readonly errorCode: string;
    readonly errorMessage: string | null;
    readonly httpStatus: number | null;
    readonly now: Timestamp;
  },
): Promise<boolean> {
  const result = await db
    .prepare(SQL_FAIL_GENERATION_CALL)
    .bind(args.id, args.errorCode, args.errorMessage, args.httpStatus, args.now)
    .run();
  return changedOne(result.meta);
}

/** The rollup written onto `generation_jobs` when a run ends. */
export const SQL_SUM_JOB_USAGE = `
SELECT count(*) AS calls_count,
       coalesce(sum(input_tokens), 0) AS input_tokens,
       coalesce(sum(output_tokens), 0) AS output_tokens,
       coalesce(sum(cache_creation_tokens), 0) AS cache_creation_tokens,
       coalesce(sum(cache_read_tokens), 0) AS cache_read_tokens,
       coalesce(sum(cost_usd_micro), 0) AS cost_usd_micro
FROM generation_calls
WHERE job_id = ?1
`;

/** The summed usage of one run. */
export interface JobUsageSums {
  readonly calls_count: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_tokens: number;
  readonly cache_read_tokens: number;
  readonly cost_usd_micro: number;
}

/**
 * Sums a run's calls.
 *
 * Includes failed calls on purpose: a run that burned $0.80 before dying still cost that, and a
 * cost model built only from successes is the one that under-prices the product.
 */
export async function sumJobUsage(db: D1Database, jobId: GenerationJobId): Promise<JobUsageSums> {
  const row = await db.prepare(SQL_SUM_JOB_USAGE).bind(jobId).first<JobUsageSums>();
  return (
    row ?? {
      calls_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      cost_usd_micro: 0,
    }
  );
}

/** Every call of one run, in order — the per-run cost breakdown in the ops digest. */
export const SQL_LIST_CALLS_FOR_JOB = `
SELECT * FROM generation_calls WHERE job_id = ?1 ORDER BY started_at, step
`;

/** Lists a run's calls. */
export async function listCallsForJob(
  db: D1Database,
  jobId: GenerationJobId,
): Promise<readonly GenerationCallRow[]> {
  const result = await db.prepare(SQL_LIST_CALLS_FOR_JOB).bind(jobId).all<GenerationCallRow>();
  return result.results;
}

/** One row of the measured cost model. */
export interface StepCostSummary {
  readonly step: GenerationStep;
  readonly effort: Effort;
  readonly calls: number;
  readonly avg_output_tokens: number;
  readonly avg_cost_usd_micro: number;
  readonly max_cost_usd_micro: number;
  readonly cache_read_tokens: number;
}

/**
 * What each step actually costs, by effort.
 *
 * THE query architecture §10 risk 2 exists to enable: §6.5's estimated cost model is rewritten from
 * this output after twenty real generations, before Phase 2 pricing is fixed. `max_cost_usd_micro`
 * is in the projection because the worst case is what `BudgetDO` has to reserve against, and an
 * average is exactly the statistic that hides it.
 */
export const SQL_STEP_COST_SUMMARY = `
SELECT step, effort,
       count(*) AS calls,
       cast(avg(output_tokens) AS INTEGER) AS avg_output_tokens,
       cast(avg(cost_usd_micro) AS INTEGER) AS avg_cost_usd_micro,
       max(cost_usd_micro) AS max_cost_usd_micro,
       coalesce(sum(cache_read_tokens), 0) AS cache_read_tokens
FROM generation_calls
WHERE created_at >= ?1
GROUP BY step, effort
ORDER BY avg_cost_usd_micro DESC
`;

/** Aggregates measured cost per step and effort since `since`. */
export async function stepCostSummary(
  db: D1Database,
  since: Timestamp,
): Promise<readonly StepCostSummary[]> {
  const result = await db.prepare(SQL_STEP_COST_SUMMARY).bind(since).all<StepCostSummary>();
  return result.results;
}
