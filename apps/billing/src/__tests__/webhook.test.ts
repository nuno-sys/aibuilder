import { cp } from '@aibuilder/db';
import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';

import {
  SQL_ABANDON_CHECKOUT,
  SQL_GET_JOB_BY_CHECKOUT_SESSION,
  SQL_RELEASE_PAID_JOB,
} from '../jobs';
import { CLAIM_TTL_MS } from '../webhook/events';
import { handleStripeEvent } from '../webhook/dispatch';
import { Changes, fakeR2, fakeStripe, recordingD1, recordingFetcher, testEnv } from './doubles';
import type { RecordingD1, RecordingFetcher } from './doubles';

/**
 * The webhook, at the four places it can go wrong in a way that costs money.
 *
 * 1. **A redelivery must not run twice.** Stripe retries for up to three days, and two deliveries
 *    of the same event can arrive concurrently. The claim is a compare-and-swap, and this suite
 *    drives it exactly as production does — the second delivery's claim changes zero rows.
 * 2. **An unresolvable organisation must answer 200.** Retrying for three days cannot make an
 *    organisation appear, and letting Stripe disable the endpoint over it takes billing down for
 *    every other tenant.
 * 3. **A livemode mismatch must never be processed.** A test-mode event in production would grant a
 *    real entitlement for a test card.
 * 4. **The batch order is a schema constraint.** `trg_orgs_deprovision_needs_member` aborts an
 *    organisation that would become reachable-and-billable with nobody able to sign in to it, and
 *    `subscriptions.stripe_customer_id` references a row that has to exist first.
 */

const ORG_ID = 'org_01J0000000000000000000000A' as const;
const SITE_ID = 'ste_01J0000000000000000000000B' as const;
const USER_ID = 'usr_01J0000000000000000000000C' as const;
const JOB_ID = 'job_01J0000000000000000000000D' as const;
const CUSTOMER_ID = 'cus_test0000000001';
const SUBSCRIPTION_ID = 'sub_test0000000001';
const SESSION_ID = 'cs_test_0123456789abcdef';
const EVENT_ID = 'evt_test0000000001';

/** A completed Checkout Session, in the shape the re-read returns. */
function completedSession(): Partial<Stripe.Checkout.Session> {
  return {
    id: SESSION_ID,
    object: 'checkout.session',
    status: 'complete',
    // The correct value on a trial-start session: Checkout creates a SetupIntent, not a
    // PaymentIntent, so asserting `paid` here would reject every real trial.
    payment_status: 'no_payment_required',
    customer: CUSTOMER_ID,
    subscription: SUBSCRIPTION_ID,
    client_reference_id: ORG_ID,
    customer_email: 'anna@example.test',
    customer_details: {
      email: 'anna@example.test',
      address: {
        country: 'NL',
        city: null,
        line1: null,
        line2: null,
        postal_code: null,
        state: null,
      },
    } as Stripe.Checkout.Session.CustomerDetails,
  };
}

/** A trialing subscription with one item, as the expanded re-read returns it. */
function trialingSubscription(): Partial<Stripe.Subscription> {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: SUBSCRIPTION_ID,
    object: 'subscription',
    status: 'trialing',
    customer: CUSTOMER_ID,
    currency: 'eur',
    cancel_at_period_end: false,
    canceled_at: null,
    ended_at: null,
    trial_start: now,
    trial_end: now + 7 * 24 * 60 * 60,
    latest_invoice: null,
    collection_method: 'charge_automatically',
    default_payment_method: {
      id: 'pm_test1',
      object: 'payment_method',
      card: { brand: 'visa', last4: '4242', fingerprint: 'fp_test_1' },
    } as Stripe.PaymentMethod,
    items: {
      object: 'list',
      has_more: false,
      url: '',
      data: [
        {
          id: 'si_test1',
          object: 'subscription_item',
          quantity: 1,
          current_period_start: now,
          current_period_end: now + 365 * 24 * 60 * 60,
          price: {
            id: 'price_test_annual',
            object: 'price',
            currency: 'eur',
            unit_amount: 11988,
            product: 'prod_test',
            recurring: { interval: 'year', interval_count: 1 },
          } as Stripe.Price,
        } as Stripe.SubscriptionItem,
      ],
    } as Stripe.ApiList<Stripe.SubscriptionItem>,
  };
}

/** An event envelope of the given type. */
function event(
  type: string,
  object: unknown,
  overrides: Record<string, unknown> = {},
): Stripe.Event {
  return {
    id: EVENT_ID,
    object: 'event',
    api_version: '2026-08-26.dahlia',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: null,
    type,
    data: { object },
    ...overrides,
  } as unknown as Stripe.Event;
}

/** The organisation row the resolver reads after `client_reference_id` names it. */
function organisationRow(): Record<string, unknown> {
  return {
    id: ORG_ID,
    name: 'Kapsalon Anna',
    shard_id: 0,
    provisional: 1,
    billing_email: null,
    country: 'NL',
    vat_number: null,
    vat_validated_at: null,
    billing_address: null,
    plan: 'free',
    entitlement: 'none',
    entitlement_until: null,
    sites_limit: 1,
    status: 'active',
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
  };
}

/** The job the Checkout Session belongs to. */
function jobRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: JOB_ID,
    org_id: ORG_ID,
    site_id: SITE_ID,
    draft_id: 'drf_01J0000000000000000000000E',
    created_by: USER_ID,
    payment_state: 'awaiting_payment',
    checkout_session_id: SESSION_ID,
    checkout_attempts: 1,
    ...overrides,
  };
}

/** The site the dispatch reads for its slug and canonical host. */
function siteRow(): Record<string, unknown> {
  return {
    id: SITE_ID,
    org_id: ORG_ID,
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
  };
}

/** Everything one case needs. */
interface Harness {
  readonly env: ReturnType<typeof testEnv>;
  readonly cpDb: RecordingD1;
  readonly shardDb: RecordingD1;
  readonly generator: RecordingFetcher;
  readonly stripe: Stripe;
  readonly calls: ReturnType<typeof fakeStripe>['calls'];
}

/** Builds an env whose two databases answer exactly the statements the handlers ship. */
function harness(
  options: {
    readonly claims?: number[];
    readonly organisation?: Record<string, unknown> | null;
    readonly customer?: Record<string, unknown> | null;
    readonly job?: Record<string, unknown> | null;
    readonly membership?: Record<string, unknown> | null;
    readonly trialByFingerprint?: Record<string, unknown> | null;
    readonly subscription?: Partial<Stripe.Subscription>;
    readonly session?: Partial<Stripe.Checkout.Session>;
  } = {},
): Harness {
  const claims = [...(options.claims ?? [1])];

  const cpDb = recordingD1({
    [cp.billing.SQL_INSERT_STRIPE_EVENT]: () => new Changes(1),
    [cp.billing.SQL_CLAIM_STRIPE_EVENT]: () => new Changes(claims.shift() ?? 0),
    [cp.billing.SQL_COMPLETE_STRIPE_EVENT]: () => new Changes(1),
    [cp.billing.SQL_FAIL_STRIPE_EVENT]: () => new Changes(1),
    [cp.billing.SQL_SKIP_STRIPE_EVENT]: () => new Changes(1),
    [cp.billing.SQL_GET_STRIPE_CUSTOMER]: () => options.customer ?? null,
    [cp.billing.SQL_FIND_TRIAL_BY_FINGERPRINT]: () => options.trialByFingerprint ?? null,
    [cp.billing.SQL_UPSERT_STRIPE_CUSTOMER]: () => new Changes(1),
    [cp.billing.SQL_INSERT_TRIAL_GRANT]: () => new Changes(1),
    [cp.subscriptions.SQL_UPSERT_SUBSCRIPTION]: () => new Changes(1),
    [cp.orgs.SQL_GET_ORG]: () =>
      options.organisation === undefined ? organisationRow() : options.organisation,
    [cp.orgs.SQL_SET_ENTITLEMENT]: () => new Changes(1),
    [cp.orgs.SQL_DEPROVISION_ORG]: () => new Changes(1),
    [cp.users.SQL_GET_MEMBERSHIP]: () => options.membership ?? null,
    [cp.users.SQL_INSERT_MEMBERSHIP]: () => new Changes(1),
    [cp.sites.SQL_SET_INDEX_STATE]: () => new Changes(1),
    [cp.sites.SQL_GET_LIVE_SITE]: () => siteRow(),
  });

  const shardDb = recordingD1({
    [SQL_GET_JOB_BY_CHECKOUT_SESSION]: () => (options.job === undefined ? jobRow() : options.job),
    [SQL_RELEASE_PAID_JOB]: () => new Changes(1),
    [SQL_ABANDON_CHECKOUT]: () => new Changes(1),
  });

  const generator = recordingFetcher(200);
  const { stripe, calls } = fakeStripe({
    session: options.session ?? completedSession(),
    subscription: options.subscription ?? trialingSubscription(),
  });

  const env = testEnv({
    CP: cpDb.db,
    SHARD_000: shardDb.db,
    BLOBS: fakeR2(),
    GENERATOR: generator.fetcher,
  });

  return { env, cpDb, shardDb, generator, stripe, calls };
}

describe('checkout.session.completed', () => {
  it('writes the batch in the order the schema requires, releases the job and dispatches once', async () => {
    const test = harness();

    const response = await handleStripeEvent(
      test.env,
      event('checkout.session.completed', completedSession()),
      '{}',
      { stripe: test.stripe },
    );

    expect(response.status).toBe(200);

    // The payload carries `subscription` as a bare id, so the handler re-reads both objects rather
    // than trusting a snapshot taken when the event was created.
    expect(test.calls.sessionRetrieves).toEqual([SESSION_ID]);
    expect(test.calls.subscriptionRetrieves).toEqual([SUBSCRIPTION_ID]);

    // ORDER (T-B17). The customer row is the FK parent of the subscription, and the membership must
    // precede the de-provision or `trg_orgs_deprovision_needs_member` aborts the whole batch.
    const customer = test.cpDb.indexOf('INSERT INTO stripe_customers');
    const subscription = test.cpDb.indexOf('INSERT INTO subscriptions');
    const membership = test.cpDb.indexOf('INSERT INTO memberships');
    const deprovision = test.cpDb.indexOf('SET provisional = 0');
    expect(customer).toBeGreaterThanOrEqual(0);
    expect(customer).toBeLessThan(subscription);
    expect(membership).toBeLessThan(deprovision);

    // The entitlement is written in the SAME batch as the subscription it was derived from.
    const entitlement = test.cpDb.find('SET entitlement =');
    expect(entitlement?.params[1]).toBe('trialing');
    expect(typeof entitlement?.params[2]).toBe('number');
    expect(entitlement?.params[3]).toBe('pro');

    // The trial is recorded in the same batch: a grant that is not in the ledger is a grant the
    // next signup's prior-trial lookup cannot see.
    expect(test.cpDb.ran('INSERT INTO trial_grants')).toBe(true);

    // The job is released and the Workflow is dispatched exactly once.
    expect(test.shardDb.ran("payment_state = 'paid'")).toBe(true);
    expect(test.generator.calls).toHaveLength(1);
    expect(test.generator.calls[0]?.url).toContain('/v1/generations');
    expect(test.generator.calls[0]?.body).toMatchObject({ jobId: JOB_ID, orgId: ORG_ID });
  });

  it('lets exactly one of two concurrent redeliveries do the work (T-B7)', async () => {
    // The claim is a compare-and-swap: the first delivery changes one row, the second changes none
    // because the first holds a live claim.
    const test = harness({ claims: [1, 0] });
    const delivery = (): Promise<Response> =>
      handleStripeEvent(test.env, event('checkout.session.completed', completedSession()), '{}', {
        stripe: test.stripe,
      });

    const [first, second] = await Promise.all([delivery(), delivery()]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const memberships = test.cpDb.log.filter((entry) =>
      entry.sql.includes('INSERT INTO memberships'),
    );
    const grants = test.cpDb.log.filter((entry) => entry.sql.includes('INSERT INTO trial_grants'));
    expect(memberships).toHaveLength(1);
    expect(grants).toHaveLength(1);
    expect(test.generator.calls).toHaveLength(1);
  });

  it('claims with a 16-byte token and a two-minute expiry (T-B8)', async () => {
    const test = harness();
    const now = 1_800_000_000_000;

    await handleStripeEvent(
      test.env,
      event('checkout.session.completed', completedSession()),
      '{}',
      { stripe: test.stripe, now },
    );

    const claim = test.cpDb.find("SET status = 'processing'");
    expect(claim).toBeDefined();
    // `length(claim_token) = 16` is a CHECK; the expiry sits above Stripe's 30-second delivery
    // timeout and far below its five-minute first retry, so a crashed handler is re-claimable and a
    // concurrent one is not.
    expect((claim?.params[1] as ArrayBuffer).byteLength).toBe(16);
    expect(claim?.params[2]).toBe(now + CLAIM_TTL_MS);
    // The statement itself carries the three-way predicate that makes an expired claim re-claimable.
    expect(claim?.sql).toContain("status = 'received'");
    expect(claim?.sql).toContain('claim_expires_at < ?4');
  });

  it('records an event for an unknown organisation as skipped and answers 200 (T-B10)', async () => {
    const test = harness({
      customer: null,
      organisation: null,
      session: { ...completedSession(), client_reference_id: null },
    });

    const response = await handleStripeEvent(
      test.env,
      event('checkout.session.completed', completedSession()),
      '{}',
      { stripe: test.stripe },
    );

    // 200, because retrying for three days cannot make an organisation appear.
    expect(response.status).toBe(200);
    const skip = test.cpDb.find("SET status = 'skipped'");
    expect(skip?.params[1]).toBe('org_unresolved');

    // The ledger row was inserted with `org_id` NULL, and nothing else was written anywhere.
    const insert = test.cpDb.find('INSERT INTO stripe_events');
    expect(insert?.params[6]).toBeNull();
    expect(test.cpDb.ran('INSERT INTO stripe_customers')).toBe(false);
    expect(test.cpDb.ran('INSERT INTO memberships')).toBe(false);
    expect(test.shardDb.log).toHaveLength(0);
    expect(test.generator.calls).toHaveLength(0);
  });

  it('records a livemode mismatch and never claims it (T-B11)', async () => {
    // `ENVIRONMENT = 'production'` expects live events; this one is test-mode.
    const test = harness();
    const env = testEnv({
      CP: test.cpDb.db,
      SHARD_000: test.shardDb.db,
      BLOBS: fakeR2(),
      GENERATOR: test.generator.fetcher,
      ENVIRONMENT: 'production',
    });

    const response = await handleStripeEvent(
      env,
      event('checkout.session.completed', completedSession(), { livemode: false }),
      '{}',
      { stripe: test.stripe },
    );

    expect(response.status).toBe(200);
    const insert = test.cpDb.find('INSERT INTO stripe_events');
    // Recorded as skipped in ONE write, with the reason, and never claimed or processed.
    expect(insert?.params[7]).toBe('skipped');
    expect(insert?.params[8]).toBe('livemode_mismatch');
    expect(test.cpDb.ran("SET status = 'processing'")).toBe(false);
    expect(test.generator.calls).toHaveLength(0);

    // The mirror case: a live event against a staging deployment is refused the same way.
    const staging = harness();
    const mirrored = await handleStripeEvent(
      staging.env,
      event('checkout.session.completed', completedSession(), { livemode: true }),
      '{}',
      { stripe: staging.stripe },
    );
    expect(mirrored.status).toBe(200);
    expect(staging.cpDb.ran("SET status = 'processing'")).toBe(false);
  });

  it('does not release the job when a returning card converts the trial (T-T1)', async () => {
    const active: Partial<Stripe.Subscription> = { ...trialingSubscription(), status: 'active' };
    const test = harness({
      trialByFingerprint: {
        id: 'trg_01J0000000000000000000000F',
        email_normalized: 'someone@example.test',
        org_id: null,
        stripe_customer_id: null,
        stripe_subscription_id: null,
        outcome: 'granted',
        granted_at: 1,
      },
      subscription: active,
    });

    const response = await handleStripeEvent(
      test.env,
      event('checkout.session.completed', completedSession()),
      '{}',
      { stripe: test.stripe },
    );

    expect(response.status).toBe(200);
    // The trial ends immediately and Stripe invoices the year up front…
    expect(test.calls.subscriptionUpdates).toHaveLength(1);
    expect(test.calls.subscriptionUpdates[0]).toMatchObject({
      id: SUBSCRIPTION_ID,
      params: { trial_end: 'now', proration_behavior: 'none' },
    });
    // …and no Opus is spent until `invoice.paid` says the money arrived.
    expect(test.shardDb.ran("payment_state = 'paid'")).toBe(false);
    expect(test.generator.calls).toHaveLength(0);
  });

  it('treats a missing card fingerprint as no signal (T-T2)', async () => {
    const noFingerprint: Partial<Stripe.Subscription> = {
      ...trialingSubscription(),
      default_payment_method: {
        id: 'pm_test2',
        object: 'payment_method',
        card: { brand: 'visa', last4: '4242', fingerprint: null },
      } as Stripe.PaymentMethod,
    };
    const test = harness({ subscription: noFingerprint });

    await handleStripeEvent(
      test.env,
      event('checkout.session.completed', completedSession()),
      '{}',
      { stripe: test.stripe },
    );

    // No lookup was even attempted, the trial proceeds, and the job is released.
    expect(test.cpDb.ran('card_fingerprint_sha256 = ?1')).toBe(false);
    expect(test.calls.subscriptionUpdates).toHaveLength(0);
    expect(test.generator.calls).toHaveLength(1);
  });

  it('refuses a card whose prior trial ended in a chargeback (T-T3)', async () => {
    const test = harness({
      trialByFingerprint: {
        id: 'trg_01J0000000000000000000000G',
        email_normalized: 'fraud@example.test',
        org_id: null,
        stripe_customer_id: null,
        stripe_subscription_id: null,
        outcome: 'disputed',
        granted_at: 1,
      },
    });

    await handleStripeEvent(
      test.env,
      event('checkout.session.completed', completedSession()),
      '{}',
      { stripe: test.stripe },
    );

    expect(test.calls.subscriptionCancels).toEqual([SUBSCRIPTION_ID]);
    expect(test.calls.subscriptionUpdates).toHaveLength(0);
    expect(test.generator.calls).toHaveLength(0);
    // The refusal is recorded in the ledger as such, so the next attempt sees it too.
    const grant = test.cpDb.find('INSERT INTO trial_grants');
    expect(grant?.params[6]).toBe('refused');
  });
});

describe('checkout.session.expired', () => {
  it('abandons the job without terminating it (T-B21)', async () => {
    const test = harness({ customer: null });

    const response = await handleStripeEvent(
      test.env,
      event('checkout.session.expired', {
        id: SESSION_ID,
        object: 'checkout.session',
        status: 'expired',
        customer: null,
        client_reference_id: ORG_ID,
      }),
      '{}',
      { stripe: test.stripe },
    );

    expect(response.status).toBe(200);
    const abandon = test.shardDb.find("payment_state = 'abandoned'");
    expect(abandon).toBeDefined();
    // The guard is what stops a late `expired` for a superseded session from abandoning a job that
    // is already waiting on a newer one.
    expect(abandon?.sql).toContain(
      "AND payment_state = 'awaiting_payment' AND checkout_session_id",
    );
    // `status` is untouched: a terminal status would make "pay after all" impossible without a
    // second job row, a second idempotency key and a second slug reservation.
    expect(abandon?.sql).not.toContain('status =');
    // No control-plane write at all: no Customer was ever created, because `subscription` mode
    // creates one only when the session completes.
    expect(test.cpDb.ran('INSERT INTO stripe_customers')).toBe(false);
  });
});

describe('unknown event types', () => {
  it('records them as skipped so the endpoint configuration can be audited', async () => {
    const test = harness();

    const response = await handleStripeEvent(
      test.env,
      event('payment_intent.succeeded', { id: 'pi_test1' }),
      '{}',
      { stripe: test.stripe },
    );

    expect(response.status).toBe(200);
    expect(test.cpDb.find("SET status = 'skipped'")?.params[1]).toBe('unhandled_type');
  });
});
