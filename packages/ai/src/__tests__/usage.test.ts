import { describe, expect, it } from 'vitest';
import type { FinalMessage } from '../protocol';
import {
  EMPTY_USAGE,
  HAIKU_4_5_PRICES,
  OPUS_5_PRICES,
  addUsage,
  costUsdMicro,
  detectFallback,
  formatUsd,
  refusalCategory,
  usageFromResponse,
} from '../usage';

/**
 * The cost arithmetic is the input to the Phase 2 pricing decision (architecture 10, risk 2), so it
 * is tested against the published prices rather than against itself.
 */

const usage = (
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens = 0,
  cacheReadTokens = 0,
) => ({ inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens });

describe('costUsdMicro', () => {
  it('prices each term at the published Opus 5 rate', () => {
    // $/MTok is numerically identical to micro-USD per token, which is why there is no scale factor.
    expect(costUsdMicro(usage(1_000, 0))).toBe(5_000);
    expect(costUsdMicro(usage(0, 1_000))).toBe(25_000);
    expect(costUsdMicro(usage(0, 0, 1_000, 0))).toBe(6_250);
    expect(costUsdMicro(usage(0, 0, 0, 1_000))).toBe(500);
    expect(costUsdMicro(EMPTY_USAGE)).toBe(0);
  });

  it('rounds the total once, not each term', () => {
    // 6.25 + 0.5 = 6.75 micro-USD.
    expect(costUsdMicro(usage(0, 0, 1, 1))).toBe(7);
    expect(costUsdMicro(usage(0, 0, 0, 3))).toBe(2);
  });

  it('does not add a thinking term', () => {
    // Thinking bills inside output_tokens. Two calls with identical usage must cost the same however
    // much of that output was reasoning.
    expect(costUsdMicro(usage(0, 40_000))).toBe(costUsdMicro(usage(0, 40_000)));
    expect(costUsdMicro(usage(0, 40_000))).toBe(1_000_000);
  });

  it('reproduces the architecture 6.5 planning figure for one single-locale generation', () => {
    // One 22K cache write, three cache reads of the same prefix, ~8K fresh input, ~40K output.
    const total =
      costUsdMicro(usage(0, 0, 22_000, 0)) +
      costUsdMicro(usage(0, 0, 0, 66_000)) +
      costUsdMicro(usage(8_000, 40_000));
    expect(total).toBe(1_210_500);
    expect(total).toBeGreaterThan(960_000);
    expect(total).toBeLessThan(1_490_000);
    expect(formatUsd(total)).toBe('$1.2105');
  });

  it('prices the Haiku intake screen at well under a cent', () => {
    expect(costUsdMicro(usage(1_500, 120), HAIKU_4_5_PRICES)).toBe(2_100);
    expect(costUsdMicro(usage(1_500, 120), HAIKU_4_5_PRICES)).toBeLessThan(10_000);
  });

  it('keeps the two price tables distinct', () => {
    expect(OPUS_5_PRICES.input).toBe(5);
    expect(OPUS_5_PRICES.output).toBe(25);
    expect(OPUS_5_PRICES.cacheRead).toBe(0.5);
    expect(OPUS_5_PRICES.cacheWrite).toBe(6.25);
    expect(HAIKU_4_5_PRICES.input).toBe(1);
    expect(HAIKU_4_5_PRICES.output).toBe(5);
  });
});

describe('usageFromResponse', () => {
  it('resolves the nullable cache fields to zero', () => {
    expect(
      usageFromResponse({
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      }),
    ).toEqual(usage(10, 20));
  });

  it('is total over a missing or nonsensical usage object', () => {
    expect(usageFromResponse(undefined)).toEqual(EMPTY_USAGE);
    expect(usageFromResponse(null)).toEqual(EMPTY_USAGE);
    expect(usageFromResponse({ input_tokens: -5, output_tokens: Number.NaN })).toEqual(EMPTY_USAGE);
    expect(usageFromResponse({ input_tokens: 10.7, output_tokens: 0 })).toEqual(usage(10, 0));
  });
});

describe('addUsage', () => {
  it('sums the rounds of a repair ladder into one step total', () => {
    expect(addUsage(usage(1, 2, 3, 4), usage(10, 20, 30, 40))).toEqual(usage(11, 22, 33, 44));
  });
});

const message = (overrides: Partial<FinalMessage>): FinalMessage => ({
  stop_reason: 'end_turn',
  content: [],
  usage: { input_tokens: 0, output_tokens: 0 },
  ...overrides,
});

describe('response signals', () => {
  it('detects a fallback from any of the three signals', () => {
    expect(detectFallback(message({ content: [{ type: 'fallback' }] }), 'claude-opus-5')).toBe(
      true,
    );
    expect(
      detectFallback(
        message({
          usage: { input_tokens: 0, output_tokens: 0, iterations: [{ type: 'fallback_message' }] },
        }),
        'claude-opus-5',
      ),
    ).toBe(true);
    expect(detectFallback(message({ model: 'claude-opus-4-8' }), 'claude-opus-5')).toBe(true);
    expect(detectFallback(message({ model: 'claude-opus-5' }), 'claude-opus-5')).toBe(false);
    expect(detectFallback(message({}), 'claude-opus-5')).toBe(false);
  });

  it('reads a refusal category only on a refusal', () => {
    expect(
      refusalCategory(message({ stop_reason: 'refusal', stop_details: { category: 'cyber' } })),
    ).toBe('cyber');
    // stop_details is populated only on a refusal; anything else must not be mined for one.
    expect(
      refusalCategory(message({ stop_reason: 'end_turn', stop_details: { category: 'cyber' } })),
    ).toBeNull();
    expect(refusalCategory(message({ stop_reason: 'refusal' }))).toBeNull();
  });
});
