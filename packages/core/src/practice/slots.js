/**
 * Building a validated practice plan out of raw slots and assignments.
 *
 * @module practice/slots
 */

import { deepFreeze } from '../facility/facilityGraph.js';
import { isoDateOfDayNumber, isoDayNumber } from '../facility/eligibility.js';
import { weekdayCodeOf } from '../availability/calendar.js';

import { PRACTICE_REASON, makePracticeFinding } from './reasonCodes.js';
import { PracticeSlotSetInputSchema } from './schemas.js';

/**
 * The first date on or after `from` that falls on `weekday`.
 *
 * Integer arithmetic on day numbers; no `Date`, so the runner's TZ cannot
 * move the answer. This is the whole of the weekday logic in this package —
 * materialisation and the never-occurs check both go through it, so there is
 * one place for an off-by-one to live and one place for a test to break it.
 *
 * @param {string} from - `YYYY-MM-DD`
 * @param {string} weekday - `'SUN'`…`'SAT'`
 * @returns {string} `YYYY-MM-DD`
 */
export function firstWeekdayOnOrAfter(from, weekday) {
  const start = isoDayNumber(from);
  // Derive the target index from the same function that labels dates, rather
  // than from a literal table: a table here would be a second weekday
  // vocabulary, and the two would be free to drift.
  let delta = 0;
  while (weekdayCodeOf(isoDateOfDayNumber(start + delta)) !== weekday) {
    delta += 1;
    /* c8 ignore next 3 -- unreachable: seven consecutive days cover every code */
    if (delta > 6) {
      throw new Error(`practice: "${weekday}" is not a weekday code`);
    }
  }
  return isoDateOfDayNumber(start + delta);
}

/**
 * Does this slot's own validity range contain any occurrence of its weekday?
 *
 * @param {import('./types.js').PracticeSlot} slot
 * @returns {boolean}
 */
function slotEverOccurs(slot) {
  if (slot.validFrom === null || slot.validUntil === null) return false;
  return firstWeekdayOnOrAfter(slot.validFrom, slot.weekday) <= slot.validUntil;
}

/**
 * Do two slots describe the same recurring window on the same ground over
 * overlapping time?
 *
 * **Within one revision only.** Two *revisions* of a plan describing the same
 * Tuesday 16:00 on the same pitch is what a revision *is*, not a duplicate —
 * on the season-2026 corpus an earlier draft of this check reported 415 such
 * pairs, which is the seven-revisions fact restated 415 times with the genuine
 * case buried inside it. Revision coexistence has its own codes
 * (`PRACTICE_REVISION_UNDATED`, `PRACTICE_REVISION_ORDER_UNKNOWN`); this one is
 * for a single plan contradicting itself.
 *
 * Undated slots (`validFrom === null`) are treated as overlapping everything,
 * because "the source did not say" cannot be used to rule a clash out.
 *
 * @param {import('./types.js').PracticeSlot} a
 * @param {import('./types.js').PracticeSlot} b
 * @returns {boolean}
 */
function slotsCollide(a, b) {
  if (a.revisionId !== b.revisionId) return false;
  if (a.surfaceId !== b.surfaceId) return false;
  if (a.weekday !== b.weekday) return false;
  if (a.startMinutes !== b.startMinutes) return false;
  if (a.validFrom === null || b.validFrom === null) return true;
  return (
    a.validFrom <= /** @type {string} */ (b.validUntil) &&
    b.validFrom <= /** @type {string} */ (a.validUntil)
  );
}

/**
 * Validate a practice plan and index it.
 *
 * Reports, and never resolves:
 *
 * - **undated revisions** — the season-2026 corpus's seven plans carry no
 *   effective range, and this model refuses to invent one. See
 *   `PRACTICE_REASON.REVISION_UNDATED`.
 * - **duplicate windows** — both halves are kept.
 * - **slots that can never occur** — a legal slot whose range holds no
 *   instance of its own weekday.
 *
 * Every set also carries `PRACTICE_MODEL_UNWIRED`; see that code's docstring.
 *
 * @param {{ slots: Array<Object>, assignments?: Array<Object>, source?: string|null }} input
 * @returns {import('./types.js').PracticeSlotSet}
 */
export function buildPracticeSlotSet(input) {
  const parsed = PracticeSlotSetInputSchema.parse(input);
  /** @type {import('./types.js').PracticeFinding[]} */
  const findings = [];

  const slots = /** @type {import('./types.js').PracticeSlot[]} */ (parsed.slots);
  const assignments = /** @type {import('./types.js').PracticeAssignment[]} */ (parsed.assignments);

  const seenIds = new Set();
  for (const slot of slots) {
    if (seenIds.has(slot.id)) {
      throw new Error(`practice: duplicate slot id "${slot.id}"`);
    }
    seenIds.add(slot.id);
  }
  for (const assignment of assignments) {
    if (!seenIds.has(assignment.slotId)) {
      throw new Error(
        `practice: assignment "${assignment.id}" references unknown slot "${assignment.slotId}"`
      );
    }
  }

  /* -- undated revisions ------------------------------------------------- */

  /** revision id (or the sentinel for "no revision named") -> slot count */
  const undatedByRevision = new Map();
  let undatedSlotCount = 0;
  for (const slot of slots) {
    if (slot.validFrom !== null) continue;
    undatedSlotCount += 1;
    const key = slot.revisionId ?? '(no revision named)';
    undatedByRevision.set(key, (undatedByRevision.get(key) ?? 0) + 1);
  }
  for (const [revisionId, count] of [...undatedByRevision].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    findings.push(
      makePracticeFinding(
        PRACTICE_REASON.REVISION_UNDATED,
        `revision "${revisionId}" carries no effective date range, so its ${count} slot(s) materialise to nothing; the source does not say when this plan applied and this model will not invent it`,
        { revisionId, slotCount: count }
      )
    );
  }
  if (undatedByRevision.size > 1) {
    findings.push(
      makePracticeFinding(
        PRACTICE_REASON.REVISION_ORDER_UNKNOWN,
        `${undatedByRevision.size} revisions are undated, so they cannot be ordered against one another, let alone dated: ${[...undatedByRevision.keys()].sort().join(', ')}`,
        { revisionCount: undatedByRevision.size }
      )
    );
  }

  /* -- duplicates and dead slots ----------------------------------------- */

  for (let i = 0; i < slots.length; i += 1) {
    for (let j = i + 1; j < slots.length; j += 1) {
      if (!slotsCollide(slots[i], slots[j])) continue;
      findings.push(
        makePracticeFinding(
          PRACTICE_REASON.SLOT_DUPLICATE,
          `slots "${slots[i].id}" and "${slots[j].id}" describe the same ${slots[i].weekday} window on ${slots[i].surfaceId} over overlapping dates; both are kept`,
          {
            slotIds: [slots[i].id, slots[j].id],
            surfaceId: slots[i].surfaceId,
            weekday: slots[i].weekday,
            startMinutes: slots[i].startMinutes,
            revisionIds: [slots[i].revisionId, slots[j].revisionId],
          }
        )
      );
    }
  }

  for (const slot of slots) {
    if (slot.surfaceResolution === null || slot.surfaceResolution === 'resolved') continue;
    findings.push(
      makePracticeFinding(
        PRACTICE_REASON.SLOT_SURFACE_UNRESOLVED,
        `slot "${slot.id}" names ground that resolved "${slot.surfaceResolution}", so "${slot.surfaceId}" is not a surface the facility graph holds; the slot is kept and nothing can be decided about its ground`,
        { slotId: slot.id, surfaceId: slot.surfaceId, resolution: slot.surfaceResolution }
      )
    );
  }

  for (const slot of slots) {
    if (slot.validFrom === null) continue;
    if (slotEverOccurs(slot)) continue;
    findings.push(
      makePracticeFinding(
        PRACTICE_REASON.SLOT_NEVER_OCCURS,
        `slot "${slot.id}" is a ${slot.weekday} slot valid ${slot.validFrom}..${slot.validUntil}, a range that contains no ${slot.weekday}`,
        {
          slotId: slot.id,
          weekday: slot.weekday,
          validFrom: slot.validFrom,
          validUntil: slot.validUntil,
        }
      )
    );
  }

  /* -- the declaration --------------------------------------------------- */

  findings.push(
    makePracticeFinding(
      PRACTICE_REASON.MODEL_UNWIRED,
      `this practice model is not consulted by any production path: no standing rule or registry constraint claims a PRACTICE_* code, and PracticeSchedulingPage.partitionPracticeSlots() still normalises practice_slots rows itself; ${slots.length} slot(s) are modelled only where a caller asks directly`,
      { slotCount: slots.length, source: parsed.source ?? null }
    )
  );

  /* -- stats -------------------------------------------------------------- */

  /** @type {Record<string, number>} */
  const slotsByWeekday = { SUN: 0, MON: 0, TUE: 0, WED: 0, THU: 0, FRI: 0, SAT: 0 };
  for (const slot of slots) slotsByWeekday[slot.weekday] += 1;

  return deepFreeze({
    slots,
    assignments,
    slotIds: slots.map((slot) => slot.id),
    source: parsed.source,
    findings,
    stats: {
      slotCount: slots.length,
      assignmentCount: assignments.length,
      teamCount: new Set(assignments.map((a) => a.teamId)).size,
      surfaceCount: new Set(slots.map((slot) => slot.surfaceId)).size,
      revisionCount: new Set(slots.map((slot) => slot.revisionId).filter((r) => r !== null)).size,
      undatedSlotCount,
      slotsByWeekday,
    },
  });
}

/**
 * The slot a set holds under an id.
 *
 * @param {import('./types.js').PracticeSlotSet} slotSet
 * @param {string} slotId
 * @returns {import('./types.js').PracticeSlot|null}
 */
export function getPracticeSlot(slotSet, slotId) {
  return slotSet.slots.find((slot) => slot.id === slotId) ?? null;
}
