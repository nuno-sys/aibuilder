/**
 * The acts of the generation theatre, and the phase table that feeds them.
 *
 * WHY THIS IS ITS OWN MODULE. The act indices are read in two places — the status rail in
 * `GenerationTheatre` and the palette/image reveals in `SkeletonMorph` — and Phase 2 inserted a new
 * act at index 0 (`awaiting_payment`, DECISIONS §D2). Every hard-coded `act >= 2` in the preview
 * silently became a threshold on the wrong act the moment that happened. Named constants in one
 * module make the next insertion a compile-time edit in one place rather than a visual bug nobody
 * notices until the palette paints during the wrong step.
 *
 * `GenerationTheatre` imports `SkeletonMorph`, so the shared values cannot live in either of them
 * without a module cycle. They live here.
 */

import type { GenerationPhase } from './hooks/useSSE';

/** The ten acts the user can see, in order. Act 0 only appears for a job that had to pay first. */
export const ACTS = [
  'awaitingPayment',
  'queued',
  'prompt',
  'design',
  'writing',
  'layout',
  'media',
  'build',
  'deploy',
  'done',
] as const;

/** One act name. */
export type ActName = (typeof ACTS)[number];

/** One act index, 0–9. */
export type ActIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/** Waiting for a Checkout Session to complete. The only act in which the rail does not move. */
export const ACT_AWAITING_PAYMENT: ActIndex = 0;

/** The first act the checklist shows for a job that never saw Checkout. */
export const ACT_QUEUED: ActIndex = 1;

/** The palette wipes across when this act is reached — the first proof the design is being chosen. */
export const ACT_DESIGN: ActIndex = 3;

/** The preview's image block resolves from neutral to the site's own palette at this act. */
export const ACT_MEDIA: ActIndex = 6;

/** The reveal replaces the preview at this act. */
export const ACT_DONE: ActIndex = 9;

/**
 * Phase → act. Many-to-one by design; `error` keeps whatever act was reached.
 *
 * Every value is one higher than it was in Phase 1, because `awaiting_payment` took index 0. No
 * phase maps onto it: the workflow does not emit one, since the workflow has not started.
 */
export const PHASE_TO_ACT: Readonly<Record<GenerationPhase, ActIndex | null>> = {
  queued: ACT_QUEUED,
  prompt_built: 2,
  api_call: ACT_DESIGN,
  thinking: ACT_DESIGN,
  streaming: 4,
  parsing: 5,
  pages_written: 5,
  media_fetch: ACT_MEDIA,
  build: 7,
  deploy: 8,
  done: ACT_DONE,
  error: null,
};

/**
 * Progress floor of each act, and therefore the ceiling of the one before it (UX §5.5).
 *
 * Acts 0 and 1 share the 0 % floor on purpose: releasing a paid job must not make the bar jump, and
 * `queued` has never claimed progress either.
 */
export const ACT_FLOOR: readonly number[] = [0, 0, 3, 10, 24, 58, 70, 84, 93, 100];
