import { describe, expect, it } from 'vitest';

import {
  CSS_BUDGET_BYTES,
  JS_BUDGET_BYTES,
  analyseDocument,
  buildTenantCsp,
  checkDocumentBudgets,
  HERO_VIDEO_LANDSCAPE_BUDGET_BYTES,
  HERO_VIDEO_PORTRAIT_BUDGET_BYTES,
  checkHeroVideo,
  checkPosterInvariant,
  hasBlockingBudgetFindings,
  posterSatisfiesSizeInvariant,
  preloadLinkHeader,
} from '../budgets';

const HOST = 'bakkerij-jansen.mijnsaas.com';

const GOOD_PAGE = `<!doctype html>
<html lang="nl" dir="ltr">
<head>
<meta charset="utf-8">
<link rel="preload" as="image" fetchpriority="high" media="(max-width:767px)" href="/_a/hero-p-1170.3f9a1c.avif" type="image/avif">
<link rel="preload" as="font" type="font/woff2" href="/_a/inter-latin.9a13c4.woff2" crossorigin>
<style>:root{--color-bg:oklch(0.17 0.018 288)}</style>
<link rel="canonical" href="https://${HOST}/nl/">
<meta property="og:image" content="https://${HOST}/_a/og-1200x630.3f9a1c.jpg">
</head>
<body><main id="main"><h1>Bakkerij Jansen</h1></main>
<script>document.documentElement.dataset.js='1'</script>
</body></html>`;

describe('analyseDocument', () => {
  const analysis = analyseDocument(GOOD_PAGE);

  it('finds the inline style and script blocks', () => {
    expect(analysis.inlineStyles).toHaveLength(1);
    expect(analysis.inlineScripts).toHaveLength(1);
    expect(analysis.externalScripts).toHaveLength(0);
    expect(analysis.stylesheetHrefs).toHaveLength(0);
  });

  it('separates the JSON-LD graph from the executable scripts', () => {
    // script-src does not gate a non-executable type, so hashing the graph would put ~50 pointless
    // bytes in every page's CSP and would change that header whenever a business fact changed.
    const withGraph = analyseDocument(
      `${GOOD_PAGE}<script type="application/ld+json">{"@context":"https://schema.org"}</script>`,
    );
    expect(withGraph.inlineScripts).toHaveLength(1);
    expect(withGraph.dataBlocks).toEqual([
      { type: 'application/ld+json', content: '{"@context":"https://schema.org"}' },
    ]);
  });

  it('treats a module and an untyped script as executable', () => {
    const analysed = analyseDocument(
      '<script type="module">a()</script><script>b()</script><script type="speculationrules">{}</script>',
    );
    expect(analysed.inlineScripts).toEqual(['a()', 'b()']);
    expect(analysed.dataBlocks.map((block) => block.type)).toEqual(['speculationrules']);
  });

  it('records the preloads in document order with their media queries', () => {
    expect(analysis.preloads).toEqual([
      {
        href: '/_a/hero-p-1170.3f9a1c.avif',
        as: 'image',
        type: 'image/avif',
        media: '(max-width:767px)',
        fetchPriority: 'high',
        crossOrigin: false,
      },
      {
        href: '/_a/inter-latin.9a13c4.woff2',
        as: 'font',
        type: 'font/woff2',
        media: null,
        fetchPriority: null,
        crossOrigin: true,
      },
    ]);
  });

  it('collects absolute origins, which is how third parties are counted', () => {
    expect(analysis.externalOrigins).toEqual([`https://${HOST}`]);
  });

  it('counts inline event handlers', () => {
    expect(analyseDocument('<button onclick="go()">x</button>').inlineEventHandlers).toBe(1);
    expect(analysis.inlineEventHandlers).toBe(0);
  });
});

describe('checkDocumentBudgets', () => {
  const sameOriginHosts = [HOST];

  it('passes a document that satisfies every §7 budget', () => {
    const findings = checkDocumentBudgets({
      analysis: analyseDocument(GOOD_PAGE),
      sizes: { cssGzipBytes: 4_000, jsGzipBytes: 900 },
      sameOriginHosts,
    });
    expect(findings).toEqual([]);
    expect(hasBlockingBudgetFindings(findings)).toBe(false);
  });

  it('blocks on an over-budget CSS bundle', () => {
    const findings = checkDocumentBudgets({
      analysis: analyseDocument(GOOD_PAGE),
      sizes: { cssGzipBytes: CSS_BUDGET_BYTES + 1, jsGzipBytes: 0 },
      sameOriginHosts,
    });
    expect(findings.map((finding) => finding.code)).toEqual(['css_budget']);
    expect(hasBlockingBudgetFindings(findings)).toBe(true);
  });

  it('blocks on an over-budget JS bundle', () => {
    const findings = checkDocumentBudgets({
      analysis: analyseDocument(GOOD_PAGE),
      sizes: { cssGzipBytes: 0, jsGzipBytes: JS_BUDGET_BYTES + 1 },
      sameOriginHosts,
    });
    expect(findings.map((finding) => finding.code)).toEqual(['js_budget']);
  });

  it('blocks a Google Fonts stylesheet on three counts at once', () => {
    // §7.21/§7.22: a third origin on the critical path, and LG München I 3 O 17493/20 makes it a
    // GDPR exposure in exactly the market this product sells into.
    const html = `<head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"></head>`;
    const findings = checkDocumentBudgets({
      analysis: analyseDocument(html),
      sizes: { cssGzipBytes: 0, jsGzipBytes: 0 },
      sameOriginHosts,
    });
    expect(findings.map((finding) => finding.code)).toEqual([
      'render_blocking_stylesheet',
      'third_party_origin',
    ]);
  });

  it('blocks the Cloudflare Web Analytics beacon like any other third-party script', () => {
    const html = `<script src="https://static.cloudflareinsights.com/beacon.min.js"></script>`;
    const findings = checkDocumentBudgets({
      analysis: analyseDocument(html),
      sizes: { cssGzipBytes: 0, jsGzipBytes: 0 },
      sameOriginHosts,
    });
    expect(findings.map((finding) => finding.code)).toEqual([
      'external_script',
      'third_party_origin',
    ]);
  });

  it('blocks an inline event handler, which no hash-based script-src can cover', () => {
    const findings = checkDocumentBudgets({
      analysis: analyseDocument('<a href="/nl/" onclick="track()">x</a>'),
      sizes: { cssGzipBytes: 0, jsGzipBytes: 0 },
      sameOriginHosts,
    });
    expect(findings.map((finding) => finding.code)).toContain('inline_event_handler');
  });
});

describe('the poster/video size invariant', () => {
  it('accepts the specified desktop and mobile pairs', () => {
    // §7.17: a <video> is an LCP candidate and LCP stays open until first interaction, so only the
    // size invariant keeps the poster as the candidate.
    expect(
      checkPosterInvariant([
        {
          breakpoint: 'desktop',
          poster: { width: 2400, height: 1350 },
          video: { width: 1920, height: 1080 },
        },
        {
          breakpoint: 'mobile',
          poster: { width: 1170, height: 2080 },
          video: { width: 720, height: 1280 },
        },
      ]),
    ).toEqual([]);
  });

  it('rejects a poster smaller in area than its video', () => {
    expect(
      posterSatisfiesSizeInvariant({ width: 1280, height: 720 }, { width: 1920, height: 1080 }),
    ).toBe(false);
    const findings = checkPosterInvariant([
      {
        breakpoint: 'mobile',
        poster: { width: 640, height: 360 },
        video: { width: 720, height: 1280 },
      },
    ]);
    expect(findings.map((finding) => finding.code)).toEqual(['poster_smaller_than_video']);
  });
});

describe('buildTenantCsp', () => {
  it('closes the four holes the dimension drafts left open', () => {
    const csp = buildTenantCsp({ scriptHashes: ['sha256-aaa'], styleHashes: ['sha256-bbb'] });
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'sha256-aaa'");
    expect(csp).toContain("style-src 'sha256-bbb'");
    // frame-ancestors does NOT inherit from default-src; without it every tenant site is framable.
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("font-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('emits a none source rather than a wildcard when a page has no inline code', () => {
    const csp = buildTenantCsp({ scriptHashes: [], styleHashes: [] });
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("style-src 'none'");
  });
});

describe('preloadLinkHeader', () => {
  it('mirrors the head preloads as a Link header, crossorigin included', () => {
    const header = preloadLinkHeader(analyseDocument(GOOD_PAGE).preloads);
    expect(header).toBe(
      '</_a/hero-p-1170.3f9a1c.avif>; rel=preload; as=image; type="image/avif"; media="(max-width:767px)"; fetchpriority=high, ' +
        '</_a/inter-latin.9a13c4.woff2>; rel=preload; as=font; type="font/woff2"; crossorigin',
    );
  });

  it('returns null when there is nothing to preload', () => {
    expect(preloadLinkHeader([])).toBeNull();
  });
});

describe('the hero motion gate', () => {
  const OK = {
    landscapePoster: { width: 2560, height: 1440 },
    portraitPoster: { width: 1440, height: 2560 },
    landscape: { width: 1920, height: 1080, maxBytes: 380_000 },
    portrait: { width: 720, height: 1280, maxBytes: 110_000 },
  };

  it('passes a hero whose posters dominate and whose clips are within budget', () => {
    expect(checkHeroVideo(OK)).toEqual([]);
  });

  it('catches a portrait poster the phone video would outsize', () => {
    // The failure that motivated the separate 9:16 ladder: cover-fitting the landscape still into a
    // phone viewport leaves the poster scored smaller than the video, and the video takes the LCP.
    const findings = checkHeroVideo({ ...OK, portraitPoster: { width: 640, height: 360 } });
    expect(findings.map((f) => f.code)).toEqual(['poster_smaller_than_video']);
    expect(findings[0]?.severity).toBe('error');
  });

  it('catches a clip over budget at either breakpoint, and says so per breakpoint', () => {
    const findings = checkHeroVideo({
      ...OK,
      landscape: { ...OK.landscape, maxBytes: 2_000_000 },
      portrait: { ...OK.portrait, maxBytes: 900_000 },
    });
    expect(findings.map((f) => f.code)).toEqual(['hero_video_budget', 'hero_video_budget']);
    expect(findings[0]?.message).toContain('(min-width:768px)');
    expect(findings[1]?.message).toContain('(max-width:767px)');
  });

  it('holds the phone to a tighter ceiling than the desktop', () => {
    // A clip that is fine on a laptop is not automatically fine on a phone; one budget for both
    // would either starve the desktop or wave the phone through.
    expect(HERO_VIDEO_PORTRAIT_BUDGET_BYTES).toBeLessThan(HERO_VIDEO_LANDSCAPE_BUDGET_BYTES);
    const findings = checkHeroVideo({
      ...OK,
      portrait: { ...OK.portrait, maxBytes: HERO_VIDEO_LANDSCAPE_BUDGET_BYTES },
    });
    expect(findings.map((f) => f.code)).toEqual(['hero_video_budget']);
  });
});
