import type { DayOfWeek, OpeningHours } from './intake';
import { DAYS_OF_WEEK, TIME_OF_DAY_PATTERN } from './intake';
import type { Locale } from './locales';

/**
 * Opening hours: intake shape in, schema.org out — plus a display formatter.
 *
 * Every case handled here is a bug someone ships (dim-seo §3.4): split shifts, closed days, 24-hour
 * operation, hours that cross midnight, appointment-only businesses and seasonal windows. Google
 * cross-checks the rendered HTML against the markup, so `formatHoursForLocale()` and
 * `toOpeningHoursSpecification()` are deliberately driven from the same normalisation step — a site
 * whose visible hours disagree with its JSON-LD loses the rich result it was emitted for.
 *
 * Two rules that look like details and are not:
 *   - `opens`/`closes` are `HH:MM`, 24-hour, **no timezone suffix**. The IANA zone lives on the
 *     `tz` field for display purposes only; putting an offset in the markup is invalid.
 *   - `dayOfWeek` values stay English (`Monday`), even on `/de/`. They are schema.org enumeration
 *     members, not user-facing text.
 *
 * Nothing here throws. Malformed input (a bad time, an impossible date) is dropped, because this
 * runs at publish time over data that has already been accepted, and failing a publish over a
 * typo'd holiday date would be worse than omitting the holiday.
 */

/** A schema.org `OpeningHoursSpecification` node. */
export interface OpeningHoursSpecification {
  readonly '@type': 'OpeningHoursSpecification';
  /** Present on weekly specs, absent on dated (special) ones. */
  readonly dayOfWeek?: readonly DayOfWeek[];
  readonly opens: string;
  readonly closes: string;
  readonly validFrom?: string;
  readonly validThrough?: string;
}

/** The two hours properties of a schema.org `Place`, plus the flag that has no markup. */
export interface OpeningHoursJsonLd {
  /** Goes on `openingHoursSpecification`. */
  readonly openingHoursSpecification: readonly OpeningHoursSpecification[];
  /** Goes on `specialOpeningHoursSpecification` — holidays and closures, never `openingHours`. */
  readonly specialOpeningHoursSpecification: readonly OpeningHoursSpecification[];
  /**
   * schema.org has no vocabulary for "by appointment only", so this never becomes markup. It drives
   * the visible line and the CTA choice (a booking link instead of a hours table).
   */
  readonly byAppointmentOnly: boolean;
}

/** Position of a day in the European week. Literal so tuple lookups stay exact. */
type DayIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Position of each day in the European week. */
const DAY_INDEX: Readonly<Record<DayOfWeek, DayIndex>> = {
  Monday: 0,
  Tuesday: 1,
  Wednesday: 2,
  Thursday: 3,
  Friday: 4,
  Saturday: 5,
  Sunday: 6,
};

/** Google's documented way of saying "closed all day". */
const CLOSED_ALL_DAY = { opens: '00:00', closes: '00:00' } as const;

/** Google's documented way of saying "open all day". */
const OPEN_ALL_DAY = { opens: '00:00', closes: '23:59' } as const;

/** One opening interval on one day, `HH:MM`-`HH:MM`. */
export interface OpeningInterval {
  readonly opens: string;
  readonly closes: string;
}

/** True for `YYYY-MM-DD` that is also a real calendar date. */
function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(time)) return false;
  // `Date.parse` accepts 2026-02-31 in some engines by rolling over, so round-trip the value.
  return new Date(time).toISOString().slice(0, 10) === value;
}

/** True when `value` is one of the seven schema.org day names. */
function isDayOfWeek(value: string): value is DayOfWeek {
  return Object.hasOwn(DAY_INDEX, value);
}

/**
 * Normalises the intake spec into one sorted, merged interval list per day.
 *
 * Applies the two conversions the rest of the module depends on: `opens === closes` means the
 * business is open all day (the form cannot express a zero-length shift, so it never means that),
 * and overlapping intervals on one day are merged so a split shift is only ever emitted when there
 * is a genuine gap.
 */
function intervalsByDay(hours: OpeningHours): Map<DayOfWeek, OpeningInterval[]> {
  const closedDays = new Set<DayOfWeek>(hours.closed.filter(isDayOfWeek));
  const byDay = new Map<DayOfWeek, OpeningInterval[]>();

  for (const entry of hours.spec) {
    if (!TIME_OF_DAY_PATTERN.test(entry.opens) || !TIME_OF_DAY_PATTERN.test(entry.closes)) continue;
    const interval: OpeningInterval =
      entry.opens === entry.closes ? OPEN_ALL_DAY : { opens: entry.opens, closes: entry.closes };

    for (const day of entry.dayOfWeek) {
      // An explicit "closed" toggle outranks a leftover interval: the toggle is the last thing the
      // user touched in the UI, and a business that says it is closed on Monday must not be marked
      // open on Monday by a stale row.
      if (closedDays.has(day)) continue;
      const list = byDay.get(day) ?? [];
      if (!list.some((i) => i.opens === interval.opens && i.closes === interval.closes)) {
        list.push(interval);
      }
      byDay.set(day, list);
    }
  }

  for (const [day, list] of byDay) {
    byDay.set(day, mergeIntervals(list));
  }
  return byDay;
}

/** True when an interval runs past midnight into the next day (`23:00` to `02:00`). */
function crossesMidnight(interval: OpeningInterval): boolean {
  return interval.closes < interval.opens;
}

/**
 * Sorts and merges same-day intervals.
 *
 * Midnight-crossing intervals are never merged: their `closes` belongs to the following day, so
 * comparing it against another interval's `opens` on the same clock face is meaningless.
 */
function mergeIntervals(intervals: readonly OpeningInterval[]): OpeningInterval[] {
  const sorted = [...intervals].sort((a, b) =>
    a.opens < b.opens ? -1 : a.opens > b.opens ? 1 : 0,
  );
  const out: OpeningInterval[] = [];

  for (const interval of sorted) {
    const previous = out[out.length - 1];
    if (
      previous === undefined ||
      crossesMidnight(previous) ||
      crossesMidnight(interval) ||
      interval.opens > previous.closes
    ) {
      out.push(interval);
      continue;
    }
    out[out.length - 1] = {
      opens: previous.opens,
      closes: interval.closes > previous.closes ? interval.closes : previous.closes,
    };
  }
  return out;
}

/** Builds one weekly spec, optionally bounded to a season. */
function weeklySpec(
  days: readonly DayOfWeek[],
  interval: OpeningInterval,
  season: { from: string; to: string } | null,
): OpeningHoursSpecification {
  return {
    '@type': 'OpeningHoursSpecification',
    dayOfWeek: days,
    opens: interval.opens,
    closes: interval.closes,
    ...(season === null ? {} : { validFrom: season.from, validThrough: season.to }),
  };
}

/**
 * Converts intake opening hours into the two schema.org hours properties.
 *
 * Guarantees, in order of how often they are got wrong:
 *   - a split shift becomes **two** specs for the same day, never one spanning the gap;
 *   - a closed day is emitted explicitly as `00:00`–`00:00` rather than omitted, because an omitted
 *     day is ambiguous between "closed" and "unknown";
 *   - a 24-hour day is `00:00`–`23:59`;
 *   - an interval that crosses midnight keeps `closes < opens`, which schema.org reads as next-day;
 *   - days sharing an interval collapse into one spec with a `dayOfWeek` array;
 *   - a `closed: false` exception is a **season**: the weekly hours are emitted once per window,
 *     carrying `validFrom`/`validThrough`, and never unbounded — that is what a campsite open from
 *     April to October actually means;
 *   - a `closed: true` exception becomes a `specialOpeningHoursSpecification` entry, which is a
 *     property of `Place`, and never an `openingHours` string;
 *   - output ordering is deterministic (Monday first, then opening time), because `render_sha256`
 *     is computed over the rendered projection and `lastmod` must not move on a republish.
 */
export function toOpeningHoursSpecification(hours: OpeningHours | null): OpeningHoursJsonLd {
  if (hours === null) {
    return {
      openingHoursSpecification: [],
      specialOpeningHoursSpecification: [],
      byAppointmentOnly: false,
    };
  }

  const byDay = intervalsByDay(hours);
  const openDays = DAYS_OF_WEEK.filter((day) => (byDay.get(day) ?? []).length > 0);

  const seasons = hours.exceptions
    .filter((e) => !e.closed && isIsoDate(e.from) && isIsoDate(e.to) && e.from <= e.to)
    .map((e) => ({ from: e.from, to: e.to }));

  const specials: OpeningHoursSpecification[] = hours.exceptions
    .filter((e) => e.closed && isIsoDate(e.from) && isIsoDate(e.to) && e.from <= e.to)
    .map((e) => ({
      '@type': 'OpeningHoursSpecification',
      opens: CLOSED_ALL_DAY.opens,
      closes: CLOSED_ALL_DAY.closes,
      validFrom: e.from,
      validThrough: e.to,
    }));

  if (openDays.length === 0) {
    // No published hours at all. Emitting seven closed days here would tell Google the business is
    // permanently shut, which is a very different claim from "we work by appointment".
    return {
      openingHoursSpecification: [],
      specialOpeningHoursSpecification: specials,
      byAppointmentOnly: hours.byAppointmentOnly,
    };
  }

  // Group days by identical interval. Iterating in week order makes both the day arrays and the
  // group order deterministic.
  const groups = new Map<string, { interval: OpeningInterval; days: DayOfWeek[] }>();
  for (const day of DAYS_OF_WEEK) {
    for (const interval of byDay.get(day) ?? []) {
      const key = `${interval.opens}-${interval.closes}`;
      const group = groups.get(key);
      if (group === undefined) groups.set(key, { interval, days: [day] });
      else group.days.push(day);
    }
  }

  const ordered = [...groups.values()].sort((a, b) => {
    const dayA = a.days[0];
    const dayB = b.days[0];
    const indexA = dayA === undefined ? Number.MAX_SAFE_INTEGER : DAY_INDEX[dayA];
    const indexB = dayB === undefined ? Number.MAX_SAFE_INTEGER : DAY_INDEX[dayB];
    if (indexA !== indexB) return indexA - indexB;
    return a.interval.opens < b.interval.opens ? -1 : a.interval.opens > b.interval.opens ? 1 : 0;
  });

  const closedDays = DAYS_OF_WEEK.filter((day) => (byDay.get(day) ?? []).length === 0);

  const base: OpeningHoursSpecification[] = [];
  const seasonWindows: readonly ({ from: string; to: string } | null)[] =
    seasons.length > 0 ? seasons : [null];

  for (const season of seasonWindows) {
    for (const group of ordered) base.push(weeklySpec(group.days, group.interval, season));
    if (closedDays.length > 0) base.push(weeklySpec(closedDays, CLOSED_ALL_DAY, season));
  }

  return {
    openingHoursSpecification: base,
    specialOpeningHoursSpecification: specials,
    byAppointmentOnly: hours.byAppointmentOnly,
  };
}

/* ── Display ─────────────────────────────────────────────────────────────────────────────────── */

/** One rendered row of the visible hours table. */
export interface FormattedHoursLine {
  /** The days this row covers, in week order. */
  readonly days: readonly DayOfWeek[];
  /** Localised day label — `"Ma t/m vr"`, `"Sa"`, `"Lun–Ven"`. */
  readonly daysLabel: string;
  /** Localised hours label — `"09:00–17:00 · 18:00–22:00"`, `"Gesloten"`, `"24 uur open"`. */
  readonly hoursLabel: string;
  /** Machine-readable intervals, for `<time>` elements. */
  readonly intervals: readonly OpeningInterval[];
  readonly closed: boolean;
  readonly allDay: boolean;
  /** True when any interval on this row runs into the next day. */
  readonly crossesMidnight: boolean;
}

/** One rendered exception row (a holiday closure or a season). */
export interface FormattedHoursException {
  readonly from: string;
  readonly to: string;
  readonly closed: boolean;
  readonly label: string;
}

/** Everything a hours block needs to render, in one locale. */
export interface FormattedHours {
  readonly lines: readonly FormattedHoursLine[];
  readonly exceptions: readonly FormattedHoursException[];
  readonly byAppointmentOnly: boolean;
  /** Localised "by appointment only" line, or `null` when the flag is off. */
  readonly byAppointmentLabel: string | null;
  /** IANA zone from the intake, for a "times are local" footnote. Never emitted into markup. */
  readonly timeZone: string;
}

/** Per-locale display strings and formats. */
interface HoursCopy {
  readonly closed: string;
  readonly allDay: string;
  readonly byAppointment: string;
  readonly dayRangeSeparator: string;
  readonly dayNamesShort: readonly [string, string, string, string, string, string, string];
  readonly dayNamesLong: readonly [string, string, string, string, string, string, string];
  readonly formatDate: (iso: string) => string;
  readonly closedBetween: (from: string, to: string) => string;
  readonly openBetween: (from: string, to: string) => string;
}

/** `YYYY-MM-DD` split into its parts, for the locale date formatters. */
function dateParts(iso: string): { day: string; month: string; year: string } {
  return { year: iso.slice(0, 4), month: iso.slice(5, 7), day: iso.slice(8, 10) };
}

/**
 * Display copy per locale.
 *
 * Hardcoded rather than taken from `Intl`: the formatted strings end up in the rendered HTML, which
 * is hashed into `render_sha256`. An ICU version difference between workerd and the CI runner would
 * silently move every tenant's `lastmod` on the next publish, which is exactly the failure mode
 * §7.8 exists to prevent. Seven day names in six languages is a cheap price for a stable hash.
 */
const HOURS_COPY: Readonly<Record<Locale, HoursCopy>> = {
  nl: {
    closed: 'Gesloten',
    allDay: '24 uur open',
    byAppointment: 'Alleen op afspraak',
    dayRangeSeparator: ' t/m ',
    dayNamesShort: ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'],
    dayNamesLong: ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag'],
    formatDate: (iso) => {
      const { day, month, year } = dateParts(iso);
      return `${day}-${month}-${year}`;
    },
    closedBetween: (from, to) => `Gesloten van ${from} t/m ${to}`,
    openBetween: (from, to) => `Open van ${from} t/m ${to}`,
  },
  en: {
    closed: 'Closed',
    allDay: 'Open 24 hours',
    byAppointment: 'By appointment only',
    dayRangeSeparator: '–',
    dayNamesShort: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    dayNamesLong: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
    formatDate: (iso) => iso,
    closedBetween: (from, to) => `Closed from ${from} to ${to}`,
    openBetween: (from, to) => `Open from ${from} to ${to}`,
  },
  de: {
    closed: 'Geschlossen',
    allDay: 'Durchgehend geöffnet',
    byAppointment: 'Nur nach Vereinbarung',
    dayRangeSeparator: '–',
    dayNamesShort: ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'],
    dayNamesLong: ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'],
    formatDate: (iso) => {
      const { day, month, year } = dateParts(iso);
      return `${day}.${month}.${year}`;
    },
    closedBetween: (from, to) => `Geschlossen vom ${from} bis ${to}`,
    openBetween: (from, to) => `Geöffnet vom ${from} bis ${to}`,
  },
  fr: {
    closed: 'Fermé',
    allDay: 'Ouvert 24h/24',
    byAppointment: 'Uniquement sur rendez-vous',
    dayRangeSeparator: '–',
    dayNamesShort: ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'],
    dayNamesLong: ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'],
    formatDate: (iso) => {
      const { day, month, year } = dateParts(iso);
      return `${day}/${month}/${year}`;
    },
    closedBetween: (from, to) => `Fermé du ${from} au ${to}`,
    openBetween: (from, to) => `Ouvert du ${from} au ${to}`,
  },
  es: {
    closed: 'Cerrado',
    allDay: 'Abierto 24 horas',
    byAppointment: 'Solo con cita previa',
    dayRangeSeparator: '–',
    dayNamesShort: ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'],
    dayNamesLong: ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'],
    formatDate: (iso) => {
      const { day, month, year } = dateParts(iso);
      return `${day}/${month}/${year}`;
    },
    closedBetween: (from, to) => `Cerrado del ${from} al ${to}`,
    openBetween: (from, to) => `Abierto del ${from} al ${to}`,
  },
  pt: {
    closed: 'Fechado',
    allDay: 'Aberto 24 horas',
    byAppointment: 'Apenas com marcação',
    dayRangeSeparator: '–',
    dayNamesShort: ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'],
    dayNamesLong: [
      'segunda-feira',
      'terça-feira',
      'quarta-feira',
      'quinta-feira',
      'sexta-feira',
      'sábado',
      'domingo',
    ],
    formatDate: (iso) => {
      const { day, month, year } = dateParts(iso);
      return `${day}/${month}/${year}`;
    },
    closedBetween: (from, to) => `Fechado de ${from} a ${to}`,
    openBetween: (from, to) => `Aberto de ${from} a ${to}`,
  },
};

/** Localised short or long name of a day. Never used inside JSON-LD, which stays English. */
export function dayName(locale: Locale, day: DayOfWeek, style: 'short' | 'long' = 'short'): string {
  const copy = HOURS_COPY[locale];
  const names = style === 'short' ? copy.dayNamesShort : copy.dayNamesLong;
  return names[DAY_INDEX[day]];
}

/** Builds the `"Ma t/m vr"` / `"Za"` label for a run of days. */
function daysLabel(locale: Locale, days: readonly DayOfWeek[]): string {
  const first = days[0];
  const last = days[days.length - 1];
  if (first === undefined || last === undefined) return '';
  if (days.length === 1) return dayName(locale, first);
  return `${dayName(locale, first)}${HOURS_COPY[locale].dayRangeSeparator}${dayName(locale, last)}`;
}

/**
 * Renders opening hours for one locale.
 *
 * Guarantees the visible text describes exactly the same intervals as
 * `toOpeningHoursSpecification()` — both read the same normalisation — and that consecutive days
 * with identical hours collapse into one row, which is what a human expects to read and what keeps
 * the block short enough to sit above the fold on a phone.
 */
export function formatHoursForLocale(hours: OpeningHours | null, locale: Locale): FormattedHours {
  const copy = HOURS_COPY[locale];
  if (hours === null) {
    return {
      lines: [],
      exceptions: [],
      byAppointmentOnly: false,
      byAppointmentLabel: null,
      timeZone: '',
    };
  }

  const byDay = intervalsByDay(hours);
  const hasAnyHours = DAYS_OF_WEEK.some((day) => (byDay.get(day) ?? []).length > 0);

  const lines: FormattedHoursLine[] = [];
  if (hasAnyHours) {
    let run: { signature: string; days: DayOfWeek[]; intervals: OpeningInterval[] } | null = null;
    for (const day of DAYS_OF_WEEK) {
      const intervals = byDay.get(day) ?? [];
      const signature = intervals.map((i) => `${i.opens}-${i.closes}`).join('|');
      if (run !== null && run.signature === signature) {
        run.days.push(day);
        continue;
      }
      if (run !== null) lines.push(toLine(locale, run.days, run.intervals));
      run = { signature, days: [day], intervals };
    }
    if (run !== null) lines.push(toLine(locale, run.days, run.intervals));
  }

  const exceptions: FormattedHoursException[] = hours.exceptions
    .filter((e) => isIsoDate(e.from) && isIsoDate(e.to) && e.from <= e.to)
    .map((e) => {
      const from = copy.formatDate(e.from);
      const to = copy.formatDate(e.to);
      return {
        from: e.from,
        to: e.to,
        closed: e.closed,
        label: e.closed ? copy.closedBetween(from, to) : copy.openBetween(from, to),
      };
    });

  return {
    lines,
    exceptions,
    byAppointmentOnly: hours.byAppointmentOnly,
    byAppointmentLabel: hours.byAppointmentOnly ? copy.byAppointment : null,
    timeZone: hours.tz,
  };
}

/** Renders one row of the hours table. */
function toLine(
  locale: Locale,
  days: readonly DayOfWeek[],
  intervals: readonly OpeningInterval[],
): FormattedHoursLine {
  const copy = HOURS_COPY[locale];
  const closed = intervals.length === 0;
  const first = intervals[0];
  const allDay =
    intervals.length === 1 &&
    first !== undefined &&
    first.opens === OPEN_ALL_DAY.opens &&
    first.closes === OPEN_ALL_DAY.closes;

  const hoursLabel = closed
    ? copy.closed
    : allDay
      ? copy.allDay
      : intervals.map((i) => `${i.opens}–${i.closes}`).join(' · ');

  return {
    days: [...days],
    daysLabel: daysLabel(locale, days),
    hoursLabel,
    intervals: [...intervals],
    closed,
    allDay,
    crossesMidnight: intervals.some(crossesMidnight),
  };
}
