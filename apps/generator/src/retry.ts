import { classifyTransportError } from '@aibuilder/ai';

/**
 * The retry ladder — the one decision that separates a rate-limit blip from a permanently failed
 * onboarding, and a refusal from a $1.20 hole in the day's budget.
 *
 * THREE KINDS OF FAILURE, THREE ANSWERS (architecture §6.2, §10 risk 5):
 *
 *   TRANSPORT  a 429, a 5xx, a dropped socket, an abort. Nothing about the request is wrong. The
 *              step is retried with backoff, honouring `retry-after` where the provider gave one.
 *
 *   CONTENT    the model answered and the answer is unusable: truncated at `max_tokens`, malformed
 *              JSON, or still schema-invalid after the repair ladder spent its two paid rounds.
 *              The step is retried, because a retry draws a FRESH SAMPLE — which is a different
 *              thing from replaying the same defective one, and is the only reason retrying content
 *              failures is not simply paying twice for the same mistake. The ladder is short (2
 *              attempts) for exactly that reason.
 *
 *   POLICY     `stop_reason: "refusal"`, or the injection canary firing. TERMINAL. Never retried,
 *              at any level, for any reason. A silent retry burns the full price and refuses again;
 *              §6.2 is explicit that a refusal is a `needs_review` state with honest user-facing
 *              copy and a route back into the modal. A refusal that gets retried five times is the
 *              single most expensive bug this pipeline can have.
 *
 * A fourth class, INTERNAL, covers our own bugs — a missing API key, an SDK surface that moved, a
 * dispatch naming a draft that does not exist. Those reproduce exactly on retry, so burning the
 * ladder on them turns a five-second failure into a twenty-minute one.
 *
 * WHY THIS READS `code` RATHER THAN USING `instanceof`. Every error class in `@aibuilder/ai` and in
 * `src/errors.ts` restores its prototype after construction, so `instanceof` works within a bundle.
 * It does NOT reliably work across one: this Worker bundles `@aibuilder/ai` from source, and a
 * future build that dedupes or re-exports it differently would silently make every branch false and
 * make every refusal look like an unknown failure — which is to say, retryable. Reading a stable
 * string discriminator cannot fail that way.
 */

/** How a failure should be treated. */
export type FailureClass = 'transport' | 'content' | 'policy' | 'internal';

/** The verdict on one thrown value. */
export interface StepFailureDecision {
  readonly failureClass: FailureClass;
  /** True when Workflows should retry the step. False makes it terminal for the whole run. */
  readonly retry: boolean;
  /** The terminal `generation_jobs.status` this failure ends the run in. */
  readonly jobStatus: 'failed' | 'timed_out' | 'cancelled';
  /** Written to `generation_jobs.error_code`. Constrained to `[a-z0-9_.]`, 1-64 characters. */
  readonly errorCode: string;
  /** True when a person must look at this run before anyone re-runs it. */
  readonly needsReview: boolean;
  /** From a provider `retry-after`, when there was one. */
  readonly retryAfterSeconds: number | null;
  /** The HTTP status the failure carried, for `generation_calls.http_status`. */
  readonly httpStatus: number | null;
}

/** Reads a string property off an unknown value without assuming a class. */
function stringProperty(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw: unknown = (value as Record<string, unknown>)[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** Reads a boolean property off an unknown value without assuming a class. */
function booleanProperty(value: unknown, key: string): boolean | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw: unknown = (value as Record<string, unknown>)[key];
  return typeof raw === 'boolean' ? raw : null;
}

/** Builds a decision, filling in the fields that follow from the class. */
function decide(
  failureClass: FailureClass,
  errorCode: string,
  options: {
    readonly retry?: boolean;
    readonly needsReview?: boolean;
    readonly jobStatus?: 'failed' | 'timed_out' | 'cancelled';
    readonly retryAfterSeconds?: number | null;
    readonly httpStatus?: number | null;
  } = {},
): StepFailureDecision {
  return {
    failureClass,
    retry: options.retry ?? (failureClass === 'transport' || failureClass === 'content'),
    jobStatus: options.jobStatus ?? 'failed',
    errorCode,
    needsReview: options.needsReview ?? false,
    retryAfterSeconds: options.retryAfterSeconds ?? null,
    httpStatus: options.httpStatus ?? null,
  };
}

/**
 * Classifies anything a step threw.
 *
 * Guarantees a total result for any input, including a thrown string, and that the two failures
 * whose cost is unbounded — a policy refusal and a canary leak — are never classified as retryable
 * whatever else the value carries.
 */
export function classifyStepFailure(error: unknown): StepFailureDecision {
  const code = stringProperty(error, 'code');

  switch (code) {
    // -- Policy. Terminal, and the only class that sets `needsReview`. ---------------------------
    case 'model_refusal':
      return decide('policy', 'needs_review.model_refusal', { retry: false, needsReview: true });
    case 'sentinel_leaked':
      // The four schema invariants mean the blast radius is bad copy rather than code execution,
      // but a document that echoed the prompt envelope was written by the tenant's text rather than
      // by the model, and it must never reach a publish step.
      return decide('policy', 'needs_review.sentinel_leaked', { retry: false, needsReview: true });
    case 'policy_not_passed':
      return decide('policy', 'needs_review.policy_screen', { retry: false, needsReview: true });

    // -- Content. Retried, because a retry draws a fresh sample. ----------------------------------
    case 'output_truncated':
      return decide('content', 'output_truncated');
    case 'malformed_output':
      return decide('content', 'malformed_output');
    case 'repair_exhausted':
      return decide('content', 'repair_exhausted');
    case 'document_invalid':
      // Deterministic: the same memoised documents re-assemble to the same findings. Not retried,
      // so the run fails in seconds with a report a human can act on rather than four times over.
      return decide('content', 'document_invalid', { retry: false });
    case 'audit_failed':
      return decide('content', 'audit_failed', { retry: false });
    case 'artifact_missing':
    case 'artifact_invalid':
      return decide('content', code);

    // -- Internal. Reproduces exactly on retry. ---------------------------------------------------
    case 'missing_api_key':
      return decide('internal', 'missing_api_key', { retry: false });
    case 'sdk_surface_mismatch':
      return decide('internal', 'sdk_surface_mismatch', { retry: false });
    case 'not_implemented_phase_1':
      return decide('internal', 'not_implemented', { retry: false });
    case 'draft_missing':
    case 'draft_not_ready':
    case 'intake_invalid':
      return decide('internal', code, { retry: false });
    case 'invalid_id':
    case 'invalid_key_segment':
    case 'invalid_slug':
    case 'unknown_industry':
    case 'unknown_locale':
      return decide('internal', code, { retry: false });

    // -- Transport, named. ------------------------------------------------------------------------
    case 'screen_failed':
      return decide('transport', 'screen_failed');
    case 'step_deadline':
      // The step's own guard fired before the Workflow's timeout would have, which is what makes
      // this classifiable at all: an unguarded step timeout arrives as an opaque platform error.
      return decide('transport', 'step_deadline', { jobStatus: 'timed_out' });
    case 'job_cancelled':
      return decide('internal', 'job_cancelled', { retry: false, jobStatus: 'cancelled' });
    default:
      break;
  }

  // Not one of ours. Either an SDK/transport error carrying a status, or something unforeseen.
  const transport = classifyTransportError(error);
  const retryable = booleanProperty(error, 'retryable');
  return decide(transport.retryable ? 'transport' : 'internal', `transport.${transport.reason}`, {
    // An explicit `retryable: false` on the error wins over the transport heuristic: a 400 that
    // some layer already decided is our own bug must not be retried because the status looked
    // transient.
    retry: retryable === false ? false : transport.retryable,
    retryAfterSeconds: transport.retryAfterSeconds,
    httpStatus: transport.status,
  });
}

/**
 * The Workflow retry configuration for one failure class.
 *
 * `limit` is the number of RETRIES, not attempts. Content failures get one retry and not three,
 * because every attempt is a full-price Opus call and the second identical failure is evidence
 * about the prompt rather than about luck.
 *
 * The three constants below are `as const`, and that is deliberate rather than stylistic: the
 * platform types `delay` and `timeout` as template-literal duration strings, so a value widened to
 * `string` is not assignable to `step.do()`'s config. Keeping the literals is what lets this file
 * describe the policy without importing a platform type name that moves between releases.
 */
export interface RetryPolicy {
  readonly limit: number;
  readonly delay: string;
  readonly backoff: 'constant' | 'linear' | 'exponential';
}

/**
 * Retries for a step that spends model tokens.
 *
 * Three attempts total. Exponential from ten seconds absorbs an Anthropic 429 — there is no
 * Priority Tier on Opus 5, so a rate limit must be waited out rather than bought around (§10 risk
 * 5) — without letting a persistent outage hold a customer's progress bar for an hour.
 */
export const MODEL_STEP_RETRIES = {
  limit: 2,
  delay: '10 seconds',
  backoff: 'exponential',
} as const satisfies RetryPolicy;

/** Retries for a deterministic step. Cheap to repeat, so it gets more of them and a shorter delay. */
export const DETERMINISTIC_STEP_RETRIES = {
  limit: 3,
  delay: '2 seconds',
  backoff: 'exponential',
} as const satisfies RetryPolicy;

/** Retries for a step whose only failure mode is a busy dependency (D1, R2, a DO). */
export const IO_STEP_RETRIES = {
  limit: 5,
  delay: '1 second',
  backoff: 'exponential',
} as const satisfies RetryPolicy;
