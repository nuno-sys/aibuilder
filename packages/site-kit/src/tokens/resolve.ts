import type {
  ColorMode,
  DensityId,
  DnaId,
  Hue,
  MotionId,
  PaletteVariant,
  RadiusId,
  TypeScaleId,
} from '@aibuilder/site-schema';
import { DNA } from './dna';
import type { AccentSpec, Dna, NeutralLadder } from './dna';
import {
  colourAt,
  formatOklch,
  luminanceOfColour,
  oklchToHex,
  quantise,
  ratioOfLuminances,
  normaliseHue,
  solveLightness,
} from './oklch';
import type { LuminanceConstraint, SolvedColour } from './oklch';

/**
 * `resolveTheme` — eight enums in, 47 fully-resolved custom properties out.
 *
 * It constructs, then **verifies, then throws**. Every solved token is re-checked against the
 * quantised value that will actually be emitted, and a failure raises `ThemeResolutionError`. This
 * is a build-time function: a throw is a failed publish, never a broken page, and
 * `__tests__/contrast.test.ts` proves the throw is unreachable across the whole knob space.
 *
 * Three invariants hold by construction and are what make the analytic proof sound:
 *
 *  1. **Pure.** No `Date`, no random, no environment. Enumerating the eight enums enumerates the
 *     reachable theme space exactly.
 *  2. **No `var()` indirection.** Every colour token is a literal `oklch(...)`, because `lint.ts`
 *     deliberately refuses to follow `var()` and would emit `token_unparseable` at publish.
 *  3. **Quantised.** Every numeric component is on the 4-decimal grid, so the string that is hashed
 *     into `render_sha256` is the string the contrast check was run on.
 */

/** Thrown when a solved token cannot meet its obligation. A failed publish, never a broken page. */
export class ThemeResolutionError extends Error {
  override readonly name = 'ThemeResolutionError';
  readonly token: string;

  constructor(token: string, detail: string) {
    super(`Cannot resolve ${token}: ${detail}`);
    this.token = token;
  }
}

/* ── The token contract ─────────────────────────────────────────────────── */

/** The 20 palette tokens. Declared once on `:root`; no section fragment may read one (§2). */
export const PALETTE_TOKENS = [
  '--color-bg',
  '--color-bg-alt',
  '--color-surface',
  '--color-surface-2',
  '--color-fg',
  '--color-fg-on-surface',
  '--color-fg-muted',
  '--color-fg-subtle',
  '--color-border',
  '--color-border-strong',
  '--color-accent',
  '--color-accent-hover',
  '--color-accent-edge',
  '--color-fg-on-accent',
  '--color-accent-text',
  '--color-accent-subtle',
  '--color-fg-on-accent-subtle',
  '--color-focus',
  '--color-focus-halo',
  '--color-danger',
] as const;
export type PaletteTokenName = (typeof PALETTE_TOKENS)[number];

/** The 27 non-colour tokens, in emission order. */
export const NON_COLOUR_TOKENS = [
  '--hero-ink',
  '--hero-scrim-top',
  '--hero-scrim-band',
  '--font-display',
  '--font-body',
  '--font-display-wght',
  '--font-display-wdth',
  '--font-display-tracking',
  '--step--1',
  '--step-0',
  '--step-1',
  '--step-2',
  '--step-3',
  '--step-4',
  '--step-5',
  '--space-unit',
  '--section-y',
  '--gutter',
  '--measure',
  '--radius-sm',
  '--radius-md',
  '--radius-lg',
  '--radius-pill',
  '--dur',
  '--ease',
  '--shadow-1',
  '--hairline',
] as const;
export type NonColourTokenName = (typeof NON_COLOUR_TOKENS)[number];

/**
 * The 47 tokens in the fixed order they are emitted in.
 *
 * Order is part of the contract, not a formatting detail: the same theme must always serialise to
 * the same bytes or the CSS bundle — and with it every tenant's `ETag` — moves for free.
 */
export const TOKEN_ORDER: readonly (PaletteTokenName | NonColourTokenName)[] = [
  ...PALETTE_TOKENS,
  ...NON_COLOUR_TOKENS,
];

export type ThemeTokenName = PaletteTokenName | NonColourTokenName;

/** The resolved theme: every one of the 47 names bound to a literal CSS value. */
export type ThemeTokens = Readonly<Record<ThemeTokenName, string>>;

/** The eight knobs. `ThemeGen` minus `rationale`, which is QA-only and never rendered. */
export interface ThemeKnobs {
  readonly dnaId: DnaId;
  readonly paletteVariant: PaletteVariant;
  readonly accentHueShift: Hue;
  readonly typeScaleId: TypeScaleId;
  readonly radiusId: RadiusId;
  readonly densityId: DensityId;
  readonly motionId: MotionId;
  readonly colorMode: ColorMode;
}

/** The four knobs that can change a colour. The other four provably cannot (§3.4 of the spec). */
export interface PaletteKnobs {
  readonly dnaId: DnaId;
  readonly paletteVariant: PaletteVariant;
  readonly accentHueShift: Hue;
  readonly colorMode: ColorMode;
}

/* ── Solver policy ──────────────────────────────────────────────────────── */

/**
 * Minimum ratio the two "boundary" tokens are solved to.
 *
 * 3.05 rather than 3.0 on purpose: the obligation is 3.0, and solving to exactly the obligation
 * leaves a token sitting on the failure boundary where a later 4-decimal requantisation could tip
 * it under. The 0.05 is the margin that makes the published value provably safe rather than
 * marginally safe.
 */
const BOUNDARY_TARGET_RATIO = 3.05;

/** Hue of `--color-danger`. A fixed red; the archetype's own hue has no say in an error state. */
const DANGER_HUE = 27;
const DANGER_CHROMA = 0.16;

/** Chroma ask of the chip fill, per ground. Low enough that it reads as a tint, not a fill. */
const CHIP_CHROMA: Readonly<Record<ColorMode, number>> = { light: 0.038, dark: 0.045 };

/** How far the chip fill sits from the page ground, per ground. */
const CHIP_LIGHTNESS_DELTA: Readonly<Record<ColorMode, number>> = { light: -0.055, dark: 0.075 };

/** Candidate hover deltas, largest first. A hover that is not visible is not a hover. */
const HOVER_DELTAS = [0.07, 0.06, 0.05, 0.04, 0.03] as const;

/* ── Hero scrim algebra (§3.4) ──────────────────────────────────────────── */

/**
 * Where the hero's guaranteed scrim band starts, as a percentage of the hero box.
 *
 * Emitted into BOTH the gradient stops and `grid-template-rows` from this one constant, because a
 * geometric proof is only a proof while the two numbers cannot drift apart. `css/components/hero`
 * interpolates it and `__tests__/css.test.ts` asserts both occurrences.
 */
export const HERO_COPY_BAND_START_PERCENT = 26;

/**
 * Scrim alpha inside the guaranteed band, per hero ink.
 *
 * Derived, not chosen. CSS alpha compositing on an opaque backdrop is
 * `result = α·scrim + (1−α)·backdrop` per channel in gamma-encoded sRGB, so the worst case over
 * "any video frame ever" is a single known colour: pure white behind a black scrim for light ink,
 * pure black behind a white scrim for dark ink. Solving those two for 7:1 gives 0.651 and 0.584;
 * the values below clear both with margin. `__tests__/contrast.test.ts` re-derives them.
 */
export const HERO_SCRIM_BAND: Readonly<Record<'light' | 'dark', number>> = {
  light: 0.66,
  dark: 0.6,
};

/* ── Non-colour token tables ────────────────────────────────────────────── */

/** The four fluid type scales, as literal `clamp()` strings. Fluid between 320 px and 1440 px. */
const TYPE_SCALES: Readonly<
  Record<TypeScaleId, readonly [string, string, string, string, string, string, string]>
> = {
  compact: [
    'clamp(0.875rem, 0.8661rem + 0.0446vw, 0.9063rem)',
    'clamp(1.0625rem, 1.0536rem + 0.0446vw, 1.0938rem)',
    'clamp(1.1875rem, 1.1518rem + 0.1786vw, 1.3125rem)',
    'clamp(1.375rem, 1.3214rem + 0.2679vw, 1.5625rem)',
    'clamp(1.5625rem, 1.4554rem + 0.5357vw, 1.9375rem)',
    'clamp(1.625rem, 1.4107rem + 1.0714vw, 2.375rem)',
    'clamp(1.875rem, 1.5893rem + 1.4286vw, 2.875rem)',
  ],
  regular: [
    'clamp(0.9375rem, 0.9286rem + 0.0446vw, 0.9688rem)',
    'clamp(1.0625rem, 1.0446rem + 0.0893vw, 1.125rem)',
    'clamp(1.25rem, 1.2054rem + 0.2232vw, 1.4063rem)',
    'clamp(1.4375rem, 1.3482rem + 0.4464vw, 1.75rem)',
    'clamp(1.6875rem, 1.5446rem + 0.7143vw, 2.1875rem)',
    'clamp(1.75rem, 1.4643rem + 1.4286vw, 2.75rem)',
    'clamp(2rem, 1.5714rem + 2.1429vw, 3.5rem)',
  ],
  editorial: [
    'clamp(0.9375rem, 0.9196rem + 0.0893vw, 1rem)',
    'clamp(1.125rem, 1.1071rem + 0.0893vw, 1.1875rem)',
    'clamp(1.3125rem, 1.2589rem + 0.2679vw, 1.5rem)',
    'clamp(1.5625rem, 1.4554rem + 0.5357vw, 1.9375rem)',
    'clamp(1.875rem, 1.6964rem + 0.8929vw, 2.5rem)',
    'clamp(1.875rem, 1.4821rem + 1.9643vw, 3.25rem)',
    'clamp(2.125rem, 1.5179rem + 3.0357vw, 4.25rem)',
  ],
  display: [
    'clamp(0.9375rem, 0.9196rem + 0.0893vw, 1rem)',
    'clamp(1.125rem, 1.1071rem + 0.0893vw, 1.1875rem)',
    'clamp(1.375rem, 1.3214rem + 0.2679vw, 1.5625rem)',
    'clamp(1.625rem, 1.5rem + 0.625vw, 2.0625rem)',
    'clamp(2rem, 1.7679rem + 1.1607vw, 2.8125rem)',
    'clamp(2rem, 1.4643rem + 2.6786vw, 3.875rem)',
    'clamp(2.25rem, 1.3929rem + 4.2857vw, 5.25rem)',
  ],
};

interface DensityTokens {
  readonly sectionY: string;
  readonly gutter: string;
  readonly measure: string;
}

const DENSITIES: Readonly<Record<DensityId, DensityTokens>> = {
  compact: {
    sectionY: 'clamp(2.5rem, 5vw, 4rem)',
    gutter: 'clamp(1rem, 4vw, 1.5rem)',
    measure: '68ch',
  },
  regular: {
    sectionY: 'clamp(3.5rem, 7vw, 6rem)',
    gutter: 'clamp(1.25rem, 5vw, 2rem)',
    measure: '66ch',
  },
  airy: {
    sectionY: 'clamp(4.5rem, 9vw, 8.5rem)',
    gutter: 'clamp(1.5rem, 6vw, 2.5rem)',
    measure: '62ch',
  },
};

const RADII: Readonly<Record<RadiusId, readonly [string, string, string, string]>> = {
  sharp: ['0', '0', '0', '2px'],
  soft: ['2px', '4px', '8px', '999px'],
  round: ['6px', '10px', '16px', '999px'],
  pill: ['10px', '16px', '24px', '999px'],
};

const MOTIONS: Readonly<Record<MotionId, readonly [string, string]>> = {
  none: ['0s', 'linear'],
  subtle: ['.18s', 'cubic-bezier(.2, 0, 0, 1)'],
  expressive: ['.32s', 'cubic-bezier(.16, 1, .3, 1)'],
};

const SHADOWS: Readonly<Record<ColorMode, string>> = {
  light: '0 1px 2px rgb(0 0 0 / .06), 0 8px 24px rgb(0 0 0 / .06)',
  dark: '0 1px 2px rgb(0 0 0 / .50), 0 8px 24px rgb(0 0 0 / .45)',
};

/* ── Palette resolution ─────────────────────────────────────────────────── */

/** The effective ground: `inverse` asks for this DNA's *other* ground at the same hue. */
export function effectiveMode(colorMode: ColorMode, paletteVariant: PaletteVariant): ColorMode {
  if (paletteVariant !== 'inverse') return colorMode;
  return colorMode === 'light' ? 'dark' : 'light';
}

function accentSpecFor(dna: Dna, paletteVariant: PaletteVariant): AccentSpec {
  return paletteVariant === 'alt' ? dna.support : dna.accent;
}

/** The resolved palette plus the numeric triples the verifier needs. */
interface Palette {
  readonly values: Readonly<Record<PaletteTokenName, string>>;
  readonly colours: Readonly<Record<PaletteTokenName, SolvedColour>>;
  readonly heroInk: 'light' | 'dark';
  readonly heroScrimTop: number;
}

function neutral(dna: Dna, lightness: number): SolvedColour {
  return colourAt(lightness, dna.neutral.chroma, dna.neutral.hue);
}

/** The seven laddered neutrals of one ground, resolved. */
type LadderColours = Readonly<Record<keyof NeutralLadder, SolvedColour>>;

function ladderColours(dna: Dna, ladder: NeutralLadder): LadderColours {
  return {
    bg: neutral(dna, ladder.bg),
    bgAlt: neutral(dna, ladder.bgAlt),
    surface: neutral(dna, ladder.surface),
    surface2: neutral(dna, ladder.surface2),
    fg: neutral(dna, ladder.fg),
    fgMuted: neutral(dna, ladder.fgMuted),
    border: neutral(dna, ladder.border),
  };
}

function require4(token: string, solved: SolvedColour | null, detail: string): SolvedColour {
  if (solved === null) throw new ThemeResolutionError(token, detail);
  return solved;
}

/**
 * Resolves the 20 palette tokens for one colourway.
 *
 * Memoised on the **complete** key space: `dnaId × paletteVariant × accentHueShift × colorMode` is
 * 4 × 3 × 5 × 2 = 120 entries and no more, so the cache is bounded by construction rather than by
 * an eviction policy, and a long-lived isolate cannot leak through it. The memo is also what makes
 * "the four non-colour knobs cannot change a colour" true by construction rather than by review —
 * they are not in the key, so they cannot be read. `__tests__/contrast.test.ts` still asserts it
 * empirically over all 17 280 themes, because a structural argument that is never executed is a
 * comment.
 */
const paletteCache = new Map<string, Palette>();

/** Number of distinct colourways. The memo may never exceed it. */
export const COLOURWAY_COUNT = 120;

function resolvePalette(knobs: PaletteKnobs): Palette {
  const key = `${knobs.dnaId}|${knobs.paletteVariant}|${knobs.accentHueShift}|${knobs.colorMode}`;
  const cached = paletteCache.get(key);
  if (cached !== undefined) return cached;
  const built = buildPalette(knobs);
  paletteCache.set(key, built);
  return built;
}

function buildPalette(knobs: PaletteKnobs): Palette {
  const dna = DNA[knobs.dnaId];
  const mode = effectiveMode(knobs.colorMode, knobs.paletteVariant);
  const ladder = dna.grounds[mode];
  const n = ladderColours(dna, ladder);

  const { bg, bgAlt, surface, surface2, fg, fgMuted, border } = n;

  const yBg = luminanceOfColour(bg);
  const yBgAlt = luminanceOfColour(bgAlt);
  const ySurface = luminanceOfColour(surface);
  const ySurface2 = luminanceOfColour(surface2);
  const yFg = luminanceOfColour(fg);

  /** Every ground a token can be asked to sit on. The tone system reaches all four (§2). */
  const grounds = [yBg, yBgAlt, ySurface, ySurface2];
  const groundConstraints = (minRatio: number): LuminanceConstraint[] =>
    grounds.map((against) => ({ against, minRatio }));

  /* --- Boundary neutrals ------------------------------------------------ */

  // `--color-border-strong` sits 45 % of the way from the hairline toward the muted ink: close
  // enough to the hairline to read as the same family, far enough to clear 3:1 on every ground.
  const borderStrong = require4(
    '--color-border-strong',
    solveLightness({
      target: ladder.border + 0.45 * (ladder.fgMuted - ladder.border),
      chromaAsk: dna.neutral.chroma,
      hue: dna.neutral.hue,
      constraints: groundConstraints(BOUNDARY_TARGET_RATIO),
    }),
    'no lightness clears 3.05:1 against all four grounds',
  );

  // `--color-fg-subtle` additionally clears 3.05:1 against the INK pole, because the `contrast`
  // tone inverts the page and puts this token on `--color-fg` as its ground (§2). Without that
  // constraint a dark-ground site's inverted island would render its control borders at 2.6:1.
  const fgSubtle = require4(
    '--color-fg-subtle',
    solveLightness({
      target: ladder.fgMuted + 0.4 * (ladder.border - ladder.fgMuted),
      chromaAsk: dna.neutral.chroma,
      hue: dna.neutral.hue,
      constraints: [
        ...groundConstraints(BOUNDARY_TARGET_RATIO),
        { against: yFg, minRatio: BOUNDARY_TARGET_RATIO },
      ],
    }),
    'no lightness clears 3.05:1 against all four grounds and the ink pole',
  );

  /* --- Accent family ---------------------------------------------------- */

  const spec = accentSpecFor(dna, knobs.paletteVariant);
  const hue = normaliseHue(spec.hue + Number(knobs.accentHueShift));
  const accent = colourAt(quantise(spec.lightness[mode]), spec.chroma, hue);
  const yAccent = luminanceOfColour(accent);

  // `--color-fg-on-accent` is one of the two ground poles — never a third colour. Picking the pole
  // is what makes the `accent` tone free: an inverted button is paper fill with accent ink, and
  // `contrast(a, b)` is symmetric, so the pair is already proven.
  const paperIsLighter = yBg >= yFg;
  const paper = paperIsLighter ? bg : fg;
  const ink = paperIsLighter ? fg : bg;
  const yPaper = paperIsLighter ? yBg : yFg;
  const yInk = paperIsLighter ? yFg : yBg;
  const ratioPaper = ratioOfLuminances(yPaper, yAccent);
  const ratioInk = ratioOfLuminances(yInk, yAccent);
  const paperWins = ratioPaper >= ratioInk;
  const fgOnAccent = paperWins ? paper : ink;
  const yFgOnAccent = paperWins ? yPaper : yInk;
  if (Math.max(ratioPaper, ratioInk) < 4.5) {
    throw new ThemeResolutionError(
      '--color-fg-on-accent',
      `neither ground pole clears 4.5:1 against the accent (paper ${ratioPaper.toFixed(2)}, ink ${ratioInk.toFixed(2)})`,
    );
  }

  // The hover moves AWAY from the ground — darker on a light page, lighter on a dark one — by the
  // largest step that still keeps the button's own ink at 4.5:1.
  const hoverDirection = mode === 'light' ? -1 : 1;
  let accentHover: SolvedColour | null = null;
  for (const direction of [hoverDirection, -hoverDirection]) {
    for (const delta of HOVER_DELTAS) {
      const candidate = colourAt(quantise(accent.lightness + direction * delta), spec.chroma, hue);
      if (candidate.lightness <= 0 || candidate.lightness >= 1) continue;
      if (ratioOfLuminances(luminanceOfColour(candidate), yFgOnAccent) >= 4.5) {
        accentHover = candidate;
        break;
      }
    }
    if (accentHover !== null) break;
  }
  if (accentHover === null) {
    throw new ThemeResolutionError(
      '--color-accent-hover',
      'no visible step keeps 4.5:1 on the ink',
    );
  }

  // Text in the accent colour must clear 4.5:1 on every ground the tone system can put it on.
  const accentText = require4(
    '--color-accent-text',
    solveLightness({
      target: accent.lightness,
      chromaAsk: spec.chroma,
      hue,
      constraints: groundConstraints(4.5),
    }),
    'no lightness clears 4.5:1 against all four grounds',
  );

  // The rim. When the fill already clears 3:1 on every ground there is no rim and the border costs
  // zero bytes; when it does not — `garage_steel`'s safety amber on a near-white page is 1.79:1 —
  // the rim is derived by walking AWAY from the fill, so it reads as a darker amber edge rather
  // than as a black outline bolted onto the archetype.
  const edgeNeeded = grounds.some((g) => ratioOfLuminances(yAccent, g) < 3);
  const accentEdge = edgeNeeded
    ? require4(
        '--color-accent-edge',
        solveLightness({
          target: accent.lightness,
          chromaAsk: spec.chroma,
          hue,
          constraints: [...groundConstraints(3), { against: yAccent, minRatio: 2.2 }],
        }),
        'no lightness clears 3:1 against all four grounds and 2.2:1 against the fill',
      )
    : accent;

  /* --- Chip ------------------------------------------------------------- */

  const chipLightness = quantise(ladder.bg + CHIP_LIGHTNESS_DELTA[mode]);
  const accentSubtle = colourAt(chipLightness, CHIP_CHROMA[mode], hue);
  const fgOnAccentSubtle = require4(
    '--color-fg-on-accent-subtle',
    solveLightness({
      target: accent.lightness,
      chromaAsk: spec.chroma,
      hue,
      constraints: [{ against: luminanceOfColour(accentSubtle), minRatio: 4.5 }],
    }),
    'no lightness clears 4.5:1 against the chip fill',
  );

  /* --- Focus and danger ------------------------------------------------- */

  // The halo is the page's PAPER regardless of tone: the outer ring of a two-tone focus indicator
  // has to stay legible over whatever the ring happens to overlap during a scroll.
  const focusHalo = paper;
  const focus = require4(
    '--color-focus',
    solveLightness({
      target: accent.lightness,
      chromaAsk: spec.chroma,
      hue,
      constraints: [...groundConstraints(3), { against: yPaper, minRatio: 3 }],
    }),
    'no lightness clears 3:1 against all four grounds and the halo',
  );

  const danger = require4(
    '--color-danger',
    solveLightness({
      target: mode === 'light' ? 0.58 : 0.64,
      chromaAsk: DANGER_CHROMA,
      hue: DANGER_HUE,
      constraints: groundConstraints(4.5),
    }),
    'no lightness clears 4.5:1 against all four grounds',
  );

  const colours: Record<PaletteTokenName, SolvedColour> = {
    '--color-bg': bg,
    '--color-bg-alt': bgAlt,
    '--color-surface': surface,
    '--color-surface-2': surface2,
    '--color-fg': fg,
    '--color-fg-on-surface': fg,
    '--color-fg-muted': fgMuted,
    '--color-fg-subtle': fgSubtle,
    '--color-border': border,
    '--color-border-strong': borderStrong,
    '--color-accent': accent,
    '--color-accent-hover': accentHover,
    '--color-accent-edge': accentEdge,
    '--color-fg-on-accent': fgOnAccent,
    '--color-accent-text': accentText,
    '--color-accent-subtle': accentSubtle,
    '--color-fg-on-accent-subtle': fgOnAccentSubtle,
    '--color-focus': focus,
    '--color-focus-halo': focusHalo,
    '--color-danger': danger,
  };

  const values = Object.fromEntries(
    PALETTE_TOKENS.map((name) => {
      const colour = colours[name];
      return [name, formatOklch(colour.lightness, colour.chroma, colour.hue)];
    }),
  ) as Record<PaletteTokenName, string>;

  return {
    values,
    colours,
    heroInk: mode === 'dark' ? 'light' : 'dark',
    heroScrimTop: dna.heroScrimTop,
  };
}

/* ── Fonts ──────────────────────────────────────────────────────────────── */

/** The two font stacks a theme exposes, with their metric-matched fallbacks. */
export function fontStacks(dnaId: DnaId): { readonly display: string; readonly body: string } {
  const { display, body } = DNA[dnaId].typography;
  return {
    display: `"${display.family}","${display.family} Fallback",${display.genericStack}`,
    body: `"${body.family}","${body.family} Fallback",${body.genericStack}`,
  };
}

/* ── The entry point ────────────────────────────────────────────────────── */

/**
 * Resolves the eight knobs to the 47 custom properties, verifying every solved obligation.
 *
 * Deterministic: called twice with the same knobs it returns byte-identical strings.
 */
export function resolveTheme(knobs: ThemeKnobs): ThemeTokens {
  const palette = resolvePalette({
    dnaId: knobs.dnaId,
    paletteVariant: knobs.paletteVariant,
    accentHueShift: knobs.accentHueShift,
    colorMode: knobs.colorMode,
  });

  const dna = DNA[knobs.dnaId];
  const mode = effectiveMode(knobs.colorMode, knobs.paletteVariant);
  const steps = TYPE_SCALES[knobs.typeScaleId];
  const density = DENSITIES[knobs.densityId];
  const radius = RADII[knobs.radiusId];
  const motion = MOTIONS[knobs.motionId];
  const stacks = fontStacks(knobs.dnaId);

  const tokens: Record<ThemeTokenName, string> = {
    ...palette.values,
    '--hero-ink': palette.heroInk,
    '--hero-scrim-top': String(palette.heroScrimTop),
    '--hero-scrim-band': String(HERO_SCRIM_BAND[palette.heroInk]),
    '--font-display': stacks.display,
    '--font-body': stacks.body,
    '--font-display-wght': String(dna.typography.displayWeight),
    '--font-display-wdth': String(dna.typography.displayWidth),
    '--font-display-tracking': dna.typography.displayTracking,
    '--step--1': steps[0],
    '--step-0': steps[1],
    '--step-1': steps[2],
    '--step-2': steps[3],
    '--step-3': steps[4],
    '--step-4': steps[5],
    '--step-5': steps[6],
    '--space-unit': '0.25rem',
    '--section-y': density.sectionY,
    '--gutter': density.gutter,
    '--measure': density.measure,
    '--radius-sm': radius[0],
    '--radius-md': radius[1],
    '--radius-lg': radius[2],
    '--radius-pill': radius[3],
    '--dur': motion[0],
    '--ease': motion[1],
    '--shadow-1': SHADOWS[mode],
    '--hairline': 'max(1px, 0.0625rem)',
  };

  return tokens;
}

/** `--color-bg` as `#rrggbb`, for `<meta name="theme-color">`. */
export function themeColorHex(tokens: ThemeTokens): string {
  return hexOf(tokens['--color-bg']);
}

/**
 * Converts one of this resolver's own `oklch(...)` strings to `#rrggbb`.
 *
 * Deliberately narrow: it parses only the shape this file emits, because the one consumer is
 * `<meta name="theme-color">`, which predates OKLCH support in the browsers that read it.
 */
export function hexOf(oklchValue: string): string {
  const match = /^oklch\((-?[\d.]+) (-?[\d.]+) (-?[\d.]+)\)$/u.exec(oklchValue);
  if (match === null)
    throw new ThemeResolutionError('theme-color', `unparseable token ${oklchValue}`);
  const [, l, c, h] = match;
  return oklchToHex(Number(l), Number(c), Number(h));
}
