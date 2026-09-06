/**
 * The response header set for `cdn.mijnsaas.com`.
 *
 * These five headers are the entire security model of this Worker, and each one is doing a specific
 * job against a specific attack on user-uploaded bytes:
 *
 * 1. **`Content-Type`, forced.** Set by the caller from the key shape, never from the object's own
 *    stored metadata and never from the request. The key was derived by the media pipeline from the
 *    database's validated MIME (`MIME_TO_EXTENSION` in `core/keys.ts`), so the type is a database
 *    fact transported rather than a guess — the user's filename never reached the key, and a
 *    `photo.jpg.svg` cannot become an `image/svg+xml`.
 * 2. **`X-Content-Type-Options: nosniff`.** Without it, a browser may override the declared type
 *    from the bytes, which is exactly how a polyglot file becomes a document.
 * 3. **`Content-Security-Policy: default-src 'none'; sandbox`.** If a document *does* somehow get
 *    rendered from this origin, it loads nothing, runs nothing, and is in an opaque origin. An SVG
 *    is an HTML document, which is why SVG is not an accepted upload type at all (§8) — this header
 *    is the second line behind that.
 * 4. **`Cross-Origin-Resource-Policy: cross-origin`.** These objects exist to be embedded by tenant
 *    pages on a different host, so the permissive value is the correct one; stating it explicitly
 *    stops a future default from breaking every generated site at once.
 * 5. **`Strict-Transport-Security`.** Full policy on our own zone only.
 *
 * COOKIELESS BY CONSTRUCTION. Nothing here reads `Cookie` and nothing sets `Set-Cookie`. That is
 * the reason `cdn.` is on the tenant registrable domain and not on the control-plane one: a tenant
 * subdomain can set a `.mijnsaas.com` cookie today, and those cookies would ride along on every
 * asset request — wasted bytes on the LCP path, and a needless cookie-consent question — but they
 * can never reach the surface that holds a session, because that is a different registrable domain
 * entirely (§1.1).
 */

/** Headers every asset response carries. */
export const MEDIA_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
  'cross-origin-resource-policy': 'cross-origin',
  'referrer-policy': 'no-referrer',
};

/** Content-addressed keys are immutable, so a year is safe and a revalidation is never needed. */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** True when `host` is inside the tenant root domain. */
export function isOwnZone(host: string, rootDomain: string): boolean {
  return host === rootDomain || host.endsWith(`.${rootDomain}`);
}

/** The `Strict-Transport-Security` value appropriate to this host. */
export function hstsFor(host: string, rootDomain: string): string {
  return isOwnZone(host, rootDomain) ? 'max-age=63072000; includeSubDomains' : 'max-age=15768000';
}

/** Applies the header set, in place. */
export function applyMediaHeaders(
  headers: Headers,
  args: { readonly host: string; readonly rootDomain: string },
): void {
  for (const [name, value] of Object.entries(MEDIA_HEADERS)) {
    headers.set(name, value);
  }
  headers.set('strict-transport-security', hstsFor(args.host, args.rootDomain));
  // Nothing here is per-visitor, so nothing may be attached to a visitor. Deleting rather than
  // trusting that nothing set one: this is the last place the response passes through.
  headers.delete('set-cookie');
}
