import { cacheKeyUrl, robotsTxt } from '@aibuilder/core';
import type { RoutingManifest } from '@aibuilder/core';

import { forDelivery, lookup, store } from './cache';
import type { CacheLike } from './cache';

/**
 * `robots.txt`, synthesised per `Host` (§7.9).
 *
 * Not a stored object. The body is a pure function of the host and the index state — both of which
 * are already in the manifest this request read — so materialising it at publish would mean
 * rewriting an object every time a site's index state changed, on a path where the index state
 * change is the *only* thing that happened. Synthesising it also means a `gone` flip takes effect
 * as fast as KV propagates, which is the point of having a kill switch.
 *
 * It is still cached on the versioned synthetic key, because the alternative is recomputing three
 * lines of text on every crawler request; and the key includes the version so a republish refreshes
 * it for free.
 */
export async function serveRobots(args: {
  readonly manifest: RoutingManifest;
  readonly host: string;
  readonly cache: CacheLike | null;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}): Promise<Response> {
  const cacheUrl = cacheKeyUrl({
    siteId: args.manifest.siteId,
    liveVersion: args.manifest.liveVersion,
    // THE VARIANT CARRIES EVERY INPUT THE BODY DEPENDS ON, not just the version. Both of the other
    // two change WITHOUT a republish: the index state moves when a site is claimed or withdrawn,
    // and the host moves when a customer attaches their own domain. A variant of only the version
    // would keep serving `Disallow: /` after the claim, and would name the old host in the
    // `Sitemap:` line after the move.
    variant: `robots-${args.manifest.indexState}-${args.host}`,
  });

  const cached = await lookup(args.cache, cacheUrl);
  let base = cached.response ?? null;

  if (base === null) {
    base = new Response(robotsTxt({ host: args.host, indexState: args.manifest.indexState }), {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
    if (args.cache !== null) args.waitUntil(store(args.cache, cacheUrl, base));
  }

  return forDelivery(base, cached.status);
}

/**
 * The IndexNow key file, served at `/<key>.txt`.
 *
 * The protocol verifies a ping by fetching this file from the host that was pinged and checking it
 * contains the key. It is public by design — it proves control of the host, it is not a credential
 * — which is why `INDEXNOW_KEY` is a `var` rather than a secret.
 *
 * Served only for the exact filename. A wildcard `*.txt` handler would let a visitor discover the
 * key by fetching any name and comparing bodies.
 */
export function serveIndexNowKey(key: string): Response {
  return new Response(`${key}\n`, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}
