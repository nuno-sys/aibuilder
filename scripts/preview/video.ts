/**
 * Real hero footage for the preview, encoded on the spot.
 *
 * The production pipeline sources a clip that is relevant to the specific business and re-hosts it.
 * That path needs a Pexels key and network egress, neither of which exists in a preview run — but
 * "there is no video here" was exactly what made the demos unable to show the product's headline
 * feature. So the harness ENCODES its own: an abstract, slow-moving field in the archetype's own
 * palette, at the two sizes and in the two codecs the real manifest specifies.
 *
 * It is placeholder footage and it says so on screen. What it is not is a still, a grey box, or an
 * absence — the point of the preview is to show that the header moves, fills the viewport, and
 * carries its copy legibly over moving pixels.
 *
 * Encoder settings are the ones `apps/marketing/src/content/hero-media.ts` documents for production,
 * so what you watch here is what the budget was written against:
 *   - no audio track at all (`-an`), which removes 15-25% of the bytes and every autoplay edge case
 *   - `+faststart`, without which Safari buffers the whole file before the first frame
 *   - AV1 first, H.264 second: a modern browser never downloads the fallback
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import ffmpegPath from 'ffmpeg-static';

/** One encode target. Landscape drives desktop; portrait is what a phone actually gets. */
export interface VideoTarget {
  readonly role: 'landscape' | 'portrait';
  readonly width: number;
  readonly height: number;
  /** Constant-quality target. Portrait is tighter: it is the file a phone downloads. */
  readonly av1Crf: number;
  readonly h264Crf: number;
}

/** `gradients` shapes that hold up behind copy. Spiral is the most alive; radial the calmest. */
export type GradientType = 'linear' | 'radial' | 'spiral';

export const VIDEO_TARGETS: readonly VideoTarget[] = [
  { role: 'landscape', width: 1920, height: 1080, av1Crf: 38, h264Crf: 27 },
  { role: 'portrait', width: 720, height: 1280, av1Crf: 42, h264Crf: 31 },
];

/** Seconds. Long enough not to read as a loop, short enough to stay inside the byte budget. */
const DURATION = 8;
const FPS = 25;

/** What one encoded pair came out as. */
export interface EncodedVideo {
  readonly role: 'landscape' | 'portrait';
  readonly av1File: string;
  readonly h264File: string;
  readonly width: number;
  readonly height: number;
  readonly maxBytes: number;
}

/**
 * The filter graph for one archetype's footage.
 *
 * `gradients` alone, deliberately. The obvious chain — blur the field, add a vignette, dust it with
 * noise — aborts at teardown in the static ffmpeg build this harness ships with (exit 134, AFTER a
 * valid file has been written, which is the most misleading way for a build step to fail). Three
 * colour stops drifting slowly are enough: the header has a full-strength scrim over it and the
 * copy is what the eye goes to.
 *
 * `speed` is very low on purpose. Fast movement behind text reads as a distraction; this is meant
 * to be the kind of motion you notice only when you look for it.
 */
function filterGraph(target: VideoTarget, stops: readonly string[], type: GradientType): string {
  const colours = stops.map((hex, index) => `c${String(index)}=${hex}`).join(':');
  return (
    [
      `gradients=s=${String(target.width)}x${String(target.height)}`,
      colours,
      `nb_colors=${String(stops.length)}`,
      `type=${type}`,
      'speed=0.015',
      `r=${String(FPS)}`,
      `d=${String(DURATION)}`,
    ].join(':') + ',format=yuv420p'
  );
}

function run(args: readonly string[]): void {
  if (ffmpegPath === null) throw new Error('ffmpeg-static did not resolve a binary');
  execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

/**
 * Encodes both codecs at one size.
 *
 * @param outDir  directory the two files land in
 * @param slug    archetype key, used as the file stem
 * @param stops   the archetype's own colours, dark ground first
 * @param type    gradient shape
 */
export function encodeTarget(
  outDir: string,
  slug: string,
  target: VideoTarget,
  stops: readonly string[],
  type: GradientType,
): EncodedVideo {
  mkdirSync(outDir, { recursive: true });
  const stem = path.join(outDir, `${slug}-${target.role}`);
  const av1File = `${stem}.av1.webm`;
  const h264File = `${stem}.h264.mp4`;
  const graph = filterGraph(target, stops, type);

  run([
    '-f',
    'lavfi',
    '-i',
    graph,
    '-an',
    '-c:v',
    'libaom-av1',
    '-crf',
    String(target.av1Crf),
    '-b:v',
    '0',
    '-cpu-used',
    '8',
    '-row-mt',
    '1',
    '-g',
    String(FPS * 2),
    '-pix_fmt',
    'yuv420p',
    av1File,
  ]);
  run([
    '-f',
    'lavfi',
    '-i',
    graph,
    '-an',
    '-c:v',
    'libx264',
    '-profile:v',
    'high',
    '-level',
    '4.0',
    '-crf',
    String(target.h264Crf),
    '-preset',
    'medium',
    '-tune',
    'film',
    '-g',
    String(FPS * 2),
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    h264File,
  ]);

  return {
    role: target.role,
    av1File,
    h264File,
    width: target.width,
    height: target.height,
    maxBytes: Math.max(statSync(av1File).size, statSync(h264File).size),
  };
}

/** Encodes both sizes for one archetype, skipping anything already on disk. */
export function encodeArchetype(
  outDir: string,
  slug: string,
  stops: readonly string[],
  type: GradientType,
  force = false,
): readonly EncodedVideo[] {
  if (force) rmSync(path.join(outDir, slug), { recursive: true, force: true });
  return VIDEO_TARGETS.map((target) => {
    const stem = path.join(outDir, `${slug}-${target.role}`);
    if (!force && existsSync(`${stem}.av1.webm`) && existsSync(`${stem}.h264.mp4`)) {
      return {
        role: target.role,
        av1File: `${stem}.av1.webm`,
        h264File: `${stem}.h264.mp4`,
        width: target.width,
        height: target.height,
        maxBytes: Math.max(statSync(`${stem}.av1.webm`).size, statSync(`${stem}.h264.mp4`).size),
      };
    }
    return encodeTarget(outDir, slug, target, stops, type);
  });
}

export const VIDEO_DURATION_SECONDS = DURATION;
