/**
 * Uploads the media library's binaries to R2.
 *
 * The catalogue that ships in the Worker bundle is only an index: it names keys under
 * `library/`, and a tenant site builds `/_a/l/<key>` URLs out of them. This script is what puts
 * the bytes behind those names. Run it after every ingest, before the first publish that will
 * reference new footage.
 *
 *   node scripts/media-library/upload.mjs --dry-run     # list what would be written
 *   node scripts/media-library/upload.mjs               # write what is missing
 *   node scripts/media-library/upload.mjs --force       # overwrite, and mean it
 *
 * WHY IT REFUSES TO OVERWRITE BY DEFAULT
 * Library keys are not content-addressed — they are the ingest's own path names — yet they are
 * served with a one-year `immutable` cache directive, the same as every other asset. That promise
 * is only honest if a key's bytes never change once published. So a key that already exists is
 * skipped, and changing what a key holds takes `--force` and a deliberate decision about the caches
 * and the CDN edges still holding the old object. Adding footage is free: new footage gets new
 * names, and new names have no cached past.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.join(ROOT, '.media-library', 'out');
const MANIFEST = path.join(ROOT, '.media-library', 'media-library.json');
const CONFIG = path.join(ROOT, 'apps/renderer/wrangler.jsonc');

/** Must equal `LIBRARY_PREFIX` in `packages/core/src/routing.ts`; `check` asserts it. */
const LIBRARY_PREFIX = 'library/';
const BUCKET = 'aibuilder-media';
const JURISDICTION = 'eu';

/** Parallel `wrangler` invocations. Each is its own process, so this is a memory bound as much as a rate one. */
const CONCURRENCY = 6;

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const FORCE = args.has('--force');

if (!existsSync(MANIFEST)) {
  console.error(`no manifest at ${path.relative(ROOT, MANIFEST)} — run ingest.mjs first`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));

/** Every key the catalogue can address, in upload order: clips first, then their stills. */
function keysOf(clips) {
  const keys = [];
  for (const clip of clips) {
    for (const rendition of [clip.landscape, clip.portrait]) {
      keys.push(rendition.av1Key, rendition.h264Key);
    }
    for (const ladder of [clip.poster, clip.posterPortrait]) {
      for (const width of ladder.widths) {
        keys.push(ladder.avifKeyTemplate.replace('{width}', String(width)));
        keys.push(ladder.webpKeyTemplate.replace('{width}', String(width)));
      }
    }
  }
  return keys;
}

// `brand` is the marketing site's own clip: it is staged into `apps/marketing/public/` by
// `stage-marketing.mjs` and served by Astro, so it has no business in the tenant bucket.
const keys = [...new Set(keysOf(manifest.videos ?? []))].sort();

async function wrangler(argv) {
  return run(
    'pnpm',
    ['exec', 'wrangler', ...argv, '--config', CONFIG, '--remote', '--jurisdiction', JURISDICTION],
    { cwd: ROOT, maxBuffer: 8 * 1024 * 1024 },
  );
}

async function exists(key) {
  try {
    await wrangler(['r2', 'object', 'get', `${BUCKET}/${LIBRARY_PREFIX}${key}`, '--pipe']);
    return true;
  } catch {
    return false;
  }
}

async function upload(key) {
  const file = path.join(OUT, key);
  if (!existsSync(file)) {
    return { key, state: 'missing' };
  }
  if (!FORCE && (await exists(key))) {
    return { key, state: 'skipped' };
  }
  if (DRY_RUN) {
    return { key, state: 'would-write', bytes: statSync(file).size };
  }
  await wrangler(['r2', 'object', 'put', `${BUCKET}/${LIBRARY_PREFIX}${key}`, '--file', file]);
  return { key, state: 'written', bytes: statSync(file).size };
}

/** A fixed-size worker pool: `CONCURRENCY` tasks in flight, never a burst of a thousand. */
async function pool(items, worker) {
  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index]);
      }
    }),
  );
  return results;
}

const results = await pool(keys, upload);

const tally = { written: 0, skipped: 0, missing: 0, 'would-write': 0 };
let bytes = 0;
for (const result of results) {
  tally[result.state] += 1;
  bytes += result.bytes ?? 0;
}

for (const result of results) {
  if (result.state === 'missing') {
    console.error(`missing locally: ${result.key}`);
  }
}

console.log(
  `${keys.length} keys under ${LIBRARY_PREFIX}: ` +
    `${tally.written} written, ${tally['would-write']} would write, ` +
    `${tally.skipped} already there, ${tally.missing} missing ` +
    `(${Math.round(bytes / 1024 / 1024)} MB)`,
);

if (tally.missing > 0) {
  console.error('re-run ingest.mjs: the catalogue names objects this checkout cannot produce');
  process.exitCode = 1;
}
