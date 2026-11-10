/**
 * The SquadLogic schedule CSV: the saved game schedule in the format the games import reads (plan
 * `docs/changes/2026-11-03-schedule-expansion.md` 4.3 and 5.4; PR 6, task G3). A file exported here imports here: the
 * round trip is the import's idempotency test (`tests/gameImportRoundTrip.test.jsx`: the export of an imported
 * schedule, imported again as a dry run, changes nothing).
 *
 * - **The times are the slot's wall readings** (`game_slots.slot_date`, `start_time`, `end_time`), which are the
 *   season's clock as the import and the field setup wrote them. No instant is converted here, so no zone is read.
 * - **The Game ID is the saved one** (`external_ref`); a game with none (a generated game) has a blank Game ID and is
 *   found again by its teams, place and week.
 * - **A TIME TBD game that holds a date** is a row with its date and no time, venue or field, as the import reads one.
 * - **Nothing is left out in silence.** A game whose slot, field, venue or team cannot be named, and a TIME TBD game
 *   with no date (the file needs a date), are counted in `omitted` and never written half.
 *
 * Declared: a name that begins like a spreadsheet formula (`=`, `+`, `-`, `@`) is written with a leading apostrophe, as
 * every file a person opens is (`csv.js`). Imported again it is a different label, so its rows are listed as unknown and
 * nothing is created for it; no name in the program is spelled that way today.
 *
 * The header row is the import's own template (`SCHEDULE_IMPORT_TEMPLATE_HEADER`), so the two cannot drift.
 */

import { escapeCsvCell } from '../csv.js';
import { SCHEDULE_IMPORT_COLUMNS as C, SCHEDULE_IMPORT_TEMPLATE_HEADER } from './parseRows.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** `HH:mm` from `HH:mm` or `HH:mm:ss`, or null. @param {unknown} value */
const clock = (value) => {
  const match =
    typeof value === 'string' ? /^(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value) : null;
  return match ? `${match[1]}:${match[2]}` : null;
};

/**
 * @param {Object} input
 * @param {Array<{ id: string, externalRef?: string | null, gameSlotId?: string | null, fieldId?: string | null,
 *   homeTeamId: string, awayTeamId: string, division?: string | null, weekIndex?: number | null }>} input.games
 *   the saved games of the season's current run
 * @param {Array<{ id: string, date?: string | null, startTime?: string | null, endTime?: string | null,
 *   fieldId?: string | null, weekIndex?: number | null }>} input.slots
 * @param {Array<{ id: string, name: string, division?: string | null }>} input.teams  own teams and outside clubs
 * @param {Array<{ id: string, name: string, venueId?: string | null }>} input.fields
 * @param {Array<{ id: string, name: string }>} input.venues
 * @param {Array<{ externalRef?: string | null, gameDate?: string | null, weekIndex: number, homeTeamId: string,
 *   awayTeamId: string, division?: string | null }>} [input.tbdGames]
 * @returns {{ headers: string[], rows: Array<Record<string, string>>, csv: string,
 *   omitted: { noPlace: number, unknownRecord: number, undatedTbd: number } }}
 */
export function buildScheduleCsv({ games, slots, teams, fields, venues, tbdGames = [] }) {
  for (const [name, value] of Object.entries({ games, slots, teams, fields, venues, tbdGames })) {
    if (!Array.isArray(value)) throw new TypeError(`buildScheduleCsv: ${name} must be an array`);
  }
  const slotById = new Map(slots.map((s) => [String(s.id), s]));
  const teamById = new Map(teams.map((t) => [String(t.id), t]));
  const fieldById = new Map(fields.map((f) => [String(f.id), f]));
  const venueById = new Map(venues.map((v) => [String(v.id), v]));
  const omitted = { noPlace: 0, unknownRecord: 0, undatedTbd: 0 };
  /** @type {Array<{ sort: string, row: Record<string, string> }>} */
  const out = [];

  for (const game of games) {
    const slot = slotById.get(String(game.gameSlotId ?? ''));
    const start = clock(slot?.startTime);
    const end = clock(slot?.endTime);
    if (!slot || !DATE.test(String(slot.date ?? '')) || start === null || end === null) {
      omitted.noPlace += 1;
      continue;
    }
    const field = fieldById.get(String(game.fieldId ?? slot.fieldId ?? ''));
    const venue = field ? venueById.get(String(field.venueId ?? '')) : undefined;
    const home = teamById.get(String(game.homeTeamId));
    const away = teamById.get(String(game.awayTeamId));
    const division = String(game.division ?? home?.division ?? '');
    const week = game.weekIndex ?? slot.weekIndex;
    if (!field || !venue || !home || !away || division === '' || !Number.isInteger(week)) {
      omitted.unknownRecord += 1;
      continue;
    }
    out.push({
      sort: JSON.stringify([slot.date, start, venue.name, field.name, home.name, String(game.id)]),
      row: {
        [C.GAME_ID]: String(game.externalRef ?? ''),
        [C.DATE]: String(slot.date),
        [C.START]: start,
        [C.END]: end,
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
  const headers = [...SCHEDULE_IMPORT_TEMPLATE_HEADER];
  const rows = out.map((entry) => entry.row);
  const csv = [headers, ...rows.map((row) => headers.map((h) => row[h] ?? ''))]
    .map((line) => line.map(escapeCsvCell).join(','))
    .join('\n');
  return { headers, rows, csv, omitted };
}
