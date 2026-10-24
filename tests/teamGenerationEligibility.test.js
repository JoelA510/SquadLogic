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

import { generateTeams } from '../packages/core/src/teamGeneration.js';
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
      const output = JSON.parse(JSON.stringify(generateTeams(scenario)));
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

      // B2's one new key on a rerun: present, and empty when nobody is blocked.
      for (const changes of Object.values(output.changeDiagnosticsByDivision ?? {})) {
        if ('eligibilityHolds' in changes) {
          expect(changes.eligibilityHolds).toEqual([]);
          delete changes.eligibilityHolds;
        }
      }
      expect(JSON.stringify(output)).toBe(JSON.stringify(golden));
    });
  }
});
