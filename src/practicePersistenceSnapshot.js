import { buildPracticeAssignmentRows } from './practiceSupabase.js';
import {
    normalizeRunHistory,
    normalizeRunMetadata,
    normalizeSchedulerRuns,
    buildRunHistoryFromSchedulerRuns,
    deriveRunMetadataFromSchedulerRuns,
    deriveRunMetadataFromNormalizedSchedulerRuns,
} from './teamPersistenceSnapshot.js';

/**
 * Normalize override status to a lowercased string.
 * Defaults to "pending" when status is missing or not a string.
 */
function getOverrideStatus(entry) {
    return (
        (typeof entry?.status === 'string' &&
            entry.status.trim().toLowerCase()) ||
        'pending'
    );
}

// Normalizes admin-provided overrides for practice slots.
function normalizePracticeOverrides(overrides = []) {
    if (!Array.isArray(overrides)) {
        throw new TypeError('practiceOverrides must be an array');
    }

    return overrides.map((entry, index) => {
        if (!entry || typeof entry !== 'object') {
            throw new TypeError(`practiceOverrides[${index}] must be an object`);
        }
        const teamId = entry.teamId ?? entry.team_id;
        if (typeof teamId !== 'string' || !teamId.trim()) {
            throw new Error(`practiceOverrides[${index}] requires a teamId`);
        }

        const status = getOverrideStatus(entry);
        if (status !== 'pending' && status !== 'applied') {
            throw new Error(`practiceOverrides[${index}] has unsupported status: ${status}`);
        }

        return {
            id: entry.id ?? `override-${index}`,
            teamId,
            teamName: entry.teamName ?? null,
            slotId: entry.slotId ?? null,
            status,
            updatedAt: entry.updatedAt ?? entry.updated_at ?? null,
            reason: entry.reason ?? '',
        };
    });
}

function deriveAppliedPracticeOverrides(overrides = []) {
    return overrides
        .filter((entry) => entry && typeof entry === 'object')
        .map((entry) => {
            const teamId = entry.teamId ?? entry.team_id;
            const status = getOverrideStatus(entry);

            if (!teamId || status !== 'applied') {
                return null;
            }

            // For practice, an override usually means "assign team X to slot Y"
            // or "lock team X to slot Y".
            return {
                teamId,
                slotId: entry.slotId,
                source: 'manual',
            };
        })
        .filter(Boolean);
}

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
export function preparePracticePersistenceSnapshot({
    assignments = [],
    slots = [],
    practiceOverrides = [],
    runHistory = [],
    schedulerRuns = [],
    lastSyncedAt = null,
    runId,
    runMetadata = {},
    pendingManualOverrideGoal = 'Resolve pending overrides before the next Supabase sync.',
} = {}) {
    // 1. Merge overrides into assignments if needed, or just pass them through
    // For now, we assume 'assignments' already includes applied overrides if the scheduler respected them.
    // If not, we might need to merge here. We'll assume the caller (UI/Scheduler) handles the merge
    // or that 'assignments' is the final list to persist.

    // 2. Build Supabase rows
    const assignmentRows = buildPracticeAssignmentRows({
        assignments,
        slots,
        runId,
    });

    // 3. Normalize metadata
    const normalizedOverrides = normalizePracticeOverrides(practiceOverrides);
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
        pendingManualOverrideGoal,
        manualOverrides: normalizedOverrides,
        runHistory: normalizedRunHistory,
        runMetadata: normalizedRunMetadata,
        payload: {
            assignmentRows,
        },
    };
}

export {
    deriveAppliedPracticeOverrides,
    normalizePracticeOverrides,
};
