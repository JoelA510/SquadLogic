/**
 * Orchestrates server-side handling of team persistence requests by combining
 * auth, validation, and transactional Supabase upserts.
 */

import {
  authorizeTeamPersistenceRequest,
  handleTeamPersistence,
  persistTeamSnapshotTransactional,
} from './teamPersistenceHandler.js';

/**
 * Process a team persistence request in a server or Edge Function context.
 *
 * @param {Object} params
 * @param {Object} params.supabaseClient - Client exposing transaction + from().
 * @param {Object} [params.requestBody] - Parsed JSON body containing snapshot, overrides, runMetadata.
 * @param {Object} [params.user] - Authenticated user record with role metadata.
 * @param {Array<string>} [params.allowedRoles] - Allowed roles for persistence.
 * @param {Date} [params.now] - Clock injection for deterministic responses.
 * @returns {Promise<Object>} Normalized response for API handlers to relay.
 */
export async function processTeamPersistenceRequest({
  supabaseClient,
  requestBody = {},
  user,
  allowedRoles,
  now = new Date(),
} = {}) {
  const authResult = authorizeTeamPersistenceRequest({ user, allowedRoles });
  if (authResult.status !== 'authorized') {
    return authResult;
  }

  const { snapshot, overrides = [], runMetadata = {} } = requestBody;

  try {
    const validationResult = handleTeamPersistence({ snapshot, overrides, now });
    if (validationResult.status !== 'success') {
      return validationResult;
    }

    return await persistTeamSnapshotTransactional({
      supabaseClient,
      snapshot,
      runMetadata,
      now,
    });
  } catch (error) {
    return {
      status: 'error',
      message: error?.message || 'Failed to persist team snapshot.',
    };
  }
}
