import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
  CONFIRM_THRESHOLD,
  DAILY_GENERATION_CAP,
  DAILY_SPEND_CAP_MICRO,
  QUEUE_THRESHOLD,
  RESERVATION_TTL_MS,
  budgetMode,
} from '../do/BudgetDO';
import type { BudgetDO } from '../do/BudgetDO';

/**
 * `BudgetDO` — reservation, settlement, the orphan alarm and the four degradation bands.
 *
 * Every case here is about a way the daily counter could tell a lie, and each lie has a different
 * cost. Double-counting a replayed dispatch ratchets the ceiling down against work that happened
 * once. Failing to settle leaves an estimate charged forever. Settling a run that never spent
 * anything without giving back its generation slot exhausts the volume ceiling on failures. And
 * getting a band boundary wrong turns a busy afternoon into either a customer outage or an
 * unbounded bill.
 */

/** The §6.5 planning figure: $1.20 per free generation, in integer micro-USD. */
const ESTIMATE = 1_200_000;

/** A fixed instant, so nothing here depends on when the suite runs. */
const NOW = Date.parse('2026-09-06T09:00:00.000Z');

/** Addresses one budget object. A distinct name per case: this object is global in production. */
function budget(name: string) {
  return env.BUDGET.get(env.BUDGET.idFromName(name));
}

describe('budgetMode — the four staged degradation bands (§8)', () => {
  it('generates immediately below 70 per cent', () => {
    expect(budgetMode(0)).toBe('allow');
    expect(budgetMode(0.5)).toBe('allow');
    expect(budgetMode(CONFIRM_THRESHOLD - 0.0001)).toBe('allow');
  });

  it('requires e-mail confirmation between 70 and 85 per cent', () => {
    expect(budgetMode(CONFIRM_THRESHOLD)).toBe('confirm_email');
    expect(budgetMode(0.8)).toBe('confirm_email');
    expect(budgetMode(QUEUE_THRESHOLD - 0.0001)).toBe('confirm_email');
  });

  it('confirms and queues between 85 and 100 per cent', () => {
    expect(budgetMode(QUEUE_THRESHOLD)).toBe('queued');
    expect(budgetMode(0.99)).toBe('queued');
  });

  it('defers at and above the ceiling', () => {
    expect(budgetMode(1)).toBe('deferred');
    expect(budgetMode(4)).toBe('deferred');
  });

  it('treats an uncomputable ratio as deferred, never as headroom', () => {
    // A ratio nobody could compute is not evidence that there is budget left.
    expect(budgetMode(Number.NaN)).toBe('deferred');
    expect(budgetMode(-1)).toBe('deferred');
  });
});

describe('BudgetDO reserve', () => {
  it('charges the estimate up front and reports it', async () => {
    const result = await runInDurableObject(budget('reserve-basic'), (instance: BudgetDO) =>
      instance.reserve('job_a', ESTIMATE, NOW),
    );

    expect(result.accepted).toBe(true);
    expect(result.reservationId).not.toBeNull();
    // Charged BEFORE the run, so two hundred concurrent submissions cannot each read a below-cap
    // number and collectively blow past it.
    expect(result.spentMicro).toBe(ESTIMATE);
    expect(result.generationsToday).toBe(1);
    expect(result.capMicro).toBe(DAILY_SPEND_CAP_MICRO);
    expect(result.generationsCap).toBe(DAILY_GENERATION_CAP);
    expect(result.mode).toBe('allow');
  });

  it('is idempotent per job while the reservation is open', async () => {
    const [first, second] = await runInDurableObject(
      budget('reserve-idem'),
      (instance: BudgetDO) => [
        instance.reserve('job_dup', ESTIMATE, NOW),
        instance.reserve('job_dup', ESTIMATE, NOW),
      ],
    );

    expect(second?.reservationId).toBe(first?.reservationId);
    // A replayed dispatch must not charge the day twice for one generation.
    expect(second?.spentMicro).toBe(ESTIMATE);
    expect(second?.generationsToday).toBe(1);
  });

  it('refuses rather than fails once the spend ceiling is reached', async () => {
    const result = await runInDurableObject(budget('reserve-cap'), (instance: BudgetDO) => {
      instance.reserve('job_big', DAILY_SPEND_CAP_MICRO, NOW);
      return instance.reserve('job_next', ESTIMATE, NOW);
    });

    expect(result.accepted).toBe(false);
    expect(result.mode).toBe('deferred');
    // Refused, not errored: the caller still writes the lead, the media and the job row, and only
    // the spend is withheld.
    expect(result.spentMicro).toBe(DAILY_SPEND_CAP_MICRO);
  });

  it('lets the stricter of the two ceilings drive the band', async () => {
    // A day of unusually cheap runs must not sail past the 250-generation ceiling with the spend
    // band still reading "allow".
    const wanted = Math.ceil(DAILY_GENERATION_CAP * QUEUE_THRESHOLD);
    const result = await runInDurableObject(budget('reserve-volume'), (instance: BudgetDO) => {
      for (let index = 0; index < wanted - 1; index += 1) {
        instance.reserve(`job_cheap_${String(index)}`, 1, NOW);
      }
      return instance.reserve('job_cheap_last', 1, NOW);
    });

    expect(result.accepted).toBe(true);
    expect(result.spentMicro / result.capMicro).toBeLessThan(CONFIRM_THRESHOLD);
    expect(result.mode).toBe('queued');
  });
});

describe('BudgetDO settle', () => {
  it('replaces the estimate with what was actually spent', async () => {
    const status = await runInDurableObject(budget('settle-actual'), (instance: BudgetDO) => {
      instance.reserve('job_s', ESTIMATE, NOW);
      instance.settle(
        { reservationId: null, jobId: 'job_s', actualMicro: 800_000, counted: true },
        NOW + 60_000,
      );
      return instance.status(NOW + 60_000);
    });

    expect(status.spentMicro).toBe(800_000);
    expect(status.generationsToday).toBe(1);
  });

  it('settles by job id, because the Workflow never holds a reservation id', async () => {
    const settled = await runInDurableObject(budget('settle-by-job'), (instance: BudgetDO) => {
      instance.reserve('job_by_job', ESTIMATE, NOW);
      return instance.settle(
        { reservationId: null, jobId: 'job_by_job', actualMicro: 10, counted: true },
        NOW + 1000,
      );
    });

    expect(settled).toBe(true);
  });

  it('gives back the generation slot when nothing was spent', async () => {
    // The API reserved and then could not dispatch. Without returning the slot, a day of failed
    // dispatches would exhaust the 250/day ceiling having generated nothing.
    const status = await runInDurableObject(budget('settle-zero'), (instance: BudgetDO) => {
      instance.reserve('job_z', ESTIMATE, NOW);
      instance.settle(
        { reservationId: null, jobId: 'job_z', actualMicro: 0, counted: false },
        NOW + 1000,
      );
      return instance.status(NOW + 1000);
    });

    expect(status.spentMicro).toBe(0);
    expect(status.generationsToday).toBe(0);
  });

  it('is idempotent, so a retried step cannot refund twice', async () => {
    const [second, status] = await runInDurableObject(
      budget('settle-twice'),
      (instance: BudgetDO) => {
        instance.reserve('job_t', ESTIMATE, NOW);
        instance.settle(
          { reservationId: null, jobId: 'job_t', actualMicro: 500_000, counted: true },
          NOW + 1000,
        );
        const again = instance.settle(
          { reservationId: null, jobId: 'job_t', actualMicro: 500_000, counted: true },
          NOW + 2000,
        );
        return [again, instance.status(NOW + 2000)] as const;
      },
    );

    expect(second).toBe(false);
    expect(status.spentMicro).toBe(500_000);
  });
});

describe('BudgetDO orphan alarm', () => {
  it('force-settles a reservation past its deadline, at estimate', async () => {
    const { forced, status } = await runInDurableObject(budget('orphan'), (instance: BudgetDO) => {
      instance.reserve('job_orphan', ESTIMATE, NOW);
      // The run died between reserve and settle: an evicted isolate, a terminated Workflow, a
      // deploy mid-flight.
      const count = instance.forceSettleExpired(NOW + RESERVATION_TTL_MS + 1000);
      return { forced: count, status: instance.status(NOW + RESERVATION_TTL_MS + 1000) };
    });

    expect(forced).toBe(1);
    // FAIL CLOSED: the estimate stays charged. Guessing low on a run we lost track of is how a
    // ceiling stops being a ceiling.
    expect(status.spentMicro).toBe(ESTIMATE);
    expect(status.generationsToday).toBe(1);
  });

  it('leaves a reservation inside its window alone', async () => {
    const forced = await runInDurableObject(budget('orphan-early'), (instance: BudgetDO) => {
      instance.reserve('job_fresh', ESTIMATE, NOW);
      return instance.forceSettleExpired(NOW + RESERVATION_TTL_MS - 1000);
    });

    expect(forced).toBe(0);
  });

  it('makes a late settle a no-op once the alarm has forced it', async () => {
    const settled = await runInDurableObject(budget('orphan-late'), (instance: BudgetDO) => {
      instance.reserve('job_late', ESTIMATE, NOW);
      instance.forceSettleExpired(NOW + RESERVATION_TTL_MS + 1);
      return instance.settle(
        { reservationId: null, jobId: 'job_late', actualMicro: 5, counted: true },
        NOW + RESERVATION_TTL_MS + 2,
      );
    });

    expect(settled).toBe(false);
  });
});

describe('BudgetDO wire contract', () => {
  it('answers /reserve and /settle in the shape apps/api parses', async () => {
    const stub = budget('wire');
    const reserved = await stub.fetch('https://budget.internal/reserve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: 'job_wire', estimateMicro: ESTIMATE }),
    });
    expect(reserved.status).toBe(200);
    const body = (await reserved.json()) as {
      accepted: boolean;
      reservationId: string | null;
      spentMicro: number;
      capMicro: number;
      generationsToday: number;
      generationsCap: number;
    };
    expect(body.accepted).toBe(true);
    expect(typeof body.reservationId).toBe('string');
    expect(body.capMicro).toBe(DAILY_SPEND_CAP_MICRO);

    const settled = await stub.fetch('https://budget.internal/settle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reservationId: body.reservationId, actualMicro: 0 }),
    });
    expect(settled.status).toBe(204);
  });
});
