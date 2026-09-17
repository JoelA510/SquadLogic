/**
 * Shared normalization utilities for data persistence and processing.
 */

import { isZonelessTimestamp } from '../timing/seasonClock.js';

export function normalizeString(value, label, index) {
  if (typeof value !== 'string') {
    throw new TypeError(
      `${label} must be a string${index !== undefined ? ` at index ${index}` : ''}`
    );
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} cannot be empty${index !== undefined ? ` at index ${index}` : ''}`);
  }
  return trimmed;
}

export function normalizeOptionalString(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new TypeError('Value must be a string when provided');
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function normalizeId(value, label, index) {
  return normalizeString(value, label ?? 'id', index);
}

/**
 * Normalise a timestamp to an ISO instant, or refuse.
 *
 * ## Why the third parameter is `index` and not a fallback (LIVE-6)
 *
 * This used to read `normalizeTimestamp(value, label, fallbackIso)` and return
 * `fallbackIso` for a nullish value. Both call sites -- `gameSupabase.js`'s
 * `start` and `end` -- pass the row `index`, a **number**, in that slot, so a
 * missing `start` returned the integer `0` and was written straight into a
 * `timestamptz` column. Worse, it defeated the guard immediately below it:
 * `'2026-11-07T18:14:00.000Z' <= 0` coerces to `NaN <= 0`, which is `false`, so
 * `end must be after start` passed. The "both missing" case only threw by
 * accident, because both fallbacks happened to be the same index.
 *
 * The fix is the signature, not the call sites -- which is why neither call site
 * changed. `normalizeString` and `normalizeId`, the siblings in this file,
 * already read `(value, label, index)` and already put the index in the message.
 * Adopting their contract is what CLAUDE.md means by taking the neighbour's
 * shape instead of inventing a third one, and it makes a missing timestamp what
 * it always was: an error, not a defaultable value. Nothing in the codebase ever
 * wanted a fallback here.
 *
 * ## Why a naive wall string is refused here too (GAP-30)
 *
 * This is the function that actually produces `game_assignments.start` and
 * `end`, both `timestamptz`. `new Date('2026-11-07T16:44:00')` reads that string
 * in the **host's** zone, so this boundary -- not the page above it -- is where
 * the same 4:44 PM slot became three instants eight hours apart. Refusing the
 * naive form means the last step before the column cannot guess a zone even if
 * something upstream hands it one, and it matches `SlotSchema`/`AssignmentSchema`,
 * which refuse it too. A wall time is composed by `timing/seasonClock.js` first.
 *
 * A bare `'2026-11-07'` is refused on the same predicate. It is not host-zone
 * dependent -- `new Date()` reads a date-only string as UTC midnight -- but it
 * is still an instant nobody chose, five in the evening the day before for a
 * Pacific season, and `start`/`end` have no reading in which a date without a
 * clock is the value that was meant.
 *
 * @param {*} value - a `Date`, an epoch number, or a string carrying a zone.
 * @param {string} label - what the caller calls this value.
 * @param {number} [index] - the row it came from, for the message.
 * @returns {string} an ISO instant.
 * @throws {TypeError} when the value is missing, unreadable, or zone-less.
 */
export function normalizeTimestamp(value, label, index) {
  const at = index !== undefined ? ` at index ${index}` : '';

  if (value === undefined || value === null) {
    throw new TypeError(`${label} is required${at}`);
  }

  if (isZonelessTimestamp(value)) {
    throw new TypeError(
      `${label} must carry a timezone${at}; compose a wall time with timing/seasonClock.js first`
    );
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`${label} must be a valid date or timestamp string${at}`);
  }

  return date.toISOString();
}

export function normalizeJsonObject(value, label) {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }

  return value;
}

export function normalizePlayerData(data) {
  const valid = [];
  const errors = [];
  const seenIds = new Set();

  data.forEach((row, index) => {
    if (row.gotSportId && seenIds.has(row.gotSportId)) {
      errors.push({ type: 'DUPLICATE_ID', id: row.gotSportId, row: index });
      return;
    }
    if (row.gotSportId) seenIds.add(row.gotSportId);

    if (!row.dob) {
      errors.push({
        row: index,
        column: 'dob',
        message: 'Missing critical column: Date of Birth',
      });
      return;
    }

    valid.push(row);
  });

  return { valid, errors };
}
