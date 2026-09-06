import type { CallUsage } from './usage';

/**
 * Typed errors for every way a model call can fail.
 *
 * The distinction this file exists to encode is the one architecture 7.6 calls "the whole game":
 * **transport** failures (429, 5xx, a dropped socket) are retried by Workflows, while **content**
 * failures (a refusal, a truncated document, a schema mismatch) are handled inside the step,
 * because a blind retry reproduces them at full price. Every error therefore carries `retryable`,
 * and every error carries the `usage` the call had already accrued -- an unwritten ledger row is a
 * call that spent money nobody can account for.
 */

/** Stable, greppable discriminator carried by every error this package throws. */
export type AiErrorCode =
  | 'not_implemented_phase_1'
  | 'missing_api_key'
  | 'sdk_surface_mismatch'
  | 'model_refusal'
  | 'output_truncated'
  | 'malformed_output'
  | 'repair_exhausted'
  | 'sentinel_leaked'
  | 'screen_failed';

/** Base class for every error thrown by `@aibuilder/ai`. */
export class AiError extends Error {
  public readonly code: AiErrorCode;
  /** True when re-running the same step unchanged has a real chance of succeeding. */
  public readonly retryable: boolean;
  /** Tokens already billed when this failed. `null` when the API never answered. */
  public readonly usage: CallUsage | null;
  public readonly requestId: string | null;

  public constructor(
    code: AiErrorCode,
    message: string,
    options: {
      readonly retryable: boolean;
      readonly usage?: CallUsage | null;
      readonly requestId?: string | null;
    },
  ) {
    super(message);
    this.code = code;
    this.retryable = options.retryable;
    this.usage = options.usage ?? null;
    this.requestId = options.requestId ?? null;
    this.name = 'AiError';
    // esbuild/Vite downlevel `extends Error` on some targets, which severs the prototype chain and
    // breaks `instanceof` across bundle boundaries. Every app bundles this package separately, so
    // this is not hypothetical.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by typed functions whose behaviour is scoped to a later phase.
 *
 * Guarantees a real, final-signature call site exists today so consumers compile against it, while
 * making the gap loud at runtime instead of silently returning a plausible-but-wrong value.
 */
export class NotImplementedInPhase1 extends AiError {
  public constructor(what: string) {
    super('not_implemented_phase_1', `Not implemented in Phase 1: ${what}`, { retryable: false });
    this.name = 'NotImplementedInPhase1';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when neither Secrets Store nor `wrangler secret put` produced an API key. */
export class MissingApiKeyError extends AiError {
  public constructor(detail: string) {
    super('missing_api_key', `ANTHROPIC_API_KEY is not usable: ${detail}`, { retryable: false });
    this.name = 'MissingApiKeyError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the installed SDK does not expose the surface this package was written against.
 *
 * The alternative -- a `TypeError: client.beta.messages.stream is not a function` from inside a
 * Workflow step -- classifies as an unknown failure and gets retried five times at full price.
 */
export class SdkSurfaceError extends AiError {
  public constructor(what: string) {
    super('sdk_surface_mismatch', `Anthropic SDK surface mismatch: ${what}`, { retryable: false });
    this.name = 'SdkSurfaceError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * A policy decline (HTTP 200, `stop_reason: "refusal"`).
 *
 * Terminal by construction: the job moves to `needs_review` with honest user-facing copy and a route
 * back into the modal. Never retried -- a silent retry burns the full price and refuses again.
 */
export class ModelRefusalError extends AiError {
  /** From `stop_details.category`. An open set, persisted verbatim so gating can be learned. */
  public readonly category: string | null;
  public readonly explanation: string | null;

  public constructor(args: {
    readonly category: string | null;
    readonly explanation: string | null;
    readonly usage: CallUsage | null;
    readonly requestId: string | null;
  }) {
    super(
      'model_refusal',
      `Model declined the request (category: ${args.category ?? 'unknown'}).`,
      {
        retryable: false,
        usage: args.usage,
        requestId: args.requestId,
      },
    );
    this.category = args.category;
    this.explanation = args.explanation;
    this.name = 'ModelRefusalError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * `stop_reason: "max_tokens"` -- the document was cut off mid-emission.
 *
 * Detected from `stop_reason`, never from the JSON parse error it causes: those two failures need
 * opposite responses and the parse error cannot tell them apart. Retryable once with a higher
 * ceiling; a recurrence means the call must be split (Phase 2: per-page copy).
 */
export class OutputTruncatedError extends AiError {
  public readonly maxTokens: number;

  public constructor(args: {
    readonly maxTokens: number;
    readonly usage: CallUsage | null;
    readonly requestId: string | null;
  }) {
    super('output_truncated', `Output hit the ${args.maxTokens}-token ceiling and was truncated.`, {
      retryable: true,
      usage: args.usage,
      requestId: args.requestId,
    });
    this.maxTokens = args.maxTokens;
    this.name = 'OutputTruncatedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The response ended normally but carried no usable JSON document.
 *
 * Grammar-constrained decoding makes this rare; when it happens a fresh sample usually fixes it, so
 * it is retryable rather than terminal.
 */
export class MalformedOutputError extends AiError {
  public readonly detail: string;

  public constructor(args: {
    readonly detail: string;
    readonly usage: CallUsage | null;
    readonly requestId: string | null;
  }) {
    super('malformed_output', `Model output could not be read as JSON: ${args.detail}`, {
      retryable: true,
      usage: args.usage,
      requestId: args.requestId,
    });
    this.detail = args.detail;
    this.name = 'MalformedOutputError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** One machine-generated defect handed back to the model, or logged when the ladder gives up. */
export interface Defect {
  /** Dotted path into the generation document, e.g. `pages.0.sections.2.items`. */
  readonly path: string;
  /** What is wrong, in one clause. */
  readonly problem: string;
  /** What a correct value looks like, in one clause. */
  readonly constraint: string;
}

/**
 * The repair ladder ran out of rounds.
 *
 * Retryable at the step level: Workflows re-runs the step from scratch, which draws a fresh sample
 * rather than pushing the same defective one through a third repair.
 */
export class RepairExhaustedError extends AiError {
  public readonly defects: readonly Defect[];
  public readonly rounds: number;

  public constructor(args: {
    readonly defects: readonly Defect[];
    readonly rounds: number;
    readonly usage: CallUsage | null;
  }) {
    const summary = args.defects
      .slice(0, 5)
      .map((defect) => `${defect.path}: ${defect.problem}`)
      .join('; ');
    super(
      'repair_exhausted',
      `Document still invalid after ${args.rounds} repair round(s): ${summary}`,
      { retryable: true, usage: args.usage },
    );
    this.defects = args.defects;
    this.rounds = args.rounds;
    this.name = 'RepairExhaustedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * A per-request sentinel from the prompt envelope appeared in the model's output.
 *
 * This is the injection canary firing (architecture 8). It is terminal and it alerts: the four
 * schema invariants mean the blast radius is bad copy rather than code execution, but a document
 * that echoes the envelope was written by the tenant's text rather than by the model, and it must
 * never reach a publish step.
 */
export class SentinelLeakedError extends AiError {
  public constructor(args: {
    readonly usage: CallUsage | null;
    readonly requestId: string | null;
  }) {
    super('sentinel_leaked', 'Model output contained a prompt-envelope sentinel.', {
      retryable: false,
      usage: args.usage,
      requestId: args.requestId,
    });
    this.name = 'SentinelLeakedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The Haiku intake screen could not produce a verdict. Callers fail closed, to `review`. */
export class ScreenFailedError extends AiError {
  public constructor(detail: string, usage: CallUsage | null) {
    super('screen_failed', `Intake policy screen produced no verdict: ${detail}`, {
      retryable: true,
      usage,
    });
    this.name = 'ScreenFailedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/* -- Transport classification ---------------------------------------------------------------- */

/** How a thrown SDK/transport error should be treated by the Workflow retry ladder. */
export interface TransportClassification {
  /** HTTP status, when the failure carried one. */
  readonly status: number | null;
  /** True when Workflows should retry the step with backoff. */
  readonly retryable: boolean;
  /** Seconds from a `retry-after` header, when the failure carried one. */
  readonly retryAfterSeconds: number | null;
  readonly reason: 'rate_limited' | 'server_error' | 'connection' | 'client_error' | 'unknown';
}

/** Reads a numeric property off an unknown error without assuming a class. */
function numericProperty(value: unknown, key: string): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw: unknown = (value as Record<string, unknown>)[key];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Classifies a thrown transport error without depending on the SDK's error classes.
 *
 * `instanceof Anthropic.RateLimitError` needs the SDK loaded, which defeats the lazy import that
 * keeps it off the Worker's startup CPU budget; and it is fragile across bundles, where a
 * downlevelled prototype chain silently makes every branch false and every 429 look like an unknown
 * failure. Reading `status` off the error is neither.
 *
 * Guarantees a total result for any input, including a thrown string.
 */
export function classifyTransportError(error: unknown): TransportClassification {
  const retryAfterSeconds =
    numericProperty(error, 'retryAfterSeconds') ??
    numericProperty((error as { headers?: unknown } | null)?.headers, 'retry-after');
  const status = numericProperty(error, 'status');

  if (status === null) {
    // No status: a connection reset, a DNS failure, or the SDK's own abort. All worth one retry.
    return { status: null, retryable: true, retryAfterSeconds, reason: 'connection' };
  }
  if (status === 429) return { status, retryable: true, retryAfterSeconds, reason: 'rate_limited' };
  if (status >= 500) return { status, retryable: true, retryAfterSeconds, reason: 'server_error' };
  if (status === 408 || status === 409) {
    return { status, retryable: true, retryAfterSeconds, reason: 'server_error' };
  }
  // 400 is our own bug (a malformed parameter, an invalid schema) and 401/403 is a credential
  // problem. Both reproduce exactly on retry, so they fail the job instead of burning the ladder.
  return { status, retryable: false, retryAfterSeconds, reason: 'client_error' };
}
