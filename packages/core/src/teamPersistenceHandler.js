// @ts-check
/**
 * Backend-oriented helpers for validating and responding to team persistence requests.
 */

import {
  authorizePersistenceRequest,
  handlePersistenceRequest,
  persistSnapshotTransactional,
} from './persistenceHandler.js';
import { evaluateOverrides } from './utils/snapshot.js';

/**
 * @typedef {import('./persistenceHandler.js').PersistenceSnapshot} PersistenceSnapshot
 */

/**
 * Authorize a team persistence request.
 * @param {Object} params
 * @param {string} [params.runId]
 * @param {string} [params.seasonSettingsId]
 * @param {string} [params.createdBy]
 * @param {string} [params.runType]
 * @param {import('./persistenceHandler.js').User} [params.user]
 * @param {string[]} [params.allowedRoles]
 * @returns {Object}
 */
export function authorizeTeamPersistenceRequest(params) {
  // @ts-ignore
  return authorizePersistenceRequest({ ...params, runType: 'team' });
}

/**
 * Normalize the team snapshot to ensure structural validity.
 *
 * @param {PersistenceSnapshot} snapshot
 * @returns {PersistenceSnapshot & { teamRows: Array<Object>, teamPlayerRows: Array<Object>, updatedTeams: number, updatedPlayers: number }}
 */
function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new TypeError('snapshot must be an object');
  }

  const payload = snapshot.payload;
  if (!payload || typeof payload !== 'object') {
    throw new TypeError('snapshot.payload must be an object');
  }

  // @ts-ignore - payload structure dynamic validation
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
    // @ts-ignore
    if (typeof row.id !== 'string' || !row.id.trim()) {
      throw new Error(`teamRows[${index}] requires an id`);
    }
  });

  teamPlayerRows.forEach((row, index) => {
    if (!row || typeof row !== 'object') {
      throw new TypeError(`teamPlayerRows[${index}] must be an object`);
    }
    // @ts-ignore
    if (typeof row.team_id !== 'string' || !row.team_id.trim()) {
      throw new Error(`teamPlayerRows[${index}] requires a team_id`);
    }
    // @ts-ignore
    if (typeof row.player_id !== 'string' || !row.player_id.trim()) {
      throw new Error(`teamPlayerRows[${index}] requires a player_id`);
    }
  });

  return {
    ...snapshot,
    payload: {
      ...snapshot.payload,
      // @ts-ignore
      assignmentRows: undefined // Clear incompatible assignments if any
    },
    teamRows,
    teamPlayerRows,
    updatedTeams: teamRows.length,
    updatedPlayers: teamPlayerRows.length,
    runId: snapshot.lastRunId ?? snapshot.runId ?? null,
  };
}

/**
 * Build a scheduler run row.
 * @param {Object} params
 * @param {string} [params.runId]
 * @param {string} [params.seasonSettingsId]
 * @param {string} [params.runType]
 * @param {string} [params.status]
 * @param {Object} [params.parameters]
 * @param {Object} [params.metrics]
 * @param {Object} [params.results]
 * @param {string} [params.startedAt]
 * @param {string} [params.completedAt]
 * @param {string} [params.createdBy]
 * @param {string} [params.nowIso]
 * @returns {Object}
 */
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
  // Note: This logic is now largely handled by the RPC or passed as JSON,
  // but we keep the structure building here for the RPC argument.
  return {
    id: runId,
    season_settings_id: seasonSettingsId,
    run_type: runType,
    status,
    parameters: parameters ?? {},
    metrics: metrics ?? {},
    results: results ?? {},
    started_at: startedAt ?? nowIso,
    completed_at: completedAt ?? nowIso,
    created_by: createdBy,
  };
}

/**
 * Persist the team snapshot transactionally.
 *
 * @param {Object} params
 * @param {Object} params.supabaseClient
 * @param {PersistenceSnapshot} params.snapshot
 * @param {Object} [params.runMetadata]
 * @param {Date} [params.now]
 * @returns {Promise<Object>}
 */
export async function persistTeamSnapshotTransactional({
  supabaseClient,
  snapshot,
  runMetadata = {},
  now = new Date(),
}) {
  // @ts-ignore - Validated by normalizeSnapshot
  const { teamRows, teamPlayerRows, runId: snapshotRunId } = normalizeSnapshot(snapshot);
  // @ts-ignore
  const effectiveRunId = runMetadata.runId ?? snapshotRunId;
  const effectiveRunMetadata = { ...runMetadata, runId: effectiveRunId };

  const result = await persistSnapshotTransactional({
    supabaseClient,
    snapshot,
    rpcName: 'persist_team_schedule',
    runType: 'team',
    runMetadata: effectiveRunMetadata,
    now,
    // @ts-ignore
    transformPayload: ({ snapshot, runMetadata, nowIso, runId }) => {
      // Prepare run data for the RPC
      const runData = buildSchedulerRunRow({
        ...runMetadata,
        runId,
        nowIso,
      });

      return {
        run_data: runData,
        teams: teamRows,
        team_players: teamPlayerRows,
      };
    },
  });

  // console.log('DEBUG persistSnapshotTransactional inner result:', result);

  return {
    ...result,
    updatedTeams: teamRows.length,
    updatedPlayers: teamPlayerRows.length,
  };
}

/**
 * Validate a persistence request payload and return a response-friendly summary.
 * @param {Object} params
 * @param {PersistenceSnapshot} [params.snapshot]
 * @param {Array<any>} [params.overrides]
 * @param {Date} [params.now]
 * @returns {Object}
 */
export function handleTeamPersistence({ snapshot, overrides = [], now = new Date() }) {
  // @ts-ignore
  return handlePersistenceRequest({
    snapshot,
    overrides,
    now,
    snapshotNormalizer: normalizeSnapshot,
    overrideEvaluator: evaluateOverrides,
    successMessage: 'Snapshot validated. Ready for team persistence upsert.',
  });
}

// Re-export specific normalizers if needed by consumers who import from here
export { normalizeSnapshot, evaluateOverrides };
