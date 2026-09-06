import type { Env } from '../env';

/**
 * Typed test doubles.
 *
 * The suite runs in real workerd, so the primitives that matter — `crypto.subtle`, `Request`,
 * `Headers`, the Durable Object runtime — are the real ones. What is faked here is the set of
 * bindings that cannot exist in a test: D1, R2, the API service binding and a Secrets Store entry.
 *
 * THE D1 DOUBLE DISPATCHES ON THE SQL TEXT EXPORTED BY `@aibuilder/db`, not on a hand-written
 * pattern, and this is what makes it honest: a test that answers `cp.dashboard.SQL_GET_SITE_FOR_USER`
 * is answering the statement the loader actually ships, and a statement that is renamed or reworded
 * in the db package makes the double throw `unexpected statement` rather than silently returning
 * `null` and turning a broken query into a green test. It is the same double `apps/api` uses, for
 * the same reasons.
 *
 * IT ALSO RECORDS EVERY STATEMENT IT WAS ASKED TO PREPARE, which is the mechanism behind the
 * strongest test in this app: "an unauthenticated request never reaches data" is provable by
 * counting, not by reading the code.
 *
 * The factories end in one cast each. That is deliberate and it is the only place a cast appears in
 * this Worker: the platform interfaces carry members no test needs, and structurally satisfying all
 * of them would be a page of `throw new Error('unused')` per binding.
 */

/** Answers one prepared statement. Returns a row, an array of rows, or `null`. */
export type FakeD1Handler = (params: readonly unknown[]) => unknown;

/** Statement text (as exported by `@aibuilder/db`) to its answer. */
export type FakeD1Handlers = Readonly<Record<string, FakeD1Handler>>;

/** One prepare/bind the Worker performed. The whole point of the double. */
export interface PreparedCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** A D1 double plus the log of what was asked of it. */
export interface RecordingD1 {
  readonly db: D1Database;
  /** Every statement prepared, in order, with the parameters it was bound to. */
  readonly calls: PreparedCall[];
}

/**
 * Builds a `D1Database` that answers exactly the statements it was given, and records them all.
 *
 * @throws Error when the Worker prepares a statement the test did not stub, which is the signal
 * that a code path reached a query the test did not intend to exercise.
 */
export function recordingD1(handlers: FakeD1Handlers): RecordingD1 {
  const table = new Map<string, FakeD1Handler>(
    Object.entries(handlers).map(([sql, handler]) => [sql.trim(), handler]),
  );
  const calls: PreparedCall[] = [];

  const prepare = (sql: string): unknown => {
    const key = sql.trim();
    let params: readonly unknown[] = [];

    const answer = (): unknown => {
      const handler = table.get(key);
      if (handler === undefined) {
        throw new Error(`recordingD1: unexpected statement:\n${key}`);
      }
      return handler(params);
    };

    const statement = {
      bind(...values: unknown[]): unknown {
        params = values;
        // Recorded at BIND time, not at prepare time, so the log carries the parameters. Every
        // statement this app ships is bound before it is run.
        calls.push({ sql: key, params: values });
        return statement;
      },
      first(): Promise<unknown> {
        const result = answer();
        return Promise.resolve(Array.isArray(result) ? (result[0] ?? null) : (result ?? null));
      },
      all(): Promise<unknown> {
        const result = answer();
        return Promise.resolve({
          results: Array.isArray(result) ? result : result === null ? [] : [result],
          success: true,
          meta: { changes: 0, duration: 0, rows_read: 0, rows_written: 0 },
        });
      },
      run(): Promise<unknown> {
        const result = answer();
        return Promise.resolve({
          results: [],
          success: true,
          meta: {
            changes: typeof result === 'number' ? result : 1,
            duration: 0,
            rows_read: 0,
            rows_written: 0,
          },
        });
      },
      raw(): Promise<unknown[]> {
        return Promise.resolve([]);
      },
    };
    return statement;
  };

  return {
    db: { prepare, batch: () => Promise.resolve([]) } as unknown as D1Database,
    calls,
  };
}

/** The vars and secrets every case gets for free. */
const ENV_DEFAULTS: Readonly<Record<string, unknown>> = {
  ENVIRONMENT: 'staging',
  DASHBOARD_ORIGIN: 'https://app.example-control-plane.test',
  PREVIEW_ORIGIN: 'https://preview.example-control-plane.test',
  APP_ORIGIN: 'https://www.example-control-plane.test',
  API_ORIGIN: 'https://api.example-control-plane.test',
  SITES_ROOT_DOMAIN: 'example-tenants.test',
  MEDIA_CDN_ORIGIN: 'https://cdn.example-tenants.test',
  TURNSTILE_SITE_KEY: 'test-turnstile-site-key',
  PREVIEW_HMAC_KEY: 'k1:MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY',
  IP_SALT: 'test-ip-salt',
};

/** Builds an `Env` carrying `overrides` over the defaults. Everything unlisted is absent. */
export function fakeEnv(overrides: Readonly<Record<string, unknown>>): Env {
  return { ...ENV_DEFAULTS, ...overrides } as unknown as Env;
}

/** A `GET` request to the dashboard with an optional cookie header. */
export function request(path: string, cookie?: string): Request {
  const headers = new Headers();
  if (cookie !== undefined) {
    headers.set('cookie', cookie);
  }
  return new Request(`${String(ENV_DEFAULTS['DASHBOARD_ORIGIN'])}${path}`, { headers });
}

/** base64url of raw bytes, unpadded — the shape `@aibuilder/auth` puts in the session cookie. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** A session cookie value and the `token_hash` the `sessions` row must carry for it. */
export async function sessionCredential(seed = 7): Promise<{
  readonly cookie: string;
  readonly tokenHash: Uint8Array;
}> {
  const bytes = new Uint8Array(32).fill(seed);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return {
    cookie: `__Host-aib_session=${toBase64Url(bytes)}`,
    tokenHash: new Uint8Array(digest),
  };
}
