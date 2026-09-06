import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { IntakeSchema } from '@aibuilder/core';
import type { Intake } from '@aibuilder/core';
import { shard, shardById } from '@aibuilder/db';
import { LocaleBundleGen, SiteDocSchema, SiteStructureGen } from '@aibuilder/site-schema';
import type { BlogPostInput } from '@aibuilder/site-schema';

import { stepDeadline } from './anthropic';
import { readArtifact, runArtifactKey } from './artifacts';
import { budgetStub } from './do/jurisdiction';
import type { Env, SiteGenerationParams } from './env';
import { runIds } from './ids';
import type { RunIds } from './ids';
import { recordStepOutcome } from './ledger';
import { createProgressEmitter } from './progress';
import type { Phrase, ProgressEmitter } from './progress';
import {
  DETERMINISTIC_STEP_RETRIES,
  IO_STEP_RETRIES,
  MODEL_STEP_RETRIES,
  classifyStepFailure,
} from './retry';
import type { RetryPolicy, StepFailureDecision } from './retry';
import { runAssembleStep } from './steps/assemble';
import { runAuditStep } from './steps/audit';
import { BlogArtifactSchema, runBlogStep } from './steps/blog';
import { runCopyStep } from './steps/copy';
import { LegalPackSchema, runLegalStep } from './steps/legal';
import { MediaManifestSchema, runMediaStep } from './steps/media';
import type { MediaManifest } from './steps/media';
import { runPublishStep } from './steps/publish';
import { runRenderStep } from './steps/render';
import { PLANNED_BLOG_POSTS, runStructureStep } from './steps/structure';
import { runValidateStep } from './steps/validate';

/**
 * `SiteGenerationWorkflow` — the ten steps of §6.1, in order, each with an explicit timeout.
 *
 * WHY A WORKFLOW AND NOT A QUEUE OR `waitUntil`. Queues and Durable Object alarms both cap at 15
 * minutes of wall clock; a four-Opus-call generation with a repair round does not reliably fit in
 * that, and neither of them memoises. A Workflow step's ceiling is 30 minutes and its results are
 * durable, which is simultaneously the reliability story and the cost-control story: a failed blog
 * post retries alone while everything before it stays memoised and paid for exactly once.
 *
 * FOUR RULES GOVERN EVERY STEP BELOW. They are requirements, not preferences:
 *
 *   1. EVERY STEP HAS AN EXPLICIT `timeout`. The `StepConfig` default is 10 minutes, which is below
 *      the time a `copy-primary` call legitimately takes, so a default-timeout step would kill
 *      successful generations after their tokens were billed and then pay for them again on the
 *      retry. The hard ceiling is 30 minutes and the table below stays under it.
 *
 *   2. STEPS PASS R2 KEYS, NEVER PAYLOADS. A non-streaming `step.do()` return is capped at 1 MiB
 *      and is stored durably for the life of the instance. Every step therefore writes its document
 *      to R2 and returns a key plus the counts the next step branches on, and every step body reads
 *      what it needs back — which is also what makes a step correct when a resume lands it on a
 *      different isolate three minutes later.
 *
 *   3. `run()` IS REPLAYED IN FULL ON EVERY RESUME. Memoised steps return their cached result
 *      without re-executing their bodies, but everything between them runs again, from the top,
 *      every time. So every `emit()` in this file lives INSIDE a `step.do()` and carries a stable
 *      idempotency key — see the header of `src/progress.ts` for why a counter-based key would be
 *      wrong and a literal label is right.
 *
 *   4. EVERY STEP IS IDEMPOTENT. They will be retried. Artefacts are overwritten at a fixed key,
 *      the version is resolved from the job row rather than created blindly, and the ledger's
 *      attempt number is derived from the rows already present.
 *
 * THE RETRY LADDER (`src/retry.ts`) is applied here, in `guard()`: a transport failure is retried
 * with backoff, a content failure is retried once because a retry draws a fresh sample, and a
 * POLICY REFUSAL IS TERMINAL and is never retried at any level — it is wrapped in
 * `NonRetryableError` so the platform stops immediately rather than spending three more full-price
 * calls to be refused three more times.
 *
 * WHERE THIS DELIVERY STOPS, AND WHY THAT IS VISIBLE RATHER THAN HIDDEN. `render` and `publish` are
 * owned by `@aibuilder/site-kit` and `@aibuilder/core`, which are not part of this delivery
 * (VERIFIED-FACTS.md, deliberate deviation 2). They are declared here as real steps, with real
 * timeouts and real retry policies, and they throw `NotImplementedInPhase1`. So until those
 * packages ship, EVERY run completes steps 1-8 — the SiteDoc is assembled, audited and stored, the
 * ledger is written and the budget is settled — and then terminates at `render` with
 * `error_code = 'not_implemented'`. That is a truthful `generation_jobs` row and a truthful progress
 * event, which is worth more than a green bar over a site that does not exist.
 */

/** The wall-clock envelope of one step. */
interface StepBudget {
  /**
   * The Workflow step timeout. Under the 30-minute platform ceiling, always explicit.
   */
  readonly timeout: string;
  /**
   * The step's own deadline, as an `AbortSignal`, in milliseconds. Strictly below `timeout`.
   *
   * It exists because a model step is not one call: the repair ladder makes up to three, so
   * `SDK timeout < step timeout` alone would let a three-round step run to three times the SDK
   * timeout. One signal shared by every round bounds the step as a whole, and it fires BEFORE the
   * platform's own timeout so the failure arrives as a typed abort the ladder can classify rather
   * than as an opaque platform error.
   */
  readonly guardMs: number;
  /** The SDK's per-request timeout, in milliseconds. Strictly below `guardMs`. */
  readonly sdkTimeoutMs: number;
  readonly retries: RetryPolicy;
}

const MINUTE = 60_000;

/**
 * Per-step budgets.
 *
 * The chain `sdkTimeoutMs < guardMs < timeout < 30 minutes` holds for every model step, and each
 * link is load-bearing — see `src/anthropic.ts` for why the SDK must abort first and why 180
 * seconds would be catastrophically wrong.
 */
const BUDGETS = {
  claim: { timeout: '1 minute', guardMs: 45_000, sdkTimeoutMs: 0, retries: IO_STEP_RETRIES },
  validate: {
    timeout: '2 minutes',
    guardMs: 100_000,
    sdkTimeoutMs: 0,
    retries: DETERMINISTIC_STEP_RETRIES,
  },
  // Stock lookup plus up to three re-hosts of up to 8 MB each, against a third-party API that is
  // allowed to be slow. Every one of those has its own short timeout; this bounds the sum.
  media: {
    timeout: '6 minutes',
    guardMs: 5 * MINUTE,
    sdkTimeoutMs: 0,
    retries: DETERMINISTIC_STEP_RETRIES,
  },
  structure: {
    timeout: '25 minutes',
    guardMs: 23 * MINUTE,
    sdkTimeoutMs: 10 * MINUTE,
    retries: MODEL_STEP_RETRIES,
  },
  copy: {
    timeout: '25 minutes',
    guardMs: 23 * MINUTE,
    sdkTimeoutMs: 10 * MINUTE,
    retries: MODEL_STEP_RETRIES,
  },
  blog: {
    timeout: '15 minutes',
    guardMs: 13 * MINUTE,
    sdkTimeoutMs: 6 * MINUTE,
    retries: MODEL_STEP_RETRIES,
  },
  legal: {
    timeout: '1 minute',
    guardMs: 45_000,
    sdkTimeoutMs: 0,
    retries: DETERMINISTIC_STEP_RETRIES,
  },
  assemble: {
    timeout: '5 minutes',
    guardMs: 4 * MINUTE,
    sdkTimeoutMs: 0,
    retries: DETERMINISTIC_STEP_RETRIES,
  },
  audit: {
    timeout: '3 minutes',
    guardMs: 2 * MINUTE,
    sdkTimeoutMs: 0,
    retries: DETERMINISTIC_STEP_RETRIES,
  },
  render: {
    timeout: '10 minutes',
    guardMs: 9 * MINUTE,
    sdkTimeoutMs: 0,
    retries: DETERMINISTIC_STEP_RETRIES,
  },
  publish: {
    timeout: '10 minutes',
    guardMs: 9 * MINUTE,
    sdkTimeoutMs: 0,
    retries: IO_STEP_RETRIES,
  },
  finalise: { timeout: '2 minutes', guardMs: 100_000, sdkTimeoutMs: 0, retries: IO_STEP_RETRIES },
} as const satisfies Readonly<Record<string, StepBudget>>;

/**
 * Builds the `step.do()` config for one budget.
 *
 * Generic in the budget so the LITERAL types survive. The platform types `timeout` and
 * `retries.delay` as template-literal duration strings (`"25 minutes"`), and a value widened to
 * `string` is not assignable to them — so a non-generic parameter here would force every call site
 * to re-state its own timeout inline, which is exactly the duplication the table exists to prevent.
 */
function options<T extends { readonly retries: RetryPolicy; readonly timeout: string }>(
  budget: T,
): { readonly retries: T['retries']; readonly timeout: T['timeout'] } {
  return { retries: budget.retries, timeout: budget.timeout };
}

/* -- User-facing copy ------------------------------------------------------------------------- */

/**
 * The progress lines, in Dutch and English.
 *
 * Dutch is the product's primary language; the English line rides alongside in the event's `data`
 * so the modal can switch without a second round trip. They are written as statements about the
 * customer's business rather than about our pipeline — "we kiezen de opbouw van je site" and not
 * "running step 3 of 10" — because this text is the entire product experience for ninety seconds.
 */
const COPY = {
  claimed: {
    nl: 'We zijn begonnen met je website.',
    en: 'We have started building your website.',
  },
  validate: {
    nl: 'We controleren je gegevens.',
    en: 'Checking the details you entered.',
  },
  media: {
    nl: 'We zoeken de beelden voor je site.',
    en: 'Finding the imagery for your site.',
  },
  structure: {
    nl: 'We bepalen de opbouw en de stijl van je site.',
    en: 'Choosing the structure and style of your site.',
  },
  copy: {
    nl: 'We schrijven de teksten voor je pagina’s.',
    en: 'Writing the copy for your pages.',
  },
  blog: {
    nl: 'We schrijven je eerste blogartikelen.',
    en: 'Writing your first blog articles.',
  },
  legal: {
    nl: 'We zetten je privacyverklaring en voorwaarden klaar.',
    en: 'Preparing your privacy statement and terms.',
  },
  assemble: {
    nl: 'We zetten je website in elkaar.',
    en: 'Putting your website together.',
  },
  audit: {
    nl: 'We controleren de kwaliteit van je site.',
    en: 'Checking the quality of your site.',
  },
  deploy: {
    nl: 'We zetten je website klaar.',
    en: 'Getting your website ready.',
  },
  done: {
    nl: 'Je website staat klaar.',
    en: 'Your website is ready.',
  },
} as const satisfies Readonly<Record<string, Phrase>>;

/** The honest failure line for one classified failure. */
function failureCopy(decision: StepFailureDecision): Phrase {
  if (decision.needsReview) {
    return {
      nl: 'We kunnen deze website niet automatisch maken. Een collega kijkt ernaar en neemt contact met je op.',
      en: 'We cannot build this website automatically. A colleague will review it and contact you.',
    };
  }
  if (decision.errorCode === 'not_implemented') {
    return {
      nl: 'Je site is opgebouwd, maar publiceren is nog niet beschikbaar in deze versie.',
      en: 'Your site has been built, but publishing is not available in this release yet.',
    };
  }
  if (decision.failureClass === 'transport') {
    return {
      nl: 'Het lukte even niet om je site af te maken. We proberen het opnieuw.',
      en: 'We could not finish your site just now. We are trying again.',
    };
  }
  return {
    nl: 'Er ging iets mis bij het bouwen van je site. We hebben je gegevens bewaard en nemen contact op.',
    en: 'Something went wrong while building your site. We kept your details and will be in touch.',
  };
}

/* -- The Workflow ----------------------------------------------------------------------------- */

export class SiteGenerationWorkflow extends WorkflowEntrypoint<Env, SiteGenerationParams> {
  public override async run(
    event: WorkflowEvent<SiteGenerationParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const env = this.env;
    const params = event.payload;
    // Throws before any step runs if the dispatch is malformed. Nothing here is worth attempting
    // against identifiers that cannot address a row.
    const ids: RunIds = runIds(params);
    const db = shardById(ids.shardId, env);
    // The Workflow instance id IS the job id, so it is also the run id: one run, one event log,
    // one idempotency namespace.
    const emitter = createProgressEmitter(env, params, ids.jobId);

    /**
     * The classification of the failure that actually surfaced.
     *
     * Written by `guard()` and read by the terminal handler in the same `run()` invocation, because
     * a `NonRetryableError` carries a message and nothing else — wrapping the original would lose
     * the `code` the ladder classifies on. A holder object rather than a `let`, so the value the
     * catch reads is unambiguously the one the closure wrote.
     */
    const surfaced: { decision: StepFailureDecision | null } = { decision: null };

    /**
     * Runs one step body, applying the retry ladder.
     *
     * A non-retryable classification is re-thrown as `NonRetryableError` so the platform stops
     * immediately: for a refusal, three more attempts is three more full-price calls that will be
     * refused again.
     */
    const guard = async <T>(name: string, body: () => Promise<T>): Promise<T> => {
      const startedAt = Date.now();
      try {
        const result = await body();
        recordStepOutcome(env, {
          jobId: ids.jobId,
          step: name,
          outcome: 'ok',
          durationMs: Date.now() - startedAt,
        });
        return result;
      } catch (error) {
        const classified = classifyStepFailure(error);
        surfaced.decision = classified;
        recordStepOutcome(env, {
          jobId: ids.jobId,
          step: name,
          outcome: classified.errorCode,
          durationMs: Date.now() - startedAt,
        });
        if (!classified.retry) {
          throw new NonRetryableError(`${name}: ${classified.errorCode}`);
        }
        throw error;
      }
    };

    /** Reads the validated intake. Every step that needs it reads it; nothing passes it through. */
    const readIntake = (): Promise<Intake> =>
      readArtifact(env.BLOBS, runArtifactKey(ids.jobId, 'intake'), IntakeSchema);

    const readManifest = (): Promise<MediaManifest> =>
      readArtifact(env.BLOBS, runArtifactKey(ids.jobId, 'media'), MediaManifestSchema);

    const readStructure = (): Promise<SiteStructureGen> =>
      readArtifact(env.BLOBS, runArtifactKey(ids.jobId, 'structure'), SiteStructureGen);

    try {
      // ---- 0. Claim ---------------------------------------------------------------------------
      // Not one of the ten, and not optional: the job row exists in `queued` and this is what moves
      // it to `running`, stamps `started_at` and takes the lease the stuck-job reaper reads.
      await step.do('claim', options(BUDGETS.claim), async () =>
        guard('claim', async () => {
          await shard.generationJobs.claimQueuedJob(db, {
            jobId: ids.jobId,
            // The instance id IS the job id, so no second worker can hold this lease. The value is
            // for the reaper's audit trail, not for mutual exclusion.
            lockedBy: `workflow:${ids.jobId}`,
            lockExpiresAt: Date.now() + 45 * MINUTE,
            now: Date.now(),
          });
          await emitter.emit('claimed', { phase: 'queued', message: COPY.claimed });
          return { claimed: true };
        }),
      );

      // ---- 1. validate-intake ------------------------------------------------------------------
      const validated = await step.do('validate', options(BUDGETS.validate), async () =>
        guard('validate', async () => {
          await emitter.emit('validate.start', {
            phase: 'prompt_built',
            message: COPY.validate,
          });
          return runValidateStep(env, params);
        }),
      );

      // ---- 2. resolve-media --------------------------------------------------------------------
      const media = await step.do('media', options(BUDGETS.media), async () =>
        guard('media', async () => {
          await emitter.emit('media.start', {
            phase: 'media_fetch',
            message: COPY.media,
          });
          return runMediaStep(env, ids, await readIntake());
        }),
      );

      // ---- 3. plan-brief -----------------------------------------------------------------------
      const structure = await step.do('structure', options(BUDGETS.structure), async () =>
        guard('structure', async () => {
          await emitter.emit('structure.start', {
            phase: 'api_call',
            message: COPY.structure,
            data: { uploads: media.uploadCount, stock: media.stockCount },
          });
          return runStructureStep(env, ids, {
            intake: await readIntake(),
            manifest: await readManifest(),
            emitter,
            timing: {
              sdkTimeoutMs: BUDGETS.structure.sdkTimeoutMs,
              signal: stepDeadline(BUDGETS.structure.guardMs),
            },
          });
        }),
      );

      // ---- 4. copy-primary ---------------------------------------------------------------------
      const copy = await step.do('copy', options(BUDGETS.copy), async () =>
        guard('copy', async () => {
          await emitter.emit('copy.start', {
            phase: 'streaming',
            message: COPY.copy,
            data: { pages: structure.pageCount, slots: structure.slotCount },
          });
          return runCopyStep(env, ids, {
            intake: await readIntake(),
            manifest: await readManifest(),
            structure: await readStructure(),
            emitter,
            timing: {
              sdkTimeoutMs: BUDGETS.copy.sdkTimeoutMs,
              signal: stepDeadline(BUDGETS.copy.guardMs),
            },
          });
        }),
      );

      // ---- 5. blog-0 … blog-N ------------------------------------------------------------------
      // Sequential rather than parallel, for two reasons that both matter: the second post is given
      // the first's title so it does not write the same article twice, and §6.3 is explicit that N
      // parallel requests with identical prefixes ALL pay full price because none can read what the
      // others are still writing.
      const blogTitles: string[] = [];
      for (let index = 0; index < PLANNED_BLOG_POSTS; index += 1) {
        const existing = [...blogTitles];
        const post = await step.do(`blog-${String(index)}`, options(BUDGETS.blog), async () =>
          guard('blog', async () => {
            await emitter.emit(`blog.${String(index)}.start`, {
              phase: 'pages_written',
              message: COPY.blog,
              data: { index: index + 1, of: PLANNED_BLOG_POSTS },
            });
            return runBlogStep(env, ids, {
              index,
              intake: await readIntake(),
              manifest: await readManifest(),
              structure: await readStructure(),
              existingTitles: existing,
              emitter,
              timing: {
                sdkTimeoutMs: BUDGETS.blog.sdkTimeoutMs,
                signal: stepDeadline(BUDGETS.blog.guardMs),
              },
            });
          }),
        );
        blogTitles.push(post.title);
      }

      // ---- 6. legal ----------------------------------------------------------------------------
      await step.do('legal', options(BUDGETS.legal), async () =>
        guard('legal', async () => {
          await emitter.emit('legal.start', { phase: 'build', message: COPY.legal });
          return runLegalStep(env, ids, await readIntake());
        }),
      );

      // ---- 7. assemble -------------------------------------------------------------------------
      const assembled = await step.do('assemble', options(BUDGETS.assemble), async () =>
        guard('assemble', async () => {
          await emitter.emit('assemble.start', {
            phase: 'build',
            message: COPY.assemble,
            data: { entries: copy.entryCount, slots: copy.slotCount },
          });
          const blog: BlogPostInput[] = [];
          for (let index = 0; index < PLANNED_BLOG_POSTS; index += 1) {
            blog.push(
              await readArtifact(
                env.BLOBS,
                runArtifactKey(ids.jobId, 'blog', index),
                BlogArtifactSchema,
              ),
            );
          }
          return runAssembleStep(env, ids, {
            intake: await readIntake(),
            manifest: await readManifest(),
            structure: await readStructure(),
            bundle: await readArtifact(
              env.BLOBS,
              runArtifactKey(ids.jobId, 'copy'),
              LocaleBundleGen,
            ),
            blog,
            legal: await readArtifact(
              env.BLOBS,
              runArtifactKey(ids.jobId, 'legal'),
              LegalPackSchema,
            ),
          });
        }),
      );

      // ---- 8. audit ----------------------------------------------------------------------------
      await step.do('audit', options(BUDGETS.audit), async () =>
        guard('audit', async () => {
          await emitter.emit('audit.start', {
            phase: 'build',
            message: COPY.audit,
            data: { pages: assembled.pageCount, warnings: assembled.warnings.length },
          });
          return runAuditStep(env, ids, {
            doc: await readArtifact(env.BLOBS, runArtifactKey(ids.jobId, 'sitedoc'), SiteDocSchema),
            legal: await readArtifact(
              env.BLOBS,
              runArtifactKey(ids.jobId, 'legal'),
              LegalPackSchema,
            ),
            versionId: assembled.versionId,
          });
        }),
      );

      // ---- 9. render ---------------------------------------------------------------------------
      // Out of this delivery. Declared as a real step so its timeout, its retry policy and its
      // position in the ordering are reviewed today; it throws `NotImplementedInPhase1`, which the
      // ladder classifies as terminal, so the run ends here with a truthful `error_code` rather
      // than with a green progress bar over a site that was never rendered.
      const rendered = await step.do('render', options(BUDGETS.render), async () =>
        guard('render', async () => {
          await emitter.emit('render.start', { phase: 'deploy', message: COPY.deploy });
          return runRenderStep(env, ids, {
            doc: await readArtifact(env.BLOBS, runArtifactKey(ids.jobId, 'sitedoc'), SiteDocSchema),
            versionId: assembled.versionId,
          });
        }),
      );

      // ---- 10. publish -------------------------------------------------------------------------
      await step.do('publish', options(BUDGETS.publish), async () =>
        guard('publish', async () =>
          runPublishStep(env, ids, {
            doc: await readArtifact(env.BLOBS, runArtifactKey(ids.jobId, 'sitedoc'), SiteDocSchema),
            rendered,
            versionId: assembled.versionId,
            canonicalHost: params.canonicalHost,
          }),
        ),
      );

      // ---- Terminal success --------------------------------------------------------------------
      await step.do('finalise', options(BUDGETS.finalise), async () => {
        const usage = await rollup(db, ids);
        await shard.generationJobs.finishJobSucceeded(db, {
          jobId: ids.jobId,
          versionId: null,
          usage,
          now: Date.now(),
        });
        await settleBudget(env, ids.jobId, usage.costUsdMicro);
        await emitter.emit('done', {
          phase: 'done',
          message: COPY.done,
          data: { siteUrl: `https://${params.canonicalHost}`, validated: validated.primaryLocale },
        });
        return { finished: true };
      });
    } catch (error) {
      // The terminal handler runs in the same `run()` invocation as the throw, so `decision` is the
      // classification of the failure that actually surfaced rather than a re-derivation from a
      // `NonRetryableError` that no longer carries the original code.
      const final: StepFailureDecision = surfaced.decision ?? classifyStepFailure(error);
      await this.finaliseFailure(env, ids, params, emitter, final);
      // Re-thrown so the Workflow instance itself is marked errored: an instance reported as
      // complete over a job row that says `failed` is two systems disagreeing about the same run.
      throw error;
    }
  }

  /**
   * Closes the job row, settles the budget and tells the customer, on every failing path.
   *
   * Not inside a `step.do()`: it must run even when a step has exhausted its retries, and every
   * write it makes is idempotent — `finishJobFailed` is guarded by a status predicate, the budget
   * settle is a no-op once the reservation is closed, and the emit carries an idempotency key.
   */
  private async finaliseFailure(
    env: Env,
    ids: RunIds,
    params: SiteGenerationParams,
    emitter: ProgressEmitter,
    decision: StepFailureDecision,
  ): Promise<void> {
    const db = shardById(ids.shardId, env);
    try {
      const usage = await rollup(db, ids);
      await shard.generationJobs.finishJobFailed(db, {
        jobId: ids.jobId,
        status: decision.jobStatus,
        errorCode: decision.errorCode,
        errorMessage: `${decision.failureClass}: ${decision.errorCode}`,
        usage,
        now: Date.now(),
      });
      // Settled at what was actually spent, not at estimate: a run that died after the structure
      // call cost roughly a third of one, and charging the day for a whole generation would ratchet
      // the ceiling down against work that never happened.
      await settleBudget(env, ids.jobId, usage.costUsdMicro);
    } catch {
      // A ledger write that fails must not swallow the original failure. The +10 minute BudgetDO
      // alarm force-settles the reservation and the stuck-job reaper closes the row.
    }

    await emitter.emit(`error.${decision.errorCode}`, {
      phase: 'error',
      message: failureCopy(decision),
      data: {
        code: decision.errorCode,
        needsReview: decision.needsReview,
        siteUrl: `https://${params.canonicalHost}`,
      },
    });
  }
}

/* -- Collaborators ---------------------------------------------------------------------------- */

/** Sums a run's calls into the rollup `generation_jobs` stores. Includes failed calls, by design. */
async function rollup(
  db: D1Database,
  ids: RunIds,
): Promise<{
  callsCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsdMicro: number;
}> {
  const sums = await shard.generationCalls.sumJobUsage(db, ids.jobId);
  return {
    callsCount: sums.calls_count,
    inputTokens: sums.input_tokens,
    outputTokens: sums.output_tokens,
    cacheCreationTokens: sums.cache_creation_tokens,
    cacheReadTokens: sums.cache_read_tokens,
    costUsdMicro: sums.cost_usd_micro,
  };
}

/**
 * Settles this run's budget reservation against what it actually cost.
 *
 * Addressed by JOB id, not by reservation id: the API opened the reservation at submit and the
 * Workflow is dispatched with identifiers only, so the job id is the handle both sides share.
 * Best-effort — the DO's +10 minute alarm force-settles orphans at estimate, so this is an
 * optimisation of a safety net rather than the safety net itself.
 */
async function settleBudget(env: Env, jobId: string, actualMicro: number): Promise<void> {
  try {
    await budgetStub(env).fetch('https://budget.internal/settle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jobId,
        actualMicro,
        // A run that spent nothing never happened, and its generation slot goes back: without that
        // a day of failed dispatches would exhaust the 250/day ceiling having generated nothing.
        counted: actualMicro > 0,
      }),
    });
  } catch {
    // Deliberately swallowed: see the JSDoc.
  }
}
