/**
 * The narrow slice of the Anthropic Messages API this package speaks.
 *
 * Two things forced this file into existence, and both are worth stating because "define your own
 * types for SDK objects" is normally the wrong instinct:
 *
 *   1. **The call layer is injected, not imported.** `streamStructured()` takes a client rather
 *      than constructing one, so the failure-branch suite (refusal, truncation, schema mismatch,
 *      sentinel leak) runs against a stub and never opens a socket. A test that can reach
 *      api.anthropic.com is a test that can spend money in CI.
 *   2. **The generation path lives entirely on beta parameters** (`fallbacks`, `output_config`,
 *      `task_budget`) whose SDK type names move between minor releases while the wire shape stays
 *      put. Binding the whole package to those names would turn a patch bump into a repo-wide type
 *      break; binding it to the wire shape confines the blast radius to `client.ts`, which is the
 *      only file that touches the real SDK at all.
 *
 * Everything here mirrors the wire format exactly -- `snake_case` field names included -- so that
 * the objects this package builds can be handed to the SDK unchanged. Types only; no runtime code.
 */

/* -- Request ------------------------------------------------------------------------------- */

/** `output_config.effort`. Higher costs more thinking; it is the tuning lever, never model choice. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** `thinking.display`. `omitted` is the API default on Opus 5, which streams empty thinking text. */
export type ThinkingDisplay = 'summarized' | 'omitted' | 'updates';

/**
 * The cache breakpoint marker.
 *
 * No `ttl` field: the 1-hour TTL costs a 2x write and needs three prefix-sharing requests inside
 * the hour to break even, which Phase 1 traffic will not produce (architecture 6.3). A read
 * refreshes the 5-minute timer for free, and the steps of one job are seconds apart.
 */
export interface CacheControlEphemeral {
  readonly type: 'ephemeral';
}

/** One block of the `system` array. The prefix is a block list precisely so one block can be marked. */
export interface SystemTextBlock {
  readonly type: 'text';
  readonly text: string;
  readonly cache_control?: CacheControlEphemeral;
}

/**
 * One turn of the `messages` array.
 *
 * `role` is `'user'` and only `'user'`. Assistant prefill returns a 400 on `claude-opus-5`, and the
 * repair ladder deliberately re-states the model's previous document inside a user turn rather than
 * replaying it as an assistant turn -- see `repair.ts` for why that is stronger than it looks.
 */
export interface PromptMessage {
  readonly role: 'user';
  readonly content: string;
}

/** `output_config.task_budget`. The API's documented minimum for `total` is 20,000. */
export interface TokenTaskBudget {
  readonly type: 'tokens';
  readonly total: number;
}

/**
 * The structured-output grammar spec produced by `betaZodOutputFormat()`.
 *
 * Opaque on purpose: this package never reads inside it, it only forwards it. The one field named
 * here is the discriminator the runtime shape check asserts.
 */
export interface OutputFormatSpec {
  readonly type: string;
}

/** `output_config` for a generation call. */
export interface OutputConfigParam {
  readonly effort: Effort;
  readonly task_budget: TokenTaskBudget;
  readonly format: OutputFormatSpec;
}

/** Adaptive thinking. `budget_tokens` is removed on Opus 5 and returns a 400 if sent. */
export interface ThinkingParam {
  readonly type: 'adaptive';
  readonly display: ThinkingDisplay;
}

/** The exact body of a streamed generation call. */
export interface StreamMessageParams {
  readonly model: string;
  readonly max_tokens: number;
  readonly betas: readonly string[];
  /**
   * Server-side refusal fallbacks. The scalar `'default'` form pairs with the `-2026-07-01` beta
   * and routes by refusal category, so no model list is maintained here; pairing it with the
   * `-2026-06-01` beta instead is a 400.
   */
  readonly fallbacks: 'default';
  readonly thinking: ThinkingParam;
  readonly output_config: OutputConfigParam;
  readonly system: readonly SystemTextBlock[];
  readonly messages: readonly PromptMessage[];
}

/**
 * The body of the small non-streaming classifier call.
 *
 * No `thinking` (Haiku 4.5 still takes the removed `budget_tokens` form, so the only correct way to
 * ask it not to think is to omit the parameter) and no `effort` (Haiku 4.5 rejects `output_config
 * .effort` outright). The classifier needs neither.
 */
export interface ParseMessageParams {
  readonly model: string;
  readonly max_tokens: number;
  readonly system: readonly SystemTextBlock[];
  readonly messages: readonly PromptMessage[];
  readonly output_config: { readonly format: OutputFormatSpec };
}

/** Per-request options, distinct from the request body. */
export interface RequestOptions {
  readonly signal?: AbortSignal;
}

/* -- Response ------------------------------------------------------------------------------ */

/**
 * The four token fields `usage` actually has.
 *
 * There is deliberately no `thinking_tokens`: thinking bills inside `output_tokens`. A fifth field
 * would always read zero and every cost formula that summed it would double-count.
 */
export interface RawUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
  /** Present when server-side fallbacks ran; an entry of type `fallback_message` means a rescue. */
  readonly iterations?: readonly { readonly type: string }[] | null;
}

/** Populated only when `stop_reason === 'refusal'`; `null` for every other stop reason. */
export interface StopDetails {
  readonly type?: string;
  /** An open set (`cyber`, `bio`, `reasoning_extraction`, ...), so it is never narrowed to a union. */
  readonly category?: string | null;
  readonly explanation?: string | null;
}

/** One block of `content`. Narrowed by `type` before `text` is read. */
export interface ContentBlock {
  readonly type: string;
  readonly text?: string;
}

/** The completed message, as returned by `stream.finalMessage()`. */
export interface FinalMessage {
  readonly id?: string | null;
  /** The model that actually served the turn, which differs from the request on a fallback rescue. */
  readonly model?: string | null;
  readonly stop_reason: string | null;
  readonly stop_details?: StopDetails | null;
  readonly content: readonly ContentBlock[];
  readonly usage: RawUsage;
  readonly _request_id?: string | null;
}

/** A `messages.parse()` response: a message plus the SDK's own decode of the structured output. */
export interface ParsedMessage extends FinalMessage {
  /** `null` when the SDK could not decode the output against the schema -- always guarded. */
  readonly parsed_output?: unknown;
}

/**
 * The streaming handle.
 *
 * `on()` returns the stream in the SDK for chaining; it is typed `void` here because this package
 * never chains, and a wider return would be one more thing to keep in sync for no benefit.
 */
export interface MessageStreamHandle {
  on(event: 'text' | 'thinking', handler: (delta: string, snapshot: string) => void): void;
  finalMessage(): Promise<FinalMessage>;
}

/* -- Client -------------------------------------------------------------------------------- */

/** The two methods this package calls, and nothing else. */
export interface AnthropicClient {
  readonly beta: {
    readonly messages: {
      stream(params: StreamMessageParams, options?: RequestOptions): MessageStreamHandle;
      parse(params: ParseMessageParams, options?: RequestOptions): Promise<ParsedMessage>;
    };
  };
}
