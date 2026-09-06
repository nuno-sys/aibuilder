import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { materialisedPageKey } from '@aibuilder/core';

import app from '../index';
import { fakeAnalytics, fakeEnv, manifest } from './doubles';

const HOST = 'bakkerij-jansen.mijnsaas.com';
const SITE = manifest();
const HOME_KEY = materialisedPageKey({
  siteId: SITE.siteId,
  versionId: SITE.liveVersion,
  locale: 'nl',
  path: '/',
});

async function get(
  url: string,
  env: ReturnType<typeof fakeEnv>,
  init?: RequestInit,
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(url, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe('host resolution', () => {
  it('serves a known host from R2', async () => {
    const env = fakeEnv({
      manifests: [SITE],
      blobs: { [HOME_KEY]: { body: '<!doctype html><title>Bakkerij</title>' } },
    });
    const response = await get(`https://${HOST}/nl/`, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Bakkerij');
  });

  it('answers an UNRECOGNISED host with a neutral 404 and never a default site', async () => {
    // A wildcard route answers for every hostname pointed at the zone. Serving "some site" here is
    // how a platform ends up hosting a phishing page on a hostname nobody authorised.
    const env = fakeEnv({
      manifests: [SITE],
      blobs: { [HOME_KEY]: { body: '<!doctype html><title>Bakkerij</title>' } },
    });
    const response = await get('https://someone-elses-domain.example/nl/', env);
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).not.toContain('Bakkerij');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('gives the same neutral answer for a malformed Host as for an unknown one', async () => {
    const env = fakeEnv({ manifests: [SITE] });
    const response = await get('https://bakkerij-jansen.mijnsaas.com/nl/', env, {
      headers: { host: 'not a host' },
    });
    expect(response.status).toBe(404);
  });

  it('redirects a non-canonical host exactly once, preserving path and query', async () => {
    // A site that has moved to a custom domain keeps answering on its slug host, and every one of
    // those requests is a single 301 to the canonical name — never a chain, never a 302.
    const site = manifest({ canonicalHost: 'www.bakkerijjansen.nl' });
    const env = fakeEnv({ manifests: [site], routing: { [HOST]: site } });
    const response = await get(`https://${HOST}/nl/diensten/?utm_source=flyer`, env);
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe(
      'https://www.bakkerijjansen.nl/nl/diensten/?utm_source=flyer',
    );
  });
});

describe('tenant response headers', () => {
  it('carries the §S7 set on every response, including the 404', async () => {
    const env = fakeEnv({ manifests: [SITE] });
    const response = await get('https://unknown.example/nl/', env);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('permissions-policy')).toContain('browsing-topics=()');
    // FLoC was withdrawn in 2022 and was never a Permissions-Policy feature.
    expect(response.headers.get('permissions-policy')).not.toContain('interest-cohort');
  });

  it('sends includeSubDomains only on our own zone', async () => {
    const env = fakeEnv({
      manifests: [SITE],
      blobs: { [HOME_KEY]: { body: '<!doctype html>' } },
    });
    const own = await get(`https://${HOST}/nl/`, env);
    expect(own.headers.get('strict-transport-security')).toBe(
      'max-age=63072000; includeSubDomains',
    );
  });

  it('never preloads or includes subdomains on a customer custom domain', async () => {
    // Preloading someone else's apex is close to irreversible and breaks them if they leave (§S7).
    const site = manifest({ canonicalHost: 'www.bakkerijjansen.nl' });
    const env = fakeEnv({
      manifests: [site],
      blobs: {
        [materialisedPageKey({
          siteId: site.siteId,
          versionId: site.liveVersion,
          locale: 'nl',
          path: '/',
        })]: { body: '<!doctype html>' },
      },
    });
    const response = await get('https://www.bakkerijjansen.nl/nl/', env);
    const hsts = response.headers.get('strict-transport-security');
    expect(hsts).toBe('max-age=15768000');
    expect(hsts).not.toContain('preload');
    expect(hsts).not.toContain('includeSubDomains');
  });
});

describe('path routing', () => {
  const env = () =>
    fakeEnv({
      manifests: [SITE],
      blobs: {
        [HOME_KEY]: { body: '<!doctype html><title>nl home</title>' },
        [`sites/${SITE.siteId}/${SITE.liveVersion}/index.html`]: {
          body: '<!doctype html><title>bare domain</title>',
        },
      },
    });

  it('serves / as a 200 over its own object, never a redirect', async () => {
    // §7.2: a 308 on the flyer-printed URL of every tenant site is a self-inflicted LCP wound.
    const response = await get(`https://${HOST}/`, env());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('bare domain');
  });

  it('404s a locale this site does not publish rather than substituting one', async () => {
    const response = await get(`https://${HOST}/de/`, env());
    expect(response.status).toBe(404);
  });

  it('redirects a missing trailing slash once', async () => {
    const response = await get(`https://${HOST}/nl/diensten`, env());
    expect(response.status).toBe(301);
  });

  it('never varies on Accept-Language or country', async () => {
    // §7.3: Googlebot crawls from US IPs with no meaningful Accept-Language, and Vary: CF-IPCountry
    // fragments the cache roughly 200 ways.
    const response = await get(`https://${HOST}/`, env(), {
      headers: { 'accept-language': 'de-DE,de;q=0.9' },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('bare domain');
    expect(response.headers.get('vary') ?? '').not.toContain('Accept-Language');
    expect(response.headers.get('vary') ?? '').not.toContain('CF-IPCountry');
  });
});

describe('analytics', () => {
  it('writes exactly one first-party data point per request', async () => {
    const analytics = fakeAnalytics();
    const env = fakeEnv({
      manifests: [SITE],
      blobs: { [HOME_KEY]: { body: '<!doctype html><title>x</title>' } },
      analytics,
    });

    const response = await get(`https://${HOST}/nl/`, env);
    expect(response.status).toBe(200);
    expect(analytics.points).toHaveLength(1);
    expect(analytics.points[0]?.indexes).toEqual([SITE.siteId]);
    expect(analytics.points[0]?.blobs).toContain('/nl/');
  });

  it('records nothing that identifies a visitor', async () => {
    // No IP, raw or hashed; no user agent; no referrer; no query string. A two-letter country from
    // Cloudflare's own edge is the finest granularity, and that is deliberate (§7.22, §8 GDPR).
    const analytics = fakeAnalytics();
    const env = fakeEnv({
      manifests: [SITE],
      blobs: { [HOME_KEY]: { body: '<!doctype html>' } },
      analytics,
    });
    await get(`https://${HOST}/nl/?utm_campaign=secret`, env, {
      headers: {
        'user-agent': 'Mozilla/5.0 (a very identifying string)',
        referer: 'https://example.com/where-i-came-from',
        'cf-connecting-ip': '203.0.113.9',
      },
    });
    const serialised = JSON.stringify(analytics.points);
    expect(serialised).not.toContain('203.0.113.9');
    expect(serialised).not.toContain('Mozilla');
    expect(serialised).not.toContain('where-i-came-from');
    expect(serialised).not.toContain('utm_campaign');
  });

  it('counts a 404 so a broken internal link is visible somewhere', async () => {
    const analytics = fakeAnalytics();
    const env = fakeEnv({ manifests: [SITE], analytics });
    await get(`https://${HOST}/nl/verdwenen/`, env);
    expect(analytics.points).toHaveLength(1);
    expect(analytics.points[0]?.doubles?.[0]).toBe(404);
  });
});
