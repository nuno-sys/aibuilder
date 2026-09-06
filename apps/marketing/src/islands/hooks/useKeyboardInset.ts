/**
 * Keeps the sticky footer — and the primary conversion button in it — above the software keyboard.
 *
 * THIS IS NOT `env(safe-area-inset-bottom)`, AND CONFUSING THE TWO IS THE BUG. The safe-area inset
 * is the *notch and home indicator*: a constant, known at layout time, that does nothing whatsoever
 * about a keyboard. On iOS the **layout viewport does not shrink** when the keyboard opens — only
 * the *visual* viewport does — so a `position: sticky; bottom: 0` footer stays anchored to the
 * bottom of a viewport that is now behind the keyboard. The primary button of the whole funnel ends
 * up underneath the keys, on the majority platform, and it is a WCAG 2.4.11 (Focus Not Obscured)
 * failure on top of a conversion one.
 *
 * The fix has two halves and needs both:
 *
 *  1. **`interactive-widget=resizes-content` in the viewport meta**, which `layouts/Base.astro`
 *     already sets:
 *
 *         <meta name="viewport"
 *               content="width=device-width, initial-scale=1, viewport-fit=cover,
 *                        interactive-widget=resizes-content">
 *
 *     On the browsers that honour it (Chrome 108+ on Android) the layout viewport itself shrinks
 *     and the sticky footer behaves. It is a hint, not a guarantee, and Safari ignores it.
 *
 *  2. **This hook**, which measures the gap the visual viewport has lost and hands it back as a
 *     pixel offset the footer translates by. That covers iOS, older Android, and every browser
 *     that has not implemented the meta key.
 *
 * The offset is applied as a `transform`, never as `bottom` or `padding`: a transform is composited
 * and does not invalidate layout, so the footer tracks a keyboard animation at 60 fps instead of
 * triggering a reflow of the whole scroll container on every frame of it.
 */

import { useEffect, useState } from 'react';

/** Ignore sub-pixel noise; a viewport that "changed" by 2 px did not open a keyboard. */
const NOISE_THRESHOLD_PX = 8;

/**
 * Pixels the bottom of the visual viewport currently sits above the bottom of the layout viewport.
 *
 * `0` whenever no keyboard is open, on the server, and in browsers without `visualViewport`
 * (where the layout viewport resizes instead, so no compensation is needed and none is applied).
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (viewport === undefined || viewport === null) {
      return undefined;
    }

    let frame = 0;
    const measure = (): void => {
      // `offsetTop` matters: when the page is scrolled *inside* a shrunken visual viewport the
      // visual viewport's top moves, and the gap at the bottom is the difference between the layout
      // height and where the visual viewport ends — not simply the height difference.
      const occluded = window.innerHeight - (viewport.height + viewport.offsetTop);
      const next = occluded > NOISE_THRESHOLD_PX ? Math.round(occluded) : 0;
      setInset((previous) => (previous === next ? previous : next));
    };

    const schedule = (): void => {
      // Coalesced into one frame: `resize` and `scroll` both fire per keyboard-animation frame on
      // iOS, and measuring twice per frame is two forced layouts for one answer.
      if (frame !== 0) {
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };

    measure();
    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
    return () => {
      if (frame !== 0) {
        cancelAnimationFrame(frame);
      }
      viewport.removeEventListener('resize', schedule);
      viewport.removeEventListener('scroll', schedule);
    };
  }, []);

  return inset;
}
