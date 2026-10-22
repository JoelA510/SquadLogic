/**
 * Row normalization shared by the browser import paths (ImportPanel's preview and the mock
 * `import-validation`). Twin of `supabase/functions/_shared/import-rows.ts`, which the Edge
 * Function uses; `tests/importRowsParity.test.js` holds the two equal.
 *
 * Two rules a GotSport export needs (fixtures/demo-2026/README.md, "Import gaps"):
 *
 * - Two source columns can resolve to one canonical key (`Email/UserID` and `Contact Email` both
 *   mean `email`). A blank never replaces a value; between two filled values the later column
 *   wins, as it always has, so no row that had a value before changes.
 * - A coach export has `First Name` and `Last Name` but no full name. `full_name` is composed
 *   from whichever of the two are filled, joined by a space, as ColumnMapper's composite does.
 */

const isBlank = (value) => value === undefined || value === null || String(value).trim() === '';

/**
 * Re-key a parsed row by canonical header.
 * @param {Record<string, unknown>} rawRow
 * @param {(header: string) => string} resolveKey - raw header to canonical key
 * @param {(value: unknown) => string} [clean] - applied to every value before it is kept
 * @returns {Record<string, string>}
 */
export function normalizeImportRow(
  rawRow,
  resolveKey,
  clean = (v) => (v == null ? '' : String(v))
) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [header, value] of Object.entries(rawRow || {})) {
    const key = resolveKey(header);
    const cleaned = clean(value);
    if (!isBlank(cleaned) || !Object.hasOwn(out, key)) out[key] = cleaned;
  }
  return out;
}

/**
 * Give a row with no full name one composed from its first and last names. A row with a full
 * name, or with neither part, is returned unchanged.
 * @param {Record<string, string>} row
 * @returns {Record<string, string>}
 */
export function composeFullName(row) {
  if (!isBlank(row.full_name)) return row;
  const parts = [row.first_name, row.last_name]
    .filter((p) => !isBlank(p))
    .map((p) => String(p).trim());
  return parts.length ? { ...row, full_name: parts.join(' ') } : row;
}
