/**
 * Shared normalization utilities for data persistence and processing.
 */

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
 * @param {*} value - a `Date`, an ISO string, or an epoch number.
 * @param {string} label - what the caller calls this value.
 * @param {number} [index] - the row it came from, for the message.
 * @returns {string} an ISO instant.
 * @throws {TypeError} when the value is missing or unreadable.
 */
export function normalizeTimestamp(value, label, index) {
  const at = index !== undefined ? ` at index ${index}` : '';

  if (value === undefined || value === null) {
    throw new TypeError(`${label} is required${at}`);
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
