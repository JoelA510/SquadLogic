// @vitest-environment node
/**
 * Phase D PR D (plan `docs/changes/2026-10-27-phase-d-scheduling.md`, D2): the practice optimizer
 * in a Web Worker, the page's client for it, and the budget of the chunk it ships in.
 *
 * Three layers, each held to the server's own code:
 *
 * 1. `frontend/src/workers/practiceOptimizer.worker.js` -- the job it runs, executed here without
 *    a worker over `tests/fixtures/practiceOptimizerLeague.js`, and its registration inside one.
 *    Its placements are held equal to the Edge solver's own run (cap off, same seed and iteration
 *    count) and to what `verify` accepts, with the same score.
 * 2. `frontend/src/lib/practiceOptimizerClient.js` -- progress, cancel, an error, a worker that
 *    cannot start or never answers, and the decision to fall back to the server.
 * 3. `config/bundle-budget.json` -- the rule for the worker chunk, shown failing at a 1 KB cap.
 *
 * Every expectation is derived from the fixture or from the Edge modules, never from what the
 * worker answered.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it, vi } from 'vitest';

import { evaluateBudget } from '../scripts/check-bundle-size.js';
import { runOptimizerJob } from '../frontend/src/workers/practiceOptimizer.worker.js';
import {
  OPTIMIZER_WALL_BUDGET_MS,
  OptimizerWorkerError,
  WORKER_ANSWER_GRACE_MS,
  browserOptimizerAvailable,
  createOptimizerWorker,
  runOptimizerInWorker,
  runPracticeOptimizerPath,
} from '../frontend/src/lib/practiceOptimizerClient.js';
import {
  runPracticeOptimizer,
  unitIdOf,
  verifyPracticePlacements,
} from '../supabase/functions/_shared/engines/auto-scheduler-solver.js';
import {
  INPUT_CHANGED,
  SOLVER_INPUT_UNENCODABLE,
  digestEncodedInput,
  encodeSolverInput,
} from '../supabase/functions/_shared/engines/solver-input.js';
import { prepareTeam } from '../supabase/functions/_shared/engines/practice-coaches.js';
import { toDaylightSlot } from '../supabase/functions/_shared/engines/practice-daylight.js';
import { LEAGUE_CONFIG, practiceOptimizerLeague } from './fixtures/practiceOptimizerLeague.js';

const league = () => practiceOptimizerLeague({ toDaylightSlot, prepareTeam });
const SCOPE = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  seasonSettingsId: '00000000-0000-4000-8000-000000000002',
};
const WIRE = () => JSON.parse(JSON.stringify(encodeSolverInput(league(), SCOPE)));
const CONFIG = { seed: LEAGUE_CONFIG.seed, maxIterations: LEAGUE_CONFIG.maxIterations };

/** Run the worker's job and return every message it posted. */
async function job(message) {
  const posted = [];
  await runOptimizerJob(message, (m) => posted.push(m));
  return posted;
}
const runMessage = (config = {}) => ({
  type: 'run',
  input: WIRE(),
  config: { ...LEAGUE_CONFIG, ...config },
});
const resultOf = (posted) => posted.find((m) => m.type === 'result');
const byUnit = (list) => [...list].sort((a, b) => unitIdOf(a).localeCompare(unitIdOf(b)));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the worker runs the Edge solver, with the server cap off', () => {
  it('posts progress and one result, and nothing after it', async () => {
    const posted = await job(runMessage());
    const types = posted.map((m) => m.type);
    assert.equal(types.at(-1), 'result');
    assert.equal(types.filter((t) => t === 'result').length, 1);
    assert.ok(types.filter((t) => t === 'progress').length >= 1, 'a 300-iteration search reports');
    for (const progress of posted.filter((m) => m.type === 'progress')) {
      assert.ok(progress.iteration > 0 && progress.iteration % 100 === 0);
      assert.ok(progress.bestScore >= 0 && progress.bestScore <= 1);
    }
    const { run } = resultOf(posted);
    assert.equal(run.terminationReason, 'max-iterations');
    assert.equal(run.iterations, LEAGUE_CONFIG.maxIterations);
  });

  it("finds the schedule the server's own run finds: same seed and iteration count, same placements", async () => {
    const direct = await runPracticeOptimizer({
      ...league(),
      config: LEAGUE_CONFIG,
      cpuCapMs: Infinity,
    });
    const { placements, run } = resultOf(await job(runMessage()));
    assert.deepEqual(
      placements,
      direct.placements.map((p) => ({
        teamId: p.teamId,
        slotId: p.slotId,
        ...(p.unitId ? { unitId: p.unitId } : {}),
      }))
    );
    assert.equal(run.bestScore, direct.bestScore);
    assert.equal(run.seedScore, direct.seedScore);
    assert.equal(run.restarts, direct.restarts);
  });

  it('is deterministic for a seed and an iteration count: the same run, statistics and all', async () => {
    const a = resultOf(await job(runMessage()));
    const b = resultOf(await job(runMessage()));
    assert.deepEqual(b.placements, a.placements);
    // Everything the search reports but the clock: the PRNG draws the same moves.
    const { elapsedMs: _a, ...runA } = a.run;
    const { elapsedMs: _b, ...runB } = b.run;
    assert.deepEqual(runB, runA);
    // Fewer iterations is a different search (its count is part of what is held fixed).
    const shorter = resultOf(await job(runMessage({ maxIterations: 100 })));
    assert.equal(shorter.run.iterations, 100);
  });

  it("is checked by the server's own verify: the same placements, the same score", async () => {
    const { placements, run } = resultOf(await job(runMessage()));
    const verified = verifyPracticePlacements({ ...league(), placements });
    assert.deepEqual(verified.refused, []);
    assert.deepEqual(byUnit(verified.placements).map(unitIdOf), placements.map(unitIdOf).sort());
    assert.equal(verified.bestScore, run.bestScore);
  });

  it('stops at its wall budget, with the best schedule so far, and says so', async () => {
    const posted = await job(runMessage({ timeBudgetMs: 0, maxIterations: 5000 }));
    const { placements, run } = resultOf(posted);
    assert.equal(run.terminationReason, 'time-budget');
    assert.ok(run.iterations < 5000);
    // The greedy seed is the floor: stopping at once still returns a schedule.
    assert.ok(placements.length > 0);
  });

  it('is not held to the server cap: a budget past 1.5 s is the budget it was given', async () => {
    // With the cap on, a 25 s budget would stop at CPU_CAP_MS; here it only stops at its iterations.
    const { run } = resultOf(await job(runMessage({ timeBudgetMs: 25_000, maxIterations: 150 })));
    assert.equal(run.terminationReason, 'max-iterations');
  });
});

describe('a job that cannot run says so, and never throws', () => {
  it('an input of another version, an unreadable input, an unknown message, a bad config', async () => {
    const wrongVersion = await job({ ...runMessage(), input: { ...WIRE(), version: 2 } });
    assert.deepEqual(
      wrongVersion.map((m) => m.type),
      ['error']
    );
    assert.match(wrongVersion[0].message, /version 2/);
    assert.equal((await job({ type: 'run', input: null, config: LEAGUE_CONFIG }))[0].type, 'error');
    assert.match((await job({ type: 'nope' }))[0].message, /unknown message "nope"/);
    assert.match((await job(null))[0].message, /unknown message null/);
    const noBudget = await job({ ...runMessage(), config: { seed: 1, maxIterations: 10 } });
    assert.match(noBudget[0].message, /config\.timeBudgetMs is not a number/);
  });
});

describe('inside a worker, the module answers the page’s messages', () => {
  it('registers a message listener and posts back through the worker scope', async () => {
    class FakeWorkerGlobalScope {
      listeners = new Map();
      posted = [];
      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      }
      postMessage(message) {
        this.posted.push(message);
      }
    }
    const scope = new FakeWorkerGlobalScope();
    vi.stubGlobal('WorkerGlobalScope', FakeWorkerGlobalScope);
    vi.stubGlobal('self', scope);
    vi.resetModules();
    await import('../frontend/src/workers/practiceOptimizer.worker.js');
    const listener = scope.listeners.get('message');
    assert.equal(typeof listener, 'function');
    listener({ data: runMessage({ maxIterations: 100 }) });
    await vi.waitFor(() => assert.equal(scope.posted.at(-1)?.type, 'result'));
  });

  it('registers nothing when it is imported on a page (the Vitest suite, a bundler analysing it)', async () => {
    const scope = { addEventListener: vi.fn() };
    vi.stubGlobal('self', scope);
    vi.resetModules();
    await import('../frontend/src/workers/practiceOptimizer.worker.js');
    assert.equal(scope.addEventListener.mock.calls.length, 0);
  });
});

/** A worker the test drives by hand: it records what it was sent and what was done to it. */
class FakeWorker {
  /** @type {any} */
  static last = null;
  /** @type {any} */
  onmessage = null;
  /** @type {any} */
  onerror = null;
  /** @type {any} */
  onmessageerror = null;

  constructor() {
    /** @type {any[]} */
    this.sent = [];
    this.terminated = 0;
    FakeWorker.last = this;
  }
  postMessage(/** @type {any} */ message) {
    this.sent.push(message);
  }
  terminate() {
    this.terminated += 1;
  }
  say(/** @type {any} */ data) {
    this.onmessage?.({ data });
  }
}

/** The fake as the `Worker` the client is typed to take. */
const asWorker = () => /** @type {any} */ (new FakeWorker());

/** A worker that really runs the job, in this process, as a worker would after `postMessage`. */
class InProcessWorker extends FakeWorker {
  postMessage(/** @type {any} */ message) {
    super.postMessage(message);
    void runOptimizerJob(message, (data) => queueMicrotask(() => this.say(data)));
  }
}

describe('the page’s client for the worker', () => {
  const input = { version: 1 };
  const config = { seed: 1, maxIterations: 100, timeBudgetMs: 5000 };

  it('forwards progress, resolves the result and terminates the worker', async () => {
    const progress = vi.fn();
    const pending = runOptimizerInWorker({
      input,
      config,
      onProgress: progress,
      createWorker: asWorker,
    });
    const worker = FakeWorker.last;
    assert.deepEqual(worker.sent, [{ type: 'run', input, config }]);
    worker.say({
      type: 'progress',
      iteration: 100,
      bestScore: 0.9,
      elapsedMs: 40,
      restartCount: 1,
    });
    worker.say({
      type: 'result',
      placements: [{ teamId: 't', slotId: 's' }],
      run: { seedScore: 0.5, bestScore: 0.9 },
    });
    const done = await pending;
    assert.deepEqual(progress.mock.calls, [
      [{ iteration: 100, bestScore: 0.9, elapsedMs: 40, restartCount: 1 }],
    ]);
    assert.deepEqual(done.placements, [{ teamId: 't', slotId: 's' }]);
    assert.equal(worker.terminated, 1);
  });

  it('cancel terminates the worker at once and rejects as a cancellation', async () => {
    const controller = new AbortController();
    const pending = runOptimizerInWorker({
      input,
      config,
      signal: controller.signal,
      createWorker: asWorker,
    });
    const worker = FakeWorker.last;
    controller.abort();
    await assert.rejects(pending, (/** @type {any} */ err) => err.name === 'AbortError');
    assert.equal(worker.terminated, 1);
    // What the worker says after it was cancelled is not heard.
    assert.equal(worker.onmessage, null);
  });

  it('an already-cancelled request never starts a worker', async () => {
    const controller = new AbortController();
    controller.abort();
    const createWorker = vi.fn();
    await assert.rejects(
      runOptimizerInWorker({ input, config, signal: controller.signal, createWorker }),
      (/** @type {any} */ err) => err.name === 'AbortError'
    );
    assert.equal(createWorker.mock.calls.length, 0);
  });

  it('a worker that errors, raises, sends junk or returns a result it cannot read fails the run', async () => {
    const failure = async (react) => {
      const pending = runOptimizerInWorker({ input, config, createWorker: asWorker });
      const worker = FakeWorker.last;
      react(worker);
      const error = await pending.catch((e) => e);
      assert.ok(error instanceof OptimizerWorkerError);
      assert.equal(error.kind, 'failed');
      assert.equal(worker.terminated, 1);
      return error.message;
    };
    assert.equal(await failure((w) => w.say({ type: 'error', message: 'boom' })), 'boom');
    assert.equal(
      await failure((w) => w.onerror({ message: 'SyntaxError: import' })),
      'SyntaxError: import'
    );
    assert.match(await failure((w) => w.onerror({})), /raised an error/);
    assert.match(await failure((w) => w.onmessageerror()), /could not be read/);
    assert.match(
      await failure((w) => w.say({ type: 'result', placements: 'x' })),
      /cannot be read/
    );
  });

  it('a worker that cannot be constructed is "unavailable"', async () => {
    const error = await runOptimizerInWorker({
      input,
      config,
      createWorker: () => {
        throw new TypeError('Worker is not a constructor');
      },
    }).catch((e) => e);
    assert.ok(error instanceof OptimizerWorkerError);
    assert.equal(error.kind, 'unavailable');
  });

  it('a worker that never answers is given up on, past its own budget and a grace', async () => {
    vi.useFakeTimers();
    const pending = runOptimizerInWorker({ input, config, createWorker: asWorker });
    const outcome = pending.catch((e) => e);
    const worker = FakeWorker.last;
    await vi.advanceTimersByTimeAsync(config.timeBudgetMs + WORKER_ANSWER_GRACE_MS - 1);
    assert.equal(worker.terminated, 0, 'not yet');
    await vi.advanceTimersByTimeAsync(2);
    const error = await outcome;
    assert.match(error.message, /did not answer in time/);
    assert.equal(worker.terminated, 1);
  });

  it('knows whether a browser can start a worker, and builds the module worker Vite bundles', () => {
    assert.equal(browserOptimizerAvailable(), false, 'Node has no Worker');
    vi.stubGlobal('Worker', function Worker() {});
    assert.equal(browserOptimizerAvailable(), true);
    const made = [];
    vi.stubGlobal(
      'Worker',
      class {
        constructor(url, options) {
          made.push([String(url), options]);
        }
      }
    );
    createOptimizerWorker();
    assert.match(made[0][0], /workers\/practiceOptimizer\.worker\.js$/);
    assert.deepEqual(made[0][1], { type: 'module' });
    assert.equal(OPTIMIZER_WALL_BUDGET_MS, 20_000);
  });
});

describe('the browser path: prepare, search, verify -- or the server', () => {
  /** @returns {any} */
  const ok = (/** @type {any} */ result) => ({ response: { ok: true, status: 200 }, result });
  /** @returns {any} */
  const refused = (/** @type {number} */ status, /** @type {any} */ result) => ({
    response: { ok: false, status },
    result,
  });
  const preparedOk = ok({ mode: 'prepare', digest: 'd'.repeat(64), input: { version: 1 } });

  /**
   * The path with a worker, and the two requests as spies.
   * @param {{ prepare?: any, verify?: any, worker?: () => any }} [options]
   */
  function setup({ prepare = preparedOk, verify = ok({ assignments: [] }), worker } = {}) {
    /** @type {{ prepare: number, verify: any[], phases: string[] }} */
    const calls = { prepare: 0, verify: [], phases: [] };
    return {
      calls,
      options: {
        prepare: async () => {
          calls.prepare += 1;
          return prepare;
        },
        verify: async (/** @type {any} */ claims) => {
          calls.verify.push(claims);
          return verify;
        },
        config: CONFIG,
        onPhase: (phase) => calls.phases.push(phase),
        createWorker: worker ?? asWorker,
      },
    };
  }
  const answer = (/** @type {any} */ worker) =>
    worker.say({
      type: 'result',
      placements: [{ teamId: 't', slotId: 's' }],
      run: {
        seedScore: 0.4,
        bestScore: 0.8,
        iterations: 100,
        restarts: 0,
        elapsedMs: 55,
        terminationReason: 'max-iterations',
      },
    });

  it('verifies what the worker found, with the digest prepare gave and the worker’s report', async () => {
    const { calls, options } = setup();
    const pending = runPracticeOptimizerPath(options);
    await vi.waitFor(() => assert.ok(FakeWorker.last?.sent.length));
    const worker = FakeWorker.last;
    assert.deepEqual(worker.sent[0].config, {
      seed: CONFIG.seed,
      maxIterations: CONFIG.maxIterations,
      timeBudgetMs: OPTIMIZER_WALL_BUDGET_MS,
    });
    answer(worker);
    const outcome = await pending;
    assert.equal(outcome.kind, 'verified');
    assert.deepEqual(calls.verify, [
      {
        digest: 'd'.repeat(64),
        placements: [{ teamId: 't', slotId: 's' }],
        browserRun: {
          seedScore: 0.4,
          iterations: 100,
          restarts: 0,
          elapsedMs: 55,
          terminationReason: 'max-iterations',
        },
      },
    ]);
    assert.deepEqual(calls.phases, ['preparing', 'searching', 'verifying']);
  });

  it('takes an older function’s finished solve as the run, and starts no worker', async () => {
    const createWorker = vi.fn();
    const solved = { assignments: [{ teamId: 't', slotId: 's' }], unassigned: [] };
    const { calls, options } = setup({ prepare: ok(solved) });
    const outcome = await runPracticeOptimizerPath({ ...options, createWorker });
    assert.deepEqual(outcome, { kind: 'server', data: solved });
    assert.equal(createWorker.mock.calls.length, 0);
    assert.equal(calls.verify.length, 0);
  });

  it('throws a refusal prepare shares with solve, rather than running the server to hear it again', async () => {
    const createWorker = vi.fn();
    const { options } = setup({
      prepare: refused(409, { error: 'The page is looking at a different schedule', code: 'X' }),
    });
    await assert.rejects(
      runPracticeOptimizerPath({ ...options, createWorker }),
      /different schedule/
    );
    assert.equal(createWorker.mock.calls.length, 0);
    await assert.rejects(
      runPracticeOptimizerPath({ ...setup({ prepare: refused(503, {}) }).options }),
      /Server error: 503/
    );
  });

  it('falls back when the worker cannot start, or fails, and does not call verify', async () => {
    const unavailable = setup({
      worker: () => {
        throw new Error('no module workers');
      },
    });
    const a = await runPracticeOptimizerPath(unavailable.options);
    assert.equal(a.kind, 'fallback');
    assert.equal(a.reason, 'unavailable');
    assert.equal(unavailable.calls.verify.length, 0);

    const failing = setup();
    const pending = runPracticeOptimizerPath(failing.options);
    await vi.waitFor(() => assert.ok(FakeWorker.last?.sent.length));
    FakeWorker.last.say({ type: 'error', message: 'boom' });
    const b = await pending;
    assert.equal(b.kind, 'fallback');
    assert.equal(b.reason, 'worker-error');
    assert.equal(b.detail, 'boom');
    assert.equal(failing.calls.verify.length, 0);
  });

  it('falls back, without a worker, when the server could not write the input down for the browser', async () => {
    const createWorker = vi.fn();
    const { calls, options } = setup({
      prepare: refused(422, {
        error: 'could not be handed to the browser',
        code: SOLVER_INPUT_UNENCODABLE,
      }),
    });
    const outcome = await runPracticeOptimizerPath({ ...options, createWorker });
    assert.equal(outcome.kind, 'fallback');
    assert.equal(outcome.reason, 'prepare-failed');
    assert.match(outcome.detail, /could not be handed/);
    assert.equal(createWorker.mock.calls.length, 0);
    assert.equal(calls.verify.length, 0);
    // Any other 422 is a refusal the server would give a solve too.
    const other = setup({
      prepare: refused(422, { error: 'slots could not be dated', code: 'SLOT_DATING_UNREADABLE' }),
    });
    await assert.rejects(runPracticeOptimizerPath(other.options), /slots could not be dated/);
  });

  it('falls back when prepare answers with something that is not a solver input', async () => {
    const { options } = setup({ prepare: ok({ digest: 'd'.repeat(64) }) });
    const outcome = await runPracticeOptimizerPath(options);
    assert.equal(outcome.kind, 'fallback');
    assert.equal(outcome.reason, 'worker-error');
  });

  it('falls back when verify says the inputs changed, and only then', async () => {
    const changed = setup({
      verify: refused(409, { error: 'The season changed', code: INPUT_CHANGED }),
    });
    const pending = runPracticeOptimizerPath(changed.options);
    await vi.waitFor(() => assert.ok(FakeWorker.last?.sent.length));
    answer(FakeWorker.last);
    const outcome = await pending;
    assert.equal(outcome.kind, 'fallback');
    assert.equal(outcome.reason, 'input-changed');

    // Any other refusal is the answer: the server would give it to a solve too.
    for (const reply of [
      refused(409, { error: 'locks differ', code: 'LOCKED_ASSIGNMENTS_MISMATCH' }),
      refused(503, { error: 'unreadable', code: 'PRACTICE_LOCK_UNREADABLE' }),
    ]) {
      const other = setup({ verify: reply });
      const p = runPracticeOptimizerPath(other.options);
      await vi.waitFor(() => assert.ok(FakeWorker.last?.sent.length));
      answer(FakeWorker.last);
      await assert.rejects(p, /locks differ|unreadable/);
    }
  });

  it('cancel while the worker searches ends the run, terminates the worker and never verifies', async () => {
    const controller = new AbortController();
    const { calls, options } = setup();
    const pending = runPracticeOptimizerPath({ ...options, signal: controller.signal });
    await vi.waitFor(() => assert.ok(FakeWorker.last?.sent.length));
    const worker = FakeWorker.last;
    controller.abort();
    await assert.rejects(pending, (/** @type {any} */ err) => err.name === 'AbortError');
    assert.equal(worker.terminated, 1);
    assert.equal(calls.verify.length, 0);
  });

  it('end to end with the real worker job and the real verify: the server accepts what the browser found', async () => {
    const encoded = encodeSolverInput(league(), SCOPE);
    const digest = await digestEncodedInput(encoded);
    const wire = JSON.parse(JSON.stringify(encoded));
    /** @type {any} */
    let verifiedBody = null;
    const outcome = await runPracticeOptimizerPath({
      prepare: async () => ok({ mode: 'prepare', digest, input: wire }),
      verify: async (claims) => {
        verifiedBody = claims;
        const verified = verifyPracticePlacements({ ...league(), placements: claims.placements });
        return ok({ verified: { digest: claims.digest, refused: verified.refused }, ...verified });
      },
      config: CONFIG,
      createWorker: () => /** @type {any} */ (new InProcessWorker()),
    });
    assert.equal(outcome.kind, 'verified');
    assert.equal(verifiedBody.digest, digest);
    assert.deepEqual(outcome.data.verified.refused, []);
    const direct = await runPracticeOptimizer({
      ...league(),
      config: LEAGUE_CONFIG,
      cpuCapMs: Infinity,
    });
    assert.deepEqual(
      byUnit(outcome.data.placements).map(unitIdOf),
      byUnit(direct.placements).map(unitIdOf)
    );
    assert.equal(outcome.data.bestScore, direct.bestScore);
  });
});

describe('the worker chunk has a budget of its own', () => {
  const budget = JSON.parse(
    readFileSync(path.join(process.cwd(), 'config/bundle-budget.json'), 'utf8')
  );
  const rule = budget.rules.find((r) => r.label === 'practice optimizer worker');
  /** @type {any[]} */
  const FILES = [
    { path: 'assets/index-ENTRY111.js', size: 400000, gz: 100000 },
    { path: 'assets/practiceOptimizer.worker-AbC123xy.js', size: 120000, gz: 30000 },
  ];
  const evaluate = (/** @type {any[]} */ rules) =>
    evaluateBudget({
      files: FILES,
      budget: { rules, totalFirstPaintGzipBytes: 296000 },
      firstPaint: parseHtml(),
      gzipSize: (/** @type {any} */ f) => f.gz,
    });
  function parseHtml() {
    return { entries: ['assets/index-ENTRY111.js'], assets: ['assets/index-ENTRY111.js'] };
  }
  const entryRule = {
    match: '^assets/index-.*\\.js$',
    label: 'main entry',
    firstPaint: true,
    maxGzipBytes: 190000,
  };

  it('is a lazy rule at 40,000 B gzip, with its reason, that matches the file Vite emits', () => {
    assert.ok(rule, 'config/bundle-budget.json has no "practice optimizer worker" rule');
    assert.equal(rule.maxGzipBytes, 40_000);
    assert.equal(rule.firstPaint, undefined, 'a worker is never first paint');
    assert.match(rule.rationale, /\S/);
    assert.ok(new RegExp(rule.match).test(FILES[1].path));
    assert.ok(!new RegExp(rule.match).test(FILES[0].path));
  });

  it('passes at its cap and fails at a 1 KB cap (the check can fail)', () => {
    const set = evaluate([entryRule, rule]);
    assert.deepEqual(set.violations, []);
    assert.ok(set.passed.some((line) => line.includes('practice optimizer worker')));

    const tight = evaluate([entryRule, { ...rule, maxGzipBytes: 1000 }]);
    assert.equal(tight.violations.length, 1);
    assert.match(
      tight.violations[0],
      /\[GZIP\] practice optimizer worker .* exceeds budget 1000 B/
    );
  });

  it('a renamed worker chunk escapes nothing: a rule that matches no file fails the gate', () => {
    const renamed = evaluateBudget({
      files: [FILES[0], { path: 'assets/optimizer-XYZ.js', size: 1, gz: 1 }],
      budget: { rules: [entryRule, rule], totalFirstPaintGzipBytes: 296000 },
      firstPaint: parseHtml(),
      gzipSize: (/** @type {any} */ f) => f.gz,
    });
    assert.ok(
      renamed.violations.some((v) => v.startsWith('[NO MATCH] rule "practice optimizer worker"'))
    );
  });
});
