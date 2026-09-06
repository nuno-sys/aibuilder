import type { DnaId } from '@aibuilder/site-schema';
import { NON_COLOUR_TOKENS, PALETTE_TOKENS } from '../tokens/resolve';
import type { ThemeTokens } from '../tokens/resolve';
import { TONE_TOKENS } from '../tokens/tones';
import { BASE_CSS, LAYOUT_CSS, RESET_CSS, STATE_CSS } from './base.css';
import { COMPONENT_CSS } from './components/index';
import { COMPONENT_ORDER, LAYER_STATEMENT } from './layers';
import type { ComponentKey } from './layers';
import { fontFaceBlock, themeBlock } from './theme';
import type { FontAssetHashes } from './theme';

/**
 * Assembly, the byte ceiling, and the lint that keeps colour inside the token layer.
 *
 * One `<style>` element in `<head>` containing 100 % of the page's CSS, built from the sections the
 * page actually uses. No external stylesheet, no CSS-in-JS runtime, no `@import`, and no
 * `<link rel=stylesheet>` anywhere on a tenant site.
 */

/** The assembled bundle plus its measured size. */
export interface CssBundle {
  readonly css: string;
  readonly bytes: number;
}

/** Thrown when an assembled bundle exceeds the raw ceiling. A failed publish, never a slow page. */
export class CssBudgetError extends Error {
  override readonly name = 'CssBudgetError';
  readonly bytes: number;
  readonly ceiling: number;

  constructor(bytes: number, ceiling: number) {
    super(`Assembled CSS is ${bytes} B, over the ${ceiling} B ceiling`);
    this.bytes = bytes;
    this.ceiling = ceiling;
  }
}

/**
 * The publish-time gate, in **raw** bytes.
 *
 * The budget everyone quotes is brotli — ≤ 11 264 B for a page that uses every section type — but
 * `workerd` exposes `CompressionStream` for gzip and deflate only. There is no brotli stream API in
 * the runtime, so the publish path physically cannot measure the number the budget is actually
 * stated in. Saying "≤ 11 KB brotli, asserted at publish" without noticing that would be a lie in
 * the build log.
 *
 * So the split is: this constant gates raw bytes at publish, and `__tests__/css.test.ts` measures
 * real brotli-11 (it may import `node:zlib`; source files may not) and asserts both the brotli
 * budget and that this ceiling is still a *sound* stand-in for it.
 *
 * Derived from the measurement, not chosen. The worst-case assembly — all 17 section fragments plus
 * all four chrome fragments — is **31 432 B raw / 5 814 B brotli-11**, a ratio of 5.41. 36 KiB is
 * that raw figure plus ~17 % headroom, and at the observed ratio a bundle sitting exactly on this
 * ceiling would still compress to ~6.8 KB, comfortably inside the brotli budget. If a future
 * component pushes past it, the answer is a smaller component, not a bigger ceiling.
 */
export const CSS_RAW_CEILING = 36_864;

/**
 * The brotli-11 budget the raw ceiling stands in for. Asserted in CI, not at publish.
 *
 * Measured headroom today: 5 814 B used of 11 264 B on the page that uses every section type.
 */
export const CSS_BROTLI_BUDGET = 11_264;

/* ── The colour-leak lint ───────────────────────────────────────────────── */

/**
 * Custom properties a fragment may read that are neither theme tokens nor tone tokens.
 *
 * Two groups, both code-owned: the fixed 4 px grid declared in the base layer, and the handful of
 * names a component sets on its own element (from a closed enum or a computed integer) and reads
 * back in CSS. Nothing here can carry a colour that was not resolved by `tokens/resolve.ts`, with
 * the single exception of `--hero-bg`, which is `media_assets.dominant_color` — a `CHECK`
 * -constrained hex column written by the media pipeline, never by the model.
 */
export const LAYOUT_CUSTOM_PROPS: readonly string[] = [
  '--space-1',
  '--space-2',
  '--space-3',
  '--space-4',
  '--space-5',
  '--space-6',
  '--space-8',
  '--space-10',
  '--space-12',
  '--space-16',
  '--space-20',
  '--space-24',
  '--wrap-max',
  '--col',
  '--split',
  '--stack-gap',
  '--sec-h',
  '--focal',
  '--hero-bg',
  '--hero-focal',
  '--hero-copy-ink',
  '--wa-lift',
  '--banner-h',
];

/**
 * The complete list of palette reads permitted outside the `tokens` layer.
 *
 * There are exactly three places where an element floats over a tone it cannot know, and each is
 * enumerated rather than waved through:
 *
 *  1. `--color-focus-halo` in the one `:focus-visible` rule — the ring's outer tone must be the
 *     page's paper regardless of what it happens to ring.
 *  2. The WhatsApp pill, which is `position: fixed` over anything including a hero video.
 *  3. `<meta name="theme-color">`, which is not CSS at all and is handled in `render.ts`.
 *
 * This list is what makes "every text pair on every page is one of the pairs in the contract" a
 * checked statement rather than a convention.
 */
export const TONE_EXEMPT_READS: readonly string[] = [
  '--color-focus-halo',
  '--color-accent',
  '--color-accent-hover',
  '--color-accent-edge',
  '--color-fg-on-accent',
];

const ALLOWED_IN_SECTIONS = new Set<string>([
  ...TONE_TOKENS,
  ...NON_COLOUR_TOKENS,
  ...LAYOUT_CUSTOM_PROPS,
]);

const ALLOWED_IN_CHROME = new Set<string>([...ALLOWED_IN_SECTIONS, ...TONE_EXEMPT_READS]);

/** One illegal custom-property read found by the lint. */
export interface CssLeak {
  readonly fragment: string;
  readonly property: string;
}

/**
 * Collects every `var(--x)` name a fragment reads that it is not allowed to.
 *
 * Locals declared in the same fragment are permitted when they begin `--_`, which is the naming
 * convention that makes "declared here" checkable without parsing the CSS.
 */
export function lintFragment(name: string, css: string, allowed: ReadonlySet<string>): CssLeak[] {
  const leaks: CssLeak[] = [];
  for (const match of css.matchAll(/var\((--[a-z0-9-]+)/giu) as Iterable<RegExpMatchArray>) {
    const property = match[1];
    if (property === undefined) continue;
    if (property.startsWith('--_')) continue;
    if (allowed.has(property)) continue;
    leaks.push({ fragment: name, property });
  }
  return leaks;
}

/**
 * Lints every shipped fragment.
 *
 * Section fragments may read only tone tokens, non-colour theme tokens and the enumerated layout
 * locals; chrome fragments may additionally read the three exempt palette names. A section fragment
 * that says `var(--color-accent)` fails the build, which is the whole point of the tone indirection.
 */
export function lintAllFragments(): CssLeak[] {
  const leaks: CssLeak[] = [];
  for (const key of COMPONENT_ORDER) {
    const css = COMPONENT_CSS[key];
    const isChrome = css.includes('@layer chrome{');
    leaks.push(...lintFragment(key, css, isChrome ? ALLOWED_IN_CHROME : ALLOWED_IN_SECTIONS));
  }
  leaks.push(...lintFragment('base', BASE_CSS, ALLOWED_IN_CHROME));
  leaks.push(...lintFragment('layout', LAYOUT_CSS, ALLOWED_IN_SECTIONS));
  leaks.push(...lintFragment('reset', RESET_CSS, ALLOWED_IN_SECTIONS));
  leaks.push(...lintFragment('state', STATE_CSS, ALLOWED_IN_SECTIONS));
  return leaks;
}

/** True when `name` is one of the 20 palette tokens. Used by the lint's error messages. */
export function isPaletteToken(name: string): boolean {
  return (PALETTE_TOKENS as readonly string[]).includes(name);
}

/* ── Assembly ───────────────────────────────────────────────────────────── */

/** Everything `assembleCss` needs beyond the used-set. */
export interface AssembleOptions {
  readonly tokens: ThemeTokens;
  readonly dnaId: DnaId;
  readonly assetBase: string;
  readonly fontHashes: FontAssetHashes;
}

const encoder = new TextEncoder();

/**
 * Concatenates the page's CSS.
 *
 * The Worker does nothing but join strings: fragments are normalised at module load, so there is no
 * minifier, no parser and no allocation-heavy pass on the publish path. Emission follows
 * `COMPONENT_ORDER`, not the used-set's iteration order, so the bundle is a pure function of the
 * *set* of components and not of the order they first appear on the page.
 */
export function assembleCss(used: ReadonlySet<ComponentKey>, options: AssembleOptions): CssBundle {
  const parts = [
    LAYER_STATEMENT,
    RESET_CSS,
    themeBlock(options.tokens),
    fontFaceBlock(options.dnaId, options.assetBase, options.fontHashes),
    BASE_CSS,
    LAYOUT_CSS,
    ...COMPONENT_ORDER.filter((key) => used.has(key)).map((key) => COMPONENT_CSS[key]),
    STATE_CSS,
  ];
  const css = parts.join('');
  const bytes = encoder.encode(css).byteLength;
  if (bytes > CSS_RAW_CEILING) throw new CssBudgetError(bytes, CSS_RAW_CEILING);
  return { css, bytes };
}
