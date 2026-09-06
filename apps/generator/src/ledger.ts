import { mintId } from '@aibuilder/core';
import { shard } from '@aibuilder/db';
import type { GenerationCallId, GenerationJobId, GenerationStep } from '@aibuilder/db';
import type { GenerationCallRecord } from '@aibuilder/ai';

import type { Env } from './env';
import { classifyStepFailure } from './retry';

/**
 * The cost ledger — `response.usage` in, one `generation_calls` row and one Analytics Engine point
 * out.
 *
 * §10 risk 2 is blunt about why this exists: the §6.5 cost model is DERIVED, not measured, and
 * thinking tokens — which dominate output and are on by default on Opus 5 — carry the widest error
 * bar in it. Twenty real generations are run against these rows before Phase 2 pricing is fixed, so
 * every call is recorded whether it succeeded or not. A cost model built only from successes is the
 * one that under-prices the product.
 *
 * TWO SINKS, ON PURPOSE. D1 is the system of record: it joins to the job, the org and the site, and
 * it is what an invoice dispute is answered from. Analytics Engine is the aggregate view, and it is
 * written second and never awaited, because the shard is a single writer and a busy shard must not
 * be able to stall a paid step's completion.
 *
 * THE ROW IS OPENED BEFORE THE REQUEST. A crash between the call and the write would otherwise
 * leave money spent with no trace at all; an open row with no `finished_at` is a visible,
 * greppable "this call was made and we never learned how it ended", which is the honest record.
 */

/** What one recorded call needs beyond the AI package's record. */
export interface LedgerContext {
  readonly db: D1Database;
  readonly jobId: GenerationJobId;
  readonly step: GenerationStep;
  /** 1-based. Derived from the rows already present, because Workflows does not expose the count. */
  readonly attempt: number;
}

/**
 * Computes the attempt number for the next call of one step.
 *
 * `uq_gen_calls_attempt(job_id, step, attempt)` means a retry that reuses a number is a failed
 * insert rather than a duplicate row silently doubling the job's rolled-up cost — so the number has
 * to be derived from what is already there. A Workflow instance is single-threaded, so counting and
 * then inserting is not a race here; two instances for one job cannot exist, because the instance
 * id IS the job id.
 */
export async function nextAttempt(
  db: D1Database,
  jobId: GenerationJobId,
  step: GenerationStep,
): Promise<number> {
  const rows = await shard.generationCalls.listCallsForJob(db, jobId);
  return rows.filter((row) => row.step === step).length + 1;
}

/**
 * Opens a call row before the request is sent.
 *
 * Returns the row id, which the caller must pass to exactly one of `closeCall` / `failCall`.
 */
export async function openCall(
  context: LedgerContext,
  request: {
    readonly model: string;
    readonly effort: GenerationCallRecord['effort'];
    readonly thinkingType: GenerationCallRecord['thinkingType'];
    readonly thinkingDisplay: GenerationCallRecord['thinkingDisplay'];
    readonly maxTokens: number;
    readonly taskBudgetTotal: number | null;
    readonly streamed: boolean;
    readonly schemaName: string | null;
  },
): Promise<GenerationCallId> {
  const id = mintId('generationCall');
  await shard.generationCalls.insertGenerationCall(context.db, {
    id,
    jobId: context.jobId,
    step: context.step,
    attempt: context.attempt,
    model: request.model,
    effort: request.effort,
    thinkingType: request.thinkingType,
    thinkingDisplay: request.thinkingDisplay,
    maxTokens: request.maxTokens,
    taskBudgetTotal: request.taskBudgetTotal,
    streamed: request.streamed ? 1 : 0,
    outputFormat: 'json_schema',
    schemaName: request.schemaName,
    now: Date.now(),
  });
  return id;
}

/**
 * Closes a call row with what the API actually returned, and mirrors it to Analytics Engine.
 *
 * Guarantees the row is closed exactly once (`WHERE finished_at IS NULL` in the statement) and that
 * an Analytics Engine failure cannot fail the step.
 */
export async function closeCall(
  env: Env,
  context: LedgerContext,
  callId: GenerationCallId,
  record: GenerationCallRecord,
): Promise<void> {
  await shard.generationCalls.finishGenerationCall(context.db, {
    id: callId,
    servedModel: record.servedModel,
    fallbackUsed: record.fallbackUsed ? 1 : 0,
    usage: {
      inputTokens: record.usage.inputTokens,
      outputTokens: record.usage.outputTokens,
      cacheCreationTokens: record.usage.cacheCreationTokens,
      cacheReadTokens: record.usage.cacheReadTokens,
    },
    costUsdMicro: record.costUsdMicro,
    stopReason: record.stopReason,
    refusalCategory: record.refusalCategory,
    repairRounds: record.repairRounds,
    anthropicRequestId: record.anthropicRequestId,
    requestSha256: null,
    responseSha256: null,
    httpStatus: null,
    now: Date.now(),
  });

  writePoint(env, {
    jobId: context.jobId,
    step: context.step,
    attempt: context.attempt,
    outcome: record.stopReason ?? 'unknown',
    costUsdMicro: record.costUsdMicro,
    inputTokens: record.usage.inputTokens,
    outputTokens: record.usage.outputTokens,
    cacheReadTokens: record.usage.cacheReadTokens,
    cacheCreationTokens: record.usage.cacheCreationTokens,
    repairRounds: record.repairRounds,
  });
}

/** Closes a call row with an error. The tokens may still have been billed; the row says so. */
export async function failCall(
  env: Env,
  context: LedgerContext,
  callId: GenerationCallId,
  failure: {
    readonly errorCode: string;
    readonly errorMessage: string | null;
    readonly httpStatus: number | null;
  },
): Promise<void> {
  await shard.generationCalls.failGenerationCall(context.db, {
    id: callId,
    errorCode: failure.errorCode,
    // Truncated hard: `error_message` is capped at 4000 characters by the column, and a provider
    // body can carry an echo of the request.
    errorMessage: failure.errorMessage === null ? null : failure.errorMessage.slice(0, 2000),
    httpStatus: failure.httpStatus,
    now: Date.now(),
  });

  writePoint(env, {
    jobId: context.jobId,
    step: context.step,
    attempt: context.attempt,
    outcome: failure.errorCode,
    costUsdMicro: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    repairRounds: 0,
  });
}

/**
 * Closes an open call row from whatever the step threw.
 *
 * A REFUSAL IS NOT A TECHNICAL FAILURE AND MUST NOT BE LEDGERED AS ONE. `stop_reason: "refusal"`
 * arrives as HTTP 200 with tokens already billed and a `stop_details.category` that is the single
 * most useful field in the whole table — it is how gating gets learned rather than guessed. So a
 * refusal closes the row properly, with its usage, its stop reason and its category; only genuine
 * transport and internal failures take the error path, where the token counts are unknown.
 *
 * Guarantees the row is closed on every throwing path, so an open row always means "we lost track
 * of this call" and never "the call failed".
 */
export async function finishCallFromError(
  env: Env,
  context: LedgerContext,
  callId: GenerationCallId,
  error: unknown,
): Promise<void> {
  const record = error as {
    readonly code?: unknown;
    readonly category?: unknown;
    readonly usage?: unknown;
    readonly requestId?: unknown;
    readonly message?: unknown;
  };
  const usage = readUsage(record.usage);

  if (record.code === 'model_refusal') {
    await shard.generationCalls.finishGenerationCall(context.db, {
      id: callId,
      servedModel: null,
      fallbackUsed: 0,
      usage,
      costUsdMicro: 0,
      stopReason: 'refusal',
      refusalCategory: typeof record.category === 'string' ? record.category : null,
      repairRounds: 0,
      anthropicRequestId: typeof record.requestId === 'string' ? record.requestId : null,
      requestSha256: null,
      responseSha256: null,
      httpStatus: null,
      now: Date.now(),
    });
    writePoint(env, {
      jobId: context.jobId,
      step: context.step,
      attempt: context.attempt,
      outcome: 'refusal',
      costUsdMicro: 0,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      repairRounds: 0,
    });
    return;
  }

  const decision = classifyStepFailure(error);
  await failCall(env, context, callId, {
    errorCode: decision.errorCode,
    errorMessage: typeof record.message === 'string' ? record.message : null,
    httpStatus: decision.httpStatus,
  });
}

/** Reads the four token counters off an error's `usage`, defaulting each to zero. */
function readUsage(value: unknown): {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
} {
  const source =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const count = (key: string): number => {
    const raw = source[key];
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0;
  };
  return {
    inputTokens: count('inputTokens'),
    outputTokens: count('outputTokens'),
    cacheCreationTokens: count('cacheCreationTokens'),
    cacheReadTokens: count('cacheReadTokens'),
  };
}

/**
 * Writes one Analytics Engine point.
 *
 * Synchronous and unawaited by design: `writeDataPoint` does not return a promise and telemetry
 * that can fail a generation is worse than no telemetry. `indexes` carries the step, because the
 * one query this dataset exists to answer is "what does each step cost".
 */
function writePoint(
  env: Env,
  point: {
    readonly jobId: string;
    readonly step: GenerationStep;
    readonly attempt: number;
    readonly outcome: string;
    readonly costUsdMicro: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheCreationTokens: number;
    readonly repairRounds: number;
  },
): void {
  try {
    env.AE.writeDataPoint({
      indexes: [point.step],
      blobs: [point.jobId, point.step, point.outcome, env.ENVIRONMENT],
      doubles: [
        point.costUsdMicro,
        point.inputTokens,
        point.outputTokens,
        point.cacheReadTokens,
        point.cacheCreationTokens,
        point.repairRounds,
        point.attempt,
      ],
    });
  } catch {
    // Deliberately swallowed: see the JSDoc.
  }
}

/**
 * Records a non-model step's outcome in Analytics Engine only.
 *
 * `generation_calls` is for Anthropic calls and nothing else — `media`, `assemble` and `audit` are
 * deterministic code and a row for them would pollute every cost query with zero-cost rows.
 */
export function recordStepOutcome(
  env: Env,
  args: {
    readonly jobId: string;
    /**
     * A plain string, not `GenerationStep`: the Workflow also times steps that are not model calls
     * and have no D1 vocabulary (`claim`, `finalise`). Analytics Engine blobs are strings, and a
     * union here would force those two to masquerade as a step they are not.
     */
    readonly step: string;
    readonly outcome: string;
    readonly durationMs: number;
  },
): void {
  try {
    env.AE.writeDataPoint({
      indexes: [args.step],
      blobs: [args.jobId, args.step, args.outcome, env.ENVIRONMENT],
      doubles: [0, 0, 0, 0, 0, 0, args.durationMs],
    });
  } catch {
    // Deliberately swallowed: see `writePoint`.
  }
}
