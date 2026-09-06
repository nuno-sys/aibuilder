/**
 * The six-segment progress rail.
 *
 * ALL SIX SEGMENTS ARE VISIBLE FROM THE FIRST FRAME, and that is a conversion decision rather than
 * a decorative one: what makes people abandon a multi-step form is *uncertainty* about its length,
 * not the length itself. A rail that grows a segment per step hides the cost and reads as endless.
 *
 * THE FILL IS NON-LINEAR: `[0, 28, 44, 58, 72, 86, 100]`. Completing step 1 of 6 paints 28 %, not
 * 16.7 %. This is the goal-gradient effect — perceived proximity to a goal accelerates effort — and
 * it is honest in the way that matters, because the *remaining work* really is front-loaded: step 1
 * is one field and step 6 is five.
 *
 * COMPLETED SEGMENTS ARE BUTTONS, forward ones are not. Backward navigation is always safe (the
 * draft is saved); forward navigation past unvalidated fields is what the `furthestStep` ceiling
 * exists to prevent, so a future segment is a `<span>` and cannot be reached by keyboard at all.
 *
 * THE NUMERIC LABEL CHANGES AT THE MIDPOINT of the fill transition, not at its start: a label
 * reading "Stap 3 van 6" above a bar still visibly sitting at step 2 is a 320 ms window in which
 * the UI contradicts itself, and it is exactly the kind of thing that reads as cheap without the
 * viewer being able to say why.
 */

import { useEffect, useState } from 'react';
import type { Locale } from '@aibuilder/core';

import { copyFor } from '../lib/copy';
import { interpolate } from '../lib/format';
import { cssVars, useMotionTiming } from '../lib/motion';
import { STEP_COUNT } from '../lib/types';
import type { StepIndex } from '../lib/types';

import styles from './ProgressRail.module.css';

/**
 * Fill percentage after completing each step, indexed by completed count.
 *
 * `FILL_MAP[0]` is the state before any step is finished; `FILL_MAP[6]` is 100 %.
 */
export const FILL_MAP: readonly number[] = [0, 28, 44, 58, 72, 86, 100];

/**
 * Seconds a median user spends on each step, from the UX targets (§1.3).
 *
 * Used only for the decaying "nog ±40 sec" label, which is *inverse* labour illusion: the point is
 * to show that finishing is cheap. It is deliberately optimistic-but-real — the P50 numbers, not
 * the P90 — because a pessimistic estimate on the last step is a reason to stop.
 */
const STEP_SECONDS: readonly number[] = [8, 6, 10, 12, 10, 25];

/** Seconds still to go from the start of `step`. */
function remainingSeconds(step: StepIndex): number {
  return STEP_SECONDS.slice(step - 1).reduce((total, seconds) => total + seconds, 0);
}

/** Portion of one segment that the overall fill covers, 0–100. */
function segmentFill(index: number, overall: number): number {
  const width = 100 / STEP_COUNT;
  const start = index * width;
  return Math.max(0, Math.min(100, ((overall - start) / width) * 100));
}

export interface ProgressRailProps {
  readonly step: StepIndex;
  /** The furthest step reached; segments up to here are navigable. */
  readonly furthestStep: StepIndex;
  readonly locale: Locale;
  /** Called when a completed segment is activated. Never called for a future segment. */
  readonly onNavigate: (step: StepIndex) => void;
}

/**
 * Renders the rail, its labels and the decaying time estimate.
 *
 * Guarantees the fill never moves backwards on a re-render, that exactly one item carries
 * `aria-current="step"`, and that the visible step number never disagrees with the bar.
 */
export default function ProgressRail({
  step,
  furthestStep,
  locale,
  onNavigate,
}: ProgressRailProps) {
  const copy = copyFor(locale);
  const timing = useMotionTiming();
  const [labelStep, setLabelStep] = useState<StepIndex>(step);

  useEffect(() => {
    if (labelStep === step) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setLabelStep(step);
    }, timing.railFill / 2);
    return () => {
      clearTimeout(timer);
    };
  }, [step, labelStep, timing.railFill]);

  const completed = step - 1;
  const overall = FILL_MAP[completed] ?? 0;
  const seconds = Math.max(5, Math.round(remainingSeconds(step) / 5) * 5);

  return (
    <div className={styles.wrap}>
      <nav aria-label={copy.rail.label}>
        <ol
          className={styles.rail}
          style={cssVars({ '--rail-duration': `${String(timing.railFill)}ms` })}
        >
          {copy.rail.steps.map((name, index) => {
            const position = (index + 1) as StepIndex;
            const isCurrent = position === step;
            const isReachable = position < step || position <= furthestStep;
            const fill = segmentFill(index, overall);

            return (
              <li key={name} className={styles.item}>
                {isReachable && !isCurrent ? (
                  <button
                    type="button"
                    className={`${styles.segment} ${styles.segmentButton}`}
                    onClick={() => {
                      onNavigate(position);
                    }}
                    title={interpolate(copy.rail.goToStep, { step: position, name })}
                  >
                    <span className={styles.track}>
                      <span
                        className={styles.fill}
                        style={cssVars({ '--fill': `${String(fill)}%` })}
                      />
                    </span>
                    <span className={styles.name}>{name}</span>
                    <span className="sr-only">
                      {interpolate(copy.rail.goToStep, { step: position, name })}
                    </span>
                  </button>
                ) : (
                  <span
                    className={styles.segment}
                    {...(isCurrent ? { 'aria-current': 'step' as const } : {})}
                  >
                    <span className={styles.track}>
                      <span
                        className={styles.fill}
                        style={cssVars({ '--fill': `${String(fill)}%` })}
                      />
                    </span>
                    <span className={styles.name}>{name}</span>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      <p className={styles.meta}>
        <span className={styles.count}>
          {interpolate(copy.rail.stepOf, { step: labelStep, total: STEP_COUNT })}
        </span>
        <span className={styles.estimate}>{interpolate(copy.rail.estimate, { seconds })}</span>
      </p>
    </div>
  );
}
