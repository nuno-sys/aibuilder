import {
  STEP_CONFIGS,
  businessFactsFromIntake,
  generateLocaleBundle,
  newEnvelopeSecrets,
} from '@aibuilder/ai';
import type { Intake } from '@aibuilder/core';
import { shardById } from '@aibuilder/db';
import { deriveSlotInventory } from '@aibuilder/site-schema';
import type { SiteStructureGen } from '@aibuilder/site-schema';

import { modelRuntime } from '../anthropic';
import { putArtifact, putTranscript, runArtifactKey } from '../artifacts';
import type { ArtifactRef } from '../artifacts';
import type { Env } from '../env';
import type { RunIds } from '../ids';
import { closeCall, finishCallFromError, nextAttempt, openCall } from '../ledger';
import type { ProgressEmitter } from '../progress';
import type { MediaManifest } from './media';
import { normalizeContextFor } from './structure';
import type { ModelStepTiming } from './structure';

/**
 * Step 4, `copy-primary` — one `claude-opus-5` call producing every visible string of one locale.
 *
 * THE SLOT INVENTORY IS THE CONTRACT. `deriveSlotInventory(structure)` is a pure function of the
 * section list, and the bundle's key set must equal it exactly. That check is only meaningful
 * because the generation schema has no `*Slot` fields for the model to invent — the ids are derived
 * from `(sectionId, field, index)` on both sides, so "the model wrote copy for a slot that does not
 * exist" and "the model skipped a slot" are both mechanically detectable, and the repair turn can
 * name the missing ids instead of asking for the document again (§S5).
 *
 * IT READS WHAT THE STRUCTURE CALL WROTE. This is the second call of the run and lands seconds
 * after the first, so the ~22K prefix is a cache READ at 0.1x rather than a write at 1.25x. That is
 * where prompt caching pays for itself in this product — within a single job. Cross-job hits are
 * upside, never the plan (§6.3), which is why nothing here varies the prefix per tenant.
 *
 * Phase 1 generates ONE locale. The step takes the locale as a parameter rather than reading it
 * from the structure, because Phase 2's fan-out calls this same function once per locale with a
 * per-message effort override, and a function that reads its own locale out of a shared document
 * cannot be called twice.
 */

/** What the copy step hands to the rest of the run. */
export interface CopyResult {
  readonly bundle: ArtifactRef;
  readonly locale: Intake['defaultLocale'];
  readonly entryCount: number;
  /** Slots the inventory expected. Equal to `entryCount` on a clean run; the gap is the signal. */
  readonly slotCount: number;
  readonly costUsdMicro: number;
  readonly repairRounds: number;
}

/**
 * Writes the site's copy.
 *
 * Guarantees the stored bundle's ids are exactly the structure's derived slot inventory, that every
 * entry is inside its slot's character ceiling, and that the ledger row is written on every path.
 */
export async function runCopyStep(
  env: Env,
  ids: RunIds,
  input: {
    readonly intake: Intake;
    readonly manifest: MediaManifest;
    readonly structure: SiteStructureGen;
    readonly emitter: ProgressEmitter;
    readonly timing: ModelStepTiming;
  },
): Promise<CopyResult> {
  const db = shardById(ids.shardId, env);
  const config = STEP_CONFIGS.copy;
  const runtime = await modelRuntime(env, input.timing.sdkTimeoutMs);
  const locale = input.intake.defaultLocale;

  const attempt = await nextAttempt(db, ids.jobId, 'copy');
  const ledger = { db, jobId: ids.jobId, step: 'copy' as const, attempt };
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
  // Derived once and passed in, rather than let `generateLocaleBundle` derive its own: the same
  // inventory then drives the task turn's slot brief, the post-parse key-set check and this step's
  // reported `slotCount`, so all three can never disagree.
  const slots = deriveSlotInventory(input.structure);

  try {
    const result = await generateLocaleBundle({
      context: {
        client: runtime.client,
        model: runtime.model,
        onDelta: input.emitter.deltaSink('streaming', 52),
        signal: input.timing.signal,
      },
      facts,
      secrets,
      structure: input.structure,
      locale,
      normalizeContext: normalizeContextFor(input.intake, input.manifest),
      slots,
    });

    await closeCall(env, ledger, callId, result.call);
    await putTranscript(env.BLOBS, {
      jobId: ids.jobId,
      step: 'copy',
      attempt,
      payload: { calls: result.calls, repairs: result.repairs },
    });
    const ref = await putArtifact(env.BLOBS, runArtifactKey(ids.jobId, 'copy'), result.bundle);

    return {
      bundle: ref,
      locale,
      entryCount: result.bundle.entries.length,
      slotCount: slots.slots.length,
      costUsdMicro: result.call.costUsdMicro,
      repairRounds: result.call.repairRounds,
    };
  } catch (error) {
    await finishCallFromError(env, ledger, callId, error);
    throw error;
  }
}
