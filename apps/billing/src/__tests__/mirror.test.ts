import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';

import { DUNNING_GRACE_MS, decideEntitlement } from '../entitlement';
import {
  clampSubscriptionStatus,
  defaultCardFingerprint,
  invoiceMirror,
  invoiceTaxCents,
  subscriptionMirror,
  subscriptionPeriod,
} from '../mirror';

/**
 * The mirror and the entitlement decision: three API facts, and one state machine.
 *
 * Each of the first three tests exists because the field it covers MOVED in the API version this
 * product pins, and reading the old one silently produces a plausible wrong number rather than an
 * error: the billing period left the subscription for its items, the invoice's tax became an array
 * of lines, and the subscription status became an open string.
 */

const ORG_ID = 'org_01J0000000000000000000000A' as const;
const NOW = 1_800_000_000_000;

/** A subscription with one item, in the shape an expanded re-read returns. */
function subscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  const seconds = Math.floor(NOW / 1000);
  return {
    id: 'sub_test0000000001',
    object: 'subscription',
    status: 'active',
    customer: 'cus_test0000000001',
    currency: 'eur',
    cancel_at_period_end: false,
    canceled_at: null,
    ended_at: null,
    trial_start: null,
    trial_end: null,
    latest_invoice: null,
    collection_method: 'charge_automatically',
    default_payment_method: null,
    items: {
      object: 'list',
      has_more: false,
      url: '',
      data: [
        {
          id: 'si_test1',
          object: 'subscription_item',
          quantity: 1,
          current_period_start: seconds,
          current_period_end: seconds + 365 * 24 * 60 * 60,
          price: {
            id: 'price_test_annual',
            object: 'price',
            currency: 'eur',
            unit_amount: 11988,
            product: 'prod_test',
            recurring: { interval: 'year', interval_count: 1 },
          },
        },
      ],
    },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

/** An invoice in the shape `invoice.paid` delivers. */
function invoice(overrides: Partial<Stripe.Invoice> = {}): Stripe.Invoice {
  const seconds = Math.floor(NOW / 1000);
  return {
    id: 'in_test0000000001',
    object: 'invoice',
    status: 'paid',
    currency: 'eur',
    number: 'AIB-0001',
    subtotal: 11988,
    total: 14505,
    amount_paid: 14505,
    created: seconds,
    period_start: seconds,
    period_end: seconds + 365 * 24 * 60 * 60,
    status_transitions: {
      finalized_at: seconds,
      paid_at: seconds,
      marked_uncollectible_at: null,
      voided_at: null,
    },
    total_taxes: [
      { amount: 2000, tax_behavior: 'exclusive', taxable_amount: 11988, type: 'tax_rate_details' },
      { amount: 517, tax_behavior: 'exclusive', taxable_amount: 11988, type: 'tax_rate_details' },
    ],
    parent: {
      type: 'subscription_details',
      quote_details: null,
      subscription_details: { subscription: 'sub_test0000000001', metadata: null },
    },
    ...overrides,
  } as unknown as Stripe.Invoice;
}

describe('the subscription mirror', () => {
  it('takes the billing period from items.data[0] (T-B14)', () => {
    const period = subscriptionPeriod(subscription());

    expect(period.start).toBe(NOW);
    expect(period.end).toBe(NOW + 365 * 24 * 60 * 60 * 1000);
  });

  it('produces NULLs rather than throwing for a subscription with no items (T-B14)', () => {
    const empty = subscription({
      items: { object: 'list', has_more: false, url: '', data: [] },
    } as unknown as Partial<Stripe.Subscription>);

    const mirror = subscriptionMirror(empty, {
      orgId: ORG_ID,
      stripeCustomerId: 'cus_test0000000001',
      stripeUpdatedAt: NOW,
      fallbackPriceId: 'price_test_annual',
      nowMs: NOW,
    });

    expect(mirror.currentPeriodStart).toBeNull();
    expect(mirror.currentPeriodEnd).toBeNull();
    // `stripe_price_id` is NOT NULL, so the configured price stands in rather than the write
    // failing a CHECK on a webhook Stripe would then retry for three days.
    expect(mirror.stripePriceId).toBe('price_test_annual');
    expect(mirror.unitAmountCents).toBe(0);
  });

  it('clamps an unrecognised status and reports that it did (T-B15)', () => {
    expect(clampSubscriptionStatus('trialing')).toEqual({ status: 'trialing', recognised: true });

    const future = clampSubscriptionStatus('quantum_superposition');
    expect(future.status).toBe('past_due');
    expect(future.recognised).toBe(false);

    const mirror = subscriptionMirror(subscription({ status: 'quantum_superposition' as never }), {
      orgId: ORG_ID,
      stripeCustomerId: 'cus_test0000000001',
      stripeUpdatedAt: NOW,
      fallbackPriceId: 'price_test_annual',
      nowMs: NOW,
    });
    // The column's CHECK is a closed set on a table that can never be rebuilt, so the mirror stores
    // the clamped value and the raw one goes to the alert.
    expect(mirror.status).toBe('past_due');
  });

  it('supplies canceled_at when Stripe reports only ended_at', () => {
    const seconds = Math.floor(NOW / 1000);
    const mirror = subscriptionMirror(
      subscription({ status: 'canceled', canceled_at: null, ended_at: seconds }),
      {
        orgId: ORG_ID,
        stripeCustomerId: 'cus_test0000000001',
        stripeUpdatedAt: NOW,
        fallbackPriceId: 'price_test_annual',
        nowMs: NOW,
      },
    );

    // `CHECK (status <> 'canceled' OR canceled_at IS NOT NULL)`.
    expect(mirror.canceledAt).toBe(NOW);
  });

  it('reads the card fingerprint only from an expanded payment method', () => {
    expect(defaultCardFingerprint(subscription())).toBeNull();
    expect(
      defaultCardFingerprint(
        subscription({ default_payment_method: 'pm_test1' as unknown as Stripe.PaymentMethod }),
      ),
    ).toBeNull();
    expect(
      defaultCardFingerprint(
        subscription({
          default_payment_method: {
            id: 'pm_test1',
            object: 'payment_method',
            card: { brand: 'visa', last4: '4242', fingerprint: 'fp_1' },
          } as unknown as Stripe.PaymentMethod,
        }),
      ),
    ).toBe('fp_1');
  });
});

describe('the invoice mirror', () => {
  it('sums total_taxes and tolerates its absence (T-B13)', () => {
    expect(invoiceTaxCents(invoice())).toBe(2517);
    expect(invoiceTaxCents(invoice({ total_taxes: null }))).toBe(0);
  });

  it('survives an invoice with no hosted URL or PDF (T-B13)', () => {
    const mirror = invoiceMirror(invoice({ hosted_invoice_url: null, invoice_pdf: null }), {
      orgId: ORG_ID,
    });

    expect(mirror.hostedInvoiceUrl).toBeNull();
    expect(mirror.invoicePdfUrl).toBeNull();
    expect(mirror.taxCents).toBe(2517);
    expect(mirror.totalCents).toBe(14505);
    // The subscription comes from `parent.subscription_details`; the removed top-level field would
    // have orphaned every invoice from its subscription.
    expect(mirror.stripeSubscriptionId).toBe('sub_test0000000001');
  });

  it('always supplies paid_at for a paid invoice', () => {
    const mirror = invoiceMirror(
      invoice({
        status_transitions: {
          finalized_at: null,
          paid_at: null,
          marked_uncollectible_at: null,
          voided_at: null,
        },
      }),
      { orgId: ORG_ID },
    );

    // `CHECK (status <> 'paid' OR paid_at IS NOT NULL)`.
    expect(mirror.paidAt).toBe(NOW);
  });
});

describe('decideEntitlement', () => {
  /** The facts every case shares; each test overrides only what it is about. */
  const base = {
    trialEndMs: NOW + 7 * 24 * 60 * 60 * 1000,
    currentPeriodEndMs: NOW + 365 * 24 * 60 * 60 * 1000,
    endedAtMs: null,
    canceledAtMs: null,
    nowMs: NOW,
    dunningGraceMs: DUNNING_GRACE_MS,
  };

  it('maps all eight known statuses and one unknown (T-E1)', () => {
    const table: readonly [string, string, number | null, string][] = [
      ['trialing', 'trialing', base.trialEndMs, 'pro'],
      ['active', 'active', base.currentPeriodEndMs, 'pro'],
      ['past_due', 'past_due', NOW + DUNNING_GRACE_MS, 'pro'],
      ['unpaid', 'past_due', NOW + DUNNING_GRACE_MS, 'pro'],
      ['paused', 'canceled', NOW, 'free'],
      ['canceled', 'canceled', NOW, 'free'],
      ['incomplete', 'none', null, 'free'],
      ['incomplete_expired', 'canceled', NOW, 'free'],
      // The important row: Stripe reserves the right to ship a new status, and it must fail open
      // for the customer and closed for us.
      ['something_new', 'past_due', NOW + DUNNING_GRACE_MS, 'pro'],
    ];

    for (const [stripeStatus, entitlement, until, plan] of table) {
      const decision = decideEntitlement({ ...base, stripeStatus });
      expect({ stripeStatus, ...decision }).toEqual({
        stripeStatus,
        entitlement,
        entitlementUntil: until,
        plan,
      });
    }
  });

  it('never returns a null deadline for a live entitlement (T-E2)', () => {
    const statuses = [
      'trialing',
      'active',
      'past_due',
      'unpaid',
      'paused',
      'canceled',
      'incomplete',
      'incomplete_expired',
      'brand_new_status',
    ];
    // Every combination of missing timestamps, which is the shape a lost or partial webhook
    // produces. `CHECK (entitlement NOT IN ('trialing','active','past_due') OR entitlement_until IS
    // NOT NULL)` must hold for all of them.
    for (const stripeStatus of statuses) {
      for (const trialEndMs of [null, base.trialEndMs]) {
        for (const currentPeriodEndMs of [null, base.currentPeriodEndMs]) {
          const decision = decideEntitlement({
            ...base,
            stripeStatus,
            trialEndMs,
            currentPeriodEndMs,
          });
          if (['trialing', 'active', 'past_due'].includes(decision.entitlement)) {
            expect(decision.entitlementUntil).not.toBeNull();
            expect(decision.entitlementUntil).toBeGreaterThan(NOW);
          }
        }
      }
    }
  });

  it('leaves a cancel-at-period-end subscription entitled to the period it paid for (T-E3)', () => {
    // `cancel_at_period_end` does not change `status`, so nothing about this decision changes
    // either. The transition happens when `customer.subscription.deleted` arrives.
    const decision = decideEntitlement({ ...base, stripeStatus: 'active' });

    expect(decision.entitlement).toBe('active');
    expect(decision.entitlementUntil).toBe(base.currentPeriodEndMs);
    expect(decision.plan).toBe('pro');
  });
});
