/**
 * How full each practice slot is from the season's today on, for the override
 * panel's "Avail" count (M4.7, `docs/PLAN_SCORING_DATE_MODEL.md` §3.5, Q5).
 *
 * The panel used to count every row naming a slot, so a series closed last
 * week (#541, #546: an override closes the old series and starts a new one)
 * still consumed the slot it had left. An override starts today, so the load
 * that matters is the busiest date from today on, read through the same
 * dated rule the scoring engines use (`@squadlogic/core/utils/practiceLiveDates.js`).
 *
 * A row whose range does not read is counted as holding the slot on every
 * remaining date: an unknown range is never shown as a free place.
 *
 * @module utils/overrideSlotLoad
 */

import {
  LIVE_SPAN_STATUS,
  assignmentLiveSpan,
  calendarDayNumber,
  peakLiveCount,
} from '@squadlogic/core/utils/practiceLiveDates.js';

/**
 * @param {{
 *   slots: Array<{ id: string, firstDate: string, lastDate: string }>,
 *   assignments: Array<{ slotId: string | null, effectiveDateRange?: string | null }>,
 *   seasonToday: string | null,
 * }} input - `seasonToday` is the season's date (`seasonCalendarDate`), or
 *   `null` before the clock is read, which counts the whole validity.
 * @returns {Map<string, number | null>} slot id -> teams holding it on its
 *   busiest date from `seasonToday` on; `null` for a slot with no date left
 *   from `seasonToday` (its validity has ended: nothing can be placed there);
 *   a slot whose dates do not read maps to its row count, as before.
 */
export function overrideSlotLoad({ slots, assignments, seasonToday }) {
  const rowsBySlot = new Map();
  for (const assignment of assignments) {
    if (!assignment.slotId) continue;
    const rows = rowsBySlot.get(assignment.slotId) ?? [];
    rows.push(assignment);
    rowsBySlot.set(assignment.slotId, rows);
  }

  const load = new Map();
  for (const slot of slots) {
    const rows = rowsBySlot.get(slot.id) ?? [];
    const firstDay = calendarDayNumber(slot.firstDate);
    const lastDay = calendarDayNumber(slot.lastDate);
    if (firstDay === null || lastDay === null) {
      load.set(slot.id, rows.length);
      continue;
    }
    const remaining = assignmentLiveSpan({ firstDay, lastDay, notBefore: seasonToday });
    if (remaining.status !== LIVE_SPAN_STATUS.LIVE) {
      load.set(slot.id, null);
      continue;
    }
    const spans = [];
    for (const row of rows) {
      const span = assignmentLiveSpan({
        firstDay,
        lastDay,
        range: row.effectiveDateRange,
        notBefore: seasonToday,
      });
      if (span.status === LIVE_SPAN_STATUS.LIVE) {
        spans.push(span);
      } else if (span.status === LIVE_SPAN_STATUS.UNREADABLE) {
        spans.push(remaining);
      }
    }
    load.set(slot.id, peakLiveCount(spans));
  }
  return load;
}
