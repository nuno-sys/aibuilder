/**
 * Choosing footage and stills out of the library.
 *
 * Three properties this has to have, and they pull against each other:
 *
 *  1. **Readable.** Luminance must match the theme's colour mode. This is absolute — a mismatch is
 *     not a worse-looking site, it is copy nobody can read.
 *  2. **Coherent.** Where there is a choice, prefer footage whose hue sits near the site's accent,
 *     so the header looks chosen rather than assigned.
 *  3. **Varied.** Two bakeries in the same town must not get the same header. Selection is
 *     therefore seeded on the site id and spreads across the candidates rather than always
 *     returning the best-scoring one.
 *
 * Deterministic throughout: the same site always resolves to the same clip. Regeneration is meant
 * to change a site because the MODEL chose differently, not because a random number moved.
 */

import type { LuminanceClass } from '@aibuilder/site-schema';

import type { LibraryImage, LibraryVideo, MediaGroupKey, MediaLibrary } from './types';

/** FNV-1a over a string. Small, stable across runtimes, and not a security primitive. */
function hash(seed: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    value ^= seed.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value >>> 0;
}

/** Shortest distance between two hues on the colour wheel, 0-180 degrees. */
export function hueDistance(a: number, b: number): number {
  const raw = Math.abs((((a % 360) + 360) % 360) - (((b % 360) + 360) % 360));
  return raw > 180 ? 360 - raw : raw;
}

/**
 * How well a candidate's hue suits an accent, 0 (opposite) to 1 (identical).
 *
 * Complementary footage — roughly 180 degrees away — scores low deliberately. It is a legitimate
 * design choice made on purpose and a poor default made by accident, and this is a default.
 * Footage with no meaningful chroma scores in the middle: neutral goes with anything, which is
 * neither a reason to prefer it nor to avoid it.
 */
export function hueAffinity(candidateHue: number | null, accentHue: number | null): number {
  if (candidateHue === null || accentHue === null) return 0.5;
  return 1 - hueDistance(candidateHue, accentHue) / 180;
}

/** What the caller knows about the site being built. */
export interface SelectionContext {
  readonly group: MediaGroupKey;
  /** The resolved theme's mode. Luminance must equal this. */
  readonly colorMode: LuminanceClass;
  /** The theme's accent hue in degrees, or `null` when the palette is achromatic. */
  readonly accentHue: number | null;
  /** Stable per site — the site id. Two sites with the same inputs still differ. */
  readonly seed: string;
}

/**
 * Ranks candidates, then picks one by seed rather than always taking the winner.
 *
 * Taking the top result every time would give every business in a group the same header, which is
 * the failure this library exists to avoid. Instead the field is narrowed to those within a
 * tolerance of the best score, and the seed chooses among them: still a good fit, reliably varied.
 */
function pickSeeded<T>(
  candidates: readonly T[],
  score: (item: T) => number,
  seed: string,
): T | null {
  if (candidates.length === 0) return null;
  const scored = candidates.map((item) => ({ item, score: score(item) }));
  const best = Math.max(...scored.map((entry) => entry.score));
  // 0.25 of the score range: wide enough that a group with four clips usually offers more than one
  // answer, narrow enough that a genuinely poor fit never wins.
  const shortlist = scored.filter((entry) => entry.score >= best - 0.25).map((entry) => entry.item);
  const chosen = shortlist[hash(seed) % shortlist.length];
  return chosen ?? null;
}

/**
 * The hero clip for a site, or `null` when the library cannot serve this combination.
 *
 * `null` is a real outcome the caller must handle: the poster still renders and the header is a
 * full-screen still. It is never a reason to fall back to footage in the wrong luminance.
 */
export function selectHeroVideo(
  library: MediaLibrary,
  context: SelectionContext,
): LibraryVideo | null {
  const inGroup = library.videos.filter(
    (video) => video.group === context.group && video.luminance === context.colorMode,
  );
  const pool =
    inGroup.length > 0
      ? inGroup
      : // No footage for this trade in this mode. Rather than serve an unreadable header, widen to
        // any group at the right luminance: a well-shot neutral interior beats a mismatched
        // on-topic one, because the copy has to be legible before it can be relevant.
        library.videos.filter((video) => video.luminance === context.colorMode);
  return pickSeeded(pool, (video) => hueAffinity(video.hue, context.accentHue), context.seed);
}

/**
 * Stills for section grounds, in the order they should be assigned.
 *
 * Returns as many DISTINCT stills as the caller asked for, best fit first. A page whose every band
 * carries the same photo reads as a template; this is what stops that.
 */
export function selectGrounds(
  library: MediaLibrary,
  context: SelectionContext,
  count: number,
): readonly LibraryImage[] {
  if (count <= 0) return [];
  const candidates = library.images.filter(
    (image) =>
      image.role === 'ground' &&
      image.luminance === context.colorMode &&
      image.orientation === 'landscape',
  );
  const inGroup = candidates.filter((image) => image.group === context.group);
  const pool = inGroup.length >= count ? inGroup : candidates;

  const ranked = [...pool].sort((a, b) => {
    const byHue = hueAffinity(b.hue, context.accentHue) - hueAffinity(a.hue, context.accentHue);
    // Ties broken by seeded id order, so two sites in one group do not get the same sequence.
    if (byHue !== 0) return byHue;
    return hash(context.seed + a.id) - hash(context.seed + b.id);
  });
  return ranked.slice(0, count);
}

/** Every group the library can currently serve a hero for, in both modes. Used by the ingest gate. */
export function coverageGaps(
  library: MediaLibrary,
  groups: readonly MediaGroupKey[],
): readonly {
  readonly group: MediaGroupKey;
  readonly luminance: LuminanceClass;
  readonly have: number;
}[] {
  const gaps: { group: MediaGroupKey; luminance: LuminanceClass; have: number }[] = [];
  for (const group of groups) {
    for (const luminance of ['light', 'dark'] as const) {
      const have = library.videos.filter(
        (video) => video.group === group && video.luminance === luminance,
      ).length;
      if (have < 2) gaps.push({ group, luminance, have });
    }
  }
  return gaps;
}
