/**
 * A practice slot's identity and the supply rule between two slots (plan
 * `docs/changes/2026-11-03-schedule-expansion.md` 4.11.3; PR 9, task J2).
 *
 * ## Identity
 *
 * A slot is found by the fields import's own key (`finalize_field_import_job`, `20261029010000:892-1009`):
 * `(field, subunit or the whole field, weekday, start, valid from)`. {@link practiceSlotKey} spells it as a
 * JSON tuple, never a delimited string: a label may contain any delimiter, and two different slots must
 * never be one key. The whole field is `null`, not the empty string, so it is never a half named `''`.
 *
 * ## The supply rule
 *
 * `practice_slot_conflicts` (`20261029010000:140-196`) refuses a new slot that clashes with a stored
 * one: **same field, same weekday, overlapping times, a whole field against each of its halves (two
 * different halves never clash), and windows that share a date which IS the weekday**. Back to back is
 * allowed (turnover 0). {@link practiceSlotsOverlap} is that rule over two slots of one file, so the
 * preview can say `slot-overlaps-another` before the database does. It reads no table: a clash with a
 * slot already stored is the database's (PR 10).
 *
 * Nothing here reads the host time zone: dates are day numbers from `Date.parse` of a UTC midnight, and a
 * time is minutes past midnight.
 */

import { scheduleLabelKey } from '../scheduleImport/mapping.js';

/**
 * The one label key of the import family: trim, collapse whitespace, fold case, **drop no word**
 * (`externalImport/mapping.js`, through the schedule import's null-safe wrapper). Shared, not copied:
 * a second normaliser is how `Park Back` becomes `Park`.
 *
 * @param {unknown} label
 * @returns {string}  `''` for a blank or missing label
 */
export const practiceLabelKey = scheduleLabelKey;

/**
 * A composite key: the parts as a JSON array. A string joined with a delimiter is ambiguous the moment a
 * label contains the delimiter; an array of strings round-trips.
 *
 * @param {...unknown} parts
 * @returns {string}
 */
export const practiceTuple = (...parts) => JSON.stringify(parts);

/**
 * The key a slot is found by.
 *
 * @param {Object} slot
 * @param {string} slot.field  the field (an id, or a label key before mapping)
 * @param {string | null} slot.subunit  the half or side, or `null` for the whole field
 * @param {string} slot.day  `mon` to `sun`
 * @param {string} slot.startTime  `HH:mm`
 * @param {string} slot.validFrom  `YYYY-MM-DD`
 * @returns {string}
 */
export function practiceSlotKey({ field, subunit, day, startTime, validFrom }) {
  return practiceTuple(field, subunit ?? null, day, startTime, validFrom);
}

const MS_PER_DAY = 86400000;
/** Monday is 0: 1970-01-01 was a Thursday. @param {number} dayNumber */
const weekdayOf = (dayNumber) => (((dayNumber + 3) % 7) + 7) % 7;
const WEEKDAY_INDEX = Object.freeze({ mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 });

/** @param {string} iso `YYYY-MM-DD` @returns {number} days since 1970-01-01 */
const dayNumberOf = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / MS_PER_DAY);

/**
 * Minutes past midnight of an `HH:mm` wall time.
 * @param {string} hhmm
 */
export const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * @typedef {Object} PracticeWindow  when a slot happens
 * @property {string} day  `mon` to `sun`
 * @property {string} startTime
 * @property {string} endTime
 * @property {string | null} validFrom  `YYYY-MM-DD`; null is open, as the column reads
 * @property {string | null} validUntil
 */

/**
 * Do two slots meet in time: the same weekday, times that overlap (back to back does not), and dates
 * that share a day which IS that weekday.
 *
 * @param {PracticeWindow} a
 * @param {PracticeWindow} b
 * @returns {boolean}
 */
export function practiceWindowsOverlap(a, b) {
  if (a.day !== b.day) return false;
  if (
    !(
      minutesOf(a.startTime) < minutesOf(b.endTime) && minutesOf(b.startTime) < minutesOf(a.endTime)
    )
  ) {
    return false;
  }
  const lo = Math.max(
    a.validFrom == null ? -Infinity : dayNumberOf(a.validFrom),
    b.validFrom == null ? -Infinity : dayNumberOf(b.validFrom)
  );
  const hi = Math.min(
    a.validUntil == null ? Infinity : dayNumberOf(a.validUntil),
    b.validUntil == null ? Infinity : dayNumberOf(b.validUntil)
  );
  if (lo > hi) return false;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return true;
  const target = WEEKDAY_INDEX[a.day];
  if (target === undefined) throw new TypeError(`practiceWindowsOverlap: "${a.day}" is not a day`);
  return lo + ((target - weekdayOf(lo) + 7) % 7) <= hi;
}

/**
 * @typedef {PracticeWindow & { fieldId: string, subunitId: string | null }} PracticeSlotShape
 */

/**
 * The supply rule between two slots: the same field, a whole field against any half or the same half
 * against itself, and {@link practiceWindowsOverlap}. Symmetric.
 *
 * @param {PracticeSlotShape} a
 * @param {PracticeSlotShape} b
 * @returns {boolean}
 */
export function practiceSlotsOverlap(a, b) {
  if (a.fieldId !== b.fieldId) return false;
  const sameGround = a.subunitId == null || b.subunitId == null || a.subunitId === b.subunitId;
  return sameGround && practiceWindowsOverlap(a, b);
}

/**
 * The most practices a team has in one scheduling week: the database's own `count` rule
 * (`practice_new_auto_row_refusals`, `20261105010000`). A scheduling week is Monday to Sunday, and the
 * practices a team has in it are the rows with a date on their weekday in that week. Two rows of one
 * team that are never in force together (a slot moved mid-season) are one a week, not two; a Monday and a
 * Wednesday row of one week are two though no date is shared. A window that holds no date on its weekday
 * never happens and counts in no week.
 *
 * @param {Array<{ day: string, validFrom: string, validUntil: string }>} rows  one team's rows
 * @returns {number}
 */
export function practicePeakPerWeek(rows) {
  if (rows.length === 0) return 0;
  const spans = rows.map((r) => {
    const dow = WEEKDAY_INDEX[r.day];
    if (dow === undefined) throw new TypeError(`practicePeakPerWeek: "${r.day}" is not a day`);
    return { dow, from: dayNumberOf(r.validFrom), until: dayNumberOf(r.validUntil) };
  });
  const first = Math.min(...spans.map((x) => x.from));
  const last = Math.max(...spans.map((x) => x.until));
  let peak = 0;
  for (let monday = first - weekdayOf(first); monday <= last; monday += 7) {
    let n = 0;
    for (const x of spans) if (monday + x.dow >= x.from && monday + x.dow <= x.until) n += 1;
    peak = Math.max(peak, n);
  }
  return peak;
}
