/**
 * Field validation and the whole error vocabulary of the modal, in Dutch and English.
 *
 * TWO PROPERTIES THIS MODULE GUARANTEES, both of them WCAG requirements rather than niceties:
 *
 *  1. **Every message names the problem *and* the fix** (SC 3.3.1, 3.3.3). There is no "Ongeldige
 *     invoer" anywhere in this file. `Een Nederlandse postcode ziet er zo uit: 1012 AB` is a
 *     message; `Ongeldig` is a shrug.
 *  2. **Dutch and English sit side by side in one table.** The second locale is a lookup, never a
 *     rewrite, and a code with copy in one language and not the other is a compile error because
 *     the table is a total `Record<ValidationCode, LocalisedMessage>`.
 *
 * Codes are flat, dotted strings (`phone.invalid`) rather than nested objects: they are what the
 * error summary anchors to, what analytics counts, and what a support engineer greps for.
 *
 * WHEN VALIDATION RUNS (UX §2): on blur and on submit, never on keystroke — except for the
 * *positive* signals (slug availability, live phone formatting), which are live because a green
 * tick mid-typing is encouragement and a red cross mid-typing is an accusation. Once a field HAS
 * errored, it re-validates on input, so the error clears the instant it is fixed.
 */

import { IntakeSchema } from '@aibuilder/core';
import type { Intake, Locale, OpeningHours } from '@aibuilder/core';

import { damerauLevenshtein, fold, normaliseFreeText } from './text';

/** The two locales the modal has hand-written copy for. Phase 2 adds de/fr/es/pt. */
export type CopyLocale = 'nl' | 'en';

/**
 * Maps any supported locale onto the two the modal has copy for.
 *
 * A German visitor reading English is a known, honest gap; a German visitor reading a machine
 * translation of a validation error is a worse one. Phase 2 adds the other four tables.
 */
export function copyLocale(locale: Locale): CopyLocale {
  return locale === 'nl' ? 'nl' : 'en';
}

/** One message in both languages. */
export interface LocalisedMessage {
  readonly nl: string;
  readonly en: string;
}

/** Every validation outcome the modal can report. */
export type ValidationCode =
  // Step 1 — business name and slug
  | 'businessName.empty'
  | 'businessName.tooShort'
  | 'businessName.noLetters'
  | 'businessName.looksLikeUrl'
  | 'slug.taken'
  | 'slug.reserved'
  | 'slug.invalid'
  | 'slug.homoglyph'
  // Step 2 — industry
  | 'industry.empty'
  | 'industry.noMatch'
  // Step 3 — address
  | 'address.empty'
  | 'address.postcodeNl'
  | 'address.postcodeBe'
  | 'address.houseNumber'
  | 'address.notFound'
  | 'address.lookupDown'
  | 'address.cityEmpty'
  | 'serviceArea.cityEmpty'
  // Step 4 — hours
  | 'hours.endBeforeStart'
  | 'hours.overlap'
  | 'hours.allClosed'
  // Step 5 — contact
  | 'phone.empty'
  | 'phone.invalid'
  | 'phone.whatsappLandline'
  | 'gbp.notGoogle'
  // Step 6 — story, email, consent
  | 'description.tooShort'
  | 'description.tooLong'
  | 'description.containsContact'
  | 'email.empty'
  | 'email.invalid'
  | 'email.typo'
  | 'email.alreadyUsed'
  // Media (UX §4.6)
  | 'media.wrongType'
  | 'media.tooLarge'
  | 'media.tooSmall'
  | 'media.tooMany'
  | 'media.decodeFailed'
  | 'media.uploadFailed'
  | 'media.quarantined'
  | 'media.offline';

/**
 * The copy table. UX §2 and §4.6, verbatim.
 *
 * `{placeholders}` are filled by `validationMessage()`. Emphasis that the spec writes in bold is
 * plain text here — a validation message is announced by a screen reader as one string, and markup
 * inside it either does nothing or is read aloud as punctuation.
 */
export const VALIDATION_MESSAGES: Readonly<Record<ValidationCode, LocalisedMessage>> = {
  'businessName.empty': {
    nl: 'Vul de naam van je bedrijf in.',
    en: 'Please enter your business name.',
  },
  'businessName.tooShort': {
    nl: 'Dat lijkt wat kort — gebruik de volledige naam.',
    en: 'That looks short — use the full name.',
  },
  'businessName.noLetters': {
    nl: 'Een bedrijfsnaam bevat minstens één letter.',
    en: 'A business name needs at least one letter.',
  },
  'businessName.looksLikeUrl': {
    nl: 'Dat is een website. Wat is de naam van je bedrijf?',
    en: "That's a website. What's your business name?",
  },
  'slug.taken': {
    nl: 'Dit webadres is al bezet. Probeer {suggestion}.',
    en: 'That web address is taken. Try {suggestion}.',
  },
  'slug.reserved': {
    nl: 'Dit webadres kunnen we niet uitgeven. Kies een andere naam.',
    en: 'We cannot hand out that web address. Choose another name.',
  },
  'slug.invalid': {
    nl: 'Van deze naam kunnen we geen webadres maken. Voeg een letter of cijfer toe.',
    en: 'We cannot build a web address from that name. Add a letter or a number.',
  },
  'slug.homoglyph': {
    nl: 'Dit webadres lijkt te veel op een bestaand merk. Kies een andere naam.',
    en: 'That web address looks too much like an existing brand. Choose another name.',
  },
  'industry.empty': {
    nl: 'Kies een branche uit de lijst.',
    en: 'Pick an industry from the list.',
  },
  'industry.noMatch': {
    nl: 'Niks gevonden voor “{query}”. Kies iets dat er dichtbij komt.',
    en: 'Nothing found for “{query}”. Pick the closest match.',
  },
  'address.empty': {
    nl: 'Vul je adres in, of zet aan dat je naar klanten toe komt.',
    en: 'Enter your address, or tell us you visit customers.',
  },
  'address.postcodeNl': {
    nl: 'Een Nederlandse postcode ziet er zo uit: 1012 AB.',
    en: 'A Dutch postcode looks like this: 1012 AB.',
  },
  'address.postcodeBe': {
    nl: 'Een Belgische postcode bestaat uit vier cijfers, bijvoorbeeld 2000.',
    en: 'A Belgian postcode is four digits, for example 2000.',
  },
  'address.houseNumber': {
    nl: 'Vul je huisnummer in, bijvoorbeeld 12 of 12A.',
    en: 'Enter your house number, for example 12 or 12A.',
  },
  'address.notFound': {
    nl: 'We konden dit adres niet vinden. Controleer het of vul het handmatig in.',
    en: "We couldn't find that address. Check it or enter it manually.",
  },
  'address.lookupDown': {
    nl: 'Onze adreszoeker doet het even niet. Vul het adres zelf in — je site wordt er niet minder van.',
    en: "Our address lookup is down. Type it in — your site won't suffer.",
  },
  'address.cityEmpty': {
    nl: 'Vul de plaats in waar je gevestigd bent.',
    en: 'Enter the town or city you are based in.',
  },
  'serviceArea.cityEmpty': {
    nl: 'Vul in vanuit welke plaats je werkt.',
    en: 'Enter the town or city you work from.',
  },
  'hours.endBeforeStart': {
    nl: 'De sluitingstijd moet ná de openingstijd liggen.',
    en: 'Closing time must be after opening time.',
  },
  'hours.overlap': {
    nl: 'Deze tijden overlappen met een ander blok op dezelfde dag.',
    en: 'These hours overlap another block on the same day.',
  },
  'hours.allClosed': {
    nl: 'Alle dagen staan op gesloten. Klopt dat?',
    en: 'Every day is closed. Is that right?',
  },
  'phone.empty': {
    nl: 'Vul een telefoonnummer in — dit is je belangrijkste contactknop.',
    en: "Enter a phone number — it's your most important contact button.",
  },
  'phone.invalid': {
    nl: 'Dit nummer klopt niet voor {country}. Voorbeeld: {example}.',
    en: "That number isn't valid for {country}. Example: {example}.",
  },
  'phone.whatsappLandline': {
    nl: 'Dit lijkt een vast nummer. WhatsApp werkt alleen op mobiel.',
    en: 'That looks like a landline. WhatsApp only works on mobile.',
  },
  'gbp.notGoogle': {
    nl: 'Dat lijkt geen Google-link. Zoek je bedrijf op Google Maps en gebruik Delen → Link kopiëren.',
    en: "That doesn't look like a Google link. Find your business on Google Maps and use Share → Copy link.",
  },
  'description.tooShort': {
    nl: 'Nog een paar woorden erbij — of laat dit veld leeg.',
    en: 'A few more words — or leave this field empty.',
  },
  'description.tooLong': {
    nl: 'Iets korter graag (max 600 tekens). Je kunt later meer toevoegen.',
    en: 'A little shorter please (600 characters max). You can add more later.',
  },
  'description.containsContact': {
    nl: 'Laat je telefoonnummer en website hier weg — die zetten we automatisch op je site.',
    en: 'Leave your phone number and website out here — we add those to your site automatically.',
  },
  'email.empty': {
    nl: 'We hebben een e-mailadres nodig om je site op te slaan.',
    en: 'We need an email address to save your site.',
  },
  'email.invalid': {
    nl: 'Dit e-mailadres lijkt niet te kloppen.',
    en: "That email address doesn't look right.",
  },
  'email.typo': {
    nl: 'Bedoelde je {suggestion}?',
    en: 'Did you mean {suggestion}?',
  },
  'email.alreadyUsed': {
    nl: 'Dit adres heeft al een account. Je concept blijft bewaard.',
    en: 'That address already has an account. Your draft is saved.',
  },
  'media.wrongType': {
    nl: 'We kunnen {name} niet gebruiken. Gebruik JPG, PNG of WebP.',
    en: "We can't use {name}. Use JPG, PNG or WebP.",
  },
  'media.tooLarge': {
    nl: '{name} is {size} — dat is te groot. Bestanden mogen tot 15 MB.',
    en: '{name} is {size} — too large. Files can be up to 15 MB.',
  },
  'media.tooSmall': {
    nl: 'Deze foto is te klein ({width}×{height}) en wordt wazig op grote schermen.',
    en: 'This photo is small ({width}×{height}) and will look blurry on big screens.',
  },
  'media.tooMany': {
    nl: 'Twaalf foto’s is het maximum — meer kun je later in de editor toevoegen.',
    en: 'Twelve photos is the maximum — add more later in the editor.',
  },
  'media.decodeFailed': {
    nl: 'We konden {name} niet openen. Kies een andere foto.',
    en: "We couldn't open {name}. Choose another photo.",
  },
  'media.uploadFailed': {
    nl: 'Uploaden van {name} is mislukt.',
    en: '{name} failed to upload.',
  },
  'media.quarantined': {
    nl: 'Deze foto konden we niet verwerken. Kies een andere.',
    en: "We couldn't process this photo. Choose another one.",
  },
  'media.offline': {
    nl: 'Je bent offline. We gaan verder zodra je weer verbinding hebt.',
    en: "You're offline. We'll continue as soon as you're back.",
  },
};

/** Resolves one code to its copy, filling `{placeholders}`. */
export function validationMessage(
  code: ValidationCode,
  locale: Locale,
  params: Readonly<Record<string, string | number>> = {},
): string {
  const template = VALIDATION_MESSAGES[code][copyLocale(locale)];
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = params[key];
    return value === undefined ? whole : String(value);
  });
}

/** A failure with the parameters its copy needs. `null` means the field is valid. */
export interface ValidationFailure {
  readonly code: ValidationCode;
  readonly params: Readonly<Record<string, string | number>>;
}

/** Builds a failure. */
function fail(
  code: ValidationCode,
  params: Readonly<Record<string, string | number>> = {},
): ValidationFailure {
  return { code, params };
}

/* ── Step 1: business name ────────────────────────────────────────────────────────────────────── */

/** Anything that is a web address or an e-mail rather than a name. */
const LOOKS_LIKE_URL =
  /^(?:https?:\/\/|www\.)|^[^\s@]+@[^\s@]+\.[a-z]{2,}$|^[a-z0-9-]+\.[a-z]{2,}$/i;

/**
 * Validates a business name.
 *
 * Mirrors the `IntakeSchema.businessName` constraints (2–120 characters, at least one letter) and
 * adds the two UX rules the schema cannot express: a bare URL is a different question being
 * answered, and a one-character name is almost always a slip.
 */
export function validateBusinessName(raw: string): ValidationFailure | null {
  const value = normaliseFreeText(raw);
  if (value.length === 0) {
    return fail('businessName.empty');
  }
  if (LOOKS_LIKE_URL.test(value)) {
    return fail('businessName.looksLikeUrl');
  }
  if (value.length < 2) {
    return fail('businessName.tooShort');
  }
  if (!/\p{L}/u.test(value)) {
    return fail('businessName.noLetters');
  }
  return null;
}

/** Maps a `GET /v1/slug-check` rejection reason onto its copy. */
export function slugFailure(
  reason: 'invalid' | 'reserved' | 'taken' | 'homoglyph',
  suggestion: string | null,
): ValidationFailure {
  switch (reason) {
    case 'taken':
      // Without a suggestion "that one is taken" is a dead end, so the copy degrades to the
      // reserved wording, which at least tells the user what to do next.
      return suggestion === null ? fail('slug.reserved') : fail('slug.taken', { suggestion });
    case 'reserved':
      return fail('slug.reserved');
    case 'homoglyph':
      return fail('slug.homoglyph');
    case 'invalid':
      return fail('slug.invalid');
  }
}

/* ── Step 2: industry ─────────────────────────────────────────────────────────────────────────── */

/** An industry is valid only when it resolves to a real key; free text never passes. */
export function validateIndustry(key: string | null, query: string): ValidationFailure | null {
  if (key !== null && key.length > 0) {
    return null;
  }
  return query.trim().length >= 2
    ? fail('industry.noMatch', { query: query.trim() })
    : fail('industry.empty');
}

/* ── Step 3: address ──────────────────────────────────────────────────────────────────────────── */

/** `1012 AB`, with or without the space. */
const NL_POSTCODE = /^[1-9][0-9]{3}\s?[A-Za-z]{2}$/;

/** Four digits, first non-zero. */
const BE_POSTCODE = /^[1-9][0-9]{3}$/;

/** `12`, `12A`, `12-bis`. */
const HOUSE_NUMBER = /^[0-9]{1,5}\s?[A-Za-z-]{0,4}$/;

/** Countries that get the two-field postcode + house-number flow. */
export function usesPostcodeLookup(country: string | null): country is 'NL' | 'BE' {
  return country === 'NL' || country === 'BE';
}

/** Uppercases and single-spaces a Dutch postcode: `1012ab` → `1012 AB`. */
export function normalisePostcode(raw: string, country: 'NL' | 'BE'): string {
  const compact = raw.replace(/\s+/g, '').toUpperCase();
  if (country === 'BE') {
    return compact;
  }
  return compact.length > 4 ? `${compact.slice(0, 4)} ${compact.slice(4)}` : compact;
}

/** Validates a postcode for the country whose format it is meant to be in. */
export function validatePostcode(raw: string, country: 'NL' | 'BE'): ValidationFailure | null {
  const value = raw.trim();
  if (value.length === 0) {
    return country === 'NL' ? fail('address.postcodeNl') : fail('address.postcodeBe');
  }
  const pattern = country === 'NL' ? NL_POSTCODE : BE_POSTCODE;
  if (!pattern.test(value)) {
    return country === 'NL' ? fail('address.postcodeNl') : fail('address.postcodeBe');
  }
  return null;
}

/** Validates a house number. */
export function validateHouseNumber(raw: string): ValidationFailure | null {
  return HOUSE_NUMBER.test(raw.trim()) ? null : fail('address.houseNumber');
}

/* ── Step 4: opening hours ────────────────────────────────────────────────────────────────────── */

/** One editable interval in the day grid. */
export interface HoursInterval {
  readonly opens: string;
  readonly closes: string;
}

/**
 * Validates one day's intervals.
 *
 * Returns the first problem, because a row shows one message: two errors on one line of a
 * seven-line grid is noise, and fixing the first usually fixes the second.
 *
 * `closes === '00:00'` is accepted as midnight-at-the-end-of-the-day, which is how a bar that
 * closes at midnight is written; `@aibuilder/core`'s hours mapper understands the same convention.
 */
export function validateDayIntervals(
  intervals: readonly HoursInterval[],
): ValidationFailure | null {
  const minutes = intervals.map((interval) => ({
    from: toMinutes(interval.opens),
    to: interval.closes === '00:00' ? 1440 : toMinutes(interval.closes),
  }));

  for (const interval of minutes) {
    if (interval.from === null || interval.to === null || interval.to <= interval.from) {
      return fail('hours.endBeforeStart');
    }
  }

  const sorted = [...minutes]
    .filter((i): i is { from: number; to: number } => i.from !== null && i.to !== null)
    .sort((a, b) => a.from - b.from);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous !== undefined && current !== undefined && current.from < previous.to) {
      return fail('hours.overlap');
    }
  }
  return null;
}

/** `"09:30"` → `570`, `null` when it is not a time. */
function toMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match === null ? null : Number(match[1]) * 60 + Number(match[2]);
}

/** True when the week has no open interval and no appointment flag — worth confirming, not blocking. */
export function isEverythingClosed(hours: OpeningHours | null): boolean {
  if (hours === null) {
    return false;
  }
  return !hours.byAppointmentOnly && hours.spec.length === 0;
}

/* ── Step 5: phone ────────────────────────────────────────────────────────────────────────────── */

/** The E.164 shape the API, the D1 CHECK and the `wa.me` link all require. */
const E164 = /^\+[1-9]\d{6,14}$/;

/** True when a string is storable as `sites.phone_e164`. */
export function isE164(value: string): boolean {
  return E164.test(value);
}

/**
 * Validates a phone number that `libphonenumber-js` has already had its say about.
 *
 * The heavy parser is lazy-loaded on focus (UX §2.7), so this function takes its verdict rather
 * than importing it: `valid` comes from `parsePhoneNumber().isValid()` when the chunk has landed,
 * and falls back to the E.164 shape when it has not. A field must never be blocked by a 145 KB
 * download that has not arrived yet.
 */
export function validatePhone(params: {
  e164: string | null;
  valid: boolean | null;
  countryLabel: string;
  example: string;
}): ValidationFailure | null {
  if (params.e164 === null || params.e164.length === 0) {
    return fail('phone.empty');
  }
  const acceptable = params.valid ?? isE164(params.e164);
  return acceptable
    ? null
    : fail('phone.invalid', { country: params.countryLabel, example: params.example });
}

/** A GBP link is stored for `sameAs` and never fetched, so the only rule is that it is a Google URL. */
export function validateGbpUrl(raw: string): ValidationFailure | null {
  const value = raw.trim();
  if (value.length === 0) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail('gbp.notGoogle');
  }
  if (url.protocol !== 'https:') {
    return fail('gbp.notGoogle');
  }
  const host = url.hostname.toLowerCase();
  const isGoogleHost =
    host === 'g.page' ||
    host === 'goo.gl' ||
    host === 'maps.app.goo.gl' ||
    host === 'business.google.com' ||
    host === 'maps.google.com' ||
    /^(?:www\.)?google\.[a-z.]{2,6}$/.test(host);
  return isGoogleHost ? null : fail('gbp.notGoogle');
}

/* ── Step 6: description and e-mail ───────────────────────────────────────────────────────────── */

/** Shortest description we accept once the field is not empty (UX §2.6: 0 or 40–600). */
export const DESCRIPTION_MIN = 40;

/** `sites.short_description` and `IntakeSchema` both cap at 600. */
export const DESCRIPTION_MAX = 600;

/** A phone number or a URL inside the description; both belong in their own fields. */
const DESCRIPTION_CONTACT = /(https?:\/\/|www\.)|(\+?\d[\d\s().-]{7,}\d)/i;

/** Validates the optional-but-nudged description. Empty is valid; half-written is not. */
export function validateDescription(raw: string): ValidationFailure | null {
  const value = normaliseFreeText(raw);
  if (value.length === 0) {
    return null;
  }
  if (value.length > DESCRIPTION_MAX) {
    return fail('description.tooLong');
  }
  if (value.length < DESCRIPTION_MIN || value.split(' ').length < 6) {
    return fail('description.tooShort');
  }
  if (DESCRIPTION_CONTACT.test(value)) {
    return fail('description.containsContact');
  }
  return null;
}

/** The shape check. Deliberately the same one the API's `contact_email` CHECK applies. */
const EMAIL = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;

/**
 * The domains a European small business actually types, plus the ones they mistype.
 *
 * A typo check against a global top-1000 list would "correct" `ziggo.nl` to `zoho.com`. This list
 * is the Dutch/Belgian/German mailbox market plus the international consumer providers, and it is
 * the ONLY set a suggestion may come from.
 */
const KNOWN_EMAIL_DOMAINS: readonly string[] = [
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'hotmail.nl',
  'hotmail.be',
  'hotmail.de',
  'hotmail.fr',
  'outlook.com',
  'outlook.nl',
  'outlook.be',
  'outlook.de',
  'live.nl',
  'live.com',
  'live.be',
  'msn.com',
  'icloud.com',
  'me.com',
  'yahoo.com',
  'yahoo.co.uk',
  'ziggo.nl',
  'kpnmail.nl',
  'planet.nl',
  'home.nl',
  'casema.nl',
  'chello.nl',
  'xs4all.nl',
  'upcmail.nl',
  'telfort.nl',
  'zeelandnet.nl',
  'telenet.be',
  'skynet.be',
  'proximus.be',
  'scarlet.be',
  'web.de',
  'gmx.de',
  'gmx.net',
  't-online.de',
  'freenet.de',
  'orange.fr',
  'wanadoo.fr',
  'free.fr',
  'protonmail.com',
  'proton.me',
];

/** Validates an e-mail address. Paste is never blocked (SC 3.3.8); this only reads the result. */
export function validateEmail(raw: string): ValidationFailure | null {
  const value = raw.trim().toLowerCase();
  if (value.length === 0) {
    return fail('email.empty');
  }
  if (value.length > 254 || !EMAIL.test(value)) {
    return fail('email.invalid');
  }
  return null;
}

/**
 * Suggests a corrected domain, or `null`.
 *
 * Edit distance ≤ 2 against the list above, and only when the typed domain is not itself on it.
 * Returned as a *suggestion*, never applied: `gmial.com` is a typo and `gmail.co` might be someone's
 * real company domain, and the user is the only one who knows which.
 */
export function suggestEmailCorrection(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) {
    return null;
  }
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (KNOWN_EMAIL_DOMAINS.includes(domain)) {
    return null;
  }

  let best: { domain: string; distance: number } | null = null;
  for (const candidate of KNOWN_EMAIL_DOMAINS) {
    const distance = damerauLevenshtein(fold(domain), candidate, 2);
    if (distance <= 2 && (best === null || distance < best.distance)) {
      best = { domain: candidate, distance };
    }
  }
  return best === null ? null : `${local}@${best.domain}`;
}

/* ── The whole-form gate ──────────────────────────────────────────────────────────────────────── */

/**
 * Runs the real `IntakeSchema` over a candidate payload.
 *
 * THE CLIENT VALIDATES WITH THE SERVER'S SCHEMA, IMPORTED — never with a re-typed copy of it. A
 * second implementation of the same rules drifts within one sprint, and the failure mode is the
 * worst one in the funnel: a user who passed every step, pressed the one button that matters, and
 * got a 422 with no field to blame.
 *
 * Returns the parsed intake, or the same field-keyed map shape the API's 422 uses, so the error
 * summary renders identically whichever side rejected it.
 */
export function validateIntake(
  candidate: unknown,
):
  | { readonly ok: true; readonly intake: Intake }
  | { readonly ok: false; readonly fields: Readonly<Record<string, readonly string[]>> } {
  const parsed = IntakeSchema.safeParse(candidate);
  if (parsed.success) {
    return { ok: true, intake: parsed.data };
  }
  const fields: Record<string, string[]> = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path.length === 0 ? '_' : issue.path.map(String).join('.');
    const codes = fields[key] ?? [];
    const code = issue.code === 'custom' && issue.message.length > 0 ? issue.message : issue.code;
    if (!codes.includes(code)) {
      codes.push(code);
    }
    fields[key] = codes;
  }
  return { ok: false, fields };
}
