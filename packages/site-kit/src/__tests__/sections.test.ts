import { describe, expect, it } from 'vitest';
import { SECTION_TYPES } from '@aibuilder/site-schema';
import type { PageDoc, SectionGen, SectionType, SiteDoc } from '@aibuilder/site-schema';
import { renderSection, toneFor } from '../sections/index';
import { HOSTILE_HREF, hostileDoc, renderContext } from './fixtures';

/**
 * The per-section semantic-HTML and escaping contract.
 *
 * Snapshot-free on purpose. A snapshot test tells you a section changed; it does not tell you the
 * section is still a named landmark with a heading at the right level and no unescaped model string
 * in it. These assertions state the contract, so a refactor that keeps the contract passes and a
 * refactor that breaks it fails with a message naming what broke.
 *
 * Every section is fed the same hostile payload — a `<script>` element, all three quote characters,
 * an ampersand — and one of them additionally carries a `javascript:` allowlist entry.
 */

/** The fixture's home page, as a `PageDoc` rather than a possibly-undefined index read. */
function homePageOf(document: SiteDoc): PageDoc {
  const page = document.pages[0];
  if (page === undefined) throw new Error('fixture has no home page');
  return page;
}

const doc = hostileDoc();
const ctx = renderContext();
const home = homePageOf(doc);

/** Renders one section standalone, at heading level 2 unless told otherwise. */
function render(section: SectionGen, headingLevel: 1 | 2 = 2, index = 1): string {
  return String(
    renderSection({
      section,
      doc,
      ctx,
      scope: { locale: 'nl', pageId: home.pageId },
      tone: toneFor(section, index),
      headingLevel,
    }),
  );
}

const byType = new Map<SectionType, SectionGen>();
for (const section of home.sections) byType.set(section.type, section);

describe('the fixture', () => {
  it('exercises all 17 section types', () => {
    expect([...byType.keys()].sort()).toStrictEqual([...SECTION_TYPES].sort());
  });
});

describe.each(SECTION_TYPES)('%s', (type) => {
  const section = byType.get(type);
  if (section === undefined) throw new Error(`fixture is missing a ${type} section`);
  const html = render(section);

  it('is a landmark region with an accessible name', () => {
    expect(html.startsWith('<section')).toBe(true);
    // `aria-labelledby` promotes the section to a named region; an unnamed landmark is a WCAG
    // 1.3.1 failure and the reason every section has a headline slot.
    expect(html).toContain(`aria-labelledby="${section.id}-h"`);
    const heading = new RegExp(`<h2 id="${section.id}-h"[^>]*>([^<]*)`, 'u').exec(html);
    expect(heading, 'section must own an <h2> with the id its region points at').not.toBeNull();
    expect((heading?.[1] ?? '').trim().length, 'accessible name must not be empty').toBeGreaterThan(
      0,
    );
  });

  it('carries its variant and a contain-intrinsic-size estimate', () => {
    expect(html).toContain(`data-variant="${section.variant}"`);
    expect(html).toMatch(/--sec-h:\d+px/u);
  });

  it('renders no heading level above 2 and never skips a level', () => {
    expect(html).not.toContain('<h1');
    // An `<h4>` without an `<h3>` before it is a skipped level; no section emits `<h4>` at all.
    expect(html).not.toContain('<h4');
    const h3Index = html.indexOf('<h3');
    const h2Index = html.indexOf('<h2');
    if (h3Index !== -1)
      expect(h2Index, 'an <h3> must follow the section <h2>').toBeLessThan(h3Index);
  });

  it('escapes every model-authored string', () => {
    // The payload must survive as text, not as markup.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // No raw quote from the payload may sit inside an attribute value.
    expect(html).toContain('&quot;');
    expect(html).toContain('&amp;');
  });

  it('never emits a URL built from model output', () => {
    expect(html).not.toContain(HOSTILE_HREF);
    expect(html).not.toContain('javascript:');
    for (const match of html.matchAll(/href="([^"]*)"/gu)) {
      const href = match[1] ?? '';
      expect(
        /^(\/|#|https:\/\/|tel:|mailto:)/u.test(href),
        `href "${href}" is not a scheme this package builds`,
      ).toBe(true);
    }
  });

  it('renders repeated item groups as real lists', () => {
    // `role="list"` is restated because the reset removes the marker, and removing the marker
    // removes list semantics in Safari.
    if (html.includes('<ul')) {
      expect(html).toMatch(/<ul[^>]*role="(list|group)"/u);
    }
  });
});

describe('per-section specifics', () => {
  it('hero owns the page h1 and never a poster with a loading attribute', () => {
    const hero = byType.get('hero');
    if (hero === undefined) throw new Error('no hero');
    const html = render(hero, 1, 0);
    expect(html).toContain(`<h1 id="${hero.id}-h"`);
    // `loading="lazy"` on the LCP image is an automatic Lighthouse failure.
    expect(html).not.toContain('loading="lazy"');
    expect(html).toContain('fetchpriority="high"');
    expect(html).toContain('decoding="sync"');
    // A `poster=` attribute would make the video element the LCP candidate.
    expect(html).not.toContain('poster=');
    expect(html).toContain('preload="none"');
    expect(html).toContain('aria-hidden="true"');
    // The video must have no `src` in the HTML: the element exists for layout only.
    expect(html).not.toMatch(/<video[^>]*\ssrc=/u);
  });

  it('stats_band puts the label in dt and the value in dd', () => {
    const stats = byType.get('stats_band');
    if (stats === undefined) throw new Error('no stats_band');
    const html = render(stats);
    const dt = html.indexOf('<dt>');
    const dd = html.indexOf('<dd>');
    expect(dt).toBeGreaterThan(-1);
    expect(dd).toBeGreaterThan(dt);
    expect(html).toContain('.items.0.label');
  });

  it('faq uses details/summary with the heading inside the summary', () => {
    const faq = byType.get('faq');
    if (faq === undefined) throw new Error('no faq');
    const html = render(faq);
    expect(html).toMatch(/<summary><h3>/u);
    expect(html).toContain('<details class="s-faq__item" open');
  });

  it('reviews renders the unverified-review disclosure as body text', () => {
    const reviews = byType.get('reviews');
    if (reviews === undefined) throw new Error('no reviews');
    const html = render(reviews);
    expect(html).toContain('niet onafhankelijk geverifieerd');
    expect(html).toContain('<blockquote>');
    // The star glyph run is decorative; the rating is announced by the visually hidden text.
    expect(html).toContain('<span class="vh">5 van de 5 sterren</span>');
  });

  it('contact_form gives every control a label and never pre-checks consent', () => {
    const form = byType.get('contact_form');
    if (form === undefined) throw new Error('no contact_form');
    const html = render(form);
    for (const name of ['name', 'email', 'message', 'consent']) {
      expect(html).toContain(`for="s13-${name}"`);
      expect(html).toContain(`id="s13-${name}"`);
    }
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('checked');
    // SC 1.3.5: identify input purpose where a purpose exists, and `off` where none does.
    expect(html).toContain('autocomplete="name"');
    expect(html).toContain('autocomplete="email"');
    expect(html).toContain('autocomplete="off"');
  });

  it('map_hours renders a table with a caption and row headers', () => {
    const hours = byType.get('map_hours');
    if (hours === undefined) throw new Error('no map_hours');
    const html = render(hours);
    expect(html).toContain('<caption class="vh">Openingstijden</caption>');
    expect(html).toContain('<th scope="row">');
    expect(html).toContain('<time datetime="08:30">');
    // The map is a static image inside a route link, never a third-party iframe.
    expect(html).not.toContain('<iframe');
    expect(html).toContain('https://www.google.com/maps/dir/?api=1');
  });

  it('services_grid drops a link whose allowlist entry is not https', () => {
    const services = byType.get('services_grid');
    if (services === undefined) throw new Error('no services_grid');
    const html = render(services);
    // Item 0 links to an anchor and renders; item 1's `javascript:` ref is dropped, and its title
    // still renders as text so the card is not silently empty.
    expect(html).toContain('href="/nl/#s6"');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('.items.1.title');
  });

  it('menu announces diet tags with a prefix rather than as bare words', () => {
    const menu = byType.get('menu');
    if (menu === undefined) throw new Error('no menu');
    const html = render(menu);
    expect(html).toContain('<span class="vh">Dieet: </span>');
    expect(html).toContain('<dl class="s-menu__list">');
  });

  it('team falls back to initials rather than to a stock face', () => {
    const team = byType.get('team');
    if (team === undefined) throw new Error('no team');
    const html = render(team);
    expect(html).toContain('s-team__initials');
    expect(html).toContain('aria-hidden="true"');
  });

  it('cta_band on accent_full adopts the accent tone', () => {
    const cta = byType.get('cta_band');
    if (cta === undefined) throw new Error('no cta_band');
    expect(toneFor(cta, 3)).toBe('accent');
    expect(render(cta, 2, 3)).toContain('data-tone="accent"');
  });

  it('rich_text and hero are always on the page tone', () => {
    const prose = byType.get('rich_text');
    const hero = byType.get('hero');
    if (prose === undefined || hero === undefined) throw new Error('missing fixture');
    expect(toneFor(prose, 5)).toBe('page');
    expect(toneFor(hero, 5)).toBe('page');
  });

  it('contact_form is never placed on a saturated ground', () => {
    const form = byType.get('contact_form');
    if (form === undefined) throw new Error('no contact_form');
    for (let index = 0; index < 8; index += 1) {
      expect(['page', 'alt']).toContain(toneFor(form, index));
    }
  });

  it('carries the hostile payload through every slot without losing the copy', () => {
    // A renderer that "escaped" by deleting would also pass the injection assertions, so prove the
    // copy actually arrived: every fixture slot's text ends with its own slot id.
    for (const section of home.sections) {
      const html = render(section);
      expect(html, section.type).toContain(`${section.id}.headline`);
      expect(html, section.type).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;');
    }
  });
});
