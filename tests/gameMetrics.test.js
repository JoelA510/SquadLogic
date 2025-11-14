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
  assert(warnings.some((warning) => warning.type === 'unscheduled-matchups'));
});
