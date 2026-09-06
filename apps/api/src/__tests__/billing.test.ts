import { cp, shard } from '@aibuilder/db';
import { describe, expect, it } from 'vitest';

import type { Env } from '../env';
import { DRAFT_COOKIE_NAME, mintDraftCookie } from '../middleware/draft-cookie';
import {
  SQL_ATTACH_CHECKOUT_SESSION,
  SQL_BUMP_CHECKOUT_ATTEMPTS,
  billingRoutes,
} from '../routes/billing';
import { TEST_APP_ORIGIN, anonSessionRow, draftRow, testEnv } from './doubles';
import { Changes, allowingRateLimit, recordingD1, recordingFetcher } from './harness';
import type { RecordingD1, RecordingFetcher } from './harness';

/**
 * `GET /v1/billing/return` and `POST /v1/billing/checkout/:jobId` — the two races the inverted
 * funnel creates.
 *
 * THE RACE. The customer's browser can land on `success_url` before Stripe's webhook arrives. The
 * return route therefore has to answer honestly without becoming a second writer of billing state:
 * it may unlock the BROWSER SESSION, and it may not dispatch, release a job, create a membership or
 * touch `payment_state`. Every assertion below that says "did not" is protecting that boundary,
 * because two writers of the same state across two transports is exactly how a double dispatch —
 * and a double generation bill — happens.
 *
 * THE AUTHORISATION IS A PAIR. The draft cookie proves ownership of the draft; the draft owns one
 * job; the job names one Checkout Session. A `session_id` travels in a URL and proves nothing on
 * its own, which is what the last two cases assert.
 */

const JOB_ID = 'job_01J0000000000000000000000A' as const;
const ORG_ID = 'org_01J0000000000000000000000B' as const;
const SITE_ID = 'ste_01J0000000000000000000000C' as const;
const USER_ID = 'usr_01J0000000000000000000000D' as const;
const SESSION_ID = 'cs_test_0123456789abcdef';

/** A live Checkout Session, as `apps/billing` answers a create with. */
const CREATED = {
  checkoutSessionId: 'cs_test_fedcba9876543210',
  checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_fedcba9876543210',
  expiresAt: Date.now() + 30 * 60 * 1000,
};

/** The submitted draft that owns the job. */
function submittedDraft(): ReturnType<typeof draftRow> {
  return draftRow({
    status: 'submitted',
    site_id: SITE_ID,
    org_id: ORG_ID,
    generation_job_id: JOB_ID,
  });
}

/** A job row with the payment columns `0007_billing_gate.sql` adds. */
function jobRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: JOB_ID,
    org_id: ORG_ID,
    site_id: SITE_ID,
    draft_id: submittedDraft().id,
    kind: 'initial_site',
    status: 'queued',
    created_by: USER_ID,
    payment_state: 'awaiting_payment',
    checkout_session_id: SESSION_ID,
    payment_deadline_at: Date.now() + 10 * 60 * 1000,
    checkout_attempts: 1,
    ...overrides,
  };
}

/** Everything one case needs. */
interface Harness {
  readonly env: Env;
  readonly cookie: string;
  readonly cpDb: RecordingD1;
  readonly shardDb: RecordingD1;
  readonly billing: RecordingFetcher;
}

/** Builds an env whose two databases answer exactly the statements these routes ship. */
async function harness(options: {
  readonly job?: Record<string, unknown> | null;
  readonly draft?: ReturnType<typeof draftRow> | null;
  readonly billingResponse?: (url: string, body: unknown) => Response;
  readonly bumpChanges?: number;
}): Promise<Harness> {
  const base = testEnv();
  const minted = await mintDraftCookie(base);

  const cpDb = recordingD1({
    [cp.drafts.SQL_GET_ANON_SESSION]: () => anonSessionRow(),
    [cp.drafts.SQL_GET_LATEST_DRAFT_FOR_SESSION]: () => options.draft ?? submittedDraft(),
    [cp.users.SQL_INSERT_SESSION]: () => new Changes(1),
  });

  const shardDb = recordingD1({
    [shard.generationJobs.SQL_GET_GENERATION_JOB]: () =>
      options.job === undefined ? jobRow() : options.job,
    [SQL_BUMP_CHECKOUT_ATTEMPTS]: () => new Changes(options.bumpChanges ?? 1),
    [SQL_ATTACH_CHECKOUT_SESSION]: () => new Changes(1),
  });

  const billing = recordingFetcher(
    options.billingResponse ??
      ((url) =>
        url.includes(SESSION_ID)
          ? Response.json({ status: 'complete', paymentStatus: 'no_payment_required', url: null })
          : Response.json(CREATED)),
  );

  const env = testEnv({
    CP: cpDb.db,
    SHARD_000: shardDb.db,
    BILLING: billing.fetcher,
    RL_CHECKOUT: allowingRateLimit(),
    API_ORIGIN: 'https://api.example-control-plane.test',
    DASHBOARD_ORIGIN: 'https://app.example-control-plane.test',
  });

  return { env, cookie: `${DRAFT_COOKIE_NAME}=${minted.value}`, cpDb, shardDb, billing };
}

/** `GET /v1/billing/return`, with or without the draft cookie. */
async function callReturn(harnessed: Harness, query: string, withCookie = true): Promise<Response> {
  return billingRoutes.request(
    `/return?${query}`,
    { headers: withCookie ? { Cookie: harnessed.cookie } : {} },
    harnessed.env,
  );
}

describe('GET /v1/billing/return', () => {
  it('mints a session when Stripe says complete and the webhook has not landed (T-B18)', async () => {
    const test = await harness({});

    const response = await callReturn(test, `session_id=${SESSION_ID}`);

    expect(response.status).toBe(303);
    const location = response.headers.get('location') ?? '';
    expect(location).toContain(`job=${JOB_ID}`);
    expect(location).toContain('payment=confirming');

    // The browser session is unlocked…
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('__Host-aib_session=');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    // …and, being a `__Host-` cookie, carries no Domain attribute, which is what makes it host-only.
    expect(cookie).not.toContain('Domain=');
    expect(test.cpDb.ran('INSERT INTO sessions')).toBe(true);

    // …and nothing else is. No payment state, no membership, no dispatch: all three belong to the
    // webhook, and to exactly one code path.
    expect(test.shardDb.ran('payment_state =')).toBe(false);
    expect(test.cpDb.ran('INSERT INTO memberships')).toBe(false);
    expect(test.billing.count('/v1/checkout-sessions')).toBe(1);
  });

  it('sends a customer who came back without paying to the cancelled state (T-B19)', async () => {
    const test = await harness({
      billingResponse: () =>
        Response.json({ status: 'open', paymentStatus: 'unpaid', url: 'https://checkout.test/x' }),
    });

    const response = await callReturn(test, `session_id=${SESSION_ID}`);

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('checkout=cancelled');
    // No session is minted for someone who has not paid.
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(test.cpDb.ran('INSERT INTO sessions')).toBe(false);
  });

  it('reports an expired session as expired, without asking Stripe twice', async () => {
    const test = await harness({ job: jobRow({ payment_state: 'abandoned' }) });

    const response = await callReturn(test, `session_id=${SESSION_ID}`);

    expect(response.headers.get('location')).toContain('checkout=expired');
    // `abandoned` is already known locally; Stripe is not consulted for a state we recorded.
    expect(test.billing.calls).toHaveLength(0);
  });

  it('mints a session without a Stripe round trip once the webhook has landed', async () => {
    const test = await harness({ job: jobRow({ payment_state: 'paid' }) });

    const response = await callReturn(test, `session_id=${SESSION_ID}`);

    expect(response.headers.get('location')).toContain(`job=${JOB_ID}`);
    expect(response.headers.get('location')).not.toContain('payment=confirming');
    expect(response.headers.get('set-cookie')).toContain('__Host-aib_session=');
    expect(test.billing.calls).toHaveLength(0);
  });

  it('refuses a session_id without the draft cookie, and a mismatched one with it (T-B20)', async () => {
    const test = await harness({});

    const noCookie = await callReturn(test, `session_id=${SESSION_ID}`, false);
    expect(noCookie.status).toBe(303);
    expect(noCookie.headers.get('location')).toBe(`${TEST_APP_ORIGIN}/start/`);
    expect(noCookie.headers.get('set-cookie')).toBeNull();
    expect(test.cpDb.ran('INSERT INTO sessions')).toBe(false);

    // The draft's job names a DIFFERENT session, so possession of this URL proves nothing.
    const mismatch = await harness({
      job: jobRow({ checkout_session_id: 'cs_test_someoneelse01' }),
    });
    const wrongJob = await callReturn(mismatch, `session_id=${SESSION_ID}`);
    expect(wrongJob.headers.get('location')).toBe(`${TEST_APP_ORIGIN}/start/`);
    expect(mismatch.cpDb.ran('INSERT INTO sessions')).toBe(false);

    // A malformed id never reaches Stripe at all.
    const malformed = await callReturn(test, 'session_id=../../etc/passwd');
    expect(malformed.headers.get('location')).toBe(`${TEST_APP_ORIGIN}/start/`);
  });
});

describe('POST /v1/billing/checkout/:jobId', () => {
  /** Posts the re-mint request with everything the guards require. */
  async function remint(test: Harness, jobId: string = JOB_ID): Promise<Response> {
    return billingRoutes.request(
      `/checkout/${jobId}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Origin: TEST_APP_ORIGIN,
          Cookie: test.cookie,
        },
      },
      test.env,
    );
  }

  it('mints a fresh session for an abandoned checkout (T-B21)', async () => {
    const test = await harness({
      job: jobRow({ payment_state: 'abandoned', checkout_session_id: null }),
    });

    const response = await remint(test);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      paymentState: string;
      checkoutUrl: string;
      checkoutExpiresAt: number;
    };
    expect(body.paymentState).toBe('awaiting_payment');
    expect(body.checkoutUrl).toBe(CREATED.checkoutUrl);
    expect(body.checkoutExpiresAt).toBe(CREATED.expiresAt);

    // The attempt is counted BEFORE Stripe is called, and the new session is attached to the same
    // job — one draft has exactly one job for its whole life, however many sessions it has.
    expect(test.shardDb.ran('checkout_attempts = checkout_attempts + 1')).toBe(true);
    expect(test.shardDb.find('SET checkout_session_id')?.params[1]).toBe(CREATED.checkoutSessionId);
  });

  it('refuses the sixth attempt (T-B21)', async () => {
    // The cap is enforced by the statement's own `WHERE checkout_attempts < ?3`, so a job at the
    // cap changes no rows — which is what the route reads.
    // `SQL_ABANDON_CHECKOUT` clears the session id, so an abandoned job has no live session to
    // re-use and goes straight to the attempt counter.
    const test = await harness({
      job: jobRow({
        payment_state: 'abandoned',
        checkout_session_id: null,
        checkout_attempts: 5,
      }),
      bumpChanges: 0,
    });

    const response = await remint(test);

    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('checkout_attempts_exhausted');
    // Nothing was created: a card tester gets no free Checkout Session generator.
    expect(test.billing.calls).toHaveLength(0);
  });

  it('answers a paid job with its state rather than a new session', async () => {
    const test = await harness({ job: jobRow({ payment_state: 'paid' }) });

    const response = await remint(test);

    expect(response.status).toBe(200);
    expect((await response.json()) as { paymentState: string }).toMatchObject({
      paymentState: 'paid',
    });
    expect(test.billing.calls).toHaveLength(0);
    expect(test.shardDb.ran('checkout_attempts = checkout_attempts + 1')).toBe(false);
  });

  it('refuses a job id the draft does not own', async () => {
    const test = await harness({});

    const response = await remint(test, 'job_01J000000000000000000000ZZ');

    expect(response.status).toBe(404);
    expect(test.billing.calls).toHaveLength(0);
  });
});
