/**
 * Phase D PR D (plan `docs/changes/2026-10-27-phase-d-scheduling.md`, D2 and D3): `useAutoScheduler`
 * runs the search in the browser's Web Worker where it can, has the server verify the result, and
 * runs the server's own search -- saying which ran -- when the browser cannot.
 *
 * The worker is a fake the test drives; its real job and the real `verify` are held to one another
 * in `tests/practiceOptimizerWorker.test.js`. Here the subject is the hook's decisions: which
 * requests it makes in which order and with which body, what it shows while they run, what a
 * cancel does, and that the answer says where the search ran.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const channelCalls = vi.hoisted(() => ({ made: 0 }));
vi.mock('../frontend/src/lib/supabaseClient.js', () => {
  const channel = { on: () => channel, subscribe: () => channel };
  return {
    supabase: {
      auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) },
      channel: () => {
        channelCalls.made += 1;
        return channel;
      },
      removeChannel: () => {},
    },
  };
});

const { PERSISTENCE_TIMEOUT_MS } = await import('../frontend/src/lib/persistenceRequest.js');
const { useAutoScheduler } = await import('../frontend/src/hooks/useAutoScheduler.js');
const { edgeFunctionCache } = await import('../frontend/src/lib/cache.js');

const ORG = '11111111-1111-4111-8111-111111111111';
const SEASON = '22222222-2222-4222-8222-222222222222';
const DIGEST = 'a'.repeat(64);

/** A worker the test drives by hand. */
class FakeWorker {
  /** @type {FakeWorker[]} */
  static instances = [];
  static failToConstruct = false;
  /** @type {any} */
  onmessage = null;

  constructor() {
    if (FakeWorker.failToConstruct) throw new Error('module workers are not supported');
    /** @type {any[]} */
    this.sent = [];
    this.terminated = 0;
    FakeWorker.instances.push(this);
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
  finish() {
    this.say({
      type: 'result',
      placements: [{ teamId: 't-1', slotId: 's-1' }],
      run: {
        seedScore: 0.5,
        bestScore: 0.9,
        iterations: 300,
        restarts: 1,
        elapsedMs: 4000,
        terminationReason: 'max-iterations',
      },
    });
  }
}

/** A solve-shaped answer, as the function gives both a `solve` and a `verify`. */
const solved = (extra = {}) => ({
  runId: 'run-1',
  assignments: [{ teamId: 't-1', slotId: 's-1', source: 'auto' }],
  unassigned: [],
  evaluation: {},
  optimization: {
    seedScore: 0.5,
    bestScore: 0.9,
    improvement: 0.4,
    iterations: 300,
    restarts: 1,
    elapsedMs: 4000,
    terminationReason: 'max-iterations',
  },
  ...extra,
});
const prepared = { mode: 'prepare', digest: DIGEST, input: { version: 1 } };

/** Answers each request by its `mode`, and records the bodies in order. */
function stubFetch(answers) {
  const bodies = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      const answer = answers[body.mode ?? 'solve'];
      const { status = 200, ...payload } = typeof answer === 'function' ? answer(body) : answer;
      return { ok: status < 400, status, json: async () => payload };
    })
  );
  return bodies;
}

let runCount = 0;
/** A distinct input per call, so the hook's TTL cache never answers instead. */
function inputs(overrides = {}) {
  runCount += 1;
  return {
    teams: [{ id: `t-${runCount}`, division: 'U10' }],
    slots: [{ id: 's-1', start: 'a', end: 'b', capacity: 1 }],
    lockedAssignments: [{ id: 'row-1', teamId: 'x', slotId: 's-1' }],
    seasonSettingsId: SEASON,
    config: { timeBudgetMs: 8000, maxIterations: 300, seed: 7 },
    ...overrides,
  };
}

async function run(result, args = inputs()) {
  let finished;
  await act(async () => {
    finished = result.current.trigger(args);
  });
  return { args, finished };
}

beforeEach(() => {
  FakeWorker.instances = [];
  FakeWorker.failToConstruct = false;
  channelCalls.made = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  edgeFunctionCache.clear();
});

describe('where the browser cannot run a worker, the server runs the search as it always did', () => {
  it('one request, no mode in it, the progress channel, and the answer says "server"', async () => {
    const bodies = stubFetch({ solve: solved() });
    const { result } = renderHook(() => useAutoScheduler({ organizationId: ORG }));
    const { args, finished } = await run(result);
    await act(async () => finished);
    expect(bodies).toHaveLength(1);
    expect('mode' in bodies[0]).toBe(false);
    expect(bodies[0]).toEqual({
      organizationId: ORG,
      seasonSettingsId: SEASON,
      teams: args.teams,
      slots: args.slots,
      divisionPreferences: {},
      lockedAssignments: args.lockedAssignments,
      scoringWeights: {},
      config: args.config,
    });
    expect(channelCalls.made).toBe(1);
    expect(result.current.status).toBe('completed');
    expect(result.current.result.ranIn).toBe('server');
    // A browser with no Worker never tried one: the result says why the server ran it.
    expect(result.current.result.ranNote).toBe('unavailable');
    expect(result.current.result.verified).toBeNull();
    expect(result.current.progress.phase).toBeUndefined();
  });
});

describe('where it can, the worker searches and the server verifies', () => {
  beforeEach(() => vi.stubGlobal('Worker', FakeWorker));

  it('prepare, then the worker, then verify with the same body plus the worker’s claims', async () => {
    const bodies = stubFetch({
      prepare: prepared,
      verify: solved({ verified: { digest: DIGEST, refused: [] } }),
    });
    const { result } = renderHook(() => useAutoScheduler({ organizationId: ORG }));
    const { args, finished } = await run(result);

    // While prepare is answered and the worker searches, the panel is told what is happening.
    await waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    const worker = FakeWorker.instances[0];
    expect(worker.sent[0].config).toEqual({ seed: 7, maxIterations: 300, timeBudgetMs: 20_000 });
    expect(worker.sent[0].input).toEqual(prepared.input);
    expect(result.current.progress.phase).toBe('searching');
    act(() =>
      worker.say({
        type: 'progress',
        iteration: 100,
        bestScore: 0.8,
        elapsedMs: 900,
        restartCount: 0,
      })
    );
    expect(result.current.progress).toEqual({
      iteration: 100,
      bestScore: 0.8,
      elapsedMs: 900,
      phase: 'searching',
    });
    expect(result.current.status).toBe('running');

    await act(async () => {
      worker.finish();
      await finished;
    });
    expect(bodies.map((b) => b.mode)).toEqual(['prepare', 'verify']);
    const { mode: _p, ...prepareBody } = bodies[0];
    const { mode: _v, digest, placements, browserRun, ...verifyBody } = bodies[1];
    expect(prepareBody).toEqual(verifyBody);
    expect(verifyBody.teams).toEqual(args.teams);
    expect(verifyBody.lockedAssignments).toEqual(args.lockedAssignments);
    expect(digest).toBe(DIGEST);
    expect(placements).toEqual([{ teamId: 't-1', slotId: 's-1' }]);
    expect(browserRun).toEqual({
      seedScore: 0.5,
      iterations: 300,
      restarts: 1,
      elapsedMs: 4000,
      terminationReason: 'max-iterations',
    });

    expect(result.current.status).toBe('completed');
    expect(result.current.result.ranIn).toBe('browser');
    expect(result.current.result.ranNote).toBeNull();
    expect(result.current.result.verified).toEqual({ digest: DIGEST, refused: [] });
    expect(result.current.result.assignments).toHaveLength(1);
    // The search ran here, so there was nothing on the server to follow.
    expect(channelCalls.made).toBe(0);
    expect(worker.terminated).toBe(1);
  });

  it('carries what the server’s check refused into the result', async () => {
    const refused = [{ teamId: 't-1', slotId: 's-1', rule: 'capacity' }];
    stubFetch({
      prepare: prepared,
      verify: solved({
        unassigned: [{ teamId: 't-1', reason: 'verify-refused', rule: 'capacity' }],
        verified: { digest: DIGEST, refused },
      }),
    });
    const { result } = renderHook(() => useAutoScheduler({ organizationId: ORG }));
    const { finished } = await run(result);
    await waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    await act(async () => {
      FakeWorker.instances[0].finish();
      await finished;
    });
    expect(result.current.result.verified.refused).toEqual(refused);
    expect(result.current.result.unassigned[0].reason).toBe('verify-refused');
  });

  it('Cancel terminates the worker at once, ends the run, and asks the server for nothing more', async () => {
    const bodies = stubFetch({ prepare: prepared, verify: solved(), solve: solved() });
    const { result } = renderHook(() => useAutoScheduler({ organizationId: ORG }));
    const { finished } = await run(result);
    await waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    const worker = FakeWorker.instances[0];
    await act(async () => {
      result.current.cancel();
      await finished;
    });
    expect(worker.terminated).toBe(1);
    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeNull();
    expect(bodies.map((b) => b.mode)).toEqual(['prepare']);
  });

  it('a worker that errors hands the run to the server, says why, and follows its progress', async () => {
    const bodies = stubFetch({ prepare: prepared, solve: solved() });
    const { result } = renderHook(() => useAutoScheduler({ organizationId: ORG }));
    const { finished } = await run(result);
    await waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    await act(async () => {
      FakeWorker.instances[0].say({ type: 'error', message: 'boom' });
      await finished;
    });
    expect(bodies.map((b) => b.mode)).toEqual(['prepare', undefined]);
    expect('mode' in bodies[1]).toBe(false);
    expect(result.current.status).toBe('completed');
    expect(result.current.result.ranIn).toBe('server');
    expect(result.current.result.ranNote).toBe('worker-error');
    expect(channelCalls.made).toBe(1);
  });

  it('a browser that cannot construct the worker goes straight to the server', async () => {
    FakeWorker.failToConstruct = true;
    const bodies = stubFetch({ prepare: prepared, solve: solved() });
    const { result } = renderHook(() => useAutoScheduler({ organizationId: ORG }));
    const { finished } = await run(result);
    await act(async () => finished);
    expect(bodies.map((b) => b.mode)).toEqual(['prepare', undefined]);
    expect(result.current.result.ranIn).toBe('server');
    expect(result.current.result.ranNote).toBe('unavailable');
  });

  it('a verify that refuses the input (409 INPUT_CHANGED) runs the server’s search on the new data', async () => {
    const bodies = stubFetch({
      prepare: prepared,
      verify: { status: 409, error: 'The season changed', code: 'INPUT_CHANGED' },
      solve: solved(),
    });
    const { result } = renderHook(() => useAutoScheduler({ organizationId: ORG }));
    const { finished } = await run(result);
    await waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    await act(async () => {
      FakeWorker.instances[0].finish();
      await finished;
    });
    expect(bodies.map((b) => b.mode)).toEqual(['prepare', 'verify', undefined]);
    expect(result.current.result.ranIn).toBe('server');
    expect(result.current.result.ranNote).toBe('input-changed');
    expect(result.current.status).toBe('completed');
  });

  it('a server that could not write the input down for the browser runs the search itself', async () => {
    const bodies = stubFetch({
      prepare: { status: 422, error: 'not handed over', code: 'SOLVER_INPUT_UNENCODABLE' },
      solve: solved(),
    });
    const { result } = renderHook(() => useAutoScheduler({ organizationId: ORG }));
    const { finished } = await run(result);
    await act(async () => finished);
    expect(bodies.map((b) => b.mode)).toEqual(['prepare', undefined]);
    expect(FakeWorker.instances).toHaveLength(0);
    expect(result.current.status).toBe('completed');
    expect(result.current.result.ranIn).toBe('server');
    expect(result.current.result.ranNote).toBe('prepare-failed');
    expect(channelCalls.made).toBe(1);
  });

  it('any other refusal is the run’s answer: the server is not asked to say it again', async () => {
    const bodies = stubFetch({
      prepare: { status: 503, error: 'The practice assignments could not be read', code: 'X' },
      solve: solved(),
    });
    const { result } = renderHook(() => useAutoScheduler({ organizationId: ORG }));
    const { finished } = await run(result);
    await act(async () => finished);
    expect(result.current.status).toBe('failed');
    expect(result.current.error).toBe('The practice assignments could not be read');
    expect(bodies.map((b) => b.mode)).toEqual(['prepare']);
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('a prepare that never answers fails at the deadline, and does not send the admin looking for a recorded run', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Promise(() => {}))
      );
      const { result } = renderHook(() => useAutoScheduler({ organizationId: ORG }));
      let finished;
      await act(async () => {
        finished = result.current.trigger(inputs());
        await vi.advanceTimersByTimeAsync(PERSISTENCE_TIMEOUT_MS + 1000);
        await finished;
      });
      expect(result.current.status).toBe('failed');
      // The solve path says the run "may have finished and been recorded"; a prepare records nothing.
      expect(result.current.error).toBe(
        `The auto-scheduler did not answer within ${PERSISTENCE_TIMEOUT_MS / 1000} seconds`
      );
      expect(FakeWorker.instances).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a function that does not know prepare and ran the whole solve: that run is the answer', async () => {
    const bodies = stubFetch({ prepare: solved() });
    const { result } = renderHook(() => useAutoScheduler({ organizationId: ORG }));
    const { finished } = await run(result);
    await act(async () => finished);
    expect(bodies).toHaveLength(1);
    expect(FakeWorker.instances).toHaveLength(0);
    expect(result.current.status).toBe('completed');
    expect(result.current.result.ranIn).toBe('server');
    expect(result.current.result.assignments).toHaveLength(1);
  });

  it('the same inputs inside five minutes answer from the cache, whichever side ran', async () => {
    const bodies = stubFetch({ prepare: prepared, verify: solved() });
    const { result } = renderHook(() => useAutoScheduler({ organizationId: ORG }));
    const args = inputs();
    const first = await run(result, args);
    await waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    await act(async () => {
      FakeWorker.instances[0].finish();
      await first.finished;
    });
    expect(bodies).toHaveLength(2);
    await run(result, args);
    expect(bodies).toHaveLength(2);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(result.current.result.ranIn).toBe('browser');
  });
});
