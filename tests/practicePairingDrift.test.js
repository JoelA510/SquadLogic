// @vitest-environment node
import { it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runOptimizerJob } from '../frontend/src/workers/practiceOptimizer.worker.js';
import { encodeSolverInput } from '../supabase/functions/_shared/engines/solver-input.ts';
import { runPracticeOptimizer } from '../supabase/functions/_shared/engines/auto-scheduler-solver.ts';
import { prepareTeam } from '../supabase/functions/_shared/engines/practice-coaches.ts';
import { readLeague, REFERENCE_SEASON } from '../scripts/build-demo-practice-seed.mjs';
import { sweepRuns } from '../scripts/generate-solver-golden.mjs';

const expected = {
  season: {
    edge: '4a29c66bbb037d81906a378a6220bc37a656ea5d7081834e45dca26352b7639d',
    worker: 'c2f07de51a4e74ea7123c195d8b598dc9a3a49ea7c453c4af48473d1ef663fab',
    placements: 132,
  },
  demo: {
    edge: 'c11822280a76c1b439205aa80d6cf0784ce4b65d45ba6b83d15db70390c1bdf1',
    worker: 'a5a646c9c2dc77572d353b7c1f3a1d7023ef7251f0e9e61a59339843e3cad8af',
    placements: 252,
  },
};
const extract = JSON.parse(
  readFileSync('supabase/functions/_shared/tests/fixtures/scoring-parity.season-2026.json', 'utf8')
);
const {
  config: _unusedConfig,
  cpuCapMs: _unusedCap,
  ...season
} = sweepRuns(extract, prepareTeam, '2026-08-10')[0].input;
const league = readLeague();
const demo = {
  teams: league.teams.map((t) => ({ ...t, ...prepareTeam(t) })),
  slots: league.slots.map((s) => s.slot),
  locked: [],
  placeableTeamIds: league.teams.map((t) => t.id),
  unitsNeeded: Object.fromEntries(league.teams.map((t) => [t.id, t.practicesPerWeek])),
  dating: {
    liveFrom: REFERENCE_SEASON.start,
    slots: new Map(league.slots.map((s) => [s.slot.id, s.dating])),
  },
};
const digest = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const config = { seed: 42, maxIterations: 300, timeBudgetMs: 120000 };

for (const [fixture, input] of Object.entries({ season, demo })) {
  it(`preserves the complete unpaired ${fixture} results from the worker and server optimizer`, async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 7, 10, 12));
    try {
      const edge = await runPracticeOptimizer({ ...input, config });
      const messages = [];
      await runOptimizerJob(
        {
          type: 'run',
          input: encodeSolverInput(input, {
            organizationId: 'regression-org',
            seasonSettingsId: 'regression-season',
          }),
          config,
        },
        (m) => messages.push(m)
      );
      const worker = messages.at(-1);
      assert.equal(worker.type, 'result', worker.message);
      assert.deepEqual(
        worker.placements,
        edge.placements.map(({ source: _source, ...placement }) => placement)
      );
      assert.equal(edge.terminationReason, 'max-iterations');
      assert.equal(edge.placements.length, expected[fixture].placements);
      assert.equal(digest(edge), expected[fixture].edge);
      assert.equal(digest(worker), expected[fixture].worker);
    } finally {
      clock.mockRestore();
    }
  }, 30000);
}
