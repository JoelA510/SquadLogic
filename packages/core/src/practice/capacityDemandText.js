/**
 * The words for why a division has no open slot (schedule expansion, PR 13, fix round 3): one
 * sentence for each report code of `CAPACITY_NO_SLOT_REASON`, with a practice length set and without
 * one. Plain language for the admin lives next to the code so a page cannot show a bare code, and so
 * a code with no words is a failing test (`tests/practiceCapacityDemandReasons.test.js`) and not a
 * sentence that is true of another code.
 *
 * The date and length sentences are the run's own (`describeUnplacedReason`). The reservation
 * sentences say which reservation refused the slots, because the two need different fixes: a slot
 * reserved to another division is that division's to release; a division with reserved slots of its
 * own may use only those, so when none of them is live the unreserved slots are closed to it until
 * its own reservation is renewed or removed.
 *
 * @module practice/capacityDemandText
 */

import { describeUnplacedReason } from '../practiceUnplacedReasons.js';
import { CAPACITY_NO_SLOT_REASON } from './capacityDemand.js';

const sentence = (reason) => {
  const text = describeUnplacedReason(reason);
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
};

/**
 * Each code's sentence as `[with no practice length set, with one]`. With a length set, a live slot
 * of the length is what a reservation closes, and the sentence says so: the live slots of another
 * length are not reserved, they are the wrong length.
 */
export const NO_SLOT_REASON_WORDS = Object.freeze({
  [CAPACITY_NO_SLOT_REASON.NO_LIVE_DATE]: Object.freeze([
    sentence(CAPACITY_NO_SLOT_REASON.NO_LIVE_DATE),
    sentence(CAPACITY_NO_SLOT_REASON.NO_LIVE_DATE),
  ]),
  [CAPACITY_NO_SLOT_REASON.PRACTICE_LENGTH]: Object.freeze([
    sentence(CAPACITY_NO_SLOT_REASON.PRACTICE_LENGTH),
    sentence(CAPACITY_NO_SLOT_REASON.PRACTICE_LENGTH),
  ]),
  [CAPACITY_NO_SLOT_REASON.RESERVED_FOR_ANOTHER_DIVISION]: Object.freeze([
    'Every slot with a date left from today is reserved to another division.',
    "Every slot of the division's length with a date left from today is reserved to another division.",
  ]),
  [CAPACITY_NO_SLOT_REASON.OUTSIDE_DIVISION_RESERVATION]: Object.freeze([
    'The division has reserved slots, so it may use only those, and none of them has a date left from today.',
    'The division has reserved slots, so it may use only those, and none of them is a live slot of its length.',
  ]),
  [CAPACITY_NO_SLOT_REASON.RESERVATIONS_MIXED]: Object.freeze([
    'Every slot with a date left from today is closed to the division: some are reserved to another division, and it has reserved slots of its own, so it may use only those, and none of them has a date left from today.',
    "Every slot of the division's length with a date left from today is closed to the division: some are reserved to another division, and it has reserved slots of its own, so it may use only those, and none of them is a live slot of its length.",
  ]),
});

/**
 * The sentence for a no-slot reason. A code this build does not know is said as written, never as
 * another code's sentence.
 *
 * @param {unknown} reason - a `CAPACITY_NO_SLOT_REASON` value
 * @param {number | null | undefined} practiceMinutes - the division's practice length, or none
 * @returns {string}
 */
export function describeNoSlotReason(reason, practiceMinutes) {
  const words = NO_SLOT_REASON_WORDS[/** @type {string} */ (reason)];
  if (!words) return String(reason);
  return words[practiceMinutes === null || practiceMinutes === undefined ? 0 : 1];
}
