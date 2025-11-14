import assert from 'node:assert/strict';
import { test } from 'node:test';

import { schedulePractices } from '../src/practiceScheduling.js';

function createSlot({ id, day, startHour, endHour, capacity = 1 }) {
  const start = new Date(`2024-08-05T${String(startHour).padStart(2, '0')}:00:00.000Z`);
  const end = new Date(`2024-08-05T${String(endHour).padStart(2, '0')}:00:00.000Z`);
  return { id, day, start, end, capacity };
}

test('assigns teams to available slots without exceeding capacity', () => {
  const teams = [
    { id: 'T1', division: 'U10', coachId: 'c1' },
    { id: 'T2', division: 'U10', coachId: 'c2' },
    { id: 'T3', division: 'U10', coachId: 'c3' },
  ];

  const slots = [
    createSlot({ id: 's1', day: 'Mon', startHour: 22, endHour: 23, capacity: 2 }),
    createSlot({ id: 's2', day: 'Tue', startHour: 22, endHour: 23, capacity: 1 }),
  ];

  const result = schedulePractices({ teams, slots });

  assert.equal(result.assignments.length, 3);
  for (const assignment of result.assignments) {
    assert.equal(assignment.source, 'auto');
  }
  const capacityUsage = new Map();
  for (const assignment of result.assignments) {
    capacityUsage.set(assignment.slotId, (capacityUsage.get(assignment.slotId) ?? 0) + 1);
  }
  assert.equal(capacityUsage.get('s1'), 2);
  assert.equal(capacityUsage.get('s2'), 1);
  assert.deepEqual(result.unassigned, []);
});

test('avoids overlapping slots for the same coach', () => {
  const teams = [
    { id: 'T1', division: 'U10', coachId: 'coach-shared' },
    { id: 'T2', division: 'U10', coachId: 'coach-shared' },
  ];

  const slots = [
    createSlot({ id: 'early', day: 'Mon', startHour: 21, endHour: 22, capacity: 1 }),
    createSlot({ id: 'late', day: 'Mon', startHour: 22, endHour: 23, capacity: 1 }),
  ];

  const result = schedulePractices({ teams, slots });

  assert.equal(result.assignments.length, 2);
  const assignedSlotIds = new Set(result.assignments.map((a) => a.slotId));
  assert.deepEqual(assignedSlotIds, new Set(['early', 'late']));
  for (const assignment of result.assignments) {
    assert.equal(assignment.source, 'auto');
  }
});

test('prioritises preferred slots for coaches and divisions', () => {
  const teams = [
    { id: 'T1', division: 'U12', coachId: 'coach-a' },
    { id: 'T2', division: 'U12', coachId: 'coach-b' },
  ];

  const slots = [
    createSlot({ id: 'mon', day: 'Mon', startHour: 21, endHour: 22, capacity: 1 }),
    createSlot({ id: 'wed', day: 'Wed', startHour: 21, endHour: 22, capacity: 1 }),
  ];

  const result = schedulePractices({
    teams,
    slots,
    coachPreferences: {
      'coach-a': { preferredSlotIds: ['wed'] },
    },
    divisionPreferences: {
      U12: { preferredDays: ['Wed'] },
    },
  });

  const assignmentMap = Object.fromEntries(result.assignments.map((a) => [a.teamId, a.slotId]));
  assert.equal(assignmentMap.T1, 'wed');
  assert.equal(assignmentMap.T2, 'mon');
  for (const assignment of result.assignments) {
    assert.equal(assignment.source, 'auto');
  }
});

test('flags teams when no slots satisfy constraints', () => {
  const teams = [{ id: 'T1', division: 'U10', coachId: 'coach-a' }];
  const slots = [createSlot({ id: 's1', day: 'Mon', startHour: 21, endHour: 22, capacity: 0 })];

  const result = schedulePractices({
    teams,
    slots,
    coachPreferences: {
      'coach-a': { unavailableSlotIds: ['s1'] },
    },
  });

  assert.equal(result.assignments.length, 0);
  assert.equal(result.unassigned.length, 1);
  assert.equal(result.unassigned[0].teamId, 'T1');
  assert.equal(result.unassigned[0].reason, 'no available slots meeting hard constraints');
});

test('breaks ties by earliest start time then slot id', () => {
  const teams = [{ id: 'T1', division: 'U10', coachId: 'coach-a' }];
  const slots = [
    createSlot({ id: 'slot-b', day: 'Mon', startHour: 20, endHour: 21, capacity: 1 }),
    createSlot({ id: 'slot-a', day: 'Mon', startHour: 20, endHour: 21, capacity: 1 }),
    createSlot({ id: 'slot-early', day: 'Mon', startHour: 19, endHour: 20, capacity: 1 }),
  ];

  const result = schedulePractices({ teams, slots });

  assert.equal(result.assignments.length, 1);
  assert.equal(result.assignments[0].slotId, 'slot-early');
  assert.equal(result.assignments[0].source, 'auto');

  const remainingCapacity = Object.fromEntries(slots.map((slot) => [slot.id, slot.capacity]));
  for (const assignment of result.assignments) {
    remainingCapacity[assignment.slotId] -= 1;
  }

  assert.equal(remainingCapacity['slot-early'], 0);
  assert.equal(remainingCapacity['slot-a'], 1);
  assert.equal(remainingCapacity['slot-b'], 1);

  const tieResult = schedulePractices({
    teams,
    slots: [
      createSlot({ id: 'slot-b', day: 'Mon', startHour: 20, endHour: 21, capacity: 1 }),
      createSlot({ id: 'slot-a', day: 'Mon', startHour: 20, endHour: 21, capacity: 1 }),
    ],
  });

  assert.equal(tieResult.assignments[0].slotId, 'slot-a');
  assert.equal(tieResult.assignments[0].source, 'auto');
});

test('respects locked assignments and prevents conflicting reassignments', () => {
  const teams = [
    { id: 'T1', division: 'U10', coachId: 'coach-shared' },
    { id: 'T2', division: 'U10', coachId: 'coach-shared' },
    { id: 'T3', division: 'U10', coachId: 'coach-other' },
  ];

  const slots = [
    {
      id: 'mon-early',
      day: 'Mon',
      start: new Date('2024-08-05T19:00:00.000Z'),
      end: new Date('2024-08-05T20:00:00.000Z'),
      capacity: 1,
    },
    {
      id: 'mon-late',
      day: 'Mon',
      start: new Date('2024-08-05T20:00:00.000Z'),
      end: new Date('2024-08-05T21:00:00.000Z'),
      capacity: 1,
    },
    {
      id: 'tue',
      day: 'Tue',
      start: new Date('2024-08-06T19:00:00.000Z'),
      end: new Date('2024-08-06T20:00:00.000Z'),
      capacity: 1,
    },
  ];

  const result = schedulePractices({
    teams,
    slots,
    lockedAssignments: [{ teamId: 'T1', slotId: 'mon-early' }],
  });

  const assignmentMap = new Map(result.assignments.map((entry) => [entry.teamId, entry]));
  assert.equal(assignmentMap.get('T1').slotId, 'mon-early');
  assert.equal(assignmentMap.get('T1').source, 'locked');
  assert.equal(assignmentMap.get('T2').source, 'auto');
  assert.equal(assignmentMap.get('T3').source, 'auto');

  assert.notEqual(assignmentMap.get('T2').slotId, 'mon-early');
  assert.equal(result.unassigned.length, 0);
});
