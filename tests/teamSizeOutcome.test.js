/**
 * The outcome of a team run against its roster limits (Phase B4,
 * docs/changes/2026-10-22-phase-b-teaming.md): teams under the minimum, teams over the maximum,
 * and players not placed for lack of room, per division. Every result here is the real
 * generator's, fresh or on a rerun; the expected teams and players come from the inputs (the
 * roster limits, the player count), not from the helper's output.
 */
import { describe, expect, it } from 'vitest';
import { generateTeams } from '../packages/core/src/teamGeneration.js';
import { TEAM_GENERATION } from '../packages/core/src/constants.js';
import {
  CAPACITY_OVERFLOW_REASONS,
  summarizeTeamSizeOutcome,
} from '../packages/core/src/teamSizeOutcome.js';
import { buildTeamReviewSnapshot } from '../frontend/src/utils/teamReviewPersistence.js';
import { createDeterministicRandom } from './fixtures/incrementalTeamingFixtures.js';

const players = (count, prefix = 'p', extra = {}) =>
  Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${index + 1}`,
    division: 'U10',
    name: `Player ${prefix.toUpperCase()}${index + 1}`,
    ...extra,
  }));

const generate = (roster, config, rest = {}) =>
  generateTeams({
    players: roster,
    divisionConfigs: { U10: { id: 'U10', ...config } },
    random: createDeterministicRandom(),
    ...rest,
  });

const u10 = (summary) => summary?.divisions.find((division) => division.division === 'U10');

/** A published U10 snapshot of three teams, each already at the maximum of four. */
function fullSnapshot() {
  const team = (n, ids) => ({
    id: `uuid-team-${n}`,
    name: `Team ${n}`,
    division: 'U10',
    players: ids.map((id) => ({ id })),
  });
  return {
    status: 'published',
    runId: 'run-1',
    teamsByDivision: {
      U10: [
        team(1, ['s1', 's2', 's3', 's4']),
        team(2, ['s5', 's6', 's7', 's8']),
        team(3, ['s9', 's10', 's11', 's12']),
      ],
    },
  };
}
const SAVED = Array.from({ length: 12 }, (_, index) => ({ id: `s${index + 1}`, division: 'U10' }));

function overCapRerun() {
  return generate(
    [...SAVED, { id: 'late-1', division: 'U10', name: 'Late One' }],
    { maxRosterSize: 4 },
    {
      existingSnapshot: fullSnapshot(),
      generationMode: 'published',
      changePolicy: { allowOverCapAssignments: true },
    }
  );
}

describe('summarizeTeamSizeOutcome', () => {
  it('names the one team of a division with fewer players than the minimum roster', () => {
    // Six players and a minimum of eight: one team, and it is short.
    const outcome = u10(
      summarizeTeamSizeOutcome(generate(players(6), { maxRosterSize: 12, minRosterSize: 8 }))
    );
    expect(outcome.minRosterSize).toBe(8);
    expect(outcome.underMin).toEqual([
      { teamId: 'U10-T01', teamName: expect.any(String), playerCount: 6 },
    ]);
    expect(outcome.overMax).toEqual([]);
    expect(outcome.notPlacedForCapacity).toEqual([]);
  });

  it('counts every team the minimum-teams floor leaves short, from the rosters', () => {
    // Twenty players on at least three teams with a minimum of eight cannot all reach eight.
    const result = generate(players(20), { maxRosterSize: 10, minRosterSize: 8, minTeams: 3 });
    const outcome = u10(summarizeTeamSizeOutcome(result));
    const short = result.teamsByDivision.U10.filter((team) => team.players.length < 8).map(
      (team) => team.id
    );
    expect(short.length).toBeGreaterThan(0);
    expect(outcome.underMin.map((team) => team.teamId)).toEqual(short);
    expect(outcome.teamCount).toBe(3);
    expect(outcome.playersPlaced).toBe(20);
  });

  it('says no team is under a minimum nobody set, and reads the limits the run recorded', () => {
    const outcome = u10(summarizeTeamSizeOutcome(generate(players(9), { maxRosterSize: 10 })));
    expect(outcome.limitsRecorded).toBe(true);
    expect(outcome.minRosterSize).toBeNull();
    expect(outcome.maxRosterSize).toBe(10);
    expect(outcome.underMin).toEqual([]);
  });

  it('names a team a rerun pushes past the maximum when over-cap placement is allowed', () => {
    const result = overCapRerun();
    const outcome = u10(summarizeTeamSizeOutcome(result));
    // Three teams of four and a late player, with nowhere under the maximum of four.
    const seatedOn = result.teamsByDivision.U10.find((team) =>
      team.players.some((player) => player.id === 'late-1')
    );
    expect(outcome.maxRosterSize).toBe(4);
    expect(outcome.overMax).toEqual([
      { teamId: seatedOn.id, teamName: seatedOn.name, playerCount: 5 },
    ]);
    // The generator's own check agrees.
    expect(result.changeDiagnosticsByDivision.U10.capacityViolations).toEqual([
      { teamId: seatedOn.id, playerCount: 5, maxRosterSize: 4 },
    ]);
  });

  it('lists each player not placed for lack of room, with the reason, and only those', () => {
    // Thirty players, at most two teams of ten: ten have no room.
    const outcome = u10(
      summarizeTeamSizeOutcome(generate(players(30), { maxRosterSize: 10, maxTeams: 2 }))
    );
    expect(outcome.notPlacedForCapacity).toHaveLength(30 - 2 * 10);
    expect(
      outcome.notPlacedForCapacity.every(
        (entry) => entry.reason === TEAM_GENERATION.REASON_InsufficientCapacity
      )
    ).toBe(true);
    expect(outcome.overMax).toEqual([]);
  });

  it("counts a coach's child with no room on the coach's team, and not a blocked player", () => {
    // Three children of one coach and a maximum of two: one of them cannot join the coach.
    const roster = [
      ...players(3, 'c', { coachId: 'coach-1' }),
      ...players(2, 'g'),
      { id: 'old-1', division: 'U10', name: 'Too Old', placement: 'play_down_blocked' },
    ];
    const outcome = u10(summarizeTeamSizeOutcome(generate(roster, { maxRosterSize: 2 })));
    expect(outcome.notPlacedForCapacity).toEqual([
      expect.objectContaining({ reason: TEAM_GENERATION.REASON_CoachCapacity }),
    ]);
    expect(outcome.notPlacedForCapacity[0].playerId).toMatch(/^c\d$/);
    expect(CAPACITY_OVERFLOW_REASONS).not.toContain(TEAM_GENERATION.REASON_EligibilityBlocked);
  });

  it('does not report "no team over the maximum" for a run that recorded neither the limits nor the check', () => {
    const result = overCapRerun();
    // A run whose results kept the rosters but neither the per-team limits nor the rerun's own
    // check (an older stored run, or a fresh one stripped of its stats) was not checked.
    const { rosterBalanceByDivision: _limits, ...rest } = result;
    const unrecorded = {
      ...rest,
      changeDiagnosticsByDivision: {
        U10: { ...result.changeDiagnosticsByDivision.U10, capacityViolations: undefined },
      },
    };
    const outcome = u10(summarizeTeamSizeOutcome(unrecorded));
    expect(outcome.limitsRecorded).toBe(false);
    expect(outcome.overMax).toBeNull();
    expect(outcome.underMin).toBeNull();
    expect(outcome.maxRosterSize).toBeNull();

    // A fresh result never carries `capacityViolations`; with the limits recorded it is still
    // checked, from the rosters.
    const fresh = generate(players(9), { maxRosterSize: 10 });
    expect(fresh.changeDiagnosticsByDivision).toBeUndefined();
    expect(u10(summarizeTeamSizeOutcome(fresh)).overMax).toEqual([]);
  });

  it("falls back to the rerun's own check, by team name, when the limits were not recorded", () => {
    const result = overCapRerun();
    const { rosterBalanceByDivision: _limits, ...rest } = result;
    const outcome = u10(summarizeTeamSizeOutcome(rest));
    const seatedOn = result.teamsByDivision.U10.find((team) =>
      team.players.some((player) => player.id === 'late-1')
    );
    expect(outcome.maxRosterSize).toBe(4);
    expect(outcome.overMax).toEqual([
      { teamId: seatedOn.id, teamName: seatedOn.name, playerCount: 5 },
    ]);
  });

  it("reads a stored run's persisted team ids and the sizes its current rows give", () => {
    const result = generate(players(6), { maxRosterSize: 12, minRosterSize: 4 });
    const snapshot = buildTeamReviewSnapshot({
      generatedResult: result,
      divisionKey: 'U10',
      divisionId: '00000000-0000-4000-8000-000000000010',
      organizationId: 'org-1',
      seasonSettingsId: 'season-1',
      userId: 'user-1',
      selectedProgramId: 'U10',
      divisionConfig: { id: 'U10', maxRosterSize: 12, minRosterSize: 4 },
    });
    const stored = snapshot.runMetadata.results;
    const [team] = stored.teamsByDivision.U10;
    expect(u10(summarizeTeamSizeOutcome(stored)).underMin).toEqual([]);
    // A manual edit has since left three players on the team.
    const outcome = u10(
      summarizeTeamSizeOutcome(stored, { rosterSizeByTeamId: new Map([[team.id, 3]]) })
    );
    expect(outcome.underMin).toEqual([{ teamId: team.id, teamName: team.name, playerCount: 3 }]);
    expect(outcome.playersPlaced).toBe(3);
  });

  it('says nothing about a result with no rosters', () => {
    expect(summarizeTeamSizeOutcome(null)).toBeNull();
    expect(summarizeTeamSizeOutcome({ overflowByDivision: {} })).toBeNull();
    expect(summarizeTeamSizeOutcome({ teamsByDivision: {} })).toBeNull();
  });

  it('checks nothing it cannot see in a division the run built no teams for', () => {
    const outcome = u10(
      summarizeTeamSizeOutcome(
        generate([{ id: 'old-1', division: 'U10', placement: 'play_down_blocked' }], {
          maxRosterSize: 10,
        })
      )
    );
    expect(outcome.teamCount).toBe(0);
    expect(outcome.underMin).toEqual([]);
    expect(outcome.overMax).toEqual([]);
    expect(outcome.notPlacedForCapacity).toEqual([]);
  });
});
