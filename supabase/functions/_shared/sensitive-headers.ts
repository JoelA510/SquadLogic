/**
 * The sensitive-header rule, server side: which import columns are never stored.
 *
 * Twin of `frontend/src/utils/gotsportCanonicalizer.js`, which strips the same
 * columns in the browser before upload. The browser filter alone protects
 * nothing from a caller who posts to `import-validation` directly, so the
 * function strips them again here before it stages a row
 * (docs/changes/2026-10-20-phase-a-privacy.md, A1). `tests/sensitiveHeaderParity.test.js`
 * holds the two lists equal; change both or neither.
 *
 * Matched case-insensitively against the trimmed header, minus any `__n`
 * dedupe suffix, with underscores and camelCase read as spaces.
 */

export const SENSITIVE_PATTERNS: readonly RegExp[] = [
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

/** Headers that would match a pattern but are kept. None since `players.paid` was dropped. */
export const ALLOWED_HEADERS: readonly RegExp[] = [];

/** The import types whose rows lose their sensitive columns (people, not fields). */
export const SENSITIVE_IMPORT_TYPES: readonly string[] = Object.freeze(['players', 'coaches']);

/** True when an import column must not be stored. */
export function isSensitiveHeader(header: unknown): boolean {
  if (header === null || header === undefined) return false;
  let h = String(header);
  if (h.charCodeAt(0) === 0xfeff) h = h.slice(1);
  h = h
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/__\d+$/, '')
    .replace(/_+/g, ' ');
  if (!h) return false;
  if (ALLOWED_HEADERS.some((re) => re.test(h))) return false;
  return SENSITIVE_PATTERNS.some((re) => re.test(h));
}

/** The row without its sensitive columns; every other key and value as given. */
export function stripSensitiveColumns(row: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!isSensitiveHeader(key)) kept[key] = value;
  }
  return kept;
}
