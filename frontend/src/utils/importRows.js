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
 * @param {(value: unknown) => string} [clean] - applied to the composed name (two capped parts
 *   can exceed the cap together)
 * @returns {Record<string, string>}
 */
export function composeFullName(row, clean = (v) => (v == null ? '' : String(v))) {
  if (!isBlank(row.full_name)) return row;
  const parts = [row.first_name, row.last_name]
    .filter((p) => !isBlank(p))
    .map((p) => String(p).trim());
  return parts.length ? { ...row, full_name: clean(parts.join(' ')) } : row;
}

/**
 * Remove every tag from `text`, by scanning. A tag runs from a `<` to the first `>` after it, exactly
 * the span a global regular-expression replace of that shape would take, so ordinary text (a lone
 * `<` or `>` as in "<1" or "5 > 3", which is data, not markup) comes out as it went in.
 *
 * Why a scan: that regular expression is what CodeQL's js/incomplete-multi-character-sanitization
 * flags, on the worry that removing a tag could join its neighbours into a new one. It cannot here,
 * and the scan makes that a property of the code rather than of an argument: a `<` with a `>` after it
 * always starts a span that is removed, so nothing that is left holds a `<` before a `>`
 * (`<<script>script>` leaves `script>`, `<scr<script>ipt>` leaves `ipt>`), and a second pass changes
 * nothing. `tests/importRowsParity.test.js` checks both over every short string. Linear: a `<` with no
 * `>` after it ends the scan, as no later `<` can have one either.
 * Twin of `stripTags` in `supabase/functions/_shared/import-rows.ts`.
 *
 * @param {string} text
 * @returns {string}
 */
function stripTags(text) {
  /** @type {string[]} */
  const kept = [];
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
 * characters out (tab, newline and carriage return stay), trimmed, capped. The Edge function's
 * `sanitizeString`, the mock `import-validation` and the preference preview all call this one
 * (twin: `supabase/functions/_shared/import-rows.ts`; `tests/importRowsParity.test.js` holds the two
 * equal), so what a preview says about a cell is what is staged.
 *
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string}
 */
export function sanitizeImportText(value, maxLength = 500) {
  if (value === null || value === undefined) return '';
  return (
    stripTags(String(value))
      // eslint-disable-next-line no-control-regex -- stripping control characters is the point
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim()
      .slice(0, maxLength)
  );
}
