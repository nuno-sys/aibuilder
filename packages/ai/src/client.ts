import { MissingApiKeyError, SdkSurfaceError } from './errors';
import type { AnthropicClient, OutputFormatSpec } from './protocol';

/**
 * Construction of the Anthropic client, and the one place in the repo that touches the SDK.
 *
 * Three properties are load-bearing:
 *
 *   - **`maxRetries: 0`.** Workflows owns retries so every attempt is durable, observable and
 *     ledgered. SDK retries would double-retry invisibly and wall clock could reach
 *     `timeout x (maxRetries + 1)`.
 *   - **The timeout is in MILLISECONDS** in the TypeScript SDK, and it is ~12 minutes, not 180
 *     seconds. A 180 s abort fires on the majority of *successful* generations after the tokens are
 *     already billed, and the retry then pays for them again. It sits strictly below the Workflow
 *     step timeout so the SDK aborts first and produces an error the retry ladder can classify.
 *   - **The SDK is dynamically imported.** A Worker gets ~400 ms of startup CPU; `apps/api` links
 *     this package for its types but never calls the model, and must not pay to parse the SDK.
 */

/** The `claude-opus-5` id. Never date-suffixed -- a suffixed variant is not a real model id. */
export const MODEL_OPUS_5 = 'claude-opus-5';

/** The intake policy classifier. Cheap enough to run before any Opus spend. */
export const MODEL_HAIKU_4_5 = 'claude-haiku-4-5';

/**
 * The betas every generation call carries.
 *
 * `fallbacks: 'default'` pairs with the `-2026-07-01` header; the array form pairs with
 * `-2026-06-01`, and crossing them is a 400. Ordering is fixed because the header is part of the
 * cached prefix key.
 */
export const GENERATION_BETAS: readonly string[] = [
  'server-side-fallback-2026-07-01',
  'task-budgets-2026-03-13',
];

/** SDK request timeout, in milliseconds. Below the generator's 15-minute Workflow step timeout. */
export const DEFAULT_TIMEOUT_MS = 12 * 60 * 1000;

/**
 * A Secrets Store binding.
 *
 * Secrets Store resolves through an async `get()`; `wrangler secret put` yields a plain string.
 * Both must keep working while Secrets Store is in open beta, which is why the binding type is a
 * union rather than one or the other.
 */
export interface SecretBinding {
  get(): Promise<string>;
}

/** `ANTHROPIC_API_KEY` as either binding form. */
export type ApiKeySource = string | SecretBinding;

/** The generator Worker's env, narrowed to what this package reads. */
export interface AiEnv {
  readonly ANTHROPIC_API_KEY: ApiKeySource;
  /** Pinned in `vars` so the model id is a deploy-time decision, not a code edit. */
  readonly ANTHROPIC_MODEL?: string | undefined;
}

/**
 * Resolves the API key from either binding form.
 *
 * This is the type-safe spelling of `await env.ANTHROPIC_API_KEY.get?.() ?? env.ANTHROPIC_API_KEY`:
 * the optional call cannot be written against a `string | SecretBinding` union without narrowing
 * first, and the narrowing is what makes a misconfigured binding a named error instead of a
 * `TypeError` inside a paid step.
 *
 * Guarantees a non-empty string or a thrown `MissingApiKeyError`; never returns a blank key.
 */
export async function resolveApiKey(source: ApiKeySource): Promise<string> {
  if (typeof source === 'string') {
    const trimmed = source.trim();
    if (trimmed.length === 0) throw new MissingApiKeyError('the bound string is empty');
    return trimmed;
  }
  if (typeof source === 'object' && source !== null && typeof source.get === 'function') {
    const value = await source.get();
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed.length === 0) throw new MissingApiKeyError('Secrets Store returned an empty value');
    return trimmed;
  }
  throw new MissingApiKeyError('the binding is neither a string nor a Secrets Store secret');
}

/** The model id for generation calls: the `vars` override when set, `claude-opus-5` otherwise. */
export function resolveModel(env: AiEnv): string {
  const configured = env.ANTHROPIC_MODEL;
  return typeof configured === 'string' && configured.trim().length > 0
    ? configured.trim()
    : MODEL_OPUS_5;
}

/** Options for `createAnthropicClient()`. */
export interface AnthropicClientOptions {
  /** Request timeout in MILLISECONDS. Must stay below the calling Workflow step's own timeout. */
  readonly timeoutMs?: number | undefined;
}

/**
 * Narrows a freshly constructed SDK client to the surface this package uses.
 *
 * The assertion is deliberate and is paid for with a runtime check: the beta parameters this
 * pipeline is built on (`fallbacks`, `output_config`, `task_budget`) live behind SDK type names
 * that move between minor releases, so `protocol.ts` binds to the wire shape instead and this is
 * the single boundary where the two meet. If the installed SDK ever stops exposing the two methods,
 * that surfaces here as a named, non-retryable error at client construction rather than as a
 * `TypeError` five retries deep into a paid step.
 */
function narrowToClient(candidate: unknown): AnthropicClient {
  const beta: unknown =
    typeof candidate === 'object' && candidate !== null
      ? (candidate as { beta?: unknown }).beta
      : undefined;
  const messages: unknown =
    typeof beta === 'object' && beta !== null
      ? (beta as { messages?: unknown }).messages
      : undefined;
  if (typeof messages !== 'object' || messages === null) {
    throw new SdkSurfaceError('client.beta.messages is missing');
  }
  const surface = messages as { stream?: unknown; parse?: unknown };
  if (typeof surface.stream !== 'function') {
    throw new SdkSurfaceError('client.beta.messages.stream is not a function');
  }
  if (typeof surface.parse !== 'function') {
    throw new SdkSurfaceError('client.beta.messages.parse is not a function');
  }
  return candidate as AnthropicClient;
}

/**
 * Builds an Anthropic client for the generator.
 *
 * Guarantees: the SDK module is imported only on the first call (so a Worker that never generates
 * never parses it); SDK-level retries are off; the timeout is in milliseconds; and the returned
 * object is proven to expose the two methods this package calls.
 */
export async function createAnthropicClient(
  env: AiEnv,
  options: AnthropicClientOptions = {},
): Promise<AnthropicClient> {
  const apiKey = await resolveApiKey(env.ANTHROPIC_API_KEY);
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return narrowToClient(new Anthropic({ apiKey, maxRetries: 0, timeout }));
}

/** The `betaZodOutputFormat` helper, as this package uses it. */
interface ZodOutputFormatHelpers {
  betaZodOutputFormat(schema: unknown): OutputFormatSpec;
}

/**
 * Compiles a Zod schema into the structured-output grammar spec.
 *
 * `betaZodOutputFormat()` takes exactly one argument -- the two-argument form with a schema *name*
 * is the Python SDK's shape and is a compile error here.
 *
 * The helper module is imported lazily for the same reason as the client, and through a declared
 * shape because the helper is typed against whichever Zod major the SDK was built for; this package
 * is on Zod 4 and must not break when those two disagree on a generic parameter it never uses.
 */
export async function toOutputFormat(schema: unknown): Promise<OutputFormatSpec> {
  const helpers =
    (await import('@anthropic-ai/sdk/helpers/beta/zod')) as unknown as ZodOutputFormatHelpers;
  if (typeof helpers.betaZodOutputFormat !== 'function') {
    throw new SdkSurfaceError(
      'betaZodOutputFormat is missing from @anthropic-ai/sdk/helpers/beta/zod',
    );
  }
  return helpers.betaZodOutputFormat(schema);
}
