/**
 * Errors this Worker raises itself, as distinct from the ones it re-classifies.
 *
 * `@aibuilder/ai` owns everything a model call can do wrong; `@aibuilder/core` and
 * `@aibuilder/site-schema` own their own domains. What is left — a dispatch that names a draft that
 * is not there, a document that survived the repair ladder and still cannot be published, a step
 * that ran out of its own wall clock — belongs here.
 *
 * Every one carries `retryable`, because that is the only question `src/retry.ts` asks. The default
 * is `false`: a failure whose retry semantics nobody thought about must not silently cost four more
 * Opus calls.
 */

/** Stable, greppable discriminator. Matches the `[a-z0-9_.]` charset `error_code` accepts. */
export type GeneratorErrorCode =
  | 'draft_missing'
  | 'draft_not_ready'
  /** The stored intake screen verdict is not `pass`. Terminal `needs_review`, never retried. */
  | 'policy_not_passed'
  | 'intake_invalid'
  | 'artifact_missing'
  | 'artifact_invalid'
  | 'document_invalid'
  | 'audit_failed'
  | 'step_deadline'
  /**
   * Raised by a caller that stopped a run on purpose.
   *
   * Nothing in this Worker throws it today: cancellation goes through the Workflow instance's
   * `terminate()`, which stops the spend without unwinding through `run()` (§6.4). The code exists
   * because the retry ladder must classify it as terminal rather than as an unknown failure the
   * moment the Phase 2 modal grows a cancel button and the API starts writing the row.
   */
  | 'job_cancelled';

/** Base class for every error raised by the generator itself. */
export class GeneratorError extends Error {
  public readonly code: GeneratorErrorCode;
  /** True when re-running the step unchanged has a real chance of succeeding. */
  public readonly retryable: boolean;
  /** Machine-readable context for the ledger. Never contains tenant free text. */
  public readonly detail: string | null;

  public constructor(
    code: GeneratorErrorCode,
    message: string,
    options: { readonly retryable?: boolean; readonly detail?: string | null } = {},
  ) {
    super(message);
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.detail = options.detail ?? null;
    this.name = 'GeneratorError';
    // esbuild downlevels `extends Error` on some targets, severing the prototype chain and breaking
    // `instanceof` across bundle boundaries.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The dispatch named a draft the control plane does not have, or that is not submitted. */
export class DraftUnavailableError extends GeneratorError {
  public constructor(code: 'draft_missing' | 'draft_not_ready', detail: string) {
    super(code, `Draft is not usable: ${detail}`, { retryable: false, detail });
    this.name = 'DraftUnavailableError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * A step artefact could not be read back from R2, or did not validate against its schema.
 *
 * Retryable: steps pass R2 keys rather than payloads, so a missing object usually means the writing
 * step's own retry has not landed yet, and re-running re-writes it.
 */
export class ArtifactError extends GeneratorError {
  public readonly key: string;

  public constructor(code: 'artifact_missing' | 'artifact_invalid', key: string, detail: string) {
    super(code, `Artefact ${key}: ${detail}`, { retryable: true, detail });
    this.key = key;
    this.name = 'ArtifactError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The assembled document carries a blocking lint finding.
 *
 * Retryable at the step level, which means Workflows re-runs `assemble` — and because the ai steps
 * are memoised, that is a deterministic re-assembly of the same documents and will produce the same
 * finding. That is the point: the retry ladder exhausts quickly and the run fails honestly instead
 * of publishing a site whose body text fails contrast or whose WhatsApp button has no number.
 */
export class DocumentInvalidError extends GeneratorError {
  public readonly findings: readonly string[];

  public constructor(findings: readonly string[]) {
    super(
      'document_invalid',
      `Assembled document has ${String(findings.length)} blocking finding(s)`,
      { retryable: false, detail: findings.slice(0, 5).join('; ') },
    );
    this.findings = findings;
    this.name = 'DocumentInvalidError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A step's own wall-clock guard fired before the Workflow's step timeout would have. */
export class StepDeadlineError extends GeneratorError {
  public constructor(step: string, budgetMs: number) {
    super('step_deadline', `Step "${step}" exceeded its ${String(budgetMs)} ms budget`, {
      retryable: true,
      detail: step,
    });
    this.name = 'StepDeadlineError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
