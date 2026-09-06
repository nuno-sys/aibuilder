import { isId, mintId } from '@aibuilder/core';
import { cp, shardById } from '@aibuilder/db';
import type { OrganisationId, OrganisationRow, SiteId } from '@aibuilder/db';
import type Stripe from 'stripe';

import type { Env } from '../env';

/**
 * What every handler is handed, and how an event is turned into an organisation.
 *
 * THE RESOLUTION ORDER IS THE AUTHORISATION MODEL (design §3.5):
 *
 *   `stripe_customers.org_id`  →  (first event only) `client_reference_id`  →  give up
 *
 * `client_reference_id` is set by this product when it creates the Checkout Session and exists only
 * on `checkout.session.*`. The durable mapping is the `stripe_customers` row that the first
 * completed session writes, and every later event resolves through it. Metadata is never in this
 * chain: it is editable from the Stripe Dashboard by anyone with access, and an authorisation
 * decision a Dashboard user can edit is not an authorisation decision.
 *
 * GIVING UP MEANS 200, NOT 500. An event whose organisation nothing resolves is recorded
 * `status='skipped'`, `org_id IS NULL`, alerted to an operator, and acknowledged. Retrying for
 * three days cannot make an organisation appear, and letting Stripe disable the endpoint over one
 * unresolvable event would take billing down for every other tenant.
 */

/** Everything a handler needs that is not the event's own object. */
export interface HandlerContext {
  readonly env: Env;
  readonly stripe: Stripe;
  readonly event: Stripe.Event;
  /** `event.created * 1000`. The mirror's ordering guard compares against this, not the clock. */
  readonly eventCreatedMs: number;
  readonly now: number;
}

/** What a handler reports back to the dispatcher. */
export interface HandlerOutcome {
  /** Attached to the ledger row on completion, so an event can be traced to its tenant. */
  readonly orgId: OrganisationId | null;
  /** Set when the event was recognised but deliberately not acted on. */
  readonly skipped?: string;
}

/** An organisation, its shard binding, and the customer id the event arrived under. */
export interface ResolvedOrganisation {
  readonly orgId: OrganisationId;
  readonly organisation: OrganisationRow;
  readonly shard: D1Database;
  readonly stripeCustomerId: string | null;
}

/** Reads `.id` off a Stripe field that is either an id or an expanded object. */
export function idOf(value: string | { readonly id: string } | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === 'string' ? value : value.id;
}

/**
 * Resolves the organisation an event belongs to.
 *
 * `clientReferenceId` is only ever passed by a `checkout.session.*` handler; every other event
 * resolves through the customer mapping alone, which is what makes a stolen or edited metadata
 * field worthless.
 */
export async function resolveOrganisation(
  env: Env,
  args: {
    readonly stripeCustomerId: string | null;
    readonly clientReferenceId?: string | null;
  },
): Promise<ResolvedOrganisation | null> {
  let orgId: OrganisationId | null = null;

  if (args.stripeCustomerId !== null) {
    const customer = await cp.billing.getStripeCustomer(env.CP, args.stripeCustomerId);
    orgId = customer?.org_id ?? null;
  }

  if (orgId === null) {
    const reference = args.clientReferenceId ?? null;
    // Shape-checked before it is used as a key. A `client_reference_id` is ours, but it arrives
    // over the internet, and a prefixed-ULID check is one string comparison.
    orgId = reference !== null && isId('organisation', reference) ? reference : null;
  }

  if (orgId === null) {
    return null;
  }

  const organisation = await cp.orgs.getOrganisation(env.CP, orgId);
  if (organisation === null || organisation.deleted_at !== null) {
    return null;
  }

  return {
    orgId,
    organisation,
    // The shard binding always comes from the STORED `shard_id`, never from a recomputation: an
    // organisation's shard is assigned once and a rehash would address the wrong database.
    shard: shardById(organisation.shard_id, env),
    stripeCustomerId: args.stripeCustomerId,
  };
}

/**
 * Records one abuse signal.
 *
 * Fire-and-forget by the same rule the API applies: telemetry that cannot be written is an ops
 * problem, never a reason to fail a webhook Stripe would then retry for three days.
 *
 * `kind` deliberately reuses the existing vocabulary rather than adding a value — widening
 * `CHECK (kind IN (…))` on `abuse_events` is a table rebuild, and a rebuild for a label is a bad
 * trade. The specific reason travels in `detail`.
 */
export async function recordAbuse(
  env: Env,
  args: {
    readonly kind: 'quota_exceeded' | 'manual_report';
    readonly severity: 'info' | 'warn' | 'block';
    readonly orgId: OrganisationId;
    readonly siteId: SiteId | null;
    readonly detail: Readonly<Record<string, string>>;
    readonly now: number;
  },
): Promise<void> {
  /** Ninety days, matching the retention the API applies to every other abuse signal. */
  const retentionMs = 90 * 24 * 60 * 60 * 1000;
  try {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`org${args.orgId}`),
    );
    await cp.quotas.insertAbuseEvent(env.CP, {
      ulid: mintId('abuseEvent'),
      kind: args.kind,
      severity: args.severity,
      subjectType: 'org',
      subjectHash: new Uint8Array(digest),
      siteId: args.siteId,
      orgId: args.orgId,
      detail: JSON.stringify(args.detail),
      now: args.now,
      purgeAfter: args.now + retentionMs,
    });
  } catch {
    // Intentionally swallowed; see the JSDoc.
  }
}
