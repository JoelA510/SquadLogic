/**
 * Why a practice goes unplaced in an auto-scheduler run, which rule the practice writer's
 * gate broke (Phase D PR B; plan `docs/changes/2026-10-27-phase-d-scheduling.md`, section B), and
 * which rule the server's check of a browser run broke (Phase D PR D, section D).
 *
 * **One list, three spellings.** The Edge solver (`supabase/functions/_shared/engines/
 * auto-scheduler-solver.ts`) names an unplaced practice with one of
 * {@link PRACTICE_UNPLACED_REASON}; `persist_practice_schedule`'s gate
 * (`practice_new_auto_row_refusals`, migration `20261105010000`) names the rule a new auto row
 * broke with one of {@link PRACTICE_WRITER_GATE_RULE}. `tests/practiceUnplacedReasons.test.js`
 * pins the Deno constants and the SQL text to these lists, in both directions, so a reason added
 * on one side and not the others fails there. {@link VERIFY_REFUSAL_RULE} is pinned to the solver's
 * the same way.
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
  /** Every legal slot breaks an approved coach `must` preference. */
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

/**
 * The reason a practice carries when the server's check of a browser run (`verify` mode of
 * `auto-scheduler`) refused the placement proposed for it; the entry's `rule` says which rule. It is
 * not a reason the search gives, and not on the TIME TBD table's closed list (that is a migration), so
 * the practice writer labels the team's TIME TBD row `not-scheduled-yet`.
 */
export const VERIFY_REFUSED_REASON = 'verify-refused';

/** The rule a proposed placement broke at `verify`: the search's own, and three malformed shapes. */
export const VERIFY_REFUSAL_RULE = Object.freeze({
  RESERVATION: 'reservation',
  LENGTH: 'length',
  NO_LIVE_DATE: 'no-live-date',
  CAPACITY: 'capacity',
  COACH_CONFLICT: 'coach-conflict',
  WEEKDAY: 'weekday',
  MUST_KEEP: 'must-keep',
  UNKNOWN_PRACTICE: 'unknown-practice',
  UNKNOWN_SLOT: 'unknown-slot',
  DUPLICATE_PRACTICE: 'duplicate-practice',
});

const REFUSAL_RULE_TEXT = Object.freeze({
  [VERIFY_REFUSAL_RULE.RESERVATION]: 'the slot is reserved to another division',
  [VERIFY_REFUSAL_RULE.LENGTH]: "the slot is not as long as the division's practice",
  [VERIFY_REFUSAL_RULE.NO_LIVE_DATE]: 'the slot has no date left from today',
  [VERIFY_REFUSAL_RULE.CAPACITY]: 'the slot was already full',
  [VERIFY_REFUSAL_RULE.COACH_CONFLICT]: 'a coach would be in two places at once',
  [VERIFY_REFUSAL_RULE.WEEKDAY]: 'the team already practises on that weekday',
  [VERIFY_REFUSAL_RULE.MUST_KEEP]: "it breaks a coach's must-keep preference",
  [VERIFY_REFUSAL_RULE.UNKNOWN_PRACTICE]: 'the team has no practice to place',
  [VERIFY_REFUSAL_RULE.UNKNOWN_SLOT]: 'the slot is not in this run',
  [VERIFY_REFUSAL_RULE.DUPLICATE_PRACTICE]: 'the practice was given two slots',
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
 * @param {unknown} [rule] for {@link VERIFY_REFUSED_REASON}: the rule the proposed placement broke
 * @returns {string}
 */
export function describeUnplacedReason(reason, rule = undefined) {
  const key = String(reason ?? '');
  if (key === VERIFY_REFUSED_REASON) {
    const why = REFUSAL_RULE_TEXT[String(rule ?? '')] ?? String(rule ?? '');
    return why
      ? `the server's check refused the browser's placement: ${why}`
      : "the server's check refused the browser's placement";
  }
  if (key === 'optimizer-unplaced') return TEXT.optimizerUnplaced;
  return TEXT[key] ?? key;
}
