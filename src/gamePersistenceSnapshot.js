import { buildGameAssignmentRows } from './gameSupabase.js';
import {
    normalizeRunHistory,
    normalizeRunMetadata,
    normalizeSchedulerRuns,
    buildRunHistoryFromSchedulerRuns,
    deriveRunMetadataFromNormalizedSchedulerRuns,
} from './teamPersistenceSnapshot.js';

function mergeRunMetadata({ providedRunMetadata, derivedRunMetadata, fallbackRunId }) {
    if (providedRunMetadata == null) {
        return normalizeRunMetadata(derivedRunMetadata, fallbackRunId);
    }

    if (typeof providedRunMetadata !== 'object' || Array.isArray(providedRunMetadata)) {
        throw new TypeError('runMetadata must be an object');
    }

    return normalizeRunMetadata({ ...derivedRunMetadata, ...providedRunMetadata }, fallbackRunId);
}

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
