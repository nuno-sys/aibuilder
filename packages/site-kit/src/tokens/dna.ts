import type {
  ColorMode,
  DensityId,
  DnaId,
  MotionId,
  RadiusId,
  TypeScaleId,
} from '@aibuilder/site-schema';

/**
 * The four archetypes, as data.
 *
 * Nothing here is code and nothing here is solved: this file is the *design*, and `resolve.ts` is
 * the machine that turns it into 47 custom properties. Splitting them that way is what lets the
 * contrast proof enumerate the whole knob space — a ladder is four numbers, so adding a fifth
 * archetype is a data edit that the proof immediately covers.
 *
 * Two conventions run through every ladder:
 *
 *  - **Lightness only.** Every neutral takes the DNA's one `neutral.hue` / `neutral.chroma`, and
 *    `resolve.ts` caps that chroma into sRGB at each lightness. This is why the canonical blocks in
 *    `PHASE2-SITE-KIT.md` §1 show a *lower* chroma on the extreme tokens (`--color-surface` at
 *    `oklch(1 0 228)`, `--color-fg` at `oklch(0.965 0.0164 288)`): those are not hand-tuned
 *    exceptions, they are the gamut boundary showing through. One number, no exceptions list.
 *  - **Both grounds are declared.** `paletteVariant: 'inverse'` asks for this DNA's *other* ground,
 *    so all six (variant × mode) pairs must exist for all four archetypes. There is no fallback
 *    combination and no unreachable one.
 */

/** The seven laddered neutrals of one ground, as OKLCH lightness values. */
export interface NeutralLadder {
  readonly bg: number;
  readonly bgAlt: number;
  readonly surface: number;
  readonly surface2: number;
  readonly fg: number;
  readonly fgMuted: number;
  readonly border: number;
}

/** An accent or support colour: one hue, one chroma ask, one lightness per ground. */
export interface AccentSpec {
  readonly hue: number;
  readonly chroma: number;
  readonly lightness: Readonly<Record<ColorMode, number>>;
}

/** The knob values a DNA is designed at. The model may override any of them. */
export interface DnaDefaults {
  readonly typeScaleId: TypeScaleId;
  readonly radiusId: RadiusId;
  readonly densityId: DensityId;
  readonly motionId: MotionId;
}

/** A self-hosted variable family. `stack` is the metric-matched fallback chain. */
export interface FontSpec {
  /** Family name as it appears in `@font-face` and in `--font-display` / `--font-body`. */
  readonly family: string;
  /** Content-hashed basename under `/_a/`, without the `-latin*.woff2` suffix. */
  readonly asset: string;
  /** The generic fallback appended after the metric-matched local face. */
  readonly genericStack: string;
}

export interface DnaTypography {
  readonly display: FontSpec;
  readonly body: FontSpec;
  /** `font-variation-settings` "wght" for headings. */
  readonly displayWeight: number;
  /** `font-variation-settings` "wdth" for headings. 100 unless the family has a width axis. */
  readonly displayWidth: number;
  /** `letter-spacing` for headings, as a CSS length. */
  readonly displayTracking: string;
}

export interface Dna {
  readonly id: DnaId;
  /** One sentence. Shown in the editor's DNA picker; never rendered on a tenant site. */
  readonly thesis: string;
  /** The ground the archetype was designed at. `colorMode` may ask for the other one. */
  readonly canonicalMode: ColorMode;
  readonly neutral: { readonly hue: number; readonly chroma: number };
  readonly grounds: Readonly<Record<ColorMode, NeutralLadder>>;
  readonly accent: AccentSpec;
  /** Reached by `paletteVariant: 'alt'`. A different hue relationship at the same polarity. */
  readonly support: AccentSpec;
  readonly defaults: DnaDefaults;
  readonly typography: DnaTypography;
  /**
   * Alpha of the hero scrim above the guaranteed band (`0 %`–`20 %` of the hero box).
   *
   * It carries no contrast obligation because no text is ever placed there — the hero's grid puts
   * the copy in row 2, which starts at the band boundary. See §3.4 of the specification.
   */
  readonly heroScrimTop: number;
}

const INTER: FontSpec = {
  family: 'Inter',
  asset: 'inter',
  genericStack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
};

const SPACE_GROTESK: FontSpec = {
  family: 'Space Grotesk',
  asset: 'space-grotesk',
  genericStack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
};

const PLAYFAIR: FontSpec = {
  family: 'Playfair Display',
  asset: 'playfair-display',
  genericStack: 'Georgia, "Times New Roman", serif',
};

const ARCHIVO: FontSpec = {
  family: 'Archivo',
  asset: 'archivo',
  genericStack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
};

const MIDNIGHT_NEON: Dna = {
  id: 'midnight_neon',
  thesis:
    'A lit room after dark: near-black violet ground, one electric accent that behaves like a light source, type set tight and large enough to feel like signage.',
  canonicalMode: 'dark',
  neutral: { hue: 288, chroma: 0.018 },
  grounds: {
    dark: {
      bg: 0.17,
      bgAlt: 0.21,
      surface: 0.235,
      surface2: 0.28,
      fg: 0.965,
      fgMuted: 0.78,
      border: 0.34,
    },
    light: {
      bg: 0.975,
      bgAlt: 0.945,
      surface: 0.998,
      surface2: 0.92,
      fg: 0.2,
      fgMuted: 0.44,
      border: 0.878,
    },
  },
  accent: { hue: 295, chroma: 0.2, lightness: { dark: 0.64, light: 0.53 } },
  support: { hue: 195, chroma: 0.13, lightness: { dark: 0.8, light: 0.64 } },
  defaults: {
    typeScaleId: 'display',
    radiusId: 'sharp',
    densityId: 'compact',
    motionId: 'expressive',
  },
  typography: {
    display: SPACE_GROTESK,
    body: INTER,
    displayWeight: 600,
    displayWidth: 100,
    displayTracking: '-0.02em',
  },
  heroScrimTop: 0.24,
};

const WARM_TRATTORIA: Dna = {
  id: 'warm_trattoria',
  thesis:
    'Paper, not screen: warm cream ground, terracotta ink-on-clay accent, editorial serif headings and hairline rules, so the page reads like a menu card.',
  canonicalMode: 'light',
  neutral: { hue: 78, chroma: 0.017 },
  grounds: {
    light: {
      bg: 0.972,
      bgAlt: 0.946,
      surface: 0.995,
      surface2: 0.923,
      fg: 0.26,
      fgMuted: 0.45,
      border: 0.882,
    },
    dark: {
      bg: 0.175,
      bgAlt: 0.215,
      surface: 0.24,
      surface2: 0.285,
      fg: 0.965,
      fgMuted: 0.77,
      border: 0.345,
    },
  },
  accent: { hue: 32, chroma: 0.145, lightness: { light: 0.52, dark: 0.64 } },
  support: { hue: 122, chroma: 0.07, lightness: { light: 0.47, dark: 0.72 } },
  defaults: {
    typeScaleId: 'editorial',
    radiusId: 'soft',
    densityId: 'airy',
    motionId: 'subtle',
  },
  typography: {
    display: PLAYFAIR,
    body: INTER,
    displayWeight: 600,
    displayWidth: 100,
    displayTracking: '-0.01em',
  },
  heroScrimTop: 0.18,
};

const CLINICAL_TRUST: Dna = {
  id: 'clinical_trust',
  thesis:
    'Nothing between the visitor and the information: white ground, one calm teal, generous line height, every claim next to the credential that backs it.',
  canonicalMode: 'light',
  neutral: { hue: 228, chroma: 0.008 },
  grounds: {
    light: {
      bg: 0.99,
      bgAlt: 0.964,
      surface: 1,
      surface2: 0.945,
      fg: 0.24,
      fgMuted: 0.46,
      border: 0.895,
    },
    dark: {
      bg: 0.165,
      bgAlt: 0.205,
      surface: 0.23,
      surface2: 0.275,
      fg: 0.97,
      fgMuted: 0.78,
      border: 0.335,
    },
  },
  accent: { hue: 205, chroma: 0.108, lightness: { light: 0.54, dark: 0.7 } },
  support: { hue: 258, chroma: 0.095, lightness: { light: 0.49, dark: 0.72 } },
  defaults: {
    typeScaleId: 'regular',
    radiusId: 'round',
    densityId: 'regular',
    motionId: 'none',
  },
  typography: {
    // One font file for the whole site: display is Inter at a heavier weight and tighter tracking.
    display: INTER,
    body: INTER,
    displayWeight: 700,
    displayWidth: 100,
    displayTracking: '-0.02em',
  },
  heroScrimTop: 0.2,
};

const GARAGE_STEEL: Dna = {
  id: 'garage_steel',
  thesis:
    'A phone number you can hit with a gloved thumb: cool steel ground, safety-amber accent, condensed uppercase headings, no ornament that is not a signal.',
  canonicalMode: 'light',
  neutral: { hue: 255, chroma: 0.006 },
  grounds: {
    light: {
      bg: 0.976,
      bgAlt: 0.943,
      surface: 0.998,
      surface2: 0.918,
      fg: 0.21,
      fgMuted: 0.44,
      border: 0.875,
    },
    dark: {
      bg: 0.16,
      bgAlt: 0.2,
      surface: 0.225,
      surface2: 0.27,
      fg: 0.97,
      fgMuted: 0.775,
      border: 0.33,
    },
  },
  accent: { hue: 72, chroma: 0.155, lightness: { light: 0.79, dark: 0.82 } },
  support: { hue: 252, chroma: 0.14, lightness: { light: 0.48, dark: 0.68 } },
  defaults: {
    typeScaleId: 'compact',
    radiusId: 'sharp',
    densityId: 'compact',
    motionId: 'none',
  },
  typography: {
    // Archivo's `wdth` axis gives the condensed industrial voice without a second static family.
    display: ARCHIVO,
    body: INTER,
    displayWeight: 700,
    displayWidth: 78,
    displayTracking: '0.01em',
  },
  heroScrimTop: 0.22,
};

/** The archetype catalogue, keyed by the `DnaId` the model picks. */
export const DNA: Readonly<Record<DnaId, Dna>> = {
  midnight_neon: MIDNIGHT_NEON,
  warm_trattoria: WARM_TRATTORIA,
  clinical_trust: CLINICAL_TRUST,
  garage_steel: GARAGE_STEEL,
};

/** Every distinct font family the four archetypes can ask for. */
export const FONT_SPECS: readonly FontSpec[] = [INTER, SPACE_GROTESK, PLAYFAIR, ARCHIVO];
