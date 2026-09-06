/**
 * The step container: directional slide, crossfade, measured height, and focus that lands last.
 *
 * THE TRANSITION (UX §5.4)
 *   outgoing  opacity 1→0, translateX(0 → ∓24px)   160 ms  --ease-in
 *   incoming  opacity 0→1, translateX(±24px → 0)   240 ms  --ease-out-quint, after an 80 ms gap
 *   height    measured → measured                  260 ms  --ease-out-quint
 * Forward slides in from the right, back from the left. Total perceived time ≈ 320 ms, which is
 * under the ~400 ms threshold where a transition stops reading as a response and starts reading as
 * a wait.
 *
 * WHY THE HEIGHT IS MEASURED RATHER THAN LEFT TO `auto`. `height: auto` cannot be transitioned in
 * any browser this product must support (`interpolate-size` is Chromium-only), so an unmeasured
 * container snaps between step heights — which on a modal filling most of the viewport is a jolt
 * big enough to lose the user's place. A `ResizeObserver` on the inner content keeps the measured
 * value current, which also handles a step that grows *while it is displayed*: an inline error
 * appearing, the hours grid expanding, a third media row wrapping.
 *
 * WHY FOCUS MOVES AFTER THE TRANSITION, NEVER DURING. Focusing a moving element makes a screen
 * reader read a target that is still animating (several engines re-announce mid-flight), and on iOS
 * it yanks the viewport towards an element whose position changes every frame. The step heading
 * carries `tabindex="-1"` and takes focus once the incoming animation has finished — which also
 * means the full step context is read before the field rather than the field alone.
 *
 * WHY THE OUTGOING STEP IS SNAPSHOTTED IN A LAYOUT EFFECT. The parent hands over the *new* step's
 * children in the same render in which `stepId` changes. Capturing the previous render's node in a
 * passive effect would leave one painted frame showing the new content before the outgoing
 * animation starts; a layout effect runs before that paint, so the swap is never visible.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { cssVars, useMotionTiming } from '../lib/motion';

import styles from './StepShell.module.css';

/**
 * `useLayoutEffect` in the browser, `useEffect` during Astro's server render.
 *
 * The island is server-rendered as part of the page HTML; React warns about layout effects there,
 * and the warning is correct — there is no layout to read.
 */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Which way the wizard is moving; decides which side the incoming step arrives from. */
export type StepDirection = 'forward' | 'back';

export interface StepShellProps {
  /** Changing this starts a transition. Use the step's stable id, never its index. */
  readonly stepId: string;
  readonly direction: StepDirection;
  readonly headingId: string;
  readonly heading: string;
  readonly helperId: string;
  readonly helper: string;
  /**
   * `'heading'` on steps 2–6 so the step context is read first. Step 1 passes `'none'` and focuses
   * its own field instead: it is the fastest path to typing, and the field IS the step.
   */
  readonly autoFocus: 'heading' | 'none';
  /** Fired once the incoming step has settled and focus has moved. */
  readonly onEntered?: (() => void) | undefined;
  readonly children: ReactNode;
}

/** One renderable step, captured so the outgoing one can outlive its props. */
interface Snapshot {
  readonly stepId: string;
  readonly heading: string;
  readonly helper: string;
  readonly node: ReactNode;
}

/**
 * Renders one step with the transition above.
 *
 * Guarantees the container's height is animated between two measured values, that `will-change` is
 * present only while something is actually moving, and that focus lands exactly once per step.
 */
export default function StepShell({
  stepId,
  direction,
  headingId,
  helperId,
  heading,
  helper,
  autoFocus,
  onEntered,
  children,
}: StepShellProps) {
  const timing = useMotionTiming();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const onEnteredRef = useRef(onEntered);
  onEnteredRef.current = onEntered;

  /** The previous render's step, updated after paint so a layout effect can still read it. */
  const previousRender = useRef<Snapshot>({ stepId, heading, helper, node: children });
  const shownStepId = useRef(stepId);

  const [outgoing, setOutgoing] = useState<Snapshot | null>(null);
  const [phase, setPhase] = useState<'idle' | 'out' | 'in'>('idle');
  const [height, setHeight] = useState<number | null>(null);

  useIsomorphicLayoutEffect(() => {
    if (shownStepId.current === stepId) {
      return undefined;
    }
    shownStepId.current = stepId;
    setOutgoing(previousRender.current);
    setPhase('out');
    const swap = setTimeout(() => {
      setOutgoing(null);
      setPhase('in');
    }, timing.stepOut + timing.stepDelay);
    return () => {
      clearTimeout(swap);
    };
  }, [stepId, timing.stepOut, timing.stepDelay]);

  useEffect(() => {
    previousRender.current = { stepId, heading, helper, node: children };
  });

  useEffect(() => {
    if (phase !== 'in') {
      return undefined;
    }
    const settle = setTimeout(() => {
      setPhase('idle');
      if (autoFocus === 'heading') {
        headingRef.current?.focus({ preventScroll: true });
      }
      onEnteredRef.current?.();
    }, timing.stepIn);
    return () => {
      clearTimeout(settle);
    };
  }, [phase, autoFocus, timing.stepIn]);

  // Height measurement. A layout effect so the first measurement is applied before paint and the
  // container never renders at the wrong height for a frame.
  useIsomorphicLayoutEffect(() => {
    const element = contentRef.current;
    if (element === null || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const measure = (): void => {
      const next = Math.ceil(element.getBoundingClientRect().height);
      setHeight((previous) => (previous === next ? previous : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  const shown: Snapshot =
    phase === 'out' && outgoing !== null ? outgoing : { stepId, heading, helper, node: children };

  const phaseClass =
    phase === 'out' ? styles.leaving : phase === 'in' ? styles.entering : styles.settled;

  return (
    <div
      className={styles.viewport}
      data-measured={height === null ? 'false' : 'true'}
      style={cssVars({
        ...(height === null ? {} : { '--step-height': `${String(height)}px` }),
        '--step-out': `${String(timing.stepOut)}ms`,
        '--step-in': `${String(timing.stepIn)}ms`,
        '--step-height-duration': `${String(timing.stepHeight)}ms`,
        // Forward: the incoming step arrives from the right, the outgoing one leaves to the left.
        '--step-offset': direction === 'forward' ? '24px' : '-24px',
      })}
    >
      <div ref={contentRef} className={`${styles.pane} ${phaseClass}`}>
        <h2 ref={headingRef} id={headingId} className={styles.heading} tabIndex={-1}>
          {shown.heading}
        </h2>
        <p id={helperId} className={styles.helper}>
          {shown.helper}
        </p>
        <div className={styles.body}>{shown.node}</div>
      </div>
    </div>
  );
}
