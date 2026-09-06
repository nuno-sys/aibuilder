import { cp } from '@aibuilder/db';
import type { OrganisationId } from '@aibuilder/db';

import type { Env } from './env';
import { stripeClient } from './stripe';
import { priorTrialForEmail } from './trials';

/**
 * The service-binding surface: creating a Checkout Session, reading one back, and minting a portal
 * link. None of this is reachable from the internet (see `index.ts`).
 *
 * THE PRICE IS NEVER ACCEPTED FROM A CALLER. `env.STRIPE_PRICE_ID` is the entire server-side
 * allowlist, and it is one id. A price that arrives in a request body is a price an attacker can
 * choose, and "€0,01 per year" is a valid Stripe price.
 *
 * THE IDEMPOTENCY KEY IS `cs:<jobId>:<attempt>`. A retried create for the same attempt returns the
 * SAME session rather than a second one, which matters because `apps/api` retries this call when
 * its own D1 write fails; a genuine re-mint (the customer abandoned Checkout and came back)
 * increments `checkout_attempts` and therefore changes the key.
 *
 * `customer_creation` and `customer_update` are deliberately NOT sent: the first is rejected in
 * `subscription` mode (where a Customer is always created), and the second is only accepted
 * alongside an existing `customer`.
 */

/** Stripe's minimum window, and the one this product uses. Thirty minutes. */
const SESSION_TTL_SECONDS = 1800;

/** What `apps/api` sends. Identifiers and the values it derived server-side; never a price. */
export interface CheckoutRequest {
  readonly orgId: OrganisationId;
  readonly jobId: string;
  readonly email: string;
  readonly emailNormalized: string;
  readonly businessName: string;
  readonly locale: string;
  readonly attempt: number;
}

/** What it gets back. `expiresAt` is epoch milliseconds, like every other timestamp here. */
export interface CheckoutCreated {
  readonly checkoutSessionId: string;
  readonly checkoutUrl: string;
  readonly expiresAt: number;
}

/** The refusal that is an identity decision rather than a payment one. */
export interface TrialAlreadyUsed {
  readonly error: 'trial_already_used';
}

/** Narrows an unknown request body into `CheckoutRequest`, or returns `null`. */
export function parseCheckoutRequest(body: unknown): CheckoutRequest | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const text = (key: string, max: number): string | null => {
    const value = record[key];
    return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
  };
  const orgId = text('orgId', 30);
  const jobId = text('jobId', 30);
  const email = text('email', 254);
  const emailNormalized = text('emailNormalized', 254);
  const businessName = text('businessName', 200);
  const locale = text('locale', 8);
  const attempt = record['attempt'];

  if (
    orgId === null ||
    !orgId.startsWith('org_') ||
    jobId === null ||
    email === null ||
    emailNormalized === null ||
    businessName === null ||
    locale === null ||
    typeof attempt !== 'number' ||
    !Number.isInteger(attempt) ||
    attempt < 0 ||
    attempt > 10
  ) {
    return null;
  }
  return {
    orgId: orgId as OrganisationId,
    jobId,
    email,
    emailNormalized,
    businessName,
    locale,
    attempt,
  };
}

/**
 * Creates the Checkout Session for one generation job.
 *
 * The e-mail prior-trial lookup runs here as well as in `apps/api` — defence in depth, because this
 * Worker owns the ledger and the API's call can be replayed. A hit refuses before any Stripe object
 * exists, which is the only point at which refusing is still free for everyone.
 */
export async function createCheckoutSession(
  env: Env,
  request: CheckoutRequest,
): Promise<CheckoutCreated | TrialAlreadyUsed> {
  const prior = await priorTrialForEmail(env, request.emailNormalized);
  if (prior.kind !== 'none') {
    return { error: 'trial_already_used' };
  }

  const stripe = await stripeClient(env);
  const expiresAtSeconds = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;

  const session = await stripe.checkout.sessions.create(
    {
      mode: 'subscription',
      line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
      // The bootstrap tenancy mapping. The durable one is the `stripe_customers` row that the
      // completed session writes; this is what lets the first event find its organisation at all.
      client_reference_id: request.orgId,
      customer_email: request.email,
      payment_method_types: ['card'],
      // `always` makes Checkout refuse to complete without a payment method; `cancel` makes Stripe
      // cancel rather than invoice if that method disappears before day 7. Together they are the
      // only end behaviour with a clean terminal state — `create_invoice` would leave us chasing an
      // unpaid €119,88 invoice from a business that never wanted the product.
      payment_method_collection: 'always',
      // Stripe Tax cannot compute without a customer location, and for electronically supplied
      // services the EU expects two non-contradicting pieces of evidence: this address, and the
      // card's issuing country.
      billing_address_collection: 'required',
      tax_id_collection: { enabled: true },
      automatic_tax: { enabled: true },
      consent_collection: { terms_of_service: 'required' },
      locale: 'nl',
      subscription_data: {
        trial_period_days: 7,
        trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
        description: request.businessName.slice(0, 500),
        metadata: { org_id: request.orgId, job_id: request.jobId },
      },
      metadata: { org_id: request.orgId, job_id: request.jobId },
      expires_at: expiresAtSeconds,
      // The return route reads the draft cookie and the job's own `checkout_session_id`; the
      // session id in this URL is never sufficient on its own.
      success_url: `${env.API_ORIGIN}/v1/billing/return?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.APP_ORIGIN}/start/?job=${request.jobId}&checkout=cancelled`,
    },
    { idempotencyKey: `cs:${request.jobId}:${request.attempt}`, maxNetworkRetries: 2 },
  );

  if (session.url === null) {
    // A `subscription`-mode session always carries a hosted URL. Treating its absence as a failure
    // rather than returning `""` keeps the caller's 402 honest.
    throw new Error('checkout session has no url');
  }

  return {
    checkoutSessionId: session.id,
    checkoutUrl: session.url,
    expiresAt: (session.expires_at ?? expiresAtSeconds) * 1000,
  };
}

/** What the return route needs to tell "paid" from "came back without paying". */
export interface CheckoutStatus {
  readonly status: 'complete' | 'expired' | 'open' | 'unknown';
  readonly paymentStatus: string;
  /**
   * The hosted Checkout URL, while the session is still open.
   *
   * Returned so a replayed submit can hand back the SAME live session instead of minting a second
   * one: the URL is not stored anywhere in this product — only the session id is — and a re-mint
   * that was not needed spends one of the job's five lifetime attempts.
   */
  readonly url: string | null;
}

/**
 * Reads a Checkout Session back from Stripe.
 *
 * Used by `GET /v1/billing/return` when the browser beats the webhook. It answers a question about
 * the BROWSER session only; it never writes billing state, because two writers of the same state
 * across two transports is how a double dispatch happens.
 */
export async function retrieveCheckoutStatus(env: Env, sessionId: string): Promise<CheckoutStatus> {
  const stripe = await stripeClient(env);
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  // Narrowed one literal at a time rather than by a set test: `Session.status` is an open string
  // in the SDK, and a widening `includes()` would let a future value through as itself.
  const status: CheckoutStatus['status'] =
    session.status === 'complete'
      ? 'complete'
      : session.status === 'expired'
        ? 'expired'
        : session.status === 'open'
          ? 'open'
          : 'unknown';
  return {
    status,
    // `no_payment_required` is the CORRECT value on a trial-start session: Checkout creates a
    // SetupIntent, not a PaymentIntent, so asserting `paid` here would reject every real trial.
    paymentStatus: session.payment_status,
    url: status === 'open' ? session.url : null,
  };
}

/**
 * Mints a customer-portal link.
 *
 * Cancellation, payment-method updates and invoice history are Stripe's portal and not a screen in
 * this product: a hand-rolled cancel flow has to reproduce proration, trial handling, dunning state
 * and invoice access, and every one of those is a place to get it subtly wrong against the system
 * of record. The URL is single-use and short-lived, so it is returned and never stored.
 */
export async function createPortalSession(env: Env, orgId: OrganisationId): Promise<string | null> {
  const customer = await cp.billing.getStripeCustomerByOrg(env.CP, orgId);
  if (customer === null) {
    return null;
  }
  const stripe = await stripeClient(env);
  const session = await stripe.billingPortal.sessions.create({
    customer: customer.stripe_customer_id,
    return_url: `${env.DASHBOARD_ORIGIN}/facturatie`,
    locale: 'nl',
  });
  return session.url;
}
