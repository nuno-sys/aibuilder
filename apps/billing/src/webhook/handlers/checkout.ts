import { cp, runBatch } from '@aibuilder/db';
import type { GenerationJobId, OrganisationId, SiteId, UserId } from '@aibuilder/db';
import type Stripe from 'stripe';

import { DUNNING_GRACE_MS, decideEntitlement } from '../../entitlement';
import type { Env } from '../../env';
import { abandonCheckout, getJobByCheckoutSession, releasePaidJob } from '../../jobs';
import type { PaymentAwareJobRow } from '../../jobs';
import {
  clampSubscriptionStatus,
  defaultCardFingerprint,
  defaultCardSummary,
  subscriptionMirror,
} from '../../mirror';
import { alert } from '../../ops';
import { hashFingerprint, priorTrialForCard } from '../../trials';
import { mintTrialGrantId } from '../../ids';
import { idOf, recordAbuse, resolveOrganisation } from '../context';
import type { HandlerContext, HandlerOutcome, ResolvedOrganisation } from '../context';

/**
 * `checkout.session.completed` — the ONE dispatcher of the generation Workflow, and
 * `checkout.session.expired` — the state fix for a customer who never finished.
 *
 * DECISIONS §D2 inverted the funnel: no Opus is spent before a card is on file. `POST
 * /v1/onboarding/submit` writes the job row with `payment_state='awaiting_payment'` and
 * `queue_ready_at IS NULL`, which the drain's partial index cannot see, and returns a Checkout URL.
 * The Workflow starts here and nowhere else. In particular it never starts on the `success_url`
 * redirect, which is a browser navigation, is not a payment guarantee, and can be skipped entirely
 * by closing the tab.
 *
 * THE WRITE ORDER IN THE CONTROL-PLANE BATCH IS A SCHEMA CONSTRAINT, NOT A PREFERENCE:
 *
 *   1. `stripe_customers` — `subscriptions.stripe_customer_id` REFERENCES it, so the parent row
 *      must exist inside the same atomic batch before the child is written.
 *   2. `subscriptions` + `organisations.entitlement` — one indivisible pair, always. The
 *      entitlement column is a denormalisation of subscription status and the only thing keeping it
 *      honest is that nothing can write one without the other.
 *   3. `memberships` — BEFORE the de-provision. `trg_orgs_deprovision_needs_member` aborts an
 *      organisation that would become reachable-and-billable with nobody able to sign in to it.
 *   4. `organisations.provisional = 0`.
 *   5. `sites.index_state = 'eligible'`.
 *   6. `trial_grants` — in the same batch as the entitlement, so a trial cannot be granted without
 *      being recorded. The ledger is what the next signup's prior-trial lookup reads.
 *
 * THE JOB RELEASE IS A SEPARATE, GUARDED WRITE. It lands on a shard, and no transaction spans two
 * D1 databases. `SQL_RELEASE_PAID_JOB` carries `AND payment_state = 'awaiting_payment'`, so a
 * redelivery changes zero rows and that is not an error — dispatch is idempotent on the job id, and
 * the Workflow instance id IS the job id, so a duplicate create answers 409 and counts as success.
 */

/** The generator's internal API. No public route exists; the service binding is the only path. */
const GENERATOR_ORIGIN = 'https://generator.internal';

/** Everything the batch needs that had to be read first. */
interface CheckoutFacts {
  readonly resolved: ResolvedOrganisation;
  readonly subscription: Stripe.Subscription;
  readonly stripeCustomerId: string;
  readonly job: PaymentAwareJobRow;
  readonly userId: UserId;
  readonly siteId: SiteId;
  readonly billingEmail: string;
  readonly emailNormalized: string;
}

/** Lowercases and trims an address the same way `apps/api`'s `normalizeEmail` does. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The address Stripe collected, in the order of decreasing reliability. */
function emailFromSession(session: Stripe.Checkout.Session): string | null {
  return session.customer_details?.email ?? session.customer_email ?? null;
}

/** The customer's country, which is half of the EU's two-piece tax evidence. */
function countryFromSession(session: Stripe.Checkout.Session): string | null {
  const country = session.customer_details?.address?.country ?? null;
  return country === null ? null : country.toUpperCase();
}

/**
 * Dispatches the Workflow.
 *
 * Identifiers only, in exactly the shape `apps/api` used to send: the generator holds both D1
 * bindings and reads the draft itself. A 409 counts as success — the instance id is the job id, so
 * a duplicate create means the run already exists, which is the outcome the caller wanted.
 */
async function dispatchGeneration(
  env: Env,
  args: {
    readonly jobId: GenerationJobId;
    readonly orgId: OrganisationId;
    readonly siteId: SiteId;
    readonly draftId: string;
    readonly shardId: number;
    readonly slug: string;
    readonly canonicalHost: string;
  },
): Promise<boolean> {
  try {
    const response = await env.GENERATOR.fetch(`${GENERATOR_ORIGIN}/v1/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    return response.ok || response.status === 409;
  } catch {
    return false;
  }
}

/**
 * Gathers everything the completion needs, or explains what is missing.
 *
 * Every identifier here is server-side. The job is found by `checkout_session_id`, which
 * `apps/api` wrote when it created the session; the user comes from the job's `created_by` and
 * falls back to the address Stripe confirmed. Session metadata is carried for disaster recovery and
 * is never read as authority.
 */
async function gatherFacts(
  ctx: HandlerContext,
  session: Stripe.Checkout.Session,
  subscription: Stripe.Subscription,
  resolved: ResolvedOrganisation,
  stripeCustomerId: string,
): Promise<CheckoutFacts | { readonly missing: string }> {
  const job = await getJobByCheckoutSession(resolved.shard, session.id);
  if (job === null) {
    return { missing: 'job_not_found' };
  }
  if (job.org_id !== resolved.orgId) {
    // The session's job belongs to a different tenant than the customer mapping resolved. That is
    // either a corrupted mapping or an attempt to cross tenants; either way it is never processed.
    return { missing: 'job_org_mismatch' };
  }

  const email = emailFromSession(session);
  if (email === null) {
    return { missing: 'no_email' };
  }
  const emailNormalized = normalizeEmail(email);

  let userId: UserId | null = job.created_by;
  if (userId === null) {
    const user = await cp.users.getUserByEmail(ctx.env.CP, emailNormalized);
    userId = user?.id ?? null;
  }
  if (userId === null) {
    return { missing: 'user_not_found' };
  }

  return {
    resolved,
    subscription,
    stripeCustomerId,
    job,
    userId,
    siteId: job.site_id,
    billingEmail: email,
    emailNormalized,
  };
}

/** What the fingerprint screen decided, and what the rest of the handler must do about it. */
interface TrialDecision {
  readonly subscription: Stripe.Subscription;
  /** `false` on the two paths where no Opus may be spent yet. */
  readonly releaseJob: boolean;
  readonly grantOutcome: 'granted' | 'refused';
  readonly abuseDetail: Readonly<Record<string, string>> | null;
}

/**
 * The card half of DECISIONS §D2's "e-mail AND `card.fingerprint`".
 *
 * A hit does NOT refuse. By the time the fingerprint exists, Checkout is complete, a Customer and a
 * Subscription exist in Stripe, and the person is sitting on the return page; cancelling silently
 * would punish the legitimate cases this signal cannot tell apart — a partner signing up a second
 * business on the company card, a bookkeeper paying for two clients. The trial is a RISK ALLOWANCE
 * against ~€1 of model spend, and a card that has already been charged has demonstrated it can be
 * charged again. So the trial ends immediately and Stripe invoices the year up front; the job is
 * released by `invoice.paid`, not here, so a failed charge spends nothing.
 *
 * The single exception is a card whose prior grant ended in a chargeback. That subscription is
 * cancelled outright: a card that has charged us back is not one we extend credit to.
 */
async function screenTrial(
  ctx: HandlerContext,
  subscription: Stripe.Subscription,
): Promise<TrialDecision> {
  const fingerprint = defaultCardFingerprint(subscription);
  const prior = await priorTrialForCard(ctx.env, fingerprint);

  if (prior.kind === 'none') {
    return { subscription, releaseJob: true, grantOutcome: 'granted', abuseDetail: null };
  }

  if (prior.kind === 'disputed') {
    const cancelled = await ctx.stripe.subscriptions.cancel(subscription.id);
    alert('disputed_card_refused', { subscription: subscription.id });
    return {
      subscription: cancelled,
      releaseJob: false,
      grantOutcome: 'refused',
      abuseDetail: { reason: 'prior_trial_fingerprint', outcome: 'refused_disputed_card' },
    };
  }

  const charged = await ctx.stripe.subscriptions.update(subscription.id, {
    trial_end: 'now',
    proration_behavior: 'none',
  });
  return {
    subscription: charged,
    releaseJob: false,
    grantOutcome: 'granted',
    abuseDetail: { reason: 'prior_trial_fingerprint', outcome: 'charged_immediately' },
  };
}

/** `checkout.session.completed`. See the module header for the ordering rules. */
export async function handleCheckoutCompleted(
  ctx: HandlerContext,
  payloadSession: Stripe.Checkout.Session,
): Promise<HandlerOutcome> {
  // RE-READ. The payload is a snapshot from when the event was created, and it carries
  // `subscription` as a bare id — the trial end, the price and the card fingerprint are simply not
  // in it (design §4.5).
  const session = await ctx.stripe.checkout.sessions.retrieve(payloadSession.id);

  if (session.status !== 'complete') {
    return { orgId: null, skipped: `session_status_${session.status ?? 'unknown'}` };
  }

  const stripeCustomerId = idOf(session.customer);
  const subscriptionId = idOf(session.subscription);
  if (stripeCustomerId === null || subscriptionId === null) {
    // `subscription` mode always creates both. A session without them is a mode this product does
    // not use, and acting on it would be acting on a guess.
    return { orgId: null, skipped: 'not_a_subscription_session' };
  }

  const resolved = await resolveOrganisation(ctx.env, {
    stripeCustomerId,
    clientReferenceId: session.client_reference_id,
  });
  if (resolved === null) {
    alert('org_unresolved', {
      event: ctx.event.id,
      type: ctx.event.type,
      customer: stripeCustomerId,
    });
    return { orgId: null, skipped: 'org_unresolved' };
  }

  const subscription = await ctx.stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['default_payment_method', 'items.data.price'],
  });

  const facts = await gatherFacts(ctx, session, subscription, resolved, stripeCustomerId);
  if ('missing' in facts) {
    // The customer has paid and we cannot find what they paid for. This is the one unresolved case
    // that is a support ticket rather than a shrug.
    alert('job_unresolved', { event: ctx.event.id, reason: facts.missing, org: resolved.orgId });
    return { orgId: resolved.orgId, skipped: facts.missing };
  }

  const trial = await screenTrial(ctx, subscription);
  const clamped = clampSubscriptionStatus(trial.subscription.status);
  if (!clamped.recognised) {
    alert('unknown_subscription_status', {
      event: ctx.event.id,
      status: trial.subscription.status,
      subscription: trial.subscription.id,
    });
  }

  const mirror = subscriptionMirror(trial.subscription, {
    orgId: resolved.orgId,
    stripeCustomerId,
    stripeUpdatedAt: ctx.eventCreatedMs,
    fallbackPriceId: ctx.env.STRIPE_PRICE_ID,
    nowMs: ctx.now,
  });
  const entitlement = decideEntitlement({
    stripeStatus: trial.subscription.status,
    trialEndMs: mirror.trialEnd,
    currentPeriodEndMs: mirror.currentPeriodEnd,
    endedAtMs: mirror.endedAt,
    canceledAtMs: mirror.canceledAt,
    nowMs: ctx.now,
    dunningGraceMs: DUNNING_GRACE_MS,
  });

  const card = defaultCardSummary(trial.subscription);
  const fingerprint = defaultCardFingerprint(trial.subscription);
  const fingerprintHash = fingerprint === null ? null : await hashFingerprint(ctx.env, fingerprint);

  // Read before write: `memberships` has no `ON CONFLICT` clause, and a batch is atomic — a
  // duplicate insert would roll the whole thing back on a redelivery whose claim had expired.
  const existingMembership = await cp.users.getMembership(ctx.env.CP, {
    userId: facts.userId,
    orgId: resolved.orgId,
  });

  const statements: D1PreparedStatement[] = [
    cp.billing.upsertStripeCustomerStatement(ctx.env.CP, {
      stripeCustomerId,
      orgId: resolved.orgId,
      email: facts.billingEmail,
      defaultPmBrand: card.brand,
      defaultPmLast4: card.last4,
      defaultPmFingerprint: fingerprint,
      taxCountry: countryFromSession(session) ?? resolved.organisation.country,
      now: ctx.now,
    }),
    ...cp.subscriptions.subscriptionAndEntitlementStatements(ctx.env.CP, {
      subscription: mirror,
      entitlement,
      now: ctx.now,
    }),
    ...(existingMembership === null
      ? [
          cp.users.insertMembershipStatement(ctx.env.CP, {
            orgId: resolved.orgId,
            userId: facts.userId,
            role: 'owner',
            invitedBy: null,
            acceptedAt: ctx.now,
            now: ctx.now,
          }),
        ]
      : []),
    cp.orgs.deprovisionOrganisationStatement(ctx.env.CP, {
      orgId: resolved.orgId,
      billingEmail: facts.billingEmail,
      now: ctx.now,
    }),
    // `eligible`, never `indexable`: §7.26 still requires a passing quality gate before a generated
    // site may be indexed. Card-on-file is now a precondition of the site existing at all, so this
    // promotion no longer waits for it (DECISIONS §D2).
    ctx.env.CP.prepare(cp.sites.SQL_SET_INDEX_STATE).bind(facts.siteId, 'eligible', ctx.now),
    cp.billing.insertTrialGrantStatement(ctx.env.CP, {
      id: mintTrialGrantId(),
      emailNormalized: facts.emailNormalized,
      cardFingerprintSha256: fingerprintHash,
      orgId: resolved.orgId,
      stripeCustomerId,
      stripeSubscriptionId: trial.subscription.id,
      outcome: trial.grantOutcome,
      now: ctx.now,
    }),
  ];

  await runBatch(ctx.env.CP, statements);

  if (trial.abuseDetail !== null) {
    await recordAbuse(ctx.env, {
      kind: 'quota_exceeded',
      severity: 'warn',
      orgId: resolved.orgId,
      siteId: facts.siteId,
      detail: trial.abuseDetail,
      now: ctx.now,
    });
  }

  if (!trial.releaseJob) {
    // Charged immediately, or refused. `invoice.paid` releases the job when the money actually
    // arrives; until then no Opus is spent.
    return { orgId: resolved.orgId, skipped: 'awaiting_immediate_charge' };
  }

  await releaseAndDispatch(ctx.env, resolved.shard, facts.job, resolved.orgId, ctx.now);
  return { orgId: resolved.orgId };
}

/**
 * Releases a paid job and dispatches its Workflow.
 *
 * Exported because `invoice.paid` performs the same two steps for the trial-converted-immediately
 * path, and there must be exactly one implementation of "the job may now spend money".
 */
export async function releaseAndDispatch(
  env: Env,
  shard: D1Database,
  job: PaymentAwareJobRow,
  orgId: OrganisationId,
  now: number,
): Promise<void> {
  const site = await cp.sites.getLiveSite(env.CP, job.site_id);
  if (site === null) {
    alert('job_unresolved', { reason: 'site_missing', job: job.id, org: orgId });
    return;
  }

  // `changes === 0` means a redelivery already released it. Not an error, and the dispatch below
  // still runs: it is idempotent on the job id, and a lost dispatch is worse than a duplicate 409.
  await releasePaidJob(shard, { jobId: job.id, now });

  const dispatched = await dispatchGeneration(env, {
    jobId: job.id,
    orgId,
    siteId: job.site_id,
    draftId: job.draft_id ?? '',
    shardId: site.shard_id,
    slug: site.slug,
    canonicalHost: site.canonical_host,
  });
  if (!dispatched) {
    // The job row is queued and durable, so the generator's drain picks it up on its next pass.
    // This is a deferral, not a loss, and the operator is told because the customer has paid.
    alert('dispatch_failed', { job: job.id, org: orgId });
  }
}

/**
 * `checkout.session.expired` — the customer did not finish inside the 30-minute window.
 *
 * A STATE FIX, NOT A STORAGE FIX. It exists so the UI can tell "we are waiting for Stripe" apart
 * from "you did not finish", and so a resume mints a fresh session instead of linking to a dead
 * one. Storage is reclaimed by the 30-day provisional-organisation purge. Nothing is written to the
 * control plane: no Customer was ever created, because `subscription` mode creates one only when
 * the session completes.
 */
export async function handleCheckoutExpired(
  ctx: HandlerContext,
  session: Stripe.Checkout.Session,
): Promise<HandlerOutcome> {
  const resolved = await resolveOrganisation(ctx.env, {
    stripeCustomerId: idOf(session.customer),
    clientReferenceId: session.client_reference_id,
  });
  if (resolved === null) {
    alert('org_unresolved', { event: ctx.event.id, type: ctx.event.type });
    return { orgId: null, skipped: 'org_unresolved' };
  }

  const job = await getJobByCheckoutSession(resolved.shard, session.id);
  if (job === null) {
    // Already superseded by a re-minted session, which cleared the column. Nothing to do.
    return { orgId: resolved.orgId, skipped: 'job_not_found' };
  }

  await abandonCheckout(resolved.shard, {
    jobId: job.id,
    checkoutSessionId: session.id,
    now: ctx.now,
  });
  return { orgId: resolved.orgId };
}
