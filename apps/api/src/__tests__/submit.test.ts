import { cp, shard } from '@aibuilder/db';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../env';
import app from '../index';
import { DRAFT_COOKIE_NAME, mintDraftCookie } from '../middleware/draft-cookie';
import {
  SQL_ATTACH_CHECKOUT_SESSION,
  SQL_INSERT_GENERATION_JOB_AWAITING_PAYMENT,
} from '../routes/billing';
import { TEST_APP_ORIGIN, anonSessionRow, draftRow, fakeD1, testEnv } from './doubles';
import {
  Changes,
  allowingRateLimit,
  budgetDouble,
  quotaDouble,
  recordingD1,
  recordingFetcher,
  turnstileFetch,
} from './harness';
import type { RecordingD1, RecordingDurableObject, RecordingFetcher } from './harness';

/**
 * `POST /v1/onboarding/submit`, at the two boundaries that matter: the 422, and the inverted funnel.
 *
 * THE 422 SHAPE MATTERS MORE THAN THE STATUS. The modal renders one Dutch message per field and
 * anchors its error summary at the field that failed, so `fields` is keyed by DOTTED PATH and
 * carries issue CODES — never messages, which could echo what the user typed back into a response
 * body.
 *
 * THE FUNNEL TESTS EXIST BECAUSE DECISIONS §D2 MOVED THE MONEY. Submit no longer dispatches
 * anything; it writes a job that the queue drain cannot see and hands back a Checkout URL. Three of
 * the assertions below would each, alone, catch a regression that costs real money: the job is
 * written with `queue_ready_at = NULL`, the generator is never asked to run anything, and the
 * budget reservation does not survive the response.
 */

/** The 422 body from architecture §S4. */
interface ValidationBody {
  readonly error: string;
  readonly message: string;
  readonly messageEn: string;
  readonly fields: Record<string, readonly string[]>;
}

/** The 202/200 body the modal reads. */
interface AcceptedBody {
  readonly jobId: string;
  readonly slug: string;
  readonly paymentState: string;
  readonly checkoutUrl: string | null;
  readonly checkoutExpiresAt: number | null;
}

/** An env whose control plane answers the session and draft reads, and nothing else. */
async function envWithSession(): Promise<{ env: Env; cookie: string }> {
  const base = testEnv();
  const minted = await mintDraftCookie(base);
  const env = testEnv({
    CP: fakeD1({
      [cp.drafts.SQL_GET_ANON_SESSION]: () => anonSessionRow(),
      [cp.drafts.SQL_GET_LATEST_DRAFT_FOR_SESSION]: () => draftRow(),
    }),
  });
  return { env, cookie: `${DRAFT_COOKIE_NAME}=${minted.value}` };
}

/** Posts a body to the submit route with everything the guards require. */
async function submit(body: unknown): Promise<Response> {
  const { env, cookie } = await envWithSession();
  return app.request(
    '/v1/onboarding/submit',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: TEST_APP_ORIGIN,
        Cookie: cookie,
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

/** A complete, valid intake, so that a single removed field is the only thing under test. */
function validIntake(): Record<string, unknown> {
  return {
    turnstileToken: 'test-token',
    businessName: 'Kapsalon Anna',
    slug: 'kapsalon-anna',
    industryKey: 'hairdresser',
    defaultLocale: 'nl',
    extraLocales: [],
    serviceArea: null,
    address: {
      line1: 'Hoofdstraat 1',
      line2: null,
      postalCode: '1011 AB',
      city: 'Amsterdam',
      country: 'NL',
      latitude: null,
      longitude: null,
      geoSource: 'none',
    },
    openingHours: null,
    phoneE164: '+31612345678',
    whatsappE164: null,
    gbpUrl: null,
    shortDescription: 'Kleine kapsalon in de Jordaan.',
    contactEmail: 'anna@example.test',
    marketingOptIn: false,
    mediaIds: [],
  };
}

describe('submit validation', () => {
  it('answers 422 with a field-keyed error map', async () => {
    const response = await submit({});

    expect(response.status).toBe(422);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('private, no-store');

    const body = (await response.json()) as ValidationBody;
    expect(body.error).toBe('validation_failed');
    expect(body.message.length).toBeGreaterThan(0);
    expect(body.messageEn.length).toBeGreaterThan(0);

    // Every missing required field is named, and the Turnstile token is one of them: it travels
    // alongside the intake and is validated in the same pass.
    for (const field of ['turnstileToken', 'businessName', 'slug', 'phoneE164', 'contactEmail']) {
      expect(Object.keys(body.fields)).toContain(field);
      expect(body.fields[field]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('keys nested failures by dotted path', async () => {
    const intake = validIntake();
    intake['address'] = { ...(intake['address'] as Record<string, unknown>), country: 'nederland' };

    const body = (await submit(intake).then((response) => response.json())) as ValidationBody;

    expect(Object.keys(body.fields)).toContain('address.country');
  });

  it('reports the cross-field rule under the form key, not under a field', async () => {
    const intake = validIntake();
    intake['address'] = null;
    intake['serviceArea'] = null;

    const response = await submit(intake);
    expect(response.status).toBe(422);

    const body = (await response.json()) as ValidationBody;
    // `LocalBusiness` needs one of the two, and the JSON-LD emitter branches on which; the rule is
    // a refine rather than two optional fields, so it has no field to attach to.
    expect(body.fields['_']).toContain('address_or_service_area_required');
  });

  it('never echoes the submitted value back', async () => {
    const intake = validIntake();
    intake['contactEmail'] = 'not-an-address-<script>';

    const raw = await submit(intake).then((response) => response.text());

    expect(raw).not.toContain('<script>');
    expect(raw).not.toContain('not-an-address');
  });

  it('refuses the request outright when the draft cookie is missing', async () => {
    const { env } = await envWithSession();
    const response = await app.request(
      '/v1/onboarding/submit',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: TEST_APP_ORIGIN },
        body: JSON.stringify(validIntake()),
      },
      env,
    );

    expect(response.status).toBe(401);
  });
});

// -------------------------------------------------------------------------------------------------
// The trial-first funnel
// -------------------------------------------------------------------------------------------------

/** The draft the funnel tests run against. `open`, complete, and owned by the session. */
const DRAFT = draftRow({ status: 'open' });

/** A live Checkout Session, as `apps/billing` answers with. */
const CHECKOUT = {
  checkoutSessionId: 'cs_test_0123456789abcdef',
  checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_0123456789abcdef',
  expiresAt: Date.now() + 30 * 60 * 1000,
};

/** Everything one funnel case needs, wired together. */
interface Harness {
  readonly env: Env;
  readonly cookie: string;
  readonly cpDb: RecordingD1;
  readonly shardDb: RecordingD1;
  readonly generator: RecordingFetcher;
  readonly billing: RecordingFetcher;
  readonly budget: RecordingDurableObject;
}

/**
 * Builds an env that answers the whole ladder.
 *
 * Every statement the route can reach is stubbed by its shipped SQL text; anything else throws, so
 * a code path the case did not intend to exercise fails loudly rather than silently.
 */
async function funnelHarness(
  overrides: {
    readonly priorTrial?: unknown;
    readonly billingResponse?: (url: string) => Response;
    readonly draft?: ReturnType<typeof draftRow>;
    readonly job?: Record<string, unknown> | null;
    readonly attachChanges?: number;
  } = {},
): Promise<Harness> {
  const draft = overrides.draft ?? DRAFT;
  const base = testEnv();
  const minted = await mintDraftCookie(base);

  const cpDb = recordingD1({
    [cp.drafts.SQL_GET_ANON_SESSION]: () => anonSessionRow(),
    [cp.drafts.SQL_GET_LATEST_DRAFT_FOR_SESSION]: () => draft,
    [cp.drafts.SQL_SET_DRAFT_POLICY_SCREEN]: () => new Changes(1),
    [cp.slugs.SQL_FILTER_TAKEN_SLUGS]: () => [],
    [cp.billing.SQL_FIND_TRIAL_BY_EMAIL]: () => overrides.priorTrial ?? null,
    [cp.users.SQL_GET_USER_BY_EMAIL]: () => null,
    [cp.orgs.SQL_INSERT_PROVISIONAL_ORG]: () => new Changes(1),
    [cp.users.SQL_INSERT_USER]: () => new Changes(1),
    [cp.sites.SQL_INSERT_SITE]: () => new Changes(1),
    [cp.drafts.SQL_MARK_DRAFT_SUBMITTED]: () => new Changes(1),
    [cp.quotas.SQL_INSERT_ABUSE_EVENT]: () => new Changes(1),
    [cp.sites.SQL_GET_LIVE_SITE]: () => ({
      id: 'ste_01J0000000000000000000000C',
      org_id: 'org_01J0000000000000000000000D',
      shard_id: 0,
      slug: 'kapsalon-anna',
      status: 'onboarding',
      default_locale: 'nl',
      published_version_id: null,
      canonical_host: 'kapsalon-anna.sites.test',
      index_state: 'noindex',
      published_at: null,
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
    }),
  });

  const shardDb = recordingD1({
    [SQL_INSERT_GENERATION_JOB_AWAITING_PAYMENT]: () => new Changes(1),
    [shard.media.SQL_PROMOTE_DRAFT_MEDIA]: () => new Changes(1),
    [SQL_ATTACH_CHECKOUT_SESSION]: () => new Changes(overrides.attachChanges ?? 1),
    [shard.generationJobs.SQL_GET_GENERATION_JOB]: () => overrides.job ?? null,
  });

  const generator = recordingFetcher((url) => {
    if (url.includes('/v1/policy-screen')) {
      return Response.json({ verdict: 'pass', reason: null });
    }
    return new Response(null, { status: 404 });
  });

  const billing = recordingFetcher(
    overrides.billingResponse ?? (() => Response.json(CHECKOUT, { status: 200 })),
  );

  const budget = budgetDouble();
  const quota = quotaDouble();

  const env = testEnv({
    CP: cpDb.db,
    SHARD_000: shardDb.db,
    GENERATOR: generator.fetcher,
    BILLING: billing.fetcher,
    BUDGET: budget.namespace,
    QUOTA: quota.namespace,
    RL_SUBMIT: allowingRateLimit(),
    API_ORIGIN: 'https://api.example-control-plane.test',
    DASHBOARD_ORIGIN: 'https://app.example-control-plane.test',
  });

  return {
    env,
    cookie: `${DRAFT_COOKIE_NAME}=${minted.value}`,
    cpDb,
    shardDb,
    generator,
    billing,
    budget,
  };
}

/**
 * Runs one submit through the full ladder.
 *
 * An `ExecutionContext` is passed explicitly because several branches record an abuse signal on
 * `waitUntil`, and `waitOnExecutionContext` then makes that background write finish before the
 * assertions read the log — a fire-and-forget telemetry write is exactly the kind of thing a test
 * otherwise races.
 */
async function runSubmit(harness: Harness): Promise<Response> {
  vi.stubGlobal('fetch', turnstileFetch(DRAFT.id));
  const ctx = createExecutionContext();
  const response = await app.request(
    '/v1/onboarding/submit',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: TEST_APP_ORIGIN,
        Cookie: harness.cookie,
      },
      body: JSON.stringify(validIntake()),
    },
    harness.env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('submit — the trial-first funnel', () => {
  it('answers 202 with a Checkout URL and writes an unrunnable job (T-B1)', async () => {
    const harness = await funnelHarness();

    const response = await runSubmit(harness);
    expect(response.status).toBe(202);

    const body = (await response.json()) as AcceptedBody;
    expect(body.paymentState).toBe('awaiting_payment');
    expect(body.checkoutUrl).toBe(CHECKOUT.checkoutUrl);
    expect(body.checkoutExpiresAt).toBe(CHECKOUT.expiresAt);
    expect(body.slug).toBe('kapsalon-anna');

    // The whole design in one assertion: the job row exists, and the queue sentinel that
    // `idx_jobs_queue` is partial on is NULL, so the drain cannot see it.
    const insert = harness.shardDb.find('INSERT INTO generation_jobs');
    expect(insert).toBeDefined();
    expect(insert?.sql).toContain("'awaiting_payment'");
    expect(insert?.sql).toContain('NULL, ?6, NULL');
    expect(insert?.sql).toContain("'initial_site', 1, 'queued'");

    // The session Stripe minted is attached to the job, which is what every later lookup — the
    // webhook's, and the return route's — resolves through.
    const attach = harness.shardDb.find('SET checkout_session_id');
    expect(attach?.params[1]).toBe(CHECKOUT.checkoutSessionId);
  });

  it('dispatches nothing (T-B3)', async () => {
    const harness = await funnelHarness();

    await runSubmit(harness);

    // The policy screen is the ONLY call this route may make to the generator. A single
    // `/v1/generations` here would mean Opus spend before a card exists.
    expect(harness.generator.count('/v1/policy-screen')).toBe(1);
    expect(harness.generator.count('/v1/generations')).toBe(0);
  });

  it('settles the budget reservation at zero before answering (T-B4)', async () => {
    const harness = await funnelHarness();

    await runSubmit(harness);

    const settles = harness.budget.calls.filter((call) => call.url.endsWith('/settle'));
    expect(settles).toHaveLength(1);
    expect(settles[0]?.body).toMatchObject({ reservationId: 'res_test', actualMicro: 0 });
  });

  it('refuses an address that has already had a trial, writing nothing (T-B6)', async () => {
    const harness = await funnelHarness({
      priorTrial: {
        id: 'trg_01J0000000000000000000000E',
        email_normalized: 'anna@example.test',
        org_id: null,
        stripe_customer_id: null,
        stripe_subscription_id: null,
        outcome: 'granted',
        granted_at: 1,
      },
    });

    const response = await runSubmit(harness);
    expect(response.status).toBe(409);

    const body = (await response.json()) as { error: string; signInUrl: string };
    expect(body.error).toBe('trial_already_used');
    expect(body.signInUrl).toContain('/inloggen');

    // Nothing was written and no Stripe object was created: the refusal is free for everyone.
    expect(harness.cpDb.ran('INSERT INTO organisations')).toBe(false);
    expect(harness.cpDb.ran('INSERT INTO users')).toBe(false);
    expect(harness.shardDb.ran('INSERT INTO generation_jobs')).toBe(false);
    expect(harness.billing.calls).toHaveLength(0);
  });

  it('answers 402 with the job id when Checkout cannot be created', async () => {
    const harness = await funnelHarness({
      billingResponse: () => new Response(null, { status: 503 }),
    });

    const response = await runSubmit(harness);
    expect(response.status).toBe(402);

    const body = (await response.json()) as { error: string; jobId: string };
    expect(body.error).toBe('checkout_unavailable');
    // The job survives: `POST /v1/billing/checkout/:jobId` mints a session for it later, and
    // nothing the customer entered is lost.
    expect(body.jobId.startsWith('job_')).toBe(true);
    expect(harness.shardDb.ran('INSERT INTO generation_jobs')).toBe(true);
  });

  it('reports the webhook winning the attach race as paid, not as a failure', async () => {
    const harness = await funnelHarness({
      attachChanges: 0,
      job: { payment_state: 'paid', id: 'job_01J0000000000000000000000F' },
    });

    const response = await runSubmit(harness);

    expect(response.status).toBe(200);
    const body = (await response.json()) as AcceptedBody;
    expect(body.paymentState).toBe('paid');
    expect(body.checkoutUrl).toBeNull();
  });

  it('replays a submitted draft with the live Checkout URL and no second job (T-B5)', async () => {
    const submitted = draftRow({
      status: 'submitted',
      site_id: 'ste_01J0000000000000000000000C',
      org_id: 'org_01J0000000000000000000000D',
      generation_job_id: 'job_01J0000000000000000000000F',
    });
    const harness = await funnelHarness({
      draft: submitted,
      job: {
        id: 'job_01J0000000000000000000000F',
        site_id: 'ste_01J0000000000000000000000C',
        org_id: 'org_01J0000000000000000000000D',
        payment_state: 'awaiting_payment',
        checkout_session_id: CHECKOUT.checkoutSessionId,
        payment_deadline_at: Date.now() + 10 * 60 * 1000,
        checkout_attempts: 1,
        created_by: 'usr_01J0000000000000000000000G',
        draft_id: submitted.id,
      },
      billingResponse: (url) =>
        url.includes(CHECKOUT.checkoutSessionId)
          ? Response.json({ status: 'open', paymentStatus: 'unpaid', url: CHECKOUT.checkoutUrl })
          : Response.json(CHECKOUT),
    });

    const response = await runSubmit(harness);
    expect(response.status).toBe(200);

    const body = (await response.json()) as AcceptedBody;
    expect(body.jobId).toBe('job_01J0000000000000000000000F');
    expect(body.checkoutUrl).toBe(CHECKOUT.checkoutUrl);

    // The live session is re-used rather than re-minted: no second job, no second organisation, and
    // no attempt spent on a customer who merely refreshed.
    expect(harness.cpDb.ran('INSERT INTO organisations')).toBe(false);
    expect(harness.shardDb.ran('INSERT INTO generation_jobs')).toBe(false);
    expect(harness.shardDb.ran('checkout_attempts = checkout_attempts + 1')).toBe(false);
    expect(harness.billing.count('/v1/checkout-sessions')).toBe(1);
  });
});
