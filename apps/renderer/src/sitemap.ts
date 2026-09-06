import {
  SITEMAP_PREFIX,
  cacheKeyUrl,
  localeByUrlSegment,
  sitemapIndexKey,
  sitemapKey,
} from '@aibuilder/core';
import type { Locale, RoutingManifest } from '@aibuilder/core';

import { forDelivery, lookup, store } from './cache';
import type { CacheLike } from './cache';
import { neutralNotFound } from './serve';

/**
 * Serving the sitemaps, which are materialised at publish rather than built per request.
 *
 * THE `.xml.br` KEY IS A MISNOMER AND THE OBJECT IS NOT BROTLI. `core/keys.ts` named it in the
 * expectation that publish would pre-compress, and it cannot: there is no brotli anywhere in a
 * Worker, because `CompressionStream` is gzip and deflate only (§0, "there is no build compute in
 * this stack"). The object is therefore stored uncompressed and the edge compresses it on the way
 * out, exactly as it does the HTML. This handler declares a `Content-Encoding` only when the stored
 * object actually carries one, so the day the key is renamed — or the day a pre-compressed object
 * does appear — nothing here has to change and nothing is ever mislabelled.
 *
 * A withdrawn or unindexed site does not serve a sitemap at all. `robots.txt` already declines to
 * advertise one in those states, and answering with the file anyway would hand a crawler the exact
 * list of URLs the site is trying to keep out of, or remove from, the index.
 */

/** True when this site should serve sitemaps at all. */
export function sitemapsAvailable(manifest: RoutingManifest): boolean {
  return manifest.indexState === 'indexable';
}

/** Resolves `/sitemaps/{segment}.xml` to a locale this site publishes, or `null`. */
export function localeFromSitemapPath(pathname: string, manifest: RoutingManifest): Locale | null {
  if (!pathname.startsWith(SITEMAP_PREFIX) || !pathname.endsWith('.xml')) return null;
  const segment = pathname.slice(SITEMAP_PREFIX.length, -'.xml'.length);
  const definition = localeByUrlSegment(segment);
  if (definition === null) return null;
  return manifest.locales.includes(definition.code) ? definition.code : null;
}

/** Serves the sitemap index or one locale's urlset from R2, through the same synthetic cache key. */
export async function serveSitemap(args: {
  readonly manifest: RoutingManifest;
  readonly locale: Locale | null;
  readonly blobs: R2Bucket;
  readonly cache: CacheLike | null;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}): Promise<Response> {
  if (!sitemapsAvailable(args.manifest)) return neutralNotFound();

  const key =
    args.locale === null
      ? sitemapIndexKey({ siteId: args.manifest.siteId, versionId: args.manifest.liveVersion })
      : sitemapKey({
          siteId: args.manifest.siteId,
          versionId: args.manifest.liveVersion,
          locale: args.locale,
        });

  const cacheUrl = cacheKeyUrl({
    siteId: args.manifest.siteId,
    liveVersion: args.manifest.liveVersion,
    variant: args.locale === null ? 'sitemap-index' : `sitemap-${args.locale}`,
  });

  const cached = await lookup(args.cache, cacheUrl);
  let base = cached.response ?? null;

  if (base === null) {
    const object = await args.blobs.get(key);
    if (object === null) return neutralNotFound();
    const headers = new Headers({
      'content-type': 'application/xml; charset=utf-8',
      etag: object.httpEtag,
    });
    const encoding = object.httpMetadata?.contentEncoding;
    if (encoding !== undefined && encoding.length > 0) headers.set('content-encoding', encoding);
    base = new Response(object.body, { status: 200, headers });
    if (args.cache !== null) args.waitUntil(store(args.cache, cacheUrl, base));
  }

  return forDelivery(base, cached.status);
}
