/**
 * The one CSV cell writer for files a person downloads and opens in a
 * spreadsheet (DS-4).
 *
 * Two rules, applied in this order:
 *
 * 1. **Neutralise a formula.** A cell that Excel, LibreOffice or Sheets would
 *    read as a formula starts with `=`, `+`, `-` or `@` (leading spaces allowed); a leading tab or
 *    carriage return is the other way in (OWASP, "CSV Injection"). Such a cell
 *    gets a leading apostrophe, which the spreadsheet shows as nothing and
 *    reads as "this is text". Without it, a team named `=HYPERLINK(...)` or a
 *    coach's name pasted from a registration form runs on the admin's machine.
 * 2. **Quote per RFC 4180.** A cell with a quote, comma, CR or LF is wrapped in
 *    double quotes, with embedded quotes doubled.
 *
 * ## Legitimate numbers are not touched
 *
 * A JavaScript number (`-5`) is written as it is. So is a string that is
 * nothing but a signed decimal (`-5`, `+15551234567`, `-0.25`): a spreadsheet
 * reads that as a number, and no formula, function call or reference can be
 * spelled with only digits, one sign and one point. Anything longer
 * (`-5+cmd`, `+1 (555) 123`, `-`) is not a plain number and is neutralised.
 * No export column is numeric today, so there is no per-column switch to get
 * wrong; the rule is on the value.
 *
 * ## Where it applies
 *
 * Output a person opens: `outputGeneration.formatCsv` (schedule exports and the
 * roster export) and the import template download. It is *not* applied to
 * `ColumnMapper.serializeCanonicalCsv` (our own re-packaging of an upload for the
 * import parser, which a prefix would corrupt) or to `fieldAdmin`'s `toCsv` (a
 * lossless round-trip format whose reader would have to unprefix); the export is
 * where data meets a spreadsheet, so the rule lives there.
 */

/** A cell that is only a signed decimal: a number to a spreadsheet, never a formula. */
const PLAIN_SIGNED_NUMBER = /^[+-]?\d+(\.\d+)?$/;

/**
 * A cell a spreadsheet may take as a formula: `=`, `+`, `-` or `@` first (after
 * any leading spaces, as the July audit's fix approach says), or a tab or CR first.
 */
const FORMULA_LEAD = /^( *[=+\-@]|[\t\r])/;

/**
 * Prefix a formula-looking cell with an apostrophe.
 *
 * @param {string} text
 * @returns {string}
 */
export function neutraliseFormula(text) {
  if (!FORMULA_LEAD.test(text) || PLAIN_SIGNED_NUMBER.test(text.trimStart())) {
    return text;
  }
  return `'${text}`;
}

/**
 * Write one cell: null and undefined are empty, a formula is neutralised, and
 * the result is quoted if it needs it.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeCsvCell(value) {
  if (value === null || value === undefined) {
    return '';
  }
  // A finite number is a number whatever its sign; only text can carry a formula.
  const text =
    typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : neutraliseFormula(String(value));
  if (/["\n\r,]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}
