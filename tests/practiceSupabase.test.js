import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPracticeSlotsFromSupabaseRows,
  expandSupabasePracticeSlots,
  buildPracticeAssignmentRows,
} from '../src/practiceSupabase.js';

describe('buildPracticeSlotsFromSupabaseRows', () => {
  it('normalizes camelCase and snake_case Supabase slot rows', () => {
    const rows = [
      {
        id: 'slot-1',
        day_of_week: 'mon',
        start_time: '18:00',
        end_time: '19:15',
        capacity: 2,
        valid_from: '2024-08-01',
        valid_until: '2024-09-01',
        field_id: 'field-1',
        field_subunit_id: 'field-1A',
        fieldLabel: 'Field 1A',
      },
      {
        slotId: 'slot-2',
        day: 'Thu',
        start: new Date('2024-08-01T00:30:00Z'),
        end: new Date('2024-08-01T01:30:00Z'),
        slotCapacity: 1,
        validFrom: new Date('2024-09-02'),
        validUntil: new Date('2024-10-01'),
        fieldId: 'field-2',
        location: 'Main Complex',
      },
    ];

    const normalized = buildPracticeSlotsFromSupabaseRows(rows);

    assert.deepEqual(normalized, [
      {
        id: 'slot-1',
        day: 'Mon',
        start: '18:00',
        end: '19:15',
        capacity: 2,
        validFrom: '2024-08-01',
        validUntil: '2024-09-01',
        fieldId: 'field-1',
        fieldSubunitId: 'field-1A',
        location: 'Field 1A',
      },
      {
        id: 'slot-2',
        day: 'Thu',
        start: '00:30',
        end: '01:30',
        capacity: 1,
        validFrom: '2024-09-02',
        validUntil: '2024-10-01',
        fieldId: 'field-2',
        fieldSubunitId: null,
        location: 'Main Complex',
      },
    ]);
  });

  it('rejects invalid time ordering', () => {
    const rows = [
      {
        id: 'slot-3',
        day: 'Tue',
        start: '19:00',
        end: '18:00',
        capacity: 1,
        validFrom: '2024-08-01',
        validUntil: '2024-09-01',
      },
    ];

    assert.throws(() => buildPracticeSlotsFromSupabaseRows(rows));
  });

  it('rejects unsupported day values', () => {
    const rows = [
      {
        id: 'slot-1',
        day: 'xyz',
        start: '18:00',
        end: '19:00',
        validFrom: '2024-08-01',
        validUntil: '2024-08-31',
        capacity: 2,
      },
    ];

    assert.throws(
      () => buildPracticeSlotsFromSupabaseRows(rows),
      /unsupported day value/i,
    );
  });

  it('rejects invalid time strings', () => {
    const baseRow = {
      id: 'slot-1',
      day: 'Tue',
      validFrom: '2024-08-01',
      validUntil: '2024-08-31',
      capacity: 2,
    };

    assert.throws(
      () => buildPracticeSlotsFromSupabaseRows([{ ...baseRow, start: '25:00', end: '26:00' }]),
      /invalid hour component/i,
    );
    assert.throws(
      () => buildPracticeSlotsFromSupabaseRows([{ ...baseRow, start: '10:60', end: '11:00' }]),
      /invalid minute component/i,
    );
    assert.throws(
      () => buildPracticeSlotsFromSupabaseRows([{ ...baseRow, start: 'abc', end: '11:00' }]),
      /invalid hour component/i,
    );
  });

  it('rejects invalid date strings', () => {
    const rows = [
      {
        id: 'slot-1',
        day: 'Tue',
        start: '18:00',
        end: '19:00',
        validFrom: 'not-a-date',
        validUntil: '2024-08-31',
        capacity: 2,
      },
    ];

    assert.throws(
      () => buildPracticeSlotsFromSupabaseRows(rows),
      /not a valid date/i,
    );
  });

  it('rejects invalid capacity values', () => {
    const baseRow = {
      id: 'slot-1',
      day: 'Tue',
      start: '18:00',
      end: '19:00',
      validFrom: '2024-08-01',
      validUntil: '2024-08-31',
    };

    assert.throws(
      () => buildPracticeSlotsFromSupabaseRows([{ ...baseRow, capacity: 0 }]),
      /capacity must be a positive number/i,
    );
    assert.throws(
      () => buildPracticeSlotsFromSupabaseRows([{ ...baseRow, capacity: -1 }]),
      /capacity must be a positive number/i,
    );
    assert.throws(
      () => buildPracticeSlotsFromSupabaseRows([{ ...baseRow, capacity: 'abc' }]),
      /capacity must be a positive number/i,
    );
  });

  it('rejects when validUntil precedes validFrom', () => {
    const rows = [
      {
        id: 'slot-1',
        day: 'Tue',
        start: '18:00',
        end: '19:00',
        validFrom: '2024-09-01',
        validUntil: '2024-08-31',
        capacity: 2,
      },
    ];

    assert.throws(
      () => buildPracticeSlotsFromSupabaseRows(rows),
      /validUntil precedes validFrom/i,
    );
  });

  it('accepts Friday and Saturday slots', () => {
    const rows = [
      {
        id: 'slot-fri',
        day: 'Friday',
        start: '18:00',
        end: '19:00',
        validFrom: '2024-08-01',
        validUntil: '2024-08-31',
        capacity: 2,
      },
      {
        id: 'slot-sat',
        day: 'sat',
        start: '09:00',
        end: '10:00',
        validFrom: '2024-08-01',
        validUntil: '2024-08-31',
        capacity: 2,
      },
    ];

    const result = buildPracticeSlotsFromSupabaseRows(rows);

    assert.deepEqual(
      result.map((slot) => ({ id: slot.id, day: slot.day })),
      [
        { id: 'slot-fri', day: 'Fri' },
        { id: 'slot-sat', day: 'Sat' },
      ],
    );
  });

  it('trims field identifiers and normalizes empty to null', () => {
    const rows = [
      {
        id: 'slot-1',
        day: 'Tue',
        start: '18:00',
        end: '19:00',
        validFrom: '2024-08-01',
        validUntil: '2024-08-31',
        capacity: 2,
        fieldId: '  FIELD-1  ',
        fieldSubunitId: '   ',
      },
    ];

    const [slot] = buildPracticeSlotsFromSupabaseRows(rows);

    assert.equal(slot.fieldId, 'FIELD-1');
    assert.equal(slot.fieldSubunitId, null);
  });

  it('requires required fields', () => {
    assert.throws(() => buildPracticeSlotsFromSupabaseRows('nope'));
    assert.throws(() => buildPracticeSlotsFromSupabaseRows([null]));
    assert.throws(() => buildPracticeSlotsFromSupabaseRows([{}]));
  });
});

describe('expandSupabasePracticeSlots', () => {
  it('expands normalized Supabase slots into season-aware effective slots with overrides', () => {
    const rows = [
      {
        id: 'slot-1',
        day: 'Mon',
        start: '17:00',
        end: '18:15',
        capacity: 2,
        validFrom: '2024-08-01',
        validUntil: '2024-10-31',
        seasonOverrides: {
          early: { endTime: '18:00' },
        },
      },
    ];

    const seasonPhases = [
      { id: 'early', startDate: '2024-08-01', endDate: '2024-09-15' },
      { id: 'late', startDate: '2024-09-16', endDate: '2024-10-31' },
    ];

    const expanded = expandSupabasePracticeSlots({ rows, seasonPhases });

    assert.equal(expanded.length, 2);
    assert.deepEqual(
      expanded.map((slot) => ({
        id: slot.id,
        baseSlotId: slot.baseSlotId,
        seasonPhaseId: slot.seasonPhaseId,
        day: slot.day,
        capacity: slot.capacity,
        effectiveFrom: slot.effectiveFrom,
        effectiveUntil: slot.effectiveUntil,
      })),
      [
        {
          id: 'slot-1::early',
          baseSlotId: 'slot-1',
          seasonPhaseId: 'early',
          day: 'Mon',
          capacity: 2,
          effectiveFrom: '2024-08-01',
          effectiveUntil: '2024-09-15',
        },
        {
          id: 'slot-1::late',
          baseSlotId: 'slot-1',
          seasonPhaseId: 'late',
          day: 'Mon',
          capacity: 2,
          effectiveFrom: '2024-09-16',
          effectiveUntil: '2024-10-31',
        },
      ],
    );

    const earlySlot = expanded.find((slot) => slot.seasonPhaseId === 'early');
    const lateSlot = expanded.find((slot) => slot.seasonPhaseId === 'late');

    assert.ok(earlySlot, 'Early phase slot should exist');
    assert.ok(lateSlot, 'Late phase slot should exist');

    assert.equal(earlySlot.start.toISOString(), '2024-08-05T17:00:00.000Z');
    assert.equal(earlySlot.end.toISOString(), '2024-08-05T18:00:00.000Z');
    assert.equal(lateSlot.start.toISOString(), '2024-09-16T17:00:00.000Z');
    assert.equal(lateSlot.end.toISOString(), '2024-09-16T18:15:00.000Z');
  });
});

describe('buildPracticeAssignmentRows', () => {
  const sampleSlots = [
    {
      id: 'slot-1::early',
      baseSlotId: 'slot-1',
      seasonPhaseId: 'early',
      effectiveFrom: '2024-08-01',
      effectiveUntil: '2024-09-15',
    },
    {
      id: 'slot-1::late',
      baseSlotId: 'slot-1',
      seasonPhaseId: 'late',
      effectiveFrom: '2024-09-16',
      effectiveUntil: '2024-10-31',
    },
  ];

  it('builds Supabase-ready practice assignment rows', () => {
    const assignments = [
      { teamId: 'team-1', slotId: 'slot-1::early', source: 'locked' },
      { teamId: 'team-2', slotId: 'slot-1::late', source: 'auto' },
    ];

    const rows = buildPracticeAssignmentRows({ assignments, slots: sampleSlots, runId: 'run-123' });

    assert.deepEqual(rows, [
      {
        team_id: 'team-1',
        slot_id: 'slot-1::early',
        base_slot_id: 'slot-1',
        season_phase_id: 'early',
        effective_from: '2024-08-01',
        effective_until: '2024-09-15',
        effective_date_range: '[2024-08-01,2024-09-15]',
        source: 'manual',
        run_id: 'run-123',
      },
      {
        team_id: 'team-2',
        slot_id: 'slot-1::late',
        base_slot_id: 'slot-1',
        season_phase_id: 'late',
        effective_from: '2024-09-16',
        effective_until: '2024-10-31',
        effective_date_range: '[2024-09-16,2024-10-31]',
        source: 'auto',
        run_id: 'run-123',
      },
    ]);
  });

  it('fails when slot metadata is missing', () => {
    assert.throws(
      () =>
        buildPracticeAssignmentRows({
          assignments: [{ teamId: 'team-1', slotId: 'slot-unknown' }],
          slots: sampleSlots,
        }),
      /unknown slotId/i,
    );

    assert.throws(
      () =>
        buildPracticeAssignmentRows({
          assignments: [{ teamId: 'team-1', slotId: 'slot-1::early' }],
          slots: [{ id: 'slot-1::early' }],
        }),
      /requires effectiveFrom and effectiveUntil/i,
    );
  });
});
