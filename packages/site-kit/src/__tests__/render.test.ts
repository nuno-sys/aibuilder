import { describe, expect, it } from 'vitest';
import { SITE_JS, SITE_JS_CEILING } from '../js/site';
import { renderPage } from '../render';
import { stableStringify } from '../project';
import { HOSTILE_HREF, hostileDoc, renderContext, renderOptions } from './fixtures';

/**
 * The whole-page render contract: byte identity, hash stability, and the escaping boundary at the
 * one seam where markup is assembled as a string.
 */

const ctx = renderContext();
const options = renderOptions();

async function render(doc = hostileDoc(), locale: 'nl' | 'de' = 'nl', pageId = 'p1') {
  return renderPage(doc, locale, pageId, ctx, options);
}

describe('byte-identical re-render', () => {
  it('produces the same bytes twice from the same inputs', async () => {
    const first = await render();
    const second = await render();
    expect(second.html).toBe(first.html);
    expect(second.renderSha256).toBe(first.renderSha256);
    expect(second.css.css).toBe(first.css.css);
  });

  it('is unaffected by the enumeration order of copy and media records', async () => {
    // `doc.copy`, `doc.media`, `doc.links` and `page.perLocale` are `z.record(...)`: their key order
    // is a JS-engine detail. The renderer must iterate the derived slot inventory and
    // `doc.locales.enabled`, both arrays. This proves it empirically rather than by inspection.
    const forwards = await render(hostileDoc());
    const reversed = await render(hostileDoc({ reverseCopyOrder: true, reverseMediaOrder: true }));
    expect(reversed.renderSha256).toBe(forwards.renderSha256);
    expect(reversed.html).toBe(forwards.html);
  });
});

describe('render_sha256', () => {
  it('does not move when only the theme changes', async () => {
    // Styling is not content. A theme change must repaint the site without moving `lastmod` on
    // every page in the sitemap.
    const base = await render(hostileDoc());
    const restyled = await render(
      hostileDoc({ theme: { radiusId: 'sharp', densityId: 'compact', motionId: 'none' } }),
    );
    expect(restyled.renderSha256).toBe(base.renderSha256);
    // …and the HTML *does* change, so the test is not passing because nothing happened.
    expect(restyled.css.css).not.toBe(base.css.css);
  });

  it('moves when a single slot of copy changes', async () => {
    const base = await render(hostileDoc());
    const edited = hostileDoc();
    const nl = edited.copy.nl;
    if (nl === undefined) throw new Error('fixture has no nl copy');
    nl['s2.items.0.title'] = 'Elke ochtend vers';
    const after = await render(edited);
    expect(after.renderSha256).not.toBe(base.renderSha256);
  });

  it('moves when a locale is added to a page, because the head changes', async () => {
    const base = await render(hostileDoc());
    const extra = hostileDoc();
    const privacy = extra.pages[1];
    if (privacy === undefined) throw new Error('fixture has no privacy page');
    privacy.perLocale.de = {
      path: '/de/datenschutz/',
      slug: 'datenschutz',
      title: 'Datenschutz',
      description: 'Datenschutz',
      ogMediaRefId: null,
    };
    const after = await render(extra);
    // The home page's own cluster is unchanged, so only the page that gained a translation moves.
    expect(after.renderSha256).toBe(base.renderSha256);
    const beforePrivacy = await render(hostileDoc(), 'nl', 'p2');
    const afterPrivacy = await render(extra, 'nl', 'p2');
    expect(afterPrivacy.renderSha256).not.toBe(beforePrivacy.renderSha256);
  });

  it('excludes dateModified from the projection, because including it would be circular', async () => {
    const early = await renderPage(hostileDoc(), 'nl', 'p1', ctx, options);
    const later = await renderPage(
      hostileDoc(),
      'nl',
      'p1',
      renderContext({
        contentChangedAt: '2027-01-01T00:00:00+01:00',
        publishedAt: '2027-01-01T00:00:00+01:00',
      }),
      options,
    );
    // `dateModified` derives from `content_changed_at`, which moves when this hash moves. Including
    // it would make the hash depend on itself and move `lastmod` on every publish.
    expect(later.renderSha256).toBe(early.renderSha256);
    expect(later.html).not.toBe(early.html);
  });

  it('excludes the origin, so a preview host and a custom hostname agree', async () => {
    const preview = await renderPage(
      hostileDoc(),
      'nl',
      'p1',
      renderContext({ origin: 'https://preview.example.test' }),
      options,
    );
    const live = await render();
    expect(preview.renderSha256).toBe(live.renderSha256);
  });

  it('is a lowercase 64-character hex digest', async () => {
    const result = await render();
    expect(result.renderSha256).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('stableStringify', () => {
  it('sorts keys and emits no whitespace', () => {
    expect(stableStringify({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe('{"a":[2,{"c":3,"d":4}],"b":1}');
  });

  it('throws on anything that cannot be canonicalised', () => {
    // A projection that silently drops a key produces two different pages with the same hash,
    // which is the one failure mode a content hash exists to prevent.
    expect(() => stableStringify({ a: Number.NaN })).toThrow(TypeError);
    expect(() => stableStringify({ a: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => stableStringify({ a: undefined } as unknown as Record<string, never>)).toThrow(
      TypeError,
    );
  });
});

describe('the document', () => {
  it('has exactly one h1, and it belongs to the hero', async () => {
    const { html } = await render();
    expect([...html.matchAll(/<h1[\s>]/gu)]).toHaveLength(1);
    expect(html).toContain('<h1 id="s1-h"');
  });

  it('puts the skip link first in the body and the landmarks in order', async () => {
    const { html } = await render();
    const body = html.indexOf('<body>');
    const skip = html.indexOf('<a class="skip"');
    const header = html.indexOf('<header');
    const main = html.indexOf('<main id="main">');
    const footer = html.indexOf('<footer');
    expect(skip).toBe(body + '<body>'.length);
    expect(header).toBeGreaterThan(skip);
    expect(main).toBeGreaterThan(header);
    expect(footer).toBeGreaterThan(main);
  });

  it('emits one style element, no stylesheet link and no external script', async () => {
    const { html } = await render();
    expect([...html.matchAll(/<style>/gu)]).toHaveLength(1);
    expect(html).not.toContain('rel="stylesheet"');
    expect(html).not.toContain('@import');
    // The only `<script>` elements are the JSON-LD block, the inline runtime and the speculation
    // rules. None of them has a `src`.
    expect(html).not.toMatch(/<script[^>]*\ssrc=/u);
  });

  it('orders the head so the preload scanner sees the LCP candidates first', async () => {
    const { html } = await render();
    const heroPreload = html.indexOf('rel="preload" as="image"');
    const fontPreload = html.indexOf('rel="preload" as="font"');
    const style = html.indexOf('<style>');
    const title = html.indexOf('<title>');
    const jsonLd = html.indexOf('application/ld+json');
    expect(heroPreload).toBeGreaterThan(-1);
    expect(fontPreload).toBeGreaterThan(heroPreload);
    expect(style).toBeGreaterThan(fontPreload);
    expect(title).toBeGreaterThan(style);
    expect(jsonLd).toBeGreaterThan(title);
  });

  it('never disables pinch zoom', async () => {
    const { html } = await render();
    expect(html).toContain('viewport-fit=cover');
    expect(html).not.toContain('user-scalable');
    expect(html).not.toContain('maximum-scale');
  });

  it('escapes the hostile payload everywhere in the head', async () => {
    const { html } = await render();
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).not.toContain('<script>alert(1)</script>');
    expect(head).toContain('&lt;script&gt;');
    // Inside the JSON-LD block the escape is at the JSON layer, not the HTML one.
    expect(head).toContain('\\u003cscript>');
    expect(head).not.toContain(HOSTILE_HREF);
  });

  it('omits, never substitutes, a locale that has no translation of this page', async () => {
    const { html } = await render(hostileDoc(), 'nl', 'p2');
    expect(html).toContain('hreflang="nl"');
    // `p2` has no German routing, so `de` must be absent from the cluster entirely — one
    // non-reciprocal entry invalidates the whole cluster.
    expect(html).not.toContain('hreflang="de"');
    expect(html).toContain('hreflang="x-default"');
  });

  it('marks a page noindex when the quality gate has not passed', async () => {
    const gated = await renderPage(
      hostileDoc(),
      'nl',
      'p1',
      renderContext({ indexState: 'noindex' }),
      options,
    );
    expect(gated.html).toContain('<meta name="robots" content="noindex, nofollow">');
    const live = await render();
    expect(live.html).not.toContain('name="robots"');
  });

  it('renders the WhatsApp pill from the CHECK-constrained number, in the initial HTML', async () => {
    const { html } = await render();
    expect(html).toContain('href="https://wa.me/31612345678?text=');
    expect(html).not.toContain('whatsapp://');
    expect(html).toContain('data-no-prerender');
    // Present in the initial HTML — never injected — so it neither shifts anything nor is shifted.
    expect(html.indexOf('class="wa"')).toBeLessThan(html.indexOf('</body>'));
  });

  it('gives every img and video explicit dimensions', async () => {
    const { html } = await render();
    for (const match of html.matchAll(/<(img|video)\b[^>]*>/gu)) {
      const tag = match[0];
      expect(tag, `${tag} has no width`).toContain('width="');
      expect(tag, `${tag} has no height`).toContain('height="');
    }
  });

  it('keeps the footer backlink as plain text', async () => {
    const { html } = await render();
    const footer = html.slice(html.indexOf('<footer'));
    expect(footer).toContain('Gemaakt met aibuilder');
    // A sitewide followed backlink to the platform apex is the fastest route to a manual action.
    expect(footer).not.toMatch(/<a[^>]*aibuilder/u);
  });
});

describe('the inline runtime', () => {
  it('fits the stated budget as one deferred file', () => {
    const bytes = new TextEncoder().encode(SITE_JS).byteLength;
    expect(bytes).toBeLessThanOrEqual(SITE_JS_CEILING);
  });

  it('defaults an unknown connection to poster-only on phones', () => {
    // Safari and Firefox expose no Network Information API, so a permissive default would wave
    // through every iPhone on a train. This is the one line that makes the mobile budget hold.
    expect(SITE_JS).toContain('else if(innerWidth<768){v.remove();return}');
  });

  it('checks the motion preference first and honours a later change', () => {
    const motion = SITE_JS.indexOf('prefers-reduced-motion');
    const connection = SITE_JS.indexOf('navigator.connection');
    expect(motion).toBeGreaterThan(-1);
    expect(motion).toBeLessThan(connection);
    expect(SITE_JS).toContain("mq.addEventListener('change'");
  });

  it('waits for LCP to be attributed to the poster before mounting', () => {
    expect(SITE_JS).toContain('largest-contentful-paint');
    expect(SITE_JS).toContain('e.element===img');
  });
});
