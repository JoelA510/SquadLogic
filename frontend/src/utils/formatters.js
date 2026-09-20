import { anchorToSeasonClock } from '@squadlogic/core/timing/index.js';

export const formatPercent = (value) => `${Math.round((value ?? 0) * 100)}%`;

export const formatPercentPrecise = (value) => {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return '0%';
  }
  const scaled = Math.round(numeric * 1000) / 10;
  return `${Number.isInteger(scaled) ? scaled.toFixed(0) : scaled.toFixed(1)}%`;
};

export const formatList = (items) => (items.length > 0 ? items.join(', ') : 'None');

export const formatReasons = (reasons) =>
  Object.entries(reasons)
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(', ');

/**
 * Place a value on the season clock before it is read as an instant.
 *
 * `formatDate`/`formatTime`/`formatDateTime` used to call `new Date(value)` --
 * a **browser-local** parse -- and then render the result with
 * `timeZone: timezone`. For a naive wall string that is a double shift: the
 * same 4:44 PM slot read "4:44 PM", "7:44 PM" or "11:44 AM" depending on where
 * the admin sat. Composing first removes it.
 *
 * Two behaviours are deliberately preserved:
 *
 * - **A value that already carries a zone is untouched.** Once a slot is a real
 *   instant, `new Date(value)` plus `timeZone` was already correct and stays so.
 * - **A caller that passes no timezone still renders browser-local.**
 *   `PersistenceHistoryList`, `TeamPersistencePanel`, `PracticeReadinessPanel`,
 *   `TeamOverviewPanel`, `TeamListView` and `GameReadinessPanel` format audit
 *   and `scheduler_runs` timestamps that already carry a `Z`, and the viewer's
 *   own clock is the right one for those. The last two joined that list when
 *   the dead `timezone` thread from `useDashboardData` was removed; each of
 *   their docblocks cites this paragraph as the rule, so this list is the
 *   thing that has to stay true.
 *
 * A naive wall string with no zone to place it on has no honest reading, so it
 * comes back `null` and the caller renders its `unspecified` sentinel rather
 * than a browser-derived guess.
 *
 * @param {*} value
 * @param {string} [timezone]
 * @returns {Date|null}
 */
const toSeasonInstant = (value, timezone) => {
  const { iso } = anchorToSeasonClock(value, timezone);
  if (iso === null || iso === undefined) {
    return null;
  }
  const date = new Date(/** @type {string|number|Date} */ (iso));
  return Number.isNaN(date.getTime()) ? null : date;
};

export const formatTime = (value, timezone) => {
  if (!value) {
    return 'unspecified time';
  }
  const date = toSeasonInstant(value, timezone);
  if (date === null) {
    return 'unspecified time';
  }
  /** @type {Intl.DateTimeFormatOptions} */
  const options = { hour: 'numeric', minute: '2-digit' };
  if (timezone) {
    options.timeZone = timezone;
  }
  return date.toLocaleTimeString([], options);
};

export const formatDate = (value, timezone) => {
  if (!value) {
    return 'unspecified date';
  }
  const date = toSeasonInstant(value, timezone);
  if (date === null) {
    return 'unspecified date';
  }
  /** @type {Intl.DateTimeFormatOptions} */
  const options = { year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' };
  if (timezone) {
    options.timeZone = timezone;
  }
  return date.toLocaleDateString(undefined, options);
};

export const formatClockFromMinutes = (minutes) => {
  if (!Number.isFinite(minutes)) {
    return 'unspecified time';
  }
  const normalized = Math.max(0, Math.round(minutes));
  const hours = Math.floor(normalized / 60) % 24;
  const mins = normalized % 60;
  const label = `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
  const suffix = hours >= 12 ? 'pm' : 'am';
  const adjustedHour = ((hours + 11) % 12) + 1;
  return `${adjustedHour}:${mins.toString().padStart(2, '0')} ${suffix} (${label})`;
};

export const formatGameWarningDetails = (details) => {
  if (!details) {
    return 'See evaluator details';
  }
  if (details.dominantDivision) {
    return `${details.dominantDivision} at ${formatPercentPrecise(details.dominantShare)}`;
  }
  if (details.coachId) {
    return `Coach ${details.coachId} · Week ${details.weekIndex}`;
  }
  return 'See evaluator details';
};

export const formatDateTime = (value, timezone) => {
  if (!value) {
    return 'unspecified time';
  }
  // One composition, read twice: deriving the two halves independently would let
  // a value that is a date but not a time (or vice versa) print half a label.
  const date = toSeasonInstant(value, timezone);
  if (date === null) {
    return 'unspecified time';
  }
  const datePart = formatDate(date, timezone);
  const timePart = formatTime(date, timezone);
  return `${datePart} · ${timePart}`;
};
