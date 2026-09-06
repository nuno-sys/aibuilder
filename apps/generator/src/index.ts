import { createAnthropicClient, screenIntake } from '@aibuilder/ai';
import { industryByKey, isId } from '@aibuilder/core';
import { z } from 'zod';

import type { Env, MediaVerifyMessage, SiteGenerationParams } from './env';
import { handleMediaBatch } from './queue/media-consumer';

/**
 * `aibuilder-generator` — the Worker that holds `ANTHROPIC_API_KEY` and has NO PUBLIC ROUTE.
 *
 * Capability separation on Workers means splitting Workers (architecture §8). Bindings are
 * per-Worker, so the only way to make "one process holds the model key" true is to make that
 * process a separate deployment with no `routes` entry. Everything below is reachable exclusively
 * through `aibuilder-api`'s `GENERATOR` service binding, and that is the entire authorisation
 * story: there is no URL on the internet that resolves here.
 *
 * The four surfaces this script exposes, all in one entry because a Worker has one:
 *
 *   `fetch`   the two calls `apps/api` makes — the pre-spend policy screen, and Workflow dispatch —
 *             plus the cancellation path §6.4 requires.
 *   `queue`   the upload verify/re-encode consumer.
 *   the Workflow class, and the three Durable Object classes, which the runtime instantiates by
 *   name from `wrangler.jsonc` rather than by import.
 *
 * There is deliberately no router library here. Two routes and a health check do not need one, and
 * this Worker's startup CPU budget is spent parsing the Anthropic SDK on the first generation.
 */

export { SiteGenerationWorkflow } from './workflow';
export { JobHub } from './do/JobHub';
export { BudgetDO } from './do/BudgetDO';
export { QuotaDO } from './do/QuotaDO';

/** The intake screen request `apps/api` sends before it writes a job row. */
const PolicyScreenRequest = z.object({
  draftId: z.string().min(1).max(64),
  locale: z.string().min(2).max(8),
  industryKey: z.string().min(1).max(40),
  businessName: z.string().min(1).max(200),
  city: z.string().max(120).nullable(),
  description: z.string().max(2000).nullable(),
});

/** The dispatch request. Identifiers only; the generator reads the draft itself. */
const DispatchRequest = z.object({
  jobId: z.string().min(1).max(64),
  orgId: z.string().min(1).max(64),
  siteId: z.string().min(1).max(64),
  draftId: z.string().min(1).max(64),
  shardId: z.number().int().min(0).max(999),
  slug: z.string().min(1).max(63),
  canonicalHost: z.string().min(1).max(253),
});

/**
 * The classifier's request timeout, in milliseconds.
 *
 * Far shorter than a generation's, and for the opposite reason: a human is waiting on the submit
 * response. Twenty seconds is generous for a 512-token Haiku classification and short enough that a
 * provider incident becomes an `error` verdict — which escalates to e-mail confirmation — rather
 * than a submit that hangs.
 */
const SCREEN_TIMEOUT_MS = 20_000;

/** A JSON response with the store-nothing headers every internal answer carries. */
function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * Runs the Haiku intake screen.
 *
 * WHY IT LIVES HERE AND NOT IN `apps/api`. The API does not hold `ANTHROPIC_API_KEY` and never
 * will. Only the model-facing fields cross the binding — business name, city, industry and the
 * description, each already redacted by the caller — and this Worker redacts them again through
 * `screenIntake()`, because a Worker must not trust a value because the Worker in front of it
 * cleaned one.
 *
 * WHY THE CALL IS NOT LEDGERED IN `generation_calls`. That table's rows are children of
 * `generation_jobs` by foreign key, and this call happens BEFORE the job row exists — that
 * ordering is the point of the screen (§8: a refusal is not refundable, so it must precede the
 * spend). The call is recorded in Analytics Engine instead, which is where the aggregate "what do
 * screens cost" question is answered anyway.
 *
 * A screening OUTAGE answers `review`, never `pass` and never `reject`: the caller escalates to
 * e-mail confirmation rather than refusing every signup or spending on an unscreened one.
 */
async function handlePolicyScreen(request: Request, env: Env): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = PolicyScreenRequest.safeParse(body);
  if (!parsed.success) return json({ error: 'invalid_request' }, 400);

  // `businessName`, `city` and `locale` are accepted and validated but NOT forwarded to the model.
  // The classifier's question is "should a website be generated for this kind of business", and a
  // name and a city move it towards judging the applicant rather than the trade — which is both a
  // worse classifier and a data-minimisation regression on a call that does not need them. They are
  // kept in the request shape because the caller has them and a future human-review queue will.
  const industry = industryByKey(parsed.data.industryKey);
  try {
    const client = await createAnthropicClient(env, { timeoutMs: SCREEN_TIMEOUT_MS });
    const result = await screenIntake({
      client,
      industryKey: parsed.data.industryKey,
      industryLabel: industry?.labels.en ?? parsed.data.industryKey,
      description: parsed.data.description,
    });

    if (result.call !== null) {
      env.AE.writeDataPoint({
        indexes: ['validate'],
        blobs: [parsed.data.draftId, 'validate', result.verdict.decision, env.ENVIRONMENT],
        doubles: [
          result.call.costUsdMicro,
          result.call.usage.inputTokens,
          result.call.usage.outputTokens,
          0,
          0,
          0,
          1,
        ],
      });
    }

    const decision = result.verdict.decision;
    return json(
      {
        verdict: decision === 'allow' ? 'pass' : decision === 'reject' ? 'reject' : 'review',
        category: result.verdict.category,
        // Shown to the applicant on a rejection, so it is the classifier's own sentence rather
        // than a generic one — an honest reason and a route to support (§S4, the 451).
        reason: result.verdict.reason,
      },
      200,
    );
  } catch {
    // Never a fabricated `pass`. The caller reads anything but `pass`/`reject` as an outage and
    // escalates; §8's degradation ladder already has a step for exactly this.
    return json({ verdict: 'review', category: 'other', reason: null }, 200);
  }
}

/**
 * Creates the Workflow instance for one job.
 *
 * THE INSTANCE ID IS THE JOB ID. That is what makes dispatch idempotent without an idempotency
 * table: a duplicate `POST` collides on the instance id and answers 409, which the caller counts as
 * success because the run it wanted already exists. It is also why `generation_jobs` has no second
 * column holding a Workflow id — two columns that must always be equal are two columns that will
 * eventually disagree.
 */
async function handleDispatch(request: Request, env: Env): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = DispatchRequest.safeParse(body);
  if (!parsed.success) return json({ error: 'invalid_request' }, 400);
  if (!isId('generationJob', parsed.data.jobId)) return json({ error: 'invalid_job_id' }, 400);

  const params: SiteGenerationParams = parsed.data;
  try {
    const instance = await env.SITEGEN.create({ id: params.jobId, params });
    return json({ jobId: params.jobId, instanceId: instance.id }, 202);
  } catch (error) {
    // The platform rejects a duplicate instance id. Distinguishing that from a real failure by
    // message is fragile, so the existence check is made explicitly rather than inferred.
    const existing = await env.SITEGEN.get(params.jobId).catch(() => null);
    if (existing !== null) return json({ jobId: params.jobId, duplicate: true }, 409);
    return json({ error: 'dispatch_failed', detail: String(error) }, 503);
  }
}

/**
 * Terminates a running generation.
 *
 * §6.4: a cancelled job that keeps running burns tokens through the most expensive steps while the
 * UI shows it stopped. `terminate()` is the only thing that actually stops the spend — marking the
 * D1 row cancelled does not, because the Workflow never reads it.
 *
 * This route stops the run and nothing else. The `generation_jobs` transition belongs to the caller,
 * which holds the shard id and the authorisation that let it ask: resolving a shard here from a job
 * id alone would mean RECOMPUTING a placement that is a stored fact, and that is the one mistake
 * `shardById()` exists to make impossible. Phase 2's cancel button writes the row.
 */
async function handleCancel(jobId: string, env: Env): Promise<Response> {
  if (!isId('generationJob', jobId)) return json({ error: 'invalid_job_id' }, 400);
  try {
    const instance = await env.SITEGEN.get(jobId);
    await instance.terminate();
    return new Response(null, { status: 204 });
  } catch {
    // An instance that does not exist, or has already finished, is the outcome the caller wanted.
    return new Response(null, { status: 204 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/v1/policy-screen') {
      return handlePolicyScreen(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/v1/generations') {
      return handleDispatch(request, env);
    }
    const cancel = /^\/v1\/generations\/([^/]+)\/cancel$/u.exec(url.pathname);
    if (request.method === 'POST' && cancel !== null) {
      return handleCancel(cancel[1] ?? '', env);
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, environment: env.ENVIRONMENT }, 200);
    }
    return json({ error: 'not_found' }, 404);
  },

  async queue(batch: MessageBatch<MediaVerifyMessage>, env: Env): Promise<void> {
    await handleMediaBatch(batch, env);
  },
};
