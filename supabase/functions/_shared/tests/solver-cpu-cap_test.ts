/**
 * The practice optimiser's compute cap (`CPU_CAP_MS`): a Supabase Edge Function
 * request gets 2 s of CPU, so the search stops at the cap with the best
 * schedule found, says so (`terminationReason: 'cpu-cap'`), and a small league
 * that finishes inside it is untouched.
 *
 * Time is injected (`now`), never waited for: each reading of the fake clock
 * advances it by a fixed step, so the stop is a function of the code path and
 * not of the machine running the test.
 */
import { assert, assertEquals } from 'https://deno.land/std@0.203.0/assert/mod.ts';
import {
  CPU_CAP_MS,
  runPracticeOptimizer,
  type SchedulerSlot,
} from '../engines/auto-scheduler-solver.ts';
import { toDaylightSlot } from '../engines/practice-daylight.ts';
import { prepareTeam } from '../engines/practice-coaches.ts';
import { solverDatedRun } from '../../../../tests/fixtures/solverDatedCases.js';

/** 24 teams with a coach each, and 30 one-team slots (Mon-Fri, 15:00-20:00): room for all of them. */
function league() {
  const slots = [];
  for (let d = 0; d < 5; d += 1) {
    for (let h = 15; h < 21; h += 1) {
      const date = `2026-10-${String(19 + d)}`;
      slots.push({
        id: `s-${d}-${h}`,
        start: `${date}T${h}:00:00-04:00`,
        end: `${date}T${h + 1}:00:00-04:00`,
        capacity: 1,
        firstDate: date,
        validUntil: '2026-11-20',
      });
    }
  }
  const teams = Array.from({ length: 24 }, (_, i) => ({
    id: `T${i}`,
    division: 'U10',
    coachId: `c${i}`,
  }));
  const { slots: runSlots, dating } = solverDatedRun({ slots }, toDaylightSlot);
  return {
    teams: teams.map((t) => ({ ...prepareTeam(t), division: t.division })),
    slots: runSlots as unknown as SchedulerSlot[],
    placeableTeamIds: teams.map((t) => t.id),
    dating,
    locked: [],
  };
}

/** A clock that moves `stepMs` on every reading, starting at 0. */
function steppedClock(stepMs: number) {
  let t = 0;
  return () => {
    const reading = t;
    t += stepMs;
    return reading;
  };
}

const CONFIG = { timeBudgetMs: 25_000, maxIterations: 5_000, seed: 42 };
const keyOf = (run: { placements: Array<{ teamId: string; slotId: string }> }) =>
  run.placements.map((p) => `${p.teamId} -> ${p.slotId}`).sort();

Deno.test('the cap is 1,500 ms, leaving the platform 500 ms of its 2,000 for what follows', () => {
  assertEquals(CPU_CAP_MS, 1_500);
});

Deno.test(
  'a budget larger than the cap stops at the cap with cpu-cap, and returns the best schedule so far',
  async () => {
    const capped = await runPracticeOptimizer({
      ...league(),
      config: CONFIG,
      now: steppedClock(100),
    });
    assertEquals(capped.terminationReason, 'cpu-cap');
    // It stops at the cap, give or take the clock's 100 ms step, not at the 25 s asked for.
    assert(
      capped.elapsedMs >= CPU_CAP_MS && capped.elapsedMs <= CPU_CAP_MS + 200,
      `stopped at ${capped.elapsedMs} ms, not at the ${CPU_CAP_MS} ms cap`
    );
    assert(capped.iterations > 0, 'the cap ended the run before the search began');
    assert(capped.iterations < CONFIG.maxIterations, 'the run did not stop at the cap');
    assert(capped.placements.length > 0, 'a capped run returned no placements');

    // "Best so far" is the search's answer after exactly that many iterations:
    // the same run, with no cap, told to stop there.
    const reference = await runPracticeOptimizer({
      ...league(),
      config: { ...CONFIG, maxIterations: capped.iterations },
      cpuCapMs: Infinity,
      now: steppedClock(0),
    });
    assertEquals(reference.terminationReason, 'max-iterations');
    assertEquals(keyOf(capped), keyOf(reference));
    assertEquals(capped.bestScore, reference.bestScore);
  }
);

Deno.test('the cap runs from the request start, not from the search loop', async () => {
  // The request began 1,400 ms before the search was called: 100 ms are left.
  const run = await runPracticeOptimizer({
    ...league(),
    config: CONFIG,
    requestStartedAt: -1_400,
    now: steppedClock(100),
  });
  assertEquals(run.terminationReason, 'cpu-cap');
  // The search got well under the 1,500 ms it would have had from its own start.
  assert(run.elapsedMs < 500, `searched ${run.elapsedMs} ms of a 100 ms allowance`);
  // The greedy seed is the floor: stopping at once still returns a schedule.
  assert(run.placements.length > 0, 'a run capped before its first iteration returned nothing');
  assertEquals(run.seedScore, run.bestScore);
});

Deno.test(
  "the effective budget is the smaller of the cap and the caller (the caller's wins)",
  async () => {
    const run = await runPracticeOptimizer({
      ...league(),
      config: { ...CONFIG, timeBudgetMs: 1_000 },
      now: steppedClock(100),
    });
    assertEquals(run.terminationReason, 'time-budget');
    assert(run.elapsedMs >= 1_000 && run.elapsedMs < CPU_CAP_MS);
  }
);

Deno.test('the 140 s wall-clock guard is kept when the cap is off', async () => {
  const run = await runPracticeOptimizer({
    ...league(),
    // The request schema allows at most 25 s; the guard is the last resort for a larger one.
    config: { ...CONFIG, timeBudgetMs: 200_000 },
    cpuCapMs: Infinity,
    now: steppedClock(10_000),
  });
  assertEquals(run.terminationReason, 'wall-clock-safety');
  assert(run.placements.length > 0);
});

Deno.test(
  'a small league finishes by its own reason, with the schedule it always got',
  async () => {
    const config = { timeBudgetMs: 20_000, maxIterations: 300, seed: 42 };
    // The default clock and the default cap, as the Edge Function runs it.
    const real = await runPracticeOptimizer({ ...league(), config });
    assertEquals(real.terminationReason, 'max-iterations');
    assertEquals(real.iterations, 300);
    assertEquals(real.placements.length, 24, 'every team has a slot');
    // The same league with the cap off answers identically: the cap changed nothing.
    const uncapped = await runPracticeOptimizer({ ...league(), config, cpuCapMs: Infinity });
    assertEquals(keyOf(real), keyOf(uncapped));
    assertEquals(real.bestScore, uncapped.bestScore);
  }
);
