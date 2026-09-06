/**
 * The bridge between the 7-day grid the user edits and the schema.org-shaped `OpeningHours` the
 * API stores.
 *
 * The stored shape groups days that share the same hours (`{dayOfWeek: ["Monday", …, "Friday"],
 * opens, closes}`) because that is what `openingHoursSpecification` wants and what keeps the column
 * inside its 4096-character CHECK. The editable shape is one row per day with a list of intervals,
 * because that is what a person means by "Thursday we close at 21:00". Converting between them is
 * the whole content of this module, and it is pure — which is what makes the round trip testable
 * and keeps the component free of data plumbing.
 *
 * ROUND-TRIP GUARANTEE: `hoursFromGrid(gridFromHours(h))` describes the same open intervals as `h`
 * for every `h` this UI can produce. It is not byte-identical — day groups are recomputed and
 * therefore normalised — which is deliberate: two spellings of the same week would otherwise make
 * "has the user changed anything?" undecidable.
 */

import { DAYS_OF_WEEK } from '@aibuilder/core';
import type { DayOfWeek, OpeningHours } from '@aibuilder/core';

import type { HoursPresetId } from './types';
import type { HoursInterval } from './validation';

/** Longest split shift we allow: morning, afternoon, evening (UX §2.4). */
export const MAX_INTERVALS_PER_DAY = 3;

/** One editable day. `open: false` renders the row greyed with its intervals preserved. */
export interface DayRow {
  open: boolean;
  intervals: HoursInterval[];
}

/** The editable week. Total over `DayOfWeek`, so a missing day is a compile error. */
export type DayGrid = Record<DayOfWeek, DayRow>;

/** Monday–Friday. */
export const WEEKDAYS: readonly DayOfWeek[] = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
];

/** Saturday–Sunday. */
export const WEEKEND: readonly DayOfWeek[] = ['Saturday', 'Sunday'];

/**
 * The visitor's IANA time zone, falling back to the product's home zone.
 *
 * Read from the browser rather than hard-coded: the hours a Portuguese baker enters are local, and
 * storing them under `Europe/Amsterdam` would shift every JSON-LD `opens` by an hour.
 */
export function detectTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone.length > 0 ? zone : 'Europe/Amsterdam';
  } catch {
    return 'Europe/Amsterdam';
  }
}

/** An empty week: every day closed, no intervals. */
export function emptyGrid(): DayGrid {
  const grid = {} as DayGrid;
  for (const day of DAYS_OF_WEEK) {
    grid[day] = { open: false, intervals: [] };
  }
  return grid;
}

/** Explodes stored hours into the editable grid. */
export function gridFromHours(hours: OpeningHours | null): DayGrid {
  const grid = emptyGrid();
  if (hours === null) {
    return grid;
  }
  for (const entry of hours.spec) {
    for (const day of entry.dayOfWeek) {
      const row = grid[day];
      if (row.intervals.length < MAX_INTERVALS_PER_DAY) {
        row.open = true;
        row.intervals.push({ opens: entry.opens, closes: entry.closes });
      }
    }
  }
  for (const day of DAYS_OF_WEEK) {
    grid[day].intervals.sort((a, b) => a.opens.localeCompare(b.opens));
  }
  return grid;
}

/**
 * Collapses the editable grid back into stored hours.
 *
 * Days with identical interval lists share one `spec` entry, so `Mo–Fr 09:00–17:00` is three
 * entries and not fifteen. Closed days land in `closed`, which is what the renderer uses to print
 * "zondag gesloten" rather than silently omitting the row.
 */
export function hoursFromGrid(
  grid: DayGrid,
  options: { timeZone: string; byAppointmentOnly: boolean },
): OpeningHours {
  const spec: OpeningHours['spec'] = [];
  const closed: string[] = [];

  // Group by the interval signature so identical days collapse regardless of week order.
  const byIntervals = new Map<string, { intervals: HoursInterval[]; days: DayOfWeek[] }>();
  for (const day of DAYS_OF_WEEK) {
    const row = grid[day];
    const intervals = row.open ? row.intervals.filter(isCompleteInterval) : [];
    if (intervals.length === 0) {
      closed.push(day);
      continue;
    }
    const signature = intervals.map((i) => `${i.opens}-${i.closes}`).join('|');
    const bucket = byIntervals.get(signature);
    if (bucket === undefined) {
      byIntervals.set(signature, { intervals, days: [day] });
    } else {
      bucket.days.push(day);
    }
  }

  for (const bucket of byIntervals.values()) {
    for (const interval of bucket.intervals) {
      spec.push({ dayOfWeek: bucket.days, opens: interval.opens, closes: interval.closes });
    }
  }

  return {
    tz: options.timeZone,
    byAppointmentOnly: options.byAppointmentOnly,
    spec,
    closed,
    // Holiday exceptions are a Phase 2 editor feature; the field exists in the contract and stays
    // empty here rather than being invented from a calendar we do not have.
    exceptions: [],
  };
}

/** True when both ends of an interval are present. Half-typed rows are dropped, never stored. */
function isCompleteInterval(interval: HoursInterval): boolean {
  return interval.opens.length === 5 && interval.closes.length === 5;
}

/** Builds a week where `days` share one interval and everything else is closed. */
function weekOf(days: readonly DayOfWeek[], opens: string, closes: string): DayGrid {
  const grid = emptyGrid();
  for (const day of days) {
    grid[day] = { open: true, intervals: [{ opens, closes }] };
  }
  return grid;
}

/**
 * The chip presets (UX §2.4).
 *
 * Chip-first is the entire point of this step: the median user never opens the grid, which is what
 * turns a 12-second step into a 3-second one. The presets are therefore ordinary Dutch trading
 * patterns, not a demonstration of the grid's flexibility.
 */
export const HOURS_PRESETS: Readonly<Record<HoursPresetId, () => DayGrid>> = {
  weekdays_9_17: () => weekOf(WEEKDAYS, '09:00', '17:00'),
  mon_sat_9_18: () =>
    weekOf(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'], '09:00', '18:00'),
  tue_sun_12_22: () =>
    weekOf(['Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'], '12:00', '22:00'),
  // "By appointment" has no grid at all: the flag is the answer, and showing seven empty rows
  // underneath it would invite the user to contradict themselves.
  appointment: () => emptyGrid(),
  always: () => weekOf(DAYS_OF_WEEK, '00:00', '23:59'),
};

/** True when the preset carries no grid, only the `byAppointmentOnly` flag. */
export function presetIsAppointmentOnly(preset: HoursPresetId): boolean {
  return preset === 'appointment';
}

/** Signature of a grid, for comparing a live grid against a preset. */
function gridSignature(grid: DayGrid): string {
  return DAYS_OF_WEEK.map((day) => {
    const row = grid[day];
    return row.open ? row.intervals.map((i) => `${i.opens}-${i.closes}`).join('+') : '';
  }).join('|');
}

/**
 * The preset a grid matches, or `null` once the user has edited it.
 *
 * Used to keep the chip selection honest after a manual edit: a chip that stays lit while the grid
 * says something else is a lie the user will only discover on their published site.
 */
export function detectPreset(grid: DayGrid, byAppointmentOnly: boolean): HoursPresetId | null {
  if (byAppointmentOnly) {
    return 'appointment';
  }
  const signature = gridSignature(grid);
  for (const [id, build] of Object.entries(HOURS_PRESETS) as ReadonlyArray<
    [HoursPresetId, () => DayGrid]
  >) {
    if (id !== 'appointment' && gridSignature(build()) === signature) {
      return id;
    }
  }
  return null;
}

/** Copies one day's intervals onto a set of target days. Returns a new grid. */
export function copyDayTo(
  grid: DayGrid,
  source: DayOfWeek,
  targets: readonly DayOfWeek[],
): DayGrid {
  const row = grid[source];
  const next: DayGrid = { ...grid };
  for (const day of targets) {
    if (day === source) {
      continue;
    }
    next[day] = {
      open: row.open,
      intervals: row.intervals.map((interval) => ({ ...interval })),
    };
  }
  return next;
}

/**
 * Replaces one day's row, returning a new grid.
 *
 * A one-line helper with a declared return type, rather than an inline `{ ...grid, [day]: row }`:
 * an object literal with a computed key of union type widens to an index signature, and the
 * annotation here is what keeps `DayGrid`'s totality checked at every call site.
 */
export function withDay(grid: DayGrid, day: DayOfWeek, row: DayRow): DayGrid {
  return { ...grid, [day]: row };
}
