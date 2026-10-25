import { summarizeTeamGeneration } from '@squadlogic/core/teamDiagnostics.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

export function createUuid() {
  const cryptoSource = globalThis.crypto;
  if (typeof cryptoSource?.randomUUID === 'function') {
    return cryptoSource.randomUUID();
  }

  if (typeof cryptoSource?.getRandomValues !== 'function') {
    throw new Error('Secure UUID generation is unavailable in this environment.');
  }

  const bytes = cryptoSource.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export function firstString(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return null;
}

export function getPlayerExternalId(row) {
  return firstString(row, [
    'external_registration_id',
    'gotsport_id',
    'registration_id',
    'player_registration_id',
  ]);
}

function groupTeamRows(teamRows) {
  return teamRows.reduce((acc, team) => {
    const key = team.division || team.division_id || 'Unassigned';
    acc[key] = acc[key] || [];
    acc[key].push({
      id: team.id,
      name: team.name,
      division: key,
      division_id: team.division_id,
      coachId: team.coach_id ?? null,
      players: [],
    });
    return acc;
  }, {});
}

function normalizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function findDivisionIdForTeam(teamRow, displayTeam, divisionRows = []) {
  const candidates = [
    teamRow.division_id,
    teamRow.division,
    teamRow.divisionName,
    displayTeam?.division_id,
    displayTeam?.division,
    displayTeam?.divisionName,
  ].filter(Boolean);

  const uuidCandidate = candidates.find(isUuid);
  if (uuidCandidate) return uuidCandidate;

  const normalizedCandidates = new Set(candidates.map(normalizeKey));
  const matchedDivision = divisionRows.find(
    (division) =>
      normalizedCandidates.has(normalizeKey(division.id)) ||
      normalizedCandidates.has(normalizeKey(division.name))
  );

  return matchedDivision?.id || null;
}

function remapTeamStatsByDivision(statsByDivision = {}, teamIdMap) {
  return Object.fromEntries(
    Object.entries(statsByDivision).map(([division, value]) => [
      division,
      {
        ...value,
        teamStats: (value?.teamStats || []).map((entry) => ({
          ...entry,
          teamId: teamIdMap[entry.teamId] || entry.teamId,
        })),
        summary: value?.summary
          ? {
              ...value.summary,
              teamsNeedingPlayers: (value.summary.teamsNeedingPlayers || []).map(
                (teamId) => teamIdMap[teamId] || teamId
              ),
              teamsBelowMinRoster: Array.isArray(value.summary.teamsBelowMinRoster)
                ? value.summary.teamsBelowMinRoster.map((teamId) => teamIdMap[teamId] || teamId)
                : value.summary.teamsBelowMinRoster,
            }
          : value?.summary,
      },
    ])
  );
}

function remapTeamsByDivision(teamsByDivision, teamIdMap, teamRowById) {
  return Object.fromEntries(
    Object.entries(teamsByDivision || {}).map(([division, teams]) => [
      division,
      (teams || []).map((team) => {
        const mappedId = teamIdMap[team.id] || team.id;
        const teamRow = teamRowById.get(mappedId);
        return {
          ...team,
          id: mappedId,
          division_id: teamRow?.division_id || team.division_id,
        };
      }),
    ])
  );
}

/**
 * @param {any} params
 */
export function buildTeamReviewSnapshot(
  {
    generatedResult,
    divisionKey,
    divisionId,
    organizationId,
    seasonSettingsId,
    userId,
    selectedProgramId,
    divisionConfig,
    nowIso = new Date().toISOString(),
    runId = createUuid(),
    idFactory = createUuid,
  } = /** @type {any} */ ({})
) {
  if (!generatedResult?.teamsByDivision || !divisionKey || !divisionId) {
    throw new Error('Generated teams and a saved division are required before review.');
  }

  const originalTeams = generatedResult.teamsByDivision[divisionKey] || [];
  const teamIdMap = {};
  const teamRows = originalTeams.map((team) => {
    const dbTeamId = isUuid(team.id) ? team.id : idFactory();
    teamIdMap[team.id] = dbTeamId;
    return {
      id: dbTeamId,
      organization_id: organizationId,
      division_id: divisionId,
      division: divisionKey,
      name: team.name,
      coach_id: isUuid(team.coachId) ? team.coachId : null,
      // Assistants persist as id metadata on the team row (uuid[] in the DB) —
      // team_players.player_id is FK-bound to players, so assistant (coach-id)
      // role rows are structurally impossible there. UUID-only, matching the
      // coach_id convention; non-UUID assistant ids still round-trip via the
      // inline results.teams JSON that the re-run path reads.
      assistant_coach_ids: [
        ...new Set(
          (Array.isArray(team.assistantCoachIds) ? team.assistantCoachIds : [])
            .map((id) => String(id))
            .filter(isUuid)
        ),
      ],
    };
  });

  const teamPlayerRows = originalTeams.flatMap((team) => {
    const teamId = teamIdMap[team.id];
    return (team.players || []).map((player) => ({
      team_id: teamId,
      player_id: player.id,
      role: 'player',
      source: player.assignment_source === 'manual' ? 'manual' : 'auto',
      player_name: player.name || `${player.firstName || ''} ${player.lastName || ''}`.trim(),
      skill: player.skillRating ?? player.skill ?? null,
    }));
  });

  const teamsByDivision = {
    ...generatedResult.teamsByDivision,
    [divisionKey]: originalTeams.map((team) => ({
      ...team,
      id: teamIdMap[team.id],
      generatorId: team.id,
      division: team.division || divisionKey,
      division_id: divisionId,
    })),
  };

  const results = {
    ...generatedResult,
    teamsByDivision,
    rosterBalanceByDivision: remapTeamStatsByDivision(
      generatedResult.rosterBalanceByDivision,
      teamIdMap
    ),
    skillBalanceByDivision: remapTeamStatsByDivision(
      generatedResult.skillBalanceByDivision,
      teamIdMap
    ),
    teams: Object.values(teamsByDivision).flat(),
    team_players: teamPlayerRows,
  };

  const overflowPlayers = Object.values(generatedResult.overflowSummaryByDivision || {}).reduce(
    (sum, summary) => sum + (summary?.totalPlayers || 0),
    0
  );
  // Persist the structured generation summary (incl. per-division incremental
  // `changes` for snapshot-aware re-runs) alongside the raw results, so audit
  // history carries an analysis-ready digest. Computed from the remapped
  // results so any team ids it references are the persisted UUIDs. Non-fatal:
  // a summary failure must never block persistence.
  let generationSummary = null;
  try {
    generationSummary = summarizeTeamGeneration(results);
  } catch {
    generationSummary = null;
  }
  const metrics = {
    progress: 100,
    generatedTeams: teamRows.length,
    assignedPlayers: teamPlayerRows.length,
    overflowPlayers,
    ...(generationSummary ? { generationSummary } : {}),
  };
  const parameters = {
    source: 'team_analysis_review',
    selectedProgramId,
    divisionConfigs: { [divisionKey]: divisionConfig },
  };
  const runMetadata = {
    runId,
    organizationId,
    seasonId: seasonSettingsId,
    seasonSettingsId,
    runType: 'team',
    status: 'completed',
    parameters,
    metrics,
    results,
    createdBy: userId,
    startedAt: nowIso,
    completedAt: nowIso,
  };

  return {
    lastRunId: runId,
    lastSyncedAt: null,
    preparedTeamRows: teamRows.length,
    preparedPlayerRows: teamPlayerRows.length,
    manualOverrides: [],
    runHistory: [
      {
        runId,
        status: 'review',
        startedAt: nowIso,
        updatedTeams: teamRows.length,
        updatedPlayers: teamPlayerRows.length,
        notes: 'Pending review',
      },
    ],
    runMetadata,
    payload: {
      teamRows,
      teamPlayerRows,
      teamIdMap,
    },
  };
}

/**
 * @param {any} params
 */
export function buildManualRosterSnapshot(
  {
    baseSnapshot,
    teams,
    organizationId,
    seasonSettingsId,
    userId,
    divisionRows = [],
    nowIso = new Date().toISOString(),
    runId = createUuid(),
    idFactory = createUuid,
  } = /** @type {any} */ ({})
) {
  const basePayload = baseSnapshot?.payload;
  const sourceTeamRows = basePayload?.teamRows || [];
  if (!Array.isArray(sourceTeamRows) || sourceTeamRows.length === 0) {
    throw new Error('No persisted team rows are available for manual roster changes.');
  }

  const displayTeamById = new Map((teams || []).map((team) => [team.id, team]));
  const teamIdMap = {};
  const teamRows = sourceTeamRows.map((teamRow) => {
    const targetId = isUuid(teamRow.id) ? teamRow.id : idFactory();
    const displayTeam = displayTeamById.get(teamRow.id);
    const divisionId = findDivisionIdForTeam(teamRow, displayTeam, divisionRows);

    if (!divisionId || !isUuid(divisionId)) {
      throw new Error('Manual roster changes require saved UUID-backed divisions.');
    }

    teamIdMap[teamRow.id] = targetId;
    return {
      ...teamRow,
      id: targetId,
      organization_id: organizationId,
      division_id: divisionId,
      coach_id: isUuid(teamRow.coach_id) ? teamRow.coach_id : null,
    };
  });

  const validTeamIds = new Set(sourceTeamRows.map((team) => team.id));
  const invalidTeam = (teams || []).find((team) => !validTeamIds.has(team.id));
  if (invalidTeam) {
    throw new Error('Manual roster changes include a team outside the persisted snapshot.');
  }

  const teamPlayerRows = (teams || []).flatMap((team) =>
    (team.players || []).map((player) => ({
      team_id: teamIdMap[team.id] || team.id,
      player_id: player.id,
      role: player.role || 'player',
      source:
        player.assignment_source === 'manual' || player.source === 'manual' ? 'manual' : 'auto',
      player_name: player.name || null,
      skill: player.skill || player.skillRating || null,
    }))
  );
  const invalidPlayer = teamPlayerRows.find((row) => !isUuid(row.player_id));
  if (invalidPlayer) {
    throw new Error('Manual roster changes require durable UUID-backed players.');
  }

  const manualAssignments = teamPlayerRows.filter((row) => row.source === 'manual').length;
  const baseResults = baseSnapshot?.runMetadata?.results || {};
  const teamRowById = new Map(teamRows.map((team) => [team.id, team]));
  const teamsByDivision = remapTeamsByDivision(
    baseResults.teamsByDivision || groupTeamRows(sourceTeamRows),
    teamIdMap,
    teamRowById
  );
  const results = {
    ...baseResults,
    teams: teamRows,
    teamsByDivision,
    team_players: teamPlayerRows,
  };
  const runMetadata = {
    ...(baseSnapshot?.runMetadata || {}),
    runId,
    organizationId,
    seasonId: seasonSettingsId,
    seasonSettingsId,
    runType: 'team',
    status: 'completed',
    parameters: {
      ...(baseSnapshot?.runMetadata?.parameters || {}),
      source: 'manual_roster_review',
      previousRunId: baseSnapshot?.lastRunId || baseSnapshot?.runMetadata?.runId || null,
    },
    metrics: {
      ...(baseSnapshot?.runMetadata?.metrics || {}),
      progress: 100,
      generatedTeams: teamRows.length,
      assignedPlayers: teamPlayerRows.length,
      manualAssignments,
    },
    results,
    createdBy: userId,
    startedAt: nowIso,
    completedAt: nowIso,
  };

  return {
    ...baseSnapshot,
    lastRunId: runId,
    lastSyncedAt: null,
    preparedTeamRows: teamRows.length,
    preparedPlayerRows: teamPlayerRows.length,
    manualOverrides: [],
    runHistory: [
      {
        runId,
        status: 'review',
        startedAt: nowIso,
        updatedTeams: teamRows.length,
        updatedPlayers: teamPlayerRows.length,
        notes: 'Manual roster edits pending sync',
      },
      ...(baseSnapshot?.runHistory || []),
    ],
    runMetadata,
    payload: {
      ...basePayload,
      teamRows,
      teamPlayerRows,
      teamIdMap: {
        ...(basePayload?.teamIdMap || {}),
        ...teamIdMap,
      },
    },
  };
}

/**
 * Relational `team_players.role` values that are NOT part of the active roster — coaches, not
 * players. Mirrors the canonical role sets in packages/core/src/teamSnapshot.js so a head-coach or
 * assistant row is never mis-seated as a rostered player (today persistence only writes
 * `role: 'player'`, but §6g of the hardening doc contemplates persisting coach rows later).
 */
const NON_ROSTER_ROLES = new Set([
  'assistant_coach',
  'assistant coach',
  'assistant',
  'coach',
  'head_coach',
  'head coach',
]);
const ASSISTANT_COACH_ROLES = new Set(['assistant_coach', 'assistant coach', 'assistant']);
const roleOf = (row) => String(row?.role ?? 'player').toLowerCase();

/**
 * Is a relational `team_players` row a rostered player (not a coach or assistant)? The one test,
 * for every reader of the rows: a row with no role is a player.
 * @param {any} row
 */
export const isRosterPlayerRow = (row) => !NON_ROSTER_ROLES.has(roleOf(row));

/**
 * Build an `existingSnapshot` (consumable by core `generateTeams`) from a previously persisted
 * team snapshot, so a re-run PRESERVES team UUIDs, coach/assistant assignments, and manual roster
 * moves instead of regenerating fresh. Division-scoped when `divisionKey` is supplied. Returns null
 * when there is nothing to preserve (the first run for that division) — callers then fall back to
 * fresh generation. Pure — no Supabase / React imports; DB-specific logic stays out of core.
 *
 * Tolerates both shapes a persisted snapshot can carry: generation-style team rows with an inline
 * `players` array, and the relational `teamPlayerRows`. The relational `source` is authoritative
 * for the manual/auto flag (it survives manual roster edits), so it wins when present. When a
 * `payloadByDivision` map is present (see useTeamPersistence), the requested division's own
 * most-recent payload is preferred over the single global `payload`.
 *
 * @param {any} baseSnapshot - persisted/review snapshot with `payload.teamRows` (+ optional `payload.teamPlayerRows`), and optional `payloadByDivision`.
 * @param {{ divisionKey?: string }} [options]
 * @returns {{ status: string, runId: string|null, teamsByDivision: Record<string, any[]> } | null}
 */
export function buildExistingSnapshotForRerun(baseSnapshot, { divisionKey } = {}) {
  // Prefer the division's own most-recent persisted payload so re-running a division other than the
  // single most-recently-persisted one still finds its teams; fall back to the global payload.
  const payload =
    (divisionKey != null && baseSnapshot?.payloadByDivision?.[divisionKey]) ||
    baseSnapshot?.payload;
  const teamRows = Array.isArray(payload?.teamRows) ? payload.teamRows : [];
  if (teamRows.length === 0) return null;

  const playerRowsByTeam = new Map();
  for (const row of Array.isArray(payload?.teamPlayerRows) ? payload.teamPlayerRows : []) {
    if (!row?.team_id) continue;
    if (!playerRowsByTeam.has(row.team_id)) playerRowsByTeam.set(row.team_id, []);
    playerRowsByTeam.get(row.team_id).push(row);
  }

  /** @type {Record<string, any[]>} */
  const teamsByDivision = {};
  for (const team of teamRows) {
    const division = String(team?.division ?? team?.division_id ?? 'unknown');
    if (divisionKey != null && division !== String(divisionKey)) continue;

    const relationalRows = playerRowsByTeam.get(team.id) || [];
    const relationalPlayers = relationalRows.filter(isRosterPlayerRow);
    const players =
      relationalPlayers.length > 0
        ? relationalPlayers.map((row) => ({
            id: row.player_id,
            assignment_source: row.source === 'manual' ? 'manual' : 'auto',
            locked: Boolean(row.locked),
          }))
        : (Array.isArray(team.players) ? team.players : []).map((player) => ({
            id: player.id,
            assignment_source: player.assignment_source === 'manual' ? 'manual' : 'auto',
            locked: Boolean(player.locked),
          }));

    const inlineAssistants = team.assistantCoachIds ?? team.assistant_coach_ids ?? [];
    const relationalAssistants = relationalRows
      .filter((row) => ASSISTANT_COACH_ROLES.has(roleOf(row)))
      .map((row) => row.player_id);
    const assistantCoachIds = [...new Set([...inlineAssistants, ...relationalAssistants])];

    if (!teamsByDivision[division]) teamsByDivision[division] = [];
    teamsByDivision[division].push({
      id: team.id,
      ...(team.generatorId ? { generatorId: team.generatorId } : {}),
      ...(team.name != null ? { name: team.name } : {}),
      division,
      coachId: team.coachId ?? team.coach_id ?? null,
      assistantCoachIds,
      locked: Boolean(team.locked),
      players,
    });
  }

  if (Object.keys(teamsByDivision).length === 0) return null;

  return {
    status: baseSnapshot?.runHistory?.[0]?.status ?? 'review',
    runId: baseSnapshot?.lastRunId ?? baseSnapshot?.runMetadata?.runId ?? null,
    teamsByDivision,
  };
}
