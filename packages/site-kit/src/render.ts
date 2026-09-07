import type { Locale, PageDoc, SiteDoc } from '@aibuilder/site-schema';
import type { RenderContext } from './context';
import { assembleCss } from './css/assemble';
import type { CssBundle } from './css/assemble';
import type { ComponentKey } from './css/layers';
import type { FontAssetHashes } from './css/theme';
import { preloadFontHref } from './css/theme';
import { SITE_JS } from './js/site';
import { SPECULATION_RULES, documentOpen, renderHead, skipLink } from './layout/document';
import { SiteFooter } from './layout/footer';
import { HERO_SIZES } from './layout/hero';
import { SiteHeader } from './layout/header';
import { WhatsAppWidget } from './layout/whatsapp';
import { projectPage, renderSha256 } from './project';
import type { PageProjection } from './project';
import { renderSection, toneFor } from './sections/index';
import { buildGraph, ldScript, validateGraph } from './seo/jsonld';
import type { QaNote } from './seo/jsonld';
import type { ThemeKnobs } from './tokens/resolve';
import { resolveTheme } from './tokens/resolve';

/**
 * `renderPage` — one `SiteDoc`, one locale, one page, one complete HTML document.
 *
 * Pure with respect to `(doc, locale, pageId, ctx)`: no `Date.now()`, no `Math.random()`, no
 * `crypto.randomUUID()`, no environment read. `async` only because `renderSha256` goes through
 * `crypto.subtle.digest`.
 *
 * Five rules make identical inputs produce byte-identical output, and each is enforced somewhere
 * concrete rather than merely intended:
 *
 *  1. **Never iterate a record.** `doc.copy`, `doc.media`, `doc.links` and `page.perLocale` are
 *     `z.record(...)`; their key order is an engine detail. The renderer iterates the derived slot
 *     inventory, `doc.locales.enabled` and `page.sections` — all arrays.
 *  2. **Fixed attribute order** per component, written in the JSX, never assembled from an object.
 *  3. **No `Intl`, anywhere.** `Intl` output depends on the ICU data bundled with the runtime, so a
 *     `workerd` upgrade would silently change every published page's bytes and every tenant's
 *     `ETag`. `ui.ts` and `core/hours.ts` are table-driven for exactly this reason.
 *  4. **Numbers are pre-formatted strings.** `resolveTheme` quantises tokens to four decimals and
 *     `--sec-h` is an integer; nothing else numeric is interpolated.
 *  5. **`COMPONENT_ORDER` is a fixed array**, so the CSS bundle is a function of the *set* of used
 *     components, not of the order they first appear.
 */

/** What `renderPage` returns. */
export interface RenderResult {
  readonly html: string;
  /**
   * Lowercase hex SHA-256 of the CANONICAL SEMANTIC PROJECTION, not of `html`.
   *
   * It drives `lastmod`, so it must not move on a deploy, a template change or a footer year
   * rollover. See `project.ts`.
   */
  readonly renderSha256: string;
  readonly projection: PageProjection;
  readonly css: CssBundle;
  /** Divergences worth a QA note. Never control flow. */
  readonly notes: readonly QaNote[];
}

/** Options that are deployment facts rather than document data. */
export interface RenderOptions {
  readonly fontHashes: FontAssetHashes;
  /**
   * The footer's "made with" line, as **plain text**.
   *
   * A sitewide followed backlink from every tenant site to the platform's apex is the fastest
   * available route to a manual action, so this is a string and not a link.
   */
  readonly madeWith: string;
}

/** Thrown when the requested page does not exist in the document. */
export class PageNotFoundError extends Error {
  override readonly name = 'PageNotFoundError';
}

/** The set of CSS fragments a page needs. Chrome is always present; sections are per page. */
export function usedComponents(page: PageDoc, doc: SiteDoc, ctx: RenderContext): Set<ComponentKey> {
  const used = new Set<ComponentKey>(['header', 'footer']);
  for (const section of page.sections) used.add(section.type);
  if (doc.chrome.whatsappEnabled && doc.facts.whatsappE164 !== null) used.add('whatsapp');
  // The cookie banner is the one component whose CSS ships without its markup, and that is correct
  // rather than an oversight: the banner is created by the ~300 B consent bootstrap in `<head>`,
  // which is the only code that knows whether this visitor has already consented. Shipping the
  // sized fragment means the element it inserts is styled the moment it exists, so a `position:
  // fixed` banner appearing after paint costs nothing and flashes nothing. When
  // `uses_non_essential` is false — the default, and the case for almost every tenant — neither the
  // bootstrap nor these bytes are emitted at all.
  if (ctx.usesNonEssential) used.add('cookie_banner');
  return used;
}

/**
 * The theme knobs stored on the document.
 *
 * `ThemeDoc` is `ThemeGen` minus `rationale` plus the resolved tokens, so the eight knobs are
 * already there and `resolveTheme` re-derives the tokens rather than trusting the stored ones. That
 * is deliberate: a document whose stored tokens were edited by hand must render with the tokens the
 * resolver can prove, not with the ones somebody typed.
 */
function knobsOf(doc: SiteDoc): ThemeKnobs {
  return {
    dnaId: doc.theme.dnaId,
    paletteVariant: doc.theme.paletteVariant,
    accentHueShift: doc.theme.accentHueShift,
    typeScaleId: doc.theme.typeScaleId,
    radiusId: doc.theme.radiusId,
    densityId: doc.theme.densityId,
    motionId: doc.theme.motionId,
    colorMode: doc.theme.colorMode,
  };
}

export async function renderPage(
  doc: SiteDoc,
  locale: Locale,
  pageId: string,
  ctx: RenderContext,
  options: RenderOptions,
): Promise<RenderResult> {
  const page = doc.pages.find((candidate) => candidate.pageId === pageId);
  if (page === undefined) throw new PageNotFoundError(`no page "${pageId}" in this document`);

  const routing = page.perLocale[locale];
  if (routing === undefined) {
    throw new PageNotFoundError(`page "${pageId}" has no "${locale}" translation`);
  }
  const canonical = `${ctx.origin}${routing.path}`;

  const tokens = resolveTheme(knobsOf(doc));
  const themed: SiteDoc = { ...doc, theme: { ...doc.theme, tokens } };

  const css = assembleCss(usedComponents(page, doc, ctx), {
    tokens,
    dnaId: doc.theme.dnaId,
    assetBase: ctx.assetBase,
    fontHashes: options.fontHashes,
  });

  const notes: QaNote[] = [];
  const graph = buildGraph({ doc: themed, page, locale, ctx, canonical, notes });
  const graphProblems = validateGraph(graph, themed);
  if (graphProblems.length > 0) {
    // A structurally broken graph is a publish failure, not a page with quietly wrong markup:
    // a dangling `@id` disables every rich result and nothing in the UI would ever show it.
    throw new Error(`JSON-LD graph is invalid: ${graphProblems.join('; ')}`);
  }

  const scope = { locale, pageId };
  // Exactly one `<h1>` per page: the hero's headline where there is a hero, otherwise the first
  // section's. A section never decides its own level.
  const h1Index = page.sections.findIndex((section) => section.type === 'hero');
  const headingOwner = h1Index === -1 ? 0 : h1Index;

  const body = page.sections
    .map((section, index) =>
      String(
        renderSection({
          section,
          doc: themed,
          ctx,
          scope,
          tone: toneFor(section, index),
          headingLevel: index === headingOwner ? 1 : 2,
        }),
      ),
    )
    .join('');

  const heroPreloads =
    ctx.hero === null
      ? []
      : [
          ...(ctx.hero.portraitSources[0] === undefined
            ? []
            : [
                {
                  media: '(max-width:767px)',
                  imagesrcset: ctx.hero.portraitSources[0].srcset,
                  imagesizes: HERO_SIZES,
                  type: ctx.hero.portraitSources[0].type,
                },
              ]),
          ...(ctx.hero.poster.sources[0] === undefined
            ? []
            : [
                {
                  media: '(min-width:768px)',
                  imagesrcset: ctx.hero.poster.sources[0].srcset,
                  imagesizes: HERO_SIZES,
                  type: ctx.hero.poster.sources[0].type,
                },
              ]),
        ];

  const head = renderHead({
    doc: themed,
    page,
    locale,
    ctx,
    canonical,
    css: css.css,
    jsonLd: ldScript(graph),
    fontPreload: preloadFontHref(doc.theme.dnaId, ctx.assetBase, options.fontHashes),
    heroPreloads,
  });

  const html = [
    documentOpen(locale),
    head,
    '</head><body>',
    skipLink(locale),
    String(SiteHeader({ doc: themed, locale, currentPageId: pageId })),
    '<main id="main">',
    body,
    '</main>',
    String(
      SiteFooter({ doc: themed, ctx, locale, currentPageId: pageId, madeWith: options.madeWith }),
    ),
    whatsappMarkup(themed, locale),
    `<script>${SITE_JS}</script>`,
    SPECULATION_RULES,
    '</body></html>',
  ].join('');

  const projection = projectPage({ doc: themed, page, locale, ctx, graph });
  return {
    html,
    renderSha256: await renderSha256(projection),
    projection,
    css,
    notes,
  };
}

/** The widget, or nothing. Kept out of the array literal so the `null` case emits no bytes. */
function whatsappMarkup(doc: SiteDoc, locale: Locale): string {
  const widget = WhatsAppWidget({ doc, locale });
  return widget === null ? '' : String(widget);
}
