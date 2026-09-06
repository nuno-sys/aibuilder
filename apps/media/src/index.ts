import { ASSET_PREFIX, assetContentType, assetR2Key, parseAssetPath } from '@aibuilder/core';
import { Hono } from 'hono';

import type { AppEnv } from './env';
import { IMMUTABLE_CACHE_CONTROL, applyMediaHeaders } from './headers';

/**
 * `aibuilder-media` — `cdn.mijnsaas.com`.
 *
 * WHAT IT IS FOR, GIVEN THAT TENANT PAGES DO NOT USE IT. A generated site references its images
 * through the renderer's own `/_a/` path, because `img-src 'self'` and the zero-third-party-origin
 * rule (§7.22, §7.24) both require same-origin assets. This host exists for the consumers that
 * cannot use a relative path: the dashboard and the live editor on the control-plane domain, the
 * preview surface, and anything that needs an absolute, cacheable URL for an uploaded image.
 *
 * ONE GRAMMAR, TWO SPELLINGS. The path is parsed by the same `parseAssetPath` the renderer uses, so
 * there is exactly one definition of what an asset URL means and one mapping from it to an R2 key.
 * A bare `/i/{sha}/800.avif` is accepted as well as `/_a/i/{sha}/800.avif`, because a CDN host
 * carrying the renderer's internal prefix would be a strange thing to print in a `srcset` — but
 * both spellings go through the same validation, and anything that is not one of the five closed
 * asset shapes is a 404 before the bucket is touched.
 */
const app = new Hono<AppEnv>();

/** The header set, applied outermost so the 404 and 405 paths carry it too. */
app.use('*', async (c, next) => {
  await next();
  applyMediaHeaders(c.res.headers, {
    host: new URL(c.req.url).hostname,
    rootDomain: c.env.SITES_ROOT_DOMAIN,
  });
});

/**
 * Normalises the two accepted spellings onto the one grammar.
 *
 * Prefixing rather than accepting a second parser: the validation — a 64-hex digest, a width from
 * the derivative ladder, a format from the encoder list — must be identical on both hosts, and the
 * only way to guarantee that is for there to be one function.
 */
export function normaliseAssetPath(pathname: string): string {
  return pathname.startsWith(ASSET_PREFIX)
    ? pathname
    : `${ASSET_PREFIX}${pathname.replace(/^\/+/u, '')}`;
}

app.on(['GET', 'HEAD'], '*', async (c) => {
  const request = parseAssetPath(normaliseAssetPath(new URL(c.req.url).pathname));
  if (request === null) return notFound();

  const object = await c.env.MEDIA.get(assetR2Key(request));
  if (object === null) return notFound();

  const headers = new Headers({
    // FORCED. Never `object.httpMetadata.contentType`, which is whatever was set at write time,
    // and never negotiated. See the header of `headers.ts`.
    'content-type': assetContentType(request),
    'cache-control': IMMUTABLE_CACHE_CONTROL,
    etag: object.httpEtag,
    // Same-origin embedding is not the use case; these objects are fetched by pages on other hosts.
    'access-control-allow-origin': '*',
  });

  if (matchesEtag(c.req.header('if-none-match') ?? null, object.httpEtag)) {
    return new Response(null, { status: 304, headers });
  }

  // HEAD is answered by the runtime discarding the body, so the same construction serves both and
  // the two can never disagree about a header.
  return new Response(object.body, { status: 200, headers });
});

/** Nothing here is writable. A write attempt is a 405, not a 404, so a misconfigured client sees it. */
app.all(
  '*',
  () =>
    new Response('Method not allowed\n', {
      status: 405,
      headers: { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' },
    }),
);

/** Neutral 404: says nothing about whether the shape or the object was the problem. */
function notFound(): Response {
  return new Response('Not found\n', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * Weak `If-None-Match` comparison.
 *
 * R2's `httpEtag` is a strong tag around the object's own digest, and a strong comparison would be
 * correct here — but a client that stripped the quotes or added a `W/` prefix would then re-download
 * an immutable object, which is the one thing this host exists to avoid.
 */
function matchesEtag(ifNoneMatch: string | null, etag: string): boolean {
  if (ifNoneMatch === null) return false;
  const candidate = etag.replace(/^W\//u, '');
  return ifNoneMatch
    .split(',')
    .map((value) => value.trim().replace(/^W\//u, ''))
    .some((value) => value === '*' || value === candidate);
}

app.onError((error, c) => {
  console.error('media_error', {
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
