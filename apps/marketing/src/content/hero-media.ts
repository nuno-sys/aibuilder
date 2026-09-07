/**
 * The hero media contract: what the sales page's own full-screen video header is allowed to be.
 *
 * WHERE THE FILES COME FROM. Not from a hand-run ffmpeg line in a comment — that is what this file
 * used to be, and the binaries it named were never in the repository, so the marketing hero was an
 * empty box. They now come from the media library: the `brand` clip is ingested by exactly the
 * encoder every tenant clip goes through, and `scripts/media-library/stage-marketing.mjs` copies
 * its renditions into `public/media/hero/` and writes `hero-media.generated.ts`. One encoder, one
 * set of budgets, one place a change lands. The sales page cannot promise a fast video header while
 * shipping a slow one, because it is serving the same bytes the product produces.
 *
 * WHY THE LCP GUARDS LIVE HERE. A `<video>` is an LCP candidate, and LCP stays open until the first
 * user interaction, so no amount of "mount the video later" can stop it from superseding the
 * poster. Only a size invariant can:
 *
 *     poster intrinsic area  >=  video intrinsic area,  at every breakpoint
 *
 * because the LCP algorithm replaces a candidate only with a STRICTLY larger one. The numbers are
 * generated; the assertion is written here, next to the reason, so a re-encode that breaks the
 * invariant fails the build instead of being rediscovered in a Lighthouse regression (SEO §4.1,
 * §4.5; architecture §7.17).
 *
 * WHY THERE ARE TWO VIDEOS. A phone getting the 1920x1080 desktop file is the single decision that
 * gives background video its bad reputation: four times the bytes, letterboxed into the wrong
 * shape. The portrait encode is a fraction of the bytes AND fills the screen. The user asked for a
 * full-screen video header everywhere; the honest way to give a phone one is to send it a phone's
 * video, not to send it the desktop's and hope.
 *
 * The encoder settings themselves are stated once, in `scripts/media-library/ingest.mjs`. They are
 * deliberately not repeated here: two copies of an encoder invocation is two copies that drift.
 */

import {
  brandCredit,
  brandLandscape,
  brandLuminance,
  brandPortrait,
  brandPoster,
  brandPosterPortrait,
} from './hero-media.generated';
import type { GeneratedPoster, GeneratedVideo } from './hero-media.generated';

export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

export interface HeroPoster {
  /** Media condition, identical on the `<source>` and on the `<link rel="preload">`. */
  readonly media: string;
  readonly avifSrcset: string;
  readonly webpSrcset: string;
  readonly sizes: string;
  /** Intrinsic size of the LARGEST candidate — the cap on this poster's LCP size. */
  readonly intrinsic: Dimensions;
}

export interface HeroVideo {
  readonly av1: string;
  readonly h264: string;
  readonly intrinsic: Dimensions;
  /** Measured at encode time by the ingest, never estimated here. */
  readonly maxBytes: number;
}

/**
 * Fails the build when a video could out-size its poster and steal the LCP entry.
 *
 * @throws Error when the poster's intrinsic area is smaller than the video's.
 */
function assertPosterDominates(label: string, poster: Dimensions, video: Dimensions): void {
  const posterArea = poster.width * poster.height;
  const videoArea = video.width * video.height;
  if (posterArea < videoArea) {
    throw new Error(
      `Hero LCP size invariant violated at ${label}: ` +
        `poster ${poster.width}x${poster.height} (${posterArea}px) is smaller than ` +
        `video ${video.width}x${video.height} (${videoArea}px). ` +
        'The video would become a new, later LCP candidate. Re-encode the poster larger.',
    );
  }
}

/**
 * Fails the build when a video's bytes exceed what a hero may cost.
 *
 * A budget that is not asserted is a wish. These are the ceilings SEO §4.13 sets for a header that
 * has to load on a phone on a train, and they are checked against the sizes the encoder actually
 * produced rather than the sizes it was asked for.
 *
 * @throws Error when the encode is over budget.
 */
function assertWithinBudget(label: string, video: GeneratedVideo, maxBytes: number): void {
  if (video.maxBytes > maxBytes) {
    throw new Error(
      `Hero byte budget exceeded at ${label}: ${video.maxBytes} B against a ${maxBytes} B ceiling. ` +
        'Re-encode at a higher CRF or shorten the loop; do not raise the ceiling.',
    );
  }
}

/**
 * The tallest phone aspect a rung has to cover: 19.5/9, the shape of a modern flagship.
 *
 * A rung of width `w` is selected when `viewport width x DPR` is about `w`, so at DPR 1 the
 * viewport is `w` CSS px wide and as tall as the device. If the rung's intrinsic area is smaller
 * than that box, LCP scores the poster down to its intrinsic size while the video — clamped to the
 * full box — scores higher, and the video takes the entry. Cutting the ladder at this aspect is
 * what makes the argument hold at every rung rather than only at the top of the ladder.
 */
const TALLEST_PHONE_ASPECT = 19.5 / 9;

/**
 * Fails the build when a portrait rung is smaller than the viewport that selects it.
 *
 * @throws Error when any rung falls short.
 */
function assertRungsCoverTheirViewports(poster: GeneratedPoster): void {
  const ratio = poster.height / poster.width;
  for (const candidate of poster.avifSrcset.split(', ')) {
    const width = Number(candidate.split(' ')[1]?.replace('w', ''));
    if (!Number.isFinite(width)) continue;
    const area = width * Math.round(width * ratio);
    const box = width * width * TALLEST_PHONE_ASPECT;
    if (area + width < box) {
      throw new Error(
        `Portrait poster rung ${String(width)}w is ${String(Math.round(area))}px against a ` +
          `${String(Math.round(box))}px viewport box. Cut the ladder at 9:19.5, not 9:16, ` +
          'or the hero video takes the LCP entry on every phone that selects this rung.',
      );
    }
  }
}

const toPoster = (poster: GeneratedPoster, media: string): HeroPoster => ({
  media,
  avifSrcset: poster.avifSrcset,
  webpSrcset: poster.webpSrcset,
  sizes: '100vw',
  intrinsic: { width: poster.width, height: poster.height },
});

const toVideo = (video: GeneratedVideo): HeroVideo => ({
  av1: video.av1,
  h264: video.h264,
  intrinsic: { width: video.width, height: video.height },
  maxBytes: video.maxBytes,
});

/** Landscape, `(min-width: 768px)`. */
export const landscapePoster: HeroPoster = toPoster(brandPoster, '(min-width: 768px)');

/**
 * Portrait, `(max-width: 767px)` — a real 9:16 crop, not the landscape still cover-fitted.
 *
 * The art direction is the visible reason. The load-bearing one is that LCP scores an image at
 * `min(visible area, intrinsic area)`: cover-fitting the 16:9 ladder into a phone viewport picks a
 * rung smaller than the hero is displayed at, so the poster is scored down while the portrait video
 * is scored at the full box — and the video wins. Every rung of this ladder is larger than any
 * phone hero is displayed at, so the poster is never capped and the video can at best tie.
 */
export const portraitPoster: HeroPoster = toPoster(brandPosterPortrait, '(max-width: 767px)');

export const landscapeVideo: HeroVideo = toVideo(brandLandscape);

/** The phone's own encode. Mounted below 768px, where the landscape file would be wrong twice. */
export const portraitVideo: HeroVideo = toVideo(brandPortrait);

/**
 * The `<img>` `src`: the largest WebP rung.
 *
 * Never AVIF — this is the last-resort candidate for a UA that supports neither AVIF nor WebP…
 * except that every UA which reaches this markup decodes WebP, which is why the ladder stops at two
 * formats instead of carrying a JPEG rung nobody fetches. Its `width`/`height` attributes are what
 * give the element an aspect ratio before any byte arrives.
 */
export const posterFallback = {
  src: brandPoster.fallback,
  intrinsic: { width: brandPoster.width, height: brandPoster.height },
} as const;

/**
 * Focal point for `object-position`. Framing on the upper-middle keeps the subject visible when a
 * tall phone viewport crops the sides away.
 */
export const heroFocalPoint = '50% 42%';

/** Measured off the pixels at ingest. The scrim washes white over light footage, ink over dark. */
export const heroLuminance = brandLuminance;

/** Attribution the licence requires, rendered in the footer. `null` when none is required. */
export const heroCredit = brandCredit;

assertPosterDominates('landscape', landscapePoster.intrinsic, landscapeVideo.intrinsic);
assertPosterDominates('portrait', portraitPoster.intrinsic, portraitVideo.intrinsic);
assertRungsCoverTheirViewports(brandPosterPortrait);

// Landscape is allowed more because it only ever loads on a wide viewport, which correlates with a
// connection that can afford it; the phone's ceiling is a third of that.
assertWithinBudget('landscape', brandLandscape, 1_400_000);
assertWithinBudget('portrait', brandPortrait, 450_000);

/**
 * Art-directed `<link rel="preload">` descriptors for `<head>`.
 *
 * `imagesrcset` + `imagesizes` mirror the `<picture>` exactly, so the preload resolves to the same
 * candidate the renderer will pick — preloading a single fixed URL against a multi-entry srcset
 * downloads the wrong file and pays for it twice. Only AVIF is preloaded; a UA without AVIF support
 * discards the hint and fetches WebP normally.
 */
export const heroPreloads: readonly {
  readonly media: string;
  readonly imagesrcset: string;
  readonly imagesizes: string;
}[] = [
  {
    media: portraitPoster.media,
    imagesrcset: portraitPoster.avifSrcset,
    imagesizes: portraitPoster.sizes,
  },
  {
    media: landscapePoster.media,
    imagesrcset: landscapePoster.avifSrcset,
    imagesizes: landscapePoster.sizes,
  },
];
