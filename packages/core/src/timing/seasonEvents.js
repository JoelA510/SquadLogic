/**
 * Season clock events: the daylight-saving changes a season crosses, derived
 * from the season's zone rather than written down.
 *
 * ## Why an event and not a rule
 *
 * The 2026 season's evenings get an hour darker overnight on 2026-11-01, and
 * every practice limit after that date moves with it (8.9 plan, F1). That is a
 * named fact about the season, so it is reported as one: `dst-end` on the date
 * the clock went back. It is **derived** from the zone's UTC offset on
 * consecutive dates through {@link utcOffsetMinutesOn} -- the same reader
 * `sunsetOnDate()` uses -- and never from a written US rule, so a season in
 * `Europe/London` or `Australia/Sydney` gets its own dates for free.
 *
 * An event's `date` is the first date whose noon offset differs from the day
 * before. IANA zones change overnight, so that is the date the change happened
 * on; the same noon reading `solar.js` states and relies on.
 *
 * ## The corpus note, read as a cross-check (decision D12)
 *
 * `sunsets.csv` carries a `Note` column whose only content is "DST ends 11/01".
 * It was parsed and read by nothing. {@link crossCheckClockChangeNotes} reads
 * it: a note naming a clock change the zone does not make on that date is
 * reported as `CLOCK_CHANGE_NOTE_DISAGREES`. The zone is applied; the note is a
 * claim checked against it, never a second source of the date.
 *
 * `Date` is never constructed here; dates are walked as day numbers.
 *
 * @module timing/seasonEvents
 */

import { isoDateOfDayNumber, isoDayNumber } from '../facility/eligibility.js';

import { TIMING_REASON, makeTimingFinding } from './reasonCodes.js';
import { utcOffsetMinutesOn } from './solar.js';

/**
 * The clock events a season can cross.
 *
 * @readonly
 * @enum {string}
 */
export const SEASON_CLOCK_EVENT = Object.freeze({
  /** The clock goes forward: the offset grows (evenings get lighter). */
  DST_START: 'dst-start',
  /** The clock goes back: the offset shrinks (evenings get darker). */
  DST_END: 'dst-end',
});

/** `YYYY-MM-DD`. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A note naming a clock change: "DST ends 11/01", "DST starts 3/8". The
 * `MM/DD` is read in the year of the row that carries the note.
 */
const CLOCK_CHANGE_NOTE = /\bDST\s+(ends|starts|begins)\s+(\d{1,2})\/(\d{1,2})\b/i;

/**
 * @typedef {Object} SeasonClockEvent
 * @property {string} name - a {@link SEASON_CLOCK_EVENT} value
 * @property {string} date - the first date on the new offset, `YYYY-MM-DD`
 * @property {number} offsetBeforeMinutes - minutes east of UTC the day before
 * @property {number} offsetAfterMinutes - minutes east of UTC on `date`
 */

/**
 * Every clock change the zone makes between two dates, inclusive.
 *
 * Never throws on its input. An unreadable range or zone is the season clock's
 * refusal, carried as `findings` with no events: a season whose clock cannot
 * be read has no knowable events, which is not the same as having none.
 *
 * @param {{ from: string, to: string, timeZone: string|null|undefined }} input
 * @returns {{ events: SeasonClockEvent[], findings: Array<import('./types.js').TimingFinding> }}
 */
export function deriveSeasonClockEvents({ from, to, timeZone }) {
  if (
    typeof from !== 'string' ||
    typeof to !== 'string' ||
    !ISO_DATE.test(from) ||
    !ISO_DATE.test(to)
  ) {
    return {
      events: [],
      findings: [
        makeTimingFinding(
          TIMING_REASON.WALL_TIME_UNREADABLE,
          `a season's clock events need a YYYY-MM-DD range, got ${String(from)}..${String(to)}`,
          { from: String(from), to: String(to), timeZone: String(timeZone) }
        ),
      ],
    };
  }
  /** @type {SeasonClockEvent[]} */
  const events = [];
  const first = isoDayNumber(from);
  const last = isoDayNumber(to);
  let previous = null;
  for (let day = first; day <= last; day += 1) {
    const date = isoDateOfDayNumber(day);
    const { offsetMinutes, findings } = utcOffsetMinutesOn({ date, timeZone });
    if (offsetMinutes === null) return { events: [], findings };
    if (previous !== null && offsetMinutes !== previous) {
      events.push({
        name: offsetMinutes < previous ? SEASON_CLOCK_EVENT.DST_END : SEASON_CLOCK_EVENT.DST_START,
        date,
        offsetBeforeMinutes: previous,
        offsetAfterMinutes: offsetMinutes,
      });
    }
    previous = offsetMinutes;
  }
  return { events, findings: [] };
}

/**
 * Read a note as a clock-change claim, or `null` when it makes none.
 *
 * @param {string|null|undefined} note
 * @param {string} rowDate - `YYYY-MM-DD` of the row carrying the note; its year
 *   is the note's year.
 * @returns {{ name: string, date: string }|null}
 */
export function parseClockChangeNote(note, rowDate) {
  if (typeof note !== 'string' || typeof rowDate !== 'string') return null;
  const match = CLOCK_CHANGE_NOTE.exec(note);
  if (!match) return null;
  const month = match[2].padStart(2, '0');
  const day = match[3].padStart(2, '0');
  return {
    name:
      match[1].toLowerCase() === 'ends' ? SEASON_CLOCK_EVENT.DST_END : SEASON_CLOCK_EVENT.DST_START,
    date: `${rowDate.slice(0, 4)}-${month}-${day}`,
  };
}

/**
 * Check every note that names a clock change against the derived events.
 *
 * `notesExamined` counts the notes that made a claim, so a caller can assert
 * the check saw one: a cross-check over zero claims proves nothing.
 *
 * @param {{ notes: ReadonlyArray<{ date: string, note: string|null, source?: string|null }>, events: ReadonlyArray<SeasonClockEvent> }} input
 * @returns {{ findings: Array<import('./types.js').TimingFinding>, notesExamined: number, notesConfirmed: number }}
 */
export function crossCheckClockChangeNotes({ notes, events }) {
  /** @type {Array<import('./types.js').TimingFinding>} */
  const findings = [];
  let notesExamined = 0;
  let notesConfirmed = 0;
  for (const row of notes) {
    const claim = parseClockChangeNote(row.note, row.date);
    if (claim === null) continue;
    notesExamined += 1;
    const match = events.find((event) => event.name === claim.name && event.date === claim.date);
    if (match) {
      notesConfirmed += 1;
      continue;
    }
    const derived = events.filter((event) => event.name === claim.name).map((event) => event.date);
    findings.push(
      makeTimingFinding(
        TIMING_REASON.CLOCK_CHANGE_NOTE_DISAGREES,
        `the note on ${row.date} says ${claim.name} on ${claim.date}; the season's zone puts ${claim.name} on ${derived.length > 0 ? derived.join(', ') : 'no date in range'}`,
        {
          rowDate: row.date,
          note: String(row.note),
          claimedEvent: claim.name,
          claimedDate: claim.date,
          derivedDates: derived.join(','),
          source: row.source ?? null,
        }
      )
    );
  }
  return { findings, notesExamined, notesConfirmed };
}
