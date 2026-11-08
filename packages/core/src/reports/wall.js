/**
 * An instant on the season's clock, for the schedule reports (PR 7 of the schedule expansion).
 *
 * `game_assignments.start` is a `timestamptz`; a report reads it as the season does, in the season's zone, so a 22:00
 * game is on the day it is played and not on the next UTC day. There is no guess in it: a value with no zone, a zone
 * the runtime does not know and a missing zone all answer `null`, and the caller says the time could not be read.
 *
 * @module reports/wall
 */

import { isoDateOfDayNumber, isoDayNumber } from '../facility/eligibility.js';

/** A date and time with a zone designator: `Z`, `+HH`, `+HHMM` or `+HH:MM`. Anything without one is not an instant. */
const ZONED_INSTANT =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}(?::?\d{2})?)$/i;

const formatters = new Map();

/** @param {string} timeZone @returns {Intl.DateTimeFormat | null} */
function formatterFor(timeZone) {
  if (formatters.has(timeZone)) return formatters.get(timeZone) ?? null;
  let formatter = null;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    // An unknown zone is a RangeError; the answer is "no reading", which the cache remembers.
    formatter = null;
  }
  formatters.set(timeZone, formatter);
  return formatter;
}

/**
 * The instant as epoch milliseconds, or `null` when the value is not a moment with a zone.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function instantMs(value) {
  if (typeof value !== 'string') return null;
  const match = ZONED_INSTANT.exec(value.trim());
  if (match === null) return null;
  let zone = match[3].toUpperCase();
  if (zone !== 'Z') {
    const digits = zone.slice(1).replace(':', '');
    zone = `${zone[0]}${digits.slice(0, 2)}:${digits.slice(2) || '00'}`;
  }
  const time = match[2].length === 5 ? `${match[2]}:00` : match[2];
  const epoch = Date.parse(`${match[1]}T${time}${zone}`);
  return Number.isFinite(epoch) ? epoch : null;
}

/**
 * The season's calendar date and wall time of an instant.
 *
 * @param {unknown} value - an ISO instant carrying its zone
 * @param {string | null | undefined} timeZone - the season's IANA zone
 * @returns {{ date: string, time: string } | null} `YYYY-MM-DD` and `HH:MM`, or `null` when there is no honest reading
 */
export function wallOfInstant(value, timeZone) {
  if (!timeZone) return null;
  const epoch = instantMs(value);
  if (epoch === null) return null;
  const formatter = formatterFor(timeZone);
  if (formatter === null) return null;
  /** @type {Record<string, string>} */
  const parts = {};
  for (const part of formatter.formatToParts(new Date(epoch))) parts[part.type] = part.value;
  // Some ICU builds render midnight as 24.
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${hour}:${parts.minute}` };
}

const WEEKDAYS = Object.freeze([
  ['Sun', 'Sunday'],
  ['Mon', 'Monday'],
  ['Tue', 'Tuesday'],
  ['Wed', 'Wednesday'],
  ['Thu', 'Thursday'],
  ['Fri', 'Friday'],
  ['Sat', 'Saturday'],
]);

/** The weekday of a real `YYYY-MM-DD`, short and long (1970-01-01 was a Thursday), or `null`. @param {string} date */
export function weekdayOfDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const day = isoDayNumber(date);
  if (!Number.isFinite(day) || isoDateOfDayNumber(day) !== date) return null;
  const [short, long] = WEEKDAYS[(((day + 4) % 7) + 7) % 7];
  return { short, long };
}
