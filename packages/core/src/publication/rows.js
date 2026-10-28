/**
 * **One normalised parity row, and thin adapters into it.**
 *
 * The whole point of this file is that there is exactly one row shape and
 * exactly one key derivation in the repository, so that the published artifact,
 * the working schedule and an externally-sourced re-import can all be compared
 * by {@link import('./parity.js').compareParityRows} rather than by three
 * hand-rolled loops that agree until they do not.
 *
 * ## The field vocabulary is the corpus's own
 *
 * `date`, `startMinutes`, `venue`, `field`, `format`, `division`, `home`,
 * `away` — the eight columns `combined_schedule.csv` and
 * `published_rec_schedule.csv` are written in, and the same eight
 * `fixtures/season2026Parsers.js` `publicationKey()` has always joined. That is
 * not a coincidence: `publicationKey()` now delegates to
 * {@link parityRowKey} rather than keeping a second spelling of the same idea.
 * A ninth, `participant`, exists for per-team artifacts and is `null` on every
 * row those two files produce — see {@link PARITY_FIELD_ORDER}.
 *
 * Times are **minutes past local midnight** and dates are `YYYY-MM-DD`. No
 * `Date` is constructed in this package (GAP-30): the corpus is wall clock, two
 * of its dates fall after DST ends, and a comparison that normalised through an
 * absolute instant would move a published 8:30 AM by an hour on one machine and
 * not another — the parity checker causing the divergence it exists to detect.
 *
 * ## `null` means "this source does not carry that column"
 *
 * It never means "empty" and never means "equal". `external_fixtures_published.csv`
 * has no `Division` and no `Format` column at all; the adapter leaves both
 * `null` and the subject that uses those rows names the fields it can honestly
 * compare. A compared field that is `null` on either side of a pair is
 * `PARITY_FIELD_ABSENT` at blocking rather than a silent match.
 *
 * The corollary is {@link exportCell}, and it is the whole reason that function
 * exists rather than `row[header] || null`: **a cell the artifact carries and
 * left blank is a value, not a missing column.** `generateScheduleExports()`
 * writes `fieldId ?? ''` and `division ?? ''`, so a published fixture whose
 * field was later cleared arrives here as an empty `Field` cell. Folding that
 * into `null` made it read as a column the export vocabulary does not have,
 * which put the pair in `buckets.matched`, counted it in `PARITY_ROWS_MATCHED`
 * and told the family whose pitch had gone precisely nothing. Absent and empty
 * are different, exactly as unknown and zero are.
 *
 * @module publication/rows
 */

import { SCHEDULE_EXPORT_HEADERS } from '../outputGeneration.js';
import { PUBLICATION_TBD } from '../reserve/reasonCodes.js';

/**
 * The columns a normalised parity row carries.
 *
 * @readonly
 * @enum {string}
 */
export const PARITY_FIELD = Object.freeze({
  DATE: 'date',
  START_MINUTES: 'startMinutes',
  VENUE: 'venue',
  FIELD: 'field',
  FORMAT: 'format',
  DIVISION: 'division',
  HOME: 'home',
  AWAY: 'away',
  PARTICIPANT: 'participant',
  ORDINAL: 'ordinal',
});

/**
 * Every comparable field, in the order `publicationKey()` has always joined
 * them, plus one the corpus's schedule rows do not have.
 *
 * `participant` is the team a row is *addressed to*. A schedule row has none —
 * a fixture is not addressed to anybody — but a **per-team export row is**, and
 * one fixture produces two of them. Without it, both halves of a game share an
 * identity and the comparator would report `PARITY_KEY_AMBIGUOUS` on every
 * fixture in a per-team artifact. It is `null` on every row the corpus's
 * schedule CSVs produce, so it never widens a comparison that does not need it.
 *
 * `ordinal` is the same kind of field: it is `null` on every row that has a date, and numbers the
 * TIME TBD rows of one team, event and opponent (1, 2, ...). A TBD row has no date, so two of one
 * team (a team two practices short, or two games against one opponent) would share every other key
 * field and be `PARITY_KEY_AMBIGUOUS`; the ordinal tells them apart, so "2 TBD then, 1 now" is a row
 * removed, not an ambiguity. It is a key field only where a subject names it
 * ({@link import('./baseline.js').BASELINE_KEY_FIELDS}).
 *
 * @type {ReadonlyArray<string>}
 */
export const PARITY_FIELD_ORDER = Object.freeze([
  PARITY_FIELD.DATE,
  PARITY_FIELD.START_MINUTES,
  PARITY_FIELD.VENUE,
  PARITY_FIELD.FIELD,
  PARITY_FIELD.FORMAT,
  PARITY_FIELD.DIVISION,
  PARITY_FIELD.HOME,
  PARITY_FIELD.AWAY,
  PARITY_FIELD.PARTICIPANT,
  PARITY_FIELD.ORDINAL,
]);

/**
 * The identity fields a parity subject keys on unless it says otherwise.
 *
 * Date and the two participants: what a family knows a fixture *by*. Time and
 * place are deliberately **not** in the default key — they are the things that
 * move, and a key that included them would report every rescheduled game as one
 * removal plus one addition rather than as the change it is.
 *
 * @type {ReadonlyArray<string>}
 */
export const DEFAULT_PARITY_KEY_FIELDS = Object.freeze([
  PARITY_FIELD.DATE,
  PARITY_FIELD.HOME,
  PARITY_FIELD.AWAY,
]);

/**
 * Build a normalised parity row, filling every unstated column with `null`.
 *
 * @param {Partial<import('./types.js').ParityRow> & { rowId: string, sourceLabel: string }} input
 * @returns {import('./types.js').ParityRow}
 */
export function makeParityRow(input) {
  /** @type {Record<string, unknown>} */
  const row = { rowId: input.rowId, sourceLabel: input.sourceLabel };
  for (const field of PARITY_FIELD_ORDER) {
    row[field] = input[field] === undefined ? null : input[field];
  }
  return /** @type {import('./types.js').ParityRow} */ (row);
}

/**
 * Render one field's value as key text.
 *
 * `null` is spelled as the empty string and a number as its decimal digits;
 * nothing here parses the result back, so the only property that matters is
 * that two rows produce the same text exactly when they agree on every named
 * field.
 *
 * @param {unknown} value
 * @returns {string}
 */
function keyText(value) {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * The identity of a row under a stated list of fields.
 *
 * **The one key derivation in this repository.** `publicationKey()` in
 * `fixtures/season2026Parsers.js` calls through to it over
 * {@link PARITY_FIELD_ORDER}; `compareParityRows()` calls it over whichever
 * fields the subject names.
 *
 * @param {import('./types.js').ParityRow} row
 * @param {ReadonlyArray<string>} keyFields
 * @returns {string}
 */
export function parityRowKey(row, keyFields) {
  return keyFields.map((field) => keyText(row[field])).join('|');
}

/**
 * Which comparable fields a row set actually carries.
 *
 * Used to report `PARITY_FIELD_UNCOMPARED`: a field both sides populate and
 * neither the key nor the comparison touches is a narrowing of the subject that
 * has to be said out loud.
 *
 * @param {ReadonlyArray<import('./types.js').ParityRow>} rows
 * @returns {string[]}
 */
export function populatedParityFields(rows) {
  return PARITY_FIELD_ORDER.filter((field) =>
    rows.some((row) => row[field] !== null && row[field] !== undefined)
  );
}

/**
 * Is this a field a parity row can be keyed or compared on?
 *
 * @param {string} field
 * @returns {boolean}
 */
export function isParityField(field) {
  return PARITY_FIELD_ORDER.includes(field);
}

/**
 * `YYYY-MM-DDTHH:MM:SS` — the naive datetime `reserve/publication.js`
 * `naiveDateTime()` emits, read back without constructing a `Date`.
 */
const NAIVE_DATETIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/;

/**
 * Split a naive datetime into a date and minutes past midnight.
 *
 * Anything that is not one — `TIME TBD` above all — yields `{ date: null,
 * startMinutes: null }` rather than a guess, so an unplaced fixture compares as
 * a fixture whose time is not known rather than as a fixture at midnight.
 *
 * @param {string} value
 * @returns {{ date: string|null, startMinutes: number|null }}
 */
export function splitNaiveDateTime(value) {
  const match = typeof value === 'string' ? value.match(NAIVE_DATETIME_RE) : null;
  if (match === null) return { date: null, startMinutes: null };
  return { date: match[1], startMinutes: Number(match[2]) * 60 + Number(match[3]) };
}

/**
 * One cell of an export-vocabulary row, keeping "the artifact does not have
 * this column" and "the artifact has it and it is blank" apart.
 *
 * A column the row object does not carry is `null`, which every comparison
 * refuses to read as agreement (`PARITY_FIELD_ABSENT`). A cell that is present
 * is returned as it stands, **including the empty string**: a fixture whose
 * `Field` was cleared has a field, and it is nothing. Reading that back as an
 * absent column is what let a cleared pitch land in `buckets.matched`.
 *
 * @param {Record<string, string>} row
 * @param {string} header - a `SCHEDULE_EXPORT_HEADERS` value
 * @returns {string|null}
 */
export function exportCell(row, header) {
  const value = row[header];
  if (value === undefined || value === null) return null;
  return String(value);
}

/**
 * Adapt one export-vocabulary row — the shape
 * `packages/core/src/reserve/publication.js` emits and
 * `packages/core/src/outputGeneration.js` consumes — into a parity row.
 *
 * A **thin function, not a second comparator**: it renames columns and reads
 * the `Start` cell back into date-plus-minutes. Two things it deliberately does
 * not invent:
 *
 * - `venue` stays `null`. The export vocabulary has one `Field` column carrying
 *   a surface id and no venue column at all; splitting an id into a venue and a
 *   field here would be a name-mapping transform hidden inside an adapter.
 * - the two sides come from `Role` and `Opponent`. An export row is per team,
 *   so `Team Name` is the home side when `Role` says `Home` and the away side
 *   otherwise; a row that carries no `Opponent` column at all is left with
 *   `away` null, which the absent-field check will refuse to compare rather
 *   than guess at, while a row whose `Opponent` cell is present and blank says
 *   so with an empty string ({@link exportCell}).
 *
 * - `ordinal` is only what the caller passes ({@link parityRowsFromExportRows} numbers the TBD
 *   rows of one team, event and opponent); a lone row has none.
 *
 * @param {Record<string, string>} row
 * @param {{ sourceLabel: string, rowId?: string, index?: number, ordinal?: number | null }} context
 * @returns {import('./types.js').ParityRow}
 */
export function parityRowFromExportRow(row, context) {
  const { date, startMinutes } = splitNaiveDateTime(row[SCHEDULE_EXPORT_HEADERS.START] ?? '');
  const teamName = exportCell(row, SCHEDULE_EXPORT_HEADERS.TEAM_NAME);
  const opponent = exportCell(row, SCHEDULE_EXPORT_HEADERS.OPPONENT);
  const role = exportCell(row, SCHEDULE_EXPORT_HEADERS.ROLE);
  const isAway = role === 'Away';

  return makeParityRow({
    rowId: context.rowId ?? `${context.sourceLabel}#${context.index ?? 0}`,
    sourceLabel: context.sourceLabel,
    date,
    startMinutes,
    venue: null,
    field: exportCell(row, SCHEDULE_EXPORT_HEADERS.FIELD),
    format: null,
    division: exportCell(row, SCHEDULE_EXPORT_HEADERS.DIVISION),
    home: isAway ? opponent : teamName,
    away: isAway ? teamName : opponent,
    // The team this row is addressed to: what makes the home half and the away
    // half of one fixture two distinct rows rather than one ambiguous identity.
    participant: exportCell(row, SCHEDULE_EXPORT_HEADERS.TEAM_ID),
    ordinal: context.ordinal ?? null,
  });
}

/**
 * Adapt a whole export-vocabulary artifact — a publication snapshot's rows, or
 * the rows a fresh `publicationRowsFor()` run produced — into parity rows.
 *
 * @param {ReadonlyArray<Record<string, string>>} rows
 * @param {{ sourceLabel: string }} context
 * @returns {import('./types.js').ParityRow[]}
 */
export function parityRowsFromExportRows(rows, context) {
  // The TIME TBD rows of one team, opponent and role (a practice has neither opponent nor role, a
  // game both, so the group never mixes the two) are told apart by their order in the
  // artifact: 1, 2, ... Rows with a date carry none (their date already identifies them). The
  // surplus on either side then falls into `added` or `removed` as the comparator pairs by key.
  /** @type {Map<string, number>} */
  const seen = new Map();
  return rows.map((row, index) => {
    let ordinal = null;
    if (row[SCHEDULE_EXPORT_HEADERS.START] === PUBLICATION_TBD.TIME) {
      const group = [
        SCHEDULE_EXPORT_HEADERS.TEAM_ID,
        SCHEDULE_EXPORT_HEADERS.OPPONENT,
        SCHEDULE_EXPORT_HEADERS.ROLE,
      ]
        .map((header) => keyText(row[header]))
        .join('|');
      ordinal = (seen.get(group) ?? 0) + 1;
      seen.set(group, ordinal);
    }
    return parityRowFromExportRow(row, { sourceLabel: context.sourceLabel, index, ordinal });
  });
}
