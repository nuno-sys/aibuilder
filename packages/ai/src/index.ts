/**
 * `@aibuilder/ai` -- the Anthropic prompt architecture and call layer.
 *
 * The shape of the pipeline, in the order a generation runs:
 *
 *   `screen.ts`         a `claude-haiku-4-5` policy classifier over the free-text description,
 *                       before any Opus spend, because a refusal is not refundable.
 *   `prompt/blocks.ts`  the frozen four-block system prefix, derived from `@aibuilder/site-schema`
 *                       and `@aibuilder/core` so it cannot drift, and byte-stable so it caches.
 *   `prompt/tasks.ts`   the per-step user turns: a nonce-wrapped, PII-free facts envelope plus the
 *                       task, always after the cache breakpoint.
 *   `call.ts`           one streamed structured call, branching on `stop_reason` before `content`.
 *   `repair.ts`         deterministic repair, then at most one paid repair turn, then fail the step.
 *   `usage.ts`          `response.usage` -> `generation_calls` -> integer micro-USD.
 *   `steps.ts`          the three functions the generator Workflow actually calls.
 *
 * Nothing in this package imports `cloudflare:*` or touches a binding: `client.ts` takes an `Env`
 * shape and every step takes an injected client, which is what keeps the whole layer runnable in a
 * plain vitest process and testable without spending money.
 */

export * from './errors';
export * from './protocol';

export * from './client';
export * from './usage';

export * from './prompt/blocks';
export * from './prompt/tasks';

export * from './call';
export * from './repair';
export * from './screen';
export * from './steps';
