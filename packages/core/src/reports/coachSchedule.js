/**
 * The coach schedule (tasks G2 and G2b of PR 7 of the schedule expansion; plan 5.1, F3 and F17): one coach's games
 * and practices across all their teams, head and assistant, as rows and a file. Read-only, admin only, the coach's
 * name and never an email or a phone (data minimisation; the master export's `Coach Emails` column stays where it is).
 *
 * - **The coach's teams are `team_coach_assignments`**, head (`lead`) and assistant, read as of a date, so an
 *   assistant's team is on the schedule and a team a coach left is not.
 * - **The multi-team marker is derived from the team list**: the DISTINCT teams a coach has now. The stored
 *   `can_coach_multiple_teams` flag the Coaches page shows is not read at all.
 * - **The subject set is the coach registry.** A coach with no team is listed. An assignment that names a coach or a
 *   team the registry lacks is reported, never turned into a coach.
 * - **The games clash column is `evaluateGameSchedule`'s per-coach `coach-conflict` warning.** The evaluator reports
 *   the first overlap it finds for a coach, so it is run week by week: a coach's second clash is not hidden behind
 *   the first. The practice clash is the one rule of `practiceClash.js`. **A practice is never compared with a game.**
 * - **Nothing is dropped.** A game on the TIME TBD list and a saved game with no readable time keep their rows, with
 *   the reason; a practice whose slot or date range cannot be read keeps its row too.
 *
 * @module reports/coachSchedule
 */

import { evaluateGameSchedule } from '../gameMetrics.js';
import { formatCsv } from '../outputGeneration.js';
import { windowCoversDate } from '../people/roster.js';
import { scheduleTbdNote } from '../scheduleTbd.js';
import {
  GAME_SLOT_MISSING,
  TEAM_SCHEDULE_CAUSES,
  TEAM_SCHEDULE_COLUMNS,
  TEAM_SCHEDULE_HEADERS as H,
  TEAM_SCHEDULE_STATUS,
} from '../teamScheduleExport.js';
import { TIMING_REASON } from '../timing/index.js';
import { practiceRangeBounds, practiceRangeLowerBound } from '../utils/practiceOccurrences.js';
import { makeNamers } from './daySheet.js';
import { positiveWeek } from './gameKey.js';
import { PRACTICE_UNREADABLE, coachPracticeClashes, readPractice } from './practiceClash.js';
import { instantMs, wallOfInstant, weekdayOfDate } from './wall.js';

/** The file's columns: the coach, the team export's own, then the day, the dates of a practice series and the clash. */
export const COACH_SCHEDULE_COLUMNS = Object.freeze([
  'Coach',
  ...TEAM_SCHEDULE_COLUMNS,
  'Day',
  'Dates',
  'Coach Clash',
]);

const WEEKDAY_LONG = Object.freeze({
  sun: 'Sunday',
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
});

const NOT_COMPARED =
  'A practice is not compared with a game: a weekly series against a dated event is not checked.';

/** @param {unknown} value */
const idOf = (value) => (value === null || value === undefined ? '' : String(value));
/** @param {unknown} value */
const dateOnly = (value) =>
  value === null || value === undefined ? null : String(value).slice(0, 10);

/**
 * Who coaches which team as of a date.
 *
 * @param {Object} input
 * @param {Array<{ id: string, name: string }>} input.coaches - the registry
 * @param {Array<{ id: string, name: string, division?: string | null }>} input.teams - the registry
 * @param {Array<Record<string, any>>} input.assignments - `team_coach_assignments` rows
 * @param {string} input.asOf - `YYYY-MM-DD`
 */
export function buildCoachDirectory({ coaches, teams, assignments, asOf }) {
  const teamById = new Map(teams.map((team) => [idOf(team.id), team]));
  const coachIds = new Set(coaches.map((coach) => idOf(coach.id)));
  const unknownCoachIds = new Set();
  const unknownTeamIds = new Set();
  /** @type {Map<string, Map<string, Set<string>>>} coach id -> team id -> roles */
  const held = new Map();
  for (const row of assignments) {
    if (!windowCoversDate(asOf, dateOnly(row.effective_from), dateOnly(row.effective_to))) continue;
    const coachId = idOf(row.coach_id);
    const teamId = idOf(row.team_id);
    if (!coachIds.has(coachId)) unknownCoachIds.add(coachId);
    if (!teamById.has(teamId)) unknownTeamIds.add(teamId);
    if (!coachIds.has(coachId) || !teamById.has(teamId)) continue;
    const teamsOfCoach = held.get(coachId) ?? new Map();
    const roles = teamsOfCoach.get(teamId) ?? new Set();
    roles.add(String(row.role));
    teamsOfCoach.set(teamId, roles);
    held.set(coachId, teamsOfCoach);
  }
  const directory = coaches
    .map((coach) => {
      const teamsOfCoach = [...(held.get(idOf(coach.id)) ?? new Map()).entries()]
        .map(([teamId, roles]) => {
          const team = teamById.get(teamId);
          return {
            id: teamId,
            name: String(team.name ?? teamId),
            division: String(team.division ?? ''),
            roles: [...roles].sort(),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      return {
        id: idOf(coach.id),
        name: String(coach.name ?? '').trim() || 'Unnamed coach',
        teams: teamsOfCoach,
        teamCount: teamsOfCoach.length,
        // Derived from the distinct teams, never from the stored flag.
        multiTeam: teamsOfCoach.length >= 2,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return {
    coaches: directory,
    unknownCoachIds: [...unknownCoachIds].sort(),
    unknownTeamIds: [...unknownTeamIds].sort(),
  };
}

/**
 * One coach's schedule.
 *
 * @param {Object} input
 * @param {string} input.coachId
 * @param {Array<{ id: string, name: string }>} input.coaches
 * @param {Array<{ id: string, name: string, division?: string | null }>} input.teams
 * @param {Array<Record<string, any>>} input.assignments
 * @param {string} input.asOf
 * @param {Array<Record<string, any>>} input.games - the saved games (camelCase rows of the latest run)
 * @param {Array<{ homeTeamId: string, awayTeamId: string, weekIndex: number, reason: string, gameDate?: string | null }>} [input.tbdGames]
 * @param {Array<import('./practiceClash.js').ReportPractice>} [input.practices]
 * @param {Array<{ id: string, name: string, venueId?: string | null }>} input.fields
 * @param {Array<{ id: string, name: string }>} input.venues
 * @param {string} input.timeZone
 */
export function buildCoachSchedule({
  coachId,
  coaches,
  teams,
  assignments,
  asOf,
  games,
  tbdGames = [],
  practices = [],
  fields,
  venues,
  timeZone,
}) {
  if (!timeZone) throw new TypeError('the coach schedule needs the season’s time zone');
  const directory = buildCoachDirectory({ coaches, teams, assignments, asOf });
  const coach = directory.coaches.find((entry) => entry.id === idOf(coachId));
  if (!coach) throw new RangeError(`coach ${idOf(coachId)} is not on the coach list`);
  const names = makeNamers({ teams, fields, venues });
  const myTeams = new Map(coach.teams.map((team) => [team.id, team]));

  const locationOf = (fieldId, fallbackName = null) => names.location(fieldId, fallbackName);
  const baseRow = (team, extra) => ({
    Coach: coach.name,
    [H.TEAM]: team.name,
    [H.DIVISION]: team.division,
    [H.EVENT_TYPE]: '',
    [H.OPPONENT]: '',
    [H.HOME_AWAY]: '',
    [H.DATE]: '',
    [H.START]: '',
    [H.END]: '',
    [H.TIME_ZONE]: '',
    [H.LOCATION]: '',
    [H.STATUS]: '',
    [H.REASON]: '',
    [H.REASON_CODE]: '',
    Day: '',
    Dates: '',
    'Coach Clash': '',
    ...extra,
  });

  /**
   * One row of the file, with what orders it (team, then kind, then time) and, for a timed game, the game itself.
   *
   * @type {Array<{ team: string, order: number, at: number, row: Record<string, string>,
   *   game?: Record<string, any>, teamId?: string }>}
   */
  const entries = [];

  // ---- the games the schedule saved, one row for each of the coach's teams in each ----
  let untimedGames = 0;
  let datedGames = 0;
  for (const game of games) {
    for (const role of /** @type {const} */ (['Home', 'Away'])) {
      const teamId = idOf(role === 'Home' ? game.homeTeamId : game.awayTeamId);
      const team = myTeams.get(teamId);
      if (!team) continue;
      const row = baseRow(team, {
        [H.EVENT_TYPE]: 'Game',
        [H.OPPONENT]: names.teamName(role === 'Home' ? game.awayTeamId : game.homeTeamId),
        [H.HOME_AWAY]: role,
        [H.LOCATION]: locationOf(game.fieldId),
      });
      const start = wallOfInstant(game.start, timeZone);
      const end = wallOfInstant(game.end, timeZone);
      const startMs = instantMs(game.start);
      const endMs = instantMs(game.end);
      if (
        start === null ||
        end === null ||
        startMs === null ||
        endMs === null ||
        endMs <= startMs
      ) {
        untimedGames += 1;
        const code = idOf(game.slotId ?? game.gameSlotId)
          ? TIMING_REASON.WALL_TIME_UNREADABLE
          : GAME_SLOT_MISSING;
        Object.assign(row, {
          [H.STATUS]: TEAM_SCHEDULE_STATUS.DATE_TBD,
          [H.REASON]: TEAM_SCHEDULE_CAUSES[code],
          [H.REASON_CODE]: code,
        });
        entries.push({ team: team.name, order: 2, at: 0, row });
        continue;
      }
      datedGames += 1;
      Object.assign(row, {
        [H.DATE]: start.date,
        [H.START]: start.time,
        [H.END]: end.time,
        [H.TIME_ZONE]: timeZone,
        [H.STATUS]: TEAM_SCHEDULE_STATUS.SCHEDULED,
        Day: weekdayOfDate(start.date)?.long ?? '',
      });
      entries.push({ team: team.name, order: 0, at: startMs, row, game, teamId });
    }
  }

  // ---- the games on the TIME TBD list: no time (a date only when an import gave one), the reason in the master
  // export's words ----
  let tbdCount = 0;
  for (const tbd of tbdGames) {
    for (const role of /** @type {const} */ (['Home', 'Away'])) {
      const team = myTeams.get(idOf(role === 'Home' ? tbd.homeTeamId : tbd.awayTeamId));
      if (!team) continue;
      tbdCount += 1;
      const row = baseRow(team, {
        [H.EVENT_TYPE]: 'Game',
        [H.OPPONENT]: names.teamName(role === 'Home' ? tbd.awayTeamId : tbd.homeTeamId),
        [H.HOME_AWAY]: role,
        // A game an import gave a date and no time holds its date (and still no time), as the master export's note
        // and the Day Sheet say it.
        [H.DATE]: tbd.gameDate ?? '',
        [H.STATUS]: TEAM_SCHEDULE_STATUS.TIME_TBD,
        [H.REASON]: scheduleTbdNote({
          kind: 'game',
          homeTeamId: idOf(tbd.homeTeamId),
          awayTeamId: idOf(tbd.awayTeamId),
          weekIndex: tbd.weekIndex,
          reason: tbd.reason,
          ...(tbd.gameDate ? { gameDate: tbd.gameDate } : {}),
        }),
        [H.REASON_CODE]: String(tbd.reason),
      });
      entries.push({ team: team.name, order: 1, at: 0, row });
    }
  }

  // ---- game clashes: the evaluator's coach-conflict, read week by week ----
  const gameClashes = markGameClashes({ coach, entries, teams, assignments, asOf, names });

  // ---- practices, and the one clash rule ----
  const myPractices = practices.filter((practice) => myTeams.has(idOf(practice.teamId)));
  const { clashes: practiceClashes, unjudged } = coachPracticeClashes(myPractices);
  const practiceById = new Map(myPractices.map((practice) => [practice.id, practice]));
  /** @type {Map<string, string[]>} */
  const clashOf = new Map();
  for (const clash of practiceClashes) {
    const day = WEEKDAY_LONG[clash.dayOfWeek] ?? clash.dayOfWeek;
    const dates =
      clash.sharedDates === null
        ? 'on shared dates'
        : `${clash.sharedDates} shared ${clash.sharedDates === 1 ? 'date' : 'dates'}, from ${clash.firstDate}`;
    for (const [self, otherId] of [
      [clash.a, clash.b],
      [clash.b, clash.a],
    ]) {
      const other = /** @type {any} */ (practiceById.get(otherId));
      const text = `Overlaps the ${day} ${hhmm(other.startTime)} to ${hhmm(other.endTime)} practice of ${names.teamName(other.teamId)} (${dates})`;
      clashOf.set(self, [...(clashOf.get(self) ?? []), text]);
    }
  }
  for (const practice of myPractices) {
    const team = /** @type {any} */ (myTeams.get(idOf(practice.teamId)));
    const reading = readPractice(practice);
    const row = baseRow(team, {
      [H.EVENT_TYPE]: 'Practice',
      [H.LOCATION]: locationOf(practice.fieldId, practice.fieldName),
    });
    const day = WEEKDAY_LONG[String(practice.dayOfWeek ?? '').toLowerCase()] ?? '';
    let at = 0;
    if (reading.ok === true) {
      at = reading.weekday * 100000 + reading.startSec;
      Object.assign(row, {
        Day: day,
        [H.START]: hhmm(practice.startTime),
        [H.END]: hhmm(practice.endTime),
        [H.TIME_ZONE]: timeZone,
        [H.STATUS]: TEAM_SCHEDULE_STATUS.SCHEDULED,
        Dates: describeRange(practice.range),
        'Coach Clash': (clashOf.get(practice.id) ?? []).join('; '),
      });
    } else {
      Object.assign(row, {
        [H.STATUS]: TEAM_SCHEDULE_STATUS.DATE_TBD,
        [H.REASON]: reading.why,
        [H.REASON_CODE]: reading.code,
      });
      // A slot that reads and a range that does not: say what the row says, so a person can find it.
      if (reading.code === PRACTICE_UNREADABLE.RANGE_UNREADABLE) {
        Object.assign(row, {
          Day: day,
          [H.START]: hhmm(practice.startTime),
          [H.END]: hhmm(practice.endTime),
          [H.TIME_ZONE]: timeZone,
          Dates: String(practice.range ?? ''),
        });
      }
    }
    entries.push({ team: team.name, order: 3, at, row });
  }

  entries.sort(
    (a, b) =>
      a.team.localeCompare(b.team) ||
      a.order - b.order ||
      a.at - b.at ||
      a.row[H.OPPONENT].localeCompare(b.row[H.OPPONENT])
  );

  const notes = [];
  if (coach.teams.length === 0) {
    notes.push(`${coach.name} has no current team, so there is nothing to list.`);
  }
  notes.push(NOT_COMPARED);
  if (datedGames > 0) {
    notes.push(
      'Game clashes are the schedule check’s coach conflicts: the first overlap it finds for this coach in each week is marked.'
    );
  }
  if (untimedGames > 0) {
    notes.push(
      `${untimedGames} saved ${untimedGames === 1 ? 'game has' : 'games have'} no start and end time that can be read, so ${untimedGames === 1 ? 'it is' : 'they are'} listed as "Date and time TBD" and not checked for clashes.`
    );
  }
  if (unjudged.length > 0) {
    notes.push(
      `${unjudged.length} ${unjudged.length === 1 ? 'practice' : 'practices'} could not be read (its slot, day, time or date range), so clashes involving ${unjudged.length === 1 ? 'it were' : 'them were'} not checked.`
    );
  }

  return {
    coach: { id: coach.id, name: coach.name },
    teams: coach.teams,
    multiTeam: coach.multiTeam,
    rows: entries.map((entry) => entry.row),
    counts: { games: datedGames, tbdGames: tbdCount, untimedGames, practices: myPractices.length },
    gameClashes,
    practiceClashes,
    unjudgedPractices: unjudged,
    notes,
  };
}

/** `HH:MM` of a `HH:MM[:SS]` time. @param {unknown} time */
const hhmm = (time) => String(time ?? '').slice(0, 5);

/**
 * Mark the games of a coach who is in two places at once, from `evaluateGameSchedule`'s per-coach `coach-conflict`.
 *
 * The evaluator stops at the first overlap it finds for a coach, so it is called for each week's games on their own:
 * a second clash in another week is found, though a third in one week is still behind the first (the evaluator's
 * counts are lower bounds, and the page says "the first overlap in each week"). The teams passed are the whole
 * registry with their coaches as of the date, so the check is the league's and not a copy of it.
 *
 * @returns {Array<{ weekIndex: number, games: Array<{ teamId: string, slotId: string }> }>}
 */
function markGameClashes({ coach, entries, teams, assignments, asOf, names }) {
  const evalTeams = teams.map((team) => {
    const lead = [];
    const assistant = [];
    for (const row of assignments) {
      if (idOf(row.team_id) !== idOf(team.id)) continue;
      if (!windowCoversDate(asOf, dateOnly(row.effective_from), dateOnly(row.effective_to)))
        continue;
      (row.role === 'lead' ? lead : assistant).push(idOf(row.coach_id));
    }
    const [first = null, ...more] = lead;
    return {
      id: team.id,
      division: team.division || 'unknown',
      coachId: first,
      assistantCoachIds: [...more, ...assistant],
    };
  });
  const slotOf = (game) => idOf(game.slotId ?? game.gameSlotId);

  /** @type {Map<number, Map<string, Record<string, any>>>} */
  const weeks = new Map();
  for (const entry of entries) {
    const game = entry.game;
    const week = positiveWeek(game?.weekIndex);
    if (!game || week === null || !slotOf(game)) continue;
    const bucket = weeks.get(week) ?? new Map();
    bucket.set(`${idOf(game.id)}|${slotOf(game)}|${idOf(game.homeTeamId)}`, game);
    weeks.set(week, bucket);
  }

  const clashes = [];
  for (const [weekIndex, bucket] of [...weeks.entries()].sort((a, b) => a[0] - b[0])) {
    const assignmentsOfWeek = [...bucket.values()].map((game) => ({
      id: game.id,
      weekIndex,
      division: game.division || names.team(game.homeTeamId)?.division || 'unknown',
      slotId: slotOf(game),
      homeTeamId: idOf(game.homeTeamId),
      awayTeamId: idOf(game.awayTeamId),
      start: game.start,
      end: game.end,
    }));
    const { warnings } = evaluateGameSchedule({ assignments: assignmentsOfWeek, teams: evalTeams });
    for (const warning of warnings) {
      if (warning.type !== 'coach-conflict' || warning.details.coachId !== coach.id) continue;
      const pair = warning.details.conflicts.map((c) => ({
        teamId: idOf(c.teamId),
        slotId: idOf(c.slotId),
      }));
      clashes.push({ weekIndex, games: pair });
      for (const [i, self] of pair.entries()) {
        const other = pair[1 - i];
        const find = (side) =>
          entries.find(
            (entry) =>
              entry.game && entry.teamId === side.teamId && slotOf(entry.game) === side.slotId
          );
        const selfEntry = find(self);
        const otherEntry = find(other);
        if (!selfEntry || !otherEntry) continue;
        const { game } = otherEntry;
        const text = `Overlaps ${names.teamName(game?.homeTeamId)} v ${names.teamName(game?.awayTeamId)}, ${otherEntry.row[H.START]} to ${otherEntry.row[H.END]}`;
        selfEntry.row['Coach Clash'] = selfEntry.row['Coach Clash']
          ? `${selfEntry.row['Coach Clash']}; ${text}`
          : text;
      }
    }
  }
  return clashes;
}

/** A practice series' dates in words: `2026-09-08 to 2026-11-19`, `from 2026-11-03`, or nothing for no range. */
function describeRange(range) {
  if (range === null || range === undefined || String(range).trim() === '') return '';
  const bounds = practiceRangeBounds(range);
  if (bounds !== null) return `${bounds.first} to ${bounds.last}`;
  const lower = practiceRangeLowerBound(range);
  return lower !== null && lower.upperUnbounded ? `from ${lower.first}` : String(range);
}

/**
 * The schedule as CSV, through the export's one cell writer (formula neutralised, RFC 4180 quoting).
 *
 * @param {{ rows: Array<Record<string, string>> }} schedule
 */
export function coachScheduleCsv(schedule) {
  return formatCsv([...COACH_SCHEDULE_COLUMNS], schedule.rows);
}
