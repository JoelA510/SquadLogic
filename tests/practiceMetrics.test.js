import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePracticeSchedule } from '../src/practiceMetrics.js';

const SAMPLE_SLOTS = [
  {
    id: 'slot-early-mon',
    baseSlotId: 'field-a-mon',
    capacity: 2,
    start: '2024-08-05T17:00:00Z',
    end: '2024-08-05T18:00:00Z',
    day: 'Mon',
  },
  {
    id: 'slot-late-mon',
    baseSlotId: 'field-a-mon',
    capacity: 1,
    start: '2024-08-05T17:30:00Z',
    end: '2024-08-05T18:30:00Z',
    day: 'Mon',
  },
  {
    id: 'slot-wed',
    baseSlotId: 'field-b-wed',
    capacity: 1,
    start: '2024-08-07T18:30:00Z',
    end: '2024-08-07T19:30:00Z',
    day: 'Wed',
  },
];

const SAMPLE_TEAMS = [
  { id: 'team-1', division: 'U10', coachId: 'coach-a' },
  { id: 'team-2', division: 'U10', coachId: 'coach-b' },
  { id: 'team-3', division: 'U12', coachId: 'coach-a' },
  { id: 'team-4', division: 'U12', coachId: null },
];

test('evaluatePracticeSchedule summarises utilization and division distribution', () => {
  const report = evaluatePracticeSchedule({
    assignments: [
      { teamId: 'team-1', slotId: 'slot-early-mon' },
      { teamId: 'team-2', slotId: 'slot-early-mon' },
      { teamId: 'team-3', slotId: 'slot-wed' },
    ],
    unassigned: [{ teamId: 'team-4', reason: 'no capacity' }],
    teams: SAMPLE_TEAMS,
    slots: SAMPLE_SLOTS,
  });

  assert.deepEqual(report.summary, {
    totalTeams: 4,
    assignedTeams: 3,
    unassignedTeams: 1,
    assignmentRate: 0.75,
  });

  assert.equal(report.slotUtilization.length, 3);
  const [earlyMon, lateMon, wed] = report.slotUtilization;
  assert.deepEqual(earlyMon, {
    slotId: 'slot-early-mon',
    assignedCount: 2,
    capacity: 2,
    utilization: 1,
    overbooked: false,
  });
  assert.deepEqual(lateMon, {
    slotId: 'slot-late-mon',
    assignedCount: 0,
    capacity: 1,
    utilization: 0,
    overbooked: false,
  });
  assert.deepEqual(wed, {
    slotId: 'slot-wed',
    assignedCount: 1,
    capacity: 1,
    utilization: 1,
    overbooked: false,
  });

  assert.deepEqual(report.divisionDayDistribution, {
    U10: {
      totalAssigned: 2,
      averageStartMinutes: 1020,
      dayBreakdown: [
        { day: 'Mon', count: 2, percentage: 1 },
      ],
    },
    U12: {
      totalAssigned: 1,
      averageStartMinutes: 1110,
      dayBreakdown: [
        { day: 'Wed', count: 1, percentage: 1 },
      ],
    },
  });

  assert.equal(report.baseSlotDistribution.length, 2);
  const [fieldAMon, fieldBWed] = report.baseSlotDistribution;

  assert.deepEqual(fieldAMon, {
    baseSlotId: 'field-a-mon',
    day: 'Mon',
    representativeStart: '2024-08-05T17:00:00.000Z',
    totalAssigned: 2,
    totalCapacity: 3,
    utilization: 0.6667,
    divisionBreakdown: [
      { division: 'U10', count: 2, percentage: 1 },
    ],
  });

  assert.deepEqual(fieldBWed, {
    baseSlotId: 'field-b-wed',
    day: 'Wed',
    representativeStart: '2024-08-07T18:30:00.000Z',
    totalAssigned: 1,
    totalCapacity: 1,
    utilization: 1,
    divisionBreakdown: [
      { division: 'U12', count: 1, percentage: 1 },
    ],
  });
});

test('evaluatePracticeSchedule flags coach conflicts', () => {
  const report = evaluatePracticeSchedule({
    assignments: [
      { teamId: 'team-1', slotId: 'slot-early-mon' },
      { teamId: 'team-3', slotId: 'slot-late-mon' },
    ],
    teams: SAMPLE_TEAMS,
    slots: SAMPLE_SLOTS,
  });

  assert.equal(report.coachConflicts.length, 1);
  assert.deepEqual(report.coachConflicts[0], {
    coachId: 'coach-a',
    teams: [
      { teamId: 'team-1', slotId: 'slot-early-mon' },
      { teamId: 'team-3', slotId: 'slot-late-mon' },
    ],
    reason: 'overlapping slots',
  });

  assert.deepEqual(report.coachLoad, {
    'coach-a': { assignedTeams: 2, distinctDays: 1 },
  });
});

test('evaluatePracticeSchedule emits warnings for inconsistent data', () => {
  const report = evaluatePracticeSchedule({
    assignments: [
      { teamId: 'unknown-team', slotId: 'slot-early-mon' },
      { teamId: 'team-2', slotId: 'unknown-slot' },
      { teamId: 'team-1', slotId: 'slot-early-mon' },
      { teamId: 'team-1', slotId: 'slot-early-mon' },
    ],
    teams: SAMPLE_TEAMS,
    slots: SAMPLE_SLOTS,
  });

  assert.equal(report.summary.assignedTeams, 1);
  assert.equal(report.dataQualityWarnings.length, 3);
  assert(report.dataQualityWarnings[0].includes('unknown team'));
  assert(report.dataQualityWarnings[1].includes('unknown slot'));
  assert(report.dataQualityWarnings[2].includes('duplicate assignment'));
});

test('evaluatePracticeSchedule correctly counts teams assigned to multiple slots', () => {
  const report = evaluatePracticeSchedule({
    assignments: [
      { teamId: 'team-1', slotId: 'slot-early-mon' },
      { teamId: 'team-1', slotId: 'slot-wed' },
    ],
    teams: SAMPLE_TEAMS,
    slots: SAMPLE_SLOTS,
  });

  assert.deepEqual(report.summary, {
    totalTeams: 4,
    assignedTeams: 1,
    unassignedTeams: 3,
    assignmentRate: 0.25,
  });
});
