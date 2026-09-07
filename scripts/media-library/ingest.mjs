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
  'food_drink',
  'beauty',
  'health',
  'sport',
  'trades',
  'automotive',
  'retail',
  'professional',
  'events',
  'education',
  'real_estate',
  'travel',
  'pets',
  'crafts',
];

/**
 * The marketing site's own header, ingested through exactly the same pipeline as tenant footage.
 *
 * It is NOT one of the fourteen industry groups: it never enters a selection pool, and the coverage
 * gate does not ask it to be dressed in both luminances. It is here because a header the customer
 * sees on the sales page and a header the customer gets on their own site must be produced by one
 * encoder with one set of budgets — the moment the marketing hero is encoded by hand it drifts, and
 * the promise the sales page makes about speed stops being a promise the product keeps.
 */
const BRAND = 'brand';

/**
 * Poster widths.
 *
 * Chosen against real device widths rather than round numbers: 640 covers a 1x phone, 960 a 2x
 * phone in portrait, 1280 a laptop, 1920 a 1x desktop and a 2x tablet, 2560 a dense desktop. Five
 * rungs is where the ladder stops paying for itself — a sixth saves bytes no one notices and costs
 * an encode on every clip.
 */
const POSTER_WIDTHS = [640, 960, 1280, 1920, 2560];

/**
 * Portrait poster widths, and why the phone gets its own still at all.
 *
 * LCP compares a candidate's VISIBLE area capped by its INTRINSIC area, so an image displayed
 * larger than it was encoded is scored at its intrinsic size. Cover-fitting a 16:9 still into a
 * phone viewport is exactly that case: at 390x844 CSS px the landscape ladder's 640-wide rung is
 * 640x360 = 0.23 Mpx against 0.33 Mpx of visible hero, so the poster scores 0.23 and the portrait
 * VIDEO — clamped to the same 0.33 — scores strictly higher and steals the LCP entry.
 *
 * The rungs below are cut at `PORTRAIT_ASPECT`, which is what makes each one at least as large as
 * the box that selects it. 540 covers a 1x phone, 720 a small 2x, 1080 a 3x flagship, 1440 a
 * tablet in portrait.
 */
const PORTRAIT_POSTER_WIDTHS = [540, 720, 1080, 1440];

/**
 * The portrait poster's shape, identical to the portrait video's so the two crop the same way.
 *
 * 9:19.5 rather than 9:16, and this is what makes the LCP argument a proof rather than a hope. An
 * image is scored at `min(visible area, intrinsic area)`, so a rung only keeps the LCP entry while
 * its intrinsic area is at least the area it is displayed at. A rung of width `w` is selected when
 * `viewport width x DPR` is about `w`, so at DPR 1 the viewport is `w` CSS px wide and as tall as
 * the device — up to 19.5/9 of its width on the tallest phones shipping. At 9:16 the rung is
 * smaller than that box and the video, clamped to the same box, scores strictly higher and takes
 * the LCP entry. At 9:19.5 the rung is exactly the box, the video can at best tie, and a tie keeps
 * the poster: the algorithm only replaces a candidate with a strictly larger one.
 */
const PORTRAIT_ASPECT = 9 / 19.5;

const VIDEO_TARGETS = [
  { role: 'landscape', width: 1920, height: 1080, av1Crf: 38, h264Crf: 27 },
  // A phone gets its own encode. Handing it the landscape file is the single decision that gives
  // background video its bad reputation: four times the bytes, letterboxed into the wrong shape.
  //
  // 720x1560 is 9:19.5, the shape of a modern phone — NOT 9:16. Two reasons, and the second is the
  // load-bearing one. It fills the screen without cropping; and it is the same shape as the
  // portrait poster, so the moment the video fades in nothing reframes. A 9:16 encode behind a
  // 9:19.5 poster crops another 18% off the sides at the exact instant the visitor is looking.
  { role: 'portrait', width: 720, height: 1560, av1Crf: 42, h264Crf: 31 },
];

const DURATION = 8;
const FPS = 25;

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const SYNTHESIZE = args.has('--synthesize');

/**
 * Ingest only the marketing site's own header, and hold the coverage gate.
 *
 * The gate demands two light and two dark clips for all fourteen industry groups, which is right
 * for the tenant library and meaningless for the brand clip: `brand` is not a group, never enters a
 * selection pool, and is the ONLY thing the marketing hero needs. Without this flag, refreshing the
 * sales page's header means transcoding fifty-seven clips first — two hours to change one video.
 */
const BRAND_ONLY = args.has('--brand-only');

/**
 * The mirror of `--brand-only`: ingest the fourteen tenant groups and leave the header to `hero.yml`.
 *
 * The check below — "no brand clip, the marketing hero has no footage" — was written when one
 * pipeline owned everything, and it caught a real bug: a hero whose files existed only in a
 * comment. It still does, but it now belongs to the workflow that actually produces that clip. A
 * library run has nothing to say about it, and failing a two-hour transcode over a file it was
 * explicitly told not to fetch is the check firing at the wrong target.
 */
const NO_BRAND = args.has('--no-brand');

function ff(argv, capture = false) {
  return execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...argv], {
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** The average colour of a source's first frame, as `#rrggbb`. Measured, never declared. */
function averageColour(input) {
  const raw = ff(
    ['-i', input, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    true,
  );
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

  const rn = r / 255,
    gn = g / 255,
    bn = b / 255;
  const max = Math.max(rn, gn, bn),
    min = Math.min(rn, gn, bn),
    delta = max - min;
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
      ff([
        '-i',
        input,
        '-t',
        String(DURATION),
        '-vf',
        scale,
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
        av1File,
      ]);
    }
    if (!fresh(h264File)) {
      ff([
        '-i',
        input,
        '-t',
        String(DURATION),
        '-vf',
        scale,
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
        '-movflags',
        '+faststart',
        h264File,
      ]);
    }
    renditions[target.role] = {
      av1Key,
      h264Key,
      width: target.width,
      height: target.height,
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
function encodeStill(input, kind, group, name, shape = {}) {
  const { suffix = '', widths: ladder = POSTER_WIDTHS, aspect = null } = shape;
  const dir = path.join(OUT, kind, group);
  mkdirSync(dir, { recursive: true });
  const source = pngSize(input);
  const stem = `${name}${suffix}`;
  const heightAt = (width) =>
    aspect === null ? scaledHeight(width, source) : 2 * Math.round(width / aspect / 2);
  // A fixed aspect crops rather than squashes, with the same `increase`-then-crop pass the video
  // encoder uses, so the still and the clip frame the subject identically.
  const filterAt = (width) =>
    aspect === null
      ? `scale=${width}:-2:flags=lanczos`
      : `scale=${width}:${heightAt(width)}:force_original_aspect_ratio=increase:flags=lanczos,` +
        `crop=${width}:${heightAt(width)}`;

  const widths = [];
  for (const width of ladder) {
    const avif = path.join(OUT, `${kind}/${group}/${stem}-${width}.avif`);
    const webp = path.join(OUT, `${kind}/${group}/${stem}-${width}.webp`);
    if (!fresh(avif)) {
      ff([
        '-i',
        input,
        '-frames:v',
        '1',
        '-vf',
        filterAt(width),
        '-c:v',
        'libaom-av1',
        '-crf',
        '32',
        '-cpu-used',
        '8',
        '-still-picture',
        '1',
        avif,
      ]);
    }
    if (!fresh(webp)) {
      ff([
        '-i',
        input,
        '-frames:v',
        '1',
        '-vf',
        filterAt(width),
        '-c:v',
        'libwebp',
        '-quality',
        '74',
        '-compression_level',
        '6',
        webp,
      ]);
    }
    widths.push(width);
  }
  const width = ladder.at(-1);
  return {
    avifKeyTemplate: `${kind}/${group}/${stem}-{width}.avif`,
    webpKeyTemplate: `${kind}/${group}/${stem}-{width}.webp`,
    widths,
    width,
    height: heightAt(width),
  };
}

/**
 * Reads a PNG's intrinsic size straight out of its IHDR chunk.
 *
 * The declared poster height is what the `<img>` carries as its `height` attribute, so guessing it
 * from a hard-coded 16:9 is a content-layout-shift waiting for the first clip that is not 16:9.
 * The frame is always a PNG this script wrote one line earlier, so the header is enough — no
 * second ffmpeg invocation, no stderr scraping.
 *
 * @throws Error when the file is not a PNG.
 */
function pngSize(file) {
  const head = readFileSync(file).subarray(0, 24);
  if (head.length < 24 || head.readUInt32BE(0) !== 0x89504e47) {
    throw new Error(`not a PNG: ${file}`);
  }
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

/** The height ffmpeg's `scale=<width>:-2` produces: the source ratio, rounded to an even line. */
function scaledHeight(width, source) {
  return 2 * Math.round((width * source.height) / source.width / 2);
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
/**
 * Palettes for the stand-ins, chosen so the MEASUREMENT cannot disagree with the label.
 *
 * `gradients` animates, and the frame the luminance is measured from is one second in, so a palette
 * whose darkest stop straddles the 0.32 boundary lands on either side depending on where the
 * animation happens to be — which is exactly what happened to the first pass: four groups measured
 * only one light clip out of two and the coverage gate failed. Every stop of a light palette is now
 * above the boundary and every stop of a dark one below it, so the class is a property of the
 * palette rather than of the frame.
 */
const SYNTH = {
  dark: [
    ['0x101014', '0x1d2233', '0x4d6ea8'],
    ['0x14100f', '0x2a1c19', '0xa8603d'],
  ],
  light: [
    ['0xf7f9fc', '0xe6edf7', '0xb9cde6'],
    ['0xfdfaf5', '0xf2e6d6', '0xe0c39a'],
  ],
};

/** A stable seed per clip, so `--force` re-encodes the same footage instead of new footage. */
function seedOf(name) {
  let hash = 2166136261;
  for (const character of name) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  }
  return hash;
}

function writeSidecar(dir, name, description) {
  const sidecar = path.join(dir, `${name}.json`);
  if (!existsSync(sidecar)) {
    writeFileSync(
      sidecar,
      JSON.stringify({ description, credit: null, placeholder: true }, null, 2) + '\n',
    );
  }
}

function synthesizeClip(dir, name, stops, type) {
  const file = path.join(dir, `${name}.mp4`);
  if (fresh(file)) {
    return 0;
  }
  const colours = stops.map((hex, i) => `c${i}=${hex}`).join(':');
  ff([
    '-f',
    'lavfi',
    '-i',
    `gradients=s=1920x1080:${colours}:nb_colors=${stops.length}:type=${type}:` +
      `seed=${seedOf(`${path.basename(dir)}/${name}`)}:speed=0.015:r=${FPS}:d=${DURATION},format=yuv420p`,
    '-an',
    '-c:v',
    'libx264',
    '-crf',
    '20',
    '-preset',
    'veryfast',
    file,
  ]);
  return 1;
}

function synthesize() {
  let made = 0;

  // The marketing hero: high-key, because the sales page sets ink type and a white wash over it.
  // One clip, because the sales page has one header.
  const brandDir = path.join(SOURCES, BRAND);
  mkdirSync(brandDir, { recursive: true });
  made += synthesizeClip(brandDir, 'header', ['0xfbfaf7', '0xe8eef7', '0x8fa9cc'], 'radial');
  writeSidecar(brandDir, 'header', 'Plaatshouder — lichte merkachtergrond voor de marketingsite');

  for (const group of GROUPS) {
    const dir = path.join(SOURCES, group);
    mkdirSync(dir, { recursive: true });
    for (const [luminance, palettes] of Object.entries(SYNTH)) {
      palettes.forEach((stops, index) => {
        const name = `${luminance}-${index + 1}`;
        made += synthesizeClip(dir, name, stops, index === 0 ? 'radial' : 'linear');
        writeSidecar(
          dir,
          name,
          `Plaatshouder — abstracte ${luminance === 'dark' ? 'donkere' : 'lichte'} achtergrond voor ${group}`,
        );
      });
    }
  }
  return made;
}

/* ── Ingest ───────────────────────────────────────────────────────────────── */

/** Ingests one source clip into every rendition, measurement and manifest row it needs. */
function ingestClip(group, file) {
  const name = file.replace(/\.[^.]+$/, '');
  const dir = path.join(SOURCES, group);
  const input = path.join(dir, file);
  const sidecarPath = path.join(dir, `${name}.json`);
  const sidecar = existsSync(sidecarPath) ? JSON.parse(readFileSync(sidecarPath, 'utf8')) : {};

  const frame = posterFrameOf(input, group, name);
  const measured = measure(averageColour(frame));
  const renditions = encodeVideo(input, group, name);
  const poster = encodeStill(frame, 'poster', group, name);
  const posterPortrait = encodeStill(frame, 'poster', group, name, {
    suffix: '-p',
    widths: PORTRAIT_POSTER_WIDTHS,
    aspect: PORTRAIT_ASPECT,
  });

  const video = {
    id: `${group}/${name}`,
    group,
    luminance: measured.luminance,
    hue: measured.hue,
    landscape: renditions.landscape,
    portrait: renditions.portrait,
    poster,
    posterPortrait,
    durationSeconds: DURATION,
    description: sidecar.description ?? `${group} achtergrond`,
    credit: sidecar.credit ?? null,
  };
  console.log(
    `  ${group}/${name}`.padEnd(34),
    measured.luminance.padEnd(6),
    `hue ${measured.hue === null ? '—' : String(measured.hue).padStart(3)}`,
    `${String(Math.round(renditions.landscape.maxBytes / 1024)).padStart(5)} kB / ${String(Math.round(renditions.portrait.maxBytes / 1024)).padStart(4)} kB`,
  );

  // Every clip's own poster doubles as a section ground: it is already relevant, already
  // measured, and already encoded. A ground pool that needs its own sourcing run is a pool
  // that stays empty.
  const image = {
    id: `${group}/${name}-ground`,
    group,
    luminance: measured.luminance,
    hue: measured.hue,
    role: 'ground',
    orientation: 'landscape',
    rendition: poster,
    description: sidecar.description ?? `${group} achtergrond`,
    credit: sidecar.credit ?? null,
  };
  return { video, image };
}

function clipsIn(group) {
  const dir = path.join(SOURCES, group);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((f) => /\.(mp4|mov|webm)$/i.test(f))
    .sort()
    .map((file) => ingestClip(group, file));
}

function ingest() {
  const videos = [];
  const images = [];
  const brand = [];
  if (!existsSync(SOURCES)) {
    console.log(
      `no sources at ${path.relative(ROOT, SOURCES)} — run with --synthesize to generate stand-ins`,
    );
    return { videos, images, brand };
  }

  for (const group of readdirSync(SOURCES).filter((d) => GROUPS.includes(d))) {
    for (const { video, image } of clipsIn(group)) {
      videos.push(video);
      images.push(image);
    }
  }
  for (const { video } of clipsIn(BRAND)) {
    brand.push(video);
  }
  return { videos, images, brand };
}

function main() {
  mkdirSync(OUT, { recursive: true });
  if (SYNTHESIZE) {
    const made = synthesize();
    console.log(`synthesize: ${made} stand-in clip(s) written to ${path.relative(ROOT, SOURCES)}`);
  }
  console.log('ingesting:');
  const { videos, images, brand } = ingest();

  // The brand clip is staged into `apps/marketing/public/` and never uploaded to R2, so it does not
  // belong in the manifest the catalogue is projected from. Writing that manifest here would empty
  // the shipped catalogue of all fifty-seven tenant clips.
  if (BRAND_ONLY) {
    writeFileSync(
      MANIFEST,
      JSON.stringify(
        { version: 1, builtAt: new Date().toISOString(), videos: [], images: [], brand },
        null,
        2,
      ) + '\n',
    );
    if (brand.length === 0) {
      console.log(`\nno ${BRAND} clip ingested — sources/${BRAND}/ is empty`);
      process.exitCode = 1;
      return;
    }
    console.log(`\nbrand clip ready -> ${path.relative(ROOT, MANIFEST)}`);
    return;
  }

  const manifest = {
    version: 1,
    builtAt: new Date().toISOString(),
    videos: videos.sort((a, b) => a.id.localeCompare(b.id)),
    images: images.sort((a, b) => a.id.localeCompare(b.id)),
    brand: brand.sort((a, b) => a.id.localeCompare(b.id)),
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
  if (brand.length === 0 && !NO_BRAND) {
    console.log(
      `no ${BRAND} clip: the marketing hero has no footage. ` +
        `Add sources/${BRAND}/, re-run with --synthesize, or run the Homepage header workflow.`,
    );
    process.exitCode = 1;
  }
}

main();
