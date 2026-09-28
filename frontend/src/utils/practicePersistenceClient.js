import { preparePracticePersistenceSnapshot } from '@squadlogic/core/practicePersistenceSnapshot.js';
import { PRACTICE_PERSISTENCE_URL } from '../config.js';
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
