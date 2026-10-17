// M2.5 (audit finding 5.2): every request the practice persistence client
// sends -- the ordinary save, the repair save and the enact -- has a deadline,
// and a 2xx whose body cannot be read is an error, not an empty success.
//
// The three senders are checked against the module's exports, not the calls a
// page happens to make: a new exported function has to be added below or the
// coverage assertion fails, and a direct `fetch(` in either client fails the
// source check.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it, vi } from 'vitest';

import {
  PERSISTENCE_INVALID_PAYLOAD,
  PERSISTENCE_TIMEOUT,
  PERSISTENCE_TIMEOUT_MS,
  PERSISTENCE_UNREADABLE_RESPONSE,
} from '../frontend/src/lib/persistenceRequest.js';
import * as practiceClient from '../frontend/src/utils/practicePersistenceClient.js';
import { settleWithin } from './helpers/index.js';
import { MOCK_SEASON_ID } from '../frontend/src/lib/mockSeedIds.js';

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'token-m25' } } }),
    },
  },
}));

const ENACT_KEY = '00000000-0000-4000-8000-0000000000e5';

const SAVE_ARGS = {
  assignments: [{ teamId: 't1', slotId: 'slot-a' }],
  slots: [{ id: 'slot-a', effectiveFrom: '2026-09-01', effectiveUntil: '2026-11-30' }],
  runId: undefined,
  runMetadata: { seasonSettingsId: MOCK_SEASON_ID },
};

/** Each sender, called the way its page calls it, against the real network path. */
const SENDERS = {
  persistPracticeScheduleReview: () => practiceClient.persistPracticeScheduleReview(SAVE_ARGS),
  persistPracticeRepair: () =>
    practiceClient.persistPracticeRepair({
      ...SAVE_ARGS,
      unlock: [{ assignment_id: 'a1', reason: 'retired' }],
      closes: [{ assignment_id: 'a1', last_day: '2026-10-14' }],
      baseFingerprint: '0123456789abcdef0123456789abcdef',
    }),
  persistPracticeEnact: () =>
    practiceClient.persistPracticeEnact(
      {
        payload: { assignmentRows: [], repair: { unlock: [] } },
        enact: { enact_key: ENACT_KEY },
        runMetadata: { runId: ENACT_KEY, seasonSettingsId: MOCK_SEASON_ID },
      },
      { mock: false }
    ),
};

/**
 * Each sender with a body the Edge's `PersistencePayloadSchema` refuses (M4.4):
 * a numeric team id from the save and repair paths, and an enact row with no
 * slot. Keyed like SENDERS; the coverage case below holds the two key sets equal.
 */
const MALFORMED = {
  persistPracticeScheduleReview: {
    send: () =>
      practiceClient.persistPracticeScheduleReview({
        ...SAVE_ARGS,
        assignments: [{ teamId: 7, slotId: 'slot-a' }],
      }),
    path: 'snapshot.payload.assignmentRows.0.team_id',
  },
  persistPracticeRepair: {
    send: () =>
      practiceClient.persistPracticeRepair({
        ...SAVE_ARGS,
        assignments: [{ teamId: 7, slotId: 'slot-a' }],
        unlock: [{ assignment_id: 'a1', reason: 'retired' }],
        baseFingerprint: '0123456789abcdef0123456789abcdef',
      }),
    path: 'snapshot.payload.assignmentRows.0.team_id',
  },
  persistPracticeEnact: {
    send: () =>
      practiceClient.persistPracticeEnact(
        {
          payload: { assignmentRows: [{ team_id: 't1' }], repair: { unlock: [] } },
          enact: { enact_key: ENACT_KEY },
          runMetadata: { runId: ENACT_KEY, seasonSettingsId: MOCK_SEASON_ID },
        },
        { mock: false }
      ),
    path: 'snapshot.payload.assignmentRows.0.practice_slot_id',
  },
};

/** The label each sender's errors carry. */
const LABELS = {
  persistPracticeScheduleReview: /^The practice schedule save /,
  persistPracticeRepair: /^The practice schedule save /,
  persistPracticeEnact: /^the enact request /,
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('practice persistence client :: deadline', () => {
  for (const [name, send] of Object.entries(SENDERS)) {
    it(`${name}: a request that never answers is aborted at the deadline`, async () => {
      vi.useFakeTimers();
      /** @type {AbortSignal[]} */
      const signals = [];
      vi.stubGlobal(
        'fetch',
        vi.fn((_url, init) => {
          signals.push(init.signal);
          return new Promise(() => {});
        })
      );

      const outcome = send().then(
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
        'the request is still pending 5 s past the deadline'
      );
      const { ok, err } = await outcome;
      assert.equal(ok, false);
      assert.equal(err.code, PERSISTENCE_TIMEOUT);
      assert.match(err.message, LABELS[name]);
      assert.match(
        err.message,
        new RegExp(`did not answer within ${PERSISTENCE_TIMEOUT_MS / 1000} seconds`)
      );
      // One request, never a retry (the enact's rule, and no save retries either).
      assert.equal(signals.length, 1);
      assert.equal(signals[0]?.aborted, true, 'the request was not aborted');
    });

    it(`${name}: a 2xx whose body cannot be read is an error, not an empty success`, async () => {
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
      await assert.rejects(send, (err) => {
        assert.equal(/** @type {any} */ (err).code, PERSISTENCE_UNREADABLE_RESPONSE);
        assert.equal(/** @type {any} */ (err).status, 200);
        assert.match(/** @type {Error} */ (err).message, LABELS[name]);
        return true;
      });
    });
  }

  for (const [name, { send, path }] of Object.entries(MALFORMED)) {
    it(`${name}: a malformed payload is refused client-side, before any request`, async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      await assert.rejects(send, (err) => {
        const error = /** @type {any} */ (err);
        assert.equal(error.code, PERSISTENCE_INVALID_PAYLOAD);
        assert.equal(error.status, null);
        assert.deepEqual(
          error.issues.map((issue) => issue.path.join('.')),
          [path]
        );
        assert.match(error.message, LABELS[name]);
        assert.match(error.message, /was not sent: its data is malformed/);
        assert.ok(error.message.includes(`${path}: `), error.message);
        return true;
      });
      assert.equal(fetchMock.mock.calls.length, 0, 'a malformed payload reached the network');
    });
  }

  it('the enact clause is bare, for the panel to frame', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {}))
    );
    const outcome = SENDERS.persistPracticeEnact().then(
      () => undefined,
      (err) => err
    );
    assert.equal(await settleWithin(outcome, PERSISTENCE_TIMEOUT_MS + 5000), true);
    // PracticeRepairPanel: `It is not known whether the practice was enacted: ${message}. Close ...`
    assert.equal(
      (await outcome)?.message,
      `the enact request did not answer within ${PERSISTENCE_TIMEOUT_MS / 1000} seconds`
    );
  });

  it('a save refusal keeps its code and HTTP status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 409,
        json: async () => ({ code: 'PRACTICE_ASSIGNMENT_LOCKED', message: 'locked' }),
      }))
    );
    await assert.rejects(SENDERS.persistPracticeRepair, (err) => {
      assert.equal(/** @type {any} */ (err).code, 'PRACTICE_ASSIGNMENT_LOCKED');
      assert.equal(/** @type {any} */ (err).status, 409);
      return true;
    });
  });

  it('covers every exported function (enumerated from the module, not from this file)', () => {
    // Every function the module exports is a sender today; a new export of any
    // name must be added to SENDERS (and so to the deadline cases above).
    const exported = Object.entries(practiceClient)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .sort();
    assert.ok(exported.length > 0, 'no function export found: the enumeration examined nothing');
    assert.deepEqual(exported, Object.keys(SENDERS).sort());
    assert.deepEqual(Object.keys(MALFORMED).sort(), Object.keys(SENDERS).sort());
  });

  it('neither persistence client calls fetch directly (every request goes through the deadline)', () => {
    for (const file of [
      'frontend/src/utils/practicePersistenceClient.js',
      'frontend/src/utils/gamePersistenceClient.js',
    ]) {
      const source = readFileSync(file, 'utf8');
      assert.match(
        source,
        /postPersistenceRequest\(/,
        `${file} no longer sends through the deadline`
      );
      assert.doesNotMatch(source, /\bfetch\(/, `${file} calls fetch directly`);
    }
  });
});
