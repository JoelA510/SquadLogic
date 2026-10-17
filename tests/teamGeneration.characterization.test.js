/**
 * Characterization tests for `generateTeams` — they lock in the CURRENT fresh-allocation
 * behavior (no `existingSnapshot`) that the incremental teaming hardening PRs (02–09)
 * must preserve. See `docs/architecture/incremental-teaming-hardening.md`.
 *
 * These intentionally assert cross-cutting invariants rather than exact rosters, and they
 * complement (do not duplicate) the scenario assertions in `teamGeneration.test.js`.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { generateTeams } from '../packages/core/src/teamGeneration.js';
import {
  createDeterministicRandom,
  balancedDivisionScenario,
  mutualBuddyScenario,
  coachAnchorScenario,
  coachOverflowScenario,
} from './fixtures/incrementalTeamingFixtures.js';

test('characterization: later incremental params are ignored in fresh (no-snapshot) generation', () => {
  const { players, divisionConfigs } = balancedDivisionScenario({ count: 9 });

  const baseline = generateTeams({ players, divisionConfigs, random: createDeterministicRandom() });

  // Params introduced by later hardening PRs (02–08). Today `generateTeams` does not
  // destructure them, so a fresh run MUST be byte-identical. PR 04 must preserve this
  // when `existingSnapshot` is null / `generationMode` is 'draft'. Built as a variable so
  // checkJs does not flag the (currently unknown) extra properties as excess.
  const incrementalArgs = {
    players,
    divisionConfigs,
    random: createDeterministicRandom(),
    existingSnapshot: null,
    generationMode: 'draft',
    changePolicy: {},
    teamCountPolicy: 'auto',
  };
  const withIncrementalParams = generateTeams(incrementalArgs);

  assert.deepEqual(withIncrementalParams, baseline);
});

test('characterization: fresh generation conserves players (assigned ∪ overflow == input, none over cap)', () => {
  const scenarios = [
    balancedDivisionScenario(),
    mutualBuddyScenario(),
    coachAnchorScenario(),
    coachOverflowScenario(),
  ];

  for (const { players, divisionConfigs } of scenarios) {
    const { teamsByDivision, overflowByDivision } = generateTeams({
      players,
      divisionConfigs,
      random: createDeterministicRandom(),
    });
    const division = players[0].division;

    const assigned = (teamsByDivision[division] ?? []).flatMap((team) =>
      team.players.map((player) => player.id)
    );
    const overflowed = (overflowByDivision[division] ?? []).flatMap((unit) =>
      unit.players.map((player) => player.id)
    );
    const everyone = [...assigned, ...overflowed].sort();

    assert.deepEqual(
      everyone,
      players.map((player) => player.id).sort(),
      'every input player is assigned exactly once or overflowed'
    );
    assert.equal(new Set(everyone).size, players.length, 'no player appears twice');

    const maxRosterSize = divisionConfigs[division].maxRosterSize;
    (teamsByDivision[division] ?? []).forEach((team) => {
      assert.ok(team.players.length <= maxRosterSize, 'no team exceeds maxRosterSize');
    });
  }
});

test('characterization: mutual buddies are co-placed across a multi-team division (fresh generation)', () => {
  const { players, divisionConfigs } = mutualBuddyScenario();
  const { teamsByDivision, buddyDiagnosticsByDivision } = generateTeams({
    players,
    divisionConfigs,
    random: createDeterministicRandom(),
  });
  const teams = teamsByDivision.U10;

  // ≥2 teams means co-placement is a real decision — the buddies COULD have been split.
  assert.ok(
    teams.length >= 2,
    'scenario must produce multiple teams for co-placement to be meaningful'
  );

  const teamOfA = teams.find((team) => team.players.some((player) => player.id === 'buddy-a'));
  const teamOfB = teams.find((team) => team.players.some((player) => player.id === 'buddy-b'));
  assert.ok(teamOfA && teamOfB, 'both mutual buddies are placed');
  assert.equal(teamOfA.id, teamOfB.id, 'mutual buddies share one team');

  const pairs = buddyDiagnosticsByDivision.U10.mutualPairs;
  assert.equal(pairs.length, 1, 'exactly one mutual pair detected');
  assert.deepEqual([...pairs[0].playerIds].sort(), ['buddy-a', 'buddy-b']);
});

test('characterization: coach-anchored players land on their coach team in a multi-team division', () => {
  const { players, divisionConfigs } = coachAnchorScenario();
  const { teamsByDivision } = generateTeams({
    players,
    divisionConfigs,
    random: createDeterministicRandom(),
  });
  const teams = teamsByDivision.U10;

  // ≥2 teams, exactly one anchored to coach-1, plus a coachless alternative — so landing the
  // coached players on coach-1's team is a real decision, not a single-team tautology.
  assert.ok(
    teams.length >= 2,
    'scenario must produce multiple teams for anchoring to be meaningful'
  );
  const coachTeams = teams.filter((team) => team.coachId === 'coach-1');
  assert.equal(coachTeams.length, 1, 'exactly one team is anchored to coach-1');
  assert.ok(
    teams.some((team) => team.coachId !== 'coach-1'),
    'a non-coach-1 team exists as a placement alternative'
  );

  const coachTeam = coachTeams[0];
  assert.equal(coachTeam.coachNeeded, false, 'an anchored coach team is not coach-needed');
  const coachedIds = coachTeam.players.map((player) => player.id);
  assert.ok(
    coachedIds.includes('coached-a') && coachedIds.includes('coached-b'),
    "the coach's children are on the coach team, not the coachless one"
  );
});

test('characterization: coach-capacity overflow reason and metadata are stable in fresh generation', () => {
  const { players, divisionConfigs } = coachOverflowScenario();
  const { overflowByDivision, overflowSummaryByDivision } = generateTeams({
    players,
    divisionConfigs,
    random: createDeterministicRandom(),
  });

  const overflow = overflowByDivision.U10;
  assert.equal(overflow.length, 1, 'exactly one overflow unit');
  assert.equal(overflow[0].reason, 'coach-capacity');
  assert.equal(overflow[0].metadata.coachId, 'coach-1');
  assert.equal(overflowSummaryByDivision.U10.byReason['coach-capacity'].players, 1);
});

test('characterization: rosterBalanceByDivision summary exposes the documented keys', () => {
  const { players, divisionConfigs } = balancedDivisionScenario({ count: 9 });
  const { rosterBalanceByDivision } = generateTeams({
    players,
    divisionConfigs,
    random: createDeterministicRandom(),
  });

  const summary = rosterBalanceByDivision.U10.summary;
  for (const key of ['totalPlayers', 'totalCapacity', 'averageFillRate', 'teamsNeedingPlayers']) {
    assert.ok(key in summary, `rosterBalance summary exposes ${key}`);
  }
  assert.equal(summary.totalPlayers, 9);
});

// The incremental contract once registered here as six `test.todo` entries is
// implemented and tested (plan item M6.3, audit finding 6.5), so the todos are
// gone. Where each is covered:
// - team count kept after a player drops: teamGenerationIncremental.test.js
//   "preserves team count, ids, and names after a player drops (published
//   default)"; incrementalTeamingScenarios.test.js scenario 1.
// - team IDs kept from an existing snapshot: the same test; scenarios 8 and 8b.
// - a late player routed to their buddy's team: teamGenerationIncremental.test.js
//   "routes a late player onto their buddy's preserved team when capacity
//   allows"; scenario 3.
// - a full buddy target overflows with a specific reason: "overflows a late buddy
//   with buddy-target-capacity when the target team is full (no reshuffle)" and
//   "... buddy-target-locked when the target team is locked"; scenario 4.
// - an assistant-only coach unit backfills an existing team: scenario 7.
// - a dropped coach keeps the roster and marks the team coach-needed: scenario 5.
