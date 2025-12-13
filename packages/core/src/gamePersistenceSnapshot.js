import { buildGameAssignmentRows } from './gameSupabase.js';
import {
    normalizeRunHistory,
    normalizeRunMetadata,
    normalizeSchedulerRuns,
    buildRunHistoryFromSchedulerRuns,
    deriveRunMetadataFromNormalizedSchedulerRuns,
    mergeRunMetadata,
} from './utils/snapshot.js';

/**
 * Prepare a persistence snapshot with Supabase-ready payloads and admin metadata.
 */
export function prepareGamePersistenceSnapshot({
    assignments = [],
    runHistory = [],
    schedulerRuns = [],
    lastSyncedAt = null,
    runId,
    runMetadata = {},
} = {}) {
    // 1. Build Supabase rows
    const assignmentRows = buildGameAssignmentRows({
        assignments,
        runId,
    });

    // 2. Normalize metadata
    const normalizedSchedulerRuns = normalizeSchedulerRuns(schedulerRuns);
    const normalizedRunHistory = normalizeRunHistory([
        ...buildRunHistoryFromSchedulerRuns(normalizedSchedulerRuns),
        ...runHistory,
    ]);
    const latestRunId = runId ?? normalizedRunHistory[0]?.runId ?? null;
    const normalizedRunMetadata = mergeRunMetadata({
        providedRunMetadata: runMetadata,
        derivedRunMetadata: deriveRunMetadataFromNormalizedSchedulerRuns(
            normalizedSchedulerRuns,
            latestRunId,
        ),
        fallbackRunId: latestRunId,
    });

    return {
        lastRunId: latestRunId,
        lastSyncedAt,
        preparedAssignmentRows: assignmentRows.length,
        runHistory: normalizedRunHistory,
        runMetadata: normalizedRunMetadata,
        payload: {
            assignmentRows,
        },
    };
}
