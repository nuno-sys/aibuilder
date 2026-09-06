import { isId } from '@aibuilder/core';
import { cp, shard, shardById } from '@aibuilder/db';
import type { AnonSessionRow, GenerationJobRow, JobPhase } from '@aibuilder/db';
import { Hono } from 'hono';

import type { AppEnv, Env } from '../env';
import { errorResponse, jsonResponse, notFoundResponse } from '../lib/responses';
import { requireAnonSession } from '../middleware/draft-cookie';
import { currentDraft } from './drafts';

/**
 * Progress: an SSE stream proxied from the job's `JobHub`, and a polling fallback.
 *
 * AUTHORISATION HAPPENS ON EVERY CONNECTION, INCLUDING EVERY RESUME. That is not a claim about
 * diligence — it is a property of the transport. An `EventSource` reconnect is an ordinary new HTTP
 * request carrying `Last-Event-ID`, so it re-enters this handler and re-runs the same two checks:
 * the draft cookie must resolve to a live session, and `generation_jobs.draft_id` must equal that
 * session's draft. Possession of a job id proves nothing, which is what the org-scoped idempotency
 * key in architecture §5.4 was adopted to guarantee.
 *
 * THE STREAM IS PROXIED, NOT REBUILT. The DO owns the sequence numbers, the buffering and the
 * 15-second heartbeat; this Worker adds authorisation and the correct headers and then gets out of
 * the way. The SSE `id` is the DO-assigned `seq` and never the D1 autoincrement — using the latter
 * would put a write to the single D1 primary between the model's token and the customer's screen.
 *
 * The polling route exists because the modal falls back to it after two failed reconnects. It is
 * three cheap reads and no stream, so a client stuck behind a proxy that eats `text/event-stream`
 * still sees its site being built.
 */

/** The DO's internal API. The host is never resolved; only the path is read. */
const JOB_HUB_ORIGIN = 'https://job-hub.internal';

/** Headers that keep an SSE stream alive through the intermediaries this will meet. */
const SSE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'private, no-store',
  connection: 'keep-alive',
  // Some reverse proxies buffer a streaming response into uselessness; this is the documented
  // opt-out and is inert everywhere else.
  'x-accel-buffering': 'no',
};

/** What the polling route answers with. */
interface JobStatusBody {
  readonly status: string;
  readonly phase: JobPhase;
  readonly progress: number;
  readonly message: string | null;
  readonly siteUrl?: string;
  readonly error?: string;
}

/** The subset of the DO's state the polling route merges in. */
interface HubState {
  readonly phase: JobPhase | null;
  readonly progress: number | null;
  readonly message: string | null;
}

/**
 * The phase implied by a job row, for when the DO cannot be reached.
 *
 * Derived rather than stored: `generation_jobs.status` is the durable lifecycle and the phase is a
 * finer-grained progress signal that lives in the DO. Mapping one onto the other is honest — it
 * says where the run is without pretending to know which step it is on.
 */
function phaseForStatus(status: GenerationJobRow['status']): JobPhase {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'api_call';
    case 'streaming':
      return 'streaming';
    case 'succeeded':
      return 'done';
    default:
      return 'error';
  }
}

/** A coarse progress floor for the same fallback. The modal interpolates between events anyway. */
function progressForStatus(status: GenerationJobRow['status']): number {
  switch (status) {
    case 'queued':
      return 0;
    case 'running':
      return 10;
    case 'streaming':
      return 40;
    case 'succeeded':
      return 100;
    default:
      return 0;
  }
}

/** Reads the DO's current state, or `null` when it cannot be reached. */
async function readHubState(env: Env, jobId: string): Promise<HubState | null> {
  try {
    const namespace = env.JOB_HUB.jurisdiction('eu');
    const response = await namespace
      .get(namespace.idFromName(jobId))
      .fetch(`${JOB_HUB_ORIGIN}/state`);
    if (!response.ok) {
      return null;
    }
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) {
      return null;
    }
    const record = body as Record<string, unknown>;
    const phase = record['phase'];
    const progress = record['progress'];
    const message = record['message'];
    return {
      phase: typeof phase === 'string' ? (phase as JobPhase) : null,
      progress: typeof progress === 'number' ? progress : null,
      message: typeof message === 'string' ? message : null,
    };
  } catch {
    return null;
  }
}

/**
 * Resolves the job this request is allowed to see, or `null`.
 *
 * The draft id is a predicate in the SQL statement rather than a value the caller compares, so
 * there is no path on which a job is read first and authorised second. Every failure — malformed
 * id, no draft, someone else's job — returns the same `null`, and the caller answers the same 404.
 */
async function authorizedJob(
  env: Env,
  session: AnonSessionRow,
  jobId: string,
): Promise<GenerationJobRow | null> {
  if (!isId('generationJob', jobId)) {
    return null;
  }
  const draft = await currentDraft(env, session);
  if (draft === null) {
    return null;
  }
  return shard.generationJobs.getJobForDraft(shardById(draft.shard_id, env), {
    jobId,
    draftId: draft.id,
  });
}

export const jobRoutes = new Hono<AppEnv>();

jobRoutes.get('/:jobId/events', requireAnonSession, async (c) => {
  const jobId = c.req.param('jobId');
  const job = await authorizedJob(c.env, c.get('anonSession'), jobId);
  if (job === null) {
    return notFoundResponse('job_not_found');
  }

  // `Last-Event-ID` is client-supplied and goes into a DO query string, so it is parsed as a
  // non-negative integer or discarded. A resume that asks for events "after NaN" would either
  // replay the whole log or none of it, depending on how the DO coerces it.
  const header = c.req.header('Last-Event-ID');
  const parsed = header === undefined ? Number.NaN : Number.parseInt(header, 10);
  const lastEventId = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;

  const namespace = c.env.JOB_HUB.jurisdiction('eu');
  const upstream = await namespace
    .get(namespace.idFromName(job.id))
    .fetch(`${JOB_HUB_ORIGIN}/events?lastEventId=${String(lastEventId)}`, {
      headers: { accept: 'text/event-stream' },
    });

  if (!upstream.ok || upstream.body === null) {
    return errorResponse(
      502,
      'events_unavailable',
      'De live-verbinding is niet beschikbaar. We schakelen over op verversen.',
      'The live connection is unavailable. Falling back to polling.',
    );
  }

  return new Response(upstream.body, { status: 200, headers: SSE_HEADERS });
});

jobRoutes.get('/:jobId', requireAnonSession, async (c) => {
  const jobId = c.req.param('jobId');
  const job = await authorizedJob(c.env, c.get('anonSession'), jobId);
  if (job === null) {
    return notFoundResponse('job_not_found');
  }

  const [state, site] = await Promise.all([
    readHubState(c.env, job.id),
    cp.sites.getLiveSite(c.env.CP, job.site_id),
  ]);

  const body: JobStatusBody = {
    status: job.status,
    phase: state?.phase ?? phaseForStatus(job.status),
    progress: state?.progress ?? progressForStatus(job.status),
    message: state?.message ?? null,
    ...(site === null ? {} : { siteUrl: `https://${site.canonical_host}` }),
    // The stable code only. `error_message` can carry provider detail and is for the ledger and
    // support tooling, not for a public response body.
    ...(job.error_code === null ? {} : { error: job.error_code }),
  };
  return jsonResponse(body, 200);
});
