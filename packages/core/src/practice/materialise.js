/**
 * Turning a recurring plan into the concrete practices it implies.
 *
 * **Occurrences are computed on demand and never stored as truth.** The plan
 * is the slot plus its dated overrides; a list of dates is a *view* of that
 * plan over a window, and two calls with the same inputs give the same answer.
 * This is the half the prompt asks for that did not exist:
 * `practiceSlotExpansion.js` splits a slot across *season phases* and anchors
 * each piece to the first matching weekday in the phase — one record per
 * (slot, phase). It never enumerates the Tuesdays, and its `seasonOverrides`
 * are keyed by phase id, so it has no concept of a dated exception at all.
 *
 * **Nothing here constructs a `Date`.** Dates are `YYYY-MM-DD`, times are
 * minutes past local midnight, and the walk is integer arithmetic on day
 * numbers. The output is deliberately the `FacilityBooking` shape
 * (`facility/schemas.js:131-146`), so an occurrence goes straight into
 * `checkOccupancy()` or `findClosureBreaches()` without an adapter — and so
 * that venue closures stay the facility layer's job rather than being
 * re-modelled here. A slot's own exceptions (rain-out, holiday) are the slot's;
 * a venue being shut is the venue's.
 *
 * @module practice/materialise
 */

import { deepFreeze } from '../facility/facilityGraph.js';
import { isoDateOfDayNumber, isoDayNumber } from '../facility/eligibility.js';

import { PRACTICE_REASON, derivePracticeStatus, makePracticeFinding } from './reasonCodes.js';
import { PRACTICE_EXCEPTION_KIND, PracticeWindowSchema } from './schemas.js';
import { firstWeekdayOnOrAfter } from './slots.js';

/** The later of two ISO dates. */
const laterOf = (a, b) => (a > b ? a : b);
/** The earlier of two ISO dates. */
const earlierOf = (a, b) => (a < b ? a : b);

/**
 * Teams holding a slot on a date.
 *
 * An assignment with no range of its own inherits the slot's, which is why
 * this takes the slot rather than only the assignment.
 *
 * @param {import('./types.js').PracticeSlotSet} slotSet
 * @param {import('./types.js').PracticeSlot} slot
 * @param {string} date
 * @returns {string[]}
 */
function teamsOn(slotSet, slot, date) {
  /** @type {string[]} */
  const teams = [];
  for (const assignment of slotSet.assignments) {
    if (assignment.slotId !== slot.id) continue;
    const from = assignment.effectiveFrom ?? slot.validFrom;
    const until = assignment.effectiveUntil ?? slot.validUntil;
    if (from !== null && date < from) continue;
    if (until !== null && date > until) continue;
    if (!teams.includes(assignment.teamId)) teams.push(assignment.teamId);
  }
  return teams.sort();
}

/**
 * Materialise every practice a plan implies inside a window.
 *
 * Exceptions are applied **as overrides, never as edits**: the slot is
 * untouched, and each override reports itself. A cancelled date is removed
 * *and* reported (`PRACTICE_OCCURRENCE_SUPPRESSED`), because a practice that
 * silently vanishes is the failure `CLAUDE.md` §3 names outright.
 *
 * An exception dated inside the window that matches no occurrence is reported
 * (`PRACTICE_EXCEPTION_UNMATCHED`) — usually a cancellation aimed at the wrong
 * slot, which means a practice somebody believes is off is still on. An
 * exception dated *outside* the window is not unmatched, merely out of scope,
 * and is silent: reporting it would make every one-month call complain about
 * the other eleven.
 *
 * @param {import('./types.js').PracticeSlotSet} slotSet
 * @param {{ from: string, to: string, exceptions?: Array<Object> }} window
 * @returns {import('./types.js').PracticeMaterialisation}
 */
export function materialisePracticeOccurrences(slotSet, window) {
  const parsed = PracticeWindowSchema.parse(window);
  const { from, to } = parsed;
  const exceptions = /** @type {import('./types.js').PracticeException[]} */ (parsed.exceptions);

  /** @type {import('./types.js').PracticeFinding[]} */
  const findings = [];

  /** `slotId\u0000date` -> the exceptions naming it. */
  const exceptionIndex = new Map();
  for (const exception of exceptions) {
    const key = `${exception.slotId}\u0000${exception.date}`;
    const list = exceptionIndex.get(key);
    if (list) list.push(exception);
    else exceptionIndex.set(key, [exception]);
  }
  /** Exception ids that reached an occurrence. */
  const applied = new Set();

  /** @type {import('./types.js').PracticeOccurrence[]} */
  const occurrences = [];
  let suppressedCount = 0;
  let movedCount = 0;
  let shortenedCount = 0;

  for (const slot of slotSet.slots) {
    // An undated slot materialises to nothing. `buildPracticeSlotSet()` has
    // already said so once per revision; repeating it per slot per call would
    // bury the plan's real findings under 457 copies of one fact.
    if (slot.validFrom === null || slot.validUntil === null) continue;

    const start = laterOf(slot.validFrom, from);
    const end = earlierOf(slot.validUntil, to);
    if (start > end) continue;

    const endDay = isoDayNumber(end);
    for (
      let day = isoDayNumber(firstWeekdayOnOrAfter(start, slot.weekday));
      day <= endDay;
      day += 7
    ) {
      const date = isoDateOfDayNumber(day);
      const onThisDate = exceptionIndex.get(`${slot.id}\u0000${date}`) ?? [];

      const cancellation = onThisDate.find(
        (exception) => exception.kind === PRACTICE_EXCEPTION_KIND.CANCELLED
      );
      if (cancellation) {
        applied.add(cancellation.id);
        suppressedCount += 1;
        findings.push(
          makePracticeFinding(
            PRACTICE_REASON.OCCURRENCE_SUPPRESSED,
            `${date}: the ${slot.weekday} practice on ${slot.surfaceId} does not happen — ${cancellation.reason}`,
            {
              slotId: slot.id,
              date,
              exceptionId: cancellation.id,
              reason: cancellation.reason,
              surfaceId: slot.surfaceId,
            }
          )
        );
        // Anything else aimed at this date could not apply: there is no
        // occurrence left to move or shorten. Left out of `applied`, so the
        // unmatched sweep below reports it.
        continue;
      }

      let startMinutes = slot.startMinutes;
      let durationMinutes = slot.durationMinutes;
      /** @type {string|null} */
      let exceptionId = null;

      for (const exception of onThisDate) {
        if (exception.kind === PRACTICE_EXCEPTION_KIND.MOVED) {
          startMinutes = /** @type {number} */ (exception.startMinutes);
          movedCount += 1;
          findings.push(
            makePracticeFinding(
              PRACTICE_REASON.OCCURRENCE_MOVED,
              `${date}: the practice on ${slot.surfaceId} starts at ${startMinutes} minutes instead of ${slot.startMinutes} — ${exception.reason}`,
              { slotId: slot.id, date, exceptionId: exception.id, reason: exception.reason }
            )
          );
        } else if (exception.kind === PRACTICE_EXCEPTION_KIND.SHORTENED) {
          durationMinutes = /** @type {number} */ (exception.durationMinutes);
          shortenedCount += 1;
          findings.push(
            makePracticeFinding(
              PRACTICE_REASON.OCCURRENCE_SHORTENED,
              `${date}: the practice on ${slot.surfaceId} runs ${durationMinutes} minutes instead of ${slot.durationMinutes} — ${exception.reason}`,
              { slotId: slot.id, date, exceptionId: exception.id, reason: exception.reason }
            )
          );
        }
        applied.add(exception.id);
        exceptionId = exception.id;
      }

      occurrences.push({
        id: `${slot.id}@${date}`,
        surfaceId: slot.surfaceId,
        date,
        startMinutes,
        endMinutes: startMinutes + durationMinutes,
        // Present so the shape matches `FacilityBooking` exactly; a practice
        // has no game format.
        format: null,
        label: slot.label,
        slotId: slot.id,
        revisionId: slot.revisionId,
        teamIds: teamsOn(slotSet, slot, date),
        exceptionId,
      });
    }
  }

  /* -- exceptions that reached nothing ------------------------------------ */

  const slotIds = new Set(slotSet.slotIds);
  let exceptionsUnmatched = 0;
  for (const exception of exceptions) {
    if (applied.has(exception.id)) continue;
    if (!slotIds.has(exception.slotId)) {
      exceptionsUnmatched += 1;
      findings.push(
        makePracticeFinding(
          PRACTICE_REASON.EXCEPTION_UNKNOWN_SLOT,
          `exception "${exception.id}" names slot "${exception.slotId}", which this plan does not hold`,
          { exceptionId: exception.id, slotId: exception.slotId, date: exception.date }
        )
      );
      continue;
    }
    // Outside the window is out of scope, not unmatched.
    if (exception.date < from || exception.date > to) continue;
    exceptionsUnmatched += 1;
    findings.push(
      makePracticeFinding(
        PRACTICE_REASON.EXCEPTION_UNMATCHED,
        `exception "${exception.id}" is dated ${exception.date}, on which slot "${exception.slotId}" does not occur; whatever it meant to change is unchanged`,
        {
          exceptionId: exception.id,
          slotId: exception.slotId,
          date: exception.date,
          kind: exception.kind,
        }
      )
    );
  }

  if (occurrences.length === 0) {
    findings.push(
      makePracticeFinding(
        PRACTICE_REASON.WINDOW_EMPTY,
        `no practice occurs between ${from} and ${to} across ${slotSet.slots.length} slot(s); an empty result here means "nothing is scheduled", not "the model did not run"`,
        { from, to, slotsConsidered: slotSet.slots.length }
      )
    );
  }

  findings.push(
    makePracticeFinding(
      PRACTICE_REASON.MODEL_UNWIRED,
      `these ${occurrences.length} occurrence(s) reach no production path: PracticeSchedulingPage.partitionPracticeSlots() composes its own slot instants and does not call this materialiser`,
      { occurrenceCount: occurrences.length }
    )
  );

  occurrences.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.startMinutes !== b.startMinutes) return a.startMinutes - b.startMinutes;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return deepFreeze({
    occurrences,
    findings,
    status: derivePracticeStatus(findings),
    stats: {
      from,
      to,
      windowDays: isoDayNumber(to) - isoDayNumber(from) + 1,
      slotsConsidered: slotSet.slots.length,
      occurrenceCount: occurrences.length,
      suppressedCount,
      movedCount,
      shortenedCount,
      exceptionsApplied: applied.size,
      exceptionsUnmatched,
    },
  });
}
