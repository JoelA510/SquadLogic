import { prepareGamePersistenceSnapshot } from '@squadlogic/core/gamePersistenceSnapshot.js';
import { GAME_PERSISTENCE_URL } from '../config.js';
import { postPersistenceRequest } from '../lib/persistenceRequest.js';
import { supabase } from '../lib/supabaseClient.js';

/**
 * Persist a staged game schedule review through the game-persistence Edge Function.
 *
 * @param {Object} [params]
 * @param {Array<Object>} [params.assignments]
 * @param {string | undefined} [params.runId]
 * @param {Record<string, unknown>} [params.runMetadata]
 * @param {Array<Object>} [params.overrides]
 */
export async function persistGameScheduleReview({
  assignments = [],
  runId,
  runMetadata = {},
  overrides = [],
} = {}) {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;

  if (!token) {
    throw new Error('Authentication required to apply game schedule changes.');
  }

  const snapshot = prepareGamePersistenceSnapshot({
    assignments,
    runId,
    runMetadata,
  });

  const { response, result } = await postPersistenceRequest(GAME_PERSISTENCE_URL, {
    token,
    body: { snapshot, overrides, runMetadata },
    label: 'The game schedule save',
  });

  if (!response.ok) {
    throw new Error(
      result.message || result.error || `Game persistence failed: ${response.status}`
    );
  }

  return result;
}
