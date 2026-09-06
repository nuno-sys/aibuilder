import { cp } from '@aibuilder/db';
import type { EntitlementRow, MembershipRow, SessionRow } from '@aibuilder/db';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env } from '../env';
import { SESSION_COOKIE_NAME, gateFailure, requireEntitlement } from '../lib/entitlement';
import {
  SQL_INSERT_BLOCKED_PAYWALL_JOB,
  SQL_INSERT_REGENERATION_JOB,
  siteRoutes,
} from '../routes/sites';
import { TEST_APP_ORIGIN, testEnv } from './doubles';
import { Changes, budgetDouble, recordingD1 } from './harness';
import type { RecordingD1 } from './harness';

/**
 * The paywall: `requireEntitlement()`, and the one route that spends money behind it.
 *
 * THE TWO CASES THAT MATTER MOST ARE BOTH ABOUT REFUSING SOMETHING THAT LOOKS FINE.
 * A provisional organisation carries `entitlement = 'trialing'` between the webhook's entitlement
 * write and its membership write, and it must still be unreachable — the tenancy isolation
 * invariant is the membership, not the entitlement. And an entitlement whose deadline has passed is
 * lapsed even though the column still says `trialing`, because webhooks can be lost and a deadline
 * nobody checks is not a deadline.
 *
 * The regenerate case asserts the refusal is RECORDED, not merely returned. A 402 that leaves no
 * row cannot answer "who hit the paywall this week", and `idx_jobs_paywalled` exists for that
 * question.
 */

/** Ids that satisfy the schema's `GLOB` shape checks. */
const ORG_ID = 'org_01J0000000000000000000000A' as const;
const SITE_ID = 'ste_01J0000000000000000000000B' as const;
const USER_ID = 'usr_01J0000000000000000000000C' as const;

/** A live session row, as `SQL_GET_SESSION` would return it. */
function sessionRow(): SessionRow {
  const now = Date.now();
  return {
    token_hash: new ArrayBuffer(32),
    id: 'ses_01J0000000000000000000000D',
    user_id: USER_ID,
    active_org_id: ORG_ID,
    ip_hash: null,
    user_agent: null,
    created_at: now,
    last_seen_at: now,
    expires_at: now + 1_000_000,
    revoked_at: null,
  };
}

/** An owner membership. */
function membershipRow(role: MembershipRow['role'] = 'owner'): MembershipRow {
  return {
    org_id: ORG_ID,
    user_id: USER_ID,
    role,
    invited_by: null,
    accepted_at: Date.now(),
    created_at: Date.now(),
  };
}

/** An entitlement row, live by default. */
function entitlementRow(overrides: Partial<EntitlementRow> = {}): EntitlementRow {
  return {
    entitlement: 'trialing',
    entitlement_until: Date.now() + 86_400_000,
    plan: 'pro',
    status: 'active',
    shard_id: 0,
    ...overrides,
  };
}

/** The site the regenerate route reads before it asks the gate anything. */
function siteRow(): Record<string, unknown> {
  return {
    id: SITE_ID,
    org_id: ORG_ID,
    shard_id: 0,
    slug: 'kapsalon-anna',
    status: 'published',
    default_locale: 'nl',
    published_version_id: null,
    canonical_host: 'kapsalon-anna.sites.test',
    index_state: 'eligible',
    published_at: null,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
  };
}

describe('requireEntitlement', () => {
  it('refuses a provisional organisation on the membership, not on the entitlement (T-E4)', async () => {
    const env = testEnv({
      CP: recordingD1({
        // Zero memberships: the organisation exists, is entitled, and is unreachable.
        [cp.users.SQL_GET_MEMBERSHIP]: () => null,
      }).db,
    });

    const result = await requireEntitlement(env, sessionRow(), ORG_ID, { minRole: 'editor' });

    expect(result).toBe('no_membership');
    // 404 and never 403: a 403 confirms the organisation exists, which turns an id guess into an
    // existence oracle for other tenants.
    expect(gateFailure(env, 'no_membership').status).toBe(404);
  });

  it('treats a passed deadline as lapsed even while the column reads trialing (T-E5)', async () => {
    const env = testEnv({
      CP: recordingD1({
        [cp.users.SQL_GET_MEMBERSHIP]: () => membershipRow(),
        [cp.orgs.SQL_GET_ENTITLEMENT]: () =>
          entitlementRow({ entitlement: 'trialing', entitlement_until: Date.now() - 1 }),
      }).db,
      DASHBOARD_ORIGIN: 'https://app.example-control-plane.test',
    });

    const result = await requireEntitlement(env, sessionRow(), ORG_ID, { minRole: 'editor' });

    expect(result).toBe('entitlement_lapsed');

    const response = gateFailure(env, 'entitlement_lapsed');
    expect(response.status).toBe(402);
    const body = (await response.json()) as { error: string; portalUrl: string };
    expect(body.error).toBe('payment_required');
    // "Pay to continue" is only useful with somewhere to pay.
    expect(body.portalUrl).toContain('/facturatie');
  });

  it('checks the role before the paywall and the suspension before both', async () => {
    const viewerEnv = testEnv({
      CP: recordingD1({
        [cp.users.SQL_GET_MEMBERSHIP]: () => membershipRow('viewer'),
      }).db,
    });
    expect(await requireEntitlement(viewerEnv, sessionRow(), ORG_ID, { minRole: 'editor' })).toBe(
      'insufficient_role',
    );

    const suspendedEnv = testEnv({
      CP: recordingD1({
        [cp.users.SQL_GET_MEMBERSHIP]: () => membershipRow(),
        // A suspended tenant is refused without ever learning whether their subscription is live.
        [cp.orgs.SQL_GET_ENTITLEMENT]: () => entitlementRow({ status: 'suspended' }),
      }).db,
    });
    expect(
      await requireEntitlement(suspendedEnv, sessionRow(), ORG_ID, { minRole: 'editor' }),
    ).toBe('org_suspended');
  });

  it('passes a live trial and reports the shard the tenant lives on', async () => {
    const env = testEnv({
      CP: recordingD1({
        [cp.users.SQL_GET_MEMBERSHIP]: () => membershipRow(),
        [cp.orgs.SQL_GET_ENTITLEMENT]: () => entitlementRow({ shard_id: 0 }),
      }).db,
    });

    const result = await requireEntitlement(env, sessionRow(), ORG_ID, { minRole: 'editor' });

    expect(typeof result).not.toBe('string');
    if (typeof result !== 'string') {
      expect(result.entitlement).toBe('trialing');
      expect(result.role).toBe('owner');
      expect(result.shardId).toBe(0);
    }
  });

  it('refuses without a session before it reads anything', async () => {
    // No CP binding at all: `testEnv` throws on any binding a case did not stub, so reaching D1
    // here would fail the test rather than pass it.
    const env = testEnv();
    expect(await requireEntitlement(env, null, ORG_ID, { minRole: 'editor' })).toBe('no_session');
  });
});

describe('POST /v1/sites/:siteId/regenerate', () => {
  /** A session cookie whose 32 random bytes hash to whatever the stub answers. */
  function sessionCookie(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    let binary = '';
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    const value = btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
    return `${SESSION_COOKIE_NAME}=${value}`;
  }

  /** Env + shard recorder for one regenerate case. */
  function harness(entitlement: EntitlementRow): { env: Env; shardDb: RecordingD1 } {
    // Keyed on the exact statements the route ships: a reworded insert makes the double throw
    // `unexpected statement` instead of quietly answering a query the test never meant to allow.
    const shardDb = recordingD1({
      [SQL_INSERT_BLOCKED_PAYWALL_JOB]: () => new Changes(1),
      [SQL_INSERT_REGENERATION_JOB]: () => new Changes(1),
    });
    const env = testEnv({
      CP: recordingD1({
        [cp.users.SQL_GET_SESSION]: () => sessionRow(),
        [cp.sites.SQL_GET_LIVE_SITE]: () => siteRow(),
        [cp.users.SQL_GET_MEMBERSHIP]: () => membershipRow(),
        [cp.orgs.SQL_GET_ENTITLEMENT]: () => entitlement,
      }).db,
      SHARD_000: shardDb.db,
      BUDGET: budgetDouble().namespace,
      DASHBOARD_ORIGIN: 'https://app.example-control-plane.test',
    });
    return { env, shardDb };
  }

  it('answers 402 and records a blocked_paywall job on a lapsed entitlement (T-E6)', async () => {
    const { env, shardDb } = harness(
      entitlementRow({ entitlement: 'canceled', entitlement_until: Date.now() - 1 }),
    );
    const ctx = createExecutionContext();

    const response = await siteRoutes.request(
      `/${SITE_ID}/regenerate`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Origin: TEST_APP_ORIGIN,
          Cookie: sessionCookie(),
        },
      },
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(402);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('payment_required');

    const blocked = shardDb.find("'blocked_paywall'");
    expect(blocked).toBeDefined();
    // `CHECK (status NOT IN (…,'blocked_paywall') OR finished_at IS NOT NULL)`: the refusal is a
    // terminal row, so it carries an end time.
    expect(typeof blocked?.params[7]).toBe('number');
    // And it is not runnable: no sentinel, so the drain never sees it.
    expect(blocked?.sql).toContain('NULL, ?5, 0');
  });

  it('accepts a live entitlement and queues the run without dispatching', async () => {
    const { env, shardDb } = harness(entitlementRow());
    const ctx = createExecutionContext();

    const response = await siteRoutes.request(
      `/${SITE_ID}/regenerate`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Origin: TEST_APP_ORIGIN,
          Cookie: sessionCookie(),
        },
      },
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(202);
    const body = (await response.json()) as { jobId: string; eventsUrl: string };
    expect(body.jobId.startsWith('job_')).toBe(true);
    expect(body.eventsUrl).toBe(`/v1/jobs/${body.jobId}/events`);

    const queued = shardDb.find("'regenerate_site', 1, 'queued'");
    expect(queued).toBeDefined();
    // The queue sentinel IS the dispatch for a regeneration: the generator's `/v1/generations`
    // takes a draft id, and a regeneration has no draft.
    expect(typeof queued?.params[4]).toBe('number');
  });

  it('refuses a site that does not exist without saying whether it might', async () => {
    const { env } = harness(entitlementRow());
    const response = await siteRoutes.request(
      '/not-an-id/regenerate',
      { method: 'POST', headers: { Origin: TEST_APP_ORIGIN } },
      env,
    );
    expect(response.status).toBe(404);
  });
});
