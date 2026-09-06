import { describe, expect, it } from 'vitest';

import { SlugSpaceExhaustedError } from '../errors';
import {
  SLUG_MAX_LENGTH,
  evaluateSlug,
  resolveAvailableSlug,
  retireSlug,
  slugSeed,
  slugify,
  transliterate,
} from '../slug';

describe('transliterate', () => {
  it('expands German umlauts and the eszett', () => {
    expect(transliterate('Müller & Söhne Straße', 'de')).toBe('mueller & soehne strasse');
  });

  it('drops the Dutch diaeresis instead of expanding it', () => {
    // `ë` in Dutch marks a hiatus, not an umlaut: `geërfd` is `geerfd`, never `geeerfd`.
    expect(transliterate('Geërfd Café Müller', 'nl')).toBe('geerfd cafe muller');
  });

  it('expands ligatures and Nordic vowels in every locale', () => {
    expect(slugify('Cœur de Lyon', 'fr')).toBe('coeur-de-lyon');
    expect(slugify('Kærgård Øst', 'nl')).toBe('kaergaard-oest');
    expect(slugify('Ĳssalon Vroomshoop', 'nl')).toBe('ijssalon-vroomshoop');
  });

  it('strips the remaining diacritics as a last resort', () => {
    expect(slugify('Peña Niño', 'es')).toBe('pena-nino');
    expect(slugify('Ação Coração', 'pt')).toBe('acao-coracao');
    expect(slugify('Crème Brûlée', 'fr')).toBe('creme-brulee');
  });
});

describe('slugify', () => {
  it('produces a slug that satisfies the intake pattern', () => {
    expect(slugify('  Bakkerij   Jansen & Zn.  ')).toBe('bakkerij-jansen-zn');
    expect(slugify('kapsalon--de--knip')).toBe('kapsalon-de-knip');
    expect(slugify('---')).toBe('');
  });

  it('returns the empty string for scripts that do not transliterate', () => {
    // This is the case that used to fail the `slug` CHECK at submit, after the user had already
    // spent 82 seconds in the modal. `slugSeed()` is what turns it into a usable slug.
    expect(slugify('Καφενείο Αθήνα', 'nl')).toBe('');
    expect(slugify('Ресторан Москва', 'nl')).toBe('');
    expect(slugify('北京饭店', 'nl')).toBe('');
  });

  it('never exceeds the DNS label limit and never ends on a hyphen', () => {
    const slug = slugify(`${'kapsalon-'.repeat(7)}amsterdam`);
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('slugSeed', () => {
  it('uses the business name when it transliterates', () => {
    expect(
      slugSeed({ businessName: 'Bakkerij Jansen', industryKey: 'bakery', city: 'Amsterdam' }),
    ).toEqual({ slug: 'bakkerij-jansen', source: 'business_name' });
  });

  it('falls back to industry and city for a Greek business name', () => {
    expect(
      slugSeed({ businessName: 'Καφενείο', industryKey: 'cafe', city: 'Athina', locale: 'nl' }),
    ).toEqual({ slug: 'cafe-lunchroom-athina', source: 'industry_city' });
  });

  it('falls back to the industry alone when there is no city either', () => {
    expect(
      slugSeed({ businessName: 'Ресторан', industryKey: 'restaurant', city: null, locale: 'nl' }),
    ).toEqual({ slug: 'restaurant', source: 'industry' });
  });

  it('never returns an empty slug, even for an unknown industry key', () => {
    const seed = slugSeed({ businessName: '北京饭店', industryKey: 'unlisted_trade', city: null });
    expect(seed.slug).toBe('unlisted-trade');
  });
});

describe('evaluateSlug', () => {
  it('accepts an ordinary business slug', () => {
    expect(evaluateSlug('Bakkerij Jansen')).toEqual({
      normalized: 'bakkerij-jansen',
      ok: true,
      reason: null,
    });
    expect(evaluateSlug('garage-van-dijk').ok).toBe(true);
    expect(evaluateSlug('kapsalon-de-knip').ok).toBe(true);
  });

  it('rejects slugs that are too short or unusable', () => {
    expect(evaluateSlug('ab').reason).toBe('invalid');
    expect(evaluateSlug('Καφενείο').reason).toBe('invalid');
  });

  it('rejects reserved infrastructure labels', () => {
    expect(evaluateSlug('www').reason).toBe('reserved');
    expect(evaluateSlug('autodiscover').reason).toBe('reserved');
    expect(evaluateSlug('preview').reason).toBe('reserved');
  });

  it('rejects ASCII homoglyphs of reserved labels and protected brands', () => {
    expect(evaluateSlug('g00gle').reason).toBe('homoglyph');
    expect(evaluateSlug('paypa1').reason).toBe('homoglyph');
    expect(evaluateSlug('rnicrosoft').reason).toBe('homoglyph');
    expect(evaluateSlug('goggle').reason).toBe('homoglyph');
    expect(evaluateSlug('mijn-google-site').reason).toBe('homoglyph');
  });

  it('does not reject ordinary words that merely resemble a short brand', () => {
    expect(evaluateSlug('salon-claude').ok).toBe(true);
    expect(evaluateSlug('de-appel-bakkerij').ok).toBe(true);
    expect(evaluateSlug('uber-optiek-koln').ok).toBe(true);
  });
});

describe('resolveAvailableSlug', () => {
  it('returns the seed when it is free', async () => {
    const result = await resolveAvailableSlug({
      seed: 'kapsalon-jansen',
      isTaken: async () => false,
    });
    expect(result).toEqual({ slug: 'kapsalon-jansen', attempts: 1, suffixed: false });
  });

  it('prefers the city suffix over a number', async () => {
    const result = await resolveAvailableSlug({
      seed: 'kapsalon-jansen',
      city: 'Utrecht',
      isTaken: async (candidate) => candidate === 'kapsalon-jansen',
    });
    expect(result.slug).toBe('kapsalon-jansen-utrecht');
    expect(result.suffixed).toBe(true);
  });

  it('falls through to the numeric ladder', async () => {
    const result = await resolveAvailableSlug({
      seed: 'kapsalon-jansen',
      city: 'Utrecht',
      isTaken: async (candidate) =>
        candidate === 'kapsalon-jansen' || candidate === 'kapsalon-jansen-utrecht',
    });
    expect(result.slug).toBe('kapsalon-jansen-2');
  });

  it('applies the 63-character cap after suffixing, not before', async () => {
    const seed = `${'kapsalon-'.repeat(7)}amsterdam`;
    const result = await resolveAvailableSlug({
      seed,
      isTaken: async (candidate) => !candidate.endsWith('-2'),
    });

    expect(result.slug.length).toBe(SLUG_MAX_LENGTH);
    expect(result.slug.endsWith('-2')).toBe(true);
    expect(result.slug.includes('--')).toBe(false);
  });

  it('falls back to a random suffix when the whole ladder is taken', async () => {
    const result = await resolveAvailableSlug({
      seed: 'kapsalon',
      isTaken: async (candidate) => candidate !== 'kapsalon-ab12',
      randomSuffix: () => 'ab12',
    });
    expect(result.slug).toBe('kapsalon-ab12');
  });

  it('throws rather than inventing a slug when nothing is available', async () => {
    await expect(
      resolveAvailableSlug({
        seed: 'kapsalon',
        isTaken: async () => true,
        randomSuffix: () => 'ab12',
      }),
    ).rejects.toBeInstanceOf(SlugSpaceExhaustedError);
  });
});

describe('retireSlug', () => {
  it('produces the reserved_slugs row that makes reuse impossible', () => {
    const retired = retireSlug({
      previousSlug: 'oude-kapsalon',
      newSlug: 'kapsalon-jansen',
      siteId: 'ste_01JQZQ8XKF3M2N4P5R6S7T8V9W',
      now: 1_760_000_000_000,
    });

    expect(retired).toEqual({
      slug: 'oude-kapsalon',
      replacedBy: 'kapsalon-jansen',
      siteId: 'ste_01JQZQ8XKF3M2N4P5R6S7T8V9W',
      retiredAt: 1_760_000_000_000,
    });
  });

  it('refuses to retire a slug in favour of itself', () => {
    expect(() =>
      retireSlug({ previousSlug: 'kapsalon', newSlug: 'kapsalon', siteId: 'ste_x' }),
    ).toThrow();
  });

  it('refuses a malformed slug on either side', () => {
    expect(() =>
      retireSlug({ previousSlug: 'Oude Kapsalon', newSlug: 'kapsalon', siteId: 'ste_x' }),
    ).toThrow();
    expect(() =>
      retireSlug({ previousSlug: 'oude-kapsalon', newSlug: 'kap--salon', siteId: 'ste_x' }),
    ).toThrow();
  });
});
