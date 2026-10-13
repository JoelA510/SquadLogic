import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { supabase } from '../frontend/src/lib/supabaseClient.js';
import { persistGameScheduleReview } from '../frontend/src/utils/gamePersistenceClient.js';
import {
  PERSISTENCE_TIMEOUT,
  PERSISTENCE_TIMEOUT_MS,
  PERSISTENCE_UNREADABLE_RESPONSE,
} from '../frontend/src/lib/persistenceRequest.js';
import { settleWithin } from './helpers/index.js';

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('requires an authenticated session before applying game schedule changes', async () => {
  vi.mocked(supabase.auth.getSession).mockResolvedValue(
    /** @type {any} */ ({ data: { session: null }, error: null })
  );
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  await assert.rejects(
    () => persistGameScheduleReview({ assignments: [] }),
    /Authentication required to apply game schedule changes/
  );
  assert.equal(fetchMock.mock.calls.length, 0);
});

test('posts Supabase-ready game rows and org metadata to the persistence endpoint', async () => {
  vi.mocked(supabase.auth.getSession).mockResolvedValue({
    data: { session: /** @type {any} */ ({ access_token: 'token-123' }) },
    error: null,
  });

  /** @type {string | undefined} */
  let capturedUrl;
  /** @type {any} */
  let capturedOptions;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'success', runId: 'run-game-1' }),
      };
    })
  );

  const result = await persistGameScheduleReview({
    assignments: [
      {
        division: 'U10',
        weekIndex: 1,
        slotId: 'slot-1',
        start: '2026-04-04T08:00:00Z',
        end: '2026-04-04T09:00:00Z',
        fieldId: 'field-1',
        homeTeamId: 'team-1',
        awayTeamId: 'team-2',
        source: 'locked',
      },
    ],
    runMetadata: {
      organizationId: 'org-1',
      seasonSettingsId: 'season-1',
      parameters: { generationMode: 'round-robin' },
    },
  });

  assert.match(capturedUrl, /\/functions\/v1\/game-persistence$/);
  assert.equal(capturedOptions.method, 'POST');
  assert.equal(capturedOptions.headers.Authorization, 'Bearer token-123');

  const body = JSON.parse(capturedOptions.body);
  assert.deepEqual(body.runMetadata, {
    organizationId: 'org-1',
    seasonSettingsId: 'season-1',
    parameters: { generationMode: 'round-robin' },
  });
  assert.equal(body.snapshot.lastRunId, null);
  assert.deepEqual(body.snapshot.payload.assignmentRows, [
    {
      division: 'U10',
      week_index: 1,
      game_slot_id: 'slot-1',
      slot_id: 'slot-1',
      start: '2026-04-04T08:00:00.000Z',
      end: '2026-04-04T09:00:00.000Z',
      field_id: 'field-1',
      home_team_id: 'team-1',
      away_team_id: 'team-2',
      assignment_source: 'manual',
      run_id: null,
    },
  ]);
  assert.equal(result.runId, 'run-game-1');
});

test('surfaces game persistence errors from the edge function', async () => {
  vi.mocked(supabase.auth.getSession).mockResolvedValue({
    data: { session: /** @type {any} */ ({ access_token: 'token-123' }) },
    error: null,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ message: 'Access denied: data belongs to a different organization' }),
    }))
  );

  await assert.rejects(
    () =>
      persistGameScheduleReview({
        assignments: [
          {
            division: 'U10',
            weekIndex: 1,
            slotId: 'slot-1',
            start: '2026-04-04T08:00:00Z',
            end: '2026-04-04T09:00:00Z',
            homeTeamId: 'team-1',
            awayTeamId: 'team-2',
          },
        ],
      }),
    /Access denied/
  );
});

// M2.5 (audit finding 5.2): a stalled Edge Function used to leave Apply
// spinning forever. The deadline and the unreadable-success rule are
// `lib/persistenceRequest.js`'s; these cases drive them through the client.

const STAGED_GAME = {
  division: 'U10',
  weekIndex: 1,
  slotId: 'slot-1',
  start: '2026-04-04T08:00:00Z',
  end: '2026-04-04T09:00:00Z',
  homeTeamId: 'team-1',
  awayTeamId: 'team-2',
};

function signIn() {
  vi.mocked(supabase.auth.getSession).mockResolvedValue({
    data: { session: /** @type {any} */ ({ access_token: 'token-123' }) },
    error: null,
  });
}

test('a request that never answers is aborted at the deadline with a timeout error', async () => {
  vi.useFakeTimers();
  try {
    signIn();
    /** @type {AbortSignal | undefined} */
    let sentSignal;
    // A fetch that never resolves and ignores its signal: the deadline must
    // not depend on the transport honouring the abort.
    vi.stubGlobal(
      'fetch',
      vi.fn((_url, init) => {
        sentSignal = init.signal;
        return new Promise(() => {});
      })
    );

    const outcome = persistGameScheduleReview({ assignments: [STAGED_GAME] }).then(
      () => ({ ok: true, err: undefined }),
      (err) => ({ ok: false, err })
    );

    assert.equal(
      await settleWithin(outcome, PERSISTENCE_TIMEOUT_MS - 2000),
      false,
      'settled before the deadline'
    );
    assert.equal(
      await settleWithin(outcome, 5000),
      true,
      'the save is still pending 5 s past the deadline'
    );
    const { ok, err } = await outcome;
    assert.equal(ok, false);
    assert.equal(err.code, PERSISTENCE_TIMEOUT);
    assert.equal(err.status, null);
    assert.ok(
      err.message.startsWith(
        `The game schedule save did not answer within ${PERSISTENCE_TIMEOUT_MS / 1000} seconds`
      ),
      err.message
    );
    assert.match(err.message, /not known whether the changes were saved/);
    assert.equal(sentSignal?.aborted, true, 'the request was not aborted');
  } finally {
    vi.useRealTimers();
  }
});

test('a request that honours the abort still rejects with the timeout, not an AbortError', async () => {
  vi.useFakeTimers();
  try {
    signIn();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted.', 'AbortError'))
            );
          })
      )
    );

    const outcome = persistGameScheduleReview({ assignments: [STAGED_GAME] }).then(
      () => undefined,
      (err) => err
    );
    assert.equal(await settleWithin(outcome, PERSISTENCE_TIMEOUT_MS + 5000), true);
    const err = await outcome;
    assert.equal(err?.code, PERSISTENCE_TIMEOUT);
  } finally {
    vi.useRealTimers();
  }
});

test('a body that stalls after the headers is under the same deadline', async () => {
  vi.useFakeTimers();
  try {
    signIn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }))
    );

    const outcome = persistGameScheduleReview({ assignments: [STAGED_GAME] }).then(
      () => undefined,
      (err) => err
    );
    assert.equal(await settleWithin(outcome, PERSISTENCE_TIMEOUT_MS + 5000), true);
    assert.equal((await outcome)?.code, PERSISTENCE_TIMEOUT);
  } finally {
    vi.useRealTimers();
  }
});

test('an answer before the deadline clears the timer', async () => {
  vi.useFakeTimers();
  try {
    signIn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ status: 'success', runId: 'run-game-2' }),
      }))
    );
    const result = await persistGameScheduleReview({ assignments: [STAGED_GAME] });
    assert.equal(result.runId, 'run-game-2');
    assert.equal(vi.getTimerCount(), 0, 'the deadline timer outlived the request');
  } finally {
    vi.useRealTimers();
  }
});

test('a 2xx whose body cannot be read is an error, not an empty success', async () => {
  signIn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    }))
  );

  await assert.rejects(
    () => persistGameScheduleReview({ assignments: [STAGED_GAME] }),
    (err) => {
      assert.equal(/** @type {any} */ (err).code, PERSISTENCE_UNREADABLE_RESPONSE);
      assert.equal(/** @type {any} */ (err).status, 200);
      assert.match(/** @type {Error} */ (err).message, /could not be read \(HTTP 200\)/);
      return true;
    }
  );
});

test('a 2xx whose body is JSON but not an object is an error too', async () => {
  signIn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => null }))
  );
  await assert.rejects(
    () => persistGameScheduleReview({ assignments: [STAGED_GAME] }),
    (err) => /** @type {any} */ (err).code === PERSISTENCE_UNREADABLE_RESPONSE
  );
});

test('a 2xx whose body is a JSON array is an error too', async () => {
  signIn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }))
  );
  await assert.rejects(
    () => persistGameScheduleReview({ assignments: [STAGED_GAME] }),
    (err) => /** @type {any} */ (err).code === PERSISTENCE_UNREADABLE_RESPONSE
  );
});

test('an error status with an unreadable body keeps its HTTP status message', async () => {
  signIn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    }))
  );
  await assert.rejects(
    () => persistGameScheduleReview({ assignments: [STAGED_GAME] }),
    /Game persistence failed: 502/
  );
});
