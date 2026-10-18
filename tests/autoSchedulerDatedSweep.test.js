// @vitest-environment node
/**
 * M4.8's minimal-diff promise, as a test (`docs/PLAN_SOLVER_DATE_MODEL.md` §4
 * point 4, §5 "The golden sweep", Q8): on the undated season-2026 corpus --
 * every slot and every locked row live on every date from today to the
 * season's end -- the dated solver's placements are byte-identical to the
 * undated solver's.
 *
 * The golden (`tests/fixtures/autoSchedulerDatedSweep.golden.json`) was
 * generated on `main` before M4.8 changed the solver, by
 * `scripts/generate-solver-golden.mjs`; this test runs today's solver over the
 * same grid (lock shares 0 / 0.5 / 0.9, seeds 1 / 2 / 3) at two "today"s and
 * compares. The subject set is the grid the generator defines and the
 * extract's roster, never the solver's output, and literal floors (132 / 71 /
 * 14 placed) make an empty or stale golden fail.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';

import { runPracticeOptimizer } from '../supabase/functions/_shared/engines/auto-scheduler-solver.js';
import { prepareTeam } from '../supabase/functions/_shared/engines/practice-coaches.js';
import { SOLVER_GOLDEN, SWEEP, goldenOf, sweepRuns } from '../scripts/generate-solver-golden.mjs';

const read = (file) => JSON.parse(readFileSync(path.join(process.cwd(), file), 'utf8'));
const GOLDEN = read(SOLVER_GOLDEN);
const EXTRACT = read('supabase/functions/_shared/tests/fixtures/scoring-parity.season-2026.json');

/** The plan's floors (§2.3), written out: placed per lock share, at every seed. */
const PLACED_FLOOR = { 0: 132, 0.5: 71, 0.9: 14 };
/**
 * Two todays (§2.3): the season's first day, before every slot's first
 * occurrence, and 2026-10-17, mid-season. Every corpus slot and locked row is
 * live on every date from either to the season's end, so neither may move a
 * placement.
 */
const TODAYS = ['2026-08-10', '2026-10-17'];

describe('the dated solver on the undated corpus: byte-identical to the undated golden (M4.8 §4)', () => {
  it('the golden covers the whole grid and holds the plan floors', () => {
    // Meta-assertions from the grid and the roster, not from the golden's own
    // shape: a golden that lost a run, or that recorded an empty schedule,
    // fails here rather than comparing nothing below.
    assert.equal(GOLDEN.runs.length, SWEEP.shares.length * SWEEP.seeds.length);
    for (const share of SWEEP.shares) {
      for (const seed of SWEEP.seeds) {
        const run = GOLDEN.runs.find((r) => r.share === share && r.seed === seed);
        assert.ok(run, `the golden has no run for share ${share}, seed ${seed}`);
        assert.equal(run.placements.length, PLACED_FLOOR[share], `share ${share}, seed ${seed}`);
        // Every placeable team is placed or unplaced, from the roster.
        assert.equal(run.placements.length + run.unassigned.length, run.placeable);
      }
    }
    assert.equal(EXTRACT.inputs.teams.length, 132);
    assert.equal(EXTRACT.inputs.slots.length, 142);
  });

  for (const today of TODAYS) {
    it(`today ${today}: every run's placements and unplaced teams match the golden`, async () => {
      const runs = sweepRuns(EXTRACT, prepareTeam, today);
      let compared = 0;
      for (const run of runs) {
        const golden = GOLDEN.runs.find((r) => r.share === run.share && r.seed === run.seed);
        const result = await runPracticeOptimizer(run.input);
        const label = `share ${run.share}, seed ${run.seed}, today ${today}`;
        assert.equal(run.placeable, golden.placeable, `${label}: the grid moved`);
        assert.deepEqual(goldenOf(result), {
          placements: golden.placements,
          unassigned: golden.unassigned,
        });
        // The run really was dated, and judged from this today.
        assert.equal(result.evaluation.summary.dateModel, 'dated', label);
        assert.equal(result.liveFrom, today, label);
        assert.deepEqual(result.endedRows, [], `${label}: a season-long row read as ended`);
        compared += 1;
      }
      assert.equal(compared, GOLDEN.runs.length, 'not every run was compared');
    }, 120_000);
  }
});
