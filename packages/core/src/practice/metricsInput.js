/**
 * The one seam between the recurring-practice model and the practice metrics.
 *
 * `practiceMetrics.evaluatePracticeSchedule()` — the report the live Apply path
 * computes (`utils/practiceRunResults.js`) — reads slots as **instants**
 * (`start`/`end`) plus a `day` label. This model holds minutes past midnight
 * and `YYYY-MM-DD` and constructs no `Date` (8.5's rule). Something has to
 * cross that seam to measure a repaired plan with the metrics production
 * reads, and this module is the only place that does.
 *
 * ## The conversion, and the one it refuses to be
 *
 * Wall readings are composed on the **season's clock** through
 * `timing/seasonClock.js` `requireZonedInstant()`, with the caller's IANA
 * zone. Never `utils/date.js` `applyMinutesToDate()`: that uses
 * `setUTCHours`, so a 17:00 practice would become 17:00 UTC — the hazard the
 * 8.5 plan names. A missing zone is refused rather than defaulted.
 *
 * ## A weekly series becomes one representative occurrence
 *
 * Each series active on `asOf` is represented by its first occurrence on or
 * after `asOf`. Every series therefore lands in the same seven-day window, so
 * two series on one weekday overlap as instants exactly when they overlap as
 * wall times, which is what the metrics' coach-conflict check needs; and two
 * series on different weekdays never do.
 *
 * @module practice/metricsInput
 */

import { requireZonedInstant } from '../timing/seasonClock.js';
import { firstWeekdayOnOrAfter } from './slots.js';

/** Display labels only; the weekday codes stay `practice/`'s one vocabulary. */
const DAY_LABEL = Object.freeze({
  SUN: 'Sunday',
  MON: 'Monday',
  TUE: 'Tuesday',
  WED: 'Wednesday',
  THU: 'Thursday',
  FRI: 'Friday',
  SAT: 'Saturday',
});

/**
 * Whether a series' effective range covers a date.
 *
 * @param {{ from: string|null, until: string|null }} range
 * @param {string} date
 * @returns {boolean}
 */
function covers(range, date) {
  if (range.from === null || range.until === null) return false;
  return range.from <= date && date <= range.until;
}

/**
 * The plan in force on `asOf`, as `evaluatePracticeSchedule()` input.
 *
 * Series with no stated range are **not** in force on any date; they are
 * returned in `undated` rather than dropped, so a caller counting what it
 * measured can see what it did not.
 *
 * @param {Pick<import('./types.js').PracticeSlotSet, 'slots' | 'assignments'>} slotSet
 * @param {{ asOf: string, timeZone: string }} options
 * @returns {{
 *   slots: Array<{ id: string, start: string, end: string, capacity: number, day: string, baseSlotId: string }>,
 *   assignments: Array<{ teamId: string, slotId: string }>,
 *   undated: string[],
 *   dangling: string[],
 * }}
 */
export function toPracticeMetricsInput(slotSet, { asOf, timeZone }) {
  if (typeof timeZone !== 'string' || timeZone.length === 0) {
    throw new Error(
      'practice: toPracticeMetricsInput needs the season timezone; it will not assume one'
    );
  }
  const slotById = new Map(slotSet.slots.map((slot) => [slot.id, slot]));
  const usedSlotIds = new Set();
  const assignments = [];
  const undated = [];
  const dangling = [];
  for (const assignment of slotSet.assignments) {
    const slot = slotById.get(assignment.slotId);
    if (!slot) {
      dangling.push(assignment.id);
      continue;
    }
    const range = {
      from: assignment.effectiveFrom ?? slot.validFrom,
      until: assignment.effectiveUntil ?? slot.validUntil,
    };
    if (range.from === null || range.until === null) {
      undated.push(assignment.id);
      continue;
    }
    if (!covers(range, asOf)) continue;
    usedSlotIds.add(slot.id);
    assignments.push({ teamId: assignment.teamId, slotId: slot.id });
  }
  const slots = [...usedSlotIds].sort().map((slotId) => {
    const slot = /** @type {import('./types.js').PracticeSlot} */ (slotById.get(slotId));
    const date = firstWeekdayOnOrAfter(asOf, slot.weekday);
    const label = `practice slot ${slot.id}`;
    return {
      id: slot.id,
      start: requireZonedInstant({ date, time: slot.startMinutes, timeZone, label }),
      end: requireZonedInstant({
        date,
        time: slot.startMinutes + slot.durationMinutes,
        timeZone,
        label,
      }),
      capacity: slot.capacity,
      // The live Apply path labels days in full ('Tuesday'); matching it keeps
      // day-keyed breakdowns comparable with the reports production shows.
      day: DAY_LABEL[slot.weekday],
      baseSlotId: slot.id,
    };
  });
  return { slots, assignments, undated, dangling };
}
