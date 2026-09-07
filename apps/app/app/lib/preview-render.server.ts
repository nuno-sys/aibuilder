import {
  BRAND_ICONS,
  IMAGE_WIDTHS,
  assertIndustry,
  assetPath,
  formatHoursForLocale,
  isLocale,
  toOpeningHoursSpecification,
} from '@aibuilder/core';
import type { ImageFormat, ImageWidth, Locale } from '@aibuilder/core';
import { renderPage } from '@aibuilder/site-kit';
import type { HeroMedia, RenderContext, RenderOptions, ResolvedImage } from '@aibuilder/site-kit';
import type { MediaAsset, PageDoc, SiteDoc } from '@aibuilder/site-schema';

import { withPreviewBridge } from './preview-bridge';

/**
 * Rendering an UNPUBLISHED draft, on the preview origin.
 *
 * WHAT THIS SHARES WITH PRODUCTION, AND WHAT IT DOES NOT. It calls the same `renderPage` with the
 * same `SiteDoc`, so the markup, the CSS bundle and the theme are the ones that will publish — that
 * is the entire point of a preview and the reason none of this is a bespoke "editor renderer".
 * Three things legitimately differ, and each is a fact about a draft rather than a shortcut:
 *
 *  1. **`indexState` is always `noindex`.** A draft is not a page anybody may index, whatever the
 *     site's own state says. The `X-Robots-Tag` header on the response says so again, because a
 *     `<meta>` robots tag in a framed document is not what a crawler that reached the URL directly
 *     would necessarily read first.
 *  2. **Asset URLs are absolute against the media CDN.** `site-kit` emits same-origin `/_a/…` paths
 *     because a published page IS on the tenant origin, where `apps/media` answers them. The
 *     preview is on `preview.<control-plane-domain>`, which answers nothing of the sort, so every
 *     image and font URL is prefixed with `MEDIA_CDN_ORIGIN`. Getting this wrong produces a preview
 *     of a site with no pictures, which reads as "the product is broken".
 *  3. **`contentChangedAt` is the draft's own mtime.** There is no publish to date it from.
 *
 * WHAT IS DELIBERATELY EMPTY. `reviews` (no verified review source exists in this phase, and
 * self-serving review markup is rich-result-ineligible and a per-se unfair practice under UCPD
 * Annex I 23b/23c), `map` (the static map image is rendered to R2 at publish; a null map renders
 * the address block without one, which is strictly better than a third-party Maps iframe) and
 * `sectionHeights` (the fitted `contain-intrinsic-size` table is a publish-time artefact; empty
 * means each component falls back to its own default rather than to a wrong number).
 */

/** Formats offered in a `<picture>`, best first. `jpg` is the fallback `src`, not a `<source>`. */
const SOURCE_FORMATS: readonly ImageFormat[] = ['avif', 'webp'];

/** MIME type per source format, for the `<source type>` attribute. */
const SOURCE_TYPES: Readonly<Record<ImageFormat, string>> = {
  avif: 'image/avif',
  webp: 'image/webp',
  jpg: 'image/jpeg',
};

/**
 * The footer's attribution, as PLAIN TEXT.
 *
 * Architecture §7.28: a sitewide followed backlink from every tenant site to the platform apex is
 * one of the three fastest routes to a manual action. `site-kit` takes a string, not a link.
 */
const MADE_WITH = 'Gemaakt met aibuilder';

/**
 * Extracts the content digest from a media key.
 *
 * Every media key is content-addressed and carries the digest as its second segment (`img/{sha}/…`,
 * `poster/{sha}.…`) or as its only one (`orig/{sha}`). Reading it back rather than storing it
 * separately keeps one source of truth: the key the pipeline wrote.
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
  return smallest === undefined ? [] : [smallest];
}

/** Resolves one media asset to the shape `site-kit` renders, with absolute CDN URLs. */
function resolveImage(asset: MediaAsset, cdnOrigin: string): ResolvedImage | null {
  const sha256 = digestOf(asset.r2Key);
  if (sha256 === null) return null;

  const widths = widthsFor(asset.width);
  const largest = widths[widths.length - 1];
  if (largest === undefined) return null;

  const url = (width: ImageWidth, format: ImageFormat): string =>
    `${cdnOrigin}${assetPath({ kind: 'image', sha256, width, format })}`;

  return {
    src: url(largest, 'jpg'),
    sources: SOURCE_FORMATS.map((format) => ({
      type: SOURCE_TYPES[format],
      srcset: widths.map((width) => `${url(width, format)} ${String(width)}w`).join(', '),
    })),
    width: asset.width,
    height: asset.height,
    // Written by the media pipeline, never by the model. An empty string renders a decorative
    // image, which is the correct a11y outcome for a photograph nobody has described.
    alt: asset.altText ?? '',
    focal: '50% 50%',
    dominantColor: asset.dominantColor,
  };
}

/**
 * Photographic grounds behind ordinary sections, resolved from `doc.sectionBackgrounds`.
 *
 * Mirrors the generator's own resolution, for the same reason `heroFor` does: the editor must
 * preview the document that will publish, not a quieter version of it.
 */
function groundsFor(
  doc: SiteDoc,
  images: Readonly<Record<string, ResolvedImage>>,
): Readonly<Record<string, ResolvedImage>> {
  const grounds: Record<string, ResolvedImage> = {};
  for (const [sectionId, refId] of Object.entries(doc.sectionBackgrounds)) {
    const image = images[refId];
    if (image !== undefined) grounds[sectionId] = image;
  }
  return grounds;
}

/** A srcset over a library still ladder, on the CDN origin the dashboard preview loads from. */
function librarySrcset(template: string, widths: readonly number[], cdnOrigin: string): string {
  return widths
    .map((width) => {
      const key = template.replace('{width}', String(width));
      return `${cdnOrigin}${assetPath({ kind: 'library', key })} ${String(width)}w`;
    })
    .join(', ');
}

/**
 * The hero's media set for one page, or `null` when the page has no hero image.
 *
 * Mirrors `apps/generator/src/steps/render.ts` field for field, and has to: the point of this
 * module is that the editor previews the document that will publish. A preview that quietly
 * withheld the hero video would show the owner a still header and then publish a moving one.
 */
function heroFor(
  page: PageDoc,
  images: Readonly<Record<string, ResolvedImage>>,
  heroVideo: SiteDoc['heroVideo'],
  cdnOrigin: string,
): HeroMedia | null {
  for (const section of page.sections) {
    if (section.type !== 'hero' || section.media === null) continue;
    const poster = images[section.media.refId];
    if (poster === undefined) continue;
    const url = (key: string): string => `${cdnOrigin}${assetPath({ kind: 'library', key })}`;
    return {
      poster,
      portraitSources:
        heroVideo === null
          ? []
          : [
              {
                type: 'image/avif',
                srcset: librarySrcset(
                  heroVideo.portraitPoster.avifKeyTemplate,
                  heroVideo.portraitPoster.widths,
                  cdnOrigin,
                ),
              },
              {
                type: 'image/webp',
                srcset: librarySrcset(
                  heroVideo.portraitPoster.webpKeyTemplate,
                  heroVideo.portraitPoster.widths,
                  cdnOrigin,
                ),
              },
            ],
      video:
        heroVideo === null
          ? null
          : {
              desktopAv1: url(heroVideo.landscape.av1R2Key),
              desktopH264: url(heroVideo.landscape.h264R2Key),
              mobileAv1: url(heroVideo.portrait.av1R2Key),
              mobileH264: url(heroVideo.portrait.h264R2Key),
              width: heroVideo.landscape.width,
              height: heroVideo.landscape.height,
            },
    };
  }
  return null;
}

/** The `<head>` icon set — the platform's shared brand files, on the CDN. */
function iconsFor(cdnOrigin: string): RenderContext['icons'] {
  return {
    png32: `${cdnOrigin}${assetPath({ kind: 'brand', file: BRAND_ICONS.png32 })}`,
    svg: `${cdnOrigin}${assetPath({ kind: 'brand', file: BRAND_ICONS.svg })}`,
    appleTouch: `${cdnOrigin}${assetPath({ kind: 'brand', file: BRAND_ICONS.appleTouch })}`,
    // No share card: a preview is never shared, and computing one would mean asserting a rung of a
    // ladder that may not exist for a freshly uploaded asset.
    og: null,
  };
}

/** What a preview render needs beyond the document itself. */
export interface PreviewRenderInput {
  readonly doc: SiteDoc;
  /** The page to render. Defaults to the document's first page when absent or unknown. */
  readonly pageId: string | null;
  /** The locale to render. Defaults to the document's default locale. */
  readonly locale: string | null;
  /** `https://<slug>.<sites-root-domain>` — the canonical origin the published page will have. */
  readonly siteOrigin: string;
  readonly cdnOrigin: string;
  readonly dashboardOrigin: string;
  /** The draft's `updated_at`. Feeds `dateModified`; there is no publish date to use. */
  readonly updatedAt: number;
}

/** A rendered preview page. */
export interface PreviewRender {
  readonly html: string;
  readonly pageId: string;
  readonly locale: Locale;
}

/** Thrown when the requested page or locale does not exist in the draft. */
export class PreviewPageNotFoundError extends Error {
  override readonly name = 'PreviewPageNotFoundError';
}

/**
 * Renders one page of a draft.
 *
 * Falls back to the first page and the default locale rather than 404ing on a stale link: the
 * editor's page picker holds ids that may have been removed by a regeneration, and dropping the
 * customer onto the home page of their own draft is a better answer than an error page inside an
 * iframe. A page id that exists but has no translation in the requested locale DOES throw, because
 * silently rendering the other language is the one failure `SiteDoc`'s routing model exists to
 * prevent.
 */
export async function renderPreview(input: PreviewRenderInput): Promise<PreviewRender> {
  const doc = input.doc;
  const requestedLocale = input.locale;
  // Widened to `readonly string[]` so the membership test runs BEFORE the value is narrowed to a
  // `Locale`: the value came off a query string, and asserting it into the enum first is the
  // assertion this check exists to avoid.
  const enabled: readonly string[] = doc.locales.enabled;
  const locale: Locale =
    requestedLocale !== null && isLocale(requestedLocale) && enabled.includes(requestedLocale)
      ? requestedLocale
      : doc.locales.default;

  const page =
    doc.pages.find((candidate) => candidate.pageId === input.pageId) ?? doc.pages[0] ?? null;
  if (page === null) {
    throw new PreviewPageNotFoundError('the draft has no pages');
  }
  if (page.perLocale[locale] === undefined) {
    throw new PreviewPageNotFoundError(`page "${page.pageId}" has no "${locale}" translation`);
  }

  const images: Record<string, ResolvedImage> = {};
  for (const [refId, asset] of Object.entries(doc.media)) {
    const resolved = resolveImage(asset, input.cdnOrigin);
    if (resolved !== null) images[refId] = resolved;
  }

  const hero = heroFor(page, images, doc.heroVideo, input.cdnOrigin);
  const industry = assertIndustry(doc.facts.industryKey);
  const changedAt = new Date(input.updatedAt).toISOString();

  const context: RenderContext = {
    origin: input.siteOrigin,
    // `assetBase` is the FONT prefix inside `site-kit` — it is used by the `@font-face` block and
    // the preload and nowhere else. Absolute, for the same reason the images are.
    assetBase: `${input.cdnOrigin}/_a/f`,
    indexState: 'noindex',
    publishedAt: changedAt,
    contentChangedAt: changedAt,
    industry: {
      key: industry.key,
      schemaOrgType: industry.schemaOrgType,
      additionalType: industry.additionalType,
    },
    hoursJsonLd: toOpeningHoursSpecification(doc.facts.openingHours),
    hoursDisplay: formatHoursForLocale(doc.facts.openingHours, locale),
    reviews: [],
    images,
    hero,
    sectionGrounds: groundsFor(doc, images),
    map: null,
    sectionHeights: {},
    icons: iconsFor(input.cdnOrigin),
    usesNonEssential: false,
  };

  const options: RenderOptions = {
    // Empty until the font-subsetting build step publishes its digests; `site-kit` falls back to
    // the unhashed filename, which is a real object.
    fontHashes: { byAsset: {} },
    madeWith: MADE_WITH,
  };

  const rendered = await renderPage(doc, locale, page.pageId, context, options);
  return {
    html: withPreviewBridge(rendered.html, input.dashboardOrigin),
    pageId: page.pageId,
    locale,
  };
}

/**
 * The response headers every preview document carries.
 *
 * `X-Robots-Tag` and `Referrer-Policy` are architecture §9's explicit requirements, and neither is
 * belt-and-braces:
 *
 *   - `noindex, nofollow` because a draft URL that leaks into a crawler is a customer's unfinished
 *     site in a search index, under a hostname they do not control.
 *   - `no-referrer` because the mandated WhatsApp widget is an outbound link to `wa.me`, and a
 *     referrer header would tell a third party which preview URL the visitor came from. Together
 *     with the handshake design in `preview-cookie.server.ts` — where the only secret that ever
 *     appears in a URL is spent by a redirect that renders nothing — the referrer channel carries
 *     nothing worth having.
 *
 * `frame-ancestors` is the whole CSP, and that is a deliberate, narrower policy than a published
 * page carries. A published page's inline-script hashes are computed by the publish pipeline from
 * the exact bytes it rendered; a draft has no such artefact, so a `script-src` here would either
 * need `'unsafe-inline'` (worse than nothing) or would break `site-kit`'s own three inline scripts.
 * What the preview relies on instead is structural: a separate origin, no session cookie worth
 * stealing, no indexing, and exactly one document allowed to frame it.
 */
export function previewHeaders(dashboardOrigin: string): Headers {
  return new Headers({
    'content-type': 'text/html; charset=utf-8',
    'x-robots-tag': 'noindex, nofollow, noarchive',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy': `frame-ancestors ${dashboardOrigin}`,
    // A draft changes on every keystroke. Anything cached is a preview of the past.
    'cache-control': 'no-store',
  });
}
