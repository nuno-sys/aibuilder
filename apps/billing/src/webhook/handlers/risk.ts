import { cp, runBatch } from '@aibuilder/db';
import type { SiteRow } from '@aibuilder/db';
import type Stripe from 'stripe';

import { DUNNING_GRACE_MS, decideEntitlement } from '../../entitlement';
import { subscriptionMirror } from '../../mirror';
import { alert } from '../../ops';
import { idOf, recordAbuse, resolveOrganisation } from '../context';
import type { HandlerContext, HandlerOutcome, ResolvedOrganisation } from '../context';

/**
 * Chargebacks, fraud warnings, and the customer's own edits.
 *
 * WHY A DISPUTE SUSPENDS THE SITE IMMEDIATELY. A chargeback on a €119,88 annual subscription
 * within weeks of signup is, empirically, either a stolen card or an abandoned business. Serving a
 * generated site while contesting a dispute means hosting a fraudster's storefront at our own
 * expense, with our own domain's reputation attached to it. The suspension is reversible by an
 * operator, and `charge.dispute.closed` with `status = 'won'` reverses it automatically.
 *
 * WHY AN EARLY FRAUD WARNING DOES NOT. An EFW is a prediction, not a chargeback. Auto-suspending on
 * it would punish false positives, and the runbook's remedy — refund proactively to avoid the
 * dispute — is a human decision with money attached.
 *
 * WHY THE DISPUTE PATH WRITES AN ENTITLEMENT WITHOUT A SUBSCRIPTION. Everywhere else in this Worker
 * those two are written as one pair, because the entitlement column is a denormalisation of the
 * subscription's status. A dispute is the deliberate exception: it is a RISK decision that
 * overrides the mirror, and the subscription row is left exactly as Stripe has it so that
 * `dispute.closed(won)` can restore the entitlement from a re-read instead of from a guess about
 * what it used to be.
 */

/** Resolves the organisation behind a dispute, via the charge's customer. */
async function organisationForCharge(
  ctx: HandlerContext,
  chargeId: string | null,
  customerId: string | null,
): Promise<ResolvedOrganisation | null> {
  if (customerId !== null) {
    const direct = await resolveOrganisation(ctx.env, { stripeCustomerId: customerId });
    if (direct !== null) {
      return direct;
    }
  }
  if (chargeId === null) {
    return null;
  }
  const charge = await ctx.stripe.charges.retrieve(chargeId);
  return resolveOrganisation(ctx.env, { stripeCustomerId: idOf(charge.customer) });
}

/**
 * How many sites one suspension touches.
 *
 * An organisation on this plan has one site; the bound exists so a compromised account with many
 * cannot turn one dispute into an unbounded write, and the page size is generous enough that the
 * realistic case is always covered in full.
 */
const SITE_PAGE = 50;

/** Every live site of an organisation, which is what a suspension has to reach. */
async function sitesForOrg(
  ctx: HandlerContext,
  resolved: ResolvedOrganisation,
): Promise<readonly SiteRow[]> {
  return cp.sites.listLiveSitesForOrg(ctx.env.CP, { orgId: resolved.orgId, limit: SITE_PAGE });
}

/**
 * `charge.dispute.created`.
 *
 * `index_state = 'gone'` makes the renderer answer 410 and asks search engines to drop the URLs;
 * `status = 'suspended'` stops it serving at all. Both are single, auditable transitions.
 */
export async function handleDisputeCreated(
  ctx: HandlerContext,
  dispute: Stripe.Dispute,
): Promise<HandlerOutcome> {
  const resolved = await organisationForCharge(ctx, idOf(dispute.charge), null);
  if (resolved === null) {
    alert('org_unresolved', { event: ctx.event.id, type: ctx.event.type, dispute: dispute.id });
    return { orgId: null, skipped: 'org_unresolved' };
  }

  const sites = await sitesForOrg(ctx, resolved);
  const statements = sites.flatMap((site) => [
    ctx.env.CP.prepare(cp.sites.SQL_SET_INDEX_STATE).bind(site.id, 'gone', ctx.now),
    ctx.env.CP.prepare(cp.sites.SQL_SET_SITE_STATUS).bind(site.id, 'suspended', ctx.now),
  ]);
  statements.push(
    cp.orgs.setEntitlementStatement(ctx.env.CP, {
      orgId: resolved.orgId,
      entitlement: 'canceled',
      entitlementUntil: ctx.now,
      plan: 'free',
      now: ctx.now,
    }),
  );
  await runBatch(ctx.env.CP, statements);

  await recordAbuse(ctx.env, {
    kind: 'manual_report',
    severity: 'block',
    orgId: resolved.orgId,
    siteId: sites[0]?.id ?? null,
    detail: { reason: 'chargeback', dispute: dispute.id, amount: String(dispute.amount) },
    now: ctx.now,
  });
  alert('dispute_opened', {
    dispute: dispute.id,
    org: resolved.orgId,
    amount: dispute.amount,
    sites: sites.length,
  });

  return { orgId: resolved.orgId };
}

/**
 * `charge.dispute.closed`.
 *
 * A win restores the site and re-derives the entitlement from a re-read of the subscription — never
 * from a remembered value, because weeks pass between the two events and the subscription may have
 * been cancelled, renewed or gone past due in between. A loss leaves the suspension in place and
 * marks the trial ledger, so the card cannot start a second trial.
 */
export async function handleDisputeClosed(
  ctx: HandlerContext,
  dispute: Stripe.Dispute,
): Promise<HandlerOutcome> {
  const resolved = await organisationForCharge(ctx, idOf(dispute.charge), null);
  if (resolved === null) {
    alert('org_unresolved', { event: ctx.event.id, type: ctx.event.type, dispute: dispute.id });
    return { orgId: null, skipped: 'org_unresolved' };
  }

  if (dispute.status !== 'won') {
    const live = await cp.subscriptions.listLiveSubscriptionsForOrg(ctx.env.CP, resolved.orgId);
    for (const subscription of live) {
      await cp.billing.setTrialOutcome(ctx.env.CP, {
        stripeSubscriptionId: subscription.stripe_subscription_id,
        outcome: 'disputed',
        now: ctx.now,
      });
    }
    return { orgId: resolved.orgId, skipped: `dispute_${dispute.status}` };
  }

  const sites = await sitesForOrg(ctx, resolved);
  const statements = sites.flatMap((site) => [
    ctx.env.CP.prepare(cp.sites.SQL_SET_INDEX_STATE).bind(site.id, 'eligible', ctx.now),
    ctx.env.CP.prepare(cp.sites.SQL_SET_SITE_STATUS).bind(
      site.id,
      site.published_version_id === null ? 'draft' : 'published',
      ctx.now,
    ),
  ]);

  const live = await cp.subscriptions.listLiveSubscriptionsForOrg(ctx.env.CP, resolved.orgId);
  const first = live[0];
  if (first !== undefined) {
    const subscription = await ctx.stripe.subscriptions.retrieve(first.stripe_subscription_id, {
      expand: ['default_payment_method', 'items.data.price'],
    });
    const mirror = subscriptionMirror(subscription, {
      orgId: resolved.orgId,
      stripeCustomerId: first.stripe_customer_id,
      stripeUpdatedAt: ctx.eventCreatedMs,
      fallbackPriceId: ctx.env.STRIPE_PRICE_ID,
      nowMs: ctx.now,
    });
    statements.push(
      ...cp.subscriptions.subscriptionAndEntitlementStatements(ctx.env.CP, {
        subscription: mirror,
        entitlement: decideEntitlement({
          stripeStatus: subscription.status,
          trialEndMs: mirror.trialEnd,
          currentPeriodEndMs: mirror.currentPeriodEnd,
          endedAtMs: mirror.endedAt,
          canceledAtMs: mirror.canceledAt,
          nowMs: ctx.now,
          dunningGraceMs: DUNNING_GRACE_MS,
        }),
        now: ctx.now,
      }),
    );
  }

  await runBatch(ctx.env.CP, statements);
  return { orgId: resolved.orgId };
}

/**
 * `radar.early_fraud_warning.created`.
 *
 * Recorded and alerted, never auto-actioned. See the module header.
 */
export async function handleEarlyFraudWarning(
  ctx: HandlerContext,
  warning: Stripe.Radar.EarlyFraudWarning,
): Promise<HandlerOutcome> {
  const resolved = await organisationForCharge(ctx, idOf(warning.charge), null);
  if (resolved === null) {
    alert('org_unresolved', { event: ctx.event.id, type: ctx.event.type });
    return { orgId: null, skipped: 'org_unresolved' };
  }

  await recordAbuse(ctx.env, {
    kind: 'manual_report',
    severity: 'warn',
    orgId: resolved.orgId,
    siteId: null,
    detail: { reason: 'early_fraud_warning', fraudType: warning.fraud_type },
    now: ctx.now,
  });
  alert('early_fraud_warning', { warning: warning.id, org: resolved.orgId });

  return { orgId: resolved.orgId };
}

/**
 * `customer.updated` — keeps the tax evidence current after a portal edit.
 *
 * The VAT number is the customer's most recent `tax_ids` entry. `vat_validated_at` records when
 * Stripe validated it, not when we read it: on a cross-border EU B2B sale that timestamp is the
 * evidence behind a reverse-charge line, and back-dating it to "now" would be inventing evidence.
 */
export async function handleCustomerUpdated(
  ctx: HandlerContext,
  customer: Stripe.Customer,
): Promise<HandlerOutcome> {
  const resolved = await resolveOrganisation(ctx.env, { stripeCustomerId: customer.id });
  if (resolved === null) {
    alert('org_unresolved', { event: ctx.event.id, type: ctx.event.type, customer: customer.id });
    return { orgId: null, skipped: 'org_unresolved' };
  }

  const address = customer.address ?? null;
  const country = address?.country?.toUpperCase() ?? null;
  const taxId = customer.tax_ids?.data[0] ?? null;
  const existing = await cp.billing.getStripeCustomer(ctx.env.CP, customer.id);

  await runBatch(ctx.env.CP, [
    cp.billing.upsertStripeCustomerStatement(ctx.env.CP, {
      stripeCustomerId: customer.id,
      orgId: resolved.orgId,
      email: customer.email,
      // The card summary is owned by the subscription handlers, which see the expanded payment
      // method; re-writing it from a customer event would blank it.
      defaultPmBrand: existing?.default_pm_brand ?? null,
      defaultPmLast4: existing?.default_pm_last4 ?? null,
      defaultPmFingerprint: existing?.default_pm_fingerprint ?? null,
      taxCountry: country ?? existing?.tax_country ?? null,
      now: ctx.now,
    }),
    cp.billing.setOrgBillingProfileStatement(ctx.env.CP, {
      orgId: resolved.orgId,
      billingAddress: address === null ? null : JSON.stringify(address),
      country,
      vatNumber: taxId?.value ?? null,
      vatValidatedAt: taxId?.verification?.status === 'verified' ? ctx.eventCreatedMs : null,
      billingEmail: customer.email,
      now: ctx.now,
    }),
  ]);

  return { orgId: resolved.orgId };
}
