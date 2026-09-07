/**
 * Whether an image reads as light or dark — measured, never guessed.
 *
 * This single bit decides two things that are invisible until they are wrong: which scrim the
 * renderer paints behind hero copy, and whether a piece of footage is allowed to sit behind a given
 * theme at all. A dark clip under a light theme's dark ink is unreadable; so is the reverse. The
 * model is never asked, because a model looking at a thumbnail can tell you a scene is "moody" and
 * cannot tell you whether white text will survive on it.
 *
 * The input is a representative colour: the stock provider's own average colour for a photo or a
 * video's poster frame, or the dominant colour the derivative pipeline computes for an upload. That
 * is a coarse summary of a whole image, and deliberately so — the decision it feeds is coarse too.
 */

import type { LuminanceClass } from '@aibuilder/site-schema';

/**
 * The boundary between "wants dark ink" and "wants light ink", in relative luminance.
 *
 * Not 0.5. Relative luminance is already perceptually weighted, and the midpoint of the SCALE is
 * not the midpoint of PERCEPTION: a 0.5-luminance ground is a light mid-grey that white text fails
 * on. 0.32 is where a full-strength scrim can still rescue either ink, which is the property that
 * actually matters here. Moving it requires re-deriving the scrim alphas in `tokens/resolve.ts`.
 */
export const LUMINANCE_BOUNDARY = 0.32;

/** One sRGB channel, 0-255, linearised per the sRGB transfer function. */
function linearise(channel8Bit: number): number {
  const c = channel8Bit / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * Parses `#rgb`, `#rrggbb` or `#rrggbbaa` into 8-bit channels. Alpha is ignored: a representative
 * colour is opaque by construction, and honouring alpha here would silently darken every result.
 */
export function parseHexColour(hex: string): { r: number; g: number; b: number } | null {
  const value = hex.trim().toLowerCase();
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/u.test(value)) return null;
  const body = value.slice(1);
  const expanded =
    body.length === 3
      ? body
          .split('')
          .map((c) => c + c)
          .join('')
      : body.slice(0, 6);
  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16),
  };
}

/** WCAG relative luminance of a hex colour, or `null` when the string is not a colour. */
export function relativeLuminanceOfHex(hex: string): number | null {
  const rgb = parseHexColour(hex);
  if (rgb === null) return null;
  return 0.2126 * linearise(rgb.r) + 0.7152 * linearise(rgb.g) + 0.0722 * linearise(rgb.b);
}

/**
 * Classifies a representative colour as `light` or `dark`.
 *
 * Returns `null` when there is nothing to measure. `null` is not "assume light": every caller must
 * decide what an unknown means for it, and for the hero the answer is to fall back to the theme's
 * own canonical mode rather than to gamble on the copy being readable.
 */
export function classifyLuminance(hex: string | null | undefined): LuminanceClass | null {
  if (hex === null || hex === undefined) return null;
  const luminance = relativeLuminanceOfHex(hex);
  if (luminance === null) return null;
  return luminance >= LUMINANCE_BOUNDARY ? 'light' : 'dark';
}

/**
 * Whether a piece of media may sit behind a theme in the given colour mode.
 *
 * A dark site wants dark footage and a light site wants light footage — stated by the client as a
 * hard rule, and it is also what keeps the scrim doing gentle work instead of heroic work. Unknown
 * luminance is permitted: refusing it would leave a site with no header at all, which is worse than
 * a scrim that has to work a little harder.
 */
export function luminanceMatchesMode(
  luminance: LuminanceClass | null,
  colorMode: 'light' | 'dark',
): boolean {
  return luminance === null || luminance === colorMode;
}
