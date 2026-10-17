import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  conflictPairKey,
  evaluatePracticeSchedule,
  MANUAL_FOLLOW_UP_CATEGORIES,
} from '../packages/core/src/practiceMetrics.js';
import {
  DATED_VECTORS,
  EXCEPTION_VECTORS,
  datedProjection,
  overbookedOf,
  undatedInputs,
} from './helpers/datedScoringVectors.js';
import { buildPracticeRunResults } from '../packages/core/src/utils/practiceRunResults.js';

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
    schoolDayEnd: '16:00',
    timezone: 'UTC',
  });

  // Three rostered teams hold a slot and three assignments were read: the two
  // numbers coincide here and deliberately do not in the multi-slot case below.
  assert.deepEqual(report.summary, {
    totalTeams: 4,
    assignedTeams: 3,
    unassignedTeams: 1,
    assignmentsRead: 3,
    assignmentsCounted: 3,
    assignmentRate: 0.75,
    manualFollowUpRate: 0.25,
    dateModel: 'undated',
  });

  assert.deepEqual(report.manualFollowUpBreakdown, [
    {
      category: MANUAL_FOLLOW_UP_CATEGORIES.CAPACITY,
      count: 1,
      percentage: 1,
      teamIds: ['team-4'],
      reasons: ['no capacity'],
    },
  ]);

  assert.equal(report.dataQualityWarnings.length, 0);

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
      dayBreakdown: [{ day: 'Mon', count: 2, percentage: 1 }],
    },
    U12: {
      totalAssigned: 1,
      averageStartMinutes: 1110,
      dayBreakdown: [{ day: 'Wed', count: 1, percentage: 1 }],
    },
  });

  assert.deepEqual(report.divisionBaseSlotDistribution, {
    U10: {
      totalAssigned: 2,
      baseSlots: [{ baseSlotId: 'field-a-mon', count: 2, percentage: 1 }],
    },
    U12: {
      totalAssigned: 1,
      baseSlots: [{ baseSlotId: 'field-b-wed', count: 1, percentage: 1 }],
    },
  });

  assert.deepEqual(report.dayConcentrationAlerts, []);

  assert.equal(report.baseSlotDistribution.length, 2);
  const [fieldAMon, fieldBWed] = report.baseSlotDistribution;

  assert.deepEqual(fieldAMon, {
    baseSlotId: 'field-a-mon',
    day: 'Mon',
    representativeStart: '2024-08-05T17:00:00.000Z',
    totalAssigned: 2,
    totalCapacity: 3,
    utilization: 0.6667,
    divisionBreakdown: [{ division: 'U10', count: 2, percentage: 1 }],
  });

  assert.deepEqual(fieldBWed, {
    baseSlotId: 'field-b-wed',
    day: 'Wed',
    representativeStart: '2024-08-07T18:30:00.000Z',
    totalAssigned: 1,
    totalCapacity: 1,
    utilization: 1,
    divisionBreakdown: [{ division: 'U12', count: 1, percentage: 1 }],
  });

  assert.equal(report.fairnessConcerns.length, 1);
  assert.deepEqual(report.fairnessConcerns[0], {
    baseSlotId: 'field-a-mon',
    day: 'Mon',
    representativeStart: '2024-08-05T17:00:00.000Z',
    dominantDivision: 'U10',
    dominantShare: 1,
    totalAssigned: 2,
    totalCapacity: 3,
    message: 'Base slot field-a-mon is 100% filled by division U10 (2/2 assignments)',
  });

  assert.deepEqual(report.unassignedByReason, [
    {
      reason: 'no capacity',
      count: 1,
      teamIds: ['team-4'],
      divisionBreakdown: [{ division: 'U12', count: 1, percentage: 1 }],
    },
  ]);
});

test('manual follow-up reasons aggregate unknown teams and default reasons', () => {
  const slots = [
    {
      id: 'slot-a',
      baseSlotId: 'field-a',
      capacity: 1,
      start: '2024-08-05T22:00:00Z',
      end: '2024-08-05T23:00:00Z',
      day: 'Mon',
    },
  ];

  const teams = [{ id: 'team-known', division: 'U10', coachId: null }];

  const report = evaluatePracticeSchedule({
    assignments: [],
    teams,
    slots,
    unassigned: [
      { teamId: 'team-known', reason: '' },
      { teamId: 'team-unknown', reason: 'no coach availability' },
    ],
    schoolDayEnd: '16:00',
    timezone: 'UTC',
  });

  assert.equal(report.summary.unassignedTeams, 1);
  assert.deepEqual(report.unassignedByReason, [
    {
      reason: 'no coach availability',
      count: 1,
      teamIds: ['team-unknown'],
      divisionBreakdown: [],
    },
    {
      reason: 'unspecified',
      count: 1,
      teamIds: ['team-known'],
      divisionBreakdown: [{ division: 'U10', count: 1, percentage: 1 }],
    },
  ]);

  assert.ok(report.dataQualityWarnings.some((warning) => warning.includes('team-unknown')));
});

test('identifies divisions stacked on a single practice day', () => {
  const slots = [
    {
      id: 'slot-tue-1',
      baseSlotId: 'field-a-tue',
      capacity: 2,
      start: '2024-08-06T17:00:00Z',
      end: '2024-08-06T18:00:00Z',
      day: 'Tue',
    },
    {
      id: 'slot-tue-2',
      baseSlotId: 'field-b-tue',
      capacity: 2,
      start: '2024-08-06T18:00:00Z',
      end: '2024-08-06T19:00:00Z',
      day: 'Tue',
    },
    {
      id: 'slot-thu',
      baseSlotId: 'field-c-thu',
      capacity: 2,
      start: '2024-08-08T17:30:00Z',
      end: '2024-08-08T18:30:00Z',
      day: 'Thu',
    },
  ];

  const teams = [
    { id: 'u12-team-1', division: 'U12', coachId: 'coach-1' },
    { id: 'u12-team-2', division: 'U12', coachId: 'coach-2' },
    { id: 'u12-team-3', division: 'U12', coachId: 'coach-3' },
    { id: 'u12-team-4', division: 'U12', coachId: 'coach-4' },
    { id: 'u12-team-5', division: 'U12', coachId: 'coach-5' },
  ];

  const report = evaluatePracticeSchedule({
    assignments: [
      { teamId: 'u12-team-1', slotId: 'slot-tue-1' },
      { teamId: 'u12-team-2', slotId: 'slot-tue-1' },
      { teamId: 'u12-team-3', slotId: 'slot-tue-2' },
      { teamId: 'u12-team-4', slotId: 'slot-tue-2' },
      { teamId: 'u12-team-5', slotId: 'slot-thu' },
    ],
    teams,
    slots,
    schoolDayEnd: '16:00',
    timezone: 'UTC',
  });

  assert.deepEqual(report.dayConcentrationAlerts, [
    {
      division: 'U12',
      dominantDay: 'Tue',
      dominantShare: 0.8,
      dominantCount: 4,
      totalAssignments: 5,
    },
  ]);
});

test('base slot metadata day matches earliest representative even when null', () => {
  const slots = [
    {
      id: 'slot-null-day-earliest',
      baseSlotId: 'shared-base-null-earliest',
      capacity: 1,
      start: '2024-08-08T17:00:00Z',
      end: '2024-08-08T18:00:00Z',
    },
    {
      id: 'slot-with-day-later',
      baseSlotId: 'shared-base-null-earliest',
      capacity: 1,
      start: '2024-08-08T18:00:00Z',
      end: '2024-08-08T19:00:00Z',
      day: 'Thu',
    },
  ];

  const report = evaluatePracticeSchedule({
    assignments: [],
    teams: [],
    slots,
    schoolDayEnd: '16:00',
    timezone: 'UTC',
  });

  assert.equal(report.baseSlotDistribution.length, 1);
  assert.deepEqual(report.baseSlotDistribution[0], {
    baseSlotId: 'shared-base-null-earliest',
    day: null,
    representativeStart: '2024-08-08T17:00:00.000Z',
    totalAssigned: 0,
    totalCapacity: 2,
    utilization: 0,
    divisionBreakdown: [],
  });
  assert.deepEqual(report.fairnessConcerns, []);
});

test('base slot metadata day follows earliest slot when defined', () => {
  const slots = [
    {
      id: 'slot-with-day-earliest',
      baseSlotId: 'shared-base-with-day',
      capacity: 1,
      start: '2024-08-09T17:00:00Z',
      end: '2024-08-09T18:00:00Z',
      day: 'Fri',
    },
    {
      id: 'slot-later-null-day',
      baseSlotId: 'shared-base-with-day',
      capacity: 1,
      start: '2024-08-09T19:00:00Z',
      end: '2024-08-09T20:00:00Z',
    },
  ];

  const report = evaluatePracticeSchedule({
    assignments: [],
    teams: [],
    slots,
    schoolDayEnd: '16:00',
    timezone: 'UTC',
  });

  assert.equal(report.baseSlotDistribution.length, 1);
  assert.deepEqual(report.baseSlotDistribution[0], {
    baseSlotId: 'shared-base-with-day',
    day: 'Fri',
    representativeStart: '2024-08-09T17:00:00.000Z',
    totalAssigned: 0,
    totalCapacity: 2,
    utilization: 0,
    divisionBreakdown: [],
  });
  assert.deepEqual(report.fairnessConcerns, []);
});

test('evaluatePracticeSchedule flags coach conflicts', () => {
  const report = evaluatePracticeSchedule({
    assignments: [
      { teamId: 'team-1', slotId: 'slot-early-mon' },
      { teamId: 'team-3', slotId: 'slot-late-mon' },
    ],
    teams: SAMPLE_TEAMS,
    slots: SAMPLE_SLOTS,
    schoolDayEnd: '16:00',
    timezone: 'UTC',
  });

  assert.equal(report.coachConflicts.length, 1);
  assert.deepEqual(report.coachConflicts[0], {
    coachId: 'coach-a',
    coachIds: ['coach-a'],
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

test('manual follow-up alert messaging is handled in the evaluation pipeline', () => {
  const slots = [
    {
      id: 'slot-1',
      capacity: 10,
      start: '2024-08-05T17:00:00Z',
      end: '2024-08-05T18:00:00Z',
      day: 'Mon',
    },
  ];

  const teams = Array.from({ length: 20 }, (_, index) => ({
    id: `team-${index + 1}`,
    division: 'U10',
  }));

  const atThreshold = evaluatePracticeSchedule({
    assignments: teams.slice(0, 19).map((team) => ({
      teamId: team.id,
      slotId: 'slot-1',
    })),
    unassigned: [{ teamId: teams[19].id, reason: 'no capacity' }],
    teams,
    slots,
    schoolDayEnd: '16:00',
    timezone: 'UTC',
  });

  assert.equal(atThreshold.summary.manualFollowUpRate, 0.05);
  assert.ok(atThreshold.dataQualityWarnings.length === 0);

  const aboveThreshold = evaluatePracticeSchedule({
    assignments: teams.slice(0, 18).map((team) => ({
      teamId: team.id,
      slotId: 'slot-1',
    })),
    unassigned: teams.slice(18).map((team) => ({
      teamId: team.id,
      reason: 'no capacity',
    })),
    teams,
    slots,
    schoolDayEnd: '16:00',
    timezone: 'UTC',
  });

  assert.equal(aboveThreshold.summary.manualFollowUpRate, 0.1);
  assert.ok(aboveThreshold.dataQualityWarnings.length === 0);
  assert.deepEqual(
    aboveThreshold.manualFollowUpBreakdown.map((bucket) => ({
      category: bucket.category,
      count: bucket.count,
      teamIds: bucket.teamIds,
    })),
    [{ category: 'capacity', count: 2, teamIds: ['team-19', 'team-20'] }]
  );
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
    schoolDayEnd: '16:00',
    timezone: 'UTC',
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
    schoolDayEnd: '16:00',
    timezone: 'UTC',
  });

  // One team, two assignments — the whole reason the report has to say which
  // unit each number is in.
  assert.deepEqual(report.summary, {
    totalTeams: 4,
    assignedTeams: 1,
    unassignedTeams: 3,
    assignmentsRead: 2,
    assignmentsCounted: 2,
    assignmentRate: 0.25,
    manualFollowUpRate: 0.75,
    dateModel: 'undated',
  });
  assert.deepEqual(report.fairnessConcerns, []);
});

test('flags fairness concerns when a base slot is dominated by one division', () => {
  const slots = [
    {
      id: 'field-a-early',
      baseSlotId: 'field-a',
      capacity: 2,
      start: '2024-08-06T21:00:00Z',
      end: '2024-08-06T22:00:00Z',
      day: 'Tue',
    },
    {
      id: 'field-a-late',
      baseSlotId: 'field-a',
      capacity: 2,
      start: '2024-08-06T22:00:00Z',
      end: '2024-08-06T23:00:00Z',
      day: 'Tue',
    },
    {
      id: 'field-b',
      baseSlotId: 'field-b',
      capacity: 1,
      start: '2024-08-07T21:00:00Z',
      end: '2024-08-07T22:00:00Z',
      day: 'Wed',
    },
  ];

  const teams = [
    { id: 'team-a', division: 'U10', coachId: 'coach-1' },
    { id: 'team-b', division: 'U10', coachId: 'coach-2' },
    { id: 'team-c', division: 'U10', coachId: 'coach-3' },
    { id: 'team-d', division: 'U12', coachId: 'coach-4' },
    { id: 'team-e', division: 'U12', coachId: 'coach-5' },
  ];

  const report = evaluatePracticeSchedule({
    assignments: [
      { teamId: 'team-a', slotId: 'field-a-early' },
      { teamId: 'team-b', slotId: 'field-a-early' },
      { teamId: 'team-c', slotId: 'field-a-late' },
      { teamId: 'team-d', slotId: 'field-a-late' },
      { teamId: 'team-e', slotId: 'field-b' },
    ],
    teams,
    slots,
    schoolDayEnd: '16:00',
    timezone: 'UTC',
  });

  assert.equal(report.fairnessConcerns.length, 1);
  assert.deepEqual(report.fairnessConcerns[0], {
    baseSlotId: 'field-a',
    day: 'Tue',
    representativeStart: '2024-08-06T21:00:00.000Z',
    dominantDivision: 'U10',
    dominantShare: 0.75,
    totalAssigned: 4,
    totalCapacity: 4,
    message: 'Base slot field-a is 75% filled by division U10 (3/4 assignments)',
  });
});

test('flags underutilized base slots for follow-up', () => {
  const slots = [
    {
      id: 'slot-high-capacity',
      baseSlotId: 'field-wide',
      capacity: 5,
      start: '2024-08-05T22:00:00Z',
      end: '2024-08-05T23:00:00Z',
      day: 'Mon',
    },
    {
      id: 'slot-balanced',
      baseSlotId: 'field-balanced',
      capacity: 1,
      start: '2024-08-06T22:00:00Z',
      end: '2024-08-06T23:00:00Z',
      day: 'Tue',
    },
  ];

  const teams = [
    { id: 'team-a', division: 'U10', coachId: null },
    { id: 'team-b', division: 'U10', coachId: null },
  ];

  const report = evaluatePracticeSchedule({
    assignments: [
      { teamId: 'team-a', slotId: 'slot-high-capacity' },
      { teamId: 'team-b', slotId: 'slot-balanced' },
    ],
    teams,
    slots,
    schoolDayEnd: '16:00',
    timezone: 'UTC',
  });

  assert.equal(report.underutilizedBaseSlots.length, 1);
  assert.deepEqual(report.underutilizedBaseSlots[0], {
    baseSlotId: 'field-wide',
    day: 'Mon',
    representativeStart: '2024-08-05T22:00:00.000Z',
    totalAssigned: 1,
    totalCapacity: 5,
    utilization: 0.2,
  });
});

test('categorizes manual follow-ups by capacity, coach availability, and exclusions', () => {
  const slots = [
    {
      id: 'slot-mon',
      capacity: 1,
      start: '2024-08-05T17:00:00Z',
      end: '2024-08-05T18:00:00Z',
      day: 'Mon',
    },
  ];
  const teams = [
    { id: 'team-a', division: 'U10', coachId: 'coach-a' },
    { id: 'team-b', division: 'U10', coachId: 'coach-b' },
    { id: 'team-c', division: 'U12', coachId: 'coach-c' },
    { id: 'team-d', division: 'U12', coachId: 'coach-d' },
  ];

  const report = evaluatePracticeSchedule({
    assignments: [],
    unassigned: [
      { teamId: 'team-a', reason: 'no available capacity' },
      { teamId: 'team-b', reason: 'coach schedule conflicts on all slots' },
      { teamId: 'team-c', reason: 'coach availability excludes all slots' },
      { teamId: 'team-d', reason: 'no alternative slots available' },
    ],
    teams,
    slots,
    schoolDayEnd: '16:00',
    timezone: 'UTC',
  });

  assert.deepEqual(report.manualFollowUpBreakdown, [
    {
      category: MANUAL_FOLLOW_UP_CATEGORIES.COACH_AVAILABILITY,
      count: 2,
      percentage: 0.5,
      teamIds: ['team-b', 'team-c'],
      reasons: ['coach availability excludes all slots', 'coach schedule conflicts on all slots'],
    },
    {
      category: MANUAL_FOLLOW_UP_CATEGORIES.CAPACITY,
      count: 1,
      percentage: 0.25,
      teamIds: ['team-a'],
      reasons: ['no available capacity'],
    },
    {
      category: MANUAL_FOLLOW_UP_CATEGORIES.EXCLUDED_SLOTS,
      count: 1,
      percentage: 0.25,
      teamIds: ['team-d'],
      reasons: ['no alternative slots available'],
    },
  ]);
});

test('handles non-string manual follow-up reasons without throwing', () => {
  const slots = [
    {
      id: 'slot-mon',
      capacity: 1,
      start: '2024-08-05T17:00:00Z',
      end: '2024-08-05T18:00:00Z',
      day: 'Mon',
    },
  ];
  const teams = [
    { id: 'team-a', division: 'U10', coachId: 'coach-a' },
    { id: 'team-b', division: 'U12', coachId: 'coach-b' },
  ];

  const report = evaluatePracticeSchedule({
    assignments: [],
    unassigned: [
      { teamId: 'team-a', reason: 42 },
      { teamId: 'team-b', reason: { note: 'missing info' } },
    ],
    teams,
    slots,
    schoolDayEnd: '16:00',
    timezone: 'UTC',
  });

  assert.deepEqual(report.manualFollowUpBreakdown, [
    {
      category: MANUAL_FOLLOW_UP_CATEGORIES.UNKNOWN,
      count: 2,
      percentage: 1,
      teamIds: ['team-a', 'team-b'],
      reasons: [],
    },
  ]);
});

test('evaluatePracticeSchedule flags school hour violations', () => {
  const timezone = 'America/New_York';
  const schoolDayEnd = '16:00'; // 4:00 PM

  const slots = [
    {
      id: 'slot-early-violation',
      capacity: 1,
      start: '2024-08-05T19:30:00Z', // Mon 3:30 PM ET (Pre-4:00 PM) -> Violated
      end: '2024-08-05T20:30:00Z',
      day: 'Mon',
    },
    {
      id: 'slot-safe',
      capacity: 1,
      start: '2024-08-05T20:30:00Z', // Mon 4:30 PM ET (Post-4:00 PM) -> OK
      end: '2024-08-05T21:30:00Z',
      day: 'Mon',
    },
    {
      id: 'slot-weekend',
      capacity: 1,
      start: '2024-08-10T14:00:00Z', // Sat 10:00 AM ET -> OK (Weekend)
      end: '2024-08-10T15:00:00Z',
      day: 'Sat',
    },
  ];

  const teams = [
    { id: 'team-1', division: 'U10', coachId: null },
    { id: 'team-2', division: 'U10', coachId: null },
    { id: 'team-3', division: 'U10', coachId: null },
  ];

  const report = evaluatePracticeSchedule({
    assignments: [
      { teamId: 'team-1', slotId: 'slot-early-violation' },
      { teamId: 'team-2', slotId: 'slot-safe' },
      { teamId: 'team-3', slotId: 'slot-weekend' },
    ],
    teams,
    slots,
    timezone,
    schoolDayEnd,
  });

  const violationWarnings = report.dataQualityWarnings.filter((w) =>
    w.includes('violates school hours')
  );
  assert.equal(violationWarnings.length, 1);
  assert.match(violationWarnings[0], /team-1/);
  assert.match(violationWarnings[0], /15:30/);
});

// ---------------------------------------------------------------------------
// 8.1 -- the evaluator reports conflicts on every coach a team carries.
// ---------------------------------------------------------------------------

test('evaluatePracticeSchedule flags a conflict on a shared assistant coach', () => {
  // team-2 has no head coach at all, so a head-only evaluator would never see it.
  const teams = [
    { id: 'team-1', division: 'U10', coachId: 'coach-a', assistantCoachIds: ['assistant-x'] },
    { id: 'team-2', division: 'U12', coachId: null, assistantCoachIds: ['assistant-x'] },
  ];

  const report = evaluatePracticeSchedule({
    assignments: [
      { teamId: 'team-1', slotId: 'slot-early-mon' },
      { teamId: 'team-2', slotId: 'slot-late-mon' },
    ],
    teams,
    slots: SAMPLE_SLOTS,
    schoolDayEnd: '16:00',
    timezone: 'UTC',
  });

  assert.deepEqual(report.coachConflicts, [
    {
      coachId: 'assistant-x',
      coachIds: ['assistant-x'],
      teams: [
        { teamId: 'team-1', slotId: 'slot-early-mon' },
        { teamId: 'team-2', slotId: 'slot-late-mon' },
      ],
      reason: 'overlapping slots',
    },
  ]);
  assert.deepEqual(report.coachLoad, {
    'coach-a': { assignedTeams: 1, distinctDays: 1 },
    'assistant-x': { assignedTeams: 2, distinctDays: 1 },
  });
});

test('evaluatePracticeSchedule reads the teams-column spelling assistant_coach_ids', () => {
  const teams = [
    { id: 'team-1', division: 'U10', coachId: 'coach-a', assistant_coach_ids: ['assistant-x'] },
    { id: 'team-2', division: 'U12', coachId: null, assistant_coach_ids: ['assistant-x'] },
  ];

  const report = evaluatePracticeSchedule({
    assignments: [
      { teamId: 'team-1', slotId: 'slot-early-mon' },
      { teamId: 'team-2', slotId: 'slot-late-mon' },
    ],
    teams,
    slots: SAMPLE_SLOTS,
    schoolDayEnd: '16:00',
    timezone: 'UTC',
  });

  assert.equal(report.coachConflicts.length, 1);
  assert.equal(report.coachConflicts[0].coachId, 'assistant-x');
});

test('control: distinct assistants on the same overlapping slots raise no conflict', () => {
  const teams = [
    { id: 'team-1', division: 'U10', coachId: 'coach-a', assistantCoachIds: ['assistant-x'] },
    { id: 'team-2', division: 'U12', coachId: null, assistantCoachIds: ['assistant-y'] },
  ];

  const report = evaluatePracticeSchedule({
    assignments: [
      { teamId: 'team-1', slotId: 'slot-early-mon' },
      { teamId: 'team-2', slotId: 'slot-late-mon' },
    ],
    teams,
    slots: SAMPLE_SLOTS,
    schoolDayEnd: '16:00',
    timezone: 'UTC',
  });

  assert.deepEqual(report.coachConflicts, []);
  assert.deepEqual(report.coachLoad, {
    'coach-a': { assignedTeams: 1, distinctDays: 1 },
    'assistant-x': { assignedTeams: 1, distinctDays: 1 },
    'assistant-y': { assignedTeams: 1, distinctDays: 1 },
  });
});

test('a pair sharing a head coach and an assistant is one conflict naming both coaches', () => {
  const teams = [
    { id: 'team-1', division: 'U10', coachId: 'coach-a', assistantCoachIds: ['assistant-x'] },
    { id: 'team-2', division: 'U12', coachId: 'coach-a', assistantCoachIds: ['assistant-x'] },
  ];

  const report = evaluatePracticeSchedule({
    assignments: [
      { teamId: 'team-1', slotId: 'slot-early-mon' },
      { teamId: 'team-2', slotId: 'slot-late-mon' },
    ],
    teams,
    slots: SAMPLE_SLOTS,
    schoolDayEnd: '16:00',
    timezone: 'UTC',
  });

  assert.deepEqual(report.coachConflicts, [
    {
      coachId: 'coach-a',
      coachIds: ['coach-a', 'assistant-x'],
      teams: [
        { teamId: 'team-1', slotId: 'slot-early-mon' },
        { teamId: 'team-2', slotId: 'slot-late-mon' },
      ],
      reason: 'overlapping slots',
    },
  ]);
  // Each coach's own load is still counted per coach.
  assert.deepEqual(report.coachLoad, {
    'coach-a': { assignedTeams: 2, distinctDays: 1 },
    'assistant-x': { assignedTeams: 2, distinctDays: 1 },
  });
});

test('a coach listed as both head and assistant of one team is counted once and never self-conflicts', () => {
  const report = evaluatePracticeSchedule({
    assignments: [{ teamId: 'team-1', slotId: 'slot-early-mon' }],
    teams: [{ id: 'team-1', division: 'U10', coachId: 'coach-a', assistantCoachIds: ['coach-a'] }],
    slots: SAMPLE_SLOTS,
    schoolDayEnd: '16:00',
    timezone: 'UTC',
  });

  assert.deepEqual(report.coachConflicts, []);
  assert.deepEqual(report.coachLoad, { 'coach-a': { assignedTeams: 1, distinctDays: 1 } });
});

test('conflictPairKey is the same whichever side is named first, and either assignment order merges to one conflict', () => {
  const x = { teamId: 'team-2', slotId: 'slot-late-mon' };
  const y = { teamId: 'team-1', slotId: 'slot-early-mon' };
  assert.equal(conflictPairKey(x, y), conflictPairKey(y, x));
  // Positive control: the un-canonicalised form this replaces does depend on the order, so
  // the assertion above fails against it (proven by substituting it into the source).
  const raw = (p, q) => `${p.teamId}::${p.slotId}::${q.teamId}::${q.slotId}`;
  assert.notEqual(raw(x, y), raw(y, x));

  // Regression guard, not a discriminating control: every coach's list is a subsequence of the
  // same assignment order and is sorted by the same comparator, so today both key forms merge
  // this pair. The guard is structural — it holds the merge correct if that ever stops being so.

  const teams = [
    { id: 'team-1', division: 'U10', coachId: 'coach-a', assistantCoachIds: ['assistant-x'] },
    { id: 'team-2', division: 'U12', coachId: 'coach-a', assistantCoachIds: ['assistant-x'] },
  ];
  const forward = [
    { teamId: 'team-1', slotId: 'slot-early-mon' },
    { teamId: 'team-2', slotId: 'slot-late-mon' },
  ];
  for (const assignments of [forward, [...forward].reverse()]) {
    const report = evaluatePracticeSchedule({
      assignments,
      teams,
      slots: SAMPLE_SLOTS,
      schoolDayEnd: '16:00',
      timezone: 'UTC',
    });
    assert.equal(report.coachConflicts.length, 1);
    assert.deepEqual(report.coachConflicts[0].coachIds, ['coach-a', 'assistant-x']);
  }
});

// ---- M4.7: the dated model (docs/PLAN_SCORING_DATE_MODEL.md §3, §4) ---------
//
// The witnesses are hand-written truths in a JSON both arms read; see
// `tests/helpers/datedScoringVectors.js`. The subject set is the vector table,
// never an engine's output.

const datedCore = (vector) =>
  evaluatePracticeSchedule({
    teams: vector.teams,
    slots: vector.slots,
    assignments: vector.assignments,
    exceptions: vector.exceptions,
    schoolDayEnd: undefined,
    timezone: DATED_VECTORS.timeZone,
  });

test('dated witnesses: the table holds the plan witnesses and cases (meta, can fail)', () => {
  const witnesses = DATED_VECTORS.vectors.map((v) => v.witness);
  for (const w of ['W1', 'W2', 'W2b', 'overlap', 'W3', 'W4', 'W5', 'open', 'unreadable']) {
    assert.ok(witnesses.includes(w), `missing ${w}`);
  }
  for (const w of ['no-live-date', 'dst', 'peak']) assert.ok(witnesses.includes(w), w);
  // A clash is expected somewhere and absent somewhere, so neither "always" nor
  // "never" can pass the table.
  const withConflict = DATED_VECTORS.vectors.filter((v) => v.expected.conflicts.length > 0);
  assert.ok(withConflict.length >= 5);
  assert.ok(DATED_VECTORS.vectors.length - withConflict.length >= 5);
});

test('dated witnesses: each one the first-occurrence comparison gets wrong, or is a control', () => {
  // The defect, executed: on the same inputs with their dates removed, the
  // undated comparison gives the answer recorded as `undated`, and for W1-W4,
  // the overlap, the peak and DST that answer differs from the truth.
  const wrongUndated = [];
  for (const vector of DATED_VECTORS.vectors) {
    const report = evaluatePracticeSchedule({
      ...undatedInputs(vector),
      schoolDayEnd: undefined,
      timezone: 'UTC',
    });
    assert.equal(report.summary.dateModel, 'undated');
    assert.equal(report.coachConflicts.length, vector.undated.conflicts, vector.name);
    assert.deepEqual(overbookedOf(report), vector.undated.overbooked, vector.name);
    const truthOverbooked = Object.entries(vector.expected.slotLoad)
      .filter(([id, [peak]]) => peak > vector.slots.find((s) => s.id === id).capacity)
      .map(([id]) => id)
      .sort();
    if (
      vector.undated.conflicts !== vector.expected.conflicts.length ||
      JSON.stringify(vector.undated.overbooked) !== JSON.stringify(truthOverbooked)
    ) {
      wrongUndated.push(vector.witness);
    }
  }
  for (const w of ['W1', 'W2', 'W3', 'W4', 'dst']) assert.ok(wrongUndated.includes(w), w);
});

for (const vector of DATED_VECTORS.vectors) {
  test(`dated witness ${vector.witness}: ${vector.name}`, () => {
    const report = datedCore(vector);
    assert.equal(report.summary.dateModel, 'dated');
    assert.deepEqual(
      datedProjection(report, report.dataQualityWarnings.length),
      vector.expected,
      vector.name
    );
  });
}

test('dated: a conflict names its first date and count; the message names the date (Q7)', () => {
  const vector = DATED_VECTORS.vectors.find((v) => v.witness === 'W4');
  const [conflict] = datedCore(vector).coachConflicts;
  assert.equal(conflict.firstDate, '2026-09-01');
  assert.equal(conflict.sharedDates, 12);
  assert.match(conflict.reason, /2026-09-01/);
});

test('dated: the unreadable and the dateless rows are each reported by name', () => {
  const unreadable = datedCore(DATED_VECTORS.vectors.find((v) => v.witness === 'unreadable'));
  assert.deepEqual(unreadable.dataQualityWarnings, [
    'assignment for team T1 to slot S1 has an unreadable date range Full Season',
  ]);
  assert.equal(unreadable.summary.assignmentsCounted, 1);
  const dateless = datedCore(DATED_VECTORS.vectors.find((v) => v.witness === 'no-live-date'));
  assert.deepEqual(dateless.dataQualityWarnings, [
    "assignment for team T1 has no date inside slot S1's validity",
  ]);
  assert.equal(dateless.summary.assignmentsCounted, 2);
});

test('dated: a mix of dated and undated slots refuses (Q8)', () => {
  const vector = DATED_VECTORS.vectors.find((v) => v.witness === 'W4');
  const { firstDate: _f, lastDate: _l, ...undatedSlot } = vector.slots[1];
  assert.throws(
    () =>
      evaluatePracticeSchedule({
        ...vector,
        slots: [vector.slots[0], undatedSlot],
        schoolDayEnd: undefined,
        timezone: 'UTC',
      }),
    /must all carry firstDate and lastDate, or none: 1 of 2 do/
  );
  // A dated slot missing its wall window, or ending before it starts, refuses too.
  for (const broken of [
    { ...vector.slots[1], startTime: undefined },
    { ...vector.slots[1], lastDate: '2026-02-30' },
    { ...vector.slots[1], endTime: '15:00:00' },
  ]) {
    assert.throws(
      () =>
        evaluatePracticeSchedule({
          ...vector,
          slots: [vector.slots[0], broken],
          schoolDayEnd: undefined,
          timezone: 'UTC',
        }),
      TypeError
    );
  }
  // Wall times alone do not date a slot: an undated caller sending them is undated.
  const report = evaluatePracticeSchedule({
    ...undatedInputs(vector),
    slots: undatedInputs(vector).slots.map((s) => ({ ...s, startTime: '16:00:00' })),
    schoolDayEnd: undefined,
    timezone: 'UTC',
  });
  assert.equal(report.summary.dateModel, 'undated');
});

// ---- The M4.7 follow-up: saved practice exceptions (plan Q1) --------------
//
// The vectors with `exceptions` run through the dated witnesses above (their
// `expected` carries `timeTbd`); these pin what the table cannot.

test('exception witnesses: relocation and TIME TBD each move a clash and a count (meta, can fail)', () => {
  const witnesses = EXCEPTION_VECTORS.map((v) => v.witness);
  for (const w of [
    'X-relocated-clash',
    'X-relocated-capacity',
    'X-tbd-clash',
    'X-tbd-capacity',
    'X-relocated-missing-slot',
    'X-tbd-open',
    'X-row-unread',
    'X-withdrawn',
  ]) {
    assert.ok(witnesses.includes(w), `missing ${w}`);
  }
  // Each vector's truth differs from the answer with its exceptions left out,
  // except the controls: so an engine that ignores exceptions fails the table.
  const ignored = (vector) =>
    datedProjection(
      evaluatePracticeSchedule({
        teams: vector.teams,
        slots: vector.slots,
        assignments: vector.assignments,
        schoolDayEnd: undefined,
        timezone: 'UTC',
      }),
      0
    );
  const moved = EXCEPTION_VECTORS.filter((v) => {
    const { timeTbd: _t, dataQuality: _d, ...truth } = v.expected;
    const { dataQuality: _x, ...without } = ignored(v);
    return JSON.stringify(truth) !== JSON.stringify(without);
  }).map((v) => v.witness);
  assert.deepEqual(moved.sort(), [
    'X-relocated-capacity',
    'X-relocated-clash',
    'X-tbd-capacity',
    'X-tbd-clash',
    'X-tbd-open',
  ]);
  assert.ok(EXCEPTION_VECTORS.some((v) => v.expected.timeTbd.length > 0));
});

test('exceptions: an exception naming no row of the call is a data-quality line, by name', () => {
  const report = datedCore(EXCEPTION_VECTORS.find((v) => v.witness === 'X-row-unread'));
  assert.deepEqual(report.dataQualityWarnings, [
    'practice exception e1 on assignment a9: PRACTICE_EXCEPTION_ROW_UNREAD',
  ]);
  assert.deepEqual(report.timeTbd, []);
});

test('exceptions: an undated call refuses them, and none sent is not a refusal', () => {
  const vector = EXCEPTION_VECTORS.find((v) => v.witness === 'X-tbd-clash');
  const inputs = { ...undatedInputs(vector), schoolDayEnd: undefined, timezone: 'UTC' };
  assert.throws(
    () => evaluatePracticeSchedule({ ...inputs, exceptions: vector.exceptions }),
    /practice exceptions need a dated call \(every slot with firstDate and lastDate\): 1 sent with undated slots/
  );
  const none = evaluatePracticeSchedule({ ...inputs, exceptions: [] });
  assert.equal(none.summary.dateModel, 'undated');
  assert.equal('timeTbd' in none, false);
  assert.throws(
    // @ts-expect-error [INVALID_INPUT] - not an array, refused at run time.
    () => evaluatePracticeSchedule({ ...inputs, exceptions: 'e1' }),
    /exceptions must be an array/
  );
});

test('exceptions: timeTbd is published only when exceptions are passed', () => {
  const vector = EXCEPTION_VECTORS.find((v) => v.witness === 'X-tbd-clash');
  const { exceptions: _e, ...withoutExceptions } = vector;
  assert.equal('timeTbd' in datedCore(withoutExceptions), false);
  assert.deepEqual(datedCore({ ...vector, exceptions: [] }).timeTbd, []);
});

test('apply-time metrics apply the exceptions they are given, as the panel does (Q9 for Q1)', () => {
  const vector = EXCEPTION_VECTORS.find((v) => v.witness === 'X-tbd-clash');
  const run = (exceptions) =>
    buildPracticeRunResults({
      assignments: vector.assignments,
      teams: vector.teams,
      slots: vector.slots,
      exceptions,
      schoolDayEnd: undefined,
      timezone: DATED_VECTORS.timeZone,
    });
  const applied = run(vector.exceptions);
  assert.equal(applied.metricsArm, 'core');
  assert.deepEqual(applied.timeTbd, vector.expected.timeTbd);
  assert.equal(applied.coachConflicts[0].sharedDates, vector.expected.conflicts[0].sharedDates);
  // Not read is not none: no `timeTbd` at all, and the unexcepted answer.
  const unread = run(undefined);
  assert.equal('timeTbd' in unread, false);
  assert.equal(unread.coachConflicts[0].sharedDates, 15);
});
