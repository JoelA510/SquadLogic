/**
 * The Practice daylight outlook's model and its words (duration-phase wiring,
 * PR B of `docs/changes/2026-11-02-duration-phases-wiring.md`; owner,
 * 2026-11-02: "Wire the durationPhases as recommended.", "Go with A").
 *
 * Stored rows and the season in; one view row per practice slot on unlit
 * ground out. The chain is the approved one, reused and never restated:
 * `buildDurationPhaseInput` turns the rows into the reports' input,
 * `derivePracticeDurationPhases` (G3) says how each slot would be retimed, and
 * `buildDstSurvivalReport` (G5) says whether it survives the season and what
 * would fix it. G4's cascade is not called (plan section 6): its proposals
 * leave only as an 8.8 change-log that no screen renders.
 *
 * **Read-only, and a proposal.** Nothing here writes, and nothing it says is
 * applied: a slot that would have to be shortened is shortened by an admin
 * editing the slot or the assignment, or not at all.
 *
 * **A sunset condition is a warning, never a refusal** (owner, 2026-11-02).
 * A date that no shortening and no earlier start saves is *kept as scheduled
 * and flagged*; an unknown sunset is flagged, never read as fine. The wording
 * here never says "blocked" or "refused" of a practice, and never "lost".
 *
 * **Two kinds of flag, worded apart.** The module raises the same finding
 * (`PRACTICE_PAST_SUNSET`) for a date past sunset and for a date a shifted slot
 * cannot keep because another practice holds the field. The second can sit
 * inside daylight, so it is worded as an overlap ("another practice is on this
 * field at that time") and never as past sunset.
 *
 * **The subject set is the slot rows**, not the report's output: the model
 * counts the rows it was given against the module's `slotsExamined` and
 * refuses to show a report that lost one.
 *
 * @module utils/daylightOutlook
 */

import { buildDurationPhaseInput } from '@squadlogic/core/practice/durationPhaseAdapter.js';
import {
  PRACTICE_RETIME_KIND,
  PRACTICE_RETIME_REFUSAL,
  PRACTICE_SURVIVAL_FIX_KIND,
  PRACTICE_SURVIVAL_VERDICT,
  buildDstSurvivalReport,
  derivePracticeDurationPhases,
  endsByDaylightLimit,
} from '@squadlogic/core/practice/durationPhases.js';
import { SEASON_CLOCK_EVENT, deriveSeasonClockEvents } from '@squadlogic/core/timing/index.js';

/** What the page calls a slot's outlook, worst first (the order the table lists them in). */
export const OUTLOOK_VERDICT = Object.freeze({
  FLAGGED: 'flagged',
  UNKNOWN: 'unknown',
  RETIMED: 'retimed',
  EXEMPT: 'exempt',
  OK: 'ok',
  NO_DATES: 'no-dates',
});

/** @type {ReadonlyArray<string>} */
const VERDICT_ORDER = Object.freeze([
  OUTLOOK_VERDICT.FLAGGED,
  OUTLOOK_VERDICT.UNKNOWN,
  OUTLOOK_VERDICT.RETIMED,
  OUTLOOK_VERDICT.EXEMPT,
  OUTLOOK_VERDICT.OK,
  OUTLOOK_VERDICT.NO_DATES,
]);

const WEEKDAY_ORDER = Object.freeze(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']);
const WEEKDAY_NAME = Object.freeze({
  MON: 'Monday',
  TUE: 'Tuesday',
  WED: 'Wednesday',
  THU: 'Thursday',
  FRI: 'Friday',
  SAT: 'Saturday',
  SUN: 'Sunday',
});
const WEEKDAY_SHORT = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const MONTH_SHORT = Object.freeze([
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]);

/** The fix the page adds when a sunset is unknown: not one of the module's, which has no such fix. */
const COORDINATES_FIX_KIND = 'coordinates';

/** The flagged dates listed before the rest go behind "Show the other N". */
export const FLAGGED_DATES_SHOWN = 3;

/**
 * The sentence the page opens with. Tested by its exact text: it is the
 * answer to "does this change my schedule?".
 */
export const OUTLOOK_BANNER =
  'Proposed, not applied. Nothing on this page changes a practice, an assignment or a calendar: ' +
  'it shows how each practice on unlit ground could be retimed to end by sunset, so you can decide. ' +
  'A date that no shortening or earlier start saves is kept as scheduled and flagged, never blocked.';

/** @param {number} minutes minutes past midnight @returns {string} `HH:MM` */
export function clock(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** @param {number} n @param {string} word */
const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** @param {string} iso `YYYY-MM-DD` */
function dayNumber(iso) {
  return Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
}

/**
 * A calendar date as `Tue 22 Sep` (with the year when asked). The weekday is
 * read from the date itself, in UTC, so no zone can move it.
 *
 * @param {string} iso `YYYY-MM-DD`
 * @param {{ year?: boolean }} [options]
 */
export function formatDay(iso, { year = false } = {}) {
  const at = new Date(`${iso}T00:00:00Z`);
  const text = `${WEEKDAY_SHORT[at.getUTCDay()]} ${at.getUTCDate()} ${MONTH_SHORT[at.getUTCMonth()]}`;
  return year ? `${text} ${at.getUTCFullYear()}` : text;
}

/**
 * The formatter the page uses: the year is printed only when the season's
 * window crosses a new year, so a date is never ambiguous.
 *
 * @param {{ from: string, to: string }} window
 * @returns {(iso: string) => string}
 */
export function dayFormatterFor(window) {
  const year = window.from.slice(0, 4) !== window.to.slice(0, 4);
  return (iso) => formatDay(iso, { year });
}

/**
 * The clock change that happened since this slot's previous practice (the
 * week ending on `date`), as a sentence, or `null`. The change is read from
 * the season's zone, never from a written rule, so any zone gets its own date.
 *
 * @param {string} date `YYYY-MM-DD`, a date the slot practises on
 * @param {ReadonlyArray<{ name: string, date: string, offsetBeforeMinutes: number, offsetAfterMinutes: number }>} clockChanges
 * @param {(iso: string) => string} day
 * @returns {string | null}
 */
export function clockChangeNote(date, clockChanges, day) {
  const last = dayNumber(date);
  const event = clockChanges.find((e) => dayNumber(e.date) > last - 7 && dayNumber(e.date) <= last);
  if (!event) return null;
  const minutes = Math.abs(event.offsetAfterMinutes - event.offsetBeforeMinutes);
  const size = minutes === 60 ? 'an hour' : `${minutes} minutes`;
  return event.name === SEASON_CLOCK_EVENT.DST_END
    ? `The clocks go back on ${day(event.date)}, which moves sunset about ${size} earlier.`
    : `The clocks go forward on ${day(event.date)}, which moves sunset about ${size} later.`;
}

/**
 * @typedef {Object} WordContext
 * @property {(iso: string) => string} day
 * @property {number} minimumDurationMinutes
 * @property {ReadonlyArray<any>} [clockChanges]
 * @property {number|null} [earliestStartMinutes] - the season's school-day end; null when it has none
 * @property {string} [earliestStartDays] - the days that end bounds, in words ("Monday and Tuesday")
 */

/**
 * The slot as it is planned (the first phase of its timeline).
 *
 * @param {{ startMinutes: number, durationMinutes: number }} phase
 */
export function describePlan(phase) {
  return `As planned: ${clock(phase.startMinutes)} to ${clock(phase.startMinutes + phase.durationMinutes)} (${phase.durationMinutes} min).`;
}

/**
 * One proposed change, from the date it starts: a shorter practice, or an
 * earlier start (with why shortening was not enough, when it was not).
 *
 * @param {{ effectiveFrom: string, startMinutes: number, durationMinutes: number, retime: string|null,
 *   bound: { limitMinutes: number }|null }} phase - a derived phase of `derivePracticeDurationPhases()`
 * @param {WordContext} ctx
 */
export function describePhase(phase, ctx) {
  const { startMinutes: start, durationMinutes: duration } = phase;
  const span = `${clock(start)} to ${clock(start + duration)}`;
  const limit = phase.bound ? ` The latest it may end is ${clock(phase.bound.limitMinutes)}.` : '';
  let what;
  if (phase.retime === PRACTICE_RETIME_KIND.SHORTEN) {
    what = `${duration} min, ${span}.`;
  } else if (phase.retime === PRACTICE_RETIME_KIND.FALLBACK_SHIFT) {
    what =
      `shortening would go below the ${ctx.minimumDurationMinutes}-minute minimum, so it starts at ` +
      `${clock(start)} instead, keeping ${duration} min, ${span}.`;
  } else if (phase.retime === PRACTICE_RETIME_KIND.SHIFT_EARLIER) {
    what = `start at ${clock(start)}, keeping ${duration} min, ${span}.`;
  } else {
    // Never worded as something it is not: a kind with no sentence is a page that says so.
    throw new Error(`the outlook has no wording for a phase retimed as "${phase.retime}"`);
  }
  const note = clockChangeNote(phase.effectiveFrom, ctx.clockChanges ?? [], ctx.day);
  return `From ${ctx.day(phase.effectiveFrom)}: ${what}${limit}${note ? ` ${note}` : ''}`;
}

/**
 * Is this flagged date an overlap and nothing else? The module raises
 * `PRACTICE_PAST_SUNSET` for it too (as it did the old TIME TBD entry), but
 * the slot was already moved earlier on an earlier night and another practice
 * holds the field at that start tonight: the practice may end inside daylight.
 * Such an entry is raised before any retiming is tried, so it names the start
 * the slot already has as the one that would overlap (`wouldStartMinutes` equals
 * `startMinutes`) and no shortening was refused; a date that tried to move
 * earlier always has a lower `wouldStartMinutes`.
 *
 * @param {{ shortenRefused: string|null, shiftRefused: string|null, startMinutes: number,
 *   wouldStartMinutes: number }} entry
 */
function raisedByOverlapFirst(entry) {
  return (
    entry.shiftRefused === PRACTICE_RETIME_REFUSAL.OVERLAP &&
    entry.shortenRefused === null &&
    entry.wouldStartMinutes === entry.startMinutes
  );
}

/**
 * An overlap and nothing else: raised by the overlap check, and the practice at
 * the timing it has ends inside daylight.
 *
 * @param {Parameters<typeof raisedByOverlapFirst>[0] & { durationMinutes: number, limitMinutes: number }} entry
 */
function isOverlapOnly(entry) {
  return (
    raisedByOverlapFirst(entry) &&
    endsByDaylightLimit(entry.startMinutes + entry.durationMinutes, entry.limitMinutes)
  );
}

/**
 * One flagged date in words: kept as scheduled, and why nothing saves it.
 *
 * @param {{ date: string, shortenRefused: string|null, shiftRefused: string|null, startMinutes: number,
 *   durationMinutes: number, wouldStartMinutes: number, floorMinutes: number|null,
 *   earlierEndMinutes: number|null, limitMinutes: number }} entry - a `slotPhases[].flagged` entry
 * @param {WordContext} ctx
 */
export function describeFlaggedDate(entry, ctx) {
  const end = entry.startMinutes + entry.durationMinutes;
  const span = `${clock(entry.startMinutes)} to ${clock(end)}`;
  const inDaylight = endsByDaylightLimit(end, entry.limitMinutes);
  const note = clockChangeNote(entry.date, ctx.clockChanges ?? [], ctx.day);
  const tail = note ? ` ${note}` : '';
  const earlierEnd = entry.earlierEndMinutes === null ? '' : clock(entry.earlierEndMinutes);

  if (raisedByOverlapFirst(entry)) {
    return (
      `${ctx.day(entry.date)}: another practice is on this field at that time. The earlier start ` +
      `proposed for it (${span}) would overlap one that ends ${earlierEnd}.` +
      (inDaylight
        ? ''
        : ` It also ends after the latest it may end (${clock(entry.limitMinutes)}).`) +
      ` It is kept as scheduled and flagged.${tail}`
    );
  }

  const parts = [
    `${ctx.day(entry.date)}: it runs ${span}, after the latest it may end (${clock(entry.limitMinutes)}).`,
  ];
  if (entry.shortenRefused === PRACTICE_RETIME_REFUSAL.BELOW_MINIMUM) {
    parts.push(`Shortening would go below the ${ctx.minimumDurationMinutes}-minute minimum.`);
  }
  if (entry.shiftRefused === PRACTICE_RETIME_REFUSAL.EARLIEST_START_FLOOR) {
    parts.push(
      `Starting at ${clock(entry.wouldStartMinutes)} is before school ends (${clock(/** @type {number} */ (entry.floorMinutes))}).`
    );
  } else if (entry.shiftRefused === PRACTICE_RETIME_REFUSAL.EARLIEST_START_UNKNOWN) {
    // Null on any day the school-day end does not bound (Friday to Sunday), set or not.
    let why;
    if (ctx.earliestStartMinutes === null || ctx.earliestStartMinutes === undefined) {
      why = 'The season has no school-day end, so an earlier start is not proposed.';
    } else if (ctx.earliestStartDays) {
      why = `The school-day end only bounds ${ctx.earliestStartDays}, so no earlier start is proposed on this day.`;
    } else {
      why = 'The school-day end does not bound this day, so no earlier start is proposed on it.';
    }
    parts.push(why);
  } else if (entry.shiftRefused === PRACTICE_RETIME_REFUSAL.OVERLAP) {
    parts.push(
      `Starting at ${clock(entry.wouldStartMinutes)} would overlap another practice on this field that ends ${earlierEnd}.`
    );
  }
  parts.push('It is kept as scheduled and flagged.');
  return `${parts.join(' ')}${tail}`;
}

/**
 * Why a venue's sunset is unknown, in words.
 *
 * @param {string|null} cause - the finding's `details.cause`
 * @param {string} venue
 */
function unknownCauseText(cause, venue) {
  if (cause === 'venue-coordinates-missing') return `${venue} has no coordinates`;
  if (cause === 'sunset-not-computable') {
    return `no sunset can be computed for ${venue} on some dates`;
  }
  return `no sunset is known for ${venue}`;
}

/**
 * The slot's unknown sunsets in words, naming each venue and why.
 *
 * @param {{ dates: number, causes: Array<{ venue: string, cause: string|null }> }} unknown
 */
export function describeUnknown({ dates, causes }) {
  const why =
    causes.length === 0
      ? 'no sunset is known there'
      : causes.map(({ venue, cause }) => unknownCauseText(cause, venue)).join('; ');
  return (
    `Sunset unknown on ${count(dates, 'date')}: ${why}. It cannot be shown to end by sunset, so it ` +
    'is flagged and never read as fine.'
  );
}

/**
 * What the report offers for a slot that does not survive, as a sentence each.
 * A fix that is not available is not listed.
 *
 * @param {Record<string, any>} fix - an entry of a G5 row's `fixes`
 * @param {{ day: (iso: string) => string, surfaceName: (id: string) => string,
 *   durationMinutes: number, minimumDurationMinutes: number }} ctx
 * @returns {{ kind: string, text: string, link: 'lighting' | 'fields' | null } | null}
 */
export function describeFix(fix, ctx) {
  if (!fix.available) return null;
  if (fix.kind === PRACTICE_SURVIVAL_FIX_KIND.LIT_FIELD) {
    const names = fix.surfaceIds.map(ctx.surfaceName);
    const shown = names.slice(0, 3).join(', ');
    const more = names.length > 3 ? ` and ${names.length - 3} more` : '';
    return {
      kind: fix.kind,
      text: `A lit field: ${shown}${more}. Only the lighting is checked.`,
      link: null,
    };
  }
  if (fix.kind === PRACTICE_SURVIVAL_FIX_KIND.EARLIER_START) {
    const shortest = Math.min(ctx.minimumDurationMinutes, ctx.durationMinutes);
    const full =
      fix.startMinutesAtFullDuration === null
        ? ''
        : `a start no later than ${clock(fix.startMinutesAtFullDuration)} keeps the full ${ctx.durationMinutes} min, and `;
    return {
      kind: fix.kind,
      text:
        `An earlier start: ${full}one no later than ${clock(fix.startMinutesAtMinimumDuration)} ` +
        `ends by sunset at ${shortest} min, judged on the tightest date (${ctx.day(fix.bindingDate)}).`,
      link: null,
    };
  }
  if (fix.kind === PRACTICE_SURVIVAL_FIX_KIND.ANOTHER_NIGHT) {
    const nights = fix.weekdays.map((/** @type {string} */ w) => WEEKDAY_NAME[w] ?? w).join(', ');
    return {
      kind: fix.kind,
      text: `Another night: ${nights} would end by sunset on every date, judged at this venue's sunset with shortening only.`,
      link: null,
    };
  }
  if (fix.kind !== PRACTICE_SURVIVAL_FIX_KIND.LIGHTING_OVERRIDE) {
    throw new Error(`the outlook has no wording for a fix of kind "${fix.kind}"`);
  }
  const { from, until } = fix.window;
  return {
    kind: fix.kind,
    text:
      from === until
        ? `Portable lighting: an approved window on ${ctx.day(from)} exempts that date.`
        : `Portable lighting: an approved window from ${ctx.day(from)} to ${ctx.day(until)} exempts those dates.`,
    link: 'lighting',
  };
}

/** What every fix list ends with: they are candidates, not checked ones. */
export const FIXES_UNCHECKED =
  'These are candidates only: permits, field size and room around other practices are not checked.';

/**
 * The verdict of a slot in words: a short label, a tone for its badge, and a sentence.
 *
 * @param {string} key - an {@link OUTLOOK_VERDICT}
 * @param {{ flagged: number, overlapOnly: number, firstFlaggedDate: string|null, unknown: number,
 *   firstPhaseDate: string|null }} facts - `overlapOnly` of the `flagged` dates are overlaps and nothing else
 * @param {(iso: string) => string} day
 * @returns {{ key: string, label: string, tone: 'success'|'info'|'warning'|'neutral', headline: string }}
 */
export function describeVerdict(key, facts, day) {
  switch (key) {
    case OUTLOOK_VERDICT.FLAGGED: {
      const first = day(/** @type {string} */ (facts.firstFlaggedDate));
      const pastSunset = facts.flagged - facts.overlapOnly;
      const label = `Flagged on ${count(facts.flagged, 'date')}`;
      const kept = 'Those dates are kept as scheduled and flagged.';
      let because;
      if (facts.overlapOnly === 0) {
        because = `On ${count(facts.flagged, 'date')} no shortening or earlier start keeps it inside daylight, the first being ${first}.`;
      } else if (pastSunset === 0) {
        because = `On ${count(facts.flagged, 'date')} another practice is on the field at the time its earlier start needs, the first being ${first}.`;
      } else {
        because =
          `It is flagged on ${count(facts.flagged, 'date')}: ${count(pastSunset, 'date')} that no shortening or earlier ` +
          `start keeps inside daylight and ${count(facts.overlapOnly, 'date')} where another practice is on the field ` +
          `at that time. The first is ${first}.`;
      }
      // A slot that was retimed before its first flagged date went dark earlier than that date.
      const dark =
        facts.firstPhaseDate !== null && facts.firstPhaseDate < facts.firstFlaggedDate
          ? `As planned it would end past sunset from ${day(facts.firstPhaseDate)}. `
          : '';
      return { key, label, tone: 'warning', headline: `${dark}${because} ${kept}` };
    }
    case OUTLOOK_VERDICT.UNKNOWN:
      return {
        key,
        label: 'Sunset unknown',
        tone: 'warning',
        headline: `No sunset is known on ${count(facts.unknown, 'date')}, so it cannot be shown to end by sunset.`,
      };
    case OUTLOOK_VERDICT.RETIMED:
      return {
        key,
        label: 'Retime to stay in daylight',
        tone: 'info',
        headline:
          `As planned it would end past sunset from ${day(/** @type {string} */ (facts.firstPhaseDate))}; ` +
          'the changes below keep it inside daylight on every date.',
      };
    case OUTLOOK_VERDICT.EXEMPT:
      return {
        key,
        label: 'Under portable lighting',
        tone: 'info',
        headline: 'Every date is under an approved lighting window, so none is judged.',
      };
    case OUTLOOK_VERDICT.NO_DATES:
      return {
        key,
        label: 'No practice dates',
        tone: 'neutral',
        headline:
          'Its weekday never falls inside its dates and the season, so there is nothing to judge.',
      };
    case OUTLOOK_VERDICT.OK:
      return {
        key,
        label: 'Ends by sunset all season',
        tone: 'success',
        headline: 'It ends by sunset on every date as planned.',
      };
    default:
      // An outlook with no sentence is never drawn as the green one: that says it is fine.
      throw new Error(`the outlook has no wording for the verdict "${key}"`);
  }
}

/**
 * The line under the banner: which approach is taken, because there is no
 * setting to take another.
 *
 * @param {{ minimumDurationMinutes: number, durationStepMinutes: number, earliestStartMinutes: number|null,
 *   earliestStartDays: string }} rules
 */
export function describeRules({
  minimumDurationMinutes,
  durationStepMinutes,
  earliestStartMinutes,
  earliestStartDays,
}) {
  const shorten = `Each slot is shortened first, in ${durationStepMinutes}-minute steps to no less than ${minimumDurationMinutes} minutes`;
  const rest =
    ' There is no setting to choose another approach per slot, and permits, field size and capacity are not checked.';
  if (earliestStartMinutes === null) {
    return `${shorten}. The season has no school-day end set, so starting earlier is not proposed.${rest}`;
  }
  const days = earliestStartDays
    ? `The school-day end only bounds ${earliestStartDays}, so on other days a practice is shortened but not started earlier.`
    : 'The school-day end bounds no day, so a practice is shortened and not started earlier.';
  return (
    `${shorten}, then started earlier when that would break the minimum, never before school ends at ` +
    `${clock(earliestStartMinutes)} and never into another practice on the same field. ${days}${rest}`
  );
}

/**
 * Weekday codes as words: "Monday, Tuesday and Wednesday".
 *
 * @param {ReadonlyArray<string>} codes
 */
function listDays(codes) {
  const words = codes.map(
    (code) => WEEKDAY_NAME[/** @type {keyof typeof WEEKDAY_NAME} */ (code)] ?? code
  );
  return words.length < 2
    ? words.join('')
    : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** @param {unknown} value an id */
const lower = (value) => String(value).toLowerCase();

/**
 * Names for surfaces, venues and teams, from the SAME rows the adapter read.
 * Ids are compared lowercased, as the adapter does.
 *
 * @param {Record<string, any[]>} rows
 */
function namesOf(rows) {
  const venue = new Map((rows.locations ?? []).map((l) => [lower(l.id), l.name || lower(l.id)]));
  const fieldById = new Map((rows.fields ?? []).map((f) => [lower(f.id), f]));
  /** @type {Map<string, string>} */
  const surface = new Map();
  for (const f of rows.fields ?? []) {
    surface.set(
      lower(f.id),
      `${f.name || lower(f.id)} (${venue.get(lower(f.location_id)) ?? '?'})`
    );
  }
  for (const s of rows.fieldSubunits ?? []) {
    const f = fieldById.get(lower(s.field_id));
    surface.set(
      lower(s.id),
      `${f?.name ?? '?'} ${s.label || lower(s.id)} (${venue.get(lower(f?.location_id)) ?? '?'})`
    );
  }
  const team = new Map((rows.teams ?? []).map((t) => [lower(t.id), t.name || lower(t.id)]));
  return {
    venue: (/** @type {string|null} */ id) =>
      id === null ? 'its venue' : (venue.get(lower(id)) ?? id),
    surface: (/** @type {string} */ id) => surface.get(lower(id)) ?? id,
    team: (/** @type {string} */ id) => team.get(lower(id)) ?? id,
  };
}

/** @param {string[]} names @param {number} [shown] */
function listSome(names, shown = 4) {
  const head = names.slice(0, shown).join(', ');
  return names.length > shown ? `${head} and ${names.length - shown} more` : head;
}

/**
 * How many of the rows' slots stand on a venue declared lit, counted from the rows
 * and nothing the reports said (a venue whose lighting is not stated is not lit).
 * A second reading of the rule, on purpose: the adapter passes no per-surface lighting
 * record, so a venue's own flag is the whole of it today; the day it does, this and the
 * reports disagree, the page refuses to draw, and this is what to update.
 *
 * @param {Record<string, any[]>} rows
 */
function litSlotsOf(rows) {
  const lit = new Map(
    (rows.locations ?? []).map((l) => [lower(l.id), l.lighting_available === true])
  );
  const venueOfField = new Map((rows.fields ?? []).map((f) => [lower(f.id), lower(f.location_id)]));
  const fieldOfSubunit = new Map(
    (rows.fieldSubunits ?? []).map((s) => [lower(s.id), lower(s.field_id)])
  );
  return rows.practiceSlots.filter((slot) => {
    const fieldId =
      slot.field_subunit_id == null
        ? lower(slot.field_id)
        : fieldOfSubunit.get(lower(slot.field_subunit_id));
    return (
      lit.get(/** @type {string} */ (venueOfField.get(/** @type {string} */ (fieldId)))) === true
    );
  }).length;
}

/**
 * The teams on a slot, by name, each with the part of the season it has the slot for when that is
 * not all of it. Read from the slot set the reports were run on, so the dates are the ones they
 * judged (a slot with no dates of its own is dated by the season). An assignment that ends before
 * the slot's dates in the season, or starts after them, is not listed.
 *
 * @param {import('@squadlogic/core/practice/types.js').PracticeSlotSet} slotSet
 * @param {{ from: string, to: string }} window
 * @param {(id: string) => string} teamName
 * @param {(iso: string) => string} day
 * @returns {Map<string, string[]>} slot id -> labels, in name order
 */
function teamsOnSlots(slotSet, window, teamName, day) {
  const slotById = new Map(slotSet.slots.map((slot) => [slot.id, slot]));
  /** @type {Map<string, Map<string, { name: string, label: string, first: string }>>} */
  const bySlot = new Map();
  for (const assignment of slotSet.assignments) {
    const slot = /** @type {NonNullable<ReturnType<typeof slotById.get>>} */ (
      slotById.get(assignment.slotId)
    );
    // The dates the slot is practised on within the season.
    const lo = slot.validFrom && slot.validFrom > window.from ? slot.validFrom : window.from;
    const hi = slot.validUntil && slot.validUntil < window.to ? slot.validUntil : window.to;
    if (lo > hi) continue;
    const first = assignment.effectiveFrom ?? lo;
    const last = assignment.effectiveUntil ?? hi;
    if (first > hi || last < lo) continue;
    const name = teamName(assignment.teamId);
    const from = first > lo ? `from ${day(first)}` : '';
    const until = last < hi ? `until ${day(last)}` : '';
    const label = from || until ? `${name} (${[from, until].filter(Boolean).join(' ')})` : name;
    const entries = bySlot.get(assignment.slotId) ?? new Map();
    entries.set(`${name}|${first}|${last}`, { name, label, first });
    bySlot.set(assignment.slotId, entries);
  }
  return new Map(
    [...bySlot].map(([slotId, entries]) => [
      slotId,
      [...entries.values()]
        .sort((a, b) => a.name.localeCompare(b.name) || a.first.localeCompare(b.first))
        .map((entry) => entry.label),
    ])
  );
}

/**
 * @typedef {Object} OutlookRow
 * @property {string} slotId
 * @property {string} title - `Tuesday 18:00 to 19:00`
 * @property {string} ground - the field or half and its venue
 * @property {string} teams - the teams assigned to it, or that none is
 * @property {{ key: string, label: string, tone: 'success'|'info'|'warning'|'neutral', headline: string }} verdict
 * @property {string} plan
 * @property {Array<{ date: string, text: string }>} phases - the proposed changes, in date order
 * @property {{ dates: number, first: string, items: Array<{ date: string, text: string }> }|null} flagged
 * @property {string|null} unknown
 * @property {string|null} exempt
 * @property {Array<{ kind: string, text: string, link: 'lighting' | 'fields' | null }>} fixes
 * @property {boolean} candidatesUnchecked - the fixes include the module's, whose permits, size and room are not checked
 * @property {string|null} fixesNote - what to say when there is no fix to list
 */

/**
 * The summary sentence over the counts.
 *
 * @param {{ slots: number, dates: number, litSlots: number }} counts
 * @param {{ from: string, to: string }} window
 * @param {string} timeZone
 * @param {(iso: string) => string} day
 */
export function describeSummary(counts, window, timeZone, day) {
  const lit =
    counts.litSlots === 0
      ? ''
      : ` ${count(counts.litSlots, 'practice slot')} on lit ground ${counts.litSlots === 1 ? 'is' : 'are'} not judged.`;
  return (
    `${count(counts.slots, 'practice slot')} on unlit ground, ${count(counts.dates, 'practice date')} from ` +
    `${day(window.from)} to ${day(window.to)} (${timeZone}).${lit}`
  );
}

/**
 * The outlook over the rows a page read and the season it shows.
 *
 * Throws what the adapter throws (a location that is not a uuid, a season with
 * no zone or dates, an unreadable row): the caller shows the message and no row.
 *
 * @param {{ rows: Record<string, any[]>, season: Record<string, any> }} input
 * @returns {{
 *   window: { from: string, to: string },
 *   timeZone: string,
 *   summary: string,
 *   rules: string,
 *   counts: { slots: number, dates: number, litSlots: number, byVerdict: Record<string, number> },
 *   judged: boolean,
 *   noCoordinates: boolean,
 *   notes: string[],
 *   rows: OutlookRow[],
 * }}
 */
export function buildDaylightOutlook({ rows, season }) {
  const adapted = buildDurationPhaseInput({
    locations: rows.locations,
    fields: rows.fields,
    fieldSubunits: rows.fieldSubunits,
    practiceSlots: rows.practiceSlots,
    practiceAssignments: rows.practiceAssignments,
    lightingOverrides: rows.lightingOverrides,
    season: /** @type {any} */ (season),
  });
  const phases = derivePracticeDurationPhases(adapted.input);
  const survival = buildDstSurvivalReport(adapted.input);

  // The subject set is the rows read, not what the reports returned: a slot the
  // adapter or a report dropped would otherwise be absent from the page and
  // from every count on it.
  if (phases.meta.slotsExamined !== rows.practiceSlots.length) {
    throw new Error(
      `the outlook examined ${phases.meta.slotsExamined} of the ${rows.practiceSlots.length} practice slots read, so it is not shown`
    );
  }
  const timelines = new Map(phases.slotPhases.map((timeline) => [timeline.slotId, timeline]));
  if (survival.rows.length !== phases.slotPhases.length) {
    throw new Error('the two daylight reports disagree on which slots are on unlit ground');
  }
  // ... and the unlit ones are counted from the rows, by each venue's own flag, so a report that
  // lost or invented an unlit slot is not shown whatever its two halves say of each other.
  const litFromRows = litSlotsOf(rows);
  if (
    survival.meta.litSlotsExempt !== litFromRows ||
    survival.rows.length !== rows.practiceSlots.length - litFromRows
  ) {
    throw new Error(
      `the outlook lists ${survival.rows.length} unlit and ${survival.meta.litSlotsExempt} lit slots of the ${rows.practiceSlots.length} read, and the rows say ${litFromRows} are lit`
    );
  }

  const { window, timeZone } = adapted.declared;
  const day = dayFormatterFor(window);
  const names = namesOf(rows);
  // From a week before the first date: a clock change is named on a slot's first practice after it,
  // which can be up to six days after it, and the first date of the season has no day before it in
  // the window. (The adapter has refused an unreadable zone or window, so the events are readable.)
  const weekBefore = new Date(Date.parse(`${window.from}T00:00:00Z`) - 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const { events: clockChanges } = deriveSeasonClockEvents({
    from: weekBefore,
    to: window.to,
    timeZone,
  });
  const minimum = survival.minimumDurationMinutes;
  const earliestStartDays = listDays(survival.earliestStartWeekdays);
  /** @type {WordContext} */
  const ctx = {
    day,
    minimumDurationMinutes: minimum,
    clockChanges,
    earliestStartMinutes: adapted.declared.earliestStart.minutes,
    earliestStartDays,
  };

  /** @type {Map<string, Set<string|null>>} venue id -> the causes its unknown sunsets gave */
  const causesByVenue = new Map();
  for (const finding of survival.findings) {
    const venueId = finding.details?.venueId;
    if (finding.code !== 'SUNSET_UNKNOWN' || typeof venueId !== 'string') continue;
    const causes = causesByVenue.get(venueId) ?? new Set();
    causes.add(/** @type {string|null} */ (finding.details?.cause ?? null));
    causesByVenue.set(venueId, causes);
  }

  const teamsBySlot = teamsOnSlots(adapted.input.slotSet, window, names.team, day);

  const keyed = survival.rows.map((row) => {
    const timeline = timelines.get(row.slotId);
    if (!timeline) throw new Error(`slot ${row.slotId} has a survival row and no timeline`);
    // G5's list and G3's entries are one list; a difference is a report that lost a flagged date.
    if (timeline.flagged.length !== row.flaggedDates.length) {
      throw new Error(`slot ${row.slotId}: the reports disagree on its flagged dates`);
    }
    const retimes = timeline.phases.slice(1);
    const flaggedEntries = timeline.flagged;
    let key;
    if (row.verdict === PRACTICE_SURVIVAL_VERDICT.EXEMPT) key = OUTLOOK_VERDICT.EXEMPT;
    else if (row.verdict === PRACTICE_SURVIVAL_VERDICT.NO_DATES) key = OUTLOOK_VERDICT.NO_DATES;
    else if (row.verdict === PRACTICE_SURVIVAL_VERDICT.DOES_NOT_SURVIVE) {
      key = OUTLOOK_VERDICT.FLAGGED;
    } else if (row.verdict === PRACTICE_SURVIVAL_VERDICT.UNKNOWN) key = OUTLOOK_VERDICT.UNKNOWN;
    else if (row.verdict === PRACTICE_SURVIVAL_VERDICT.SURVIVES) {
      key = retimes.length > 0 ? OUTLOOK_VERDICT.RETIMED : OUTLOOK_VERDICT.OK;
    } else {
      throw new Error(`slot ${row.slotId}: the survival report gave the verdict "${row.verdict}"`);
    }

    const facts = {
      flagged: flaggedEntries.length,
      overlapOnly: flaggedEntries.filter(isOverlapOnly).length,
      firstFlaggedDate: row.firstFlaggedDate,
      unknown: row.unknownDates.length,
      firstPhaseDate: retimes[0]?.effectiveFrom ?? null,
    };
    const venueName = names.venue(row.venueId);
    const causes = [...(causesByVenue.get(row.venueId ?? '') ?? [])];
    const teamNames = teamsBySlot.get(row.slotId) ?? [];
    const fixCtx = {
      day,
      surfaceName: names.surface,
      durationMinutes: row.durationMinutes,
      minimumDurationMinutes: minimum,
    };
    const weekdayName =
      WEEKDAY_NAME[/** @type {keyof typeof WEEKDAY_NAME} */ (row.weekday)] ?? row.weekday;
    const exempt = row.exemptDates.length;

    /** @type {OutlookRow} */
    const view = {
      slotId: row.slotId,
      title: `${weekdayName} ${clock(row.startMinutes)} to ${clock(row.startMinutes + row.durationMinutes)}`,
      ground: names.surface(row.surfaceId),
      teams: teamNames.length > 0 ? listSome(teamNames) : 'no team assigned',
      verdict: describeVerdict(key, facts, day),
      plan: describePlan(timeline.phases[0]),
      phases: retimes.map((phase) => ({
        date: phase.effectiveFrom,
        text: describePhase(phase, ctx),
      })),
      flagged:
        flaggedEntries.length === 0
          ? null
          : {
              dates: flaggedEntries.length,
              first: flaggedEntries[0].date,
              items: flaggedEntries.map((entry) => ({
                date: entry.date,
                text: describeFlaggedDate(entry, ctx),
              })),
            },
      unknown:
        row.unknownDates.length === 0
          ? null
          : describeUnknown({
              dates: row.unknownDates.length,
              causes: causes.map((cause) => ({ venue: venueName, cause })),
            }),
      exempt:
        exempt === 0
          ? null
          : `${count(exempt, 'date')} ${exempt === 1 ? 'is' : 'are'} under an approved lighting window and ${exempt === 1 ? 'is' : 'are'} not judged.`,
      fixes: [
        ...row.fixes.map((fix) => describeFix(fix, fixCtx)).filter((fix) => fix !== null),
        ...(row.unknownDates.length === 0
          ? []
          : [
              {
                kind: COORDINATES_FIX_KIND,
                text: `Set the coordinates of ${venueName}: the sunset is then worked out for every date.`,
                link: /** @type {'fields'} */ ('fields'),
              },
            ]),
      ],
      candidatesUnchecked: row.fixes.some((fix) => fix.available),
      fixesNote: null,
    };
    if (view.fixes.length === 0) {
      view.fixesNote =
        key === OUTLOOK_VERDICT.RETIMED ? 'The proposed changes are enough.' : 'Nothing to fix.';
    }
    return { view, weekday: row.weekday, start: row.startMinutes };
  });

  // Worst first, then the week's order; the id breaks every tie, so the order is the same on every read.
  keyed.sort(
    (a, b) =>
      VERDICT_ORDER.indexOf(a.view.verdict.key) - VERDICT_ORDER.indexOf(b.view.verdict.key) ||
      WEEKDAY_ORDER.indexOf(a.weekday) - WEEKDAY_ORDER.indexOf(b.weekday) ||
      a.start - b.start ||
      a.view.ground.localeCompare(b.view.ground) ||
      a.view.slotId.localeCompare(b.view.slotId)
  );
  const view = keyed.map((entry) => entry.view);

  /** @type {Record<string, number>} */
  const byVerdict = Object.fromEntries(VERDICT_ORDER.map((key) => [key, 0]));
  for (const row of view) byVerdict[row.verdict.key] += 1;

  // Every judged date unknown and no unlit venue with coordinates: nothing here
  // can say anything yet, so the page points at the coordinates instead.
  const unlitVenues = new Set(survival.rows.map((row) => row.venueId).filter((id) => id !== null));
  const withCoordinates = [...unlitVenues].filter((id) => {
    const venue = adapted.input.calendar.daylightByVenue?.[/** @type {string} */ (id)];
    return venue && venue.latitude !== null && venue.longitude !== null;
  });
  const noCoordinates =
    survival.meta.slotDatesExamined > 0 &&
    survival.meta.slotDatesSunsetUnknown === survival.meta.slotDatesExamined &&
    withCoordinates.length === 0;

  /** @type {string[]} */
  const notes = [];
  const declared = adapted.declared;
  const undated = declared.datedBySeasonWindow.length;
  if (undated > 0) {
    notes.push(
      `${count(undated, 'practice slot')} ${undated === 1 ? 'has' : 'have'} no start or end date of ${undated === 1 ? 'its' : 'their'} own, so the season's dates are used for ${undated === 1 ? 'it' : 'them'}.`
    );
  }
  for (const override of declared.lightingOverrides.notApplied) {
    const slot = rows.practiceSlots.find((s) => lower(s.id) === lower(override.slotId));
    const label = slot
      ? `${WEEKDAY_NAME[/** @type {keyof typeof WEEKDAY_NAME} */ (String(slot.day_of_week).toUpperCase())] ?? slot.day_of_week} ${String(slot.start_time).slice(0, 5)} on ${names.surface(slot.field_subunit_id ?? slot.field_id)}`
      : 'a practice slot this read does not include';
    const why =
      override.why === 'lit-ground'
        ? 'it is on lit ground, where nothing is judged'
        : 'no slot of this read has that id';
    notes.push(
      `An approved lighting window for ${label} from ${day(override.from)} to ${day(override.until)} is not applied: ${why}.`
    );
  }
  // A venue whose lighting is not stated is judged as unlit by the daylight rule. Counted from the
  // rows, over the slots judged on some date (not the ones a lighting window fully exempts, or with no dates).
  const lightingStated = new Map(
    (rows.locations ?? []).map((l) => [lower(l.id), typeof l.lighting_available === 'boolean'])
  );
  const undeclared = survival.rows.filter(
    (row) =>
      row.venueId !== null &&
      lightingStated.get(row.venueId) === false &&
      row.verdict !== PRACTICE_SURVIVAL_VERDICT.EXEMPT &&
      row.verdict !== PRACTICE_SURVIVAL_VERDICT.NO_DATES
  ).length;
  if (undeclared > 0) {
    notes.push(
      undeclared === 1
        ? "1 practice slot is at a venue whose lighting is not stated, so it is judged as unlit, as the daylight rule does. State the venue's lighting on Fields & Venues."
        : `${undeclared} practice slots are at venues whose lighting is not stated, so they are judged as unlit, as the daylight rule does. State each venue's lighting on Fields & Venues.`
    );
  }
  if (declared.earliestStart.note) {
    notes.push(`Starting a practice earlier is not proposed: ${declared.earliestStart.note}.`);
  }

  const counts = {
    slots: view.length,
    dates: survival.meta.slotDatesExamined + survival.meta.slotDatesExempt,
    litSlots: survival.meta.litSlotsExempt,
    byVerdict,
  };
  return {
    window,
    timeZone,
    summary: describeSummary(counts, window, timeZone, day),
    rules: describeRules({
      minimumDurationMinutes: minimum,
      durationStepMinutes: survival.durationStepMinutes,
      earliestStartMinutes: declared.earliestStart.minutes,
      earliestStartDays,
    }),
    counts,
    judged: survival.exercised,
    noCoordinates,
    notes,
    rows: view,
  };
}
