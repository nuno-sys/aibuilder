import type { PaletteTokenName, ThemeTokens } from './resolve';

/**
 * The five tones — the only colour names a section fragment is allowed to read.
 *
 * A section that wants a dark island on a light page must not reach for `--color-fg` and hope. It
 * declares a tone, and the tone rebinds a small fixed set of *consumed* names. Two things fall out
 * of that, and both are load-bearing:
 *
 *  1. **The `accent` and `contrast` tones need no new resolved tokens.** `contrast(a, b)` is
 *     symmetric, so `--t-fg` / `--t-bg` on the accent tone is the already-proven
 *     `fg-on-accent` / `accent` pair read backwards. A filled button on an accent band becomes an
 *     inverted button — paper fill, accent ink — which is both the right visual answer and free.
 *  2. **Colour cannot leak out of the token layer.** `css/assemble.ts` lints every fragment in the
 *     `sections` layer against `TONE_TOKENS`, so a fragment that says `var(--color-accent)` fails
 *     the build rather than silently rendering an unproven pair.
 */

export const TONES = ['page', 'alt', 'surface', 'accent', 'contrast'] as const;
export type Tone = (typeof TONES)[number];

/** The 17 tone tokens. This list *is* the section fragments' colour vocabulary. */
export const TONE_TOKENS = [
  '--t-bg',
  '--t-fg',
  '--t-fg-muted',
  '--t-fg-subtle',
  '--t-surface',
  '--t-fg-on-surface',
  '--t-border',
  '--t-border-strong',
  '--t-accent',
  '--t-accent-hover',
  '--t-accent-edge',
  '--t-fg-on-accent',
  '--t-accent-text',
  '--t-focus',
  '--t-danger',
  '--t-chip-bg',
  '--t-chip-fg',
] as const;
export type ToneTokenName = (typeof TONE_TOKENS)[number];

/** What each tone binds each of its 17 names to. */
export type ToneBinding = Readonly<Record<ToneTokenName, PaletteTokenName>>;

const PAGE: ToneBinding = {
  '--t-bg': '--color-bg',
  '--t-fg': '--color-fg',
  '--t-fg-muted': '--color-fg-muted',
  '--t-fg-subtle': '--color-fg-subtle',
  '--t-surface': '--color-surface',
  '--t-fg-on-surface': '--color-fg-on-surface',
  '--t-border': '--color-border',
  '--t-border-strong': '--color-border-strong',
  '--t-accent': '--color-accent',
  '--t-accent-hover': '--color-accent-hover',
  '--t-accent-edge': '--color-accent-edge',
  '--t-fg-on-accent': '--color-fg-on-accent',
  '--t-accent-text': '--color-accent-text',
  '--t-focus': '--color-focus',
  '--t-danger': '--color-danger',
  '--t-chip-bg': '--color-accent-subtle',
  '--t-chip-fg': '--color-fg-on-accent-subtle',
};

/** The tone table. Every tone declares all 17 names, so a tone can never inherit a stale binding. */
export const TONE_BINDINGS: Readonly<Record<Tone, ToneBinding>> = {
  page: PAGE,
  alt: { ...PAGE, '--t-bg': '--color-bg-alt' },
  surface: {
    ...PAGE,
    '--t-bg': '--color-surface',
    '--t-fg': '--color-fg-on-surface',
    '--t-surface': '--color-surface-2',
  },
  accent: {
    '--t-bg': '--color-accent',
    '--t-fg': '--color-fg-on-accent',
    '--t-fg-muted': '--color-fg-on-accent',
    '--t-fg-subtle': '--color-fg-on-accent',
    '--t-surface': '--color-fg-on-accent',
    '--t-fg-on-surface': '--color-accent',
    '--t-border': '--color-fg-on-accent',
    '--t-border-strong': '--color-fg-on-accent',
    '--t-accent': '--color-fg-on-accent',
    '--t-accent-hover': '--color-fg-on-accent',
    '--t-accent-edge': '--color-fg-on-accent',
    '--t-fg-on-accent': '--color-accent',
    '--t-accent-text': '--color-fg-on-accent',
    '--t-focus': '--color-fg-on-accent',
    '--t-danger': '--color-fg-on-accent',
    '--t-chip-bg': '--color-fg-on-accent',
    '--t-chip-fg': '--color-accent',
  },
  contrast: {
    '--t-bg': '--color-fg',
    '--t-fg': '--color-bg',
    '--t-fg-muted': '--color-border',
    '--t-fg-subtle': '--color-border',
    '--t-surface': '--color-bg',
    '--t-fg-on-surface': '--color-fg',
    '--t-border': '--color-fg-subtle',
    '--t-border-strong': '--color-fg-subtle',
    '--t-accent': '--color-bg',
    '--t-accent-hover': '--color-bg',
    '--t-accent-edge': '--color-bg',
    '--t-fg-on-accent': '--color-fg',
    '--t-accent-text': '--color-bg',
    '--t-focus': '--color-bg',
    '--t-danger': '--color-bg',
    '--t-chip-bg': '--color-bg',
    '--t-chip-fg': '--color-fg',
  },
};

/**
 * Every colour name a page can realise under one tone, resolved to literal values.
 *
 * The result carries the 20 palette names as well as the 17 tone names, because three obligations
 * in `THEME_CONTRAST_CONTRACT` are stated against a palette name directly: `--color-bg-alt` and
 * `--color-surface-2` are grounds a toned section can be placed on without adopting them as its
 * `--t-bg`, and `--color-focus-halo` is read straight from the palette by the one `:focus-visible`
 * rule in the base layer (§2's `TONE_EXEMPT_READS`).
 */
export function applyTone(tokens: ThemeTokens, tone: Tone): Readonly<Record<string, string>> {
  const binding = TONE_BINDINGS[tone];
  const resolved: Record<string, string> = { ...tokens };
  for (const name of TONE_TOKENS) {
    resolved[name] = tokens[binding[name]];
  }
  return resolved;
}

/**
 * The five `[data-tone]` blocks, as one constant string.
 *
 * Tones never vary per site, so this is emitted verbatim rather than rebuilt per theme, and the
 * `:root` selector is included in the `page` block so an untoned element gets the page tone without
 * a second rule.
 */
export const TONE_BLOCKS: string = TONES.map((tone) => {
  const selector = tone === 'page' ? ':root,[data-tone="page"]' : `[data-tone="${tone}"]`;
  const decls = TONE_TOKENS.map((name) => `${name}:var(${TONE_BINDINGS[tone][name]})`).join(';');
  return `${selector}{${decls}}`;
}).join('');
