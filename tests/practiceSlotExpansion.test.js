import assert from 'node:assert/strict';
import { test } from 'node:test';

import { expandPracticeSlotsForSeason } from '../src/practiceSlotExpansion.js';

function createPhase(id, startDate, endDate) {
  return { id, startDate, endDate };
}

test('splits slots across season phases while preserving metadata', () => {
  const slots = [
    {
      id: 'slot-1',
      day: 'Monday',
      start: '2024-08-05T19:00:00.000Z',
      end: '2024-08-05T20:00:00.000Z',
      capacity: 2,
      fieldId: 'field-a',
    },
  ];
  const seasonPhases = [createPhase('early', '2024-08-01', '2024-09-15'), createPhase('late', '2024-09-16', '2024-10-31')];

  const expanded = expandPracticeSlotsForSeason({ slots, seasonPhases });

  assert.equal(expanded.length, 2);
  assert.deepEqual(
    expanded.map((slot) => ({ id: slot.id, baseSlotId: slot.baseSlotId, phase: slot.seasonPhaseId, day: slot.day })),
    [
      { id: 'slot-1::early', baseSlotId: 'slot-1', phase: 'early', day: 'Mon' },
      { id: 'slot-1::late', baseSlotId: 'slot-1', phase: 'late', day: 'Mon' },
    ],
  );

  assert.equal(expanded[0].fieldId, 'field-a');
  assert.equal(expanded[0].capacity, 2);
  assert.equal(expanded[0].effectiveFrom, '2024-08-01');
  assert.equal(expanded[0].effectiveUntil, '2024-09-15');
  assert.equal(expanded[1].effectiveFrom, '2024-09-16');
  assert.equal(expanded[1].effectiveUntil, '2024-10-31');

  assert.equal(new Date(expanded[0].start).getUTCHours(), 19);
  assert.equal(new Date(expanded[0].end).getUTCHours(), 20);
  assert.equal(new Date(expanded[1].start).toISOString(), '2024-09-16T19:00:00.000Z');
});

test('respects validity boundaries and omits phases without overlap', () => {
  const slots = [
    {
      id: 'slot-2',
      day: 'Tue',
      start: '2024-08-06T18:00:00.000Z',
      end: '2024-08-06T19:30:00.000Z',
      capacity: 1,
      validFrom: '2024-08-10',
      validUntil: '2024-09-10',
    },
  ];
  const seasonPhases = [createPhase('early', '2024-08-01', '2024-09-15'), createPhase('late', '2024-09-16', '2024-10-31')];

  const expanded = expandPracticeSlotsForSeason({ slots, seasonPhases });

  assert.equal(expanded.length, 1);
  assert.equal(expanded[0].id, 'slot-2::early');
  assert.equal(expanded[0].effectiveFrom, '2024-08-10');
  assert.equal(expanded[0].effectiveUntil, '2024-09-10');

  // Start should align to first Tuesday on/after 2024-08-10.
  assert.equal(new Date(expanded[0].start).toISOString(), '2024-08-13T18:00:00.000Z');
  assert.equal(new Date(expanded[0].end).toISOString(), '2024-08-13T19:30:00.000Z');
});

test('applies phase-specific overrides for time, duration, and capacity', () => {
  const slots = [
    {
      id: 'slot-3',
      day: 'Wed',
      start: '19:00',
      durationMinutes: 60,
      capacity: 2,
      seasonOverrides: {
        default: { durationMinutes: 50 },
        late: { startTime: '18:30', durationMinutes: 45, capacity: 1 },
      },
    },
  ];
  const seasonPhases = [createPhase('early', '2024-08-01', '2024-09-15'), createPhase('late', '2024-09-16', '2024-10-31')];

  const expanded = expandPracticeSlotsForSeason({ slots, seasonPhases });

  assert.equal(expanded.length, 2);
  const early = expanded.find((slot) => slot.seasonPhaseId === 'early');
  const late = expanded.find((slot) => slot.seasonPhaseId === 'late');

  assert.ok(early);
  assert.ok(late);

  assert.equal(new Date(early.start).toISOString(), '2024-08-07T19:00:00.000Z');
  assert.equal(new Date(early.end).toISOString(), '2024-08-07T19:50:00.000Z');
  assert.equal(early.capacity, 2);

  assert.equal(new Date(late.start).toISOString(), '2024-09-18T18:30:00.000Z');
  assert.equal(new Date(late.end).toISOString(), '2024-09-18T19:15:00.000Z');
  assert.equal(late.capacity, 1);
});

test('throws when overrides create invalid time ranges', () => {
  const slots = [
    {
      id: 'slot-4',
      day: 'Thu',
      start: '18:00',
      durationMinutes: 60,
      capacity: 1,
      seasonOverrides: {
        late: { startTime: '19:00', durationMinutes: 0 },
      },
    },
  ];
  const seasonPhases = [createPhase('late', '2024-09-16', '2024-10-31')];

  assert.throws(() => expandPracticeSlotsForSeason({ slots, seasonPhases }), /durationMinutes must be positive/);
});

test('normalizes varied day inputs via map lookup', () => {
  const slots = [
    {
      id: 'slot-6',
      day: 'sun',
      start: '18:00',
      end: '19:00',
      capacity: 1,
    },
    {
      id: 'slot-7',
      day: 'SATURDAY',
      start: '09:00',
      end: '10:30',
      capacity: 2,
    },
  ];
  const seasonPhases = [createPhase('main', '2024-08-01', '2024-09-30')];

  const expanded = expandPracticeSlotsForSeason({ slots, seasonPhases });

  const dayMap = new Map(expanded.map((slot) => [slot.baseSlotId, slot.day]));
  assert.equal(dayMap.get('slot-6'), 'Sun');
  assert.equal(dayMap.get('slot-7'), 'Sat');
});

test('override endTime takes precedence over durationMinutes', () => {
  const slots = [
    {
      id: 'slot-8',
      day: 'Fri',
      start: '18:00',
      end: '19:30',
      capacity: 1,
      seasonOverrides: {
        late: { startTime: '18:15', endTime: '20:00', durationMinutes: 30 },
      },
    },
  ];
  const seasonPhases = [createPhase('late', '2024-09-01', '2024-10-31')];

  const [expanded] = expandPracticeSlotsForSeason({ slots, seasonPhases });

  assert.equal(expanded.seasonPhaseId, 'late');
  assert.equal(new Date(expanded.start).toISOString(), '2024-09-06T18:15:00.000Z');
  assert.equal(new Date(expanded.end).toISOString(), '2024-09-06T20:00:00.000Z');
});

test('throws for invalid day names', () => {
  const slots = [
    {
      id: 'slot-5',
      day: 'Funday',
      start: '18:00',
      end: '19:00',
      capacity: 1,
    },
  ];
  const seasonPhases = [createPhase('early', '2024-08-01', '2024-09-15')];

  assert.throws(() => expandPracticeSlotsForSeason({ slots, seasonPhases }), /unrecognised day value/);
});
