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
 * numbers.
 *
 * An occurrence is the `FacilityBooking` shape (`facility/schemas.js:131-146`)
 * **plus** four provenance fields, so venue closures stay the facility layer's
 * job rather than being re-modelled here: a slot's own exceptions (rain-out,
 * holiday) are the slot's, a venue being shut is the venue's. Because
 * `FacilityBookingSchema` is `.strict()`, the extra fields make an occurrence
 * a booking *superset*, not a booking — passing one to `checkOccupancy()`
 * raises `unrecognized_keys`. {@link toFacilityBooking} is the one-line
 * narrowing; an earlier draft of this file claimed "no adapter needed" and was
 * simply wrong.
 *
 * @module practice/materialise
 */

import { deepFreeze } from '../facility/facilityGraph.js';
import { isoDateOfDayNumber, isoDayNumber } from '../facility/eligibility.js';

import { PRACTICE_REASON, derivePracticeStatus, makePracticeFinding } from './reasonCodes.js';
import { PRACTICE_EXCEPTION_KIND, PracticeWindowSchema } from './schemas.js';
import { firstWeekdayOnOrAfter } from './slots.js';

/**
 * Narrow an occurrence to the booking the facility layer accepts.
 *
 * `FacilityBookingSchema` is `.strict()`, so the provenance fields have to go
 * before `checkOccupancy()`, `findFacilityConflicts()` or
 * `findClosureBreaches()` will look at it.
 *
 * @param {import('./types.js').PracticeOccurrence} occurrence
 * @returns {{ id: string, surfaceId: string, date: string, startMinutes: number, endMinutes: number, format: string|null, label: string|null }}
 */
export function toFacilityBooking(occurrence) {
  return {
    id: occurrence.id,
    surfaceId: occurrence.surfaceId,
    date: occurrence.date,
    startMinutes: occurrence.startMinutes,
    endMinutes: occurrence.endMinutes,
    format: occurrence.format,
    label: occurrence.label,
  };
}

/**
 * The one finding for "this override did not take effect", whichever rule
 * decided it.
 *
 * Two rules produce it — a cancellation removing the practice, and a
 * same-kind collision on one date — and they are distinguished by the
 * `collision` detail rather than by two codes, so a consumer asking "did
 * anything I sent get dropped" has one code to read.
 *
 * @param {Object} input
 * @param {import('./types.js').PracticeSlot} input.slot
 * @param {string} input.date
 * @param {import('./types.js').PracticeException} input.loser
 * @param {string} input.winnerId
 * @param {'cancelled'|'same-kind'} input.collision
 * @param {string} input.because - the clause that completes the message
 * @returns {import('./types.js').PracticeFinding}
 */
function supersededFinding({ slot, date, loser, winnerId, collision, because }) {
  return makePracticeFinding(
    PRACTICE_REASON.EXCEPTION_SUPERSEDED,
    `${date}: exception "${loser.id}" (${loser.kind}) had no effect — ${because}`,
    {
      slotId: slot.id,
      date,
      exceptionId: loser.id,
      kind: loser.kind,
      supersededBy: winnerId,
      collision,
    }
  );
}

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
  // **Counted per occurrence changed, not per exception seen.** With
  // same-kind collisions resolved above, at most one override of each kind
  // takes effect on a date, so these are counts of practices, which is what
  // a reader assumes. A superseded override is counted by neither; it is
  // visible as an EXCEPTION_SUPERSEDED finding.
  let occurrencesSuppressed = 0;
  let occurrencesMoved = 0;
  let occurrencesShortened = 0;

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
        occurrencesSuppressed += 1;
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
        // occurrence left to move or shorten. Reported here, with its own
        // code, rather than falling through to the unmatched sweep — whose
        // wording ("the slot does not occur on that date") would be false.
        for (const superseded of onThisDate) {
          if (superseded.id === cancellation.id) continue;
          applied.add(superseded.id);
          findings.push(
            supersededFinding({
              slot,
              date,
              loser: superseded,
              winnerId: cancellation.id,
              collision: 'cancelled',
              because: `"${cancellation.id}" cancelled this practice`,
            })
          );
        }
        continue;
      }

      let startMinutes = slot.startMinutes;
      let durationMinutes = slot.durationMinutes;
      /** @type {string[]} */
      const exceptionIds = [];

      // **Two overrides of one kind on one date are a collision, and the
      // deciding rule is stated rather than inherited from array order.**
      // Lowest exception id wins. That is not a judgement that the lower id
      // is the better record — this model has no way to rank two
      // contradictory moves — it is a rule that gives the same answer however
      // the caller happened to order its input. The loser is reported, in the
      // same code and with the same `supersededBy` a cancellation uses, so
      // "this override did not take effect" has one vocabulary.
      //
      // Applying both silently would leave two OCCURRENCE_MOVED findings on
      // one practice, each true alone, contradicting each other about the
      // start time, with nothing saying which the occurrence reflects.
      const ordered = [...onThisDate].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      /** kind -> the exception that takes effect */
      const winnerOfKind = new Map();
      for (const exception of ordered) {
        if (!winnerOfKind.has(exception.kind)) winnerOfKind.set(exception.kind, exception);
      }

      for (const exception of ordered) {
        applied.add(exception.id);
        const winner = winnerOfKind.get(exception.kind);
        if (winner.id !== exception.id) {
          findings.push(
            supersededFinding({
              slot,
              date,
              loser: exception,
              winnerId: winner.id,
              collision: 'same-kind',
              because: `"${winner.id}" is the ${exception.kind} exception this model applies here (lowest id of ${
                ordered.filter((other) => other.kind === exception.kind).length
              } on this date)`,
            })
          );
          continue;
        }

        if (exception.kind === PRACTICE_EXCEPTION_KIND.MOVED) {
          startMinutes = /** @type {number} */ (exception.startMinutes);
          occurrencesMoved += 1;
          findings.push(
            makePracticeFinding(
              PRACTICE_REASON.OCCURRENCE_MOVED,
              `${date}: the practice on ${slot.surfaceId} starts at ${startMinutes} minutes instead of ${slot.startMinutes} — ${exception.reason}`,
              { slotId: slot.id, date, exceptionId: exception.id, reason: exception.reason }
            )
          );
        } else if (exception.kind === PRACTICE_EXCEPTION_KIND.SHORTENED) {
          durationMinutes = /** @type {number} */ (exception.durationMinutes);
          occurrencesShortened += 1;
          findings.push(
            makePracticeFinding(
              PRACTICE_REASON.OCCURRENCE_SHORTENED,
              `${date}: the practice on ${slot.surfaceId} runs ${durationMinutes} minutes instead of ${slot.durationMinutes} — ${exception.reason}`,
              { slotId: slot.id, date, exceptionId: exception.id, reason: exception.reason }
            )
          );
        }
        exceptionIds.push(exception.id);
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
        // Every override that **took effect** on this date, in id order. A
        // `moved` and a `shortened` compose, so a single id would drop one;
        // an override superseded by another of its kind is absent, because it
        // altered nothing.
        exceptionIds,
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
      occurrencesSuppressed,
      occurrencesMoved,
      occurrencesShortened,
      exceptionsApplied: applied.size,
      exceptionsUnmatched,
    },
  });
}
