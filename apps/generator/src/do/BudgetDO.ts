import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../env';

/**
 * `BudgetDO` — one global instance, and the only thing standing between a bot and the bill
 * (architecture §8 layer 6, §10 risk 1).
 *
 * MONEY IS ONLY EVER COUNTED IN A DURABLE OBJECT. D1 is eventually consistent across replicas and
 * single-threaded on writes; a spend counter read from a replica is a counter you can spend twice.
 * One instance, named `global`, in the EU jurisdiction, is the serialisation point for every
 * reservation in the product. That is the cost of counting money correctly and it is worth it.
 *
 * RESERVE, THEN SETTLE. The estimate is charged against the day *before* the generation starts, so
 * two hundred concurrent submissions cannot each see a below-cap number and collectively blow past
 * it. The run then settles against real `usage`, and the difference — positive or negative — is
 * applied to the same day the reservation was opened, not to the day it happened to finish on.
 *
 * THE +10 MINUTE ALARM IS THE SAFETY NET, NOT THE MECHANISM. A run that dies between reserve and
 * settle — an evicted isolate, a terminated Workflow, a deploy mid-flight — would otherwise hold
 * its estimate forever and ratchet the ceiling down until the day rolled over. The alarm
 * force-settles every reservation past its deadline **at estimate**, which is failing closed: the
 * money is treated as spent, because the alternative is treating an unknown as free.
 *
 * AND THE COUNTER MUST NOT RATCHET. A settle at zero — the API reserved and then could not
 * dispatch, or the run aborted before its first call — gives back both the estimated micro-dollars
 * *and* the generation slot. Without that second half a day of failed dispatches would exhaust the
 * 250-generation ceiling having generated nothing.
 *
 * STAGED DEGRADATION IS WHAT MAKES A HARD CAP SURVIVABLE (§8). A naive cap turns a bot attack into
 * a customer outage: the attacker spends the day's budget by 09:00 and every real bakery that signs
 * up afterwards sees a failure. The four bands below degrade instead:
 *
 *   < 70 %     generate immediately
 *   70 - 85 %  require e-mail confirmation first — kills essentially all automated abuse and costs
 *              a real user twenty seconds
 *   85 - 100 % confirm and queue
 *   >= 100 %   onboarding still succeeds; the lead, the media and the job row are kept and the
 *              generation is deferred with an honest "we'll e-mail you within the hour"
 *
 * The object owns the numbers and reports the band; `apps/api/src/lib/budget.ts` owns the response
 * shapes each band maps onto. Both must agree on the thresholds, which is why they are named
 * constants on both sides rather than inline literals.
 */

/** The daily hard ceiling, in integer micro-USD. $500/day (§8). Money never touches a float. */
export const DAILY_SPEND_CAP_MICRO = 500_000_000;

/** The daily volume ceiling. 250 generations/day (§8). */
export const DAILY_GENERATION_CAP = 250;

/** Below this share of the stricter ceiling, generate immediately. */
export const CONFIRM_THRESHOLD = 0.7;

/** At or above this share, confirm AND queue rather than generating on the spot. */
export const QUEUE_THRESHOLD = 0.85;

/**
 * How long a reservation may stay open before the alarm force-settles it at estimate.
 *
 * Ten minutes is longer than any single step's timeout and shorter than a stuck run's blast radius.
 */
export const RESERVATION_TTL_MS = 10 * 60 * 1000;

/** Days of history kept in the object. Long enough for a month-end review, short enough to be free. */
const DAY_RETENTION = 120;

/** What a caller may do with a request, given where the day stands. */
export type BudgetMode = 'allow' | 'confirm_email' | 'queued' | 'deferred';

/**
 * Maps a spend ratio onto the staged degradation band.
 *
 * Guarantees a total result for any finite input, and that a negative or NaN ratio is treated as
 * `deferred` rather than as `allow` — a ratio nobody could compute is not evidence of headroom.
 */
export function budgetMode(ratio: number): BudgetMode {
  if (!Number.isFinite(ratio) || ratio < 0) return 'deferred';
  if (ratio < CONFIRM_THRESHOLD) return 'allow';
  if (ratio < QUEUE_THRESHOLD) return 'confirm_email';
  return ratio < 1 ? 'queued' : 'deferred';
}

/** One day's counters. `spent_micro` includes every open reservation at its estimate. */
interface DayRow {
  // `SqlStorage.exec<T>` constrains T to `Record<string, SqlStorageValue>`; the named fields above
  // are the contract, this signature only satisfies the constraint.
  readonly [column: string]: SqlStorageValue;
  readonly day: string;
  readonly spent_micro: number;
  readonly generations: number;
}

/** One reservation. `settled_micro` is NULL while it is open. */
interface ReservationRow {
  // `SqlStorage.exec<T>` constrains T to `Record<string, SqlStorageValue>`; the named fields above
  // are the contract, this signature only satisfies the constraint.
  readonly [column: string]: SqlStorageValue;
  readonly id: string;
  readonly job_id: string;
  readonly estimate_micro: number;
  readonly settled_micro: number | null;
  readonly day: string;
  readonly created_at: number;
  readonly expires_at: number;
}

/** The reserve response, field-for-field what `apps/api/src/lib/budget.ts` parses. */
interface ReserveResponse {
  readonly accepted: boolean;
  readonly reservationId: string | null;
  readonly spentMicro: number;
  readonly capMicro: number;
  readonly generationsToday: number;
  readonly generationsCap: number;
  /**
   * The band this request lands in.
   *
   * An addition to the §8 wire contract, not a replacement: the API computes the same band from
   * `spentMicro / capMicro` and the generation ratio, and ignores this field. It exists so the
   * generator's own deferred-job drain does not have to re-derive policy that already lives here.
   */
  readonly mode: BudgetMode;
}

/** UTC calendar day, `YYYY-MM-DD`. UTC and not a local zone: the cap is global, so the day must be. */
function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Coerces an unknown to a non-negative integer number of micro-USD. */
function microAmount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

export class BudgetDO extends DurableObject<Env> {
  public constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void this.ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      await Promise.resolve();
    });
  }

  private migrate(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS days (
        day         TEXT PRIMARY KEY,
        spent_micro INTEGER NOT NULL,
        generations INTEGER NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS reservations (
        id             TEXT PRIMARY KEY,
        job_id         TEXT NOT NULL,
        estimate_micro INTEGER NOT NULL,
        settled_micro  INTEGER,
        day            TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        expires_at     INTEGER NOT NULL,
        settled_at     INTEGER,
        forced         INTEGER NOT NULL DEFAULT 0
      )
    `);
    // One OPEN reservation per job. A duplicate dispatch must find the first one rather than open a
    // second and charge the day twice for one generation. Partial rather than total, because a job
    // that settles and is then legitimately re-run (a Phase 2 regeneration reusing an id) must be
    // able to open a fresh reservation instead of hitting a constraint failure inside a paid path.
    sql.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_reservations_open_job ON reservations(job_id) WHERE settled_micro IS NULL`,
    );
    sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_reservations_open ON reservations(expires_at) WHERE settled_micro IS NULL`,
    );
  }

  public override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/reserve':
        return this.handleReserve(request);
      case '/settle':
        return this.handleSettle(request);
      case '/status':
        return Response.json(this.status(Date.now()));
      default:
        return new Response('not found', { status: 404 });
    }
  }

  /* -- Reserve ------------------------------------------------------------------------------- */

  private async handleReserve(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== 'object' || body === null) {
      return new Response('bad request', { status: 400 });
    }

    const record = body as Record<string, unknown>;
    const jobId = record['jobId'];
    const estimate = microAmount(record['estimateMicro']);
    if (typeof jobId !== 'string' || jobId.length === 0 || estimate === null) {
      return new Response('bad request', { status: 400 });
    }

    const response = this.reserve(jobId, estimate, Date.now());
    await this.armAlarm();
    return Response.json(response);
  }

  /**
   * Reserves the estimated cost of one generation and reports where the day stands.
   *
   * Guarantees: idempotent per `jobId` while the reservation is open, so a replayed dispatch never
   * charges twice; the estimate is included in the returned `spentMicro` when accepted, so the
   * caller's ratio already accounts for the request being decided; and a refusal is reported as
   * `accepted: false` rather than as an error, because the caller's job is to defer, not to fail.
   */
  public reserve(jobId: string, estimateMicro: number, now: number): ReserveResponse {
    const sql = this.ctx.storage.sql;

    const open = sql
      .exec<ReservationRow>(
        `SELECT * FROM reservations WHERE job_id = ? AND settled_micro IS NULL`,
        jobId,
      )
      .toArray()[0];
    if (open !== undefined) {
      const day = this.day(open.day);
      return this.respond(true, open.id, day);
    }

    const today = utcDay(now);
    const day = this.day(today);
    const wouldSpend = day.spent_micro + estimateMicro;
    const wouldCount = day.generations + 1;

    if (wouldSpend > DAILY_SPEND_CAP_MICRO || wouldCount > DAILY_GENERATION_CAP) {
      // Refused, not failed. The lead, the media and the job row are all still written by the
      // caller; only the spend is withheld (§8, staged degradation).
      return this.respond(false, null, day);
    }

    const id = crypto.randomUUID();
    sql.exec(
      `INSERT INTO reservations (id, job_id, estimate_micro, day, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      jobId,
      estimateMicro,
      today,
      now,
      now + RESERVATION_TTL_MS,
    );
    const updated = this.writeDay(today, wouldSpend, wouldCount);
    this.pruneDays(now);
    return this.respond(true, id, updated);
  }

  /* -- Settle -------------------------------------------------------------------------------- */

  private async handleSettle(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== 'object' || body === null) {
      return new Response('bad request', { status: 400 });
    }

    const record = body as Record<string, unknown>;
    const reservationId = record['reservationId'];
    const jobId = record['jobId'];
    const actual = microAmount(record['actualMicro']);
    const counted = record['counted'];
    if (actual === null) return new Response('bad request', { status: 400 });

    this.settle(
      {
        reservationId: typeof reservationId === 'string' ? reservationId : null,
        jobId: typeof jobId === 'string' ? jobId : null,
        actualMicro: actual,
        counted: typeof counted === 'boolean' ? counted : actual > 0,
      },
      Date.now(),
    );
    await this.armAlarm();
    return new Response(null, { status: 204 });
  }

  /**
   * Settles a reservation against what was actually spent.
   *
   * Addressable by `reservationId` OR by `jobId`: the API holds the reservation id it was handed at
   * submit, and the Workflow holds only the job id — it is dispatched with identifiers, never with
   * a reservation handle. Both name the same row.
   *
   * Guarantees: idempotent (a second settle of the same reservation is a no-op, so a retried step
   * cannot refund twice); the adjustment lands on the day the reservation was *opened*, so a run
   * that crosses midnight does not credit tomorrow for yesterday's spend; and `counted: false`
   * (which `actualMicro === 0` implies) gives the generation slot back so the volume ceiling cannot
   * ratchet against runs that never happened.
   */
  public settle(
    args: {
      readonly reservationId: string | null;
      readonly jobId: string | null;
      readonly actualMicro: number;
      readonly counted: boolean;
    },
    now: number,
  ): boolean {
    const sql = this.ctx.storage.sql;
    const row =
      args.reservationId !== null
        ? sql
            .exec<ReservationRow>(
              `SELECT * FROM reservations WHERE id = ? AND settled_micro IS NULL`,
              args.reservationId,
            )
            .toArray()[0]
        : args.jobId !== null
          ? sql
              .exec<ReservationRow>(
                `SELECT * FROM reservations WHERE job_id = ? AND settled_micro IS NULL`,
                args.jobId,
              )
              .toArray()[0]
          : undefined;
    if (row === undefined) return false;

    const day = this.day(row.day);
    const spent = Math.max(0, day.spent_micro - row.estimate_micro + args.actualMicro);
    const generations = args.counted ? day.generations : Math.max(0, day.generations - 1);

    sql.exec(
      `UPDATE reservations SET settled_micro = ?, settled_at = ? WHERE id = ?`,
      args.actualMicro,
      now,
      row.id,
    );
    this.writeDay(row.day, spent, generations);
    return true;
  }

  /* -- The orphan alarm ---------------------------------------------------------------------- */

  /**
   * Force-settles every reservation past its deadline, at estimate.
   *
   * Fails closed on purpose: the estimate stays charged and the generation stays counted, because a
   * run we lost track of is more likely to have spent the money than not, and the failure mode of
   * guessing low is an unbounded bill. Returns how many were settled, for the ops digest.
   *
   * Takes `now` explicitly rather than reading the clock, so the deadline behaviour is a property
   * of the arguments and can be asserted without waiting ten minutes.
   */
  public forceSettleExpired(now: number): number {
    const sql = this.ctx.storage.sql;
    const expired = sql
      .exec<ReservationRow>(
        `SELECT * FROM reservations WHERE settled_micro IS NULL AND expires_at <= ?`,
        now,
      )
      .toArray();
    for (const row of expired) {
      sql.exec(
        `UPDATE reservations SET settled_micro = estimate_micro, settled_at = ?, forced = 1 WHERE id = ?`,
        now,
        row.id,
      );
    }
    return expired.length;
  }

  /** Runs the force-settle sweep and re-arms for the next deadline. */
  public override async alarm(): Promise<void> {
    this.forceSettleExpired(Date.now());
    await this.armAlarm();
  }

  /**
   * Points the alarm at the earliest open reservation's deadline.
   *
   * One alarm for the whole object rather than one per reservation, because a Durable Object has
   * exactly one. Re-armed after every reserve and settle so it always tracks the true earliest.
   */
  private async armAlarm(): Promise<void> {
    const next = this.ctx.storage.sql
      .exec<{ next_at: number | null }>(
        `SELECT min(expires_at) AS next_at FROM reservations WHERE settled_micro IS NULL`,
      )
      .toArray()[0];
    const at = next?.next_at ?? null;
    if (at === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) {
      await this.ctx.storage.setAlarm(at);
    }
  }

  /* -- Day counters -------------------------------------------------------------------------- */

  /** Reads a day's counters, defaulting to a zero row rather than inserting one on a read. */
  private day(day: string): DayRow {
    const row = this.ctx.storage.sql
      .exec<DayRow>(`SELECT day, spent_micro, generations FROM days WHERE day = ?`, day)
      .toArray()[0];
    return row ?? { day, spent_micro: 0, generations: 0 };
  }

  private writeDay(day: string, spentMicro: number, generations: number): DayRow {
    this.ctx.storage.sql.exec(
      `INSERT INTO days (day, spent_micro, generations) VALUES (?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET spent_micro = excluded.spent_micro,
                                      generations = excluded.generations`,
      day,
      spentMicro,
      generations,
    );
    return { day, spent_micro: spentMicro, generations };
  }

  /** Drops history past the retention window, and the settled reservations that belong to it. */
  private pruneDays(now: number): void {
    const cutoff = utcDay(now - DAY_RETENTION * 24 * 60 * 60 * 1000);
    const sql = this.ctx.storage.sql;
    sql.exec(`DELETE FROM days WHERE day < ?`, cutoff);
    sql.exec(`DELETE FROM reservations WHERE day < ? AND settled_micro IS NOT NULL`, cutoff);
  }

  /* -- Reporting ----------------------------------------------------------------------------- */

  /** The current standing of the day, for the ops digest and the deferred-job drain. */
  public status(now: number): ReserveResponse {
    const day = this.day(utcDay(now));
    return this.respond(true, null, day);
  }

  /** Builds the wire response, deriving the band from the STRICTER of the two ceilings. */
  private respond(accepted: boolean, reservationId: string | null, day: DayRow): ReserveResponse {
    const spendRatio = day.spent_micro / DAILY_SPEND_CAP_MICRO;
    const volumeRatio = day.generations / DAILY_GENERATION_CAP;
    // Two ceilings, one decision: $500/day and 250 generations/day are both hard, so the stricter
    // drives the degradation. Ignoring the volume ratio would let a day of unusually cheap runs
    // sail past the generation ceiling with the spend band still reading "allow".
    const mode = accepted ? budgetMode(Math.max(spendRatio, volumeRatio)) : 'deferred';
    return {
      accepted,
      reservationId,
      spentMicro: day.spent_micro,
      capMicro: DAILY_SPEND_CAP_MICRO,
      generationsToday: day.generations,
      generationsCap: DAILY_GENERATION_CAP,
      mode,
    };
  }
}
