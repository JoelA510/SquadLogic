/** Classify the original columns before projecting a CSV row onto the names the stage reads.
 * @param {unknown[]} headers
 * @param {(value: unknown, max: number) => string} clean
 * @param {number} maxLength
 * @param {(name: string) => string | undefined} columnOf
 */
export function classifyImportHeaders(headers, clean, maxLength, columnOf) {
  if (!Array.isArray(headers)) throw new TypeError('headers must be an array');
  if (typeof clean !== 'function') throw new TypeError('clean must be the cell cleaner');
  const read = [];
  const dropped = [];
  for (const header of headers) {
    const name = clean(header, maxLength);
    if (!name.trim()) continue;
    const column = columnOf(name);
    if (column === undefined) dropped.push(name.trim());
    else read.push({ raw: String(header ?? ''), name, column });
  }
  return { read, dropped };
}

/**
 * Keep each original header for looking up cells, send its cleaned spelling, and detect ambiguity
 * by canonical column. Each import supplies its own vocabulary, limits and refusal wording.
 * @param {{ headers: unknown[], rows: Array<Record<string, unknown>>, clean: (value: unknown, max: number) => string }} file
 * @param {{ maxLength: number, maxColumns: number, columnOf: (name: string) => string | undefined,
 *   tooMany: (count: number, max: number) => string, duplicate: (column: string) => string }} rules
 */
export function prepareImportFile({ headers, rows, clean }, rules) {
  const { read, dropped } = classifyImportHeaders(headers, clean, rules.maxLength, rules.columnOf);
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  if (read.length > rules.maxColumns) {
    const refusal = {
      code: 'too-many-columns',
      message: rules.tooMany(read.length, rules.maxColumns),
    };
    return { refusal, headers: [], rows: [], dropped };
  }
  const seen = new Set();
  for (const { column } of read) {
    if (seen.has(column)) {
      const refusal = { code: 'duplicate-column', message: rules.duplicate(column), column };
      return { refusal, headers: [], rows: [], dropped };
    }
    seen.add(column);
  }
  return {
    refusal: null,
    headers: read.map((h) => h.name),
    rows: rows.map((row) => Object.fromEntries(read.map((h) => [h.name, row?.[h.raw] ?? '']))),
    dropped,
  };
}
