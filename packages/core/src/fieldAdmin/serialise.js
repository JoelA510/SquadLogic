/**
 * **The export seam: the domain model out to CSV and back, byte-stable.**
 *
 * Follows `externalImport/mapping.js`'s
 * `serialiseExternalMappingRegistry()` / `readExternalMappingRegistry()`
 * exactly: a version-stamped document, validated by a `.strict()` schema **in
 * both directions**, with no `Date`, no `Map` and no function in it. A document
 * this module cannot read back is not a document, and finding that out at write
 * time is the difference between a failing test and a corrupt store.
 *
 * ## What "the round trip is the identity" means here, precisely
 *
 * The asserted property is **`export -> import -> export` over the domain
 * model**. It is *not* that the four working sheets are reproduced byte for
 * byte, and the plan's phrase "byte-stable and re-importable" must not be read
 * that way.
 *
 * The sheets cannot survive a normalising round trip, and that is the whole
 * point of keeping the raw cell: `field_inventory.csv`'s `9v9 (1) 7v7 (2) upper
 * (+ lower)` has no normal form, 15 rows of `field_weekly_availability.csv`
 * carry a date where an hour range was meant, and `field_constraints.csv`'s
 * Gardening Day row carries a date where a field range was meant. A serialiser
 * that reproduced those exactly would be a file copier; one that "fixed" them
 * would destroy the evidence. So the export writes the **domain model's own**
 * CSV, and the raw cells travel beside the readings rather than through them.
 *
 * ## Why this file **throws** where the projectors carry a row
 *
 * A reader here refuses the whole document on an unrecognised token -
 * `readCell` on a non-JSON structured cell or a non-`true`/`false` boolean, a
 * duplicate record id, a row whose cell count does not match the header. The
 * projectors in `projectors/` do the opposite: an undeclared `venue | facility`
 * pair, an undeclared weekly interpretation and an undeclared `fields` cell
 * each become an unresolvable row carrying its reason, because losing four
 * unrelated change sets to one unreadable cell is worse than reporting it.
 *
 * **The two are not the same case, and the difference is who wrote the value.**
 * A projector reads a *source cell* - a working sheet a club filled in by hand,
 * where an unmodelled value is ordinary news and the right answer is to carry
 * the row unapplied. This file reads *a document this module wrote*. An
 * unrecognised token here means the file is corrupt or came from another
 * version, which is a producer bug, and degrading it silently would invent a
 * record nobody wrote from bytes nobody can explain.
 *
 * So do not "fix" this by pattern-matching the projectors: they belong to
 * different families. Version skew belongs at {@link FIELD_REGISTRY_DOCUMENT_VERSION}, where a
 * refusal can name the version it found and the version it wanted - not at a
 * per-value reader, which knows only that one cell made no sense.
 *
 * ## What makes it byte-stable
 *
 * Five rules, each one of them load-bearing and none of them a default:
 *
 * 1. **Column order is frozen**, read from {@link COLUMNS} rather than from
 *    `Object.keys()` of whatever the first record happened to hold.
 * 2. **Row order is a declared sort** on the record id, in code-unit order so
 *    the runtime's locale cannot reach it - two runs over the same set write
 *    the same file regardless of input order. The comparator itself now lives
 *    in `../documentOrder.js`, shared with `externalImport`'s seam, which
 *    preserved insertion order until 2026-09-19 and so wrote a different
 *    document for the same registry.
 * 3. **One quoting rule**, {@link quoteCell} - quote if and only if the cell
 *    holds a comma, a double quote, a newline, or leading/trailing space.
 * 4. **Structured columns are JSON**, so a value containing the separator
 *    cannot be read back as two values - see {@link STRUCTURED_COLUMNS} for
 *    the corpus data that made that a defect rather than a hypothetical.
 * 5. **`\n` endings and no BOM.** A trailing newline is written, once.
 *
 * Nothing here persists anything. Every registry carries
 * {@link FIELD_ADMIN_REASON.REGISTRY_NOT_PERSISTED}, in the same position
 * `EXTERNAL_MAPPING_NOT_PERSISTED` takes: there is no SQL home for these
 * records in this PR, and writing columns now would invent the store this seam
 * exists to defer.
 *
 * @module fieldAdmin/serialise
 */

import { z } from 'zod';

import { sortRecordsById } from '../documentOrder.js';

import {
  AliasRecordSchema,
  BlackoutWindowSchema,
  PermitWindowSchema,
  RecurringWindowSchema,
  SUBJECT_KINDS,
  VenueAttributesSchema,
} from './schemas.js';
import {
  FIELD_ADMIN_REASON,
  assertFieldAdminFindings,
  deriveFieldAdminStatus,
  makeFieldAdminFinding,
} from './reasonCodes.js';

/** Bumped when the document shape changes in a way a reader must know about. */
export const FIELD_REGISTRY_DOCUMENT_VERSION = 1;

/** The line ending. Written, never inferred from the platform. */
const LINE_ENDING = '\n';

/**
 * The frozen column order per subject kind.
 *
 * Read by both the writer and the reader, so a column added to one cannot go
 * missing from the other.
 *
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
 */
export const COLUMNS = Object.freeze({
  blackout: Object.freeze([
    'id',
    'scope',
    'venueIds',
    'surfaceIds',
    'fromDate',
    'toDate',
    'startMinutes',
    'endMinutes',
    'reason',
    'note',
    'source',
  ]),
  'recurring-window': Object.freeze([
    'id',
    'venueIds',
    'isoWeekday',
    'startMinutes',
    'endMinutes',
    'available',
    'source',
  ]),
  'permit-window': Object.freeze([
    'id',
    'permitId',
    'venueIds',
    'surfaceIds',
    'facilityLabel',
    'date',
    'startMinutes',
    'endMinutes',
    'services',
    'source',
  ]),
  'venue-attributes': Object.freeze([
    'id',
    'venueIds',
    'venueLabel',
    'fieldSizesText',
    'ageGroupsText',
    'practiceMaxTeamsText',
    'bathroomText',
    'notesText',
    'equipment',
    'source',
  ]),
  alias: Object.freeze([
    'id',
    'displayName',
    'label',
    'venueIds',
    'surfaceIds',
    'uncertain',
    'source',
  ]),
});

/**
 * Columns holding structured data: a list of strings, or a list of records.
 *
 * **Written as JSON, after a space-joined encoding silently corrupted the
 * corpus.** The first version joined list members with a space and split on
 * one, with a comment claiming service names hold no spaces and that the reader
 * refused any that did. Both halves were false: all three service values the
 * permits carry - `Field Lights`, `Restroom Use`, `Custodian Open/Close` -
 * contain a space, and no refusal existed. `['Restroom Use']` came back as
 * `['Restroom', 'Use']`, `PermitWindowSchema` accepted it because both halves
 * are non-empty strings, and the round-trip test could not see it: re-rendering
 * the broken value produced the same bytes, so **the file was stable while the
 * record was wrong**.
 *
 * JSON has no such ambiguity, needs no separator nobody may type, and the CSV
 * quoting rule already handles the commas and quotes it introduces.
 */
const STRUCTURED_COLUMNS = new Set(['venueIds', 'surfaceIds', 'services', 'equipment']);

/** Columns holding an integer or the empty string. */
const NUMBER_COLUMNS = new Set(['startMinutes', 'endMinutes', 'isoWeekday']);

/** Columns holding `true` / `false`. */
const BOOLEAN_COLUMNS = new Set(['available', 'uncertain']);

/** The schema per subject kind, for validation in both directions. */
/** @type {Array<[string, import('zod').ZodTypeAny]>} */
const SCHEMA_ENTRIES = [
  ['blackout', BlackoutWindowSchema],
  ['recurring-window', RecurringWindowSchema],
  ['permit-window', PermitWindowSchema],
  ['venue-attributes', VenueAttributesSchema],
  ['alias', AliasRecordSchema],
];

const SCHEMA_BY_KIND = new Map(SCHEMA_ENTRIES);

/** The document a registry serialises to. Validated on the way out and in. */
export const FieldRegistryDocumentSchema = z
  .object({
    version: z.literal(FIELD_REGISTRY_DOCUMENT_VERSION),
    registryId: z.string().min(1),
    label: z.string().min(1),
    kind: z.enum(/** @type {[string, ...string[]]} */ (SUBJECT_KINDS)),
    records: z.array(z.record(z.string(), z.unknown())),
  })
  .strict();

/**
 * The columns for one subject kind, or a throw naming the union.
 *
 * @param {string} kind
 * @returns {ReadonlyArray<string>}
 */
export function columnsFor(kind) {
  const columns = Object.prototype.hasOwnProperty.call(COLUMNS, kind) ? COLUMNS[kind] : null;
  if (!columns) {
    throw new Error(
      `fieldAdmin serialise: subject kind "${kind}" has no column order; add one beside its neighbours in COLUMNS (${SUBJECT_KINDS.join(', ')})`
    );
  }
  return columns;
}

/**
 * Render one value to its cell text.
 *
 * @param {string} column
 * @param {unknown} value
 * @returns {string}
 */
export function renderCell(column, value) {
  if (value === null || value === undefined) return '';
  if (STRUCTURED_COLUMNS.has(column)) return JSON.stringify(value);
  if (BOOLEAN_COLUMNS.has(column)) return value ? 'true' : 'false';
  return String(value);
}

/**
 * Read one cell back to its value.
 *
 * @param {string} column
 * @param {string} cell
 * @returns {unknown}
 */
export function readCell(column, cell) {
  if (STRUCTURED_COLUMNS.has(column)) {
    // **`''` reads back as `null`, not as `[]`.** An empty array is written
    // `[]` and an absent value is written `''`, so the two are already
    // distinguishable on the page; mapping both to `[]` would make a nullable
    // structured column round-trip as `null -> '' -> [] -> '[]'` - a changed
    // file for an unchanged record. No column is nullable today, so this path
    // is unreachable on the current model and a `null` would fail the schema
    // loudly rather than pass silently, which is the direction to fail in.
    if (cell === '') return null;
    try {
      return JSON.parse(cell);
    } catch (error) {
      throw new Error(
        `fieldAdmin serialise: ${column} cell ${JSON.stringify(cell)} is not JSON (${/** @type {Error} */ (error).message})`
      );
    }
  }
  if (BOOLEAN_COLUMNS.has(column)) {
    if (cell === 'true') return true;
    if (cell === 'false') return false;
    throw new Error(
      `fieldAdmin serialise: ${column} cell ${JSON.stringify(cell)} is neither "true" nor "false"`
    );
  }
  if (NUMBER_COLUMNS.has(column)) return cell === '' ? null : Number(cell);
  return cell === '' ? null : cell;
}

/**
 * Quote a cell if and only if it needs it. **The one quoting rule.**
 *
 * @param {string} cell
 * @returns {string}
 */
export function quoteCell(cell) {
  const needsQuote =
    cell.includes(',') ||
    cell.includes('"') ||
    cell.includes('\n') ||
    cell.includes('\r') ||
    cell !== cell.trim();
  return needsQuote ? `"${cell.replace(/"/g, '""')}"` : cell;
}

/**
 * Split one CSV line, honouring the quoting rule above.
 *
 * Written here rather than reached for from `fixtures/`: this package is pure
 * domain logic and the fixtures barrel is an IO layer. The grammar is the
 * writer's own, so the two cannot disagree about it.
 *
 * Kept for a single line with no embedded newline; {@link splitCsvRecords} is
 * what `fromCsv()` uses, because a line is not a record.
 *
 * @param {string} line
 * @returns {string[]}
 */
export function splitCsvLine(line) {
  const records = splitCsvRecords(line);
  if (records.length !== 1) {
    throw new Error(
      `fieldAdmin serialise: ${JSON.stringify(line)} is ${records.length} record(s), not one; use splitCsvRecords()`
    );
  }
  return records[0];
}

/**
 * Split whole CSV text into records, **honouring quotes across newlines**.
 *
 * `quoteCell()` deliberately quotes a cell containing `\n` or `\r`, which says
 * an embedded newline is a value this format supports. The reader used to
 * `text.split('\n')` first and hand each fragment to a line splitter, so any
 * cell the writer was willing to quote that way came back as an unterminated
 * quote or a cell-count mismatch. Nothing in `NoteSchema` or
 * `VenueAttributesSchema` forbids a newline, so the asserted
 * `export -> import -> export` identity did not hold for records the writer
 * would happily produce. Scanning once, with the quote state carried across
 * line breaks, is the only reading under which the writer and the reader
 * describe the same format.
 *
 * @param {string} text
 * @returns {string[][]}
 */
export function splitCsvRecords(text) {
  /** @type {string[][]} */
  const records = [];
  /** @type {string[]} */
  let cells = [];
  let cell = '';
  let quoted = false;
  let started = false;

  const endCell = () => {
    cells.push(cell);
    cell = '';
  };
  const endRecord = () => {
    endCell();
    records.push(cells);
    cells = [];
    started = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') {
        cell += char;
      } else if (text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (char === '"' && cell === '') {
      quoted = true;
      started = true;
    } else if (char === ',') {
      started = true;
      endCell();
    } else if (char === '\n') {
      endRecord();
    } else if (char === '\r') {
      // A bare CR inside an unquoted cell is not something the writer emits;
      // swallowing it here keeps a file that has been through a CRLF tool
      // readable rather than failing on an invisible byte.
      continue;
    } else {
      started = true;
      cell += char;
    }
  }
  if (quoted) {
    throw new Error(
      `fieldAdmin serialise: unterminated quote in ${JSON.stringify(text.slice(0, 120))}`
    );
  }
  // A trailing newline ends the last record rather than starting an empty one.
  if (started || cell !== '' || cells.length > 0) endRecord();
  return records;
}

/**
 * **Build a registry** of one subject kind.
 *
 * @param {Object} input
 * @param {string} input.registryId
 * @param {string} input.label
 * @param {string} input.kind - a `SUBJECT_KINDS` value
 * @param {ReadonlyArray<Record<string, unknown>>} input.records
 * @returns {{ registryId: string, label: string, kind: string, records: ReadonlyArray<Record<string, unknown>>, findings: ReadonlyArray<import('./types.js').FieldAdminFinding>, status: string }}
 */
export function buildFieldRegistry(input) {
  const schema = SCHEMA_BY_KIND.get(input.kind);
  if (!schema) {
    throw new Error(
      `fieldAdmin serialise: subject kind "${input.kind}" has no schema; add one beside its neighbours (${SUBJECT_KINDS.join(', ')})`
    );
  }
  // Re-validated here rather than trusted from a projector: a record that
  // reaches the writer unvalidated is one the reader may refuse, and the round
  // trip would then fail at read time on data already written.
  const records = input.records.map((record) => schema.parse(record));

  const seen = new Set();
  for (const record of records) {
    const id = /** @type {string} */ (record.id);
    if (seen.has(id)) {
      throw new Error(`fieldAdmin serialise: duplicate record id "${id}" in ${input.registryId}`);
    }
    seen.add(id);
  }

  const findings = [
    makeFieldAdminFinding(
      FIELD_ADMIN_REASON.REGISTRY_NOT_PERSISTED,
      `field registry ${input.registryId} lives in memory only; serialiseFieldRegistry() and readFieldRegistry() are the declared persistence seam and nothing in this repository stores through it yet`,
      { registryId: input.registryId, kind: input.kind, recordCount: records.length }
    ),
  ];
  assertFieldAdminFindings(findings, `registry ${input.registryId}`);

  return Object.freeze({
    registryId: input.registryId,
    label: input.label,
    kind: input.kind,
    records: Object.freeze(records.map((record) => Object.freeze({ ...record }))),
    findings: Object.freeze(findings),
    status: deriveFieldAdminStatus(findings),
  });
}

/**
 * **Serialise a registry** to a document.
 *
 * Validated on the way out as well as on the way in, for the reason
 * `serialiseExternalMappingRegistry()` states.
 *
 * @param {{ registryId: string, label: string, kind: string, records: ReadonlyArray<Record<string, unknown>> }} registry
 * @returns {Object}
 */
export function serialiseFieldRegistry(registry) {
  const columns = columnsFor(registry.kind);
  const document = {
    version: FIELD_REGISTRY_DOCUMENT_VERSION,
    registryId: registry.registryId,
    label: registry.label,
    kind: registry.kind,
    // Sorted by id, so input order cannot reach the output. **Code-unit
    // order, not `localeCompare`**, and shared rather than spelled here:
    // `../documentOrder.js` holds the one comparator every persistence seam in
    // this repository sorts by, so two seams cannot drift into two orders.
    // This file's rule is unchanged - it is where the rule came from.
    records: sortRecordsById(registry.records)
      .map((record) => {
        /** @type {Record<string, unknown>} */
        const row = {};
        for (const column of columns) row[column] = record[column] ?? null;
        return row;
      }),
  };
  return /** @type {Object} */ (FieldRegistryDocumentSchema.parse(document));
}

/**
 * **Read a registry back** out of a document.
 *
 * Re-runs every construction check, so a document edited by hand - or by a
 * store with its own opinions - is refused or reported exactly as a fresh input
 * would be. There is no fast path that trusts a document because this module
 * wrote it.
 *
 * @param {unknown} rawDocument
 * @returns {ReturnType<typeof buildFieldRegistry>}
 */
export function readFieldRegistry(rawDocument) {
  const document = /** @type {any} */ (FieldRegistryDocumentSchema.parse(rawDocument));
  return buildFieldRegistry({
    registryId: document.registryId,
    label: document.label,
    kind: document.kind,
    records: document.records,
  });
}

/**
 * Write a document to CSV text.
 *
 * @param {Object} document - from {@link serialiseFieldRegistry}
 * @returns {string}
 */
export function toCsv(document) {
  const kind = /** @type {string} */ (/** @type {any} */ (document).kind);
  const columns = columnsFor(kind);
  const lines = [columns.map((column) => quoteCell(column)).join(',')];
  for (const record of /** @type {Array<Record<string, unknown>>} */ (
    /** @type {any} */ (document).records
  )) {
    lines.push(columns.map((column) => quoteCell(renderCell(column, record[column]))).join(','));
  }
  return `${lines.join(LINE_ENDING)}${LINE_ENDING}`;
}

/**
 * Read CSV text back to a document.
 *
 * @param {string} text
 * @param {{ registryId: string, label: string, kind: string }} identity
 * @returns {Object}
 */
export function fromCsv(text, identity) {
  const columns = columnsFor(identity.kind);
  const records = splitCsvRecords(text);
  if (records.length === 0) {
    throw new Error(`fieldAdmin serialise: ${identity.registryId} has no header line`);
  }

  const header = records[0];
  if (header.join(',') !== columns.join(',')) {
    // Checked whole rather than per cell, and against the frozen order: a
    // header-only mismatch is how a column silently stops being read.
    throw new Error(
      `fieldAdmin serialise: ${identity.registryId} header is [${header.join(', ')}]; expected [${columns.join(', ')}]`
    );
  }

  const rows = records.slice(1).map((cells, index) => {
    if (cells.length !== columns.length) {
      throw new Error(
        `fieldAdmin serialise: ${identity.registryId} row ${index} has ${cells.length} cell(s) for ${columns.length} column(s)`
      );
    }
    /** @type {Record<string, unknown>} */
    const record = {};
    columns.forEach((column, position) => {
      record[column] = readCell(column, cells[position]);
    });
    return record;
  });

  return /** @type {Object} */ (
    FieldRegistryDocumentSchema.parse({
      version: FIELD_REGISTRY_DOCUMENT_VERSION,
      registryId: identity.registryId,
      label: identity.label,
      kind: identity.kind,
      records: rows,
    })
  );
}
