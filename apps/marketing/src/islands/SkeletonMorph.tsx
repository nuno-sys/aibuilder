/**
 * The live preview: skeleton blocks that become the customer's real copy as it is streamed.
 *
 * THIS IS THE PRODUCT'S CENTRAL ILLUSION, AND IT IS NOT AN ILLUSION. Every line that appears here
 * arrived in an SSE frame carrying `{ slot, text }` from the model that is writing the site. The
 * wait is not masked with a spinner; it is filled with the thing being waited for.
 *
 * THE MORPH (UX §5.5). When a slot's text arrives: measure the skeleton's height, swap in the real
 * text, measure again, apply the OLD height with no transition, then release it on the next frame
 * so the block interpolates to its new size over 220 ms while the text fades in over 160 ms with a
 * 4 px rise. Without the measure-invert-release the block jumps and the eye loses the line it was
 * reading.
 *
 * WHAT THE IMAGE SLOTS DO IN PHASE 1. There are no real photographs to crossfade into yet — media
 * selection happens server-side and the marketing CSP allows images from `'self'`, `data:` and
 * `blob:` only. The image slots therefore resolve from a neutral placeholder to the site's own
 * palette, which is honest about what is known at that moment rather than pretending a photo has
 * been chosen.
 */

import { useEffect, useLayoutEffect, useRef } from 'react';

import { cssVars, useMotionTiming } from '../lib/motion';

import styles from './Generation.module.css';

/** Duration of the size interpolation when a skeleton becomes text. */
const MORPH_MS = 220;

/** Duration of the text fade-in that follows it. */
const FADE_MS = 160;

/** The slots the preview lays out, in the order a homepage reads. */
export const PREVIEW_SLOTS = [
  'hero.headline',
  'hero.sub',
  'services.item.1',
  'services.item.2',
  'services.item.3',
  'about.body',
] as const;

/** One preview slot id. */
export type PreviewSlot = (typeof PREVIEW_SLOTS)[number];

/** How many skeleton lines each slot shows before its text arrives. */
const SLOT_LINES: Readonly<Record<PreviewSlot, number>> = {
  'hero.headline': 1,
  'hero.sub': 2,
  'services.item.1': 1,
  'services.item.2': 1,
  'services.item.3': 1,
  'about.body': 4,
};

/** Renders one slot, animating the swap from skeleton to text. */
function Slot({
  slot,
  text,
  reduced,
}: {
  readonly slot: PreviewSlot;
  readonly text: string | null;
  readonly reduced: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const lastHeight = useRef<number | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    const next = element.getBoundingClientRect().height;
    const previous = lastHeight.current;
    lastHeight.current = next;
    if (previous === null || previous === next || reduced) {
      return;
    }
    element.style.transition = 'none';
    element.style.height = `${String(previous)}px`;
    requestAnimationFrame(() => {
      element.style.transition = `height ${String(MORPH_MS)}ms var(--ease-out-quint)`;
      element.style.height = `${String(next)}px`;
    });
  }, [text, reduced]);

  // The fixed height is released once the interpolation has finished, so the block can keep growing
  // if a later frame extends the same slot.
  useEffect(() => {
    const element = ref.current;
    if (element === null) {
      return undefined;
    }
    const onEnd = (): void => {
      element.style.height = '';
      element.style.transition = '';
    };
    element.addEventListener('transitionend', onEnd);
    return () => {
      element.removeEventListener('transitionend', onEnd);
    };
  }, []);

  return (
    <div ref={ref} className={styles.slot} data-slot={slot}>
      {text === null ? (
        <div className={styles.skeletonGroup} aria-hidden="true">
          {Array.from({ length: SLOT_LINES[slot] }, (_unused, line) => (
            <span
              key={`${slot}-${String(line)}`}
              className={styles.skeletonLine}
              style={cssVars({ '--line-width': line === SLOT_LINES[slot] - 1 ? '62%' : '100%' })}
            />
          ))}
        </div>
      ) : (
        <p
          className={`${styles.slotText} ${slot === 'hero.headline' ? styles.slotHeadline : ''}`}
          style={cssVars({ '--fade': `${String(FADE_MS)}ms` })}
        >
          {text}
        </p>
      )}
    </div>
  );
}

export interface SkeletonMorphProps {
  /** Slot id → the text that has arrived for it. Missing keys render as skeletons. */
  readonly slots: ReadonlyMap<string, string>;
  /** The current act, 0–8. Drives the palette and image reveals. */
  readonly act: number;
  /** The business name, painted into the preview's chrome from the first frame. */
  readonly businessName: string;
}

/**
 * Renders the preview panel.
 *
 * Guarantees that a slot never shrinks back to a skeleton once its text has arrived, and that the
 * whole panel is `aria-hidden`: it is a *visualisation* of progress that the status rail already
 * announces in words, and reading a half-written homepage aloud is not useful.
 */
export default function SkeletonMorph({ slots, act, businessName }: SkeletonMorphProps) {
  const timing = useMotionTiming();

  return (
    <div className={styles.preview} aria-hidden="true">
      <div className={styles.previewChrome}>
        <span className={styles.previewDot} />
        <span className={styles.previewDot} />
        <span className={styles.previewDot} />
        <span className={styles.previewTitle}>{businessName}</span>
      </div>

      <div className={`${styles.previewBody} ${act >= 2 ? styles.previewThemed : ''}`}>
        {/* Act 2 paints the palette: five swatches wipe across before any copy exists, which is the
            first visible proof that the design is being chosen for this business. */}
        <div className={`${styles.palette} ${act >= 2 ? styles.paletteOn : ''}`}>
          {[0, 1, 2, 3, 4].map((index) => (
            <span
              key={index}
              className={styles.swatch}
              style={cssVars({ '--swatch-delay': `${String(index * 60)}ms` })}
            />
          ))}
        </div>

        <div className={`${styles.previewMedia} ${act >= 5 ? styles.previewMediaResolved : ''}`} />

        {PREVIEW_SLOTS.map((slot) => (
          <Slot key={slot} slot={slot} text={slots.get(slot) ?? null} reduced={timing.reduced} />
        ))}
      </div>
    </div>
  );
}
