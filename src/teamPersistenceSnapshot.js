import { buildTeamPlayerRows, buildTeamRows } from './teamSupabase.js';

const DEFAULT_OVERRIDE_GOAL =
  'Review pending manual overrides and coach confirmations before syncing to Supabase.';
const DEFAULT_OVERRIDE_REASON = 'Awaiting admin review.';

export function prepareTeamPersistenceSnapshot({
  teamsByDivision,
  divisionIdMap,
  teamOverrides,
  manualAssignments,
  manualOverrideEntries,
  runHistory,
  runId,
  lastSyncedAt,
  pendingManualOverrideGoal,
} = {}) {
  const { rows: teamRows, teamIdMap } = buildTeamRows({
    teamsByDivision,
    divisionIdMap,
    teamOverrides,
    runId,
  });
  const teamPlayerRows = buildTeamPlayerRows({
    teamsByDivision,
    manualAssignments,
    runId,
    teamIdMap,
  });

  const normalizedOverrides = normalizeManualOverrides(manualOverrideEntries, teamIdMap);
  const overrideCounts = buildOverrideCounts(normalizedOverrides);
  const normalizedRunHistory = normalizeRunHistory(runHistory);
  const normalizedLastSyncedAt = normalizeOptionalDate(lastSyncedAt, 'lastSyncedAt');
  const normalizedGoal = normalizeOptionalString(
    pendingManualOverrideGoal,
    DEFAULT_OVERRIDE_GOAL,
  );

  return {
    snapshot: {
      lastRunId: runId ?? null,
      lastSyncedAt: normalizedLastSyncedAt,
      preparedTeamRows: teamRows.length,
      preparedPlayerRows: teamPlayerRows.length,
      pendingManualOverrideGoal: normalizedGoal,
      manualOverrides: normalizedOverrides,
      overrideCounts,
      runHistory: normalizedRunHistory,
    },
    payload: {
      teamRows,
      teamPlayerRows,
    },
    teamIdMap,
  };
}

function normalizeManualOverrides(entries = [], teamIdMap) {
  if (!Array.isArray(entries)) {
    throw new TypeError('manualOverrideEntries must be an array');
  }

  const normalized = entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError(`manualOverrideEntries[${index}] must be an object`);
    }

    const id = normalizeRequiredString(entry.id, 'manualOverride.id', index);
    const teamId = normalizeRequiredString(entry.teamId, 'manualOverride.teamId', index);
    const teamName = normalizeOptionalString(entry.teamName, teamId);
    const field = normalizeRequiredString(entry.field, 'manualOverride.field', index);
    const value = normalizeOverrideValue(entry.value, index);
    const status = normalizeStatus(entry.status, index);
    const updatedAt = normalizeDate(entry.updatedAt, 'manualOverride.updatedAt', index);
    const reason = normalizeOptionalString(entry.reason, DEFAULT_OVERRIDE_REASON);
    const teamUuid = teamIdMap?.get(teamId) ?? null;

    return {
      id,
      teamId,
      teamUuid,
      teamName,
      field,
      value,
      status,
      updatedAt,
      reason,
    };
  });

  normalized.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return normalized;
}

function normalizeStatus(value, index) {
  if (value === undefined || value === null) {
    return 'pending';
  }
  if (typeof value !== 'string') {
    throw new TypeError(`manualOverrideEntries[${index}].status must be a string`);
  }
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    throw new Error(`manualOverrideEntries[${index}].status cannot be empty`);
  }
  return trimmed;
}

function normalizeOverrideValue(value, index) {
  if (value === undefined || value === null) {
    return '';
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return String(value).trim();
  }
  throw new TypeError(`manualOverrideEntries[${index}].value must be string, number, or boolean`);
}

function normalizeRunHistory(entries = []) {
  if (!Array.isArray(entries)) {
    throw new TypeError('runHistory must be an array');
  }

  const normalized = entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError(`runHistory[${index}] must be an object`);
    }

    const runId = normalizeRequiredString(entry.runId, 'runHistory.runId', index);
    const status = normalizeStatus(entry.status, index);
    const triggeredBy = normalizeOptionalString(entry.triggeredBy, 'unknown');
    const startedAt = normalizeDate(entry.startedAt, 'runHistory.startedAt', index);
    const completedAt = normalizeOptionalDate(entry.completedAt, 'runHistory.completedAt', index);
    const updatedTeams = normalizeCount(entry.updatedTeams, 'runHistory.updatedTeams', index);
    const updatedPlayers = normalizeCount(entry.updatedPlayers, 'runHistory.updatedPlayers', index);
    const notes = normalizeOptionalString(entry.notes, '');

    return {
      runId,
      status,
      triggeredBy,
      startedAt,
      completedAt,
      updatedTeams,
      updatedPlayers,
      notes,
    };
  });

  normalized.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  return normalized;
}

function normalizeCount(value, label, index) {
  if (value === undefined || value === null) {
    return 0;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new TypeError(`${label} must be a finite number at index ${index}`);
  }
  return numeric;
}

function normalizeRequiredString(value, label, index) {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string at index ${index}`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} cannot be empty at index ${index}`);
  }
  return trimmed;
}

function normalizeOptionalString(value, fallback) {
  if (value === undefined || value === null) {
    return fallback ?? null;
  }
  if (typeof value !== 'string') {
    throw new TypeError('optional string value must be a string when provided');
  }
  const trimmed = value.trim();
  if (!trimmed && fallback !== undefined) {
    return fallback;
  }
  return trimmed;
}

function normalizeDate(value, label, index) {
  if (value === undefined || value === null) {
    throw new Error(`${label} is required at index ${index}`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be a valid date at index ${index}`);
  }
  return date.toISOString();
}

function normalizeOptionalDate(value, label, index) {
  if (value === undefined || value === null) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be a valid date${
      typeof index === 'number' ? ` at index ${index}` : ''
    }`);
  }
  return date.toISOString();
}

function buildOverrideCounts(overrides) {
  const counts = { total: overrides.length, pending: 0, applied: 0, byStatus: {} };
  overrides.forEach((override) => {
    counts.byStatus[override.status] = (counts.byStatus[override.status] ?? 0) + 1;
    if (override.status === 'pending') {
      counts.pending += 1;
    }
    if (override.status === 'applied') {
      counts.applied += 1;
    }
  });
  return counts;
}
