/**
 * Presentation helpers for the onboarding modal.
 *
 * Everything here is pure and locale-aware. Two rules hold throughout: numbers that a European
 * reads go through `Intl` (a Dutch user expects `1,6 MB`, not `1.6 MB`), and times are 24-hour
 * everywhere — an AM/PM control in a Dutch opening-hours grid is a usability bug, not a preference.
 */

import { dayName, formatHoursForLocale, slugify } from '@aibuilder/core';
import type { DayOfWeek, Locale, OpeningHours } from '@aibuilder/core';

import { SITES_ROOT_DOMAIN } from './config';

/** Minutes between two selectable times in the hours grid (UX §2.4). */
export const TIME_STEP_MINUTES = 15;

/** One selectable time in the day grid. */
export interface TimeOption {
  /** `HH:MM`, 24-hour — exactly the shape `OpeningHours.opens`/`closes` stores. */
  readonly value: string;
  /** What the `<option>` renders. Identical to `value`: 24-hour Europe has no other form. */
  readonly label: string;
}

/**
 * The 96 quarter-hour options of a day, `00:00` … `23:45`.
 *
 * Built once at module load. A `<select>` rather than `<input type="time">` on purpose: the native
 * time input has no coarse stepping that survives every mobile browser, renders AM/PM wherever the
 * OS locale says so regardless of the page's language, and cannot be keyboard-typed to `14` the way
 * a native select's typeahead can (UX §2.4).
 */
export const TIME_OPTIONS: readonly TimeOption[] = Array.from(
  { length: (24 * 60) / TIME_STEP_MINUTES },
  (_unused, index): TimeOption => {
    const value = minutesToTime(index * TIME_STEP_MINUTES);
    return { value, label: value };
  },
);

/** `"09:30"` → `570`. Returns `null` for anything that is not `HH:MM`. */
export function timeToMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (match === null) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours * 60 + minutes;
}

/** `570` → `"09:30"`. Values outside a day wrap, so `24:00` is expressible as `00:00` of the next. */
export function minutesToTime(total: number): string {
  const wrapped = ((Math.round(total) % 1440) + 1440) % 1440;
  const hours = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * The one-line summary above the hours grid: `"Ma t/m vr 09:00–17:00 · za 10:00–16:00"`.
 *
 * Delegates to `@aibuilder/core`'s `formatHoursForLocale`, which is the same function the generated
 * site renders its hours block with — so the summary the user approves in the modal is, character
 * for character, what their visitors will read.
 */
export function hoursSummary(hours: OpeningHours | null, locale: Locale): string {
  const formatted = formatHoursForLocale(hours, locale);
  if (formatted.byAppointmentLabel !== null) {
    return formatted.byAppointmentLabel;
  }
  if (formatted.lines.length === 0) {
    return '';
  }
  return formatted.lines.map((line) => `${line.daysLabel} ${line.hoursLabel}`).join(' · ');
}

/**
 * Localised day name, short (`"Ma"`) or long (`"Maandag"`), capitalised as a row label.
 *
 * Delegates to `@aibuilder/core`'s `dayName` rather than to `Intl.DateTimeFormat` so the grid, the
 * summary line and the generated site's hours block all spell Monday the same way. Two spellings of
 * one weekday inside a single screen is exactly the detail that makes a product feel assembled from
 * parts.
 */
export function dayLabel(
  locale: Locale,
  day: DayOfWeek,
  style: 'short' | 'long' = 'short',
): string {
  const name = dayName(locale, day, style);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** `1_678_432` → `"1,6 MB"`. Binary units, one decimal, never more precision than a user needs. */
export function formatBytes(bytes: number, locale: Locale): string {
  const units = ['B', 'kB', 'MB', 'GB'] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const formatted = new Intl.NumberFormat(locale, {
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
  return `${formatted} ${units[unit] ?? 'B'}`;
}

/** `41.6` → `"42"`. The rail's numeric label is always an integer; a decimal reads as noise. */
export function formatPercent(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(
    Math.max(0, Math.min(100, Math.round(value))),
  );
}

/**
 * The tenant host a slug would produce: `"mijn-kapsalon.mijnsaas.com"`.
 *
 * The domain half is rendered in `--fg-tertiary` beside the slug so the user reads their own name
 * as the part they control.
 */
export function tenantHost(slug: string): string {
  return `${slug}.${SITES_ROOT_DOMAIN}`;
}

/**
 * A host as a screen reader should hear it: `"mijn-kapsalon punt mijnsaas punt com"`.
 *
 * Without this, a live region announcing a domain is read as one unpronounceable word by several
 * engines, and the reveal — the peak moment of the whole product — lands as noise.
 */
export function spokenHost(host: string, locale: Locale): string {
  const dot =
    locale === 'nl'
      ? 'punt'
      : locale === 'de'
        ? 'Punkt'
        : locale === 'fr'
          ? 'point'
          : locale === 'es' || locale === 'pt'
            ? 'punto'
            : 'dot';
  return host.split('.').join(` ${dot} `);
}

/**
 * The live slug preview for step 1.
 *
 * Client-side transliteration only. Availability is a server question (`GET /v1/slug-check`), and
 * the preview never claims one: it shows the shape, and the tick appears when the server answers.
 */
export function slugPreview(businessName: string, locale: Locale): string {
  return slugify(businessName, locale);
}

/** Fills `{placeholders}` in a copy string. Unknown keys are left untouched, never blanked. */
export function interpolate(
  template: string,
  params: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = params[key];
    return value === undefined ? whole : String(value);
  });
}

/** `"een-heel-lange-bestandsnaam.jpg"` → `"een-heel-l….jpg"`, keeping the extension visible. */
export function truncateFileName(name: string, max = 24): string {
  if (name.length <= max) {
    return name;
  }
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot) : '';
  const head = name.slice(0, Math.max(1, max - extension.length - 1));
  return `${head}…${extension}`;
}

/** `95` → `"1:35"`. Used only in the honest "this is taking longer" copy, never as a countdown. */
export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  return `${String(minutes)}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * An amount in euros, in the reader's own convention: `"€ 119,88"` (nl) / `"€119.88"` (en).
 *
 * The euro locale for English is `en-IE` and not `en-GB`: `en-GB` renders EUR as `€119.88` too, but
 * it is a pound locale and the grouping separators it would choose for larger amounts are the ones a
 * British reader expects for sterling. `en-IE` is an English locale whose currency actually is the
 * euro, which is what this product charges in.
 *
 * The formatter is built per call rather than cached in a module constant because the island renders
 * at most a handful of amounts in a session, and a `Map` cache here would cost more bytes than it
 * saves in time.
 */
export function formatEuro(amount: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === 'nl' ? 'nl-NL' : 'en-IE', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
  }).format(amount);
}

/**
 * A wall-clock time, for the "this payment link is valid until …" line.
 *
 * No date part: the Checkout window is 30 minutes wide (`expires_at`, architecture PHASE2 §1 step 6),
 * so a date would be noise on every reading and misleading on the one that crosses midnight — which
 * is why the caller only ever renders this for a deadline it has already checked is in the future.
 */
export function formatClockTime(epochMs: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === 'nl' ? 'nl-NL' : 'en-IE', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(epochMs));
}
