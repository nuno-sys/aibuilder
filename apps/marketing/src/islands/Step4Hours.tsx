/**
 * Step 4 — opening hours. Chips first, grid second, and the grid stays shut until it is wanted.
 *
 * CHIP-FIRST IS THE WHOLE DESIGN. Opening hours are the second-most abandoned field in the flow,
 * and the reason is that a seven-row time grid *looks* like fifteen decisions before it is one. Four
 * presets cover the large majority of Dutch trading patterns, so the median user taps once and moves
 * on. The grid is a progressive disclosure for the minority who need it, and the summary line above
 * it is always current, so nobody has to open the grid to check what was chosen.
 *
 * `<select>` AT 15-MINUTE STEPS, NOT `<input type="time">`. The native time input renders AM/PM
 * wherever the *operating system* locale says so — regardless of the page's language — has no
 * coarse stepping that survives every mobile browser, and cannot be typed at with the select's
 * native typeahead ("14" jumps to 14:00). For a European hours grid the select is simply the better
 * control, and 96 options is not a scrolling problem when typeahead works.
 *
 * `+ pauze` EXISTS BECAUSE RESTAURANTS EXIST. A kitchen that serves 12:00–14:00 and 17:00–22:00 is
 * not an edge case in this market, and a UI that can only express one interval per day silently
 * publishes wrong hours — which is worse than publishing none.
 */

import { useEffect, useState } from 'react';
import { DAYS_OF_WEEK } from '@aibuilder/core';
import type { DayOfWeek, Locale } from '@aibuilder/core';

import { copyFor } from '../lib/copy';
import { dayLabel, hoursSummary, interpolate, TIME_OPTIONS } from '../lib/format';
import {
  copyDayTo,
  detectPreset,
  detectTimeZone,
  gridFromHours,
  hoursFromGrid,
  HOURS_PRESETS,
  MAX_INTERVALS_PER_DAY,
  presetIsAppointmentOnly,
  WEEKDAYS,
  WEEKEND,
  withDay,
} from '../lib/opening-hours';
import type { DayGrid } from '../lib/opening-hours';
import type { Draft, DraftUiState, DraftValues, HoursPresetId } from '../lib/types';
import { validateDayIntervals, validationMessage } from '../lib/validation';

import FieldMessage from './FieldMessage';
import fields from './fields.module.css';
import styles from './Step4Hours.module.css';

/** Chip order. `appointment` sits fourth because it is the "none of the above" answer. */
const PRESET_ORDER: readonly HoursPresetId[] = [
  'weekdays_9_17',
  'mon_sat_9_18',
  'tue_sun_12_22',
  'appointment',
  'always',
];

export interface Step4HoursProps {
  readonly draft: Draft;
  readonly locale: Locale;
  readonly setValues: (patch: Partial<DraftValues>) => void;
  readonly setUi: (patch: Partial<DraftUiState>) => void;
  readonly onAnnounce: (message: string) => void;
}

/**
 * Renders the presets, the summary and the optional grid.
 *
 * Guarantees the stored `OpeningHours` always describes exactly what the grid shows: every edit
 * goes through `hoursFromGrid`, and the summary is rendered by the same function the generated site
 * uses.
 */
export default function Step4Hours({
  draft,
  locale,
  setValues,
  setUi,
  onAnnounce,
}: Step4HoursProps) {
  const copy = copyFor(locale);
  const [grid, setGrid] = useState<DayGrid>(() => gridFromHours(draft.values.openingHours));
  const [openMenu, setOpenMenu] = useState<DayOfWeek | null>(null);
  const byAppointment = draft.values.openingHours?.byAppointmentOnly ?? false;

  // A preset chosen elsewhere (a resumed draft, the conflict chooser) must be reflected here.
  useEffect(() => {
    setGrid(gridFromHours(draft.values.openingHours));
  }, [draft.values.openingHours]);

  /** Writes a grid up into the draft and keeps the chip selection honest. */
  const commit = (next: DayGrid, appointmentOnly = byAppointment): void => {
    setGrid(next);
    setValues({
      openingHours: hoursFromGrid(next, {
        timeZone: draft.values.openingHours?.tz ?? detectTimeZone(),
        byAppointmentOnly: appointmentOnly,
      }),
    });
    setUi({ hoursPreset: detectPreset(next, appointmentOnly) });
  };

  const applyPreset = (preset: HoursPresetId): void => {
    const next = HOURS_PRESETS[preset]();
    const appointmentOnly = presetIsAppointmentOnly(preset);
    setGrid(next);
    setValues({
      openingHours: hoursFromGrid(next, {
        timeZone: draft.values.openingHours?.tz ?? detectTimeZone(),
        byAppointmentOnly: appointmentOnly,
      }),
    });
    setUi({ hoursPreset: preset, hoursGridOpen: false });
  };

  const summary = hoursSummary(draft.values.openingHours, locale);

  return (
    <div>
      <div className={fields.field}>
        <p className={fields.label} id="hours-presets-label">
          {copy.step4.presetLabel}
        </p>
        {/* A radiogroup rather than a set of buttons: exactly one preset is in force at a time, and
            arrow-key navigation between the chips is what a radiogroup gives for free. */}
        <div className={fields.chips} role="radiogroup" aria-labelledby="hours-presets-label">
          {PRESET_ORDER.map((preset) => {
            const active = draft.ui.hoursPreset === preset;
            return (
              <button
                key={preset}
                type="button"
                role="radio"
                aria-checked={active}
                className={`${fields.chip} ${active ? fields.chipSelected : ''}`}
                onClick={() => {
                  applyPreset(preset);
                }}
              >
                {copy.step4.presets[preset]}
              </button>
            );
          })}
        </div>
      </div>

      <p className={styles.summary}>{summary.length > 0 ? summary : copy.step4.summaryEmpty}</p>

      {!byAppointment ? (
        <button
          type="button"
          className={`${fields.button} ${fields.buttonSecondary} ${styles.toggle}`}
          aria-expanded={draft.ui.hoursGridOpen}
          aria-controls="hours-grid"
          onClick={() => {
            setUi({ hoursGridOpen: !draft.ui.hoursGridOpen });
          }}
        >
          {draft.ui.hoursGridOpen ? copy.step4.closeGrid : copy.step4.openGrid}
        </button>
      ) : null}

      {/* Kept in the DOM so `aria-controls` always resolves; `hidden` removes it from the tree
          entirely, which is what a collapsed disclosure should do. */}
      <div id="hours-grid" hidden={byAppointment || !draft.ui.hoursGridOpen}>
        <table className={styles.grid}>
          <caption className="sr-only">{copy.step4.gridLabel}</caption>
          <tbody>
            {DAYS_OF_WEEK.map((day) => {
              const row = grid[day];
              const failure = row.open ? validateDayIntervals(row.intervals) : null;
              return (
                <tr key={day} className={styles.row}>
                  <th scope="row" className={styles.day}>
                    {dayLabel(locale, day)}
                  </th>
                  <td className={styles.cellSwitch}>
                    <label className={styles.switch}>
                      <input
                        type="checkbox"
                        className={fields.checkboxInput}
                        checked={row.open}
                        onChange={(event) => {
                          const open = event.target.checked;
                          commit(
                            withDay(grid, day, {
                              open,
                              intervals:
                                open && row.intervals.length === 0
                                  ? [{ opens: '09:00', closes: '17:00' }]
                                  : row.intervals,
                            }),
                          );
                        }}
                      />
                      <span className={styles.switchLabel}>
                        {row.open ? copy.step4.open : copy.step4.closed}
                      </span>
                    </label>
                  </td>
                  <td className={styles.cellTimes}>
                    {row.open
                      ? row.intervals.map((interval, index) => (
                          <div key={`${day}-${String(index)}`} className={styles.interval}>
                            <label
                              className="sr-only"
                              htmlFor={`hours-${day}-${String(index)}-from`}
                            >
                              {`${dayLabel(locale, day, 'long')} ${copy.step4.from}`}
                            </label>
                            <select
                              id={`hours-${day}-${String(index)}-from`}
                              className={`${fields.select} ${styles.time}`}
                              value={interval.opens}
                              onChange={(event) => {
                                const intervals = row.intervals.map((entry, position) =>
                                  position === index
                                    ? { ...entry, opens: event.target.value }
                                    : entry,
                                );
                                commit(withDay(grid, day, { ...row, intervals }));
                              }}
                            >
                              {TIME_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>

                            <span className={styles.dash} aria-hidden="true">
                              –
                            </span>

                            <label className="sr-only" htmlFor={`hours-${day}-${String(index)}-to`}>
                              {`${dayLabel(locale, day, 'long')} ${copy.step4.to}`}
                            </label>
                            <select
                              id={`hours-${day}-${String(index)}-to`}
                              className={`${fields.select} ${styles.time}`}
                              value={interval.closes}
                              onChange={(event) => {
                                const intervals = row.intervals.map((entry, position) =>
                                  position === index
                                    ? { ...entry, closes: event.target.value }
                                    : entry,
                                );
                                commit(withDay(grid, day, { ...row, intervals }));
                              }}
                            >
                              {TIME_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>

                            {index > 0 ? (
                              <button
                                type="button"
                                className={styles.iconButton}
                                aria-label={`${copy.step4.removeBreak} — ${dayLabel(locale, day, 'long')}`}
                                onClick={() => {
                                  const intervals = row.intervals.filter(
                                    (_unused, position) => position !== index,
                                  );
                                  commit(withDay(grid, day, { ...row, intervals }));
                                }}
                              >
                                <svg
                                  viewBox="0 0 16 16"
                                  aria-hidden="true"
                                  focusable="false"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                >
                                  <path d="M4 8h8" />
                                </svg>
                              </button>
                            ) : null}
                          </div>
                        ))
                      : null}

                    {row.open && row.intervals.length < MAX_INTERVALS_PER_DAY ? (
                      <button
                        type="button"
                        className={`${fields.button} ${fields.buttonGhost} ${styles.addBreak}`}
                        onClick={() => {
                          const last = row.intervals[row.intervals.length - 1];
                          const intervals = [
                            ...row.intervals,
                            { opens: last?.closes ?? '18:00', closes: '22:00' },
                          ];
                          commit(withDay(grid, day, { ...row, intervals }));
                        }}
                      >
                        {copy.step4.addBreak}
                      </button>
                    ) : null}

                    {failure !== null ? (
                      <FieldMessage fieldId={`hours-${day}`} tone="error">
                        {validationMessage(failure.code, locale)}
                      </FieldMessage>
                    ) : null}
                  </td>
                  <td className={styles.cellMenu}>
                    {/* A disclosure, not an ARIA menu. The menu pattern requires roving tabindex and
                        arrow navigation; three plain buttons in a popover are keyboard-complete
                        without any of it, and a half-implemented menu role is worse than none. */}
                    <button
                      type="button"
                      className={styles.iconButton}
                      aria-expanded={openMenu === day}
                      aria-label={interpolate(copy.step4.rowMenu, {
                        day: dayLabel(locale, day, 'long'),
                      })}
                      onClick={() => {
                        setOpenMenu((previous) => (previous === day ? null : day));
                      }}
                    >
                      <svg
                        viewBox="0 0 16 16"
                        aria-hidden="true"
                        focusable="false"
                        fill="currentColor"
                      >
                        <circle cx="3" cy="8" r="1.5" />
                        <circle cx="8" cy="8" r="1.5" />
                        <circle cx="13" cy="8" r="1.5" />
                      </svg>
                    </button>

                    {openMenu === day ? (
                      <div
                        className={styles.menu}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            setOpenMenu(null);
                          }
                        }}
                      >
                        {(
                          [
                            [copy.step4.copyAll, DAYS_OF_WEEK],
                            [copy.step4.copyWeekdays, WEEKDAYS],
                            [copy.step4.copyWeekend, WEEKEND],
                          ] as ReadonlyArray<[string, readonly DayOfWeek[]]>
                        ).map(([label, targets]) => (
                          <button
                            key={label}
                            type="button"
                            className={styles.menuItem}
                            onClick={() => {
                              const next = copyDayTo(grid, day, targets);
                              commit(next);
                              setOpenMenu(null);
                              onAnnounce(
                                interpolate(copy.step4.copied, {
                                  day: dayLabel(locale, day, 'long'),
                                  hours: row.intervals
                                    .map((interval) => `${interval.opens}–${interval.closes}`)
                                    .join(', '),
                                  count: targets.filter((target) => target !== day).length,
                                }),
                              );
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
