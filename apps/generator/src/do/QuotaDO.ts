import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../env';
import type { QuotaSubjectType } from './jurisdiction';

/**
 * `QuotaDO` — one instance per quota subject, layer 5 of the six-layer funnel (architecture §8).
 *
 * WHY A DURABLE OBJECT AND NOT D1. These counters decide whether an unauthenticated request may
 * spend roughly a dollar of model time. D1 is eventually consistent across replicas; a counter read
 * from a replica is a counter you can spend twice. Quotas, like money, are counted in a Durable
 * Object, in the EU jurisdiction, always.
 *
 * IP-DERIVED LIMITS ESCALATE, THEY DO NOT BLOCK — and this is the whole reason the two policies
 * below are separate fields rather than one number. European mobile traffic is largely CGNAT: a
 * hard cap of ten generations per /24 per day refuses the eleventh Vodafone NL customer of the day
 * with no signal whatsoever distinguishing them from a bot. The eleventh customer is a customer.
 * Over the threshold the object answers `escalate`, and the caller moves the session into the
 * confirm-e-mail mode the budget degradation already implements — which costs a real user twenty
 * seconds and costs an automated attack everything. Hard blocks are kept for the subjects where a
 * false positive is not a customer: an e-mail address, a phone number, a business identity.
 *
 * AN ESCALATED REQUEST IS STILL COUNTED. It proceeds, so it consumes. A denied request is not: the
 * caller is told no, and telling someone no while charging them for it turns a limit into a trap
 * that a legitimate user can never climb out of.
 *
 * THE CALLER OWNS THE SUBJECTS, THE OBJECT OWNS THE LIMITS. `apps/api` derives `ip`, `ip_network`,
 * `email`, `phone` and `identity` from a request; this file says what each one is worth. Neither
 * owns both, which is what keeps the policy in one place and the identity derivation in another.
 * Every `key` is a hash or a normalised value — no raw IP and no raw e-mail address ever reaches a
 * Durable Object (§8, GDPR posture).
 */

/** What the funnel does next. Mirrors `QuotaOutcome` in `apps/api/src/lib/quota.ts`. */
export type QuotaOutcome = 'allow' | 'escalate' | 'deny';

/** One subject type's allowance. */
export interface QuotaLimit {
  readonly perDay: number;
  /** Total across all time, or `null` when only the daily window applies. */
  readonly lifetime: number | null;
  /**
   * What happens over the limit.
   *
   * `escalate` for anything derived from an IP address; `deny` only where a false positive is a
   * duplicate rather than a customer.
   */
  readonly overLimit: 'escalate' | 'deny';
}

/**
 * The §8 layer-5 allowances.
 *
 * 3 generations/IP/day · 10/IPv4-\24 or IPv6-\48/day · 2/normalised-e-mail/day and 5 lifetime ·
 * 2/E.164/day · 1/business-identity/day, where the identity key is
 * `sha256(nfkc(name) + postcode)`.
 */
export const QUOTA_LIMITS: Readonly<Record<QuotaSubjectType, QuotaLimit>> = {
  ip: { perDay: 3, lifetime: null, overLimit: 'escalate' },
  ip_network: { perDay: 10, lifetime: null, overLimit: 'escalate' },
  email: { perDay: 2, lifetime: 5, overLimit: 'deny' },
  phone: { perDay: 2, lifetime: null, overLimit: 'deny' },
  identity: { perDay: 1, lifetime: null, overLimit: 'deny' },
};

/** The lifetime window's key. Never expires, so its `reset_at` is beyond any real clock. */
const LIFETIME_WINDOW = 'life';
const NEVER = Number.MAX_SAFE_INTEGER;

/** One counter window. */
interface CounterRow {
  // `SqlStorage.exec<T>` constrains T to `Record<string, SqlStorageValue>`; the named fields above
  // are the contract, this signature only satisfies the constraint.
  readonly [column: string]: SqlStorageValue;
  readonly window: string;
  readonly used: number;
  readonly reset_at: number;
}

/** The per-subject answer, field-for-field what `apps/api/src/lib/quota.ts` parses. */
interface ConsumeResponse {
  readonly outcome: QuotaOutcome;
  /** Seconds until the offending window rolls over, or `null` for a lifetime limit. */
  readonly retryAfterSeconds: number | null;
}

/** UTC calendar day, `YYYY-MM-DD`. UTC because the limits are global, so the day must be. */
function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** The instant the current UTC day rolls over. */
function nextUtcMidnight(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

/** True when `value` names one of the five subject types. */
function isSubjectType(value: unknown): value is QuotaSubjectType {
  return (
    value === 'ip' ||
    value === 'ip_network' ||
    value === 'email' ||
    value === 'phone' ||
    value === 'identity'
  );
}

/** Coerces an unknown cost to an integer in `[1, 10]`. */
function readCost(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.min(10, Math.max(1, Math.trunc(value)));
}

export class QuotaDO extends DurableObject<Env> {
  public constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void this.ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      await Promise.resolve();
    });
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS counters (
        window   TEXT PRIMARY KEY,
        used     INTEGER NOT NULL,
        reset_at INTEGER NOT NULL
      )
    `);
  }

  public override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST' && url.pathname !== '/status') {
      return new Response('method not allowed', { status: 405 });
    }

    switch (url.pathname) {
      case '/consume':
      case '/release': {
        const body: unknown = await request.json().catch(() => null);
        if (typeof body !== 'object' || body === null) {
          return new Response('bad request', { status: 400 });
        }
        const record = body as Record<string, unknown>;
        const type = record['type'];
        if (!isSubjectType(type)) return new Response('bad request', { status: 400 });
        const cost = readCost(record['cost']);

        if (url.pathname === '/release') {
          this.release(cost, Date.now());
          return new Response(null, { status: 204 });
        }
        return Response.json(this.consume(type, cost, Date.now()));
      }
      case '/status':
        return Response.json(this.snapshot(Date.now()));
      default:
        return new Response('not found', { status: 404 });
    }
  }

  /**
   * Counts one generation against this subject and says what the funnel should do.
   *
   * Guarantees: a `deny` consumes nothing, so a refused user has not silently burned their
   * allowance; an `escalate` DOES consume, because the request proceeds; and the daily window is
   * derived from the current UTC day rather than from a stored timestamp, so a subject that goes
   * quiet for a week comes back with a clean day rather than a stale counter.
   */
  public consume(type: QuotaSubjectType, cost: number, now: number): ConsumeResponse {
    this.prune(now);
    const limit = QUOTA_LIMITS[type];
    const dayWindow = `d:${utcDay(now)}`;

    const day = this.counter(dayWindow, nextUtcMidnight(now));
    const life = limit.lifetime === null ? null : this.counter(LIFETIME_WINDOW, NEVER);

    const overDay = day.used + cost > limit.perDay;
    const overLifetime =
      limit.lifetime !== null && life !== null && life.used + cost > limit.lifetime;

    if ((overDay || overLifetime) && limit.overLimit === 'deny') {
      return {
        outcome: 'deny',
        // A lifetime limit has no rollover, and pretending it does — "try again in 6 hours" — would
        // be a lie the user acts on. `null` sends them to support instead.
        retryAfterSeconds: overLifetime
          ? null
          : Math.max(1, Math.ceil((day.reset_at - now) / 1000)),
      };
    }

    this.increment(dayWindow, cost, nextUtcMidnight(now));
    if (limit.lifetime !== null) this.increment(LIFETIME_WINDOW, cost, NEVER);

    return {
      outcome: overDay || overLifetime ? 'escalate' : 'allow',
      retryAfterSeconds: null,
    };
  }

  /**
   * Gives back a count taken by an earlier `consume`.
   *
   * Called when a LATER subject in the same submit refused, so the earlier ones must not keep a
   * count for a generation that never ran. Clamped at zero: a double release is a caller bug that
   * must not manufacture allowance.
   */
  public release(cost: number, now: number): void {
    const sql = this.ctx.storage.sql;
    sql.exec(
      `UPDATE counters SET used = max(0, used - ?) WHERE window IN (?, ?)`,
      cost,
      `d:${utcDay(now)}`,
      LIFETIME_WINDOW,
    );
  }

  /** Reads a window, defaulting to a zero row rather than inserting one on a read. */
  private counter(window: string, resetAt: number): CounterRow {
    const row = this.ctx.storage.sql
      .exec<CounterRow>(`SELECT window, used, reset_at FROM counters WHERE window = ?`, window)
      .toArray()[0];
    return row ?? { window, used: 0, reset_at: resetAt };
  }

  private increment(window: string, cost: number, resetAt: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO counters (window, used, reset_at) VALUES (?, ?, ?)
       ON CONFLICT(window) DO UPDATE SET used = used + excluded.used`,
      window,
      cost,
      resetAt,
    );
  }

  /** Drops rolled-over windows. The lifetime row's `reset_at` is beyond any clock, so it survives. */
  private prune(now: number): void {
    this.ctx.storage.sql.exec(`DELETE FROM counters WHERE reset_at <= ?`, now);
  }

  /** Every live window, for the ops digest and the abuse ledger. */
  private snapshot(now: number): { readonly windows: readonly CounterRow[] } {
    this.prune(now);
    return {
      windows: this.ctx.storage.sql
        .exec<CounterRow>(`SELECT window, used, reset_at FROM counters ORDER BY window`)
        .toArray(),
    };
  }
}
