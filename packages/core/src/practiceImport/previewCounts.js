/**
 * The counts of a practice import's preview, as the Practices tab shows them and its confirm carries them (plan
 * `docs/changes/2026-11-03-schedule-expansion.md` 4.11.4; PR 11, task L2): the dry run's own `counts`
 * (`apply_practice_import_job`, migration `20261123010000`), copied, never computed again here. The sibling of
 * `scheduleImport/previewCounts.js`. A small module of its own so the Import panel can show the counts without loading
 * the practice import's mapping.
 */

/**
 * @param {any} result  a result of `apply_practice_import_job`
 * @returns {Record<string, number>} the numeric counts of the result, by key, in key order
 */
export function practiceImportConfirmCounts(result) {
  const counts = result?.counts && typeof result.counts === 'object' ? result.counts : {};
  return Object.fromEntries(
    Object.entries(counts)
      .filter(([, value]) => typeof value === 'number')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  );
}

/**
 * The keys whose counts differ between two sets of confirm counts.
 *
 * @param {Record<string, number>} a
 * @param {Record<string, number>} b
 * @returns {string[]}
 */
export function diffPracticeImportConfirmCounts(a, b) {
  const keys = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].sort();
  return keys.filter((key) => Number(a?.[key] ?? 0) !== Number(b?.[key] ?? 0));
}
