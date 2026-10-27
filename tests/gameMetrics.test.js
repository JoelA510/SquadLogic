import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';

import { evaluateGameSchedule } from '../packages/core/src/gameMetrics.js';
import { coreGameProjection, truthProjection } from './fixtures/gameScoringProjection.js';

test('evaluateGameSchedule summarises assignments and byes without warnings', () => {
  const teams = [
    { id: 'u12-a', name: 'U12 Team A', division: 'U12', coachId: 'coach-a' },
    { id: 'u12-b', name: 'U12 Team B', division: 'U12', coachId: 'coach-b' },
    { id: 'u14-a', name: 'U14 Team A', division: 'U14', coachId: 'coach-c' },
    { id: 'u14-b', name: 'U14 Team B', division: 'U14', coachId: 'coach-d' },
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
    { id: 'team-a', name: 'Team A', division: 'U12', coachId: 'coach-shared' },
    { id: 'team-b', name: 'Team B', division: 'U12', coachId: 'coach-unique' },
    { id: 'team-c', name: 'Team C', division: 'U12', coachId: 'coach-shared' },
    { id: 'team-d', name: 'Team D', division: 'U12', coachId: 'coach-other' },
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
    { id: 'team-a', name: 'Team A', division: 'U12', coachId: 'coach-a' },
    { id: 'team-b', name: 'Team B', division: 'U12', coachId: 'coach-b' },
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
  const teams = [{ id: 'team-known', name: 'Known Team', division: 'U12', coachId: null }];

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
  assert.equal(summary.unscheduledByDivision.U12, 3);
  assert(warnings.some((warning) => warning.type === 'unknown-team'));
  const unscheduledWarning = warnings.find((warning) => warning.type === 'unscheduled-matchups');
  assert(unscheduledWarning);
  assert.match(
    unscheduledWarning.message,
    /3 matchup\(s\) could not be scheduled \(coach-scheduling-conflict: 2, no-slot-available: 1\)\./
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
  assert.deepEqual(unscheduledWarning.details.divisionBreakdown, { U12: 3 });
});

test('evaluateGameSchedule flags shared slot imbalances across divisions', () => {
  const teams = [
    { id: 'team-a', name: 'Team A', division: 'U10', coachId: null },
    { id: 'team-b', name: 'Team B', division: 'U12', coachId: null },
  ];

  const sharedSlotUsage = [
    {
      slotId: 'shared-slot-1',
      fieldId: 'shared-field',
      weekIndex: 1,
      start: '2024-08-10T16:00:00Z',
      end: '2024-08-10T17:00:00Z',
      divisionUsage: [{ division: 'U10', count: 2 }],
    },
    {
      slotId: 'shared-slot-2',
      fieldId: 'shared-field',
      weekIndex: 2,
      start: '2024-08-17T16:00:00Z',
      end: '2024-08-17T17:00:00Z',
      divisionUsage: [{ division: 'U12', count: 1 }],
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
  const imbalanceWarnings = warnings.filter((warning) => warning.type === 'shared-slot-imbalance');
  assert.ok(imbalanceWarnings.length >= 1, 'expected shared slot imbalance warnings');
  const slotOneImbalance = imbalanceWarnings.find(
    (warning) => warning.details.slotId === 'shared-slot-1'
  );
  assert.ok(slotOneImbalance, 'expected shared slot 1 imbalance warning');
  assert.deepEqual(slotOneImbalance.details.distribution, [
    { division: 'U10', count: 2 },
    { division: 'U12', count: 0 },
  ]);
  assert.ok(slotOneImbalance.details.spread > 1);
});

// ---- Home and away (Phase D, PR A: docs/changes/2026-10-27-phase-d-scheduling.md) ----

const HA_TEAMS = ['A', 'B', 'C', 'D'].map((id) => ({
  id,
  name: `Team ${id}`,
  division: 'U10',
  coachId: `coach-${id}`,
}));

/** One game per week, on its own slot, so nothing but the sides can raise a warning. */
function hostedGames(pairs) {
  return pairs.map(([homeTeamId, awayTeamId], index) => ({
    weekIndex: index + 1,
    division: 'U10',
    slotId: `ha-slot-${index}`,
    start: `2026-10-${String(3 + index * 7).padStart(2, '0')}T13:00:00Z`,
    end: `2026-10-${String(3 + index * 7).padStart(2, '0')}T14:00:00Z`,
    homeTeamId,
    awayTeamId,
    fieldId: `ha-field-${index}`,
  }));
}

const imbalances = (warnings) => warnings.filter((w) => w.type === 'home-away-imbalance');

test('a team hosting all three of its games raises one home-away-imbalance, with the counts', () => {
  const { summary, warnings } = evaluateGameSchedule({
    assignments: hostedGames([
      ['A', 'B'],
      ['A', 'C'],
      ['A', 'D'],
    ]),
    teams: HA_TEAMS,
  });
  const found = imbalances(warnings);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].details, {
    teamId: 'A',
    division: 'U10',
    homeGames: 3,
    awayGames: 0,
    totalGames: 3,
    unscheduledGames: 0,
  });
  assert.match(found[0].message, /Team A hosts 3 of its 3 games/);
  // The counts the warning quotes are the ones the summary publishes.
  assert.equal(summary.teamGameLoad.A.homeGames, 3);
});

test('a 2-1 team, a 1-0 team and a team with no games raise no home-away-imbalance', () => {
  const { warnings } = evaluateGameSchedule({
    // A: 2 home, 1 away. B: 1 home, 1 away. C: 0-1. D plays nothing.
    assignments: hostedGames([
      ['A', 'B'],
      ['B', 'A'],
      ['A', 'C'],
    ]),
    teams: HA_TEAMS,
  });
  assert.deepEqual(imbalances(warnings), []);
});

test('the threshold is |home - away| > 1: 1-0, 1-1 and 2-1 are quiet; 2-0 and 3-1 are not', () => {
  // Team A against five opponents' worth of ids, hosting `home` of its games and visiting `away`.
  const opponents = ['B', 'C', 'D', 'E', 'F'];
  const teams = [...HA_TEAMS, 'E', 'F'].map((t) =>
    typeof t === 'string' ? { id: t, name: `Team ${t}`, division: 'U10', coachId: `coach-${t}` } : t
  );
  const flaggedA = (home, away) => {
    const pairs = [
      ...opponents.slice(0, home).map((o) => ['A', o]),
      ...opponents.slice(home, home + away).map((o) => [o, 'A']),
    ];
    const { warnings } = evaluateGameSchedule({ assignments: hostedGames(pairs), teams });
    return imbalances(warnings).some((w) => w.details.teamId === 'A');
  };
  assert.deepEqual(
    [
      [1, 0],
      [1, 1],
      [2, 1],
      [2, 2],
      [3, 2],
    ].map(([h, a]) => flaggedA(h, a)),
    [false, false, false, false, false]
  );
  assert.deepEqual(
    [
      [2, 0],
      [3, 1],
      [0, 2],
      [1, 3],
    ].map(([h, a]) => flaggedA(h, a)),
    [true, true, true, true],
    'a team visiting more often is flagged as readily as one hosting more'
  );
});

test('a side the roster lacks raises no home-away-imbalance, only its unknown-team warning', () => {
  const { warnings } = evaluateGameSchedule({
    assignments: hostedGames([
      ['ghost', 'A'],
      ['ghost', 'B'],
      ['ghost', 'C'],
    ]),
    teams: HA_TEAMS,
  });
  assert.deepEqual(imbalances(warnings), []);
  assert.ok(warnings.some((w) => w.type === 'unknown-team'));
});

test('a team with a game left unscheduled says how many, so a dropped game is not mistaken for a skew', () => {
  const { warnings } = evaluateGameSchedule({
    assignments: hostedGames([
      ['A', 'B'],
      ['A', 'C'],
    ]),
    teams: HA_TEAMS,
    unscheduled: [
      {
        weekIndex: 3,
        division: 'U10',
        matchup: { homeTeamId: 'D', awayTeamId: 'A' },
        reason: 'no-slot',
      },
    ],
  });
  // 2 home, 0 away over two placed games is a spread of 2: flagged, with the
  // dropped game named so the reader sees why it reads that way.
  const [only] = imbalances(warnings);
  assert.equal(imbalances(warnings).length, 1);
  assert.equal(only.details.teamId, 'A');
  assert.equal(only.details.unscheduledGames, 1);
});

test('the season-2026 games raise no home-away-imbalance; one team made home in every game is flagged', () => {
  const { inputs } = JSON.parse(
    readFileSync(
      path.join(
        process.cwd(),
        'supabase/functions/_shared/tests/fixtures/scoring-parity-games.season-2026.json'
      ),
      'utf8'
    )
  );
  const real = evaluateGameSchedule({ assignments: inputs.games, teams: inputs.teams });
  // 131 of the 132 rostered teams have a game: the check examined them all.
  assert.equal(Object.keys(real.summary.teamGameLoad).length, 131);
  assert.deepEqual(imbalances(real.warnings), []);

  // Plant: the busiest team hosts every game it plays.
  const [planted] = Object.entries(real.summary.teamGameLoad).sort(
    (a, b) => b[1].totalGames - a[1].totalGames || a[0].localeCompare(b[0])
  )[0];
  assert.equal(real.summary.teamGameLoad[planted].totalGames, 9);
  const flipped = inputs.games.map((game) =>
    game.awayTeamId === planted
      ? { ...game, homeTeamId: planted, awayTeamId: game.homeTeamId }
      : game
  );
  const after = evaluateGameSchedule({ assignments: flipped, teams: inputs.teams });
  const flagged = imbalances(after.warnings).map((w) => w.details.teamId);
  assert.ok(flagged.includes(planted), 'the planted team is flagged');
  assert.equal(
    imbalances(after.warnings).find((w) => w.details.teamId === planted).details.homeGames,
    9
  );
});

// ---- The game vector table (#576 follow-up, docs/PLAN_GAME_EVALUATOR_UNKNOWN_TEAM.md §3.5) ----
//
// Core is the sibling whose contract the Edge adopts, so it must give each
// hand-worked truth first: a vector core gets wrong would hold the Edge to a
// wrong answer. The drift test and the Deno arm run the Edge over the same table.
const GAME_VECTORS = JSON.parse(
  readFileSync(
    path.join(process.cwd(), 'supabase/functions/_shared/tests/fixtures/game-scoring-vectors.json'),
    'utf8'
  )
).vectors;

test('the game vector table is the plan table (meta, can fail)', () => {
  const names = GAME_VECTORS.map((v) => v.name.split(':')[0]);
  assert.deepEqual(names, ['G1', 'G2', 'G3 (control)', 'G4', 'S1', 'S2', 'U2', 'D1']);
});

for (const vector of GAME_VECTORS) {
  test(`core gives the hand-worked truth: ${vector.name}`, () => {
    const result = evaluateGameSchedule({ assignments: vector.games, teams: vector.teams });
    assert.deepEqual(coreGameProjection(result), truthProjection(vector.truth));
  });
}
