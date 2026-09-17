/**
 * How an unplaceable slot is reported, and when the season's clock is merely
 * not loaded yet.
 *
 * ## Why this is not in `GameSchedulingPage.jsx` any more
 *
 * It was, and `PracticeSchedulingPage` needed the same three answers when its
 * own `buildDateTime` moved onto the season clock (LIVE-7). Two pages each
 * deciding what `SEASON_TIMEZONE_MISSING` means to an operator is the twin-arm
 * shape this codebase keeps paying for -- a fix landing on one arm and not its
 * sibling. `GameSchedulingPage` re-exports every name below, so its own
 * importers and `tests/gameSchedulingSeasonClock.test.js` are unchanged.
 *
 * @module utils/seasonClockSlots
 */

import { TIMING_REASON } from '@squadlogic/core/timing/index.js';

/**
 * The cause behind each reason code, phrased **without any one slot in it**.
 *
 * This table is the fix for the bucketing defect below and not decoration: the
 * per-slot `reason` strings `resolveZonedInstant` builds all embed that slot's
 * own date and time, so there is no way to bucket on them AND keep a
 * slot-independent line. The aggregate needs a sentence that is true of the
 * whole bucket; the per-slot detail stays on the entries, where the grid and a
 * future TIME TBD row can read it.
 *
 * Keyed by every code `partitionGameSlots` can emit today.
 * `WALL_TIME_AMBIGUOUS` is deliberately absent: it never refuses, so it never
 * reaches an unplaceable entry.
 *
 * **A code this table does not carry gets {@link UNPLACEABLE_CAUSE_UNKNOWN},
 * not the slot's own `reason`.** That is the structural half of the fix and it
 * matters more than the table: a future refusal code added to
 * `timing/reasonCodes.js` would otherwise fall through to a per-slot string
 * and reintroduce the unbounded banner, silently, with every test still
 * green. Boundedness must not depend on this table being kept up to date --
 * the table only makes the line more useful, and
 * `tests/gameSchedulingSeasonClock.test.js` drives an unregistered code
 * through to prove the fallback holds.
 */
export const UNPLACEABLE_CAUSE = Object.freeze({
  [TIMING_REASON.SEASON_TIMEZONE_MISSING]:
    "this season has no timezone to place them on; set the season's timezone in Settings before scheduling",
  [TIMING_REASON.SEASON_TIMEZONE_UNKNOWN]:
    "this season's timezone is not a zone this browser can resolve",
  [TIMING_REASON.WALL_TIME_NONEXISTENT]:
    "daylight saving skips that hour in the season's timezone, so the stored time names no instant",
  [TIMING_REASON.WALL_TIME_UNREADABLE]: 'the stored date or time is not a readable wall time',
  SLOT_SHAPE_INVALID: 'the row is missing an id, a start/end, or a positive week index',
});

/**
 * What a code with no entry above says. Deliberately generic AND deliberately
 * slot-independent -- see the note on {@link UNPLACEABLE_CAUSE}. The code
 * itself is printed alongside it, and `code` is the contract.
 */
export const UNPLACEABLE_CAUSE_UNKNOWN = 'this slot could not be placed on the season clock';

/** How many slots a bucket names before it summarises the rest. */
export const UNPLACEABLE_EXAMPLES = 3;

/**
 * One line per distinct **reason code**, with a count, so a hundred slots
 * sharing one cause read as one fact rather than a hundred.
 *
 * ## Why the key is `code` and not `reason`
 *
 * It was `reason`, and every reason string `resolveZonedInstant` produces
 * carries that slot's own date and time -- `"slot time 2026-11-07 16:44:00 has
 * no season timezone..."`. No two real slots ever share one, so the "collapse"
 * collapsed nothing: measured on `main`, 5 slots produced 5 lines and 50
 * produced 50 over 8 KB, and a season whose `timezone` is null makes **every**
 * row unplaceable, so a 400-slot season rendered tens of kilobytes of text into
 * a single `<p>`. `code` is the contract everywhere else in this codebase and
 * it is the contract here.
 *
 * ## What the operator loses, and what is done about it
 *
 * On `main` every unplaceable slot was named, once, in its own sentence --
 * useless at 400 and genuinely useful at 3. `partitionGameSlots`'s contract
 * says these slots get no grid row and "the banner is where they exist", so
 * collapsing to one line per code would leave three DST casualties in a
 * 400-slot season with one of the three identified and no way to find the
 * others. So a bucket names up to {@link UNPLACEABLE_EXAMPLES} slots and then
 * counts the remainder: the small case is named in full, the catastrophic case
 * stays bounded, and the entries keep every date and time for a TIME TBD row
 * to render when one exists.
 *
 * @param {Array<{ code?: string, reason?: string, date?: string|null, time?: string|null }>} entries
 * @returns {string|null}
 */
export function describeUnplaceableSlots(entries) {
  if (!entries || entries.length === 0) return null;
  /** @type {Map<string, { count: number, examples: Array<string> }>} */
  const byCode = new Map();
  for (const entry of entries) {
    const code = entry?.code ?? 'SLOT_SHAPE_INVALID';
    const bucket = byCode.get(code) ?? { count: 0, examples: [] };
    bucket.count += 1;
    if (bucket.examples.length < UNPLACEABLE_EXAMPLES) {
      const when = [entry?.date, entry?.time].filter(Boolean).join(' ');
      if (when) bucket.examples.push(when);
    }
    byCode.set(code, bucket);
  }
  return [...byCode.entries()]
    .map(([code, { count, examples }]) => {
      const cause = UNPLACEABLE_CAUSE[code] ?? UNPLACEABLE_CAUSE_UNKNOWN;
      const remainder = count - examples.length;
      const named = examples.length
        ? ` (${examples.join(', ')}${remainder > 0 ? ` and ${remainder} more` : ''})`
        : '';
      return `${count} slot${count === 1 ? '' : 's'} shown as TIME TBD (${code}): ${cause}${named}`;
    })
    .join(' \u00b7 ');
}

/**
 * Is the season's clock simply not known yet, as opposed to absent?
 *
 * `currentSeasonSetting?.timezone` is `undefined` for three different reasons
 * and only one of them is "this season has no clock". Exported and pure
 * because the other two are races, and a race is not something a render test
 * reliably reproduces -- the conditions have to be stateable to be checkable.
 *
 * 1. `OrganizationContext`'s first fetch has not answered. `loading` covers it.
 * 2. `switchOrganization()` swaps the organization synchronously and then
 *    awaits the season read WITHOUT raising `loading` -- deliberately, since
 *    `loading` gates `ProtectedRoute` and would unmount the page.
 *    `seasonSettingsLoading` is the narrow flag for exactly that window, and
 *    it is the arm that covers the case where the organization being left had
 *    no season at all, so there is no stale row to detect a mismatch on.
 * 3. The held row belongs to the organization just left. Redundant with (2)
 *    today and kept anyway: it is derived from the data rather than from a
 *    flag, so it still holds if a future writer sets `currentSeasonSetting`
 *    without going through `fetchSeasonsForOrg`.
 *
 * @param {Object} input
 * @param {boolean} [input.organizationLoading]
 * @param {boolean} [input.seasonSettingsLoading]
 * @param {{ id?: any }|null|undefined} input.currentOrganization
 * @param {{ organization_id?: any, [k: string]: any }|null|undefined} input.currentSeasonSetting
 * @returns {boolean}
 */
export function isSeasonClockLoading({
  organizationLoading,
  seasonSettingsLoading,
  currentOrganization,
  currentSeasonSetting,
}) {
  if (organizationLoading || seasonSettingsLoading) return true;
  return Boolean(
    currentOrganization?.id &&
    currentSeasonSetting &&
    currentSeasonSetting.organization_id &&
    currentSeasonSetting.organization_id !== currentOrganization.id
  );
}
