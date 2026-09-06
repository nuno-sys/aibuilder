import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { streamStructured } from '../call';
import type { StreamDelta } from '../call';
import {
  MalformedOutputError,
  ModelRefusalError,
  OutputTruncatedError,
  SentinelLeakedError,
  classifyTransportError,
} from '../errors';
import type {
  AnthropicClient,
  FinalMessage,
  MessageStreamHandle,
  StreamMessageParams,
  SystemTextBlock,
} from '../protocol';

/**
 * Every branch of the one function that spends money, against a stub. Nothing here opens a socket:
 * a suite that can reach api.anthropic.com is a suite that can spend money in CI.
 */

const Schema = z.object({ ok: z.boolean() });

const SYSTEM: readonly SystemTextBlock[] = [
  { type: 'text', text: 'frozen prefix', cache_control: { type: 'ephemeral' } },
];

interface Stub {
  readonly client: AnthropicClient;
  /** The body of the last request, so the wire shape can be asserted. */
  readonly seen: { params: StreamMessageParams | null };
}

function stubClient(message: FinalMessage, deltas: readonly StreamDelta[] = []): Stub {
  const seen: { params: StreamMessageParams | null } = { params: null };
  const client: AnthropicClient = {
    beta: {
      messages: {
        stream(params: StreamMessageParams): MessageStreamHandle {
          seen.params = params;
          // Handlers are collected, then the deltas are replayed ONCE in wire order when
          // `finalMessage()` is awaited. Firing them inside `on()` instead would order the sink by
          // registration order rather than by arrival order, which the real stream never does — and
          // that difference is precisely what the delta-forwarding test is asserting.
          const handlers = new Map<string, (delta: string, snapshot: string) => void>();
          return {
            on(event, handler) {
              handlers.set(event, handler as (delta: string, snapshot: string) => void);
            },
            finalMessage: () => {
              let snapshot = '';
              for (const delta of deltas) {
                snapshot += delta.text;
                handlers.get(delta.kind)?.(delta.text, snapshot);
              }
              return Promise.resolve(message);
            },
          };
        },
        parse: () => Promise.reject(new Error('parse() is not used on the generation path')),
      },
    },
  };
  return { client, seen };
}

function response(overrides: Partial<FinalMessage>): FinalMessage {
  return {
    stop_reason: 'end_turn',
    content: [],
    usage: {
      input_tokens: 800,
      output_tokens: 1_600,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 22_000,
    },
    _request_id: 'req_test',
    ...overrides,
  };
}

function run(stub: Stub, extra: { readonly sentinels?: readonly string[] } = {}) {
  return streamStructured({
    client: stub.client,
    model: 'claude-opus-5',
    schema: Schema,
    system: SYSTEM,
    messages: [{ role: 'user', content: 'task' }],
    maxTokens: 32_000,
    effort: 'high',
    taskBudgetTotal: 40_000,
    outputFormat: { type: 'json_schema' },
    sentinels: extra.sentinels,
  });
}

/** Awaits a promise that must reject, and hands back what it threw. */
async function capture(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw, but it resolved');
}

describe('streamStructured', () => {
  it('sends the exact beta call shape', async () => {
    const stub = stubClient(response({ content: [{ type: 'text', text: '{"ok":true}' }] }));
    await run(stub);
    const params = stub.seen.params;
    expect(params).not.toBeNull();
    expect(params?.model).toBe('claude-opus-5');
    expect(params?.betas).toEqual(['server-side-fallback-2026-07-01', 'task-budgets-2026-03-13']);
    expect(params?.fallbacks).toBe('default');
    expect(params?.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(params?.output_config.task_budget).toEqual({ type: 'tokens', total: 40_000 });
    expect(params?.output_config.task_budget.total).toBeGreaterThanOrEqual(20_000);
    expect(params?.output_config.effort).toBe('high');
    // The breakpoint travels with the system array, never with the tenant turn.
    expect(params?.system.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    expect(params?.messages.every((entry) => entry.role === 'user')).toBe(true);
  });

  it('parses and validates a well-formed document', async () => {
    const stub = stubClient(response({ content: [{ type: 'text', text: '{"ok":true}' }] }));
    const outcome = await run(stub);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.value).toEqual({ ok: true });
    expect(outcome.meta.usage).toEqual({
      inputTokens: 800,
      outputTokens: 1_600,
      cacheCreationTokens: 0,
      cacheReadTokens: 22_000,
    });
    // 800*5 + 1600*25 + 22000*0.5 = 55,000 micro-USD.
    expect(outcome.meta.costUsdMicro).toBe(55_000);
    expect(outcome.meta.requestId).toBe('req_test');
    expect(outcome.meta.fallbackUsed).toBe(false);
  });

  it('turns a refusal into a terminal error carrying stop_details.category', async () => {
    const stub = stubClient(
      response({
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: 'declined' },
        // A refusal still carries content the caller must not read.
        content: [{ type: 'text', text: 'partial' }],
      }),
    );
    const error = await capture(run(stub));
    expect(error).toBeInstanceOf(ModelRefusalError);
    {
      const refusal = error as ModelRefusalError;
      expect(refusal.category).toBe('cyber');
      expect(refusal.explanation).toBe('declined');
      // Terminal: a silent retry burns the full price and refuses again.
      expect(refusal.retryable).toBe(false);
      // The tokens were billed, so the ledger row must still be writable.
      expect(refusal.usage?.outputTokens).toBe(1_600);
      expect(refusal.requestId).toBe('req_test');
    }
  });

  it('turns a truncation into a retryable error, detected from stop_reason not from the parse', async () => {
    const stub = stubClient(
      response({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"ok":tr' }] }),
    );
    const error = await capture(run(stub));
    expect(error).toBeInstanceOf(OutputTruncatedError);
    {
      const truncated = error as OutputTruncatedError;
      expect(truncated.retryable).toBe(true);
      expect(truncated.maxTokens).toBe(32_000);
      expect(truncated.usage?.outputTokens).toBe(1_600);
    }
  });

  it('returns a schema mismatch instead of throwing, with the document intact', async () => {
    const stub = stubClient(response({ content: [{ type: 'text', text: '{"ok":"yes"}' }] }));
    const outcome = await run(stub);
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind !== 'invalid') return;
    expect(outcome.raw).toEqual({ ok: 'yes' });
    expect(outcome.issues.length).toBeGreaterThan(0);
    expect(outcome.issues[0]?.path).toBe('ok');
    // The call was billed whether or not it validated.
    expect(outcome.meta.costUsdMicro).toBe(55_000);
  });

  it('rejects output that is not JSON at all', async () => {
    const stub = stubClient(response({ content: [{ type: 'text', text: 'I cannot do that.' }] }));
    await expect(run(stub)).rejects.toBeInstanceOf(MalformedOutputError);
  });

  it('rejects a response with no text block', async () => {
    const stub = stubClient(response({ content: [{ type: 'thinking' }] }));
    await expect(run(stub)).rejects.toBeInstanceOf(MalformedOutputError);
  });

  it('refuses to hand back a document that echoed the prompt envelope', async () => {
    const stub = stubClient(
      response({ content: [{ type: 'text', text: '{"ok":true,"leak":"AIB-CANARY-abc"}' }] }),
    );
    const error = await capture(run(stub, { sentinels: ['AIB-CANARY-abc'] }));
    expect(error).toBeInstanceOf(SentinelLeakedError);
    expect((error as SentinelLeakedError).retryable).toBe(false);
  });

  it('forwards text and thinking deltas to the progress sink', async () => {
    const stub = stubClient(response({ content: [{ type: 'text', text: '{"ok":true}' }] }), [
      { kind: 'thinking', text: 'weighing layouts' },
      { kind: 'text', text: '{"ok":' },
      { kind: 'text', text: 'true}' },
    ]);
    const seen: StreamDelta[] = [];
    await streamStructured({
      client: stub.client,
      model: 'claude-opus-5',
      schema: Schema,
      system: SYSTEM,
      messages: [{ role: 'user', content: 'task' }],
      maxTokens: 32_000,
      effort: 'high',
      taskBudgetTotal: 40_000,
      outputFormat: { type: 'json_schema' },
      onDelta: (delta) => seen.push(delta),
    });
    expect(seen).toEqual([
      { kind: 'thinking', text: 'weighing layouts' },
      { kind: 'text', text: '{"ok":' },
      { kind: 'text', text: 'true}' },
    ]);
  });

  it('does not let a failing progress sink abort a paid call', async () => {
    const stub = stubClient(response({ content: [{ type: 'text', text: '{"ok":true}' }] }), [
      { kind: 'text', text: 'boom' },
    ]);
    const outcome = await streamStructured({
      client: stub.client,
      model: 'claude-opus-5',
      schema: Schema,
      system: SYSTEM,
      messages: [{ role: 'user', content: 'task' }],
      maxTokens: 32_000,
      effort: 'high',
      taskBudgetTotal: 40_000,
      outputFormat: { type: 'json_schema' },
      onDelta: () => {
        throw new Error('the SSE hub went away');
      },
    });
    expect(outcome.kind).toBe('ok');
  });
});

describe('classifyTransportError', () => {
  it('separates retryable transport failures from our own bugs', () => {
    expect(classifyTransportError({ status: 429 })).toMatchObject({
      retryable: true,
      reason: 'rate_limited',
    });
    expect(classifyTransportError({ status: 503 })).toMatchObject({
      retryable: true,
      reason: 'server_error',
    });
    expect(classifyTransportError({ status: 400 })).toMatchObject({
      retryable: false,
      reason: 'client_error',
    });
    expect(classifyTransportError({ status: 401 })).toMatchObject({ retryable: false });
    expect(classifyTransportError(new Error('socket hang up'))).toMatchObject({
      retryable: true,
      reason: 'connection',
    });
    expect(classifyTransportError('not even an error')).toMatchObject({ retryable: true });
    expect(
      classifyTransportError({ status: 429, headers: { 'retry-after': '30' } }).retryAfterSeconds,
    ).toBe(30);
  });
});
