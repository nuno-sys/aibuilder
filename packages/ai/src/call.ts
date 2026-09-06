import type { ZodType } from 'zod';
import {
  MalformedOutputError,
  ModelRefusalError,
  OutputTruncatedError,
  SentinelLeakedError,
} from './errors';
import { GENERATION_BETAS } from './client';
import type {
  AnthropicClient,
  ContentBlock,
  Effort,
  FinalMessage,
  OutputFormatSpec,
  PromptMessage,
  RequestOptions,
  StreamMessageParams,
  SystemTextBlock,
} from './protocol';
import type { CallUsage, TokenPrices } from './usage';
import {
  OPUS_5_PRICES,
  costUsdMicro,
  detectFallback,
  refusalCategory,
  usageFromResponse,
} from './usage';

/**
 * `streamStructured()` -- the one function that spends money.
 *
 * Shape, in order, because the order is the correctness argument:
 *
 *   1. `beta.messages.stream()`, never `parse()`. `parse()` does not stream and never did; the
 *      design requires streaming for large `max_tokens`, so `parse()` is the wrong entry point for
 *      exactly the calls this pipeline is built on.
 *   2. Branch on `stop_reason` BEFORE reading `content`. A refusal is a 200 with a `stop_details`
 *      category, and a truncation is a 200 whose JSON is invalid *because it was cut off* -- if you
 *      learn that from the parse error instead, you retry a content defect that a retry cannot fix.
 *   3. Sentinel check before parse: a document that echoes the prompt envelope must never reach a
 *      publish step, whatever else is wrong with it.
 *   4. `safeParse`, and a schema mismatch is *returned*, not thrown -- it is the expected input to
 *      the repair ladder, which fixes ~90% of defects for free.
 *
 * Transport failures (429, 5xx, a dropped socket) are deliberately NOT caught here. They belong to
 * the Workflow's retry ladder, which classifies them with `classifyTransportError()`; swallowing
 * them here would erase the retryable/non-retryable distinction the ladder runs on.
 */

/** A streamed fragment, forwarded so the API can push SSE progress to the onboarding modal. */
export interface StreamDelta {
  /** `thinking` deltas arrive during the long silent phase and are what keeps the bar moving. */
  readonly kind: 'text' | 'thinking';
  readonly text: string;
}

/** Where streamed fragments go. Must not throw and must not block. */
export type DeltaSink = (delta: StreamDelta) => void;

/** One schema violation, flattened out of the Zod error. */
export interface SchemaIssue {
  readonly path: string;
  readonly message: string;
  readonly code: string | null;
}

/** What the call cost and how it ended, recorded whichever branch it took. */
export interface StructuredCallMeta {
  readonly usage: CallUsage;
  readonly costUsdMicro: number;
  readonly stopReason: string | null;
  /** The model that answered, which differs from the request when a fallback rescued the call. */
  readonly servedModel: string | null;
  readonly fallbackUsed: boolean;
  readonly requestId: string | null;
  /** The raw assistant text, for the R2 transcript. Never logged. */
  readonly text: string;
}

/**
 * The outcome of one structured call.
 *
 * `invalid` is a return value rather than an exception on purpose: a schema mismatch is an expected,
 * locally-handled event that the repair ladder resolves, while a refusal or a truncation unwinds the
 * step. Both branches carry `meta`, because the ledger must be written for a call that failed
 * validation exactly as for one that succeeded -- the tokens were spent either way.
 */
export type StructuredCallOutcome<T> =
  | {
      readonly kind: 'ok';
      readonly value: T;
      readonly raw: unknown;
      readonly meta: StructuredCallMeta;
    }
  | {
      readonly kind: 'invalid';
      readonly raw: unknown;
      readonly issues: readonly SchemaIssue[];
      readonly meta: StructuredCallMeta;
    };

/** Everything one structured call needs. The client is injected so the suite can stub it. */
export interface StructuredCallInput<T> {
  readonly client: AnthropicClient;
  readonly model: string;
  readonly schema: ZodType<T>;
  /** The frozen prefix from `prompt/blocks.ts`. Never assembled per call. */
  readonly system: readonly SystemTextBlock[];
  /** Facts turn, task turn, and any repair turn -- all `user`, all after the breakpoint. */
  readonly messages: readonly PromptMessage[];
  readonly maxTokens: number;
  readonly effort: Effort;
  /** `output_config.task_budget.total`. The API minimum is 20,000. */
  readonly taskBudgetTotal: number;
  /** Pre-compiled by `toOutputFormat()`; compiling it per call would re-import the SDK helper. */
  readonly outputFormat: OutputFormatSpec;
  readonly onDelta?: DeltaSink | undefined;
  /** Strings that must never appear in the output: the envelope nonce and canary. */
  readonly sentinels?: readonly string[] | undefined;
  readonly prices?: TokenPrices | undefined;
  /** Cancellation, so a terminated Workflow stops burning tokens instead of finishing the call. */
  readonly signal?: AbortSignal | undefined;
}

/** Concatenates the text blocks of a response, ignoring thinking and any other block type. */
function textOf(content: readonly ContentBlock[]): string {
  let out = '';
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') out += block.text;
  }
  return out;
}

/** Builds the ledger-facing view of a completed call. */
function metaOf(
  message: FinalMessage,
  model: string,
  text: string,
  prices: TokenPrices,
): StructuredCallMeta {
  const usage = usageFromResponse(message.usage);
  return {
    usage,
    costUsdMicro: costUsdMicro(usage, prices),
    stopReason: message.stop_reason,
    servedModel: typeof message.model === 'string' ? message.model : null,
    fallbackUsed: detectFallback(message, model),
    requestId: typeof message._request_id === 'string' ? message._request_id : null,
    text,
  };
}

/** Flattens a Zod error into a defect-shaped list the repair turn can carry. */
function issuesOf(error: unknown): readonly SchemaIssue[] {
  const raw: unknown = (error as { issues?: unknown } | null)?.issues;
  if (!Array.isArray(raw)) return [{ path: '', message: 'schema validation failed', code: null }];
  const out: SchemaIssue[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const issue = entry as { path?: unknown; message?: unknown; code?: unknown };
    const path = Array.isArray(issue.path) ? issue.path.map((part) => String(part)).join('.') : '';
    out.push({
      path,
      message: typeof issue.message === 'string' ? issue.message : 'invalid value',
      code: typeof issue.code === 'string' ? issue.code : null,
    });
  }
  // Twenty issues is already more than a repair turn can act on, and the tail is usually the same
  // defect seen from twenty array elements.
  return out.slice(0, 20);
}

/**
 * Runs one structured generation call and validates the result.
 *
 * Guarantees: `stop_reason` is inspected before `content`; a refusal throws a terminal
 * `ModelRefusalError` carrying `stop_details.category`; a truncation throws a retryable
 * `OutputTruncatedError`; envelope sentinels in the output throw `SentinelLeakedError`; a schema
 * mismatch is returned as `kind: 'invalid'` with the parsed JSON intact for the repair ladder; and
 * every outcome, including the thrown ones, carries the usage that was billed.
 */
export async function streamStructured<T>(
  input: StructuredCallInput<T>,
): Promise<StructuredCallOutcome<T>> {
  const prices = input.prices ?? OPUS_5_PRICES;
  const params: StreamMessageParams = {
    model: input.model,
    max_tokens: input.maxTokens,
    betas: GENERATION_BETAS,
    fallbacks: 'default',
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: {
      effort: input.effort,
      task_budget: { type: 'tokens', total: input.taskBudgetTotal },
      format: input.outputFormat,
    },
    system: input.system,
    messages: input.messages,
  };
  const options: RequestOptions | undefined =
    input.signal === undefined ? undefined : { signal: input.signal };

  const stream = input.client.beta.messages.stream(params, options);
  const sink = input.onDelta;
  if (sink !== undefined) {
    // A progress sink that throws must not abort a call that is already being billed, and it must
    // not be able to reject `finalMessage()`. Swallowing here is the only safe policy.
    const forward =
      (kind: 'text' | 'thinking') =>
      (delta: string): void => {
        try {
          if (delta.length > 0) sink({ kind, text: delta });
        } catch {
          /* progress is best-effort; the generation is not */
        }
      };
    stream.on('text', forward('text'));
    stream.on('thinking', forward('thinking'));
  }

  const message = await stream.finalMessage();
  const usage = usageFromResponse(message.usage);
  const requestId = typeof message._request_id === 'string' ? message._request_id : null;

  // Branch on stop_reason before touching content.
  if (message.stop_reason === 'refusal') {
    throw new ModelRefusalError({
      category: refusalCategory(message),
      explanation: message.stop_details?.explanation ?? null,
      usage,
      requestId,
    });
  }
  if (message.stop_reason === 'max_tokens') {
    throw new OutputTruncatedError({ maxTokens: input.maxTokens, usage, requestId });
  }

  const text = textOf(message.content);
  const meta = metaOf(message, input.model, text, prices);

  for (const sentinel of input.sentinels ?? []) {
    if (sentinel.length > 0 && text.includes(sentinel)) {
      throw new SentinelLeakedError({ usage, requestId });
    }
  }

  if (text.trim().length === 0) {
    throw new MalformedOutputError({
      detail: 'response contained no text block',
      usage,
      requestId,
    });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unparseable';
    throw new MalformedOutputError({ detail, usage, requestId });
  }

  const parsed = input.schema.safeParse(raw);
  if (parsed.success) return { kind: 'ok', value: parsed.data, raw, meta };
  return { kind: 'invalid', raw, issues: issuesOf(parsed.error), meta };
}
