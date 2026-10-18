#!/usr/bin/env node
/**
 * Regenerate `tests/fixtures/autoSchedulerDatedSweep.golden.json`, the golden
 * the M4.8 minimal-diff promise is held to (`docs/PLAN_SOLVER_DATE_MODEL.md`
 * §4 point 4, §5 "The golden sweep", Q8).
 *
 * The sweep is the plan's §2.3 grid: the season-2026 parity extract
 * (`scoring-parity.season-2026.json`: 132 teams, 142 capacity-1 season-long
 * slots, 142 assignments from "93 Combined"), with the first
 * `round(share x 142)` assignments locked for lock shares 0 / 0.5 / 0.9, every
 * roster team without a locked row placeable, and the Edge solver
 * (`_shared/engines/auto-scheduler-solver.ts`) run at seeds 1 / 2 / 3 for 300
 * iterations. The golden records each run's placements and unplaced teams.
 *
 * **The committed golden was generated on `main` before M4.8 changed the
 * solver** (the commit it was taken at is in the file's `generatedAt`), so it
 * is the undated solver's answer. `tests/autoSchedulerDatedSweep.test.js` runs
 * the dated solver over the same grid, at two "today"s, and asserts the same
 * placements byte for byte. Re-running this script on a later tree records
 * that tree's answer instead: do it only when a change to the search is meant
 * to move the corpus, and quote every moved placement in the PR.
 *
 * The run passes the dated solver's inputs (`dating`), built from each slot's
 * own first occurrence and the season's last date: an undated solver ignores
 * them, so the same script produced the golden on `main`.
 *
 * The Edge module is TypeScript importing its siblings with `.ts` extensions,
 * so it is loaded through Vite's SSR loader (the transform Vitest uses).
 *
 *   node scripts/generate-solver-golden.mjs [--check]
 *   npx prettier --write tests/fixtures/autoSchedulerDatedSweep.golden.json
 *
 * `--check` regenerates in memory and exits non-zero when the committed file
 * differs, without writing it.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SOLVER_GOLDEN = 'tests/fixtures/autoSchedulerDatedSweep.golden.json';
const EXTRACT = 'supabase/functions/_shared/tests/fixtures/scoring-parity.season-2026.json';

/** The plan's §2.3 grid. */
export const SWEEP = Object.freeze({
  shares: [0, 0.5, 0.9],
  seeds: [1, 2, 3],
  maxIterations: 300,
  // Far above a run's cost, so the budget never ends a run and the answer
  // depends only on the seed.
  timeBudgetMs: 120_000,
  // The season the corpus slots run in (America/New_York, as the extract says).
  seasonEnd: '2026-11-20',
});

/** `HH:MM` minutes of an extract instant (`2026-09-15T16:00:00-04:00`), as written. */
const minutesOf = (iso) => Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));

/**
 * The dated solver's inputs for the corpus: each slot live from its own first
 * occurrence (the extract's week of 2026-09-14) to the season's end, on its
 * written wall window. Also used by the test, so both read one dating.
 */
export function corpusDating(rawSlots, liveFrom) {
  return {
    liveFrom,
    slots: new Map(
      rawSlots.map((s) => [
        s.id,
        {
          firstDate: s.start.slice(0, 10),
          effectiveUntil: SWEEP.seasonEnd,
          startMinutes: minutesOf(s.start),
          endMinutes: minutesOf(s.end),
        },
      ])
    ),
  };
}

/** The grid's runs, each as `{ share, seed, input }` for `runPracticeOptimizer`. */
export function sweepRuns(extract, prepareTeam, liveFrom) {
  const { teams: rawTeams, slots: rawSlots, assignments } = extract.inputs;
  const teams = rawTeams.map((t) => prepareTeam(t));
  const slots = rawSlots.map((s) => ({
    id: s.id,
    day: s.day,
    capacity: s.capacity,
    start: new Date(s.start),
    end: new Date(s.end),
  }));
  const runs = [];
  for (const share of SWEEP.shares) {
    const lockedRows = assignments.slice(0, Math.round(share * assignments.length));
    const lockedTeams = new Set(lockedRows.map((a) => a.teamId));
    const placeableTeamIds = rawTeams.map((t) => t.id).filter((id) => !lockedTeams.has(id));
    for (const seed of SWEEP.seeds) {
      runs.push({
        share,
        seed,
        locked: lockedRows.length,
        placeable: placeableTeamIds.length,
        input: {
          teams,
          slots,
          locked: lockedRows.map((a, i) => ({
            assignmentId: `L${i}`,
            teamId: a.teamId,
            slotId: a.slotId,
          })),
          placeableTeamIds,
          dating: corpusDating(rawSlots, liveFrom),
          config: {
            timeBudgetMs: SWEEP.timeBudgetMs,
            maxIterations: SWEEP.maxIterations,
            seed,
          },
        },
      });
    }
  }
  return runs;
}

/** What the golden keeps of one run: its placements and unplaced teams, in its own order. */
export const goldenOf = (run) => ({
  placements: run.placements.map((p) => `${p.teamId} -> ${p.slotId}`),
  unassigned: run.unassigned.map((u) => `${u.teamId}: ${u.reason}`),
});

async function main() {
  const check = process.argv.includes('--check');
  // Loaded here, not at the top: the sweep test imports this module's grid,
  // and esbuild refuses to load under Vitest's jsdom.
  const { createServer } = await import('vite');
  const server = await createServer({
    root: REPO_ROOT,
    configFile: false,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const solver = await server.ssrLoadModule(
      '/supabase/functions/_shared/engines/auto-scheduler-solver.ts'
    );
    const coaches = await server.ssrLoadModule(
      '/supabase/functions/_shared/engines/practice-coaches.ts'
    );
    const extract = JSON.parse(readFileSync(path.join(REPO_ROOT, EXTRACT), 'utf8'));
    const runs = [];
    // The corpus's first date: on or before every slot's first occurrence.
    for (const run of sweepRuns(extract, coaches.prepareTeam, '2026-09-14')) {
      const result = await solver.runPracticeOptimizer(run.input);
      runs.push({
        share: run.share,
        seed: run.seed,
        locked: run.locked,
        placeable: run.placeable,
        ...goldenOf(result),
      });
    }
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    const golden = {
      source: `${EXTRACT} (the §2.3 grid of docs/PLAN_SOLVER_DATE_MODEL.md)`,
      generatedAt: head,
      sweep: { ...SWEEP },
      runs,
    };
    const text = `${JSON.stringify(golden, null, 2)}\n`;
    const target = path.join(REPO_ROOT, SOLVER_GOLDEN);
    if (check) {
      const committed = JSON.parse(readFileSync(target, 'utf8'));
      const same = JSON.stringify(committed.runs) === JSON.stringify(golden.runs);
      console.log(same ? 'golden matches' : 'golden DIFFERS');
      process.exitCode = same ? 0 : 1;
      return;
    }
    writeFileSync(target, text);
    console.log(`wrote ${SOLVER_GOLDEN}: ${runs.length} runs at ${head}`);
    console.log('Run `npx prettier --write` on it, then review the diff.');
  } finally {
    await server.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
