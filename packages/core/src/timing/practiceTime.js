/**
 * Where a practice occurrence's wall time lands on the season clock, and what a
 * reader says when it does not.
 *
 * ## Why this is its own module
 *
 * A practice occurrence is a calendar date (from `applyPracticeExceptions`) and
 * the slot's wall start and end. Whether that date has that wall time is a
 * question about the season's zone: on the spring-forward date `02:30` names no
 * instant, and on the fall-back date `01:30` names two. The calendar feed
 * (`_shared/calendar/icsFeed.ts`, `buildFeedEvents`) answers per date, through
 * the Deno twin of {@link resolveZonedInstant}. The team portal expanded the
 * same series by weekday alone, "the season timezone is not needed", and so
 * showed 02:30 on a day that has no 02:30 while the feed said TIME TBD.
 *
 * This is the portal's reading of the feed's contract, built on the same core
 * function the twin is pinned to (`seasonClock.vectors.json`), not a third
 * implementation of it. `tests/teamPortalPracticeDst.test.js` runs the feed and
 * the portal over one series, date by date.
 *
 * - **No instant** (a blocking finding on either end): TIME TBD, carrying the
 *   first blocking code and its sentence, as the feed's `unplaceable` event does.
 * - **Two instants** (`WALL_TIME_AMBIGUOUS`): placed, at the wall time stored;
 *   the feed takes the first occurrence and notes it, and so does the reader.
 *
 * @module timing/practiceTime
 */

import { resolveZonedInstant } from './seasonClock.js';
import { TIMING_REASON, TIMING_REASON_SEVERITY, TIMING_SEVERITY } from './reasonCodes.js';

/** The code when neither end carried a blocking finding (the feed's `SLOT_TIME_MISSING`). */
export const PRACTICE_TIME_MISSING = 'SLOT_TIME_MISSING';

/**
 * One family-facing sentence per code a practice time can fail on. A mirror of
 * the feed's `UNPLACEABLE_CAUSES` (the Edge module and this package do not
 * import one another); `tests/teamPortalPracticeDst.test.js` pins them equal.
 */
export const PRACTICE_TIME_TBD_CAUSES = Object.freeze({
  [TIMING_REASON.SEASON_TIMEZONE_MISSING]:
    'this season has no timezone set, so no event can be placed on a clock - an admin can set it in Settings then Season',
  [TIMING_REASON.SEASON_TIMEZONE_UNKNOWN]:
    "this season's timezone is not a name the calendar server recognises",
  [TIMING_REASON.WALL_TIME_NONEXISTENT]:
    'the scheduled time does not exist on that date, because daylight saving skips that hour',
  [TIMING_REASON.WALL_TIME_UNREADABLE]: 'the scheduled date or time could not be read',
  [PRACTICE_TIME_MISSING]: 'the slot carries no date or time to place',
});

/** What a code with no sentence above says: the feed's `causeFor` fallback. */
export const PRACTICE_TIME_TBD_CAUSE_UNKNOWN =
  'the scheduled time could not be placed on the season clock';

/** Advisories a placed practice can carry. A mirror of the feed's `NOTE_CAUSES`. */
export const PRACTICE_TIME_NOTE_CAUSES = Object.freeze({
  [TIMING_REASON.WALL_TIME_AMBIGUOUS]:
    'the clock goes back that night, so this hour happens twice - the earlier one is shown',
});

/** What a note code with no sentence above says: the feed's `noteCauseFor` fallback. */
export const PRACTICE_TIME_NOTE_CAUSE_UNKNOWN =
  'this time needed a judgement call on the season clock';

/**
 * Is this finding one that means no instant was composed? Only the advisory
 * (`INFO`) code does not; an unregistered code blocks, as the twin's
 * `isBlockingFinding` does (`!== false`).
 *
 * @param {{ code: string }} finding
 */
const isBlocking = (finding) => TIMING_REASON_SEVERITY[finding.code] !== TIMING_SEVERITY.INFO;

/**
 * Place one practice occurrence's start and end on the season clock.
 *
 * Never throws (it inherits {@link resolveZonedInstant}'s contract).
 *
 * @param {Object} input
 * @param {string} input.date - the occurrence's wall date, `YYYY-MM-DD`
 * @param {string|null|undefined} input.startTime - the slot's wall start
 * @param {string|null|undefined} input.endTime - the slot's wall end
 * @param {string|null|undefined} input.timeZone - the season's IANA zone
 * @returns {{ placed: true, notes: string[] }
 *   | { placed: false, code: string, cause: string, message: string }}
 */
export function placePracticeTime({ date, startTime, endTime, timeZone }) {
  const start = resolveZonedInstant({
    date,
    time: startTime,
    timeZone,
    label: 'practice start',
  });
  const end = resolveZonedInstant({ date, time: endTime, timeZone, label: 'practice end' });
  const findings = [...start.findings, ...end.findings];

  if (start.iso && end.iso) {
    return {
      placed: true,
      notes: [...new Set(findings.filter((f) => !isBlocking(f)).map((f) => f.code))],
    };
  }

  // The first BLOCKING finding, not `findings[0]`: a fall-back-night slot whose
  // end is unreadable yields `[WALL_TIME_AMBIGUOUS, WALL_TIME_UNREADABLE]`, and
  // the ambiguity is not why it could not be placed.
  const blocking = findings.find(isBlocking);
  const code = blocking?.code ?? PRACTICE_TIME_MISSING;
  return {
    placed: false,
    code,
    cause: PRACTICE_TIME_TBD_CAUSES[code] ?? PRACTICE_TIME_TBD_CAUSE_UNKNOWN,
    message: blocking?.message ?? 'practice time could not be placed',
  };
}
