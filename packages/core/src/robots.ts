import type { IndexState } from './routing';

/**
 * `robots.txt` and `X-Robots-Tag`, synthesised per `Host`.
 *
 * Architecture §7.9, which is a correction of the obvious design rather than a restatement of it:
 *
 *   **`Disallow` does not de-index.** It prevents Googlebot from fetching the URL at all, and a URL
 *   Googlebot cannot fetch is a URL whose `noindex` it can never see. A page that is already in the
 *   index and is then disallowed stays in the index, usually with the "no information is available"
 *   snippet, for a very long time. So the two jobs need two different answers:
 *
 *   - a site that has **never** been indexed (`noindex`, `eligible`) is kept out with `Disallow: /`,
 *     which is cheap, immediate and correct because there is nothing to remove;
 *   - a site being **taken down** (`gone`) is served `200` with `X-Robots-Tag: noindex, follow` and
 *     crawling still ALLOWED, so the removal signal is actually seen, and only after the grace
 *     window does it become `410`.
 *
 * The three states below are exactly that, plus the ordinary published one. Nothing in this module
 * reads a request header: the body is a pure function of the host and the index state, which is
 * what makes it cacheable per site and impossible to vary by crawler.
 */

/** How long a de-indexing site keeps answering `200` so the `noindex` can be crawled. */
export const DEINDEX_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/** The three synthesised states, named so a test and a log line can say which one applied. */
export type RobotsPolicy =
  /** Published and eligible: crawl everything, here is the sitemap. */
  | 'open'
  /** Not yet cleared for the index: block the crawl outright, advertise nothing. */
  | 'blocked'
  /** Being removed: crawling stays open precisely so the `noindex` is seen. */
  | 'withdrawing';

/** Maps an index state onto the robots policy it implies. */
export function robotsPolicyFor(indexState: IndexState): RobotsPolicy {
  switch (indexState) {
    case 'indexable':
      return 'open';
    case 'gone':
      return 'withdrawing';
    case 'noindex':
    case 'eligible':
      return 'blocked';
  }
}

/**
 * Builds `robots.txt` for one host.
 *
 * The `Sitemap:` line appears only in the `open` state. Advertising a sitemap from a site that is
 * blocked is noise, and advertising one from a site that is being withdrawn asks a crawler to
 * re-discover the very URLs we are removing.
 *
 * The body always ends in a newline: some crawlers are documented as ignoring a final directive
 * without one, and it costs a byte.
 */
export function robotsTxt(args: {
  readonly host: string;
  readonly indexState: IndexState;
}): string {
  const policy = robotsPolicyFor(args.indexState);
  switch (policy) {
    case 'open':
      return `User-agent: *\nAllow: /\n\nSitemap: https://${args.host}/sitemap.xml\n`;
    case 'blocked':
      return 'User-agent: *\nDisallow: /\n';
    case 'withdrawing':
      // Crawling deliberately stays open. See the module header: a disallowed URL keeps its index
      // entry forever because the `noindex` is never fetched.
      return 'User-agent: *\nAllow: /\n';
  }
}

/**
 * The `X-Robots-Tag` value for a document, or `null` when none should be sent.
 *
 * `null` rather than `"index, follow"`: the default is already index-and-follow, and emitting it
 * explicitly adds a header to every response on the hot path while changing nothing. A directive is
 * sent only when it *restricts*.
 *
 * `pageNoindex` is the per-page flag from the `SiteDoc` — a thank-you page, a legal page a tenant
 * chose to hide. It restricts an otherwise indexable site but can never relax a restricted one, so
 * the site-level state is evaluated first.
 */
export function xRobotsTag(args: {
  readonly indexState: IndexState;
  readonly pageNoindex?: boolean | undefined;
}): string | null {
  switch (robotsPolicyFor(args.indexState)) {
    case 'blocked':
      // `nofollow` as well: nothing on an unverified site should pass a signal anywhere, and until
      // the claim link is clicked we have not confirmed the business is who the intake said it was.
      return 'noindex, nofollow';
    case 'withdrawing':
      // `follow`, not `nofollow`. Links out of a site being retired still describe the business's
      // real relationships, and dropping them adds nothing to the removal.
      return 'noindex, follow';
    case 'open':
      return args.pageNoindex === true ? 'noindex, follow' : null;
  }
}

/**
 * The HTTP status a `gone` site's documents should carry.
 *
 * `200` until the grace window has elapsed, then `410`. `410` rather than `404` because it is the
 * documented "this is permanent" signal and is processed faster; and only *after* the window,
 * because a `410` on day one removes the URL before the `noindex` has been crawled, which leaves
 * the entry in place with a stale snippet — the exact failure this whole sequence exists to avoid.
 *
 * `goneAt` is `null` for a site that has never been withdrawn, in which case there is nothing to
 * count from and the answer is the ordinary `200`.
 */
export function withdrawalStatus(args: {
  readonly indexState: IndexState;
  readonly goneAt: number | null;
  readonly now: number;
}): 200 | 410 {
  if (robotsPolicyFor(args.indexState) !== 'withdrawing') return 200;
  if (args.goneAt === null) return 200;
  return args.now - args.goneAt >= DEINDEX_GRACE_MS ? 410 : 200;
}
