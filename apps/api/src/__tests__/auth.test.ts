import {
  RpIdInvariantError,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  SQL_MARK_MAGIC_LINK_LOGIN,
  WEBAUTHN_COOKIE_NAME,
  checkSignCounter,
  fromBase64Url as fromBase64UrlPkg,
  loadSession,
  mintSession,
  preferredOrgId,
  registrationCeremony,
  rpIdProblem,
  safeNextPath,
  timingSafeEqual,
  toBase64Url as toBase64UrlPkg,
} from '@aibuilder/auth';
import type { MagicLinkInvitation, MagicLinkSender } from '@aibuilder/auth';
import { cp } from '@aibuilder/db';
import type { AuthTokenRow, MembershipRow, SessionRow, UserRow } from '@aibuilder/db';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnv, Env } from '../env';
import { fromBase64Url, toBase64Url } from '../lib/encoding';
import { appCors, jsonContentTypeGuard, originGuard } from '../middleware/origin';
import { securityHeaders } from '../middleware/security-headers';
import { createAuthRoutes } from '../routes/auth';
import { TEST_APP_ORIGIN, fakeRateLimit, testEnv } from './doubles';

/**
 * The authentication surface, at the boundaries where getting it wrong is unrecoverable.
 *
 * Four of these cases are not "does the code work" tests. They are the tests that exist because the
 * mistake they catch cannot be undone after the fact:
 *
 *   - **the `rpID` one-way door** (architecture §10, door 7). A WebAuthn credential is bound to its
 *     RP ID and cannot be migrated. Broadening it to the apex would make every passkey ever
 *     registered invalidatable by a future Public Suffix List entry, with no recovery but universal
 *     re-enrolment. The door has to be shut before the first credential exists, which is now.
 *   - **single use**. D1 has no interactive transactions, so `UPDATE … WHERE consumed_at IS NULL`
 *     plus `meta.changes === 1` IS the transaction. A magic link that mints two sessions is an
 *     account-takeover primitive, and the only thing standing between the two is a WHERE clause.
 *   - **the `__Host-` attribute set**, asserted as a string. A stray `Domain=` attribute does not
 *     loosen the cookie, it makes the browser discard it — and the reviewer who adds one is looking
 *     at a line that reads as a widening, not as a deletion.
 *   - **session rotation**. Every proof of a factor mints a new row and revokes the old one, so a
 *     planted cookie is dead the instant its victim logs in.
 */

// ---------------------------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------------------------

/** The dashboard the tests treat as `app.<control-plane-domain>`. */
const TEST_DASHBOARD_ORIGIN = 'https://app.example-control-plane.test';

/** The RP ID that matches it. A subdomain, three labels, never the apex. */
const TEST_RP_ID = 'app.example-control-plane.test';

/**
 * The three bindings `PHASE2-BILLING-AUTH.md` §8.2 adds to `Env`.
 *
 * `testEnv()` is typed against today's `Env`, so these travel through it as overrides and the
 * result is widened once, here, rather than at every call site. This is the only cast in the file
 * and it disappears the moment `src/env.ts` declares them.
 */
function authEnv(overrides: Partial<Env> = {}): Env {
  const defaults: Record<string, unknown> = {
    DASHBOARD_ORIGIN: TEST_DASHBOARD_ORIGIN,
    WEBAUTHN_RP_ID: TEST_RP_ID,
    RL_AUTH: fakeRateLimit(true),
  };
  return testEnv({ ...defaults, ...overrides } as Partial<Env>) as Env;
}

/** Lowercase hex of whatever D1 was handed as a BLOB bind parameter. */
function blobHex(value: unknown): string {
  const bytes =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : new Uint8Array(0);
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/** A user row, as `SQL_GET_USER` would return it. */
function userRow(overrides: Partial<UserRow> = {}): UserRow {
  const now = 1_700_000_000_000;
  return {
    id: 'usr_01J0000000000000000000000A',
    email: 'anna@example.test',
    email_normalized: 'anna@example.test',
    email_verified_at: null,
    password_hash: null,
    full_name: 'Anna',
    locale: 'nl',
    country: 'NL',
    timezone: 'Europe/Amsterdam',
    marketing_opt_in: 0,
    status: 'active',
    last_login_at: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    ...overrides,
  };
}

/**
 * A stateful control-plane double.
 *
 * Stateful rather than canned, because everything under test here is a state transition: a token
 * that must go from unconsumed to consumed exactly once, a session that must stop resolving after a
 * rotation. A double that answers the same row twice cannot fail the tests that matter.
 *
 * It dispatches on the SQL TEXT exported by `@aibuilder/db` and `@aibuilder/auth`, so a statement
 * that is reworded upstream makes this throw `unexpected statement` rather than silently turning a
 * broken query into a green test.
 */
interface ControlPlane {
  readonly db: D1Database;
  readonly users: Map<string, UserRow>;
  readonly tokens: Map<string, AuthTokenRow>;
  readonly sessions: Map<string, SessionRow>;
  readonly memberships: Pick<MembershipRow, 'user_id' | 'org_id' | 'role'>[];
  /** Write counters, in an object so a caller holds the live value rather than a copy of it. */
  readonly counters: { loginMarks: number };
}

function controlPlane(seed: { readonly users?: readonly UserRow[] } = {}): ControlPlane {
  const state = {
    users: new Map<string, UserRow>((seed.users ?? []).map((user) => [user.id, user])),
    tokens: new Map<string, AuthTokenRow>(),
    sessions: new Map<string, SessionRow>(),
    memberships: [] as Pick<MembershipRow, 'user_id' | 'org_id' | 'role'>[],
    counters: { loginMarks: 0 },
  };

  const handlers: Record<string, (params: readonly unknown[]) => unknown> = {
    [cp.users.SQL_GET_USER_BY_EMAIL]: (params) =>
      [...state.users.values()].find(
        (user) => user.email_normalized === params[0] && user.deleted_at === null,
      ) ?? null,

    [cp.users.SQL_GET_USER]: (params) => state.users.get(String(params[0])) ?? null,

    [cp.users.SQL_LIST_MEMBERSHIPS_FOR_USER]: (params) =>
      state.memberships.filter((membership) => membership.user_id === params[0]),

    [SQL_MARK_MAGIC_LINK_LOGIN]: (params) => {
      const user = state.users.get(String(params[0]));
      if (user === undefined || user.deleted_at !== null) {
        return 0;
      }
      const now = Number(params[1]);
      state.users.set(user.id, {
        ...user,
        email_verified_at: user.email_verified_at ?? now,
        last_login_at: now,
        updated_at: now,
      });
      state.counters.loginMarks += 1;
      return 1;
    },

    [cp.users.SQL_INSERT_AUTH_TOKEN]: (params) => {
      const key = blobHex(params[0]);
      state.tokens.set(key, {
        token_hash: params[0] as ArrayBuffer,
        id: params[1] as AuthTokenRow['id'],
        user_id: params[2] as AuthTokenRow['user_id'],
        email: String(params[3]),
        purpose: params[4] as AuthTokenRow['purpose'],
        org_id: params[5] as AuthTokenRow['org_id'],
        payload: params[6] as string | null,
        ip_hash: params[7] as ArrayBuffer | null,
        created_at: Number(params[8]),
        expires_at: Number(params[9]),
        consumed_at: null,
      });
      return 1;
    },

    // The whole single-use design in one handler: the `consumed_at IS NULL` and `expires_at > ?2`
    // predicates live in the statement, so they are modelled here and nowhere else.
    [cp.users.SQL_CONSUME_AUTH_TOKEN]: (params) => {
      const key = blobHex(params[0]);
      const now = Number(params[1]);
      const token = state.tokens.get(key);
      if (token === undefined || token.consumed_at !== null || token.expires_at <= now) {
        return null;
      }
      const consumed: AuthTokenRow = { ...token, consumed_at: now };
      state.tokens.set(key, consumed);
      return consumed;
    },

    [cp.users.SQL_INSERT_SESSION]: (params) => {
      const key = blobHex(params[0]);
      state.sessions.set(key, {
        token_hash: params[0] as ArrayBuffer,
        id: params[1] as SessionRow['id'],
        user_id: params[2] as SessionRow['user_id'],
        active_org_id: params[3] as SessionRow['active_org_id'],
        ip_hash: params[4] as ArrayBuffer | null,
        user_agent: params[5] as string | null,
        created_at: Number(params[6]),
        last_seen_at: Number(params[6]),
        expires_at: Number(params[7]),
        revoked_at: null,
      });
      return 1;
    },

    [cp.users.SQL_GET_SESSION]: (params) => {
      const session = state.sessions.get(blobHex(params[0]));
      const now = Number(params[1]);
      if (session === undefined || session.revoked_at !== null || session.expires_at <= now) {
        return null;
      }
      return session;
    },

    [cp.users.SQL_TOUCH_SESSION]: (params) => {
      const key = blobHex(params[0]);
      const session = state.sessions.get(key);
      if (session === undefined || session.revoked_at !== null) {
        return 0;
      }
      state.sessions.set(key, {
        ...session,
        last_seen_at: Number(params[1]),
        expires_at: Number(params[2]),
      });
      return 1;
    },

    [cp.users.SQL_REVOKE_SESSION]: (params) => {
      const key = blobHex(params[0]);
      const session = state.sessions.get(key);
      if (session === undefined || session.revoked_at !== null) {
        return 0;
      }
      state.sessions.set(key, { ...session, revoked_at: Number(params[1]) });
      return 1;
    },

    [cp.users.SQL_REVOKE_USER_SESSIONS]: (params) => {
      let revoked = 0;
      for (const [key, session] of state.sessions) {
        if (session.user_id === params[0] && session.revoked_at === null) {
          state.sessions.set(key, { ...session, revoked_at: Number(params[1]) });
          revoked += 1;
        }
      }
      return revoked;
    },
  };

  const table = new Map(Object.entries(handlers).map(([sql, handler]) => [sql.trim(), handler]));

  const prepare = (sql: string): unknown => {
    const key = sql.trim();
    let params: readonly unknown[] = [];
    const answer = (): unknown => {
      const handler = table.get(key);
      if (handler === undefined) {
        throw new Error(`controlPlane: unexpected statement:\n${key}`);
      }
      return handler(params);
    };
    const statement = {
      bind(...values: unknown[]): unknown {
        params = values;
        return statement;
      },
      first: (): Promise<unknown> => {
        const result = answer();
        return Promise.resolve(Array.isArray(result) ? (result[0] ?? null) : (result ?? null));
      },
      all: (): Promise<unknown> => {
        const result = answer();
        return Promise.resolve({
          results: Array.isArray(result) ? result : result === null ? [] : [result],
          success: true,
          meta: { changes: 0, duration: 0, rows_read: 0, rows_written: 0 },
        });
      },
      run: (): Promise<unknown> => {
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
      raw: (): Promise<unknown[]> => Promise.resolve([]),
    };
    return statement;
  };

  // The one cast: the platform interface carries members no test needs, and structurally satisfying
  // all of them would be a page of `throw new Error('unused')`.
  const db = { prepare, batch: () => Promise.resolve([]) } as unknown as D1Database;
  return { db, ...state };
}

/** Records what a handler asked to be sent, without sending anything. */
function recordingSender(): { sender: MagicLinkSender; sent: MagicLinkInvitation[] } {
  const sent: MagicLinkInvitation[] = [];
  return {
    sent,
    sender: {
      send: (invitation: MagicLinkInvitation): Promise<void> => {
        sent.push(invitation);
        return Promise.resolve();
      },
    },
  };
}

/**
 * An `ExecutionContext` that lets a test await what the handler moved off the response path.
 *
 * `POST /v1/auth/magic-link` deliberately mints and sends inside `waitUntil`, so that the response
 * takes the same time for a known and an unknown address. Without this, the test would assert on a
 * token that has not been written yet.
 */
function recordingCtx(): { ctx: ExecutionContext; settled: () => Promise<void> } {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>): void => {
      pending.push(promise);
    },
    passThroughOnException: (): void => undefined,
  } as unknown as ExecutionContext;
  return { ctx, settled: async () => void (await Promise.all(pending)) };
}

/**
 * The app under test, wired exactly as `src/index.ts` wires it.
 *
 * Mounting `createAuthRoutes()` into a `Hono<AppEnv>` is also the compile-time proof that
 * §8.2's `app.route('/v1/auth', authRoutes)` will type-check: the auth router's bindings are wider
 * than `AppEnv`'s, and this is where that would break if Hono disallowed it.
 */
function harness(sender?: MagicLinkSender): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', securityHeaders);
  app.use('*', appCors);
  app.use('*', originGuard);
  app.use('*', jsonContentTypeGuard);
  app.route('/v1/auth', createAuthRoutes(sender === undefined ? {} : { magicLinkSender: sender }));
  return app;
}

/** A Turnstile siteverify that passes. `hostname: null` skips the origin assertion. */
function stubTurnstilePass(): void {
  vi.stubGlobal('fetch', () =>
    Promise.resolve(
      new Response(JSON.stringify({ success: true, action: 'auth-magic-link' }), {
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

/** POSTs JSON with everything the global guards require. */
function jsonPost(body: unknown, cookie?: string): RequestInit {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    Origin: TEST_APP_ORIGIN,
  };
  if (cookie !== undefined) {
    headers['Cookie'] = cookie;
  }
  return { method: 'POST', headers, body: JSON.stringify(body) };
}

/** Every `Set-Cookie` a response carries. */
function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

/** The `Set-Cookie` for one cookie name, or `undefined`. */
function cookieHeader(response: Response, name: string): string | undefined {
  return setCookies(response).find((value) => value.startsWith(`${name}=`));
}

/** The value of a cookie in a `Set-Cookie` header. */
function cookieValue(header: string): string {
  return header.slice(header.indexOf('=') + 1, header.indexOf(';'));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------------------------
// The one-way door
// ---------------------------------------------------------------------------------------------

describe('the WebAuthn RP ID one-way door', () => {
  /**
   * ONE-WAY DOOR (architecture §10, door 7; `PHASE2-BILLING-AUTH.md` §6.5).
   *
   * A WebAuthn credential is bound to its RP ID and cannot be migrated: changing this string
   * invalidates every passkey ever registered, and the only recovery is every user re-enrolling. It
   * must be a SUBDOMAIN and not the apex, so that a future Public Suffix List entry on the
   * registrable domain — which this product's roadmap already contains for `mijnsaas.com` — cannot
   * make it invalid, and so that it is not implicitly valid for every subdomain we ever host.
   */
  it('refuses an apex RP ID', () => {
    expect(rpIdProblem({ rpId: 'aibuilder.app', dashboardOrigin: 'https://aibuilder.app' })).toBe(
      'apex_or_registrable_domain',
    );
    expect(rpIdProblem({ rpId: 'example.co.uk', dashboardOrigin: 'https://example.co.uk' })).toBe(
      'not_the_dashboard_subdomain',
    );
  });

  it('accepts the configured value, and only because it satisfies all three §6.5 assertions', () => {
    const env = authEnv();

    // §6.5, verbatim: the value, the label count, and the assertion that actually catches the
    // realistic mistake — somebody moves the dashboard and `expectedOrigin` silently stops matching
    // `expectedRPID`.
    expect(env.WEBAUTHN_RP_ID).toBe(TEST_RP_ID);
    expect(env.WEBAUTHN_RP_ID.split('.').length).toBeGreaterThanOrEqual(3);
    expect(new URL(env.DASHBOARD_ORIGIN).hostname).toBe(env.WEBAUTHN_RP_ID);
    expect(rpIdProblem({ rpId: env.WEBAUTHN_RP_ID, dashboardOrigin: env.DASHBOARD_ORIGIN })).toBe(
      null,
    );
  });

  it('names every other way the invariant can be broken', () => {
    const cases: readonly (readonly [string, string, string])[] = [
      ['', TEST_DASHBOARD_ORIGIN, 'not_configured'],
      ['APP.example-control-plane.test', TEST_DASHBOARD_ORIGIN, 'not_lowercase'],
      ['app..test', 'https://app..test', 'not_a_hostname'],
      ['www.example-control-plane.test', TEST_DASHBOARD_ORIGIN, 'not_the_dashboard_subdomain'],
      ['app.other.test', 'not-a-url', 'dashboard_origin_not_a_url'],
      ['app.other.test', TEST_DASHBOARD_ORIGIN, 'dashboard_origin_host_mismatch'],
      ['app.insecure.test', 'http://app.insecure.test', 'dashboard_origin_not_https'],
    ];
    for (const [rpId, dashboardOrigin, expected] of cases) {
      expect(rpIdProblem({ rpId, dashboardOrigin })).toBe(expected);
    }
  });

  it('refuses to generate a ceremony under a broadened RP ID', () => {
    expect(() =>
      registrationCeremony({
        rpId: 'example-control-plane.test',
        dashboardOrigin: 'https://example-control-plane.test',
        rpName: 'aibuilder',
        userId: 'usr_01J0000000000000000000000A',
        userName: 'anna@example.test',
        userDisplayName: 'Anna',
        existingCredentials: [],
      }),
    ).toThrow(RpIdInvariantError);
  });

  it('answers 503 and mints nothing when the deployment broadens it to the apex', async () => {
    const user = userRow();
    const plane = controlPlane({ users: [user] });
    const env = authEnv({
      CP: plane.db,
      WEBAUTHN_RP_ID: 'example-control-plane.test',
      DASHBOARD_ORIGIN: 'https://example-control-plane.test',
    });
    const session = await mintSession(env, {
      userId: user.id,
      activeOrgId: null,
      ipHash: null,
      userAgent: null,
      now: Date.now(),
    });

    const response = await harness().request(
      '/v1/auth/passkey/register/options',
      jsonPost({}, `${SESSION_COOKIE_NAME}=${session.cookieValue}`),
      env,
    );

    expect(response.status).toBe(503);
    const body: unknown = await response.json();
    expect((body as Record<string, unknown>)['reason']).toBe('apex_or_registrable_domain');
    // The point of failing here rather than later: no challenge was issued, so no ceremony can be
    // completed against the broadened RP ID.
    expect(cookieHeader(response, WEBAUTHN_COOKIE_NAME)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Magic link
// ---------------------------------------------------------------------------------------------

describe('magic link', () => {
  it('answers 202 identically for a known and an unknown address', async () => {
    stubTurnstilePass();
    const user = userRow();
    const plane = controlPlane({ users: [user] });
    const env = authEnv({ CP: plane.db });
    const { sender, sent } = recordingSender();
    const app = harness(sender);

    const known = recordingCtx();
    const knownResponse = await app.request(
      '/v1/auth/magic-link',
      jsonPost({ email: user.email, turnstileToken: 'tok' }),
      env,
      known.ctx,
    );
    await known.settled();

    const unknown = recordingCtx();
    const unknownResponse = await app.request(
      '/v1/auth/magic-link',
      jsonPost({ email: 'nobody@example.test', turnstileToken: 'tok' }),
      env,
      unknown.ctx,
    );
    await unknown.settled();

    expect(knownResponse.status).toBe(202);
    expect(unknownResponse.status).toBe(202);
    expect(await knownResponse.text()).toBe(await unknownResponse.text());
    // Identical answers, different work: the oracle is closed at the response, not at the mailbox.
    expect(sent).toHaveLength(1);
    expect(plane.tokens.size).toBe(1);
  });

  it('mints a link that points at the dashboard, carries the token in `t`, and expires in 15 minutes', async () => {
    stubTurnstilePass();
    const user = userRow();
    const plane = controlPlane({ users: [user] });
    const env = authEnv({ CP: plane.db });
    const { sender, sent } = recordingSender();
    const ctx = recordingCtx();

    await harness(sender).request(
      '/v1/auth/magic-link',
      jsonPost({ email: user.email, turnstileToken: 'tok' }),
      env,
      ctx.ctx,
    );
    await ctx.settled();

    const invitation = sent[0];
    expect(invitation).toBeDefined();
    const url = new URL(invitation?.url ?? '');
    expect(url.origin).toBe(TEST_DASHBOARD_ORIGIN);
    expect(url.pathname).toBe('/inloggen/verifieren');
    expect(url.searchParams.get('t')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const token = [...plane.tokens.values()][0];
    expect(token?.purpose).toBe('magic_link');
    expect((token?.expires_at ?? 0) - (token?.created_at ?? 0)).toBe(900_000);
    // The stored payload is the allowlisted destination, and only that.
    expect(token?.payload).toBe(JSON.stringify({ next: '/dashboard' }));
  });

  it('refuses and mints nothing when the per-address cap is spent', async () => {
    stubTurnstilePass();
    const user = userRow();
    const plane = controlPlane({ users: [user] });
    const env = authEnv({ CP: plane.db, RL_AUTH: fakeRateLimit(false) });
    const { sender, sent } = recordingSender();
    const ctx = recordingCtx();

    const response = await harness(sender).request(
      '/v1/auth/magic-link',
      jsonPost({ email: user.email, turnstileToken: 'tok' }),
      env,
      ctx.ctx,
    );
    await ctx.settled();

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(sent).toHaveLength(0);
    expect(plane.tokens.size).toBe(0);
  });

  it('mints nothing when Turnstile refuses', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }),
          {
            headers: { 'content-type': 'application/json' },
          },
        ),
      ),
    );
    const user = userRow();
    const plane = controlPlane({ users: [user] });
    const env = authEnv({ CP: plane.db });
    const { sender, sent } = recordingSender();
    const ctx = recordingCtx();

    const response = await harness(sender).request(
      '/v1/auth/magic-link',
      jsonPost({ email: user.email, turnstileToken: 'tok' }),
      env,
      ctx.ctx,
    );
    await ctx.settled();

    expect(response.status).toBe(403);
    expect(sent).toHaveLength(0);
    expect(plane.tokens.size).toBe(0);
  });

  it('is single use: the second verification of the same token is a 410 and mints no session', async () => {
    stubTurnstilePass();
    const user = userRow();
    const plane = controlPlane({ users: [user] });
    const env = authEnv({ CP: plane.db });
    const { sender, sent } = recordingSender();
    const app = harness(sender);

    const issue = recordingCtx();
    await app.request(
      '/v1/auth/magic-link',
      jsonPost({ email: user.email, turnstileToken: 'tok' }),
      env,
      issue.ctx,
    );
    await issue.settled();
    const token = new URL(sent[0]?.url ?? '').searchParams.get('t') ?? '';

    const first = await app.request('/v1/auth/magic-link/verify', jsonPost({ t: token }), env);
    const second = await app.request('/v1/auth/magic-link/verify', jsonPost({ t: token }), env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(410);
    expect(((await second.json()) as Record<string, unknown>)['error']).toBe('link_expired');
    // The assertion the whole design exists for: exactly one session, not two.
    expect(plane.sessions.size).toBe(1);
    expect(cookieHeader(first, SESSION_COOKIE_NAME)).toBeDefined();
    expect(cookieHeader(second, SESSION_COOKIE_NAME)).toBeUndefined();
  });

  it('refuses an expired token and mints no session', async () => {
    const user = userRow();
    const plane = controlPlane({ users: [user] });
    const env = authEnv({ CP: plane.db });

    // Written directly, expired an hour ago. The expiry predicate lives in the statement, so this
    // exercises the same path a real fifteen-minute-old link takes.
    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    const digest = await crypto.subtle.digest('SHA-256', tokenBytes);
    await cp.users.insertAuthToken(plane.db, {
      tokenHash: new Uint8Array(digest),
      id: 'tok_01J0000000000000000000000B',
      userId: user.id,
      email: user.email,
      purpose: 'magic_link',
      orgId: null,
      payload: null,
      ipHash: null,
      now: Date.now() - 7_200_000,
      expiresAt: Date.now() - 3_600_000,
    });

    const response = await harness().request(
      '/v1/auth/magic-link/verify',
      jsonPost({ t: toBase64Url(tokenBytes) }),
      env,
    );

    expect(response.status).toBe(410);
    expect(plane.sessions.size).toBe(0);
    expect(plane.counters.loginMarks).toBe(0);
  });

  it('refuses a token minted for a different purpose', async () => {
    const user = userRow();
    const plane = controlPlane({ users: [user] });
    const env = authEnv({ CP: plane.db });

    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    const digest = await crypto.subtle.digest('SHA-256', tokenBytes);
    await cp.users.insertAuthToken(plane.db, {
      tokenHash: new Uint8Array(digest),
      id: 'tok_01J0000000000000000000000C',
      userId: user.id,
      email: user.email,
      purpose: 'org_invite',
      orgId: 'org_01J0000000000000000000000D',
      payload: null,
      ipHash: null,
      now: Date.now(),
      expiresAt: Date.now() + 900_000,
    });

    const response = await harness().request(
      '/v1/auth/magic-link/verify',
      jsonPost({ t: toBase64Url(tokenBytes) }),
      env,
    );

    expect(response.status).toBe(410);
    expect(plane.sessions.size).toBe(0);
    // Documented cost of sharing `SQL_CONSUME_AUTH_TOKEN` across purposes: the invite is burnt.
    // Burning it requires already holding its 256-bit value, so this is a re-send and not an
    // escalation. The fix is a purpose-scoped consume statement in `packages/db`.
    expect([...plane.tokens.values()][0]?.consumed_at).not.toBeNull();
  });

  it('rejects a malformed token without touching the database', async () => {
    const plane = controlPlane();
    const env = authEnv({ CP: plane.db });

    for (const token of ['not+base64url', 'AAAA', 'x'.repeat(129)]) {
      const response = await harness().request(
        '/v1/auth/magic-link/verify',
        jsonPost({ t: token }),
        env,
      );
      expect([410, 422]).toContain(response.status);
    }
    expect(plane.sessions.size).toBe(0);
  });

  it('verifies the e-mail address, and is the only thing that does', async () => {
    stubTurnstilePass();
    const user = userRow({ email_verified_at: null });
    const plane = controlPlane({ users: [user] });
    const env = authEnv({ CP: plane.db });
    const { sender, sent } = recordingSender();
    const app = harness(sender);

    const issue = recordingCtx();
    await app.request(
      '/v1/auth/magic-link',
      jsonPost({ email: user.email, turnstileToken: 'tok' }),
      env,
      issue.ctx,
    );
    await issue.settled();

    await app.request(
      '/v1/auth/magic-link/verify',
      jsonPost({ t: new URL(sent[0]?.url ?? '').searchParams.get('t') ?? '' }),
      env,
    );

    expect(plane.users.get(user.id)?.email_verified_at).not.toBeNull();
    expect(plane.users.get(user.id)?.last_login_at).not.toBeNull();
    expect(plane.counters.loginMarks).toBe(1);
  });

  it('never redirects anywhere but an allowlisted same-origin path', () => {
    expect(safeNextPath('/dashboard/sites')).toBe('/dashboard/sites');
    for (const hostile of [
      '//evil.test',
      '/\\evil.test',
      'https://evil.test',
      '/dashboard?next=https://evil.test',
      '/dashboard#@evil.test',
      undefined,
      null,
      '/' + 'a'.repeat(200),
    ]) {
      expect(safeNextPath(hostile)).toBe('/dashboard');
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

describe('sessions', () => {
  it('rotates on claim: the old token stops resolving the moment a factor is proved', async () => {
    stubTurnstilePass();
    const user = userRow();
    const plane = controlPlane({ users: [user] });
    const env = authEnv({ CP: plane.db });
    const { sender, sent } = recordingSender();
    const app = harness(sender);

    // The cookie an attacker plants, or simply an older session in the same browser.
    const planted = await mintSession(env, {
      userId: user.id,
      activeOrgId: null,
      ipHash: null,
      userAgent: null,
      now: Date.now(),
    });
    const plantedCookie = `${SESSION_COOKIE_NAME}=${planted.cookieValue}`;
    expect(await loadSession(env, plantedCookie, Date.now())).not.toBeNull();

    const issue = recordingCtx();
    await app.request(
      '/v1/auth/magic-link',
      jsonPost({ email: user.email, turnstileToken: 'tok' }),
      env,
      issue.ctx,
    );
    await issue.settled();

    const response = await app.request(
      '/v1/auth/magic-link/verify',
      jsonPost({ t: new URL(sent[0]?.url ?? '').searchParams.get('t') ?? '' }, plantedCookie),
      env,
    );

    expect(response.status).toBe(200);
    const header = cookieHeader(response, SESSION_COOKIE_NAME);
    expect(header).toBeDefined();
    const fresh = cookieValue(header ?? '');
    expect(fresh).not.toBe(planted.cookieValue);

    // The planted token is dead; the fresh one is live. That is the whole of session fixation.
    expect(await loadSession(env, plantedCookie, Date.now())).toBeNull();
    expect(await loadSession(env, `${SESSION_COOKIE_NAME}=${fresh}`, Date.now())).not.toBeNull();
    // Minted before revoked: two rows exist, exactly one of them live.
    expect(plane.sessions.size).toBe(2);
    expect([...plane.sessions.values()].filter((s) => s.revoked_at === null)).toHaveLength(1);
  });

  it('serialises the attributes the __Host- prefix requires', async () => {
    stubTurnstilePass();
    const user = userRow();
    const plane = controlPlane({ users: [user] });
    const env = authEnv({ CP: plane.db });
    const { sender, sent } = recordingSender();
    const app = harness(sender);

    const issue = recordingCtx();
    await app.request(
      '/v1/auth/magic-link',
      jsonPost({ email: user.email, turnstileToken: 'tok' }),
      env,
      issue.ctx,
    );
    await issue.settled();
    const response = await app.request(
      '/v1/auth/magic-link/verify',
      jsonPost({ t: new URL(sent[0]?.url ?? '').searchParams.get('t') ?? '' }),
      env,
    );

    const header = cookieHeader(response, SESSION_COOKIE_NAME) ?? '';
    expect(header.startsWith('__Host-aib_session=')).toBe(true);
    expect(header).toContain('Secure');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(header).toContain(`Max-Age=${String(SESSION_TTL_MS / 1000)}`);
    // A `Domain` attribute silently voids the `__Host-` prefix: the browser discards the cookie.
    expect(header).not.toContain('Domain=');
    // The raw token never appears anywhere but this header.
    expect(await response.text()).not.toContain(cookieValue(header));
  });

  it('requires a live session, and one answer covers missing, forged, revoked and expired', async () => {
    const user = userRow();
    const plane = controlPlane({ users: [user] });
    const env = authEnv({ CP: plane.db });
    const app = harness();

    const live = await mintSession(env, {
      userId: user.id,
      activeOrgId: null,
      ipHash: null,
      userAgent: null,
      now: Date.now(),
    });

    const forged = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const cases: readonly (string | undefined)[] = [
      undefined,
      `${SESSION_COOKIE_NAME}=${forged}`,
      `${SESSION_COOKIE_NAME}=not-base64url!`,
      `${SESSION_COOKIE_NAME}=${live.cookieValue.slice(0, 20)}`,
    ];
    for (const cookie of cases) {
      const response = await app.request(
        '/v1/auth/me',
        cookie === undefined ? {} : { headers: { Cookie: cookie } },
        env,
      );
      expect(response.status).toBe(401);
      expect(((await response.json()) as Record<string, unknown>)['error']).toBe('no_session');
    }

    const ok = await app.request(
      '/v1/auth/me',
      { headers: { Cookie: `${SESSION_COOKIE_NAME}=${live.cookieValue}` } },
      env,
    );
    expect(ok.status).toBe(200);
  });

  it('reports who the caller is, and which organisation they act in', async () => {
    const user = userRow();
    const plane = controlPlane({ users: [user] });
    plane.memberships.push(
      { user_id: user.id, org_id: 'org_01J0000000000000000000000E', role: 'editor' },
      { user_id: user.id, org_id: 'org_01J0000000000000000000000F', role: 'owner' },
    );
    const env = authEnv({ CP: plane.db });
    const session = await mintSession(env, {
      userId: user.id,
      activeOrgId: 'org_01J0000000000000000000000F',
      ipHash: null,
      userAgent: null,
      now: Date.now(),
    });

    const response = await harness().request(
      '/v1/auth/me',
      { headers: { Cookie: `${SESSION_COOKIE_NAME}=${session.cookieValue}` } },
      env,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      user: { id: string; emailVerified: boolean };
      activeOrgId: string;
      memberships: readonly unknown[];
    };
    expect(body.user.id).toBe(user.id);
    expect(body.user.emailVerified).toBe(false);
    expect(body.activeOrgId).toBe('org_01J0000000000000000000000F');
    expect(body.memberships).toHaveLength(2);
    // Ownership wins over an alphabetically earlier editor membership.
    expect(preferredOrgId(plane.memberships)).toBe('org_01J0000000000000000000000F');
  });

  it('logs out: both cookies cleared, the row revoked', async () => {
    const user = userRow();
    const plane = controlPlane({ users: [user] });
    const env = authEnv({ CP: plane.db });
    const session = await mintSession(env, {
      userId: user.id,
      activeOrgId: null,
      ipHash: null,
      userAgent: null,
      now: Date.now(),
    });
    const cookie = `${SESSION_COOKIE_NAME}=${session.cookieValue}`;

    const response = await harness().request('/v1/auth/logout', jsonPost({}, cookie), env);

    expect(response.status).toBe(200);
    for (const name of ['__Host-aib_session', '__Host-aib_draft']) {
      const header = cookieHeader(response, name) ?? '';
      expect(header).toContain('Max-Age=0');
      expect(header).toContain('Path=/');
      expect(header).toContain('Secure');
      expect(header).not.toContain('Domain=');
    }
    expect(await loadSession(env, cookie, Date.now())).toBeNull();
  });

  it('logs out everywhere and says how many sessions that was', async () => {
    const user = userRow();
    const plane = controlPlane({ users: [user] });
    const env = authEnv({ CP: plane.db });
    const now = Date.now();
    const first = await mintSession(env, {
      userId: user.id,
      activeOrgId: null,
      ipHash: null,
      userAgent: null,
      now,
    });
    const second = await mintSession(env, {
      userId: user.id,
      activeOrgId: null,
      ipHash: null,
      userAgent: null,
      now,
    });

    const response = await harness().request(
      '/v1/auth/logout-all',
      jsonPost({}, `${SESSION_COOKIE_NAME}=${first.cookieValue}`),
      env,
    );

    expect(response.status).toBe(200);
    expect(((await response.json()) as Record<string, unknown>)['revoked']).toBe(2);
    expect(await loadSession(env, `${SESSION_COOKIE_NAME}=${second.cookieValue}`, Date.now())).toBe(
      null,
    );
  });

  it('slides last_seen_at at most once an hour', async () => {
    const user = userRow();
    const plane = controlPlane({ users: [user] });
    const env = authEnv({ CP: plane.db });
    const now = Date.now();
    const session = await mintSession(env, {
      userId: user.id,
      activeOrgId: null,
      ipHash: null,
      userAgent: null,
      now,
    });
    const cookie = `${SESSION_COOKIE_NAME}=${session.cookieValue}`;
    const key = [...plane.sessions.keys()][0] ?? '';

    await harness().request('/v1/auth/me', { headers: { Cookie: cookie } }, env);
    expect(plane.sessions.get(key)?.last_seen_at).toBe(now);

    // Age the row past the idle window; the next read writes.
    const stale = plane.sessions.get(key);
    if (stale !== undefined) {
      plane.sessions.set(key, { ...stale, last_seen_at: now - 7_200_000 });
    }
    await harness().request('/v1/auth/me', { headers: { Cookie: cookie } }, env);
    expect(plane.sessions.get(key)?.last_seen_at).toBeGreaterThan(now - 7_200_000);
  });
});

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

describe('primitives', () => {
  it('compares in constant time, and gets the answer right', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    expect(timingSafeEqual(a, new Uint8Array([1, 2, 3, 4]))).toBe(true);
    // Differs in the FIRST byte: a byte-wise early return would answer here and leak that fact.
    expect(timingSafeEqual(a, new Uint8Array([9, 2, 3, 4]))).toBe(false);
    // Differs in the LAST byte: the same call has to do the same work.
    expect(timingSafeEqual(a, new Uint8Array([1, 2, 3, 9]))).toBe(false);
    expect(timingSafeEqual(a, new Uint8Array([1, 2, 3]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });

  it('rejects a session row whose stored hash is not the one that was looked up', async () => {
    const user = userRow();
    const plane = controlPlane({ users: [user] });
    const env = authEnv({ CP: plane.db });
    const session = await mintSession(env, {
      userId: user.id,
      activeOrgId: null,
      ipHash: null,
      userAgent: null,
      now: Date.now(),
    });

    // Corrupt the stored digest. `loadSession`'s constant-time integrity check is what catches a
    // lookup that returned the wrong row; without it the caller would authenticate on it.
    const key = [...plane.sessions.keys()][0] ?? '';
    const row = plane.sessions.get(key);
    if (row !== undefined) {
      plane.sessions.set(key, { ...row, token_hash: new ArrayBuffer(32) });
    }

    expect(
      await loadSession(env, `${SESSION_COOKIE_NAME}=${session.cookieValue}`, Date.now()),
    ).toBeNull();
  });

  it('encodes identically to the app-side copy it deliberately duplicates', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    expect(toBase64UrlPkg(bytes)).toBe(toBase64Url(bytes));
    const encoded = toBase64Url(bytes);
    expect([...(fromBase64UrlPkg(encoded) ?? [])]).toEqual([...(fromBase64Url(encoded) ?? [])]);
    expect(fromBase64UrlPkg('not+base64url')).toBeNull();
    expect(fromBase64Url('not+base64url')).toBeNull();
  });

  it('treats a constant zero sign counter as no signal, and a decrease as cloning', () => {
    // Every synced passkey (iCloud Keychain, Google Password Manager) reports a constant 0.
    expect(checkSignCounter(0, 0)).toBe('ok');
    expect(checkSignCounter(0, 5)).toBe('ok');
    expect(checkSignCounter(5, 0)).toBe('ok');
    expect(checkSignCounter(5, 6)).toBe('ok');
    expect(checkSignCounter(5, 4)).toBe('cloned');
  });
});

// ---------------------------------------------------------------------------------------------
// Passkey ceremonies
// ---------------------------------------------------------------------------------------------

describe('passkey ceremonies', () => {
  it('issues registration options bound to the RP ID, with a fresh challenge in a __Host- cookie', async () => {
    const user = userRow();
    const plane = controlPlane({ users: [user] });
    const env = authEnv({ CP: plane.db });
    const session = await mintSession(env, {
      userId: user.id,
      activeOrgId: null,
      ipHash: null,
      userAgent: null,
      now: Date.now(),
    });

    const response = await harness().request(
      '/v1/auth/passkey/register/options',
      jsonPost({}, `${SESSION_COOKIE_NAME}=${session.cookieValue}`),
      env,
    );

    expect(response.status).toBe(200);
    const options = (await response.json()) as {
      rp: { id: string };
      user: { id: string };
      challenge: string;
      attestation: string;
      authenticatorSelection: { residentKey: string };
      pubKeyCredParams: readonly { alg: number }[];
    };
    expect(options.rp.id).toBe(TEST_RP_ID);
    expect(options.attestation).toBe('none');
    expect(options.authenticatorSelection.residentKey).toBe('required');
    expect(options.pubKeyCredParams.map((param) => param.alg)).toEqual([-7, -257, -8]);
    expect(options.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const header = cookieHeader(response, WEBAUTHN_COOKIE_NAME) ?? '';
    expect(cookieValue(header)).toBe(options.challenge);
    expect(header).toContain('Max-Age=300');
    expect(header).toContain('HttpOnly');
    expect(header).not.toContain('Domain=');
  });

  it('never names a credential in authentication options', async () => {
    const plane = controlPlane();
    const env = authEnv({ CP: plane.db });

    const response = await harness().request(
      '/v1/auth/passkey/authenticate/options',
      jsonPost({}),
      env,
    );

    expect(response.status).toBe(200);
    const options = (await response.json()) as { allowCredentials: readonly unknown[] };
    // Discoverable credentials only: naming one would make the login form an existence oracle,
    // which is the same thing `POST /v1/auth/magic-link` refuses to be.
    expect(options.allowCredentials).toEqual([]);
  });

  it('answers 503 with a reason on the two verification endpoints, and burns the challenge', async () => {
    const user = userRow();
    const plane = controlPlane({ users: [user] });
    const env = authEnv({ CP: plane.db });
    const session = await mintSession(env, {
      userId: user.id,
      activeOrgId: null,
      ipHash: null,
      userAgent: null,
      now: Date.now(),
    });

    for (const path of [
      '/v1/auth/passkey/register/verify',
      '/v1/auth/passkey/authenticate/verify',
    ]) {
      const response = await harness().request(
        path,
        jsonPost({}, `${SESSION_COOKIE_NAME}=${session.cookieValue}`),
        env,
      );
      expect(response.status).toBe(503);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body['error']).toBe('passkey_unavailable');
      expect(body['reason']).toBe('verifier_not_wired');
      // A challenge that cannot be verified must not stay reusable.
      expect(cookieHeader(response, WEBAUTHN_COOKIE_NAME)).toContain('Max-Age=0');
    }
  });
});
