/**
 * The SquadLogic schedule CSV: the saved game schedule in the format the games import reads (plan
 * `docs/changes/2026-11-03-schedule-expansion.md` 4.3 and 5.4; PR 6, task G3). A file exported here imports here: the
 * round trip is the import's idempotency test (`tests/gameImportRoundTrip.test.jsx`: the export of an imported
 * schedule, imported again as a dry run, changes nothing).
 *
 * - **The times are the GAME's own** (`game_assignments.start` and `"end"`), read on the season's clock, never the
 *   host's. A game keeps its own end: an import finds a slot by its field, date and start and reuses it whatever the
 *   slot's end says, so a game of 08:00 to 09:30 on an 08:00 to 09:00 slot is exported as 08:00 to 09:30 (taking the
 *   slot's end would export a different game, and the file would not import back unchanged).
 * - **The Game ID is the saved one** (`external_ref`); a game with none (a generated game) has a blank Game ID and is
 *   found again by its teams, place and week.
 * - **A TIME TBD game that holds a date** is a row with its date and no time, venue or field, as the import reads one.
 * - **The night the clocks go back.** A wall time the clocks show twice names two instants, and the import reads it
 *   as the first. So an END in the repeated hour is written as a `Length` (elapsed minutes from the start, the
 *   format's alternative to `End Time`) with a blank End Time, whichever time round it is: the import adds the
 *   minutes to the start and gets the same instant back. A START the first time round is written as it is and reads
 *   back the same. A start the SECOND time round cannot be written (the file has no way to say "the second 01:15"):
 *   the game is counted in `omitted.repeatedHour` and never written as the first. The `Length` column is in the file
 *   only when a row needs it. The day the clocks go forward needs nothing: no instant reads as a time in the skipped
 *   hour, and the import refuses a file that names one (`time-in-dst-gap`), so no game is stored there.
 * - **Nothing is left out in silence.** A game whose time, field, venue or team cannot be read, and a TIME TBD game
 *   with no date (the file needs a date), are counted in `omitted` and never written half.
 *
 * Declared: a name that begins like a spreadsheet formula (`=`, `+`, `-`, `@`) is written with a leading apostrophe, as
 * every file a person opens is (`csv.js`). Imported again it is a different label, so its rows are listed as unknown and
 * nothing is created for it; no name in the program is spelled that way today.
 *
 * The header row is the import's own template (`SCHEDULE_IMPORT_TEMPLATE_HEADER`), so the two cannot drift; `Length`,
 * which the import also reads, joins it only for the case above.
 */

import { escapeCsvCell } from '../csv.js';
import { instantMs, wallOfInstant } from '../reports/wall.js';
import { resolveZonedInstant } from '../timing/seasonClock.js';
import { TIMING_REASON } from '../timing/reasonCodes.js';
import { SCHEDULE_IMPORT_COLUMNS as C, SCHEDULE_IMPORT_TEMPLATE_HEADER } from './parseRows.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_MINUTE = 60000;
/** The longest `Length` the import reads (`parseScheduleLength`). */
const MAX_LENGTH_MINUTES = 1439;

/**
 * How the import would read a wall time of the season's clock back: whether the clocks show it twice that day, and
 * whether the instant it takes (the first) is the minute this one is.
 *
 * @param {{ date: string, time: string }} wall
 * @param {number} epochMs  the instant the wall time was read from
 * @param {string} timeZone
 */
function readBack(wall, epochMs, timeZone) {
  const read = resolveZonedInstant({ date: wall.date, time: wall.time, timeZone });
  return {
    repeated: read.findings.some((f) => f.code === TIMING_REASON.WALL_TIME_AMBIGUOUS),
    same:
      read.iso !== null &&
      Math.floor(Date.parse(read.iso) / MS_PER_MINUTE) === Math.floor(epochMs / MS_PER_MINUTE),
  };
}

/**
 * @param {Object} input
 * @param {Array<{ id: string, externalRef?: string | null, gameSlotId?: string | null, fieldId?: string | null,
 *   homeTeamId: string, awayTeamId: string, division?: string | null, weekIndex?: number | null,
 *   start?: string | null, end?: string | null }>} input.games
 *   the saved games of the season's current run, each with its own start and end instants
 * @param {Array<{ id: string, fieldId?: string | null, weekIndex?: number | null }>} input.slots
 *   for a game's field and week when the game row does not carry them
 * @param {string} input.timeZone  the season's IANA zone (`season_settings.timezone`)
 * @param {Array<{ id: string, name: string, division?: string | null }>} input.teams  own teams and outside clubs
 * @param {Array<{ id: string, name: string, venueId?: string | null }>} input.fields
 * @param {Array<{ id: string, name: string }>} input.venues
 * @param {Array<{ externalRef?: string | null, gameDate?: string | null, weekIndex: number, homeTeamId: string,
 *   awayTeamId: string, division?: string | null }>} [input.tbdGames]
 * @returns {{ headers: string[], rows: Array<Record<string, string>>, csv: string,
 *   omitted: { noPlace: number, unknownRecord: number, undatedTbd: number, repeatedHour: number } }}
 *   `headers` is the template's row, with `Length` after `End Time` when a row is written with one
 */
export function buildScheduleCsv({ games, slots, teams, fields, venues, tbdGames = [], timeZone }) {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') {
    throw new TypeError(
      'buildScheduleCsv: the season’s time zone is required to read a game’s times'
    );
  }
  for (const [name, value] of Object.entries({ games, slots, teams, fields, venues, tbdGames })) {
    if (!Array.isArray(value)) throw new TypeError(`buildScheduleCsv: ${name} must be an array`);
  }
  const slotById = new Map(slots.map((s) => [String(s.id), s]));
  const teamById = new Map(teams.map((t) => [String(t.id), t]));
  const fieldById = new Map(fields.map((f) => [String(f.id), f]));
  const venueById = new Map(venues.map((v) => [String(v.id), v]));
  const omitted = { noPlace: 0, unknownRecord: 0, undatedTbd: 0, repeatedHour: 0 };
  /** @type {Array<{ sort: string, row: Record<string, string> }>} */
  const out = [];

  for (const game of games) {
    const slot = slotById.get(String(game.gameSlotId ?? ''));
    const startAt = wallOfInstant(game.start, timeZone);
    const endAt = wallOfInstant(game.end, timeZone);
    // A game that crosses midnight on the season's clock is not one the file can hold (one Date, an end after its start).
    if (
      startAt === null ||
      endAt === null ||
      endAt.date !== startAt.date ||
      endAt.time <= startAt.time
    ) {
      omitted.noPlace += 1;
      continue;
    }
    const startMs = /** @type {number} */ (instantMs(game.start));
    const endMs = /** @type {number} */ (instantMs(game.end));
    const startRead = readBack(startAt, startMs, timeZone);
    if (startRead.repeated && !startRead.same) {
      // The second time the clocks show this start: the file can only say the wall time, which reads back as the first.
      omitted.repeatedHour += 1;
      continue;
    }
    const start = startAt.time;
    let end = endAt.time;
    /** @type {string | null} */
    let length = null;
    if (readBack(endAt, endMs, timeZone).repeated) {
      // An end the clocks show twice is said as elapsed minutes, which the import adds to the start.
      const minutes = (endMs - startMs) / MS_PER_MINUTE;
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_LENGTH_MINUTES) {
        omitted.noPlace += 1;
        continue;
      }
      end = '';
      length = String(minutes);
    }
    const field = fieldById.get(String(game.fieldId ?? slot?.fieldId ?? ''));
    const venue = field ? venueById.get(String(field.venueId ?? '')) : undefined;
    const home = teamById.get(String(game.homeTeamId));
    const away = teamById.get(String(game.awayTeamId));
    const division = String(game.division ?? home?.division ?? '');
    const week = game.weekIndex ?? slot?.weekIndex;
    if (!field || !venue || !home || !away || division === '' || !Number.isInteger(week)) {
      omitted.unknownRecord += 1;
      continue;
    }
    out.push({
      sort: JSON.stringify([
        startAt.date,
        start,
        venue.name,
        field.name,
        home.name,
        String(game.id),
      ]),
      row: {
        [C.GAME_ID]: String(game.externalRef ?? ''),
        [C.DATE]: startAt.date,
        [C.START]: start,
        [C.END]: end,
        ...(length === null ? {} : { [C.LENGTH]: length }),
        [C.VENUE]: venue.name,
        [C.FIELD]: field.name,
        [C.DIVISION]: division,
        [C.HOME]: home.name,
        [C.AWAY]: away.name,
        [C.WEEK]: String(week),
      },
    });
  }

  for (const game of tbdGames) {
    if (!DATE.test(String(game.gameDate ?? ''))) {
      omitted.undatedTbd += 1;
      continue;
    }
    const home = teamById.get(String(game.homeTeamId));
    const away = teamById.get(String(game.awayTeamId));
    const division = String(game.division ?? home?.division ?? '');
    if (!home || !away || division === '' || !Number.isInteger(game.weekIndex)) {
      omitted.unknownRecord += 1;
      continue;
    }
    out.push({
      // after the placed games of its date
      sort: JSON.stringify([game.gameDate, '~', '', '', home.name, String(game.externalRef ?? '')]),
      row: {
        [C.GAME_ID]: String(game.externalRef ?? ''),
        [C.DATE]: String(game.gameDate),
        [C.START]: '',
        [C.END]: '',
        [C.VENUE]: '',
        [C.FIELD]: '',
        [C.DIVISION]: division,
        [C.HOME]: home.name,
        [C.AWAY]: away.name,
        [C.WEEK]: String(game.weekIndex),
      },
    });
  }

  out.sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
  const rows = out.map((entry) => entry.row);
  // The template's row; `Length` joins it, beside `End Time`, only when a row is written with one.
  const headers = SCHEDULE_IMPORT_TEMPLATE_HEADER.flatMap((h) =>
    h === C.END && rows.some((row) => C.LENGTH in row) ? [h, C.LENGTH] : [h]
  );
  const csv = [headers, ...rows.map((row) => headers.map((h) => row[h] ?? ''))]
    .map((line) => line.map(escapeCsvCell).join(','))
    .join('\n');
  return { headers, rows, csv, omitted };
}
