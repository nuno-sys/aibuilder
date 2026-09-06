import {
  BlogPostGen,
  LocaleBundleGen,
  SiteStructureGen,
  contextFromStructure,
  deriveSlotInventory,
  normalizeBlogPost,
  normalizeLocaleBundle,
  normalizeStructure,
  validateBundle,
} from '@aibuilder/site-schema';
import type { NormalizeContext, Repair, SlotInventory } from '@aibuilder/site-schema';
import type { Locale } from '@aibuilder/core';
import type { ZodType } from 'zod';
import type { DeltaSink, StructuredCallMeta, StructuredCallOutcome } from './call';
import { streamStructured } from './call';
import { toOutputFormat } from './client';
import type {
  AnthropicClient,
  Effort,
  OutputFormatSpec,
  PromptMessage,
  SystemTextBlock,
} from './protocol';
import { systemBlocks } from './prompt/blocks';
import {
  blogPostTaskMessage,
  businessFactsMessage,
  localeBundleTaskMessage,
  sentinelsOf,
  structureTaskMessage,
} from './prompt/tasks';
import type { BusinessFacts, EnvelopeSecrets } from './prompt/tasks';
import { defectsFromBundleValidation, runRepairLadder } from './repair';
import type { RepairLadderResult } from './repair';
import type { BillableStep, GenerationCallRecord } from './usage';

/**
 * The per-step functions the generator Workflow calls.
 *
 * Each one is a thin composition -- frozen prefix, facts turn, task turn, streamed call, repair
 * ladder, ledger row -- and each one is pure with respect to Cloudflare: no bindings, no `env`, no
 * Workflow types. That is what lets the generator's steps stay three lines long and lets these
 * functions be exercised without workerd.
 *
 * Steps hand back an aggregated `GenerationCallRecord` rather than one per round, because
 * `generation_calls` is one row per step attempt with a `repair_rounds` column; the per-round
 * metadata is returned alongside it for the R2 transcript.
 */

/* -- Per-step model configuration ------------------------------------------------------------ */

/** The request knobs for one generation step. */
export interface StepConfig {
  readonly effort: Effort;
  readonly maxTokens: number;
  /** `output_config.task_budget.total`. The API's documented minimum is 20,000. */
  readonly taskBudgetTotal: number;
  readonly schemaName: string;
}

/**
 * Effort, ceilings and budgets per step (architecture 6.1).
 *
 * Effort is pinned across the structure+copy namespace in Phase 1: it is the tuning lever, but a
 * mid-job change would invalidate the messages cache for the calls that follow it. `plan-brief` is
 * the one call whose judgement compounds across the entire site, which is why it is not the place to
 * economise. `task_budget` is the hard containment on every one of them.
 */
export const STEP_CONFIGS = {
  structure: {
    effort: 'high',
    maxTokens: 32_000,
    taskBudgetTotal: 40_000,
    schemaName: 'site_structure',
  },
  copy: { effort: 'high', maxTokens: 48_000, taskBudgetTotal: 56_000, schemaName: 'locale_bundle' },
  blog: { effort: 'medium', maxTokens: 16_000, taskBudgetTotal: 20_000, schemaName: 'blog_post' },
} as const satisfies Readonly<Record<'structure' | 'copy' | 'blog', StepConfig>>;

/* -- Shared plumbing ------------------------------------------------------------------------- */

/** What every step needs to make a call. */
export interface StepContext {
  readonly client: AnthropicClient;
  /** From `resolveModel(env)`. Passed in rather than read here so this file never touches `env`. */
  readonly model: string;
  /** Receives streamed text and thinking deltas, for the SSE progress feed. */
  readonly onDelta?: DeltaSink | undefined;
  /** Aborts the request when the job is cancelled, instead of paying for a result nobody reads. */
  readonly signal?: AbortSignal | undefined;
  /** Overridable only so a test can assert on a smaller prefix; production always uses the frozen one. */
  readonly system?: readonly SystemTextBlock[] | undefined;
}

/**
 * Memoised grammar specs.
 *
 * `betaZodOutputFormat()` walks the whole Zod tree to emit JSON Schema. Doing that on every step of
 * every job is pure CPU on a Worker that is already CPU-bound at publish time, and the result is a
 * pure function of the schema.
 */
const formatCache = new Map<string, OutputFormatSpec>();

/** Returns the compiled grammar for a step's schema, compiling it at most once per isolate. */
async function outputFormatFor(name: string, schema: unknown): Promise<OutputFormatSpec> {
  const cached = formatCache.get(name);
  if (cached !== undefined) return cached;
  const format = await toOutputFormat(schema);
  formatCache.set(name, format);
  return format;
}

/** Collapses a ladder's rounds into the single ledger row `generation_calls` stores. */
function ledgerRow<T>(
  step: BillableStep,
  config: StepConfig,
  context: StepContext,
  result: RepairLadderResult<T>,
): GenerationCallRecord {
  const last = result.calls[result.calls.length - 1];
  return {
    step,
    model: context.model,
    servedModel: last?.servedModel ?? null,
    fallbackUsed: result.calls.some((call) => call.fallbackUsed),
    effort: config.effort,
    thinkingType: 'adaptive',
    thinkingDisplay: 'summarized',
    maxTokens: config.maxTokens,
    taskBudgetTotal: config.taskBudgetTotal,
    streamed: true,
    outputFormat: 'json_schema',
    schemaName: config.schemaName,
    usage: result.usage,
    costUsdMicro: result.costUsdMicro,
    stopReason: last?.stopReason ?? null,
    // Always null: a refusal throws `ModelRefusalError` out of `streamStructured()`, so no step that
    // produced a row ever saw one. The generator writes the refusal row from the error instead.
    refusalCategory: null,
    repairRounds: result.rounds,
    anthropicRequestId: last?.requestId ?? null,
  };
}

/** Builds the call closure the repair ladder drives. */
function callerFor<T>(args: {
  readonly context: StepContext;
  readonly config: StepConfig;
  readonly schema: ZodType<T>;
  readonly outputFormat: OutputFormatSpec;
  readonly baseMessages: readonly PromptMessage[];
  readonly secrets: EnvelopeSecrets;
}): (extra: readonly PromptMessage[]) => Promise<StructuredCallOutcome<T>> {
  return (extra) =>
    streamStructured<T>({
      client: args.context.client,
      model: args.context.model,
      schema: args.schema,
      system: args.context.system ?? systemBlocks(),
      messages: [...args.baseMessages, ...extra],
      maxTokens: args.config.maxTokens,
      effort: args.config.effort,
      taskBudgetTotal: args.config.taskBudgetTotal,
      outputFormat: args.outputFormat,
      onDelta: args.context.onDelta,
      sentinels: sentinelsOf(args.secrets),
      signal: args.context.signal,
    });
}

/* -- Step 3: plan-brief ---------------------------------------------------------------------- */

/** Input for the structure step. */
export interface GenerateStructureInput {
  readonly context: StepContext;
  readonly facts: BusinessFacts;
  readonly secrets: EnvelopeSecrets;
  /** Media and link ref ids the pipeline actually produced, so dangling refs are pruned for free. */
  readonly normalizeContext: NormalizeContext;
  readonly plannedBlogPosts: number;
}

/** A validated structure, everything derived from it, and the step's ledger row. */
export interface GenerateStructureOutput {
  readonly structure: SiteStructureGen;
  /** The slot inventory the copy step must fill. Derived once here so both steps share one. */
  readonly slots: SlotInventory;
  readonly repairs: readonly Repair[];
  readonly call: GenerationCallRecord;
  readonly calls: readonly StructuredCallMeta[];
}

/**
 * Generates the site structure: pages, sections, theme and typed SEO inputs. No prose.
 *
 * Guarantees the returned document is schema-valid and normalised (ids de-duplicated, arrays
 * clamped, dangling media and link refs dropped), and that its slot inventory is derived from the
 * post-repair document rather than the raw one.
 */
export async function generateStructure(
  input: GenerateStructureInput,
): Promise<GenerateStructureOutput> {
  const config = STEP_CONFIGS.structure;
  const outputFormat = await outputFormatFor(config.schemaName, SiteStructureGen);
  const baseMessages: readonly PromptMessage[] = [
    businessFactsMessage(input.facts, input.secrets),
    structureTaskMessage({
      primaryLocale: input.facts.primaryLocale,
      plannedBlogPosts: input.plannedBlogPosts,
    }),
  ];

  const result = await runRepairLadder<SiteStructureGen>({
    call: callerFor<SiteStructureGen>({
      context: input.context,
      config,
      schema: SiteStructureGen,
      outputFormat,
      baseMessages,
      secrets: input.secrets,
    }),
    normalize: (raw) => normalizeStructure(raw, input.normalizeContext),
  });

  return {
    structure: result.value,
    slots: deriveSlotInventory(result.value),
    repairs: result.repairs,
    call: ledgerRow('structure', config, input.context, result),
    calls: result.calls,
  };
}

/* -- Step 4: copy-primary -------------------------------------------------------------------- */

/** Input for the copy step. */
export interface GenerateLocaleBundleInput {
  readonly context: StepContext;
  readonly facts: BusinessFacts;
  readonly secrets: EnvelopeSecrets;
  readonly structure: SiteStructureGen;
  readonly locale: Locale;
  readonly normalizeContext: NormalizeContext;
  /** Pass the inventory from `generateStructure()` to avoid deriving the same thing twice. */
  readonly slots?: SlotInventory | undefined;
}

/** A validated bundle whose key set is proven equal to the structure's slot inventory. */
export interface GenerateLocaleBundleOutput {
  readonly bundle: LocaleBundleGen;
  readonly repairs: readonly Repair[];
  readonly call: GenerationCallRecord;
  readonly calls: readonly StructuredCallMeta[];
}

/**
 * Generates every visible string of one locale.
 *
 * Guarantees the returned bundle's ids are exactly `deriveSlotInventory(structure)` -- invented ids
 * are dropped deterministically and missing ones are the only defect class worth a repair turn --
 * and that every entry is within its slot's character ceiling.
 */
export async function generateLocaleBundle(
  input: GenerateLocaleBundleInput,
): Promise<GenerateLocaleBundleOutput> {
  const config = STEP_CONFIGS.copy;
  const inventory = input.slots ?? deriveSlotInventory(input.structure);
  const outputFormat = await outputFormatFor(config.schemaName, LocaleBundleGen);
  const baseMessages: readonly PromptMessage[] = [
    businessFactsMessage(input.facts, input.secrets),
    localeBundleTaskMessage({
      structure: input.structure,
      locale: input.locale,
      slots: inventory.slots,
    }),
  ];

  const result = await runRepairLadder<LocaleBundleGen>({
    call: callerFor<LocaleBundleGen>({
      context: input.context,
      config,
      schema: LocaleBundleGen,
      outputFormat,
      baseMessages,
      secrets: input.secrets,
    }),
    normalize: (raw) => normalizeLocaleBundle(raw, inventory, input.normalizeContext),
    inspect: (bundle) => defectsFromBundleValidation(validateBundle(input.structure, bundle)),
  });

  return {
    bundle: result.value,
    repairs: result.repairs,
    call: ledgerRow('copy', config, input.context, result),
    calls: result.calls,
  };
}

/* -- Step 5: blog ---------------------------------------------------------------------------- */

/** Input for one blog post. */
export interface GenerateBlogPostInput {
  readonly context: StepContext;
  readonly facts: BusinessFacts;
  readonly secrets: EnvelopeSecrets;
  /** Link refs are resolved against this structure's final page and section ids. */
  readonly structure: SiteStructureGen;
  readonly locale: Locale;
  readonly topic: string;
  readonly existingTitles: readonly string[];
  readonly normalizeContext: NormalizeContext;
  readonly targetWords?: number | undefined;
}

/** A validated post and the step's ledger row. */
export interface GenerateBlogPostOutput {
  readonly post: BlogPostGen;
  readonly repairs: readonly Repair[];
  readonly call: GenerationCallRecord;
  readonly calls: readonly StructuredCallMeta[];
}

/**
 * Generates one blog post in one locale.
 *
 * Guarantees links and media in the post resolve against the *normalised* structure's ids, because
 * the document context is derived from it rather than from the raw model output, and that a post
 * with no title or no surviving block fails the step rather than publishing a thin page.
 */
export async function generateBlogPost(
  input: GenerateBlogPostInput,
): Promise<GenerateBlogPostOutput> {
  const config = STEP_CONFIGS.blog;
  const outputFormat = await outputFormatFor(config.schemaName, BlogPostGen);
  const documentContext = contextFromStructure(input.normalizeContext, input.structure);
  const baseMessages: readonly PromptMessage[] = [
    businessFactsMessage(input.facts, input.secrets),
    blogPostTaskMessage({
      locale: input.locale,
      topic: input.topic,
      existingTitles: input.existingTitles,
      targetWords: input.targetWords ?? 700,
    }),
  ];

  const result = await runRepairLadder<BlogPostGen>({
    call: callerFor<BlogPostGen>({
      context: input.context,
      config,
      schema: BlogPostGen,
      outputFormat,
      baseMessages,
      secrets: input.secrets,
    }),
    normalize: (raw) => normalizeBlogPost(raw, documentContext),
  });

  return {
    post: result.value,
    repairs: result.repairs,
    call: ledgerRow('blog', config, input.context, result),
    calls: result.calls,
  };
}
