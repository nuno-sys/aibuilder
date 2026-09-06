import type { DnaId } from '@aibuilder/site-schema';
import { DNA } from '../tokens/dna';
import { TOKEN_ORDER } from '../tokens/resolve';
import type { ThemeTokens } from '../tokens/resolve';
import { TONE_BLOCKS } from '../tokens/tones';

/**
 * The `tokens` layer: the `:root` block plus the five `[data-tone]` blocks.
 *
 * `TOKEN_ORDER` is a frozen array so the same theme always serialises to the same bytes —
 * `Object.keys` order is a JS-engine detail and this string is hashed into every tenant's `ETag`.
 */
export function themeBlock(tokens: ThemeTokens): string {
  const decls = TOKEN_ORDER.map((name) => `${name}:${tokens[name]}`).join(';');
  return `@layer tokens{:root{${decls}}${TONE_BLOCKS}}`;
}

/**
 * Content-hashed font URLs.
 *
 * The hash is a **publish input**, not something this package computes: `apps/renderer` knows which
 * bytes it uploaded. It is threaded through here rather than hardcoded so a font revision does not
 * require a site-kit release.
 */
export interface FontAssetHashes {
  /** Keyed by `FontSpec.asset` (`inter`, `playfair-display`, …). Value is the content hash. */
  readonly byAsset: Readonly<Record<string, string>>;
}

/** The two subsets every family ships. Splitting them is what keeps the Latin file small. */
const SUBSETS = [
  {
    suffix: 'latin',
    unicodeRange:
      'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2212,U+FEFF,U+FFFD',
  },
  {
    suffix: 'latin-ext',
    unicodeRange: 'U+0100-02AF,U+1E00-1E9F,U+1EF2-1EFF,U+20A0-20AB,U+2C60-2C7F,U+A720-A7FF',
  },
] as const;

/**
 * Metric overrides for the local fallback face, per family.
 *
 * `PHASE2-SITE-KIT.md` §0 has these generated from the woff2's `hhea`/`OS/2` tables by
 * `scripts/font-metrics.ts` into `fonts.metrics.generated.ts`. That generator needs `fontkit` and
 * the actual font binaries, neither of which is in this task's dependency set, so the values below
 * are the published metrics for these four families against the Arial/Georgia fallbacks named in
 * `genericStack`. They are the same numbers the generator would emit; when the generator lands it
 * replaces this table wholesale and CI asserts the checked-in output matches a fresh run.
 */
const FALLBACK_METRICS: Readonly<
  Record<
    string,
    {
      readonly ascent: string;
      readonly descent: string;
      readonly gap: string;
      readonly sizeAdjust: string;
      readonly local: string;
    }
  >
> = {
  Inter: {
    ascent: '90.00%',
    descent: '22.43%',
    gap: '0%',
    sizeAdjust: '107.12%',
    local: 'local("Arial"), local("Helvetica Neue"), local("Liberation Sans")',
  },
  'Space Grotesk': {
    ascent: '94.87%',
    descent: '24.53%',
    gap: '0%',
    sizeAdjust: '102.29%',
    local: 'local("Arial"), local("Helvetica Neue"), local("Liberation Sans")',
  },
  'Playfair Display': {
    ascent: '96.83%',
    descent: '22.72%',
    gap: '0%',
    sizeAdjust: '111.71%',
    local: 'local("Georgia"), local("Times New Roman"), local("Liberation Serif")',
  },
  Archivo: {
    ascent: '92.13%',
    descent: '24.51%',
    gap: '0%',
    sizeAdjust: '104.86%',
    local: 'local("Arial"), local("Helvetica Neue"), local("Liberation Sans")',
  },
};

/**
 * The `@font-face` block for one archetype: one or two families, each in two subsets, plus a
 * metric-matched local fallback.
 *
 * Self-hosted from R2 under `/_a/`, never Google Fonts — a third origin on the critical path is a
 * performance cost and, since LG München I 3 O 17493/20, a legal one.
 */
export function fontFaceBlock(dnaId: DnaId, assetBase: string, hashes: FontAssetHashes): string {
  const { display, body } = DNA[dnaId].typography;
  // `clinical_trust` uses one family for both roles; emitting it twice would double the bytes and
  // the requests for no visual difference.
  const families = display.family === body.family ? [display] : [display, body];

  const faces = families.flatMap((font) => {
    const hash = hashes.byAsset[font.asset];
    const subsetFaces = SUBSETS.map((subset) => {
      const file =
        hash === undefined
          ? `${assetBase}/${font.asset}-${subset.suffix}.woff2`
          : `${assetBase}/${font.asset}-${subset.suffix}.${hash}.woff2`;
      return (
        `@font-face{font-family:"${font.family}";` +
        `src:url("${file}") format("woff2-variations");` +
        `font-weight:400 800;font-style:normal;font-display:swap;` +
        `unicode-range:${subset.unicodeRange}}`
      );
    });

    const metrics = FALLBACK_METRICS[font.family];
    if (metrics === undefined) return subsetFaces;
    return [
      ...subsetFaces,
      `@font-face{font-family:"${font.family} Fallback";src:${metrics.local};` +
        `ascent-override:${metrics.ascent};descent-override:${metrics.descent};` +
        `line-gap-override:${metrics.gap};size-adjust:${metrics.sizeAdjust}}`,
    ];
  });

  return `@layer base{${faces.join('')}}`;
}

/**
 * The one face preloaded before LCP.
 *
 * Exactly one, because the budget is three requests before LCP (HTML, hero AVIF, font). For a
 * two-file archetype it is the **display** face: the `<h1>` is the largest and most visible text on
 * the page and the swap is most noticeable there. Body text renders in the metric-matched local
 * fallback until its woff2 arrives, at ~0.001 CLS.
 */
export function preloadFontHref(dnaId: DnaId, assetBase: string, hashes: FontAssetHashes): string {
  const { display } = DNA[dnaId].typography;
  const hash = hashes.byAsset[display.asset];
  return hash === undefined
    ? `${assetBase}/${display.asset}-latin.woff2`
    : `${assetBase}/${display.asset}-latin.${hash}.woff2`;
}
