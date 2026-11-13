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
 * parse needed five more, each for an input the plan's lists have no word for. They are here, so
 * they are reviewed, rather than reported as a reason that does not exist:
 *
 * - `bad-week`: a `Week` cell that is not a whole number from 1 to 255. It was a refusal until the
 *   owner's answer of 2026-11-10 (PR 6, task F5): the week is now derived from the date and the row
 *   is kept, with this code as its warning.
 * - `bad-game-id`: a `Game ID` longer than the 40 characters 4.3 allows. Cutting it would change
 *   the key a later import matches on.
 * - `duplicate-column`: two columns of one name. Reading either would be a guess.
 * - `too-many-columns`: a header row longer than 200 (the practice import's reason, PR 11). It was cut to 200 by
 *   position, which dropped a column the import reads past the cap while its values stayed in the rows.
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
  TOO_MANY_COLUMNS: 'too-many-columns',
  NO_SEASON_CLOCK: 'no-season-clock',
  MISSING_WEEK: 'missing-week',

  // A row is listed with its reason and not written; the rest of the file imports.
  BAD_GAME_ID: 'bad-game-id',
  BAD_DATE: 'bad-date',
  END_NOT_AFTER_START: 'end-not-after-start',
  SAME_TEAM: 'same-team',
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

  // Accepted and said by the PARSE (owner, 2026-11-10; PR 6, task F5), where they were refusals: a time
  // that cannot be read makes the game a dated TIME TBD game, a Week that cannot be stored is derived
  // from the date. Staged since 20261122010000 (the SQL's staged-flag list took them), so the upload, the
  // preview and the saved result say them.
  BAD_TIME: 'bad-time',
  BAD_WEEK: 'bad-week',

  // Warnings the APPLY makes of its own plan (PR 5, fix round 2; the owner: "warnings, not blockers unless necessary"). Never a
  // refusal, never a staged flag: a game moved onto a place another game of the same file moves away from is written, and a
  // placed game the file now gives no time is converted to a dated TIME TBD game.
  GAMES_SWAPPED: 'games-swapped',
  GAME_MADE_TIME_TBD: 'game-made-time-tbd',

  // A game with no time or no field becomes a TIME TBD game with this reason.
  IMPORTED_WITHOUT_TIME: 'imported-without-time',
});

const R = SCHEDULE_IMPORT_REASON;

/** Reasons that refuse the whole file. */
export const SCHEDULE_IMPORT_FILE_REFUSALS = Object.freeze([
  R.MISSING_COLUMN,
  R.DUPLICATE_COLUMN,
  R.TOO_MANY_ROWS,
  R.TOO_MANY_COLUMNS,
  R.NO_SEASON_CLOCK,
  R.MISSING_WEEK,
]);

/** Reasons a single row is listed and not written. */
export const SCHEDULE_IMPORT_ROW_REFUSALS = Object.freeze([
  R.BAD_GAME_ID,
  R.BAD_DATE,
  R.END_NOT_AFTER_START,
  R.SAME_TEAM,
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
  R.BAD_TIME,
  R.BAD_WEEK,
]);

/**
 * The flags a STAGED row may carry: the ones `apply_game_import_job` knows (its shape check refuses a
 * staged row with any other, and with it the whole apply). `staging.js` stages these and no others.
 * Since `20261122010000_game_scores.sql` the SQL takes the parse's two warnings (`bad-time`, `bad-week`)
 * too, so they are staged and reach the saved result.
 */
export const SCHEDULE_IMPORT_STAGED_FLAGS = Object.freeze([
  R.TIME_AMBIGUOUS,
  R.WEEK_DIFFERS,
  R.BAD_TIME,
  R.BAD_WEEK,
]);

/**
 * The warnings the parse raises (PR 6, task F5): the row is kept, changed, and the change is said at
 * the upload and in the preview. They are in {@link SCHEDULE_IMPORT_FLAGS} too, and since
 * `20261122010000` they are staged ({@link SCHEDULE_IMPORT_STAGED_FLAGS}), so the result carries them.
 */
export const SCHEDULE_IMPORT_PARSE_WARNINGS = Object.freeze([R.BAD_TIME, R.BAD_WEEK]);

/**
 * Codes that refused a row until PR 6 and that `apply_game_import_job` still takes as the reason of a
 * staged refusal (its `c_row_refusals`; PR 6 has no migration, and a job staged before it may carry
 * one). No current parse stages them; the SQL's list is {@link SCHEDULE_IMPORT_ROW_REFUSALS} plus these.
 */
export const SCHEDULE_IMPORT_RETIRED_ROW_REFUSALS = Object.freeze([R.BAD_TIME, R.BAD_WEEK]);

/**
 * The warnings the apply adds to its result and its preview, beyond the parse's flags and the two conflict checks
 * (`field-overlap`, `team-double-booked`): each is a thing that was DONE, said, and none refuses a row.
 * `tests/gameImportSkipReasons.test.js` holds the SQL's literals to this list and requires words for each.
 */
export const SCHEDULE_IMPORT_APPLY_WARNINGS = Object.freeze([
  R.GAMES_SWAPPED,
  R.GAME_MADE_TIME_TBD,
]);

/**
 * Why a game the file names is NOT written by the apply (PR 5): a closed list. `skipped-scored` joined it with
 * `20261122010000_game_scores.sql` (F11-2): a game held by its score and not Published. The SQL emits these literals
 * (`apply_game_import_job`, `skipped` of its result and `skipped_games` of its list); `tests/gameImportSkipReasons.test.js`
 * holds this list to the SQL text and requires words for each, so a reason added in one place and not the other fails.
 */
export const SCHEDULE_IMPORT_SKIP_REASONS = Object.freeze(['skipped-published', 'skipped-scored']);

/** The reasons a TIME TBD game from an import may carry. */
export const SCHEDULE_IMPORT_TBD_REASONS = Object.freeze([R.IMPORTED_WITHOUT_TIME]);

/** Limits of the file (plan 4.3 and 4.4). */
export const SCHEDULE_IMPORT_LIMITS = Object.freeze({
  /** The workbook's own limit; the Edge function caps a request at 5,000. */
  MAX_ROWS: 2400,
  /** `game_assignments.external_ref`. */
  MAX_GAME_ID_LENGTH: 40,
  /**
   * The header row: a file with more columns is refused (`too-many-columns`), never cut, since a cut by position
   * dropped a column the import reads while its values stayed (the practice import's C5 on #732, followed here).
   */
  MAX_COLUMNS: 200,
});

const DESCRIPTIONS = Object.freeze({
  [R.MISSING_COLUMN]: 'The file is missing a column the import needs.',
  [R.DUPLICATE_COLUMN]: 'The file has the same column twice, so neither can be trusted.',
  [R.TOO_MANY_ROWS]: 'The file has more rows than one import takes.',
  [R.TOO_MANY_COLUMNS]: 'The file has more columns than one import reads.',
  [R.NO_SEASON_CLOCK]:
    'The season has no usable time zone, so the times in the file cannot be placed on a clock.',
  [R.MISSING_WEEK]: 'There is no Week to use and no season start date to work one out from.',
  [R.BAD_GAME_ID]: 'The Game ID is longer than the import keeps.',
  [R.BAD_DATE]: 'The date is not one the import reads (YYYY-MM-DD or M/D/YYYY).',
  [R.BAD_TIME]:
    'A time is not one the import reads (HH:mm, or h:mm AM or PM): the game is kept on its date with no time (TIME TBD).',
  [R.END_NOT_AFTER_START]: 'The game does not end after it starts.',
  [R.SAME_TEAM]: 'The home and away teams are the same team.',
  [R.BAD_WEEK]:
    'The Week is not a whole number from 1 to 255: the week was worked out from the date.',
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
  [R.GAMES_SWAPPED]:
    'The game takes the place of a game this file moves away: both are written, in an order the schedule allows.',
  [R.GAME_MADE_TIME_TBD]:
    'The file gives the game a date and no time: it is no longer placed, and stands on the TIME TBD list with its date.',
});

const SKIP_DESCRIPTIONS = Object.freeze({
  'skipped-published':
    'The game is Published and the file would change it. Allow changes to it first, then import again.',
  'skipped-scored':
    'The game has a score and the file would change it. Clear its score first, then import again.',
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
