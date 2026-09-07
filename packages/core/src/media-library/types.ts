/**
 * The pre-built media library.
 *
 * WHY A LIBRARY AND NOT A SEARCH
 * The obvious design is to search a stock provider while the site is being generated. It is the
 * wrong one, for four reasons that all bite at the same time:
 *
 *  - it puts a third-party API on the critical path of the one operation the customer is watching;
 *  - it spends a rate-limited quota per signup, so throughput is capped by someone else's tier;
 *  - the result is unvetted, so quality is whatever the search returned that day; and
 *  - the clip still has to be transcoded before it can be served, which is compute a Worker does
 *    not have.
 *
 * Curating once and shipping the result removes all four. Selection at generation time becomes a
 * lookup against data we already hold: no network, no quota, no transcode, no surprise. The cost is
 * that the library has to be filled deliberately — which is a feature, because it is the only way
 * to guarantee that every clip has actually been looked at by someone.
 *
 * WHAT IS KEYED ON WHAT
 * Entries are keyed on the INDUSTRY GROUP (14 of them), not the industry (104) and not the design
 * archetype (4). The group is the level at which footage is genuinely reusable: a bakery and a
 * coffee bar want the same kind of scene, a physiotherapist and a dentist want the same kind of
 * room. Below that the library would be unfillable; above it the footage stops being about the
 * trade at all.
 *
 * Luminance is carried per entry rather than per group, because most groups contain both light and
 * dark businesses — a nightclub and a wedding planner are both `events`. The selector treats
 * luminance as a HARD constraint and hue as a soft preference.
 */

import type { LuminanceClass } from '@aibuilder/site-schema';

/** The 14 industry groups the library is organised by. Mirrors `INDUSTRY_GROUPS`. */
export type MediaGroupKey =
  | 'food_drink'
  | 'beauty'
  | 'health'
  | 'sport'
  | 'trades'
  | 'automotive'
  | 'retail'
  | 'professional'
  | 'events'
  | 'education'
  | 'real_estate'
  | 'travel'
  | 'pets'
  | 'crafts';

/** One encoded rendition of a clip. Both codecs carry the same footage at the same size. */
export interface LibraryVideoRendition {
  /** Object key, relative to the media bucket root. Never a URL: the origin is a binding. */
  readonly av1Key: string;
  readonly h264Key: string;
  readonly width: number;
  readonly height: number;
  /** Bytes of the larger of the two. The publish budget asserts against this. */
  readonly maxBytes: number;
}

/** One responsive still, in the two formats worth shipping in 2026. */
export interface LibraryImageRendition {
  /** `{width}` is substituted by the renderer to build a srcset. */
  readonly avifKeyTemplate: string;
  readonly webpKeyTemplate: string;
  /** Widths actually encoded, ascending. A srcset never offers a width that was not built. */
  readonly widths: readonly number[];
  /** Intrinsic size of the largest rendition, for the aspect-ratio box. */
  readonly width: number;
  readonly height: number;
}

/** One clip in the library. */
export interface LibraryVideo {
  readonly id: string;
  readonly group: MediaGroupKey;
  /**
   * Measured from the poster frame at ingest, never declared by hand.
   *
   * A HARD constraint on selection: dark footage under a light theme's dark ink is unreadable, and
   * so is the reverse.
   */
  readonly luminance: LuminanceClass;
  /**
   * Dominant hue in degrees, 0-359, or `null` for footage with no meaningful chroma.
   *
   * A SOFT preference. It is what makes "picked to go with the site's colours" true rather than
   * decorative, but a hue mismatch is a missed opportunity while a luminance mismatch is a defect.
   */
  readonly hue: number | null;
  readonly landscape: LibraryVideoRendition;
  readonly portrait: LibraryVideoRendition;
  /** The poster. Always present: it is the LCP element whether or not the video ever plays. */
  readonly poster: LibraryImageRendition;
  readonly durationSeconds: number;
  /** Human description, for the editor's picker and for `alt` on the poster. */
  readonly description: string;
  /** Attribution required by the source's licence, or `null` when none is required. */
  readonly credit: string | null;
}

/** One still in the library: a section ground, a page header, or a gallery filler. */
export interface LibraryImage {
  readonly id: string;
  readonly group: MediaGroupKey;
  readonly luminance: LuminanceClass;
  readonly hue: number | null;
  /** What this still is for. A ground is scrimmed and carries copy; a feature stands alone. */
  readonly role: 'ground' | 'feature';
  readonly orientation: 'landscape' | 'portrait' | 'square';
  readonly rendition: LibraryImageRendition;
  readonly description: string;
  readonly credit: string | null;
}

/** The whole library, as shipped. */
export interface MediaLibrary {
  /** Bumped when the SHAPE changes. Adding entries is not a version change. */
  readonly version: 1;
  /** Ingest stamp, for provenance. Not read by any selection path. */
  readonly builtAt: string;
  readonly videos: readonly LibraryVideo[];
  readonly images: readonly LibraryImage[];
}
