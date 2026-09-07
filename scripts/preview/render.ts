import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertIndustry, formatHoursForLocale, toOpeningHoursSpecification } from '@aibuilder/core';
import type { Locale, SectionType } from '@aibuilder/site-schema';
import { hasBlockingFindings, lintSiteDoc } from '@aibuilder/site-schema';
import { renderPage } from '@aibuilder/site-kit';
import type { HeroMedia, RenderContext, RenderOptions, ResolvedImage } from '@aibuilder/site-kit';
import type { DemoSite } from './demo-sites';
import { DEMO_SITES } from './demo-sites';
import {
  ASSET_BASE,
  OUTPUT_DIR,
  iconUrl,
  imageUrl,
  libraryUrl,
  selectDemoHero,
  writeAssets,
} from './media';

/**
 * Renders every demo site to `.preview/`.
 *
 * This is a composition root, and it is deliberately shaped like the one that already exists in
 * `apps/app/app/lib/preview-render.server.ts`: build a `RenderContext` out of server facts, call
 * `renderPage`, write the bytes. Nothing here is a bespoke renderer — the HTML in `.preview/` is
 * the same HTML the publish pipeline emits for the same document, minus the three things a
 * developer preview genuinely cannot have (a real media pipeline, a real hero video, and the edge
 * cache in front of it).
 *
 * Two checks run before a single byte is written, because a preview that quietly renders an
 * invalid document is worse than no preview:
 *
 *  1. `assertIndustry()` looks the industry key up in the real taxonomy and this file asserts that
 *     the row's `dnaId` is the archetype the demo claims. A demo that says "this is what a garage
 *     looks like" while carrying a restaurant's design DNA would be a lie told with a screenshot.
 *  2. `lintSiteDoc()` runs over each document. It is the same semantic pass the publish pipeline
 *     uses — contrast, dangling refs, section placement, required copy, legal constraints — and its
 *     `missing_copy` check is derived from the same slot inventory the renderer reads, so a
 *     mistyped slot id in `demo-sites.ts` fails here instead of rendering an empty heading.
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

/**
 * Fixed timestamps.
 *
 * `renderPage` is pure with respect to `(doc, locale, pageId, ctx)` and its `renderSha256` feeds
 * `lastmod`, so the harness must not inject `Date.now()`: two runs an hour apart would produce two
 * different sets of bytes and every screenshot diff would be noise.
 */
const PUBLISHED_AT = '2026-02-02T09:00:00+01:00';
const CONTENT_CHANGED_AT = '2026-03-09T14:20:00+01:00';

/** The footer's attribution, as plain text. Never a link — architecture §7.28. */
const MADE_WITH = 'Gemaakt met aibuilder';

/**
 * `contain-intrinsic-size` estimates per section type.
 *
 * At publish these are fitted per section (§9.4); here they are one plausible number per type. The
 * value only has to be in the right neighbourhood: `contain-intrinsic-size: auto <n>` means the
 * browser uses the remembered size once a section has been laid out even once, so a wrong estimate
 * costs scrollbar accuracy before first paint and nothing after it.
 */
const SECTION_HEIGHTS: Readonly<Record<SectionType, number>> = {
  hero: 760,
  usp_trio: 420,
  about: 560,
  services_grid: 640,
  menu: 720,
  gallery: 700,
  reviews: 460,
  team: 640,
  process_steps: 440,
  stats_band: 260,
  faq: 520,
  booking: 400,
  contact_form: 720,
  map_hours: 560,
  cta_band: 340,
  blog_teaser: 460,
  rich_text: 520,
};

/** One rendered page, as the manifest records it. */
export interface RenderedPage {
  readonly siteKey: string;
  readonly pageId: string;
  readonly locale: Locale;
  /** The path the published page would live at, e.g. `/nl/agenda/`. */
  readonly urlPath: string;
  /** Where the bytes went, relative to the repository root. */
  readonly file: string;
  readonly title: string;
  readonly bytes: number;
  readonly cssBytes: number;
  readonly sections: readonly SectionType[];
}

/** What `renderAll` produced. `serve.ts` and `shoot.ts` both read this back off disk. */
export interface PreviewManifest {
  readonly outputDir: string;
  readonly sites: readonly {
    readonly key: string;
    readonly label: string;
    readonly archetype: string;
    readonly blurb: string;
    readonly origin: string;
    readonly pages: readonly RenderedPage[];
  }[];
}

/** Resolves the whole media manifest of one site to renderable images. */
function imagesOf(site: DemoSite): Record<string, ResolvedImage> {
  const images: Record<string, ResolvedImage> = {};
  for (const asset of site.media) {
    const source = site.doc.media[asset.refId];
    const url = imageUrl(site, asset.refId);
    images[asset.refId] = {
      src: url,
      // One `<source>` so the `<picture>` markup is exercised. A production ladder has an AVIF and
      // a WebP row with several widths each; an SVG has one rendition by definition.
      sources: [{ type: 'image/svg+xml', srcset: `${url} ${String(asset.width)}w` }],
      width: asset.width,
      height: asset.height,
      alt: source?.altText ?? '',
      focal: '50% 50%',
      dominantColor: source?.dominantColor ?? null,
    };
  }
  return images;
}

/** The hero's art-directed set: a landscape poster, a portrait crop, and the library clip. */
/** A srcset over a library still ladder, in the harness's `/_lib` address space. */
function librarySrcset(template: string, widths: readonly number[]): string {
  return widths
    .map((width) => `${libraryUrl(template.replace('{width}', String(width)))} ${String(width)}w`)
    .join(', ');
}

function heroOf(site: DemoSite, images: Readonly<Record<string, ResolvedImage>>): HeroMedia | null {
  const poster = images[site.heroRefId];
  if (poster === undefined) return null;
  const clip = selectDemoHero(site);
  return {
    poster,
    /*
      The library's own 9:16 crop, exactly as `apps/generator/src/steps/render.ts` builds it —
      not the harness's separately generated portrait art. Serving a different portrait source
      here than production serves would make the one thing this preview exists to check (that a
      phone gets a poster large enough to keep the LCP entry away from the video) unverifiable.
    */
    portraitSources:
      clip === null
        ? []
        : [
            {
              type: 'image/avif',
              srcset: librarySrcset(
                clip.posterPortrait.avifKeyTemplate,
                clip.posterPortrait.widths,
              ),
            },
            {
              type: 'image/webp',
              srcset: librarySrcset(
                clip.posterPortrait.webpKeyTemplate,
                clip.posterPortrait.widths,
              ),
            },
          ],
    /*
      The clip the REAL selector chose out of the shipped library, not one the harness assigned.
      Two encodes, because a phone must never be handed the 1920x1080 file: the portrait rendition
      is roughly a quarter of the bytes AND fills a phone viewport instead of being letterboxed
      into it. The poster remains the LCP element, and the video still mounts only after
      `js/site.ts` has seen LCP attributed.

      `null` when the library is empty or cannot dress this combination — the header is then a
      full-screen poster, which is exactly what production does.
    */
    video:
      clip === null
        ? null
        : {
            desktopAv1: libraryUrl(clip.landscape.av1Key),
            desktopH264: libraryUrl(clip.landscape.h264Key),
            mobileAv1: libraryUrl(clip.portrait.av1Key),
            mobileH264: libraryUrl(clip.portrait.h264Key),
            width: clip.landscape.width,
            height: clip.landscape.height,
          },
  };
}

/** The `RenderContext` for one site in one locale. Every field is a server fact. */
function contextOf(site: DemoSite, locale: Locale): RenderContext {
  const industry = assertIndustry(site.doc.facts.industryKey);
  if (industry.dnaId !== site.archetype) {
    throw new Error(
      `demo "${site.key}" claims archetype ${site.archetype} but industry "${industry.key}" maps to ${industry.dnaId}`,
    );
  }
  const images = imagesOf(site);
  const map = site.mapRefId === null ? null : (images[site.mapRefId] ?? null);
  const sectionHeights: Record<string, number> = {};
  for (const page of site.doc.pages) {
    for (const section of page.sections) {
      sectionHeights[section.id] = SECTION_HEIGHTS[section.type];
    }
  }

  return {
    origin: site.origin,
    assetBase: ASSET_BASE,
    indexState: 'index',
    publishedAt: PUBLISHED_AT,
    contentChangedAt: CONTENT_CHANGED_AT,
    industry: {
      key: industry.key,
      schemaOrgType: industry.schemaOrgType,
      additionalType: industry.additionalType,
    },
    hoursJsonLd: toOpeningHoursSpecification(site.doc.facts.openingHours),
    hoursDisplay: formatHoursForLocale(site.doc.facts.openingHours, locale),
    reviews: site.reviews,
    images,
    hero: heroOf(site, images),
    // Resolved exactly as the generator resolves it, so a demo shows the bands a real site gets.
    sectionGrounds: Object.fromEntries(
      Object.entries(site.doc.sectionBackgrounds).flatMap(([sectionId, refId]) => {
        const image = images[refId];
        return image === undefined ? [] : [[sectionId, image] as const];
      }),
    ),
    map,
    sectionHeights,
    icons: {
      png32: iconUrl(site, 'icon-32.png'),
      svg: iconUrl(site, 'icon.svg'),
      appleTouch: iconUrl(site, 'icon-180.png'),
      og: { url: `${site.origin}${imageUrl(site, site.ogRefId)}`, width: 1200, height: 630 },
    },
    usesNonEssential: false,
  };
}

const OPTIONS: RenderOptions = {
  // Empty: the font-subsetting build step that produces digests is not in this loop, and `site-kit`
  // falls back to the unhashed filename — which is exactly the name `media.ts` writes.
  fontHashes: { byAsset: {} },
  madeWith: MADE_WITH,
};

/** `/nl/agenda/` becomes `<out>/<site>/nl/agenda/index.html`. */
function fileFor(site: DemoSite, urlPath: string): string {
  const segments = urlPath.split('/').filter((segment) => segment !== '');
  return path.join(OUTPUT_DIR, site.key, ...segments, 'index.html');
}

/** Renders one site and returns its manifest rows. */
async function renderSite(site: DemoSite): Promise<readonly RenderedPage[]> {
  const findings = lintSiteDoc(site.doc);
  for (const finding of findings) {
    console.log(
      `  lint ${finding.severity}: ${finding.code} at ${finding.path} — ${finding.message}`,
    );
  }
  if (hasBlockingFindings(findings)) {
    throw new Error(`demo "${site.key}" has blocking lint findings; fix demo-sites.ts`);
  }

  const rows: RenderedPage[] = [];
  for (const locale of site.doc.locales.enabled) {
    const ctx = contextOf(site, locale);
    for (const page of site.doc.pages) {
      const routing = page.perLocale[locale];
      if (routing === undefined) continue;
      const result = await renderPage(site.doc, locale, page.pageId, ctx, OPTIONS);
      for (const note of result.notes) {
        console.log(`  qa note: ${note.code} ${JSON.stringify(note.detail)}`);
      }
      const file = fileFor(site, routing.path);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, result.html, 'utf8');
      rows.push({
        siteKey: site.key,
        pageId: page.pageId,
        locale,
        urlPath: routing.path,
        file: path.relative(ROOT, file),
        title: routing.title,
        bytes: Buffer.byteLength(result.html, 'utf8'),
        cssBytes: Buffer.byteLength(result.css.css, 'utf8'),
        sections: page.sections.map((section) => section.type),
      });
    }
  }
  return rows;
}

/* ── The index page ─────────────────────────────────────────────────────── */

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

/**
 * The static index.
 *
 * Its links are RELATIVE, so the file is browsable straight off disk. The pages it links to ask
 * for their images and fonts at absolute `/_m/…` and `/_a/f/…` paths, which only a server can
 * answer — hence the banner. `serve.ts` puts a second index, with working absolute links and one
 * port per site, on its base port.
 */
function indexHtml(manifest: PreviewManifest): string {
  const sites = manifest.sites
    .map((site) => {
      const pages = site.pages
        .map(
          (page) =>
            `<li><a href="${escapeHtml(path.posix.join(site.key, page.urlPath.replace(/^\//u, ''), 'index.html'))}">${escapeHtml(page.urlPath)}</a> <span class="muted">${escapeHtml(page.title)}</span> <span class="tag">${String(page.sections.length)} secties · ${String(Math.round(page.bytes / 1024))} kB</span></li>`,
        )
        .join('');
      const types = [...new Set(site.pages.flatMap((page) => page.sections))].sort();
      return `<section class="card">
  <h2>${escapeHtml(site.label)}</h2>
  <p class="dna">${escapeHtml(site.archetype)}</p>
  <p>${escapeHtml(site.blurb)}</p>
  <ul>${pages}</ul>
  <p class="muted">Secties: ${escapeHtml(types.join(', '))}</p>
</section>`;
    })
    .join('');

  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>aibuilder — designpreview</title>
<style>
  :root { color-scheme: light dark; --fg:#16181d; --muted:#5c6270; --bg:#f6f7f9; --card:#fff; --line:#e2e5ea; }
  @media (prefers-color-scheme: dark) { :root { --fg:#eef0f4; --muted:#a2a9b8; --bg:#14161a; --card:#1c1f25; --line:#2c313a; } }
  body { margin:0; padding:2.5rem 1.25rem 4rem; background:var(--bg); color:var(--fg);
         font:16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width:64rem; margin:0 auto; }
  h1 { font-size:1.9rem; margin:0 0 .25rem; letter-spacing:-.02em; }
  .lede { color:var(--muted); max-width:44rem; }
  .note { border:1px solid var(--line); border-left:4px solid #d08a2a; background:var(--card);
          padding:.9rem 1.1rem; border-radius:.5rem; margin:1.5rem 0; }
  .grid { display:grid; gap:1.25rem; grid-template-columns:repeat(auto-fit,minmax(min(100%,20rem),1fr)); margin-top:1.5rem; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:.75rem; padding:1.25rem 1.4rem; }
  .card h2 { font-size:1.15rem; margin:0 0 .15rem; }
  .dna { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:.8rem; color:var(--muted); margin:0 0 .75rem; }
  ul { padding-left:1.1rem; margin:.75rem 0; }
  li { margin:.3rem 0; }
  a { color:inherit; }
  .muted { color:var(--muted); font-size:.85rem; }
  .tag { color:var(--muted); font-size:.75rem; }
  footer { margin-top:2.5rem; color:var(--muted); font-size:.85rem; max-width:44rem; }
</style>
</head>
<body>
<main>
  <h1>Designpreview — vier demo-sites</h1>
  <p class="lede">Eén demo-site per design-DNA, gerenderd met <code>renderPage()</code> uit
     <code>@aibuilder/site-kit</code>. Alle bedrijven, adressen, telefoonnummers en reviews zijn
     verzonnen; alle beelden zijn gegenereerde placeholders en als zodanig gelabeld.</p>
  <div class="note"><strong>Open dit via de preview-server.</strong> De pagina's vragen hun
     afbeeldingen en fonts op absolute paden (<code>/_m/…</code>, <code>/_a/f/…</code>). Direct
     vanaf schijf openen laat de opmaak zien, maar zonder beeld en zonder de echte letters.
     Start de server met <code>node scripts/preview/run.mjs serve</code>.</div>
  <div class="grid">${sites}</div>
  <footer>
    <p><strong>Wat dit bewijst:</strong> layout, kleur, typografie en de HTML van de
    componentbibliotheek. <strong>Wat dit niet bewijst:</strong> Lighthouse-scores, want de echte
    mediapijplijn (AVIF/WebP-ladders, hero-video) en de edge-cache zitten niet in deze lus.</p>
  </footer>
</main>
</body>
</html>
`;
}

/* ── Entry point ────────────────────────────────────────────────────────── */

/** Renders everything and returns the manifest. Also the function `shoot.ts` calls. */
export async function renderAll(): Promise<PreviewManifest> {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const assets = writeAssets(DEMO_SITES);
  const missingFonts = assets.fonts.filter((entry) => entry.source === null);
  console.log(
    `media: ${String(assets.files)} files (${String(Math.round(assets.bytes / 1024))} kB of generated SVG/PNG)`,
  );
  if (missingFonts.length > 0) {
    console.log(
      `media: NOT installed: ${missingFonts.map((entry) => `${entry.asset}-${entry.subset}`).join(', ')} — ` +
        'those families fall back to the metric-matched local stack. `npm install` in scripts/preview installs them.',
    );
  }

  const sites = [];
  for (const site of DEMO_SITES) {
    console.log(`\n${site.label} (${site.archetype})`);
    const pages = await renderSite(site);
    for (const page of pages) {
      console.log(
        `  ${page.urlPath.padEnd(16)} ${String(Math.round(page.bytes / 1024)).padStart(3)} kB html · ${String(Math.round(page.cssBytes / 1024)).padStart(2)} kB css · ${String(page.sections.length)} sections`,
      );
    }
    sites.push({
      key: site.key,
      label: site.label,
      archetype: site.archetype,
      blurb: site.blurb,
      origin: site.origin,
      pages,
    });
  }

  const manifest: PreviewManifest = { outputDir: OUTPUT_DIR, sites };
  writeFileSync(path.join(OUTPUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(OUTPUT_DIR, 'index.html'), indexHtml(manifest), 'utf8');
  return manifest;
}

/** `node run.mjs render`. */
export async function main(): Promise<void> {
  const manifest = await renderAll();
  const pages = manifest.sites.reduce((total, site) => total + site.pages.length, 0);
  const types = new Set(
    manifest.sites.flatMap((site) => site.pages.flatMap((page) => page.sections)),
  );
  console.log(
    `\nrendered ${String(pages)} pages across ${String(manifest.sites.length)} sites, ` +
      `${String(types.size)}/17 section types, into ${path.relative(ROOT, OUTPUT_DIR)}/`,
  );
  console.log('next: node scripts/preview/run.mjs serve   (or `shoot` for screenshots)');
}
