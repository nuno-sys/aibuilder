import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { QUOTA_LIMITS } from '../do/QuotaDO';
import type { QuotaDO } from '../do/QuotaDO';

/**
 * `QuotaDO` — and specifically: IP-derived limits ESCALATE, they do not block.
 *
 * This is the case worth writing a test for, because getting it wrong is invisible in staging and
 * expensive in production. European mobile traffic is largely CGNAT. A hard cap of ten generations
 * per /24 per day refuses the eleventh Vodafone NL customer of the day, and there is no signal in
 * the request that distinguishes them from a bot — so the refusal lands on a real bakery, at
 * signup, with no recourse. Over the threshold the object must answer `escalate`, which moves the
 * session into the confirm-e-mail mode that already exists: twenty seconds for a human, everything
 * for an automated attack.
 *
 * The identity-bearing subjects are the opposite case: a second signup from one e-mail address in a
 * day is a duplicate, not a customer, so those deny.
 */

const NOW = Date.parse('2026-09-06T09:00:00.000Z');

/** Addresses one subject's counter. Distinct names per case; a counter is per subject. */
function quota(name: string) {
  return env.QUOTA.get(env.QUOTA.idFromName(name));
}

describe('QuotaDO IP-derived subjects', () => {
  it('allows up to the daily limit and then escalates instead of denying', async () => {
    const outcomes = await runInDurableObject(quota('ip:aaa'), (instance: QuotaDO) => {
      const results: string[] = [];
      for (let index = 0; index < QUOTA_LIMITS.ip.perDay + 2; index += 1) {
        results.push(instance.consume('ip', 1, NOW).outcome);
      }
      return results;
    });

    expect(outcomes.slice(0, QUOTA_LIMITS.ip.perDay)).toEqual(
      Array.from({ length: QUOTA_LIMITS.ip.perDay }, () => 'allow'),
    );
    // The eleventh Vodafone customer, not the eleventh bot.
    expect(outcomes[QUOTA_LIMITS.ip.perDay]).toBe('escalate');
    expect(outcomes[QUOTA_LIMITS.ip.perDay + 1]).toBe('escalate');
    expect(outcomes).not.toContain('deny');
  });

  it('escalates on a network subject too, at its own higher limit', async () => {
    const outcomes = await runInDurableObject(quota('net:bbb'), (instance: QuotaDO) => {
      const results: string[] = [];
      for (let index = 0; index < QUOTA_LIMITS.ip_network.perDay + 1; index += 1) {
        results.push(instance.consume('ip_network', 1, NOW).outcome);
      }
      return results;
    });

    expect(outcomes[QUOTA_LIMITS.ip_network.perDay - 1]).toBe('allow');
    expect(outcomes[QUOTA_LIMITS.ip_network.perDay]).toBe('escalate');
  });

  it('still counts an escalated request, because the request proceeds', async () => {
    const second = await runInDurableObject(quota('ip:counts'), (instance: QuotaDO) => {
      for (let index = 0; index < QUOTA_LIMITS.ip.perDay + 1; index += 1) {
        instance.consume('ip', 1, NOW);
      }
      return instance.consume('ip', 1, NOW);
    });

    expect(second.outcome).toBe('escalate');
  });
});

describe('QuotaDO identity-bearing subjects', () => {
  it('denies an e-mail address over its daily limit, with a rollover hint', async () => {
    const results = await runInDurableObject(quota('email:ccc'), (instance: QuotaDO) => {
      const out = [];
      for (let index = 0; index < QUOTA_LIMITS.email.perDay + 1; index += 1) {
        out.push(instance.consume('email', 1, NOW));
      }
      return out;
    });

    const last = results[results.length - 1];
    expect(last?.outcome).toBe('deny');
    expect(last?.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('consumes nothing on a deny, so a refused user has not burned their allowance', async () => {
    const after = await runInDurableObject(quota('email:nocharge'), (instance: QuotaDO) => {
      for (let index = 0; index < QUOTA_LIMITS.email.perDay; index += 1) {
        instance.consume('email', 1, NOW);
      }
      instance.consume('email', 1, NOW); // denied
      instance.release(1, NOW); // one of the allowed ones is given back
      return instance.consume('email', 1, NOW);
    });

    // If the denied attempt had consumed, this would still be denied.
    expect(after.outcome).toBe('allow');
  });

  it('denies on the lifetime limit with no rollover hint, because there is no rollover', async () => {
    const lifetime = QUOTA_LIMITS.email.lifetime ?? 0;
    const last = await runInDurableObject(quota('email:lifetime'), (instance: QuotaDO) => {
      // Spread across days so the daily limit is never the binding one.
      let result = instance.consume('email', 1, NOW);
      for (let index = 1; index <= lifetime; index += 1) {
        result = instance.consume('email', 1, NOW + index * 24 * 60 * 60 * 1000);
      }
      return result;
    });

    expect(last.outcome).toBe('deny');
    // "Try again in six hours" would be a lie the user acts on.
    expect(last.retryAfterSeconds).toBeNull();
  });

  it('gives one business identity one generation a day', async () => {
    const outcomes = await runInDurableObject(quota('identity:ddd'), (instance: QuotaDO) => [
      instance.consume('identity', 1, NOW).outcome,
      instance.consume('identity', 1, NOW).outcome,
    ]);

    expect(outcomes[0]).toBe('allow');
    expect(outcomes[1]).toBe('deny');
  });
});

describe('QuotaDO windows', () => {
  it('rolls the daily window over at UTC midnight', async () => {
    const nextDay = await runInDurableObject(quota('ip:rollover'), (instance: QuotaDO) => {
      for (let index = 0; index < QUOTA_LIMITS.ip.perDay; index += 1) {
        instance.consume('ip', 1, NOW);
      }
      return instance.consume('ip', 1, NOW + 24 * 60 * 60 * 1000);
    });

    expect(nextDay.outcome).toBe('allow');
  });

  it('clamps a release at zero rather than manufacturing allowance', async () => {
    const outcomes = await runInDurableObject(quota('identity:release'), (instance: QuotaDO) => {
      instance.consume('identity', 1, NOW);
      instance.release(1, NOW);
      instance.release(1, NOW);
      instance.release(1, NOW);
      return [
        instance.consume('identity', 1, NOW).outcome,
        instance.consume('identity', 1, NOW).outcome,
      ];
    });

    expect(outcomes[0]).toBe('allow');
    expect(outcomes[1]).toBe('deny');
  });
});

describe('QuotaDO wire contract', () => {
  it('answers /consume in the shape apps/api parses', async () => {
    const response = await quota('ip:wire').fetch('https://quota.internal/consume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'ip', key: 'wire', cost: 1 }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { outcome: string; retryAfterSeconds: number | null };
    expect(body.outcome).toBe('allow');
    expect(body.retryAfterSeconds).toBeNull();
  });

  it('refuses an unknown subject type rather than guessing a limit', async () => {
    // The caller reads a non-200 as "could not reach the layer" and escalates, which is the safe
    // direction: an unknown type must never fall through to `allow`.
    const response = await quota('ip:badtype').fetch('https://quota.internal/consume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'invented', key: 'x', cost: 1 }),
    });

    expect(response.status).toBe(400);
  });
});
