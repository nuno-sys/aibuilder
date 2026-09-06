import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { assetPath, assetR2Key, sitemapIndexKey, sitemapKey } from '@aibuilder/core';

import app from '../index';
import { fakeEnv, fakeFetcher, manifest } from './doubles';

const HOST = 'bakkerij-jansen.mijnsaas.com';
const SITE = manifest();
const SHA = 'c'.repeat(64);

async function call(
  url: string,
  env: ReturnType<typeof fakeEnv>,
  init?: RequestInit,
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(url, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe('robots.txt', () => {
  it('opens the crawl and advertises the sitemap once indexable', async () => {
    const response = await call(`https://${HOST}/robots.txt`, fakeEnv({ manifests: [SITE] }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await response.text()).toBe(
      `User-agent: *\nAllow: /\n\nSitemap: https://${HOST}/sitemap.xml\n`,
    );
  });

  it('blocks the crawl of a site that has not been claimed', async () => {
    const site = manifest({ indexState: 'noindex' });
    const response = await call(`https://${HOST}/robots.txt`, fakeEnv({ manifests: [site] }));
    expect(await response.text()).toBe('User-agent: *\nDisallow: /\n');
  });

  it('leaves the crawl open while a site is being withdrawn', async () => {
    // Disallow does not de-index; it stops the noindex ever being seen (§7.9).
    const site = manifest({ indexState: 'gone', goneAt: Date.now() });
    const response = await call(`https://${HOST}/robots.txt`, fakeEnv({ manifests: [site] }));
    const body = await response.text();
    expect(body).toContain('Allow: /');
    expect(body).not.toContain('Disallow');
  });

  it('is synthesised per host, so a custom domain names itself', async () => {
    const site = manifest({ canonicalHost: 'www.bakkerijjansen.nl' });
    const response = await call(
      'https://www.bakkerijjansen.nl/robots.txt',
      fakeEnv({ manifests: [site] }),
    );
    expect(await response.text()).toContain('Sitemap: https://www.bakkerijjansen.nl/sitemap.xml');
  });
});

describe('sitemaps', () => {
  const blobs = {
    [sitemapIndexKey({ siteId: SITE.siteId, versionId: SITE.liveVersion })]: {
      body: '<?xml version="1.0"?><sitemapindex/>',
    },
    [sitemapKey({ siteId: SITE.siteId, versionId: SITE.liveVersion, locale: 'nl' })]: {
      body: '<?xml version="1.0"?><urlset/>',
    },
  };

  it('serves the index from R2 and does not claim an encoding the object does not have', async () => {
    // The `.xml.br` key name is a misnomer: there is no brotli in a Worker, so the object is stored
    // uncompressed and the edge compresses it on the way out.
    const response = await call(
      `https://${HOST}/sitemap.xml`,
      fakeEnv({ manifests: [SITE], blobs }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(response.headers.get('content-encoding')).toBeNull();
  });

  it('serves one locale urlset', async () => {
    const response = await call(
      `https://${HOST}/sitemaps/nl.xml`,
      fakeEnv({ manifests: [SITE], blobs }),
    );
    expect(response.status).toBe(200);
  });

  it('404s a locale this site does not publish', async () => {
    const response = await call(
      `https://${HOST}/sitemaps/de.xml`,
      fakeEnv({ manifests: [SITE], blobs }),
    );
    expect(response.status).toBe(404);
  });

  it('serves no sitemap at all while a site is blocked or being withdrawn', async () => {
    // Handing a crawler the list of URLs a site is trying to keep out of the index defeats the
    // point of the state it is in.
    for (const indexState of ['noindex', 'eligible', 'gone'] as const) {
      const site = manifest({ indexState });
      const response = await call(
        `https://${HOST}/sitemap.xml`,
        fakeEnv({ manifests: [site], blobs }),
      );
      expect(response.status, indexState).toBe(404);
    }
  });
});

describe('the IndexNow key file', () => {
  it('serves the key at its own path only', async () => {
    const env = fakeEnv({ manifests: [SITE] });
    const response = await call(`https://${HOST}/indexnowkey0123456789.txt`, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('indexnowkey0123456789\n');
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('does not answer for any other .txt name', async () => {
    const response = await call(`https://${HOST}/guessing.txt`, fakeEnv({ manifests: [SITE] }));
    expect(response.status).toBe(404);
  });
});

describe('/_a/ assets', () => {
  const key = assetR2Key({ kind: 'image', sha256: SHA, width: 800, format: 'avif' });
  const media = { [key]: { body: new Uint8Array([0, 1, 2, 3]), etag: '"abc"' } };

  it('serves a derivative with a FORCED content type and nosniff', async () => {
    const response = await call(
      `https://${HOST}${assetPath({ kind: 'image', sha256: SHA, width: 800, format: 'avif' })}`,
      fakeEnv({ manifests: [SITE], media }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/avif');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('answers a conditional asset request with 304', async () => {
    const response = await call(
      `https://${HOST}${assetPath({ kind: 'image', sha256: SHA, width: 800, format: 'avif' })}`,
      fakeEnv({ manifests: [SITE], media }),
      { headers: { 'if-none-match': '"abc"' } },
    );
    expect(response.status).toBe(304);
  });

  it('refuses anything outside the closed derivative ladder', async () => {
    const env = fakeEnv({ manifests: [SITE], media });
    for (const path of [
      `/_a/i/${SHA}/801.avif`,
      `/_a/i/${SHA}/800.svg`,
      `/_a/p/${SHA}.svg`,
      '/_a/f/../../etc/passwd',
      '/_a/x/anything',
    ]) {
      const response = await call(`https://${HOST}${path}`, env);
      expect(response.status, path).toBe(404);
    }
  });

  it("is served from the tenant origin, so img-src 'self' holds", async () => {
    expect(
      assetPath({ kind: 'image', sha256: SHA, width: 800, format: 'avif' }).startsWith('/'),
    ).toBe(true);
  });
});

describe('the lead form forward', () => {
  it('takes the site id from KV and never from the request', async () => {
    const api = fakeFetcher();
    const env = fakeEnv({ manifests: [SITE], api });
    const response = await call(`https://${HOST}/_f/lead`, env, {
      method: 'POST',
      headers: { origin: `https://${HOST}`, 'content-type': 'application/json' },
      body: JSON.stringify({ siteId: 'ste_someone_elses', message: 'hallo' }),
    });
    expect(response.status).toBe(202);
    expect(api.seen).toHaveLength(1);
    expect(api.seen[0]?.url).toBe(`https://api.internal/v1/leads/${SITE.siteId}`);
    expect(api.seen[0]?.url).not.toContain('someone_elses');
  });

  it('refuses a cross-origin post by exact match, never a suffix test', async () => {
    // `/mijnsaas\.com$/` matches `evilmijnsaas.com`, which is a working CSRF against every tenant.
    const api = fakeFetcher();
    const env = fakeEnv({ manifests: [SITE], api });
    const response = await call(`https://${HOST}/_f/lead`, env, {
      method: 'POST',
      headers: { origin: 'https://evilbakkerij-jansen.mijnsaas.com' },
      body: '{}',
    });
    expect(response.status).toBe(403);
    expect(api.seen).toHaveLength(0);
  });

  it('refuses a post with no Origin at all', async () => {
    const api = fakeFetcher();
    const response = await call(`https://${HOST}/_f/lead`, fakeEnv({ manifests: [SITE], api }), {
      method: 'POST',
      body: '{}',
    });
    expect(response.status).toBe(403);
  });

  it('is unreachable on an unknown host', async () => {
    const api = fakeFetcher();
    const response = await call(
      'https://unknown.example/_f/lead',
      fakeEnv({ manifests: [SITE], api }),
      {
        method: 'POST',
        headers: { origin: 'https://unknown.example' },
        body: '{}',
      },
    );
    expect(response.status).toBe(404);
    expect(api.seen).toHaveLength(0);
  });
});
