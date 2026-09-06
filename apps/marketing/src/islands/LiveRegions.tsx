/**
 * The modal's two live regions, and the only place either is written.
 *
 * WHY THE CLEAR AND THE SET ARE ON SEPARATE TICKS, ~100 ms APART. A screen reader announces a live
 * region when it observes the region's contents *change*. Two identical consecutive messages —
 * "Foto 3 van 5 geüpload" twice — are not a change, so the second is silent. The fix is to blank
 * the region first. But blanking and refilling inside one task, or even across one animation frame,
 * is not observable either: the assistive technology polls the accessibility tree, and both writes
 * collapse into a single no-op mutation. 100 ms is comfortably above every engine's polling
 * interval and comfortably below the point where the delay is noticeable.
 *
 * WHY THE TEXT IS WRITTEN TO THE DOM DIRECTLY rather than held in React state: the timing above is
 * the entire contract, and routing it through a render would put React's scheduler — which may
 * batch, defer or replay under Suspense — between the two writes.
 *
 * WHY GENERATION IS THROTTLED TO ONE MESSAGE PER FOUR SECONDS. The SSE stream delivers a frame
 * roughly every 700 ms while copy is streaming. Announcing each one makes the whole 60-second wait
 * an unbroken monologue that cannot be interrupted, which is worse than no feedback at all.
 */

import { useEffect, useImperativeHandle, useRef } from 'react';
import type { Ref } from 'react';

/** Delay between blanking a region and writing the new message. */
const REANNOUNCE_DELAY_MS = 100;

/** Minimum gap between two generation announcements. */
const GENERATION_THROTTLE_MS = 4000;

/** The imperative surface. Every announcement in the island goes through one of these three. */
export interface LiveRegionsHandle {
  /** Status, progress, confirmations. Interrupts nothing. */
  polite(message: string): void;
  /** Validation failures and the completion of the build. Interrupts the current utterance. */
  assertive(message: string): void;
  /** Progress during generation, throttled. Dropped rather than queued when it arrives too soon. */
  generation(message: string): void;
}

/** Props: only the ref. The regions render nothing visible. */
export interface LiveRegionsProps {
  readonly ref?: Ref<LiveRegionsHandle>;
}

/**
 * Renders the polite and assertive regions and exposes the announcer.
 *
 * Guarantees that identical consecutive messages are re-announced, that a pending announcement is
 * cancelled when a newer one arrives (the newest state is the true one), and that no timer outlives
 * the component.
 */
export default function LiveRegions({ ref }: LiveRegionsProps) {
  const politeRef = useRef<HTMLDivElement | null>(null);
  const assertiveRef = useRef<HTMLDivElement | null>(null);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const lastGenerationAt = useRef(0);

  useEffect(
    () => () => {
      for (const timer of timers.current) {
        clearTimeout(timer);
      }
      timers.current = [];
    },
    [],
  );

  useImperativeHandle<LiveRegionsHandle, LiveRegionsHandle>(ref, () => {
    const write = (element: HTMLDivElement | null, message: string): void => {
      if (element === null || message.length === 0) {
        return;
      }
      // Cancel anything queued for either region: a superseded announcement is stale by
      // definition, and speaking it after the newer one would describe the wrong state.
      for (const timer of timers.current) {
        clearTimeout(timer);
      }
      timers.current = [];
      element.textContent = '';
      timers.current.push(
        setTimeout(() => {
          element.textContent = message;
        }, REANNOUNCE_DELAY_MS),
      );
    };

    return {
      polite: (message) => {
        write(politeRef.current, message);
      },
      assertive: (message) => {
        write(assertiveRef.current, message);
      },
      generation: (message) => {
        const now = Date.now();
        if (now - lastGenerationAt.current < GENERATION_THROTTLE_MS) {
          return;
        }
        lastGenerationAt.current = now;
        write(politeRef.current, message);
      },
    };
  }, []);

  return (
    <>
      {/* `aria-atomic` so the whole message is read, not just the words that changed. */}
      <div ref={politeRef} className="sr-only" aria-live="polite" aria-atomic="true" />
      {/* `role="alert"` carries an implicit `aria-live="assertive"`; both are not set, because
          duplicating it makes some engines announce twice. */}
      <div ref={assertiveRef} className="sr-only" role="alert" aria-atomic="true" />
    </>
  );
}
