import { buildTeamPlayerRows, buildTeamRows } from './teamSupabase.js';

/**
 * Normalize override status to a lowercased string.
 * Defaults to "pending" when status is missing or not a string.
 *
 * @param {object | null | undefined} entry
 * @returns {string}
 */
function getOverrideStatus(entry) {
  return (
    (typeof entry?.status === 'string' &&
      entry.status.trim().toLowerCase()) ||
    'pending'
  );
}

function normalizeRunHistory(runHistory = []) {
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

function normalizeSchedulerRuns(schedulerRuns = []) {
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

function buildRunHistoryFromSchedulerRuns(schedulerRuns = []) {
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

/**
 * Derives run metadata from a pre-normalized array of scheduler runs.
 * Assumes inputs are already normalized via normalizeSchedulerRuns.
 *
 * @param {Array<Object>} [normalizedRuns=[]] - Pre-normalized scheduler run objects.
 * @param {string | null} [targetRunId=null] - Specific run ID to derive metadata for.
 *   If null, the most recent run (by startedAt) is used when available.
 * @returns {Object} Derived run metadata, or an empty object when no runs are provided.
 */
function deriveRunMetadataFromNormalizedSchedulerRuns(
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

/**
 * Normalizes raw scheduler runs and derives metadata from them.
 *
 * @param {Array<Object>} [schedulerRuns=[]] - Raw scheduler run objects to normalize.
 * @param {string | null} [targetRunId=null] - Specific run ID to derive metadata for.
 *   If null, the most recent run (by startedAt) is used when available.
 * @returns {Object} Derived run metadata produced from the scheduler runs.
 */
function deriveRunMetadataFromSchedulerRuns(schedulerRuns = [], targetRunId = null) {
  const normalizedRuns = normalizeSchedulerRuns(schedulerRuns);

  return deriveRunMetadataFromNormalizedSchedulerRuns(normalizedRuns, targetRunId);
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

// Normalizes admin-provided overrides, defaulting status to "pending" so only explicit
// "applied" entries are propagated into persistence payloads.
function normalizeManualOverrides(overrides = [], teamNameByGeneratorId = new Map()) {
  if (!Array.isArray(overrides)) {
    throw new TypeError('manualOverrides must be an array');
  }

  return overrides.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError(`manualOverrides[${index}] must be an object`);
    }
    const teamId = entry.teamId ?? entry.team_id;
    if (typeof teamId !== 'string' || !teamId.trim()) {
      throw new Error(`manualOverrides[${index}] requires a teamId`);
    }

    const status = getOverrideStatus(entry);
    if (status !== 'pending' && status !== 'applied') {
      throw new Error(`manualOverrides[${index}] has unsupported status: ${status}`);
    }

    const teamName = entry.teamName ?? teamNameByGeneratorId.get(teamId) ?? null;

    return {
      id: entry.id ?? `override-${index}`,
      teamId,
      teamName,
      field: entry.field ?? 'unknown',
      value: entry.value ?? null,
      status,
      updatedAt: entry.updatedAt ?? entry.updated_at ?? null,
      reason: entry.reason ?? '',
    };
  });
}

function deriveAppliedTeamOverrides(overrides = []) {
  return overrides
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => {
      const teamId = entry.teamId ?? entry.team_id;
      const status = getOverrideStatus(entry);

      if (!teamId || status !== 'applied') {
        return null;
      }

      if (entry.field === 'name') {
        return { teamId, name: entry.value };
      }
      if (entry.field === 'coachId') {
        return { teamId, coachId: entry.value };
      }

      return null;
    })
    .filter(Boolean);
}

function normalizeRunMetadata(runMetadata = {}, fallbackRunId = null) {
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

/**
 * Prepare a persistence snapshot with Supabase-ready payloads and admin metadata.
 */
export function prepareTeamPersistenceSnapshot({
  teamsByDivision,
  divisionIdMap,
  teamOverrides = [],
  manualAssignments = [],
  runHistory = [],
  schedulerRuns = [],
  lastSyncedAt = null,
  runId,
  runMetadata = {},
  pendingManualOverrideGoal = 'Resolve pending overrides before the next Supabase sync.',
} = {}) {
  const appliedTeamOverrides = deriveAppliedTeamOverrides(teamOverrides);
  const {
    rows: teamRows,
    teamIdMap,
    teamNameByGeneratorId,
  } = buildTeamRows({ teamsByDivision, divisionIdMap, teamOverrides: appliedTeamOverrides, runId });

  const teamPlayerRows = buildTeamPlayerRows({
    teamsByDivision,
    manualAssignments,
    runId,
    teamIdMap,
  });

  const normalizedOverrides = normalizeManualOverrides(teamOverrides, teamNameByGeneratorId);
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
    preparedTeamRows: teamRows.length,
    preparedPlayerRows: teamPlayerRows.length,
    pendingManualOverrideGoal,
    manualOverrides: normalizedOverrides,
    runHistory: normalizedRunHistory,
    runMetadata: normalizedRunMetadata,
    payload: {
      teamRows,
      teamPlayerRows,
      teamIdMap,
    },
  };
}

export {
  deriveAppliedTeamOverrides,
  normalizeManualOverrides,
  normalizeRunHistory,
  normalizeRunMetadata,
  normalizeSchedulerRuns,
  buildRunHistoryFromSchedulerRuns,
  deriveRunMetadataFromSchedulerRuns,
};
