/**
 * Authorize a game persistence request.
 *
 * @param {Object} params
 * @param {Object} [params.user] - Authenticated user record.
 * @param {Array<string>} [params.allowedRoles] - Allowed roles.
 * @returns {Object} { status: 'authorized' | 'unauthorized' | 'forbidden', message? }
 */
export function authorizeGamePersistenceRequest({
    user,
    allowedRoles = ['admin', 'service_role'],
} = {}) {
    if (!user) {
        return {
            status: 'unauthorized',
            message: 'Authentication required to persist game data.',
        };
    }

    const userRole = user.role ?? 'authenticated';
    const effectiveRole = user.app_metadata?.role ?? userRole;

    if (!allowedRoles.includes(effectiveRole)) {
        return {
            status: 'forbidden',
            message: `User role "${effectiveRole}" is not authorized to persist game data.`,
        };
    }

    return { status: 'authorized' };
}

/**
 * Validate the game persistence payload.
 *
 * @param {Object} params
 * @param {Object} params.snapshot - The snapshot payload.
 * @returns {Object} { status: 'success' | 'error', message? }
 */
export function handleGamePersistence({ snapshot } = {}) {
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
 * Persist the game snapshot transactionally.
 *
 * @param {Object} params
 * @param {Object} params.supabaseClient
 * @param {Object} params.snapshot
 * @param {Object} params.runMetadata
 * @param {Date} params.now
 * @returns {Promise<Object>} Result object.
 */
export async function persistGameSnapshotTransactional({
    supabaseClient,
    snapshot,
    runMetadata,
    now,
}) {
    const { assignmentRows } = snapshot.payload;

    if (typeof supabaseClient.transaction !== 'function') {
        throw new Error('supabaseClient must support transaction()');
    }

    return await supabaseClient.transaction(async (tx) => {
        // 1. Persist Scheduler Run (if metadata provided)
        let runId = runMetadata?.runId;
        if (runId) {
            const { error: runError } = await tx.from('scheduler_runs').upsert({
                id: runId,
                run_type: 'game',
                season_settings_id: runMetadata.seasonSettingsId,
                status: 'completed',
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
        if (assignmentRows.length > 0) {
            const { error: assignError } = await tx
                .from('game_assignments')
                .upsert(assignmentRows);

            if (assignError) {
                throw new Error(`Failed to persist game assignments: ${assignError.message}`);
            }
        }

        return {
            status: 'success',
            message: `Successfully persisted ${assignmentRows.length} game assignments.`,
            data: {
                runId,
                assignmentsPersisted: assignmentRows.length,
            },
        };
    });
}
