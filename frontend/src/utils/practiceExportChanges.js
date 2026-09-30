/**
 * How many exported practices have temporary changes the export does not show
 * (8.6 3b PR 12c, plan §4 R9, operator answer Q6).
 *
 * The CSV export and the coach email drafts stay **series-level**: one row per
 * practice assignment, weekday and time. A saved practice exception (a move,
 * or a TIME TBD window) is not shown in them. So the export says how many
 * practices it lists as their series that are in fact changed, a count taken
 * from `applyPracticeExceptions`' own `meta.datesSuppressed` (the series
 * dates the helper no longer shows as their series), never restated here.
 *
 * **Declared (D4):** a TIME TBD date after a row's own range (a tail window)
 * is not one of the export's series dates, so it is not in this count.
 *
 * @module utils/practiceExportChanges
 */

import { applyPracticeExceptions } from '@squadlogic/core/utils/practiceExceptions.js';
import { fetchAllPages } from '../lib/pagedFetch.js';

/** The columns the helper reads to decide which series dates an exception changes. */
export const EXPORT_PRACTICE_EXCEPTIONS_SELECT =
  'id, assignment_id, window, kind, tbd_reason, withdrawn_at';

/** Said when the exceptions cannot be read: never "no changes" by default (Q5). */
export const EXPORT_PRACTICE_CHANGES_UNREAD_TEXT =
  'Practice changes could not be read, so this export may list practices that have moved or have no confirmed time.';

/**
 * The export's practice rows (`usePracticeAssignments`, camelCased) as the
 * helper reads stored rows. A row with no id can be named by no exception.
 *
 * @param {Array<Record<string, any>>} assignments
 */
function helperRowsOf(assignments) {
  return (Array.isArray(assignments) ? assignments : [])
    .filter((a) => a && a.id != null)
    .map((a) => {
      const slot = a.practiceSlots ?? a.practice_slots ?? null;
      return {
        id: a.id,
        effective_date_range: a.effectiveDateRange ?? a.effective_date_range,
        slot: slot ? { day_of_week: slot.dayOfWeek ?? slot.day_of_week } : null,
      };
    });
}

/**
 * The count, from rows and exceptions already read. Exceptions on rows the
 * export does not hold are left out rather than reported as unread rows: the
 * read is by organization, and another run's rows are not this export's.
 *
 * @param {Array<Record<string, any>>} assignments
 * @param {Array<Record<string, any>>} exceptions
 * @returns {number}
 */
export function unshownPracticeChangesOf(assignments, exceptions) {
  const rows = helperRowsOf(assignments);
  const ids = new Set(rows.map((r) => String(r.id)));
  const mine = exceptions.filter((e) => ids.has(String(e?.assignment_id)));
  return applyPracticeExceptions({ rows, exceptions: mine }).meta.datesSuppressed;
}

/**
 * Read the organization's exceptions and count. Never throws.
 *
 * @param {any} client - the supabase client, or null
 * @param {Array<Record<string, any>>} assignments
 * @returns {Promise<{ ok: true, count: number } | { ok: false }>}
 */
export async function readUnshownPracticeChanges(client, assignments) {
  const rows = helperRowsOf(assignments);
  if (rows.length === 0) return { ok: true, count: 0 };
  const orgIds = [
    ...new Set(
      assignments.map((a) => a?.organizationId ?? a?.organization_id).filter((id) => id != null)
    ),
  ];
  // Rows that name no organization cannot be scoped; that is a failed read,
  // not an empty one.
  if (orgIds.length === 0 || typeof client?.from !== 'function') return { ok: false };
  try {
    const reads = await Promise.all(
      orgIds.map((orgId) =>
        fetchAllPages(() =>
          client
            .from('practice_exceptions')
            .select(EXPORT_PRACTICE_EXCEPTIONS_SELECT)
            .eq('organization_id', orgId)
        )
      )
    );
    return { ok: true, count: unshownPracticeChangesOf(assignments, reads.flat()) };
  } catch {
    return { ok: false };
  }
}

/**
 * The export message's sentence, or null when there is nothing to say.
 *
 * @param {{ ok: true, count: number } | { ok: false }} result
 * @returns {string | null}
 */
export function practiceChangesNoteOf(result) {
  if (!result.ok) return EXPORT_PRACTICE_CHANGES_UNREAD_TEXT;
  if (result.count === 0) return null;
  return result.count === 1
    ? '1 practice has temporary changes not shown in this export.'
    : `${result.count} practices have temporary changes not shown in this export.`;
}
