import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTeams } from '../src/teamGeneration.js';

const divisionConfigs = {
  U10: { maxRosterSize: 4 },
};

test('distributes players evenly across teams', () => {
  const players = Array.from({ length: 9 }).map((_, index) => ({
    id: `player-${index + 1}`,
    division: 'U10',
  }));

  const { teamsByDivision, overflowByDivision, buddyDiagnosticsByDivision } = generateTeams({
    players,
    divisionConfigs,
    random: createDeterministicRandom(),
  });
  const teams = teamsByDivision.U10;

  assert.equal(teams.length, 3);

  const sizes = teams.map((team) => team.players.length).sort((a, b) => a - b);
  assert.deepEqual(sizes, [3, 3, 3]);

  const allPlayers = teams.flatMap((team) => team.players.map((player) => player.id));
  assert.equal(new Set(allPlayers).size, players.length);
  assert.deepEqual(overflowByDivision.U10, []);
  assert.deepEqual(buddyDiagnosticsByDivision.U10.unmatchedRequests, []);
});

test('keeps mutual buddies on the same team', () => {
  const players = [
    { id: 'a', division: 'U10', buddyId: 'b' },
    { id: 'b', division: 'U10', buddyId: 'a' },
    { id: 'c', division: 'U10' },
    { id: 'd', division: 'U10' },
  ];

  const { teamsByDivision, buddyDiagnosticsByDivision } = generateTeams({
    players,
    divisionConfigs,
    random: createDeterministicRandom(),
  });
  const teams = teamsByDivision.U10;
  const buddyTeam = teams.find((team) => team.players.some((player) => player.id === 'a'));
  assert.ok(buddyTeam, 'expected buddy pair to be assigned to a team');
  const buddyIds = buddyTeam.players.filter((player) => player.id === 'a' || player.id === 'b').map((player) => player.id).sort();
  assert.deepEqual(buddyIds, ['a', 'b']);
  assert.deepEqual(buddyDiagnosticsByDivision.U10.mutualPairs, [
    { playerIds: ['a', 'b'] },
  ]);
});

test('respects coach assignments when creating teams', () => {
  const players = [
    { id: 'a', division: 'U10', coachId: 'coach-1' },
    { id: 'b', division: 'U10', coachId: 'coach-1' },
    { id: 'c', division: 'U10' },
    { id: 'd', division: 'U10' },
  ];

  const { teamsByDivision, overflowByDivision } = generateTeams({
    players,
    divisionConfigs,
    random: createDeterministicRandom(),
  });
  const teams = teamsByDivision.U10;
  const coachTeam = teams.find((team) => team.coachId === 'coach-1');

  assert.ok(coachTeam, 'coach team should be created for volunteer coach');
  const rosterIds = coachTeam.players
    .filter((player) => player.id === 'a' || player.id === 'b')
    .map((player) => player.id)
    .sort();
  assert.deepEqual(rosterIds, ['a', 'b']);
  assert.deepEqual(overflowByDivision.U10, []);
});

test('records overflow when no team can accommodate a unit', () => {
  const players = [
    { id: 'a', division: 'U10', coachId: 'coach-1' },
    { id: 'b', division: 'U10', coachId: 'coach-1' },
    { id: 'c', division: 'U10', coachId: 'coach-1' },
    { id: 'd', division: 'U10', coachId: 'coach-1' },
    { id: 'e', division: 'U10', coachId: 'coach-1' },
  ];

  const { overflowByDivision, buddyDiagnosticsByDivision } = generateTeams({
    players,
    divisionConfigs,
    random: createDeterministicRandom(),
  });

  const overflow = overflowByDivision.U10;
  assert.equal(overflow.length, 1);
  assert.equal(overflow[0].reason, 'coach-capacity');
  assert.deepEqual(overflow[0].players.map((player) => player.id).sort(), ['e']);
  assert.equal(overflow[0].metadata.coachId, 'coach-1');
  assert.deepEqual(buddyDiagnosticsByDivision.U10.unmatchedRequests, []);
});

test('throws when buddy unit has conflicting coach assignments', () => {
  const players = [
    { id: 'a', division: 'U10', buddyId: 'b', coachId: 'coach-1' },
    { id: 'b', division: 'U10', buddyId: 'a', coachId: 'coach-2' },
  ];

  assert.throws(
    () => generateTeams({ players, divisionConfigs, random: createDeterministicRandom() }),
    /conflicting coach assignments/i,
  );
});

test('records insufficient capacity overflow for buddy unit larger than roster', () => {
  const players = [
    { id: 'a', division: 'U10', buddyId: 'b' },
    { id: 'b', division: 'U10', buddyId: 'a' },
  ];

  const { overflowByDivision, teamsByDivision, buddyDiagnosticsByDivision } = generateTeams({
    players,
    divisionConfigs: { U10: { maxRosterSize: 1 } },
    random: createDeterministicRandom(),
  });

  assert.equal(teamsByDivision.U10.length, 2);
  const overflow = overflowByDivision.U10;
  assert.equal(overflow.length, 1);
  assert.equal(overflow[0].reason, 'insufficient-capacity');
  assert.deepEqual(overflow[0].players.map((player) => player.id).sort(), ['a', 'b']);
  assert.deepEqual(overflow[0].metadata, { unitSize: 2 });
  assert.deepEqual(buddyDiagnosticsByDivision.U10.mutualPairs, [
    { playerIds: ['a', 'b'] },
  ]);
});

test('validates input arguments', () => {
  assert.throws(() => generateTeams({ players: null, divisionConfigs }), /players must be an array/i);
  assert.throws(
    () => generateTeams({ players: [], divisionConfigs: null }),
    /divisionconfigs must be an object/i,
  );
  assert.throws(
    () => generateTeams({ players: [], divisionConfigs, random: 'not-a-function' }),
    /random must be a function/i,
  );

  const missingId = [{ division: 'U10' }];
  assert.throws(
    () => generateTeams({ players: missingId, divisionConfigs }),
    /each player requires an id/i,
  );

  const missingDivision = [{ id: 'no-division' }];
  assert.throws(
    () => generateTeams({ players: missingDivision, divisionConfigs }),
    /is missing a division/i,
  );

  const players = [{ id: 'a', division: 'U11' }];
  assert.throws(
    () => generateTeams({ players, divisionConfigs }),
    /missing maxrostersize for division u11/i,
  );
});

test('reports unmatched buddy requests for missing or non-reciprocal pairs', () => {
  const players = [
    { id: 'a', division: 'U10', buddyId: 'missing-player' },
    { id: 'b', division: 'U10', buddyId: 'c' },
    { id: 'c', division: 'U10' },
  ];

  const { buddyDiagnosticsByDivision } = generateTeams({
    players,
    divisionConfigs,
    random: createDeterministicRandom(),
  });

  const diagnostics = buddyDiagnosticsByDivision.U10;
  assert.deepEqual(diagnostics.mutualPairs, []);
  assert.deepEqual(
    diagnostics.unmatchedRequests.sort((a, b) => a.playerId.localeCompare(b.playerId)),
    [
      {
        playerId: 'a',
        requestedBuddyId: 'missing-player',
        reason: 'missing-player',
      },
      {
        playerId: 'b',
        requestedBuddyId: 'c',
        reason: 'not-reciprocated',
      },
    ],
  );
});

test('flags self-referential buddy requests for review', () => {
  const players = [
    { id: 'solo', division: 'U10', buddyId: 'solo' },
  ];

  const { buddyDiagnosticsByDivision } = generateTeams({
    players,
    divisionConfigs,
    random: createDeterministicRandom(),
  });

  assert.deepEqual(buddyDiagnosticsByDivision.U10.mutualPairs, []);
  assert.deepEqual(buddyDiagnosticsByDivision.U10.unmatchedRequests, [
    { playerId: 'solo', requestedBuddyId: 'solo', reason: 'self-reference' },
  ]);
});

function createDeterministicRandom() {
  const modulus = 2147483647;
  let state = 42;

  return () => {
    state = (state * 48271) % modulus;
    return state / modulus;
  };
}
