// @ts-check
import { DEFAULT_ALLOWED_ROLES, PERSISTENCE_STATUS } from './constants.js';

/**
 * @typedef {Object} UserAppMetadata
 * @property {string} [role]
 */

/**
 * @typedef {Object} User
 * @property {string} [role]
 * @property {UserAppMetadata} [app_metadata]
 */

/**
 * @typedef {Object} PersistenceSnapshot
 * @property {Object} payload
 * @property {Array<Object>} [payload.assignmentRows]
 * @property {string | null} [lastRunId]
 * @property {string | null} [runId]
 * @property {Object} [runMetadata]
 */

/**
 * Authorize a persistence request.
 *
 * @param {Object} params
 * @param {User} [params.user] - Authenticated user record.
 * @param {Array<string>} [params.allowedRoles] - Allowed roles.
 * @param {string} [params.runType] - Type of run (practice/game) for error messages.
 * @returns {Object} { status: 'authorized' | 'unauthorized' | 'forbidden', message? }
 */
export function authorizePersistenceRequest({
    user,
    allowedRoles = DEFAULT_ALLOWED_ROLES,
    runType = 'data',
} = {}) {
    if (!user) {
        return {
            status: PERSISTENCE_STATUS.UNAUTHORIZED,
            message: `Authentication required to persist ${runType}.`,
        };
    }

    const userRole = user.role ?? 'authenticated';
    const effectiveRole = user.app_metadata?.role ?? userRole;

    if (!allowedRoles.includes(effectiveRole)) {
        return {
            status: PERSISTENCE_STATUS.FORBIDDEN,
            message: `User role "${effectiveRole}" is not authorized to persist ${runType}.`,
        };
    }

    return { status: 'authorized' };
}

/**
 * Validate the persistence payload.
 *
 * @param {Object} [params]
 * @param {PersistenceSnapshot} [params.snapshot] - The snapshot payload.
 * @returns {Object} { status: 'success' | 'error', message? }
 */
export function validateSnapshot({ snapshot } = {}) {
    if (!snapshot || typeof snapshot !== 'object') {
        return { status: 'error', message: 'Invalid snapshot payload.' };
    }
    // @ts-ignore
    if (!snapshot.payload || typeof snapshot.payload !== 'object') {
        return { status: 'error', message: 'Snapshot must contain an assignmentRows array in its payload.' };
    }
    return { status: 'success' };
}

/**
 * Generic handler for validating persistence requests.
 *
 * @param {Object} params
 * @param {PersistenceSnapshot} [params.snapshot]
 * @param {Array<any>} [params.overrides]
 * @param {Date} params.now
 * @param {function(PersistenceSnapshot): any} params.snapshotNormalizer - Function to normalize/validate snapshot.
 * @param {function(Array<any>): { pending: number }} params.overrideEvaluator - Function to check for pending overrides.
 * @param {string} params.successMessage
 * @returns {Object} Response object.
 */
export function handlePersistenceRequest({
    // @ts-ignore
    snapshot,
    overrides = [],
    now = new Date(),
    snapshotNormalizer,
    overrideEvaluator,
    successMessage,
}) {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        return { status: 'error', message: 'Invalid server time configuration.' };
    }

    // @ts-ignore
    const structureValidation = validateSnapshot({ snapshot });
    if (structureValidation.status !== 'success') {
        return structureValidation;
    }

    let normalizedSnapshot;
    try {
        // @ts-ignore
        normalizedSnapshot = snapshotNormalizer(snapshot); // Throws if invalid
    } catch (err) {
        // @ts-ignore
        return { status: 'error', message: err.message };
    }

    // Check for pending overrides
    const { pending } = overrideEvaluator(overrides);
    if (pending > 0) {
        return {
            status: 'blocked',
            message: `${pending} manual override${pending === 1 ? ' is' : 's are'} still pending review.`,
            pendingOverrides: pending,
            runId: normalizedSnapshot.runId,
        };
    }

    return { status: 'success', message: successMessage };
}

/**
 * Persist a snapshot transactionally using a generic RPC.
 *
 * @param {Object} params
 * @param {Object} params.supabaseClient
 * @param {PersistenceSnapshot} params.snapshot
 * @param {Object} [params.runMetadata]
 * @param {string} [params.runMetadata.runId]
 * @param {string} [params.runMetadata.seasonSettingsId]
 * @param {Object} [params.runMetadata.parameters]
 * @param {Object} [params.runMetadata.metrics]
 * @param {Object} [params.runMetadata.results]
 * @param {string} [params.runMetadata.createdBy]
 * @param {string} [params.runMetadata.startedAt]
 * @param {string} [params.runMetadata.completedAt]
 * @param {Date} params.now
 * @param {string} params.runType - 'practice' or 'game' or 'team'
 * @param {string} params.rpcName - Name of the RPC function to call
 * @param {function(Object): Object} [params.transformPayload]
 * @returns {Promise<Object>} Result object.
 */
export async function persistSnapshotTransactional({
    supabaseClient,
    snapshot,
    runMetadata,
    now,
    runType,
    rpcName,
    transformPayload,
}) {
    // Prepare Run Data Payload
    const runData = runMetadata?.runId
        ? {
            id: runMetadata.runId,
            run_type: runType,
            season_settings_id: runMetadata.seasonSettingsId,
            status: 'completed',
            parameters: runMetadata.parameters ?? {},
            metrics: runMetadata.metrics ?? {},
            results: runMetadata.results ?? {},
            created_by: runMetadata.createdBy ?? 'system',
            started_at: runMetadata.startedAt ?? now.toISOString(),
            completed_at: runMetadata.completedAt ?? now.toISOString(),
            updated_at: now.toISOString(),
        }
        : {
            // Fallback if no run metadata provided (less common for transactional)
            run_type: runType,
            status: 'completed',
            updated_at: now.toISOString(),
        };

    // Transform payload if normalizer provided, otherwise use snapshot directly
    const rpcPayload = transformPayload
        ? transformPayload({ snapshot, runMetadata, nowIso: now.toISOString(), runId: runMetadata?.runId, runData })
        : { snapshot, run_data: runData };

    // Call the RPC function
    // @ts-ignore
    const { data, error } = await supabaseClient.rpc(rpcName, rpcPayload);

    if (error) {
        throw error;
    }

    return {
        status: 'success',
        runId: runMetadata?.runId ?? snapshot.runId ?? (data ? data : null),
        message: 'Persistence successful.',
        syncedAt: now.toISOString(),
    };
}
