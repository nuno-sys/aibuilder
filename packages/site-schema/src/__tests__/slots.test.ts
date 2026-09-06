import { describe, expect, it } from 'vitest';
import {
  deriveSlotInventory,
  pageMetaSlotId,
  pageNavSlotId,
  sectionSlotId,
  validateBundle,
} from '../slots';
import { fullBundle, heroSection, makePage, makeStructure, uspSection } from './fixtures';

const structure = makeStructure([
  makePage('home', 'home', [heroSection('h1'), uspSection('u1', 2)]),
]);

describe('deriveSlotInventory', () => {
  it('derives exactly the documented slot ids, in document order', () => {
    const ids = deriveSlotInventory(structure).slots.map((slot) => slot.id);

    expect(ids).toEqual([
      'page.home.meta.title',
      'page.home.meta.description',
      'page.home.meta.slug',
      'page.home.nav.label',
      'h1.headline',
      'h1.subhead',
      'h1.trustline',
      'h1.ctas.0.label',
      'u1.headline',
      'u1.items.0.title',
      'u1.items.0.body',
      'u1.items.1.title',
      'u1.items.1.body',
    ]);
  });

  it('agrees with the exported id builders', () => {
    const { ids } = deriveSlotInventory(structure);

    expect(ids.has(pageMetaSlotId('home', 'title'))).toBe(true);
    expect(ids.has(pageNavSlotId('home'))).toBe(true);
    expect(ids.has(sectionSlotId('u1', 'items', 1, 'body'))).toBe(true);
  });

  it('is stable: the same structure derives the same ids every time', () => {
    const first = deriveSlotInventory(structure).slots.map((slot) => slot.id);
    const second = deriveSlotInventory(structure).slots.map((slot) => slot.id);
    const rebuilt = deriveSlotInventory(
      makeStructure([makePage('home', 'home', [heroSection('h1'), uspSection('u1', 2)])]),
    ).slots.map((slot) => slot.id);

    expect(second).toEqual(first);
    expect(rebuilt).toEqual(first);
  });

  it('drops the optional slots the structure did not ask for', () => {
    const withoutTrustline = makeStructure([
      makePage('home', 'home', [{ ...heroSection('h1'), showTrustline: false }]),
    ]);
    const hidden = makeStructure([
      { ...makePage('home', 'home', [heroSection('h1')]), showInNav: false },
    ]);

    expect(deriveSlotInventory(withoutTrustline).ids.has('h1.trustline')).toBe(false);
    expect(deriveSlotInventory(hidden).ids.has(pageNavSlotId('home'))).toBe(false);
  });

  it('never emits the same id twice, even when two sections collide', () => {
    const collided = makeStructure([
      makePage('home', 'home', [uspSection('dup', 1)]),
      makePage('about', 'about', [uspSection('dup', 1)]),
    ]);
    const inventory = deriveSlotInventory(collided);

    expect(inventory.slots).toHaveLength(inventory.ids.size);
  });
});

describe('validateBundle', () => {
  it('accepts a bundle whose key set matches the inventory exactly', () => {
    const result = validateBundle(structure, fullBundle(structure));

    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.unknown).toEqual([]);
  });

  it('catches a missing slot', () => {
    const bundle = fullBundle(structure);
    const short = {
      ...bundle,
      entries: bundle.entries.filter((entry) => entry.id !== 'h1.subhead'),
    };

    const result = validateBundle(structure, short);

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['h1.subhead']);
    expect(result.unknown).toEqual([]);
  });

  it('catches an extra slot the model invented', () => {
    const bundle = fullBundle(structure);
    const extra = {
      ...bundle,
      entries: [...bundle.entries, { id: 'h1.invented', text: 'Verzonnen' }],
    };

    const result = validateBundle(structure, extra);

    expect(result.ok).toBe(false);
    expect(result.unknown).toEqual(['h1.invented']);
    expect(result.missing).toEqual([]);
  });

  it('separates blank, duplicate and overlong copy from missing copy', () => {
    const bundle = fullBundle(structure);
    const damaged = {
      ...bundle,
      entries: [
        ...bundle.entries.map((entry) => {
          if (entry.id === 'h1.headline') return { ...entry, text: '   ' };
          if (entry.id === 'page.home.meta.title') return { ...entry, text: 'x'.repeat(61) };
          return entry;
        }),
        { id: 'u1.headline', text: 'Nogmaals' },
      ],
    };

    const result = validateBundle(structure, damaged);

    expect(result.blank).toEqual(['h1.headline']);
    expect(result.duplicate).toEqual(['u1.headline']);
    expect(result.missing).toEqual([]);
    expect(result.overlong).toEqual([{ id: 'page.home.meta.title', length: 61, max: 60 }]);
  });
});
