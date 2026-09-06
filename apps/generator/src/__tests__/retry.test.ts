import {
  MalformedOutputError,
  MissingApiKeyError,
  ModelRefusalError,
  OutputTruncatedError,
  RepairExhaustedError,
  SdkSurfaceError,
  SentinelLeakedError,
} from '@aibuilder/ai';
import { NotImplementedInPhase1 } from '@aibuilder/core';
import { describe, expect, it } from 'vitest';

import { DocumentInvalidError, GeneratorError, StepDeadlineError } from '../errors';
import { MODEL_STEP_RETRIES, classifyStepFailure } from '../retry';

/**
 * The retry ladder's classification.
 *
 * The distinction under test is the one §6.2 calls the whole game, and the asymmetry of its cost is
 * why it gets its own suite: misclassifying a 429 as terminal fails an onboarding that would have
 * succeeded thirty seconds later, and misclassifying a REFUSAL as retryable spends $1.20 three more
 * times to be refused three more times. The second mistake is the one that has to be impossible.
 */

/** Builds the shape an SDK transport failure arrives in: a status, sometimes a `retry-after`. */
function transportError(status: number, retryAfter?: number): unknown {
  return Object.assign(new Error(`HTTP ${String(status)}`), {
    status,
    ...(retryAfter === undefined ? {} : { headers: { 'retry-after': retryAfter } }),
  });
}

describe('policy failures are terminal', () => {
  it('never retries a refusal, and routes it to needs_review', () => {
    const decision = classifyStepFailure(
      new ModelRefusalError({
        category: 'reasoning_extraction',
        explanation: null,
        usage: null,
        requestId: 'req_1',
      }),
    );

    expect(decision.failureClass).toBe('policy');
    expect(decision.retry).toBe(false);
    expect(decision.needsReview).toBe(true);
    expect(decision.errorCode).toBe('needs_review.model_refusal');
    // `error_code` is `CHECK (length BETWEEN 1 AND 64 AND NOT GLOB '*[^a-z0-9_.]*')`.
    expect(decision.errorCode).toMatch(/^[a-z0-9_.]{1,64}$/u);
  });

  it('never retries a canary leak', () => {
    const decision = classifyStepFailure(new SentinelLeakedError({ usage: null, requestId: null }));

    expect(decision.failureClass).toBe('policy');
    expect(decision.retry).toBe(false);
    expect(decision.needsReview).toBe(true);
  });

  it('never retries a stored policy verdict that is not a pass', () => {
    const decision = classifyStepFailure(
      new GeneratorError('policy_not_passed', 'policy_screen=reject'),
    );

    expect(decision.failureClass).toBe('policy');
    expect(decision.retry).toBe(false);
    expect(decision.needsReview).toBe(true);
  });
});

describe('transport failures are retried', () => {
  it('retries a 429 and carries its retry-after', () => {
    const decision = classifyStepFailure(transportError(429, 12));

    expect(decision.failureClass).toBe('transport');
    expect(decision.retry).toBe(true);
    expect(decision.errorCode).toBe('transport.rate_limited');
    // There is no Priority Tier on Opus 5, so a rate limit is waited out rather than bought around.
    expect(decision.retryAfterSeconds).toBe(12);
    expect(decision.httpStatus).toBe(429);
  });

  it('retries a 5xx', () => {
    const decision = classifyStepFailure(transportError(503));

    expect(decision.failureClass).toBe('transport');
    expect(decision.retry).toBe(true);
    expect(decision.errorCode).toBe('transport.server_error');
  });

  it('retries a connection failure that carries no status at all', () => {
    const decision = classifyStepFailure(new Error('socket hang up'));

    expect(decision.failureClass).toBe('transport');
    expect(decision.retry).toBe(true);
    expect(decision.errorCode).toBe('transport.connection');
  });

  it('does NOT retry a 4xx that is our own bug', () => {
    // A malformed parameter or an invalid schema reproduces exactly on retry; burning the ladder on
    // it turns a five-second failure into a twenty-minute one.
    const decision = classifyStepFailure(transportError(400));

    expect(decision.failureClass).toBe('internal');
    expect(decision.retry).toBe(false);
  });

  it('does NOT retry a credential failure', () => {
    expect(classifyStepFailure(transportError(401)).retry).toBe(false);
    expect(classifyStepFailure(new MissingApiKeyError('empty binding')).retry).toBe(false);
    expect(classifyStepFailure(new SdkSurfaceError('stream is not a function')).retry).toBe(false);
  });

  it('reports a step that blew its own deadline as a timeout', () => {
    const decision = classifyStepFailure(new StepDeadlineError('copy', 23 * 60_000));

    expect(decision.failureClass).toBe('transport');
    expect(decision.retry).toBe(true);
    expect(decision.jobStatus).toBe('timed_out');
  });
});

describe('content failures are retried once, because a retry draws a fresh sample', () => {
  it('retries a truncated document', () => {
    const decision = classifyStepFailure(
      new OutputTruncatedError({ maxTokens: 32_000, usage: null, requestId: null }),
    );

    expect(decision.failureClass).toBe('content');
    expect(decision.retry).toBe(true);
  });

  it('retries unreadable output', () => {
    const decision = classifyStepFailure(
      new MalformedOutputError({
        detail: 'Unexpected end of JSON input',
        usage: null,
        requestId: null,
      }),
    );

    expect(decision.failureClass).toBe('content');
    expect(decision.retry).toBe(true);
  });

  it('retries an exhausted repair ladder at the step level', () => {
    const decision = classifyStepFailure(
      new RepairExhaustedError({
        defects: [{ path: 'pages.0', problem: 'no sections', constraint: 'at least one' }],
        rounds: 2,
        usage: null,
      }),
    );

    expect(decision.failureClass).toBe('content');
    expect(decision.retry).toBe(true);
  });

  it('does NOT retry a document whose defect is deterministic', () => {
    // The ai steps are memoised, so re-running `assemble` re-assembles the same documents and
    // reaches the same finding. Retrying would cost twenty minutes to learn nothing.
    const decision = classifyStepFailure(
      new DocumentInvalidError(['whatsapp_without_number@chrome.whatsappEnabled']),
    );

    expect(decision.failureClass).toBe('content');
    expect(decision.retry).toBe(false);
  });
});

describe('classification is total', () => {
  it('classifies an out-of-scope step as terminal rather than retrying it three times', () => {
    const decision = classifyStepFailure(new NotImplementedInPhase1('render'));

    expect(decision.retry).toBe(false);
    expect(decision.errorCode).toBe('not_implemented');
  });

  it('survives a thrown string', () => {
    const decision = classifyStepFailure('something went wrong');

    expect(decision.errorCode).toMatch(/^[a-z0-9_.]{1,64}$/u);
    expect(typeof decision.retry).toBe('boolean');
  });

  it('survives a thrown null', () => {
    expect(() => classifyStepFailure(null)).not.toThrow();
  });

  it('lets an explicit non-retryable flag beat a transient-looking status', () => {
    const decision = classifyStepFailure(
      Object.assign(new Error('nope'), { status: 503, retryable: false }),
    );

    expect(decision.retry).toBe(false);
  });
});

describe('retry policies', () => {
  it('gives a model step two retries, not five', () => {
    // Every attempt is a full-price Opus call, and the second identical failure is evidence about
    // the prompt rather than about luck.
    expect(MODEL_STEP_RETRIES.limit).toBe(2);
    expect(MODEL_STEP_RETRIES.backoff).toBe('exponential');
  });
});
