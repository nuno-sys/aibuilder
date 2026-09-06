import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

/**
 * `JobHub` — sequence monotonicity and `Last-Event-ID` resume.
 *
 * These two properties are the whole contract. `seq` is the SSE `id` on the wire, so if it can ever
 * repeat, go backwards, or be assigned by anything other than this object, then "everything after
 * `Last-Event-ID`" stops meaning anything and a reconnecting customer either loses events or sees
 * the progress bar run backwards. The tests therefore assert the two things the API and the modal
 * actually depend on, against a real Durable Object with real SQLite storage.
 */

const ORIGIN = 'https://job-hub.internal';

/** A job id shaped like the real thing, distinct per case so no test reads another's log. */
function jobId(suffix: string): string {
  return `job_01JTEST${suffix.toUpperCase().padEnd(18, 'X')}`;
}

/**
 * Addresses one hub.
 *
 * Not through `jobHubStub()`: that applies the EU jurisdiction, which the local test runtime does
 * not model, and the property under test here is the object's behaviour rather than its id. The
 * jurisdiction itself is covered by `jurisdiction.test.ts`.
 */
function hub(name: string) {
  return env.JOB_HUB.get(env.JOB_HUB.idFromName(name));
}

/** The stub type, so the helpers below do not each have to spell it. */
type HubStub = ReturnType<typeof hub>;

/** Appends one event and returns the `seq` the object assigned. */
async function append(
  stub: HubStub,
  body: {
    jobId: string;
    phase: string;
    progress: number;
    message?: string | null;
    data?: unknown;
    eventKey?: string | null;
  },
): Promise<number> {
  const response = await stub.fetch(`${ORIGIN}/append`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      shardId: 0,
      message: null,
      data: null,
      eventKey: null,
      ...body,
    }),
  });
  expect(response.status).toBe(200);
  const parsed = (await response.json()) as { seq: number };
  return parsed.seq;
}

/** Reads a whole SSE response. Safe because the hub closes the stream once the run is terminal. */
async function readStream(stub: HubStub, lastEventId: number): Promise<string> {
  const response = await stub.fetch(`${ORIGIN}/events?lastEventId=${String(lastEventId)}`, {
    headers: { accept: 'text/event-stream' },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  return response.text();
}

describe('JobHub sequence numbers', () => {
  it('assigns strictly increasing sequence numbers', async () => {
    const id = jobId('seq');
    const stub = hub(id);

    const first = await append(stub, { jobId: id, phase: 'queued', progress: 2 });
    const second = await append(stub, { jobId: id, phase: 'api_call', progress: 22 });
    const third = await append(stub, { jobId: id, phase: 'streaming', progress: 45 });

    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(third).toBe(3);
  });

  it('collapses a replayed keyed event onto its original sequence number', async () => {
    // This is the property that makes an emit in a replayed `run()` body safe: the Workflow will
    // re-send `${runId}:structure.start` on every resume, and the log must not grow a row each time.
    const id = jobId('idem');
    const stub = hub(id);

    const first = await append(stub, {
      jobId: id,
      phase: 'api_call',
      progress: 22,
      eventKey: `${id}:structure.start`,
    });
    const replay = await append(stub, {
      jobId: id,
      phase: 'api_call',
      progress: 22,
      eventKey: `${id}:structure.start`,
    });
    const next = await append(stub, { jobId: id, phase: 'streaming', progress: 45 });

    expect(replay).toBe(first);
    // The replay consumed no sequence number, so the following event is the second row, not the
    // third — which is what keeps the client's cursor and the log in agreement.
    expect(next).toBe(first + 1);
  });

  it('keeps counting across separately-addressed stubs', async () => {
    // The counter must survive re-addressing. A genuine eviction cannot be forced from a test, so
    // what this pins down is the half that can be: nothing in the request path resets `nextSeq`.
    // The other half — hydrating it from `max(seq)` inside `blockConcurrencyWhile` before any
    // request is served — is asserted by review of the constructor and by the uniqueness index,
    // which would turn a repeated `seq` into a failed insert rather than a duplicate row.
    const id = jobId('rehydrate');
    await append(hub(id), { jobId: id, phase: 'queued', progress: 2 });
    await append(hub(id), { jobId: id, phase: 'build', progress: 84 });
    const third = await append(hub(id), { jobId: id, phase: 'done', progress: 100 });

    expect(third).toBe(3);
  });
});

describe('JobHub Last-Event-ID resume', () => {
  it('replays only the events after the cursor', async () => {
    const id = jobId('resume');
    const stub = hub(id);

    await append(stub, { jobId: id, phase: 'queued', progress: 2, message: 'een' });
    await append(stub, { jobId: id, phase: 'api_call', progress: 22, message: 'twee' });
    await append(stub, { jobId: id, phase: 'streaming', progress: 45, message: 'drie' });
    // Terminal, so the resumed stream is closed after the backlog and `text()` resolves.
    await append(stub, { jobId: id, phase: 'done', progress: 100, message: 'klaar' });

    const body = await readStream(stub, 2);

    expect(body).not.toContain('id: 1');
    expect(body).not.toContain('id: 2');
    expect(body).toContain('id: 3');
    expect(body).toContain('id: 4');
    expect(body).toContain('event: done');
    expect(body).toContain('drie');
    expect(body).not.toContain('twee');
  });

  it('replays the whole log for a client with no cursor', async () => {
    const id = jobId('full');
    const stub = hub(id);
    await append(stub, { jobId: id, phase: 'queued', progress: 2 });
    await append(stub, { jobId: id, phase: 'done', progress: 100 });

    const body = await readStream(stub, 0);

    expect(body).toContain('id: 1');
    expect(body).toContain('id: 2');
    // The retry hint stops a browser reconnecting every three seconds between steps.
    expect(body).toContain('retry: 3000');
  });

  it('treats a malformed cursor as no cursor rather than as a gap', async () => {
    // The API parses `Last-Event-ID` before proxying, and this repeats the parse: a Durable Object
    // must not trust a value because the Worker in front of it validated one. A `NaN` cursor that
    // reached the SQL comparison would silently return nothing.
    const id = jobId('badcursor');
    const stub = hub(id);
    await append(stub, { jobId: id, phase: 'queued', progress: 2 });
    await append(stub, { jobId: id, phase: 'done', progress: 100 });

    const response = await stub.fetch(`${ORIGIN}/events?lastEventId=not-a-number`, {
      headers: { accept: 'text/event-stream' },
    });
    const body = await response.text();

    expect(body).toContain('id: 1');
    expect(body).toContain('id: 2');
  });
});

describe('JobHub state', () => {
  it('reports the latest event for the polling fallback', async () => {
    const id = jobId('state');
    const stub = hub(id);
    await append(stub, { jobId: id, phase: 'api_call', progress: 22, message: 'bezig' });
    await append(stub, { jobId: id, phase: 'done', progress: 100, message: 'klaar' });

    const response = await stub.fetch(`${ORIGIN}/state`);
    const state = (await response.json()) as {
      seq: number;
      phase: string | null;
      progress: number | null;
      message: string | null;
      terminal: boolean;
    };

    expect(state.seq).toBe(2);
    expect(state.phase).toBe('done');
    expect(state.progress).toBe(100);
    expect(state.message).toBe('klaar');
    expect(state.terminal).toBe(true);
  });

  it('rejects an unknown phase rather than writing one D1 would refuse', async () => {
    const id = jobId('badphase');
    const response = await hub(id).fetch(`${ORIGIN}/append`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: id, shardId: 0, phase: 'inventing', progress: 5 }),
    });

    // The mirror's CHECK constraint lists twelve phases. Catching it here means the failure is a
    // 400 on the emit rather than a silent loss on a background batch nobody is watching.
    expect(response.status).toBe(400);
  });
});
