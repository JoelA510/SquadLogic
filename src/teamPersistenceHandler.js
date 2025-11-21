/**
 * Backend-oriented helpers for validating and responding to team persistence requests.
 */

import { randomUUID } from 'node:crypto';

function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new TypeError('snapshot must be an object');
  }

  const payload = snapshot.payload;
  if (!payload || typeof payload !== 'object') {
    throw new TypeError('snapshot.payload must be an object');
  }

  const { teamRows, teamPlayerRows } = payload;

  if (!Array.isArray(teamRows)) {
    throw new TypeError('snapshot.payload.teamRows must be an array');
  }
  if (!Array.isArray(teamPlayerRows)) {
    throw new TypeError('snapshot.payload.teamPlayerRows must be an array');
  }

  teamRows.forEach((row, index) => {
    if (!row || typeof row !== 'object') {
      throw new TypeError(`teamRows[${index}] must be an object`);
    }
    if (typeof row.id !== 'string' || !row.id.trim()) {
      throw new Error(`teamRows[${index}] requires an id`);
    }
  });

  teamPlayerRows.forEach((row, index) => {
    if (!row || typeof row !== 'object') {
      throw new TypeError(`teamPlayerRows[${index}] must be an object`);
    }
    if (typeof row.team_id !== 'string' || !row.team_id.trim()) {
      throw new Error(`teamPlayerRows[${index}] requires a team_id`);
    }
    if (typeof row.player_id !== 'string' || !row.player_id.trim()) {
      throw new Error(`teamPlayerRows[${index}] requires a player_id`);
    }
  });

  return {
    teamRows,
    teamPlayerRows,
    runId: snapshot.lastRunId ?? snapshot.runId ?? null,
  };
}

function normalizeAllowedRoles(allowedRoles = []) {
  if (!Array.isArray(allowedRoles)) {
    throw new TypeError('allowedRoles must be an array');
  }

  if (allowedRoles.length === 0) {
    throw new Error('allowedRoles must include at least one role');
  }

  return allowedRoles.map((role, index) => {
    if (typeof role !== 'string' || !role.trim()) {
      throw new TypeError(`allowedRoles[${index}] must be a non-empty string`);
    }

    return role.trim().toLowerCase();
  });
}

function extractUserRole(user) {
  if (!user || typeof user !== 'object') {
    return null;
  }

  const role =
    user.app_metadata?.role ||
    user.user_metadata?.role ||
    user.user_metadata?.appRole ||
    user.role;

  if (typeof role !== 'string' || !role.trim()) {
    return null;
  }

  return role.trim().toLowerCase();
}

function evaluateOverrides(overrides = []) {
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

function validateSupabaseTransactionClient(supabaseClient) {
  if (!supabaseClient || typeof supabaseClient.transaction !== 'function') {
    throw new TypeError('supabaseClient.transaction with a callback is required');
  }
}

function normalizeJsonObject(value, label) {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }

  return value;
}

function normalizeTimestamp(value, label, fallbackIso) {
  if (value === undefined || value === null) {
    return fallbackIso;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`${label} must be a valid date or timestamp string`);
  }

  return date.toISOString();
}

function buildSchedulerRunRow({
  runId,
  seasonSettingsId,
  runType = 'team',
  status = 'completed',
  parameters,
  metrics,
  results,
  startedAt,
  completedAt,
  createdBy,
  nowIso,
} = {}) {
  if (typeof seasonSettingsId !== 'number' && typeof seasonSettingsId !== 'string') {
    throw new TypeError('seasonSettingsId is required for scheduler_runs upsert');
  }

  const normalizedRunId = typeof runId === 'string' && runId.trim() ? runId : randomUUID();

  return {
    id: normalizedRunId,
    season_settings_id: seasonSettingsId,
    run_type: runType,
    status,
    parameters: normalizeJsonObject(parameters, 'parameters'),
    metrics: normalizeJsonObject(metrics, 'metrics'),
    results: normalizeJsonObject(results, 'results'),
    started_at: normalizeTimestamp(startedAt, 'startedAt', nowIso),
    completed_at: normalizeTimestamp(completedAt, 'completedAt', nowIso),
    created_by: typeof createdBy === 'string' && createdBy.trim() ? createdBy : null,
  };
}

async function upsertRows({ supabaseClient, tableName, rows }) {
  if (!Array.isArray(rows)) {
    throw new TypeError(`${tableName} rows must be an array`);
  }

  if (!supabaseClient || typeof supabaseClient.from !== 'function') {
    throw new TypeError('supabaseClient with a from() method is required');
  }

  if (rows.length === 0) {
    return [];
  }

  const table = supabaseClient.from(tableName);
  if (!table || typeof table.upsert !== 'function') {
    throw new TypeError(`${tableName} builder must expose an upsert() method`);
  }

  const { data, error } = await table.upsert(rows);
  if (error) {
    const message = error.message ?? String(error);
    throw new Error(`Failed to persist ${tableName}: ${message}`);
  }

  return data ?? null;
}

export async function persistTeamSnapshotTransactional({
  supabaseClient,
  snapshot,
  runMetadata = {},
  now = new Date(),
} = {}) {
  validateSupabaseTransactionClient(supabaseClient);
  const { teamRows, teamPlayerRows, runId: snapshotRunId } = normalizeSnapshot(snapshot);

  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }

  const nowIso = now.toISOString();
  const runId = runMetadata.runId ?? snapshotRunId ?? null;

  const transactionResult = await supabaseClient.transaction(async (transaction) => {
    const schedulerRunRow = buildSchedulerRunRow({
      ...runMetadata,
      runId,
      nowIso,
    });

    const teams = await upsertRows({
      supabaseClient: transaction,
      tableName: 'teams',
      rows: teamRows,
    });
    const teamPlayers = await upsertRows({
      supabaseClient: transaction,
      tableName: 'team_players',
      rows: teamPlayerRows,
    });
    const schedulerRuns = await upsertRows({
      supabaseClient: transaction,
      tableName: 'scheduler_runs',
      rows: [schedulerRunRow],
    });

    return { teams, teamPlayers, schedulerRuns };
  });

  return {
    status: 'success',
    syncedAt: nowIso,
    runId: transactionResult.schedulerRuns?.[0]?.id ?? runMetadata.runId ?? snapshotRunId,
    updatedTeams: teamRows.length,
    updatedPlayers: teamPlayerRows.length,
    results: transactionResult,
  };
}

/**
 * Validate a persistence request payload and return a response-friendly summary.
 */
export function handleTeamPersistence({ snapshot, overrides = [], now = new Date() } = {}) {
  const { teamRows, teamPlayerRows, runId } = normalizeSnapshot(snapshot);
  const { pending } = evaluateOverrides(overrides);

  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }

  if (pending > 0) {
    return {
      status: 'blocked',
      message: `${pending} manual override${pending === 1 ? ' is' : 's are'} still pending review.`,
      pendingOverrides: pending,
      runId,
    };
  }

  return {
    status: 'success',
    message: 'Snapshot validated. Ready for persistence upsert.',
    syncedAt: now.toISOString(),
    updatedTeams: teamRows.length,
    updatedPlayers: teamPlayerRows.length,
    runId,
  };
}

export function authorizeTeamPersistenceRequest({
  user,
  allowedRoles = ['admin', 'scheduler'],
} = {}) {
  const normalizedAllowedRoles = normalizeAllowedRoles(allowedRoles);
  const normalizedRole = extractUserRole(user);

  if (!normalizedRole) {
    return {
      status: 'unauthorized',
      message: 'Authentication with an allowed role is required for team persistence.',
    };
  }

  if (!normalizedAllowedRoles.includes(normalizedRole)) {
    return {
      status: 'forbidden',
      message: `Role "${normalizedRole}" is not permitted for team persistence.`,
      role: normalizedRole,
    };
  }

  return { status: 'authorized', role: normalizedRole };
}

export { normalizeSnapshot, evaluateOverrides };
