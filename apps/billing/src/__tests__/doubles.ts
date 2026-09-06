import type Stripe from 'stripe';

import type { Env } from '../env';

/**
 * Typed doubles for the billing Worker.
 *
 * The suite runs in real workerd, so `crypto.subtle`, `Request` and the Stripe SDK's worker build
 * are the real ones. What is faked is exactly what cannot exist in a test: two D1 databases, an R2
 * bucket, a service binding, three secrets, and the Stripe API itself.
 *
 * THE D1 DOUBLE DISPATCHES ON SQL TEXT and records every statement with the values bound to it.
 * Both halves matter here. Dispatching on the shipped text means a reworded statement makes a test
 * throw rather than silently answer `null`; recording means the ordering assertions — membership
 * before de-provision, customer before subscription — are assertions about the batch that was
 * actually built, which is the only place those constraints live outside a database trigger.
 */

/** One statement as it was executed, with the values that were bound to it. */
export interface RecordedStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** Answers one prepared statement: rows, a row, or a `Changes` for a write. */
export type Answer = (params: readonly unknown[]) => unknown;

/** A write's outcome, when a test needs `meta.changes` to be something other than 1. */
export class Changes {
  public readonly count: number;

  public constructor(count: number) {
    this.count = count;
  }
}

/** A D1 double that records every statement it runs, including inside `batch()`. */
export interface RecordingD1 {
  readonly db: D1Database;
  readonly log: RecordedStatement[];
  ran(needle: string): boolean;
  find(needle: string): RecordedStatement | undefined;
  /** The position of the first statement containing `needle`, or `-1`. */
  indexOf(needle: string): number;
}

/**
 * Builds a recording D1.
 *
 * @throws Error when the Worker prepares a statement the test did not stub.
 */
export function recordingD1(handlers: Readonly<Record<string, Answer>>): RecordingD1 {
  const table = new Map<string, Answer>(
    Object.entries(handlers).map(([sql, handler]) => [sql.trim(), handler]),
  );
  const log: RecordedStatement[] = [];

  const answerFor = (sql: string, params: readonly unknown[]): unknown => {
    const handler = table.get(sql);
    if (handler === undefined) {
      throw new Error(`recordingD1: unexpected statement:\n${sql}`);
    }
    return handler(params);
  };

  const meta = (result: unknown): D1Meta => ({
    changes: result instanceof Changes ? result.count : 1,
    duration: 0,
    rows_read: 0,
    rows_written: 0,
    last_row_id: 0,
    size_after: 0,
    changed_db: true,
  });

  const prepare = (rawSql: string): unknown => {
    const sql = rawSql.trim();
    let params: readonly unknown[] = [];
    const statement = {
      sql,
      get params(): readonly unknown[] {
        return params;
      },
      bind(...values: unknown[]): unknown {
        params = values;
        return statement;
      },
      run(): Promise<unknown> {
        log.push({ sql, params });
        const result = answerFor(sql, params);
        return Promise.resolve({ results: [], success: true, meta: meta(result) });
      },
      first(): Promise<unknown> {
        log.push({ sql, params });
        const result = answerFor(sql, params);
        return Promise.resolve(Array.isArray(result) ? (result[0] ?? null) : (result ?? null));
      },
      all(): Promise<unknown> {
        log.push({ sql, params });
        const result = answerFor(sql, params);
        return Promise.resolve({
          results: Array.isArray(result) ? result : result === null ? [] : [result],
          success: true,
          meta: meta(result),
        });
      },
      raw(): Promise<unknown[]> {
        return Promise.resolve([]);
      },
    };
    return statement;
  };

  const batch = (statements: readonly unknown[]): Promise<unknown[]> =>
    Promise.resolve(
      statements.map((entry) => {
        const typed = entry as { readonly sql: string; readonly params: readonly unknown[] };
        log.push({ sql: typed.sql, params: typed.params });
        return { results: [], success: true, meta: meta(answerFor(typed.sql, typed.params)) };
      }),
    );

  return {
    db: { prepare, batch } as unknown as D1Database,
    log,
    ran: (needle) => log.some((entry) => entry.sql.includes(needle)),
    find: (needle) => log.find((entry) => entry.sql.includes(needle)),
    indexOf: (needle) => log.findIndex((entry) => entry.sql.includes(needle)),
  };
}

/** An R2 double that swallows writes; the event archive is best-effort by design. */
export function fakeR2(): R2Bucket {
  return { put: () => Promise.resolve(null) } as unknown as R2Bucket;
}

/** A `Fetcher` double that records what it was asked for. */
export interface RecordingFetcher {
  readonly fetcher: Fetcher;
  readonly calls: { readonly url: string; readonly body: unknown }[];
}

/** Builds a `Fetcher` double. */
export function recordingFetcher(status = 200): RecordingFetcher {
  const calls: { url: string; body: unknown }[] = [];
  const fetcher = {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = new Request(input as RequestInfo, init);
      const body: unknown = await request.json().catch(() => null);
      calls.push({ url: request.url, body });
      return new Response(null, { status });
    },
  };
  return { fetcher: fetcher as unknown as Fetcher, calls };
}

/** What a Stripe API double was asked to do, so a test can assert "exactly once". */
export interface StripeCalls {
  readonly sessionRetrieves: string[];
  readonly subscriptionRetrieves: string[];
  readonly subscriptionUpdates: { readonly id: string; readonly params: unknown }[];
  readonly subscriptionCancels: string[];
}

/**
 * Builds a Stripe API double.
 *
 * Only the four methods the webhook handlers call are implemented. The cast is deliberate and is
 * the only one in this file's public surface: `Stripe` carries hundreds of resources a test has no
 * business stubbing, and a structurally complete double would be a page of `throw` per resource.
 */
export function fakeStripe(objects: {
  readonly session?: Partial<Stripe.Checkout.Session>;
  readonly subscription?: Partial<Stripe.Subscription>;
  readonly updatedSubscription?: Partial<Stripe.Subscription>;
}): { stripe: Stripe; calls: StripeCalls } {
  const calls: StripeCalls = {
    sessionRetrieves: [],
    subscriptionRetrieves: [],
    subscriptionUpdates: [],
    subscriptionCancels: [],
  };
  const client = {
    checkout: {
      sessions: {
        retrieve: (id: string) => {
          calls.sessionRetrieves.push(id);
          return Promise.resolve(objects.session ?? {});
        },
      },
    },
    subscriptions: {
      retrieve: (id: string) => {
        calls.subscriptionRetrieves.push(id);
        return Promise.resolve(objects.subscription ?? {});
      },
      update: (id: string, params: unknown) => {
        calls.subscriptionUpdates.push({ id, params });
        return Promise.resolve(objects.updatedSubscription ?? objects.subscription ?? {});
      },
      cancel: (id: string) => {
        calls.subscriptionCancels.push(id);
        return Promise.resolve(objects.updatedSubscription ?? objects.subscription ?? {});
      },
    },
  };
  return { stripe: client as unknown as Stripe, calls };
}

/** The vars and secrets every case gets for free. */
const ENV_DEFAULTS: Readonly<Record<string, unknown>> = {
  STRIPE_SECRET_KEY: 'sk_test_stub',
  STRIPE_WEBHOOK_SECRET: 'whsec_test_stub',
  TRIAL_FINGERPRINT_PEPPER: 'test-pepper',
  ENVIRONMENT: 'staging',
  APP_ORIGIN: 'https://www.example-control-plane.test',
  API_ORIGIN: 'https://api.example-control-plane.test',
  DASHBOARD_ORIGIN: 'https://app.example-control-plane.test',
  SITES_ROOT_DOMAIN: 'sites.test',
  STRIPE_PRICE_ID: 'price_test_annual',
};

/**
 * Builds an `Env` with test values, overridden per case.
 *
 * A binding the case did not provide throws BY NAME when it is read, so a test that reaches a path
 * it did not intend to exercise fails with "binding CP was used but not stubbed" rather than with a
 * `TypeError` fifteen frames deeper.
 */
export function testEnv(overrides: Partial<Env> = {}): Env {
  const values: Record<string, unknown> = { ...ENV_DEFAULTS, ...overrides };
  return new Proxy(values, {
    get(target, property): unknown {
      if (typeof property === 'symbol' || property === 'then') {
        return undefined;
      }
      if (!(property in target)) {
        throw new Error(`testEnv: binding ${String(property)} was used but not stubbed`);
      }
      return target[property];
    },
  }) as unknown as Env;
}
