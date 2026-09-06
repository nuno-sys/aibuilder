import { DOCUMENT_CACHE_CONTROL, EDGE_CACHE_CONTROL } from './headers';

/**
 * The edge cache, keyed on a synthetic URL that begins with the site id.
 *
 * THE KEY IS THE WHOLE SAFETY ARGUMENT. The default Workers cache key is derived from the request
 * URL **excluding the host**, which means two tenants asking for `/nl/diensten/` share a cache
 * entry. Any design that leans on `Cloudflare-CDN-Cache-Control` for tenant HTML therefore serves
 * one bakery's page on every other tenant's domain — architecture §3a step 4, adopted from the SEO
 * critique's fatal #1. `core/routing.ts` builds `https://c.internal/{siteId}/{version}/…` and this
 * module is the only place that stores or reads a tenant response.
 *
 * The cached copy and the delivered copy carry DIFFERENT cache directives, on purpose. The stored
 * copy gets a year, because the version is in the key and a new publish is a new key; the browser
 * gets sixty seconds with a ten-minute stale-while-revalidate window, because a visitor should see
 * a republish quickly. Storing the browser's short directive would make the edge re-read R2 every
 * minute for a document that cannot have changed.
 */

/** The subset of the Cache API this Worker uses. Narrowed so a test double is three lines. */
export interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

/** The ambient default cache, or `null` where the runtime has none (a bare unit test). */
export function defaultCache(): CacheLike | null {
  const store: unknown = (globalThis as { caches?: { default?: unknown } }).caches?.default;
  if (store === undefined || store === null) return null;
  return store as CacheLike;
}

/** A cache key is a GET `Request` — the Cache API refuses anything else. */
export function cacheRequest(keyUrl: string): Request {
  return new Request(keyUrl, { method: 'GET' });
}

/** Whether a response came from the edge cache. Emitted as a header and as an analytics blob. */
export type CacheStatus = 'hit' | 'miss' | 'bypass';

/** What a cached lookup produced. */
export interface CacheLookup {
  readonly response: Response | null;
  readonly status: CacheStatus;
}

/** Reads the cache, returning a `bypass` when the runtime has no cache at all. */
export async function lookup(cache: CacheLike | null, keyUrl: string): Promise<CacheLookup> {
  if (cache === null) return { response: null, status: 'bypass' };
  const hit = await cache.match(cacheRequest(keyUrl));
  return hit === undefined ? { response: null, status: 'miss' } : { response: hit, status: 'hit' };
}

/**
 * Stores a response under the synthetic key, with the long internal directive.
 *
 * The body is cloned rather than consumed: the caller still has to return it. A `put` failure is
 * swallowed — a cache that will not accept an entry must never turn a successful page into a 500.
 */
export async function store(
  cache: CacheLike | null,
  keyUrl: string,
  response: Response,
): Promise<void> {
  if (cache === null) return;
  const storable = new Response(response.clone().body, response);
  storable.headers.set('cache-control', EDGE_CACHE_CONTROL);
  // The delivered copy carries these; the stored copy must not, or a HIT would replay a header
  // computed for a different request.
  storable.headers.delete('x-cache');
  try {
    await cache.put(cacheRequest(keyUrl), storable);
  } catch {
    // See the JSDoc.
  }
}

/**
 * Rewrites a response for delivery to a browser.
 *
 * Applied to both a fresh response and a cache hit, so the two are byte-identical from the
 * visitor's point of view — which is what makes a HIT indistinguishable from a MISS except in
 * latency, and what stops the year-long internal directive ever reaching a browser.
 */
export function forDelivery(response: Response, status: CacheStatus): Response {
  const delivered = new Response(response.body, response);
  delivered.headers.set('cache-control', DOCUMENT_CACHE_CONTROL);
  delivered.headers.set('x-cache', status);
  // Never `Cloudflare-CDN-Cache-Control` on tenant HTML. See the module header.
  delivered.headers.delete('cloudflare-cdn-cache-control');
  return delivered;
}
