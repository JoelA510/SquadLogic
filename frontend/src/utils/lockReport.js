/**
 * The auto-scheduler's lock report (M4.8, `docs/PLAN_SOLVER_DATE_MODEL.md`
 * §3.3), as one status line.
 *
 * Every saved practice is locked, and the solver holds each one only on its
 * own dates. Two kinds of row are worth saying so about:
 *
 * - **A saved range that could not be read** (`unreadableRange`): the run held
 *   that practice's slot for the whole season rather than guess (Q2), so a
 *   slot it does not really use may have been kept from other teams. The
 *   operator can re-save the practice with its dates. This is the actionable
 *   one, so it comes first.
 * - **A practice that has ended** (`endedRows`): it holds nothing from today,
 *   so the slot it used was offered to other teams.
 *
 * @module utils/lockReport
 */

/** Ids named before the rest are counted. */
const NAMED = 3;

/**
 * @param {string[]} ids
 * @returns {string}
 */
function listSome(ids) {
  const named = ids.slice(0, NAMED).join(', ');
  return ids.length > NAMED ? `${named} and ${ids.length - NAMED} more` : named;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
const idsOf = (value) =>
  Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id !== '') : [];

/**
 * @param {{ unreadableRange?: unknown, endedRows?: unknown }|null|undefined} lock
 * @returns {string|null} the line to show, or `null` when there is nothing to say
 */
export function describeLockReport(lock) {
  if (!lock) return null;
  const lines = [];
  const unreadable = idsOf(lock.unreadableRange);
  if (unreadable.length > 0) {
    const one = unreadable.length === 1;
    lines.push(
      `${unreadable.length} saved practice${one ? ' has a date range' : 's have date ranges'} ` +
        `that could not be read, so ${one ? 'its slot was' : 'their slots were'} held for the ` +
        `whole season: ${listSome(unreadable)}. Save ${one ? 'it' : 'them'} again with ` +
        `${one ? 'its' : 'their'} dates to free the weeks ${one ? 'it does' : 'they do'} not use.`
    );
  }
  const ended = idsOf(lock.endedRows);
  if (ended.length > 0) {
    const one = ended.length === 1;
    lines.push(
      `${ended.length} saved practice${one ? ' has' : 's have'} ended, so ` +
        `${one ? 'its slot was' : 'their slots were'} offered to other teams from today.`
    );
  }
  return lines.length > 0 ? lines.join(' ') : null;
}
