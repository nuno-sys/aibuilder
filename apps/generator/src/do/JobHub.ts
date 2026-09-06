import { DurableObject } from 'cloudflare:workers';
import { runBatch, shard, shardById } from '@aibuilder/db';
import type { GenerationJobId, JobPhase, ShardId } from '@aibuilder/db';

import type { Env } from '../env';

/**
 * `JobHub` — one Durable Object per generation run, holding an append-only event log.
 *
 * WHY A DURABLE OBJECT AND NOT D1. The SSE `id` on the wire must be a sequence number that is
 * monotonic *and* assigned before the event is visible to anyone, because `Last-Event-ID` resume is
 * defined as "everything after this id". A D1 `INTEGER PRIMARY KEY AUTOINCREMENT` cannot do that
 * job: it is assigned by the single D1 primary, which would put a write to a shared, globally
 * serialised database between the model's token and the customer's screen, and it is assigned per
 * *insert*, not per *emit*, so a redelivered mirror would burn an id. The DO is single-threaded, so
 * `seq` here is a plain in-memory counter over a table it alone writes, and that is the whole
 * mechanism. The D1 table is a MIRROR of this log, written in batches off the critical path, and
 * `generation_job_events.seq` is this counter — never that table's own `id` (§S4).
 *
 * WHY SSE AND NOT WEBSOCKETS. One-way progress, native `EventSource` auto-reconnect, `Last-Event-ID`
 * resume for free, survives corporate proxies, no framing code. §6.4 is explicit that the cost is
 * DO duration billing, because an SSE stream cannot use WebSocket Hibernation — and that a 60-90 s
 * generation with one or two connected clients is fractions of a cent at Phase 1 volume. WebSockets
 * plus Hibernation is a Phase 3 upgrade if DO duration ever shows up in the bill.
 *
 * WHY SUBSCRIBERS PULL FROM SQL. Every subscriber holds a cursor and nothing else; a fan-out reads
 * `seq > cursor` out of the table and writes what it finds. There is therefore no window between
 * "read the backlog" and "subscribe to live events" in which an event can be lost, and no in-memory
 * queue that could diverge from the log. It costs one indexed range scan per event per subscriber,
 * over a table that holds tens of rows.
 *
 * THE 15-SECOND HEARTBEAT IS NOT OPTIONAL. A `plan-brief` call can think silently for a minute.
 * Nothing else keeps the stream alive through that: intermediaries close idle connections, and a
 * closed connection is a progress bar that stops moving in the one product moment that must not
 * look broken.
 */

/** The twelve phases `generation_job_events.phase` accepts. Rejected here, not at the D1 write. */
const JOB_PHASES: readonly JobPhase[] = [
  'queued',
  'prompt_built',
  'api_call',
  'thinking',
  'streaming',
  'parsing',
  'pages_written',
  'media_fetch',
  'build',
  'deploy',
  'done',
  'error',
];

/** The two phases after which no further event can be appended. */
const TERMINAL_PHASES: ReadonlySet<JobPhase> = new Set<JobPhase>(['done', 'error']);

/** Column ceilings from `migrations/shard/0004_generation.sql`. Clamped, never rejected. */
const MAX_MESSAGE_LENGTH = 2000;
const MAX_DATA_LENGTH = 8192;

/** Comment frame that keeps intermediaries from closing a silently thinking stream. */
const HEARTBEAT_INTERVAL_MS = 15_000;

/** How long after the first unmirrored event the D1 batch is written. */
const MIRROR_DELAY_MS = 2_000;

/** Rows per mirror batch. D1 `batch()` is one round trip; this bounds the statement count. */
const MIRROR_BATCH_SIZE = 50;

/**
 * How long a finished run's log stays addressable in the DO.
 *
 * Long enough that a customer who closed the laptop and reopened it still resumes from the object
 * rather than the mirror; short enough that a per-job SQLite volume is not kept forever. Past this
 * the durable record is `generation_job_events`, which the nightly purge trims at seven days.
 */
const RETENTION_AFTER_TERMINAL_MS = 24 * 60 * 60 * 1000;

/** One row of the DO's own log. */
interface EventRow {
  // `SqlStorage.exec<T>` constrains T to `Record<string, SqlStorageValue>`; the named fields above
  // are the contract, this signature only satisfies the constraint.
  readonly [column: string]: SqlStorageValue;
  readonly seq: number;
  readonly phase: string;
  readonly progress: number;
  readonly message: string | null;
  readonly data: string | null;
  readonly created_at: number;
}

/** A connected SSE client. */
interface Subscriber {
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly heartbeat: ReturnType<typeof setInterval>;
  /** The highest `seq` this client has been sent. Its `Last-Event-ID` on connect. */
  cursor: number;
}

/** What an append call carries. Validated before anything is written. */
interface AppendBody {
  readonly jobId: string;
  readonly shardId: number;
  readonly phase: JobPhase;
  readonly progress: number;
  readonly message: string | null;
  readonly data: unknown;
  /**
   * Idempotency key, `${runId}:${phase}:${ordinal}`.
   *
   * A Workflow's `run()` is replayed on every resume, so a lifecycle emit that sits between two
   * steps re-fires on each attempt. Keyed appends collapse those replays onto one row — which is
   * what stops the append-only log from growing a duplicate every retry and the progress bar from
   * jumping backwards. Streamed token deltas are deliberately keyless: they live inside a step, a
   * step retry genuinely produces new text, and the client maps phase to act many-to-one so a
   * repeat cannot move the rail backwards (§S4).
   */
  readonly eventKey: string | null;
}

/** Coerces an unknown value to a finite integer inside `[min, max]`. */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Narrows an unknown JSON body to an append, or returns `null`. Total for any input. */
function parseAppend(value: unknown): AppendBody | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;

  const jobId = record['jobId'];
  const phase = record['phase'];
  if (typeof jobId !== 'string' || jobId.length === 0) return null;
  if (typeof phase !== 'string' || !JOB_PHASES.includes(phase as JobPhase)) return null;

  const message = record['message'];
  const eventKey = record['eventKey'];
  return {
    jobId,
    shardId: clampInt(record['shardId'], 0, 999, 0),
    phase: phase as JobPhase,
    progress: clampInt(record['progress'], 0, 100, 0),
    message: typeof message === 'string' ? message.slice(0, MAX_MESSAGE_LENGTH) : null,
    data: record['data'] ?? null,
    eventKey: typeof eventKey === 'string' && eventKey.length > 0 ? eventKey.slice(0, 200) : null,
  };
}

/**
 * Serialises the `data` payload, dropping it when it cannot be stored.
 *
 * The D1 column is `CHECK (json_valid(data) AND length(data) <= 8192)`. A payload that would fail
 * that check is dropped rather than truncated: half a JSON document is not JSON, and the mirror
 * write is a background batch nobody is watching, so a constraint failure there would be silent.
 */
function serialiseData(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return null;
  }
  if (typeof text !== 'string' || text.length > MAX_DATA_LENGTH) return null;
  return text;
}

/** Parses stored `data`, returning `null` rather than throwing on anything unexpected. */
function parseOrNull(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** SSE-encodes one event. `id` is the DO-assigned `seq` — the contract `Last-Event-ID` resumes on. */
function encodeEvent(row: EventRow): string {
  const name = row.phase === 'done' ? 'done' : row.phase === 'error' ? 'error' : 'progress';
  const payload = JSON.stringify({
    seq: row.seq,
    phase: row.phase,
    progress: row.progress,
    message: row.message,
    // Re-parsed rather than embedded as a string, so the client reads one object and not a string
    // it has to parse a second time. Defensive despite `serialiseData()` guaranteeing valid JSON:
    // this runs on the streaming path, where a throw would drop a live subscriber.
    data: parseOrNull(row.data),
  });
  return `id: ${String(row.seq)}\nevent: ${name}\ndata: ${payload}\n\n`;
}

export class JobHub extends DurableObject<Env> {
  private readonly encoder = new TextEncoder();
  private readonly subscribers = new Set<Subscriber>();

  /** The next `seq` to assign. Authoritative because a Durable Object is single-threaded. */
  private nextSeq = 1;

  /** Set once the first append names the job; the mirror write needs both. */
  private jobId: GenerationJobId | null = null;
  private shardId: ShardId = 0;

  private terminal = false;

  public constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // `blockConcurrencyWhile` is what makes `nextSeq` safe: no request is served until the counter
    // has been read back from storage, so a freshly evicted object cannot hand out `seq` 1 twice.
    void this.ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      this.hydrate();
      await Promise.resolve();
    });
  }

  /** Creates the log table. Idempotent, so it runs on every construction rather than once. */
  private migrate(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq        INTEGER PRIMARY KEY,
        phase      TEXT NOT NULL,
        progress   INTEGER NOT NULL,
        message    TEXT,
        data       TEXT,
        event_key  TEXT,
        created_at INTEGER NOT NULL,
        mirrored   INTEGER NOT NULL DEFAULT 0
      )
    `);
    // Partial, so the many keyless delta rows do not collide with each other on NULL.
    sql.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_events_key ON events(event_key) WHERE event_key IS NOT NULL`,
    );
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_events_unmirrored ON events(seq) WHERE mirrored = 0`);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      )
    `);
  }

  /** Reads the counter and the run's identity back out of storage after an eviction. */
  private hydrate(): void {
    const sql = this.ctx.storage.sql;
    const maxRow = sql.exec<{ m: number | null }>(`SELECT max(seq) AS m FROM events`).toArray()[0];
    this.nextSeq = (maxRow?.m ?? 0) + 1;

    for (const row of sql.exec<{ k: string; v: string }>(`SELECT k, v FROM meta`).toArray()) {
      if (row.k === 'jobId') this.jobId = row.v as GenerationJobId;
      if (row.k === 'shardId') this.shardId = Number.parseInt(row.v, 10);
      if (row.k === 'terminal') this.terminal = row.v === '1';
    }
  }

  private putMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      key,
      value,
    );
  }

  public override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/append':
        return this.handleAppend(request);
      case '/events':
        return this.handleEvents(url);
      case '/state':
        return this.handleState();
      default:
        return new Response('not found', { status: 404 });
    }
  }

  /* -- Append ------------------------------------------------------------------------------- */

  private async handleAppend(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

    const body: unknown = await request.json().catch(() => null);
    const append = parseAppend(body);
    if (append === null) return new Response('bad request', { status: 400 });

    const row = this.append(append);
    this.fanOut();
    await this.scheduleMirror();

    if (TERMINAL_PHASES.has(append.phase)) {
      // The stream is closed only after the terminal event has been written to every subscriber,
      // so the last thing a client sees is the outcome rather than a dropped connection.
      await this.closeSubscribers();
    }
    return Response.json({ seq: row.seq });
  }

  /**
   * Writes one event, or returns the existing row when the idempotency key has been seen.
   *
   * Guarantees `seq` is strictly increasing across the object's whole lifetime, including across
   * evictions, and that a keyed replay never consumes a new `seq`.
   */
  private append(body: AppendBody): EventRow {
    const sql = this.ctx.storage.sql;

    if (body.eventKey !== null) {
      const existing = sql
        .exec<EventRow>(
          `SELECT seq, phase, progress, message, data, created_at FROM events WHERE event_key = ?`,
          body.eventKey,
        )
        .toArray()[0];
      if (existing !== undefined) return existing;
    }

    if (this.jobId === null) {
      this.jobId = body.jobId as GenerationJobId;
      this.shardId = body.shardId;
      this.putMeta('jobId', body.jobId);
      this.putMeta('shardId', String(body.shardId));
    }

    const seq = this.nextSeq;
    this.nextSeq += 1;
    const row: EventRow = {
      seq,
      phase: body.phase,
      progress: body.progress,
      message: body.message,
      data: serialiseData(body.data),
      created_at: Date.now(),
    };
    sql.exec(
      `INSERT INTO events (seq, phase, progress, message, data, event_key, created_at, mirrored)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      row.seq,
      row.phase,
      row.progress,
      row.message,
      row.data,
      body.eventKey,
      row.created_at,
    );

    if (TERMINAL_PHASES.has(body.phase)) {
      this.terminal = true;
      this.putMeta('terminal', '1');
    }
    return row;
  }

  /* -- Streaming ---------------------------------------------------------------------------- */

  private handleEvents(url: URL): Response {
    // The API already parses `Last-Event-ID` into a non-negative integer before proxying, and this
    // repeats the parse: a DO must never trust a value because a Worker in front of it validated it.
    const raw = url.searchParams.get('lastEventId');
    const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    const cursor = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;

    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    const subscriber: Subscriber = {
      writer,
      cursor,
      heartbeat: setInterval(() => {
        void this.write(subscriber, ': ping\n\n');
      }, HEARTBEAT_INTERVAL_MS),
    };
    this.subscribers.add(subscriber);

    // Backlog first, then the object is live. Both paths read the same table through the same
    // cursor, so a replay and a live event are indistinguishable and nothing can fall between them.
    void (async (): Promise<void> => {
      // A retry-hint frame costs nothing and stops browsers from reconnecting every 3 s when the
      // generator is between steps.
      await this.write(subscriber, 'retry: 3000\n\n');
      await this.drain(subscriber);
      if (this.terminal) await this.closeSubscriber(subscriber);
    })();

    return new Response(stream.readable, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'private, no-store',
        // Some reverse proxies buffer a streaming response into uselessness; this is the documented
        // opt-out and is inert everywhere else.
        'x-accel-buffering': 'no',
      },
    });
  }

  /** Sends every event after a subscriber's cursor, advancing it. */
  private async drain(subscriber: Subscriber): Promise<void> {
    const rows = this.ctx.storage.sql
      .exec<EventRow>(
        `SELECT seq, phase, progress, message, data, created_at
         FROM events WHERE seq > ? ORDER BY seq`,
        subscriber.cursor,
      )
      .toArray();
    for (const row of rows) {
      const ok = await this.write(subscriber, encodeEvent(row));
      if (!ok) return;
      subscriber.cursor = row.seq;
    }
  }

  /** Pushes new events to every subscriber. Failures drop the subscriber; they never throw. */
  private fanOut(): void {
    for (const subscriber of this.subscribers) {
      void this.drain(subscriber);
    }
  }

  /** Writes one frame, removing the subscriber when the client has gone. Returns success. */
  private async write(subscriber: Subscriber, frame: string): Promise<boolean> {
    try {
      await subscriber.writer.write(this.encoder.encode(frame));
      return true;
    } catch {
      // A disconnected client is the normal case, not an error: the tab was closed, the phone
      // slept, the proxy gave up. The stream is gone; the log is not.
      this.discard(subscriber);
      return false;
    }
  }

  private discard(subscriber: Subscriber): void {
    clearInterval(subscriber.heartbeat);
    this.subscribers.delete(subscriber);
  }

  private async closeSubscriber(subscriber: Subscriber): Promise<void> {
    this.discard(subscriber);
    try {
      await subscriber.writer.close();
    } catch {
      // Already closed by the peer. Nothing to do and nothing to report.
    }
  }

  private async closeSubscribers(): Promise<void> {
    await Promise.all([...this.subscribers].map((s) => this.closeSubscriber(s)));
  }

  /* -- Polling fallback --------------------------------------------------------------------- */

  private handleState(): Response {
    const row = this.ctx.storage.sql
      .exec<EventRow>(
        `SELECT seq, phase, progress, message, data, created_at FROM events ORDER BY seq DESC LIMIT 1`,
      )
      .toArray()[0];
    return Response.json({
      seq: row?.seq ?? 0,
      phase: row?.phase ?? null,
      progress: row?.progress ?? null,
      message: row?.message ?? null,
      terminal: this.terminal,
    });
  }

  /* -- Durable mirror ------------------------------------------------------------------------ */

  /**
   * Arms the batched mirror write.
   *
   * An alarm rather than `waitUntil`: the flush must survive the request that produced the event,
   * and it must coalesce — a run emits tens of events in a few seconds, and mirroring each one
   * individually would be tens of writes to the single D1 primary for a table nobody reads during
   * the run. Setting an alarm that is already set is a no-op, so this is safe to call per append.
   */
  private async scheduleMirror(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + MIRROR_DELAY_MS);
    }
  }

  /**
   * Flushes unmirrored events into `generation_job_events`, then retires the object.
   *
   * Guarantees the mirror carries the DO's `seq`, never D1's autoincrement, and that a redelivered
   * batch is idempotent (`ON CONFLICT(job_id, seq) DO NOTHING` in the statement itself).
   */
  public override async alarm(): Promise<void> {
    const outcome = await this.mirror();

    if (outcome === 'failed') {
      // The shard was unavailable. Back off rather than spin: the events are still in this object,
      // which is the copy a live client is reading anyway.
      await this.ctx.storage.setAlarm(Date.now() + MIRROR_DELAY_MS * 5);
      return;
    }
    if (outcome === 'more') {
      // A long run overflowed one batch. Come straight back rather than waiting for the next
      // append, which on a finished run would never arrive.
      await this.ctx.storage.setAlarm(Date.now() + 100);
      return;
    }

    if (this.terminal) {
      const expiry = await this.ctx.storage.get<number>('expiresAt');
      const now = Date.now();
      if (expiry === undefined) {
        await this.ctx.storage.put('expiresAt', now + RETENTION_AFTER_TERMINAL_MS);
        await this.ctx.storage.setAlarm(now + RETENTION_AFTER_TERMINAL_MS);
        return;
      }
      if (now >= expiry) {
        // Past the window the modal can possibly still be open. `generation_job_events` is the
        // durable record from here, and the nightly purge trims it at seven days.
        this.subscribers.clear();
        await this.ctx.storage.deleteAll();
        return;
      }
      await this.ctx.storage.setAlarm(expiry);
    }
  }

  /** Writes one batch of unmirrored rows. */
  private async mirror(): Promise<'done' | 'more' | 'failed'> {
    const jobId = this.jobId;
    if (jobId === null) return 'done';

    const sql = this.ctx.storage.sql;
    const rows = sql
      .exec<EventRow>(
        `SELECT seq, phase, progress, message, data, created_at
         FROM events WHERE mirrored = 0 ORDER BY seq LIMIT ?`,
        MIRROR_BATCH_SIZE,
      )
      .toArray();
    if (rows.length === 0) return 'done';

    let db: D1Database;
    try {
      db = shardById(this.shardId, this.env);
    } catch {
      // An unknown shard id is a dispatch bug, not a transient failure. Marking the rows mirrored
      // would lose them; leaving them unmirrored would retry forever. Reporting a failure backs the
      // alarm off and keeps the events readable from this object, which is where a live client
      // reads them from anyway.
      return 'failed';
    }

    try {
      await runBatch(
        db,
        rows.map((row) =>
          shard.generationJobs.insertJobEventStatement(db, {
            jobId,
            seq: row.seq,
            phase: row.phase as JobPhase,
            message: row.message,
            progress: row.progress,
            data: row.data,
            now: row.created_at,
          }),
        ),
      );
    } catch {
      return 'failed';
    }

    const lastSeq = rows[rows.length - 1]?.seq ?? 0;
    sql.exec(`UPDATE events SET mirrored = 1 WHERE mirrored = 0 AND seq <= ?`, lastSeq);
    return rows.length < MIRROR_BATCH_SIZE ? 'done' : 'more';
  }
}
