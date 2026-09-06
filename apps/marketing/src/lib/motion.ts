/**
 * Motion tokens and the reduced-motion switch (UX §5.1, §5.6, architecture §S6).
 *
 * The numbers below MIRROR `src/styles/tokens.css` — they are not a second source of truth, they
 * are the same values in the one form CSS cannot provide: JavaScript has to know how long a
 * transition lasts to sequence what happens after it (move focus, announce a step, drop
 * `will-change`). Reading them back with `getComputedStyle` per transition would be a layout read
 * on every step change for no benefit, so they are duplicated here and must be changed together.
 *
 * WHY REDUCED MOTION IS NOT SIMPLY "NO ANIMATION". `prefers-reduced-motion: reduce` means *less
 * vestibular provocation*, not *less feedback*. The global rule in `base.css` collapses every
 * duration to ~0.01 ms; this module re-enables the three opacity-only essentials the UX spec calls
 * out, because a modal that teleports and a progress bar that does not move both read as broken:
 *
 *   - modal enter/exit — 120 ms crossfade, no transform, no backdrop blur
 *   - step change      — 100 ms crossfade, no slide, height jumps rather than animating
 *   - progress rail    — the `width` transition is KEPT; only the asymptotic interpolation between
 *                        SSE events is disabled, so the bar steps on real events and never drifts
 *
 * Everything else — confetti, the sheen sweep, the auto-scroll, the typing domain, the skeleton
 * shimmer, the blurhash blur-up — is removed and replaced by its final state.
 */

import { useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';

/** `--dur-1` … `--dur-7`, in milliseconds. */
export const DURATION = {
  d1: 80,
  d2: 120,
  d3: 180,
  d4: 240,
  d5: 320,
  d6: 480,
  d7: 720,
} as const;

/** `--ease-*`, as CSS values, for the rare inline style that cannot use a custom property. */
export const EASING = {
  outQuint: 'cubic-bezier(0.22, 1, 0.36, 1)',
  inOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
  in: 'cubic-bezier(0.32, 0, 0.67, 0)',
} as const;

/** Per-item delay of a staggered entrance (`--stagger`). */
export const STAGGER_MS = 40;

/** The media query the whole switch turns on. */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * The durations the island sequences against, resolved for the current motion preference.
 *
 * Every value is a duration in milliseconds that some `setTimeout`, `ResizeObserver` handler or
 * `transitionend` guard depends on. They are returned as one object so a component never has to
 * decide which branch it is in.
 */
export interface MotionTiming {
  /** Panel + backdrop entrance. Focus lands after this (UX §5.2). */
  readonly modalEnter: number;
  /** Exit is always faster than entrance — an exit that lingers feels like a hang. */
  readonly modalExit: number;
  /** Outgoing step: fade + slide away. */
  readonly stepOut: number;
  /** Incoming step: fade + slide in, after `stepDelay`. */
  readonly stepIn: number;
  /** Gap between the outgoing step leaving and the incoming one starting. */
  readonly stepDelay: number;
  /** Container height interpolation between two measured heights. */
  readonly stepHeight: number;
  /** Progress rail fill. Kept under reduced motion — see the module header. */
  readonly railFill: number;
  /** The reveal's un-blur and scale-up. */
  readonly reveal: number;
  /** True when transforms, blurs and decorative animation must be suppressed entirely. */
  readonly reduced: boolean;
}

/** Full-motion timings, straight from UX §5.2–§5.5. */
const FULL_MOTION: MotionTiming = {
  modalEnter: DURATION.d5,
  modalExit: DURATION.d3,
  stepOut: 160,
  stepIn: DURATION.d4,
  stepDelay: 80,
  stepHeight: 260,
  railFill: DURATION.d5,
  reveal: 520,
  reduced: false,
};

/** Opacity-only essentials, everything else collapsed. */
const REDUCED_MOTION: MotionTiming = {
  modalEnter: DURATION.d2,
  modalExit: DURATION.d2,
  stepOut: 50,
  stepIn: 100,
  stepDelay: 0,
  stepHeight: 0,
  railFill: DURATION.d4,
  reveal: 0,
  reduced: true,
};

/** Reads the preference once. Returns `false` outside a browser (Astro's SSR pass). */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** Subscribes to preference changes. Returns the unsubscribe function. */
function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => undefined;
  }
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener('change', onChange);
  return () => {
    query.removeEventListener('change', onChange);
  };
}

/**
 * The current motion preference, live.
 *
 * A live subscription rather than a one-shot read because the preference genuinely changes
 * mid-session: iOS exposes it in Control Centre and Windows in the notification pane, and a user
 * who reaches for it is doing so *because* something on screen is making them ill.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false);
}

/** The timings for the current preference. */
export function useMotionTiming(): MotionTiming {
  return useReducedMotion() ? REDUCED_MOTION : FULL_MOTION;
}

/**
 * Builds an inline style object carrying CSS custom properties.
 *
 * React writes unknown `style` keys through to `element.style.setProperty`, which is exactly what a
 * custom property needs — but `CSSProperties` has no index signature for `--*`, so the cast is
 * unavoidable. It is contained here rather than repeated at every call site, and it is a cast
 * between two object types rather than an escape to `any`.
 */
export function cssVars(vars: Readonly<Record<string, string | number>>): CSSProperties {
  return vars as CSSProperties;
}
