import test from 'node:test';
import assert from 'node:assert/strict';
import { runScheduleEvaluations } from '../src/evaluationPipeline.js';

const BASE_TIME = new Date('2024-08-12T22:00:00Z');

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60_000);
}

test('aggregates practice and game evaluations with issue rollups', () => {
  const practiceSlots = [
    {
      id: 'slot-1',
      capacity: 1,
      start: BASE_TIME,
      end: addMinutes(BASE_TIME, 60),
      day: 'Mon',
    },
  ];
  const practiceTeams = [
    { id: 'team-1', division: 'U10', coachId: 'coach-1' },
    { id: 'team-2', division: 'U10', coachId: 'coach-1' },
    { id: 'team-3', division: 'U10', coachId: 'coach-2' },
  ];

  const practiceAssignments = [
    { teamId: 'team-1', slotId: 'slot-1' },
    { teamId: 'team-2', slotId: 'slot-1' },
  ];

  const practiceResult = runScheduleEvaluations({
    practice: {
      assignments: practiceAssignments,
      teams: practiceTeams,
      slots: practiceSlots,
      unassigned: [{ teamId: 'team-3', reason: 'no capacity', candidates: [] }],
    },
    games: {
      assignments: [
        {
          id: 'game-1',
          division: 'U10',
          weekIndex: 1,
          homeTeamId: 'team-1',
          awayTeamId: 'team-99',
          start: BASE_TIME,
          end: addMinutes(BASE_TIME, 50),
          slotId: 'field-1',
          fieldId: 'field-1',
        },
      ],
      teams: practiceTeams,
      unscheduled: [{ reason: 'weather', matchup: 'team-1 vs team-2', weekIndex: 1, division: 'U10' }],
    },
  });

  assert.equal(practiceResult.status, 'action-required');
  assert.equal(practiceResult.issues.length, 5);

  const messages = practiceResult.issues.map((issue) => issue.message);
  assert.ok(messages.some((message) => message.includes('lack practice assignments')));
  assert.ok(messages.some((message) => message.includes('overlapping practices')));
  assert.ok(messages.some((message) => message.includes('exceeds capacity')));
  assert.ok(messages.some((message) => message.includes('unknown team')));
  assert.ok(messages.some((message) => message.includes('could not be scheduled')));

  assert.equal(practiceResult.practice.summary.unassignedTeams, 1);
  assert.equal(practiceResult.games.summary.totalAssignments, 1);
  assert.ok(practiceResult.games.warnings.length >= 1);
});

test('reports ok status when no issues are detected', () => {
  const practiceSlots = [
    {
      id: 'slot-2',
      capacity: 2,
      start: BASE_TIME,
      end: addMinutes(BASE_TIME, 60),
      day: 'Tue',
    },
  ];
  const teams = [
    { id: 'team-10', division: 'U12', coachId: null },
    { id: 'team-11', division: 'U12', coachId: null },
  ];

  const result = runScheduleEvaluations({
    practice: {
      assignments: [
        { teamId: 'team-10', slotId: 'slot-2' },
        { teamId: 'team-11', slotId: 'slot-2' },
      ],
      teams,
      slots: practiceSlots,
    },
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.issues.length, 0);
  assert.equal(result.practice.summary.unassignedTeams, 0);
  assert.equal(result.games, null);
});

test('surface evaluator validation errors when required practice inputs are missing', () => {
  assert.throws(() =>
    runScheduleEvaluations({
      practice: {
        teams: [],
        slots: [],
      },
    }),
  /assignments must be an array/);

  assert.throws(() =>
    runScheduleEvaluations({
      practice: {
        assignments: [],
        slots: [],
      },
    }),
  /teams must be an array/);

  assert.throws(() =>
    runScheduleEvaluations({
      practice: {
        assignments: [],
        teams: [],
      },
    }),
  /slots must be an array/);
});

test('surface evaluator validation errors when required game inputs are missing', () => {
  assert.throws(() =>
    runScheduleEvaluations({
      games: {
        teams: [],
      },
    }),
  /assignments must be an array/);

  assert.throws(() =>
    runScheduleEvaluations({
      games: {
        assignments: [],
      },
    }),
  /teams must be an array/);
});

test('optional collections default safely when omitted', () => {
  const result = runScheduleEvaluations({
    practice: {
      assignments: [],
      teams: [],
      slots: [],
    },
    games: {
      assignments: [],
      teams: [],
    },
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.issues.length, 0);
  assert.deepEqual(result.practice.summary, {
    totalTeams: 0,
    assignedTeams: 0,
    unassignedTeams: 0,
    assignmentRate: 1,
  });
  assert.deepEqual(result.games.summary.unscheduledByReason, {});
});

test('game conflict warnings escalate to error severity', () => {
  const start = BASE_TIME;
  const overlapEnd = addMinutes(BASE_TIME, 45);
  const result = runScheduleEvaluations({
    games: {
      assignments: [
        {
          id: 'game-a',
          division: 'U10',
          weekIndex: 1,
          homeTeamId: 'team-1',
          awayTeamId: 'team-2',
          start,
          end: overlapEnd,
          slotId: 'field-1',
          fieldId: 'field-1',
        },
        {
          id: 'game-b',
          division: 'U10',
          weekIndex: 1,
          homeTeamId: 'team-1',
          awayTeamId: 'team-3',
          start: addMinutes(BASE_TIME, 15),
          end: addMinutes(BASE_TIME, 60),
          slotId: 'field-2',
          fieldId: 'field-2',
        },
      ],
      teams: [
        { id: 'team-1', division: 'U10', coachId: 'coach-1' },
        { id: 'team-2', division: 'U10', coachId: 'coach-2' },
        { id: 'team-3', division: 'U10', coachId: 'coach-3' },
      ],
    },
  });

  const conflictIssue = result.issues.find((issue) =>
    issue.category === 'games' && issue.message.includes('overlapping games'),
  );
  assert.ok(conflictIssue, 'expected overlapping games issue');
  assert.equal(conflictIssue.severity, 'error');
  assert.equal(result.status, 'action-required');
});

test('shared slot imbalance warnings surface with warning severity', () => {
  const result = runScheduleEvaluations({
    games: {
      assignments: [],
      teams: [],
      sharedSlotUsage: [
        {
          slotId: 'shared-slot-1',
          fieldId: 'field-x',
          divisionUsage: [
            { division: 'U10', count: 3 },
            { division: 'U12', count: 0 },
          ],
        },
      ],
    },
  });

  const imbalanceIssue = result.issues.find((issue) =>
    issue.category === 'games' && issue.message.includes('imbalanced across divisions'),
  );

  assert.ok(imbalanceIssue, 'expected shared slot imbalance issue');
  assert.equal(imbalanceIssue.severity, 'warning');
  assert.equal(result.status, 'attention-needed');
});
