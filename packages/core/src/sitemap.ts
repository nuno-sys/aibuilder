import type { HreflangLink, RoutingManifest } from './routing';
import { absoluteUrl } from './routing';
import { formatLastmod } from './lastmod';
import type { Locale } from './locales';
import { localeUrlSegment } from './locales';

/**
 * Sitemaps: one urlset per locale plus an index, materialised to R2 at publish (§7.7).
 *
 * THREE DELIBERATE OMISSIONS, each of which is a decision rather than an oversight.
 *
 * 1. **No `<changefreq>` and no `<priority>`.** Google has stated for years that it ignores both.
 *    They are bytes on every URL of every tenant, they invite a generator to assert a freshness it
 *    cannot know, and they have never moved a ranking.
 * 2. **No image or video extensions.** Image sitemap support was retired; the markup that still
 *    does work is the JSON-LD graph, which `site-kit` already emits.
 * 3. **No non-indexable URL.** A `noindex` page in a sitemap is a direct contradiction: the sitemap
 *    says "index this", the page says "do not". The caller filters; this module refuses to emit an
 *    entry whose page is not indexable, so the filter cannot be forgotten in one call site.
 *
 * The `xhtml:link` alternates are the same cluster the `<head>` emits, built by `routing.ts` under
 * the omit-never-substitute rule (§7.4). They are duplicated into the sitemap on purpose: Google
 * treats the two as independent declarations and reconciles them, so a page that is only reachable
 * through the sitemap still joins its cluster.
 */

/** The path the sitemap index is served at. Hard-coded because crawlers look for exactly this. */
export const SITEMAP_INDEX_PATH = '/sitemap.xml';

/** Per-locale sitemap paths live under one prefix so the renderer can route them with one test. */
export const SITEMAP_PREFIX = '/sitemaps/';

/** Protocol limits. Exceeding either invalidates the whole file, not just the extra entries. */
export const SITEMAP_MAX_URLS = 50_000;

/** 50 MB uncompressed, per the sitemaps.org protocol. */
export const SITEMAP_MAX_BYTES = 50 * 1024 * 1024;

/** The URL path of one locale's sitemap. */
export function sitemapPathFor(locale: Locale): string {
  return `${SITEMAP_PREFIX}${localeUrlSegment(locale)}.xml`;
}

/* -- Escaping ---------------------------------------------------------------------------------- */

/**
 * Escapes text for an XML text node or attribute value.
 *
 * All five predefined entities, including the two that only matter inside attributes. A sitemap is
 * built from paths that came from the slug pipeline and are already `[a-z0-9-/]`, so in practice
 * nothing here has anything to escape — which is exactly why it must be applied unconditionally
 * rather than "when needed": the day a locale segment or a custom hostname contains an ampersand,
 * the alternative is a malformed document that a crawler discards whole.
 */
export function escapeXml(value: string): string {
  let out = '';
  for (const character of value) {
    switch (character) {
      case '&':
        out += '&amp;';
        break;
      case '<':
        out += '&lt;';
        break;
      case '>':
        out += '&gt;';
        break;
      case '"':
        out += '&quot;';
        break;
      case "'":
        out += '&apos;';
        break;
      default:
        out += character;
    }
  }
  return out;
}

/* -- Per-locale urlset ------------------------------------------------------------------------- */

/** One URL in a locale's sitemap. */
export interface SitemapUrl {
  /** Absolute, locale-prefixed, trailing-slashed path — `/nl/diensten/`. */
  readonly path: string;
  /** `page_translations.content_changed_at`, never the publish time (§7.8). */
  readonly contentChangedAt: number;
  /**
   * The full hreflang cluster for this page, including its own locale.
   *
   * Built by `hreflangCluster()`. Empty for a single-locale site, in which case no `xhtml:link`
   * elements are emitted and the `xmlns:xhtml` declaration is still present — a declared but
   * unused namespace is valid and keeps the document shape identical across sites.
   */
  readonly alternates: readonly HreflangLink[];
}

/**
 * Builds one locale's `<urlset>`.
 *
 * Entries are emitted in the order given. The caller sorts by path (the `SQL_LIST_SITEMAP_ENTRIES`
 * statement already does), which makes the document byte-stable for unchanged content — a property
 * the `ETag` and the R2 object's own digest both depend on.
 *
 * @throws RangeError when the urlset exceeds the protocol's 50,000-URL limit. A truncated sitemap
 * that still claims to be complete is worse than a failed publish, and at 50,000 pages the answer
 * is a second sitemap file, which is a change to the index rather than a silent slice.
 */
export function buildLocaleSitemap(args: {
  readonly manifest: RoutingManifest;
  readonly urls: readonly SitemapUrl[];
}): string {
  if (args.urls.length > SITEMAP_MAX_URLS) {
    throw new RangeError(
      `Sitemap has ${String(args.urls.length)} URLs; the protocol limit is ${String(
        SITEMAP_MAX_URLS,
      )}.`,
    );
  }

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
  ];

  for (const url of args.urls) {
    lines.push('<url>');
    lines.push(`<loc>${escapeXml(absoluteUrl(args.manifest, url.path))}</loc>`);
    lines.push(`<lastmod>${formatLastmod(url.contentChangedAt)}</lastmod>`);
    for (const alternate of url.alternates) {
      lines.push(
        `<xhtml:link rel="alternate" hreflang="${escapeXml(
          alternate.hreflang,
        )}" href="${escapeXml(alternate.href)}"/>`,
      );
    }
    lines.push('</url>');
  }

  lines.push('</urlset>');
  return `${lines.join('\n')}\n`;
}

/* -- Index ------------------------------------------------------------------------------------- */

/** One sitemap listed in the index. */
export interface SitemapIndexEntry {
  readonly locale: Locale;
  /**
   * The newest `content_changed_at` among the URLs in that sitemap, or `null` to omit `<lastmod>`.
   *
   * Not the publish time. An index whose `lastmod` moves on every deploy has the same credibility
   * problem as a urlset whose entries do, one level up (§7.8).
   */
  readonly lastmod: number | null;
}

/** Builds the `<sitemapindex>` served at `/sitemap.xml`. */
export function buildSitemapIndex(args: {
  readonly manifest: RoutingManifest;
  readonly entries: readonly SitemapIndexEntry[];
}): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];

  for (const entry of args.entries) {
    lines.push('<sitemap>');
    lines.push(`<loc>${escapeXml(absoluteUrl(args.manifest, sitemapPathFor(entry.locale)))}</loc>`);
    if (entry.lastmod !== null) lines.push(`<lastmod>${formatLastmod(entry.lastmod)}</lastmod>`);
    lines.push('</sitemap>');
  }

  lines.push('</sitemapindex>');
  return `${lines.join('\n')}\n`;
}

/**
 * The URLs whose content actually changed, for the IndexNow ping (§7.10).
 *
 * Only the changed ones. Pinging every URL on every publish is how a key gets rate-limited and
 * eventually ignored, and it tells the endpoint nothing it could not have crawled — the value of
 * the protocol is precisely that the set is small and true.
 */
export function changedUrlsFor(args: {
  readonly manifest: RoutingManifest;
  readonly entries: readonly { readonly path: string; readonly changed: boolean }[];
}): readonly string[] {
  return args.entries
    .filter((entry) => entry.changed)
    .map((entry) => absoluteUrl(args.manifest, entry.path));
}
