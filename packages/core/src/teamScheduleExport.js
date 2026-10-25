import { formatCsv } from './outputGeneration.js';
import { PRACTICE_TIME_TBD_CAUSES, TIMING_REASON } from './timing/index.js';

/**
 * A team's schedule as rows for a file a person downloads: the CSV and XLSX
 * exports of a team page and of the coach home (plan
 * docs/changes/2026-10-22-admin-focus.md, R7).
 *
 * ## One row per event the schedule shows, and nothing dropped
 *
 * The input is exactly what the team page and the coach home render: the
 * events `fetchTeamEvents` (`frontend/src/hooks/useTeamPortal.js`) returns
 * for one team, already expanded with its saved practice exceptions and
 * placed on the team's season clock. {@link teamScheduleRows} maps each event
 * to one row, in the order given. A TIME TBD practice, a game whose slot has
 * no time and a game with no slot at all each keep their row, with a
 * `Status` and the reason (AGENTS.md section 3, "never silently drop an
 * unplaceable fixture"); a cell that is not known is blank, never a guess.
 *
 * ## No contact column
 *
 * {@link TEAM_SCHEDULE_COLUMNS} is the whole shape, for a coach and for an
 * admin alike: team, division, the event, when, where, and why it has no
 * time. No coach, email or phone column exists to leave out (owner decision,
 * 2026-10-22: coaches see no contact details). The admin's all-teams export
 * with its `Coach Emails` column is `outputGeneration.js`, and stays on the
 * admin's Exports page.
 *
 * ## Times
 *
 * `Date`, `Start` and `End` are the season-local wall reading the team page
 * shows (`HH:MM`), with the season's IANA zone beside them in `Time Zone`
 * (blank when the season has none). The instant itself is what the calendar
 * download carries, in UTC, through the feed's own renderer.
 *
 * @module teamScheduleExport
 */

/** The export's columns. */
export const TEAM_SCHEDULE_HEADERS = Object.freeze({
  TEAM: 'Team',
  DIVISION: 'Division',
  EVENT_TYPE: 'Event Type',
  OPPONENT: 'Opponent',
  HOME_AWAY: 'Home/Away',
  DATE: 'Date',
  START: 'Start',
  END: 'End',
  TIME_ZONE: 'Time Zone',
  LOCATION: 'Location',
  STATUS: 'Status',
  REASON: 'Reason',
  REASON_CODE: 'Reason Code',
});

/** The columns, in file order. */
export const TEAM_SCHEDULE_COLUMNS = Object.freeze(Object.values(TEAM_SCHEDULE_HEADERS));

/** The `Status` cell. */
export const TEAM_SCHEDULE_STATUS = Object.freeze({
  SCHEDULED: 'Scheduled',
  /** A practice a saved exception moved to another slot. */
  MOVED: 'Moved',
  /** A known day with no confirmed time. */
  TIME_TBD: 'TIME TBD',
  /** Neither a day nor a time: a game with no slot, or a practice with no readable dates. */
  DATE_TBD: 'Date and time TBD',
});

/**
 * Why an event has no time, in the calendar feed's codes and words
 * (`supabase/functions/_shared/calendar/icsFeed.ts`, `UNPLACEABLE_CAUSES`), so
 * a row and the same event's calendar entry give one reason:
 *
 * - a game with no slot is the feed's `GAME_SLOT_MISSING` (its sentence is
 *   this module's own, which `tests/teamScheduleExport.test.js` pins equal to
 *   the feed's);
 * - a slot with no wall date or time is what the feed reports when it reads
 *   one, `WALL_TIME_UNREADABLE`, worded by the season clock's own table
 *   (`timing/practiceTime.js`, pinned to the feed by
 *   `tests/teamPortalPracticeDst.test.js`).
 *
 * A TIME TBD practice keeps the code and sentence `expandPractices` gave it.
 */
export const GAME_SLOT_MISSING = 'GAME_SLOT_MISSING';
export const TEAM_SCHEDULE_CAUSES = Object.freeze({
  [GAME_SLOT_MISSING]: 'the game has no scheduled slot yet',
  [TIMING_REASON.WALL_TIME_UNREADABLE]:
    PRACTICE_TIME_TBD_CAUSES[TIMING_REASON.WALL_TIME_UNREADABLE],
});

const WEEKDAY_NAMES = Object.freeze({
  sun: 'Sunday',
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
});

/** A wall time as `HH:MM`, or blank. Never a parsed `Date`: the reading is the season's. */
const wallTime = (value) => {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value ?? '').trim());
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : '';
};

/** Blank for anything absent. Blank is not zero, and `undefined` is not a cell. */
const text = (value) => (value === null || value === undefined ? '' : String(value));

/** "Moved from Monday 17:00, Venue - Field", the team page's line. */
function movedFromText(movedFrom) {
  const weekday = WEEKDAY_NAMES[String(movedFrom?.dayOfWeek ?? '').toLowerCase()] ?? 'another day';
  const time = wallTime(movedFrom?.startTime) || 'an unknown time';
  return `Moved from ${weekday} ${time}, ${movedFrom?.location ?? 'Venue - Field'}`;
}

/**
 * When an event is, and if not, why not.
 *
 * @param {Record<string, any>} event
 * @returns {{ status: string, date: string, start: string, end: string, reason: string, code: string }}
 */
function whenOf(event) {
  const date = text(event.date);
  const moved = event.kind === 'relocated';
  if (event.timeTbd) {
    // A moved practice that cannot be placed (its new time falls in a clock
    // gap) still says which practice it replaces, as the team page does.
    return {
      status: date ? TEAM_SCHEDULE_STATUS.TIME_TBD : TEAM_SCHEDULE_STATUS.DATE_TBD,
      date,
      start: '',
      end: '',
      reason: [
        text(event.reason) || 'no confirmed time',
        moved ? movedFromText(event.movedFrom) : null,
      ]
        .filter(Boolean)
        .join('; '),
      code: text(event.reasonCode),
    };
  }
  if (!date) {
    // A game with no slot, or a slot with no wall date: the page shows "Date
    // and time not set yet". A practice always has a date or `timeTbd`
    // (`expandPractices`).
    const code =
      event.type === 'game' && !event.hasSlot
        ? GAME_SLOT_MISSING
        : TIMING_REASON.WALL_TIME_UNREADABLE;
    return {
      status: TEAM_SCHEDULE_STATUS.DATE_TBD,
      date: '',
      start: '',
      end: '',
      reason: TEAM_SCHEDULE_CAUSES[code],
      code,
    };
  }
  const start = wallTime(event.startTime);
  if (!start) {
    // A slot with a day and no time: a day is known, the time is not.
    return {
      status: TEAM_SCHEDULE_STATUS.TIME_TBD,
      date,
      start: '',
      end: '',
      reason: TEAM_SCHEDULE_CAUSES[TIMING_REASON.WALL_TIME_UNREADABLE],
      code: TIMING_REASON.WALL_TIME_UNREADABLE,
    };
  }
  const notes = Array.isArray(event.timingNotes) ? event.timingNotes : [];
  return {
    status: moved ? TEAM_SCHEDULE_STATUS.MOVED : TEAM_SCHEDULE_STATUS.SCHEDULED,
    date,
    start,
    // A slot with no end is the start, as the feed reads it (a zero-length event).
    end: wallTime(event.endTime) || start,
    reason: [moved ? movedFromText(event.movedFrom) : null, ...notes].filter(Boolean).join('; '),
    code: '',
  };
}

/**
 * One row per event, team by team, in the order given.
 *
 * @param {Array<{ team: { id: string, name?: string | null, division?: { name?: string | null } | null },
 *   timeZone?: string | null, events: Array<Record<string, any>> }>} schedules
 * @returns {Array<Record<string, string>>}
 */
export function teamScheduleRows(schedules) {
  if (!Array.isArray(schedules)) throw new TypeError('schedules must be an array');
  const H = TEAM_SCHEDULE_HEADERS;
  const rows = [];
  for (const schedule of schedules) {
    if (!schedule?.team?.id) throw new TypeError('each schedule needs its team');
    if (!Array.isArray(schedule.events)) throw new TypeError('each schedule needs its events');
    const team = schedule.team;
    for (const event of schedule.events) {
      const isGame = event?.type === 'game';
      const when = whenOf(event ?? {});
      rows.push({
        [H.TEAM]: text(team.name ?? team.id),
        [H.DIVISION]: text(team.division?.name),
        [H.EVENT_TYPE]: isGame ? 'Game' : 'Practice',
        [H.OPPONENT]: isGame ? text(event.opponent) : '',
        [H.HOME_AWAY]: isGame ? text(event.role) : '',
        [H.DATE]: when.date,
        [H.START]: when.start,
        [H.END]: when.end,
        [H.TIME_ZONE]: when.start ? text(schedule.timeZone) : '',
        [H.LOCATION]: text(event.location),
        [H.STATUS]: when.status,
        [H.REASON]: when.reason,
        [H.REASON_CODE]: when.code,
      });
    }
  }
  return rows;
}

/**
 * The rows as CSV, through the export's one cell writer (formula
 * neutralised, RFC 4180 quoting).
 *
 * @param {Array<Record<string, string>>} rows
 */
export function teamScheduleCsv(rows) {
  return formatCsv([...TEAM_SCHEDULE_COLUMNS], rows);
}
