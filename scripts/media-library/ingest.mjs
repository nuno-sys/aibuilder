/**
 * Builds the pre-optimised media library.
 *
 * Run once when footage changes, never during a site generation. That is the whole point: by the
 * time a customer clicks "make my website" every clip has already been transcoded to every
 * rendition it will ever be served in, measured for luminance and hue, and written into a manifest
 * the builder reads as plain data. No stock API on the critical path, no per-signup quota, no
 * transcode a Worker cannot do.
 *
 *   node scripts/media-library/ingest.mjs                 # ingest ./sources
 *   node scripts/media-library/ingest.mjs --synthesize    # generate stand-in footage first
 *   node scripts/media-library/ingest.mjs --force         # re-encode everything
 *
 * SOURCE LAYOUT
 *   scripts/media-library/sources/<group>/<name>.mp4      the clip
 *   scripts/media-library/sources/<group>/<name>.json     { description, credit }
 *   scripts/media-library/sources/<group>/<name>.jpg      a still, for the `ground` pool
 *
 * `luminance` and `hue` are NOT read from the sidecar. They are measured off the actual pixels,
 * because they are the two properties a human is worst at judging and the renderer most depends
 * on: get luminance wrong and the copy is unreadable.
 *
 * OUTPUT
 *   .media-library/out/<key>            every rendition, keyed exactly as the manifest says
 *   .media-library/media-library.json   the manifest, committed and shipped
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SOURCES = path.join(HERE, 'sources');
const OUT_ROOT = path.join(ROOT, '.media-library');
const OUT = path.join(OUT_ROOT, 'out');
const MANIFEST = path.join(OUT_ROOT, 'media-library.json');

const FFMPEG = path.join(ROOT, 'scripts/preview/node_modules/ffmpeg-static/ffmpeg');

/** The 14 groups. Must stay equal to `INDUSTRY_GROUPS` — `check.mjs` asserts it. */
const GROUPS = [
  'food_drink', 'beauty', 'health', 'sport', 'trades', 'automotive', 'retail',
  'professional', 'events', 'education', 'real_estate', 'travel', 'pets', 'crafts',
];

/**
 * Poster widths.
 *
 * Chosen against real device widths rather than round numbers: 640 covers a 1x phone, 960 a 2x
 * phone in portrait, 1280 a laptop, 1920 a 1x desktop and a 2x tablet, 2560 a dense desktop. Five
 * rungs is where the ladder stops paying for itself — a sixth saves bytes no one notices and costs
 * an encode on every clip.
 */
const POSTER_WIDTHS = [640, 960, 1280, 1920, 2560];

const VIDEO_TARGETS = [
  { role: 'landscape', width: 1920, height: 1080, av1Crf: 38, h264Crf: 27 },
  // A phone gets its own encode. Handing it the landscape file is the single decision that gives
  // background video its bad reputation: four times the bytes, letterboxed into the wrong shape.
  { role: 'portrait', width: 720, height: 1280, av1Crf: 42, h264Crf: 31 },
];

const DURATION = 8;
const FPS = 25;

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const SYNTHESIZE = args.has('--synthesize');

function ff(argv, capture = false) {
  return execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...argv], {
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** The average colour of a source's first frame, as `#rrggbb`. Measured, never declared. */
function averageColour(input) {
  const raw = ff(['-i', input, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], true);
  const part = (value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0');
  return `#${part(raw[0])}${part(raw[1])}${part(raw[2])}`;
}

function linearise(channel) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Kept in step with `packages/core/src/luminance.ts`; `check.mjs` asserts the boundary matches. */
const LUMINANCE_BOUNDARY = 0.32;

function measure(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance =
    0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b) >= LUMINANCE_BOUNDARY
      ? 'light'
      : 'dark';

  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), delta = max - min;
  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1) || Number.EPSILON);
  let hue = null;
  if (delta !== 0 && saturation >= 0.08) {
    let h;
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    hue = Math.round((((h * 60) % 360) + 360) % 360);
  }
  return { averageColour: hex, luminance, hue };
}

function fresh(file) {
  return !FORCE && existsSync(file) && statSync(file).size > 0;
}

/** Encodes one clip into every rendition it will ever be served in. */
function encodeVideo(input, group, name) {
  const renditions = {};
  for (const target of VIDEO_TARGETS) {
    const dir = path.join(OUT, 'video', group);
    mkdirSync(dir, { recursive: true });
    const av1Key = `video/${group}/${name}-${target.role}.av1.webm`;
    const h264Key = `video/${group}/${name}-${target.role}.h264.mp4`;
    const av1File = path.join(OUT, av1Key);
    const h264File = path.join(OUT, h264Key);
    // `increase` then centre-crop: the source is never letterboxed into the target shape, which is
    // what makes a portrait encode genuinely fill a phone rather than sit in a black box.
    const scale = `scale=${target.width}:${target.height}:force_original_aspect_ratio=increase,crop=${target.width}:${target.height},fps=${FPS},format=yuv420p`;

    if (!fresh(av1File)) {
      ff(['-i', input, '-t', String(DURATION), '-vf', scale, '-an',
        '-c:v', 'libaom-av1', '-crf', String(target.av1Crf), '-b:v', '0',
        '-cpu-used', '8', '-row-mt', '1', '-g', String(FPS * 2), av1File]);
    }
    if (!fresh(h264File)) {
      ff(['-i', input, '-t', String(DURATION), '-vf', scale, '-an',
        '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.0',
        '-crf', String(target.h264Crf), '-preset', 'medium', '-tune', 'film',
        '-g', String(FPS * 2), '-movflags', '+faststart', h264File]);
    }
    renditions[target.role] = {
      av1Key, h264Key, width: target.width, height: target.height,
      maxBytes: Math.max(statSync(av1File).size, statSync(h264File).size),
    };
  }
  return renditions;
}

/**
 * Encodes a still into the AVIF + WebP ladder.
 *
 * AVIF first and WebP second, both always built: AVIF is roughly 30% smaller at the same quality
 * and is not universal, so the `<picture>` needs the WebP row to fall back to. No JPEG rung — the
 * `<img>` src points at the largest WebP, which every browser that reaches this markup can decode.
 */
function encodeStill(input, kind, group, name) {
  const dir = path.join(OUT, kind, group);
  mkdirSync(dir, { recursive: true });
  const probe = ff(['-i', input, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], true);
  void probe;
  const widths = [];
  for (const width of POSTER_WIDTHS) {
    const avif = path.join(OUT, `${kind}/${group}/${name}-${width}.avif`);
    const webp = path.join(OUT, `${kind}/${group}/${name}-${width}.webp`);
    if (!fresh(avif)) {
      ff(['-i', input, '-frames:v', '1', '-vf', `scale=${width}:-2:flags=lanczos`,
        '-c:v', 'libaom-av1', '-crf', '32', '-cpu-used', '8', '-still-picture', '1', avif]);
    }
    if (!fresh(webp)) {
      ff(['-i', input, '-frames:v', '1', '-vf', `scale=${width}:-2:flags=lanczos`,
        '-c:v', 'libwebp', '-quality', '74', '-compression_level', '6', webp]);
    }
    widths.push(width);
  }
  const largest = path.join(OUT, `${kind}/${group}/${name}-${POSTER_WIDTHS.at(-1)}.webp`);
  const dims = ff(['-i', largest, '-f', 'null', '-'], true);
  void dims;
  return {
    avifKeyTemplate: `${kind}/${group}/${name}-{width}.avif`,
    webpKeyTemplate: `${kind}/${group}/${name}-{width}.webp`,
    widths,
    width: POSTER_WIDTHS.at(-1),
    height: Math.round((POSTER_WIDTHS.at(-1) * 9) / 16),
  };
}

/** Extracts the poster frame a clip's still ladder is built from. */
function posterFrameOf(input, group, name) {
  const dir = path.join(OUT_ROOT, 'frames', group);
  mkdirSync(dir, { recursive: true });
  const frame = path.join(dir, `${name}.png`);
  if (!fresh(frame)) {
    // One second in, not frame zero: the first frame of a clip is often a fade from black, which
    // would measure as dark footage regardless of what the clip actually looks like.
    ff(['-ss', '1', '-i', input, '-frames:v', '1', frame]);
  }
  return frame;
}

/* ── Stand-in footage ─────────────────────────────────────────────────────── */

/**
 * Generates placeholder clips so the library is complete without licensed footage.
 *
 * Two per group per luminance, which is the minimum `coverageGaps()` accepts. They are abstract
 * fields, clearly labelled in the manifest, and they exist so the whole path — ingest, manifest,
 * selection, render — can be exercised end to end. Replace them by dropping real files into
 * `sources/` and re-running; nothing else changes.
 */
const SYNTH = {
  dark: [['0x101014', '0x1d2233', '0x4d6ea8'], ['0x14100f', '0x2a1c19', '0xa8603d']],
  light: [['0xf4f6fa', '0xdfe6f0', '0x6f8fb8'], ['0xfaf6ef', '0xecdcc8', '0xc08a52']],
};

function synthesize() {
  let made = 0;
  for (const group of GROUPS) {
    const dir = path.join(SOURCES, group);
    mkdirSync(dir, { recursive: true });
    for (const [luminance, palettes] of Object.entries(SYNTH)) {
      palettes.forEach((stops, index) => {
        const name = `${luminance}-${index + 1}`;
        const file = path.join(dir, `${name}.mp4`);
        if (!fresh(file)) {
          const colours = stops.map((hex, i) => `c${i}=${hex}`).join(':');
          ff(['-f', 'lavfi', '-i',
            `gradients=s=1920x1080:${colours}:nb_colors=${stops.length}:type=${index === 0 ? 'radial' : 'linear'}:speed=0.015:r=${FPS}:d=${DURATION},format=yuv420p`,
            '-an', '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', file]);
          made += 1;
        }
        const sidecar = path.join(dir, `${name}.json`);
        if (!existsSync(sidecar)) {
          writeFileSync(sidecar, JSON.stringify({
            description: `Plaatshouder — abstracte ${luminance === 'dark' ? 'donkere' : 'lichte'} achtergrond voor ${group}`,
            credit: null,
            placeholder: true,
          }, null, 2) + '\n');
        }
      });
    }
  }
  return made;
}

/* ── Ingest ───────────────────────────────────────────────────────────────── */

function ingest() {
  const videos = [];
  const images = [];
  if (!existsSync(SOURCES)) {
    console.log(`no sources at ${path.relative(ROOT, SOURCES)} — run with --synthesize to generate stand-ins`);
    return { videos, images };
  }

  for (const group of readdirSync(SOURCES).filter((d) => GROUPS.includes(d))) {
    const dir = path.join(SOURCES, group);
    for (const file of readdirSync(dir).filter((f) => /\.(mp4|mov|webm)$/i.test(f)).sort()) {
      const name = file.replace(/\.[^.]+$/, '');
      const input = path.join(dir, file);
      const sidecarPath = path.join(dir, `${name}.json`);
      const sidecar = existsSync(sidecarPath) ? JSON.parse(readFileSync(sidecarPath, 'utf8')) : {};

      const frame = posterFrameOf(input, group, name);
      const measured = measure(averageColour(frame));
      const renditions = encodeVideo(input, group, name);
      const poster = encodeStill(frame, 'poster', group, name);

      videos.push({
        id: `${group}/${name}`,
        group,
        luminance: measured.luminance,
        hue: measured.hue,
        landscape: renditions.landscape,
        portrait: renditions.portrait,
        poster,
        durationSeconds: DURATION,
        description: sidecar.description ?? `${group} achtergrond`,
        credit: sidecar.credit ?? null,
      });
      console.log(
        `  ${group}/${name}`.padEnd(34),
        measured.luminance.padEnd(6),
        `hue ${measured.hue === null ? '—' : String(measured.hue).padStart(3)}`,
        `${String(Math.round(renditions.landscape.maxBytes / 1024)).padStart(5)} kB / ${String(Math.round(renditions.portrait.maxBytes / 1024)).padStart(4)} kB`,
      );

      // Every clip's own poster doubles as a section ground: it is already relevant, already
      // measured, and already encoded. A ground pool that needs its own sourcing run is a pool
      // that stays empty.
      images.push({
        id: `${group}/${name}-ground`,
        group,
        luminance: measured.luminance,
        hue: measured.hue,
        role: 'ground',
        orientation: 'landscape',
        rendition: poster,
        description: sidecar.description ?? `${group} achtergrond`,
        credit: sidecar.credit ?? null,
      });
    }
  }
  return { videos, images };
}

function main() {
  mkdirSync(OUT, { recursive: true });
  if (SYNTHESIZE) {
    const made = synthesize();
    console.log(`synthesize: ${made} stand-in clip(s) written to ${path.relative(ROOT, SOURCES)}`);
  }
  console.log('ingesting:');
  const { videos, images } = ingest();

  const manifest = {
    version: 1,
    builtAt: new Date().toISOString(),
    videos: videos.sort((a, b) => a.id.localeCompare(b.id)),
    images: images.sort((a, b) => a.id.localeCompare(b.id)),
  };
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');

  const gaps = [];
  for (const group of GROUPS) {
    for (const luminance of ['light', 'dark']) {
      const have = videos.filter((v) => v.group === group && v.luminance === luminance).length;
      if (have < 2) gaps.push(`${group}/${luminance} (${have})`);
    }
  }
  const bytes = videos.reduce((n, v) => n + v.landscape.maxBytes + v.portrait.maxBytes, 0);
  console.log(
    `\n${videos.length} clips, ${images.length} grounds, ${Math.round(bytes / 1024 / 1024)} MB of video ` +
      `-> ${path.relative(ROOT, MANIFEST)}`,
  );
  if (gaps.length > 0) {
    console.log(`coverage gaps (want >= 2 each): ${gaps.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`coverage: all ${GROUPS.length} groups dressed in both light and dark`);
  }
}

main();
