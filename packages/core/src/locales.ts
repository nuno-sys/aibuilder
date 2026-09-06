import { z } from 'zod';

import { CoreError, UnknownLocaleError } from './errors';

/**
 * The locale registry.
 *
 * Architecture §7.1 and §S4 make one promise about this file: **adding a seventh locale is one
 * entry here plus one `locales` row in D1, and no code change anywhere else.** Everything that
 * varies per locale — the URL segment, the `<html lang>` value, the hreflang value, the reading
 * direction, the sort order, the endonym shown in the language switcher — is a property of the
 * entry below. Nothing in this repository may branch on a locale code; it reads a field instead.
 *
 * The registry is the *build-time* mirror of the `locales` control-plane table. D1 stays the
 * runtime source for the renderer's router (which compiles its matcher from the table at cold
 * start, so a locale insert propagates without a deploy); this file is what the API, the intake
 * schema and the generator validate against, and the two are asserted equal by the migration
 * seed test.
 */

/**
 * Supported locale codes, in display order.
 *
 * Adding a locale means adding its code here and its entry to `LOCALE_REGISTRY` below — the
 * `Record<Locale, …>` type makes forgetting the second half a compile error.
 */
export const LOCALE_CODES = ['nl', 'en', 'de', 'fr', 'es', 'pt'] as const;

/** A supported locale code. */
export type Locale = (typeof LOCALE_CODES)[number];

/**
 * Zod enum over the registry.
 *
 * Architecture §S5 specifies `Locale` as part of the intake contract; it is declared here rather
 * than in `intake.ts` so the seventh locale really is a single-entry change. `intake.ts` imports
 * it.
 */
export const Locale = z.enum(LOCALE_CODES);

/** Text direction of a locale's script. */
export type TextDirection = 'ltr' | 'rtl';

/** One row of the locale registry. */
export interface LocaleDefinition {
  /** ISO 639-1 code. Primary key in D1, and the key used in `SiteDoc.copy`. */
  readonly code: Locale;
  /** Endonym — the language's name in itself. This is what the language switcher renders. */
  readonly label: string;
  /** English name, for internal dashboards and support tooling. */
  readonly englishName: string;
  /**
   * First path segment of every content URL in this locale (`/{urlSegment}/…/`).
   *
   * Deliberately separate from `code`: a future `pt-BR` split would keep `code = 'pt-BR'` while
   * serving `/pt-br/`, and the router only ever matches on this field.
   */
  readonly urlSegment: string;
  /** Value for `<html lang>`. */
  readonly htmlLang: string;
  /** Value for `<link rel="alternate" hreflang>`; must satisfy `^[a-z]{2}(-[A-Z]{2})?$`. */
  readonly hreflang: string;
  /**
   * Extra hreflang values pointing at the same URL (e.g. `pt-BR` on `/pt/`).
   *
   * Two hreflang values resolving to one URL is valid and avoids generating a second copy of the
   * site for a regional variant whose content would be identical. Empty in Phase 1.
   */
  readonly hreflangAliases: readonly string[];
  /** Reading direction. All six Phase 1 locales are `ltr`; the field exists so nothing assumes it. */
  readonly dir: TextDirection;
  /** Exactly one entry carries `true`; it is the fallback locale for the marketing surface. */
  readonly isDefault: boolean;
}

/**
 * The registry itself.
 *
 * `Record<Locale, …>` totality is what turns "I added the code but forgot the row" into a type
 * error rather than a 404 in production.
 */
const LOCALE_REGISTRY: Readonly<Record<Locale, LocaleDefinition>> = {
  nl: {
    code: 'nl',
    label: 'Nederlands',
    englishName: 'Dutch',
    urlSegment: 'nl',
    htmlLang: 'nl',
    hreflang: 'nl',
    hreflangAliases: [],
    dir: 'ltr',
    isDefault: true,
  },
  en: {
    code: 'en',
    label: 'English',
    englishName: 'English',
    urlSegment: 'en',
    htmlLang: 'en',
    hreflang: 'en',
    hreflangAliases: [],
    dir: 'ltr',
    isDefault: false,
  },
  de: {
    code: 'de',
    label: 'Deutsch',
    englishName: 'German',
    urlSegment: 'de',
    htmlLang: 'de',
    hreflang: 'de',
    hreflangAliases: [],
    dir: 'ltr',
    isDefault: false,
  },
  fr: {
    code: 'fr',
    label: 'Français',
    englishName: 'French',
    urlSegment: 'fr',
    htmlLang: 'fr',
    hreflang: 'fr',
    hreflangAliases: [],
    dir: 'ltr',
    isDefault: false,
  },
  es: {
    code: 'es',
    label: 'Español',
    englishName: 'Spanish',
    urlSegment: 'es',
    htmlLang: 'es',
    hreflang: 'es',
    hreflangAliases: [],
    dir: 'ltr',
    isDefault: false,
  },
  pt: {
    code: 'pt',
    label: 'Português',
    englishName: 'Portuguese',
    urlSegment: 'pt',
    htmlLang: 'pt',
    hreflang: 'pt',
    hreflangAliases: [],
    dir: 'ltr',
    isDefault: false,
  },
};

/** Every locale, in display order. The `sort_order` of the D1 row is this array's index × 10. */
export const LOCALES: readonly LocaleDefinition[] = LOCALE_CODES.map(
  (code) => LOCALE_REGISTRY[code],
);

/**
 * The product's fallback locale (`nl` — the target market).
 *
 * Resolved from the registry rather than written twice, and validated at module load: a registry
 * with zero or two defaults is a configuration bug that must fail at deploy, not silently pick the
 * first match at request time.
 */
export const DEFAULT_LOCALE: Locale = ((): Locale => {
  const defaults = LOCALES.filter((locale) => locale.isDefault);
  const only = defaults[0];
  if (defaults.length !== 1 || only === undefined) {
    throw new CoreError(
      'unknown_locale',
      `The locale registry must contain exactly one default; found ${defaults.length}.`,
    );
  }
  return only.code;
})();

/** Narrows an untrusted value (query string, D1 column, model output) to a supported locale. */
export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && Object.hasOwn(LOCALE_REGISTRY, value);
}

/**
 * Narrows an untrusted value to a locale or throws.
 *
 * Use at trust boundaries where a missing locale means the caller is broken (a D1 row, a KV
 * manifest); use `isLocale` where it means the *request* is broken and deserves a 400.
 */
export function assertLocale(value: unknown): Locale {
  if (!isLocale(value)) throw new UnknownLocaleError(String(value));
  return value;
}

/** Returns the registry entry for a locale. Total: every `Locale` has exactly one entry. */
export function localeDefinition(locale: Locale): LocaleDefinition {
  return LOCALE_REGISTRY[locale];
}

/** Returns the first URL path segment for a locale (`nl` → `"nl"`). */
export function localeUrlSegment(locale: Locale): string {
  return LOCALE_REGISTRY[locale].urlSegment;
}

/**
 * Resolves the locale owning a URL segment, or `null`.
 *
 * The renderer's `host → locale` resolution runs on the tenant request path, so this is a plain
 * scan over six entries rather than a lazily-built map — cheaper than the map allocation.
 */
export function localeByUrlSegment(segment: string): LocaleDefinition | null {
  for (const locale of LOCALES) {
    if (locale.urlSegment === segment) return locale;
  }
  return null;
}

/**
 * Builds a canonical content path: `/{urlSegment}/{…}/`.
 *
 * Guarantees invariant I3 (architecture §7.1): lowercase, always locale-prefixed, always a single
 * leading and trailing slash, never a doubled separator. `path` may be given with or without its
 * slashes; `'/'` and `''` both mean the locale home page.
 */
export function localePath(locale: Locale, path: string): string {
  const trimmed = path.trim().toLowerCase().replace(/^\/+/, '').replace(/\/+$/, '');
  const segments = trimmed.length === 0 ? [] : trimmed.split('/').filter((s) => s.length > 0);
  return `/${[localeUrlSegment(locale), ...segments].join('/')}/`;
}

/**
 * Compiles the router's locale matcher from the registry (`^/(nl|en|de|fr|es|pt)(/|$)`).
 *
 * Returned as a fresh `RegExp` per call because a shared one with the `g` flag would carry
 * `lastIndex` between requests; this one has no `g`, but the allocation is trivial and the sharp
 * edge is not worth documenting twice.
 */
export function localeMatcher(): RegExp {
  const alternation = LOCALES.map((locale) => locale.urlSegment).join('|');
  return new RegExp(`^/(${alternation})(?:/|$)`);
}
