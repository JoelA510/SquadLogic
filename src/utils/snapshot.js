/**
 * Shared utilities for normalizing and processing scheduler run snapshots.
 */

export function normalizeRunHistory(runHistory = []) {
    if (!Array.isArray(runHistory)) {
        throw new TypeError('runHistory must be an array');
    }

    const normalized = runHistory.map((entry, index) => {
        if (!entry || typeof entry !== 'object') {
            throw new TypeError(`runHistory[${index}] must be an object`);
        }

        const runId = entry.runId ?? entry.id ?? entry.run_id;
        if (typeof runId !== 'string' || !runId.trim()) {
            throw new Error(`runHistory[${index}] requires a runId`);
        }

        const status = (typeof entry.status === 'string' && entry.status.trim().toLowerCase()) || 'unknown';
        const startedAt = entry.startedAt ?? entry.started_at;
        const completedAt = entry.completedAt ?? entry.completed_at ?? null;

        return {
            runId,
            status,
            triggeredBy: entry.triggeredBy ?? entry.triggered_by ?? 'unknown',
            startedAt,
            completedAt,
            updatedTeams: entry.updatedTeams ?? entry.updated_teams ?? 0,
            updatedPlayers: entry.updatedPlayers ?? entry.updated_players ?? 0,
            notes: entry.notes ?? '',
        };
    });

    return normalized.sort((a, b) => {
        const aTime = a.startedAt ? new Date(a.startedAt).getTime() : 0;
        const bTime = b.startedAt ? new Date(b.startedAt).getTime() : 0;
        return bTime - aTime;
    });
}

export function normalizeSchedulerRuns(schedulerRuns = []) {
    if (!Array.isArray(schedulerRuns)) {
        throw new TypeError('schedulerRuns must be an array');
    }

    const normalizeObjectField = (value, label, index) => {
        if (value === undefined || value === null) {
            return {};
        }

        if (typeof value !== 'object' || Array.isArray(value)) {
            throw new TypeError(`schedulerRuns[${index}].${label} must be an object`);
        }

        return value;
    };

    return schedulerRuns.map((entry, index) => {
        if (!entry || typeof entry !== 'object') {
            throw new TypeError(`schedulerRuns[${index}] must be an object`);
        }

        const runId = entry.id ?? entry.runId ?? entry.run_id;
        if (typeof runId !== 'string' || !runId.trim()) {
            throw new Error(`schedulerRuns[${index}] requires an id`);
        }

        return {
            runId,
            runType: entry.run_type ?? entry.runType ?? 'team',
            status: (typeof entry.status === 'string' && entry.status.trim().toLowerCase()) || 'unknown',
            seasonSettingsId: entry.season_settings_id ?? entry.seasonSettingsId ?? null,
            parameters: normalizeObjectField(entry.parameters, 'parameters', index),
            metrics: normalizeObjectField(entry.metrics, 'metrics', index),
            results: normalizeObjectField(entry.results, 'results', index),
            triggeredBy: entry.created_by ?? entry.createdBy ?? entry.triggered_by ?? entry.triggeredBy ?? 'unknown',
            startedAt: entry.started_at ?? entry.startedAt ?? entry.created_at ?? entry.createdAt ?? null,
            completedAt: entry.completed_at ?? entry.completedAt ?? null,
            updatedTeams:
                entry.updatedTeams ?? entry.results?.updatedTeams ?? entry.metrics?.updatedTeams ?? 0,
            updatedPlayers:
                entry.updatedPlayers ?? entry.results?.updatedPlayers ?? entry.metrics?.updatedPlayers ?? 0,
            notes: entry.results?.notes ?? entry.notes ?? '',
        };
    });
}

export function buildRunHistoryFromSchedulerRuns(schedulerRuns = []) {
    const normalized = normalizeSchedulerRuns(schedulerRuns);

    return normalized.map((entry) => ({
        runId: entry.runId,
        status: entry.status,
        triggeredBy: entry.triggeredBy,
        startedAt: entry.startedAt,
        completedAt: entry.completedAt,
        updatedTeams: entry.updatedTeams,
        updatedPlayers: entry.updatedPlayers,
        notes: entry.notes,
    }));
}

export function deriveRunMetadataFromNormalizedSchedulerRuns(
    normalizedRuns = [],
    targetRunId = null,
) {
    if (!Array.isArray(normalizedRuns)) {
        throw new TypeError('normalizedRuns must be an array');
    }

    if (normalizedRuns.length === 0) {
        return {};
    }

    let source = targetRunId
        ? normalizedRuns.find((entry) => entry.runId === targetRunId)
        : undefined;

    if (!source) {
        const sorted = [...normalizedRuns].sort((a, b) => {
            const aTime = a.startedAt ? new Date(a.startedAt).getTime() : 0;
            const bTime = b.startedAt ? new Date(b.startedAt).getTime() : 0;
            return bTime - aTime;
        });
        source = sorted[0];
    }

    const metadata = {
        runId: source.runId,
        seasonSettingsId: source.seasonSettingsId ?? undefined,
        runType: source.runType,
        status: source.status,
        parameters: source.parameters,
        metrics: source.metrics,
        results: source.results,
        createdBy: source.triggeredBy,
        startedAt: source.startedAt ?? undefined,
        completedAt: source.completedAt ?? undefined,
    };

    return Object.fromEntries(
        Object.entries(metadata).filter(([, value]) => value !== undefined && value !== null),
    );
}

export function deriveRunMetadataFromSchedulerRuns(schedulerRuns = [], targetRunId = null) {
    const normalizedRuns = normalizeSchedulerRuns(schedulerRuns);

    return deriveRunMetadataFromNormalizedSchedulerRuns(normalizedRuns, targetRunId);
}

export function normalizeRunMetadata(runMetadata = {}, fallbackRunId = null) {
    if (runMetadata == null) {
        return fallbackRunId ? { runId: fallbackRunId } : {};
    }

    if (typeof runMetadata !== 'object' || Array.isArray(runMetadata)) {
        throw new TypeError('runMetadata must be an object');
    }

    const normalized = { ...runMetadata };
    if (!normalized.runId && fallbackRunId) {
        normalized.runId = fallbackRunId;
    }

    return normalized;
}

export function mergeRunMetadata({ providedRunMetadata, derivedRunMetadata, fallbackRunId }) {
    if (providedRunMetadata == null) {
        return normalizeRunMetadata(derivedRunMetadata, fallbackRunId);
    }

    if (typeof providedRunMetadata !== 'object' || Array.isArray(providedRunMetadata)) {
        throw new TypeError('runMetadata must be an object');
    }

    return normalizeRunMetadata({ ...derivedRunMetadata, ...providedRunMetadata }, fallbackRunId);
}

export function evaluateOverrides(overrides = []) {
    if (!Array.isArray(overrides)) {
        throw new TypeError('overrides must be an array');
    }

    const pending = overrides.reduce((count, entry, index) => {
        if (!entry || typeof entry !== 'object') {
            throw new TypeError(`overrides[${index}] must be an object`);
        }

        const status =
            (typeof entry.status === 'string' && entry.status.trim().toLowerCase()) || 'pending';

        return status === 'pending' ? count + 1 : count;
    }, 0);

    return { pending };
}
