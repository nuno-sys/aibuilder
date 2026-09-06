/**
 * Response headers for the tenant plane.
 *
 * Two things here differ from `apps/api`'s middleware, and both are consequences of *whose* domain
 * this is:
 *
 * 1. **HSTS is conditional.** On our own zone the full `includeSubDomains` policy is correct. On a
 *    customer's custom domain it is not ours to set: `includeSubDomains` would cover hostnames the
 *    customer runs themselves, and `preload` is close to irreversible and would break them the day
 *    they leave us (§S7). So a custom domain gets a plain six-month `max-age` and nothing else.
 * 2. **`Cross-Origin-Opener-Policy` is absent.** It belongs on the app and API surfaces, which have
 *    a session to protect. A tenant marketing site has no cross-origin window relationship worth
 *    isolating, and every header is bytes on the LCP path of a page that is trying to be fast.
 *
 * `Cloudflare-CDN-Cache-Control` appears nowhere in this Worker, and that is a hard rule rather
 * than an omission: the default Workers cache key excludes the host, so relying on it for tenant
 * HTML serves one tenant's page under another tenant's domain (§3a step 4). All caching goes
 * through the synthetic, `siteId`-prefixed key in `cache.ts`.
 */

/** Headers every response from this Worker carries, whatever the outcome. */
export const TENANT_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  // Cross-origin requests get the origin only. The WhatsApp button is a real outbound link, so a
  // full-URL referrer would hand `wa.me` the exact page a visitor was reading.
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=(), fullscreen=(self)',
  // The legacy companion to `frame-ancestors 'none'`, which does not inherit from `default-src`.
  'x-frame-options': 'DENY',
};

/** Two years, with subdomains. Only ever sent for hostnames inside our own tenant zone. */
const HSTS_OWN_ZONE = 'max-age=63072000; includeSubDomains';

/** Six months, nothing else. The most a platform may assert about a domain it does not own. */
const HSTS_CUSTOM_DOMAIN = 'max-age=15768000';

/** True when `host` is the tenant root domain or one of its subdomains. */
export function isOwnZone(host: string, rootDomain: string): boolean {
  return host === rootDomain || host.endsWith(`.${rootDomain}`);
}

/** The `Strict-Transport-Security` value appropriate to this host. */
export function hstsFor(host: string, rootDomain: string): string {
  return isOwnZone(host, rootDomain) ? HSTS_OWN_ZONE : HSTS_CUSTOM_DOMAIN;
}

/**
 * Applies the tenant header set to a response, in place.
 *
 * Set rather than appended, and applied outermost, so no handler can weaken one by accident and so
 * the two responses a per-route helper always misses — the error path and the 404 — carry them too.
 */
export function applyTenantHeaders(
  headers: Headers,
  args: { readonly host: string; readonly rootDomain: string },
): void {
  for (const [name, value] of Object.entries(TENANT_SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  headers.set('strict-transport-security', hstsFor(args.host, args.rootDomain));
}

/**
 * Browser cache policy for a tenant document.
 *
 * One minute fresh, ten minutes stale-while-revalidate. Short because the KV pointer flip is the
 * publish and a visitor should see a new version quickly; `stale-while-revalidate` is what makes
 * that cheap — a repeat visitor inside the window gets an instant response and the revalidation
 * happens off the critical path.
 */
export const DOCUMENT_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=600';

/**
 * Edge cache policy, used only on the internal cached copy.
 *
 * A year, because the key contains the version: a new publish writes a new key and the old entries
 * become unreachable and age out. There is no purge call and no purge race (§3a).
 */
export const EDGE_CACHE_CONTROL = 'public, max-age=31536000';

/** Immutable asset policy. Content-addressed keys, so this is safe to the full year. */
export const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
