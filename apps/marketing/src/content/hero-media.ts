/**
 * The hero media manifest: every poster and video file the hero references, with the intrinsic
 * dimensions that make the LCP size invariant checkable.
 *
 * WHY A MANIFEST AND NOT LITERALS IN THE COMPONENT
 * A `<video>` is an LCP candidate, and LCP stays open until the first user interaction — so timing
 * cannot stop the video from superseding the poster. Only a size invariant can:
 *
 *     poster intrinsic area  >=  video intrinsic area,  at every breakpoint
 *
 * because the LCP algorithm only replaces a candidate with a STRICTLY larger one. Keeping the
 * numbers here, next to the assertion below, means the invariant is enforced at build time rather
 * than rediscovered from a Lighthouse regression (SEO §4.1, §4.5; architecture §7.17).
 *
 * THE BINARY FILES ARE NOT IN THIS REPO. They are produced once by the media pipeline and uploaded
 * to `public/media/hero/` with exactly the names below. The encoder invocations are fixed by
 * SEO §4.5 and reproduced here so the names, dimensions and byte budgets cannot drift apart:
 *
 *   POSTER (landscape 2400x1350, portrait 1170x2080) — AVIF primary, WebP fallback, JPEG for <img>:
 *     avifenc --min 0 --max 40 --speed 4 --yuv 420 --depth 8 --cicp 1/13/6 in.png out.avif
 *     cwebp -q 72 -m 6 -sharp_yuv in.png -o out.webp
 *     cjpeg -quality 74 -progressive -optimize -sample 2x2 -outfile out.jpg in.ppm
 *
 *   VIDEO (landscape only, 1920x1080, 8 s loop, NO audio track):
 *     ffmpeg -i master.mov -an -t 8 -vf "scale=1920:1080:flags=lanczos,fps=25" \
 *       -c:v libsvtav1 -crf 38 -preset 6 -g 50 -pix_fmt yuv420p hero-1920.av1.webm
 *     ffmpeg -i master.mov -an -t 8 -vf "scale=1920:1080:flags=lanczos,fps=25" \
 *       -c:v libx264 -profile:v high -level 4.0 -crf 27 -preset slower -tune film \
 *       -g 50 -pix_fmt yuv420p -movflags +faststart hero-1920.h264.mp4
 *
 * `-an` removes 15-25% of the bytes and removes every autoplay-policy edge case at once: a muted
 * video with an audio track can still be blocked by UA heuristics; a video with no audio track
 * cannot. `+faststart` puts the moov atom first, without which Safari downloads the entire file
 * before the first frame.
 */

const BASE = '/media/hero';

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
  /** Publish-time byte budget (SEO §4.13). Asserted by the media pipeline, not by this module. */
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

/** Landscape (>= 768px): the only breakpoint that ever mounts a video. */
export const landscapePoster: HeroPoster = {
  media: '(min-width: 768px)',
  avifSrcset: `${BASE}/hero-l-1280.avif 1280w, ${BASE}/hero-l-1920.avif 1920w, ${BASE}/hero-l-2400.avif 2400w`,
  webpSrcset: `${BASE}/hero-l-1280.webp 1280w, ${BASE}/hero-l-1920.webp 1920w, ${BASE}/hero-l-2400.webp 2400w`,
  sizes: '100vw',
  intrinsic: { width: 2400, height: 1350 },
};

/**
 * Portrait (< 768px): poster only. Architecture §7.18 makes mobile poster-only by default, which
 * is also why there is no 9:16 encode to maintain — the still is a legitimate hero on its own.
 */
export const portraitPoster: HeroPoster = {
  media: '(max-width: 767px)',
  avifSrcset: `${BASE}/hero-p-780.avif 780w, ${BASE}/hero-p-1170.avif 1170w`,
  webpSrcset: `${BASE}/hero-p-780.webp 780w, ${BASE}/hero-p-1170.webp 1170w`,
  sizes: '100vw',
  intrinsic: { width: 1170, height: 2080 },
};

export const landscapeVideo: HeroVideo = {
  av1: `${BASE}/hero-1920.av1.webm`,
  h264: `${BASE}/hero-1920.h264.mp4`,
  intrinsic: { width: 1920, height: 1080 },
  maxBytes: 1_400_000,
};

/**
 * The `<img>` `src`. Never AVIF: this is the last-resort candidate for a UA that supports neither
 * AVIF nor WebP, and its `width`/`height` attributes are what give the element an aspect ratio
 * before any byte arrives.
 */
export const posterFallbackJpeg = {
  src: `${BASE}/hero-l-1920.jpg`,
  intrinsic: { width: 1920, height: 1080 },
} as const;

/**
 * Focal point for `object-position`. The composition is a bright, high-key interior; framing on the
 * upper-middle keeps the subject visible when a tall phone viewport crops the sides away.
 */
export const heroFocalPoint = '50% 42%';

assertPosterDominates('landscape', landscapePoster.intrinsic, landscapeVideo.intrinsic);

/**
 * Art-directed `<link rel="preload">` descriptors for `<head>`.
 *
 * `imagesrcset` + `imagesizes` mirror the `<picture>` exactly, so the preload resolves to the same
 * candidate the renderer will pick — preloading a single fixed URL against a three-entry srcset
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
