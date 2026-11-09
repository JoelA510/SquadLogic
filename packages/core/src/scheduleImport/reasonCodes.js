/**
 * The closed lists of the schedule import (plan `docs/changes/2026-11-03-schedule-expansion.md`,
 * sections 4.3, 4.4 and 4.8): what refuses a file, what lists a row without writing it, what is
 * accepted and flagged, and the one reason a TIME TBD game carries.
 *
 * `code` is the contract and the sentence is decoration: the Edge function (PR 6), the SQL (PR 5) and
 * the preview all branch on the code, so a code is added here and in each of them together (lesson 73:
 * a new member of a pipeline is a member of every list the pipeline keeps).
 *
 * ## What the plan lists, and what this build added
 *
 * Plan 4.4 names thirteen row reasons and two file reasons; 4.8 names `missing-week`. Building the
 * parse needed four more, each for an input the plan's lists have no word for. They are here, so
 * they are reviewed, rather than reported as a reason that does not exist:
 *
 * - `bad-week`: a `Week` cell that is not a positive whole number. Reading it as "blank, so derive
 *   it" would let a typo pick a week for the admin, which is the guess decision 17 refuses.
 * - `bad-game-id`: a `Game ID` longer than the 40 characters 4.3 allows. Cutting it would change
 *   the key a later import matches on.
 * - `duplicate-column`: two columns of one name. Reading either would be a guess.
 * - `no-season-clock`: the file cannot be placed on a clock (4.8: "with none, the import refuses with
 *   the Games page's existing 'no clock' explanation"). It is a file reason because it applies to
 *   every row.
 *
 * `missing-week` is on both lists on purpose: a file with no `Week` column and a season with no start
 * date has nothing to derive any week from (a file reason); a file that has the column but a blank
 * cell for a row has the same problem for that row.
 */

/** Every code of the import, by name. */
export const SCHEDULE_IMPORT_REASON = Object.freeze({
  // The file is refused; nothing is staged.
  MISSING_COLUMN: 'missing-column',
  DUPLICATE_COLUMN: 'duplicate-column',
  TOO_MANY_ROWS: 'too-many-rows',
  NO_SEASON_CLOCK: 'no-season-clock',
  MISSING_WEEK: 'missing-week',

  // A row is listed with its reason and not written; the rest of the file imports.
  BAD_GAME_ID: 'bad-game-id',
  BAD_DATE: 'bad-date',
  BAD_TIME: 'bad-time',
  END_NOT_AFTER_START: 'end-not-after-start',
  SAME_TEAM: 'same-team',
  BAD_WEEK: 'bad-week',
  OUTSIDE_SEASON_WINDOW: 'outside-season-window',
  TIME_IN_DST_GAP: 'time-in-dst-gap',
  UNKNOWN_DIVISION: 'unknown-division',
  UNKNOWN_TEAM: 'unknown-team',
  UNKNOWN_VENUE: 'unknown-venue',
  UNKNOWN_FIELD: 'unknown-field',
  LABEL_IS_OWN_TEAM: 'label-is-own-team',
  DUPLICATE_ROW: 'duplicate-row',
  GAME_ID_REUSED: 'game-id-reused',

  // Accepted and flagged: stored, and shown in the preview and the Games page's banner.
  FIELD_OVERLAP: 'field-overlap',
  COACH_CONFLICT: 'coach-conflict',
  TEAM_DOUBLE_BOOKED: 'team-double-booked',
  HOME_AWAY_IMBALANCE: 'home-away-imbalance',
  TIME_AMBIGUOUS: 'time-ambiguous',
  WEEK_DIFFERS: 'week-differs',

  // A game with no time or no field becomes a TIME TBD game with this reason.
  IMPORTED_WITHOUT_TIME: 'imported-without-time',
});

const R = SCHEDULE_IMPORT_REASON;

/** Reasons that refuse the whole file. */
export const SCHEDULE_IMPORT_FILE_REFUSALS = Object.freeze([
  R.MISSING_COLUMN,
  R.DUPLICATE_COLUMN,
  R.TOO_MANY_ROWS,
  R.NO_SEASON_CLOCK,
  R.MISSING_WEEK,
]);

/** Reasons a single row is listed and not written. */
export const SCHEDULE_IMPORT_ROW_REFUSALS = Object.freeze([
  R.BAD_GAME_ID,
  R.BAD_DATE,
  R.BAD_TIME,
  R.END_NOT_AFTER_START,
  R.SAME_TEAM,
  R.BAD_WEEK,
  R.MISSING_WEEK,
  R.OUTSIDE_SEASON_WINDOW,
  R.TIME_IN_DST_GAP,
  R.UNKNOWN_DIVISION,
  R.UNKNOWN_TEAM,
  R.UNKNOWN_VENUE,
  R.UNKNOWN_FIELD,
  R.LABEL_IS_OWN_TEAM,
  R.DUPLICATE_ROW,
  R.GAME_ID_REUSED,
]);

/** Reasons a row is accepted and flagged (four are `evaluateGameSchedule`'s own warning types). */
export const SCHEDULE_IMPORT_FLAGS = Object.freeze([
  R.FIELD_OVERLAP,
  R.COACH_CONFLICT,
  R.TEAM_DOUBLE_BOOKED,
  R.HOME_AWAY_IMBALANCE,
  R.TIME_AMBIGUOUS,
  R.WEEK_DIFFERS,
]);

/**
 * Why a game the file names is NOT written by the apply (PR 5): a closed list that can grow by one (F11-2 adds
 * `skipped-scored`, when a score holds a game as Published does). The SQL emits these literals
 * (`apply_game_import_job`, `skipped` of its result and `skipped_games` of its list); `tests/gameImportSkipReasons.test.js`
 * holds this list to the SQL text and requires words for each, so a reason added in one place and not the other fails.
 */
export const SCHEDULE_IMPORT_SKIP_REASONS = Object.freeze(['skipped-published']);

/** The reasons a TIME TBD game from an import may carry. */
export const SCHEDULE_IMPORT_TBD_REASONS = Object.freeze([R.IMPORTED_WITHOUT_TIME]);

/** Limits of the file (plan 4.3 and 4.4). */
export const SCHEDULE_IMPORT_LIMITS = Object.freeze({
  /** The workbook's own limit; the Edge function caps a request at 5,000. */
  MAX_ROWS: 2400,
  /** `game_assignments.external_ref`. */
  MAX_GAME_ID_LENGTH: 40,
});

const DESCRIPTIONS = Object.freeze({
  [R.MISSING_COLUMN]: 'The file is missing a column the import needs.',
  [R.DUPLICATE_COLUMN]: 'The file has the same column twice, so neither can be trusted.',
  [R.TOO_MANY_ROWS]: 'The file has more rows than one import takes.',
  [R.NO_SEASON_CLOCK]:
    'The season has no usable time zone, so the times in the file cannot be placed on a clock.',
  [R.MISSING_WEEK]: 'There is no Week to use and no season start date to work one out from.',
  [R.BAD_GAME_ID]: 'The Game ID is longer than the import keeps.',
  [R.BAD_DATE]: 'The date is not one the import reads (YYYY-MM-DD or M/D/YYYY).',
  [R.BAD_TIME]: 'A time is not one the import reads (HH:mm, or h:mm AM or PM).',
  [R.END_NOT_AFTER_START]: 'The game does not end after it starts.',
  [R.SAME_TEAM]: 'The home and away teams are the same team.',
  [R.BAD_WEEK]: 'The Week is not a positive whole number.',
  [R.OUTSIDE_SEASON_WINDOW]: 'The date is outside the season.',
  [R.TIME_IN_DST_GAP]: 'The time does not exist on that date: the clocks skip it.',
  [R.UNKNOWN_DIVISION]: 'The division is not one of yours, and nothing says what to do with it.',
  [R.UNKNOWN_TEAM]: 'A team is not one of yours, and nothing says what to do with it.',
  [R.UNKNOWN_VENUE]: 'The venue is not one of yours, and nothing says what to do with it.',
  [R.UNKNOWN_FIELD]: 'The field is not one of the venue’s, and nothing says what to do with it.',
  [R.LABEL_IS_OWN_TEAM]: 'The label was marked as an outside club but is one of your teams.',
  [R.DUPLICATE_ROW]: 'The same game is already earlier in the file.',
  [R.GAME_ID_REUSED]: 'The Game ID belongs to a different game earlier in the file.',
  [R.FIELD_OVERLAP]: 'Two games are on one field at overlapping times.',
  [R.COACH_CONFLICT]: 'A coach has two games at overlapping times.',
  [R.TEAM_DOUBLE_BOOKED]: 'A team has two games at overlapping times.',
  [R.HOME_AWAY_IMBALANCE]: 'A team hosts at least two more games than it visits, or the reverse.',
  [R.TIME_AMBIGUOUS]: 'The clocks repeat that time on that date; the first occurrence was taken.',
  [R.WEEK_DIFFERS]: 'The Week in the file is not the week the date falls in.',
  [R.IMPORTED_WITHOUT_TIME]: 'The file gave no time or no field for the game.',
});

const SKIP_DESCRIPTIONS = Object.freeze({
  'skipped-published':
    'The game is Published and the file would change it. Allow changes to it first, then import again.',
});

/**
 * A sentence for a skip reason, for a screen that has only the reason.
 *
 * @param {string} reason
 * @returns {string}
 * @throws {Error} on a reason that is not in {@link SCHEDULE_IMPORT_SKIP_REASONS}, or that has no words
 */
export function describeScheduleImportSkip(reason) {
  if (!SCHEDULE_IMPORT_SKIP_REASONS.includes(reason) || !Object.hasOwn(SKIP_DESCRIPTIONS, reason)) {
    throw new Error(`scheduleImport: "${String(reason)}" is not a skip reason with words`);
  }
  return SKIP_DESCRIPTIONS[reason];
}

/**
 * A sentence for a code, for a screen that has only the code.
 *
 * @param {string} code
 * @returns {string}
 * @throws {Error} on a code that is not in {@link SCHEDULE_IMPORT_REASON}
 */
export function describeScheduleImportReason(code) {
  if (typeof code !== 'string' || !Object.hasOwn(DESCRIPTIONS, code)) {
    throw new Error(`scheduleImport: "${String(code)}" is not a schedule import reason code`);
  }
  return DESCRIPTIONS[code];
}
