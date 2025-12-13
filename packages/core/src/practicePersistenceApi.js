/**
 * Orchestrates server-side handling of practice persistence requests by combining
 * auth, validation, and transactional Supabase upserts.
 */

import {
    authorizePracticePersistenceRequest,
    handlePracticePersistence,
    persistPracticeSnapshotTransactional,
} from './practicePersistenceHandler.js';

/**
 * Process a practice persistence request in a server or Edge Function context.
 *
 * @param {Object} params
 * @param {Object} params.supabaseClient - Client exposing transaction + from().
 * @param {Object} [params.requestBody] - Parsed JSON body containing snapshot, overrides, runMetadata.
 * @param {Object} [params.user] - Authenticated user record with role metadata.
 * @param {Array<string>} [params.allowedRoles] - Allowed roles for persistence.
 * @param {Date} [params.now] - Clock injection for deterministic responses.
 * @returns {Promise<Object>} Normalized response for API handlers to relay.
 */
export async function processPracticePersistenceRequest({
    supabaseClient,
    requestBody = {},
    user,
    allowedRoles,
    now = new Date(),
} = {}) {
    const authResult = authorizePracticePersistenceRequest({ user, allowedRoles });
    if (authResult.status !== 'authorized') {
        return authResult;
    }

    const { snapshot, overrides = [], runMetadata = {} } = requestBody || {};

    try {
        const validationResult = handlePracticePersistence({ snapshot, overrides, now });
        if (validationResult.status !== 'success') {
            return validationResult;
        }

        return await persistPracticeSnapshotTransactional({
            supabaseClient,
            snapshot,
            runMetadata,
            now,
        });
    } catch (error) {
        return {
            status: 'error',
            message: error?.message || 'Failed to persist practice snapshot.',
        };
    }
}
