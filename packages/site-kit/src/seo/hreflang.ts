import type { Locale, PageDoc, SiteDoc } from '@aibuilder/site-schema';
import { LOCALE_META } from '../ui';

/**
 * The hreflang cluster.
 *
 * It **omits, never substitutes**. A locale with no translation of *this* page is absent from the
 * cluster, because hreflang is reciprocal: one entry that points at a page which does not point
 * back invalidates the whole cluster, and Google then ignores every annotation on it. Pointing an
 * absent locale at the default translation is the single most common way to lose an entire site's
 * international targeting while appearing to have configured it.
 */

/** One `<link rel="alternate">`. */
export interface HreflangEntry {
  /** BCP-47 tag, or `x-default`. */
  readonly hreflang: string;
  readonly href: string;
}

/**
 * Builds the cluster for one page.
 *
 * `x-default` points at the site's default locale when that locale has this page, which is what
 * tells a search engine where to send a visitor whose language matches nothing.
 */
export function hreflangCluster(doc: SiteDoc, page: PageDoc, origin: string): HreflangEntry[] {
  const entries: HreflangEntry[] = [];
  // `doc.locales.enabled` is an array, so the order is stable; iterating `page.perLocale` would
  // hand the byte order of the head over to the JS engine's record enumeration.
  for (const locale of doc.locales.enabled) {
    const routing = page.perLocale[locale];
    if (routing === undefined) continue;
    entries.push({ hreflang: LOCALE_META[locale].tag, href: `${origin}${routing.path}` });
  }

  const fallback = page.perLocale[doc.locales.default];
  if (fallback !== undefined) {
    entries.push({ hreflang: 'x-default', href: `${origin}${fallback.path}` });
  }
  return entries;
}

/** The set of locales that actually have this page. Feeds the render projection (§9.2). */
export function translatedLocales(doc: SiteDoc, page: PageDoc): Locale[] {
  return doc.locales.enabled.filter((locale) => page.perLocale[locale] !== undefined);
}
