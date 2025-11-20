import { buildTeamPlayerRows, buildTeamRows } from './teamSupabase.js';

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

    const status = entry.status ?? 'unknown';
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

const status = (typeof entry.status === 'string' && entry.status.trim().toLowerCase()) || 'pending';
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
      if (entry.status === 'pending' || !teamId) {
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
  lastSyncedAt = null,
  runId,
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
  const normalizedRunHistory = normalizeRunHistory(runHistory);
  const latestRunId = runId ?? normalizedRunHistory[0]?.runId ?? null;

  return {
    lastRunId: latestRunId,
    lastSyncedAt,
    preparedTeamRows: teamRows.length,
    preparedPlayerRows: teamPlayerRows.length,
    pendingManualOverrideGoal,
    manualOverrides: normalizedOverrides,
    runHistory: normalizedRunHistory,
    payload: {
      teamRows,
      teamPlayerRows,
      teamIdMap,
    },
  };
}

export { normalizeManualOverrides, normalizeRunHistory };
