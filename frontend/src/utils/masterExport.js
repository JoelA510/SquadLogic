import { generateScheduleExports } from '@squadlogic/core/outputGeneration.js';
import { teamCoachFields } from './teamCoaches.js';
import { readSeasonTeamDirectory } from './scheduleReportsRead.js';
import { refreshAndReadScheduleTbd } from './scheduleTbdClient.js';

/**
 * The master export: the rows a publication baseline is recorded from, made in one place (PR 6b of the schedule
 * expansion, task G5a; `docs/changes/2026-11-03-schedule-expansion.md`, section 7).
 *
 * The Exports page made these rows inside `OutputGenerationPanel`: the TIME TBD list refreshed and read, the season's
 * team directory read, `buildExportPayload` over the page's teams, practices and games, then
 * `generateScheduleExports`. A second caller (the import panel recording an import as the publication baseline, task
 * G5) must make byte-identical rows, so the whole sequence lives here and both call `generateMasterExport`. The panel
 * keeps every sentence it says and every state it sets; this module returns what happened, never words for a person.
 *
 * It needs the client (the two reads), so it is a frontend util, not core; `buildExportPayload` and the
 * normalisers below are pure.
 *
 * @module utils/masterExport
 */

const DAY_INDEX = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

function getAssignmentTeamId(assignment) {
  return assignment?.teamId ?? assignment?.team_id ?? assignment?.teams?.id ?? null;
}

function getAssignmentSlotId(assignment) {
  return (
    assignment?.slotId ??
    assignment?.slot_id ??
    assignment?.practiceSlotId ??
    assignment?.practice_slot_id ??
    assignment?.practiceSlots?.id ??
    assignment?.practice_slots?.id ??
    null
  );
}

function normalizeTeamForExport(team) {
  const id = team?.id ?? team?.teamId ?? team?.team_id;
  if (!id) return null;

  const division =
    team.division ??
    team.divisionName ??
    team.division_id ??
    team.divisionId ??
    team.divisions?.name ??
    '';

  return {
    id,
    name: team.name ?? team.teamName ?? id,
    division,
    // An outside club is named as an opponent and has no rows of its own (`generateScheduleExports`).
    isExternal: team.isExternal === true || team.is_external === true,
    // 8.2: the row's coach fields under one spelling, **both sources intact**,
    // so `generateScheduleExports()` reconciles them and its `coachFindings`
    // carry any disagreement. Reconciling here and passing the settled list
    // left the core one source to read, and the message below could never
    // fire — the export said "generated successfully" for a team whose two
    // sources named different people in slot 1.
    ...teamCoachFields(team),
  };
}

function getDateFromRange(range) {
  const match = String(range ?? '').match(/\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? '2026-01-01';
}

function getDateForDay(baseDate, day) {
  const date = new Date(`${baseDate}T00:00:00Z`);
  const dayIndex = DAY_INDEX[String(day ?? '').toLowerCase()];
  if (Number.isNaN(date.getTime()) || dayIndex == null) {
    return baseDate;
  }

  const delta = (dayIndex - date.getUTCDay() + 7) % 7;
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function normalizeTime(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  const [hours = '00', minutes = '00', seconds = '00'] = trimmed.split(':');
  return `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:${seconds.padStart(2, '0')}`;
}

function normalizePracticeForExport(assignment) {
  const teamId = getAssignmentTeamId(assignment);
  const slot = assignment?.practiceSlots ?? assignment?.practice_slots ?? {};
  const startTime = normalizeTime(
    assignment?.startTime ?? assignment?.start_time ?? slot.startTime ?? slot.start_time
  );
  const endTime = normalizeTime(
    assignment?.endTime ?? assignment?.end_time ?? slot.endTime ?? slot.end_time
  );
  const range = assignment?.effectiveDateRange ?? assignment?.effective_date_range;
  const day =
    assignment?.dayOfWeek ?? assignment?.day_of_week ?? slot.dayOfWeek ?? slot.day_of_week;
  const date = getDateForDay(getDateFromRange(range), day);

  if (!teamId || (!assignment?.start && !startTime) || (!assignment?.end && !endTime)) {
    return null;
  }

  return {
    teamId,
    start: assignment.start ?? `${date}T${startTime}`,
    end: assignment.end ?? `${date}T${endTime}`,
    fieldId:
      assignment.fieldId ??
      assignment.field_id ??
      slot.fieldId ??
      slot.field_id ??
      slot.fields?.id ??
      slot.fields?.name ??
      '',
    slotId: getAssignmentSlotId(assignment) ?? '',
    notes: assignment.notes ?? '',
  };
}

function normalizeGameForExport(assignment) {
  if (!assignment?.start || !assignment?.end) return null;

  return {
    homeTeamId: assignment.homeTeamId ?? assignment.home_team_id,
    awayTeamId: assignment.awayTeamId ?? assignment.away_team_id,
    start: assignment.start,
    end: assignment.end,
    fieldId: assignment.fieldId ?? assignment.field_id ?? '',
    slotId: assignment.slotId ?? assignment.slot_id ?? '',
    notes: assignment.notes ?? '',
  };
}

export function buildExportPayload({
  teams,
  teamSummary,
  practiceAssignments,
  gameAssignments,
  directory = [],
}) {
  const teamDirectory = new Map();
  const addTeam = (team) => {
    const normalized = normalizeTeamForExport(team);
    if (normalized) teamDirectory.set(normalized.id, normalized);
  };

  // The season's teams as the tables hold them come first, outside clubs included (an outside club is in no team run, so
  // the run's teams never name one); the run's own teams, which carry the coaches, replace their entries.
  (Array.isArray(directory) ? directory : []).forEach(addTeam);
  (Array.isArray(teams) ? teams : []).forEach(addTeam);
  (Array.isArray(teamSummary?.teams) ? teamSummary.teams : []).forEach(addTeam);
  (Array.isArray(practiceAssignments) ? practiceAssignments : []).forEach((assignment) => {
    const teamId = getAssignmentTeamId(assignment);
    if (!teamDirectory.has(teamId)) {
      addTeam({ ...assignment.teams, id: teamId });
    }
  });

  const exportTeams = Array.from(teamDirectory.values());
  const exportTeamIds = new Set(exportTeams.map((team) => String(team.id)));
  const practiceRows = Array.isArray(practiceAssignments) ? practiceAssignments : [];
  const gameRows = Array.isArray(gameAssignments) ? gameAssignments : [];
  // An assignment with a broken time (no start or end) is not in the master files:
  // `generateScheduleExports` requires both for an assignment. It is counted here and said beside
  // the files (admin focus R7), never left out without a word. This is only a row whose time is
  // broken: a practice a team is short of and a game that could not be placed are not assignments
  // at all, and are listed as TIME TBD rows from the `schedule_tbd` table (Phase D, E). (A practice
  // row with no team is not counted: it names no team to export it under, and is not a time
  // question.)
  const untimed = {
    practices: practiceRows.filter(
      (a) => a && getAssignmentTeamId(a) && !normalizePracticeForExport(a)
    ).length,
    games: gameRows.filter((a) => a && !normalizeGameForExport(a)).length,
  };
  const exportPractices = practiceRows
    .map(normalizePracticeForExport)
    .filter((assignment) => assignment && exportTeamIds.has(String(assignment.teamId)));
  // The ids go with the games through the same filters, so the games a file holds and the games "Mark these games
  // Published" names cannot differ: a game with no time, or of a team the files do not hold, is in neither.
  const exportedGames = gameRows
    .map((assignment) => ({ id: assignment?.id, game: normalizeGameForExport(assignment) }))
    .filter(
      ({ game }) =>
        game &&
        exportTeamIds.has(String(game.homeTeamId)) &&
        exportTeamIds.has(String(game.awayTeamId))
    );
  const exportGames = exportedGames.map(({ game }) => game);
  // A game with a time whose home or away team is in no directory cannot be written to the files: counted here and said
  // beside them, never left out without a word (the games a file holds and the ids "Mark these games Published" names are
  // the same filter, so they cannot differ).
  const omitted = {
    games: gameRows.filter((assignment) => {
      const game = normalizeGameForExport(assignment);
      return (
        game &&
        !(exportTeamIds.has(String(game.homeTeamId)) && exportTeamIds.has(String(game.awayTeamId)))
      );
    }).length,
  };
  const gameIds = exportedGames
    .map(({ id }) => id)
    .filter((id) => typeof id === 'string' && id !== '');

  return {
    teams: exportTeams,
    practiceAssignments: exportPractices,
    gameAssignments: exportGames,
    gameIds,
    untimed,
    omitted,
  };
}

/**
 * What one generation of the master export came to. The panel turns each into its sentence.
 *
 * @typedef {{ rows: Array<Record<string, any>>, items: Array<import('@squadlogic/core/scheduleTbd.js').ScheduleTbdItem> }} TbdList
 * @typedef {ReturnType<typeof buildExportPayload>} ExportPayload
 * @typedef {(
 *   | { status: 'tbd-failed', error: any }
 *   | { status: 'nothing-scheduled', tbd: TbdList }
 *   | { status: 'directory-failed', table: string, message: string, tbd: TbdList }
 *   | { status: 'nothing-writable', payload: ExportPayload, tbd: TbdList }
 *   | { status: 'generated', payload: ExportPayload, exports: ReturnType<typeof generateScheduleExports>, tbd: TbdList, exportedPractices: Array<Object> }
 * )} MasterExportResult
 */

/**
 * Make the master and per-team files from the season as the tables hold it and the schedule the caller was handed.
 *
 * In order, each step stopping the files as it always has:
 *
 * 1. The TIME TBD list (practices a team is short of, games not placed), brought up to date and then read (only read
 *    for a completed season, which is history). A list that cannot be refreshed or read stops the files
 *    (`tbd-failed`): files made without it would leave those practices and games out without a word. No season: no
 *    list.
 * 2. Nothing placed and nothing on the list is nothing to make files from (`nothing-scheduled`); a header-only file
 *    is not an export.
 * 3. The season's teams as the tables hold them, outside clubs included (the latest team run holds only the league's
 *    own teams, so a directory made from it alone drops every game an outside club plays). A read that fails stops
 *    the files, naming the table (`directory-failed`). No organization or season: no directory.
 * 4. `buildExportPayload`; when none of it can be written and the list is empty, `nothing-writable`.
 * 5. `generateScheduleExports` (`generated`). It throws on a row it cannot write; that is not caught here.
 *
 * @param {any} client - the supabase client
 * @param {{
 *   organizationId?: string | null,
 *   seasonSettingsId?: string | null,
 *   seasonCompleted?: boolean,
 *   teams?: Array<Object>,
 *   teamSummary?: Object | null,
 *   practiceAssignments?: Array<Object>,
 *   gameAssignments?: Array<Object>,
 *   onTbdRead?: (tbd: TbdList) => void,
 * }} params - `onTbdRead` is told the list as soon as it is read, before the directory read
 * @returns {Promise<MasterExportResult>}
 */
export async function generateMasterExport(
  client,
  {
    organizationId = null,
    seasonSettingsId = null,
    seasonCompleted = false,
    teams,
    teamSummary,
    practiceAssignments,
    gameAssignments,
    onTbdRead,
  }
) {
  /** @type {TbdList} */
  let tbd = { rows: [], items: [] };
  if (seasonSettingsId) {
    try {
      tbd = await refreshAndReadScheduleTbd(client, seasonSettingsId, {
        readOnly: seasonCompleted,
      });
    } catch (error) {
      return { status: 'tbd-failed', error };
    }
  }
  onTbdRead?.(tbd);
  if (
    (practiceAssignments?.length ?? 0) === 0 &&
    (gameAssignments?.length ?? 0) === 0 &&
    tbd.items.length === 0
  ) {
    return { status: 'nothing-scheduled', tbd };
  }
  let directory = [];
  if (organizationId && seasonSettingsId) {
    const read = await readSeasonTeamDirectory(client, { organizationId, seasonSettingsId });
    if (read.ok !== true) {
      return { status: 'directory-failed', table: read.table, message: read.message, tbd };
    }
    directory = read.teams;
  }
  const payload = buildExportPayload({
    teams,
    teamSummary,
    practiceAssignments,
    gameAssignments,
    directory,
  });
  if (
    payload.practiceAssignments.length === 0 &&
    payload.gameAssignments.length === 0 &&
    tbd.items.length === 0
  ) {
    return { status: 'nothing-writable', payload, tbd };
  }
  const exports = generateScheduleExports({
    teams: payload.teams,
    practiceAssignments: payload.practiceAssignments,
    gameAssignments: payload.gameAssignments,
    tbdItems: tbd.items,
  });
  // The practice rows the files hold, as the caller handed them over, filtered exactly as `buildExportPayload`
  // filters them (never a row it dropped): what the page counts a practice's unshown changes over.
  const exportTeamIds = new Set(payload.teams.map((team) => String(team.id)));
  const exportedPractices = (practiceAssignments ?? []).filter((assignment) => {
    const exported = normalizePracticeForExport(assignment);
    return exported && exportTeamIds.has(String(exported.teamId));
  });
  return { status: 'generated', payload, exports, tbd, exportedPractices };
}
