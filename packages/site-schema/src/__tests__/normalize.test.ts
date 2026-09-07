import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  normalizeBlogPost,
  normalizeHexColor,
  normalizeIdentifier,
  normalizeLocaleBundle,
  normalizeStructure,
  normalizeText,
  truncateAtWordBoundary,
} from '../normalize';
import type { DocumentNormalizeContext, RepairCode } from '../normalize';
import { SiteStructureGen } from '../gen/site-structure';
import { deriveSlotInventory } from '../slots';
import {
  fullBundle,
  heroSection,
  makePage,
  makeStructure,
  testContext,
  uspSection,
} from './fixtures';

const structure = makeStructure([
  makePage('home', 'home', [heroSection('h1'), uspSection('u1', 3)]),
]);
const inventory = deriveSlotInventory(structure);
const documentContext: DocumentNormalizeContext = {
  ...testContext,
  knownPageIds: new Set(['home']),
  knownSectionIds: new Set(['h1', 'u1']),
};

function codes(repairs: readonly { readonly code: RepairCode }[]): readonly RepairCode[] {
  return repairs.map((repair) => repair.code);
}

describe('truncateAtWordBoundary', () => {
  it('keeps text that already fits', () => {
    expect(truncateAtWordBoundary('Kort genoeg', 40)).toBe('Kort genoeg');
  });

  it('cuts at the word boundary rather than mid-word', () => {
    expect(truncateAtWordBoundary('Wij maken uw website vandaag nog', 18)).toBe('Wij maken uw');
  });

  it('keeps a word that ends exactly on the budget', () => {
    expect(truncateAtWordBoundary('Wij maken uw website vandaag nog', 20)).toBe(
      'Wij maken uw website',
    );
  });

  it('hard-cuts rather than throwing away more than 40% of the budget', () => {
    expect(truncateAtWordBoundary('Op maatwerkkeukenrenovatie', 12)).toBe('Op maatwerkk');
  });

  it('never appends an ellipsis, and trims trailing punctuation', () => {
    const cut = truncateAtWordBoundary('Snel, eerlijk, vakkundig werk', 13);

    expect(cut).toBe('Snel, eerlijk');
    expect(cut.endsWith('...')).toBe(false);
  });
});

describe('normalizeText', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeText('  Veel    ruimte\n\ttussen  ', 100)).toBe('Veel ruimte tussen');
  });

  it('strips bidi and zero-width characters that survive HTML escaping', () => {
    const bidiOverride = String.fromCodePoint(0x202e);
    const zeroWidth = String.fromCodePoint(0x200b);

    expect(normalizeText(`Prijs${bidiOverride}10${zeroWidth} EUR`, 100)).toBe('Prijs10 EUR');
  });

  it('returns the empty string for anything that is not a string', () => {
    expect(normalizeText(null, 20)).toBe('');
    expect(normalizeText(42, 20)).toBe('');
    expect(normalizeText({ text: 'nee' }, 20)).toBe('');
  });
});

describe('normalizeHexColor', () => {
  it('lowercases and expands shorthand', () => {
    expect(normalizeHexColor('#ABC')).toBe('#aabbcc');
    expect(normalizeHexColor('#A1B2C3')).toBe('#a1b2c3');
    expect(normalizeHexColor('  #AABBCCDD ')).toBe('#aabbccdd');
    expect(normalizeHexColor('A1B2C3')).toBe('#a1b2c3');
  });

  it('returns null for anything that is not a hex colour', () => {
    expect(normalizeHexColor('rebeccapurple')).toBeNull();
    expect(normalizeHexColor('#12345')).toBeNull();
    expect(normalizeHexColor(undefined)).toBeNull();
  });
});

describe('normalizeIdentifier', () => {
  it('closes the charset so an id is safe as a DOM id and a CSS selector', () => {
    expect(normalizeIdentifier('Hero Sectie!', 'fallback')).toBe('hero-sectie');
    expect(normalizeIdentifier('3col', 'fallback')).toBe('id-3col');
    expect(normalizeIdentifier('   ', 'fallback')).toBe('fallback');
    expect(normalizeIdentifier('page', 'fallback')).toBe('fallback');
  });
});

describe('normalizeStructure', () => {
  it('clamps an over-long array down to the limit', () => {
    const raw: unknown = makeStructure([makePage('home', 'home', [uspSection('u1', 9)])]);

    const result = normalizeStructure(raw, testContext);
    const section = result.value?.pages[0]?.sections[0];

    expect(section?.type).toBe('usp_trio');
    if (section?.type !== 'usp_trio') throw new Error('expected a usp_trio section');
    expect(section.items).toHaveLength(LIMITS.uspItems.max);
    expect(codes(result.repairs)).toContain('array_truncated');
  });

  it('pads an under-filled array up to the minimum', () => {
    const raw: unknown = makeStructure([makePage('home', 'home', [uspSection('u1', 1)])]);

    const result = normalizeStructure(raw, testContext);
    const section = result.value?.pages[0]?.sections[0];

    if (section?.type !== 'usp_trio') throw new Error('expected a usp_trio section');
    expect(section.items).toHaveLength(LIMITS.uspItems.min);
    expect(codes(result.repairs)).toContain('array_padded');
  });

  it('renames duplicate section ids so slot ids stay unique', () => {
    const raw: unknown = makeStructure([
      makePage('home', 'home', [uspSection('dup', 2)]),
      makePage('about', 'about', [uspSection('dup', 2)]),
    ]);

    const result = normalizeStructure(raw, testContext);
    const ids = result.value?.pages.flatMap((page) => page.sections.map((s) => s.id)) ?? [];

    expect(ids).toEqual(['dup', 'dup-2']);
    expect(codes(result.repairs)).toContain('duplicate_id_renamed');
  });

  it('drops a media ref that is not in the manifest', () => {
    const raw: unknown = makeStructure([
      makePage('home', 'home', [
        { ...heroSection('h1'), media: { refId: 'does-not-exist', focalPoint: 'center' } },
      ]),
    ]);

    const result = normalizeStructure(raw, testContext);
    const section = result.value?.pages[0]?.sections[0];

    if (section?.type !== 'hero') throw new Error('expected a hero section');
    expect(section.media).toBeNull();
    expect(codes(result.repairs)).toContain('dangling_media_ref_dropped');
  });

  it('drops a link that points at a page which does not exist', () => {
    const raw: unknown = makeStructure([
      makePage('home', 'home', [
        {
          ...heroSection('h1'),
          ctas: [{ target: { kind: 'page', pageId: 'ghost' }, style: 'primary' }],
        },
      ]),
    ]);

    const result = normalizeStructure(raw, testContext);
    const section = result.value?.pages[0]?.sections[0];

    if (section?.type !== 'hero') throw new Error('expected a hero section');
    expect(codes(result.repairs)).toContain('dangling_link_ref_dropped');
    // The dangling target is gone, and the hero is not left with nothing to do: the header is two
    // buttons over moving footage, so the backfill dresses it from the site's own routing. This
    // fixture is a one-page site with nowhere to point, which is what the last resort is for.
    expect(section.ctas.some((cta) => JSON.stringify(cta.target).includes('ghost'))).toBe(false);
    expect(section.ctas).toHaveLength(2);
    expect(codes(result.repairs)).toContain('hero_ctas_backfilled');
  });

  it('gives every hero two buttons, pointing at the pages the site actually has', () => {
    const raw: unknown = makeStructure([
      makePage('home', 'home', [{ ...heroSection('h1'), ctas: [] }]),
      makePage('services', 'services', [{ ...heroSection('h2'), ctas: [] }]),
      makePage('contact', 'contact', [{ ...heroSection('h3'), ctas: [] }]),
    ]);

    const result = normalizeStructure(raw, testContext);
    for (const page of result.value?.pages ?? []) {
      const section = page.sections[0];
      if (section?.type !== 'hero') throw new Error('expected a hero section');
      expect(section.ctas).toHaveLength(2);
      // Services first, contact second: the order a visitor's intent runs in. Two buttons that
      // lead to the same place are one button, so the second is never a copy of the first.
      expect(section.ctas[0]?.target).toEqual({ kind: 'page', pageId: 'services' });
      expect(section.ctas[1]?.target).toEqual({ kind: 'page', pageId: 'contact' });
      expect(section.ctas[0]?.style).toBe('primary');
      expect(section.ctas[1]?.style).toBe('secondary');
    }
  });

  it('keeps the buttons the model chose and only fills the gap', () => {
    const raw: unknown = makeStructure([
      makePage('home', 'home', [
        {
          ...heroSection('h1'),
          ctas: [{ target: { kind: 'whatsapp', _: null }, style: 'ghost' }],
        },
      ]),
      makePage('contact', 'contact', [heroSection('h2')]),
    ]);

    const result = normalizeStructure(raw, testContext);
    const section = result.value?.pages[0]?.sections[0];

    if (section?.type !== 'hero') throw new Error('expected a hero section');
    expect(section.ctas).toHaveLength(2);
    expect(section.ctas[0]).toEqual({ target: { kind: 'whatsapp', _: null }, style: 'ghost' });
    expect(section.ctas[1]?.target).toEqual({ kind: 'page', pageId: 'contact' });
  });

  it('reports an unsalvageable document instead of throwing', () => {
    const result = normalizeStructure({ pages: [] }, testContext);

    expect(result.value).toBeNull();
    expect(codes(result.repairs)).toContain('unsalvageable');
  });
});

describe('normalizeLocaleBundle', () => {
  it('drops slot ids the model invented', () => {
    const bundle = fullBundle(structure);
    const raw: unknown = {
      ...bundle,
      entries: [...bundle.entries, { id: 'h1.invented', text: 'Verzonnen' }],
    };

    const result = normalizeLocaleBundle(raw, inventory, testContext);
    const ids = result.value?.entries.map((entry) => entry.id) ?? [];

    expect(ids).not.toContain('h1.invented');
    expect(ids).toHaveLength(inventory.slots.length);
    expect(codes(result.repairs)).toContain('unknown_slot_dropped');
  });

  it('keeps the first of two entries for the same slot', () => {
    const raw: unknown = {
      schemaVersion: '1',
      locale: 'nl',
      entries: [
        { id: 'h1.headline', text: 'Eerste' },
        { id: 'h1.headline', text: 'Tweede' },
      ],
    };

    const result = normalizeLocaleBundle(raw, inventory, testContext);

    expect(result.value?.entries).toEqual([{ id: 'h1.headline', text: 'Eerste' }]);
    expect(codes(result.repairs)).toContain('duplicate_entry_dropped');
  });

  it("truncates copy at its slot's ceiling and emits entries in inventory order", () => {
    const raw: unknown = {
      schemaVersion: '1',
      locale: 'nl',
      entries: [
        { id: 'h1.headline', text: 'Kop' },
        { id: 'page.home.nav.label', text: 'Een veel te lange navigatielabeltekst hier' },
      ],
    };

    const result = normalizeLocaleBundle(raw, inventory, testContext);
    const entries = result.value?.entries ?? [];

    expect(entries[0]?.id).toBe('page.home.nav.label');
    expect([...(entries[0]?.text ?? '')].length).toBeLessThanOrEqual(24);
    expect(entries[1]?.id).toBe('h1.headline');
  });

  it('drops blank copy so it surfaces as missing, not as an empty page', () => {
    const raw: unknown = {
      schemaVersion: '1',
      locale: 'nl',
      entries: [{ id: 'h1.headline', text: '   ' }],
    };

    const result = normalizeLocaleBundle(raw, inventory, testContext);

    expect(result.value?.entries).toEqual([]);
    expect(codes(result.repairs)).toContain('blank_slot_dropped');
  });

  it('falls back to the primary locale when the model picks one we do not sell', () => {
    const raw: unknown = { schemaVersion: '1', locale: 'ja', entries: [] };

    const result = normalizeLocaleBundle(raw, inventory, testContext);

    expect(result.value?.locale).toBe('nl');
    expect(codes(result.repairs)).toContain('enum_fallback');
  });
});

describe('garbage input', () => {
  const circular: Record<string, unknown> = { pages: [] };
  circular.self = circular;

  const garbage: readonly unknown[] = [
    null,
    undefined,
    0,
    42,
    '',
    'een string',
    true,
    [],
    [1, 2, 3],
    {},
    { pages: 'geen array' },
    { pages: [{ sections: [{ type: {} }] }] },
    { pages: [{ pageId: 7, sections: [{ id: [], type: 'hero', ctas: 'nee' }] }] },
    { schemaVersion: 99, entries: 'nee' },
    { entries: [{ id: null, text: [] }] },
    { blocks: [{ type: 'p' }, { type: 'onbekend' }] },
    circular,
    new Map<string, string>([['a', 'b']]),
    Symbol('nope'),
  ];

  it('never throws, whatever it is handed', () => {
    for (const input of garbage) {
      expect(() => normalizeStructure(input, testContext)).not.toThrow();
      expect(() => normalizeLocaleBundle(input, inventory, testContext)).not.toThrow();
      expect(() => normalizeBlogPost(input, documentContext)).not.toThrow();
    }
  });

  it('returns a repair log, and anything that survives is schema-valid', () => {
    for (const input of garbage) {
      const result = normalizeStructure(input, testContext);

      expect(Array.isArray(result.repairs)).toBe(true);
      if (result.value !== null) {
        expect(SiteStructureGen.safeParse(result.value).success).toBe(true);
      }
    }
  });
});

describe('normalizeBlogPost', () => {
  it('keeps a usable post and drops the blocks it cannot render', () => {
    const raw: unknown = {
      schemaVersion: '1',
      locale: 'nl',
      titleText: 'Vijf tips voor uw kapsel',
      slugSeed: 'vijf tips',
      excerptText: 'Kort en bondig.',
      metaDescriptionText: 'Vijf praktische tips.',
      heroMedia: { refId: 'm2', focalPoint: 'top' },
      blocks: [
        { type: 'p', text: 'Een gewone alinea.' },
        { type: 'p', text: '   ' },
        { type: 'image', media: { refId: 'bestaat-niet', focalPoint: 'center' } },
        { type: 'cta', labelText: 'Maak een afspraak', target: { kind: 'page', pageId: 'home' } },
        { type: 'cta', labelText: 'Kapot', target: { kind: 'page', pageId: 'ghost' } },
      ],
    };

    const result = normalizeBlogPost(raw, documentContext);

    expect(result.value?.blocks.map((block) => block.type)).toEqual(['p', 'cta']);
    expect(codes(result.repairs)).toContain('block_dropped');
  });

  it('refuses a post with no body rather than publishing a thin page', () => {
    const raw: unknown = { schemaVersion: '1', locale: 'nl', titleText: 'Leeg', blocks: [] };

    const result = normalizeBlogPost(raw, documentContext);

    expect(result.value).toBeNull();
    expect(codes(result.repairs)).toContain('unsalvageable');
  });
});
