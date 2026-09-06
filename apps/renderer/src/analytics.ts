import type { RoutingManifest } from '@aibuilder/core';

import type { CacheStatus } from './cache';

/**
 * One Analytics Engine data point per request, written from `ctx.waitUntil`.
 *
 * FIRST-PARTY, SERVER-SIDE, ZERO CLIENT BYTES. This is the resolution of the three-way
 * contradiction between the design dimensions (§3a step 8, §7.22): the Cloudflare Web Analytics
 * beacon is itself a third-party script served from `static.cloudflareinsights.com`, so it is
 * banned on tenant sites — it would break the zero-third-party-origin rule, add a request to the
 * critical path, and raise a consent question that this product's whole "no cookie banner by
 * default" position depends on not having.
 *
 * WHAT IS NOT RECORDED. No IP, raw or hashed. No user agent. No referrer. No query string. A
 * two-letter country from Cloudflare's own edge is the finest granularity here, and it is on the
 * request already. The point of this dataset is "which pages of which sites are being read, and is
 * the cache working" — not who is reading them, which we have no need for and no lawful basis to
 * collect on a tenant's behalf without the banner we are avoiding.
 *
 * Fire-and-forget by construction: `writeDataPoint` is synchronous and returns nothing, and a
 * failure to record a page view must never affect the page view.
 */
export function recordPageView(
  dataset: AnalyticsEngineDataset,
  event: {
    readonly manifest: RoutingManifest;
    readonly host: string;
    readonly pathname: string;
    readonly locale: string;
    readonly status: number;
    readonly cache: CacheStatus;
    readonly country: string;
  },
): void {
  try {
    dataset.writeDataPoint({
      // Sampling and grouping are per site. Analytics Engine allows one index of up to 96 bytes,
      // and a 30-character site id is the only value worth spending it on.
      indexes: [event.manifest.siteId],
      blobs: [
        event.host,
        event.pathname,
        event.locale,
        event.manifest.liveVersion,
        event.manifest.indexState,
        event.cache,
        event.country,
      ],
      doubles: [event.status, 1],
    });
  } catch {
    // Telemetry that can fail a page view is worse than no telemetry.
  }
}

/** The visitor's country as Cloudflare resolved it, or `'XX'` when the edge did not say. */
export function countryOf(request: Request): string {
  const cf = (request as Request & { readonly cf?: { readonly country?: string } }).cf;
  const country = cf?.country;
  return typeof country === 'string' && country.length === 2 ? country : 'XX';
}
