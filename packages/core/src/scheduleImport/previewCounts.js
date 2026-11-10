/**
 * The counts an admin confirms, and whether an apply would still do what was confirmed (plan
 * `docs/changes/2026-11-03-schedule-expansion.md`, PR 6, task F7: preview-stale protection).
 *
 * The confirm screen shows the result of `apply_game_import_job(job, dry_run => true)`. Between that
 * preview and the confirm another admin can change the schedule, and the apply plans again against the
 * state it finds: its counts can differ from the ones on screen. So the confirm sends the counts it
 * showed, the Edge function (`import-validation`, `action: 'apply'`) runs the dry run again, and when
 * the two differ it refuses with `game_import_preview_stale`, both sets of counts, and writes nothing.
 *
 * ## Which counts
 *
 * Every count the confirm screen shows, read from ONE place (this function) by the screen, the mock
 * and the Edge function's mirror (`supabase/functions/_shared/schedule-import.ts`,
 * `tests/gameImportEdgeParity.test.js`):
 *
 * - `arrive_published`, `nothing_to_apply`
 * - `rows.staged`, `rows.refused`, `rows.skipped`, `rows.games`, `rows.time_tbd`
 * - `refused_by_reason.<code>` for every reason with a row
 * - `games.inserted`, `games.updated`, `games.unchanged`, and `games.skipped.<reason>` for every reason
 * - `time_tbd.inserted`, `time_tbd.updated`, `time_tbd.unchanged`, `time_tbd.removed`, `time_tbd.converted`
 * - `created.divisions`, `created.venues`, `created.fields`, `created.teams`, `created.outside_teams`, `created.slots`
 * - `not_in_file` (games in the schedule that the file does not name)
 * - `warnings.<type>` for every warning type, by its count
 *
 * Not compared, because the screen does not show them: `games.repointed` and `reused.slots` (how the
 * apply carries games it does not change), the listed rows (capped at 200), and the ids.
 *
 * A count that is absent reads as zero, so a result with no warnings and one that lists none agree.
 */

const FIXED = Object.freeze({
  rows: ['staged', 'refused', 'skipped', 'games', 'time_tbd'],
  games: ['inserted', 'updated', 'unchanged'],
  time_tbd: ['inserted', 'updated', 'unchanged', 'removed', 'converted'],
  created: ['divisions', 'venues', 'fields', 'teams', 'outside_teams', 'slots'],
});

/** The most keys a set of confirmed counts may hold (a request is refused past it). */
export const SCHEDULE_IMPORT_CONFIRM_MAX_KEYS = 120;

/** @param {unknown} value */
const count = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
/** @param {unknown} value @returns {Record<string, unknown>} */
const record = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};

/**
 * The counts of a preview (or an apply) result, flat, as the confirm screen shows them.
 *
 * @param {unknown} result  what `apply_game_import_job` returned
 * @returns {Record<string, number | boolean>}
 */
export function scheduleImportConfirmCounts(result) {
  const r = record(result);
  /** @type {Record<string, number | boolean>} */
  const out = {
    arrive_published: r.arrive_published === true,
    nothing_to_apply: r.nothing_to_apply === true,
  };
  for (const [group, keys] of Object.entries(FIXED)) {
    const source = record(r[group]);
    for (const key of keys) out[`${group}.${key}`] = count(source[key]);
  }
  for (const [reason, n] of Object.entries(record(r.refused_by_reason))) {
    if (count(n) !== 0) out[`refused_by_reason.${reason}`] = count(n);
  }
  for (const [reason, n] of Object.entries(record(record(r.games).skipped))) {
    if (count(n) !== 0) out[`games.skipped.${reason}`] = count(n);
  }
  out.not_in_file = count(record(r.not_in_file).count);
  for (const warning of Array.isArray(r.warnings) ? r.warnings : []) {
    const type = String(record(warning).type ?? 'unknown');
    out[`warnings.${type}`] = count(out[`warnings.${type}`]) + 1;
  }
  return out;
}

/**
 * Whether a value is a set of confirmed counts as {@link scheduleImportConfirmCounts} makes one: a flat
 * object of numbers and booleans, with the two flags and at least `rows.staged`. The Edge function
 * refuses a confirm that sends anything else (a confirm with no counts would compare nothing).
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isScheduleImportConfirmCounts(value) {
  const r = record(value);
  const keys = Object.keys(r);
  if (keys.length === 0 || keys.length > SCHEDULE_IMPORT_CONFIRM_MAX_KEYS) return false;
  if (typeof r.arrive_published !== 'boolean' || typeof r.nothing_to_apply !== 'boolean')
    return false;
  if (typeof r['rows.staged'] !== 'number') return false;
  return keys.every(
    (key) =>
      key.length <= 80 &&
      (typeof r[key] === 'boolean' || (typeof r[key] === 'number' && Number.isFinite(r[key])))
  );
}

/**
 * The counts that differ between what was confirmed and what the apply would do now.
 *
 * @param {Record<string, number | boolean>} confirmed
 * @param {Record<string, number | boolean>} current
 * @returns {string[]} the keys that differ, sorted; empty when the two agree
 */
export function diffScheduleImportConfirmCounts(confirmed, current) {
  const a = record(confirmed);
  const b = record(current);
  /** @param {unknown} v */
  const norm = (v) => (typeof v === 'boolean' ? v : count(v));
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => norm(a[key] ?? 0) !== norm(b[key] ?? 0))
    .sort();
}
