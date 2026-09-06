import {
  STEP_CONFIGS,
  businessFactsFromIntake,
  generateBlogPost,
  newEnvelopeSecrets,
} from '@aibuilder/ai';
import { industryByKey, mintId } from '@aibuilder/core';
import type { Intake } from '@aibuilder/core';
import { shardById } from '@aibuilder/db';
import { BlogPostGen } from '@aibuilder/site-schema';
import type { SiteStructureGen } from '@aibuilder/site-schema';
import { z } from 'zod';

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
 * Step 5, `blog-0` / `blog-1` — one `claude-opus-5` call per post.
 *
 * ONE POST PER STEP, AND THAT IS THE POINT OF THE WHOLE DECOMPOSITION (§6.1). A single defect in
 * post two must not destroy a site whose structure, copy and first post are already paid for and
 * memoised. Per-step memoisation is simultaneously the reliability story and the cost-control
 * story, and the blog is where the difference is most visible: a failed post retries alone.
 *
 * A SEPARATE CACHE NAMESPACE, DELIBERATELY. Blog posts run at `effort: "medium"` against a
 * different grammar, and §6.3 is explicit that thinking and effort changes always invalidate the
 * messages cache. Putting them at the end of the run rather than between the structure and copy
 * calls is what keeps that invalidation from costing the copy step its cache read.
 *
 * THE TOPICS ARE BRIEFS, NOT TITLES. The model is asked what a customer of this trade is actually
 * searching for before they book — not for "5 tips about bakeries". A generated blog that reads
 * like generated blog is a §7 thinness problem and a quality-gate finding, and the brief is the
 * cheapest place to prevent it. They are deterministic in the post index, so a retry regenerates
 * the same brief rather than quietly changing what the site is about.
 */

/**
 * The editorial briefs, in order.
 *
 * Two, matching `PLANNED_BLOG_POSTS`. The first is search-intent-led — it exists to be found by
 * someone who does not know the business yet. The second is proof-led: it exists to convince
 * someone who has already landed. A third of the same kind as either would be padding.
 */
const BLOG_BRIEFS: readonly string[] = [
  'the question a prospective customer of this trade actually types into a search engine before ' +
    'they book for the first time, answered concretely and without padding',
  'how the work is really done at this business, told through one specific process or decision, ' +
    'so a reader can tell it apart from any competitor',
];

/** Words per post. Long enough not to be thin, short enough that an SMB owner will read it. */
const TARGET_WORDS = 700;

/** One generated post plus the identity and timestamps only this Worker knows. `BlogPostInput`. */
export const BlogArtifactSchema = z.object({
  postId: z.string().min(1).max(64),
  publishedAt: z.string().min(1),
  updatedAt: z.string().min(1),
  post: BlogPostGen,
});

/** A stored blog artefact. Shaped as `BlogPostInput` so `genToDoc()` takes it unchanged. */
export type BlogArtifact = z.infer<typeof BlogArtifactSchema>;

/** What one blog step hands back. */
export interface BlogResult {
  readonly post: ArtifactRef;
  readonly index: number;
  /** Passed to the next post so it does not write the same article twice. */
  readonly title: string;
  readonly blockCount: number;
  readonly costUsdMicro: number;
  readonly repairRounds: number;
}

/**
 * Composes the brief for one post.
 *
 * Guarantees a non-empty topic for any index, so a fan-out wider than the brief list degrades to
 * the last brief rather than to an empty string the model would have to guess at.
 */
export function blogTopicFor(index: number, intake: Intake): string {
  const industry = industryByKey(intake.industryKey);
  const label = industry?.labels.en ?? intake.industryKey;
  const brief = BLOG_BRIEFS[Math.min(index, BLOG_BRIEFS.length - 1)] ?? BLOG_BRIEFS[0] ?? '';
  const place = intake.address?.city ?? intake.serviceArea?.city ?? null;
  return place === null ? `For a ${label}: ${brief}` : `For a ${label} in ${place}: ${brief}`;
}

/**
 * Generates one blog post.
 *
 * Guarantees links and media inside the post resolve against the NORMALISED structure's final ids —
 * the document context is derived from the stored structure, not from anything the blog call
 * returned — and that the ledger row is written on every path.
 */
export async function runBlogStep(
  env: Env,
  ids: RunIds,
  input: {
    readonly index: number;
    readonly intake: Intake;
    readonly manifest: MediaManifest;
    readonly structure: SiteStructureGen;
    readonly existingTitles: readonly string[];
    readonly emitter: ProgressEmitter;
    readonly timing: ModelStepTiming;
  },
): Promise<BlogResult> {
  const db = shardById(ids.shardId, env);
  const config = STEP_CONFIGS.blog;
  const runtime = await modelRuntime(env, input.timing.sdkTimeoutMs);

  const attempt = await nextAttempt(db, ids.jobId, 'blog');
  const ledger = { db, jobId: ids.jobId, step: 'blog' as const, attempt };
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
    const result = await generateBlogPost({
      context: {
        client: runtime.client,
        model: runtime.model,
        onDelta: input.emitter.deltaSink('streaming', 70),
        signal: input.timing.signal,
      },
      facts,
      secrets,
      structure: input.structure,
      locale: input.intake.defaultLocale,
      topic: blogTopicFor(input.index, input.intake),
      existingTitles: input.existingTitles,
      normalizeContext: normalizeContextFor(input.intake, input.manifest),
      targetWords: TARGET_WORDS,
    });

    await closeCall(env, ledger, callId, result.call);
    await putTranscript(env.BLOBS, {
      jobId: ids.jobId,
      step: `blog.${String(input.index)}`,
      attempt,
      payload: { calls: result.calls, repairs: result.repairs },
    });

    // The id is minted here rather than by the caller, and stored INSIDE the artefact, because a
    // retry overwrites the artefact wholesale: the id that the assemble step reads is always the id
    // of the attempt that actually produced the post it is reading.
    const now = new Date().toISOString();
    const artifact: BlogArtifact = {
      postId: mintId('blogPost'),
      publishedAt: now,
      updatedAt: now,
      post: result.post,
    };
    const ref = await putArtifact(
      env.BLOBS,
      runArtifactKey(ids.jobId, 'blog', input.index),
      artifact,
    );

    return {
      post: ref,
      index: input.index,
      title: result.post.titleText,
      blockCount: result.post.blocks.length,
      costUsdMicro: result.call.costUsdMicro,
      repairRounds: result.call.repairRounds,
    };
  } catch (error) {
    await finishCallFromError(env, ledger, callId, error);
    throw error;
  }
}
