import { createAnthropicClient, resolveModel } from '@aibuilder/ai';
import type { AnthropicClient } from '@aibuilder/ai';

import type { Env } from './env';

/**
 * Client construction for the three model steps.
 *
 * Everything load-bearing about the client lives in `@aibuilder/ai/client.ts` — `maxRetries: 0`
 * because Workflows owns retries, the millisecond timeout, the lazy SDK import that keeps the
 * parse off a 400 ms startup CPU budget. This module exists for one reason the AI package cannot
 * own: THE TIMEOUT IS A FUNCTION OF THE STEP IT RUNS IN.
 *
 * The chain is `SDK timeout < step guard < Workflow step timeout < 30-minute platform ceiling`, and
 * every link matters:
 *
 *   - The SDK aborting first is what turns a hung call into a TYPED error the retry ladder can
 *     classify. A Workflow step timeout arrives as an opaque platform failure with no status, no
 *     `retry-after` and no usage, which classifies as "unknown" and gets the full retry treatment
 *     at full price.
 *   - The SDK timeout is ~10-12 minutes and emphatically NOT 180 seconds (§8): a 180 s abort fires
 *     on the majority of SUCCESSFUL generations, after the tokens are already billed, and the retry
 *     then pays for them again.
 *   - And the step guard exists because a step is not one call. The repair ladder makes up to three
 *     (one plus two paid repair rounds), so `SDK timeout < step timeout` alone would let a
 *     three-round step run to 3x the SDK timeout and blow through the step's budget anyway. The
 *     guard is one `AbortSignal` shared by every round, deadline-based rather than per-call.
 */

/** A constructed client plus the model id it should be called with. */
export interface ModelRuntime {
  readonly client: AnthropicClient;
  readonly model: string;
}

/**
 * Builds the Anthropic client for one step.
 *
 * Guarantees the SDK's own timeout is exactly `timeoutMs`, in milliseconds, and that SDK-level
 * retries are off so every attempt is a durable, ledgered Workflow attempt.
 */
export async function modelRuntime(env: Env, timeoutMs: number): Promise<ModelRuntime> {
  const client = await createAnthropicClient(env, { timeoutMs });
  return { client, model: resolveModel(env) };
}

/**
 * A wall-clock guard for one step, as an `AbortSignal`.
 *
 * `AbortSignal.timeout` rather than a manual `setTimeout`: the timer is owned by the runtime, it
 * cannot leak past the step, and the abort reason it produces is a `TimeoutError` the transport
 * classifier already reads as retryable.
 */
export function stepDeadline(budgetMs: number): AbortSignal {
  return AbortSignal.timeout(budgetMs);
}
