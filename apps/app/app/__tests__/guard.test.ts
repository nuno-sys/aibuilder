import { describe, expect, it } from 'vitest';
import { cp } from '@aibuilder/db';

import { loadViewer, requireSiteAccess, requireViewer } from '../lib/guard.server';
import { fakeEnv, recordingD1, request, sessionCredential } from './doubles';

/**
 * THE INVARIANT: an unauthenticated request never reaches data.
 *
 * This is the test the whole `guard.server.ts` arrangement exists to make provable. "The loader
 * calls `requireViewer` first" is a claim about code that a future refactor can quietly break;
 * "the database was asked zero questions" is a fact about a run.
 *
 * The mechanism is `recordingD1`, which logs every statement it is asked to prepare and throws on
 * any statement a test did not stub. So a guard that leaked a tenant read before authenticating
 * would fail in one of two ways — an unexpected statement, or a non-empty call log — and both name
 * the statement in the failure message.
 *
 * WHAT THIS DOES NOT PROVE, stated so nobody reads more into it: it does not prove the SQL is
 * correct. That is what the `EXPLAIN QUERY PLAN` gate and the statement-text assertions in
 * `org-isolation.test.ts` are for. What it proves is the ORDER of operations, which is the part a
 * refactor gets wrong.
 */

const NOW = Date.parse('2026-09-06T09:00:00.000Z');
const SITE_ID = 'ste_01J8Z9QWERTYUIOPASDFGHJKLZ';
const USER_ID = 'usr_01J8Z9QWERTYUIOPASDFGHJKLZ';

describe('an unauthenticated request never reaches data', () => {
  it('asks the database nothing at all when there is no cookie', async () => {
    // Every handler throws. If ANY statement is prepared, the test fails with its text.
    const d1 = recordingD1({});
    const env = fakeEnv({ CP: d1.db });

    const viewer = await loadViewer(env, request('/dashboard'), NOW);

    expect(viewer).toBeNull();
    expect(d1.calls).toHaveLength(0);
  });

  it('reads the session and stops there when the cookie is forged', async () => {
    const { cookie } = await sessionCredential();
    const d1 = recordingD1({
      // A cookie that is well-formed but names no live session: `SQL_GET_SESSION` carries
      // `revoked_at IS NULL AND expires_at > ?2`, so an expired or revoked session is the same
      // `null` as an unknown one.
      [cp.users.SQL_GET_SESSION]: () => null,
    });
    const env = fakeEnv({ CP: d1.db });

    const viewer = await loadViewer(env, request('/dashboard', cookie), NOW);

    expect(viewer).toBeNull();
    // Exactly one statement: the session lookup. No user read, and above all no site read.
    expect(d1.calls).toHaveLength(1);
    expect(d1.calls[0]?.sql).toBe(cp.users.SQL_GET_SESSION.trim());
  });

  it('does not reach the site read when the request is unauthenticated', async () => {
    const d1 = recordingD1({});
    const env = fakeEnv({ CP: d1.db });

    // `requireSiteAccess` throws the sign-in redirect. The assertion that matters is the one after
    // it: the throw happened BEFORE any statement was prepared.
    await expect(
      requireSiteAccess(env, request(`/sites/${SITE_ID}/editor`), SITE_ID, {
        minRole: 'viewer',
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(Response);
    expect(d1.calls).toHaveLength(0);
  });

  it('redirects to the sign-in page, carrying where the visitor was going', async () => {
    const d1 = recordingD1({});
    const env = fakeEnv({ CP: d1.db });

    const thrown = await requireViewer(env, request('/sites/x/editor'), NOW).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(Response);
    const response = thrown as Response;
    expect(response.status).toBe(302);
    // The `next` is a PATH and never a full URL — an absolute value here is an open redirect on the
    // one page whose whole job is to be trusted.
    expect(response.headers.get('location')).toBe(
      `/inloggen?next=${encodeURIComponent('/sites/x/editor')}`,
    );
  });

  it('refuses a live session whose user row is gone, without reading a site', async () => {
    const { cookie, tokenHash } = await sessionCredential();
    const d1 = recordingD1({
      [cp.users.SQL_GET_SESSION]: () => ({
        token_hash: tokenHash,
        id: 'ses_01J8Z9QWERTYUIOPASDFGHJKLZ',
        user_id: USER_ID,
        active_org_id: null,
        ip_hash: null,
        user_agent: null,
        created_at: NOW - 1000,
        last_seen_at: NOW - 1000,
        expires_at: NOW + 1000,
        revoked_at: null,
      }),
      // A deleted account whose sessions have not been swept yet.
      [cp.users.SQL_GET_USER]: () => null,
    });
    const env = fakeEnv({ CP: d1.db });

    const viewer = await loadViewer(env, request('/dashboard', cookie), NOW);

    expect(viewer).toBeNull();
    expect(d1.calls.map((call) => call.sql)).toEqual([
      cp.users.SQL_GET_SESSION.trim(),
      cp.users.SQL_GET_USER.trim(),
    ]);
  });

  it('does not slide a session that was seen within the hour', async () => {
    const { cookie, tokenHash } = await sessionCredential();
    const d1 = recordingD1({
      [cp.users.SQL_GET_SESSION]: () => ({
        token_hash: tokenHash,
        id: 'ses_01J8Z9QWERTYUIOPASDFGHJKLZ',
        user_id: USER_ID,
        active_org_id: null,
        ip_hash: null,
        user_agent: null,
        created_at: NOW - 1000,
        // Seen a minute ago. `SESSION_SLIDE_AFTER_MS` is an hour, so no write is due.
        last_seen_at: NOW - 60_000,
        expires_at: NOW + 1000,
        revoked_at: null,
      }),
      [cp.users.SQL_GET_USER]: () => ({
        id: USER_ID,
        email: 'anna@example.test',
        email_normalized: 'anna@example.test',
        email_verified_at: NOW - 5000,
        password_hash: null,
        full_name: 'Anna',
        locale: 'nl',
        country: 'NL',
        timezone: 'Europe/Amsterdam',
        marketing_opt_in: 0,
        status: 'active',
        last_login_at: NOW - 5000,
        created_at: NOW - 100_000,
        updated_at: NOW - 100_000,
        deleted_at: null,
      }),
    });
    const env = fakeEnv({ CP: d1.db });

    const viewer = await loadViewer(env, request('/dashboard', cookie), NOW);

    expect(viewer?.userId).toBe(USER_ID);
    // Authentication must not cost a D1 WRITE per request: `sessions` is the hottest table in the
    // product and D1's primary is single-threaded. `SQL_TOUCH_SESSION` is absent from the stub map,
    // so preparing it would have thrown.
    expect(d1.calls.map((call) => call.sql)).not.toContain(cp.users.SQL_TOUCH_SESSION.trim());
  });
});
