/**
 * OKLCH ⇄ sRGB, the sRGB gamut boundary, WCAG luminance, and the lightness solver.
 *
 * Pure maths. No design opinions live here, and nothing in this file knows what an archetype is.
 *
 * Two properties make the analytic contrast proof (`__tests__/contrast.test.ts`) sound rather than
 * approximate, and both are enforced here:
 *
 *  1. **Every emitted colour stays strictly inside sRGB.** `site-schema`'s `parseColor()` *clamps*
 *     out-of-gamut channels to `[0,1]`, while a browser gamut-*maps* by reducing chroma. A ratio
 *     computed on a clamped colour is therefore a ratio for a colour nobody will ever see. Chroma
 *     is capped at `GAMUT_SAFETY × maxChromaInSrgb(L, H)` so the two agree exactly.
 *  2. **Every emitted number is already quantised.** The solver returns lightness on the 4-decimal
 *     grid, so the string that goes into `render_sha256` is the string the ratio was checked on.
 *     A float that serialises as `0.6404999999999999` on one run would move `lastmod` for free.
 *
 * The conversion matrices are Björn Ottosson's published OKLab ⇄ linear-sRGB pair — the same ones
 * `site-schema/lint.ts` uses, deliberately duplicated rather than imported, because `lint.ts` only
 * exposes the clamped path and this file needs the unclamped one to find the gamut boundary.
 */

/** A colour in linear-light sRGB. Components may fall outside `[0,1]` — that is the whole point. */
export interface LinearRgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * How far inside the sRGB boundary a token is allowed to sit.
 *
 * 6 % of headroom absorbs the difference between this solver's boundary and a browser's own gamut
 * mapping, and keeps every channel comfortably clear of the clamp that would make the proof lie.
 */
export const GAMUT_SAFETY = 0.94;

/** Decimal places every emitted lightness / chroma is quantised to. */
export const TOKEN_DECIMALS = 4;

const QUANTUM = 10 ** TOKEN_DECIMALS;

/** Converts OKLCH to linear-light sRGB **without** clamping. */
export function oklchToLinearRgb(lightness: number, chroma: number, hueDegrees: number): LinearRgb {
  const hue = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);

  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

/**
 * True when every channel is inside `[0, 1]` with a hair of tolerance.
 *
 * The tolerance is one part in a million, far below the 8-bit quantisation a browser applies, so it
 * cannot admit a colour that would visibly clip.
 */
function inSrgb(colour: LinearRgb): boolean {
  const eps = 1e-6;
  return (
    colour.r >= -eps &&
    colour.r <= 1 + eps &&
    colour.g >= -eps &&
    colour.g <= 1 + eps &&
    colour.b >= -eps &&
    colour.b <= 1 + eps
  );
}

/** Largest chroma that is still inside sRGB at this lightness and hue. */
export function maxChromaInSrgb(lightness: number, hueDegrees: number): number {
  if (!inSrgb(oklchToLinearRgb(lightness, 0, hueDegrees))) return 0;
  let lo = 0;
  let hi = 0.5;
  // 40 halvings take the interval to ~5e-13, well under the 4-decimal grid the tokens live on.
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (inSrgb(oklchToLinearRgb(lightness, mid, hueDegrees))) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * The chroma a token actually gets: the design's ask, capped into the safe part of sRGB, then
 * quantised **down** onto the 4-decimal grid.
 *
 * Rounding down rather than to-nearest is the whole point. `formatNumber` emits four decimals, so a
 * cap of `0.0116897` would serialise as `0.0117` — a chroma the boundary does not actually admit,
 * and therefore a colour whose contrast was computed on a value the browser would gamut-map away.
 * Quantising down makes the emitted string, the checked value and the painted colour the same
 * thing.
 */
export function capChroma(lightness: number, chroma: number, hueDegrees: number): number {
  return quantiseDown(Math.min(chroma, GAMUT_SAFETY * maxChromaInSrgb(lightness, hueDegrees)));
}

function srgbToLinearChannel(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearToSrgbChannel(channel: number): number {
  const clamped = Math.min(1, Math.max(0, channel));
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

/** WCAG relative luminance of a linear-light colour, clamped exactly as `lint.ts` clamps. */
export function relativeLuminance(colour: LinearRgb): number {
  const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
  return 0.2126 * clamp01(colour.r) + 0.7152 * clamp01(colour.g) + 0.0722 * clamp01(colour.b);
}

/** WCAG relative luminance of an OKLCH triple. */
export function luminanceOf(lightness: number, chroma: number, hueDegrees: number): number {
  return relativeLuminance(oklchToLinearRgb(lightness, chroma, hueDegrees));
}

/** WCAG 2.x contrast ratio between two relative luminances. */
export function ratioOfLuminances(a: number, b: number): number {
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/* ── Quantisation ───────────────────────────────────────────────────────── */

/** Rounds to the 4-decimal token grid. */
export function quantise(value: number): number {
  return Math.round(value * QUANTUM) / QUANTUM;
}

/** Rounds down onto the 4-decimal token grid. */
export function quantiseDown(value: number): number {
  return Math.floor(value * QUANTUM) / QUANTUM;
}

/** Rounds up onto the 4-decimal token grid. */
export function quantiseUp(value: number): number {
  return Math.ceil(value * QUANTUM) / QUANTUM;
}

/**
 * Formats a number for a CSS token: fixed 4 decimals with trailing zeros stripped.
 *
 * `Number.prototype.toString()` is not used because `0.1 + 0.2` and friends serialise with a 17-digit
 * tail, and the token strings are hashed. Going through `toFixed` first makes the output a function
 * of the quantised value alone.
 */
export function formatNumber(value: number): string {
  const fixed = value.toFixed(TOKEN_DECIMALS);
  const trimmed = fixed.replace(/0+$/u, '').replace(/\.$/u, '');
  // `-0` and `0.0000` both have to come out as a plain `0`.
  return trimmed === '' || trimmed === '-0' ? '0' : trimmed;
}

/** Normalises a hue into `[0, 360)`. */
export function normaliseHue(hueDegrees: number): number {
  return ((hueDegrees % 360) + 360) % 360;
}

/** Serialises an OKLCH triple to the exact string that is stored and hashed. */
export function formatOklch(lightness: number, chroma: number, hueDegrees: number): string {
  return `oklch(${formatNumber(lightness)} ${formatNumber(chroma)} ${formatNumber(hueDegrees)})`;
}

/** Converts an OKLCH triple to lowercase `#rrggbb`, for `<meta name="theme-color">`. */
export function oklchToHex(lightness: number, chroma: number, hueDegrees: number): string {
  const linear = oklchToLinearRgb(lightness, chroma, hueDegrees);
  const channel = (value: number): string =>
    Math.round(linearToSrgbChannel(value) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(linear.r)}${channel(linear.g)}${channel(linear.b)}`;
}

/** Relative luminance of a `#rrggbb` string, for the scrim algebra. */
export function luminanceOfHex(hex: string): number {
  const channel = (offset: number): number =>
    srgbToLinearChannel(Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  return relativeLuminance({ r: channel(1), g: channel(3), b: channel(5) });
}

/* ── The lightness solver ───────────────────────────────────────────────── */

/** One "must clear `minRatio` against this luminance" obligation on a solved token. */
export interface LuminanceConstraint {
  /** Relative luminance of the colour the solved token sits against. */
  readonly against: number;
  readonly minRatio: number;
}

/** A solved colour: lightness on the 4-decimal grid, chroma capped into gamut at that lightness. */
export interface SolvedColour {
  readonly lightness: number;
  readonly chroma: number;
  readonly hue: number;
}

/** Builds the in-gamut colour at a given lightness for a fixed (chroma ask, hue). */
export function colourAt(lightness: number, chromaAsk: number, hue: number): SolvedColour {
  return { lightness, chroma: capChroma(lightness, chromaAsk, hue), hue };
}

/** Luminance of a solved colour. */
export function luminanceOfColour(colour: SolvedColour): number {
  return luminanceOf(colour.lightness, colour.chroma, colour.hue);
}

function satisfies(colour: SolvedColour, constraints: readonly LuminanceConstraint[]): boolean {
  const luminance = luminanceOfColour(colour);
  return constraints.every((c) => ratioOfLuminances(luminance, c.against) >= c.minRatio);
}

/**
 * Finds the quantised lightness closest to `target` that satisfies every constraint.
 *
 * Why this can be done exactly rather than approximately: for a fixed (chroma ask, hue), luminance
 * increases monotonically with lightness, and `contrast(x, g)` is therefore a V in lightness with
 * its minimum where the luminances meet. "≥ k against g" is consequently `L ≤ a_g` **or**
 * `L ≥ b_g`, and intersecting over the constraint set leaves a feasible region of the shape
 * `[0, lo] ∪ [hi, 1]`. Both boundaries are found by bisection, then pushed onto the 4-decimal grid
 * *away from the failing side* — down for `lo`, up for `hi` — so quantisation can only ever make a
 * value safer.
 *
 * The linear sweep at the end is not dead code and not a fallback for a bug: `capChroma` makes the
 * luminance curve piecewise (chroma collapses near both poles), so on a pathological hue the V can
 * have a flat shoulder that bisection lands slightly inside. Sweeping the grid outward from the
 * target is O(10⁴) worst case and only runs when the closed-form answer failed verification, which
 * keeps the common path at ~60 luminance evaluations.
 *
 * Returns `null` when the constraint set is genuinely infeasible at this hue. Callers turn that
 * into a `ThemeResolutionError`; §3 of `PHASE2-SITE-KIT.md` proves it is unreachable.
 */
export function solveLightness(params: {
  readonly target: number;
  readonly chromaAsk: number;
  readonly hue: number;
  readonly constraints: readonly LuminanceConstraint[];
  /** Optional hard bounds, e.g. "a hover may not go below 0.02". */
  readonly min?: number;
  readonly max?: number;
}): SolvedColour | null {
  const { target, chromaAsk, hue, constraints } = params;
  const min = params.min ?? 0;
  const max = params.max ?? 1;
  const at = (lightness: number): SolvedColour => colourAt(lightness, chromaAsk, hue);

  const clampedTarget = Math.min(max, Math.max(min, quantise(target)));
  if (satisfies(at(clampedTarget), constraints)) return at(clampedTarget);

  // Boundary of the "darker than everything" branch: largest L ≤ target that passes.
  const findDownward = (): number | null => {
    if (!satisfies(at(min), constraints)) return null;
    let pass = min;
    let fail = clampedTarget;
    for (let i = 0; i < 40; i += 1) {
      const mid = (pass + fail) / 2;
      if (satisfies(at(mid), constraints)) pass = mid;
      else fail = mid;
    }
    return quantiseDown(pass);
  };

  // Boundary of the "lighter than everything" branch: smallest L ≥ target that passes.
  const findUpward = (): number | null => {
    if (!satisfies(at(max), constraints)) return null;
    let pass = max;
    let fail = clampedTarget;
    for (let i = 0; i < 40; i += 1) {
      const mid = (pass + fail) / 2;
      if (satisfies(at(mid), constraints)) pass = mid;
      else fail = mid;
    }
    return quantiseUp(pass);
  };

  const candidates: number[] = [];
  const down = findDownward();
  const up = findUpward();
  if (down !== null && down >= min) candidates.push(down);
  if (up !== null && up <= max) candidates.push(up);
  candidates.sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
  for (const lightness of candidates) {
    const colour = at(lightness);
    if (satisfies(colour, constraints)) return colour;
  }

  // Exhaustive sweep of the 4-decimal grid, outward from the target. See the doc comment.
  const start = Math.round(clampedTarget * QUANTUM);
  const lowest = Math.round(min * QUANTUM);
  const highest = Math.round(max * QUANTUM);
  for (let step = 1; step <= QUANTUM; step += 1) {
    for (const probe of [start - step, start + step]) {
      if (probe < lowest || probe > highest) continue;
      const colour = at(probe / QUANTUM);
      if (satisfies(colour, constraints)) return colour;
    }
  }
  return null;
}
