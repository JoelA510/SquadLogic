/**
 * Why a practice goes unplaced in an auto-scheduler run, and which rule the practice writer's
 * gate broke (Phase D PR B; plan `docs/changes/2026-10-27-phase-d-scheduling.md`, section B).
 *
 * **One list, three spellings.** The Edge solver (`supabase/functions/_shared/engines/
 * auto-scheduler-solver.ts`) names an unplaced practice with one of
 * {@link PRACTICE_UNPLACED_REASON}; `persist_practice_schedule`'s gate
 * (`practice_new_auto_row_refusals`, migration `20261105010000`) names the rule a new auto row
 * broke with one of {@link PRACTICE_WRITER_GATE_RULE}. `tests/practiceUnplacedReasons.test.js`
 * pins the Deno constants and the SQL text to these lists, in both directions, so a reason added
 * on one side and not the others fails there.
 *
 * Plain language for the admin lives next to the code so a page cannot show a bare code.
 *
 * @module practiceUnplacedReasons
 */

/** The reason an unplaced practice carries in a run's `unassigned`. */
export const PRACTICE_UNPLACED_REASON = Object.freeze({
  /** The search found no legal slot (or its own `optimizer-unplaced`). */
  NO_SLOT_AVAILABLE: 'no-slot-available',
  /** No run slot has a live date from today on (M4.8 Q3). */
  NO_LIVE_DATE: 'no-live-date',
  /** Every legal slot breaks an approved coach `must_keep` preference. */
  COACH_PREFERENCE: 'coach-preference',
  /** The division sets a practice length and no slot open to it is that long. */
  PRACTICE_LENGTH: 'practice-length',
  /** The slots open to the division fall on fewer weekdays than its practices a week. */
  NOT_ENOUGH_DAYS: 'not-enough-days',
});

/** The rule a new auto row broke at the practice writer. */
export const PRACTICE_WRITER_GATE_RULE = Object.freeze({
  CAPACITY: 'capacity',
  RESERVATION: 'reservation',
  LENGTH: 'length',
  WEEKDAY: 'weekday',
  COUNT: 'count',
});

const TEXT = Object.freeze({
  [PRACTICE_UNPLACED_REASON.NO_SLOT_AVAILABLE]: 'no slot was free for it',
  [PRACTICE_UNPLACED_REASON.NO_LIVE_DATE]: 'no practice slot has a date left from today',
  [PRACTICE_UNPLACED_REASON.COACH_PREFERENCE]:
    "every free slot breaks a coach's must-keep preference",
  [PRACTICE_UNPLACED_REASON.PRACTICE_LENGTH]:
    "no practice slot is exactly as long as the division's practice",
  [PRACTICE_UNPLACED_REASON.NOT_ENOUGH_DAYS]:
    "the division's slots fall on fewer weekdays than its practices a week",
  optimizerUnplaced: 'no slot was free for it',
});

/**
 * A reason in words an admin can read. A code this build does not know is shown as written, never
 * hidden.
 *
 * @param {unknown} reason
 * @returns {string}
 */
export function describeUnplacedReason(reason) {
  const key = String(reason ?? '');
  if (key === 'optimizer-unplaced') return TEXT.optimizerUnplaced;
  return TEXT[key] ?? key;
}
