/**
 * Eligibility honoured: one not-placed contract (Phase B2,
 * docs/changes/2026-10-22-phase-b-teaming.md).
 *
 * The golden (`tests/fixtures/teamGenerationEligibility.golden.json`) was generated on `main`
 * before B2 changed the generator, by `scripts/generate-teaming-eligibility-golden.mjs`: seeded
 * rosters in which no player is blocked must give the same output, byte for byte.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { TEAM_GENERATION } from '../packages/core/src/constants.js';
import { PLACEMENT } from '../packages/core/src/playUp.js';
import { summarizeTeamGeneration } from '../packages/core/src/teamDiagnostics.js';
import { generateTeams } from '../packages/core/src/teamGeneration.js';
import { prepareTeamingInput } from '../packages/core/src/teamingPipeline.js';
import {
  ELIGIBILITY_GOLDEN,
  eligibilityGoldenScenarios,
} from '../scripts/generate-teaming-eligibility-golden.mjs';

const GOLDEN = JSON.parse(readFileSync(path.join(process.cwd(), ELIGIBILITY_GOLDEN), 'utf8'));

const BLOCKED = new Set(['play_up_blocked', 'play_down_blocked']);

describe('no player blocked: the output is the golden from main, byte for byte', () => {
  const scenarios = eligibilityGoldenScenarios();

  it('the scenarios hold no blocked player and every other annotation', () => {
    // From the inputs, never the outputs: a scenario that lost its annotations, or that
    // blocked someone, would compare nothing B2 changes.
    const placements = new Set();
    for (const scenario of Object.values(scenarios)) {
      for (const player of scenario.players) {
        expect(BLOCKED.has(player.placement)).toBe(false);
        placements.add(player.placement ?? 'none');
      }
    }
    expect([...placements].sort()).toEqual(['in_band', 'none', 'play_up_sanctioned', 'unknown']);
    expect(Object.keys(GOLDEN.scenarios).sort()).toEqual(Object.keys(scenarios).sort());
  });

  for (const [name, scenario] of Object.entries(scenarios)) {
    it(`${name}: matches the golden`, () => {
      const output = JSON.parse(JSON.stringify(generateTeams(/** @type {any} */ (scenario))));
      const golden = GOLDEN.scenarios[name];
      // Every input player is in the golden once (placed or in overflow), from the roster.
      const seen = [
        ...Object.values(golden.teamsByDivision).flatMap((teams) =>
          teams.flatMap((team) => team.players.map((player) => player.id))
        ),
        ...Object.values(golden.overflowByDivision).flatMap((entries) =>
          entries.flatMap((entry) => entry.players.map((player) => player.id))
        ),
      ];
      expect(seen.sort()).toEqual(scenario.players.map((player) => player.id).sort());

      // B2's one new key on a rerun: present on every incremental division, and empty when
      // nobody is blocked; absent from a fresh run (no change diagnostics at all).
      if (scenario.existingSnapshot) {
        const divisions = Object.keys(output.changeDiagnosticsByDivision);
        expect(divisions.length).toBeGreaterThan(0);
        for (const division of divisions) {
          const changes = output.changeDiagnosticsByDivision[division];
          expect(changes.eligibilityHolds).toEqual([]);
          delete changes.eligibilityHolds;
        }
      } else {
        expect(output.changeDiagnosticsByDivision).toBeUndefined();
      }
      expect(JSON.stringify(output)).toBe(JSON.stringify(golden));
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Blocked players: annotated by the real pipeline (`prepareTeamingInput` →
// `applyPlayUpEligibility`), as the Teams page does, never forged.
// ---------------------------------------------------------------------------------------------

const SEASON = 2026;
const U10 = [{ id: 'U10', name: 'U10', min_age: 10, max_age: 10 }];
const IN_BAND_DOB = '2016-05-01'; // natural age 10
const PLAY_DOWN_DOB = '2013-05-01'; // natural age 13: play-down, never permitted
const PLAY_UP_DOB = '2018-05-01'; // natural age 8: play-up with no coaching parent or buddy

/** The page's single-division pipeline call (`remapBlocked: false`). */
function prepare(players, coaches = []) {
  return prepareTeamingInput({
    players,
    coaches,
    divisions: U10,
    seasonYear: SEASON,
    cutoffMode: 'birth_year',
    remapBlocked: false,
  }).players;
}

/** A division config with a roster of four (`teamsCount` is unread by the generator). */
const config = (id) => ({ id, teamsCount: 1, slotsPerWeek: 0, maxRosterSize: 4 });

/** @returns {any} an engine player before the pipeline annotates it */
const kid = (id, dob = IN_BAND_DOB, extra = {}) => ({ id, division: 'U10', dob, ...extra });
const fillers = (count, prefix = 'f') =>
  Array.from({ length: count }, (_, i) =>
    kid(`${prefix}${i + 1}`, IN_BAND_DOB, { skillRating: i })
  );

const seatedIds = (result, division = 'U10') =>
  (result.teamsByDivision[division] ?? []).flatMap((team) => team.players.map((p) => String(p.id)));
const overflowIds = (result, division = 'U10') =>
  (result.overflowByDivision[division] ?? []).flatMap((entry) =>
    entry.players.map((p) => String(p.id))
  );
const eligibilityEntries = (result, division = 'U10') =>
  (result.overflowByDivision[division] ?? []).filter(
    (entry) => entry.reason === TEAM_GENERATION.REASON_EligibilityBlocked
  );

/** Every input player is seated or in overflow, exactly once (enumerated from the input). */
function expectConserved(result, inputPlayers, division = 'U10') {
  const seen = [...seatedIds(result, division), ...overflowIds(result, division)];
  expect(seen.sort()).toEqual(inputPlayers.map((p) => String(p.id)).sort());
}

describe('fresh generation: a blocked player is not placed, and says why', () => {
  it('the reason constant is the plan’s', () => {
    expect(TEAM_GENERATION.REASON_EligibilityBlocked).toBe('eligibility-blocked');
  });

  it('a play-down and an unsanctioned play-up are in overflow with the reason, on no team', () => {
    const input = [kid('down', PLAY_DOWN_DOB), kid('up', PLAY_UP_DOB), ...fillers(6)];
    const players = prepare(input);
    // The pipeline really blocks them (the state the page produces).
    expect(players.find((p) => p.id === 'down').placement).toBe(PLACEMENT.PLAY_DOWN_BLOCKED);
    expect(players.find((p) => p.id === 'up').placement).toBe(PLACEMENT.PLAY_UP_BLOCKED);

    const result = generateTeams({
      players,
      divisionConfigs: { U10: config('U10') },
      seed: 'b2',
    });

    expect(seatedIds(result)).not.toContain('down');
    expect(seatedIds(result)).not.toContain('up');
    const entries = eligibilityEntries(result);
    expect(entries.map((entry) => entry.players.map((p) => p.id))).toEqual([['down'], ['up']]);
    expect(entries[0].metadata).toEqual({
      placement: 'play_down_blocked',
      reviewReason: 'play-down is not permitted',
      naturalAge: 13,
      coachId: null,
    });
    expect(entries[1].metadata).toEqual({
      placement: 'play_up_blocked',
      reviewReason: 'unsanctioned play-up (no coaching parent or qualifying buddy)',
      naturalAge: 8,
      coachId: null,
    });
    expectConserved(result, input);
    expect(result.overflowSummaryByDivision.U10.byReason).toEqual({
      'eligibility-blocked': { units: 2, players: 2 },
    });
    // The run summary rolls the reason up like any other.
    const summary = summarizeTeamGeneration(result);
    expect(summary.divisions[0].overflowPlayersByReason['eligibility-blocked']).toBe(2);
    expect(summary.totals.overflowPlayers).toBe(2);
  });

  it('blocked players do not count toward the team count', () => {
    // Eight eligible players and four blocked, rosters of four: two teams, not three.
    const input = [...fillers(8), ...['d1', 'd2', 'd3', 'd4'].map((id) => kid(id, PLAY_DOWN_DOB))];
    const result = generateTeams({
      players: prepare(input),
      divisionConfigs: { U10: config('U10') },
      seed: 'b2',
    });
    expect(result.teamsByDivision.U10).toHaveLength(2);
    expect(eligibilityEntries(result)).toHaveLength(4);
    expectConserved(result, input);
  });

  it('a blocked coach’s child anchors no team, and the metadata names the coach', () => {
    const input = [kid('coach-kid', PLAY_DOWN_DOB), ...fillers(4)];
    const players = prepare(input, [{ id: 'coach-x', player_id: 'coach-kid' }]);
    expect(players.find((p) => p.id === 'coach-kid').coachId).toBe('coach-x');

    const result = generateTeams({
      players,
      divisionConfigs: { U10: config('U10') },
      seed: 'b2',
    });
    expect(result.teamsByDivision.U10.map((team) => team.coachId)).not.toContain('coach-x');
    expect(result.teamsByDivision.U10).toHaveLength(1);
    expect(eligibilityEntries(result)[0].metadata.coachId).toBe('coach-x');
    expect(result.coachCoverageByDivision.U10.volunteerCoaches).toBe(0);
    expectConserved(result, input);
  });

  it('a blocked player’s mutual buddy is placed alone, with buddy-not-placed', () => {
    const input = [
      kid('blocked-a', PLAY_DOWN_DOB, { buddyId: 'buddy-b' }),
      kid('buddy-b', IN_BAND_DOB, { buddyId: 'blocked-a' }),
      // A one-way request for the blocked player keeps today's reason.
      kid('asker-c', IN_BAND_DOB, { buddyId: 'blocked-a' }),
      ...fillers(5),
    ];
    const result = generateTeams({
      players: prepare(input),
      divisionConfigs: { U10: config('U10') },
      seed: 'b2',
    });
    expect(seatedIds(result)).toContain('buddy-b');
    expect(seatedIds(result)).not.toContain('blocked-a');
    const buddies = result.buddyDiagnosticsByDivision.U10;
    expect(buddies.mutualPairs).toEqual([]);
    expect(buddies.unmatchedRequests).toEqual([
      { playerId: 'buddy-b', requestedBuddyId: 'blocked-a', reason: 'buddy-not-placed' },
      { playerId: 'asker-c', requestedBuddyId: 'blocked-a', reason: 'not-reciprocated' },
    ]);
    expectConserved(result, input);
  });

  it('two blocked buddies both overflow; neither is placed', () => {
    const input = [
      kid('x', PLAY_DOWN_DOB, { buddyId: 'y' }),
      kid('y', PLAY_UP_DOB, { buddyId: 'x' }),
      ...fillers(3),
    ];
    const result = generateTeams({
      players: prepare(input),
      divisionConfigs: { U10: config('U10') },
      seed: 'b2',
    });
    expect(eligibilityEntries(result).flatMap((e) => e.players.map((p) => p.id))).toEqual([
      'x',
      'y',
    ]);
    expect(result.buddyDiagnosticsByDivision.U10.unmatchedRequests).toEqual([]);
    expectConserved(result, input);
  });

  it('unknown (no natural age) is placed and flagged, never blocked (owner decision 3)', () => {
    const input = [kid('no-dob', undefined), ...fillers(3)];
    delete input[0].dob;
    const players = prepare(input);
    expect(players.find((p) => p.id === 'no-dob').placement).toBe(PLACEMENT.UNKNOWN);
    const result = generateTeams({
      players,
      divisionConfigs: { U10: config('U10') },
      seed: 'b2',
    });
    const seated = /** @type {any[]} */ (
      result.teamsByDivision.U10.flatMap((team) => team.players)
    );
    expect(seated.find((p) => p.id === 'no-dob')?.placement).toBe('unknown');
    expect(result.overflowByDivision.U10).toEqual([]);
  });

  it('a sanctioned play-up (a coaching parent) is placed on the coach’s team', () => {
    const input = [kid('coach-up', PLAY_UP_DOB), ...fillers(3)];
    const players = prepare(input, [{ id: 'coach-y', player_id: 'coach-up' }]);
    expect(players.find((p) => p.id === 'coach-up').placement).toBe(PLACEMENT.PLAY_UP_SANCTIONED);
    const result = generateTeams({
      players,
      divisionConfigs: { U10: config('U10') },
      seed: 'b2',
    });
    const coachTeam = result.teamsByDivision.U10.find((team) => team.coachId === 'coach-y');
    expect(coachTeam.players.map((p) => p.id)).toContain('coach-up');
    expect(eligibilityEntries(result)).toEqual([]);
  });
});

/** A reviewed roster: two UUID teams, one locked, with a manual move. */
function reviewedSnapshot() {
  return {
    status: 'review',
    runId: 'run-b2',
    teamsByDivision: {
      U10: [
        {
          id: '0b2e0000-0000-4000-8000-0000000000a1',
          name: 'Team A',
          division: 'U10',
          coachId: null,
          players: [
            { id: 'rostered-blocked', assignment_source: 'auto' },
            { id: 'f1', assignment_source: 'manual' },
            { id: 'f2', assignment_source: 'auto' },
          ],
        },
        {
          id: '0b2e0000-0000-4000-8000-0000000000a2',
          name: 'Team B',
          division: 'U10',
          coachId: null,
          locked: true,
          players: [
            { id: 'locked-blocked', assignment_source: 'auto' },
            { id: 'f3', assignment_source: 'auto' },
          ],
        },
      ],
    },
  };
}

describe('incremental generation: a rostered blocked player stays and is listed', () => {
  const rerun = (input, extra = {}) =>
    generateTeams({
      players: prepare(input),
      divisionConfigs: { U10: config('U10') },
      seed: 'b2',
      existingSnapshot: reviewedSnapshot(),
      generationMode: 'review',
      ...extra,
    });

  it('keeps the blocked player on their reviewed team, with the team UUID, in eligibilityHolds', () => {
    const input = [
      kid('rostered-blocked', PLAY_DOWN_DOB),
      kid('locked-blocked', PLAY_UP_DOB),
      ...fillers(3),
    ];
    const result = rerun(input);
    const teams = result.teamsByDivision.U10;
    expect(teams.map((team) => team.id)).toEqual([
      '0b2e0000-0000-4000-8000-0000000000a1',
      '0b2e0000-0000-4000-8000-0000000000a2',
    ]);
    expect(teams[0].players.map((p) => p.id)).toEqual(['rostered-blocked', 'f1', 'f2']);
    expect(teams[1].players.map((p) => p.id)).toEqual(['locked-blocked', 'f3']);
    // The manual move is still manual (and locked in review mode).
    expect(teams[0].players[1]).toMatchObject({ assignment_source: 'manual', locked: true });
    expect(result.changeDiagnosticsByDivision.U10.eligibilityHolds).toEqual([
      {
        playerId: 'rostered-blocked',
        teamId: '0b2e0000-0000-4000-8000-0000000000a1',
        placement: 'play_down_blocked',
        reviewReason: 'play-down is not permitted',
      },
      {
        playerId: 'locked-blocked',
        teamId: '0b2e0000-0000-4000-8000-0000000000a2',
        placement: 'play_up_blocked',
        reviewReason: 'unsanctioned play-up (no coaching parent or qualifying buddy)',
      },
    ]);
    expect(eligibilityEntries(result)).toEqual([]);
    expectConserved(result, input);
  });

  it('a blocked late player overflows with the reason and counts as overflowed', () => {
    const input = [
      kid('rostered-blocked', IN_BAND_DOB),
      kid('locked-blocked', IN_BAND_DOB),
      ...fillers(3),
      kid('late-blocked', PLAY_DOWN_DOB),
      kid('late-ok', IN_BAND_DOB),
    ];
    const result = rerun(input);
    expect(seatedIds(result)).not.toContain('late-blocked');
    expect(seatedIds(result)).toContain('late-ok');
    const entries = eligibilityEntries(result);
    expect(entries).toHaveLength(1);
    expect(entries[0].players.map((p) => p.id)).toEqual(['late-blocked']);
    expect(entries[0].metadata).toMatchObject({ placement: 'play_down_blocked', naturalAge: 13 });
    const changes = result.changeDiagnosticsByDivision.U10;
    expect(changes.eligibilityHolds).toEqual([]);
    expect(changes.latePlayersOverflowed).toBe(1);
    expect(changes.latePlayersAssigned).toBe(1);
    expectConserved(result, input);
  });

  it('a blocked late player’s late mutual buddy is placed alone, with buddy-not-placed', () => {
    const input = [
      kid('rostered-blocked', IN_BAND_DOB),
      kid('locked-blocked', IN_BAND_DOB),
      ...fillers(3),
      kid('late-blocked', PLAY_UP_DOB, { buddyId: 'late-buddy' }),
      kid('late-buddy', IN_BAND_DOB, { buddyId: 'late-blocked' }),
    ];
    const result = rerun(input);
    expect(seatedIds(result)).toContain('late-buddy');
    expect(seatedIds(result)).not.toContain('late-blocked');
    expect(result.buddyDiagnosticsByDivision.U10.unmatchedRequests).toEqual([
      { playerId: 'late-buddy', requestedBuddyId: 'late-blocked', reason: 'buddy-not-placed' },
    ]);
    expectConserved(result, input);
  });

  it('a division with nothing preserved runs fresh semantics and still blocks', () => {
    // A draft rerun whose snapshot holds only U10: U12 takes the fresh path.
    const u12 = [
      { id: 'u12-down', division: 'U12', dob: '2010-05-01' },
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `u12-${i}`,
        division: 'U12',
        dob: '2014-05-01',
      })),
    ];
    const players = prepareTeamingInput({
      players: [...[kid('rostered-blocked'), kid('locked-blocked'), ...fillers(3)], ...u12],
      divisions: [...U10, { id: 'U12', name: 'U12', min_age: 12, max_age: 12 }],
      seasonYear: SEASON,
      cutoffMode: 'birth_year',
      remapBlocked: false,
    }).players;
    const result = generateTeams({
      players,
      divisionConfigs: {
        U10: config('U10'),
        U12: config('U12'),
      },
      seed: 'b2',
      existingSnapshot: reviewedSnapshot(),
      generationMode: 'draft',
    });
    expect(seatedIds(result, 'U12')).not.toContain('u12-down');
    expect(eligibilityEntries(result, 'U12').map((e) => e.players[0].id)).toEqual(['u12-down']);
    expect(result.changeDiagnosticsByDivision.U12.eligibilityHolds).toEqual([]);
    expect(result.changeDiagnosticsByDivision.U12.latePlayersOverflowed).toBe(1);
    expectConserved(result, u12, 'U12');
  });
});

describe('review findings (B2)', () => {
  it('a division where every player is blocked builds no empty teams', () => {
    const input = ['d1', 'd2', 'd3'].map((id) => kid(id, PLAY_DOWN_DOB));
    const result = generateTeams({
      players: prepare(input),
      divisionConfigs: { U10: { ...config('U10'), teamCountOverride: 3 } },
      seed: 'b2',
    });
    expect(result.teamsByDivision.U10).toEqual([]);
    expect(eligibilityEntries(result)).toHaveLength(3);
    expectConserved(result, input);
  });

  it('a player remapBlocked moved to their natural division is placed there', () => {
    // A multi-division flow may remap (prepareTeamingInput's remapBlocked: true): the moved
    // player keeps the placement judged in the division they registered in.
    const input = [
      kid('moved', PLAY_DOWN_DOB),
      ...fillers(3),
      ...['a', 'b', 'c'].map((id) => ({ id: `u13-${id}`, division: 'U13', dob: PLAY_DOWN_DOB })),
    ];
    const players = prepareTeamingInput({
      players: input,
      divisions: [...U10, { id: 'U13', name: 'U13', min_age: 13, max_age: 13 }],
      seasonYear: SEASON,
      cutoffMode: 'birth_year',
      remapBlocked: true,
    }).players;
    const moved = players.find((p) => p.id === 'moved');
    expect(moved).toMatchObject({ division: 'U13', registeredDivision: 'U10' });
    expect(moved.placement).toBe(PLACEMENT.PLAY_DOWN_BLOCKED);

    const result = generateTeams({
      players,
      divisionConfigs: { U10: config('U10'), U13: config('U13') },
      seed: 'b2',
    });
    expect(seatedIds(result, 'U13')).toContain('moved');
    expect(eligibilityEntries(result, 'U13')).toEqual([]);
  });

  it('a blocked assistant’s child is named in the metadata', () => {
    const input = [kid('asst-kid', PLAY_UP_DOB, { assistantCoachId: 'asst-z' }), ...fillers(3)];
    const result = generateTeams({
      players: prepare(input),
      divisionConfigs: { U10: config('U10') },
      seed: 'b2',
    });
    expect(eligibilityEntries(result)[0].metadata).toEqual({
      placement: 'play_up_blocked',
      reviewReason: 'unsanctioned play-up (no coaching parent or qualifying buddy)',
      naturalAge: 8,
      coachId: null,
      assistantCoachId: 'asst-z',
    });
    expect(result.teamsByDivision.U10.flatMap((team) => team.assistantCoachIds)).toEqual([]);
  });
});
