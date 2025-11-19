/**
 * Helpers for persisting generated teams and roster memberships to Supabase.
 */

import { v5 as uuidv5 } from 'uuid';

// A stable namespace UUID for team IDs. Do not change once set.
const TEAM_ID_NAMESPACE = '9f7c9e2a-2b7f-4cc1-87b1-4af21d3aa2f0';

function deriveTeamUuid(generatorTeamId) {
  return uuidv5(generatorTeamId, TEAM_ID_NAMESPACE);
}

function normalizeString(value, label, index) {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string at index ${index}`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} cannot be empty at index ${index}`);
  }
  return trimmed;
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new TypeError('coachId must be a string when provided');
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeDivisionId(divisionKey, divisionIdMap, index) {
  const divisionId = divisionIdMap?.[divisionKey] ?? divisionKey;
  return normalizeString(divisionId, 'divisionId', index);
}

function normalizeSource(value, index) {
  if (value === undefined || value === null || value === 'auto') {
    return 'auto';
  }
  if (value === 'manual' || value === 'locked') {
    return 'manual';
  }
  throw new Error(`assignments[${index}] has an unsupported source: ${value}`);
}

function normalizeRole(value, index) {
  if (value === undefined || value === null) {
    return 'player';
  }
  if (typeof value !== 'string') {
    throw new TypeError(`assignments[${index}] role must be a string when provided`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`assignments[${index}] role cannot be empty`);
  }
  return trimmed;
}

/**
 * Convert generated teams into Supabase-ready `teams` rows.
 *
 * @param {Object} params
 * @param {Record<string, Array<Object>>} params.teamsByDivision - Output from the team generator.
 * @param {Record<string, string>} [params.divisionIdMap] - Optional mapping from division codes to Supabase ids.
 * @param {Array<{ teamId: string, name?: string, coachId?: string | null }>} [params.teamOverrides]
 *   - Optional admin overrides keyed by `teamId`.
 * @param {string} [params.runId] - Optional scheduler run identifier.
 * @returns {{ rows: Array<Object>, teamIdMap: Map<string, string> }} Supabase row payloads with snake_case keys and a mapping from generator ids to UUIDs.
 */
export function buildTeamRows({ teamsByDivision, divisionIdMap, teamOverrides = [], runId } = {}) {
  if (!teamsByDivision || typeof teamsByDivision !== 'object' || Array.isArray(teamsByDivision)) {
    throw new TypeError('teamsByDivision must be an object');
  }

  const overridesByTeamId = new Map();
  teamOverrides.forEach((override, index) => {
    if (!override || typeof override !== 'object') {
      throw new TypeError(`teamOverrides[${index}] must be an object`);
    }
    const teamId = normalizeString(override.teamId, 'teamOverrides.teamId', index);
    if (overridesByTeamId.has(teamId)) {
      throw new Error(`duplicate override for teamId: ${teamId}`);
    }
    const normalizedOverride = { teamId };
    if (override.name !== undefined) {
      normalizedOverride.name = normalizeString(override.name, 'teamOverrides.name', index);
    }
    if (override.coachId !== undefined) {
      normalizedOverride.coachId = normalizeOptionalString(override.coachId);
    }
    overridesByTeamId.set(teamId, normalizedOverride);
  });

  const rows = [];
  const teamIdMap = new Map(); // generatorId -> uuid
  Object.entries(teamsByDivision).forEach(([division, teams], divisionIndex) => {
    if (!Array.isArray(teams)) {
      throw new TypeError(`teamsByDivision[${division}] must be an array`);
    }

    teams.forEach((team, teamIndex) => {
      if (!team || typeof team !== 'object') {
        throw new TypeError(`team entry at teamsByDivision[${division}][${teamIndex}] must be an object`);
      }

      const generatorTeamId = normalizeString(team.id, 'teamId', teamIndex);
      const override = overridesByTeamId.get(generatorTeamId);
      let dbTeamId = teamIdMap.get(generatorTeamId);
      if (!dbTeamId) {
        dbTeamId = deriveTeamUuid(generatorTeamId);
        teamIdMap.set(generatorTeamId, dbTeamId);
      }
      const divisionId = normalizeDivisionId(division, divisionIdMap, divisionIndex);
      const name = normalizeString(
        override?.name ?? team.name,
        'team name',
        teamIndex,
      );
      const coachId =
        override && Object.prototype.hasOwnProperty.call(override, 'coachId')
          ? override.coachId
          : normalizeOptionalString(team.coachId);

      rows.push({
        id: dbTeamId,
        division_id: divisionId,
        name,
        coach_id: coachId,
        run_id: runId ?? null,
      });
    });
  });

  return { rows, teamIdMap };
}

/**
 * Convert team memberships into Supabase-ready `team_players` rows, allowing manual overrides.
 *
 * @param {Object} params
 * @param {Record<string, Array<Object>>} params.teamsByDivision - Output from the team generator.
 * @param {Array<{ teamId: string, playerId: string, role?: string, source?: string }>} [params.manualAssignments]
 *   - Optional manual adjustments from admins. Manual entries replace generated rows for the same team/player.
 * @param {string} [params.runId] - Optional scheduler run identifier.
 * @param {Map<string, string>} [params.teamIdMap] - Optional mapping from generator team IDs to Supabase UUIDs.
 * @returns {Array<Object>} Supabase row payloads with snake_case keys.
 */
export function buildTeamPlayerRows({ teamsByDivision, manualAssignments = [], runId, teamIdMap } = {}) {
  if (!teamsByDivision || typeof teamsByDivision !== 'object' || Array.isArray(teamsByDivision)) {
    throw new TypeError('teamsByDivision must be an object');
  }
  if (!Array.isArray(manualAssignments)) {
    throw new TypeError('manualAssignments must be an array');
  }

  const rows = [];
  const rowByKey = new Map();

  const addRow = ({ teamId, playerId, role, source }) => {
    const key = `${teamId}::${playerId}`;
    rowByKey.set(key, {
      team_id: teamId,
      player_id: playerId,
      role,
      source,
      run_id: runId ?? null,
    });
  };

  Object.entries(teamsByDivision).forEach(([division, teams]) => {
    if (!Array.isArray(teams)) {
      throw new TypeError(`teamsByDivision[${division}] must be an array`);
    }

    teams.forEach((team, teamIndex) => {
      if (!team || typeof team !== 'object') {
        throw new TypeError(`team entry at teamsByDivision[${division}][${teamIndex}] must be an object`);
      }
      const generatorTeamId = normalizeString(team.id, 'teamId', teamIndex);
      const teamId = teamIdMap ? teamIdMap.get(generatorTeamId) : generatorTeamId;
      if (teamIdMap && teamId === undefined) {
        throw new Error(`UUID mapping not found for generator team ID: ${generatorTeamId}`);
      }
      if (!Array.isArray(team.players)) {
        throw new TypeError(`team ${teamId} must include a players array`);
      }

      team.players.forEach((player, playerIndex) => {
        if (!player || typeof player !== 'object') {
          throw new TypeError(`player ${playerIndex} for team ${teamId} must be an object`);
        }
        const playerId = normalizeString(player.id, 'playerId', playerIndex);
        addRow({
          teamId,
          playerId,
          role: 'player',
          source: 'auto',
        });
      });
    });
  });

  manualAssignments.forEach((assignment, index) => {
    if (!assignment || typeof assignment !== 'object') {
      throw new TypeError(`manualAssignments[${index}] must be an object`);
    }

    const generatorTeamId = normalizeString(assignment.teamId, 'manualAssignments.teamId', index);
    const teamId = teamIdMap ? teamIdMap.get(generatorTeamId) : generatorTeamId;
    if (teamIdMap && teamId === undefined) {
      throw new Error(`UUID mapping not found for generator team ID: ${generatorTeamId}`);
    }
    const playerId = normalizeString(assignment.playerId, 'manualAssignments.playerId', index);
    const role = normalizeRole(assignment.role, index);
    const source = normalizeSource(assignment.source ?? 'manual', index);

    addRow({ teamId, playerId, role, source });
  });

  return Array.from(rowByKey.values());
}

async function persistRows({ supabaseClient, tableName, rows, upsert = false }) {
  if (!supabaseClient || typeof supabaseClient.from !== 'function') {
    throw new TypeError('supabaseClient with a from() method is required');
  }

  const table = supabaseClient.from(tableName);
  if (!table || typeof table !== 'object') {
    throw new TypeError('supabaseClient.from must return a query builder object');
  }

  const action = upsert ? table.upsert : table.insert;
  const actionName = upsert ? 'upsert' : 'insert';

  if (typeof action !== 'function') {
    throw new TypeError(`${tableName} builder must expose a ${actionName}() method`);
  }

  const { data, error } = await action.call(table, rows);
  if (error) {
    const message = error.message ?? String(error);
    throw new Error(`Failed to persist ${tableName}: ${message}`);
  }
  return data ?? null;
}

/**
 * Persist teams to Supabase using the provided client.
 * @param {Object} params
 * @param {Object} params.supabaseClient - Supabase client exposing `from()`.
 * @param {Record<string, Array<Object>>} params.teamsByDivision
 * @param {Record<string, string>} [params.divisionIdMap]
 * @param {Array<Object>} [params.teamOverrides]
 * @param {string} [params.runId]
 * @param {boolean} [params.upsert=false]
 * @returns {Promise<{ data: Array<Object> | null, teamIdMap: Map<string, string> }>}
 */
export async function persistTeams({
  supabaseClient,
  teamsByDivision,
  divisionIdMap,
  teamOverrides,
  runId,
  upsert = false,
} = {}) {
  const { rows, teamIdMap } = buildTeamRows({ teamsByDivision, divisionIdMap, teamOverrides, runId });
  if (rows.length === 0) {
    return { data: [], teamIdMap };
  }
  const data = await persistRows({ supabaseClient, tableName: 'teams', rows, upsert });
  return { data, teamIdMap };
}

/**
 * Persist team-player assignments to Supabase using the provided client.
 * @param {Object} params
 * @param {Object} params.supabaseClient - Supabase client exposing `from()`.
 * @param {Record<string, Array<Object>>} params.teamsByDivision
 * @param {Array<Object>} [params.manualAssignments]
 * @param {string} [params.runId]
 * @param {boolean} [params.upsert=false]
 * @param {Map<string, string>} [params.teamIdMap]
 * @returns {Promise<Array<Object> | null>} Supabase response payload.
 */
export async function persistTeamPlayers({
  supabaseClient,
  teamsByDivision,
  manualAssignments,
  runId,
  upsert = false,
  teamIdMap,
} = {}) {
  const rows = buildTeamPlayerRows({ teamsByDivision, manualAssignments, runId, teamIdMap });
  if (rows.length === 0) {
    return [];
  }
  return persistRows({ supabaseClient, tableName: 'team_players', rows, upsert });
}
