import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPracticeSlotsFromSupabaseRows } from '../src/practiceSupabase.js';

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

  it('requires required fields', () => {
    assert.throws(() => buildPracticeSlotsFromSupabaseRows('nope'));
    assert.throws(() => buildPracticeSlotsFromSupabaseRows([null]));
    assert.throws(() => buildPracticeSlotsFromSupabaseRows([{}]));
  });
});
