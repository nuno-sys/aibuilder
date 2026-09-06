import { InvalidSlugError, SlugSpaceExhaustedError } from './errors';
import type { SlugRejectionReason } from './errors';
import { industryByKey } from './industries';
import { DEFAULT_LOCALE } from './locales';
import type { Locale } from './locales';

/**
 * Slug policy: transliteration, reserved and lookalike checks, collision suffixing, retirement.
 *
 * A tenant slug is a DNS label (`<slug>.${SITES_ROOT_DOMAIN}`) *and* a permanent identity. Both
 * halves drive the rules here:
 *
 *   - **Transliteration is locale-aware, not a generic NFD strip** (architecture §7.5). `Müller`
 *     is `mueller` for a German business and `muller` for a French one; `ß` is `ss` everywhere;
 *     `ĳ` is `ij`. A plain NFD strip returns the empty string for Greek, Cyrillic and Han, which
 *     fails the `slug` CHECK at submit — after 82 seconds of user effort. When transliteration
 *     yields nothing, this module falls back to `{industry}-{city}` and **never returns `""`**.
 *   - **The 63-character cap is applied after collision suffixing**, not before, because a cap
 *     applied first produces a 63-character base that a `-2` suffix pushes over the DNS label limit.
 *   - **Retired slugs are never reused** (architecture §7.6). `retireSlug()` produces the
 *     `reserved_slugs` row that makes that a database invariant rather than a convention.
 *
 * Availability is injected, never queried here: `core` takes bindings as parameters (architecture
 * §2), so the D1 lookup lives in the caller and this module stays a pure, fast, testable policy.
 */

/** Minimum slug length. Matches `IntakeSchema.slug`. */
export const SLUG_MIN_LENGTH = 3;

/** Maximum slug length — the DNS label limit. Matches `IntakeSchema.slug`. */
export const SLUG_MAX_LENGTH = 63;

/** The shape a stored slug must have. Identical to the D1 CHECK and to `IntakeSchema.slug`. */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Transliterations that hold in every locale.
 *
 * These are cases where dropping the diacritic loses a letter rather than an accent: `ß` is two
 * `s`, `ĳ` is two letters, `æ`/`œ` are ligatures, and the Nordic vowels have conventional two-letter
 * romanisations. Keys are lowercase because the input is lowercased first.
 */
const UNIVERSAL_TRANSLITERATION: Readonly<Record<string, string>> = {
  ß: 'ss',
  ĳ: 'ij',
  œ: 'oe',
  æ: 'ae',
  ø: 'oe',
  å: 'aa',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ł: 'l',
  ħ: 'h',
  ı: 'i',
  ŋ: 'ng',
  ẛ: 's',
};

/**
 * Locale overrides, applied before the universal map.
 *
 * German umlauts expand (`ü` is `ue`); the identical Dutch glyph is a diaeresis marking a hiatus
 * and drops to the bare vowel (`geërfd` is `geerfd`, never `geeerfd`). Getting that backwards is
 * the difference between `muellers-bakkerij` and `muellers` for a Dutch customer named Müller who
 * has never spelled it `Mueller` in her life. The Romance entries are what the NFD strip would do
 * anyway; they are listed so the intent is readable rather than emergent.
 */
const LOCALE_TRANSLITERATION: Readonly<Record<Locale, Readonly<Record<string, string>>>> = {
  nl: { ä: 'a', ë: 'e', ï: 'i', ö: 'o', ü: 'u', ĳ: 'ij' },
  en: {},
  de: { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' },
  fr: { ç: 'c', œ: 'oe', æ: 'ae', ë: 'e', ï: 'i', ü: 'u', ÿ: 'y' },
  es: { ñ: 'n', ü: 'u' },
  pt: { ç: 'c', ã: 'a', õ: 'o' },
};

/**
 * Labels that may never become a tenant slug.
 *
 * Three groups, all of which have burned someone: infrastructure labels that would shadow a real
 * host on the sites domain (`mx`, `autodiscover`, `wpad`, `_acme-challenge` — issuing a certificate
 * for a tenant-controlled `_acme-challenge` label is a domain-takeover primitive), product surfaces
 * (`app`, `api`, `preview`), and our own brands.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // Certificate, mail and service-discovery labels.
  '_acme-challenge',
  'acme-challenge',
  'autoconfig',
  'autodiscover',
  'dkim',
  'dmarc',
  'dns',
  'imap',
  'mail',
  'mx',
  'ns',
  'ns1',
  'ns2',
  'ns3',
  'pop',
  'pop3',
  'smtp',
  'spf',
  'webmail',
  'wpad',
  // Infrastructure.
  'assets',
  'backup',
  'backups',
  'cache',
  'cdn',
  'cron',
  'db',
  'edge',
  'files',
  'ftp',
  'host',
  'hosting',
  'img',
  'images',
  'localhost',
  'media',
  'metrics',
  'monitor',
  'origin',
  'proxy',
  'queue',
  'redis',
  'server',
  'servers',
  'ssl',
  'static',
  'storage',
  'tls',
  'upload',
  'uploads',
  'vpn',
  'worker',
  'workers',
  // Product surfaces and reserved routes.
  'about',
  'abuse',
  'account',
  'accounts',
  'admin',
  'alpha',
  'analytics',
  'api',
  'app',
  'apps',
  'auth',
  'avg',
  'beta',
  'billing',
  'blog',
  'build',
  'careers',
  'checkout',
  'ci',
  'claim',
  'client',
  'clients',
  'config',
  'contact',
  'cookies',
  'customer',
  'customers',
  'dashboard',
  'debug',
  'demo',
  'deploy',
  'dev',
  'docs',
  'download',
  'downloads',
  'error',
  'errors',
  'favicon',
  'gdpr',
  'graphql',
  'health',
  'healthz',
  'help',
  'helpdesk',
  'identity',
  'info',
  'internal',
  'invite',
  'invoice',
  'invoices',
  'jobs',
  'legal',
  'log',
  'login',
  'logout',
  'logs',
  'mobile',
  'news',
  'noreply',
  'oauth',
  'oidc',
  'partner',
  'partners',
  'pay',
  'payment',
  'payments',
  'ping',
  'portal',
  'postmaster',
  'press',
  'preview',
  'privacy',
  'private',
  'profile',
  'public',
  'register',
  'robots',
  'root',
  'saml',
  'sandbox',
  'secure',
  'security',
  'settings',
  'signin',
  'signup',
  'sitemap',
  'sso',
  'staging',
  'status',
  'support',
  'sysadmin',
  'team',
  'terms',
  'test',
  'testing',
  'trace',
  'user',
  'users',
  'v1',
  'v2',
  'webmaster',
  'wellknown',
  'well-known',
  'www',
  // Our own brands.
  'aibuilder',
  'mijnsaas',
]);

/**
 * Trademark-lookalike list.
 *
 * Compared against the *confusable skeleton* of a candidate, so `g00gle`, `paypa1` and `rnicrosoft`
 * are caught as well as the literal spellings. Deliberately excludes brands that are also ordinary
 * words in a target-market language (`plus`, `action`, `bol`, `total`, `orange`, `claude`): a
 * hairdresser called Claude is a customer, not a trademark infringement.
 */
export const PROTECTED_BRANDS: readonly string[] = [
  'abnamro',
  'adidas',
  'adyen',
  'airbnb',
  'albertheijn',
  'aldi',
  'amazon',
  'anthropic',
  'apple',
  'asos',
  'audi',
  'aws',
  'bancontact',
  'blokker',
  'bmw',
  'bosch',
  'bunq',
  'chanel',
  'chatgpt',
  'coolblue',
  'decathlon',
  'deliveroo',
  'dhl',
  'disney',
  'dpd',
  'eneco',
  'essent',
  'etos',
  'expedia',
  'facebook',
  'fedex',
  'ferrari',
  'gmail',
  'google',
  'gucci',
  'hellofresh',
  'hema',
  'hotmail',
  'huawei',
  'icloud',
  'ikea',
  'instagram',
  'iphone',
  'jumbo',
  'klarna',
  'klm',
  'knab',
  'kpn',
  'kruidvat',
  'lidl',
  'linkedin',
  'lufthansa',
  'marktplaats',
  'mastercard',
  'mediamarkt',
  'mercedes',
  'microsoft',
  'miele',
  'mollie',
  'netflix',
  'nike',
  'odido',
  'openai',
  'outlook',
  'paypal',
  'peugeot',
  'philips',
  'pinterest',
  'porsche',
  'postnl',
  'prada',
  'puma',
  'rabobank',
  'renault',
  'revolut',
  'rolex',
  'ryanair',
  'samsung',
  'siemens',
  'snapchat',
  'sony',
  'spotify',
  'stripe',
  'thuisbezorgd',
  'tiktok',
  'transavia',
  'tripadvisor',
  'twitter',
  'uber',
  'ubereats',
  'unicredit',
  'uniqlo',
  'vattenfall',
  'vodafone',
  'volkswagen',
  'wehkamp',
  'whatsapp',
  'xbox',
  'xiaomi',
  'youtube',
  'zalando',
  'zara',
  'ziggo',
];

/** Brands short enough that a one-edit neighbourhood would swallow ordinary words. */
const EDIT_DISTANCE_MIN_LENGTH = 6;

/** Brands long enough to be recognisable as a token inside a longer slug. */
const TOKEN_MATCH_MIN_LENGTH = 5;

/**
 * Folds a slug to its confusable skeleton.
 *
 * Only ASCII confusables are folded, and that is not an oversight: transliteration has already run,
 * so a Cyrillic `а` or a Greek `ο` is gone by the time this is called — the residual attack is
 * `rn`/`m`, `vv`/`w`, `cl`/`d` and digit-for-letter, all of which are ASCII and all of which survive
 * every normalisation form. Both sides of a comparison are folded, so the folds only need to be
 * consistent, not linguistically meaningful.
 */
export function confusableSkeleton(slug: string): string {
  return slug
    .replace(/-/g, '')
    .replace(/0/g, 'o')
    .replace(/1/g, 'l')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/8/g, 'b')
    .replace(/9/g, 'g')
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/cl/g, 'd');
}

/** True when `a` and `b` are at most one insertion, deletion or substitution apart. */
function isWithinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** Skeletons of the reserved set, built once. */
const RESERVED_SKELETONS: ReadonlySet<string> = new Set(
  [...RESERVED_SLUGS].map((entry) => confusableSkeleton(entry)),
);

/** Skeletons of the brand list, built once. */
const BRAND_SKELETONS: readonly string[] = PROTECTED_BRANDS.map((brand) =>
  confusableSkeleton(brand),
);

/** True when the slug is on the reserved list verbatim. */
export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug);
}

/**
 * True when the slug is a lookalike of a reserved label or a protected brand.
 *
 * Three tests, tuned so ordinary Dutch business names survive: skeleton equality against the
 * reserved set, skeleton equality or a one-edit distance against brands of at least
 * `EDIT_DISTANCE_MIN_LENGTH` characters, and an exact token match against brands of at least
 * `TOKEN_MATCH_MIN_LENGTH` characters (`mijn-google-site`).
 */
export function isHomoglyphOfReserved(slug: string): boolean {
  const skeleton = confusableSkeleton(slug);
  if (RESERVED_SKELETONS.has(skeleton)) return true;

  for (const brand of BRAND_SKELETONS) {
    if (skeleton === brand) return true;
    if (brand.length >= EDIT_DISTANCE_MIN_LENGTH && isWithinOneEdit(skeleton, brand)) return true;
  }

  const tokens = slug.split('-').map((token) => confusableSkeleton(token));
  for (const token of tokens) {
    if (token.length < TOKEN_MATCH_MIN_LENGTH) continue;
    if (BRAND_SKELETONS.includes(token)) return true;
  }
  return false;
}

/**
 * Transliterates one string to ASCII for the given locale.
 *
 * Order is deliberate: locale map, then universal map, then NFD combining-mark strip as the **last**
 * resort. Anything still non-ASCII after that (Greek, Cyrillic, Han, emoji) is dropped, which is why
 * `slugify()` can return `""` and why `slugSeed()` exists.
 */
export function transliterate(input: string, locale: Locale = DEFAULT_LOCALE): string {
  const lowered = input.normalize('NFC').toLowerCase();
  const overrides = LOCALE_TRANSLITERATION[locale];

  let mapped = '';
  for (const character of lowered) {
    mapped += overrides[character] ?? UNIVERSAL_TRANSLITERATION[character] ?? character;
  }
  return mapped.normalize('NFD').replace(/\p{M}+/gu, '');
}

/**
 * Turns arbitrary text into a slug, or into `""` when nothing survives transliteration.
 *
 * Guarantees the result satisfies `SLUG_PATTERN`, contains no `--`, and is at most
 * `SLUG_MAX_LENGTH` characters. It does **not** guarantee a minimum length, availability or policy
 * compliance — `slugSeed()` and `evaluateSlug()` do that.
 */
export function slugify(input: string, locale: Locale = DEFAULT_LOCALE): string {
  return transliterate(input, locale)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');
}

/** Where a seed slug came from. Surfaced to the UI so "we picked this for you" can be explained. */
export type SlugSeedSource = 'business_name' | 'industry_city' | 'industry';

/** A seed slug and its provenance. */
export interface SlugSeed {
  readonly slug: string;
  readonly source: SlugSeedSource;
}

/**
 * Derives the seed slug for a business.
 *
 * Guarantees a non-empty result. The business name wins when it transliterates to something usable;
 * otherwise the fallback is `{industry}-{city}` in the site's own locale (`kapsalon-amsterdam`, not
 * `hairdresser-amsterdam`), and finally the industry label alone. The collision ladder in
 * `resolveAvailableSlug()` makes the last two unique.
 */
export function slugSeed(params: {
  businessName: string;
  industryKey: string;
  city: string | null;
  locale?: Locale;
}): SlugSeed {
  const locale = params.locale ?? DEFAULT_LOCALE;
  const fromName = slugify(params.businessName, locale);
  if (fromName.length >= SLUG_MIN_LENGTH) return { slug: fromName, source: 'business_name' };

  const industry = industryByKey(params.industryKey);
  const industryLabel = industry === null ? params.industryKey : industry.labels[locale];
  const industrySlug = slugify(industryLabel, locale);
  const citySlug = params.city === null ? '' : slugify(params.city, locale);

  if (industrySlug.length > 0 && citySlug.length > 0) {
    return { slug: capAt(`${industrySlug}-${citySlug}`), source: 'industry_city' };
  }
  if (industrySlug.length > 0) return { slug: industrySlug, source: 'industry' };
  // `industryKey` is ASCII by construction (it is a database key), so this cannot be empty.
  return { slug: slugify(params.industryKey, 'en'), source: 'industry' };
}

/** Truncates to the DNS label limit without leaving a trailing hyphen. */
function capAt(slug: string): string {
  return slug.slice(0, SLUG_MAX_LENGTH).replace(/-+$/g, '');
}

/** The verdict on one candidate slug. `taken` is never returned here — it needs a D1 read. */
export interface SlugEvaluation {
  /** The candidate after normalisation. This is what `GET /v1/slug-check` returns as `normalized`. */
  readonly normalized: string;
  readonly ok: boolean;
  readonly reason: SlugRejectionReason | null;
}

/**
 * Applies every policy check that does not need I/O.
 *
 * Guarantees that a slug it approves satisfies `SLUG_PATTERN`, is between `SLUG_MIN_LENGTH` and
 * `SLUG_MAX_LENGTH` characters, contains no `--`, is not reserved, and is not a lookalike of a
 * reserved label or a protected brand. The API route adds the one remaining check — `taken` —
 * against the control-plane `sites.slug` unique index.
 */
export function evaluateSlug(candidate: string, locale: Locale = DEFAULT_LOCALE): SlugEvaluation {
  const normalized = slugify(candidate, locale);

  if (
    normalized.length < SLUG_MIN_LENGTH ||
    normalized.length > SLUG_MAX_LENGTH ||
    normalized.includes('--') ||
    !SLUG_PATTERN.test(normalized)
  ) {
    return { normalized, ok: false, reason: 'invalid' };
  }
  if (isReservedSlug(normalized)) return { normalized, ok: false, reason: 'reserved' };
  if (isHomoglyphOfReserved(normalized)) return { normalized, ok: false, reason: 'homoglyph' };
  return { normalized, ok: true, reason: null };
}

/**
 * Appends a suffix, applying the 63-character cap **after** the suffix is known.
 *
 * The base is trimmed to make room, never the other way round, so `-2` on a 63-character seed
 * produces a 63-character slug rather than a 65-character one that D1 and DNS both reject.
 */
function withSuffix(base: string, suffix: string): string {
  const room = Math.max(SLUG_MAX_LENGTH - suffix.length, 0);
  const head = base.slice(0, room).replace(/-+$/g, '');
  return head.length === 0 ? suffix.replace(/^-+/, '') : `${head}${suffix}`;
}

/**
 * The Workers/Node `crypto` global.
 *
 * Declared locally because this package compiles with `"types": []` and no DOM lib — it must not
 * depend on `@types/node` or `@cloudflare/workers-types` to stay runnable in a plain vitest run.
 */
declare const crypto: { getRandomValues<T extends ArrayBufferView>(array: T): T };

/** Lowercase Crockford alphabet: no `i`, `l`, `o` or `u`, so a suffix cannot be misread aloud. */
const SUFFIX_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Four random Crockford characters, for the last rung of the collision ladder. */
function randomSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  let out = '';
  for (const byte of bytes) out += SUFFIX_ALPHABET.charAt(byte % SUFFIX_ALPHABET.length);
  return out;
}

/** How many `-2`…`-N` candidates the ladder tries before falling back to randomness. */
const MAX_NUMERIC_SUFFIX = 99;

/** How many random-suffix candidates are tried before giving up. */
const RANDOM_ROUNDS = 3;

/** Inputs for the collision ladder. */
export interface ResolveSlugOptions {
  /** The seed, typically from `slugSeed()`. Normalised again here, so raw input is fine. */
  readonly seed: string;
  /** Locale used for transliteration of the seed and the city. */
  readonly locale?: Locale;
  /** City, used for the first and friendliest collision suffix (`kapsalon-jansen-utrecht`). */
  readonly city?: string | null;
  /** Availability predicate — a `sites.slug` lookup in the control plane, injected by the caller. */
  readonly isTaken: (candidate: string) => Promise<boolean>;
  /** Overridable for tests; defaults to four random Crockford characters. */
  readonly randomSuffix?: () => string;
}

/** The outcome of the collision ladder. */
export interface ResolvedSlug {
  readonly slug: string;
  /** Candidates evaluated, including the winner. Useful as a "hot seed" signal in logs. */
  readonly attempts: number;
  /** False when the seed itself was free. */
  readonly suffixed: boolean;
}

/**
 * Walks the collision ladder until a free, policy-clean slug is found.
 *
 * The order is chosen for what a customer would pick themselves: the seed, then the city
 * (`kapsalon-jansen-amsterdam` reads like a business, `kapsalon-jansen-2` reads like a bug), then
 * a numeric suffix, then randomness. Every candidate is re-checked against the full policy, because
 * a suffix can turn a clean seed into a reserved word or a brand lookalike.
 *
 * @throws SlugSpaceExhaustedError when every rung is taken, which means the availability predicate
 * is broken or the seed is pathological — both need a human, not a 63-character random string.
 */
export async function resolveAvailableSlug(options: ResolveSlugOptions): Promise<ResolvedSlug> {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const nextRandom = options.randomSuffix ?? randomSuffix;
  const base = slugify(options.seed, locale);
  const citySlug =
    options.city === undefined || options.city === null ? '' : slugify(options.city, locale);

  const suffixes: string[] = ['', ...(citySlug.length > 0 ? [`-${citySlug}`] : [])];
  for (let n = 2; n <= MAX_NUMERIC_SUFFIX; n += 1) suffixes.push(`-${n}`);

  const seen = new Set<string>();
  let attempts = 0;

  for (const suffix of suffixes) {
    const candidate = suffix === '' ? base : withSuffix(base, suffix);
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    const evaluation = evaluateSlug(candidate, locale);
    if (!evaluation.ok) continue;
    attempts += 1;
    if (await options.isTaken(evaluation.normalized)) continue;
    return { slug: evaluation.normalized, attempts, suffixed: suffix !== '' };
  }

  for (let round = 0; round < RANDOM_ROUNDS; round += 1) {
    const candidate = withSuffix(base, `-${nextRandom()}`);
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    const evaluation = evaluateSlug(candidate, locale);
    if (!evaluation.ok) continue;
    attempts += 1;
    if (await options.isTaken(evaluation.normalized)) continue;
    return { slug: evaluation.normalized, attempts, suffixed: true };
  }

  throw new SlugSpaceExhaustedError(options.seed, attempts);
}

/** The `reserved_slugs` row that retires a slug, plus the alias that keeps its URLs alive. */
export interface RetiredSlug {
  /** The slug being retired. Inserted into `reserved_slugs` so it can never be issued again. */
  readonly slug: string;
  /** The slug that replaces it. The retired host 301s here, forever. */
  readonly replacedBy: string;
  /** The site that owned the retired slug. */
  readonly siteId: string;
  /** Epoch milliseconds, written to `reserved_slugs.retired_at`. */
  readonly retiredAt: number;
}

/**
 * Retires a slug in favour of a new one.
 *
 * Architecture §7.6 and the domain-migration rules: the redirect is permanent and the slug is never
 * reused — not by this tenant and not by the next one, because a stale link or a printed flyer
 * pointing at `oude-kapsalon.mijnsaas.com` must never land on somebody else's business.
 *
 * @throws InvalidSlugError when either slug is malformed, or when they are the same slug.
 */
export function retireSlug(params: {
  previousSlug: string;
  newSlug: string;
  siteId: string;
  now?: number;
}): RetiredSlug {
  const previous = params.previousSlug;
  const next = params.newSlug;

  if (!SLUG_PATTERN.test(previous) || previous.includes('--')) {
    throw new InvalidSlugError(previous, 'invalid');
  }
  if (!SLUG_PATTERN.test(next) || next.includes('--')) {
    throw new InvalidSlugError(next, 'invalid');
  }
  if (previous === next) throw new InvalidSlugError(previous, 'taken');

  return {
    slug: previous,
    replacedBy: next,
    siteId: params.siteId,
    retiredAt: params.now ?? Date.now(),
  };
}
