import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTeams } from '../src/teamGeneration.js';
import { summarizeTeamGeneration } from '../src/teamDiagnostics.js';

function createDeterministicRandom() {
  const modulus = 2147483647;
  let state = 123456;
  return () => {
    state = (state * 1103515245 + 12345) % modulus;
    return state / modulus;
  };
}

test('summarizeTeamGeneration aggregates per-division diagnostics', () => {
  const players = [
    { id: 'u10-a', division: 'U10', buddyId: 'u10-b' },
    { id: 'u10-b', division: 'U10', buddyId: 'u10-a' },
    { id: 'u10-c', division: 'U10' },
    { id: 'u10-d', division: 'U10', buddyId: 'missing-player' },
    { id: 'u10-e', division: 'U10' },
    { id: 'u12-a', division: 'U12', coachId: 'coach-1' },
    { id: 'u12-b', division: 'U12', coachId: 'coach-1' },
    { id: 'u12-c', division: 'U12', coachId: 'coach-1' },
    { id: 'u12-d', division: 'U12', coachId: 'coach-1' },
    { id: 'u12-e', division: 'U12', coachId: 'coach-1' },
  ];

  const divisionConfigs = {
    U10: { maxRosterSize: 3 },
    U12: { maxRosterSize: 4 },
  };

  const teamResult = generateTeams({
    players,
    divisionConfigs,
    random: createDeterministicRandom(),
  });

  const summary = summarizeTeamGeneration(teamResult);

  assert.deepEqual(summary.totals, {
    divisions: 2,
    teams: 4,
    playersAssigned: 9,
    overflowPlayers: 1,
    divisionsNeedingCoaches: 2,
    divisionsWithOpenRosterSlots: 2,
  });

  assert.equal(summary.divisions.length, 2);
  const [u10, u12] = summary.divisions;

  assert.equal(u10.divisionId, 'U10');
  assert.equal(u10.totalTeams, 2);
  assert.equal(u10.playersAssigned, 5);
  assert.equal(u10.totalCapacity, 6);
  assert.equal(u10.slotsRemaining, 1);
  assert.equal(u10.mutualBuddyPairs, 1);
  assert.equal(u10.unmatchedBuddyCount, 1);
  assert.deepEqual(u10.unmatchedBuddyReasons, { 'missing-player': 1 });
  assert.equal(u10.needsAdditionalCoaches, true);
  assert.equal(u10.overflowUnits, 0);
  assert.equal(u10.overflowPlayers, 0);
  assert.deepEqual(u10.overflowByReason, {});
  assert.deepEqual(u10.overflowPlayersByReason, {});

  assert.equal(u12.divisionId, 'U12');
  assert.equal(u12.totalTeams, 2);
  assert.equal(u12.playersAssigned, 4);
  assert.equal(u12.totalCapacity, 8);
  assert.equal(u12.slotsRemaining, 4);
  assert.equal(u12.needsAdditionalCoaches, true);
  assert.equal(u12.overflowUnits, 1);
  assert.equal(u12.overflowPlayers, 1);
  assert.deepEqual(u12.overflowByReason, { 'coach-capacity': 1 });
  assert.deepEqual(u12.overflowPlayersByReason, { 'coach-capacity': 1 });
});

test('summarizeTeamGeneration validates inputs', () => {
  assert.throws(() => summarizeTeamGeneration(null), /result must be an object/i);

  assert.throws(
    () =>
      summarizeTeamGeneration({
        teamsByDivision: null,
        overflowByDivision: {},
        buddyDiagnosticsByDivision: {},
        coachCoverageByDivision: {},
        rosterBalanceByDivision: {},
      }),
    /teamsbydivision must be an object/i,
  );
});

test('summarizeTeamGeneration defaults coverage and aggregates roster stats', () => {
  const result = {
    teamsByDivision: { U8: [{ id: 'team-1' }] },
    overflowByDivision: {},
    buddyDiagnosticsByDivision: {},
    coachCoverageByDivision: {},
    rosterBalanceByDivision: {
      U8: {
        teamStats: [
          { playerCount: 6, maxRosterSize: 8, slotsRemaining: 2 },
          { playerCount: 5, maxRosterSize: 7, slotsRemaining: 2 },
        ],
        summary: { averageFillRate: 0.75, teamsNeedingPlayers: ['team-1'] },
      },
    },
  };

  const summary = summarizeTeamGeneration(result);

  assert.equal(summary.totals.playersAssigned, 11);
  assert.equal(summary.totals.divisionsWithOpenRosterSlots, 1);
  assert.equal(summary.divisions[0].playersAssigned, 11);
  assert.equal(summary.divisions[0].totalCapacity, 15);
  assert.equal(summary.divisions[0].slotsRemaining, 4);
  assert.equal(summary.divisions[0].coachCoverage.totalTeams, 0);
  assert.equal(summary.divisions[0].needsAdditionalCoaches, false);
});

test('summarizeTeamGeneration leverages overflow summaries for player counts', () => {
  const result = {
    teamsByDivision: { U9: [{ id: 'team-u9-a' }] },
    overflowByDivision: { U9: [] },
    overflowSummaryByDivision: {
      U9: {
        totalUnits: 2,
        totalPlayers: 3,
        byReason: {
          'coach-capacity': { units: 1, players: 2 },
          'sibling-group': { units: 1, players: 1 },
        },
      },
    },
    buddyDiagnosticsByDivision: {},
    coachCoverageByDivision: {},
    rosterBalanceByDivision: {
      U9: {
        teamStats: [
          { playerCount: 0, maxRosterSize: 10, slotsRemaining: 10 },
        ],
        summary: { averageFillRate: 0, teamsNeedingPlayers: ['team-u9-a'] },
      },
    },
  };

  const summary = summarizeTeamGeneration(result);

  assert.equal(summary.divisions.length, 1);
  const division = summary.divisions[0];
  assert.equal(division.overflowUnits, 2);
  assert.equal(division.overflowPlayers, 3);
  assert.deepEqual(division.overflowByReason, {
    'coach-capacity': 1,
    'sibling-group': 1,
  });
  assert.deepEqual(division.overflowPlayersByReason, {
    'coach-capacity': 2,
    'sibling-group': 1,
  });
  assert.equal(summary.totals.overflowPlayers, 3);
});
