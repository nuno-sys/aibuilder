import { describe, expect, it } from 'vitest';

import { formatHoursForLocale, toOpeningHoursSpecification } from '../hours';
import type { OpeningHours } from '../intake';

/** Builds an `OpeningHours` with the boring fields filled in. */
function hours(partial: Partial<OpeningHours> = {}): OpeningHours {
  return {
    tz: 'Europe/Amsterdam',
    byAppointmentOnly: false,
    spec: [],
    closed: [],
    exceptions: [],
    ...partial,
  };
}

describe('toOpeningHoursSpecification', () => {
  it('collapses days that share an interval into one spec', () => {
    const result = toOpeningHoursSpecification(
      hours({
        spec: [
          {
            dayOfWeek: ['Tuesday', 'Wednesday', 'Thursday', 'Friday'],
            opens: '07:00',
            closes: '18:00',
          },
        ],
      }),
    );

    expect(result.openingHoursSpecification[0]).toEqual({
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: ['Tuesday', 'Wednesday', 'Thursday', 'Friday'],
      opens: '07:00',
      closes: '18:00',
    });
  });

  it('emits a split shift as two specs for the same day, never one spanning the gap', () => {
    const result = toOpeningHoursSpecification(
      hours({
        spec: [
          { dayOfWeek: ['Monday'], opens: '09:00', closes: '12:00' },
          { dayOfWeek: ['Monday'], opens: '14:00', closes: '18:00' },
        ],
      }),
    );

    const monday = result.openingHoursSpecification.filter((spec) =>
      spec.dayOfWeek?.includes('Monday'),
    );
    expect(monday).toHaveLength(2);
    expect(monday.map((spec) => `${spec.opens}-${spec.closes}`)).toEqual([
      '09:00-12:00',
      '14:00-18:00',
    ]);
  });

  it('merges overlapping intervals on the same day instead of emitting both', () => {
    const result = toOpeningHoursSpecification(
      hours({
        spec: [
          { dayOfWeek: ['Monday'], opens: '09:00', closes: '12:00' },
          { dayOfWeek: ['Monday'], opens: '11:00', closes: '14:00' },
        ],
      }),
    );

    const monday = result.openingHoursSpecification.filter((spec) =>
      spec.dayOfWeek?.includes('Monday'),
    );
    expect(monday).toHaveLength(1);
    expect(monday[0]?.opens).toBe('09:00');
    expect(monday[0]?.closes).toBe('14:00');
  });

  it('keeps an interval that crosses midnight as closes < opens', () => {
    const result = toOpeningHoursSpecification(
      hours({ spec: [{ dayOfWeek: ['Friday', 'Saturday'], opens: '23:00', closes: '02:00' }] }),
    );

    const open = result.openingHoursSpecification[0];
    expect(open?.dayOfWeek).toEqual(['Friday', 'Saturday']);
    expect(open?.opens).toBe('23:00');
    expect(open?.closes).toBe('02:00');
  });

  it('does not merge a midnight-crossing interval with an earlier one', () => {
    const result = toOpeningHoursSpecification(
      hours({
        spec: [
          { dayOfWeek: ['Saturday'], opens: '12:00', closes: '15:00' },
          { dayOfWeek: ['Saturday'], opens: '20:00', closes: '03:00' },
        ],
      }),
    );

    const saturday = result.openingHoursSpecification.filter((spec) =>
      spec.dayOfWeek?.includes('Saturday'),
    );
    expect(saturday.map((spec) => `${spec.opens}-${spec.closes}`)).toEqual([
      '12:00-15:00',
      '20:00-03:00',
    ]);
  });

  it('turns a zero-length interval into open 24 hours', () => {
    const result = toOpeningHoursSpecification(
      hours({ spec: [{ dayOfWeek: ['Monday'], opens: '00:00', closes: '00:00' }] }),
    );

    const monday = result.openingHoursSpecification.find((spec) =>
      spec.dayOfWeek?.includes('Monday'),
    );
    expect(monday?.opens).toBe('00:00');
    expect(monday?.closes).toBe('23:59');
  });

  it('emits closed days explicitly as 00:00-00:00', () => {
    const result = toOpeningHoursSpecification(
      hours({
        spec: [{ dayOfWeek: ['Monday', 'Tuesday'], opens: '09:00', closes: '17:00' }],
        closed: ['Sunday'],
      }),
    );

    const closed = result.openingHoursSpecification.find(
      (spec) => spec.opens === '00:00' && spec.closes === '00:00',
    );
    expect(closed?.dayOfWeek).toEqual(['Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
  });

  it('lets an explicit closed day win over a leftover interval', () => {
    const result = toOpeningHoursSpecification(
      hours({
        spec: [{ dayOfWeek: ['Monday', 'Tuesday'], opens: '09:00', closes: '17:00' }],
        closed: ['Monday'],
      }),
    );

    const monday = result.openingHoursSpecification.find((spec) =>
      spec.dayOfWeek?.includes('Monday'),
    );
    expect(monday?.opens).toBe('00:00');
    expect(monday?.closes).toBe('00:00');
  });

  it('publishes no hours at all for an appointment-only business', () => {
    const result = toOpeningHoursSpecification(hours({ byAppointmentOnly: true }));

    expect(result.openingHoursSpecification).toEqual([]);
    expect(result.byAppointmentOnly).toBe(true);
  });

  it('puts holiday closures in specialOpeningHoursSpecification', () => {
    const result = toOpeningHoursSpecification(
      hours({
        spec: [{ dayOfWeek: ['Monday'], opens: '09:00', closes: '17:00' }],
        exceptions: [{ from: '2026-12-25', to: '2026-12-26', closed: true }],
      }),
    );

    expect(result.specialOpeningHoursSpecification).toEqual([
      {
        '@type': 'OpeningHoursSpecification',
        opens: '00:00',
        closes: '00:00',
        validFrom: '2026-12-25',
        validThrough: '2026-12-26',
      },
    ]);
    expect(result.openingHoursSpecification.every((spec) => spec.validFrom === undefined)).toBe(
      true,
    );
  });

  it('bounds the weekly hours to the season when an open exception is present', () => {
    const result = toOpeningHoursSpecification(
      hours({
        spec: [{ dayOfWeek: ['Monday'], opens: '09:00', closes: '17:00' }],
        exceptions: [{ from: '2026-04-01', to: '2026-10-31', closed: false }],
      }),
    );

    expect(
      result.openingHoursSpecification.every(
        (spec) => spec.validFrom === '2026-04-01' && spec.validThrough === '2026-10-31',
      ),
    ).toBe(true);
  });

  it('drops exceptions whose dates are not real calendar dates', () => {
    const result = toOpeningHoursSpecification(
      hours({
        spec: [{ dayOfWeek: ['Monday'], opens: '09:00', closes: '17:00' }],
        exceptions: [{ from: '2026-02-31', to: '2026-13-01', closed: true }],
      }),
    );

    expect(result.specialOpeningHoursSpecification).toEqual([]);
  });

  it('is deterministic, so render_sha256 cannot move on a no-op republish', () => {
    const input = hours({
      spec: [
        { dayOfWeek: ['Friday', 'Tuesday'], opens: '09:00', closes: '17:00' },
        { dayOfWeek: ['Monday'], opens: '14:00', closes: '18:00' },
        { dayOfWeek: ['Monday'], opens: '09:00', closes: '12:00' },
      ],
    });

    expect(JSON.stringify(toOpeningHoursSpecification(input))).toBe(
      JSON.stringify(toOpeningHoursSpecification(input)),
    );
  });

  it('returns empty properties for a business with no hours on file', () => {
    expect(toOpeningHoursSpecification(null)).toEqual({
      openingHoursSpecification: [],
      specialOpeningHoursSpecification: [],
      byAppointmentOnly: false,
    });
  });
});

describe('formatHoursForLocale', () => {
  it('collapses consecutive days with identical hours into one Dutch row', () => {
    const result = formatHoursForLocale(
      hours({
        spec: [
          {
            dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
            opens: '09:00',
            closes: '17:00',
          },
        ],
      }),
      'nl',
    );

    expect(result.lines[0]?.daysLabel).toBe('Ma t/m Vr');
    expect(result.lines[0]?.hoursLabel).toBe('09:00–17:00');
    expect(result.lines[1]?.daysLabel).toBe('Za t/m Zo');
    expect(result.lines[1]?.hoursLabel).toBe('Gesloten');
  });

  it('renders a split shift on one row', () => {
    const result = formatHoursForLocale(
      hours({
        spec: [
          { dayOfWeek: ['Monday'], opens: '09:00', closes: '12:00' },
          { dayOfWeek: ['Monday'], opens: '14:00', closes: '18:00' },
        ],
      }),
      'nl',
    );

    expect(result.lines[0]?.hoursLabel).toBe('09:00–12:00 · 14:00–18:00');
  });

  it('labels a 24-hour day and flags a midnight crossing', () => {
    const allDay = formatHoursForLocale(
      hours({ spec: [{ dayOfWeek: ['Monday'], opens: '00:00', closes: '00:00' }] }),
      'de',
    );
    expect(allDay.lines[0]?.hoursLabel).toBe('Durchgehend geöffnet');
    expect(allDay.lines[0]?.allDay).toBe(true);

    const nightclub = formatHoursForLocale(
      hours({ spec: [{ dayOfWeek: ['Saturday'], opens: '23:00', closes: '04:00' }] }),
      'nl',
    );
    const saturday = nightclub.lines.find((line) => line.days.includes('Saturday'));
    expect(saturday?.crossesMidnight).toBe(true);
  });

  it('renders the appointment-only line and the exception rows per locale', () => {
    const result = formatHoursForLocale(
      hours({
        byAppointmentOnly: true,
        exceptions: [{ from: '2026-12-25', to: '2026-12-26', closed: true }],
      }),
      'nl',
    );

    expect(result.byAppointmentLabel).toBe('Alleen op afspraak');
    expect(result.lines).toEqual([]);
    expect(result.exceptions[0]?.label).toBe('Gesloten van 25-12-2026 t/m 26-12-2026');
  });

  it('describes the same intervals as the JSON-LD it is rendered next to', () => {
    const input = hours({
      spec: [{ dayOfWeek: ['Monday'], opens: '09:00', closes: '12:00' }],
      closed: ['Sunday'],
    });

    const jsonLd = toOpeningHoursSpecification(input);
    const rendered = formatHoursForLocale(input, 'nl');

    const openInJsonLd = jsonLd.openingHoursSpecification.find((spec) => spec.opens === '09:00');
    const openInHtml = rendered.lines.find((line) => !line.closed);
    expect(openInJsonLd?.dayOfWeek).toEqual(openInHtml?.days);
  });
});
