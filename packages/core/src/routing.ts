import type { ImageFormat, ImageWidth, VideoFormat } from './keys';
import {
  IMAGE_FORMATS,
  IMAGE_WIDTHS,
  VIDEO_FORMATS,
  mediaImageKey,
  mediaOriginalKey,
  mediaPosterKey,
  mediaVideoKey,
} from './keys';
import type { Locale } from './locales';
import { LOCALES, isLocale, localeUrlSegment } from './locales';

/**
 * Host resolution and the tenant cache key — the two pieces of the tenant read path that decide
 * which site a request belongs to.
 *
 * Architecture §3a in full: a visitor's request is KV -> Cache -> R2 and **never** D1. One
 * `KV_ROUTING.get(host)` serves the whole site, so everything the renderer needs to answer a
 * request has to be inside the manifest this module defines. That is why the manifest carries the
 * locale list and the index state rather than a pointer to a row that would have to be read.
 *
 * TWO PROPERTIES IN HERE ARE SECURITY BOUNDARIES, NOT CONVENIENCES.
 *
 * 1. **An unrecognised `Host` is a neutral 404 and is never served a default site.** A wildcard
 *    route answers for every hostname pointed at the zone, including ones we have never heard of.
 *    Serving "some site" for an unknown host is how a platform ends up hosting a phishing page on a
 *    hostname its owner never authorised, and how one tenant's content appears under another's
 *    domain. `resolveHost()` returns `unknown` for a KV miss and there is no fallback branch.
 *
 * 2. **The cache key begins with `siteId`.** The default Workers cache key is derived from the
 *    request URL *excluding the host*, so any design that relies on `Cloudflare-CDN-Cache-Control`
 *    for tenant HTML serves one bakery's `/nl/` on every other tenant's domain (architecture §3a
 *    step 4, adopted from the SEO critique's fatal #1). The renderer therefore caches on the
 *    synthetic URL this module builds — `siteId` first, then the version — and **never** sets
 *    `Cloudflare-CDN-Cache-Control` on tenant HTML.
 *
 * Because the version is part of the key, publishing is a pointer flip: old entries become
 * unreachable and age out on their own. There is no purge call, no purge quota and no purge race.
 */

/* -- The manifest ----------------------------------------------------------------------------- */

/**
 * Indexability of a site, mirroring `IndexState` in `@aibuilder/db`'s `types.ts`.
 *
 * Declared here rather than imported because `core` deliberately carries no dependency on `db`:
 * this package has to stay loadable in a plain runner with no Cloudflare types (its `tsconfig.json`
 * lists `types: ["node"]`, which is what keeps a binding out of the domain layer). The generator's
 * publish step holds both packages, so a divergence between the two unions is a compile error at
 * the one call site that bridges them.
 */
export const INDEX_STATES = ['noindex', 'eligible', 'indexable', 'gone'] as const;

/** How a site may be crawled and indexed. */
export type IndexState = (typeof INDEX_STATES)[number];

/** Narrows an untrusted value — a KV blob, a D1 column — to an `IndexState`. */
export function isIndexState(value: unknown): value is IndexState {
  return typeof value === 'string' && (INDEX_STATES as readonly string[]).includes(value);
}

/**
 * Version stamp of the KV manifest shape.
 *
 * A manifest written by an older deploy must be *recognised as old*, not misread. `parseRoutingManifest`
 * rejects any other value, and a rejected manifest is a 404 rather than a half-understood site —
 * which is the correct failure for a shape change that has not finished rolling out.
 */
export const ROUTING_MANIFEST_VERSION = 1;

/**
 * Everything the renderer knows about a host, from one KV read.
 *
 * Deliberately small: it is read on every request to every tenant page, and KV value size is on the
 * critical path of the first byte. Anything that can be derived (the R2 keys, the canonical URL,
 * the robots body) is derived rather than stored.
 */
export interface RoutingManifest {
  readonly v: typeof ROUTING_MANIFEST_VERSION;
  /** `ste_…`. The first component of every cache key, which is what makes the cache tenant-safe. */
  readonly siteId: string;
  /** Where this tenant's rows live. Carried so the lead-form forward does not need a lookup. */
  readonly shardId: number;
  /** `org_…`. Needed by the lead endpoint's authorisation, never by the read path. */
  readonly orgId: string;
  /** The published version id. Part of the cache key, so a flip retires every cached entry. */
  readonly liveVersion: string;
  /** The host every canonical URL, sitemap entry and JSON-LD `@id` is built from. */
  readonly canonicalHost: string;
  /** Locales this site publishes, in display order. `/` serves `defaultLocale`. */
  readonly locales: readonly Locale[];
  readonly defaultLocale: Locale;
  readonly indexState: IndexState;
  /**
   * When `indexState` first became `gone`, or `null`.
   *
   * The withdrawal sequence in `robots.ts` counts from this: `200 + noindex, follow` for the grace
   * window so the removal signal is actually crawled, then `410`. It lives in the manifest because
   * the renderer has no D1 binding and therefore no other way to know how long a site has been
   * withdrawn (architecture §3a, §7.9).
   */
  readonly goneAt: number | null;
  /** When the pointer was flipped. Used only for observability and cache diagnostics. */
  readonly publishedAt: number;
}

/* -- Hosts ------------------------------------------------------------------------------------ */

/** One DNS label: 1-63 characters, no leading or trailing hyphen. Punycode arrives already ASCII. */
const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/**
 * Normalises a `Host` header into the form KV is keyed on, or `null` when it is not a hostname.
 *
 * Case, a trailing dot and an explicit port are all legal in a `Host` header and all address the
 * same site; treating them as different keys would produce a KV miss and therefore a 404 on a
 * perfectly valid request. Everything else is rejected rather than repaired: a `Host` containing a
 * slash, whitespace or a userinfo section is an attempt to make the key mean something other than a
 * hostname, and the correct answer to that is "unknown host".
 *
 * IP literals are rejected on purpose. Nothing in this product is ever addressed by IP, and an IPv6
 * literal in a KV key is a shape nobody has thought about.
 */
export function normaliseHost(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 260) return null;

  // Strip an explicit port, but only a numeric one — `example.com:evil` is not a host with a port.
  const portIndex = trimmed.lastIndexOf(':');
  const hostPart = portIndex === -1 ? trimmed : trimmed.slice(0, portIndex);
  if (portIndex !== -1 && !/^\d{1,5}$/u.test(trimmed.slice(portIndex + 1))) return null;

  const withoutRootDot = hostPart.endsWith('.') ? hostPart.slice(0, -1) : hostPart;
  if (withoutRootDot.length === 0 || withoutRootDot.length > 253) return null;

  const labels = withoutRootDot.split('.');
  if (labels.length < 2) return null;
  for (const label of labels) {
    if (!LABEL_PATTERN.test(label)) return null;
  }
  // A trailing all-numeric label means an IPv4 literal; nothing here is addressed that way.
  const last = labels[labels.length - 1];
  if (last === undefined || /^\d+$/u.test(last)) return null;
  return withoutRootDot;
}

/**
 * The KV key one host is stored under.
 *
 * Architecture §3a says `KV_ROUTING.get(host)`, and this is that — as a function, so the
 * normalisation the writer applied and the normalisation the reader applies cannot drift apart.
 * They are the same rule in the same module, which is the only way a key ever stays stable.
 */
export function routingKey(host: string): string {
  return host;
}

/* -- Resolution --------------------------------------------------------------------------------*/

/** What the renderer should do with a request, decided before anything is fetched. */
export type HostResolution =
  | { readonly kind: 'serve'; readonly manifest: RoutingManifest }
  /** `host !== canonicalHost`: exactly one 301, path- and query-preserving. */
  | { readonly kind: 'redirect'; readonly location: string; readonly manifest: RoutingManifest }
  /** No manifest, an unparseable manifest, or a `Host` that is not a hostname. */
  | { readonly kind: 'unknown' };

/**
 * Decides how to answer a request for `host`.
 *
 * There is no branch that serves a site for a host the manifest does not name. A miss is
 * `unknown`, a mismatch between the requested host and the canonical host is one 301, and a match
 * is a serve — those three, and nothing else.
 *
 * The redirect is built from the request's own path and query so that a printed URL keeps working,
 * and it is exactly one hop: the destination is the canonical host, which by definition does not
 * redirect again.
 */
export function resolveHost(args: {
  readonly host: string | null | undefined;
  readonly manifest: RoutingManifest | null;
  readonly pathname: string;
  readonly search: string;
}): HostResolution {
  const host = normaliseHost(args.host);
  if (host === null || args.manifest === null) return { kind: 'unknown' };
  if (host === args.manifest.canonicalHost) return { kind: 'serve', manifest: args.manifest };
  return {
    kind: 'redirect',
    location: `https://${args.manifest.canonicalHost}${args.pathname}${args.search}`,
    manifest: args.manifest,
  };
}

/* -- Serialisation ---------------------------------------------------------------------------- */

/** Serialises a manifest for KV. Key order is fixed so an unchanged manifest is unchanged bytes. */
export function encodeRoutingManifest(manifest: RoutingManifest): string {
  return JSON.stringify({
    v: manifest.v,
    siteId: manifest.siteId,
    shardId: manifest.shardId,
    orgId: manifest.orgId,
    liveVersion: manifest.liveVersion,
    canonicalHost: manifest.canonicalHost,
    locales: manifest.locales,
    defaultLocale: manifest.defaultLocale,
    indexState: manifest.indexState,
    goneAt: manifest.goneAt,
    publishedAt: manifest.publishedAt,
  });
}

/** Reads one string property of an unknown object, or `null`. */
function stringAt(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 && value.length <= 253 ? value : null;
}

/**
 * Parses a KV value into a manifest, or `null`.
 *
 * NEVER THROWS, and that is the whole point. This runs on the tenant read path against a value
 * written by a previous deploy; a throw here is a 500 on a customer's home page for a shape
 * mismatch that a 404 handles correctly. Every field is validated, because a manifest with a
 * missing `liveVersion` would compose an R2 key that reads `sites/ste_…/undefined/…`.
 */
export function parseRoutingManifest(raw: string | null | undefined): RoutingManifest | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const source = parsed as Record<string, unknown>;

  if (source['v'] !== ROUTING_MANIFEST_VERSION) return null;

  const siteId = stringAt(source, 'siteId');
  const orgId = stringAt(source, 'orgId');
  const liveVersion = stringAt(source, 'liveVersion');
  const canonicalHostRaw = stringAt(source, 'canonicalHost');
  const indexState = source['indexState'];
  const defaultLocale = source['defaultLocale'];
  const shardId = source['shardId'];
  const publishedAt = source['publishedAt'];
  const rawLocales = source['locales'];

  if (siteId === null || orgId === null || liveVersion === null || canonicalHostRaw === null) {
    return null;
  }
  const canonicalHost = normaliseHost(canonicalHostRaw);
  if (canonicalHost === null) return null;
  if (!isIndexState(indexState) || !isLocale(defaultLocale)) return null;
  if (!Number.isInteger(shardId) || (shardId as number) < 0) return null;
  if (!Number.isFinite(publishedAt)) return null;
  if (!Array.isArray(rawLocales) || rawLocales.length === 0) return null;

  const locales: Locale[] = [];
  for (const entry of rawLocales) {
    if (!isLocale(entry)) return null;
    if (!locales.includes(entry)) locales.push(entry);
  }
  if (!locales.includes(defaultLocale)) return null;

  // Absent on a manifest written before the withdrawal window existed; `null` is the correct
  // reading of "this site has never been withdrawn", so an old manifest stays valid.
  const goneAtRaw = source['goneAt'];
  const goneAt = typeof goneAtRaw === 'number' && Number.isFinite(goneAtRaw) ? goneAtRaw : null;

  return {
    v: ROUTING_MANIFEST_VERSION,
    siteId,
    shardId: shardId as number,
    orgId,
    liveVersion,
    canonicalHost,
    locales,
    defaultLocale,
    indexState,
    goneAt,
    publishedAt: publishedAt as number,
  };
}

/* -- Path routing ------------------------------------------------------------------------------*/

/** What a request path addresses within a resolved site. */
export type PathRoute =
  /** `/` — a 200 serving the default locale's content, never a redirect (§7.2). */
  | { readonly kind: 'root' }
  /** `/{locale}/…/` — a content page. */
  | { readonly kind: 'page'; readonly locale: Locale; readonly path: string }
  /** A path whose first segment is a locale this site does not publish, or no locale at all. */
  | { readonly kind: 'miss' }
  /** A content path missing its trailing slash. One 301, and only for a locale we publish. */
  | { readonly kind: 'canonicalise'; readonly to: string };

/**
 * Routes a request path within an already-resolved site.
 *
 * `/` is a 200, not a 308. A redirect on the single most-requested, flyer-printed URL of every
 * tenant site is a self-inflicted LCP wound and trips "Avoid multiple page redirects" (§7.2); the
 * cost of doing it properly is one extra R2 object per publish, which is free.
 *
 * The locale is matched against **this site's** enabled list, not against the global registry. A
 * Dutch-only bakery must 404 on `/de/`, not serve its Dutch page under a German URL — a locale that
 * has no translation is omitted from the cluster, never substituted (§7.4), and the same rule has
 * to hold for the router or the sitemap and the server would disagree.
 *
 * Nothing here inspects `Accept-Language` or geography. §7.3 forbids both: Googlebot crawls from US
 * IPs with no meaningful `Accept-Language`, so a language redirect means the Dutch page is never
 * indexed, and `Vary: CF-IPCountry` fragments the cache roughly 200 ways.
 */
export function routePath(pathname: string, manifest: RoutingManifest): PathRoute {
  if (pathname === '/' || pathname === '') return { kind: 'root' };
  if (!pathname.startsWith('/')) return { kind: 'miss' };
  if (pathname.includes('//') || pathname.includes('..')) return { kind: 'miss' };
  if (pathname !== pathname.toLowerCase()) {
    return { kind: 'canonicalise', to: pathname.toLowerCase() };
  }

  const firstSlash = pathname.indexOf('/', 1);
  const segment = firstSlash === -1 ? pathname.slice(1) : pathname.slice(1, firstSlash);

  const locale = manifest.locales.find((code) => localeUrlSegment(code) === segment);
  if (locale === undefined) return { kind: 'miss' };

  // `/nl` addresses the same document as `/nl/`; every content URL carries a trailing slash (§7.1).
  if (firstSlash === -1) return { kind: 'canonicalise', to: `${pathname}/` };
  if (!pathname.endsWith('/')) return { kind: 'canonicalise', to: `${pathname}/` };

  return { kind: 'page', locale, path: pathname.slice(firstSlash) };
}

/**
 * The absolute URL of one page, built from the canonical host.
 *
 * Every canonical link, hreflang entry, sitemap `<loc>` and JSON-LD `@id` in the system goes
 * through this function, so a site that moves to a custom hostname moves all of them at once.
 */
export function absoluteUrl(manifest: RoutingManifest, path: string): string {
  return `https://${manifest.canonicalHost}${path}`;
}

/** The locale-prefixed path of one page, from a locale-local path. `'/'` is the locale home. */
export function localePagePath(locale: Locale, path: string): string {
  const local = path === '' ? '/' : path;
  return `/${localeUrlSegment(locale)}${local}`;
}

/* -- The cache key ---------------------------------------------------------------------------- */

/**
 * The synthetic origin every tenant cache entry is stored under.
 *
 * It is not a real host and is never resolved. Using a constant internal origin plus a path that
 * starts with the site id is what makes the entry unreachable from another tenant's request, since
 * no tenant request can construct this URL.
 */
export const CACHE_ORIGIN = 'https://c.internal';

/**
 * Builds the cache key for one document.
 *
 * `siteId` FIRST, then the version, then the variant. The order is the isolation property: two
 * tenants asking for `/nl/diensten/` produce keys that differ in their first path segment, so
 * neither can read the other's entry however the underlying cache is partitioned.
 *
 * `variant` distinguishes the documents that are not locale pages — the `/` document, `robots.txt`,
 * a sitemap — and is a fixed, code-chosen string, never anything derived from the request.
 */
export function cacheKeyUrl(args: {
  readonly siteId: string;
  readonly liveVersion: string;
  readonly variant: string;
}): string {
  return `${CACHE_ORIGIN}/${encodeURIComponent(args.siteId)}/${encodeURIComponent(
    args.liveVersion,
  )}/${args.variant.replace(/^\/+/u, '')}`;
}

/** Cache key for one locale page. */
export function pageCacheKeyUrl(args: {
  readonly siteId: string;
  readonly liveVersion: string;
  readonly locale: Locale;
  readonly path: string;
}): string {
  return cacheKeyUrl({
    siteId: args.siteId,
    liveVersion: args.liveVersion,
    variant: `p${localePagePath(args.locale, args.path)}`,
  });
}

/* -- hreflang ---------------------------------------------------------------------------------- */

/** One member of an hreflang cluster. */
export interface HreflangLink {
  /** `nl`, `de`, or the literal `x-default`. */
  readonly hreflang: string;
  readonly href: string;
}

/**
 * Builds the hreflang cluster for one page.
 *
 * THE RULE IS OMIT, NEVER SUBSTITUTE (§7.4). A locale that has no translation of *this* page is
 * absent from the cluster. The tempting alternative — pointing `hreflang="de"` at the Dutch page so
 * the cluster "looks complete" — makes one entry non-reciprocal, and a single non-reciprocal entry
 * causes Google to discard the entire cluster. An incomplete cluster works; a wrong one does not.
 *
 * Every member lists every member **including itself**, which is why the self entry is not special
 * cased out. `x-default` points at `/` — the bare-domain document, which is a 200 serving the
 * default locale (§7.2) — and is emitted only when the page has a translation in the default
 * locale, because `/` renders that translation and pointing `x-default` at a page that does not
 * exist there would be exactly the substitution this rule forbids.
 */
export function hreflangCluster(args: {
  readonly manifest: RoutingManifest;
  /** The locales this page actually has, in any order. Anything not enabled is ignored. */
  readonly available: readonly Locale[];
  /** Locale-local path of the page (`'/'`, `'/diensten/'`), identical across locales in shape. */
  readonly pathFor: (locale: Locale) => string | null;
}): readonly HreflangLink[] {
  const links: HreflangLink[] = [];
  const available = new Set<Locale>(args.available);

  // Iterated over the registry order, not the input order, so the emitted cluster is byte-stable
  // across publishes regardless of how the caller collected the locales.
  for (const definition of LOCALES) {
    const locale = definition.code;
    if (!args.manifest.locales.includes(locale)) continue;
    if (!available.has(locale)) continue;
    const path = args.pathFor(locale);
    if (path === null) continue;
    links.push({ hreflang: definition.hreflang, href: absoluteUrl(args.manifest, path) });
    for (const alias of definition.hreflangAliases) {
      links.push({ hreflang: alias, href: absoluteUrl(args.manifest, path) });
    }
  }

  if (available.has(args.manifest.defaultLocale) && args.pathFor(args.manifest.defaultLocale)) {
    const isHome =
      args.pathFor(args.manifest.defaultLocale) ===
      localePagePath(args.manifest.defaultLocale, '/');
    // `x-default` is the bare domain, and the bare domain only exists for the home page.
    if (isHome) links.push({ hreflang: 'x-default', href: absoluteUrl(args.manifest, '/') });
  }

  return links;
}

/* -- Asset routing ----------------------------------------------------------------------------- */

/**
 * Prefix every media derivative is served under, on the tenant's own origin.
 *
 * Same-origin, and that is the point (§7.24): `img-src 'self'` in the tenant CSP is only true if
 * images come from the tenant host, and §7.22's zero-third-party-origin rule counts `cdn.` as a
 * third origin relative to `<slug>.mijnsaas.com`. Serving derivatives here also converts a
 * recurring image-transformation meter into a one-time cost at publish, because the objects are
 * already in R2 and nothing transforms them at request time.
 *
 * `cdn.mijnsaas.com` still exists and is still served by `apps/media`, for the consumers that
 * cannot use a relative path — the dashboard, the preview surface and anything embedding a tenant
 * image off-site.
 */
export const ASSET_PREFIX = '/_a/';

/**
 * R2 prefix the media library is uploaded under.
 *
 * One writer (`scripts/media-library/upload.mjs`) and one reader (`assetR2Key`), so the prefix is
 * stated once here rather than spelled into either of them.
 */
export const LIBRARY_PREFIX = 'library/';

/** One addressable asset. Every field is validated before it is turned back into an R2 key. */
export type AssetRequest =
  | {
      readonly kind: 'image';
      readonly sha256: string;
      readonly width: ImageWidth;
      readonly format: ImageFormat;
    }
  | { readonly kind: 'poster'; readonly sha256: string; readonly format: ImageFormat }
  | { readonly kind: 'video'; readonly sha256: string; readonly format: VideoFormat }
  | { readonly kind: 'original'; readonly sha256: string }
  /** A self-hosted font file. Never a font CDN (§7.21). */
  | { readonly kind: 'font'; readonly file: string }
  /**
   * A platform brand file — the default favicon set.
   *
   * Shared across tenants and uploaded once by the bootstrap script, exactly like the fonts. A
   * per-tenant favicon needs a PNG or SVG derivative, and the publish-time ladder produces
   * `avif`/`webp`/`jpg` only, so per-tenant icons arrive with the editor's branding panel rather
   * than being faked from a JPEG here.
   */
  | { readonly kind: 'brand'; readonly file: string }
  /**
   * One object of the pre-built media library — a hero clip's encode or a poster rung.
   *
   * Not content-addressed, and deliberately so. Library objects are OUR build output, uploaded once
   * and shared by every tenant, so a digest would buy nothing and would make the catalogue churn on
   * every re-encode. The key is a path the ingest produced (`video/<group>/<name>-<role>.av1.webm`,
   * `poster/<group>/<name>-<width>.avif`), which is why `LIBRARY_KEY_PATTERN` is a closed shape
   * rather than a sanity check: it is the only thing standing between a request path and an R2 key.
   */
  | { readonly kind: 'library'; readonly key: string };

/** A font filename: the build step's own output, so a closed shape rather than a free string. */
const FONT_FILE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}\.woff2$/u;

/** A brand filename. Same reasoning as the font pattern: our own build output, closed shape. */
const BRAND_FILE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}\.(?:png|svg|ico)$/u;

/**
 * A media-library key, as the ingest writes it.
 *
 * Every segment is bounded and the alphabet excludes `.` in the directory positions, so the pattern
 * cannot match a traversal however it is spelled. The extension alternation is the encoder's own
 * output list — `av1.webm` and `h264.mp4` for clips, `avif` and `webp` for stills — which keeps a
 * request for an unbuilt format a 404 at the parse rather than a miss at the bucket.
 */
const LIBRARY_KEY_PATTERN =
  /^(?:video|poster)\/[a-z][a-z_]{1,31}\/[a-z0-9][a-z0-9-]{0,63}\.(?:av1\.webm|h264\.mp4|avif|webp)$/u;

const SHA256_HEX = /^[0-9a-f]{64}$/u;

/**
 * The public URL path of one asset.
 *
 * Content-addressed, therefore immutable, therefore safe to serve with a one-year `immutable`
 * cache directive. The single-letter kind segment keeps the path short — it is repeated in every
 * `srcset` on the page — while making the parse total: a path whose kind is not one of these six
 * is not an asset, and there is no fallback that tries to guess.
 */
export function assetPath(request: AssetRequest): string {
  switch (request.kind) {
    case 'image':
      return `${ASSET_PREFIX}i/${request.sha256}/${String(request.width)}.${request.format}`;
    case 'poster':
      return `${ASSET_PREFIX}p/${request.sha256}.${request.format}`;
    case 'video':
      return `${ASSET_PREFIX}v/${request.sha256}.${request.format}`;
    case 'original':
      return `${ASSET_PREFIX}o/${request.sha256}`;
    case 'font':
      return `${ASSET_PREFIX}f/${request.file}`;
    case 'brand':
      return `${ASSET_PREFIX}b/${request.file}`;
    case 'library':
      return `${ASSET_PREFIX}l/${request.key}`;
  }
}

/**
 * Parses a request path into an asset request, or `null`.
 *
 * EVERY component is validated against a closed set before it is used: the digest against a 64-hex
 * pattern, the width against the derivative ladder, the format against the encoder list. That is
 * what makes `assetR2Key()` safe to call on the result — the key it builds cannot contain anything
 * the caller chose, which is the same guarantee `keys.ts` gives its own inputs.
 */
export function parseAssetPath(pathname: string): AssetRequest | null {
  if (!pathname.startsWith(ASSET_PREFIX)) return null;
  const rest = pathname.slice(ASSET_PREFIX.length);
  if (rest.includes('..') || rest.includes('//')) return null;

  const slash = rest.indexOf('/');
  const kind = slash === -1 ? '' : rest.slice(0, slash);
  const tail = slash === -1 ? '' : rest.slice(slash + 1);
  if (tail.length === 0) return null;

  if (kind === 'i') {
    const parts = tail.split('/');
    const sha256 = parts[0];
    const file = parts[1];
    if (parts.length !== 2 || sha256 === undefined || file === undefined) return null;
    if (!SHA256_HEX.test(sha256)) return null;
    const dot = file.lastIndexOf('.');
    if (dot <= 0) return null;
    const width = Number(file.slice(0, dot));
    const format = file.slice(dot + 1);
    if (!isImageWidth(width) || !isImageFormat(format)) return null;
    return { kind: 'image', sha256, width, format };
  }

  if (kind === 'p' || kind === 'v' || kind === 'o') {
    if (tail.includes('/')) return null;
    if (kind === 'o') {
      return SHA256_HEX.test(tail) ? { kind: 'original', sha256: tail } : null;
    }
    const dot = tail.lastIndexOf('.');
    if (dot <= 0) return null;
    const sha256 = tail.slice(0, dot);
    const format = tail.slice(dot + 1);
    if (!SHA256_HEX.test(sha256)) return null;
    if (kind === 'p') {
      return isImageFormat(format) ? { kind: 'poster', sha256, format } : null;
    }
    return isVideoFormat(format) ? { kind: 'video', sha256, format } : null;
  }

  if (kind === 'f') {
    return FONT_FILE_PATTERN.test(tail) ? { kind: 'font', file: tail } : null;
  }

  if (kind === 'b') {
    return BRAND_FILE_PATTERN.test(tail) ? { kind: 'brand', file: tail } : null;
  }

  if (kind === 'l') {
    return LIBRARY_KEY_PATTERN.test(tail) ? { kind: 'library', key: tail } : null;
  }

  return null;
}

/**
 * The R2 key one asset request addresses.
 *
 * Delegates to `keys.ts` for every shape that module owns, which is what keeps the writer (the
 * media pipeline) and the reader (this renderer) deriving the same string from one function.
 *
 * Fonts are the exception and are built here. They have no `keys.ts` builder because they are not
 * tenant content: they are a fixed set of files uploaded once by the build script that subsets them
 * (§7.21), with one writer and one reader, and inventing a per-tenant key shape for a shared object
 * would be worse than stating the flat prefix.
 */
export function assetR2Key(request: AssetRequest): string {
  switch (request.kind) {
    case 'image':
      return mediaImageKey({
        sha256: request.sha256,
        width: request.width,
        format: request.format,
      });
    case 'poster':
      return mediaPosterKey({ sha256: request.sha256, format: request.format });
    case 'video':
      return mediaVideoKey({ sha256: request.sha256, format: request.format });
    case 'original':
      return mediaOriginalKey(request.sha256);
    case 'font':
      return `fonts/${request.file}`;
    case 'brand':
      return `brand/${request.file}`;
    case 'library':
      return `${LIBRARY_PREFIX}${request.key}`;
  }
}

/**
 * The `Content-Type` an asset is served with — FORCED, never negotiated and never sniffed.
 *
 * The type is a function of the key, and the key was derived by the media pipeline from the
 * database's own validated MIME (`MIME_TO_EXTENSION`), so this is that database fact transported
 * rather than a guess: the user's filename never reached the key, and a `photo.jpg.svg` cannot
 * become an `image/svg+xml` response. That, plus `X-Content-Type-Options: nosniff`, is what stops
 * an uploaded file being interpreted as a document — an SVG is an HTML document, which is why SVG
 * is not in the ladder at all (§8).
 *
 * An `original` has no extension by design (it is content-addressed bytes), so it is served as an
 * opaque octet stream. Nothing renders it; it exists for re-encoding.
 */
export function assetContentType(request: AssetRequest): string {
  switch (request.kind) {
    case 'image':
    case 'poster':
      return IMAGE_CONTENT_TYPES[request.format];
    case 'video':
      return VIDEO_CONTENT_TYPES[request.format];
    case 'original':
      return 'application/octet-stream';
    case 'font':
      return 'font/woff2';
    case 'brand':
      return BRAND_CONTENT_TYPES[extensionOf(request.file)] ?? 'application/octet-stream';
    case 'library':
      return LIBRARY_CONTENT_TYPES[librarySuffixOf(request.key)] ?? 'application/octet-stream';
  }
}

/**
 * Closed MIME table for the library's four output shapes.
 *
 * Keyed on the compound suffix rather than the last extension, because `av1.webm` and `h264.mp4`
 * name a codec as well as a container: the `<source type>` the renderer emits carries the codec
 * string, and a response whose `Content-Type` disagreed with it would be the one mismatch a browser
 * resolves by refusing to play rather than by guessing.
 */
const LIBRARY_CONTENT_TYPES: Readonly<Record<string, string>> = {
  'av1.webm': 'video/webm',
  'h264.mp4': 'video/mp4',
  avif: 'image/avif',
  webp: 'image/webp',
};

/** The suffix of a library key that `LIBRARY_KEY_PATTERN` has already validated. */
function librarySuffixOf(key: string): string {
  const file = key.slice(key.lastIndexOf('/') + 1);
  const dot = file.indexOf('.');
  return dot === -1 ? '' : file.slice(dot + 1);
}

/** Closed MIME table for the brand file set. */
const BRAND_CONTENT_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
};

/** The lowercase extension of a filename that `BRAND_FILE_PATTERN` has already validated. */
function extensionOf(file: string): string {
  return file.slice(file.lastIndexOf('.') + 1);
}

/**
 * Filenames of the platform brand set.
 *
 * A closed list rather than a convention, because `document.tsx` emits all three unconditionally and
 * a typo would put a 404 in the `<head>` of every generated page. `favicon.svg` is the one place in
 * the product where an SVG is served — it is our own file, not tenant input, and `apps/media`'s
 * `default-src 'none'; sandbox` plus `nosniff` still apply to it.
 */
export const BRAND_ICONS = {
  png32: 'icon-32.png',
  svg: 'icon.svg',
  appleTouch: 'icon-180.png',
} as const;

/** Closed MIME table for the image ladder. */
const IMAGE_CONTENT_TYPES: Readonly<Record<ImageFormat, string>> = {
  avif: 'image/avif',
  webp: 'image/webp',
  jpg: 'image/jpeg',
};

/** Closed MIME table for the video renditions. */
const VIDEO_CONTENT_TYPES: Readonly<Record<VideoFormat, string>> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
};

function isImageWidth(value: number): value is ImageWidth {
  return (IMAGE_WIDTHS as readonly number[]).includes(value);
}

function isImageFormat(value: string): value is ImageFormat {
  return (IMAGE_FORMATS as readonly string[]).includes(value);
}

function isVideoFormat(value: string): value is VideoFormat {
  return (VIDEO_FORMATS as readonly string[]).includes(value);
}
