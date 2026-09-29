import { preparePracticePersistenceSnapshot } from '@squadlogic/core/practicePersistenceSnapshot.js';
import { IS_MOCK_MODE, PRACTICE_PERSISTENCE_URL } from '../config.js';
import { supabase } from '../lib/supabaseClient.js';

export async function persistPracticeScheduleReview({
  assignments = [],
  slots = [],
  runId,
  runMetadata = {},
}) {
  return sendPracticeSnapshot({ assignments, slots, runId, runMetadata });
}

/**
 * Save a practice repair through writer v3 (8.6 PR 3b plan §3): the same
 * snapshot as an ordinary save plus the override arguments. Every existing
 * row the save deletes, re-ranges or moves must be named in `unlock` (admin
 * only, audited per row); `closes` ends a row in place; `exceptions` and
 * `withdrawExceptions` write practice_exceptions; `baseFingerprint` refuses
 * a save built on a stale read. The Edge Function validates each with Zod
 * and the RPC re-checks them.
 */
export async function persistPracticeRepair({
  assignments = [],
  slots = [],
  runId,
  runMetadata = {},
  unlock = [],
  closes = [],
  exceptions = [],
  withdrawExceptions = [],
  baseFingerprint,
}) {
  return sendPracticeSnapshot({
    assignments,
    slots,
    runId,
    runMetadata,
    repair: {
      unlock,
      closes,
      exceptions,
      withdrawExceptions,
      ...(baseFingerprint ? { baseFingerprint } : {}),
    },
  });
}

/** The Edge's 409 for a stale base fingerprint (`_shared/practice-repair-errors.ts`). */
export const PRACTICE_SCHEDULE_STALE = 'PRACTICE_SCHEDULE_STALE';

/**
 * Enact ONE practice repair recommendation (8.6 3b PR 11c,
 * `docs/PHASE_8_6_PR11_ENACT_PLAN.md` §1 step 9, §4). The adapter's DB rows
 * go VERBATIM as `snapshot.payload.assignmentRows` (never rebuilt through
 * `preparePracticePersistenceSnapshot`, which would lose `assigned_via` and
 * the explicit ranges), with the `repair` and `enact` bodies, and the run id
 * IS the enact key. The Edge routes the call to the wrapper RPC
 * `enact_practice_recommendation`.
 *
 * **One call, never a retry.** A stale base (409 `PRACTICE_SCHEDULE_STALE`)
 * is RETURNED as `{ status: 'stale' }` for the caller to re-judge and show;
 * nothing here sends a second request. Every other refusal throws with the
 * server's message and, when the Edge gave one, its `code` and HTTP `status`.
 *
 * **Mock mode** (`IS_MOCK_MODE`) calls the mock client's twin of the wrapper
 * RPC directly, with the `run_data` the Edge would build (no Edge Function
 * runs in mock mode); `lib/mockPracticeEnact.js` lists what it mirrors.
 *
 * @param {{ payload: { assignmentRows: Object[], repair: Object }, enact: Object,
 *   runMetadata: { runId: string, seasonSettingsId: string } }} body
 * @param {{ mock?: boolean }} [options]
 * @returns {Promise<{ status: 'stale', code: string, message: string } | Record<string, any>>}
 */
export async function persistPracticeEnact({ payload, enact, runMetadata }, options = {}) {
  const { mock = IS_MOCK_MODE } = options;
  if (runMetadata?.runId !== enact?.enact_key) {
    throw new Error('an enact is sent under its own enact key as the run id');
  }
  if (mock) return persistPracticeEnactInMock({ payload, enact, runMetadata });

  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) {
    throw new Error('Authentication required to enact a practice recommendation.');
  }
  const response = await fetch(PRACTICE_PERSISTENCE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      snapshot: { payload: { assignmentRows: payload.assignmentRows }, runId: runMetadata.runId },
      overrides: [],
      runMetadata,
      repair: payload.repair,
      enact,
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (response.status === 409 && result.code === PRACTICE_SCHEDULE_STALE) {
    return { status: 'stale', code: PRACTICE_SCHEDULE_STALE, message: result.message ?? '' };
  }
  if (!response.ok) {
    throw Object.assign(
      new Error(result.message || result.error || `Practice enact failed: ${response.status}`),
      { code: result.code ?? null, status: response.status }
    );
  }
  return result;
}

/** The mock arm: the wrapper RPC's twin, with the Edge's `run_data`, and its 409. */
async function persistPracticeEnactInMock({ payload, enact, runMetadata }) {
  const now = new Date().toISOString();
  const { data, error } = await supabase.rpc('enact_practice_recommendation', {
    run_data: {
      id: runMetadata.runId,
      run_type: 'practice',
      season_settings_id: runMetadata.seasonSettingsId,
      status: 'completed',
      parameters: {},
      metrics: {},
      results: {},
      created_by: 'system',
      started_at: now,
      completed_at: now,
      updated_at: now,
    },
    assignments: payload.assignmentRows,
    unlock: payload.repair.unlock,
    closes: payload.repair.closes,
    exceptions: payload.repair.exceptions,
    base_fingerprint: payload.repair.baseFingerprint ?? null,
    enact,
  });
  if (error?.code === '40001') {
    return { status: 'stale', code: PRACTICE_SCHEDULE_STALE, message: error.message ?? '' };
  }
  if (error) {
    throw Object.assign(new Error(error.message || 'Practice enact failed.'), {
      code: error.code ?? null,
    });
  }
  return {
    status: 'success',
    runId: runMetadata.runId,
    fingerprint: data?.fingerprint ?? null,
    idempotent: data?.idempotent ?? false,
    enactAudited: data?.enact_audited ?? false,
  };
}

async function sendPracticeSnapshot({
  assignments,
  slots,
  runId,
  runMetadata,
  repair = undefined,
}) {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;

  if (!token) {
    throw new Error('Authentication required to apply practice schedule changes.');
  }

  const snapshot = preparePracticePersistenceSnapshot({
    assignments,
    slots,
    runId,
    runMetadata,
    practiceOverrides: [],
  });

  const response = await fetch(PRACTICE_PERSISTENCE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      snapshot,
      overrides: [],
      runMetadata,
      ...(repair ? { repair } : {}),
    }),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      result.message || result.error || `Practice persistence failed: ${response.status}`
    );
  }

  return result;
}
