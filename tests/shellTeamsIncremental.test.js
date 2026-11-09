/**
 * The second of the two checks of 4.5 (schedule expansion plan `docs/changes/2026-11-03-schedule-expansion.md`; PR 5,
 * task E2): a division that holds only empty team shells re-runs INTO them.
 *
 * An organization that arrives with a schedule has no teams, so the games import can create them as shells: a `teams`
 * row with a division and a name, no players and no coach, recorded in a team run's `results.teams` by the existing team
 * writer (the first check: `persist_team_schedule` accepts teams with no `team_players`; the pgTAP file
 * `supabase/tests/game_import_apply_rollback.sql` holds it). A later team generation reads the saved run, not the table
 * (finding 6), so it has to keep those teams, fill them, and not make a second team of the same name (which the table's
 * `UNIQUE (division_id, name)` would refuse).
 *
 * The rows below are shaped as the apply writes them into `results.teams` (an id, the division's id as the `division`
 * key and as `division_id`, a name, no players), and are read back the way the Teams page reads a saved run
 * (`buildExistingSnapshotForRerun`), then handed to `generateTeams` as an `existingSnapshot`. If either part failed the
 * plan says to stop: the smallest input is one division, two empty shells, twenty players.
 */
import { describe, expect, it } from 'vitest';
import { generateTeams } from '../packages/core/src/teamGeneration.js';
import { buildExistingSnapshotForRerun } from '../frontend/src/utils/teamReviewPersistence.js';
import { createDeterministicRandom } from './fixtures/incrementalTeamingFixtures.js';

const DIVISION_ID = '5a000000-0000-4000-8000-0000000000d1';
const SHELL_A = '5a000000-0000-4000-8000-0000000000a1';
const SHELL_B = '5a000000-0000-4000-8000-0000000000a2';

/** A saved team run's rows for the shells, as the games import writes them. */
const shellRow = (id, name) => ({
  id,
  organization_id: '5a000000-0000-4000-8000-0000000000f0',
  division: DIVISION_ID,
  division_id: DIVISION_ID,
  name,
  coach_id: null,
  assistant_coach_ids: [],
  players: [],
});

const persisted = (teamRows, teamPlayerRows = []) => ({
  payload: { teamRows, teamPlayerRows },
  payloadByDivision: { [DIVISION_ID]: { teamRows, teamPlayerRows } },
  lastRunId: 'run-shells',
  runHistory: [{ status: 'completed' }],
});

const players = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, division: DIVISION_ID }));
const CONFIG = {
  [DIVISION_ID]: { id: DIVISION_ID, teamsCount: 2, slotsPerWeek: 4, maxRosterSize: 10 },
};

describe('a division of two empty shells re-runs into them', () => {
  const snapshot = buildExistingSnapshotForRerun(
    persisted([shellRow(SHELL_A, 'Lions'), shellRow(SHELL_B, 'Tigers')]),
    { divisionKey: DIVISION_ID }
  );

  it('the saved run reads back as an existing snapshot of two teams with no players', () => {
    expect(snapshot).not.toBeNull();
    const teams = snapshot?.teamsByDivision[DIVISION_ID] ?? [];
    expect(teams.map((t) => t.id)).toEqual([SHELL_A, SHELL_B]);
    expect(teams.every((t) => t.players.length === 0)).toBe(true);
  });

  it('twenty players fill the two shells: same ids, same names, no third team, no second Lions', () => {
    const result = generateTeams({
      players: players(20),
      divisionConfigs: CONFIG,
      random: createDeterministicRandom(),
      existingSnapshot: snapshot,
      generationMode: 'draft',
    });
    const teams = result.teamsByDivision[DIVISION_ID];
    expect(teams.map((t) => t.id).sort()).toEqual([SHELL_A, SHELL_B].sort());
    expect(teams.map((t) => t.name).sort()).toEqual(['Lions', 'Tigers']);
    expect(teams.reduce((sum, t) => sum + t.players.length, 0)).toBe(20);
    expect(teams.every((t) => t.players.length > 0)).toBe(true);
    const diagnostics = result.changeDiagnosticsByDivision[DIVISION_ID];
    expect(diagnostics.existingTeamsPreserved).toBe(2);
    expect(diagnostics.newTeamsCreated).toBe(0);
  });

  it("CONTROL: with no saved run the same input makes two NEW teams (so keeping the shells is the snapshot's doing)", () => {
    const result = generateTeams({
      players: players(20),
      divisionConfigs: CONFIG,
      random: createDeterministicRandom(),
    });
    const teams = result.teamsByDivision[DIVISION_ID];
    expect(teams).toHaveLength(2);
    expect(teams.map((t) => t.id)).not.toContain(SHELL_A);
  });

  it("a run that held only the new shells and not the division's earlier teams would shadow them: the apply carries them", () => {
    // buildExistingSnapshotForRerun takes the newest run that holds a division as the whole of it, so a shell run of
    // only the new shells would make an earlier team look absent. The apply writes the division's earlier teams into
    // the shell run as well (pgTAP: "carries that run's teams with the new shell").
    const onlyNew = buildExistingSnapshotForRerun(persisted([shellRow(SHELL_B, 'Tigers')]), {
      divisionKey: DIVISION_ID,
    });
    expect(onlyNew?.teamsByDivision[DIVISION_ID].map((t) => t.id)).toEqual([SHELL_B]);
    const carried = buildExistingSnapshotForRerun(
      persisted([shellRow(SHELL_A, 'Lions'), shellRow(SHELL_B, 'Tigers')]),
      { divisionKey: DIVISION_ID }
    );
    expect(carried?.teamsByDivision[DIVISION_ID].map((t) => t.id)).toEqual([SHELL_A, SHELL_B]);
  });
});
