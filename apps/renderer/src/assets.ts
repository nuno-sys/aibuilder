import { assetContentType, assetR2Key, parseAssetPath } from '@aibuilder/core';

import { ASSET_CACHE_CONTROL } from './headers';
import { matchesEtag, neutralNotFound } from './serve';

/**
 * `/_a/*` — media derivatives, served from the tenant's own origin.
 *
 * WHY SAME-ORIGIN RATHER THAN `cdn.`. Two §7 rules force it. `img-src 'self'` in the tenant CSP is
 * only satisfiable when images come from the tenant host, and the zero-third-party-origin rule
 * (§7.22) counts `cdn.mijnsaas.com` as a third origin relative to `<slug>.mijnsaas.com` — a DNS
 * lookup and a TLS handshake on the LCP path, for an object we already own. Serving derivatives
 * here also means nothing is transformed at request time, which converts a recurring
 * image-transformation meter into a one-time cost at publish (§7.24).
 *
 * EVERY PART OF THE KEY IS VALIDATED BEFORE IT IS BUILT. `parseAssetPath` accepts only a 64-hex
 * digest, a width from the derivative ladder and a format from the encoder list, so the R2 key this
 * handler passes to `get()` cannot contain anything the visitor chose. The `Content-Type` is then
 * forced from a closed table keyed on that same parsed shape — never from the object, never from
 * the request, never sniffed. Combined with `nosniff`, that is what stops an uploaded file being
 * interpreted as a document.
 */
export async function serveAsset(args: {
  readonly pathname: string;
  readonly media: R2Bucket;
  readonly ifNoneMatch: string | null;
}): Promise<Response> {
  const request = parseAssetPath(args.pathname);
  if (request === null) return neutralNotFound();

  const object = await args.media.get(assetR2Key(request));
  if (object === null) return neutralNotFound();

  const headers = new Headers({
    'content-type': assetContentType(request),
    // Content-addressed, therefore immutable, therefore safe for a year. A re-upload of different
    // bytes is a different digest and therefore a different URL.
    'cache-control': ASSET_CACHE_CONTROL,
    etag: object.httpEtag,
    'x-content-type-options': 'nosniff',
  });

  if (matchesEtag(args.ifNoneMatch, object.httpEtag)) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(object.body, { status: 200, headers });
}
