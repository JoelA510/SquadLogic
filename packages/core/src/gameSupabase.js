import { normalizeId, normalizeTimestamp, normalizeOptionalString } from './utils/normalization.js';

function normalizeWeekIndex(value, index) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`assignments[${index}] requires a positive weekIndex`);
  }
  return Math.trunc(value);
}

function normalizeFieldId(value) {
  return normalizeOptionalString(value);
}

function normalizeAssignmentSource(value) {
  const normalized = normalizeOptionalString(value) ?? 'auto';
  if (normalized === 'locked') return 'manual';
  if (normalized !== 'auto' && normalized !== 'manual') {
    throw new Error(`unsupported game assignment source: ${normalized}`);
  }
  return normalized;
}

/**
 * Convert scheduler assignments into Supabase-ready rows for `game_assignments`.
 *
 * @param {Object} params
 * @param {Array<Object>} params.assignments - Game assignments from the scheduler. An assignment that carries a
 *   non-empty string `id` names the saved game it continues, and its row carries that `id`: the save updates that game
 *   in place (`20261120010000_game_identity.sql`). The caller sends an id only for a game that is saved (the Games
 *   page's `persisted` ones), never a placeholder; an empty or non-string id is no id.
 * @param {string} [params.runId] - Optional scheduler run identifier.
 * @returns {Array<Object>} Supabase row payloads with snake_case keys.
 */
export function buildGameAssignmentRows({ assignments, runId } = { assignments: [] }) {
  if (!Array.isArray(assignments)) {
    throw new TypeError('assignments must be an array');
  }

  return assignments.map((assignment, index) => {
    if (!assignment || typeof assignment !== 'object') {
      throw new TypeError(`assignments[${index}] must be an object`);
    }

    const division = normalizeId(assignment.division, 'division', index);
    const weekIndex = normalizeWeekIndex(assignment.weekIndex, index);
    const slotId = normalizeId(assignment.slotId, 'slotId', index);
    const homeTeamId = normalizeId(assignment.homeTeamId, 'homeTeamId', index);
    const awayTeamId = normalizeId(assignment.awayTeamId, 'awayTeamId', index);
    const start = normalizeTimestamp(assignment.start, 'start', index);
    const end = normalizeTimestamp(assignment.end, 'end', index);

    if (end <= start) {
      throw new Error(`assignments[${index}] end must be after start`);
    }

    const id = typeof assignment.id === 'string' && assignment.id !== '' ? assignment.id : null;

    return {
      ...(id === null ? {} : { id }),
      division,
      week_index: weekIndex,
      game_slot_id: slotId,
      slot_id: slotId,
      start,
      end,
      field_id: normalizeFieldId(assignment.fieldId ?? assignment.field_id),
      home_team_id: homeTeamId,
      away_team_id: awayTeamId,
      assignment_source: normalizeAssignmentSource(
        assignment.assignmentSource ?? assignment.assignment_source ?? assignment.source
      ),
      run_id: runId ?? null,
    };
  });
}

/**
 * Persist game assignments through a Supabase client.
 *
 * @param {Object} params
 * @param {Object} params.supabaseClient - Supabase client exposing `from()`.
 * @param {Array<Object>} params.assignments - Game assignments from the scheduler.
 * @param {string} [params.runId] - Optional scheduler run identifier.
 * @param {boolean} [params.upsert=false] - Whether to upsert instead of insert.
 * @returns {Promise<Array<Object> | null>} Supabase response payload.
 */
export async function persistGameAssignments(
  { supabaseClient, assignments, runId = undefined, upsert = false } = {
    supabaseClient: undefined,
    assignments: [],
  }
) {
  if (!supabaseClient || typeof supabaseClient.from !== 'function') {
    throw new TypeError('supabaseClient with a from() method is required');
  }

  const rows = buildGameAssignmentRows({ assignments, runId });
  if (rows.length === 0) {
    return [];
  }

  const table = supabaseClient.from('game_assignments');
  if (!table || typeof table !== 'object') {
    throw new TypeError('supabaseClient.from must return a query builder object');
  }

  const action = upsert ? table.upsert : table.insert;
  const actionName = upsert ? 'upsert' : 'insert';
  if (typeof action !== 'function') {
    throw new TypeError(`game_assignments builder must expose a ${actionName}() method`);
  }

  const { data, error } = await action.call(table, rows);
  if (error) {
    const message = error.message ?? String(error);
    throw new Error(`Failed to persist game assignments: ${message}`);
  }

  return data ?? null;
}
