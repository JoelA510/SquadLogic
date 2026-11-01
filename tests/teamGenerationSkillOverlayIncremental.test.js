/**
 * A stored skill tier now overlays the registration file's on the Teams page (E3c, Codex P1 on
 * #684): an evaluations import can change the `skillRating` of players whose rosters were already
 * reviewed, published or locked. The incremental-teaming rule (docs/architecture/
 * incremental-teaming-hardening.md) is that a re-run never reshuffles such a roster, so this holds
 * it against exactly that input change: the same snapshot and the same newcomers, with the
 * existing players' `skillRating` all different, in every re-run mode.
 *
 * What may differ is where a NEWCOMER is seated and the team's skill totals (they are sums of the
 * input); what may not is any existing player's team, or the teams' ids and names.
 */
import { describe, expect, it } from 'vitest';
import { generateTeams } from '../packages/core/src/teamGeneration.js';
import { createDeterministicRandom } from './fixtures/incrementalTeamingFixtures.js';

const CONFIG = { id: 'U10', teamsCount: 3, slotsPerWeek: 4, maxRosterSize: 5 };
const EXISTING = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'];
const SNAPSHOT_TEAM_OF = {
  p1: 'uuid-team-1',
  p2: 'uuid-team-1',
  p3: 'uuid-team-1',
  p4: 'uuid-team-2',
  p5: 'uuid-team-2',
  p6: 'uuid-team-2',
  p7: 'uuid-team-3',
  p8: 'uuid-team-3',
  p9: 'uuid-team-3',
};

const snapshot = (status) => ({
  status,
  runId: 'run-1',
  teamsByDivision: {
    U10: ['uuid-team-1', 'uuid-team-2', 'uuid-team-3'].map((id, i) => ({
      id,
      name: ['Raptors', 'Sharks', 'Wolves'][i],
      division: 'U10',
      locked: status === 'locked',
      players: EXISTING.filter((p) => SNAPSHOT_TEAM_OF[p] === id).map((p) => ({ id: p })),
    })),
  },
});

/** The existing players with the given tiers (as `toGeneratorPlayer` reads them), then two newcomers. */
const roster = (tiers) => [
  ...EXISTING.map((id, i) => ({ id, division: 'U10', skillRating: tiers[i] })),
  { id: 'n1', division: 'U10', skillRating: 5 },
  { id: 'n2', division: 'U10', skillRating: 1 },
];

const run = (players, mode) =>
  generateTeams({
    players,
    divisionConfigs: { U10: CONFIG },
    random: createDeterministicRandom(),
    featureFlags: { player_rating: true },
    existingSnapshot: snapshot(mode === 'locked' ? 'locked' : 'published'),
    generationMode: mode,
  });

const teamOf = (result) => {
  const map = new Map();
  for (const team of result.teamsByDivision.U10) {
    for (const player of team.players) map.set(player.id, team.id);
  }
  return map;
};

describe.each(['review', 'published', 'locked'])('a re-run in %s mode', (mode) => {
  // The registration file's tiers, and then every one of them different (the evaluations import).
  const before = run(roster([1, 1, 1, 3, 3, 3, 5, 5, 5]), mode);
  const after = run(roster([5, 5, 5, 3, 3, 3, 1, 1, 1]), mode);

  it('keeps every existing player on the team the snapshot has, whatever their tier', () => {
    for (const result of [before, after]) {
      const placed = teamOf(result);
      for (const id of EXISTING) expect(placed.get(id), id).toBe(SNAPSHOT_TEAM_OF[id]);
    }
  });

  it('keeps the teams, their ids and names; a locked team takes nobody, the others take both newcomers', () => {
    for (const result of [before, after]) {
      expect(result.teamsByDivision.U10.map((t) => [t.id, t.name])).toEqual([
        ['uuid-team-1', 'Raptors'],
        ['uuid-team-2', 'Sharks'],
        ['uuid-team-3', 'Wolves'],
      ]);
      const placed = teamOf(result);
      expect(placed.has('n1')).toBe(mode !== 'locked');
      expect(placed.has('n2')).toBe(mode !== 'locked');
    }
  });

  it("is a real input change: the teams' skill totals differ between the two runs", () => {
    // The control that makes the checks above mean something: the tiers did reach the generator.
    const totals = (result) => result.teamsByDivision.U10.map((t) => t.skillTotal);
    expect(totals(after)).not.toEqual(totals(before));
  });
});

it('CONTROL: a fresh run (no snapshot) does regroup the same players by skill, so the checks above can fail', () => {
  const fresh = generateTeams({
    players: roster([1, 1, 1, 3, 3, 3, 5, 5, 5]),
    divisionConfigs: { U10: CONFIG },
    random: createDeterministicRandom(),
    featureFlags: { player_rating: true },
  });
  const placed = teamOf(fresh);
  // p1 to p3 share a team in the snapshot; a fresh, skill-balanced run does not keep them together.
  expect(new Set(['p1', 'p2', 'p3'].map((id) => placed.get(id))).size).toBeGreaterThan(1);
});
