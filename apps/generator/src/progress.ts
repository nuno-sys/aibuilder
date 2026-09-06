import type { JobPhase } from '@aibuilder/db';
import type { StreamDelta } from '@aibuilder/ai';

import type { Env, SiteGenerationParams } from './env';
import { jobHubStub } from './do/jurisdiction';

/**
 * Progress emission — the client half of the `JobHub` contract.
 *
 * IDEMPOTENCE IS THE WHOLE DESIGN HERE, AND IT IS NOT OPTIONAL. A Workflow's `run()` is REPLAYED in
 * full on every resume: on a retry, on an eviction, on a deploy. Memoised steps return their cached
 * result without re-running their bodies, but every statement between them executes again, from the
 * top, every time. An `emit()` in the bare function body therefore re-fires on each attempt — and
 * against an append-only log that means a duplicate row per replay, a progress bar that jumps
 * backwards, and the destruction of the one thing the DO exists for (architecture §6.1).
 *
 * So there are exactly two ways to emit, and both are safe:
 *
 *   `emit(label, …)`  carries a stable idempotency key, `${runId}:${label}`, where `label` is a
 *                     string LITERAL at the call site. The DO collapses replays of the same key
 *                     onto the row it already wrote and returns its original `seq`. The label is
 *                     deliberately not a counter: a counter incremented as the body runs would
 *                     diverge between the first pass (where step bodies execute and may emit) and a
 *                     replay (where they do not), and two runs would disagree about which event is
 *                     number four.
 *
 *   `delta(…)`        keyless, and only ever called from INSIDE a `step.do()`. A step retry
 *                     genuinely produces new tokens, so a repeat is new information rather than a
 *                     duplicate, and the client maps phase to UI act many-to-one with acts
 *                     advancing monotonically (§S4) — so a second streaming burst updates the
 *                     detail line without moving the rail backwards.
 *
 * Emission never fails a generation. A JobHub that cannot be reached costs the customer a progress
 * bar; failing the step would cost them the site.
 */

/** One user-facing line, in the product's primary language and in English. */
export interface Phrase {
  readonly nl: string;
  readonly en: string;
}

/**
 * The progress percentage each phase reports.
 *
 * Monotonic by construction: the client is told to advance acts monotonically, and handing it a
 * lower number than it already has is how a progress bar goes backwards. The gaps are proportional
 * to observed wall clock, not to step count — `copy-primary` is the longest wait in the run and
 * gets the widest band.
 */
export const PHASE_PROGRESS: Readonly<Record<JobPhase, number>> = {
  queued: 2,
  prompt_built: 8,
  media_fetch: 16,
  api_call: 22,
  thinking: 28,
  streaming: 45,
  parsing: 66,
  pages_written: 74,
  build: 84,
  deploy: 94,
  done: 100,
  // `error` keeps whatever the rail last showed; overwriting it with 0 would erase the context the
  // failure message is read against.
  error: 0,
};

/** Everything one emitted event carries. */
export interface ProgressEvent {
  readonly phase: JobPhase;
  /** Defaults to `PHASE_PROGRESS[phase]`. Set explicitly only to interpolate inside a long step. */
  readonly progress?: number;
  readonly message: Phrase;
  /** Structured detail for the modal: `{ slot, text }` while streaming, counts elsewhere. */
  readonly data?: Readonly<Record<string, unknown>>;
}

/** Posts progress for one run. */
export interface ProgressEmitter {
  /** Exactly-once per `label` across every replay of this run. */
  emit(label: string, event: ProgressEvent): Promise<void>;
  /** Best-effort, unkeyed. Only legal inside a `step.do()`. */
  delta(event: ProgressEvent): void;
  /** A rate-limited sink for streamed model tokens, for `StepContext.onDelta`. */
  deltaSink(phase: 'thinking' | 'streaming', progress: number): (delta: StreamDelta) => void;
}

/** At most one streamed frame per this many milliseconds. */
const DELTA_INTERVAL_MS = 700;

/** Longest streamed excerpt forwarded to the modal. A detail line, not a transcript. */
const DELTA_EXCERPT = 180;

/**
 * Builds the emitter for one run.
 *
 * Guarantees no method throws, and that `runId` — not the job id — is what keys idempotence, so a
 * Phase 2 re-run of the same job under a new Workflow instance emits its own events rather than
 * being silently deduplicated against the first run's.
 */
export function createProgressEmitter(
  env: Env,
  params: SiteGenerationParams,
  runId: string,
): ProgressEmitter {
  const post = async (body: Record<string, unknown>): Promise<void> => {
    try {
      await jobHubStub(env, params.jobId).fetch('https://job-hub.internal/append', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId: params.jobId, shardId: params.shardId, ...body }),
      });
    } catch {
      // Deliberately swallowed. See the header: progress is not worth a generation.
    }
  };

  const frame = (event: ProgressEvent, eventKey: string | null): Record<string, unknown> => ({
    phase: event.phase,
    progress: event.progress ?? PHASE_PROGRESS[event.phase],
    message: event.message.nl,
    // The English line rides in `data` rather than in a second column: `generation_job_events` has
    // one `message`, and a parallel column would have to be kept in sync by every writer.
    data: { ...(event.data ?? {}), en: event.message.en },
    eventKey,
  });

  return {
    async emit(label: string, event: ProgressEvent): Promise<void> {
      await post(frame(event, `${runId}:${label}`));
    },

    delta(event: ProgressEvent): void {
      void post(frame(event, null));
    },

    deltaSink(phase: 'thinking' | 'streaming', progress: number) {
      let lastAt = 0;
      return (delta: StreamDelta): void => {
        const now = Date.now();
        if (now - lastAt < DELTA_INTERVAL_MS) return;
        lastAt = now;
        // The tail rather than the head: the interesting part of a streaming document is the part
        // that just arrived, and the head is the same JSON preamble on every call.
        const excerpt = delta.text.slice(-DELTA_EXCERPT);
        if (excerpt.trim().length === 0) return;
        void post(
          frame(
            {
              phase: delta.kind === 'thinking' ? 'thinking' : phase,
              progress,
              message:
                delta.kind === 'thinking'
                  ? {
                      nl: 'We denken na over de opbouw…',
                      en: 'Thinking through the structure…',
                    }
                  : { nl: 'We schrijven de teksten…', en: 'Writing the copy…' },
              data: { kind: delta.kind, text: excerpt },
            },
            null,
          ),
        );
      };
    },
  };
}
