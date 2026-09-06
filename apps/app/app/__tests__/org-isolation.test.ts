import { describe, expect, it } from 'vitest';
import { cp } from '@aibuilder/db';

import { loadSiteAccess, requireSiteAccess } from '../lib/guard.server';
import { fakeEnv, recordingD1, request, sessionCredential } from './doubles';

/**
 * THE TENANCY ISOLATION INVARIANT: a member of organisation A cannot load a site of organisation B.
 *
 * Architecture §5.2 states it as "an organisation with zero memberships is unreachable by every
 * authenticated path". This file tests the read half of that directly, in three layers, because no
 * one of them alone is enough:
 *
 *   1. **The statement text.** `SQL_GET_SITE_FOR_USER` must carry the join to `memberships` with
 *      the user id bound. This is a string assertion and it is the only thing that catches somebody
 *      "simplifying" the statement to `SELECT * FROM live_sites WHERE id = ?1` — which would pass
 *      every behavioural test written against a double.
 *   2. **The binding.** The guard must pass the SIGNED-IN user's id, not one from the URL. The
 *      double records the parameters, so this is checked against what was actually bound.
 *   3. **The behaviour.** When the join yields nothing, the guard answers 404 — never 403, never a
 *      different message — so the dashboard cannot be used as an existence oracle for other
 *      tenants' site ids.
 *
 * WHAT A DOUBLE CANNOT DO is prove SQLite's join semantics; that is the `EXPLAIN QUERY PLAN` gate's
 * territory and the migration suite's. Layer 1 is what closes the gap that matters: it is not
 * possible to satisfy this file with a statement that has no membership predicate.
 */

const NOW = Date.parse('2026-09-06T09:00:00.000Z');
const SITE_OF_ORG_B = 'ste_01J8Z9QWERTYUIOPASDFGHJKLZ';
const USER_IN_ORG_A = 'usr_01AAAAAAAAAAAAAAAAAAAAAAAA';

/** A live session row for the user of organisation A. */
function sessionRow(tokenHash: Uint8Array) {
  return {
    token_hash: tokenHash,
    id: 'ses_01J8Z9QWERTYUIOPASDFGHJKLZ',
    user_id: USER_IN_ORG_A,
    active_org_id: 'org_01AAAAAAAAAAAAAAAAAAAAAAAA',
    ip_hash: null,
    user_agent: null,
    created_at: NOW - 1000,
    last_seen_at: NOW - 60_000,
    expires_at: NOW + 1000,
    revoked_at: null,
  };
}

/** The user row of organisation A's member. */
function userRow() {
  return {
    id: USER_IN_ORG_A,
    email: 'a@example.test',
    email_normalized: 'a@example.test',
    email_verified_at: NOW,
    password_hash: null,
    full_name: 'A',
    locale: 'nl',
    country: 'NL',
    timezone: 'Europe/Amsterdam',
    marketing_opt_in: 0,
    status: 'active',
    last_login_at: NOW,
    created_at: NOW - 1,
    updated_at: NOW - 1,
    deleted_at: null,
  };
}

describe('the isolation statement itself', () => {
  it('joins memberships and binds the user id', () => {
    const sql = cp.dashboard.SQL_GET_SITE_FOR_USER;
    // The join, the user predicate, and the fact that the user id is a BOUND parameter rather than
    // interpolated. Removing any of the three is the bug this assertion exists for.
    expect(sql).toContain('JOIN memberships');
    expect(sql).toMatch(/m\.user_id\s*=\s*\?2/u);
    expect(sql).toMatch(/s\.id\s*=\s*\?1/u);
    // Read through the soft-delete view, so a deleted site is not reachable by id.
    expect(sql).toContain('live_sites');
  });

  it('has no unguarded single-site read anywhere in the dashboard module', () => {
    // Every `SQL_` constant that reads one site by id must also mention `memberships`. A future
    // `getSite(siteId)` helper added "just for the admin page" is exactly how isolation is lost.
    for (const [name, value] of Object.entries(cp.dashboard)) {
      if (!name.startsWith('SQL_') || typeof value !== 'string') {
        continue;
      }
      if (/FROM live_sites/u.test(value)) {
        expect(value, `${name} reads sites without a membership join`).toContain('memberships');
      }
    }
  });
});

describe('a member of organisation A cannot load a site of organisation B', () => {
  it('gets null from the guarded read', async () => {
    const { tokenHash } = await sessionCredential();
    const d1 = recordingD1({
      // The statement's real behaviour, modelled: the join yields no row, because this user has no
      // membership in the organisation that owns this site.
      [cp.dashboard.SQL_GET_SITE_FOR_USER]: () => null,
    });
    const env = fakeEnv({ CP: d1.db });

    const access = await loadSiteAccess(
      env,
      {
        session: sessionRow(tokenHash) as never,
        user: userRow() as never,
        userId: USER_IN_ORG_A as never,
        activeOrgId: null,
      },
      SITE_OF_ORG_B as never,
    );

    expect(access).toBeNull();
    // And the id it asked about was bound with the SIGNED-IN user, not with anything from the URL.
    expect(d1.calls[0]?.params).toEqual([SITE_OF_ORG_B, USER_IN_ORG_A]);
  });

  it('answers 404 and not 403, so the site id is not confirmed to exist', async () => {
    const { cookie, tokenHash } = await sessionCredential();
    const d1 = recordingD1({
      [cp.users.SQL_GET_SESSION]: () => sessionRow(tokenHash),
      [cp.users.SQL_GET_USER]: () => userRow(),
      [cp.dashboard.SQL_GET_SITE_FOR_USER]: () => null,
    });
    const env = fakeEnv({ CP: d1.db });

    const thrown = await requireSiteAccess(
      env,
      request(`/sites/${SITE_OF_ORG_B}/editor`, cookie),
      SITE_OF_ORG_B,
      { minRole: 'viewer', now: NOW },
    ).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(Response);
    // 403 would confirm the site exists. Not found and not yours are the same answer.
    expect((thrown as Response).status).toBe(404);
  });

  it('refuses a role below the route minimum, with the same 404', async () => {
    const { cookie, tokenHash } = await sessionCredential();
    const d1 = recordingD1({
      [cp.users.SQL_GET_SESSION]: () => sessionRow(tokenHash),
      [cp.users.SQL_GET_USER]: () => userRow(),
      // The user IS a member — as a viewer. A write route asks for `editor`.
      [cp.dashboard.SQL_GET_SITE_FOR_USER]: () => ({
        id: SITE_OF_ORG_B,
        org_id: 'org_01BBBBBBBBBBBBBBBBBBBBBBBB',
        org_name: 'B',
        shard_id: 0,
        slug: 'b',
        status: 'published',
        canonical_host: 'b.example-tenants.test',
        index_state: 'indexable',
        default_locale: 'nl',
        published_version_id: 'ver_01J8Z9QWERTYUIOPASDFGHJKLZ',
        published_at: NOW,
        created_at: NOW,
        updated_at: NOW,
        role: 'viewer',
        plan: 'pro',
        entitlement: 'active',
        entitlement_until: NOW + 100_000,
        org_status: 'active',
        provisional: 0,
      }),
    });
    const env = fakeEnv({ CP: d1.db, SHARD_000: d1.db });

    const thrown = await requireSiteAccess(
      env,
      request(`/sites/${SITE_OF_ORG_B}/editor`, cookie),
      SITE_OF_ORG_B,
      { minRole: 'editor', now: NOW },
    ).catch((error: unknown) => error);

    expect((thrown as Response).status).toBe(404);
  });

  it('rejects a malformed site id before it reaches a bound parameter', async () => {
    const { cookie, tokenHash } = await sessionCredential();
    const d1 = recordingD1({
      [cp.users.SQL_GET_SESSION]: () => sessionRow(tokenHash),
      [cp.users.SQL_GET_USER]: () => userRow(),
    });
    const env = fakeEnv({ CP: d1.db });

    const thrown = await requireSiteAccess(env, request('/sites/../editor', cookie), '../', {
      minRole: 'viewer',
      now: NOW,
    }).catch((error: unknown) => error);

    expect((thrown as Response).status).toBe(404);
    // The site statement was never prepared: a malformed id is a 404, not a query.
    expect(d1.calls.map((call) => call.sql)).not.toContain(
      cp.dashboard.SQL_GET_SITE_FOR_USER.trim(),
    );
  });
});
