import { describe, expect, it } from 'vitest';

import {
  DEINDEX_GRACE_MS,
  robotsPolicyFor,
  robotsTxt,
  withdrawalStatus,
  xRobotsTag,
} from '../robots';

const HOST = 'bakkerij-jansen.mijnsaas.com';

describe('the three robots states', () => {
  it('opens the crawl and advertises the sitemap once a site is indexable', () => {
    expect(robotsPolicyFor('indexable')).toBe('open');
    expect(robotsTxt({ host: HOST, indexState: 'indexable' })).toBe(
      `User-agent: *\nAllow: /\n\nSitemap: https://${HOST}/sitemap.xml\n`,
    );
  });

  it('blocks the crawl of a site that has never been cleared for the index', () => {
    // `noindex` before the claim link is clicked (§3b step 7); `eligible` once paid but before the
    // quality gate. Neither has ever been in the index, so Disallow is the correct, cheap answer.
    for (const state of ['noindex', 'eligible'] as const) {
      expect(robotsPolicyFor(state)).toBe('blocked');
      expect(robotsTxt({ host: HOST, indexState: state })).toBe('User-agent: *\nDisallow: /\n');
    }
  });

  it('KEEPS the crawl open while a site is being withdrawn', () => {
    // The correction that makes this module worth having: Disallow does not de-index. It stops
    // Googlebot fetching the URL, so the noindex is never seen and the entry stays forever (§7.9).
    expect(robotsPolicyFor('gone')).toBe('withdrawing');
    const body = robotsTxt({ host: HOST, indexState: 'gone' });
    expect(body).toBe('User-agent: *\nAllow: /\n');
    expect(body).not.toContain('Disallow');
  });

  it('never advertises a sitemap from a site that is blocked or withdrawing', () => {
    for (const state of ['noindex', 'eligible', 'gone'] as const) {
      expect(robotsTxt({ host: HOST, indexState: state })).not.toContain('Sitemap:');
    }
  });

  it('ends every body with a newline', () => {
    for (const state of ['noindex', 'eligible', 'indexable', 'gone'] as const) {
      expect(robotsTxt({ host: HOST, indexState: state }).endsWith('\n')).toBe(true);
    }
  });
});

describe('X-Robots-Tag', () => {
  it('sends nothing on an indexable page', () => {
    expect(xRobotsTag({ indexState: 'indexable' })).toBeNull();
  });

  it('sends noindex, nofollow before a site is verified', () => {
    expect(xRobotsTag({ indexState: 'noindex' })).toBe('noindex, nofollow');
    expect(xRobotsTag({ indexState: 'eligible' })).toBe('noindex, nofollow');
  });

  it('sends noindex, follow while a site is being withdrawn', () => {
    expect(xRobotsTag({ indexState: 'gone' })).toBe('noindex, follow');
  });

  it('lets a page opt out of an otherwise indexable site', () => {
    expect(xRobotsTag({ indexState: 'indexable', pageNoindex: true })).toBe('noindex, follow');
  });

  it('cannot be relaxed by a page flag', () => {
    expect(xRobotsTag({ indexState: 'noindex', pageNoindex: false })).toBe('noindex, nofollow');
  });
});

describe('the withdrawal window', () => {
  const goneAt = 1_757_000_000_000;

  it('answers 200 while the noindex is still being crawled', () => {
    expect(withdrawalStatus({ indexState: 'gone', goneAt, now: goneAt })).toBe(200);
    expect(
      withdrawalStatus({ indexState: 'gone', goneAt, now: goneAt + DEINDEX_GRACE_MS - 1 }),
    ).toBe(200);
  });

  it('answers 410 once the window has elapsed', () => {
    expect(withdrawalStatus({ indexState: 'gone', goneAt, now: goneAt + DEINDEX_GRACE_MS })).toBe(
      410,
    );
  });

  it('answers 200 for every state that is not a withdrawal', () => {
    for (const state of ['noindex', 'eligible', 'indexable'] as const) {
      expect(withdrawalStatus({ indexState: state, goneAt, now: goneAt + DEINDEX_GRACE_MS })).toBe(
        200,
      );
    }
  });

  it('answers 200 when nothing recorded when the withdrawal started', () => {
    expect(withdrawalStatus({ indexState: 'gone', goneAt: null, now: goneAt })).toBe(200);
  });
});
