import { IntakeSchema, mintId, redactForModel, resolveAvailableSlug } from '@aibuilder/core';
import type { Intake, Locale } from '@aibuilder/core';
import { cp, runBatch, shard, shardById, toArrayBuffer, toBytes } from '@aibuilder/db';
import type {
  GenerationJobId,
  OnboardingDraftRow,
  OrganisationId,
  SiteId,
  UserId,
} from '@aibuilder/db';
import { Hono } from 'hono';
import { z } from 'zod';

import type { AppEnv, Env } from '../env';
import { GENERATION_ESTIMATE_USD_MICRO, reserveBudget, settleBudget } from '../lib/budget';
import { consumeQuota, releaseQuota } from '../lib/quota';
import type { QuotaSubject } from '../lib/quota';
import {
  errorResponse,
  jsonResponse,
  malformedBodyResponse,
  notFoundResponse,
  validationErrorFromIssues,
} from '../lib/responses';
import type { ValidationIssue } from '../lib/responses';
import {
  businessIdentityHex,
  clientIp,
  hashIp,
  ipNetwork,
  normalizeEmail,
  sha256,
  sha256Hex,
  toHex,
} from '../lib/subjects';
import { requireAnonSession } from '../middleware/draft-cookie';
import { rateLimitByIp } from '../middleware/ratelimit';
import { TURNSTILE_ACTION_SUBMIT, verifyTurnstile } from '../middleware/turnstile';
import {
  SQL_ATTACH_CHECKOUT_SESSION,
  SQL_INSERT_GENERATION_JOB_AWAITING_PAYMENT,
  checkoutOutcomeResponse,
  createCheckoutSession,
  ensureCheckoutSession,
  getPaymentJob,
  trialAlreadyUsedResponse,
} from './billing';
import type { PaymentState } from './billing';
import { currentDraft } from './drafts';

/**
 * `POST /v1/onboarding/submit` — the whole funnel, in order.
 *
 * Turnstile → Zod → `QuotaDO` → `BudgetDO` → Haiku policy screen → the prior-trial screen → one
 * control-plane `batch()` → the shard's job row → a Stripe Checkout Session. The order is not
 * arbitrary: each layer is cheaper than the one after it, and the two that cost money (the policy
 * screen, and the generation itself) are last (architecture §8).
 *
 * THIS ROUTE NO LONGER DISPATCHES ANYTHING. DECISIONS §D2 inverted the funnel: the 7-day trial
 * happens BEFORE the first generation, so submit returns a Checkout URL and the
 * `checkout.session.completed` webhook dispatches the Workflow. The `success_url` redirect never
 * does — a redirect is a browser navigation, not a payment guarantee, and the customer can close
 * the tab before it fires. The job row is written with `payment_state='awaiting_payment'` and
 * `queue_ready_at IS NULL`, which the drain's partial index cannot see, so no Opus can be spent
 * until money is on the table.
 *
 * THE CLIENT CANNOT SUPPLY AN IDEMPOTENCY KEY. The key was minted at draft creation, is stored on
 * the draft row, and keys `uq_jobs_idem(org_id, idempotency_key)`. Architecture §5.4 adopted the
 * org scoping because a globally unique, client-supplied, ULID-shaped key was simultaneously a
 * cross-tenant denial of service and an existence oracle for other tenants' job ids.
 *
 * WHAT HAPPENS WHEN SOMETHING FAILS HALF-WAY. The control plane, the shard and Stripe are three
 * systems and no transaction spans them, so the sequence is chosen so that every partial state is
 * recoverable by simply calling this route again:
 *
 *   - The CP batch is atomic. A concurrent second submit either loses the `status = 'open'`
 *     predicate on the draft transition or collides on the total unique index over `sites.slug`;
 *     both land on the replay path.
 *   - If the CP batch commits and the shard write fails, the draft is `submitted` with a job id
 *     whose row does not exist. The replay path detects exactly that and re-creates the row with
 *     the SAME id, which is why the ids are minted before either write rather than by either write.
 *   - If the job row exists and the Checkout Session cannot be created, the answer is
 *     `402 checkout_unavailable` carrying the job id. Nothing the customer entered is lost:
 *     `POST /v1/billing/checkout/:jobId` mints a session for that same job later, and a replayed
 *     submit does the same thing on its own.
 *   - If Stripe creates a session and the row that records it cannot be written, the webhook has
 *     already won the race or is about to; the replay path re-reads `payment_state` and answers
 *     with whatever it now holds. A session nobody uses expires in thirty minutes and is free.
 *
 * THE BUDGET RESERVATION DOES NOT SURVIVE THE RESPONSE. No Opus spend has been authorised at this
 * point — the customer has not paid yet — so the reservation is settled at zero on every path
 * before the answer is written, and the generator re-reserves at dispatch, which is the moment
 * spend actually becomes imminent. The QUOTA is deliberately not released: a submit consumes a
 * generation slot whether or not the card lands, otherwise abandoning Checkout in a loop is a free
 * slug-reservation and draft-row generator.
 */

/** Abuse signals are kept for 90 days, then purged by cron. */
const ABUSE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** A claimed draft is the fact source publish projects from, so it outlives the 30-day purge. */
const CLAIMED_DRAFT_RETENTION_MS = 3650 * 24 * 60 * 60 * 1000;

/** The generator's internal API. Used by the policy screen only; dispatch belongs to the webhook. */
const GENERATOR_ORIGIN = 'https://generator.internal';

/**
 * The `payment_deadline_at` a job is created with, before Stripe's own `expires_at` replaces it.
 *
 * Thirty minutes, matching the session TTL, so a job whose Checkout Session could not be created at
 * all still has a deadline the sweep can find it by.
 */
const CHECKOUT_DEADLINE_FALLBACK_MS = 30 * 60 * 1000;

/** The Turnstile token travels alongside the intake rather than inside it. */
const TurnstileEnvelopeSchema = z.object({
  turnstileToken: z.string().min(1).max(4096),
});

/**
 * The 202/200 body.
 *
 * `checkoutUrl` and `checkoutExpiresAt` are nullable rather than optional: with
 * `exactOptionalPropertyTypes` on, an absent-or-present field is a worse contract for a client than
 * one that is always there and sometimes `null`, and the modal branches on the value either way.
 */
interface SubmitAcceptedBody {
  readonly jobId: string;
  readonly slug: string;
  readonly siteUrl: string;
  readonly eventsUrl: string;
  readonly paymentState: PaymentState;
  readonly checkoutUrl: string | null;
  readonly checkoutExpiresAt: number | null;
}

export const submitRoutes = new Hono<AppEnv>();

// ------------------------------------------------------------------------------------------------
// Collaborators
// ------------------------------------------------------------------------------------------------

/** The policy screen's verdict, as `onboarding_drafts.policy_screen` records it. */
type PolicyVerdict = 'pass' | 'reject' | 'error';

/** What the Haiku screen answered. */
interface PolicyResult {
  readonly verdict: PolicyVerdict;
  /** An honest, user-facing reason on a rejection. Recorded and returned with the 451. */
  readonly reason: string | null;
}

/**
 * Runs the Haiku 4.5 intake policy screen through the generator.
 *
 * This Worker does not hold `ANTHROPIC_API_KEY` and never will — capability separation on Workers
 * means splitting Workers (architecture §8), so the screen runs in the one Worker that holds the
 * key and has no public route. Only the model-facing fields are sent: business name, city,
 * industry and the free-text description, each passed through `redactForModel()`. E-mail, phone,
 * street address and the GBP URL are not sent to a model at any point in this product.
 *
 * A screening outage is neither a pass nor a rejection: it answers `error`, and the caller
 * escalates to e-mail confirmation rather than refusing every signup or spending on an unscreened
 * one.
 */
async function screenPolicy(
  env: Env,
  args: {
    readonly draftId: string;
    readonly locale: string;
    readonly industryKey: string;
    readonly businessName: string;
    readonly city: string | null;
    readonly description: string | null;
  },
): Promise<PolicyResult> {
  try {
    const response = await env.GENERATOR.fetch(`${GENERATOR_ORIGIN}/v1/policy-screen`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftId: args.draftId,
        locale: args.locale,
        industryKey: args.industryKey,
        businessName: redactForModel(args.businessName),
        city: args.city === null ? null : redactForModel(args.city),
        description: args.description === null ? null : redactForModel(args.description),
      }),
    });
    if (!response.ok) {
      return { verdict: 'error', reason: null };
    }
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) {
      return { verdict: 'error', reason: null };
    }
    const record = body as Record<string, unknown>;
    const verdict = record['verdict'];
    if (verdict !== 'pass' && verdict !== 'reject') {
      return { verdict: 'error', reason: null };
    }
    const reason = record['reason'];
    return { verdict, reason: typeof reason === 'string' ? reason.slice(0, 500) : null };
  } catch {
    return { verdict: 'error', reason: null };
  }
}

/** Records one abuse signal. Fire-and-forget: telemetry must never fail a user's request. */
async function recordAbuse(
  env: Env,
  args: {
    readonly kind:
      'turnstile_fail' | 'quota_exceeded' | 'policy_reject' | 'budget_deferred' | 'slug_blocked';
    /** `quota_exceeded` doubles as the prior-trial refusal; the reason travels in `detail`. */
    readonly severity: 'info' | 'warn' | 'block';
    readonly draft: OnboardingDraftRow;
    readonly detail: string | null;
  },
): Promise<void> {
  const now = Date.now();
  const subjectHash =
    args.draft.ip_hash === null
      ? await sha256(`draft${args.draft.id}`)
      : toBytes(args.draft.ip_hash);
  try {
    await cp.quotas.insertAbuseEvent(env.CP, {
      ulid: mintId('abuseEvent'),
      kind: args.kind,
      severity: args.severity,
      subjectType: args.draft.ip_hash === null ? 'draft' : 'ip',
      subjectHash,
      siteId: args.draft.site_id,
      orgId: args.draft.org_id,
      detail: args.detail,
      now,
      purgeAfter: now + ABUSE_RETENTION_MS,
    });
  } catch {
    // Deliberately swallowed: an abuse signal that cannot be written is an ops problem, not a
    // reason to fail the request that produced it.
  }
}

/**
 * The quota subjects one submit is counted against (architecture §8 layer 5).
 *
 * Every key is a hash or a normalised value; no raw IP and no raw e-mail address reaches a Durable
 * Object. The IP-derived subjects are listed first so that the cheapest, most abused limits are
 * consulted before an identity is derived.
 */
async function quotaSubjects(
  env: Env,
  intake: Intake,
  ip: string | null,
): Promise<readonly QuotaSubject[]> {
  const subjects: QuotaSubject[] = [];
  if (ip !== null) {
    subjects.push({ type: 'ip', key: toHex(await hashIp(env, ip)) });
    const network = ipNetwork(ip);
    if (network !== null) {
      subjects.push({ type: 'ip_network', key: await sha256Hex(`net${network}`) });
    }
  }
  subjects.push({
    type: 'email',
    key: await sha256Hex(`email${normalizeEmail(intake.contactEmail)}`),
  });
  subjects.push({ type: 'phone', key: await sha256Hex(`phone${intake.phoneE164}`) });
  subjects.push({
    type: 'identity',
    key: await businessIdentityHex(intake.businessName, intake.address?.postalCode ?? null),
  });
  return subjects;
}

/**
 * The digest recorded as `generation_jobs.prompt_sha256`.
 *
 * It hashes the MODEL-FACING brief and nothing else: business name, industry, city, locale and the
 * redacted description. That makes two runs of the same brief comparable in the ledger, and it
 * keeps the column meaningful without recording anything that was never sent to a model. The
 * per-call prompt hashes are written by the generator into `generation_calls`.
 */
async function briefDigest(intake: Intake): Promise<Uint8Array> {
  const city = intake.address?.city ?? intake.serviceArea?.city ?? '';
  const description =
    intake.shortDescription === null ? '' : redactForModel(intake.shortDescription);
  return sha256(
    [intake.businessName, intake.industryKey, city, intake.defaultLocale, description].join(''),
  );
}

/** The accepted body for a job that exists. */
function acceptedBody(
  env: Env,
  jobId: string,
  slug: string,
  payment: {
    readonly paymentState: PaymentState;
    readonly checkoutUrl: string | null;
    readonly checkoutExpiresAt: number | null;
  },
): SubmitAcceptedBody {
  return {
    jobId,
    slug,
    siteUrl: `https://${slug}.${env.SITES_ROOT_DOMAIN}`,
    eventsUrl: `/v1/jobs/${jobId}/events`,
    paymentState: payment.paymentState,
    checkoutUrl: payment.checkoutUrl,
    checkoutExpiresAt: payment.checkoutExpiresAt,
  };
}

// ------------------------------------------------------------------------------------------------
// Replay
// ------------------------------------------------------------------------------------------------

/**
 * Answers a submit for a draft that is no longer `open`.
 *
 * The self-healing branch is the important one: a draft that is `submitted` but whose shard row is
 * missing means the control-plane batch committed and the shard write did not. Re-creating the row
 * with the stored ids is safe — `uq_jobs_idem(org_id, idempotency_key)` makes a duplicate insert
 * fail rather than double-bill — and it turns a 500 into a retry the client already knows how to
 * make.
 *
 * The second branch is DECISIONS §D2's: a job still waiting for payment gets the LIVE Checkout URL
 * back, or a fresh session when the stored one has expired. A customer who reloads the modal after
 * closing the Stripe tab is the ordinary case, and answering it with "this form has already been
 * completed" would strand a paying customer behind a form they cannot re-open.
 */
async function replaySubmitted(env: Env, draft: OnboardingDraftRow): Promise<Response> {
  if (draft.status === 'rejected') {
    return errorResponse(
      451,
      'policy_rejected',
      'We kunnen voor deze onderneming geen website genereren.',
      'We cannot generate a website for this business.',
      { reason: draft.policy_reason },
    );
  }
  if (draft.generation_job_id === null || draft.site_id === null || draft.org_id === null) {
    return errorResponse(
      409,
      'draft_closed',
      'Dit formulier is al afgerond.',
      'This form has already been completed.',
    );
  }

  const site = await cp.sites.getLiveSite(env.CP, draft.site_id);
  if (site === null) {
    return errorResponse(
      409,
      'draft_closed',
      'Dit formulier is al afgerond.',
      'This form has already been completed.',
    );
  }

  const db = shardById(draft.shard_id, env);
  const job = await getPaymentJob(db, draft.generation_job_id);
  if (job === null) {
    return errorResponse(
      409,
      'submit_incomplete',
      'Je aanvraag is nog niet volledig verwerkt. Probeer het zo nog eens.',
      'Your request was not fully processed. Please try again shortly.',
    );
  }

  if (job.payment_state === 'awaiting_payment' || job.payment_state === 'abandoned') {
    const outcome = await ensureCheckoutSession(env, {
      draft,
      job,
      orgId: draft.org_id,
      db,
    });
    if (outcome.kind === 'created') {
      return jsonResponse(
        acceptedBody(env, job.id, site.slug, {
          paymentState: 'awaiting_payment',
          checkoutUrl: outcome.session.checkoutUrl,
          checkoutExpiresAt: outcome.session.expiresAt,
        }),
        200,
      );
    }
    if (outcome.kind !== 'already_paid') {
      return checkoutOutcomeResponse(env, job.id, outcome);
    }
  }

  return jsonResponse(
    acceptedBody(env, job.id, site.slug, {
      paymentState: job.payment_state,
      checkoutUrl: null,
      checkoutExpiresAt: null,
    }),
    200,
  );
}

// ------------------------------------------------------------------------------------------------
// The route
// ------------------------------------------------------------------------------------------------

submitRoutes.post('/submit', requireAnonSession, rateLimitByIp('RL_SUBMIT'), async (c) => {
  const draft = await currentDraft(c.env, c.get('anonSession'));
  if (draft === null) {
    return notFoundResponse('no_draft');
  }

  const body: unknown = await c.req.json<unknown>().catch(() => null);
  if (body === null) {
    return malformedBodyResponse();
  }

  const envelope = TurnstileEnvelopeSchema.safeParse(body);
  const intakeParsed = IntakeSchema.safeParse(body);
  if (!envelope.success || !intakeParsed.success) {
    const issues: ValidationIssue[] = [
      ...(envelope.success ? [] : envelope.error.issues),
      ...(intakeParsed.success ? [] : intakeParsed.error.issues),
    ];
    return validationErrorFromIssues(issues);
  }
  const intake: Intake = intakeParsed.data;

  if (draft.status !== 'open') {
    return replaySubmitted(c.env, draft);
  }

  const ip = clientIp(c.req.raw);

  // ---- Layer 3: Turnstile, bound to THIS draft ------------------------------------------------
  const verification = await verifyTurnstile(c.env, {
    token: envelope.data.turnstileToken,
    action: TURNSTILE_ACTION_SUBMIT,
    cdata: draft.id,
    remoteIp: ip,
  });
  if (!verification.ok) {
    c.executionCtx.waitUntil(
      recordAbuse(c.env, {
        kind: 'turnstile_fail',
        severity: 'warn',
        draft,
        detail: verification.error,
      }),
    );
    return errorResponse(
      403,
      'turnstile_failed',
      'We konden niet vaststellen dat je een mens bent. Ververs de pagina en probeer het opnieuw.',
      'We could not verify that you are human. Refresh the page and try again.',
      { reason: verification.error },
    );
  }

  // ---- Layer 5: per-subject quotas -------------------------------------------------------------
  const subjects = await quotaSubjects(c.env, intake, ip);
  const quota = await consumeQuota(c.env, subjects);
  if (quota.outcome === 'deny') {
    c.executionCtx.waitUntil(
      recordAbuse(c.env, {
        kind: 'quota_exceeded',
        severity: 'block',
        draft,
        detail: quota.subject?.type ?? null,
      }),
    );
    return errorResponse(
      409,
      'quota_exceeded',
      'Er zijn vandaag al te veel websites vanaf dit account aangemaakt. Probeer het morgen opnieuw.',
      'Too many websites have been created from this account today. Please try again tomorrow.',
      { retryAfterSeconds: quota.retryAfterSeconds },
      quota.retryAfterSeconds === null
        ? {}
        : { 'retry-after': String(Math.ceil(quota.retryAfterSeconds)) },
    );
  }

  // ---- Layer 6: the global spend ceiling, with staged degradation -------------------------------
  const jobId: GenerationJobId = mintId('generationJob');
  const budget = await reserveBudget(c.env, {
    jobId,
    estimateMicro: GENERATION_ESTIMATE_USD_MICRO,
  });

  // An escalated quota and a screening outage both land in the same place the budget's first
  // degradation step does: confirm the e-mail address before spending anything.
  let mode = budget.mode;
  let cause: 'budget' | 'quota' | 'policy_screen' = 'budget';
  if (mode === 'allow' && quota.outcome === 'escalate') {
    mode = 'confirm_email';
    cause = 'quota';
  }

  /** Unwinds everything reserved so far. Called on every path that stops before dispatch. */
  const releaseReservations = async (): Promise<void> => {
    if (budget.reservationId !== null) {
      await settleBudget(c.env, { reservationId: budget.reservationId, actualMicro: 0 });
    }
    await releaseQuota(c.env, subjects);
  };

  // ---- The Haiku policy screen, before any Opus spend -------------------------------------------
  const screen = await screenPolicy(c.env, {
    draftId: draft.id,
    locale: intake.defaultLocale,
    industryKey: intake.industryKey,
    businessName: intake.businessName,
    city: intake.address?.city ?? intake.serviceArea?.city ?? null,
    description: intake.shortDescription,
  });
  await cp.drafts.setDraftPolicyScreen(c.env.CP, {
    draftId: draft.id,
    verdict: screen.verdict,
    reason: screen.reason,
    now: Date.now(),
  });
  if (screen.verdict === 'reject') {
    await releaseReservations();
    c.executionCtx.waitUntil(
      recordAbuse(c.env, {
        kind: 'policy_reject',
        severity: 'block',
        draft,
        detail: screen.reason,
      }),
    );
    return errorResponse(
      451,
      'policy_rejected',
      'We kunnen voor deze onderneming geen website genereren.',
      'We cannot generate a website for this business.',
      { reason: screen.reason },
    );
  }
  if (screen.verdict === 'error' && mode === 'allow') {
    mode = 'confirm_email';
    cause = 'policy_screen';
  }

  // ---- The final slug --------------------------------------------------------------------------
  const locale: Locale = intake.defaultLocale;
  const city = intake.address?.city ?? intake.serviceArea?.city ?? null;
  let slug: string;
  try {
    const resolved = await resolveAvailableSlug({
      seed: intake.slug,
      locale,
      city,
      isTaken: async (candidate) =>
        (await cp.slugs.filterUnavailableSlugs(c.env.CP, [candidate])).has(candidate),
    });
    slug = resolved.slug;
  } catch {
    await releaseReservations();
    c.executionCtx.waitUntil(
      recordAbuse(c.env, { kind: 'slug_blocked', severity: 'warn', draft, detail: intake.slug }),
    );
    return errorResponse(
      409,
      'slug_unavailable',
      'Dit webadres is niet beschikbaar. Kies een andere naam.',
      'That web address is not available. Please choose another name.',
    );
  }

  // ---- The prior-trial screen, before any row is written -----------------------------------------
  //
  // DECISIONS §D2 asks for a lookup by `email_normalized` AND by `card.fingerprint`. Only the first
  // can run here: the fingerprint is a property of a PaymentMethod that does not exist until the
  // customer has typed a card into Checkout, so its half runs in the webhook (design §5.1).
  //
  // 409 and not 402: nothing about the request is unpaid, the identity is ineligible. It runs after
  // the slug so that a returning customer is told the truth about their account rather than about
  // their web address, and BEFORE the batch so that a refusal writes nothing at all.
  const now = Date.now();
  const emailNormalized = normalizeEmail(intake.contactEmail);
  const priorTrial = await cp.billing.findTrialByEmail(c.env.CP, emailNormalized);
  if (priorTrial !== null) {
    await releaseReservations();
    c.executionCtx.waitUntil(
      recordAbuse(c.env, {
        kind: 'quota_exceeded',
        severity: 'warn',
        draft,
        detail: 'prior_trial_email',
      }),
    );
    return trialAlreadyUsedResponse(c.env);
  }

  // ---- Identity ---------------------------------------------------------------------------------
  const existingUser = await cp.users.getUserByEmail(c.env.CP, emailNormalized);
  const userId: UserId = existingUser?.id ?? mintId('user');
  const orgId: OrganisationId = mintId('organisation');
  const siteId: SiteId = mintId('site');
  const canonicalHost = `${slug}.${c.env.SITES_ROOT_DOMAIN}`.toLowerCase();
  // `organisations.country` is NOT NULL with a 'NL' default; the address is the best signal, the
  // edge's country is the next best, and the column's own default is the floor.
  const country = intake.address?.country ?? draft.ip_country ?? 'NL';

  // ---- One control-plane batch ------------------------------------------------------------------
  //
  // The statements come from `@aibuilder/db` as exported SQL constants rather than through its
  // executor functions, because `batch()` needs prepared statements and atomicity here is the
  // point: an organisation without its site, or a site without its draft transition, is a state no
  // later request can repair. The TEXT still lives in the db package, so the CI
  // EXPLAIN-QUERY-PLAN gate sees these statements exactly as it sees every other one.
  //
  // Order is dictated by the schema, not by taste: `trg_sites_shard_ownership_ins` reads the
  // organisation row, and `onboarding_drafts.site_id` has a foreign key to the site.
  //
  // The claim token is deliberately NOT minted here. A claim token is a credential whose only
  // purpose is to be delivered; minting one now would mean storing a hash whose preimage is
  // discarded in the same statement — a row that can never be consumed. Phase 2's invitation
  // sender mints it (`cp.drafts.insertClaimToken`) at the moment it can put the value in an
  // e-mail, which cannot ship before SPF/DKIM/DMARC `p=reject` (architecture §10 risk 7).
  // `GET /claim` is complete today and consumes whatever that sender creates.
  const statements = [
    c.env.CP.prepare(cp.orgs.SQL_INSERT_PROVISIONAL_ORG).bind(
      orgId,
      intake.businessName,
      draft.shard_id,
      country,
      now,
    ),
    ...(existingUser === null
      ? [
          c.env.CP.prepare(cp.users.SQL_INSERT_USER).bind(
            userId,
            intake.contactEmail,
            emailNormalized,
            null,
            locale,
            country,
            intake.marketingOptIn ? 1 : 0,
            null,
            now,
          ),
        ]
      : []),
    c.env.CP.prepare(cp.sites.SQL_INSERT_SITE).bind(
      siteId,
      orgId,
      draft.shard_id,
      slug,
      'onboarding',
      locale,
      canonicalHost,
      now,
    ),
    cp.drafts.markDraftSubmittedStatement(c.env.CP, {
      draftId: draft.id,
      siteId,
      orgId,
      jobId,
      now,
    }),
  ];

  try {
    const results = await runBatch(c.env.CP, statements);
    const transition = results[results.length - 1];
    if (transition !== undefined && transition.meta.changes !== 1) {
      // The draft was submitted by a concurrent request between our read and this write. The rows
      // this batch created are orphans: the organisation stays provisional and is collected by the
      // 30-day purge, and its slug was uniquely suffixed so it collides with nothing.
      const current = await currentDraft(c.env, c.get('anonSession'));
      await releaseReservations();
      return current === null ? notFoundResponse('no_draft') : replaySubmitted(c.env, current);
    }
  } catch {
    // A constraint failure here is almost always the concurrent-submit race colliding on the total
    // unique index over `sites.slug`. The batch rolled back atomically, so the draft is whatever
    // the winner left it as, and re-reading answers correctly for both outcomes.
    const current = await currentDraft(c.env, c.get('anonSession'));
    await releaseReservations();
    if (current !== null && current.status !== 'open') {
      return replaySubmitted(c.env, current);
    }
    return errorResponse(
      409,
      'submit_conflict',
      'Je aanvraag kon niet worden afgerond. Probeer het nog een keer.',
      'Your request could not be completed. Please try again.',
    );
  }

  // ---- The shard: the run ledger and the media hand-off ------------------------------------------
  const db = shardById(draft.shard_id, c.env);
  const promptSha256 = await briefDigest(intake);
  try {
    const shardResults = await runBatch(db, [
      db.prepare(SQL_INSERT_GENERATION_JOB_AWAITING_PAYMENT).bind(
        jobId,
        orgId,
        siteId,
        draft.id,
        draft.idempotency_key,
        toArrayBuffer(promptSha256),
        GENERATION_ESTIMATE_USD_MICRO,
        // `created_by` is set now that the user row exists in the same submit: the Checkout
        // return route mints a browser session from it rather than re-deriving the identity.
        userId,
        // A placeholder deadline, immediately overwritten with Stripe's own `expires_at`. It
        // exists so that a job whose session creation fails is still reaped by the deadline
        // sweep rather than sitting in `awaiting_payment` forever.
        now + CHECKOUT_DEADLINE_FALLBACK_MS,
        now,
      ),
      shard.media.promoteDraftMediaStatement(db, { draftId: draft.id, siteId, orgId, now }),
    ]);
    const inserted = shardResults[0];
    if (inserted !== undefined && inserted.meta.changes !== 1) {
      throw new Error('generation job insert changed no rows');
    }
  } catch {
    // The control plane already committed, so the draft points at a job id whose row is missing.
    // A retry lands on `replaySubmitted`, which reports `submit_incomplete` rather than inventing a
    // second run; the reservation is released here so the ceiling is not charged for it meanwhile.
    await releaseReservations();
    return errorResponse(
      409,
      'submit_incomplete',
      'Je aanvraag is nog niet volledig verwerkt. Probeer het zo nog eens.',
      'Your request was not fully processed. Please try again shortly.',
    );
  }

  // ---- Release the reservation, then hand the customer to Stripe -------------------------------
  //
  // The reservation is settled at zero on EVERY path from here: no Opus spend has been authorised,
  // and a reservation must not sit against the daily ceiling for the thirty minutes the customer
  // spends deciding. The generator re-reserves when the webhook releases the job, which is the
  // moment spend actually becomes imminent.
  if (budget.reservationId !== null) {
    await settleBudget(c.env, { reservationId: budget.reservationId, actualMicro: 0 });
  }
  if (mode !== 'allow') {
    // The ceiling no longer withholds anything at submit — there is nothing to withhold, because
    // this route stopped dispatching. The signal is still recorded, because "how close to the
    // ceiling were we when this cohort signed up" is the question the degradation ladder was built
    // to answer, and the generator's dispatcher re-consults `BudgetDO` before it spends.
    c.executionCtx.waitUntil(
      recordAbuse(c.env, { kind: 'budget_deferred', severity: 'info', draft, detail: cause }),
    );
  }

  const checkout = await createCheckoutSession(c.env, {
    orgId,
    jobId,
    email: intake.contactEmail,
    emailNormalized,
    businessName: intake.businessName,
    locale,
    attempt: 1,
  });
  if (checkout.kind !== 'created') {
    // The job row exists and is durable. `POST /v1/billing/checkout/:jobId` mints a session for it
    // later, and a replayed submit does the same — nothing the customer entered is lost.
    return checkoutOutcomeResponse(c.env, jobId, checkout);
  }

  const attached = await db
    .prepare(SQL_ATTACH_CHECKOUT_SESSION)
    .bind(jobId, checkout.session.checkoutSessionId, checkout.session.expiresAt, Date.now())
    .run();
  if (attached.meta.changes !== 1) {
    // `changes === 0` means the webhook already won the race: the customer paid before this
    // statement landed, which is possible because Stripe is fast. Not an error — the row is re-read
    // and the answer carries whatever `payment_state` it now holds.
    const current = await getPaymentJob(db, jobId);
    return jsonResponse(
      acceptedBody(c.env, jobId, slug, {
        paymentState: current?.payment_state ?? 'paid',
        checkoutUrl: null,
        checkoutExpiresAt: null,
      }),
      200,
    );
  }

  return jsonResponse(
    acceptedBody(c.env, jobId, slug, {
      paymentState: 'awaiting_payment',
      checkoutUrl: checkout.session.checkoutUrl,
      checkoutExpiresAt: checkout.session.expiresAt,
    }),
    202,
  );
});

/** Exported for the claim route, which pushes a claimed draft's retention out to match its site. */
export { CLAIMED_DRAFT_RETENTION_MS };
