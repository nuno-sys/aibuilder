/**
 * `lastmod` — when a page's *content* last changed, which is not when it was last published.
 *
 * Architecture §7.8 is a hard requirement and the easiest thing in the SEO surface to get wrong:
 * **`lastmod` moves only when rendered semantic content changes.** It must not move on a deploy, a
 * template change, a footer year rollover, or a republish with identical content. The reason is
 * economic rather than aesthetic — a sitemap whose every entry says "just now" is a sitemap Google
 * stops believing, and once it stops believing it, the field is discarded for the whole site,
 * including the entries where it was true.
 *
 * The mechanism is a two-step indirection, and each step is doing real work:
 *
 *   1. `site-kit`'s `projectPage()` reduces a rendered page to a **canonical semantic projection** —
 *      copy, structure, media identity, link targets, facts — with the theme, the CSS bundle, the
 *      asset URL prefixes, `publishedAt` and `dateModified` itself deliberately excluded. Hashing
 *      that gives `render_sha256`.
 *   2. This module compares the new `render_sha256` against the one the currently-published version
 *      carries for the same `(page_key, locale)` and carries the OLD `content_changed_at` forward
 *      when they match.
 *
 * Step 2 is why a regeneration that produces the same site does not lie to a crawler, and it is why
 * `content_changed_at` is joined on `page_key` — the identity that survives a regeneration — rather
 * than on `page_id`, which is minted fresh for every version.
 */

/* -- Digest plumbing --------------------------------------------------------------------------- */

/** Length of a SHA-256 digest in bytes. `page_translations.render_sha256` is `BLOB(32)`. */
export const SHA256_BYTES = 32;

const HEX_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

/** True when `value` is a lowercase hex SHA-256 digest, as `site-kit`'s `renderSha256()` returns. */
export function isHexDigest(value: unknown): value is string {
  return typeof value === 'string' && HEX_DIGEST_PATTERN.test(value);
}

/**
 * Converts a lowercase hex digest to the 32 bytes D1 stores.
 *
 * `site-kit` speaks hex because a hash is a string everywhere it is logged, compared or put in an
 * `ETag`; the column is `BLOB(32)` because 64 characters of hex is a 100% storage overhead on the
 * one column every page row carries. This is the single conversion point between the two.
 *
 * @throws RangeError when `hex` is not exactly 64 lowercase hex characters. A caller that reached
 * here with something else has a bug that must not be written to a content-addressed column.
 */
export function digestToBytes(hex: string): Uint8Array {
  if (!HEX_DIGEST_PATTERN.test(hex)) {
    throw new RangeError(`Not a lowercase hex SHA-256 digest: ${hex.slice(0, 16)}…`);
  }
  const bytes = new Uint8Array(SHA256_BYTES);
  for (let index = 0; index < SHA256_BYTES; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Converts stored digest bytes back to lowercase hex, or `null` when the column was empty. */
export function digestToHex(bytes: Uint8Array | null | undefined): string | null {
  if (bytes === null || bytes === undefined || bytes.length !== SHA256_BYTES) return null;
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/* -- The decision ------------------------------------------------------------------------------ */

/** What the previously published version knows about one `(page_key, locale)`. */
export interface PreviousContent {
  /** Lowercase hex `render_sha256`, or `null` when the previous version never recorded one. */
  readonly renderSha256: string | null;
  readonly contentChangedAt: number;
}

/** The outcome for one page translation. */
export interface LastmodDecision {
  /** The value to write to `page_translations.content_changed_at`. */
  readonly contentChangedAt: number;
  /** True when the semantic projection differs from the published one — drives IndexNow (§7.10). */
  readonly changed: boolean;
}

/**
 * Decides one page's `content_changed_at`.
 *
 * Three cases, and the middle one is the whole point:
 *
 *   - **No previous version** (a first publish): the content is new, so `now`.
 *   - **Previous digest equals the new one**: carry the old timestamp forward unchanged. This is
 *     what makes a template change, a redeploy or an identical regeneration invisible to a crawler.
 *   - **Previous digest differs, or the previous version never recorded one**: `now`.
 *
 * A `null` previous digest is treated as changed rather than as unchanged. It means the row predates
 * the projection or failed to record it, and claiming "unchanged" on the strength of a value we do
 * not have would suppress a real update — the failure that is expensive, as against a single
 * unnecessary `lastmod` move, which is not.
 */
export function decideLastmod(args: {
  readonly previous: PreviousContent | null;
  readonly renderSha256: string;
  readonly now: number;
}): LastmodDecision {
  const previous = args.previous;
  if (previous === null || previous.renderSha256 === null) {
    return { contentChangedAt: args.now, changed: true };
  }
  if (previous.renderSha256 === args.renderSha256) {
    return { contentChangedAt: previous.contentChangedAt, changed: false };
  }
  return { contentChangedAt: args.now, changed: true };
}

/* -- Formatting -------------------------------------------------------------------------------- */

/**
 * Formats a timestamp as the W3C Datetime a `<lastmod>` element takes.
 *
 * `Date#toISOString` and nothing else. `Intl.DateTimeFormat` is banned from every code path that
 * produces published bytes (`PHASE2-SITE-KIT.md` §9.3 rule 3): its output depends on the ICU data
 * bundled with the runtime, so a `workerd` upgrade would silently change every tenant's sitemap and
 * every `ETag` derived from one.
 *
 * Truncated to whole seconds. Sub-second precision in a `lastmod` is noise that no consumer reads,
 * and it makes two sitemaps generated in the same publish differ for no reason.
 *
 * @throws RangeError on a non-finite timestamp, rather than emitting `Invalid Date` into an XML
 * document that a crawler will then reject wholesale.
 */
export function formatLastmod(timestampMs: number): string {
  if (!Number.isFinite(timestampMs)) {
    throw new RangeError(`Not a timestamp: ${String(timestampMs)}`);
  }
  const seconds = Math.floor(timestampMs / 1000) * 1000;
  return `${new Date(seconds).toISOString().slice(0, 19)}Z`;
}

/**
 * The newest `content_changed_at` in a set, or `null` for an empty set.
 *
 * Used for the `<lastmod>` of a sitemap **index** entry, which must describe the sitemap it points
 * at rather than the moment the index was written — the same rule as §7.8, one level up.
 */
export function newestChangedAt(
  entries: readonly { readonly contentChangedAt: number }[],
): number | null {
  let newest: number | null = null;
  for (const entry of entries) {
    if (newest === null || entry.contentChangedAt > newest) newest = entry.contentChangedAt;
  }
  return newest;
}
