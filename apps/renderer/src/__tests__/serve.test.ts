import { describe, expect, it } from 'vitest';

import { encodePageMetadata, materialisedPageKey, rootDocumentKey } from '@aibuilder/core';
import type { RoutingManifest } from '@aibuilder/core';

import { pageTarget, rootTarget, serveDocument } from '../serve';
import { fakeCache, fakeR2, manifest } from './doubles';
import type { FakeObject } from './doubles';

const NOW = 1_757_000_000_000;

const METADATA = encodePageMetadata({
  renderSha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  csp: "default-src 'none'; script-src 'sha256-x'",
  link: '</_a/i/aa/800.avif>; rel=preload; as=image',
  locale: 'nl',
  noindex: false,
});

function pageObject(body: string, metadata = METADATA): FakeObject {
  return { body, customMetadata: metadata };
}

async function serve(args: {
  readonly site: RoutingManifest;
  readonly path: string;
  readonly blobs: Readonly<Record<string, FakeObject>>;
  readonly cache?: ReturnType<typeof fakeCache>;
  readonly ifNoneMatch?: string;
  readonly now?: number;
}): Promise<Response> {
  const target = args.path === '/' ? rootTarget(args.site) : pageTarget(args.site, 'nl', args.path);
  if (target === null) throw new Error(`test path is not a content path: ${args.path}`);
  return serveDocument({
    manifest: args.site,
    target,
    blobs: fakeR2(args.blobs),
    cache: args.cache ?? null,
    ifNoneMatch: args.ifNoneMatch ?? null,
    now: args.now ?? NOW,
    waitUntil: (promise) => {
      void promise;
    },
  });
}

function keyFor(site: RoutingManifest, path: string): string {
  return path === '/'
    ? rootDocumentKey({ siteId: site.siteId, versionId: site.liveVersion })
    : materialisedPageKey({
        siteId: site.siteId,
        versionId: site.liveVersion,
        locale: 'nl',
        path,
      });
}

describe('cache-key tenant isolation', () => {
  it('does NOT let two tenants collide on the same path', async () => {
    // The default Workers cache key excludes the host. If these two ever shared an entry, one
    // bakery's /nl/diensten/ would be served on the other's domain (§3a step 4).
    const a = manifest({ siteId: 'ste_aaa', canonicalHost: 'a.mijnsaas.com' });
    const b = manifest({ siteId: 'ste_bbb', canonicalHost: 'b.mijnsaas.com' });
    const cache = fakeCache();

    const first = await serve({
      site: a,
      path: '/diensten/',
      blobs: { [keyFor(a, '/diensten/')]: pageObject('<!doctype html>A') },
      cache,
    });
    const second = await serve({
      site: b,
      path: '/diensten/',
      blobs: { [keyFor(b, '/diensten/')]: pageObject('<!doctype html>B') },
      cache,
    });

    expect(await first.text()).toContain('A');
    expect(await second.text()).toContain('B');
    expect(cache.keys).toHaveLength(2);
    expect(new Set(cache.keys).size).toBe(2);
    expect(cache.keys[0]).toContain('/ste_aaa/');
    expect(cache.keys[1]).toContain('/ste_bbb/');
  });

  it('caches every entry under a key that begins with the site id and the version', async () => {
    const site = manifest();
    const cache = fakeCache();
    await serve({
      site,
      path: '/diensten/',
      blobs: { [keyFor(site, '/diensten/')]: pageObject('<!doctype html>') },
      cache,
    });
    expect(cache.keys[0]).toBe(
      `https://c.internal/${site.siteId}/${site.liveVersion}/p/nl/diensten/`,
    );
  });

  it('serves the second request from the cache without touching storage', async () => {
    const site = manifest();
    const cache = fakeCache();
    const blobs = { [keyFor(site, '/')]: pageObject('<!doctype html>cached') };

    const miss = await serve({ site, path: '/verdwenen/', blobs: {}, cache });
    expect(miss.status).toBe(404);

    await serve({ site, path: '/', blobs, cache });
    // Storage is now empty; only a cache hit can answer.
    const hit = await serve({ site, path: '/', blobs: {}, cache });
    expect(hit.status).toBe(200);
    expect(hit.headers.get('x-cache')).toBe('hit');
    expect(await hit.text()).toContain('cached');
  });

  it('makes a new version unreachable from the old entries', async () => {
    const before = manifest({ liveVersion: 'ver_1' });
    const after = manifest({ liveVersion: 'ver_2' });
    const cache = fakeCache();

    await serve({
      site: before,
      path: '/',
      blobs: { [keyFor(before, '/')]: pageObject('<!doctype html>old') },
      cache,
    });
    const republished = await serve({
      site: after,
      path: '/',
      blobs: { [keyFor(after, '/')]: pageObject('<!doctype html>new') },
      cache,
    });
    expect(await republished.text()).toContain('new');
    expect(cache.keys).toHaveLength(2);
  });
});

describe('document response headers', () => {
  const site = manifest();
  const blobs = { [keyFor(site, '/')]: pageObject('<!doctype html>home') };

  it('NEVER sets Cloudflare-CDN-Cache-Control on tenant HTML', async () => {
    // That header is keyed on a cache that excludes the host, which is exactly the multi-tenant
    // leak this Worker's synthetic key exists to avoid.
    const response = await serve({ site, path: '/', blobs });
    expect(response.headers.get('cloudflare-cdn-cache-control')).toBeNull();
    expect(response.headers.get('cdn-cache-control')).toBeNull();
  });

  it('gives the browser a short cache with stale-while-revalidate', async () => {
    const response = await serve({ site, path: '/', blobs });
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=60, stale-while-revalidate=600',
    );
  });

  it('stores the long internal directive, and only in the cache', async () => {
    const cache = fakeCache();
    await serve({ site, path: '/', blobs, cache });
    const stored = cache.entries.get(cache.keys[0] ?? '');
    expect(stored?.headers.get('cache-control')).toBe('public, max-age=31536000');
  });

  it('carries the ETag, Content-Language, CSP and preload Link from the stored metadata', async () => {
    const response = await serve({ site, path: '/', blobs });
    expect(response.headers.get('etag')).toBe(`W/"${site.liveVersion}-abcdef0123456789"`);
    expect(response.headers.get('content-language')).toBe('nl');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('link')).toContain('rel=preload');
  });

  it('answers a conditional request with 304 and no body', async () => {
    const etag = `W/"${site.liveVersion}-abcdef0123456789"`;
    const response = await serve({ site, path: '/', blobs, ifNoneMatch: etag });
    expect(response.status).toBe(304);
    expect(response.body).toBeNull();
  });

  it('compares ETags weakly, so a stripped W/ prefix still matches', async () => {
    const response = await serve({
      site,
      path: '/',
      blobs,
      ifNoneMatch: `"${site.liveVersion}-abcdef0123456789"`,
    });
    expect(response.status).toBe(304);
  });
});

describe('X-Robots-Tag on a served document', () => {
  const site = manifest();

  it('sends nothing on an indexable page of an indexable site', async () => {
    const response = await serve({
      site,
      path: '/',
      blobs: { [keyFor(site, '/')]: pageObject('<!doctype html>') },
    });
    expect(response.headers.get('x-robots-tag')).toBeNull();
  });

  it('sends noindex, nofollow before the site is verified', async () => {
    const unverified = manifest({ indexState: 'noindex' });
    const response = await serve({
      site: unverified,
      path: '/',
      blobs: { [keyFor(unverified, '/')]: pageObject('<!doctype html>') },
    });
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('lets a single page opt out of an indexable site', async () => {
    const metadata = encodePageMetadata({
      renderSha256: null,
      csp: null,
      link: null,
      locale: 'nl',
      noindex: true,
    });
    const response = await serve({
      site,
      path: '/',
      blobs: { [keyFor(site, '/')]: pageObject('<!doctype html>', metadata) },
    });
    expect(response.headers.get('x-robots-tag')).toBe('noindex, follow');
  });
});

describe('the withdrawal window', () => {
  const goneAt = NOW - 1000;
  const site = manifest({ indexState: 'gone', goneAt });
  const blobs = { [keyFor(site, '/')]: pageObject('<!doctype html>still here') };

  it('keeps serving 200 with noindex, follow while the removal is being crawled', async () => {
    const response = await serve({ site, path: '/', blobs, now: NOW });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-robots-tag')).toBe('noindex, follow');
  });

  it('answers 410 once the grace window has elapsed', async () => {
    const response = await serve({
      site,
      path: '/',
      blobs,
      now: goneAt + 31 * 24 * 60 * 60 * 1000,
    });
    expect(response.status).toBe(410);
    expect(response.headers.get('x-robots-tag')).toBe('noindex, follow');
  });
});
