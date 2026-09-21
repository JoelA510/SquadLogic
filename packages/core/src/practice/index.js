/**
 * Barrel for the recurring-practice model.
 *
 * Every public export of `practice/` goes through this file, exactly as
 * `facility/index.js` and `availability/index.js` do for their layers. There is
 * no `packages/core/src/index.js` and this does not create one: the repo's
 * convention is a barrel per module directory, reached through the
 * `@squadlogic/core/<module>/index.js` alias.
 *
 * ## The two rules this package keeps
 *
 * **No `Date`, anywhere.** Dates are `YYYY-MM-DD`, times are minutes past
 * local midnight, weekdays are three-letter codes, and every date walk is
 * integer arithmetic on day numbers. The package therefore has no opinion about
 * timezones, which is the only honest position for a layer that is not given
 * one. Enforced, not asserted: `tests/practiceSlotModel.test.js` reads these
 * source files and fails on `new Date`, `Date.`, or an import of
 * `utils/date.js`.
 *
 * The seam this avoids is real and logged. `utils/date.js:118
 * applyMinutesToDate()` calls `setUTCHours`, so a 17:00 practice becomes 17:00
 * **UTC**; `tests/practiceSchedulingTimezone.test.js:14-17` records the
 * incident that produced ("Ubuntu-CI at UTC was misinterpreting the naive ISO
 * strings as UTC and filtering both slots"). The conversion from a wall clock
 * to an instant needs a timezone and therefore belongs where one exists:
 * `frontend/src/pages/PracticeSchedulingPage.jsx` composes slot instants
 * through `frontend/src/utils/seasonClockSlots.js` with the season's own zone,
 * DST included. **This package moves that boundary outward rather than
 * crossing it** — it hands out wall-clock occurrences and lets the one layer
 * that knows the zone do the composing.
 *
 * **Nothing in production calls any of this.** Every result carries
 * `PRACTICE_MODEL_UNWIRED`, and `tests/unwiredLayerImporters.test.js` pins the
 * importer and consumer lists exactly, in both directions. The single call site
 * that would reach the model is
 * `PracticeSchedulingPage.partitionPracticeSlots()`; replacing it is a change
 * to the live persistence path, not a rider on a domain-model PR.
 *
 * @module practice
 */

export {
  PRACTICE_REASON,
  PRACTICE_REASON_SEVERITY,
  PRACTICE_SEVERITY,
  PRACTICE_STATUS,
  derivePracticeStatus,
  makePracticeFinding,
  practiceSeverityOf,
} from './reasonCodes.js';

export {
  PRACTICE_EXCEPTION_KIND,
  PracticeAssignmentSchema,
  PracticeExceptionSchema,
  PracticeSlotSchema,
  PracticeSlotSetInputSchema,
  PracticeWeekdaySchema,
  PracticeWindowSchema,
} from './schemas.js';

export { buildPracticeSlotSet, firstWeekdayOnOrAfter, getPracticeSlot } from './slots.js';

export { materialisePracticeOccurrences, toFacilityBooking } from './materialise.js';

export { buildPracticeHistory, describePracticeHistory } from './history.js';

export { toSeason2026PracticePlan } from './adapters/season2026PracticeGrid.js';
