import { persistPracticeAssignments } from './practiceSupabase.js';

/**
 * Authorize a practice persistence request.
 *
 * @param {Object} params
 * @param {Object} [params.user] - Authenticated user record.
 * @param {Array<string>} [params.allowedRoles] - Allowed roles.
 * @returns {Object} { status: 'authorized' | 'unauthorized' | 'forbidden', message? }
 */
export function authorizePracticePersistenceRequest({
    user,
    allowedRoles = ['admin', 'service_role'],
} = {}) {
    if (!user) {
        return {
            status: 'unauthorized',
            message: 'Authentication required to persist practice data.',
        };
    }

    const userRole = user.role ?? 'authenticated';
    // Check if the user's role is in the allowed list.
    // Note: Supabase JWTs often put the role in `user.role`.
    // Custom claims might need `user.app_metadata.role`.
    // We'll check both for robustness, defaulting to the standard `role`.
    const effectiveRole = user.app_metadata?.role ?? userRole;

    if (!allowedRoles.includes(effectiveRole)) {
        return {
            status: 'forbidden',
            message: `User role "${effectiveRole}" is not authorized to persist practice data.`,
        };
    }

    return { status: 'authorized' };
}

/**
 * Validate the practice persistence payload.
 *
 * @param {Object} params
 * @param {Object} params.snapshot - The snapshot payload.
 * @returns {Object} { status: 'success' | 'error', message? }
 */
export function handlePracticePersistence({ snapshot } = {}) {
    if (!snapshot || typeof snapshot !== 'object') {
        return {
            status: 'error',
            message: 'Invalid snapshot payload.',
        };
    }

    if (!snapshot.payload || !Array.isArray(snapshot.payload.assignmentRows)) {
        return {
            status: 'error',
            message: 'Snapshot must contain an assignmentRows array in its payload.',
        };
    }

    return { status: 'success' };
}

/**
 * Persist the practice snapshot transactionally.
 *
 * @param {Object} params
 * @param {Object} params.supabaseClient
 * @param {Object} params.snapshot
 * @param {Object} params.runMetadata
 * @param {Date} params.now
 * @returns {Promise<Object>} Result object.
 */
export async function persistPracticeSnapshotTransactional({
    supabaseClient,
    snapshot,
    runMetadata,
    now,
}) {
    const { assignmentRows } = snapshot.payload;

    // We need a transaction to ensure consistency.
    // If the client supports it (e.g. via our shim or future Supabase support), use it.
    if (typeof supabaseClient.transaction !== 'function') {
        throw new Error('supabaseClient must support transaction()');
    }

    return await supabaseClient.transaction(async (tx) => {
        // 1. Persist Scheduler Run (if metadata provided)
        let runId = runMetadata?.runId;
        if (runId) {
            const { error: runError } = await tx.from('scheduler_runs').upsert({
                id: runId,
                run_type: 'practice',
                season_settings_id: runMetadata.seasonSettingsId,
                status: 'completed', // Assuming persistence implies completion
                parameters: runMetadata.parameters ?? {},
                metrics: runMetadata.metrics ?? {},
                results: runMetadata.results ?? {},
                created_by: runMetadata.createdBy ?? 'system',
                started_at: runMetadata.startedAt ?? now.toISOString(),
                completed_at: runMetadata.completedAt ?? now.toISOString(),
                updated_at: now.toISOString(),
            });

            if (runError) {
                throw new Error(`Failed to persist scheduler run: ${runError.message}`);
            }
        }

        // 2. Persist Assignments
        // We use the helper from practiceSupabase.js, but pass the transaction client 'tx'
        // Note: persistPracticeAssignments expects a client with .from()
        // Our 'tx' object from the shim provides .from(), so it works.
        // However, persistPracticeAssignments builds rows internally.
        // We already have built rows in `assignmentRows`.
        // We should probably just upsert them directly here to avoid rebuilding.

        if (assignmentRows.length > 0) {
            const { error: assignError } = await tx
                .from('practice_assignments')
                .upsert(assignmentRows);

            if (assignError) {
                throw new Error(`Failed to persist practice assignments: ${assignError.message}`);
            }
        }

        return {
            status: 'success',
            message: `Successfully persisted ${assignmentRows.length} practice assignments.`,
            data: {
                runId,
                assignmentsPersisted: assignmentRows.length,
            },
        };
    });
}
