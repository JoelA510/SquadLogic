/**
 * The optional alias file (plan `docs/changes/2026-11-03-schedule-expansion.md` 4.11.5, F17, decision 30;
 * PR 9, task J2): a small CSV, read in the browser and never uploaded or stored, that says which of the
 * organization's grounds a label of the practice file means.
 *
 * | column | |
 * | --- | --- |
 * | `Alias` | a label as the practice file writes it |
 * | `Location` | one of the organization's locations (`Venue` is read as `Location`) |
 * | `Field` | optional: one of that location's fields |
 * | `Subunit` | optional, and only with a `Field`: one of that field's halves or sides |
 *
 * The most specific cell filled is the **level** of the alias: a `Location` alone aliases a location label, a
 * `Field` a field label, a `Subunit` a subunit label. An alias is keyed by its label and its level (one
 * label may be a location alias and a field alias), through the label key every import here shares
 * (trim, collapse, fold case, no word dropped).
 *
 * **An alias is a proposal, never a decision.** What this module returns is a set of grounds the mapping
 * step (`mapping.js`) shows beside the exact match and the previous import's mapping; nothing is applied
 * without the admin (decision 30), and an alias that disagrees with an exact match is shown with it and
 * chooses neither. It is different from the Edge function's `HEADER_ALIASES`, which aliases column headers.
 *
 * **The format is a proposal until the owner says what their alias tab means** (plan finding 17: its 21
 * names occur on no other tab, and 4 of its 20 targets are row labels on the grid).
 *
 * Reads no table and stores nothing; the result is plain objects with no `Map`, no `Date` and no function,
 * so it can be handed on or kept by the caller. A label that is a property name (`__proto__`,
 * `constructor`) is an ordinary key.
 */

import { PRACTICE_IMPORT_LIMITS, PRACTICE_IMPORT_REASON as R } from './reasonCodes.js';
import { practiceLabelKey, practiceTuple } from './slotKey.js';

/** The columns of the alias file. */
export const PRACTICE_ALIAS_COLUMNS = Object.freeze({
  ALIAS: 'Alias',
  LOCATION: 'Location',
  FIELD: 'Field',
  SUBUNIT: 'Subunit',
});
const A = PRACTICE_ALIAS_COLUMNS;
const HEADER_ALIASES = Object.freeze({ [practiceLabelKey('Venue')]: A.LOCATION });

/** @param {unknown} value @param {string} what */
function requireArray(value, what) {
  if (!Array.isArray(value))
    throw new TypeError(`practiceImport aliases: ${what} must be an array`);
  return value;
}

/** @param {string} text */
const quoted = (text) => `"${text.length > 60 ? `${text.slice(0, 57)}...` : text}"`;

/**
 * @typedef {Object} PracticeAliases  what an alias file proposes, by level
 * @property {Record<string, { locationId: string }>} locations
 * @property {Record<string, { locationId: string, fieldId: string }>} fields
 * @property {Record<string, { locationId: string, fieldId: string, subunitId: string }>} subunits
 */

/**
 * @typedef {Object} PracticeAliasRow
 * @property {number} rowNumber
 * @property {'ok' | 'refused'} status
 * @property {string | null} reason  a `PRACTICE_IMPORT_ALIAS_REFUSALS` member when refused
 * @property {string | null} message
 * @property {'location' | 'field' | 'subunit' | null} level
 * @property {string} aliasKey  the alias as the mapping step looks it up
 */

/**
 * Read an alias file that a CSV parser has already split into a header row and rows of text, against the
 * organization's grounds.
 *
 * @param {Object} input
 * @param {string[]} input.headers
 * @param {Array<Record<string, unknown>>} input.rows
 * @param {{ locations: Array<{ id: string, name: string }>, fields: Array<{ id: string, locationId: string, name: string }>, subunits: Array<{ id: string, fieldId: string, name: string }> }} input.league
 * @returns {{
 *   ok: boolean,
 *   refusal: { code: string, message: string, column?: string } | null,
 *   droppedColumns: string[],
 *   aliases: PracticeAliases,
 *   rows: PracticeAliasRow[],
 *   counts: { rows: number, ok: number, refused: number },
 *   byReason: Record<string, number>,
 * }}
 */
export function readPracticeAliases({ headers, rows, league }) {
  requireArray(headers, 'headers');
  requireArray(rows, 'rows');
  if (!league || typeof league !== 'object') {
    throw new TypeError('practiceImport aliases: league must be an object');
  }
  const locations = requireArray(league.locations, 'league.locations');
  const fields = requireArray(league.fields, 'league.fields');
  const subunits = requireArray(league.subunits, 'league.subunits');

  const empty = { locations: {}, fields: {}, subunits: {} };
  /** @param {string} code @param {string} message @param {string} [column] */
  const refusal = (code, message, column) => ({
    ok: false,
    refusal: column === undefined ? { code, message } : { code, message, column },
    droppedColumns: [],
    aliases: empty,
    rows: [],
    counts: { rows: 0, ok: 0, refused: 0 },
    byReason: {},
  });

  /** @type {Map<string, string>} */
  const header = new Map();
  /** @type {string[]} */
  const droppedColumns = [];
  const byKey = new Map(Object.values(A).map((name) => [practiceLabelKey(name), name]));
  for (const raw of headers) {
    const written = String(raw ?? '');
    const key = practiceLabelKey(written);
    const canonical =
      byKey.get(key) ?? (Object.hasOwn(HEADER_ALIASES, key) ? HEADER_ALIASES[key] : undefined);
    if (canonical === undefined) {
      if (written.trim() !== '') droppedColumns.push(written.trim());
      continue;
    }
    if (header.has(canonical)) {
      return refusal(
        R.DUPLICATE_COLUMN,
        `The alias file has the column "${canonical}" more than once. Remove one and read it again.`,
        canonical
      );
    }
    header.set(canonical, written);
  }
  for (const column of [A.ALIAS, A.LOCATION]) {
    if (!header.has(column)) {
      return refusal(
        R.MISSING_COLUMN,
        `The alias file has no "${column}" column. Add it and read it again.`,
        column
      );
    }
  }
  if (rows.length > PRACTICE_IMPORT_LIMITS.MAX_ROWS) {
    return refusal(
      R.TOO_MANY_ROWS,
      `The alias file has ${rows.length.toLocaleString('en-US')} rows; at most ${PRACTICE_IMPORT_LIMITS.MAX_ROWS.toLocaleString('en-US')} are read.`
    );
  }

  /** @param {Array<any>} list @param {(x: any) => string} scope */
  const indexBy = (list, scope) => {
    const out = new Map();
    for (const item of list) {
      const key = practiceTuple(scope(item), practiceLabelKey(item.name));
      out.set(key, [...(out.get(key) ?? []), item]);
    }
    return out;
  };
  const locationsByName = indexBy(locations, () => '');
  const fieldsByName = indexBy(fields, (f) => f.locationId);
  const subunitsByName = indexBy(subunits, (s) => s.fieldId);

  /** @param {Record<string, unknown>} row @param {string} column */
  const cell = (row, column) => {
    const written = header.get(column);
    if (written === undefined) return '';
    const value = row?.[written];
    return value === undefined || value === null ? '' : String(value).trim();
  };

  /** @type {Array<PracticeAliasRow & { target: string | null, ids: any }>} */
  const read = rows.map((row, index) => {
    const out = {
      rowNumber: index + 1,
      status: /** @type {'ok' | 'refused'} */ ('ok'),
      reason: /** @type {string | null} */ (null),
      message: /** @type {string | null} */ (null),
      level: /** @type {'location' | 'field' | 'subunit' | null} */ (null),
      aliasKey: '',
      target: /** @type {string | null} */ (null),
      ids: /** @type {any} */ (null),
    };
    /** @param {string} code @param {string} message */
    const refuse = (code, message) => {
      out.status = 'refused';
      out.reason = code;
      out.message = message;
      return out;
    };
    const alias = cell(row, A.ALIAS);
    if (practiceLabelKey(alias) === '') return refuse(R.BLANK_ALIAS, 'The row has no Alias.');
    out.aliasKey = practiceLabelKey(alias);

    const locationText = cell(row, A.LOCATION);
    if (practiceLabelKey(locationText) === '') {
      return refuse(R.UNKNOWN_LOCATION, `The Location of ${quoted(alias)} is blank.`);
    }
    const locationHits =
      locationsByName.get(practiceTuple('', practiceLabelKey(locationText))) ?? [];
    if (locationHits.length === 0) {
      return refuse(R.UNKNOWN_LOCATION, `${quoted(locationText)} is not one of your locations.`);
    }
    if (locationHits.length > 1) {
      return refuse(
        R.UNKNOWN_LOCATION,
        `More than one location is named ${quoted(locationText)}, so the alias ${quoted(alias)} cannot say which.`
      );
    }
    const location = locationHits[0];

    const fieldText = cell(row, A.FIELD);
    const subunitText = cell(row, A.SUBUNIT);
    if (practiceLabelKey(fieldText) === '') {
      if (practiceLabelKey(subunitText) !== '') {
        return refuse(
          R.UNKNOWN_FIELD,
          `${quoted(alias)} names a Subunit but no Field. A half or side belongs to a field.`
        );
      }
      out.level = 'location';
      out.ids = { locationId: location.id };
      out.target = practiceTuple(location.id);
      return out;
    }
    const fieldHits =
      fieldsByName.get(practiceTuple(location.id, practiceLabelKey(fieldText))) ?? [];
    if (fieldHits.length !== 1) {
      return refuse(
        R.UNKNOWN_FIELD,
        fieldHits.length === 0
          ? `${quoted(fieldText)} is not one of ${quoted(locationText)}’s fields.`
          : `More than one field of ${quoted(locationText)} is named ${quoted(fieldText)}.`
      );
    }
    const field = fieldHits[0];
    if (practiceLabelKey(subunitText) === '') {
      out.level = 'field';
      out.ids = { locationId: location.id, fieldId: field.id };
      out.target = practiceTuple(location.id, field.id);
      return out;
    }
    const subunitHits =
      subunitsByName.get(practiceTuple(field.id, practiceLabelKey(subunitText))) ?? [];
    if (subunitHits.length !== 1) {
      return refuse(
        R.UNKNOWN_SUBUNIT,
        subunitHits.length === 0
          ? `${quoted(subunitText)} is not one of ${quoted(fieldText)}’s halves or sides.`
          : `More than one half or side of ${quoted(fieldText)} is named ${quoted(subunitText)}.`
      );
    }
    out.level = 'subunit';
    out.ids = { locationId: location.id, fieldId: field.id, subunitId: subunitHits[0].id };
    out.target = practiceTuple(location.id, field.id, subunitHits[0].id);
    return out;
  });

  // The same label at one level naming two different grounds: refuse every row of it (nothing guessed).
  // Naming the same ground twice: the first is read and the repeat listed.
  /** @type {Map<string, Array<(typeof read)[number]>>} */
  const byAlias = new Map();
  for (const r of read) {
    if (r.status !== 'ok') continue;
    const key = practiceTuple(r.level, r.aliasKey);
    byAlias.set(key, [...(byAlias.get(key) ?? []), r]);
  }
  for (const group of byAlias.values()) {
    const targets = new Set(group.map((r) => r.target));
    if (targets.size > 1) {
      for (const r of group) {
        r.status = 'refused';
        r.reason = R.ALIAS_CONFLICT;
        r.message = `The alias ${quoted(r.aliasKey)} names more than one ground in this file (rows ${group.map((g) => g.rowNumber).join(', ')}), so none of them is kept.`;
        r.ids = null;
      }
    } else {
      group.slice(1).forEach((r) => {
        r.status = 'refused';
        r.reason = R.DUPLICATE_ROW;
        r.message = `This alias is already read from row ${group[0].rowNumber}.`;
        r.ids = null;
      });
    }
  }

  // Object.fromEntries defines own properties, so a label like `__proto__` is a key, not a prototype.
  const pick = (level) =>
    Object.fromEntries(
      read.filter((r) => r.status === 'ok' && r.level === level).map((r) => [r.aliasKey, r.ids])
    );
  const counts = { rows: read.length, ok: 0, refused: 0 };
  /** @type {Record<string, number>} */
  const byReason = {};
  for (const r of read) {
    counts[r.status] += 1;
    if (r.reason !== null) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  }
  return {
    ok: true,
    refusal: null,
    droppedColumns,
    aliases: { locations: pick('location'), fields: pick('field'), subunits: pick('subunit') },
    rows: read.map(({ rowNumber, status, reason, message, level, aliasKey }) => ({
      rowNumber,
      status,
      reason,
      message,
      level,
      aliasKey,
    })),
    counts,
    byReason,
  };
}
