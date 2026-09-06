import type { cp } from '@aibuilder/db';
import type { InvoiceStatus, OrganisationId, SubscriptionStatus } from '@aibuilder/db';
import type Stripe from 'stripe';

/**
 * Stripe objects → our row shapes.
 *
 * This module is where three verified facts about the pinned API version live, and it is the only
 * place any of them appears:
 *
 * 1. **`Subscription.current_period_start/end` no longer exist.** The period moved onto the items:
 *    `subscription.items.data[i].current_period_{start,end}`. Our two columns are therefore DERIVED
 *    from `items.data[0]`, and a subscription whose items list is empty yields `null` rather than a
 *    thrown `TypeError` on a webhook Stripe would then retry for three days.
 * 2. **`Invoice.tax` no longer exists.** The aggregate is `invoice.total_taxes[].amount`, and it is
 *    nullable. Copying the old field would store €0,00 of VAT on every invoice — a number that is
 *    wrong, plausible, and invisible until an accountant asks.
 * 3. **`Subscription.status` is an open string.** The SDK types it as its union PLUS `OtherString`.
 *    Our column's CHECK is a closed set on a table that can never be rebuilt, so an unrecognised
 *    status is clamped to `past_due` and reported; storing it verbatim would fail the CHECK.
 *
 * Everything here is a pure function of a Stripe object. Nothing reads a binding, so the mapping is
 * unit-testable without the network and without a database.
 */

/** Stripe timestamps are epoch SECONDS; every column in this product is epoch MILLISECONDS. */
export function epochMs(seconds: number | null | undefined): number | null {
  return typeof seconds === 'number' ? seconds * 1000 : null;
}

/** The statuses `subscriptions.status` accepts. Mirrors the CHECK in `migrations/cp/0004`. */
const KNOWN_STATUSES: ReadonlySet<string> = new Set<SubscriptionStatus>([
  'trialing',
  'active',
  'past_due',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'unpaid',
  'paused',
]);

/** A clamped status, and whether clamping was needed. */
export interface ClampedStatus {
  readonly status: SubscriptionStatus;
  /** `false` means Stripe shipped a status we do not model. The caller alerts; it does not fail. */
  readonly recognised: boolean;
}

/**
 * Clamps a Stripe subscription status onto the closed set the column allows.
 *
 * `past_due` is the safe landing place for an unknown state: it keeps the site serving and keeps
 * regeneration blocked, and the entitlement derived from it expires in the dunning window rather
 * than never.
 */
export function clampSubscriptionStatus(status: string): ClampedStatus {
  return KNOWN_STATUSES.has(status)
    ? { status: status as SubscriptionStatus, recognised: true }
    : { status: 'past_due', recognised: false };
}

/** The billing period, from `items.data[0]`. Both `null` when the subscription has no items. */
export function subscriptionPeriod(subscription: Stripe.Subscription): {
  readonly start: number | null;
  readonly end: number | null;
} {
  const item = subscription.items.data[0];
  if (item === undefined) {
    return { start: null, end: null };
  }
  return { start: epochMs(item.current_period_start), end: epochMs(item.current_period_end) };
}

/** The id of a field Stripe returns either expanded or as a bare id. */
function idOf(value: string | { readonly id: string } | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === 'string' ? value : value.id;
}

/**
 * The card fingerprint of the subscription's default payment method.
 *
 * Requires `expand: ['default_payment_method']`; an unexpanded field is a bare id and carries no
 * card at all. `card.fingerprint` is `string | null` and on some shapes absent entirely, and a
 * missing fingerprint is treated everywhere as NO SIGNAL rather than as a refusal — a check that
 * failed closed on an optional field would reject legitimate customers for a reason nobody could
 * explain to them.
 */
export function defaultCardFingerprint(subscription: Stripe.Subscription): string | null {
  const method = subscription.default_payment_method;
  if (method === null || typeof method === 'string') {
    return null;
  }
  return method.card?.fingerprint ?? null;
}

/** The card brand and last four of the subscription's default payment method, when expanded. */
export function defaultCardSummary(subscription: Stripe.Subscription): {
  readonly brand: string | null;
  readonly last4: string | null;
} {
  const method = subscription.default_payment_method;
  if (method === null || typeof method === 'string') {
    return { brand: null, last4: null };
  }
  return { brand: method.card?.brand ?? null, last4: method.card?.last4 ?? null };
}

/** `billing_interval` accepts two values; the single Price this product sells is annual. */
function clampInterval(interval: string | undefined): 'month' | 'year' {
  // `day` and `week` are clamped to the SHORTER of the two allowed values on purpose: this column
  // is displayed to the customer, and over-stating a billing period reads as a longer commitment
  // than they made. Unreachable with the one Price in `STRIPE_PRICE_ID`.
  return interval === 'year' ? 'year' : 'month';
}

/**
 * Maps a re-read Stripe subscription onto the mirror row.
 *
 * `stripeUpdatedAt` is the EVENT's creation time, not the wall clock: it is what the ordering guard
 * on the upsert compares against, and using `Date.now()` would make every write win regardless of
 * which event it came from.
 */
export function subscriptionMirror(
  subscription: Stripe.Subscription,
  args: {
    readonly orgId: OrganisationId;
    readonly stripeCustomerId: string;
    readonly stripeUpdatedAt: number;
    /** Used only when Stripe hands back a subscription with no items; see the header. */
    readonly fallbackPriceId: string;
    readonly nowMs: number;
  },
): cp.subscriptions.SubscriptionMirror {
  const clamped = clampSubscriptionStatus(subscription.status);
  const period = subscriptionPeriod(subscription);
  const item = subscription.items.data[0];
  const price = item?.price;
  const canceledAt = epochMs(subscription.canceled_at);
  const endedAt = epochMs(subscription.ended_at);

  return {
    stripeSubscriptionId: subscription.id,
    orgId: args.orgId,
    stripeCustomerId: args.stripeCustomerId,
    status: clamped.status,
    stripePriceId: price?.id ?? args.fallbackPriceId,
    stripeProductId: idOf(price?.product),
    currency: (price?.currency ?? subscription.currency).toLowerCase(),
    unitAmountCents: price?.unit_amount ?? 0,
    billingInterval: clampInterval(price?.recurring?.interval),
    intervalCount: price?.recurring?.interval_count ?? 1,
    quantity: item?.quantity ?? 1,
    trialStart: epochMs(subscription.trial_start),
    trialEnd: epochMs(subscription.trial_end),
    currentPeriodStart: period.start,
    currentPeriodEnd: period.end,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    // `CHECK (status <> 'canceled' OR canceled_at IS NOT NULL)`. Stripe can report a cancelled
    // subscription with only `ended_at` set, so the fallback chain ends at the clock rather than at
    // a constraint failure on a webhook that would then retry for three days.
    canceledAt: clamped.status === 'canceled' ? (canceledAt ?? endedAt ?? args.nowMs) : canceledAt,
    endedAt,
    latestInvoiceId: idOf(subscription.latest_invoice),
    collectionMethod:
      subscription.collection_method === 'send_invoice' ? 'send_invoice' : 'charge_automatically',
    stripeUpdatedAt: args.stripeUpdatedAt,
  };
}

/** `invoices.status` accepts five values; Stripe's is nullable while the invoice is a draft. */
function clampInvoiceStatus(status: Stripe.Invoice.Status | null): InvoiceStatus {
  switch (status) {
    case 'open':
      return 'open';
    case 'paid':
      return 'paid';
    case 'void':
      return 'void';
    case 'uncollectible':
      return 'uncollectible';
    default:
      // `null` (a draft), and the open string the SDK models for statuses Stripe may add later.
      return 'draft';
  }
}

/**
 * The invoice's total tax, in cents.
 *
 * `sum(total_taxes[].amount)`, tolerating `null` — which is what a €0 tax line and a reverse-charge
 * B2B sale both look like.
 */
export function invoiceTaxCents(invoice: Stripe.Invoice): number {
  const taxes = invoice.total_taxes;
  if (taxes === null || taxes === undefined) {
    return 0;
  }
  let total = 0;
  for (const tax of taxes) {
    total += tax.amount;
  }
  return total;
}

/**
 * The subscription an invoice belongs to.
 *
 * `Invoice.subscription` was replaced by `invoice.parent.subscription_details.subscription`, which
 * is either an id or an expanded object. Reading the removed field would silently orphan every
 * invoice from its subscription.
 */
export function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  return idOf(invoice.parent?.subscription_details?.subscription);
}

/** Maps a Stripe invoice onto the mirror row. */
export function invoiceMirror(
  invoice: Stripe.Invoice,
  args: { readonly orgId: OrganisationId },
): cp.billing.InvoiceMirror {
  const status = clampInvoiceStatus(invoice.status);
  return {
    // A finalised invoice always carries an id; the draft-preview shape does not, and a preview is
    // never delivered as an event.
    stripeInvoiceId: invoice.id ?? '',
    orgId: args.orgId,
    stripeSubscriptionId: invoiceSubscriptionId(invoice),
    number: invoice.number,
    status,
    currency: invoice.currency.toLowerCase(),
    subtotalCents: invoice.subtotal,
    taxCents: invoiceTaxCents(invoice),
    totalCents: invoice.total,
    amountPaidCents: invoice.amount_paid,
    // Both are optional as well as nullable on this API version, so `?? null` is doing real work.
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    invoicePdfUrl: invoice.invoice_pdf ?? null,
    periodStart: epochMs(invoice.period_start),
    periodEnd: epochMs(invoice.period_end),
    issuedAt: epochMs(invoice.status_transitions.finalized_at) ?? epochMs(invoice.created) ?? 0,
    // `CHECK (status <> 'paid' OR paid_at IS NOT NULL)`: a paid invoice with no recorded
    // transition falls back to its own creation time rather than failing the write.
    paidAt:
      status === 'paid'
        ? (epochMs(invoice.status_transitions.paid_at) ?? epochMs(invoice.created))
        : epochMs(invoice.status_transitions.paid_at),
  };
}
