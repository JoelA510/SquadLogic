import { DEFAULT_ALLOWED_ROLES, PERSISTENCE_STATUS } from './constants.js';

/**
 * Authorize a persistence request.
 *
 * @param {Object} params
 * @param {Object} [params.user] - Authenticated user record.
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
 * @param {Object} params
 * @param {Object} params.snapshot - The snapshot payload.
 * @returns {Object} { status: 'success' | 'error', message? }
 */
export function validateSnapshot({ snapshot } = {}) {
    if (!snapshot || typeof snapshot !== 'object') {
        return {
            status: PERSISTENCE_STATUS.ERROR,
            message: 'Invalid snapshot payload.',
        };
    }

    if (!snapshot.payload || !Array.isArray(snapshot.payload.assignmentRows)) {
        return {
            status: PERSISTENCE_STATUS.ERROR,
            message: 'Snapshot must contain an assignmentRows array in its payload.',
        };
    }

    return { status: 'success' };
}

/**
 * Generic handler for validating persistence requests.
 *
 * @param {Object} params
 * @param {Object} params.snapshot
 * @param {Array} params.overrides
 * @param {Date} params.now
 * @param {Function} params.snapshotNormalizer - Function to normalize/validate snapshot.
 * @param {Function} params.overrideEvaluator - Function to check for pending overrides.
 * @param {string} params.successMessage
 * @returns {Object} Response object.
 */
export function handlePersistenceRequest({
    snapshot,
    overrides = [],
    now = new Date(),
    snapshotNormalizer,
    overrideEvaluator,
    successMessage,
}) {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new TypeError('now must be a valid Date');
    }

    if (typeof snapshotNormalizer !== 'function') {
        throw new TypeError('snapshotNormalizer must be a function');
    }
    if (typeof overrideEvaluator !== 'function') {
        throw new TypeError('overrideEvaluator must be a function');
    }

    const normalizedSnapshot = snapshotNormalizer(snapshot);
    const { pending } = overrideEvaluator(overrides);

    if (pending > 0) {
        return {
            status: 'blocked',
            message: `${pending} manual override${pending === 1 ? ' is' : 's are'} still pending review.`,
            pendingOverrides: pending,
            runId: normalizedSnapshot.runId,
        };
    }

    return {
        status: 'success',
        message: successMessage,
        syncedAt: now.toISOString(),
        ...normalizedSnapshot,
    };
}

/**
 * Persist a snapshot transactionally using a generic RPC.
 *
 * @param {Object} params
 * @param {Object} params.supabaseClient
 * @param {Object} params.snapshot
 * @param {Object} params.runMetadata
 * @param {Date} params.now
 * @param {string} params.runType - 'practice' or 'game'
 * @param {string} params.rpcName - Name of the RPC function to call
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
        : null;

    let rpcArgs;
    if (transformPayload) {
        rpcArgs = transformPayload({ snapshot, runMetadata, nowIso: now.toISOString(), runId: runMetadata?.runId });
    } else {
        const { assignmentRows } = snapshot.payload;
        rpcArgs = {
            run_data: runData,
            assignments: assignmentRows,
        };
    }

    // Call the RPC function
    const { data, error } = await supabaseClient.rpc(rpcName, rpcArgs);

    if (error) {
        throw new Error(`Failed to persist ${runType ?? 'schedule'} via ${rpcName}: ${error.message}`);
    }

    return {
        status: PERSISTENCE_STATUS.SUCCESS,
        message: `Successfully persisted schedule via ${rpcName}.`,
        syncedAt: now.toISOString(),
        runId: runMetadata?.runId,
        data: {
            runId: runMetadata?.runId,
            results: data,
        },
    };
}
