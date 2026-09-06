import {
  STEP_CONFIGS,
  businessFactsFromIntake,
  generateStructure,
  newEnvelopeSecrets,
} from '@aibuilder/ai';
import type { Intake, Locale } from '@aibuilder/core';
import { shardById } from '@aibuilder/db';
import { deriveSlotInventory } from '@aibuilder/site-schema';
import type { NormalizeContext } from '@aibuilder/site-schema';

import { modelRuntime } from '../anthropic';
import { putArtifact, putTranscript, runArtifactKey } from '../artifacts';
import type { ArtifactRef } from '../artifacts';
import type { Env } from '../env';
import type { RunIds } from '../ids';
import { closeCall, finishCallFromError, nextAttempt, openCall } from '../ledger';
import type { ProgressEmitter } from '../progress';
import type { MediaManifest } from './media';

/**
 * Step 3, `plan-brief` — one `claude-opus-5` call producing a `SiteStructureGen`.
 *
 * THIS DOCUMENT CONTAINS NO PROSE. Not one visible sentence: pages, sections, variants, the design
 * DNA and the typed JSON-LD inputs, and nothing else. Copy is a separate call addressed by slot ids
 * DERIVED from the ids chosen here (§S5). That separation is what makes the copy step's key-set
 * equality check mean something, and it is why this step is the one that gets `effort: "high"` —
 * its judgement compounds across every page of the site, so it is not the place to economise.
 *
 * IT IS ALSO THE CALL THAT WRITES THE CACHE. The ~22K-token frozen prefix is paid for here at
 * 1.25x, and steps 4 onward read it at 0.1x seconds later (§6.3). Everything about the request that
 * could vary — effort, thinking, the system blocks — is therefore pinned, and the tenant's data
 * sits after the single breakpoint where varying it costs nothing.
 */

/** How many posts the blog step will produce. The structure is told, so a teaser is honest. */
export const PLANNED_BLOG_POSTS = 2;

/** The wall-clock budget one model step runs under. Set by the Workflow, not by the step. */
export interface ModelStepTiming {
  /** The SDK's own request timeout, in milliseconds. Strictly below the Workflow step timeout. */
  readonly sdkTimeoutMs: number;
  /** Bounds the WHOLE step including every repair round. Strictly below the step timeout. */
  readonly signal: AbortSignal;
}

/** What the structure step hands to the rest of the run. Keys and counts only. */
export interface StructureResult {
  readonly structure: ArtifactRef;
  readonly pageCount: number;
  readonly sectionCount: number;
  /** The number of strings the copy step has to write. The single best predictor of its cost. */
  readonly slotCount: number;
  /** Two-to-four English words the model chose. Recorded for the Phase 2 stock re-query. */
  readonly stockQueryHint: string;
  /** The model's own read on whether the tenant's text tried to instruct it. Never a refusal. */
  readonly containsInstructions: boolean;
  readonly costUsdMicro: number;
  readonly repairRounds: number;
}

/**
 * Builds the normalisation context every generated document is repaired against.
 *
 * `knownMediaRefIds` is what makes invariant 2 of §4 enforceable rather than aspirational: a
 * `refId` the manifest does not contain is deleted, so the model cannot invent an image, and it
 * cannot smuggle a URL through a field that was only ever meant to hold a manifest key.
 *
 * Phase 1 enables exactly ONE locale (§0: six machine-translated copies of one bakery's content is
 * the scaled-content-abuse pattern the SEO rules exist to prevent). `intake.extraLocales` is stored
 * and is the Phase 2 fan-out's input; it is deliberately not in `allowedLocales` here, so a model
 * that emits a second locale has it coerced rather than silently publishing an unwritten one.
 */
export function normalizeContextFor(intake: Intake, manifest: MediaManifest): NormalizeContext {
  const primaryLocale: Locale = intake.defaultLocale;
  return {
    knownMediaRefIds: new Set(manifest.candidates.map((candidate) => candidate.refId)),
    // Empty in Phase 1, and not an oversight: the only external URL onboarding collects is the
    // Google Business Profile link, and §8 keeps it out of the prompt entirely — it is merged in
    // from D1 at render time as a `sameAs`, never offered to the model as a link target.
    knownExternalRefIds: new Set<string>(),
    primaryLocale,
    allowedLocales: [primaryLocale],
  };
}

/**
 * Plans the site.
 *
 * Guarantees the stored structure is schema-valid and normalised, that its ledger row is written on
 * every path including a refusal, and that a transcript of every round is in R2 before the step
 * returns — a paid call with no transcript is a cost investigation that cannot be run.
 *
 * Idempotent in the sense that matters: a retry makes a NEW call (there is no way to make a model
 * call idempotent) but overwrites the same artefact key and inserts a distinctly-numbered ledger
 * row, so the run never ends up reading a mix of two attempts.
 */
export async function runStructureStep(
  env: Env,
  ids: RunIds,
  input: {
    readonly intake: Intake;
    readonly manifest: MediaManifest;
    readonly emitter: ProgressEmitter;
    readonly timing: ModelStepTiming;
  },
): Promise<StructureResult> {
  const db = shardById(ids.shardId, env);
  const config = STEP_CONFIGS.structure;
  const runtime = await modelRuntime(env, input.timing.sdkTimeoutMs);

  const attempt = await nextAttempt(db, ids.jobId, 'structure');
  const ledger = { db, jobId: ids.jobId, step: 'structure' as const, attempt };
  const callId = await openCall(ledger, {
    model: runtime.model,
    effort: config.effort,
    thinkingType: 'adaptive',
    thinkingDisplay: 'summarized',
    maxTokens: config.maxTokens,
    taskBudgetTotal: config.taskBudgetTotal,
    streamed: true,
    schemaName: config.schemaName,
  });

  const secrets = newEnvelopeSecrets();
  const facts = businessFactsFromIntake(input.intake, {
    media: input.manifest.candidates,
    externalLinks: [],
  });

  try {
    const result = await generateStructure({
      context: {
        client: runtime.client,
        model: runtime.model,
        onDelta: input.emitter.deltaSink('streaming', 30),
        signal: input.timing.signal,
      },
      facts,
      secrets,
      normalizeContext: normalizeContextFor(input.intake, input.manifest),
      plannedBlogPosts: PLANNED_BLOG_POSTS,
    });

    await closeCall(env, ledger, callId, result.call);
    await putTranscript(env.BLOBS, {
      jobId: ids.jobId,
      step: 'structure',
      attempt,
      payload: { calls: result.calls, repairs: result.repairs },
    });
    const ref = await putArtifact(
      env.BLOBS,
      runArtifactKey(ids.jobId, 'structure'),
      result.structure,
    );

    const sectionCount = result.structure.pages.reduce(
      (total, page) => total + page.sections.length,
      0,
    );
    return {
      structure: ref,
      pageCount: result.structure.pages.length,
      sectionCount,
      slotCount: deriveSlotInventory(result.structure).slots.length,
      stockQueryHint: result.structure.stockQueryHint,
      containsInstructions: result.structure.inputSafety.containsInstructions,
      costUsdMicro: result.call.costUsdMicro,
      repairRounds: result.call.repairRounds,
    };
  } catch (error) {
    await finishCallFromError(env, ledger, callId, error);
    throw error;
  }
}
