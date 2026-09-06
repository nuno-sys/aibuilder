/**
 * The generation event stream: `EventSource`, then polling when the stream cannot be kept up.
 *
 * TWO NON-OBVIOUS FACTS THIS HOOK IS BUILT AROUND.
 *
 *  1. **`event: error` from the server and a connection failure arrive on the same listener.** A
 *     named SSE event called `error` is dispatched on the `EventSource` exactly like the built-in
 *     transport error is. They are told apart by their type: a server event is a `MessageEvent`
 *     with a string `data`, a transport failure is a bare `Event`. Getting this wrong means either
 *     a dropped failure message or an infinite reconnect on a job that has already failed.
 *
 *  2. **A manual reconnect loses `Last-Event-ID`.** The browser sends that header automatically on
 *     *its own* reconnects, but a freshly constructed `EventSource` has an empty last event id, and
 *     `EventSource` cannot set request headers. That is fine here and deliberately so: the JobHub
 *     replays its whole buffer from `lastEventId = 0`, and this hook drops any event whose `seq` it
 *     has already seen. Resumption is therefore idempotent by sequence number rather than by
 *     transport state, which is also what makes the polling fallback interchangeable with the
 *     stream.
 *
 * After two consecutive failed connections the stream is abandoned for 2-second polling of
 * `GET /v1/jobs/:jobId`. Some corporate proxies and a few mobile carriers buffer or terminate
 * `text/event-stream`; those customers still watch their site being built.
 */

import { useEffect, useRef, useState } from 'react';

import { getJobStatus, jobEventsUrl } from '../../lib/api';

/** The twelve phases of `generation_job_events`. The client maps them many-to-one onto UI acts. */
export type GenerationPhase =
  | 'queued'
  | 'prompt_built'
  | 'api_call'
  | 'thinking'
  | 'streaming'
  | 'parsing'
  | 'pages_written'
  | 'media_fetch'
  | 'build'
  | 'deploy'
  | 'done'
  | 'error';

/** Every phase, for narrowing an untrusted string off the wire. */
const PHASES: ReadonlySet<string> = new Set<GenerationPhase>([
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
]);

/** One event, normalised from either transport. */
export interface GenerationEvent {
  /** DO-assigned sequence number. Monotonic per job; the dedup key. */
  readonly seq: number;
  readonly phase: GenerationPhase;
  /** 0–100, as the server computed it. */
  readonly progress: number;
  /** The Dutch line. `data.en` carries the English one. */
  readonly message: string | null;
  /** Structured detail: `{ slot, text }` while streaming, counts elsewhere, `en` always. */
  readonly data: Readonly<Record<string, unknown>> | null;
}

/** How the events are currently arriving. */
export type SseConnection = 'idle' | 'connecting' | 'live' | 'polling' | 'closed';

/** Consecutive stream failures before the fallback takes over. */
const MAX_STREAM_FAILURES = 2;

/** Polling interval of the fallback. */
const POLL_INTERVAL_MS = 2000;

/** Narrows a parsed SSE payload into a `GenerationEvent`, or `null` if it is not one. */
function toEvent(raw: unknown): GenerationEvent | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const seq = record['seq'];
  const phase = record['phase'];
  const progress = record['progress'];
  if (typeof seq !== 'number' || typeof phase !== 'string' || !PHASES.has(phase)) {
    return null;
  }
  const data = record['data'];
  return {
    seq,
    phase: phase as GenerationPhase,
    progress: typeof progress === 'number' ? progress : 0,
    message: typeof record['message'] === 'string' ? record['message'] : null,
    data: typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null,
  };
}

/** What the caller gets back. */
export interface UseSseResult {
  readonly connection: SseConnection;
  /** Milliseconds since the last event of any kind. Drives the "taking longer" copy. */
  readonly silentFor: number;
}

/**
 * Subscribes to one job's events.
 *
 * `onEvent` is called once per event, in sequence order, with duplicates already removed — a
 * replayed buffer after a reconnect produces no repeated announcements and never moves the rail
 * backwards. Passing `jobId: null` keeps the hook dormant.
 *
 * The callback is read through a ref, so a caller may pass an inline closure without tearing down
 * and rebuilding the connection on every render.
 */
export function useSSE(params: {
  jobId: string | null;
  eventsPath: string | null;
  onEvent: (event: GenerationEvent) => void;
}): UseSseResult {
  const { jobId, eventsPath } = params;
  const [connection, setConnection] = useState<SseConnection>('idle');
  const [silentFor, setSilentFor] = useState(0);

  const onEventRef = useRef(params.onEvent);
  const lastSeq = useRef(0);
  const lastEventAt = useRef(Date.now());

  useEffect(() => {
    onEventRef.current = params.onEvent;
  }, [params.onEvent]);

  useEffect(() => {
    if (jobId === null || eventsPath === null) {
      setConnection('idle');
      return undefined;
    }

    let source: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let failures = 0;
    let stopped = false;

    const deliver = (event: GenerationEvent | null): void => {
      if (event === null || event.seq <= lastSeq.current) {
        return;
      }
      lastSeq.current = event.seq;
      lastEventAt.current = Date.now();
      setSilentFor(0);
      onEventRef.current(event);
    };

    const stop = (): void => {
      stopped = true;
      source?.close();
      source = null;
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const startPolling = (): void => {
      if (stopped || pollTimer !== null) {
        return;
      }
      setConnection('polling');
      let pollSeq = lastSeq.current;
      pollTimer = setInterval(() => {
        void (async () => {
          try {
            const status = await getJobStatus(jobId);
            const phase = PHASES.has(status.phase) ? (status.phase as GenerationPhase) : 'queued';
            // The polling route has no sequence numbers, so one is synthesised. It only has to be
            // monotonic and disjoint from the stream's, which it is: the stream is gone by now.
            pollSeq += 1;
            deliver({
              seq: pollSeq,
              phase,
              progress: status.progress,
              message: status.message,
              data: status.siteUrl === undefined ? null : { siteUrl: status.siteUrl },
            });
            if (phase === 'done' || phase === 'error') {
              stop();
              setConnection('closed');
            }
          } catch {
            // A failed poll is not fatal: the next one is two seconds away and the job is running
            // regardless of whether anyone is watching.
          }
        })();
      }, POLL_INTERVAL_MS);
    };

    // Typed as `Event` rather than `MessageEvent` because `EventSource.addEventListener` narrows
    // the listener signature only for its three built-in names; a custom event name goes through
    // the `EventListener` overload, whose parameter is `Event`. The payload is narrowed here.
    const onMessage = (event: Event): void => {
      if (!(event instanceof MessageEvent) || typeof event.data !== 'string') {
        return;
      }
      failures = 0;
      setConnection('live');
      try {
        deliver(toEvent(JSON.parse(event.data)));
      } catch {
        // A malformed frame is dropped. One bad line must not kill a stream that is otherwise fine.
      }
    };

    const connect = (): void => {
      setConnection('connecting');
      // `withCredentials` is what carries the `__Host-aib_draft` cookie cross-origin; without it
      // every connection — including every automatic reconnect — is unauthorised.
      source = new EventSource(jobEventsUrl(eventsPath), { withCredentials: true });
      source.addEventListener('open', () => {
        failures = 0;
        setConnection('live');
      });
      source.addEventListener('progress', onMessage);
      source.addEventListener('done', (event: Event) => {
        onMessage(event);
        stop();
        setConnection('closed');
      });
      source.addEventListener('error', (event: Event) => {
        // See the module header: a server-sent `error` event and a transport failure land here
        // together, and only the payload tells them apart.
        if (event instanceof MessageEvent && typeof event.data === 'string') {
          onMessage(event);
          stop();
          setConnection('closed');
          return;
        }
        failures += 1;
        if (failures >= MAX_STREAM_FAILURES) {
          source?.close();
          source = null;
          startPolling();
        }
      });
    };

    connect();

    // One shared ticker for the silence counter. The theatre reads it to decide when to show the
    // honest "this is taking longer" line and, later, the email-and-release offer.
    const silenceTimer = setInterval(() => {
      setSilentFor(Date.now() - lastEventAt.current);
    }, 1000);

    return () => {
      clearInterval(silenceTimer);
      stop();
    };
  }, [jobId, eventsPath]);

  return { connection, silentFor };
}
