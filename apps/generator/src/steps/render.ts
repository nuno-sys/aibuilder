import {
  BRAND_ICONS,
  analyseDocument,
  assertIndustry,
  assetPath,
  buildTenantCsp,
  checkDocumentBudgets,
  encodePageMetadata,
  formatHoursForLocale,
  hasBlockingBudgetFindings,
  materialisedPageKey,
  preloadLinkHeader,
  rootDocumentKey,
  toOpeningHoursSpecification,
} from '@aibuilder/core';
import type { ImageFormat, ImageWidth, Locale } from '@aibuilder/core';
import { IMAGE_WIDTHS } from '@aibuilder/core';
import { cp } from '@aibuilder/db';
import { renderPage } from '@aibuilder/site-kit';
import type { HeroMedia, RenderContext, RenderOptions, ResolvedImage } from '@aibuilder/site-kit';
import type { MediaAsset, PageDoc, SiteDoc } from '@aibuilder/site-schema';

import type { Env } from '../env';
import { DocumentInvalidError, GeneratorError } from '../errors';
import type { RunIds } from '../ids';

/**
 * Step 9, `render` — the `SiteDoc` becomes one HTML document per (locale, page), plus the `/` copy.
 *
 * WHAT THIS STEP IS, AND WHAT IT DELIBERATELY IS NOT. It is the composition root for
 * `@aibuilder/site-kit`. That package renders in a plain Node runner with no bindings and no `env`
 * (architecture §2), which is only possible because everything it would otherwise have to fetch —
 * the resolved media URLs, the localised opening hours, the industry row, the origin, the index
 * state — is handed to it as a `RenderContext`. Assembling that context from D1, R2 and
 * `@aibuilder/core` is this file's whole job. It is not a renderer, it holds no markup, and it must
 * never grow one: the code that turns attacker-influenced content into HTML lives in the package
 * that has no access to `ANTHROPIC_API_KEY`.
 *
 * WHY THE HTML IS WRITTEN HERE RATHER THAN IN `publish`. Every artefact of a version lives under
 * `sites/{siteId}/{versionId}/`, which is unreachable until the KV pointer names that version. So
 * writing the documents as they are rendered is invisible to the public, idempotent on a retry
 * (same key, same bytes) and avoids the alternative — buffering seven documents through a Workflow
 * step boundary, where a non-streaming `step.do()` return is capped at 1 MiB and is stored durably
 * for the life of the instance. The ordering guarantee is untouched: `publishVersion` verifies
 * every one of these keys exists before it flips, and the flip is still the only publish.
 *
 * THE `/` DOCUMENT IS A BYTE COPY, NOT A SECOND RENDER. §7.2 makes `/` a 200 serving the default
 * locale's content, with `<link rel=canonical>` pointing at `/{defaultLocale}/` and `x-default`
 * pointing at `/`. The default-locale home page already carries exactly those two relationships, so
 * the bare-domain document is the same bytes under a second key — one extra R2 object per publish,
 * which is free, against a redirect on the single most-requested URL of every tenant site.
 */

/** One materialised document. */
export interface RenderedPage {
  /** The R2 key it was written to, under the version prefix. */
  readonly key: string;
  readonly locale: Locale;
  readonly pageId: string;
  /** Stable across regenerations; `publish` joins `content_changed_at` on it. */
  readonly pageKey: string;
  /** Locale-prefixed path with a trailing slash. */
  readonly path: string;
  readonly bytes: number;
  /**
   * Hex SHA-256 of the CANONICAL SEMANTIC PROJECTION — never of the bytes.
   *
   * §7.8: `lastmod` must not move on a deploy, a template change or a footer year rollover, so the
   * digest is taken over copy, structure, media identity and facts, with the theme, the CSS bundle,
   * the asset hashes and `dateModified` itself excluded.
   */
  readonly renderSha256: string;
  /** The `@graph`, extracted from the rendered head for `page_translations.jsonld`. */
  readonly jsonLd: string | null;
}

/** What the render step hands to `publish`. */
export interface RenderResult {
  readonly pages: readonly RenderedPage[];
  /** The bare-domain document's key, or `null` when the site has no default-locale home page. */
  readonly rootKey: string | null;
  /** Gzip size of the inline CSS on the largest page. The §7.20 budget is measured, not assumed. */
  readonly cssBytes: number;
  /** Gzip size of the inline JS. §7.23. */
  readonly jsBytes: number;
}

/**
 * The font prefix, which is what `RenderContext.assetBase` means to `site-kit`.
 *
 * `assetBase` is used in exactly two places inside that package — the `@font-face` block and the
 * font preload — and nowhere else, because every other asset URL arrives already resolved in the
 * context. So it is the FONT prefix, and it is `/_a/f` because that is the path `apps/renderer` and
 * `apps/media` parse back to the `fonts/` R2 prefix (`core/routing.ts`). Passing `/_a` here would
 * emit `/_a/inter-latin.woff2`, which parses as no asset kind at all and 404s on every page.
 */
const FONT_ASSET_BASE = '/_a/f';

/**
 * The footer's attribution, as PLAIN TEXT.
 *
 * §7.28: a sitewide followed backlink from every tenant site to the platform apex is one of the
 * three fastest routes to a manual action. `site-kit` takes a string, not a link, and this is that
 * string.
 */
const MADE_WITH = 'Gemaakt met aibuilder';

/* -- Media resolution -------------------------------------------------------------------------- */

/** Formats offered in a `<picture>`, best first. `jpg` is the fallback `src`, not a `<source>`. */
const SOURCE_FORMATS: readonly ImageFormat[] = ['avif', 'webp'];

/** MIME type per source format, for the `<source type>` attribute. */
const SOURCE_TYPES: Readonly<Record<ImageFormat, string>> = {
  avif: 'image/avif',
  webp: 'image/webp',
  jpg: 'image/jpeg',
};

/**
 * Extracts the content digest from a media key.
 *
 * Every media key is content-addressed and carries the digest as its second segment
 * (`img/{sha}/…`, `poster/{sha}.…`) or as its only one (`orig/{sha}`). Reading it back rather than
 * storing it separately keeps one source of truth: the key the pipeline wrote.
 */
function digestOf(r2Key: string): string | null {
  const match =
    /^(?:img|vid)\/([0-9a-f]{64})\/|^(?:poster)\/([0-9a-f]{64})\.|^orig\/([0-9a-f]{64})$/u.exec(
      r2Key,
    );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

/** The ladder rungs that exist for an asset: never wider than the asset itself. */
function widthsFor(intrinsicWidth: number): readonly ImageWidth[] {
  const usable = IMAGE_WIDTHS.filter((width) => width <= intrinsicWidth);
  const smallest = IMAGE_WIDTHS[0];
  if (usable.length > 0) return usable;
  // An asset narrower than the smallest rung still has that rung: the pipeline upscales nothing,
  // but it always writes at least one derivative, and an empty `srcset` renders no image at all.
  return smallest === undefined ? [] : [smallest];
}

/**
 * Resolves one media asset to the shape `site-kit` renders.
 *
 * Every URL is a same-origin `/_a/…` path (§7.24), which is what makes `img-src 'self'` in the
 * tenant CSP true and keeps the third-party-origin count at zero (§7.22).
 */
function resolveImage(asset: MediaAsset): ResolvedImage | null {
  const sha256 = digestOf(asset.r2Key);
  if (sha256 === null) return null;

  const widths = widthsFor(asset.width);
  const largest = widths[widths.length - 1];
  if (largest === undefined) return null;

  const srcsetFor = (format: ImageFormat): string =>
    widths
      .map((width) => `${assetPath({ kind: 'image', sha256, width, format })} ${String(width)}w`)
      .join(', ');

  return {
    src: assetPath({ kind: 'image', sha256, width: largest, format: 'jpg' }),
    sources: SOURCE_FORMATS.map((format) => ({
      type: SOURCE_TYPES[format],
      srcset: srcsetFor(format),
    })),
    width: asset.width,
    height: asset.height,
    // Written by the media pipeline, never by the model. An empty string renders a decorative
    // image, which is the correct a11y outcome for a photograph nobody has described.
    alt: asset.altText ?? '',
    // Neutral, because `ctx.images` is keyed by ref and a focal point is a property of one USE of
    // an asset. `site-kit`'s projection reads the section's own `MediaRef.focalPoint`.
    focal: '50% 50%',
    dominantColor: asset.dominantColor,
  };
}

/** The hero's media set for one page, or `null` when the page has no hero image. */
function heroFor(page: PageDoc, images: Readonly<Record<string, ResolvedImage>>): HeroMedia | null {
  for (const section of page.sections) {
    if (section.type !== 'hero' || section.media === null) continue;
    const poster = images[section.media.refId];
    if (poster === undefined) continue;
    return {
      poster,
      // No portrait crop and no video renditions in this phase: the media pipeline accepts no user
      // video at all (§0) and produces one landscape ladder per upload. The §7.17 poster/video size
      // invariant is therefore vacuously satisfied — there is no video to lose to.
      portraitSources: [],
      video: null,
    };
  }
  return null;
}

/**
 * The `<head>` icon set.
 *
 * The PLATFORM's icons, shared by every tenant, and that is deliberate rather than a stopgap: a
 * per-tenant favicon needs a PNG or an SVG, and the publish-time derivative ladder produces
 * `avif`/`webp`/`jpg` only. Faking a 32-pixel favicon from a JPEG would be worse than the honest
 * default. Per-tenant icons arrive with the editor's branding panel, which is where a customer can
 * actually supply a mark.
 *
 * `og:image` is per-site, because it is a share card rather than an icon and the 1200-wide JPEG
 * rung already exists.
 */
function iconsFor(hero: HeroMedia | null): RenderContext['icons'] {
  const og = hero === null ? null : ogImageFor(hero.poster);
  return {
    png32: assetPath({ kind: 'brand', file: BRAND_ICONS.png32 }),
    svg: assetPath({ kind: 'brand', file: BRAND_ICONS.svg }),
    appleTouch: assetPath({ kind: 'brand', file: BRAND_ICONS.appleTouch }),
    og,
  };
}

/** The share card: the 1200-wide JPEG rung of the hero poster, with its true rendered height. */
function ogImageFor(poster: ResolvedImage): RenderContext['icons']['og'] {
  const match = /\/_a\/i\/([0-9a-f]{64})\//u.exec(poster.src);
  const sha256 = match?.[1];
  if (sha256 === undefined || poster.width < 1200) return null;
  return {
    url: assetPath({ kind: 'image', sha256, width: 1200, format: 'jpg' }),
    width: 1200,
    height: Math.round((1200 * poster.height) / poster.width),
  };
}

/* -- Measurement ------------------------------------------------------------------------------- */

/**
 * Gzip byte length.
 *
 * `CompressionStream` is gzip and deflate only — there is no brotli in a Worker — so the §7.20
 * budget, which is stated in brotli, is enforced against gzip. That is sound in the direction that
 * matters: gzip is never smaller than brotli on the same input, so passing the gzip ceiling implies
 * passing the brotli one.
 */
async function gzipBytes(input: string): Promise<number> {
  if (input.length === 0) return 0;
  const stream = new Blob([input]).stream().pipeThrough(new CompressionStream('gzip'));
  const compressed = await new Response(stream).arrayBuffer();
  return compressed.byteLength;
}

/** `sha256-<base64>`, the form a CSP hash source takes. */
async function cspHash(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return `sha256-${btoa(binary)}`;
}

/* -- The step ---------------------------------------------------------------------------------- */

/**
 * Materialises every page of a version.
 *
 * Fails the run on a budget violation rather than publishing a page that breaks a §7 invariant.
 * `document_invalid` is classified as terminal by the retry ladder, which is right: a CSS bundle
 * that is over budget is over budget on every attempt, and four more tries would cost four more
 * renders and produce four identical failures.
 */
export async function runRenderStep(
  env: Env,
  ids: RunIds,
  input: { readonly doc: SiteDoc; readonly versionId: string },
): Promise<RenderResult> {
  const doc = input.doc;
  const site = await cp.sites.getLiveSite(env.CP, ids.siteId);
  if (site === null) {
    throw new GeneratorError('document_invalid', 'The site row disappeared before render.', {
      detail: ids.siteId,
    });
  }

  const industry = assertIndustry(doc.facts.industryKey);
  const hoursJsonLd = toOpeningHoursSpecification(doc.facts.openingHours);

  const images: Record<string, ResolvedImage> = {};
  for (const [refId, asset] of Object.entries(doc.media)) {
    const resolved = resolveImage(asset);
    if (resolved !== null) images[refId] = resolved;
  }

  const options: RenderOptions = {
    // Empty until the font-subsetting build step publishes its digests. `site-kit` falls back to
    // the unhashed filename, which is a real object at `fonts/{asset}-{subset}.woff2` — correct,
    // just without the immutable-cache win that a content hash buys.
    fontHashes: { byAsset: {} },
    madeWith: MADE_WITH,
  };

  const pages: RenderedPage[] = [];
  let rootKey: string | null = null;
  let cssBytes = 0;
  let jsBytes = 0;

  for (const locale of doc.locales.enabled) {
    const hoursDisplay = formatHoursForLocale(doc.facts.openingHours, locale);

    for (const page of doc.pages) {
      const routing = page.perLocale[locale];
      // Omit, never substitute (§7.4): a page with no translation in this locale simply has no
      // document here, and the hreflang cluster will not claim otherwise.
      if (routing === undefined) continue;

      const hero = heroFor(page, images);
      const context: RenderContext = {
        origin: `https://${site.canonical_host}`,
        assetBase: FONT_ASSET_BASE,
        // The site-level state; the per-page `noindex` flag is carried on the page itself and is
        // applied by `site-kit` and again by the renderer's `X-Robots-Tag`.
        indexState: site.index_state === 'indexable' ? 'index' : 'noindex',
        publishedAt: new Date(site.published_at ?? site.created_at).toISOString(),
        // Provisional: `publish` computes the real `content_changed_at` by comparing this page's
        // projection digest against the currently published one, which cannot be known until the
        // projection exists. The value is excluded from the projection precisely so that this
        // circularity does not move `lastmod` on every publish (§9.2).
        contentChangedAt: new Date(site.updated_at).toISOString(),
        industry: {
          key: industry.key,
          schemaOrgType: industry.schemaOrgType,
          additionalType: industry.additionalType,
        },
        hoursJsonLd,
        hoursDisplay,
        // Phase 1 and 2 collect no verified reviews, and `reviews_source` is `none`, so review
        // markup is not emitted at all — self-serving review markup has been rich-result-ineligible
        // since 2019 and is a per-se unfair practice under UCPD Annex I 23b/23c (§7.13).
        reviews: [],
        images,
        hero,
        // The static map image is rendered to R2 at publish in a later phase; a null map renders the
        // address block without one, which is strictly better than a third-party Maps iframe (§7.22).
        map: null,
        // `contain-intrinsic-size` estimates come from the nightly render matrix's fitted
        // coefficient table, which lives in `site-kit`. Empty means every section falls back to the
        // component's own default rather than to a wrong number.
        sectionHeights: {},
        icons: iconsFor(hero),
        // §7.25: the site sets no non-essential cookie, uses no `localStorage` and logs
        // server-side, so the strictly-necessary exemption covers everything and the correct output
        // is no banner at all.
        usesNonEssential: false,
      };

      const rendered = await renderPage(doc, locale, page.pageId, context, options);
      const analysis = analyseDocument(rendered.html);

      const scriptHashes = await Promise.all(analysis.inlineScripts.map(cspHash));
      const styleHashes = await Promise.all(analysis.inlineStyles.map(cspHash));
      const pageJsBytes = await gzipBytes(analysis.inlineScripts.join(''));
      const pageCssBytes = await gzipBytes(analysis.inlineStyles.join(''));
      cssBytes = Math.max(cssBytes, pageCssBytes);
      jsBytes = Math.max(jsBytes, pageJsBytes);

      const findings = checkDocumentBudgets({
        analysis,
        sizes: { cssGzipBytes: pageCssBytes, jsGzipBytes: pageJsBytes },
        sameOriginHosts: [site.canonical_host],
      });
      if (hasBlockingBudgetFindings(findings)) {
        throw new DocumentInvalidError(
          findings.map((finding) => `${finding.code}@${routing.path}: ${finding.message}`),
        );
      }

      const metadata = encodePageMetadata({
        renderSha256: rendered.renderSha256,
        csp: buildTenantCsp({ scriptHashes, styleHashes }),
        link: preloadLinkHeader(analysis.preloads),
        locale,
        noindex: page.noindex,
      });

      const key = materialisedPageKey({
        siteId: ids.siteId,
        versionId: input.versionId,
        locale,
        // `routing.path` is the full locale-prefixed path; the key builder prepends the locale
        // segment itself, so it takes the locale-local remainder.
        path: routing.path.slice(`/${locale}`.length) || '/',
      });

      await writeDocument(env, key, rendered.html, metadata);

      pages.push({
        key,
        locale,
        pageId: page.pageId,
        pageKey: page.pageKey,
        path: routing.path,
        bytes: analysis.htmlBytes,
        renderSha256: rendered.renderSha256,
        jsonLd:
          analysis.dataBlocks.find((block) => block.type === 'application/ld+json')?.content ??
          null,
      });

      if (locale === doc.locales.default && page.role === 'home') {
        rootKey = rootDocumentKey({ siteId: ids.siteId, versionId: input.versionId });
        await writeDocument(env, rootKey, rendered.html, metadata);
      }
    }
  }

  if (pages.length === 0) {
    throw new DocumentInvalidError(['render produced no documents at all']);
  }

  return { pages, rootKey, cssBytes, jsBytes };
}

/**
 * Writes one document under the version prefix.
 *
 * Uncompressed on purpose: the edge compresses HTML on the way out, brotli is not available in a
 * Worker, and a gzip-compressed R2 object would have to be decompressed and recompressed on every
 * miss (§0, "there is no build compute in this stack").
 */
async function writeDocument(
  env: Env,
  key: string,
  html: string,
  customMetadata: Record<string, string>,
): Promise<void> {
  await env.BLOBS.put(key, html, {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
    customMetadata,
  });
}
