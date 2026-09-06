import {
  decodePageMetadata,
  localeDefinition,
  materialisedPageKey,
  pageCacheKeyUrl,
  pageETag,
  rootDocumentKey,
  withdrawalStatus,
  xRobotsTag,
} from '@aibuilder/core';
import type { Locale, RoutingManifest } from '@aibuilder/core';

import { cacheKeyUrl } from '@aibuilder/core';
import { forDelivery, lookup, store } from './cache';
import type { CacheLike } from './cache';

/**
 * Serving one materialised document: KV has already answered, so this is Cache, then R2, then done.
 *
 * `D1 IS NEVER TOUCHED ON THIS PATH` (§3a step 6). Everything a response needs beyond the bytes —
 * the render digest for the `ETag`, the CSP hashes, the preload `Link` header, the locale, the
 * page's own `noindex` flag — travels with the object as R2 custom metadata, written at publish by
 * `core/publish.ts`'s `encodePageMetadata`. That is what keeps the read path at one KV read plus
 * one storage read, and what makes it survivable when the control plane is unavailable.
 */

/** Neutral 404. Deliberately says nothing about whether the host or the path was the problem. */
export function neutralNotFound(): Response {
  return new Response('Not found\n', {
    status: 404,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      // Never cached: an unknown host may become a known one the moment a publish lands, and a
      // cached 404 would outlive the customer's patience.
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

/** The R2 key and cache variant for one route. */
export interface DocumentTarget {
  readonly key: string;
  readonly cacheUrl: string;
  readonly locale: Locale;
}

/**
 * Resolves `/` to the bare-domain document.
 *
 * §7.2: `/` is a **200 serving the default locale's content**, not a 308. It is a separate R2 object
 * rather than an internal alias so that the response is a plain storage read with no branch, and so
 * the cache entry for `/` and the one for `/nl/` are independent — they carry different canonical
 * and `x-default` relationships even though their bytes are the same.
 */
export function rootTarget(manifest: RoutingManifest): DocumentTarget {
  return {
    key: rootDocumentKey({ siteId: manifest.siteId, versionId: manifest.liveVersion }),
    cacheUrl: cacheKeyUrl({
      siteId: manifest.siteId,
      liveVersion: manifest.liveVersion,
      variant: 'root',
    }),
    locale: manifest.defaultLocale,
  };
}

/**
 * Resolves a locale-prefixed content path to its materialised object, or `null`.
 *
 * `null` rather than a throw, because the caller is a request handler and the input is a URL a
 * visitor typed. `routePath()` has already rejected traversal, doubled separators and uppercase,
 * but `keys.ts`'s content-path grammar is stricter still — it allows only lowercase words joined by
 * single hyphens — and a path that satisfies one and not the other is a 404, not a 503. Letting
 * `InvalidKeySegmentError` escape would turn a crafted URL into an error-rate alert.
 */
export function pageTarget(
  manifest: RoutingManifest,
  locale: Locale,
  path: string,
): DocumentTarget | null {
  let key: string;
  try {
    key = materialisedPageKey({
      siteId: manifest.siteId,
      versionId: manifest.liveVersion,
      locale,
      path,
    });
  } catch {
    return null;
  }
  return {
    key,
    cacheUrl: pageCacheKeyUrl({
      siteId: manifest.siteId,
      liveVersion: manifest.liveVersion,
      locale,
      path,
    }),
    locale,
  };
}

/**
 * Serves one document.
 *
 * The order — cache, then R2, then headers — is what the whole architecture is arranged around: a
 * hit costs one to three milliseconds of CPU and zero storage reads, and a miss costs one R2 read
 * from an EU bucket to an EU colo.
 *
 * A conditional request is answered from the `ETag` before the body is touched, which is the
 * cheapest possible 304 and the reason the digest travels in metadata rather than being computed
 * over the bytes.
 */
export async function serveDocument(args: {
  readonly manifest: RoutingManifest;
  readonly target: DocumentTarget;
  readonly blobs: R2Bucket;
  readonly cache: CacheLike | null;
  readonly ifNoneMatch: string | null;
  readonly now: number;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}): Promise<Response> {
  const cached = await lookup(args.cache, args.target.cacheUrl);
  const base = cached.response ?? (await fromStorage(args));
  if (base === null) return neutralNotFound();

  if (cached.response === null && args.cache !== null) {
    // Stored before the delivery rewrite, so the entry carries the long internal directive.
    args.waitUntil(store(args.cache, args.target.cacheUrl, base));
  }

  const delivered = forDelivery(base, cached.status);
  const etag = delivered.headers.get('etag');
  if (etag !== null && matchesEtag(args.ifNoneMatch, etag)) {
    return new Response(null, { status: 304, headers: delivered.headers });
  }

  // A withdrawn site keeps answering 200 for the grace window so the `noindex` is actually crawled,
  // and only then becomes 410 (§7.9). The header is already on the response either way.
  if (
    withdrawalStatus({
      indexState: args.manifest.indexState,
      goneAt: args.manifest.goneAt,
      now: args.now,
    }) === 410
  ) {
    return new Response('Gone\n', {
      status: 410,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex, follow',
      },
    });
  }

  return delivered;
}

/** Reads the document from R2 and builds the response headers from its stored metadata. */
async function fromStorage(args: {
  readonly manifest: RoutingManifest;
  readonly target: DocumentTarget;
  readonly blobs: R2Bucket;
}): Promise<Response | null> {
  const object = await args.blobs.get(args.target.key);
  if (object === null) return null;

  const metadata = decodePageMetadata(object.customMetadata);
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    etag: pageETag(args.manifest.liveVersion, metadata.renderSha256),
    'content-language': localeDefinition(args.target.locale).htmlLang,
  });

  if (metadata.csp !== null) headers.set('content-security-policy', metadata.csp);
  if (metadata.link !== null) headers.set('link', metadata.link);

  const robots = xRobotsTag({
    indexState: args.manifest.indexState,
    pageNoindex: metadata.noindex,
  });
  if (robots !== null) headers.set('x-robots-tag', robots);

  return new Response(object.body, { status: 200, headers });
}

/**
 * Evaluates `If-None-Match` against a weak validator.
 *
 * Weak comparison, per RFC 9110: the stored tag is weak by construction (`pageETag`), so a strong
 * comparison would never match and every conditional request would re-download a page that had not
 * changed. `*` matches anything that exists.
 */
export function matchesEtag(ifNoneMatch: string | null, etag: string): boolean {
  if (ifNoneMatch === null) return false;
  const candidate = etag.replace(/^W\//u, '');
  return ifNoneMatch
    .split(',')
    .map((value) => value.trim().replace(/^W\//u, ''))
    .some((value) => value === '*' || value === candidate);
}
