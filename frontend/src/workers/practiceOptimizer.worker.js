/**
 * The practice optimizer, in a Web Worker (Phase D PR D; plan
 * `docs/changes/2026-10-27-phase-d-scheduling.md`, section D).
 *
 * The auto-scheduler's solver is one module (`supabase/functions/_shared/engines/
 * auto-scheduler-solver.ts`) that the Edge Function and this worker both import, so the browser
 * does not run a third copy. On the server the search stops at the request's CPU cap
 * (`CPU_CAP_MS`, 1.5 s); here the cap is off (`cpuCapMs: Infinity`) and the search runs until it
 * finishes its iterations or reaches a wall-clock budget (20 s by default), so a league too big for
 * the server's 1.5 s gets the search it asked for.
 *
 * **What it is given.** The page calls the function's `prepare` mode, which loads every input of the
 * run as the caller and answers with the solver's input, encoded (`solver-input.ts`), and a digest
 * of it. The page posts that encoding here; the worker revives it and searches. It reads nothing
 * else: no network, no storage.
 *
 * **What it answers.** Progress every 100 iterations, then the placements and what it reports of its
 * own search. That is a PROPOSAL: the page sends the placements, with the digest, to the function's
 * `verify` mode, which loads everything again itself, refuses if the digest no longer matches, and
 * seats the placements through the same admissibility check the search used. Whatever the worker
 * answers, the server has the last word.
 *
 * **Deterministic for a seed and an iteration count.** The search draws from a seeded generator, so
 * the same input, seed and `maxIterations` give the same placements on any machine -- as long as the
 * search finishes its iterations. A wall budget that ends it first makes the result depend on how
 * fast this computer is (`terminationReason: 'time-budget'`), which the panel says.
 *
 * **Cancelling.** The page terminates the worker (`Worker.terminate()`): it stops at once, mid
 * search, with nothing for the worker to cooperate in.
 *
 * Messages in: `{ type: 'run', input, config: { seed, maxIterations, timeBudgetMs } }`.
 * Messages out: `{ type: 'progress', iteration, bestScore, elapsedMs, restartCount }`,
 * `{ type: 'result', placements, run }`, `{ type: 'error', message }`.
 *
 * The handler is exported so a test can run a job without a worker; it registers itself only inside
 * one.
 */
import { runPracticeOptimizer } from '../../../supabase/functions/_shared/engines/auto-scheduler-solver.ts';
import { reviveSolverInput } from '../../../supabase/functions/_shared/engines/solver-input.ts';

/**
 * Run one job and post its messages. Never throws: whatever goes wrong in a job -- an input of a
 * version this build does not know, a solver error -- is posted as an `error` message, because the
 * worker's page can only fall back to the server if it is told. (This is the boundary of the
 * worker, not a swallowed error: the message is the report.)
 *
 * @param {any} message the page's `{ type: 'run', input, config }`
 * @param {(message: Record<string, unknown>) => void} post
 * @returns {Promise<void>}
 */
export async function runOptimizerJob(message, post) {
  try {
    if (!message || message.type !== 'run') {
      throw new TypeError(`unknown message ${JSON.stringify(message?.type ?? null)}`);
    }
    const { seed, maxIterations, timeBudgetMs } = message.config ?? {};
    for (const [name, value] of Object.entries({ seed, maxIterations, timeBudgetMs })) {
      if (!Number.isFinite(value)) throw new TypeError(`config.${name} is not a number`);
    }
    const input = reviveSolverInput(message.input);
    const run = await runPracticeOptimizer({
      ...input,
      config: { seed, maxIterations, timeBudgetMs },
      // The server's compute cap is the server's: a browser has no 2 s of CPU to protect.
      cpuCapMs: Infinity,
      onProgress: (progress) => post({ type: 'progress', ...progress }),
    });
    post({
      type: 'result',
      placements: run.placements.map((p) => ({
        teamId: p.teamId,
        slotId: p.slotId,
        ...(p.unitId ? { unitId: p.unitId } : {}),
      })),
      run: {
        seedScore: run.seedScore,
        bestScore: run.bestScore,
        iterations: run.iterations,
        restarts: run.restarts,
        elapsedMs: run.elapsedMs,
        terminationReason: run.terminationReason,
      },
    });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

// Registered only inside a worker (the "dom" lib has no `WorkerGlobalScope`, hence the cast).
const WorkerScope = /** @type {any} */ (globalThis).WorkerGlobalScope;
if (typeof WorkerScope === 'function' && self instanceof WorkerScope) {
  self.addEventListener('message', (event) => {
    void runOptimizerJob(event.data, (message) => self.postMessage(message));
  });
}
