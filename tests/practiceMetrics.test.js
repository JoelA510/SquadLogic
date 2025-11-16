import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePracticeSchedule,
  MANUAL_FOLLOW_UP_CATEGORIES,
} from '../src/practiceMetrics.js';

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
    manualFollowUpRate: 0.25,
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
      divisionBreakdown: [
        { division: 'U12', count: 1, percentage: 1 },
      ],
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
      divisionBreakdown: [
        { division: 'U10', count: 1, percentage: 1 },
      ],
    },
  ]);

  assert.ok(
    report.dataQualityWarnings.some((warning) =>
      warning.includes('team-unknown'),
    ),
  );
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

  const report = evaluatePracticeSchedule({ assignments: [], teams: [], slots });

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

  const report = evaluatePracticeSchedule({ assignments: [], teams: [], slots });

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
    manualFollowUpRate: 0.75,
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
  });

  assert.deepEqual(report.manualFollowUpBreakdown, [
    {
      category: MANUAL_FOLLOW_UP_CATEGORIES.COACH_AVAILABILITY,
      count: 2,
      percentage: 0.5,
      teamIds: ['team-b', 'team-c'],
      reasons: [
        'coach availability excludes all slots',
        'coach schedule conflicts on all slots',
      ],
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
