import { describe, expect, it } from 'vitest';

import {
  CACHE_ORIGIN,
  LIBRARY_PREFIX,
  assetContentType,
  assetPath,
  assetR2Key,
  parseAssetPath,
  ROUTING_MANIFEST_VERSION,
  absoluteUrl,
  cacheKeyUrl,
  encodeRoutingManifest,
  hreflangCluster,
  localePagePath,
  normaliseHost,
  pageCacheKeyUrl,
  parseRoutingManifest,
  resolveHost,
  routePath,
} from '../routing';
import type { RoutingManifest } from '../routing';

/** A published, Dutch-only bakery. */
function bakery(overrides: Partial<RoutingManifest> = {}): RoutingManifest {
  return {
    v: ROUTING_MANIFEST_VERSION,
    siteId: 'ste_01J0000000000000000000000A',
    shardId: 0,
    orgId: 'org_01J0000000000000000000000B',
    liveVersion: 'ver_01J0000000000000000000000C',
    canonicalHost: 'bakkerij-jansen.mijnsaas.com',
    locales: ['nl'],
    defaultLocale: 'nl',
    indexState: 'indexable',
    goneAt: null,
    publishedAt: 1_757_000_000_000,
    ...overrides,
  };
}

describe('normaliseHost', () => {
  it('folds the three spellings of the same host onto one key', () => {
    expect(normaliseHost('Bakkerij-Jansen.MijnSaas.com')).toBe('bakkerij-jansen.mijnsaas.com');
    expect(normaliseHost('bakkerij-jansen.mijnsaas.com.')).toBe('bakkerij-jansen.mijnsaas.com');
    expect(normaliseHost('bakkerij-jansen.mijnsaas.com:8787')).toBe('bakkerij-jansen.mijnsaas.com');
  });

  it('rejects anything that is not a hostname', () => {
    for (const value of [
      '',
      'localhost',
      'evil.com/../other',
      'a b.com',
      'user@evil.com',
      '192.0.2.1',
      'site.mijnsaas.com:notaport',
      `${'x'.repeat(300)}.com`,
      '-leading.mijnsaas.com',
    ]) {
      expect(normaliseHost(value), value).toBeNull();
    }
  });
});

describe('resolveHost', () => {
  it('serves the site when the host is its canonical host', () => {
    const resolution = resolveHost({
      host: 'bakkerij-jansen.mijnsaas.com',
      manifest: bakery(),
      pathname: '/nl/',
      search: '',
    });
    expect(resolution.kind).toBe('serve');
  });

  it('NEVER serves a default site for an unrecognised host', () => {
    // A KV miss is the only signal the renderer gets that a hostname is not ours. There is no
    // fallback branch and this test exists to keep it that way.
    const resolution = resolveHost({
      host: 'phishing.example.com',
      manifest: null,
      pathname: '/nl/',
      search: '',
    });
    expect(resolution).toEqual({ kind: 'unknown' });
  });

  it('treats an unparseable Host as unknown rather than as the canonical host', () => {
    expect(
      resolveHost({ host: 'not a host', manifest: bakery(), pathname: '/', search: '' }).kind,
    ).toBe('unknown');
  });

  it('redirects a non-canonical host exactly once, preserving path and query', () => {
    const resolution = resolveHost({
      host: 'bakkerij-jansen.mijnsaas.com.',
      manifest: bakery({ canonicalHost: 'www.bakkerijjansen.nl' }),
      pathname: '/nl/diensten/',
      search: '?utm_source=flyer',
    });
    expect(resolution).toMatchObject({
      kind: 'redirect',
      location: 'https://www.bakkerijjansen.nl/nl/diensten/?utm_source=flyer',
    });
  });
});

describe('the manifest round trip', () => {
  it('survives encode -> parse unchanged', () => {
    const manifest = bakery({ locales: ['nl', 'en'], goneAt: 1_757_000_001_000 });
    expect(parseRoutingManifest(encodeRoutingManifest(manifest))).toEqual(manifest);
  });

  it('returns null rather than throwing on anything malformed', () => {
    for (const value of [
      null,
      '',
      'not json',
      '[]',
      '{}',
      JSON.stringify({ ...bakery(), v: 2 }),
      JSON.stringify({ ...bakery(), liveVersion: '' }),
      JSON.stringify({ ...bakery(), locales: [] }),
      JSON.stringify({ ...bakery(), locales: ['nl'], defaultLocale: 'de' }),
      JSON.stringify({ ...bakery(), indexState: 'whatever' }),
      JSON.stringify({ ...bakery(), canonicalHost: 'not a host' }),
    ]) {
      expect(parseRoutingManifest(value as string | null)).toBeNull();
    }
  });

  it('reads a manifest written before goneAt existed', () => {
    const { goneAt: _goneAt, ...older } = bakery();
    expect(parseRoutingManifest(JSON.stringify(older))?.goneAt).toBeNull();
  });
});

describe('the cache key', () => {
  it('isolates two tenants asking for the same path', () => {
    // The default Workers cache key excludes the host. If this ever collides, one bakery's page is
    // served on every other tenant's domain — architecture §3a step 4, the SEO critique's fatal #1.
    const a = pageCacheKeyUrl({
      siteId: 'ste_01J0000000000000000000000A',
      liveVersion: 'ver_01J0000000000000000000000C',
      locale: 'nl',
      path: '/diensten/',
    });
    const b = pageCacheKeyUrl({
      siteId: 'ste_01J0000000000000000000000Z',
      liveVersion: 'ver_01J0000000000000000000000C',
      locale: 'nl',
      path: '/diensten/',
    });
    expect(a).not.toBe(b);
    expect(new URL(a).pathname.split('/')[1]).toBe('ste_01J0000000000000000000000A');
    expect(new URL(b).pathname.split('/')[1]).toBe('ste_01J0000000000000000000000Z');
  });

  it('retires every entry of a site when the version changes', () => {
    const before = pageCacheKeyUrl({
      siteId: 'ste_a',
      liveVersion: 'ver_1',
      locale: 'nl',
      path: '/',
    });
    const after = pageCacheKeyUrl({
      siteId: 'ste_a',
      liveVersion: 'ver_2',
      locale: 'nl',
      path: '/',
    });
    expect(before).not.toBe(after);
  });

  it('separates the variants of one version', () => {
    const robots = cacheKeyUrl({ siteId: 'ste_a', liveVersion: 'ver_1', variant: 'robots.txt' });
    const root = cacheKeyUrl({ siteId: 'ste_a', liveVersion: 'ver_1', variant: 'root' });
    expect(robots).not.toBe(root);
    expect(robots.startsWith(`${CACHE_ORIGIN}/ste_a/ver_1/`)).toBe(true);
  });

  it('cannot be reconstructed from a tenant request', () => {
    // The synthetic origin is not routable, so no inbound request can produce this URL.
    expect(CACHE_ORIGIN).toBe('https://c.internal');
  });
});

describe('routePath', () => {
  const manifest = bakery({ locales: ['nl', 'de'] });

  it('treats / as a page, never a redirect', () => {
    // §7.2: a 308 on the single most-requested, flyer-printed URL of every tenant site is a
    // self-inflicted LCP wound.
    expect(routePath('/', manifest)).toEqual({ kind: 'root' });
  });

  it('resolves a locale-prefixed content path', () => {
    expect(routePath('/nl/diensten/', manifest)).toEqual({
      kind: 'page',
      locale: 'nl',
      path: '/diensten/',
    });
  });

  it('misses on a locale this site does not publish', () => {
    // Omit, never substitute (§7.4): a Dutch-only site 404s on /fr/ rather than serving Dutch
    // content under a French URL.
    expect(routePath('/fr/', bakery()).kind).toBe('miss');
  });

  it('canonicalises a missing trailing slash and an uppercase path', () => {
    expect(routePath('/nl/diensten', manifest)).toEqual({
      kind: 'canonicalise',
      to: '/nl/diensten/',
    });
    expect(routePath('/NL/', manifest)).toEqual({ kind: 'canonicalise', to: '/nl/' });
  });

  it('rejects traversal and doubled separators outright', () => {
    expect(routePath('/nl/../../etc/', manifest).kind).toBe('miss');
    expect(routePath('/nl//diensten/', manifest).kind).toBe('miss');
  });
});

describe('hreflangCluster', () => {
  const manifest = bakery({ locales: ['nl', 'de', 'en'], defaultLocale: 'nl' });

  it('lists every member including itself', () => {
    const cluster = hreflangCluster({
      manifest,
      available: ['nl', 'de', 'en'],
      pathFor: (locale) => localePagePath(locale, '/diensten/'),
    });
    expect(cluster.map((link) => link.hreflang)).toEqual(['nl', 'en', 'de']);
    expect(cluster[0]?.href).toBe(absoluteUrl(manifest, '/nl/diensten/'));
  });

  it('OMITS a locale with no translation and never substitutes another', () => {
    // One non-reciprocal entry causes Google to discard the entire cluster (§7.4).
    const cluster = hreflangCluster({
      manifest,
      available: ['nl', 'en'],
      pathFor: (locale) => (locale === 'de' ? null : localePagePath(locale, '/diensten/')),
    });
    expect(cluster.map((link) => link.hreflang)).toEqual(['nl', 'en']);
    expect(cluster.every((link) => !link.href.includes('/de/'))).toBe(true);
  });

  it('ignores a locale the site does not publish even when copy exists for it', () => {
    const cluster = hreflangCluster({
      manifest: bakery(),
      available: ['nl', 'de'],
      pathFor: (locale) => localePagePath(locale, '/'),
    });
    expect(cluster.map((link) => link.hreflang)).toEqual(['nl', 'x-default']);
  });

  it('emits x-default only for the home page, pointing at the bare domain', () => {
    const home = hreflangCluster({
      manifest,
      available: ['nl'],
      pathFor: (locale) => localePagePath(locale, '/'),
    });
    expect(home.at(-1)).toEqual({ hreflang: 'x-default', href: absoluteUrl(manifest, '/') });

    const inner = hreflangCluster({
      manifest,
      available: ['nl'],
      pathFor: (locale) => localePagePath(locale, '/diensten/'),
    });
    expect(inner.some((link) => link.hreflang === 'x-default')).toBe(false);
  });

  it('emits the cluster in registry order regardless of the caller order', () => {
    const a = hreflangCluster({
      manifest,
      available: ['en', 'de', 'nl'],
      pathFor: (locale) => localePagePath(locale, '/over-ons/'),
    });
    const b = hreflangCluster({
      manifest,
      available: ['nl', 'en', 'de'],
      pathFor: (locale) => localePagePath(locale, '/over-ons/'),
    });
    expect(a).toEqual(b);
  });
});

describe('asset routing', () => {
  const SHA = 'b'.repeat(64);

  it('round-trips every asset kind', () => {
    for (const request of [
      { kind: 'image', sha256: SHA, width: 1200, format: 'avif' },
      { kind: 'poster', sha256: SHA, format: 'jpg' },
      { kind: 'video', sha256: SHA, format: 'mp4' },
      { kind: 'original', sha256: SHA },
      { kind: 'font', file: 'inter-latin.9a13c4.woff2' },
      { kind: 'brand', file: 'icon-32.png' },
      { kind: 'library', key: 'video/food_drink/light-1-landscape.av1.webm' },
      { kind: 'library', key: 'poster/real_estate/dark-2-p-1080.avif' },
    ] as const) {
      expect(parseAssetPath(assetPath(request))).toEqual(request);
    }
  });

  it('serves every derivative from the tenant origin, never a third one', () => {
    // §7.22 and §7.24: img-src 'self' is only true when the path is relative.
    expect(assetPath({ kind: 'image', sha256: SHA, width: 800, format: 'webp' })).toBe(
      `/_a/i/${SHA}/800.webp`,
    );
  });

  it('rejects anything outside the closed ladder', () => {
    for (const path of [
      '/_a/',
      '/_a/i/short/800.webp',
      `/_a/i/${SHA}/801.webp`,
      `/_a/i/${SHA}/800.svg`,
      `/_a/i/${SHA}/800.gif`,
      `/_a/p/${SHA}.svg`,
      `/_a/v/${SHA}.mov`,
      `/_a/x/${SHA}`,
      '/_a/f/../../secret',
      '/_a/f/evil.html',
      `/_a/o/${SHA}/../../other`,
      // The library grammar is closed the same way: a directory it does not name, a traversal
      // however it is spelled, an unbuilt format, and a bare directory are all not assets.
      '/_a/l/secrets/food_drink/x.webp',
      '/_a/l/video/../../etc/passwd',
      '/_a/l/video/food_drink/../../../secret.webp',
      '/_a/l/video/food_drink/clip.mkv',
      '/_a/l/video/food_drink/clip.av1.webm.exe',
      '/_a/l/poster/food_drink/',
      '/_a/l/poster/Food_Drink/x-640.avif',
      '/nl/',
    ]) {
      expect(parseAssetPath(path), path).toBeNull();
    }
  });

  it('builds the same R2 key the media pipeline wrote', () => {
    expect(assetR2Key({ kind: 'image', sha256: SHA, width: 400, format: 'jpg' })).toBe(
      `img/${SHA}/400.jpg`,
    );
    expect(assetR2Key({ kind: 'poster', sha256: SHA, format: 'avif' })).toBe(`poster/${SHA}.avif`);
    expect(assetR2Key({ kind: 'font', file: 'inter.woff2' })).toBe('fonts/inter.woff2');
    // Library objects are OUR build output under a single prefix, not content-addressed tenant
    // media: the key is the ingest's own path and the prefix is stated once, in `LIBRARY_PREFIX`.
    expect(assetR2Key({ kind: 'library', key: 'video/pets/dark-1-portrait.h264.mp4' })).toBe(
      `${LIBRARY_PREFIX}video/pets/dark-1-portrait.h264.mp4`,
    );
  });

  it('forces a Content-Type from a closed table, never from the request', () => {
    expect(assetContentType({ kind: 'image', sha256: SHA, width: 400, format: 'avif' })).toBe(
      'image/avif',
    );
    expect(assetContentType({ kind: 'video', sha256: SHA, format: 'webm' })).toBe('video/webm');
    expect(assetContentType({ kind: 'original', sha256: SHA })).toBe('application/octet-stream');
    expect(assetContentType({ kind: 'font', file: 'a.woff2' })).toBe('font/woff2');
    // Keyed on the COMPOUND suffix: `av1.webm` and `h264.mp4` name a codec as well as a container,
    // and a browser resolves a Content-Type that disagrees with the `<source type>` by refusing.
    expect(
      assetContentType({ kind: 'library', key: 'video/sport/light-1-landscape.av1.webm' }),
    ).toBe('video/webm');
    expect(
      assetContentType({ kind: 'library', key: 'video/sport/light-1-portrait.h264.mp4' }),
    ).toBe('video/mp4');
    expect(assetContentType({ kind: 'library', key: 'poster/sport/light-1-p-720.avif' })).toBe(
      'image/avif',
    );
    expect(assetContentType({ kind: 'library', key: 'poster/sport/light-1-2560.webp' })).toBe(
      'image/webp',
    );
  });
});
