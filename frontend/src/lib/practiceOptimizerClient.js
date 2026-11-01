/**
 * The page's side of the browser optimizer (Phase D PR D; plan
 * `docs/changes/2026-10-27-phase-d-scheduling.md`, section D): run the practice optimizer in a Web
 * Worker, have the server verify the result, and fall back to the server's own run when the browser
 * cannot.
 *
 * {@link runPracticeOptimizerPath} is the whole decision, with its two requests passed in so the
 * hook owns the session, the URL and the deadline:
 *
 * 1. `prepare()` -- the function loads every input as the caller and answers with the solver's
 *    input and a digest of it.
 * 2. The worker searches it ({@link runOptimizerInWorker}), reporting progress. Cancelling the
 *    request's signal terminates the worker at once.
 * 3. `verify({ digest, placements, browserRun })` -- the function loads everything again, refuses
 *    409 `INPUT_CHANGED` if it no longer matches the digest, and otherwise checks every placement
 *    and answers as a `solve` does.
 *
 * It answers `verified` (the schedule to stage), `server` (an older function answered `prepare`
 * with a finished `solve`: it is that run), or `fallback` with the reason, and the caller then runs
 * the server's `solve` and says so. A refusal that a `solve` would also give (the lock does not
 * match, the settings cannot be read) is thrown, not fallen back from: the server would only say
 * it again. An error out of `prepare` (a deadline, a lost connection) is thrown with
 * `recordedNothing`: `prepare` writes nothing, so there is no run for the admin to look for.
 */
import { isAbortError } from './abortError.js';
import {
  INPUT_CHANGED,
  SOLVER_INPUT_UNENCODABLE,
} from '../../../supabase/functions/_shared/engines/solver-input.ts';

/**
 * The wall-clock budget of a browser search, in ms (owner decision 8, 2026-10-27). The search also
 * stops at its iteration count, so this ends only a search that is slower than the count allows.
 */
export const OPTIMIZER_WALL_BUDGET_MS = 20_000;

/** How long past its own budget the page waits for a worker to answer before giving up on it. */
export const WORKER_ANSWER_GRACE_MS = 30_000;

/**
 * Why a run was handed to the server, as the panel says it.
 * @typedef {'unavailable' | 'worker-error' | 'input-changed' | 'prepare-failed'} FallbackReason
 */

/** The worker could not run, or failed. `kind` is `unavailable` (could not start) or `failed`. */
export class OptimizerWorkerError extends Error {
  /**
   * @param {'unavailable' | 'failed'} kind
   * @param {string} message
   */
  constructor(kind, message) {
    super(message);
    this.name = 'OptimizerWorkerError';
    this.kind = kind;
  }
}

/** Can this browser start a worker at all? (Whether it runs modules is found out by starting one.) */
export function browserOptimizerAvailable() {
  return typeof Worker === 'function';
}

/** The optimizer worker. Vite builds it as its own chunk, loaded only when a run begins. */
export function createOptimizerWorker() {
  return new Worker(new URL('../workers/practiceOptimizer.worker.js', import.meta.url), {
    type: 'module',
  });
}

const cancelled = () => new DOMException('The optimizer was cancelled.', 'AbortError');

/**
 * Search `input` in a worker.
 *
 * @param {Object} options
 * @param {Record<string, unknown>} options.input the encoding `prepare` answered with
 * @param {{ seed: number, maxIterations: number, timeBudgetMs: number }} options.config
 * @param {(progress: { iteration: number, bestScore: number, elapsedMs: number, restartCount: number }) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal] aborting terminates the worker and rejects with an `AbortError`
 * @param {() => Worker} [options.createWorker]
 * @returns {Promise<{ placements: Array<{ teamId: string, slotId: string, unitId?: string }>, run: { seedScore: number, bestScore: number, iterations: number, restarts: number, elapsedMs: number, terminationReason: string } }>}
 * @throws {OptimizerWorkerError} the worker could not start, errored, or did not answer in time
 */
export function runOptimizerInWorker({
  input,
  config,
  onProgress,
  signal,
  createWorker = createOptimizerWorker,
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelled());
      return;
    }
    /** @type {Worker} */
    let worker;
    try {
      worker = createWorker();
    } catch (err) {
      reject(new OptimizerWorkerError('unavailable', `the worker could not start: ${err.message}`));
      return;
    }
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let watchdog;
    const onAbort = () => settle(() => reject(cancelled()));
    /** @param {() => void} outcome */
    function settle(outcome) {
      clearTimeout(watchdog);
      signal?.removeEventListener('abort', onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      outcome();
    }
    const fail = (/** @type {string} */ message) =>
      settle(() => reject(new OptimizerWorkerError('failed', message)));

    signal?.addEventListener('abort', onAbort, { once: true });
    watchdog = setTimeout(
      () => fail('the worker did not answer in time'),
      config.timeBudgetMs + WORKER_ANSWER_GRACE_MS
    );
    worker.onmessage = (event) => {
      const message = event.data;
      if (message?.type === 'progress') {
        onProgress?.({
          iteration: message.iteration,
          bestScore: message.bestScore,
          elapsedMs: message.elapsedMs,
          restartCount: message.restartCount,
        });
      } else if (message?.type === 'result') {
        if (!Array.isArray(message.placements) || !message.run) {
          fail('the worker answered with a result that cannot be read');
        } else {
          settle(() => resolve({ placements: message.placements, run: message.run }));
        }
      } else if (message?.type === 'error') {
        fail(String(message.message ?? 'the worker failed'));
      }
    };
    // A worker that could not load (a browser without module workers, a blocked script) raises
    // `error` on the Worker object, with no message of ours.
    worker.onerror = (event) => fail(event?.message || 'the worker raised an error');
    worker.onmessageerror = () => fail('the worker sent a message that could not be read');
    worker.postMessage({ type: 'run', input, config });
  });
}

/** @param {{ response: Response, result: Record<string, any> }} reply */
function refusal(reply) {
  return new Error(reply.result?.error || `Server error: ${reply.response.status}`);
}

/**
 * The browser path of one run. See the module note.
 *
 * @param {Object} options
 * @param {() => Promise<{ response: Response, result: Record<string, any> }>} options.prepare
 * @param {(claims: { digest: string, placements: Array<Record<string, unknown>>, browserRun: Record<string, unknown> }) => Promise<{ response: Response, result: Record<string, any> }>} options.verify
 * @param {{ seed: number, maxIterations: number }} options.config the run's own search settings
 * @param {AbortSignal} [options.signal]
 * @param {(phase: 'preparing' | 'searching' | 'verifying') => void} [options.onPhase]
 * @param {(progress: { iteration: number, bestScore: number, elapsedMs: number, restartCount: number }) => void} [options.onProgress]
 * @param {() => Worker} [options.createWorker]
 * @returns {Promise<
 *   | { kind: 'verified', data: Record<string, any> }
 *   | { kind: 'server', data: Record<string, any> }
 *   | { kind: 'fallback', reason: FallbackReason, detail: string }
 * >}
 */
export async function runPracticeOptimizerPath({
  prepare,
  verify,
  config,
  signal,
  onPhase,
  onProgress,
  createWorker,
}) {
  onPhase?.('preparing');
  let prepared;
  try {
    prepared = await prepare();
  } catch (err) {
    // `prepare` writes nothing, so a failure of it (a deadline included) leaves no run that might
    // have been recorded: the caller must not tell the admin to go and look for one.
    if (err && typeof err === 'object') /** @type {any} */ (err).recordedNothing = true;
    throw err;
  }
  // The input could not be written down for the browser: the server can still search it itself.
  if (prepared.response.status === 422 && prepared.result?.code === SOLVER_INPUT_UNENCODABLE) {
    return {
      kind: 'fallback',
      reason: 'prepare-failed',
      detail: String(prepared.result.error ?? SOLVER_INPUT_UNENCODABLE),
    };
  }
  if (!prepared.response.ok) throw refusal(prepared);
  const data = prepared.result;
  // A function deployed before `prepare` existed ignores the key and runs the whole `solve`:
  // that finished run is the answer, and nothing is run twice.
  if (!data.digest && Array.isArray(data.assignments)) return { kind: 'server', data };
  if (typeof data.digest !== 'string' || !data.input || typeof data.input !== 'object') {
    return {
      kind: 'fallback',
      reason: 'worker-error',
      detail: 'the server answered prepare with something that is not a solver input',
    };
  }

  onPhase?.('searching');
  let found;
  try {
    found = await runOptimizerInWorker({
      input: data.input,
      config: {
        seed: config.seed,
        maxIterations: config.maxIterations,
        timeBudgetMs: OPTIMIZER_WALL_BUDGET_MS,
      },
      onProgress,
      signal,
      createWorker,
    });
  } catch (err) {
    if (isAbortError(err, signal)) throw err;
    if (err instanceof OptimizerWorkerError) {
      return {
        kind: 'fallback',
        reason: err.kind === 'unavailable' ? 'unavailable' : 'worker-error',
        detail: err.message,
      };
    }
    throw err;
  }

  onPhase?.('verifying');
  const verified = await verify({
    digest: data.digest,
    placements: found.placements,
    browserRun: {
      seedScore: found.run.seedScore,
      iterations: found.run.iterations,
      restarts: found.run.restarts,
      elapsedMs: found.run.elapsedMs,
      terminationReason: found.run.terminationReason,
    },
  });
  if (verified.response.ok) return { kind: 'verified', data: verified.result };
  if (verified.response.status === 409 && verified.result?.code === INPUT_CHANGED) {
    return {
      kind: 'fallback',
      reason: 'input-changed',
      detail: String(verified.result.error ?? INPUT_CHANGED),
    };
  }
  throw refusal(verified);
}
