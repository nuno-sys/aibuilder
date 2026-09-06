import { describe, expect, it } from 'vitest';

import { ROUTING_MANIFEST_VERSION, hreflangCluster, localePagePath } from '../routing';
import type { RoutingManifest } from '../routing';
import {
  SITEMAP_INDEX_PATH,
  SITEMAP_MAX_URLS,
  buildLocaleSitemap,
  buildSitemapIndex,
  changedUrlsFor,
  escapeXml,
  sitemapPathFor,
} from '../sitemap';

function manifest(overrides: Partial<RoutingManifest> = {}): RoutingManifest {
  return {
    v: ROUTING_MANIFEST_VERSION,
    siteId: 'ste_01J0000000000000000000000A',
    shardId: 0,
    orgId: 'org_01J0000000000000000000000B',
    liveVersion: 'ver_01J0000000000000000000000C',
    canonicalHost: 'bakkerij-jansen.mijnsaas.com',
    locales: ['nl', 'de'],
    defaultLocale: 'nl',
    indexState: 'indexable',
    goneAt: null,
    publishedAt: 1_757_000_000_000,
    ...overrides,
  };
}

const CHANGED_AT = 1_757_000_000_000;

describe('buildLocaleSitemap', () => {
  const site = manifest();
  const xml = buildLocaleSitemap({
    manifest: site,
    urls: [
      {
        path: '/nl/',
        contentChangedAt: CHANGED_AT,
        alternates: hreflangCluster({
          manifest: site,
          available: ['nl', 'de'],
          pathFor: (locale) => localePagePath(locale, '/'),
        }),
      },
      {
        path: '/nl/diensten/',
        contentChangedAt: CHANGED_AT + 1000,
        alternates: hreflangCluster({
          manifest: site,
          available: ['nl'],
          pathFor: (locale) => (locale === 'nl' ? '/nl/diensten/' : null),
        }),
      },
    ],
  });

  it('declares both namespaces and closes the document', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset ')).toBe(true);
    expect(xml).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    expect(xml.trimEnd().endsWith('</urlset>')).toBe(true);
  });

  it('emits absolute locs built from the canonical host', () => {
    expect(xml).toContain('<loc>https://bakkerij-jansen.mijnsaas.com/nl/</loc>');
    expect(xml).toContain('<loc>https://bakkerij-jansen.mijnsaas.com/nl/diensten/</loc>');
  });

  it('emits lastmod from content_changed_at, not from the publish time', () => {
    expect(xml).toContain('<lastmod>2025-09-04T15:33:20Z</lastmod>');
  });

  it('omits changefreq and priority entirely', () => {
    // Google ignores both, and a generated <changefreq> is an assertion we cannot back up.
    expect(xml).not.toContain('changefreq');
    expect(xml).not.toContain('priority');
  });

  it('carries the hreflang cluster as xhtml:link, omitting the locale with no translation', () => {
    const home = xml.slice(xml.indexOf('<url>'), xml.indexOf('</url>'));
    expect(home).toContain(
      '<xhtml:link rel="alternate" hreflang="nl" href="https://bakkerij-jansen.mijnsaas.com/nl/"/>',
    );
    expect(home).toContain('hreflang="de"');
    expect(home).toContain('hreflang="x-default"');

    const services = xml.slice(xml.lastIndexOf('<url>'));
    expect(services).toContain('hreflang="nl"');
    expect(services).not.toContain('hreflang="de"');
  });

  it('refuses to emit a sitemap over the protocol limit', () => {
    const urls = Array.from({ length: SITEMAP_MAX_URLS + 1 }, (_unused, index) => ({
      path: `/nl/p${String(index)}/`,
      contentChangedAt: CHANGED_AT,
      alternates: [],
    }));
    expect(() => buildLocaleSitemap({ manifest: site, urls })).toThrow(RangeError);
  });

  it('is byte-stable for unchanged input', () => {
    const again = buildLocaleSitemap({
      manifest: site,
      urls: [
        {
          path: '/nl/',
          contentChangedAt: CHANGED_AT,
          alternates: hreflangCluster({
            manifest: site,
            available: ['nl', 'de'],
            pathFor: (locale) => localePagePath(locale, '/'),
          }),
        },
        {
          path: '/nl/diensten/',
          contentChangedAt: CHANGED_AT + 1000,
          alternates: hreflangCluster({
            manifest: site,
            available: ['nl'],
            pathFor: (locale) => (locale === 'nl' ? '/nl/diensten/' : null),
          }),
        },
      ],
    });
    expect(again).toBe(xml);
  });
});

describe('buildSitemapIndex', () => {
  it('lists one sitemap per locale at the documented paths', () => {
    const xml = buildSitemapIndex({
      manifest: manifest(),
      entries: [
        { locale: 'nl', lastmod: CHANGED_AT },
        { locale: 'de', lastmod: null },
      ],
    });
    expect(xml).toContain('<loc>https://bakkerij-jansen.mijnsaas.com/sitemaps/nl.xml</loc>');
    expect(xml).toContain('<loc>https://bakkerij-jansen.mijnsaas.com/sitemaps/de.xml</loc>');
    expect(xml.trimEnd().endsWith('</sitemapindex>')).toBe(true);
  });

  it('omits lastmod for a sitemap with nothing in it', () => {
    const xml = buildSitemapIndex({
      manifest: manifest(),
      entries: [{ locale: 'de', lastmod: null }],
    });
    expect(xml).not.toContain('<lastmod>');
  });

  it('agrees with sitemapPathFor and the documented index path', () => {
    expect(sitemapPathFor('nl')).toBe('/sitemaps/nl.xml');
    expect(SITEMAP_INDEX_PATH).toBe('/sitemap.xml');
  });
});

describe('escapeXml', () => {
  it('escapes all five predefined entities', () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
  });
});

describe('changedUrlsFor', () => {
  it('returns only the URLs whose content actually changed', () => {
    // Pinging everything on every publish is how an IndexNow key gets ignored (§7.10).
    expect(
      changedUrlsFor({
        manifest: manifest(),
        entries: [
          { path: '/nl/', changed: true },
          { path: '/nl/over-ons/', changed: false },
        ],
      }),
    ).toEqual(['https://bakkerij-jansen.mijnsaas.com/nl/']);
  });
});
