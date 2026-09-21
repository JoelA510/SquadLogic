/**
 * **The stored baseline, asked the question it was stored for.**
 *
 * > *"is the working schedule still what version *v* said?"*
 *
 * `checkParity()` has been able to answer that since Prompt 6.2, over two row
 * sets held in one process. GAP-29 Stage 2 gave the published side a durable
 * home (`public.publication_baselines`), and this module is the join: it takes
 * a snapshot read back out of that store and the export a fresh
 * `generateScheduleExports()` run just produced, and hands both to the one
 * comparator.
 *
 * ## What is deliberately absent from this file
 *
 * - **No comparison.** `compareParityRows()` is the only row comparator in this
 *   package and this module does not contain a second one; it chooses a key,
 *   chooses the compared fields, and calls `checkParity()`. If that sentence
 *   ever stops being true, `tests/publicationBaseline.test.js` says so by
 *   enumerating the source.
 * - **No second export vocabulary.** Both sides go through
 *   {@link import('./rows.js').parityRowsFromExportRows}, which is
 *   `outputGeneration.js`'s own `SCHEDULE_EXPORT_HEADERS` read once. A
 *   snapshot's rows and a fresh export's rows are the *same shape* --
 *   `makePublicationSnapshot()` defaults `columns` to `SCHEDULE_EXPORT_COLUMNS`
 *   and `generateScheduleExports()` builds its rows from the same constant --
 *   so no adapter stands between them and none is written here.
 * - **No clock and no store.** This is `packages/core`; it is handed rows and
 *   returns a report. `frontend/src/hooks/usePublicationBaselines.js` is what
 *   talks to Supabase.
 *
 * ## The key includes `participant`, and that is not decoration
 *
 * {@link import('./rows.js').DEFAULT_PARITY_KEY_FIELDS} is date plus the two
 * sides, which identifies a *fixture*. An export artifact is **per team**: one
 * game produces two rows, a home one and an away one, and
 * `parityRowFromExportRow()` normalises both to the same `home`/`away` pair. So
 * under the default key every single game in the artifact would be
 * `PARITY_KEY_AMBIGUOUS` -- two published rows and two current rows sharing one
 * identity -- and nothing would be compared at all. `participant` (the `Team
 * ID` cell) is what tells the two halves apart. `rows.js` says this in as many
 * words where the field is declared; this is the caller that needs it.
 *
 * ## What the comparison can and cannot see, stated rather than implied
 *
 * `venue` and `format` are `null` on every row an export produces -- the export
 * vocabulary has one `Field` column carrying a surface id and no venue column
 * at all -- so comparing them would be `PARITY_FIELD_ABSENT` at blocking on
 * every row rather than a finding about the schedule. They are left out of
 * {@link BASELINE_COMPARED_FIELDS}, which leaves the comparison covering
 * **when, where and in which division**.
 *
 * The export columns that are not parity fields at all -- `Event Type`,
 * `Slot`, `Notes`, `Coaches`, `Coach Emails` -- are outside the parity
 * vocabulary entirely and no bucket in this report says anything about them.
 * That is a real narrowing and {@link baselineParityCoverageFindings} exists so
 * it is said out loud on every run rather than inferred from a silence.
 *
 * ## `Start` is an instant here, a wall reading there, and that had to be faced
 *
 * The header above says no adapter stands between an export row and a parity
 * row, and on the *columns* that is true. On the `Start` **cell** it was not,
 * and the discrepancy was found by running the comparison rather than by
 * reading it. `reserve/publication.js` writes a naive wall reading;
 * `generateScheduleExports()` writes `toISOString()`. `parityRowFromExportRow()`
 * reads only the first, so a baseline taken from the real publish path came
 * back with `date` and `startMinutes` **null on every row** -- the kickoff
 * invisible, and `date` is a key field.
 *
 * What this module does about it is narrow on purpose: it re-spells an
 * instant's own text into `YYYY-MM-DDTHH:MM:SS` when **both** sides are
 * instants, constructing no `Date` and applying no zone, so the comparison is
 * a UTC reading against a UTC reading. A mixture of the two vocabularies is
 * **refused rather than compared**, because `09:00:00` and `09:00:00Z` are not
 * the same moment and agreeing that they are is GAP-30 arriving through the
 * one door GAP-30's schema work does not cover.
 *
 * The underlying divergence -- two producers of one vocabulary disagreeing
 * about a cell -- is a defect in `outputGeneration.js` rather than here, and
 * it is recorded in `docs/MODEL_GAPS.md` rather than fixed under a
 * persistence change: `generateScheduleExports()`'s output is the CSV
 * operators download, and re-rendering every `Start` cell is not a rider a
 * store change gets to carry.
 *
 * @module publication/baseline
 */

import { SCHEDULE_EXPORT_COLUMNS, SCHEDULE_EXPORT_HEADERS } from '../outputGeneration.js';

import { checkParity } from './parity.js';
import {
  PUBLICATION_REASON,
  PUBLICATION_SEVERITY,
  derivePublicationStatus,
  makePublicationFinding,
} from './reasonCodes.js';
import { DEFAULT_PARITY_KEY_FIELDS, PARITY_FIELD, parityRowsFromExportRows } from './rows.js';

/**
 * The identity of a row in a per-team export artifact.
 *
 * `DEFAULT_PARITY_KEY_FIELDS` plus `participant`, derived from the constant
 * rather than retyped so a change to the default key reaches here.
 *
 * @type {ReadonlyArray<string>}
 */
export const BASELINE_KEY_FIELDS = Object.freeze([
  ...DEFAULT_PARITY_KEY_FIELDS,
  PARITY_FIELD.PARTICIPANT,
]);

/**
 * What an export artifact can honestly be compared on: the kickoff, the ground
 * and the division.
 *
 * @type {ReadonlyArray<string>}
 */
export const BASELINE_COMPARED_FIELDS = Object.freeze([
  PARITY_FIELD.START_MINUTES,
  PARITY_FIELD.FIELD,
  PARITY_FIELD.DIVISION,
]);

/**
 * The export headers `parityRowFromExportRow()` actually reads.
 *
 * Named through `SCHEDULE_EXPORT_HEADERS` rather than by their string values,
 * so this is a reference to the export vocabulary and not a second copy of it.
 * `tests/publicationBaseline.test.js` holds it to `rows.js` by enumerating
 * which `SCHEDULE_EXPORT_HEADERS.*` members that file names -- a header added
 * to the adapter and forgotten here makes the test red rather than making the
 * coverage finding quietly overclaim.
 *
 * @type {ReadonlyArray<string>}
 */
export const BASELINE_READ_EXPORT_HEADERS = Object.freeze([
  SCHEDULE_EXPORT_HEADERS.TEAM_ID,
  SCHEDULE_EXPORT_HEADERS.TEAM_NAME,
  SCHEDULE_EXPORT_HEADERS.DIVISION,
  SCHEDULE_EXPORT_HEADERS.OPPONENT,
  SCHEDULE_EXPORT_HEADERS.ROLE,
  SCHEDULE_EXPORT_HEADERS.START,
  SCHEDULE_EXPORT_HEADERS.FIELD,
]);

/**
 * The export columns this comparison reads nothing about.
 *
 * `SCHEDULE_EXPORT_COLUMNS` minus the headers above, so a column added to the
 * export joins this list automatically instead of being silently uncovered.
 *
 * @type {ReadonlyArray<string>}
 */
export const BASELINE_UNREAD_EXPORT_COLUMNS = Object.freeze(
  SCHEDULE_EXPORT_COLUMNS.filter((column) => !BASELINE_READ_EXPORT_HEADERS.includes(column))
);

/**
 * Say, on every run, which export columns the parity numbers are silent about.
 *
 * **Exported and given its inputs rather than closing over them**, exactly as
 * `verifySnapshotDigest()` and `parityPartitionFindings()` are, so a test can
 * hand it a column list that makes it fire and one that does not. A coverage
 * statement nobody can falsify is the decoration this package keeps refusing.
 *
 * @param {ReadonlyArray<string>} columns - the snapshot's declared columns
 * @param {string} subject - what the parity run is of, in words
 * @returns {import('./types.js').PublicationFinding[]}
 */
export function baselineParityCoverageFindings(columns, subject) {
  const unread = columns.filter((column) => BASELINE_UNREAD_EXPORT_COLUMNS.includes(column));
  if (unread.length === 0) return [];
  return [
    makePublicationFinding(
      PUBLICATION_REASON.PARITY_FIELD_UNCOMPARED,
      `"${subject}" compares a baseline carrying ${unread.join(', ')}, which the parity row vocabulary does not model at all, so its numbers say nothing about ${unread.length === 1 ? 'that column' : 'those columns'}`,
      {
        subject,
        columns: unread.join(','),
        comparedFields: BASELINE_COMPARED_FIELDS.join(','),
      }
    ),
  ];
}

/**
 * An ISO instant with a `Z`, as `generateScheduleExports()` writes into `Start`
 * and `End` when no `timezone` argument is given.
 *
 * The fractional seconds are optional because `toISOString()` always writes
 * them and nothing should depend on that.
 */
const UTC_INSTANT_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z$/;

/**
 * The UTC wall reading of an instant, as text.
 *
 * `2026-04-11T09:30:00.000Z` becomes `2026-04-11T09:30:00`. **No `Date` is
 * constructed and no zone is applied**: this drops the fraction and the `Z`
 * and nothing else, so it is a re-spelling rather than a conversion. The
 * result is a UTC reading and this module says so everywhere it is used; it is
 * emphatically *not* the local wall time a family was told, and nothing here
 * pretends otherwise.
 *
 * @param {unknown} cell
 * @returns {string|null} `null` when the cell is not an instant
 */
function utcWallReading(cell) {
  const match = typeof cell === 'string' ? cell.match(UTC_INSTANT_RE) : null;
  return match === null ? null : `${match[1]}T${match[2]}`;
}

/**
 * Which time vocabulary an export artifact's `Start` cells are written in.
 *
 * **This repository has two producers of export-vocabulary rows and they do
 * not agree about `Start`**, which is the defect GAP-29 Stage 4 found by
 * running the comparison rather than reading it:
 *
 * | producer | `Start` cell |
 * | --- | --- |
 * | `reserve/publication.js` `naiveDateTime()` | `2026-04-11T09:00:00` — a wall reading |
 * | `outputGeneration.js` `generateScheduleExports()` | `2026-04-11T09:00:00.000Z` — an instant (or a `toLocaleString` when a `timezone` is passed) |
 *
 * `parityRowFromExportRow()` reads only the first: its `NAIVE_DATETIME_RE`
 * refuses a trailing `Z`. So a parity run over the real publish path's rows
 * had `date` and `startMinutes` **null on every row** — time invisible, and
 * `date` is a key field. `PARITY_FIELD_ABSENT` at blocking stops that being
 * silent, but a reader whose headline question is *"has my game moved?"* and
 * which cannot see a kickoff is not a reader.
 *
 * @param {ReadonlyArray<Record<string, string>>} rows
 * @returns {{ instants: number, other: number }}
 */
function startVocabulary(rows) {
  let instants = 0;
  for (const row of rows) {
    if (utcWallReading(row[SCHEDULE_EXPORT_HEADERS.START]) !== null) instants += 1;
  }
  return { instants, other: rows.length - instants };
}

/**
 * Re-spell an artifact's `Start` cells from instants into their UTC wall
 * reading, so `parityRowFromExportRow()` can read them.
 *
 * Only `Start`, and only when it is an instant. A cell already written as a
 * wall reading is left exactly as it is, and so is `TIME TBD`, a locale string
 * or anything else — those stay unreadable and become `PARITY_FIELD_ABSENT` at
 * blocking, which is the right answer for a cell nobody can interpret.
 *
 * @param {ReadonlyArray<Record<string, string>>} rows
 * @returns {Record<string, string>[]}
 */
function withReadableStart(rows) {
  return rows.map((row) => {
    const reading = utcWallReading(row[SCHEDULE_EXPORT_HEADERS.START]);
    return reading === null ? { ...row } : { ...row, [SCHEDULE_EXPORT_HEADERS.START]: reading };
  });
}

/**
 * Compare a stored baseline against the working schedule.
 *
 * @param {Object} input
 * @param {import('./types.js').PublicationSnapshot} input.snapshot - as
 *   {@link import('./serialise.js').readPublicationSnapshot} returned it
 * @param {ReadonlyArray<Record<string, string>>} input.currentRows - the rows a
 *   fresh `generateScheduleExports()` produced (`master.rows`)
 * @param {string} [input.currentLabel]
 * @param {string} [input.subject]
 * @returns {import('./types.js').ParityResult}
 */
export function checkBaselineParity(input) {
  const { snapshot, currentRows } = input;
  if (snapshot === null || typeof snapshot !== 'object') {
    throw new Error('publication baseline: a parity run needs a snapshot to compare against');
  }
  if (!Array.isArray(currentRows)) {
    throw new Error('publication baseline: currentRows must be an array of export rows');
  }

  const publishedLabel = `${snapshot.label} (published ${snapshot.publishedAt})`;
  const currentLabel = input.currentLabel ?? 'the working schedule';
  const subject = input.subject ?? `${snapshot.label} against the working schedule`;

  // **The two sides must be written in one time vocabulary, and a mixture is
  // refused rather than compared.** `09:00:00` and `09:00:00Z` are not the
  // same moment, and a comparator that let them match would report parity on
  // a schedule that had moved by the offset — the GAP-30 failure, arriving
  // through the one door GAP-30's schema work does not cover, because these
  // are CSV cells rather than `SlotSchema` values.
  const publishedVocabulary = startVocabulary(snapshot.rows);
  const currentVocabulary = startVocabulary(currentRows);
  /** @type {import('./types.js').PublicationFinding[]} */
  const vocabularyFindings = [];
  const mixed =
    (publishedVocabulary.instants > 0 && currentVocabulary.other > 0) ||
    (currentVocabulary.instants > 0 && publishedVocabulary.other > 0);
  if (mixed) {
    vocabularyFindings.push(
      makePublicationFinding(
        PUBLICATION_REASON.PARITY_FIELD_ABSENT,
        `"${subject}" compares a baseline whose Start cells are ${publishedVocabulary.instants} instant(s) and ${publishedVocabulary.other} other against a schedule that is ${currentVocabulary.instants} and ${currentVocabulary.other}; a wall reading and an instant are not the same moment and were not compared as one`,
        {
          subject,
          field: PARITY_FIELD.START_MINUTES,
          publishedInstants: publishedVocabulary.instants,
          currentInstants: currentVocabulary.instants,
        }
      )
    );
  }

  // When both sides are instants, both are re-spelled the same way. When
  // neither is, nothing is touched. A mixture is re-spelled on neither side,
  // so the comparison cannot accidentally agree across vocabularies — the
  // finding above says so and `PARITY_FIELD_ABSENT` fires per cell besides.
  const respell = !mixed && publishedVocabulary.instants > 0 && currentVocabulary.instants > 0;
  const publishedRows = respell ? withReadableStart(snapshot.rows) : snapshot.rows;
  const currentExportRows = respell ? withReadableStart(currentRows) : currentRows;

  const result = checkParity({
    subject,
    published: {
      label: publishedLabel,
      rows: parityRowsFromExportRows(publishedRows, { sourceLabel: publishedLabel }),
    },
    current: {
      label: currentLabel,
      rows: parityRowsFromExportRows(currentExportRows, { sourceLabel: currentLabel }),
    },
    keyFields: BASELINE_KEY_FIELDS,
    comparedFields: BASELINE_COMPARED_FIELDS,
    // Declared empty deliberately, and `checkParity()` says so with
    // `MAPPING_NOT_EXERCISED`: both sides are written in this repository's own
    // export vocabulary, and a rule invented to make the table look used would
    // be a rule nothing could falsify.
    mappingRules: [],
  });

  // **`status` is re-derived, not carried over.** `checkParity()` computes its
  // status mechanically from *its* findings; adding findings afterwards and
  // keeping the old status produces a result that contradicts itself, and the
  // coverage finding fires on every real run, so every single baseline parity
  // result would have mis-stated its status. `derivePublicationStatus()` is
  // the one derivation and is called again over the merged list rather than a
  // second rule being written here.
  const findings = [
    ...result.findings,
    ...vocabularyFindings,
    ...baselineParityCoverageFindings(snapshot.columns, subject),
  ];
  return { ...result, findings, status: derivePublicationStatus(findings) };
}

/**
 * Has the working schedule drifted from this baseline?
 *
 * A one-line reading of a {@link checkBaselineParity} result for a surface that
 * needs a yes or a no. **`added` is not drift** -- a fixture the baseline never
 * carried is news, and `checkParity()`'s own header makes that distinction
 * because treating 112 new Select-layer rows as 112 differences was the
 * difference between a correct report and a false alarm. `differing` and
 * `removed` are drift: a game that moved, and a game that has gone.
 *
 * @param {import('./types.js').ParityResult} result
 * @returns {{ drifted: boolean, differing: number, removed: number, added: number, matched: number }}
 */
export function baselineDriftSummary(result) {
  const differing = result.buckets.differing.length;
  const removed = result.buckets.removed.length;
  return {
    drifted: differing + removed > 0,
    differing,
    removed,
    added: result.buckets.added.length,
    matched: result.buckets.matched.length,
  };
}

/**
 * The findings that mean **the comparison itself cannot be trusted**, as
 * opposed to findings about the schedule.
 *
 * This distinction is not cosmetic and it was got wrong once on the way here.
 * A first attempt gated the operator's verdict on "any blocking finding", but
 * {@link import('./reasonCodes.js').PUBLICATION_REASON.PARITY_ROW_DIFFERS} and
 * `PARITY_ROW_REMOVED` are blocking **precisely because they are the answer** --
 * a game moved, a game is gone. Treating them as unsoundness made the reader
 * refuse to state the very result it exists to state.
 *
 * What is on this list is different in kind: the ground truth is not what was
 * published (`SNAPSHOT_DIGEST_MISMATCH`), a compared field could not be read
 * on one side (`PARITY_FIELD_ABSENT`), nothing was actually compared
 * (`PARITY_VACUOUS`), the four buckets do not account for the inputs
 * (`PARITY_PARTITION_INCOMPLETE`), or rows were paired by input order because
 * the key did not identify them (`PARITY_KEY_AMBIGUOUS`). In every one of
 * those the counts are arithmetic over something nobody should read as a
 * verdict.
 *
 * @type {ReadonlyArray<string>}
 */
export const BASELINE_UNSOUND_REASONS = Object.freeze([
  PUBLICATION_REASON.SNAPSHOT_DIGEST_MISMATCH,
  PUBLICATION_REASON.PARITY_FIELD_ABSENT,
  PUBLICATION_REASON.PARITY_VACUOUS,
  PUBLICATION_REASON.PARITY_PARTITION_INCOMPLETE,
  PUBLICATION_REASON.PARITY_KEY_AMBIGUOUS,
]);

/**
 * Can this comparison's numbers be read as a verdict?
 *
 * **Exported and given its findings** rather than closing over a run, so a
 * test can hand it a set that makes it say no and a set that makes it say
 * yes. `extraFindings` is how a caller folds in the findings from the *read*
 * of the stored baseline: a digest mismatch is discovered when the row set is
 * loaded, not when it is compared, so a surface that only looked at the parity
 * result would compare confidently against corrupted ground truth.
 *
 * @param {import('./types.js').ParityResult} result
 * @param {ReadonlyArray<import('./types.js').PublicationFinding>} [extraFindings]
 * @returns {{ sound: boolean, reasons: string[] }}
 */
export function baselineParitySoundness(result, extraFindings = []) {
  const reasons = [
    ...new Set(
      [...result.findings, ...extraFindings]
        .filter((finding) => BASELINE_UNSOUND_REASONS.includes(finding.code))
        .map((finding) => finding.code)
    ),
  ];
  return { sound: reasons.length === 0, reasons };
}

/**
 * The severity an operator surface should render a baseline parity run at.
 *
 * Re-exported reading of `derivePublicationStatus()`'s inputs rather than a
 * second severity ladder: a run carrying any `blocking` finding is blocking.
 *
 * @param {import('./types.js').ParityResult} result
 * @returns {boolean}
 */
export function baselineParityIsBlocking(result) {
  return result.findings.some((finding) => finding.severity === PUBLICATION_SEVERITY.BLOCKING);
}
