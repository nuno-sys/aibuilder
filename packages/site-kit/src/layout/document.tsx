import type { Locale, PageDoc, SiteDoc } from '@aibuilder/site-schema';
import { escapeAttr, escapeHtml } from '../escape';
import type { RenderContext } from '../context';
import { hexOf } from '../tokens/resolve';
import { hreflangCluster } from '../seo/hreflang';
import { LOCALE_META, uiStrings } from '../ui';

/**
 * The document shell — the one module in this package that assembles markup as a string.
 *
 * It has to be: `<!doctype html>` is not an element, and the `<style>`, `<script>` and JSON-LD
 * bodies are raw text that JSX would escape into uselessness. So this is the single, auditable seam
 * where escaping is explicit, and every interpolated value below goes through `escapeAttr` or
 * `escapeHtml`. The body — every section, the header, the footer — is `hono/jsx`, which escapes on
 * its own.
 *
 * The `<head>` order is a specification, not a style. The preload scanner reads top-down and starts
 * fetches before the parser reaches them, so LCP candidates come first, all CSS second, and
 * everything that fetches nothing after that.
 */

/** Everything the head needs that is not in the document. */
export interface HeadInputs {
  readonly doc: SiteDoc;
  readonly page: PageDoc;
  readonly locale: Locale;
  readonly ctx: RenderContext;
  readonly canonical: string;
  /** The assembled CSS bundle. Machine-generated: no tenant string reaches it. */
  readonly css: string;
  /** The serialised `<script type="application/ld+json">` element, already escaped by `ldScript`. */
  readonly jsonLd: string;
  /** `href` of the single preloaded font face. */
  readonly fontPreload: string;
  /** Art-directed hero preloads: at most one fetches, because they carry `media`. */
  readonly heroPreloads: readonly {
    readonly media: string;
    readonly href: string;
    readonly type: string;
  }[];
}

/**
 * Renders `<head>`.
 *
 * `viewport-fit=cover` is required for `env(safe-area-inset-*)` on notched iPhones. There is no
 * `maximum-scale` and no `user-scalable=no`: that is an automatic Lighthouse accessibility failure
 * and a WCAG 1.4.4 violation, and it is the single most common thing a template gets wrong.
 */
export function renderHead(inputs: HeadInputs): string {
  const { doc, page, locale, ctx, canonical } = inputs;
  const routing = page.perLocale[locale];
  const title = routing?.title ?? doc.facts.businessName;
  const description = routing?.description ?? '';
  const parts: string[] = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
  ];

  // 1. LCP candidates. Art-directed, so exactly one image is fetched.
  for (const preload of inputs.heroPreloads) {
    parts.push(
      `<link rel="preload" as="image" fetchpriority="high" media="${escapeAttr(preload.media)}"` +
        ` href="${escapeAttr(preload.href)}" type="${escapeAttr(preload.type)}">`,
    );
  }
  // `crossorigin` is mandatory even same-origin: fonts are CORS-fetched, and omitting it causes a
  // double download.
  parts.push(
    `<link rel="preload" as="font" type="font/woff2" href="${escapeAttr(inputs.fontPreload)}" crossorigin>`,
  );

  // 2. ALL CSS, inline, one element. Nothing render-blocking follows.
  parts.push(`<style>${inputs.css}</style>`);

  // 3. Metadata. No fetches, so order below the CSS is free.
  parts.push(`<title>${escapeHtml(title)}</title>`);
  parts.push(`<meta name="description" content="${escapeAttr(description)}">`);
  parts.push(`<link rel="canonical" href="${escapeAttr(canonical)}">`);

  for (const entry of hreflangCluster(doc, page, ctx.origin)) {
    parts.push(
      `<link rel="alternate" hreflang="${escapeAttr(entry.hreflang)}" href="${escapeAttr(entry.href)}">`,
    );
  }

  // The quality gate, not the model, decides whether a page may be indexed.
  if (ctx.indexState !== 'index' || page.noindex) {
    parts.push('<meta name="robots" content="noindex, nofollow">');
  }

  parts.push(`<link rel="icon" href="${escapeAttr(ctx.icons.png32)}" sizes="32x32">`);
  parts.push(`<link rel="icon" href="${escapeAttr(ctx.icons.svg)}" type="image/svg+xml">`);
  parts.push(`<link rel="apple-touch-icon" href="${escapeAttr(ctx.icons.appleTouch)}">`);
  parts.push('<link rel="manifest" href="/site.webmanifest">');
  // The third and last `TONE_EXEMPT_READS` entry: this is not CSS, so it cannot read a token.
  parts.push(
    `<meta name="theme-color" content="${escapeAttr(hexOf(doc.theme.tokens['--color-bg'] ?? 'oklch(1 0 0)'))}">`,
  );

  parts.push('<meta property="og:type" content="website">');
  parts.push(`<meta property="og:title" content="${escapeAttr(title)}">`);
  parts.push(`<meta property="og:description" content="${escapeAttr(description)}">`);
  parts.push(`<meta property="og:url" content="${escapeAttr(canonical)}">`);
  parts.push(`<meta property="og:locale" content="${escapeAttr(LOCALE_META[locale].og)}">`);
  if (ctx.icons.og !== null) {
    parts.push(`<meta property="og:image" content="${escapeAttr(ctx.icons.og.url)}">`);
    parts.push(`<meta property="og:image:width" content="${String(ctx.icons.og.width)}">`);
    parts.push(`<meta property="og:image:height" content="${String(ctx.icons.og.height)}">`);
    parts.push('<meta name="twitter:card" content="summary_large_image">');
  }

  // 4. JSON-LD last: it is the largest text node in the head and it blocks nothing.
  parts.push(inputs.jsonLd);

  return parts.join('');
}

/** Opens the document. `lang` and `dir` come from the locale table, never from the model. */
export function documentOpen(locale: Locale): string {
  return `<!doctype html><html lang="${escapeAttr(LOCALE_META[locale].tag)}" dir="ltr"><head>`;
}

/** The skip link. First in the DOM, before the header, or it is not a skip link. */
export function skipLink(locale: Locale): string {
  return `<a class="skip" href="#main">${escapeHtml(uiStrings(locale).skipToContent)}</a>`;
}

/**
 * Speculation rules for same-origin navigations.
 *
 * `moderate` eagerness prefetches on hover rather than on viewport entry, which keeps a phone on a
 * metered connection from downloading the whole site because the visitor scrolled past the nav. The
 * WhatsApp anchor is excluded through `data-no-prerender` — it is cross-origin and not
 * prerenderable.
 */
export const SPECULATION_RULES: string =
  '<script type="speculationrules">' +
  '{"prerender":[{"where":{"and":[{"href_matches":"/*"},{"not":{"selector_matches":"[data-no-prerender]"}}]},"eagerness":"moderate"}]}' +
  '</script>';
