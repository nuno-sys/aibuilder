import type { ContrastRequirement } from '@aibuilder/site-schema';
import type { Tone } from './tones';

/**
 * `THEME_CONTRAST_CONTRACT` — every (foreground, background) pair a rendered page can realise,
 * per tone, with the ratio it must clear.
 *
 * This list is data so that the proof (`__tests__/contrast.test.ts`) and the prose (§3.3 of
 * `PHASE2-SITE-KIT.md`) cannot drift: the test iterates this array, it does not re-state it.
 *
 * `CONTRAST_PAIRS` in `site-schema/lint.ts` is the publish-time subset — five pairs, checked on
 * every assembled document, cheap. This is its superset, and the test asserts the inclusion, so the
 * two cannot disagree. The dependency direction is forced (`site-schema` may not import
 * `site-kit`) and this is the right side of it: the linter checks a stored document, the proof
 * checks the generator.
 *
 * Where the background is a `--color-*` name rather than a `--t-*` one, that is deliberate: it is a
 * ground a toned section can be placed *on* without adopting it as its own `--t-bg`.
 */

/**
 * The obligations that hold on any tone whose ground is one of the four neutral grounds.
 *
 * Applied to `page`, `alt` and `surface`. Those three differ only in which neutral `--t-bg` and
 * `--t-surface` bind to, so one list covers all three and the substitution is what varies.
 */
const NEUTRAL_GROUND_PAIRS: readonly ContrastRequirement[] = [
  // Body copy is AAA everywhere. The worst reachable value is 12.81:1, so a theme that lands
  // under 7 has a resolver defect, not a tight palette.
  { foreground: '--t-fg', background: '--t-bg', minRatio: 7, label: 'body text' },
  { foreground: '--t-fg', background: '--t-surface', minRatio: 7, label: 'body text on a card' },
  { foreground: '--t-fg', background: '--color-bg-alt', minRatio: 7, label: 'body text on a band' },
  {
    foreground: '--t-fg',
    background: '--color-surface-2',
    minRatio: 4.5,
    label: 'body text on a nested surface',
  },
  {
    foreground: '--t-fg-on-surface',
    background: '--t-surface',
    minRatio: 4.5,
    label: 'card text',
  },
  { foreground: '--t-fg-muted', background: '--t-bg', minRatio: 4.5, label: 'secondary text' },
  {
    foreground: '--t-fg-muted',
    background: '--t-surface',
    minRatio: 4.5,
    label: 'secondary text on a card',
  },
  {
    foreground: '--t-fg-muted',
    background: '--color-bg-alt',
    minRatio: 4.5,
    label: 'secondary text on a band',
  },
  {
    foreground: '--t-fg-muted',
    background: '--color-surface-2',
    minRatio: 4.5,
    label: 'secondary text on a nested surface',
  },
  {
    foreground: '--t-fg-on-accent',
    background: '--t-accent',
    minRatio: 4.5,
    label: 'primary buttons',
  },
  {
    foreground: '--t-fg-on-accent',
    background: '--t-accent-hover',
    minRatio: 4.5,
    label: 'primary buttons, hovered',
  },
  { foreground: '--t-accent-text', background: '--t-bg', minRatio: 4.5, label: 'links' },
  {
    foreground: '--t-accent-text',
    background: '--t-surface',
    minRatio: 4.5,
    label: 'links on a card',
  },
  {
    foreground: '--t-accent-text',
    background: '--color-surface-2',
    minRatio: 4.5,
    label: 'links on a nested surface',
  },
  { foreground: '--t-chip-fg', background: '--t-chip-bg', minRatio: 4.5, label: 'chip text' },
  {
    foreground: '--t-fg-muted',
    background: '--t-chip-bg',
    minRatio: 4.5,
    label: 'secondary text on a chip',
  },
  { foreground: '--t-danger', background: '--t-bg', minRatio: 4.5, label: 'form errors' },
  {
    foreground: '--t-danger',
    background: '--t-surface',
    minRatio: 4.5,
    label: 'form errors on a card',
  },
  {
    foreground: '--t-border-strong',
    background: '--t-bg',
    minRatio: 3,
    label: 'control borders',
  },
  {
    foreground: '--t-border-strong',
    background: '--t-surface',
    minRatio: 3,
    label: 'control borders on a card',
  },
  {
    foreground: '--t-border-strong',
    background: '--color-bg-alt',
    minRatio: 3,
    label: 'control borders on a band',
  },
  {
    foreground: '--t-border-strong',
    background: '--color-surface-2',
    minRatio: 3,
    label: 'control borders on a nested surface',
  },
  { foreground: '--t-fg-subtle', background: '--t-bg', minRatio: 3, label: 'subtle text' },
  {
    foreground: '--t-fg-subtle',
    background: '--t-surface',
    minRatio: 3,
    label: 'subtle text on a card',
  },
  {
    foreground: '--t-fg-subtle',
    background: '--color-bg-alt',
    minRatio: 3,
    label: 'subtle text on a band',
  },
  { foreground: '--t-accent-edge', background: '--t-bg', minRatio: 3, label: 'button rim' },
  {
    foreground: '--t-accent-edge',
    background: '--t-surface',
    minRatio: 3,
    label: 'button rim on a card',
  },
  {
    foreground: '--t-accent-edge',
    background: '--color-bg-alt',
    minRatio: 3,
    label: 'button rim on a band',
  },
  { foreground: '--t-focus', background: '--t-bg', minRatio: 3, label: 'focus ring' },
  {
    foreground: '--t-focus',
    background: '--t-surface',
    minRatio: 3,
    label: 'focus ring on a card',
  },
  {
    foreground: '--t-focus',
    background: '--color-bg-alt',
    minRatio: 3,
    label: 'focus ring on a band',
  },
  {
    foreground: '--t-focus',
    background: '--color-surface-2',
    minRatio: 3,
    label: 'focus ring on a nested surface',
  },
  // The second tone of the two-tone ring, for the backgrounds it may overlap during a scroll.
  {
    foreground: '--color-focus-halo',
    background: '--t-focus',
    minRatio: 3,
    label: 'focus halo',
  },
];

/**
 * The `accent` tone.
 *
 * Every one of its 17 names binds to either `--color-accent` or `--color-fg-on-accent`, so the
 * realisable pair set collapses to that one already-proven pair read in both directions. The focus
 * halo obligation is deliberately absent: on an accent band `--t-focus` *is* the paper, so the
 * two-tone ring degenerates to one tone. That is not a failure — the ring still clears 4.5:1
 * against the ground it is drawn on, which is the obligation SC 1.4.11 actually states.
 */
const ACCENT_PAIRS: readonly ContrastRequirement[] = [
  { foreground: '--t-fg', background: '--t-bg', minRatio: 4.5, label: 'copy on an accent band' },
  {
    foreground: '--t-fg-muted',
    background: '--t-bg',
    minRatio: 4.5,
    label: 'secondary copy on an accent band',
  },
  {
    foreground: '--t-fg-on-surface',
    background: '--t-surface',
    minRatio: 4.5,
    label: 'inverted button on an accent band',
  },
  {
    foreground: '--t-accent-text',
    background: '--t-bg',
    minRatio: 4.5,
    label: 'links on an accent band',
  },
  {
    foreground: '--t-chip-fg',
    background: '--t-chip-bg',
    minRatio: 4.5,
    label: 'chips on an accent band',
  },
  {
    foreground: '--t-danger',
    background: '--t-bg',
    minRatio: 4.5,
    label: 'errors on an accent band',
  },
  {
    foreground: '--t-border-strong',
    background: '--t-bg',
    minRatio: 3,
    label: 'borders on an accent band',
  },
  {
    foreground: '--t-focus',
    background: '--t-bg',
    minRatio: 3,
    label: 'focus ring on an accent band',
  },
];

/**
 * The `contrast` tone — one inverted island per page, maximum.
 *
 * `--t-bg` is `--color-fg` and `--t-fg` is `--color-bg`, so the body pair is the page's own read
 * backwards. The one obligation that is *not* free is `--t-border-strong`, which binds to
 * `--color-fg-subtle`: that token is solved against the ink pole as well as the four grounds
 * precisely so this tone holds (see `resolve.ts`). The halo obligation is absent for the same
 * reason as on the accent tone.
 */
const CONTRAST_PAIRS_TONE: readonly ContrastRequirement[] = [
  { foreground: '--t-fg', background: '--t-bg', minRatio: 7, label: 'copy on an inverted island' },
  {
    foreground: '--t-fg-on-surface',
    background: '--t-surface',
    minRatio: 7,
    label: 'card copy on an inverted island',
  },
  {
    foreground: '--t-fg-muted',
    background: '--t-bg',
    minRatio: 4.5,
    label: 'secondary copy on an inverted island',
  },
  {
    foreground: '--t-accent-text',
    background: '--t-bg',
    minRatio: 4.5,
    label: 'links on an inverted island',
  },
  {
    foreground: '--t-chip-fg',
    background: '--t-chip-bg',
    minRatio: 4.5,
    label: 'chips on an inverted island',
  },
  {
    foreground: '--t-danger',
    background: '--t-bg',
    minRatio: 4.5,
    label: 'errors on an inverted island',
  },
  {
    foreground: '--t-fg-subtle',
    background: '--t-bg',
    minRatio: 3,
    label: 'subtle text on an inverted island',
  },
  {
    foreground: '--t-border-strong',
    background: '--t-bg',
    minRatio: 3,
    label: 'borders on an inverted island',
  },
  {
    foreground: '--t-focus',
    background: '--t-bg',
    minRatio: 3,
    label: 'focus ring on an inverted island',
  },
];

/** The complete contract, per tone. */
export const THEME_CONTRAST_CONTRACT: Readonly<Record<Tone, readonly ContrastRequirement[]>> = {
  page: NEUTRAL_GROUND_PAIRS,
  alt: NEUTRAL_GROUND_PAIRS,
  surface: NEUTRAL_GROUND_PAIRS,
  accent: ACCENT_PAIRS,
  contrast: CONTRAST_PAIRS_TONE,
};
