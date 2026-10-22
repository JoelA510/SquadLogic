/**
 * Row normalization for `import-validation`, server side.
 *
 * Twin of `frontend/src/utils/importRows.js`, which the browser preview and the mock use.
 * `tests/importRowsParity.test.js` holds the two equal; change both or neither.
 *
 * - A blank never replaces a value for a canonical key two source columns share
 *   (`Email/UserID` and `Contact Email`); between two filled values the later column wins.
 * - `full_name` is composed from the filled ones of `first_name` and `last_name` when absent.
 */

const isBlank = (value: unknown): boolean =>
  value === undefined || value === null || String(value).trim() === '';

export function normalizeImportRow(
  rawRow: Record<string, unknown>,
  resolveKey: (header: string) => string,
  clean: (value: unknown) => string = (v) => (v == null ? '' : String(v))
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [header, value] of Object.entries(rawRow ?? {})) {
    const key = resolveKey(header);
    const cleaned = clean(value);
    if (!isBlank(cleaned) || !Object.hasOwn(out, key)) out[key] = cleaned;
  }
  return out;
}

export function composeFullName(
  row: Record<string, string>,
  clean: (value: unknown) => string = (v) => (v == null ? '' : String(v))
): Record<string, string> {
  if (!isBlank(row.full_name)) return row;
  const parts = [row.first_name, row.last_name]
    .filter((p) => !isBlank(p))
    .map((p) => String(p).trim());
  // The cleaner runs again on the composed value: two capped parts can exceed the cap together.
  return parts.length ? { ...row, full_name: clean(parts.join(' ')) } : row;
}
