/**
 * The columns of a schedule file, by the name the template uses (plan
 * `docs/changes/2026-11-03-schedule-expansion.md` 4.3), and the template's header row.
 *
 * Constants only, and no import: the Import page's template download needs the header row, and must not pull the
 * parser, the season clock and the mapping in with it (they load with the schedule import's own panel).
 * `parseRows.js` re-exports both, so every reader of the columns still has one list.
 */

/** The columns of plan 4.3, by the name the template uses. */
export const SCHEDULE_IMPORT_COLUMNS = Object.freeze({
  GAME_ID: 'Game ID',
  DATE: 'Date',
  START: 'Start Time',
  END: 'End Time',
  LENGTH: 'Length',
  VENUE: 'Venue',
  FIELD: 'Field',
  DIVISION: 'Division',
  HOME: 'Home Team',
  AWAY: 'Away Team',
  WEEK: 'Week',
});
const C = SCHEDULE_IMPORT_COLUMNS;

/** The header row of the downloadable template: `Length` is the alternative to `End Time`. */
export const SCHEDULE_IMPORT_TEMPLATE_HEADER = Object.freeze([
  C.GAME_ID,
  C.DATE,
  C.START,
  C.END,
  C.VENUE,
  C.FIELD,
  C.DIVISION,
  C.HOME,
  C.AWAY,
  C.WEEK,
]);
