import { test } from 'vitest';
import assert from 'node:assert/strict';
import { prepareTeamingInput } from '../packages/core/src/teamingPipeline.js';
import { PLACEMENT } from '../packages/core/src/playUp.js';
import { generateTeams } from '../packages/core/src/teamGeneration.js';

const SEASON = 2026;
const MODE = 'birth_year';

const divisions = [
  { id: 'U9B', name: 'U9 Boys', minAge: 9, maxAge: 9, gender_policy: 'boys' },
  { id: 'U10B', name: 'U10 Boys', minAge: 10, maxAge: 10, gender_policy: 'boys' },
];

test('links coaches and sanctions a coach-child play-up in one pass', () => {
  const players = [
    // coach's child, age 9, registered up into U10B
    { id: 'p_child', division: 'U10B', dob: '2017-05-01' },
    // unrelated age-9 player registered up into U10B with no sanction
    { id: 'p_other', division: 'U10B', dob: '2017-05-01' },
    // a normal in-band U10 player
    { id: 'p_inband', division: 'U10B', dob: '2016-05-01' },
  ];
  const coaches = [{ id: 'coachA', player_id: 'p_child' }];

  const { players: out, diagnostics } = prepareTeamingInput({
    players,
    coaches,
    divisions,
    seasonYear: SEASON,
    cutoffMode: MODE,
  });

  const child = out.find((p) => p.id === 'p_child');
  const other = out.find((p) => p.id === 'p_other');
  const inband = out.find((p) => p.id === 'p_inband');

  // Coach linking anchored the coach's team around the child.
  assert.equal(child.coachId, 'coachA');
  assert.equal(diagnostics.coachLinking.linkedPlayers, 1);

  // Coach child playing up is sanctioned (route A).
  assert.equal(child.placement, PLACEMENT.PLAY_UP_SANCTIONED);
  assert.equal(child.division, 'U10B');

  // The unrelated play-up is blocked.
  assert.equal(other.placement, PLACEMENT.PLAY_UP_BLOCKED);

  // In-band player untouched.
  assert.equal(inband.placement, PLACEMENT.IN_BAND);

  assert.equal(diagnostics.playUp.counts.playUpSanctioned, 1);
  assert.equal(diagnostics.playUp.counts.playUpBlocked, 1);
});

test('remapBlocked=false keeps players in their registered division (single-division flow)', () => {
  const players = [{ id: 'p_other', division: 'U10B', dob: '2017-05-01' }];
  const { players: out } = prepareTeamingInput({
    players,
    coaches: [],
    divisions,
    seasonYear: SEASON,
    cutoffMode: MODE,
    remapBlocked: false,
  });
  assert.equal(out[0].division, 'U10B');
  assert.equal(out[0].needsReview, true);
});

/* -------------------------------------------------------------------------- */
/* Phase B1: buddy requests by name reach the generator                        */
/* -------------------------------------------------------------------------- */

const named = (id, firstName, lastName, extra = {}) => ({
  id,
  division: 'U10B',
  firstName,
  lastName,
  dob: '2016-05-01',
  ...extra,
});

test('a reciprocal name pair arrives as mutual buddyIds and is one unit in generateTeams', () => {
  const players = [
    named('a', 'Ada', 'One', { buddy_request: 'Bea Two' }),
    named('b', 'Bea', 'Two', { buddy_request: 'One, Ada' }),
    ...Array.from({ length: 10 }, (_, i) => named(`x${i}`, `Kid${i}`, `Filler${i}`)),
  ];
  const { players: out, diagnostics } = prepareTeamingInput({
    players,
    divisions,
    seasonYear: SEASON,
    cutoffMode: MODE,
  });
  const byId = new Map(out.map((p) => [p.id, p]));
  assert.equal(byId.get('a').buddyId, 'b');
  assert.equal(byId.get('b').buddyId, 'a');
  assert.ok(!diagnostics.buddyLinking.some((d) => d.code === 'missing-buddy-target'));

  const result = generateTeams({
    players: out,
    divisionConfigs: { U10B: { id: 'U10B', slotsPerWeek: 0, teamsCount: 2, maxRosterSize: 8 } },
    random: () => 0.5,
  });
  assert.deepEqual(result.buddyDiagnosticsByDivision.U10B.mutualPairs, [{ playerIds: ['a', 'b'] }]);
  const teamOf = (id) =>
    result.teamsByDivision.U10B.find((t) => t.players.some((p) => p.id === id));
  assert.equal(teamOf('a').id, teamOf('b').id);
});

test("a coach's child named back by a play-up player sanctions the play-up (route B)", () => {
  const players = [
    // the coach's child, age 10, in band in U10B
    named('child', 'Cara', 'Coach', { buddy_request: 'Pia Up' }),
    // age 9, registered up into U10B, buddied with the coach's child
    named('up', 'Pia', 'Up', { dob: '2017-05-01', buddy_request: 'Cara Coach' }),
  ];
  const { players: out, diagnostics } = prepareTeamingInput({
    players,
    coaches: [{ id: 'coachA', player_id: 'child' }],
    divisions,
    seasonYear: SEASON,
    cutoffMode: MODE,
  });
  const up = out.find((p) => p.id === 'up');
  assert.equal(up.buddyId, 'child');
  assert.equal(up.placement, PLACEMENT.PLAY_UP_SANCTIONED);
  assert.deepEqual(diagnostics.playUp.sanctionedPlayUps, [
    { id: 'up', division: 'U10B', via: 'buddy', naturalAge: 9 },
  ]);
});

test("a one-way request for a coach's child sanctions nothing under the mutual rule", () => {
  const { players: out } = prepareTeamingInput({
    players: [
      named('child', 'Cara', 'Coach'),
      named('up', 'Pia', 'Up', { dob: '2017-05-01', buddy_request: 'Cara Coach' }),
    ],
    coaches: [{ id: 'coachA', player_id: 'child' }],
    divisions,
    seasonYear: SEASON,
    cutoffMode: MODE,
  });
  assert.equal(out.find((p) => p.id === 'up').placement, PLACEMENT.PLAY_UP_BLOCKED);
});

test("an honoured one-way request for a coach's child does not sanction a play-up", () => {
  // Under one_way_best_effort the request is scored best effort, and may not land together,
  // so it is no sanction: route B needs a pair.
  const { players: out } = prepareTeamingInput({
    players: [
      named('child', 'Cara', 'Coach'),
      named('up', 'Pia', 'Up', { dob: '2017-05-01', buddy_request: 'Cara Coach' }),
    ],
    coaches: [{ id: 'coachA', player_id: 'child' }],
    divisions,
    seasonYear: SEASON,
    cutoffMode: MODE,
    buddyRule: 'one_way_best_effort',
  });
  const up = out.find((p) => p.id === 'up');
  assert.equal(up.buddyId, 'child', 'the request is honoured best effort');
  assert.equal(up.placement, PLACEMENT.PLAY_UP_BLOCKED);
});

test('two coaching families as buddies give buddy-coach-conflict and no throw', () => {
  const players = [
    named('a', 'Ada', 'One', { buddy_request: 'Bea Two' }),
    named('b', 'Bea', 'Two', { buddy_request: 'Ada One' }),
    ...Array.from({ length: 6 }, (_, i) => named(`x${i}`, `Kid${i}`, `Filler${i}`)),
  ];
  const prepared = prepareTeamingInput({
    players,
    coaches: [
      { id: 'coachA', player_id: 'a' },
      { id: 'coachB', player_id: 'b' },
    ],
    divisions,
    seasonYear: SEASON,
    cutoffMode: MODE,
  });
  const byId = new Map(prepared.players.map((p) => [p.id, p]));
  // Both keep their coach; neither keeps the buddy.
  assert.equal(byId.get('a').coachId, 'coachA');
  assert.equal(byId.get('b').coachId, 'coachB');
  assert.equal(byId.get('a').buddyId, undefined);
  assert.equal(byId.get('b').buddyId, undefined);
  const conflict = prepared.diagnostics.buddyLinking.filter(
    (d) => d.code === 'buddy-coach-conflict'
  );
  assert.equal(conflict.length, 1);
  assert.deepEqual(conflict[0].playerIds, ['a', 'b']);
  assert.ok(
    prepared.diagnostics.buddyRequests.every((r) => r.outcome === 'coach-conflict' && !r.honoured)
  );

  // The generator no longer aborts the run ("Conflicting coach assignments").
  const result = generateTeams({
    players: prepared.players,
    divisionConfigs: { U10B: { id: 'U10B', slotsPerWeek: 0, teamsCount: 2, maxRosterSize: 8 } },
    random: () => 0.5,
  });
  const teamOf = (id) =>
    result.teamsByDivision.U10B.find((t) => t.players.some((p) => p.id === id));
  assert.equal(teamOf('a').coachId, 'coachA');
  assert.equal(teamOf('b').coachId, 'coachB');
});
