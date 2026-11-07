/**
 * The Day Sheet (task G1 of PR 7 of the schedule expansion; plan 5.1): one date, an optional venue, one row per saved
 * game, the TIME TBD games listed apart, and a CSV. A read-only view over `game_assignments`, the master export's own
 * source; admin only.
 *
 * - **The date is the season's calendar date** (`wallOfInstant`), so a 22:00 game is on the day it is played.
 * - **A venue is chosen by its id.** Two venues can share a display name, and a name is not a key.
 * - **Nothing is dropped without a word.** A game with no readable time is listed apart with its teams (it is on no
 *   date); a field or team the registry lacks is shown as unknown and, under a venue filter, counted as left out.
 * - **The TIME TBD games have no date and no venue**, so they are listed whatever the filter, in the master export's
 *   words (`scheduleTbdNote`'s reasons).
 * - **No coach, email or phone**: the columns are the sheet's own and the builder reads no coach field.
 *
 * The master export writes a game as two rows, one for each team; the Day Sheet writes it once.
 *
 * @module reports/daySheet
 */

import { formatCsv } from '../outputGeneration.js';
import { PUBLICATION_TBD } from '../reserve/reasonCodes.js';
import { describeScheduleTbdReason } from '../scheduleTbd.js';
import { instantMs, wallOfInstant, weekdayOfDate } from './wall.js';

/** The sheet's columns, in file order. */
export const DAY_SHEET_COLUMNS = Object.freeze([
  'Date',
  'Kickoff',
  'Ends',
  'Venue',
  'Field',
  'Division',
  'Home',
  'Away',
  'Status',
]);

const SCHEDULED = 'Scheduled';

/** @param {unknown} value */
const idOf = (value) => (value === null || value === undefined ? '' : String(value));

/**
 * Names for ids, from the registry rows read: a team, a field and its venue. An id the registry lacks reads as
 * unknown, with the id, and says so.
 *
 * @param {{ teams: any[], fields: any[], venues: any[] }} registry
 */
export function makeNamers({ teams, fields, venues }) {
  const teamById = new Map(teams.map((team) => [idOf(team.id), team]));
  const fieldById = new Map(fields.map((field) => [idOf(field.id), field]));
  const venueById = new Map(venues.map((venue) => [idOf(venue.id), venue]));
  return {
    team: (id) => teamById.get(idOf(id)) ?? null,
    teamName: (id) => teamById.get(idOf(id))?.name ?? `Unknown team (${idOf(id)})`,
    field: (id) => fieldById.get(idOf(id)) ?? null,
    venueIdOfField: (fieldId) => {
      const venueId = fieldById.get(idOf(fieldId))?.venueId;
      return venueId !== null && venueId !== undefined && venueById.has(idOf(venueId))
        ? idOf(venueId)
        : null;
    },
    venueName: (fieldId) => {
      const venueId = fieldById.get(idOf(fieldId))?.venueId;
      return venueById.get(idOf(venueId))?.name ?? 'Unknown venue';
    },
    fieldName: (fieldId) => {
      if (!idOf(fieldId)) return '';
      return fieldById.get(idOf(fieldId))?.name ?? `Unknown field (${idOf(fieldId)})`;
    },
    /** `Venue - Field`; the field alone when its venue is not known; the id when the field is not; blank for none. */
    location: (fieldId, fallbackName = null) => {
      const id = idOf(fieldId);
      if (!id) return fallbackName ?? '';
      const field = fieldById.get(id);
      if (!field) return fallbackName ?? `Unknown field (${id})`;
      const venue = venueById.get(idOf(field.venueId))?.name;
      return venue ? `${venue} - ${field.name}` : field.name;
    },
  };
}

/**
 * Build the Day Sheet.
 *
 * @param {Object} input
 * @param {Array<Record<string, any>>} input.games - the saved games (camelCase rows of the latest run)
 * @param {Array<{ id: string, name: string, division?: string | null }>} input.teams - the registry
 * @param {Array<{ id: string, name: string, venueId?: string | null }>} input.fields
 * @param {Array<{ id: string, name: string }>} input.venues
 * @param {Array<{ homeTeamId: string, awayTeamId: string, weekIndex: number, reason: string }>} [input.tbdGames]
 * @param {string} input.timeZone - the season's IANA zone
 * @param {string | null} input.date - `YYYY-MM-DD`, or none: then no game is on the date, and the TIME TBD games and the
 *   games with no readable time are still listed
 * @param {string | null} [input.venueId] - a venue's id, or none for every venue
 */
export function buildDaySheet({
  games,
  teams,
  fields,
  venues,
  tbdGames = [],
  timeZone,
  date,
  venueId = null,
}) {
  if (!timeZone) throw new TypeError('the Day Sheet needs the season’s time zone');
  if (date !== null && weekdayOfDate(date) === null) {
    throw new TypeError(`${String(date)} is not a date (YYYY-MM-DD)`);
  }
  const names = makeNamers({ teams, fields, venues });

  /** @type {Array<{ at: number, venue: string, field: string, home: string, id: string, row: Record<string, string> }>} */
  const dated = [];
  const unreadable = [];
  let onDate = 0;
  let unknownGround = 0;

  for (const game of games) {
    const start = wallOfInstant(game.start, timeZone);
    const end = wallOfInstant(game.end, timeZone);
    if (start === null || end === null) {
      unreadable.push({
        id: game.id,
        home: names.teamName(game.homeTeamId),
        away: names.teamName(game.awayTeamId),
        why: 'it has no start or end time that can be read on the season’s clock',
      });
      continue;
    }
    if (date === null || start.date !== date) continue;
    onDate += 1;
    const gameVenueId = names.venueIdOfField(game.fieldId);
    if (gameVenueId === null) unknownGround += 1;
    if (venueId !== null && gameVenueId !== venueId) continue;
    const home = names.team(game.homeTeamId);
    dated.push({
      at: /** @type {number} */ (instantMs(game.start)),
      venue: names.venueName(game.fieldId),
      field: names.fieldName(game.fieldId),
      home: names.teamName(game.homeTeamId),
      id: game.id,
      row: {
        Date: start.date,
        Kickoff: start.time,
        Ends: end.time,
        Venue: names.venueName(game.fieldId),
        Field: names.fieldName(game.fieldId),
        Division: String(game.division ?? home?.division ?? ''),
        Home: names.teamName(game.homeTeamId),
        Away: names.teamName(game.awayTeamId),
        Status: SCHEDULED,
      },
    });
  }
  dated.sort(
    (a, b) =>
      a.at - b.at ||
      a.venue.localeCompare(b.venue) ||
      a.field.localeCompare(b.field) ||
      a.home.localeCompare(b.home)
  );

  const tbd = tbdGames.map((game) => ({
    Date: '',
    Kickoff: PUBLICATION_TBD.TIME,
    Ends: '',
    Venue: PUBLICATION_TBD.LOCATION,
    Field: '',
    Division: String(names.team(game.homeTeamId)?.division ?? ''),
    Home: names.teamName(game.homeTeamId),
    Away: names.teamName(game.awayTeamId),
    Status: `${PUBLICATION_TBD.TIME} (week ${game.weekIndex}): ${describeScheduleTbdReason('game', game.reason)}`,
  }));

  return {
    columns: [...DAY_SHEET_COLUMNS],
    rows: dated.map((entry) => entry.row),
    gameIds: dated.map((entry) => entry.id),
    tbd,
    unreadable,
    counts: {
      saved: games.length,
      onDate,
      shown: dated.length,
      tbd: tbd.length,
      unreadable: unreadable.length,
      unknownGround,
    },
  };
}

/**
 * The sheet as CSV, through the export's one cell writer (formula neutralised, RFC 4180 quoting): the games of the
 * date, then the TIME TBD games.
 *
 * @param {{ rows: Array<Record<string, string>>, tbd: Array<Record<string, string>> }} sheet
 */
export function daySheetCsv(sheet) {
  return formatCsv([...DAY_SHEET_COLUMNS], [...sheet.rows, ...sheet.tbd]);
}
