import { test } from 'vitest';
import assert from 'node:assert/strict';
import { prepareTeamingInput } from '../packages/core/src/teamingPipeline.js';
import { PLACEMENT } from '../packages/core/src/playUp.js';
import { generateTeams } from '../packages/core/src/teamGeneration.js';
import { BuddyEvaluator } from '../packages/core/src/evaluators/index.js';

const SEASON = 2026;
const MODE = 'birth_year';

const divisions = [
  { id: 'U9B', name: 'U9 Boys', minAge: 9, maxAge: 9, gender_policy: 'boys' },
  { id: 'U10B', name: 'U10 Boys', minAge: 10, maxAge: 10, gender_policy: 'boys' },
];

test('links coaches and lists every play-up in one pass', () => {
  const players = [
    // coach's child, age 9, registered up into U10B and requested to play up
    { id: 'p_child', division: 'U10B', dob: '2017-05-01', play_up_requested: true },
    // unrelated age-9 player registered up into U10B, no request
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

  // The requested play-up stays where it registered.
  assert.equal(child.placement, PLACEMENT.PLAY_UP);
  assert.equal(child.division, 'U10B');

  // The unrequested one plays in their own age division.
  assert.equal(other.placement, PLACEMENT.PLAY_UP);
  assert.equal(other.division, 'U9B');

  // In-band player untouched.
  assert.equal(inband.placement, PLACEMENT.IN_BAND);

  assert.equal(diagnostics.playUp.counts.playUpRequested, 1);
  assert.equal(diagnostics.playUp.counts.playUpUnrequested, 1);
  // The listing carries the coach link the pipeline made.
  assert.equal(diagnostics.playUp.listing.find((e) => e.playerId === 'p_child').coachId, 'coachA');
});

test('players are placed across every division given, whatever they registered in', () => {
  const { players: out } = prepareTeamingInput({
    players: [{ id: 'p_other', division: 'U10B', dob: '2017-05-01' }],
    coaches: [],
    divisions,
    seasonYear: SEASON,
    cutoffMode: MODE,
  });
  assert.equal(out[0].division, 'U9B');
  assert.equal(out[0].registeredDivision, 'U10B');
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

test("a play-up player's buddy pair with a coach's child is listed with the buddy fact", () => {
  const players = [
    // the coach's child, age 10, in band in U10B
    named('child', 'Cara', 'Coach', { buddy_request: 'Pia Up' }),
    // age 9, registered up into U10B, requested, buddied with the coach's child
    named('up', 'Pia', 'Up', {
      dob: '2017-05-01',
      buddy_request: 'Cara Coach',
      play_up_requested: true,
    }),
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
  assert.equal(up.division, 'U10B');
  const entry = diagnostics.playUp.listing.find((e) => e.playerId === 'up');
  assert.equal(entry.buddyId, 'child');
  assert.equal(entry.buddyInPlayedDivision, true);
  assert.equal(entry.coachId, null, 'the buddy is the coach’s child, not the player');
});

test('buddies who now play in two divisions are told apart, never thrown', () => {
  const { players: out, diagnostics } = prepareTeamingInput({
    players: [
      named('pal', 'Pal', 'One', { buddy_request: 'Pia Up' }),
      // age 9, no request: plays in U9B while the buddy plays in U10B
      named('up', 'Pia', 'Up', { dob: '2017-05-01', buddy_request: 'Pal One' }),
    ],
    divisions,
    seasonYear: SEASON,
    cutoffMode: MODE,
  });
  assert.equal(out.find((p) => p.id === 'up').division, 'U9B');
  assert.equal(out.find((p) => p.id === 'up').buddyId, undefined);
  assert.equal(out.find((p) => p.id === 'pal').buddyId, undefined);
  assert.deepEqual(
    diagnostics.buddyLinking.filter((d) => d.code === 'buddy-played-apart').map((d) => d.playerIds),
    [['pal', 'up']]
  );
  assert.ok(diagnostics.buddyRequests.every((r) => r.outcome === 'played-apart' && !r.honoured));
  // The listing still says the buddy was not in the division played in.
  assert.equal(
    diagnostics.playUp.listing.find((e) => e.playerId === 'up').buddyInPlayedDivision,
    false
  );
});

test('a one-way request for a coach’s child is no link under the mutual rule', () => {
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
  assert.equal(out.find((p) => p.id === 'up').buddyId, undefined);
});

test('an honoured one-way request is dropped when the two now play in different divisions', () => {
  const { players: out, diagnostics } = prepareTeamingInput({
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
  assert.equal(out.find((p) => p.id === 'up').buddyId, undefined);
  assert.equal(diagnostics.buddyRequests[0].reason, 'plays-in-another-division');
});

test("an honoured one-way request is kept when both play in the coach's child's division", () => {
  const { players: out } = prepareTeamingInput({
    players: [
      named('child', 'Cara', 'Coach'),
      named('up', 'Pia', 'Up', {
        dob: '2017-05-01',
        buddy_request: 'Cara Coach',
        play_up_requested: true,
      }),
    ],
    coaches: [{ id: 'coachA', player_id: 'child' }],
    divisions,
    seasonYear: SEASON,
    cutoffMode: MODE,
    buddyRule: 'one_way_best_effort',
  });
  assert.equal(out.find((p) => p.id === 'up').buddyId, 'child', 'honoured best effort');
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

test('an honoured one-way request steers placement whichever of the two is placed first (PR #647, Codex 4)', () => {
  // Units are placed strongest first, ties in input order, so listing the requester first
  // places them first. Requester and named player share the top rating, so both are placed
  // before any team fills: what keeps them together is the score, not capacity. One-way stays
  // best effort: never a unit.
  const fillers = Array.from({ length: 16 }, (_, i) =>
    named(`x${i}`, `Kid${i}`, `Filler${i}`, { skillRating: (i % 4) + 1 })
  );
  const divisionConfigs = {
    U10B: { id: 'U10B', slotsPerWeek: 0, teamsCount: 3, maxRosterSize: 10 },
  };
  for (const [first, second] of [
    ['requester', 'target'],
    ['target', 'requester'],
  ]) {
    const people = {
      requester: named('r', 'Ada', 'One', { buddy_request: 'Bea Two', skillRating: 5 }),
      target: named('t', 'Bea', 'Two', { skillRating: 5 }),
    };
    for (let s = 0; s < 20; s += 1) {
      const { players: out } = prepareTeamingInput({
        players: [people[first], people[second], ...fillers],
        divisions,
        seasonYear: SEASON,
        cutoffMode: MODE,
        buddyRule: 'one_way_best_effort',
      });
      const result = generateTeams({ players: out, divisionConfigs, seed: `one-way-${s}` });
      const teamOf = (id) =>
        result.teamsByDivision.U10B.find((t) => t.players.some((p) => p.id === id))?.id;
      assert.ok(teamOf('r'), 'the requester is placed');
      assert.equal(teamOf('r'), teamOf('t'), `seed one-way-${s}, ${first} listed first`);
      assert.deepEqual(result.buddyDiagnosticsByDivision.U10B.mutualPairs, []);
    }
  }
});

test('BuddyEvaluator scores the named player toward a placed requester, and has no data otherwise', () => {
  const evaluator = new BuddyEvaluator();
  const requester = { id: 'r', buddyId: 't' };
  const target = { id: 't' };
  const teamA = { id: 'A', players: [requester] };
  const teamB = { id: 'B', players: [{ id: 'x' }] };
  const allTeams = [teamA, teamB];
  assert.equal(evaluator.evaluate({ player: target, team: teamA, allTeams }), 100);
  assert.equal(evaluator.evaluate({ player: target, team: teamB, allTeams }), 0);
  // Nobody named this player, and they named nobody: no data, a perfect fit everywhere.
  const loner = { id: 'l' };
  assert.equal(evaluator.evaluate({ player: loner, team: teamA, allTeams }), 100);
  assert.equal(evaluator.evaluate({ player: loner, team: teamB, allTeams }), 100);
  // The requester's own scoring is unchanged: toward the named player once placed.
  const placed = [{ id: 'A', players: [target] }, teamB];
  assert.equal(evaluator.evaluate({ player: requester, team: placed[0], allTeams: placed }), 100);
  assert.equal(evaluator.evaluate({ player: requester, team: teamB, allTeams: placed }), 0);
});
