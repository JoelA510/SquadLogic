/**
 * GotSport registration import — client-side privacy filter.
 *
 * SquadLogic only needs the data required for teaming and scheduling. Per the
 * project's data-minimization rules we strip sensitive registration columns —
 * medical, insurance, financial / payment, identity documents, waivers /
 * signatures, and non-teaming demographics — on the client BEFORE upload, so
 * they never leave the browser. The import allowlist
 * (`importAllowlist.js`) then keeps only the columns SquadLogic uses; this
 * filter stays as the first, pattern-based pass.
 *
 * Everything this filter keeps passes through with its ORIGINAL header name
 * intact, so the downstream recognition pipeline (column mapping, edge
 * validation, finalize RPC) is unchanged by it. Pure module — safe to unit
 * test in isolation.
 */

function clean(value) {
  if (value === null || value === undefined) return '';
  // Strip a leading UTF-8 BOM so a byte-order mark on the first CSV header
  // (common in GotSport / Excel exports) never breaks header recognition.
  let s = String(value);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s.trim();
}

/**
 * PapaParse `transformHeader` that disambiguates duplicate headers (GotSport
 * repeats "Playing Up" and "Preferred Co-Coach" once per coached player). The
 * 2nd+ occurrence of any header gets a `__n` suffix so row keys never collide.
 * Returns a fresh transformer (stateful per parse).
 *
 * @returns {(header: string) => string}
 */
export function makeDedupeHeaderTransformer() {
  const counts = new Map();
  return (header, index) => {
    // PapaParse invokes transformHeader twice over the header row (it runs the
    // header pass more than once). The counter is reset on the first column so
    // each pass dedupes independently — otherwise every UNIQUE header is
    // spuriously suffixed `__2` on the second pass, which silently breaks all
    // header recognition and fails every import at validation.
    if (index === 0) counts.clear();
    const h = clean(header);
    const key = h.toLowerCase();
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return n === 1 ? h : `${h}__${n}`;
  };
}

/**
 * Header substrings that mark a column as sensitive / out-of-scope to store.
 * Matched case-insensitively against the trimmed header (minus any `__n`
 * dedupe suffix, with underscores and camelCase read as spaces so `medical_info`,
 * `MedicalInfo` and `emergency_contacts` match as their spaced forms do).
 *
 * The import-validation Edge Function applies the same rule server-side, from
 * its twin `supabase/functions/_shared/sensitive-headers.ts`;
 * `tests/sensitiveHeaderParity.test.js` holds the two lists equal. Kept deliberately specific — e.g. `birth certificate`, not
 * `birth` — so teaming-relevant fields like Date of Birth, Division, Skill
 * Level, Registration ID and guardian contacts are never dropped.
 * @type {RegExp[]}
 */
export const SENSITIVE_PATTERNS = [
  // Medical / health
  /\bmedical\b/,
  /medication/,
  /allerg/,
  /\bhealth\b/,
  /\billness\b/,
  /\bdisease\b/,
  /disabilit/,
  /diagnos/,
  /\bdoctor\b/,
  /physician/,
  /\bhospital\b/,
  /prescription/,
  /immuniz/,
  /vaccin/,
  /\binjur/,
  /epi[\s-]?pen/,
  /\basthma\b/,
  // Insurance
  /insurance/,
  /policy\s*(number|no\.?|#)/,
  // Financial / payment
  /payment/,
  /\bpaid\b/,
  /\bunpaid\b/,
  /financial/,
  /\bfinance\b/,
  /\bfees?\b/,
  /\bbalance\b/,
  /\bamount\b/,
  /\binvoice\b/,
  /scholarship/,
  /\brefund\b/,
  /\bdiscount\b/,
  /credit\s*card/,
  /card\s*(number|no\.?|#)/,
  /\bcvv\b/,
  /\bbank\b/,
  /\brouting\b/,
  /account\s*(number|no\.?|#)/,
  /\bowe[ds]?\b/,
  /\btuition\b/,
  /\bprice\b/,
  // Identity documents
  /social\s*security/,
  /\bssn\b/,
  /\btax\s*id\b/,
  /birth\s*certificate/,
  /\bpassport\b/,
  /driver'?s?\s*licen[sc]e/,
  /\bdocument/,
  /\bupload/,
  /attachment/,
  /proof\s*of/,
  // Non-teaming demographics
  /ethnicit/,
  /\brace\b/,
  /household\s*income/,
  /\bincome\b/,
  /\breligion\b/,
  // Waivers / consent forms / signatures
  /waiver/,
  /release\s*form/,
  /\bconsent\b/,
  /acknowledg/,
  /signature/,
  /e[\s-]?signature/,
  /terms\s*(and|&)?\s*conditions?/,
  /agree.*terms/,
  // Emergency contacts (not needed for teaming/scheduling — data minimization)
  /emergency/,
  // Conditions and needs a registration form collects free-text (owner decision
  // 2026-10-20: no medical data of any kind; docs/changes/2026-10-20-phase-a-privacy.md)
  /\bconditions?\b/,
  /special\s*needs?/,
];

/**
 * Headers that would match a SENSITIVE_PATTERN but are explicitly kept.
 * "Payment Status" is a PAID/UNPAID flag (no amounts, plans, or instruments);
 * everything else financial — Payment Plan, amounts, balances, card data —
 * stays stripped. Nothing stores it since `players.paid` was dropped
 * (20261022020000): the import allowlist drops it after this filter.
 * @type {RegExp[]}
 */
export const ALLOWED_HEADERS = [/^payment\s*status$/];

/** The import types whose rows lose their sensitive columns (people, not fields). */
export const SENSITIVE_IMPORT_TYPES = Object.freeze(['players', 'coaches']);

/**
 * True when a CSV header names a sensitive / out-of-scope column that must be
 * dropped before upload.
 * @param {string} header
 * @returns {boolean}
 */
export function isSensitiveHeader(header) {
  const h = clean(header)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/__\d+$/, '')
    .replace(/_+/g, ' ');
  if (!h) return false;
  if (ALLOWED_HEADERS.some((re) => re.test(h))) return false;
  return SENSITIVE_PATTERNS.some((re) => re.test(h));
}

/**
 * Drop sensitive columns from each parsed row, preserving original header names
 * and all other (teaming-relevant) fields. Recognition of the kept columns is
 * unchanged from the legacy pipeline.
 * @param {Array<Record<string, unknown>>} rows
 * @returns {Array<Record<string, unknown>>}
 */
export function stripSensitiveColumns(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    /** @type {Record<string, unknown>} */
    const kept = {};
    for (const [key, value] of Object.entries(row ?? {})) {
      if (!isSensitiveHeader(key)) kept[key] = value;
    }
    return kept;
  });
}

/**
 * Privacy filter applied to player/coach imports before upload: returns rows
 * with sensitive columns removed (original headers otherwise intact). Other
 * import types (fields / field_availability) pass through untouched.
 *
 * @param {('players'|'coaches'|string)} importType
 * @param {Array<Record<string, unknown>>} rows - rows keyed by (deduped) headers
 * @returns {Array<Record<string, unknown>>}
 */
export function canonicalizeForUpload(importType, rows) {
  if (!Array.isArray(rows)) return [];
  if (SENSITIVE_IMPORT_TYPES.includes(importType)) {
    return stripSensitiveColumns(rows);
  }
  return rows;
}
