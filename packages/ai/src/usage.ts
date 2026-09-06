import type { Effort, FinalMessage, RawUsage } from './protocol';

/**
 * `response.usage` -> a `generation_calls` row -> `cost_usd_micro`.
 *
 * Architecture 10, risk 2: the 6.5 cost model is *derived*, not measured, and thinking tokens --
 * which dominate output and are on by default on Opus 5 -- are the term with the widest error bar.
 * Twenty real generations are run against these rows before Phase 2 pricing is fixed, so everything
 * here records what actually happened rather than what was intended.
 */

/* -- Prices ---------------------------------------------------------------------------------- */

/** Per-model token prices, in US dollars per million tokens. */
export interface TokenPrices {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  /** 5-minute ("ephemeral") cache write. The 1-hour tier is not used -- architecture 6.3. */
  readonly cacheWrite: number;
}

/**
 * `claude-opus-5` list prices.
 *
 * Thinking tokens bill inside `output_tokens`; there is no separate thinking price and adding one
 * would double-count the single largest term in the model.
 */
export const OPUS_5_PRICES: TokenPrices = {
  input: 5,
  output: 25,
  cacheRead: 0.5,
  cacheWrite: 6.25,
};

/** `claude-haiku-4-5` list prices, used only by the intake policy screen. */
export const HAIKU_4_5_PRICES: TokenPrices = {
  input: 1,
  output: 5,
  cacheRead: 0.1,
  cacheWrite: 1.25,
};

/* -- Usage ----------------------------------------------------------------------------------- */

/** The four token counters, with the API's nullable fields resolved to zero. */
export interface CallUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
}

/** The zero usage. Returned for a call that failed before the API answered. */
export const EMPTY_USAGE: CallUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
};

/** Coerces one untrusted numeric field of `usage` to a non-negative integer. */
function count(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/**
 * Normalises `response.usage` into the four counters the ledger stores.
 *
 * Guarantees a total, non-negative result for any input, including the `undefined` a transport
 * failure leaves behind: the ledger must be writable on every path, because an unwritten row is a
 * call that spent money nobody can account for.
 */
export function usageFromResponse(usage: RawUsage | null | undefined): CallUsage {
  if (usage === null || usage === undefined) return EMPTY_USAGE;
  return {
    inputTokens: count(usage.input_tokens),
    outputTokens: count(usage.output_tokens),
    cacheCreationTokens: count(usage.cache_creation_input_tokens),
    cacheReadTokens: count(usage.cache_read_input_tokens),
  };
}

/** Sums two usage records, for rolling a repair ladder's rounds into one step total. */
export function addUsage(a: CallUsage, b: CallUsage): CallUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  };
}

/* -- Cost ------------------------------------------------------------------------------------ */

/**
 * Computes the cost of one call in integer micro-USD.
 *
 * The scale factor is 1 by construction and that is not a coincidence: a price quoted in dollars
 * per million tokens is numerically identical to micro-dollars per token, so one token at $5/MTok
 * costs exactly 5 micro-USD. Money is integer micro-USD everywhere in this system and never touches
 * a REAL column.
 *
 * Rounding happens once, on the total, rather than per term -- rounding four terms and summing
 * biases every row in the same direction, which over 20 calibration generations is a visible skew
 * in exactly the number Phase 2 pricing is set from.
 */
export function costUsdMicro(usage: CallUsage, prices: TokenPrices = OPUS_5_PRICES): number {
  const micro =
    usage.inputTokens * prices.input +
    usage.outputTokens * prices.output +
    usage.cacheReadTokens * prices.cacheRead +
    usage.cacheCreationTokens * prices.cacheWrite;
  return Math.round(micro);
}

/** Formats micro-USD for a log line or an operator dashboard. Never used for arithmetic. */
export function formatUsd(micro: number): string {
  return `$${(micro / 1_000_000).toFixed(4)}`;
}

/* -- The ledger row -------------------------------------------------------------------------- */

/**
 * The pipeline steps that spend model tokens.
 *
 * A subset of `GenerationStep` in `@aibuilder/db`; the ones missing from it here (`media`,
 * `assemble`, `render`, ...) are deterministic code and must never appear on a `generation_calls`
 * row. `@aibuilder/ai` does not depend on `@aibuilder/db` -- the layering in architecture 2 runs
 * one way -- so this union is asserted against the database's by the generator's contract test.
 */
export type BillableStep = 'validate' | 'structure' | 'copy' | 'blog' | 'repair';

/**
 * Everything one Anthropic call contributes to the ledger.
 *
 * Field-for-field what `insertGenerationCall()` + `finishGenerationCall()` in `@aibuilder/db` bind,
 * so the generator's step passes this straight through without a translation table that could drift.
 */
export interface GenerationCallRecord {
  readonly step: BillableStep;
  /** The model that was requested. */
  readonly model: string;
  /** The model that answered. Differs from `model` when a refusal fallback rescued the call. */
  readonly servedModel: string | null;
  readonly fallbackUsed: boolean;
  readonly effort: Effort;
  readonly thinkingType: 'adaptive' | 'disabled';
  readonly thinkingDisplay: 'summarized' | 'omitted' | 'updates' | null;
  readonly maxTokens: number;
  readonly taskBudgetTotal: number | null;
  readonly streamed: boolean;
  readonly outputFormat: 'text' | 'json_schema';
  readonly schemaName: string | null;
  readonly usage: CallUsage;
  readonly costUsdMicro: number;
  /** Written verbatim: the vocabulary belongs to the provider, not to our CHECK constraints. */
  readonly stopReason: string | null;
  /** From `stop_details`, which is populated only on a refusal. */
  readonly refusalCategory: string | null;
  readonly repairRounds: number;
  readonly anthropicRequestId: string | null;
}

/** True when the response shows a server-side fallback rescued this turn. */
export function detectFallback(message: FinalMessage, requestedModel: string): boolean {
  // Three independent signals, because each one alone has a hole: a sticky follow-up turn carries
  // no `fallback` content block, `usage.iterations` is absent on older responses, and comparing
  // models misses a fallback that resolved back to the same model id.
  if (message.content.some((block) => block.type === 'fallback')) return true;
  const iterations = message.usage.iterations;
  if (iterations !== null && iterations !== undefined) {
    if (iterations.some((entry) => entry.type === 'fallback_message')) return true;
  }
  const served = message.model;
  return typeof served === 'string' && served.length > 0 && served !== requestedModel;
}

/** Reads `stop_details.category`, which exists only on a refusal. */
export function refusalCategory(message: FinalMessage): string | null {
  if (message.stop_reason !== 'refusal') return null;
  const category = message.stop_details?.category;
  return typeof category === 'string' && category.length > 0 ? category : null;
}
