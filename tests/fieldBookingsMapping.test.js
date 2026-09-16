/**
 * `utils/fieldBookings.js` — the one mapping from the shipped tables onto the
 * shapes `findBlackoutConflicts()` takes.
 *
 * This file exists because of two defects in this PR that its other tests could
 * not see:
 *
 *  - `toClosureInputs` did not exist, and two pages passed `field_closures`
 *    rows straight into a `.strict()` schema. Every unit test passed, because
 *    each one constructed an input already in the schema's shape; the E2E suite
 *    was the only thing that ran the real projection, and it threw on render.
 *  - A plant that made an unreadable `day_of_week` silently become Monday was
 *    NOT CAUGHT by any test in the suite. Nothing exercised this module at all.
 */

import { describe, it, expect } from 'vitest';
import { ClosureRowSchema, findBlackoutConflicts } from '@squadlogic/core/fieldAdmin/index.js';
import {
  gameSlotDate,
  timeColumnToMinutes,
  toBlackoutWarnings,
  toClosureInputs,
  toFieldBookings,
} from '../frontend/src/utils/fieldBookings.js';

describe('timeColumnToMinutes', () => {
  it('reads a time column and refuses anything else', () => {
    expect(timeColumnToMinutes('16:00:00')).toBe(960);
    expect(timeColumnToMinutes('00:30')).toBe(30);
    for (const bad of [null, undefined, '', 'evening', 123]) {
      expect(timeColumnToMinutes(/** @type {any} */ (bad))).toBeNull();
    }
  });
});

describe('toFieldBookings', () => {
  it('prefers slot_date and falls back to start, as every sibling does', () => {
    // **Review finding.** Reading `slot_date` alone made a slot persisted with
    // `start` and no `slot_date` render on the grid and be invisible to the
    // blackout check. `public.field_bookings`, `normalizeGameSlot` and the mock
    // all COALESCE; this is the fourth reading of the same question and it now
    // agrees with the other three.
    expect(gameSlotDate({ slot_date: '2026-09-16', start: '2026-10-01T00:00:00Z' })).toBe(
      '2026-09-16'
    );
    expect(gameSlotDate({ slot_date: null, start: '2026-10-01T23:30:00Z' })).toBe('2026-10-01');
    for (const row of [{}, { slot_date: null }, { start: 'tomorrow' }, { start: 12345 }]) {
      expect(gameSlotDate(row)).toBeNull();
    }

    const { dated, unreadable } = toFieldBookings({
      gameSlots: [{ id: 'gs-1', field_id: 'f-1', slot_date: null, start: '2026-10-01T18:00:00Z' }],
    });
    expect(unreadable).toEqual([]);
    expect(dated[0].onDate).toBe('2026-10-01');
  });

  it('reads a half-specified clock as no clock', () => {
    const { dated, recurring } = toFieldBookings({
      gameSlots: [{ id: 'gs-1', field_id: 'f-1', slot_date: '2026-09-16', start_time: '09:00:00' }],
      practiceSlots: [{ id: 'ps-1', field_id: 'f-1', day_of_week: 'wed', end_time: '17:00:00' }],
    });
    // The mapping passes both through; the SCHEMA normalises. Asserted on the
    // reading rather than on the mapping so the guarantee is pinned where it is
    // enforced.
    expect(dated[0].startMinutes).toBe(540);
    expect(dated[0].endMinutes).toBeNull();
    expect(recurring[0].endMinutes).toBe(1020);
  });

  it('maps a game slot from its wall-clock columns in preference to `start`', () => {
    const { dated, unreadable } = toFieldBookings({
      gameSlots: [
        {
          id: 'gs-1',
          field_id: 'f-1',
          slot_date: '2026-09-16',
          start_time: '16:00:00',
          end_time: '17:30:00',
          // A timestamptz that DISAGREES with the wall clock above. Reading it
          // would cross a timezone seam silently, which is GAP-30.
          start: '2026-09-16T23:00:00Z',
        },
      ],
    });
    expect(unreadable).toEqual([]);
    expect(dated).toEqual([
      {
        kind: 'game',
        id: 'gs-1',
        fieldId: 'f-1',
        label: 'Game slot',
        onDate: '2026-09-16',
        startMinutes: 960,
        endMinutes: 1050,
      },
    ]);
  });

  it('takes a division label when the caller embedded one', () => {
    const { dated } = toFieldBookings({
      gameSlots: [
        { id: 'gs-1', field_id: 'f-1', slot_date: '2026-09-16', divisions: { name: 'U12' } },
      ],
    });
    expect(dated[0].label).toBe('U12 game');
    expect(dated[0].startMinutes).toBeNull();
  });

  it('reports a slot it cannot place, rather than dropping it', () => {
    const { dated, recurring, unreadable } = toFieldBookings({
      gameSlots: [{ id: 'gs-1', field_id: 'f-1', slot_date: null }],
      practiceSlots: [
        { id: 'ps-1', field_id: 'f-1', day_of_week: 'someday' },
        { id: 'ps-2', field_id: 'f-1', day_of_week: null },
      ],
    });
    // **Never a default.** A plant making an unreadable day read as Monday
    // would report conflicts on ground nobody booked, and a conflict count that
    // silently omitted these rows would read as "clean".
    expect(dated).toEqual([]);
    expect(recurring).toEqual([]);
    expect(unreadable.map((row) => row.id).sort()).toEqual(['gs-1', 'ps-1', 'ps-2']);
    expect(unreadable[0].why).toMatch(/slot_date/);
    expect(unreadable[1].why).toMatch(/day_of_week/);
  });

  it('maps every weekday name the column writes onto its ISO number', () => {
    const { recurring } = toFieldBookings({
      practiceSlots: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day, index) => ({
        id: `ps-${index}`,
        field_id: 'f-1',
        day_of_week: day,
      })),
    });
    expect(recurring.map((row) => row.dayOfWeek)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('carries a practice validity window, with null meaning unbounded', () => {
    const { recurring } = toFieldBookings({
      practiceSlots: [
        {
          id: 'ps-1',
          field_id: 'f-1',
          day_of_week: 'wed',
          start_time: '16:00:00',
          end_time: '17:00:00',
          valid_from: '2026-08-01',
          valid_until: null,
          fields: { name: 'North Field' },
        },
      ],
    });
    expect(recurring[0]).toMatchObject({
      label: 'Practice on North Field',
      validFrom: '2026-08-01',
      validUntil: null,
    });
  });
});

describe('toClosureInputs', () => {
  const ROW = {
    id: 'bo-1',
    source: 'field_blackouts',
    closesFieldId: 'f-1',
    closesLocationId: null,
    blackoutFrom: '2026-09-14',
    blackoutUntil: '2026-09-18',
    startMinutes: null,
    endMinutes: null,
    // The three display-only keys the hook carries and the reading does not.
    reason: 'maintenance',
    note: 'reseeding',
    sourceReasonText: null,
  };

  it('produces a row the strict schema accepts', () => {
    // **The positive control is the unprojected row.** This is the exact defect
    // the E2E suite caught: `ClosureRowSchema` is `.strict()`, so a hook row
    // passed through untouched throws at render time with every unit test
    // green.
    expect(() => ClosureRowSchema.parse(ROW)).toThrow(/Unrecognized|unrecognized/i);
    expect(() => ClosureRowSchema.parse(toClosureInputs([ROW])[0])).not.toThrow();
  });

  it('keeps every key the reading depends on', () => {
    expect(toClosureInputs([ROW])[0]).toEqual({
      id: 'bo-1',
      source: 'field_blackouts',
      closesFieldId: 'f-1',
      closesLocationId: null,
      blackoutFrom: '2026-09-14',
      blackoutUntil: '2026-09-18',
      startMinutes: null,
      endMinutes: null,
    });
  });

  it('round-trips through the reading the pages actually run', () => {
    // End to end over the two mappings together, which is the combination each
    // page performs and neither mapping's own test covers.
    const { dated, recurring } = toFieldBookings({
      gameSlots: [
        {
          id: 'gs-1',
          field_id: 'f-1',
          slot_date: '2026-09-16',
          start_time: '16:00:00',
          end_time: '17:00:00',
        },
      ],
      practiceSlots: [
        {
          id: 'ps-1',
          field_id: 'f-1',
          day_of_week: 'wed',
          start_time: '16:00:00',
          end_time: '17:00:00',
          valid_from: '2026-08-01',
          valid_until: '2026-11-30',
        },
      ],
    });
    const { findings, meta } = findBlackoutConflicts({
      closures: toClosureInputs([ROW]),
      fields: [{ id: 'f-1', locationId: 'loc-1' }],
      dated,
      recurring,
    });
    expect(meta.pairsCompared).toBe(2);
    expect(findings.map((finding) => finding.details.bookingId).sort()).toEqual(['gs-1', 'ps-1']);
  });
});

describe('toBlackoutWarnings', () => {
  const finding = (id) => ({
    message: `booking ${id} stands inside a blackout`,
    details: { bookingId: id, bookingKind: 'game' },
  });

  it('carries every finding, and the unjudged rows beside them', () => {
    // **Review finding.** Both scheduling pages mapped findings inline and
    // both DISCARDED `unreadable`, so a slot nothing could place produced no
    // conflict and no notice -- a banner reading clean while a row had not been
    // judged. One producer now, with the notice in it.
    const warnings = toBlackoutWarnings(
      [finding('a'), finding('b')],
      [{ kind: 'game', id: 'gs-9', why: 'no slot_date and no start' }]
    );
    expect(warnings.map((warning) => warning.type)).toEqual([
      'field-blackout',
      'field-blackout',
      'blackout-unjudged',
    ]);
    expect(warnings[2].message).toMatch(/could not be placed on a calendar/);
  });

  it('caps the list and states the remainder, so the count stays right', () => {
    const warnings = toBlackoutWarnings(
      Array.from({ length: 30 }, (_unused, index) => finding(String(index))),
      [],
      25
    );
    expect(warnings).toHaveLength(26);
    expect(warnings[25].message).toMatch(/and 5 more booking/);
    expect(warnings[25].details).toEqual({ omitted: 5, total: 30 });
  });

  it('says nothing when there is nothing to say', () => {
    expect(toBlackoutWarnings([], [])).toEqual([]);
  });
});
