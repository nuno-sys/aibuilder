import { isId, mintId } from '@aibuilder/core';
import { cp, shardById, toArrayBuffer } from '@aibuilder/db';
import type { GenerationJobId, OrganisationId, SiteId, UserId } from '@aibuilder/db';
import { Hono } from 'hono';

import type { AppEnv, Env } from '../env';
import { GENERATION_ESTIMATE_USD_MICRO, reserveBudget, settleBudget } from '../lib/budget';
import {
  gateFailure,
  isGateFailure,
  requireEntitlement,
  sessionFromRequest,
} from '../lib/entitlement';
import { errorResponse, jsonResponse, notFoundResponse } from '../lib/responses';
import { sha256 } from '../lib/subjects';

/**
 * `POST /v1/sites/:siteId/regenerate` — the one paid action Phase 2 exposes, and the gate in front
 * of it.
 *
 * THE GATE IS SERVER-SIDE, AND THAT IS THE ENTIRE POINT. A disabled button is decoration: the
 * request it would have sent can be sent by hand. `requireEntitlement()` runs on this request,
 * against the database, before anything is written and long before anything is dispatched.
 *
 * A REFUSAL IS RECORDED, NOT MERELY RETURNED. The 402 writes a `generation_jobs` row with
 * `status='blocked_paywall'` and `finished_at` set, because "how many people hit the paywall, and
 * which ones" is a question the business asks weekly and a log line cannot answer.
 * `idx_jobs_paywalled` exists for exactly this query.
 *
 * DECISIONS §D2 CHANGED WHAT THIS GATE CATCHES, NOT WHETHER IT EXISTS. With the trial moved before
 * the first generation, everyone holding a site holds an entitlement, so in practice this now fires
 * only on a lapsed subscription. It stays because it is a correctness boundary and not a growth
 * mechanism: the day a subscription lapses, the paid action has to stop.
 *
 * PHASE 2 (handover): the 2-regenerations-per-30-days limit is `QuotaDO`'s, on an org-scoped
 * subject that `src/lib/quota.ts` does not model yet (its five subject types are all onboarding
 * signals). That limiter is the real one now — this gate only answers "is this account paid" — and
 * it lands with the dashboard that calls this route.
 */

/** The estimate a regeneration reserves. Same model, same ceiling, same number as a first build. */
const REGENERATE_ESTIMATE_USD_MICRO = GENERATION_ESTIMATE_USD_MICRO;

/**
 * A refused regeneration, recorded.
 *
 * `finished_at` is set because `CHECK (status NOT IN (…,'blocked_paywall') OR finished_at IS NOT
 * NULL)` requires it: a terminal status with no end time is a job the reaper would chase forever.
 * `queue_ready_at` stays NULL so the drain never sees it.
 *
 * Exported so the suite can key its D1 double on the exact statement this route ships, rather than
 * on a substring that would still match after a rewrite.
 */
export const SQL_INSERT_BLOCKED_PAYWALL_JOB = `
INSERT INTO generation_jobs (id, org_id, site_id, draft_id, kind, requires_entitlement, status,
                             idempotency_key, queue_ready_at, prompt_sha256, budget_reserved_micro,
                             created_by, error_code, error_message, queued_at, finished_at,
                             created_at, updated_at)
VALUES (?1, ?2, ?3, NULL, 'regenerate_site', 1, 'blocked_paywall', ?4, NULL, ?5, 0, ?6,
        'payment_required', ?7, ?8, ?8, ?8, ?8)
`;

/**
 * An accepted regeneration.
 *
 * `queue_ready_at = now` IS the dispatch. The generator's `POST /v1/generations` takes a draft id
 * and a regeneration has no draft, so the hand-off is the queue sentinel that the drain already
 * seeks — the same path a budget-deferred submit relies on, and the one that does not require this
 * Worker to invent a request shape the generator has not agreed to.
 */
export const SQL_INSERT_REGENERATION_JOB = `
INSERT INTO generation_jobs (id, org_id, site_id, draft_id, kind, requires_entitlement, status,
                             idempotency_key, queue_ready_at, prompt_sha256, budget_reserved_micro,
                             created_by, queued_at, created_at, updated_at)
VALUES (?1, ?2, ?3, NULL, 'regenerate_site', 1, 'queued', ?4, ?5, ?6, ?7, ?8, ?5, ?5, ?5)
`;

/**
 * The digest recorded as `generation_jobs.prompt_sha256`.
 *
 * A regeneration's model-facing brief is assembled by the generator from the site's own stored
 * facts, so this Worker has no brief to hash. It records a stable digest of the REQUEST instead —
 * which keeps the NOT NULL column meaningful rather than filled with a plausible-looking lie, and
 * the per-call prompt hashes in `generation_calls` remain the real cache-attribution signal.
 */
async function requestDigest(siteId: SiteId, jobId: GenerationJobId): Promise<Uint8Array> {
  return sha256(`regenerate_site${siteId}${jobId}`);
}

/** `uq_jobs_idem(org_id, idempotency_key)`; 16-64 chars of `[0-9A-Za-z_-]`. */
function idempotencyKeyFor(jobId: GenerationJobId): string {
  return `regen-${jobId}`;
}

/** Records the refusal. Best-effort: a paywall hit that cannot be written is not a 500. */
async function recordBlockedJob(
  env: Env,
  args: {
    readonly shardId: number;
    readonly orgId: OrganisationId;
    readonly siteId: SiteId;
    readonly userId: UserId;
    readonly reason: string;
  },
): Promise<void> {
  const jobId: GenerationJobId = mintId('generationJob');
  const now = Date.now();
  try {
    await shardById(args.shardId, env)
      .prepare(SQL_INSERT_BLOCKED_PAYWALL_JOB)
      .bind(
        jobId,
        args.orgId,
        args.siteId,
        idempotencyKeyFor(jobId),
        toArrayBuffer(await requestDigest(args.siteId, jobId)),
        args.userId,
        args.reason.slice(0, 4000),
        now,
      )
      .run();
  } catch {
    // Deliberately swallowed: the customer's 402 is the important half, and a shard that cannot
    // take a telemetry row must not turn a correct refusal into an incident.
  }
}

export const siteRoutes = new Hono<AppEnv>();

siteRoutes.post('/:siteId/regenerate', async (c) => {
  const siteId = c.req.param('siteId');
  if (!isId('site', siteId)) {
    return notFoundResponse();
  }

  const session = await sessionFromRequest(c.env, c.req.raw);
  if (session === null) {
    return gateFailure(c.env, 'no_session');
  }

  const site = await cp.sites.getLiveSite(c.env.CP, siteId);
  if (site === null) {
    // 404 and not 403: a 403 would confirm that a site with this id exists somewhere.
    return notFoundResponse();
  }

  // `editor` and not `owner`: regenerating is a content action, and an editor who may rewrite every
  // page by hand is not meaningfully restrained by being unable to ask the model to do it. Money is
  // bounded by the entitlement, the quota and `BudgetDO`, not by the role.
  const gate = await requireEntitlement(c.env, session, site.org_id, { minRole: 'editor' });
  if (isGateFailure(gate)) {
    if (gate === 'not_entitled' || gate === 'entitlement_lapsed') {
      await recordBlockedJob(c.env, {
        shardId: site.shard_id,
        orgId: site.org_id,
        siteId,
        userId: session.user_id,
        reason: gate,
      });
    }
    return gateFailure(c.env, gate);
  }

  const jobId: GenerationJobId = mintId('generationJob');
  const budget = await reserveBudget(c.env, {
    jobId,
    estimateMicro: REGENERATE_ESTIMATE_USD_MICRO,
  });

  const now = Date.now();
  const db = shardById(gate.shardId, c.env);
  try {
    const result = await db
      .prepare(SQL_INSERT_REGENERATION_JOB)
      .bind(
        jobId,
        gate.orgId,
        siteId,
        idempotencyKeyFor(jobId),
        now,
        toArrayBuffer(await requestDigest(siteId, jobId)),
        REGENERATE_ESTIMATE_USD_MICRO,
        gate.userId,
      )
      .run();
    if (result.meta.changes !== 1) {
      throw new Error('regeneration job insert changed no rows');
    }
  } catch {
    if (budget.reservationId !== null) {
      await settleBudget(c.env, { reservationId: budget.reservationId, actualMicro: 0 });
    }
    return errorResponse(
      409,
      'regenerate_failed',
      'We konden de nieuwe versie niet starten. Probeer het zo nog eens.',
      'We could not start the new version. Please try again shortly.',
    );
  }

  if (budget.mode !== 'allow') {
    // The row exists with its sentinel set, so the drain runs it when the ceiling allows. The
    // reservation is released so the daily counter is not charged for a run that has not started.
    if (budget.reservationId !== null) {
      await settleBudget(c.env, { reservationId: budget.reservationId, actualMicro: 0 });
    }
    return jsonResponse(
      {
        jobId,
        eventsUrl: `/v1/jobs/${jobId}/events`,
        queued: true,
        message: 'Het is nu erg druk. We starten je nieuwe versie zodra er ruimte is.',
      },
      202,
    );
  }

  // The reservation is settled at zero here too: the generator re-reserves at dispatch, which is
  // the moment spend actually becomes imminent, and a reservation held across the queue would
  // ratchet the daily ceiling against a run that has not begun.
  if (budget.reservationId !== null) {
    await settleBudget(c.env, { reservationId: budget.reservationId, actualMicro: 0 });
  }

  return jsonResponse({ jobId, eventsUrl: `/v1/jobs/${jobId}/events`, queued: true }, 202);
});
