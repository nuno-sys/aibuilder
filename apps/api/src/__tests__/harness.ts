import type { RateLimitBinding } from '../env';

/**
 * The doubles Phase 2's billing tests need on top of `doubles.ts`.
 *
 * WHY A SECOND FILE AND NOT AN EXTENSION OF THE FIRST. `doubles.ts` fakes exactly what Phase 1's
 * suite touches: a D1 that answers a statement and a rate limiter. Everything below exists because
 * the trial-first funnel reaches further — it batches, it talks to two Durable Objects and two
 * service bindings, and the assertions are about WHAT WAS WRITTEN and WHAT WAS CALLED rather than
 * about a status code. A double that cannot be interrogated cannot prove "submit dispatches
 * nothing", which is the single most important claim in DECISIONS §D2.
 *
 * The D1 double still dispatches on the SQL TEXT the Worker ships, so a statement that is reworded
 * makes a test throw `unexpected statement` instead of silently returning `null` and turning a
 * broken query into a green test.
 */

/** One statement as it was executed, with the values that were bound to it. */
export interface RecordedStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** Answers one prepared statement: rows, a row, or a `changes` count for a write. */
export type Answer = (params: readonly unknown[]) => unknown;

/** A write's outcome, when a test needs `meta.changes` to be something other than 1. */
export class Changes {
  public readonly count: number;

  public constructor(count: number) {
    this.count = count;
  }
}

/** A D1 double that records every statement it is asked to run, including inside `batch()`. */
export interface RecordingD1 {
  readonly db: D1Database;
  /** Every statement executed, in order, with its bound parameters. */
  readonly log: RecordedStatement[];
  /** True when a statement whose text contains `needle` was executed. */
  ran(needle: string): boolean;
  /** The first execution of a statement whose text contains `needle`. */
  find(needle: string): RecordedStatement | undefined;
}

/**
 * Builds a recording D1.
 *
 * @throws Error when the Worker prepares a statement the test did not stub — the signal that a code
 * path reached a query the test did not intend to exercise.
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
        const result = answerFor(typed.sql, typed.params);
        return { results: [], success: true, meta: meta(result) };
      }),
    );

  return {
    db: { prepare, batch } as unknown as D1Database,
    log,
    ran: (needle) => log.some((entry) => entry.sql.includes(needle)),
    find: (needle) => log.find((entry) => entry.sql.includes(needle)),
  };
}

/** One call made through a `Fetcher` double. */
export interface RecordedCall {
  readonly url: string;
  readonly body: unknown;
}

/** A service-binding double that records what it was asked for. */
export interface RecordingFetcher {
  readonly fetcher: Fetcher;
  readonly calls: RecordedCall[];
  /** How many calls went to a URL containing `needle`. */
  count(needle: string): number;
}

/** Builds a `Fetcher` double whose handler answers by URL. */
export function recordingFetcher(
  handler: (url: string, body: unknown) => Response,
): RecordingFetcher {
  const calls: RecordedCall[] = [];
  const fetcher = {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = new Request(input as RequestInfo, init);
      const url = request.url;
      let body: unknown = null;
      if (request.method !== 'GET') {
        body = await request.json().catch(() => null);
      }
      calls.push({ url, body });
      return handler(url, body);
    },
  };
  return {
    fetcher: fetcher as unknown as Fetcher,
    calls,
    count: (needle) => calls.filter((call) => call.url.includes(needle)).length,
  };
}

/** What a Durable Object double answered, and what it was asked. */
export interface RecordingDurableObject {
  readonly namespace: DurableObjectNamespace;
  readonly calls: RecordedCall[];
}

/**
 * Builds a Durable Object namespace double.
 *
 * `jurisdiction('eu')` is answered by returning the same namespace, because the production code
 * must call it and a double that omitted it would let a missing jurisdiction through.
 */
export function recordingDurableObject(
  handler: (url: string, body: unknown) => Response,
): RecordingDurableObject {
  const calls: RecordedCall[] = [];
  const stub = {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = new Request(input as RequestInfo, init);
      const body: unknown = await request.json().catch(() => null);
      calls.push({ url: request.url, body });
      return handler(request.url, body);
    },
  };
  const namespace = {
    jurisdiction(): unknown {
      return namespace;
    },
    idFromName(name: string): unknown {
      return { name };
    },
    get(): unknown {
      return stub;
    },
  };
  return { namespace: namespace as unknown as DurableObjectNamespace, calls };
}

/** A `BudgetDO` double that always accepts, and records both reserve and settle. */
export function budgetDouble(): RecordingDurableObject {
  return recordingDurableObject((url) => {
    if (url.endsWith('/reserve')) {
      return Response.json({
        accepted: true,
        reservationId: 'res_test',
        spentMicro: 1,
        capMicro: 500_000_000,
        generationsToday: 1,
        generationsCap: 250,
      });
    }
    return new Response(null, { status: 204 });
  });
}

/** A `QuotaDO` double that always allows. */
export function quotaDouble(): RecordingDurableObject {
  return recordingDurableObject(() => Response.json({ outcome: 'allow', retryAfterSeconds: null }));
}

/** A rate-limit binding that always allows. */
export function allowingRateLimit(): RateLimitBinding {
  return { limit: () => Promise.resolve({ success: true }) };
}

/**
 * A `fetch` stub that answers Turnstile's siteverify and refuses everything else.
 *
 * Refusing everything else is the point: a test that accidentally reaches the network is a test
 * whose result depends on someone else's uptime.
 */
export function turnstileFetch(cdata: string): typeof fetch {
  return ((input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('challenges.cloudflare.com')) {
      return Promise.resolve(
        Response.json({ success: true, action: 'onboarding-submit', cdata, hostname: null }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch to ${url}`));
  }) as typeof fetch;
}
