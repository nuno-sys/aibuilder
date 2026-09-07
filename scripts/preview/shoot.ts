import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';
import { OUTPUT_DIR } from './media';
import { renderAll } from './render';
import { startServers } from './serve';

/**
 * Full-page screenshots of every rendered page, at two viewports.
 *
 * THE CONTENT-VISIBILITY TRAP. `LAYOUT_CSS` gives every `.section` (except the first)
 * `content-visibility: auto` with a `contain-intrinsic-size` placeholder. That is a real
 * performance win and a real screenshot hazard: an element that has never been near the viewport
 * is not rendered, and Chromium's `captureBeyondViewport` path can hand back a page whose
 * off-screen sections are blank boxes of background colour. A naive `page.screenshot({ fullPage:
 * true })` therefore produces a picture that looks like the product is broken — or, worse, one
 * that looks fine while hiding the bottom two thirds of the page.
 *
 * TWO THINGS ARE NEEDED, AND ONLY ONE OF THEM IS THE OBVIOUS ONE.
 *
 *  1. Every page is scrolled to the bottom in viewport-sized steps, two animation frames per step,
 *     then back to the top. This is what makes the `loading="lazy"` images below the fold actually
 *     fetch, and it warms the layout of every section.
 *  2. That is NOT enough on its own, and this harness has the evidence: with the scroll pass alone,
 *     the reviews, blog-teaser and CTA sections of the nightclub home page still came back as
 *     empty coloured bands. `content-visibility: auto` re-skips content the moment it is far from
 *     the viewport again, and Chromium's full-page capture does not force it back. The section's
 *     own background paints, its children do not — which is precisely the failure that looks like
 *     a finished screenshot of a broken product. So immediately before the capture the harness
 *     injects one declaration, `content-visibility: visible`, over `.section`.
 *
 * That injection is a deliberate, disclosed deviation from the published bytes, and it is the
 * smallest one available: the property's only effect is *whether* off-screen content is rendered,
 * so a section that renders looks identical either way. The alternative — stitching viewport-sized
 * tiles — would need the sticky header and the fixed WhatsApp widget overridden as well, which is
 * a larger change to the page, not a smaller one.
 *
 * AND THEN IT IS CHECKED. Believing the fix is not the same as verifying it, so each PNG is
 * decoded here and measured: the share of the single most common colour, and the number of
 * horizontal bands that are one flat colour. A page whose sections went missing shows up as a very
 * high dominant share and a run of flat bands. The numbers are printed for every shot and written
 * to `shots/report.json`, so the claim in the report is checkable rather than asserted.
 */

/**
 * Where this harness and the repository live.
 *
 * `run.mjs` bundles each entry point into `scripts/preview/dist/`, so `import.meta.url` in the
 * *bundle* points one directory deeper than the source. The runner therefore exports both paths;
 * the fallback keeps the modules correct when they are executed from source instead.
 */
const HERE = process.env['PREVIEW_HARNESS_DIR'] ?? path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env['PREVIEW_REPO_ROOT'] ?? path.resolve(HERE, '..', '..');
const SHOTS_DIR = path.join(OUTPUT_DIR, 'shots');

/**
 * The Chromium that is already on this machine.
 *
 * `playwright install` is not run: the harness installs the `playwright` package with
 * `--no-save`-style local install only, and the browser binary is provided by the environment.
 */
const CHROMIUM =
  process.env['PREVIEW_CHROMIUM'] ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/** The two viewports, exactly as briefed. */
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 1100, scale: 2 },
  { name: 'mobile', width: 390, height: 844, scale: 3 },
] as const;

/* ── PNG measurement ────────────────────────────────────────────────────── */

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly pixels: Buffer;
}

/** Channels per pixel for the PNG colour types this decoder accepts. */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decodes an 8-bit, non-interlaced PNG.
 *
 * Not a general decoder: it handles exactly what Chromium writes, and throws on anything else
 * rather than silently mis-measuring. The five filter types are the whole of the format's
 * compression story above deflate, so they all have to be here.
 */
function decodePng(bytes: Buffer): DecodedPng {
  if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const colourType = data[9];
      const interlace = data[12];
      if (depth !== 8 || interlace !== 0) throw new Error(`unsupported PNG (${String(depth)}-bit)`);
      channels = CHANNELS[colourType ?? -1] ?? 0;
      if (channels === 0) throw new Error(`unsupported colour type ${String(colourType)}`);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const value = row[x] ?? 0;
      const left = x >= channels ? (out[x - channels] ?? 0) : 0;
      const up = previous[x] ?? 0;
      const upLeft = x >= channels ? (previous[x - channels] ?? 0) : 0;
      let restored = value;
      if (filter === 1) restored = value + left;
      else if (filter === 2) restored = value + up;
      else if (filter === 3) restored = value + ((left + up) >> 1);
      else if (filter === 4) restored = value + paeth(left, up, upLeft);
      out[x] = restored & 0xff;
    }
    previous = out;
  }
  return { width, height, channels, pixels };
}

/** What one screenshot turned out to be. */
export interface ShotReport {
  readonly file: string;
  readonly siteKey: string;
  readonly urlPath: string;
  readonly viewport: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  /** Share of the single most common quantised colour, 0–1. Near 1 means a blank page. */
  readonly dominantShare: number;
  /** Distinct quantised colours in the sample. A blank page has a handful. */
  readonly distinctColours: number;
  /** Of 24 horizontal bands, how many are ≥99.5 % one colour. A blanked section shows up here. */
  readonly flatBands: number;
  readonly bandCount: number;
  readonly images: number;
  /** `<img>` elements that loaded nothing. Must be empty; anything here is a defect. */
  readonly brokenImages: readonly string[];
}

/**
 * Measures a screenshot for blankness.
 *
 * Colours are quantised to 4 bits per channel before counting, because anti-aliasing and gradients
 * would otherwise make every pixel "distinct" and the measure meaningless. Every fourth pixel in
 * each direction is sampled; at these sizes that is still tens of thousands of samples per band.
 */
function measure(
  png: DecodedPng,
  bandCount: number,
): {
  dominantShare: number;
  distinctColours: number;
  flatBands: number;
} {
  const { width, height, channels, pixels } = png;
  const overall = new Map<number, number>();
  let flatBands = 0;
  let total = 0;
  const bandHeight = Math.max(1, Math.ceil(height / bandCount));

  for (let band = 0; band < bandCount; band += 1) {
    const start = band * bandHeight;
    const end = Math.min(height, start + bandHeight);
    if (start >= end) continue;
    const local = new Map<number, number>();
    let localTotal = 0;
    for (let y = start; y < end; y += 4) {
      const rowOffset = y * width * channels;
      for (let x = 0; x < width; x += 4) {
        const offset = rowOffset + x * channels;
        const r = pixels[offset] ?? 0;
        const g = channels >= 3 ? (pixels[offset + 1] ?? 0) : r;
        const b = channels >= 3 ? (pixels[offset + 2] ?? 0) : r;
        const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
        local.set(key, (local.get(key) ?? 0) + 1);
        overall.set(key, (overall.get(key) ?? 0) + 1);
        localTotal += 1;
        total += 1;
      }
    }
    if (localTotal === 0) continue;
    const localMax = Math.max(...local.values());
    if (localMax / localTotal >= 0.995) flatBands += 1;
  }

  const dominant = overall.size === 0 ? 0 : Math.max(...overall.values());
  return {
    dominantShare: total === 0 ? 1 : dominant / total,
    distinctColours: overall.size,
    flatBands,
  };
}

/* ── Capture ────────────────────────────────────────────────────────────── */

/**
 * Walks the page so that every deferred section paints at least once.
 *
 * `scrollHeight` is re-read on every step: sections that render for the first time change the
 * document height, so a height sampled once would stop short of the footer.
 */
async function scrollThrough(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const frame = async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      });
    };
    const step = Math.max(200, Math.round(window.innerHeight * 0.8));
    let y = 0;
    let guard = 0;
    while (y < document.documentElement.scrollHeight && guard < 400) {
      window.scrollTo(0, y);
      await frame();
      y += step;
      guard += 1;
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
    await frame();
    await new Promise((resolve) => setTimeout(resolve, 120));
    window.scrollTo(0, 0);
    await frame();
    await new Promise((resolve) => setTimeout(resolve, 120));
  });
}

/**
 * Every `<img>` on the page, and the ones that failed.
 *
 * This check exists because it caught a real defect the first time it ran: the generated SVGs
 * carried a quoted font family (`"Segoe UI"`) inside a double-quoted XML attribute, which makes an
 * SVG unparseable. Chromium answered 200, decoded nothing, logged no console error, and rendered
 * alt text — a failure mode that a screenshot alone would have shown as "the design has no
 * photographs yet". `naturalWidth === 0` after load is the only reliable signal for it.
 */
async function auditImages(page: Page): Promise<{ total: number; broken: readonly string[] }> {
  return page.evaluate(() => {
    const images = [...document.querySelectorAll('img')];
    const broken = images
      .filter((image) => !image.complete || image.naturalWidth === 0)
      .map((image) => image.currentSrc || image.src);
    return { total: images.length, broken: [...new Set(broken)] };
  });
}

/** `/nl/agenda/` becomes `nl-agenda`; `/nl/` becomes `nl-home`. */
function shotName(siteKey: string, urlPath: string, viewport: string): string {
  const segments = urlPath.split('/').filter((segment) => segment !== '');
  const tail = segments.length <= 1 ? [...segments, 'home'] : segments;
  return `${siteKey}__${tail.join('-')}__${viewport}.png`;
}

async function shootPage(
  browser: Browser,
  url: string,
  siteKey: string,
  urlPath: string,
): Promise<readonly ShotReport[]> {
  const reports: ShotReport[] = [];
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.scale,
      // The demo copy is Dutch and the pages are date- and hours-heavy; a mismatched UA locale
      // would be one more difference between the screenshot and what a visitor sees.
      locale: 'nl-NL',
      timezoneId: 'Europe/Amsterdam',
      isMobile: viewport.name === 'mobile',
      hasTouch: viewport.name === 'mobile',
    });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('requestfailed', (request) => {
      consoleErrors.push(`request failed: ${request.url()}`);
    });

    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await scrollThrough(page);
    const audit = await auditImages(page);
    // See the note at the top of this file. Unlayered and `!important`, so it beats
    // `@layer layout`'s `content-visibility: auto` in both cascade dimensions.
    //
    // `contain: layout style paint` is restored by hand, and it is not optional: those three are
    // implied by `content-visibility: auto` and are lost when the property is overridden. Without
    // them the marquee row on the nightclub home page escaped its clip and widened the mobile
    // capture from 1170 px to 1938 px — a layout that no visitor would ever see. The selector
    // excludes the hero and the first section because those two already carry
    // `content-visibility: visible` in production, and therefore carry no containment either.
    await page.addStyleTag({
      content:
        '.section:not(:first-of-type):not(.hero){content-visibility:visible!important;contain:layout style paint!important}',
    });
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      });
    });

    const file = path.join(SHOTS_DIR, shotName(siteKey, urlPath, viewport.name));
    await page.screenshot({ path: file, fullPage: true, animations: 'disabled', scale: 'device' });
    await context.close();

    const bytes = statSync(file).size;
    const png = decodePng(readFileSync(file));
    const measured = measure(png, 24);
    const report: ShotReport = {
      file: path.relative(ROOT, file),
      siteKey,
      urlPath,
      viewport: viewport.name,
      width: png.width,
      height: png.height,
      bytes,
      dominantShare: Math.round(measured.dominantShare * 1000) / 1000,
      distinctColours: measured.distinctColours,
      flatBands: measured.flatBands,
      bandCount: 24,
      images: audit.total,
      brokenImages: audit.broken,
    };
    reports.push(report);
    const warning =
      report.dominantShare > 0.9 || report.flatBands > 12 ? '  <-- LOOKS BLANK, CHECK IT' : '';
    console.log(
      `  ${viewport.name.padEnd(7)} ${String(report.width).padStart(4)}×${String(report.height).padEnd(6)} ` +
        `${String(Math.round(bytes / 1024)).padStart(5)} kB  dominant ${report.dominantShare.toFixed(3)}  ` +
        `colours ${String(report.distinctColours).padStart(4)}  flat bands ${String(report.flatBands)}/24${warning}`,
    );
    if (report.brokenImages.length > 0) {
      console.log(
        `    ${String(report.brokenImages.length)}/${String(report.images)} images FAILED to load: ${report.brokenImages.slice(0, 3).join(', ')}`,
      );
    }
    if (consoleErrors.length > 0) {
      const unique = [...new Set(consoleErrors)].slice(0, 4);
      for (const message of unique) console.log(`    page error: ${message}`);
    }
  }
  return reports;
}

/** `node run.mjs shoot`. Renders first when nothing has been rendered yet. */
export async function main(): Promise<void> {
  if (!existsSync(path.join(OUTPUT_DIR, 'manifest.json'))) {
    console.log('nothing rendered yet — rendering first.\n');
    await renderAll();
  }
  mkdirSync(SHOTS_DIR, { recursive: true });

  const servers = await startServers({ basePort: 0 });
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const reports: ShotReport[] = [];
  try {
    for (const entry of servers.sites) {
      console.log(`\n${entry.site.label} — ${entry.origin}`);
      for (const page of entry.site.doc.pages) {
        const routing = page.perLocale['nl'];
        if (routing === undefined) continue;
        console.log(` ${routing.path}`);
        reports.push(
          ...(await shootPage(
            browser,
            `${entry.origin}${routing.path}`,
            entry.site.key,
            routing.path,
          )),
        );
      }
    }
  } finally {
    await browser.close();
    await servers.close();
  }

  writeFileSync(
    path.join(SHOTS_DIR, 'report.json'),
    `${JSON.stringify({ shots: reports }, null, 2)}\n`,
  );

  const brokenShots = reports.filter((report) => report.brokenImages.length > 0);
  console.log(
    brokenShots.length === 0
      ? `image check: every <img> on all ${String(reports.length)} captures decoded.`
      : `image check: ${String(brokenShots.length)} capture(s) contain images that did not load.`,
  );

  const suspicious = reports.filter(
    (report) => report.dominantShare > 0.9 || report.flatBands > 12,
  );
  console.log(
    `\n${String(reports.length)} screenshots into ${path.relative(ROOT, SHOTS_DIR)}/ ` +
      `(${String(Math.round(reports.reduce((total, report) => total + report.bytes, 0) / 1024 / 1024))} MB)`,
  );
  console.log(
    suspicious.length === 0
      ? 'blankness check: every screenshot has real content in every band.'
      : `blankness check: ${String(suspicious.length)} shot(s) look mostly flat — ${suspicious
          .map((report) => report.file)
          .join(', ')}`,
  );
}
