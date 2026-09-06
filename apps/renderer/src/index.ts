import {
  ASSET_PREFIX,
  SITEMAP_INDEX_PATH,
  SITEMAP_PREFIX,
  normaliseHost,
  parseRoutingManifest,
  resolveHost,
  routePath,
  routingKey,
} from '@aibuilder/core';

import { serveAsset } from './assets';
import { countryOf, recordPageView } from './analytics';
import { defaultCache } from './cache';
import type { AppEnv } from './env';
import { applyTenantHeaders } from './headers';
import { serveIndexNowKey, serveRobots } from './robots';
import { neutralNotFound, pageTarget, rootTarget, serveDocument } from './serve';
import { localeFromSitemapPath, serveSitemap } from './sitemap';
import { Hono } from 'hono';

/**
 * `aibuilder-renderer` — every generated tenant site, on the tenant zone.
 *
 * THE READ PATH, IN ORDER (architecture §3a):
 *
 *   1. `KV_ROUTING.get(host)` — one read serves the whole site. A miss is a NEUTRAL 404. An
 *      unrecognised `Host` is never served a default site, because a wildcard route answers for
 *      every hostname pointed at the zone, including ones we have never heard of.
 *   2. `host !== canonicalHost` → exactly one 301, path- and query-preserving.
 *   3. Cache lookup on a synthetic key beginning with `siteId` — never on the request URL, because
 *      the default Workers cache key excludes the host and would share entries between tenants.
 *   4. Miss → one R2 read. **D1 is never touched here, and this Worker has no D1 binding at all.**
 *   5. One Analytics Engine data point via `waitUntil`. No client-side beacon, ever (§7.22).
 *
 * WHAT THIS WORKER WILL NOT DO. It will not redirect on `Accept-Language` or on geography (§7.3):
 * Googlebot crawls from US IPs with no meaningful `Accept-Language`, so a language redirect means
 * the Dutch page is never indexed and the hreflang cluster is discarded, and `Vary: CF-IPCountry`
 * would fragment the cache roughly two hundred ways. And it will not serve `/` as a redirect
 * (§7.2): `/` is a 200 over its own R2 object.
 */
const app = new Hono<AppEnv>();

/**
 * The tenant header set, outermost so the error and 404 paths carry it too.
 *
 * HSTS is decided per host: our own zone gets `includeSubDomains`, a customer's custom domain gets
 * a plain six-month `max-age` and is never preloaded (§S7).
 */
app.use('*', async (c, next) => {
  await next();
  applyTenantHeaders(c.res.headers, {
    host: normaliseHost(c.req.header('host')) ?? new URL(c.req.url).hostname,
    rootDomain: c.env.SITES_ROOT_DOMAIN,
  });
});

/**
 * Host resolution. Runs before every handler, including the asset path.
 *
 * There is no branch that serves anything for a host the manifest does not name. A KV miss, an
 * unparseable manifest and a `Host` that is not a hostname all produce the same neutral 404 —
 * deliberately identical, so the response says nothing about which hostnames exist.
 */
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  const host = normaliseHost(c.req.header('host') ?? url.host);
  if (host === null) return neutralNotFound();

  const manifest = parseRoutingManifest(await c.env.ROUTING.get(routingKey(host)));
  const resolution = resolveHost({
    host,
    manifest,
    pathname: url.pathname,
    search: url.search,
  });

  if (resolution.kind === 'unknown') return neutralNotFound();
  if (resolution.kind === 'redirect') {
    // One hop. The destination is the canonical host, which by definition does not redirect again.
    return c.redirect(resolution.location, 301);
  }

  c.set('site', resolution.manifest);
  c.set('host', host);
  await next();
  return undefined;
});

app.get('/robots.txt', async (c) =>
  serveRobots({
    manifest: c.get('site'),
    host: c.get('host'),
    cache: defaultCache(),
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
  }),
);

app.get(SITEMAP_INDEX_PATH, async (c) =>
  serveSitemap({
    manifest: c.get('site'),
    locale: null,
    blobs: c.env.BLOBS,
    cache: defaultCache(),
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
  }),
);

app.get(`${SITEMAP_PREFIX}:file`, async (c) => {
  const locale = localeFromSitemapPath(new URL(c.req.url).pathname, c.get('site'));
  if (locale === null) return neutralNotFound();
  return serveSitemap({
    manifest: c.get('site'),
    locale,
    blobs: c.env.BLOBS,
    cache: defaultCache(),
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
  });
});

app.get(`${ASSET_PREFIX}*`, async (c) =>
  serveAsset({
    pathname: new URL(c.req.url).pathname,
    media: c.env.MEDIA,
    ifNoneMatch: c.req.header('if-none-match') ?? null,
  }),
);

/**
 * The lead form's target.
 *
 * `form-action 'self'` in the tenant CSP means a contact form must post to the tenant origin, so
 * this endpoint exists to hand the submission to the API — which is where the per-site origin
 * allowlist, the rate limit keyed on `siteId`, the honeypot check and the spam scoring live. This
 * Worker adds exactly one thing, and it is the important one: **the site id comes from the KV
 * manifest, never from the request**, so a visitor cannot post a lead into another tenant's inbox
 * by editing a hidden field.
 *
 * Lead forms deliberately carry no Turnstile widget (§8): a free-plan widget covers ten hostnames
 * and "Any Hostname" is Enterprise, so the whole approach collapses the moment a customer attaches
 * their own domain — which is the headline Phase 3 feature.
 */
app.post('/_f/lead', async (c) => {
  const site = c.get('site');
  const origin = c.req.header('origin');
  // Same-origin only, by exact match. Never a suffix test: `/mijnsaas\.com$/` matches
  // `evilmijnsaas.com`, and that is a working CSRF against every tenant at once.
  if (origin !== `https://${c.get('host')}`) {
    return c.json({ error: 'origin_not_allowed' }, 403);
  }

  const forwarded = new Request(`https://api.internal/v1/leads/${site.siteId}`, {
    method: 'POST',
    headers: {
      'content-type': c.req.header('content-type') ?? 'application/json',
      origin,
      // A service-binding fetch does not carry the original `cf` object, and the API's rate limit
      // and IP hashing need the visitor's address.
      'cf-connecting-ip': c.req.header('cf-connecting-ip') ?? '',
    },
    body: c.req.raw.body,
  });
  return c.env.API.fetch(forwarded);
});

/** Everything else is a document. */
app.get('*', async (c) => {
  const url = new URL(c.req.url);
  const site = c.get('site');
  const host = c.get('host');

  if (url.pathname === `/${c.env.INDEXNOW_KEY}.txt`) return serveIndexNowKey(c.env.INDEXNOW_KEY);

  const route = routePath(url.pathname, site);
  if (route.kind === 'canonicalise') return c.redirect(`${route.to}${url.search}`, 301);

  const target =
    route.kind === 'root'
      ? rootTarget(site)
      : route.kind === 'page'
        ? pageTarget(site, route.locale, route.path)
        : null;

  // A 404 is still counted. A broken internal link is exactly the kind of thing that shows up in
  // this dataset and nowhere else, because there is no client-side error beacon to report it.
  const response =
    target === null
      ? neutralNotFound()
      : await serveDocument({
          manifest: site,
          target,
          blobs: c.env.BLOBS,
          cache: defaultCache(),
          ifNoneMatch: c.req.header('if-none-match') ?? null,
          now: Date.now(),
          waitUntil: (promise) => c.executionCtx.waitUntil(promise),
        });

  const locale = route.kind === 'page' ? route.locale : site.defaultLocale;
  const cacheStatus = response.headers.get('x-cache');
  recordPageView(c.env.AE, {
    manifest: site,
    host,
    pathname: url.pathname,
    locale,
    status: response.status,
    cache: cacheStatus === 'hit' || cacheStatus === 'miss' ? cacheStatus : 'bypass',
    country: countryOf(c.req.raw),
  });

  return response;
});

app.notFound(() => neutralNotFound());

/**
 * The last line of defence.
 *
 * Logs the shape of the failure and nothing else. Log redaction is mandatory (§8) and a tenant page
 * URL can carry a business name, so the path is logged but never the query string or any header.
 */
app.onError((error, c) => {
  console.error('renderer_error', {
    path: new URL(c.req.url).pathname,
    name: error.name,
    message: error.message,
  });
  return new Response('Temporarily unavailable\n', {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
});

export default app;
