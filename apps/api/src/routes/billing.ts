import { cp, shard, shardById } from '@aibuilder/db';
import type {
  GenerationJobId,
  GenerationJobRow,
  OnboardingDraftRow,
  OrganisationId,
  SessionId,
  Timestamp,
  UserId,
} from '@aibuilder/db';
import { Hono } from 'hono';
import { monotonicFactory } from 'ulid';

import type { AppEnv, Env } from '../env';
import { toBase64Url } from '../lib/encoding';
import {
  SESSION_COOKIE_NAME,
  gateFailure,
  requireEntitlement,
  sessionFromRequest,
} from '../lib/entitlement';
import { errorResponse, jsonResponse, notFoundResponse } from '../lib/responses';
import { clientIp, hashIp, toHex } from '../lib/subjects';
import { loadAnonSession, requireAnonSession } from '../middleware/draft-cookie';
import { currentDraft } from './drafts';

/**
 * The browser-facing half of billing: the Checkout return, the Checkout re-mint, and the portal.
 *
 * WHAT THIS FILE IS NOT ALLOWED TO DO. It never dispatches the Workflow, never writes
 * `payment_state`, never writes `subscriptions`, and never creates a membership. Everything that
 * mutates billing state belongs to the `checkout.session.completed` webhook, and to exactly one
 * code path, because two writers of the same state across two transports is how a double dispatch
 * happens. A `success_url` redirect is a browser navigation: the customer can close the tab before
 * it fires, an attacker can fabricate one, and neither fact may change what the product believes
 * about money.
 *
 * WHAT IT DOES DO. It unlocks the BROWSER SESSION when Stripe confirms a completed session for a
 * job the caller already owns, which is a different concern from entitlement and is safe to decide
 * here. The pair we act on is possession of the draft cookie AND a completed session whose id the
 * job row already names — never the `session_id` alone, which travels in a URL and can be
 * shoulder-surfed.
 */

/** The internal host of the billing Worker. Not in any zone; unreachable from the internet. */
const BILLING_ORIGIN = 'https://billing.internal';

/** Thirty days, matching the anonymous window it sits beside. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** `user_agent` columns cap at 512 characters. */
const USER_AGENT_MAX = 512;

/** Stripe's own id shape. A `session_id` that does not match it is never sent to Stripe. */
const SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]{8,64}$/u;

/**
 * How many Checkout Sessions one job may ever have.
 *
 * The re-mint route is otherwise a free Checkout-Session generator, which is what a card tester
 * wants. Five is generous for the honest case — abandon, come back tomorrow, mistype a card — and
 * uninteresting for the abusive one, especially behind `RL_CHECKOUT`'s 3-per-minute-per-IP.
 */
export const MAX_CHECKOUT_ATTEMPTS = 5;

/**
 * Session ids are minted here rather than through `@aibuilder/core`'s `mintId`.
 *
 * PHASE 2 NOTE (handover): design §8.4 adds `session: 'ses'` to `ID_PREFIXES`, at which point this
 * and the identical helper in `claim.ts` both become `mintId('session')`. Until then the prefix is
 * spelled out where it is used, which is exactly what `claim.ts` already does and for the same
 * reason. The body is a monotonic ULID, which is what `CHECK (id GLOB 'ses_[0-7]*')` requires.
 */
const nextUlid = monotonicFactory();

/** Mints a `ses_…` id satisfying the sessions table's id CHECK. */
function mintSessionId(): SessionId {
  return `ses_${nextUlid()}`;
}

// ------------------------------------------------------------------------------------------------
// The payment columns of `generation_jobs`
// ------------------------------------------------------------------------------------------------

/**
 * PHASE 2 NOTE (handover): design §8.3 puts the four statements below in
 * `packages/db/src/shard/generation-jobs.ts`, where the EXPLAIN QUERY PLAN gate can see them, and
 * the four columns on `GenerationJobRow` in `packages/db/src/types.ts`. They live here because they
 * arrive with `migrations/shard/0007_billing_gate.sql`, which is not this file's change to make;
 * the SQL text is written to be moved verbatim.
 */

/** Where a job sits in the payment funnel. Orthogonal to `status`. */
export type PaymentState = 'not_required' | 'awaiting_payment' | 'paid' | 'abandoned';

/** `generation_jobs`, with the columns `0007_billing_gate.sql` adds. */
export interface PaymentAwareJobRow extends GenerationJobRow {
  readonly payment_state: PaymentState;
  readonly checkout_session_id: string | null;
  readonly payment_deadline_at: Timestamp | null;
  readonly checkout_attempts: number;
}

/**
 * The job row a trial-first submit writes.
 *
 * Four values differ from `SQL_INSERT_GENERATION_JOB` and each is load-bearing:
 * `requires_entitlement = 1` because DECISIONS §D2 gates everything; `queue_ready_at = NULL`
 * because the sentinel is what the drain seeks, so a NULL means "exists, not runnable";
 * `payment_state = 'awaiting_payment'` because `status` cannot express it — widening
 * `CHECK (status IN (…))` is a rebuild of a cascade parent, which D1 cannot do safely; and
 * `checkout_attempts = 1`, because submit is about to create the job's first Checkout Session and
 * an attempt counted only after a successful create is not a cap.
 *
 * Bound parameters, in order: id, org_id, site_id, draft_id, idempotency_key, prompt_sha256,
 * budget_reserved_micro, created_by, payment_deadline_at, now.
 */
export const SQL_INSERT_GENERATION_JOB_AWAITING_PAYMENT = `
INSERT INTO generation_jobs (id, org_id, site_id, draft_id, kind, requires_entitlement, status,
                             idempotency_key, queue_ready_at, prompt_sha256, cache_prefix_sha256,
                             budget_reserved_micro, created_by, payment_state,
                             payment_deadline_at, checkout_attempts, queued_at, created_at,
                             updated_at)
VALUES (?1, ?2, ?3, ?4, 'initial_site', 1, 'queued', ?5, NULL, ?6, NULL, ?7, ?8,
        'awaiting_payment', ?9, 1, ?10, ?10, ?10)
`;

/**
 * Attaches a Checkout Session to a job.
 *
 * `changes === 0` means the webhook already won the race — the customer paid before this statement
 * landed, which is possible because Stripe is fast. That is not an error; the caller re-reads and
 * answers with whatever `payment_state` the row now holds.
 */
export const SQL_ATTACH_CHECKOUT_SESSION = `
UPDATE generation_jobs
SET checkout_session_id = ?2, payment_deadline_at = ?3, payment_state = 'awaiting_payment',
    updated_at = ?4
WHERE id = ?1 AND payment_state IN ('awaiting_payment','abandoned')
`;

/** Counts one minted Checkout Session against the job's lifetime cap. */
export const SQL_BUMP_CHECKOUT_ATTEMPTS = `
UPDATE generation_jobs
SET checkout_attempts = checkout_attempts + 1, updated_at = ?2
WHERE id = ?1 AND checkout_attempts < ?3
`;

/**
 * Reads a job row including the payment columns.
 *
 * Deliberately re-uses `SQL_GET_GENERATION_JOB` rather than declaring a second `SELECT *` with the
 * same text: one statement per operation is what makes the EXPLAIN QUERY PLAN gate's inventory
 * meaningful, and the extra columns come back on the same row.
 */
export async function getPaymentJob(
  db: D1Database,
  jobId: GenerationJobId,
): Promise<PaymentAwareJobRow | null> {
  return db
    .prepare(shard.generationJobs.SQL_GET_GENERATION_JOB)
    .bind(jobId)
    .first<PaymentAwareJobRow>();
}

// ------------------------------------------------------------------------------------------------
// The billing Worker, over the service binding
// ------------------------------------------------------------------------------------------------

/** What `apps/billing` answers `POST /v1/checkout-sessions` with. */
export interface CheckoutSessionCreated {
  readonly checkoutSessionId: string;
  readonly checkoutUrl: string;
  readonly expiresAt: number;
}

/** Every way asking for a Checkout Session can end. */
export type CheckoutOutcome =
  | { readonly kind: 'created'; readonly session: CheckoutSessionCreated }
  /** The address has had a trial. An identity decision, not a payment one; the caller answers 409. */
  | { readonly kind: 'trial_already_used' }
  /** Stripe or the billing Worker is unavailable. The job survives; the customer can resume. */
  | { readonly kind: 'unavailable' }
  /** The job has had its five sessions. A human decides whether it gets a sixth. */
  | { readonly kind: 'exhausted' }
  /** The webhook won the race, or this job never needed a payment. */
  | { readonly kind: 'already_paid'; readonly paymentState: PaymentState };

/**
 * Asks `apps/billing` for a Checkout Session.
 *
 * This Worker never holds `STRIPE_SECRET_KEY` and never will — capability separation on Workers
 * means splitting Workers (architecture §8). Identifiers and server-derived values only; the price
 * is not a parameter, because a price a caller can choose is a price an attacker can choose.
 */
export async function createCheckoutSession(
  env: Env,
  args: {
    readonly orgId: OrganisationId;
    readonly jobId: GenerationJobId;
    readonly email: string;
    readonly emailNormalized: string;
    readonly businessName: string;
    readonly locale: string;
    readonly attempt: number;
  },
): Promise<CheckoutOutcome> {
  try {
    const response = await env.BILLING.fetch(`${BILLING_ORIGIN}/v1/checkout-sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (response.status === 409) {
      return { kind: 'trial_already_used' };
    }
    if (!response.ok) {
      return { kind: 'unavailable' };
    }
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) {
      return { kind: 'unavailable' };
    }
    const record = body as Record<string, unknown>;
    const checkoutSessionId = record['checkoutSessionId'];
    const checkoutUrl = record['checkoutUrl'];
    const expiresAt = record['expiresAt'];
    if (
      typeof checkoutSessionId !== 'string' ||
      typeof checkoutUrl !== 'string' ||
      typeof expiresAt !== 'number'
    ) {
      return { kind: 'unavailable' };
    }
    return { kind: 'created', session: { checkoutSessionId, checkoutUrl, expiresAt } };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** What Stripe says about a session right now, read through the billing Worker. */
export interface CheckoutSessionStatus {
  readonly status: 'complete' | 'expired' | 'open' | 'unknown';
  /** The hosted URL, present only while the session is open. Never stored. */
  readonly url: string | null;
}

/** Reads a Checkout Session's current status. `null` when the billing Worker cannot answer. */
async function readCheckoutStatus(
  env: Env,
  sessionId: string,
): Promise<CheckoutSessionStatus | null> {
  try {
    const response = await env.BILLING.fetch(`${BILLING_ORIGIN}/v1/checkout-sessions/${sessionId}`);
    if (!response.ok) {
      return null;
    }
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) {
      return null;
    }
    const record = body as Record<string, unknown>;
    const status = record['status'];
    const url = record['url'];
    const href = typeof url === 'string' ? url : null;
    return status === 'complete' || status === 'expired' || status === 'open'
      ? { status, url: href }
      : { status: 'unknown', url: null };
  } catch {
    return null;
  }
}

/**
 * Gives a job a Checkout Session it can be sent to, re-using the live one where there is one.
 *
 * THE RE-USE IS NOT AN OPTIMISATION. This product stores the session ID and never the hosted URL,
 * so a replayed submit has nothing to hand back unless it asks Stripe. Minting a second session
 * instead would spend one of the job's five lifetime attempts on a customer who simply refreshed
 * the page, and would leave a live session behind that `checkout.session.expired` later reports on
 * a job that has moved on.
 *
 * Every mint is counted BEFORE Stripe is called: a create that succeeds and then fails to be
 * recorded must still have cost an attempt, or the cap is not a cap.
 */
export async function ensureCheckoutSession(
  env: Env,
  args: {
    readonly draft: OnboardingDraftRow;
    readonly job: PaymentAwareJobRow;
    readonly orgId: OrganisationId;
    readonly db: D1Database;
  },
): Promise<CheckoutOutcome> {
  const { db, job } = args;

  if (job.payment_state === 'paid' || job.payment_state === 'not_required') {
    return { kind: 'already_paid', paymentState: job.payment_state };
  }

  const now = Date.now();
  if (job.checkout_session_id !== null && (job.payment_deadline_at ?? 0) > now) {
    const live = await readCheckoutStatus(env, job.checkout_session_id);
    if (live !== null && live.status === 'open' && live.url !== null) {
      return {
        kind: 'created',
        session: {
          checkoutSessionId: job.checkout_session_id,
          checkoutUrl: live.url,
          expiresAt: job.payment_deadline_at ?? now,
        },
      };
    }
  }

  if (args.draft.contact_email === null || args.draft.business_name === null) {
    // A submitted draft always carries both; without them Stripe would refuse the session anyway.
    return { kind: 'unavailable' };
  }

  const bumped = await db
    .prepare(SQL_BUMP_CHECKOUT_ATTEMPTS)
    .bind(job.id, now, MAX_CHECKOUT_ATTEMPTS)
    .run();
  if (bumped.meta.changes !== 1) {
    return { kind: 'exhausted' };
  }

  const outcome = await createCheckoutSession(env, {
    orgId: args.orgId,
    jobId: job.id,
    email: args.draft.contact_email,
    emailNormalized: args.draft.contact_email.trim().toLowerCase(),
    businessName: args.draft.business_name,
    // `default_locale` is nullable until the intake's locale step is reached; the UI locale is
    // NOT NULL and is what Checkout should be rendered in either way.
    locale: args.draft.default_locale ?? args.draft.ui_locale,
    attempt: job.checkout_attempts + 1,
  });
  if (outcome.kind !== 'created') {
    return outcome;
  }

  const attached = await db
    .prepare(SQL_ATTACH_CHECKOUT_SESSION)
    .bind(job.id, outcome.session.checkoutSessionId, outcome.session.expiresAt, now)
    .run();
  if (attached.meta.changes !== 1) {
    // The webhook released the job between the create and this write — possible, Stripe is fast.
    // The session is harmless (it expires unused) and the customer is already paid up.
    const current = await getPaymentJob(db, job.id);
    return {
      kind: 'already_paid',
      paymentState: current?.payment_state ?? 'paid',
    };
  }

  return outcome;
}

// ------------------------------------------------------------------------------------------------
// Routes
// ------------------------------------------------------------------------------------------------

export const billingRoutes = new Hono<AppEnv>();

/** A 303 that stores nothing. Every branch of the return route answers with one. */
function seeOther(location: string, cookies: readonly string[] = []): Response {
  const headers = new Headers({ location, 'cache-control': 'private, no-store' });
  for (const cookie of cookies) {
    headers.append('set-cookie', cookie);
  }
  return new Response(null, { status: 303, headers });
}

/**
 * Mints a fresh browser session for the customer who has just paid.
 *
 * SESSION FIXATION. The session is minted, never derived from the anonymous token: an attacker who
 * planted a known `__Host-aib_draft` value in someone's browser must not end up holding a cookie
 * that is now authenticated as them. That is the same defence `GET /claim` applies.
 *
 * THE DRAFT COOKIE IS DELIBERATELY NOT CLEARED, which is the one place this differs from `claim`.
 * There, the person who proved the e-mail may not be the person holding the cookie. Here the draft
 * cookie IS what authorised the exchange, and it is a draft capability rather than an
 * authentication credential — the SSE stream and the generation theatre still authorise on it, and
 * destroying it mid-generation would break the one screen the customer is looking at.
 *
 * The organisation may still be provisional at this instant, so the minted session's
 * `active_org_id` points at an organisation with zero memberships — which every authenticated path
 * treats as unreachable. That is correct: the customer holds an identity, and it grants nothing
 * until the webhook creates the membership.
 */
async function mintBrowserSession(
  env: Env,
  request: Request,
  args: { readonly userId: UserId; readonly orgId: OrganisationId },
): Promise<string> {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const digest = await crypto.subtle.digest('SHA-256', tokenBytes);
  const ip = clientIp(request);
  const now = Date.now();

  await cp.users.insertSession(env.CP, {
    tokenHash: new Uint8Array(digest),
    id: mintSessionId(),
    userId: args.userId,
    activeOrgId: args.orgId,
    ipHash: ip === null ? null : await hashIp(env, ip),
    userAgent: (request.headers.get('User-Agent') ?? '').slice(0, USER_AGENT_MAX) || null,
    now,
    expiresAt: now + SESSION_TTL_MS,
  });

  return (
    `${SESSION_COOKIE_NAME}=${toBase64Url(tokenBytes)}; ` +
    `Max-Age=${String(Math.floor(SESSION_TTL_MS / 1000))}; Path=/; Secure; HttpOnly; SameSite=Lax`
  );
}

/**
 * `GET /v1/billing/return?session_id=cs_…` — where Stripe sends the browser back.
 *
 * Every branch answers 303. The route is entered by a top-level navigation from Stripe, so there is
 * no JSON client to read a body, and a redirect is the only thing a browser can act on.
 */
billingRoutes.get('/return', async (c) => {
  const startUrl = `${c.env.APP_ORIGIN}/start/`;
  const sessionId = c.req.query('session_id') ?? '';

  const anonSession = await loadAnonSession(c.env, c.req.header('Cookie'));
  if (anonSession === null || !SESSION_ID_PATTERN.test(sessionId)) {
    // The `session_id` alone is never sufficient: it appears in a URL, and possession of a URL is
    // not possession of the draft it belongs to.
    return seeOther(startUrl);
  }

  const draft = await currentDraft(c.env, anonSession);
  if (draft === null || draft.generation_job_id === null || draft.org_id === null) {
    return seeOther(startUrl);
  }

  const db = shardById(draft.shard_id, c.env);
  const job = await getPaymentJob(db, draft.generation_job_id);
  if (job === null || job.checkout_session_id !== sessionId) {
    // The draft cookie proves ownership of the draft, the draft owns exactly one job, and the job
    // names exactly one session. All three have to agree.
    return seeOther(startUrl);
  }

  const jobUrl = `${startUrl}?job=${job.id}`;

  if (job.payment_state === 'paid') {
    return seeOther(jobUrl, await sessionCookies(c.env, c.req.raw, job, draft));
  }
  if (job.payment_state === 'abandoned') {
    return seeOther(`${jobUrl}&checkout=expired`);
  }
  if (job.payment_state !== 'awaiting_payment') {
    return seeOther(startUrl);
  }

  // THE RACE. The browser is here and the webhook is not. Stripe is asked what it knows; whatever
  // it says, this route only ever unlocks the browser session.
  const status = await readCheckoutStatus(c.env, sessionId);
  if (status === null) {
    // The billing Worker could not answer. The job is durable and the theatre has an honest state
    // for exactly this, so the customer goes there rather than to an error page.
    return seeOther(`${jobUrl}&payment=confirming`);
  }
  switch (status.status) {
    case 'complete':
      return seeOther(
        `${jobUrl}&payment=confirming`,
        await sessionCookies(c.env, c.req.raw, job, draft),
      );
    case 'expired':
      return seeOther(`${jobUrl}&checkout=expired`);
    default:
      return seeOther(`${jobUrl}&checkout=cancelled`);
  }
});

/** The session cookie, or none when the job carries no user to mint one for. */
async function sessionCookies(
  env: Env,
  request: Request,
  job: PaymentAwareJobRow,
  draft: OnboardingDraftRow,
): Promise<readonly string[]> {
  const userId = job.created_by;
  const orgId = draft.org_id;
  if (userId === null || orgId === null) {
    return [];
  }
  return [await mintBrowserSession(env, request, { userId, orgId })];
}

/**
 * `POST /v1/billing/checkout/:jobId` — mint a Checkout Session for a job that has none.
 *
 * The resume path for an abandoned or expired Checkout, and the recovery path for a submit whose
 * session creation failed. Rate-limited per IP and capped per job for the reason in
 * `MAX_CHECKOUT_ATTEMPTS`.
 */
billingRoutes.post('/checkout/:jobId', requireAnonSession, async (c) => {
  const ip = clientIp(c.req.raw);
  const key = ip === null ? 'RL_CHECKOUT:no-ip' : `RL_CHECKOUT:${toHex(await hashIp(c.env, ip))}`;
  // Called directly rather than through `rateLimitByIp`, whose `RateLimitBindingName` is a closed
  // alias in `src/env.ts`; the middleware picks this binding up when that alias is widened. A
  // binding that throws is treated as a pass, exactly as `consumeRateLimit` does: this layer is an
  // optimisation in front of the per-job cap, which is the one that actually enforces.
  const allowed = await c.env.RL_CHECKOUT.limit({ key })
    .then((outcome) => outcome.success)
    .catch(() => true);
  if (!allowed) {
    return errorResponse(
      429,
      'rate_limited',
      'Je gaat iets te snel. Probeer het over een minuut opnieuw.',
      'That was a bit quick. Please try again in a minute.',
      { retryAfterSeconds: 60 },
      { 'retry-after': '60' },
    );
  }

  const draft = await currentDraft(c.env, c.get('anonSession'));
  if (draft === null || draft.generation_job_id === null || draft.org_id === null) {
    return errorResponse(
      404,
      'no_draft',
      'We konden je aanvraag niet vinden.',
      'We could not find your request.',
    );
  }
  if (draft.generation_job_id !== c.req.param('jobId')) {
    // The job id in the path must be the one this draft owns. Possession of a job id proves nothing.
    return notFoundResponse();
  }

  const db = shardById(draft.shard_id, c.env);
  const job = await getPaymentJob(db, draft.generation_job_id);
  if (job === null) {
    return notFoundResponse();
  }

  const outcome = await ensureCheckoutSession(c.env, {
    draft,
    job,
    orgId: draft.org_id,
    db,
  });
  return checkoutOutcomeResponse(c.env, job.id, outcome);
});

/**
 * The one place a `CheckoutOutcome` becomes HTTP.
 *
 * Exported because `POST /v1/onboarding/submit` answers its replay path with exactly these bodies,
 * and two hand-written copies of a status-code table drift.
 */
export function checkoutOutcomeResponse(
  env: Env,
  jobId: GenerationJobId,
  outcome: CheckoutOutcome,
): Response {
  switch (outcome.kind) {
    case 'created':
      return jsonResponse(
        {
          jobId,
          paymentState: 'awaiting_payment',
          checkoutUrl: outcome.session.checkoutUrl,
          checkoutExpiresAt: outcome.session.expiresAt,
        },
        200,
      );
    case 'already_paid':
      return jsonResponse({ jobId, paymentState: outcome.paymentState }, 200);
    case 'trial_already_used':
      return trialAlreadyUsedResponse(env);
    case 'exhausted':
      return errorResponse(
        429,
        'checkout_attempts_exhausted',
        'Je hebt te vaak een betaallink aangevraagd. Neem contact met ons op.',
        'You have requested a payment link too many times. Please contact us.',
        { jobId },
      );
    case 'unavailable':
      return errorResponse(
        402,
        'checkout_unavailable',
        'We konden de betaalpagina niet openen. Probeer het zo nog eens.',
        'We could not open the payment page. Please try again shortly.',
        { jobId },
      );
  }
}

/**
 * `POST /v1/billing/portal` — a link into Stripe's customer portal.
 *
 * `owner` only: cancelling a subscription and changing a card are the two most consequential
 * actions an account has, and an editor who can rewrite a page has no business doing either.
 * Entitlement is deliberately NOT required — a `past_due` or `canceled` customer needs this page
 * more than anyone, and refusing it would be the product's worst possible catch-22.
 */
billingRoutes.post('/portal', async (c) => {
  const session = await sessionFromRequest(c.env, c.req.raw);
  if (session === null || session.active_org_id === null) {
    return gateFailure(c.env, 'no_session');
  }
  const gate = await requireEntitlement(c.env, session, session.active_org_id, {
    minRole: 'owner',
    allow: ['none', 'trialing', 'active', 'past_due', 'canceled'],
  });
  if (typeof gate === 'string') {
    return gateFailure(c.env, gate);
  }

  try {
    const response = await c.env.BILLING.fetch(`${BILLING_ORIGIN}/v1/portal-sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: gate.orgId }),
    });
    if (!response.ok) {
      return errorResponse(
        502,
        'portal_unavailable',
        'De facturatiepagina is even niet bereikbaar.',
        'The billing page is temporarily unavailable.',
      );
    }
    const body: unknown = await response.json();
    const url =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['url'] : null;
    if (typeof url !== 'string') {
      return errorResponse(
        502,
        'portal_unavailable',
        'De facturatiepagina is even niet bereikbaar.',
        'The billing page is temporarily unavailable.',
      );
    }
    // 303 rather than a JSON body: the portal URL is single-use and short-lived, so handing it to a
    // client that might store it is worse than sending the browser straight there.
    return seeOther(url);
  } catch {
    return errorResponse(
      502,
      'portal_unavailable',
      'De facturatiepagina is even niet bereikbaar.',
      'The billing page is temporarily unavailable.',
    );
  }
});

/**
 * The 409 for an address that has already had a trial.
 *
 * 409 and not 402: nothing about the request is unpaid, the identity is ineligible. Exported so
 * `submit.ts` answers with exactly this body from its own pre-Checkout check.
 */
export function trialAlreadyUsedResponse(env: Env): Response {
  return errorResponse(
    409,
    'trial_already_used',
    'Met dit e-mailadres is al een proefperiode gebruikt. Log in of neem contact op.',
    'A trial has already been used with this e-mail address. Sign in, or contact us.',
    { signInUrl: `${env.DASHBOARD_ORIGIN}/inloggen` },
  );
}
