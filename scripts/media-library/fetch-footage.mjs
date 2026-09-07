/**
 * Fills `sources/` with real, licensed footage from Pexels.
 *
 *   PEXELS_KEY=... node scripts/media-library/fetch-footage.mjs
 *   PEXELS_KEY=... node scripts/media-library/fetch-footage.mjs --groups=food_drink,beauty
 *   PEXELS_KEY=... node scripts/media-library/fetch-footage.mjs --force
 *
 * WHY THIS IS A SEPARATE SCRIPT AND NOT PART OF THE GENERATOR
 * The generator already talks to Pexels for stills (`apps/generator/src/steps/media.ts`), on the
 * critical path of a single customer's job, under that customer's 4-second budget. This does the
 * opposite thing: it runs once, offline, against the whole catalogue, and everything it fetches is
 * then transcoded and measured by `ingest.mjs` before any customer sees it. The two must not share
 * a code path — one is allowed to fail silently into an image-free layout, this one is allowed to
 * take ten minutes and must fail loudly.
 *
 * WHY LUMINANCE IS MEASURED AFTER THE DOWNLOAD, NOT GUESSED FROM THE QUERY
 * The library's hard constraint is two light and two dark clips per group, and `ingest.mjs`
 * classifies by measuring the pixels of the frame one second in. If this script named files from
 * the query it used ("night" -> dark) the two would disagree the moment a search returned a clip of
 * a brightly lit restaurant at night, the file would be called `dark-1`, the manifest would call it
 * light, and the coverage gate would fail with no obvious cause. So the queries only tilt the odds:
 * each candidate is downloaded, measured through the SAME arithmetic the ingest uses, and only then
 * assigned a slot. A group stops downloading as soon as both slots are full.
 *
 * LICENCE
 * The Pexels licence permits download, modification, hosting and commercial use, and does NOT
 * require attribution. What does bind us is the Pexels API Guidelines, which ask for a visible link
 * back to Pexels wherever the API is used and credit to the creator where possible. Both are met by
 * the `credit` field written into each sidecar: `ingest.mjs` carries it into the manifest,
 * `emit-catalogue.mjs` into the bundled catalogue, and the footer renders it. Nothing here is
 * hotlinked — every byte is re-hosted from R2, which is what the licence permits and the
 * performance budget requires.
 */
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SOURCES = path.join(HERE, 'sources');
const FFMPEG = path.join(ROOT, 'scripts/preview/node_modules/ffmpeg-static/ffmpeg');

const API = 'https://api.pexels.com/videos/search';

/** Kept in step with `ingest.mjs` and `packages/core/src/luminance.ts`. */
const LUMINANCE_BOUNDARY = 0.32;

/** Two per group per luminance — exactly what `ingest.mjs`'s coverage gate demands. */
const PER_LUMINANCE = 2;

/**
 * How many candidates a group may download before giving up on filling a slot.
 *
 * A cap rather than "keep going": a group whose queries genuinely cannot produce a dark clip should
 * report that in seconds, not discover it after eighty downloads. When this trips the run fails and
 * names the group, which is a prompt to edit its query — a human decision, not something to retry.
 */
const MAX_DOWNLOADS_PER_GROUP = 12;

/** A clip shorter than this loops visibly; longer than this is bytes we throw away at `-t 8`. */
const MIN_SECONDS = 6;
const MAX_SECONDS = 45;

/**
 * The per-group searches.
 *
 * Two queries per group, deliberately pulling in opposite directions on light, because the coverage
 * gate wants both and a single query returns one mood. They are English: Pexels' index is English
 * and a Dutch query returns a fraction of the results — the same reason `steps/media.ts` composes
 * its query in English.
 *
 * These are the one genuinely editorial thing in the media pipeline. Everything downstream is
 * measurement; this is taste. Change a query when a group's footage looks wrong, then re-run with
 * `--force --groups=<group>`.
 */
const QUERIES = {
  food_drink: ['restaurant interior evening candlelight', 'bright cafe morning coffee counter'],
  beauty: ['barber shop dark interior', 'hair salon daylight bright'],
  health: ['physiotherapy treatment room calm', 'bright medical clinic reception'],
  sport: ['gym weights training dark', 'yoga studio morning light'],
  trades: ['welding workshop sparks', 'carpenter workshop daylight wood'],
  automotive: ['car detailing garage night', 'auto repair workshop daylight'],
  retail: ['boutique shop evening lights', 'bright retail store interior'],
  professional: ['modern office night city window', 'bright office workspace daylight'],
  events: ['wedding reception evening lights', 'event venue daylight flowers'],
  education: ['library books reading lamp', 'bright classroom daylight'],
  real_estate: ['modern house exterior evening', 'bright living room interior window'],
  travel: ['city street night travel', 'coastline daylight aerial'],
  pets: ['dog portrait dark background', 'pet grooming daylight bright'],
  crafts: ['pottery studio hands clay', 'craft workshop daylight handmade'],
};

/**
 * The marketing site's own header.
 *
 * One clip and only light, because the sales page sets dark ink over a white wash: a dark header
 * there is not a different mood, it is unreadable copy. It is not a group and the coverage gate
 * does not ask it for both luminances — see `BRAND` in `ingest.mjs`.
 */
const BRAND = 'brand';
const BRAND_QUERY = 'soft abstract light gradient minimal';

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const groupArg = [...args].find((a) => a.startsWith('--groups='));
const ONLY = groupArg === undefined ? null : new Set(groupArg.slice('--groups='.length).split(','));

const KEY = process.env.PEXELS_KEY ?? '';
if (KEY === '') {
  console.error(
    'PEXELS_KEY is not set.\n\n' +
      'Get one free at https://www.pexels.com/api/ (instant, no card), then either:\n' +
      '  export PEXELS_KEY=...                       # to run this locally\n' +
      '  add it as a repository secret PEXELS_KEY    # to let .github/workflows/media.yml run it\n',
  );
  process.exit(1);
}

/* -- Measurement ----------------------------------------------------------------------------- */

function linearise(channel) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * `light` or `dark`, measured off the same frame `ingest.mjs` will measure.
 *
 * Same second, same 1x1 downscale, same coefficients, same boundary. If these two ever drift the
 * filenames stop describing the manifest, so the duplication is deliberate and small: this script
 * must not import from the ingest, because the ingest is a build step with side effects.
 */
function luminanceOf(file) {
  const raw = execFileSync(
    FFMPEG,
    // prettier-ignore
    ['-hide_banner', '-loglevel', 'error', '-ss', '1', '-i', file, '-frames:v', '1',
     '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 },
  );
  if (raw.length < 3) {
    return null;
  }
  const value =
    0.2126 * linearise(raw[0]) + 0.7152 * linearise(raw[1]) + 0.0722 * linearise(raw[2]);
  return value >= LUMINANCE_BOUNDARY ? 'light' : 'dark';
}

/* -- Pexels ---------------------------------------------------------------------------------- */

let quotaRemaining = null;

async function search(query, perPage) {
  const url = new URL(API);
  url.searchParams.set('query', query);
  url.searchParams.set('orientation', 'landscape');
  // `medium` is "at least Full HD". `large` is 4K and costs minutes of download for frames the
  // 1920-wide encode throws away.
  url.searchParams.set('size', 'medium');
  url.searchParams.set('per_page', String(perPage));

  const response = await fetch(url, { headers: { authorization: KEY } });
  const remaining = response.headers.get('x-ratelimit-remaining');
  if (remaining !== null) {
    quotaRemaining = Number(remaining);
  }
  if (response.status === 429) {
    throw new Error(
      'Pexels rate limit reached (free tier is 200 requests/hour). Re-run in an hour, ' +
        'or request the higher limit at https://www.pexels.com/api/.',
    );
  }
  if (!response.ok) {
    throw new Error(`Pexels search failed: ${String(response.status)} ${response.statusText}`);
  }
  const body = await response.json();
  return Array.isArray(body.videos) ? body.videos : [];
}

/**
 * The rendition to download: the SMALLEST file that is still at least 1920 wide.
 *
 * Both halves matter. At least 1920 because the landscape encode is 1920x1080 and upscaling a
 * 1280-wide source produces a soft hero that no CRF can rescue. The smallest such because
 * everything above 1920 is detail `scale=1920:1080` immediately discards — paying for a 4K download
 * to throw away three quarters of its pixels is the most expensive way to get the same output.
 */
function bestFile(video) {
  const mp4 = (video.video_files ?? []).filter(
    (f) => f.file_type === 'video/mp4' && typeof f.link === 'string' && f.width > 0,
  );
  if (mp4.length === 0) {
    return null;
  }
  const wideEnough = mp4.filter((f) => f.width >= 1920);
  const pool = wideEnough.length > 0 ? wideEnough : mp4;
  return pool.reduce((best, f) => (f.width < best.width ? f : best));
}

async function download(url, to) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed: ${String(response.status)} ${url}`);
  }
  await writeFile(to, Buffer.from(await response.arrayBuffer()));
}

/* -- Filling a group ------------------------------------------------------------------------- */

/**
 * The filename a kept clip gets, and why it carries the Pexels id.
 *
 * Library keys are the ingest's own path names and are served `immutable` for a year, so a key's
 * bytes must never change once published (see `upload.mjs`). Naming a clip `dark-1` breaks that the
 * first time this script is re-run: new footage, same key, caches and CDN edges still holding the
 * old object. Naming it `dark-<pexels id>` means replacing footage always produces NEW keys, so the
 * upload never needs `--force` and the immutable promise stays true. Luminance is still measured,
 * never inferred from the name — the prefix only records what the measurement decided.
 *
 * `brand` is exempt: it is staged into `apps/marketing/public/` and fingerprinted by Astro, never
 * uploaded to R2 under a library key, so a stable name costs nothing and keeps `manifest.brand[0]`
 * unambiguous.
 */
function nameFor(group, luminance, video) {
  return group === BRAND ? 'header' : `${luminance}-${String(video.id)}`;
}

/**
 * How many REAL clips of each luminance a group already holds, counted off the filename prefix.
 *
 * The prefix is trustworthy here precisely because nothing ever guesses it: a file is only named
 * `dark-*` after `luminanceOf()` measured it dark. `header` counts as light — the brand clip is
 * fetched from a light-leaning query and the sales page's dark ink depends on it.
 *
 * A stand-in written by `ingest.mjs --synthesize` does NOT count. It carries `placeholder: true` in
 * its sidecar, and treating it as a filled slot is the trap this function exists to avoid: a
 * developer who exercised the pipeline on abstract gradients would run this, be told every group
 * was already filled, and never see a frame of real footage. CI never hits it — `sources/` is
 * git-ignored, so a fresh checkout starts empty — which is exactly why it would have survived.
 */
function have(dir) {
  if (!existsSync(dir)) {
    return {};
  }
  const counts = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.mp4'))) {
    if (isPlaceholder(dir, file)) continue;
    const luminance = file.startsWith('dark-') ? 'dark' : 'light';
    counts[luminance] = (counts[luminance] ?? 0) + 1;
  }
  return counts;
}

/** Whether a source file is a stand-in written by `ingest.mjs --synthesize`. */
function isPlaceholder(dir, file) {
  const base = file.replace(/\.[^.]+$/u, '');
  const sidecar = path.join(dir, `${base}.json`);
  if (!existsSync(sidecar)) {
    return false;
  }
  try {
    return JSON.parse(readFileSync(sidecar, 'utf8')).placeholder === true;
  } catch {
    // An unreadable sidecar is not a reason to delete the clip beside it.
    return false;
  }
}

function sidecarFor(video, group) {
  const author = typeof video.user?.name === 'string' ? video.user.name : null;
  return {
    // Pexels videos carry no alt text, so the description is composed rather than copied. It is
    // read by `ingest.mjs` into the manifest and ends up as the hero's accessible name.
    description:
      author === null ? `${group} achtergrondbeeld` : `${group} achtergrondbeeld — ${author}`,
    credit: author === null ? 'Pexels' : `${author} / Pexels`,
    source: 'pexels',
    sourceId: video.id,
    sourceUrl: typeof video.url === 'string' ? video.url : null,
  };
}

/**
 * Downloads until every slot is filled, measuring each candidate before it is kept.
 *
 * `want` maps a luminance to how many clips of it this group still owes. A candidate that measures
 * into a full luminance is discarded rather than filed anyway: a light clip in a dark slot is
 * exactly the failure this whole detour exists to prevent.
 */
async function fill(group, queries, want) {
  const dir = path.join(SOURCES, group);
  const held = FORCE ? {} : have(dir);
  const remaining = Object.fromEntries(
    Object.entries(want).map(([lum, n]) => [lum, Math.max(0, n - (held[lum] ?? 0))]),
  );
  if (Object.values(remaining).every((n) => n === 0)) {
    console.log(`  ${group.padEnd(14)} already filled (pass --force to refetch)`);
    return 0;
  }
  mkdirSync(dir, { recursive: true });

  // We are about to fill this group, so anything being REPLACED goes now rather than surviving
  // alongside its replacement. `ingest.mjs` globs the whole directory: a stand-in left in place
  // would be transcoded, measured and shipped next to the real clip that was fetched to replace it.
  // `--force` clears the lot; otherwise only the stand-ins go, so a partial top-up never destroys
  // footage it is not replacing.
  for (const file of readdirSync(dir)) {
    const full = path.join(dir, file);
    if (FORCE || isPlaceholder(dir, file)) {
      rmSync(full, { force: true });
    }
  }

  const perQuery = [];
  for (const query of queries) {
    const usable = [];
    for (const video of await search(query, 15)) {
      const duration = Number(video.duration ?? 0);
      if (duration < MIN_SECONDS || duration > MAX_SECONDS) continue;
      const file = bestFile(video);
      if (file !== null) usable.push({ video, file });
    }
    perQuery.push(usable);
  }

  // Round-robin across the queries rather than draining the first. The download budget is what
  // makes this matter: a group whose dark query happens to return fifteen usable clips would spend
  // all twelve downloads there, never reach the light query, and report an unfillable light slot
  // that was only ever unfilled because it was never asked.
  const byId = new Map();
  for (let i = 0; i < Math.max(...perQuery.map((q) => q.length), 0); i += 1) {
    for (const usable of perQuery) {
      const candidate = usable[i];
      if (candidate !== undefined && !byId.has(candidate.video.id)) {
        byId.set(candidate.video.id, candidate);
      }
    }
  }

  // The half-inspected candidate lives at the SOURCES root, never inside a group directory.
  // `ingest.mjs` globs `<group>/*.mp4`, so a leftover scratch file one level down would be ingested
  // as a clip named `.candidate` — a broken manifest row produced by a temp file.
  const scratch = path.join(SOURCES, '.candidate.mp4');
  let downloads = 0;
  let kept = 0;
  for (const { video, file } of byId.values()) {
    if (Object.values(remaining).every((n) => n === 0)) break;
    if (downloads >= MAX_DOWNLOADS_PER_GROUP) break;
    downloads += 1;

    await download(file.link, scratch);
    const luminance = luminanceOf(scratch);
    if (luminance === null || (remaining[luminance] ?? 0) === 0) {
      continue;
    }
    remaining[luminance] -= 1;

    const name = nameFor(group, luminance, video);
    const target = path.join(dir, `${name}.mp4`);
    renameSync(scratch, target);
    writeFileSync(
      path.join(dir, `${name}.json`),
      JSON.stringify(sidecarFor(video, group), null, 2) + '\n',
    );
    kept += 1;
    console.log(
      `  ${group.padEnd(14)} ${name.padEnd(16)} ${luminance.padEnd(5)} ` +
        `${String(file.width)}x${String(file.height)} ` +
        `${String(Math.round(statSync(target).size / 1024 / 1024))} MB`,
    );
  }

  rmSync(scratch, { force: true });

  const unfilled = Object.entries(remaining).filter(([, n]) => n > 0);
  if (unfilled.length > 0) {
    const gaps = unfilled.map(([lum, n]) => `${lum} x${String(n)}`).join(', ');
    console.log(
      `  ${group.padEnd(14)} UNFILLED: ${gaps} after ${String(downloads)} downloads — ` +
        `widen or retune QUERIES.${group} in this script`,
    );
    process.exitCode = 1;
  }
  return kept;
}

/* -- Main ------------------------------------------------------------------------------------ */

async function main() {
  if (!existsSync(FFMPEG)) {
    console.error(
      `no ffmpeg at ${path.relative(ROOT, FFMPEG)} — run \`pnpm install\` first ` +
        '(it comes from scripts/preview/node_modules/ffmpeg-static).',
    );
    process.exit(1);
  }
  mkdirSync(SOURCES, { recursive: true });

  let kept = 0;
  console.log('fetching from Pexels:');
  for (const [group, queries] of Object.entries(QUERIES)) {
    if (ONLY !== null && !ONLY.has(group)) continue;
    kept += await fill(group, queries, { dark: PER_LUMINANCE, light: PER_LUMINANCE });
  }
  if (ONLY === null || ONLY.has(BRAND)) {
    kept += await fill(BRAND, [BRAND_QUERY], { light: 1 });
  }

  console.log(
    `\n${String(kept)} clip(s) written to ${path.relative(ROOT, SOURCES)}` +
      (quotaRemaining === null ? '' : ` — ${String(quotaRemaining)} API requests left this hour`),
  );
  console.log('next: pnpm media:ingest && pnpm media:catalogue && pnpm media:marketing');
}

await main();
