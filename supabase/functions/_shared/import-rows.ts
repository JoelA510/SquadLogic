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

/**
 * Remove every tag from `text`, by scanning. A tag runs from a `<` to the first `>` after it, exactly
 * the span a global regular-expression replace of that shape would take, so ordinary text (a lone
 * `<` or `>` as in "<1" or "5 > 3", which is data, not markup) comes out as it went in. A scan rather
 * than that replace because CodeQL's js/incomplete-multi-character-sanitization flags it; here a `<`
 * with a `>` after it always starts a removed span, so nothing left holds a `<` before a `>`
 * (`<<script>script>` leaves `script>`) and a second pass changes nothing. Linear: a `<` with no `>`
 * after it ends the scan. Twin of `stripTags` in `frontend/src/utils/importRows.js`.
 */
function stripTags(text: string): string {
  const kept: string[] = [];
  let from = 0;
  let at = 0;
  while (at < text.length) {
    if (text.charCodeAt(at) !== 60) {
      at += 1;
      continue;
    }
    const close = text.indexOf('>', at + 1);
    if (close === -1) break;
    kept.push(text.slice(from, at));
    at = close + 1;
    from = at;
  }
  kept.push(text.slice(from));
  return kept.join('');
}

/**
 * The cleaner every imported cell passes through: tags out, control
 * characters out (tab, newline and carriage return stay), trimmed, capped. `import-validation`'s
 * `sanitizeString` is this with its own cap; twin: `frontend/src/utils/importRows.js`, held equal by
 * `tests/importRowsParity.test.js`.
 */
export function sanitizeImportText(value: unknown, maxLength = 500): string {
  if (value === null || value === undefined) return '';
  return (
    stripTags(String(value))
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim()
      .slice(0, maxLength)
  );
}
