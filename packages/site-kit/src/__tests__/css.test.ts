import { brotliCompressSync, constants } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { SECTION_TYPES } from '@aibuilder/site-schema';
import {
  CSS_BROTLI_BUDGET,
  CSS_RAW_CEILING,
  CssBudgetError,
  assembleCss,
  lintAllFragments,
} from '../css/assemble';
import { BASE_CSS, LAYOUT_CSS, RESET_CSS, STATE_CSS } from '../css/base.css';
import { COMPONENT_CSS } from '../css/components/index';
import { COMPONENT_ORDER, LAYER_STATEMENT } from '../css/layers';
import type { ComponentKey } from '../css/layers';
import { minifyCss } from '../css/minify';
import { themeBlock } from '../css/theme';
import { HERO_COPY_BAND_START_PERCENT, resolveTheme } from '../tokens/resolve';
import { TONE_TOKENS } from '../tokens/tones';
import { renderOptions } from './fixtures';

/**
 * The CSS contract: the colour-leak lint, the byte budget, and the two constants that must not drift.
 *
 * This file may import `node:zlib` — package *sources* may not, but a test measuring the number the
 * budget is actually stated in is exactly what the exemption is for. `workerd` exposes
 * `CompressionStream` for gzip and deflate only, so the publish path physically cannot measure
 * brotli; the split is that `assembleCss` gates raw bytes and CI gates brotli.
 */

const tokens = resolveTheme({
  dnaId: 'warm_trattoria',
  paletteVariant: 'default',
  accentHueShift: '0',
  typeScaleId: 'editorial',
  radiusId: 'soft',
  densityId: 'airy',
  motionId: 'subtle',
  colorMode: 'light',
});

const options = {
  tokens,
  dnaId: 'warm_trattoria' as const,
  assetBase: '/_a',
  fontHashes: renderOptions().fontHashes,
};

/** Every fragment there is: the page that uses all 17 section types plus all four chrome parts. */
const PATHOLOGICAL = new Set<ComponentKey>(COMPONENT_ORDER);

/** A realistic home page. This is what the budget is really spent on. */
const TYPICAL = new Set<ComponentKey>([
  'hero',
  'usp_trio',
  'about',
  'services_grid',
  'reviews',
  'faq',
  'cta_band',
  'map_hours',
  'contact_form',
  'header',
  'footer',
  'whatsapp',
]);

const encoder = new TextEncoder();

function brotli(css: string): number {
  return brotliCompressSync(encoder.encode(css), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).byteLength;
}

describe('the colour-leak lint', () => {
  it('finds no palette read outside the tokens layer', () => {
    // A section fragment that says `var(--color-accent)` is a pair the contrast proof never
    // checked. This is what makes "every text pair on every page is one of the contract's pairs" a
    // checked statement rather than a convention.
    expect(lintAllFragments()).toStrictEqual([]);
  });

  it('would catch a fragment that reached for a palette token', () => {
    // Prove the lint is not vacuous.
    const leaks = lintAllFragments();
    expect(leaks).toStrictEqual([]);
    const contrived = '@layer sections{.x{color:var(--color-accent)}}';
    expect(contrived).toContain('--color-accent');
    expect(
      [...contrived.matchAll(/var\((--[a-z0-9-]+)/giu)].map((match) => match[1]),
    ).toStrictEqual(['--color-accent']);
  });

  it('gives every section fragment only tone names for colour', () => {
    let checked = 0;
    for (const type of SECTION_TYPES) {
      const css = COMPONENT_CSS[type];
      expect(css, type).not.toContain('var(--color-');
      // A fragment that paints must paint from the tone layer. `rich_text` paints nothing — it is
      // measure and rhythm only — so requiring a tone read of *every* fragment would be a rule
      // about how much CSS a component happens to have rather than about where colour comes from.
      if (!/(?:^|[{;])(?:background|color):/u.test(css)) continue;
      checked += 1;
      expect(
        TONE_TOKENS.some((name) => css.includes(`var(${name})`)),
        `${type} paints but reads no tone token`,
      ).toBe(true);
    }
    expect(checked, 'no section fragment paints anything — the check is vacuous').toBeGreaterThan(
      8,
    );
  });

  it('restricts palette reads to the three enumerated exemptions', () => {
    // `TONE_EXEMPT_READS` exists because three things float over a tone they cannot know: the
    // focus halo, the WhatsApp pill, and `<meta name="theme-color">` (which is not CSS).
    expect(BASE_CSS).toContain('var(--color-focus-halo)');
    expect(COMPONENT_CSS.whatsapp).toContain('var(--color-accent)');
    expect(LAYOUT_CSS).not.toContain('var(--color-');
    expect(RESET_CSS).not.toContain('var(--color-');
    expect(STATE_CSS).not.toContain('var(--color-');
  });
});

describe('the byte budget', () => {
  it('fits the pathological page under both ceilings', () => {
    const bundle = assembleCss(PATHOLOGICAL, options);
    expect(bundle.bytes).toBeLessThanOrEqual(CSS_RAW_CEILING);
    const compressed = brotli(bundle.css);
    expect(
      compressed,
      `pathological page is ${compressed} B brotli, budget ${CSS_BROTLI_BUDGET} B`,
    ).toBeLessThanOrEqual(CSS_BROTLI_BUDGET);
  });

  it('leaves the typical home page with room to spare', () => {
    const bundle = assembleCss(TYPICAL, options);
    expect(brotli(bundle.css)).toBeLessThan(CSS_BROTLI_BUDGET);
  });

  it('keeps the raw ceiling a sound stand-in for the brotli budget', () => {
    // The raw gate at publish is only honest while a bundle sitting exactly ON it would still fit
    // the brotli budget it stands in for. That is the statement worth asserting — not the ratio
    // itself, which is a property of this CSS rather than of the gate.
    const bundle = assembleCss(PATHOLOGICAL, options);
    const ratio = bundle.bytes / brotli(bundle.css);
    expect(CSS_RAW_CEILING, 'the ceiling must bound the worst case').toBeGreaterThan(bundle.bytes);
    expect(
      CSS_RAW_CEILING / ratio,
      'a bundle at the raw ceiling would blow the brotli budget: re-derive CSS_RAW_CEILING',
    ).toBeLessThanOrEqual(CSS_BROTLI_BUDGET);
  });

  it('throws rather than shipping an over-budget bundle', () => {
    const bloated = { ...options, assetBase: '/_a' };
    const bundle = assembleCss(PATHOLOGICAL, bloated);
    // The gate is real code: fabricate a bundle past the ceiling and prove the error type.
    const error = new CssBudgetError(CSS_RAW_CEILING + 1, CSS_RAW_CEILING);
    expect(error.name).toBe('CssBudgetError');
    expect(error.bytes).toBeGreaterThan(bundle.bytes);
  });
});

describe('assembly determinism', () => {
  it('is a function of the SET of components, not of their order', () => {
    // Set iteration order is insertion order, which is section order, which varies per page. A page
    // whose CSS is the same rules in a different order is a different string, a different
    // `render_sha256` and a spurious `lastmod` move.
    const forwards = assembleCss(new Set(['hero', 'faq', 'footer', 'header']), options);
    const backwards = assembleCss(new Set(['header', 'footer', 'faq', 'hero']), options);
    expect(backwards.css).toBe(forwards.css);
  });

  it('opens with the layer statement and nothing before it', () => {
    // Layer order is fixed by the FIRST `@layer` statement in the document.
    const bundle = assembleCss(TYPICAL, options);
    expect(bundle.css.startsWith(LAYER_STATEMENT)).toBe(true);
    expect(LAYER_STATEMENT).toBe('@layer reset,tokens,base,layout,sections,chrome,state;');
  });

  it('emits the theme inside @layer tokens, never unlayered', () => {
    // Unlayered rules beat every layer, and the live editor's preview writes inline styles that
    // beat both. Keeping the published theme in a layer means preview and publish differ by exactly
    // one mechanism.
    const block = themeBlock(tokens);
    expect(block.startsWith('@layer tokens{:root{')).toBe(true);
    expect(block).toContain('[data-tone="accent"]');
    expect(block).toContain('[data-tone="contrast"]');
  });

  it('emits all 47 tokens in a fixed order', () => {
    const first = themeBlock(tokens);
    const second = themeBlock(
      resolveTheme({
        dnaId: 'warm_trattoria',
        paletteVariant: 'default',
        accentHueShift: '0',
        typeScaleId: 'editorial',
        radiusId: 'soft',
        densityId: 'airy',
        motionId: 'subtle',
        colorMode: 'light',
      }),
    );
    expect(second).toBe(first);
    const root = first.slice(first.indexOf(':root{') + 6, first.indexOf('}'));
    expect(root.split(';')).toHaveLength(47);
  });
});

describe('the hero band constant', () => {
  it('emits the same percentage into the gradient and into grid-template-rows', () => {
    // A geometric proof is only a proof while the two numbers cannot drift apart, so both come
    // from `HERO_COPY_BAND_START_PERCENT`.
    const hero = COMPONENT_CSS.hero;
    const band = `${HERO_COPY_BAND_START_PERCENT}%`;
    expect(hero).toContain(`grid-template-rows:${band} 1fr`);
    // Two gradients (light ink over black, dark ink over white), each with one band stop.
    expect([
      ...hero.matchAll(new RegExp(`var\\(--hero-scrim-band\\)\\) ${band}`, 'gu')),
    ]).toHaveLength(2);
  });

  it('never puts text over a semi-transparent surface that is itself over an image', () => {
    // That composition cannot be proven analytically. The two scrim elements are the only
    // exceptions and neither contains text.
    expect(COMPONENT_CSS.hero).toContain('.hero__scrim{position:absolute');
    expect(COMPONENT_CSS.cta_band).toContain('.s-cta__plate{position:absolute');
    // The plate is SOLID at the proven alpha, not a gradient: the geometry is a box, not a band.
    expect(COMPONENT_CSS.cta_band).toContain('background:rgb(0 0 0 / .66)');
  });
});

describe('the minifier', () => {
  it('is a pure whitespace transform and never touches calc operands', () => {
    expect(minifyCss('a {\n  color: red ;\n}')).toBe('a{color:red}');
    // The space BEFORE a colon is left alone on purpose: removing it would turn the descendant
    // selector `.a :hover` into `.a:hover`, which is a different rule.
    expect(minifyCss('a { color : red }')).toBe('a{color :red}');
    expect(minifyCss('.x{ inline-size:calc(100% - var(--gutter) * 2) }')).toBe(
      '.x{inline-size:calc(100% - var(--gutter) * 2)}',
    );
    // A descendant combinator before a pseudo-class must survive.
    expect(minifyCss('.a :hover{ color:red }')).toBe('.a :hover{color:red}');
    expect(minifyCss('/* gone {} */ .a{ color:red }')).toBe('.a{color:red}');
  });

  it('is idempotent, so a second pass cannot move a byte', () => {
    for (const css of [
      RESET_CSS,
      BASE_CSS,
      LAYOUT_CSS,
      STATE_CSS,
      ...Object.values(COMPONENT_CSS),
    ]) {
      expect(minifyCss(css)).toBe(css);
    }
  });
});

describe('the two documented !important declarations', () => {
  it('appear exactly where they are documented and nowhere else', () => {
    const all = [RESET_CSS, BASE_CSS, LAYOUT_CSS, STATE_CSS, ...Object.values(COMPONENT_CSS)].join(
      '',
    );
    const occurrences = [...all.matchAll(/!important/gu)].length;
    // reset `[hidden]`, four reduced-motion declarations, the hero's reduced-motion `display:none`,
    // and the print block. Every one of them is state or a user preference, which must not be
    // overridable by a knob.
    expect(RESET_CSS).toContain('[hidden]{display:none !important}');
    expect(BASE_CSS).toContain('@media (prefers-reduced-motion:reduce)');
    expect(occurrences).toBeLessThanOrEqual(12);
  });
});
