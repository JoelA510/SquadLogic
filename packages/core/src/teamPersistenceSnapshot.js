import { buildTeamPlayerRows, buildTeamRows } from './teamSupabase.js';
import {
  normalizeRunHistory,
  normalizeSchedulerRuns,
  buildRunHistoryFromSchedulerRuns,
  deriveRunMetadataFromNormalizedSchedulerRuns,
  deriveRunMetadataFromSchedulerRuns,
  mergeRunMetadata,
  normalizeRunMetadata,
} from './utils/snapshot.js';

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
