/**
 * Publish-time performance and safety budgets, measured over the rendered document.
 *
 * These are the §7 non-negotiables that can only be checked once there is HTML: the CSS and JS
 * ceilings (§7.20, §7.23), the zero-third-party-origin rule (§7.22), the poster/video size
 * invariant (§7.17) and the CSP the renderer will send (§7.24). The `audit` step already checks
 * everything a `SiteDoc` alone can prove and lists these as `DEFERRED_CHECKS`; this module is what
 * they were deferred to.
 *
 * EVERYTHING HERE IS PURE AND SYNCHRONOUS. Hashing and compression are the caller's job, injected
 * as measurements, for two reasons. `core` must stay runnable in a plain Node runner with no
 * ambient runtime globals (architecture §2), and — more practically — brotli is not available in a
 * Worker at all: `CompressionStream` is gzip and deflate only. The budget is therefore stated in
 * brotli and *enforced* in gzip, which is sound in the direction that matters, since gzip is never
 * smaller than brotli on the same input. A bundle that passes the gzip ceiling passes the brotli
 * one; the reverse is not assumed anywhere.
 *
 * The analysis is a set of narrow regexes over markup **this system generated**, with fixed
 * attribute order guaranteed by `site-kit` (`PHASE2-SITE-KIT.md` §9.3 rule 2). That is the only
 * context in which parsing HTML with a regex is defensible, and it is worth stating why it is
 * preferred to the alternative: a real parser would be a dependency in the package at the bottom of
 * the render pipeline, and `HTMLRewriter` would tie the check to workerd and make it untestable in
 * the plain runner these budgets are unit-tested in.
 */

/* -- The budgets ------------------------------------------------------------------------------- */

/**
 * Inline CSS ceiling (§7.20). All CSS is inline, so this is also the whole stylesheet budget.
 *
 * Stated as brotli; enforced against a gzip measurement, which is conservative. 11 KB is not a
 * round number chosen for looks: it is what an assembled four-archetype token block plus the
 * components a page actually uses costs, and going over it means the assembly stopped being
 * per-page and started shipping the whole library.
 */
export const CSS_BUDGET_BYTES = 11 * 1024;

/** Total tenant JS (§7.23), one deferred file: hero video attach, mobile nav, form enhancement. */
export const JS_BUDGET_BYTES = 4 * 1024;

/**
 * Hard ceiling on the uncompressed document.
 *
 * Not from §7 — it is the practical bound that keeps a single R2 object servable in one read and
 * keeps the edge cache entry cheap. A page over this is not a budget violation so much as a signal
 * that a section rendered an unbounded array.
 */
export const HTML_BUDGET_BYTES = 512 * 1024;

/** Severity of a budget finding. `error` blocks the publish; `warning` is recorded. */
export type BudgetSeverity = 'error' | 'warning';

/** One budget result. */
export interface BudgetFinding {
  readonly code: string;
  readonly severity: BudgetSeverity;
  readonly measured: number;
  readonly limit: number;
  readonly message: string;
}

/* -- Document analysis ------------------------------------------------------------------------- */

/** One `<link rel="preload">` found in the head, in the order it appeared. */
export interface PreloadHint {
  readonly href: string;
  readonly as: string;
  readonly type: string | null;
  readonly media: string | null;
  readonly fetchPriority: string | null;
  readonly crossOrigin: boolean;
}

/** What one rendered document contains, measured rather than assumed. */
export interface DocumentAnalysis {
  /** UTF-8 byte length of the whole document. */
  readonly htmlBytes: number;
  /** The text of every inline `<style>` block, in document order. */
  readonly inlineStyles: readonly string[];
  /**
   * The text of every EXECUTABLE inline `<script>` block, in document order.
   *
   * A block whose `type` is not a JavaScript MIME type is not executable and is not covered by
   * `script-src` — `application/ld+json` is data, not code. Hashing it would put a pointless ~50
   * bytes in the CSP header of every page and would invalidate that header whenever a business
   * fact changed, so those blocks are reported separately instead.
   */
  readonly inlineScripts: readonly string[];
  /** Non-executable `<script>` blocks, with their declared type. The JSON-LD graph lands here. */
  readonly dataBlocks: readonly { readonly type: string; readonly content: string }[];
  /** `src` of every external script. Must be empty or same-origin (§7.22). */
  readonly externalScripts: readonly string[];
  /** `href` of every `<link rel="stylesheet">`. Must be empty: all CSS is inline (§7.20). */
  readonly stylesheetHrefs: readonly string[];
  /** Every absolute origin referenced by any attribute. Any entry is a third-party origin. */
  readonly externalOrigins: readonly string[];
  /** The preload hints, so the renderer can repeat them as `Link:` response headers (§3a.7). */
  readonly preloads: readonly PreloadHint[];
  /** Count of `on*="…"` attributes. Any is a CSP violation waiting to happen. */
  readonly inlineEventHandlers: number;
}

const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style>/giu;
const SCRIPT_BLOCK = /<script\b([^>]*)>([\s\S]*?)<\/script>/giu;
const LINK_TAG = /<link\b([^>]*)>/giu;
const ABSOLUTE_URL = /\b(?:href|src|srcset|content|poster|action)\s*=\s*"(https?:\/\/[^"]*)"/giu;
const INLINE_HANDLER = /\son[a-z]+\s*=\s*"/giu;

/**
 * Script `type` values a browser will execute.
 *
 * The empty string and an absent attribute both mean "classic script". Everything else — a JSON-LD
 * graph, a speculation-rules block, an import map — is data the parser hands to some other
 * consumer, and `script-src` does not gate it.
 */
const EXECUTABLE_SCRIPT_TYPES = new Set([
  '',
  'module',
  'text/javascript',
  'application/javascript',
  'text/ecmascript',
  'application/ecmascript',
]);

/** Reads one attribute out of a tag's attribute string. Attribute order is fixed by `site-kit`. */
function attribute(attributes: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'iu').exec(attributes);
  return match?.[1] ?? null;
}

/** True when the attribute is present at all, with or without a value. */
function hasAttribute(attributes: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`, 'iu').test(attributes);
}

/**
 * Measures one rendered document.
 *
 * Every regex is anchored on a tag name and reads only quoted attribute values, because `site-kit`
 * emits every attribute quoted and in a fixed order. A document that did not come from `site-kit`
 * is not something this function is expected to survive gracefully — it is not a sanitiser, and
 * nothing downstream treats its output as a security decision.
 */
export function analyseDocument(html: string): DocumentAnalysis {
  const inlineStyles: string[] = [];
  const inlineScripts: string[] = [];
  const dataBlocks: { type: string; content: string }[] = [];
  const externalScripts: string[] = [];
  const stylesheetHrefs: string[] = [];
  const origins = new Set<string>();
  const preloads: PreloadHint[] = [];

  for (const match of html.matchAll(STYLE_BLOCK)) inlineStyles.push(match[1] ?? '');

  for (const match of html.matchAll(SCRIPT_BLOCK)) {
    const attributes = match[1] ?? '';
    const src = attribute(attributes, 'src');
    if (src !== null) {
      externalScripts.push(src);
      continue;
    }
    const type = (attribute(attributes, 'type') ?? '').toLowerCase();
    const content = match[2] ?? '';
    if (EXECUTABLE_SCRIPT_TYPES.has(type)) inlineScripts.push(content);
    else dataBlocks.push({ type, content });
  }

  for (const match of html.matchAll(LINK_TAG)) {
    const attributes = match[1] ?? '';
    const rel = (attribute(attributes, 'rel') ?? '').toLowerCase();
    const href = attribute(attributes, 'href');
    if (href === null) continue;
    if (rel === 'stylesheet') stylesheetHrefs.push(href);
    if (rel === 'preload') {
      preloads.push({
        href,
        as: attribute(attributes, 'as') ?? '',
        type: attribute(attributes, 'type'),
        media: attribute(attributes, 'media'),
        fetchPriority: attribute(attributes, 'fetchpriority'),
        crossOrigin: hasAttribute(attributes, 'crossorigin'),
      });
    }
  }

  for (const match of html.matchAll(ABSOLUTE_URL)) {
    const value = match[1];
    if (value === undefined) continue;
    // Only the origin is recorded: what matters is how many hosts the browser must resolve and
    // connect to, not which document referenced them.
    const slashSlash = value.indexOf('//');
    const end = value.indexOf('/', slashSlash + 2);
    origins.add(end === -1 ? value : value.slice(0, end));
  }

  return {
    htmlBytes: new TextEncoder().encode(html).byteLength,
    inlineStyles,
    inlineScripts,
    dataBlocks,
    externalScripts,
    stylesheetHrefs,
    externalOrigins: [...origins].sort(),
    preloads,
    inlineEventHandlers: [...html.matchAll(INLINE_HANDLER)].length,
  };
}

/* -- The checks -------------------------------------------------------------------------------- */

/** Compressed sizes the caller measured, because compression is a runtime capability. */
export interface CompressedSizes {
  /** Gzip byte length of the concatenated inline CSS. */
  readonly cssGzipBytes: number;
  /** Gzip byte length of the concatenated inline JS. */
  readonly jsGzipBytes: number;
}

/**
 * Applies the budgets to one document.
 *
 * `externalOrigins` is an ERROR rather than a warning, and the origin list is emitted in the
 * message. §7.22 is not a performance preference: a third origin on a tenant page is a DNS lookup,
 * a TLS handshake and — in the market this product sells into — a GDPR exposure, since LG München I
 * 3 O 17493/20 made hotlinking a font CDN an actionable transfer of the visitor's IP address.
 *
 * `sameOriginHosts` lets the caller declare which absolute origins are its own (the tenant's own
 * canonical host, which `og:image` and the JSON-LD `@id` must reference absolutely). Anything else
 * is third-party by definition.
 */
export function checkDocumentBudgets(args: {
  readonly analysis: DocumentAnalysis;
  readonly sizes: CompressedSizes;
  readonly sameOriginHosts: readonly string[];
}): readonly BudgetFinding[] {
  const findings: BudgetFinding[] = [];
  const allowed = new Set(args.sameOriginHosts.map((host) => `https://${host}`));

  if (args.sizes.cssGzipBytes > CSS_BUDGET_BYTES) {
    findings.push({
      code: 'css_budget',
      severity: 'error',
      measured: args.sizes.cssGzipBytes,
      limit: CSS_BUDGET_BYTES,
      message:
        'Inline CSS exceeds the budget; the per-page assembly is shipping unused components.',
    });
  }

  if (args.sizes.jsGzipBytes > JS_BUDGET_BYTES) {
    findings.push({
      code: 'js_budget',
      severity: 'error',
      measured: args.sizes.jsGzipBytes,
      limit: JS_BUDGET_BYTES,
      message: 'Inline JS exceeds the budget.',
    });
  }

  if (args.analysis.htmlBytes > HTML_BUDGET_BYTES) {
    findings.push({
      code: 'html_budget',
      severity: 'error',
      measured: args.analysis.htmlBytes,
      limit: HTML_BUDGET_BYTES,
      message: 'Rendered document is larger than a single cache entry should be.',
    });
  }

  if (args.analysis.stylesheetHrefs.length > 0) {
    findings.push({
      code: 'render_blocking_stylesheet',
      severity: 'error',
      measured: args.analysis.stylesheetHrefs.length,
      limit: 0,
      message: 'All CSS is inline; a <link rel="stylesheet"> is a render-blocking request (§7.20).',
    });
  }

  if (args.analysis.externalScripts.length > 0) {
    findings.push({
      code: 'external_script',
      severity: 'error',
      measured: args.analysis.externalScripts.length,
      limit: 0,
      message: `External script(s): ${args.analysis.externalScripts.join(', ')}.`,
    });
  }

  const foreign = args.analysis.externalOrigins.filter((origin) => !allowed.has(origin));
  if (foreign.length > 0) {
    findings.push({
      code: 'third_party_origin',
      severity: 'error',
      measured: foreign.length,
      limit: 0,
      message: `Third-party origin(s): ${foreign.join(', ')}.`,
    });
  }

  if (args.analysis.inlineEventHandlers > 0) {
    findings.push({
      code: 'inline_event_handler',
      severity: 'error',
      measured: args.analysis.inlineEventHandlers,
      limit: 0,
      message: 'An on*= attribute cannot be covered by a hash-based script-src (§7.24).',
    });
  }

  return findings;
}

/** True when any finding blocks the publish. */
export function hasBlockingBudgetFindings(findings: readonly BudgetFinding[]): boolean {
  return findings.some((finding) => finding.severity === 'error');
}

/* -- The poster/video size invariant ----------------------------------------------------------- */

/** Intrinsic pixel dimensions of one asset. */
export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * Asserts §7.17: the poster's intrinsic area is at least the video's, at this breakpoint.
 *
 * A `<video>` is an LCP candidate and LCP stays open until the first interaction, so no amount of
 * clever timing keeps the video out of the measurement — only the size invariant does. If the
 * poster is the larger element it stays the candidate whatever the video does afterwards.
 *
 * This is also why the poster is never a `poster=` attribute: that makes the *video element* the
 * candidate, and then its own decode time is the LCP.
 */
export function posterSatisfiesSizeInvariant(poster: Dimensions, video: Dimensions): boolean {
  return poster.width * poster.height >= video.width * video.height;
}

/** Checks the invariant across every declared breakpoint pair. */
export function checkPosterInvariant(
  pairs: readonly {
    readonly breakpoint: string;
    readonly poster: Dimensions;
    readonly video: Dimensions;
  }[],
): readonly BudgetFinding[] {
  const findings: BudgetFinding[] = [];
  for (const pair of pairs) {
    if (posterSatisfiesSizeInvariant(pair.poster, pair.video)) continue;
    findings.push({
      code: 'poster_smaller_than_video',
      severity: 'error',
      measured: pair.poster.width * pair.poster.height,
      limit: pair.video.width * pair.video.height,
      message: `At ${pair.breakpoint} the video is the larger element and becomes the LCP candidate (§7.17).`,
    });
  }
  return findings;
}

/* -- The tenant CSP ---------------------------------------------------------------------------- */

/**
 * Builds the tenant Content-Security-Policy (§7.24).
 *
 * Four things in here are corrections of the versions that appeared across the design dimensions,
 * and each one was a real hole:
 *
 *   - `frame-ancestors` does **not** inherit from `default-src`, so without it every tenant site
 *     was framable and therefore clickjackable;
 *   - `connect-src` and `font-src` were missing, which under `default-src 'none'` would have
 *     blocked the form enhancement's own fetch and the self-hosted font;
 *   - `'unsafe-inline'` on `script-src` made the claim "the CSP already blocks execution" false —
 *     hashes are the whole mechanism, so they are required arguments here rather than optional;
 *   - `img-src` allows `data:` because the blurhash placeholder is a data URI, and nothing else.
 *
 * Media, fonts and images are `'self'` because derivatives are served from the tenant's own origin
 * under `/_a/`, which is also what keeps the third-party-origin count at zero and removes a
 * recurring image-transformation meter.
 *
 * An empty hash list yields `'none'`, which is correct and stricter — a page with no inline script
 * should not permit one.
 */
export function buildTenantCsp(args: {
  /** `sha256-…` values for every inline `<script>`, base64. */
  readonly scriptHashes: readonly string[];
  /** `sha256-…` values for every inline `<style>`, base64. */
  readonly styleHashes: readonly string[];
}): string {
  const sources = (hashes: readonly string[]): string =>
    hashes.length === 0 ? "'none'" : hashes.map((hash) => `'${hash}'`).join(' ');

  return [
    "default-src 'none'",
    `script-src ${sources(args.scriptHashes)}`,
    `style-src ${sources(args.styleHashes)}`,
    "img-src 'self' data:",
    "media-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

/**
 * Renders the preload hints as a `Link` response header value (§3a step 7).
 *
 * The header duplicates what is already in the `<head>`. That is deliberate and not redundant: a
 * response header is available to the browser before a single byte of the body has been parsed, so
 * on a cold connection the hero poster and the font start downloading one round trip earlier than
 * the preload scanner could start them.
 *
 * Returns `null` when there is nothing to preload, so the caller can omit the header rather than
 * send an empty one.
 */
export function preloadLinkHeader(preloads: readonly PreloadHint[]): string | null {
  if (preloads.length === 0) return null;
  const parts = preloads.map((preload) => {
    const segments = [`<${preload.href}>`, 'rel=preload', `as=${preload.as}`];
    if (preload.type !== null) segments.push(`type="${preload.type}"`);
    if (preload.media !== null) segments.push(`media="${preload.media}"`);
    if (preload.fetchPriority !== null) segments.push(`fetchpriority=${preload.fetchPriority}`);
    if (preload.crossOrigin) segments.push('crossorigin');
    return segments.join('; ');
  });
  return parts.join(', ');
}
