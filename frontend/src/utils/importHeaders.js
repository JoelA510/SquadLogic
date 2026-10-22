/**
 * Import header resolution + diagnostics (pure module, safe to unit test).
 *
 * The browser import pipeline (ImportContext.jsx) parses a CSV with PapaParse,
 * drops sensitive columns, runs the Smart Header Matcher, then requires a small
 * set of canonical columns per import type. When that required-column check
 * fails, the most common real-world cause is NOT a missing alias but a parse
 * problem with the source file (wrong delimiter, BOM, embedded newlines /
 * quoting in long free-text columns) that prevented the header row from
 * splitting into clean columns. `describeHeaderParse` captures exactly what the
 * parser produced so the failure is diagnosable from `import_jobs.error_summary`
 * without re-running the file.
 */

/**
 * Canonical columns each import type must contain after header matching.
 * @type {Record<string, string[]>}
 */
export const REQUIRED_HEADERS = {
  players: ['first_name', 'last_name', 'date_of_birth'],
  coaches: ['full_name', 'email'],
  fields: ['location', 'name', 'type', 'start', 'end'],
  field_availability: ['season_label', 'location', 'name', 'available_from', 'available_until'],
};

/**
 * A required column the import can build from others when the file lacks it: a GotSport coach
 * export has First Name and Last Name but no full name, and import-validation composes it
 * (`supabase/functions/_shared/import-rows.ts`).
 * @type {Record<string, string[]>}
 */
export const COMPOSABLE_HEADERS = {
  full_name: ['first_name', 'last_name'],
};

/**
 * Resolve one raw header to its canonical name: prefer the matcher's mapping,
 * else fall back to a lowercased/trimmed copy of the raw header.
 * @param {Record<string, string>} mappings
 * @param {string} header
 * @returns {string}
 */
export function normalizeImportHeader(mappings, header) {
  return (
    (mappings && mappings[header]) ||
    String(header ?? '')
      .toLowerCase()
      .trim()
  );
}

/**
 * Required canonical columns that are absent from the parsed/matched headers.
 * @param {string[]} fields - parsed header names (post sensitive-column filter)
 * @param {string} type - import type key into REQUIRED_HEADERS
 * @param {Record<string, string>} mappings - matchHeaders() output
 * @returns {string[]}
 */
export function findMissingRequiredHeaders(fields, type, mappings) {
  const required = REQUIRED_HEADERS[type] || [];
  const normalized = (fields || []).map((h) => normalizeImportHeader(mappings, h));
  return required.filter((req) => {
    if (normalized.includes(req)) return false;
    const parts = COMPOSABLE_HEADERS[req];
    return !(parts && parts.every((part) => normalized.includes(part)));
  });
}

/**
 * Build a compact, PII-free diagnostic describing what PapaParse produced, so a
 * header-validation failure is debuggable from the persisted `error_summary`.
 *
 * Header NAMES / values are deliberately NOT included: a malformed upload (a
 * file saved without a header row, or collapsed by the wrong delimiter) can make
 * PapaParse treat a data row as the header, so echoing field values could
 * persist names / emails / DOBs into the database — exactly what the client-side
 * privacy filter exists to prevent. We emit only non-identifying shape signals
 * (counts, detected delimiter, parser-error text, header-length extremes).
 * @param {{ fields?: string[], meta?: { delimiter?: string }, parseErrors?: any[] }} input
 * @returns {Record<string, unknown>}
 */
export function describeHeaderParse({ fields = [], meta = {}, parseErrors = [] } = {}) {
  const list = Array.isArray(fields) ? fields : [];
  const lengths = list.map((h) => String(h ?? '').length);
  return {
    column_count: list.length,
    detected_delimiter: meta?.delimiter ?? null,
    parse_error_count: Array.isArray(parseErrors) ? parseErrors.length : 0,
    first_parse_error:
      Array.isArray(parseErrors) && parseErrors.length > 0
        ? String(parseErrors[0]?.message || parseErrors[0]?.code || parseErrors[0]).slice(0, 160)
        : null,
    // A lone, very long "column" is the signature of a wrong-delimiter / no-split
    // parse. Lengths carry no PII, unlike the header text itself.
    max_header_length: lengths.length ? Math.max(...lengths) : 0,
    min_header_length: lengths.length ? Math.min(...lengths) : 0,
  };
}
