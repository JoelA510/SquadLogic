/**
 * The practice clash rule, written once (task G2b of PR 7 of the schedule expansion; plan 4.11.4): two of one
 * coach's practices clash when they fall on one weekday at overlapping times on dates both are live.
 *
 * It is the rule of the practice import's `coach-conflict` flag (a coach of two teams in overlapping slots on one
 * weekday on shared dates), so the coach schedule and the import state one rule. A practice is **never compared with
 * a game**: a weekly series against a dated event is stated on the page and not checked.
 *
 * - **Overlap** is strict: one practice ending as the other starts is not a clash.
 * - **Live dates** are the practice's own `effective_date_range` cut to its slot's validity (`valid_from`,
 *   `valid_until`, both inclusive); a missing range or validity is unbounded on that side, as
 *   `utils/practiceLiveDates.js` reads a range-less row. The range is read by `practiceRangeBounds`, the reader the
 *   portal and the feed already use, never by a third parser.
 * - **A row that cannot be read is not judged clean.** `readPractice` says why; the caller names it.
 *
 * Dates are day numbers: no `Date` is constructed (GAP-30).
 *
 * @module reports/practiceClash
 */

import { isoDateOfDayNumber, isoDayNumber } from '../facility/eligibility.js';
import { calendarDayNumber, wallSeconds } from '../utils/practiceLiveDates.js';
import {
  DAY_OF_WEEK_ENUM,
  practiceRangeBounds,
  practiceRangeLowerBound,
} from '../utils/practiceOccurrences.js';

/**
 * A practice as the reports take it.
 *
 * @typedef {Object} ReportPractice
 * @property {string} id
 * @property {string} teamId
 * @property {string | null} [range] - the `effective_date_range` literal, e.g. `[2026-09-08,2026-11-20)`
 * @property {string | null} [dayOfWeek] - `mon` to `sun`
 * @property {string | null} [startTime] - `HH:MM[:SS]`
 * @property {string | null} [endTime]
 * @property {string | null} [validFrom] - the slot's first date
 * @property {string | null} [validUntil] - the slot's last date
 * @property {string | null} [fieldId]
 * @property {string | null} [fieldName]
 */

/** Why a practice has no reading, as a closed list of codes the coach schedule prints in its Reason Code cell. */
export const PRACTICE_UNREADABLE = Object.freeze({
  SLOT_MISSING: 'PRACTICE_SLOT_MISSING',
  TIME_UNREADABLE: 'PRACTICE_TIME_UNREADABLE',
  RANGE_UNREADABLE: 'PRACTICE_RANGE_UNREADABLE',
});

const WHY = Object.freeze({
  [PRACTICE_UNREADABLE.SLOT_MISSING]: 'the practice has no slot, so it has no day or time',
  [PRACTICE_UNREADABLE.TIME_UNREADABLE]: 'the practice’s day or time cannot be read',
  [PRACTICE_UNREADABLE.RANGE_UNREADABLE]: 'the practice’s date range cannot be read',
});

const has = (value) => value !== null && value !== undefined && String(value).trim() !== '';

/**
 * The reading of one practice: its weekday, its wall times in seconds and the day numbers it is live between.
 *
 * @param {ReportPractice} practice
 * @returns {{ ok: true, weekday: number, startSec: number, endSec: number, lo: number, hi: number }
 *   | { ok: false, code: string, why: string }}
 */
export function readPractice(practice) {
  const refuse = (code) => /** @type {const} */ ({ ok: false, code, why: WHY[code] });
  if (!has(practice?.dayOfWeek) && !has(practice?.startTime) && !has(practice?.endTime)) {
    return refuse(PRACTICE_UNREADABLE.SLOT_MISSING);
  }
  const weekday = DAY_OF_WEEK_ENUM.indexOf(String(practice.dayOfWeek ?? '').toLowerCase());
  const startSec = wallSeconds(practice.startTime);
  const endSec = wallSeconds(practice.endTime);
  if (weekday < 0 || startSec === null || endSec === null || startSec >= endSec) {
    return refuse(PRACTICE_UNREADABLE.TIME_UNREADABLE);
  }

  let lo = Number.NEGATIVE_INFINITY;
  let hi = Number.POSITIVE_INFINITY;
  for (const [value, side] of [
    [practice.validFrom, 'lo'],
    [practice.validUntil, 'hi'],
  ]) {
    if (!has(value)) continue;
    const day = calendarDayNumber(String(value));
    if (day === null) return refuse(PRACTICE_UNREADABLE.RANGE_UNREADABLE);
    if (side === 'lo') lo = Math.max(lo, day);
    else hi = Math.min(hi, day);
  }
  if (has(practice.range)) {
    const bounds = practiceRangeBounds(practice.range);
    if (bounds !== null) {
      lo = Math.max(lo, isoDayNumber(bounds.first));
      hi = Math.min(hi, isoDayNumber(bounds.last));
    } else {
      const lower = practiceRangeLowerBound(practice.range);
      // An open-ended series runs to the end of its slot's validity.
      if (lower === null || !lower.upperUnbounded)
        return refuse(PRACTICE_UNREADABLE.RANGE_UNREADABLE);
      lo = Math.max(lo, isoDayNumber(lower.first));
    }
  }
  return { ok: true, weekday, startSec, endSec, lo, hi };
}

/** 0 = Sunday, for a day number (1970-01-01 was a Thursday). @param {number} day */
const weekdayOfDay = (day) => (((day + 4) % 7) + 7) % 7;

/**
 * Do two practices clash?
 *
 * @param {ReportPractice} a
 * @param {ReportPractice} b
 * @returns {{ judged: true, clash: boolean, sharedDates: number | null, firstDate: string | null }
 *   | { judged: false, clash: false, why: string, code: string }}
 */
export function practicesClash(a, b) {
  const first = readPractice(a);
  const second = readPractice(b);
  if (first.ok === false) return { judged: false, clash: false, why: first.why, code: first.code };
  if (second.ok === false) {
    return { judged: false, clash: false, why: second.why, code: second.code };
  }
  const none = {
    judged: /** @type {const} */ (true),
    clash: false,
    sharedDates: 0,
    firstDate: null,
  };
  if (first.weekday !== second.weekday) return none;
  if (!(first.startSec < second.endSec && second.startSec < first.endSec)) return none;

  const lo = Math.max(first.lo, second.lo);
  const hi = Math.min(first.hi, second.hi);
  if (lo > hi) return none;
  if (!Number.isFinite(lo)) {
    // Neither practice has a first date: they are live on every such weekday, for as long as that is.
    return { judged: true, clash: true, sharedDates: null, firstDate: null };
  }
  const start = lo + ((first.weekday - weekdayOfDay(lo) + 7) % 7);
  if (start > hi) return none;
  return {
    judged: true,
    clash: true,
    sharedDates: Number.isFinite(hi) ? Math.floor((hi - start) / 7) + 1 : null,
    firstDate: isoDateOfDayNumber(start),
  };
}

/**
 * Every clashing pair among one coach's practices, once, and the practices that could not be read.
 *
 * @param {ReportPractice[]} practices
 * @returns {{ clashes: Array<{ a: string, b: string, dayOfWeek: string, sharedDates: number | null, firstDate: string | null }>,
 *   unjudged: string[] }}
 */
export function coachPracticeClashes(practices) {
  const clashes = [];
  const unjudged = [];
  const readable = [];
  for (const practice of practices) {
    if (readPractice(practice).ok) readable.push(practice);
    else unjudged.push(practice.id);
  }
  for (let i = 0; i < readable.length; i += 1) {
    for (let j = i + 1; j < readable.length; j += 1) {
      const result = practicesClash(readable[i], readable[j]);
      if (result.judged && result.clash) {
        clashes.push({
          a: readable[i].id,
          b: readable[j].id,
          dayOfWeek: String(readable[i].dayOfWeek).toLowerCase(),
          sharedDates: result.sharedDates,
          firstDate: result.firstDate,
        });
      }
    }
  }
  return { clashes, unjudged };
}
