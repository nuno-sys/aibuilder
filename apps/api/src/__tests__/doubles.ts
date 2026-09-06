import type { AnonSessionRow, OnboardingDraftRow } from '@aibuilder/db';

import type { Env, RateLimitBinding } from '../env';

/**
 * Typed test doubles.
 *
 * The suite runs in real workerd, so the runtime primitives that matter — `crypto.subtle`,
 * `Request`, `Headers`, the router — are the real ones. What is faked here is exactly the set of
 * bindings that cannot exist in a test: D1, a rate-limit namespace and a Secrets Store entry.
 *
 * The D1 double dispatches on the SQL TEXT exported by `@aibuilder/db`, not on a hand-written
 * pattern. That is what makes it honest: a test that answers `cp.slugs.SQL_IS_SLUG_TAKEN` is
 * answering the statement the Worker actually ships, and a statement that is renamed or reworded in
 * the db package makes the double throw `unexpected statement` rather than silently returning
 * `null` and turning a broken query into a green test.
 *
 * Both factories end in one cast. That is deliberate and it is the only place a cast appears in
 * this Worker: the platform interfaces carry members no test needs, and structurally satisfying all
 * of them would be a page of `throw new Error('unused')` per binding.
 */

/** Answers one prepared statement. Returns a row, an array of rows, or `null`. */
export type FakeD1Handler = (params: readonly unknown[]) => unknown;

/** Statement text (as exported by `@aibuilder/db`) to its answer. */
export type FakeD1Handlers = Readonly<Record<string, FakeD1Handler>>;

/**
 * Builds a `D1Database` that answers exactly the statements it was given.
 *
 * @throws Error when the Worker prepares a statement the test did not stub, which is the signal
 * that a code path reached a query the test did not intend to exercise.
 */
export function fakeD1(handlers: FakeD1Handlers): D1Database {
  const table = new Map<string, FakeD1Handler>(
    Object.entries(handlers).map(([sql, handler]) => [sql.trim(), handler]),
  );

  const prepare = (sql: string): unknown => {
    const key = sql.trim();
    let params: readonly unknown[] = [];

    const answer = (): unknown => {
      const handler = table.get(key);
      if (handler === undefined) {
        throw new Error(`fakeD1: unexpected statement:\n${key}`);
      }
      return handler(params);
    };

    const statement = {
      bind(...values: unknown[]): unknown {
        params = values;
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

  return { prepare, batch: () => Promise.resolve([]) } as unknown as D1Database;
}

/** A rate-limit binding that always allows, or always refuses. */
export function fakeRateLimit(success: boolean): RateLimitBinding {
  return { limit: () => Promise.resolve({ success }) };
}

/** A 32-byte HMAC key in the `kid:material` form `DRAFT_HMAC_KEY` accepts. */
export const TEST_HMAC_KEY = 'k1:MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY';

/** A second key, for the dual-accept rotation case. */
export const TEST_HMAC_KEY_ROTATED = 'k2:ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA';

/** The origin the tests treat as the application's. */
export const TEST_APP_ORIGIN = 'https://www.example-control-plane.test';

/** The vars, secrets and rate limiters every case gets for free. */
const ENV_DEFAULTS: Readonly<Record<string, unknown>> = {
  IMAGES: null,
  RL_DRAFT: fakeRateLimit(true),
  RL_SUBMIT: fakeRateLimit(true),
  RL_UPLOAD: fakeRateLimit(true),
  RL_LEADS: fakeRateLimit(true),
  TURNSTILE_SECRET: 'test-turnstile-secret',
  DRAFT_HMAC_KEY: TEST_HMAC_KEY,
  IP_SALT: 'test-ip-salt',
  R2_ACCESS_KEY_ID: 'test-access-key',
  R2_SECRET_KEY: 'test-secret-key',
  GEOCODER_KEY: 'test-geocoder-key',
  ENVIRONMENT: 'staging',
  APP_ORIGIN: TEST_APP_ORIGIN,
  SITES_ROOT_DOMAIN: 'sites.test',
  R2_S3_ENDPOINT: 'https://account.eu.r2.cloudflarestorage.com',
  R2_QUARANTINE_BUCKET: 'aibuilder-quarantine',
  TURNSTILE_SITE_KEY: 'test-site-key',
};

/**
 * Builds an `Env` with test values, overridden per case.
 *
 * A binding the case did not provide is not merely absent — reading it throws by name. A test that
 * reaches a path it did not intend to exercise then fails with "binding CP was used but not
 * stubbed" instead of with a `TypeError` fifteen frames deeper.
 *
 * The trap deliberately passes symbols and `then` through as `undefined`: an `Env` that throws on
 * `Symbol.toStringTag` breaks `console.log`, and one that throws on `then` breaks `await`.
 */
export function testEnv(overrides: Partial<Env> = {}): Env {
  const values: Record<string, unknown> = { ...ENV_DEFAULTS, ...overrides };
  return new Proxy(values, {
    get(target, property): unknown {
      if (typeof property === 'symbol' || property === 'then') {
        return undefined;
      }
      if (!(property in target)) {
        throw new Error(`testEnv: binding ${property} was used but not stubbed`);
      }
      return target[property];
    },
  }) as unknown as Env;
}

/** A live anonymous session row, as `SQL_GET_ANON_SESSION` would return it. */
export function anonSessionRow(overrides: Partial<AnonSessionRow> = {}): AnonSessionRow {
  const now = Date.now();
  return {
    token_hash: new ArrayBuffer(32),
    id: 'ans_01J0000000000000000000000A',
    ip_hash: null,
    ip_country: 'NL',
    user_agent: null,
    created_at: now,
    last_seen_at: now,
    expires_at: now + 86_400_000,
    revoked_at: null,
    ...overrides,
  };
}

/** An open draft row, as `SQL_GET_LATEST_DRAFT_FOR_SESSION` would return it. */
export function draftRow(overrides: Partial<OnboardingDraftRow> = {}): OnboardingDraftRow {
  const now = Date.now();
  return {
    id: 'drf_01J0000000000000000000000B',
    anon_session_id: 'ans_01J0000000000000000000000A',
    shard_id: 0,
    status: 'open',
    ui_locale: 'nl',
    step: 6,
    furthest_step: 6,
    business_name: 'Kapsalon Anna',
    slug: 'kapsalon-anna',
    industry_key: 'hairdresser',
    default_locale: 'nl',
    extra_locales: null,
    service_area_city: null,
    service_area_radius_km: null,
    address_line1: 'Hoofdstraat 1',
    address_line2: null,
    postal_code: '1011AB',
    city: 'Amsterdam',
    country: 'NL',
    latitude: null,
    longitude: null,
    geo_source: 'none',
    opening_hours: null,
    phone_e164: '+31612345678',
    whatsapp_e164: null,
    gbp_url: null,
    short_description: null,
    contact_email: 'anna@example.test',
    marketing_opt_in: 0,
    media_ids: null,
    idempotency_key: 'test-idempotency-key-0123456789',
    turnstile_verified_at: now,
    policy_screen: 'pending',
    policy_reason: null,
    site_id: null,
    org_id: null,
    generation_job_id: null,
    ip_hash: null,
    ip_country: 'NL',
    created_at: now,
    updated_at: now,
    submitted_at: null,
    purge_after: now + 2_592_000_000,
    ...overrides,
  };
}
