import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluateGameSchedule } from '../src/gameMetrics.js';

test('evaluateGameSchedule summarises assignments and byes without warnings', () => {
  const teams = [
    { id: 'u12-a', division: 'U12', coachId: 'coach-a' },
    { id: 'u12-b', division: 'U12', coachId: 'coach-b' },
    { id: 'u14-a', division: 'U14', coachId: 'coach-c' },
    { id: 'u14-b', division: 'U14', coachId: 'coach-d' },
  ];

  const assignments = [
    {
      weekIndex: 1,
      division: 'U12',
      slotId: 'field-1-slot-1',
      start: '2024-08-10T16:00:00Z',
      end: '2024-08-10T17:00:00Z',
      homeTeamId: 'u12-a',
      awayTeamId: 'u12-b',
      fieldId: 'field-1',
    },
    {
      weekIndex: 1,
      division: 'U14',
      slotId: 'field-2-slot-1',
      start: '2024-08-10T17:30:00Z',
      end: '2024-08-10T18:30:00Z',
      homeTeamId: 'u14-a',
      awayTeamId: 'u14-b',
      fieldId: 'field-2',
    },
  ];

  const byes = [
    { weekIndex: 1, division: 'U12', teamId: 'u12-c' },
    { weekIndex: 1, division: 'U14', teamId: 'u14-c' },
  ];

  const { summary, warnings } = evaluateGameSchedule({
    assignments,
    teams,
    byes,
    unscheduled: [],
  });

  assert.equal(summary.totalAssignments, 2);
  assert.deepEqual(summary.assignmentsByDivision.U12.games, 1);
  assert.deepEqual(summary.assignmentsByDivision.U12.teams.sort(), ['u12-a', 'u12-b']);
  assert.deepEqual(summary.fieldUsage['field-1'].divisions, ['U12']);
  assert.equal(summary.teamsWithByes.U12, 1);
  assert.deepEqual(summary.sharedSlotUsage, []);
  assert.deepEqual(summary.sharedFieldDistribution, {});
  assert.deepEqual(summary.teamGameLoad['u12-a'], {
    totalGames: 1,
    homeGames: 1,
    awayGames: 0,
    uniqueFields: ['field-1'],
    weeksScheduled: [1],
    earliestStart: '2024-08-10T16:00:00.000Z',
    latestStart: '2024-08-10T16:00:00.000Z',
  });
  assert.deepEqual(summary.teamGameLoad['u12-b'], {
    totalGames: 1,
    homeGames: 0,
    awayGames: 1,
    uniqueFields: ['field-1'],
    weeksScheduled: [1],
    earliestStart: '2024-08-10T16:00:00.000Z',
    latestStart: '2024-08-10T16:00:00.000Z',
  });
  assert.equal(warnings.length, 0);
});

test('evaluateGameSchedule surfaces team, coach, and field conflicts', () => {
  const teams = [
    { id: 'team-a', division: 'U12', coachId: 'coach-shared' },
    { id: 'team-b', division: 'U12', coachId: 'coach-unique' },
    { id: 'team-c', division: 'U12', coachId: 'coach-shared' },
    { id: 'team-d', division: 'U12', coachId: 'coach-other' },
  ];

  const assignments = [
    {
      weekIndex: 1,
      division: 'U12',
      slotId: 'field-1-slot-1',
      start: '2024-08-10T16:00:00Z',
      end: '2024-08-10T17:00:00Z',
      homeTeamId: 'team-a',
      awayTeamId: 'team-b',
      fieldId: 'field-1',
    },
    {
      weekIndex: 1,
      division: 'U12',
      slotId: 'field-1-slot-2',
      start: '2024-08-10T16:30:00Z',
      end: '2024-08-10T17:30:00Z',
      homeTeamId: 'team-a',
      awayTeamId: 'team-c',
      fieldId: 'field-1',
    },
    {
      weekIndex: 1,
      division: 'U12',
      slotId: 'field-2-slot-1',
      start: '2024-08-10T16:45:00Z',
      end: '2024-08-10T17:45:00Z',
      homeTeamId: 'team-c',
      awayTeamId: 'team-d',
      fieldId: 'field-2',
    },
  ];

  const { warnings } = evaluateGameSchedule({
    assignments,
    teams,
    unscheduled: [],
    byes: [],
  });

  assert(warnings.some((warning) => warning.type === 'team-double-booked'));
  assert(warnings.some((warning) => warning.type === 'coach-conflict'));
  assert(warnings.some((warning) => warning.type === 'field-overlap'));
});

test('evaluateGameSchedule ignores unassigned fields when checking overlaps', () => {
  const teams = [
    { id: 'team-a', division: 'U12', coachId: 'coach-a' },
    { id: 'team-b', division: 'U12', coachId: 'coach-b' },
  ];

  const assignments = [
    {
      weekIndex: 1,
      division: 'U12',
      slotId: 'slot-a',
      start: '2024-08-10T16:00:00Z',
      end: '2024-08-10T17:00:00Z',
      homeTeamId: 'team-a',
      awayTeamId: 'team-b',
      fieldId: null,
    },
    {
      weekIndex: 1,
      division: 'U12',
      slotId: 'slot-b',
      start: '2024-08-10T16:30:00Z',
      end: '2024-08-10T17:30:00Z',
      homeTeamId: 'team-a',
      awayTeamId: 'team-b',
      fieldId: undefined,
    },
  ];

  const { summary, warnings } = evaluateGameSchedule({
    assignments,
    teams,
    unscheduled: [],
    byes: [],
  });

  const fieldOverlapWarnings = warnings.filter((warning) => warning.type === 'field-overlap');
  assert.equal(fieldOverlapWarnings.length, 0);
  assert.deepEqual(summary.teamGameLoad['team-a'], {
    totalGames: 2,
    homeGames: 2,
    awayGames: 0,
    uniqueFields: [],
    weeksScheduled: [1],
    earliestStart: '2024-08-10T16:00:00.000Z',
    latestStart: '2024-08-10T16:30:00.000Z',
  });
  assert.deepEqual(summary.teamGameLoad['team-b'], {
    totalGames: 2,
    homeGames: 0,
    awayGames: 2,
    uniqueFields: [],
    weeksScheduled: [1],
    earliestStart: '2024-08-10T16:00:00.000Z',
    latestStart: '2024-08-10T16:30:00.000Z',
  });
});

test('evaluateGameSchedule aggregates unscheduled matchups and unknown teams', () => {
  const teams = [{ id: 'team-known', division: 'U12', coachId: null }];

  const assignments = [
    {
      weekIndex: 1,
      division: 'U12',
      slotId: 'field-1-slot-1',
      start: '2024-08-10T16:00:00Z',
      end: '2024-08-10T17:00:00Z',
      homeTeamId: 'team-known',
      awayTeamId: 'team-unknown',
      fieldId: 'field-1',
    },
  ];

  const unscheduled = [
    { weekIndex: 1, division: 'U12', reason: 'coach-scheduling-conflict' },
    { weekIndex: 1, division: 'U12', reason: 'coach-scheduling-conflict' },
    { weekIndex: 2, division: 'U12', reason: 'no-slot-available' },
  ];

  const { summary, warnings } = evaluateGameSchedule({
    assignments,
    teams,
    unscheduled,
    byes: [],
  });

  assert.equal(summary.unscheduledByReason['coach-scheduling-conflict'], 2);
  assert.equal(summary.unscheduledByReason['no-slot-available'], 1);
  assert(warnings.some((warning) => warning.type === 'unknown-team'));
  const unscheduledWarning = warnings.find(
    (warning) => warning.type === 'unscheduled-matchups',
  );
  assert(unscheduledWarning);
  assert.match(
    unscheduledWarning.message,
    /3 matchup\(s\) could not be scheduled \(coach-scheduling-conflict: 2, no-slot-available: 1\)\./,
  );
  assert.deepEqual(summary.teamGameLoad['team-known'], {
    totalGames: 1,
    homeGames: 1,
    awayGames: 0,
    uniqueFields: ['field-1'],
    weeksScheduled: [1],
    earliestStart: '2024-08-10T16:00:00.000Z',
    latestStart: '2024-08-10T16:00:00.000Z',
  });
});

test('evaluateGameSchedule flags shared slot imbalances across divisions', () => {
  const teams = [
    { id: 'team-a', division: 'U10', coachId: null },
    { id: 'team-b', division: 'U12', coachId: null },
  ];

  const sharedSlotUsage = [
    {
      slotId: 'shared-slot-1',
      fieldId: 'shared-field',
      weekIndex: 1,
      start: '2024-08-10T16:00:00Z',
      end: '2024-08-10T17:00:00Z',
      divisionUsage: [
        { division: 'U10', count: 2 },
      ],
    },
    {
      slotId: 'shared-slot-2',
      fieldId: 'shared-field',
      weekIndex: 2,
      start: '2024-08-17T16:00:00Z',
      end: '2024-08-17T17:00:00Z',
      divisionUsage: [
        { division: 'U12', count: 1 },
      ],
    },
  ];

  const { summary, warnings } = evaluateGameSchedule({
    assignments: [],
    teams,
    sharedSlotUsage,
    unscheduled: [],
    byes: [],
  });

  assert.equal(summary.sharedSlotUsage.length, 2);
  assert.deepEqual(summary.sharedFieldDistribution['shared-field'], { U10: 2, U12: 1 });
  const imbalanceWarnings = warnings.filter(
    (warning) => warning.type === 'shared-slot-imbalance',
  );
  assert.ok(imbalanceWarnings.length >= 1, 'expected shared slot imbalance warnings');
  const slotOneImbalance = imbalanceWarnings.find((warning) => warning.details.slotId === 'shared-slot-1');
  assert.ok(slotOneImbalance, 'expected shared slot 1 imbalance warning');
  assert.deepEqual(slotOneImbalance.details.distribution, [
    { division: 'U10', count: 2 },
    { division: 'U12', count: 0 },
  ]);
  assert.ok(slotOneImbalance.details.spread > 1);
});
