/**
 * Practice duration phases, compression and the DST survival report (8.9 PR 5,
 * reworked by 8.9 D14).
 *
 * `practice/daylight.js` says which practices run past sunset. This module
 * says how the season adapts, in three reports over the same universe, and
 * **applies nothing**:
 *
 * - **G3, the DurationPhase schedule.** Per unlit slot, an ordered list of
 *   `(effectiveFrom, startMinutes, durationMinutes)` phases, each showing the
 *   date, the sunset and what bound it (`slotPhases`). The output is exactly
 *   the `seasonPhases` + per-slot `seasonOverrides` (`durationMinutes`, and
 *   `startTime` for a shifted slot) that `expandPracticeSlotsForSeason()`
 *   already takes -- no second mechanism.
 * - **G4, the compression report.** *Hold-starts*: every slot-date still
 *   ending past sunset under that schedule. *Cascade*: a proposal to move the
 *   later slots of a night earlier, into the minutes the practices before them
 *   gave up. Cascade proposals leave this module **only** as 8.8 change-log
 *   entries (`changelog/classify.js` `buildChangeLog()`); nothing here writes
 *   a start time back (W13).
 * - **G5, the DST survival report.** Per unlit slot: does it survive, and if
 *   not, what would fix it -- a lit field, an earlier start, another night, a
 *   portable-lighting override.
 *
 * ## The one comparison (W12)
 *
 * The limit is `floor(sunset) - PRACTICE_SUNSET_MARGIN_MINUTES`, and the margin
 * is 0 (operator ruling 2026-09-27; D1, D2, D6). A practice ending exactly at
 * the limit is **legal** -- the same contract `evaluatePracticeDaylight()` holds
 * (`endMinutes <= limitMinutes`). {@link endsByDaylightLimit} is the only place
 * this module compares an end with a limit, so a phase transition is the first
 * date the last unlit end *exceeds* the limit, never the date it merely
 * reaches it.
 *
 * ## How a slot's phases are derived (D14, operator 2026-09-29)
 *
 * **Per slot**, never per venue: a 17:00 slot is not cut because the 18:00
 * slot beside it needed it. Over the slot's dates in order, each date that
 * ends past the limit retimes the slot by its strategy, an admin's input
 * (`strategies`, default SHORTEN):
 *
 * - **SHORTEN** keeps the start and runs `D0 - step*k` minutes, D0 the slot's
 *   own length, k the fewest steps ({@link ladderDuration}; step 10) that end
 *   it by the limit. k never decreases (maximum freeze); one date may take
 *   several steps. Never below `minimumDurationMinutes` (40): when the ladder
 *   would go below it, the slot **falls back** to shifting earlier.
 * - **SHIFT_EARLIER** keeps the duration and moves the start earlier in the
 *   same steps ({@link shiftedStart}), never before the earliest-start floor
 *   (`season_settings.school_day_end`, an input, on its weekdays) and never
 *   into an earlier slot on the same surface that night. An unknown floor
 *   refuses the shift; it is never assumed.
 *
 * A date neither can save is **held out**: TIME TBD (D8) with its date and the
 * reason, listed in `slotPhases[].tbd` -- never emitted shorter than the
 * minimum and never dropped. It leaves the slot's state as it was.
 *
 * Operator duration overrides pin a slot's duration from a date. They apply
 * before the date is judged, so one that leaves a practice past sunset is
 * superseded by a derived phase on the same date and the phase records what it
 * superseded.
 *
 * ## Portable lighting (D14)
 *
 * A `lightingOverrides` window on a slot exempts its dates: they are not
 * judged, need no sunset, are never unknown, run as planned, and are counted
 * on their own (`slotDatesExempt`), never folded into the lit counters. The
 * windows' edges are season-phase boundaries, so the schedule can say so.
 *
 * ## What is declared, not optimised (D11)
 *
 * Nothing here chooses durations, starts or nights to maximise the number of
 * surviving slots. Each retiming is the least that date needs; the cascade
 * keeps each night's first start and every gap; the fixes G5 lists are
 * candidates whose permits, sizes and capacities are **not checked**. The
 * `practice-daylight` registry claim states the same.
 *
 * ## What D8 gets from here
 *
 * The scheduler only **proposes** shortening or shifting. A weekly slot that
 * is legal early and illegal late is truncated at its first illegal date and
 * the remainder goes TIME TBD; that truncation belongs to the Edge post-pass
 * (8.9 PR 6). G5 reports the date for every slot that needs it
 * (`d8.tbdFrom`), so nothing it will truncate is discovered there for the
 * first time.
 *
 * ## Universes come from the input
 *
 * Every report enumerates the **input plan's** slots x dates (weekday within
 * the slot's range, clamped to the window) -- never the materialised
 * occurrences and never another report's output. Lit slots, undated slots,
 * exempt slot-dates and slot-dates with no known sunset are listed and
 * counted, never omitted. Dated one-off exceptions are out of scope: they are
 * judged per occurrence by `evaluatePracticeDaylight()`.
 *
 * Enforced nowhere live: the core `practiceScheduling.js`/`autoScheduler.js`
 * do not call this, and the Edge post-pass (8.9 PR 6) is a Deno twin, not a
 * caller. The D14 constants are exported for the Edge twin (PR C) to pin.
 *
 * @module practice/durationPhases
 */

import { deepFreeze, getSurface } from '../facility/facilityGraph.js';
import { isoDateOfDayNumber, isoDayNumber } from '../facility/eligibility.js';
import { resolveLighting, sunsetForVenue } from '../availability/calendar.js';
import { AVAILABILITY_REASON } from '../availability/reasonCodes.js';
import { buildChangeLog } from '../changelog/classify.js';
import { PRACTICE_SUNSET_MARGIN_MINUTES, lightingOverrideCovers } from './daylight.js';
import { teamsOn } from './materialise.js';
import {
  PRACTICE_COMPRESSION_STEP_MINUTES,
  PRACTICE_COMPRESSION_STRATEGY,
  PracticeDurationPhaseOptionsSchema,
} from './schemas.js';
import { firstWeekdayOnOrAfter } from './slots.js';

/** Where a phase's timing came from. */
export const PRACTICE_PHASE_SOURCE = Object.freeze({
  BASE: 'base',
  DERIVED: 'derived',
  OVERRIDE: 'override',
});

/** How a derived phase retimed its slot (D14). */
export const PRACTICE_RETIME_KIND = Object.freeze({
  SHORTEN: 'shorten',
  SHIFT_EARLIER: 'shift-earlier',
  /** A SHORTEN slot whose ladder would go below the minimum, shifted instead. */
  FALLBACK_SHIFT: 'fallback-shift',
});

/** Why a date could not be retimed, and so is TIME TBD (D14). */
export const PRACTICE_RETIME_REFUSAL = Object.freeze({
  BELOW_MINIMUM: 'below-minimum',
  EARLIEST_START_FLOOR: 'earliest-start-floor',
  EARLIEST_START_UNKNOWN: 'earliest-start-unknown',
  OVERLAP: 'overlap',
});

/** The fixes G5 can name for a slot that does not survive. */
export const PRACTICE_SURVIVAL_FIX_KIND = Object.freeze({
  LIT_FIELD: 'lit-field',
  EARLIER_START: 'earlier-start',
  ANOTHER_NIGHT: 'another-night',
  LIGHTING_OVERRIDE: 'lighting-override',
});

/** G5's verdict per unlit slot. */
export const PRACTICE_SURVIVAL_VERDICT = Object.freeze({
  SURVIVES: 'survives',
  DOES_NOT_SURVIVE: 'does-not-survive',
  UNKNOWN: 'unknown',
  NO_DATES: 'no-dates-in-window',
  /** Every date in the window is under a portable-lighting override. */
  EXEMPT: 'exempt',
});

/** The declared change-log source every cascade proposal is filed under. */
export const PRACTICE_SUNSET_CASCADE_SOURCE_ID = 'practice-sunset-cascade';

/**
 * The exact reason text of a cascade proposal. Declared by exact text, as the
 * season-2026 change sources are, so the registry is an allowlist.
 */
export const PRACTICE_SUNSET_CASCADE_REASON_TEXT =
  'Proposed, not applied: start earlier to follow the practices shortened before it on this night (sunset cascade)';

/** The away-side label an unassigned slot's proposal carries. */
export const PRACTICE_CASCADE_UNASSIGNED_LABEL = '(no team assigned)';

/** @type {ReadonlyArray<import('../changelog/types.js').ChangeSourceDeclaration>} */
export const PRACTICE_SUNSET_CASCADE_SOURCES = Object.freeze([
  Object.freeze({
    id: PRACTICE_SUNSET_CASCADE_SOURCE_ID,
    title: 'Sunset cascade proposal (8.9 G4)',
    matches: (/** @type {string} */ reason) => reason === PRACTICE_SUNSET_CASCADE_REASON_TEXT,
  }),
]);

const WEEKDAY_CODES = Object.freeze(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);
const WEEKDAY_NAMES = Object.freeze({
  SUN: 'Sunday',
  MON: 'Monday',
  TUE: 'Tuesday',
  WED: 'Wednesday',
  THU: 'Thursday',
  FRI: 'Friday',
  SAT: 'Saturday',
});

/**
 * Is a practice ending at `endMinutes` inside daylight? The **one** comparison
 * this module makes: equality is legal (margin 0, `floor(sunset)`; W12, W15).
 *
 * @param {number} endMinutes
 * @param {number} limitMinutes
 * @returns {boolean}
 */
export function endsByDaylightLimit(endMinutes, limitMinutes) {
  return limitMinutes >= endMinutes;
}

/**
 * The shortening ladder (D14): the duration a practice starting at
 * `startMinutes` runs so it ends by the limit, as `D0 - step*k` with D0 the
 * slot's own length and k the fewest steps that fit. k never falls below the
 * steps the current duration already took (maximum freeze), so the ladder
 * never lengthens a practice. 0 when no rung above zero fits; the caller
 * holds it against the minimum.
 *
 * @param {Object} input
 * @param {number} input.plannedDurationMinutes - D0, the slot's own length
 * @param {number} [input.currentDurationMinutes] - the duration it runs now (default D0)
 * @param {number} input.startMinutes
 * @param {number} input.limitMinutes
 * @param {number} [input.stepMinutes] - default {@link PRACTICE_COMPRESSION_STEP_MINUTES}
 * @returns {number}
 */
export function ladderDuration({
  plannedDurationMinutes,
  currentDurationMinutes = plannedDurationMinutes,
  startMinutes,
  limitMinutes,
  stepMinutes = PRACTICE_COMPRESSION_STEP_MINUTES,
}) {
  const stepsTaken = Math.ceil((plannedDurationMinutes - currentDurationMinutes) / stepMinutes);
  const stepsNeeded = Math.ceil(
    (startMinutes + plannedDurationMinutes - limitMinutes) / stepMinutes
  );
  return Math.max(0, plannedDurationMinutes - stepMinutes * Math.max(0, stepsTaken, stepsNeeded));
}

/**
 * SHIFT_EARLIER (D14): the start, moved earlier in whole steps, at which a
 * practice of `durationMinutes` ends by the limit -- or why it may not move
 * there. Refused, never assumed: with no floor (`floorMinutes` null) as
 * `earliest-start-unknown`; before the floor as `earliest-start-floor`; before
 * the end of an earlier slot on the same surface that night as `overlap`.
 *
 * @param {Object} input
 * @param {number} input.startMinutes - the start it runs at now
 * @param {number} input.durationMinutes - kept as it is
 * @param {number} input.limitMinutes
 * @param {number|null} input.floorMinutes - `season_settings.school_day_end`, or null when unknown
 * @param {number|null} [input.earlierEndMinutes] - the latest end of the earlier slots that night
 * @param {number} [input.stepMinutes]
 * @returns {{ startMinutes: number|null, refused: string|null, wouldStartMinutes: number }}
 */
export function shiftedStart({
  startMinutes,
  durationMinutes,
  limitMinutes,
  floorMinutes,
  earlierEndMinutes = null,
  stepMinutes = PRACTICE_COMPRESSION_STEP_MINUTES,
}) {
  const over = startMinutes + durationMinutes - limitMinutes;
  const start =
    over <= 0 ? startMinutes : startMinutes - stepMinutes * Math.ceil(over / stepMinutes);
  const refuse = (/** @type {string} */ refused) => ({
    startMinutes: null,
    refused,
    wouldStartMinutes: start,
  });
  if (floorMinutes === null) return refuse(PRACTICE_RETIME_REFUSAL.EARLIEST_START_UNKNOWN);
  if (start < floorMinutes) return refuse(PRACTICE_RETIME_REFUSAL.EARLIEST_START_FLOOR);
  if (earlierEndMinutes !== null && start < earlierEndMinutes) {
    return refuse(PRACTICE_RETIME_REFUSAL.OVERLAP);
  }
  return { startMinutes: start, refused: null, wouldStartMinutes: start };
}

/**
 * Can this slot, start held, be saved on a date by shortening alone? Yes when
 * it already ends by the limit at its own length (a slot shorter than the
 * minimum is not penalised for it), or when its ladder rung is at least the
 * minimum. G5's another-night fix reads it.
 *
 * @param {number} limitMinutes
 * @param {{ startMinutes: number, durationMinutes: number }} slot
 * @param {number} step
 * @param {number} minimum
 * @returns {boolean}
 */
function survivesOnDate(limitMinutes, slot, step, minimum) {
  if (endsByDaylightLimit(slot.startMinutes + slot.durationMinutes, limitMinutes)) return true;
  return (
    ladderDuration({
      plannedDurationMinutes: slot.durationMinutes,
      startMinutes: slot.startMinutes,
      limitMinutes,
      stepMinutes: step,
    }) >= minimum
  );
}

const laterOf = (/** @type {string} */ a, /** @type {string} */ b) => (a > b ? a : b);
const earlierOf = (/** @type {string} */ a, /** @type {string} */ b) => (a < b ? a : b);

/**
 * The dates a weekday falls on within a range, by day-number arithmetic.
 *
 * @param {string} weekday
 * @param {string} from
 * @param {string} to
 * @returns {string[]}
 */
function weekdayDates(weekday, from, to) {
  if (from > to) return [];
  const dates = [];
  const endDay = isoDayNumber(to);
  for (let day = isoDayNumber(firstWeekdayOnOrAfter(from, weekday)); day <= endDay; day += 7) {
    dates.push(isoDateOfDayNumber(day));
  }
  return dates;
}

/**
 * @param {number} minutes
 * @returns {string} `HH:MM`
 */
function clockOf(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * @param {string} clock - `HH:MM`, as {@link clockOf} writes it
 * @returns {number}
 */
function minutesOfClock(clock) {
  return Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
}

/**
 * @typedef {Object} SlotDate
 * @property {string} date
 * @property {boolean} exempt - under a portable-lighting override: not judged
 * @property {number|null} sunsetMinutes - the enforcement minute (floored); null when exempt
 * @property {number|null} limitMinutes
 * @property {'table'|'computed'|'unknown'|null} sunsetSource - null when exempt
 */

/**
 * @typedef {Object} UnlitSlotEntry
 * @property {import('./types.js').PracticeSlot} slot
 * @property {string|null} venueId
 * @property {boolean|null} lit - `false` or undeclared (`null`)
 * @property {SlotDate[]} dates - the slot's weekday within its range and the window
 */

/**
 * The universe every report here enumerates: the input plan's slots, split by
 * lighting, each unlit one with its dates, each date exempt (a lighting
 * override covers it: no sunset is asked for) or judged against its limit.
 *
 * @param {{ slotSet: import('./types.js').PracticeSlotSet, graph: Object, calendar: Object, window: { from: string, to: string }, lightingOverrides?: ReadonlyArray<Object> }} input
 */
function buildUnlitUniverse({ slotSet, graph, calendar, window, lightingOverrides }) {
  if (!slotSet || !Array.isArray(slotSet.slots)) {
    throw new TypeError('durationPhases: requires the practice slot set');
  }
  if (!graph || !calendar) {
    throw new TypeError('durationPhases: requires the facility graph and the calendar');
  }
  const exemptOn = lightingOverrideCovers(lightingOverrides);

  /** @type {UnlitSlotEntry[]} */
  const unlit = [];
  /** @type {string[]} */
  const litSlotIds = [];
  /** @type {string[]} */
  const undatedSlotIds = [];
  /** @type {import('../availability/types.js').AvailabilityFinding[]} */
  const findings = [];
  /** `venueId\u0000date` -> the provider's answer, asked once. */
  const sunsetCache = new Map();

  // Sunset is a property of a venue on a date, so its findings are reported
  // once per venue-date -- their details already carry `venueId` and `date` --
  // rather than once per slot sharing it. Only lookups for the plan's own
  // judged slot-dates report; G5's what-if lookups (another night) do not, so
  // no finding names a date nothing is scheduled on. Every plan lookup happens
  // while this universe is built, before any what-if, so the cache cannot
  // swallow a plan date's finding.
  const daylightOn = (
    /** @type {string|null} */ venueId,
    /** @type {string} */ date,
    report = true
  ) => {
    const key = `${venueId ?? ''}\u0000${date}`;
    let answer = sunsetCache.get(key);
    if (!answer) {
      answer = sunsetForVenue(calendar, { venueId, date });
      if (report) findings.push(...answer.findings);
      sunsetCache.set(key, answer);
    }
    return answer;
  };

  for (const slot of slotSet.slots) {
    if (slot.validFrom === null || slot.validUntil === null) {
      undatedSlotIds.push(slot.id);
      continue;
    }
    const surface = getSurface(graph, slot.surfaceId);
    const venueId = surface?.venueId ?? null;
    const lit = surface ? resolveLighting(graph, calendar, slot.surfaceId).lit : null;
    if (lit === true) {
      litSlotIds.push(slot.id);
      continue;
    }
    const from = laterOf(slot.validFrom, window.from);
    const to = earlierOf(slot.validUntil, window.to);
    const dates = weekdayDates(slot.weekday, from, to).map((date) => {
      // Exempt: not judged, so no sunset is asked for -- no coordinates are
      // needed and the date can never be SUNSET_UNKNOWN.
      if (exemptOn(slot.id, date)) {
        return { date, exempt: true, sunsetMinutes: null, limitMinutes: null, sunsetSource: null };
      }
      const daylight = daylightOn(venueId, date);
      return {
        date,
        exempt: false,
        sunsetMinutes: daylight.sunsetMinutes,
        limitMinutes:
          daylight.sunsetMinutes === null
            ? null
            : daylight.sunsetMinutes - PRACTICE_SUNSET_MARGIN_MINUTES,
        sunsetSource: daylight.source,
      };
    });
    unlit.push({ slot, venueId, lit, dates });
  }

  return { unlit, litSlotIds, undatedSlotIds, findings, daylightOn };
}

/**
 * The options G3 and G5 share, parsed once. A strategy or a lighting override
 * that names no slot of the plan is refused, not ignored: it would otherwise
 * be an admin's choice silently unread.
 *
 * @param {Object} input
 */
function parseOptions(input) {
  const options = PracticeDurationPhaseOptionsSchema.parse({
    window: input.window,
    minimumDurationMinutes: input.minimumDurationMinutes,
    durationStepMinutes: input.durationStepMinutes,
    overrides: input.overrides,
    strategies: input.strategies,
    earliestStartMinutes: input.earliestStartMinutes,
    earliestStartWeekdays: input.earliestStartWeekdays,
    lightingOverrides: input.lightingOverrides,
  });
  return options;
}

/**
 * The one per-slot derivation (D14) G3 and G5 both read, so a slot survives in
 * G5 exactly when G3 saves every one of its judged dates.
 *
 * Slots are derived in order of planned start, so when a slot shifts, every
 * earlier slot on its surface that night already has its timing for the date.
 * An earlier slot occupies its derived end; on a date it is exempt, its
 * planned start plus the operator pin in force (it runs as planned); on an
 * unknown-sunset date, its current end; on a date it is held out, nothing (it
 * is TIME TBD, not on the surface). A shifted slot is re-checked against that
 * every night, and a night it would overlap is held out `overlap`.
 *
 * `retimeRefusals` counts held-out dates only, by each refusal that held one
 * out (a SHORTEN date refused by the ladder and the shift counts in both).
 *
 * @param {ReturnType<typeof buildUnlitUniverse>} universe
 * @param {ReturnType<typeof parseOptions>} options
 */
function deriveSlotTimelines(universe, options) {
  const {
    window,
    minimumDurationMinutes: minimum,
    durationStepMinutes: step,
    overrides,
    strategies,
    earliestStartMinutes,
    earliestStartWeekdays,
  } = options;
  const floorOn = (/** @type {string} */ weekday) =>
    earliestStartWeekdays.includes(/** @type {any} */ (weekday)) ? earliestStartMinutes : null;

  const unlitById = new Map(universe.unlit.map((entry) => [entry.slot.id, entry]));
  // The duration overrides' contract, for every per-slot input: a strategy or
  // a lighting window on a slot that is not an unlit, dated slot of this plan
  // would be parsed and never read, so it is refused.
  const named = [
    ...Object.keys(strategies).map((slotId) => ['a strategy', slotId]),
    ...options.lightingOverrides.map((override) => ['a lighting override', override.slotId]),
  ];
  for (const [what, slotId] of named) {
    if (!unlitById.has(slotId)) {
      throw new TypeError(
        `durationPhases: ${what} names slot "${slotId}", which is no unlit, dated slot in this plan`
      );
    }
  }
  /** slotId -> effectiveFrom -> override */
  const overridesBySlot = new Map();
  for (const override of overrides) {
    const entry = unlitById.get(override.slotId);
    if (!entry) {
      throw new TypeError(
        `durationPhases: override for slot "${override.slotId}" names no unlit slot in this plan`
      );
    }
    if (override.effectiveFrom < window.from || override.effectiveFrom > window.to) {
      throw new TypeError(
        `durationPhases: override for slot "${override.slotId}" is dated ${override.effectiveFrom}, outside the window ${window.from}..${window.to}`
      );
    }
    // A pin may not lengthen the plan, and may not go below the minimum a
    // derived phase is held to: either would emit what D14 rules out.
    if (override.durationMinutes > entry.slot.durationMinutes) {
      throw new TypeError(
        `durationPhases: override for slot "${override.slotId}" (${override.durationMinutes} min) is longer than the slot's own ${entry.slot.durationMinutes} min`
      );
    }
    if (override.durationMinutes < Math.min(minimum, entry.slot.durationMinutes)) {
      throw new TypeError(
        `durationPhases: override for slot "${override.slotId}" (${override.durationMinutes} min) is below the ${minimum}-minute minimum`
      );
    }
    const byDate = overridesBySlot.get(override.slotId) ?? new Map();
    // Refused, not resolved: two pins on one slot-date would leave one of
    // them silently unapplied.
    if (byDate.has(override.effectiveFrom)) {
      throw new TypeError(
        `durationPhases: two overrides pin slot "${override.slotId}" on ${override.effectiveFrom}; one would be silently lost`
      );
    }
    byDate.set(override.effectiveFrom, override);
    overridesBySlot.set(override.slotId, byDate);
  }

  const counters = {
    unlitSlotDatesExamined: 0,
    slotDatesExempt: 0,
    slotDatesSunsetUnknown: 0,
    slotDatesHeldOut: 0,
    phaseTransitionsDerived: 0,
    shortenings: 0,
    shifts: 0,
    fallbackShifts: 0,
    overridesApplied: 0,
    overridesSuperseded: 0,
    retimeRefusals: /** @type {Record<string, number>} */ (
      Object.fromEntries(Object.values(PRACTICE_RETIME_REFUSAL).map((code) => [code, 0]))
    ),
  };

  /** `surfaceId\u0000date` -> the ends of the slots already derived that night */
  const nightEnds = new Map();
  const ordered = [...universe.unlit].sort(
    (a, b) =>
      a.slot.startMinutes - b.slot.startMinutes ||
      (a.slot.id < b.slot.id ? -1 : a.slot.id > b.slot.id ? 1 : 0)
  );
  /** @type {Map<string, Object>} */
  const timelines = new Map();

  for (const entry of ordered) {
    const { slot } = entry;
    const strategy = strategies[slot.id] ?? PRACTICE_COMPRESSION_STRATEGY.SHORTEN;
    const floor = floorOn(slot.weekday);
    let start = slot.startMinutes;
    let duration = slot.durationMinutes;
    /** The operator pins applied, in date order: what an exempt date runs at. */
    const pins = [];
    /** @type {Array<Object>} */
    const phases = [
      {
        effectiveFrom: window.from,
        startMinutes: start,
        durationMinutes: duration,
        source: PRACTICE_PHASE_SOURCE.BASE,
        retime: null,
        reason: 'the slot as planned: shortens and moves nothing',
        bound: null,
        supersedes: null,
      },
    ];
    /** @type {Array<Object>} */
    const tbd = [];
    let exemptDates = 0;
    const slotOverrides = overridesBySlot.get(slot.id) ?? new Map();
    const byDate = new Map(entry.dates.map((slotDate) => [slotDate.date, slotDate]));
    const dates = [...new Set([...byDate.keys(), ...slotOverrides.keys()])].sort();

    for (const date of dates) {
      const override = slotOverrides.get(date);
      if (override) {
        duration = override.durationMinutes;
        pins.push({ effectiveFrom: date, durationMinutes: duration });
        counters.overridesApplied += 1;
        const phase = {
          effectiveFrom: date,
          startMinutes: start,
          durationMinutes: duration,
          source: PRACTICE_PHASE_SOURCE.OVERRIDE,
          retime: null,
          reason: override.reason,
          bound: null,
          supersedes: null,
        };
        if (phases[phases.length - 1].effectiveFrom === date) {
          phase.supersedes = supersededBy(phases[phases.length - 1]);
          phases[phases.length - 1] = phase;
        } else {
          phases.push(phase);
        }
      }

      const slotDate = byDate.get(date);
      if (!slotDate) continue;
      const nightKey = `${slot.surfaceId}\u0000${date}`;
      const ends = nightEnds.get(nightKey) ?? [];
      nightEnds.set(nightKey, ends);
      const earlierEnd = ends.length > 0 ? Math.max(...ends) : null;

      if (slotDate.exempt) {
        // Exempt from daylight and compression, not from the operator: it
        // runs at its planned start and at the pin in force, if any.
        exemptDates += 1;
        counters.slotDatesExempt += 1;
        ends.push(slot.startMinutes + (pins.at(-1)?.durationMinutes ?? slot.durationMinutes));
        continue;
      }
      counters.unlitSlotDatesExamined += 1;
      if (slotDate.limitMinutes === null) {
        counters.slotDatesSunsetUnknown += 1;
        ends.push(start + duration);
        continue;
      }
      const limit = slotDate.limitMinutes;
      const numbers = {
        sunsetMinutes: slotDate.sunsetMinutes,
        limitMinutes: limit,
        marginMinutes: PRACTICE_SUNSET_MARGIN_MINUTES,
        sunsetSource: slotDate.sunsetSource,
      };
      // A shift was legal on the night it was made. An earlier slot can run
      // later on another night (its own lighting window, an operator pin), so
      // a shifted slot is re-checked every night, never assumed clear.
      if (start < slot.startMinutes && earlierEnd !== null && start < earlierEnd) {
        counters.slotDatesHeldOut += 1;
        counters.retimeRefusals[PRACTICE_RETIME_REFUSAL.OVERLAP] += 1;
        tbd.push({
          date,
          code: AVAILABILITY_REASON.PRACTICE_PAST_SUNSET,
          shortenRefused: null,
          shiftRefused: PRACTICE_RETIME_REFUSAL.OVERLAP,
          reason: `on ${date} slot ${slot.id}, moved to ${clockOf(start)}, would overlap an earlier slot on its surface that ends ${clockOf(earlierEnd)}`,
          startMinutes: start,
          durationMinutes: duration,
          wouldStartMinutes: start,
          floorMinutes: floor,
          earlierEndMinutes: earlierEnd,
          ...numbers,
        });
        continue;
      }
      if (endsByDaylightLimit(start + duration, limit)) {
        ends.push(start + duration);
        continue;
      }

      /** @type {{ start: number, duration: number }|null} */
      let next = null;
      let retime = null;
      /** @type {{ code: string, durationMinutes: number }|null} */
      let shortenRefused = null;
      let shift = null;
      // SHORTEN walks the ladder until it has shifted once; from then on the
      // slot keeps its duration and moves, as SHIFT_EARLIER does.
      if (strategy === PRACTICE_COMPRESSION_STRATEGY.SHORTEN && start === slot.startMinutes) {
        const rung = ladderDuration({
          plannedDurationMinutes: slot.durationMinutes,
          currentDurationMinutes: duration,
          startMinutes: start,
          limitMinutes: limit,
          stepMinutes: step,
        });
        if (rung >= minimum) {
          next = { start, duration: rung };
          retime = PRACTICE_RETIME_KIND.SHORTEN;
        } else {
          shortenRefused = { code: PRACTICE_RETIME_REFUSAL.BELOW_MINIMUM, durationMinutes: rung };
        }
      }
      if (next === null) {
        shift = shiftedStart({
          startMinutes: start,
          durationMinutes: duration,
          limitMinutes: limit,
          floorMinutes: floor,
          earlierEndMinutes: earlierEnd,
          stepMinutes: step,
        });
        if (shift.refused === null) {
          next = { start: /** @type {number} */ (shift.startMinutes), duration };
          retime =
            strategy === PRACTICE_COMPRESSION_STRATEGY.SHIFT_EARLIER
              ? PRACTICE_RETIME_KIND.SHIFT_EARLIER
              : PRACTICE_RETIME_KIND.FALLBACK_SHIFT;
        }
      }

      const past = `on ${date} slot ${slot.id} (${clockOf(start)}, ${duration} min) would end at ${clockOf(start + duration)}, past the limit ${clockOf(limit)} (sunset ${clockOf(/** @type {number} */ (slotDate.sunsetMinutes))}, ${slotDate.sunsetSource}, margin ${PRACTICE_SUNSET_MARGIN_MINUTES})`;
      const shortenText =
        shortenRefused === null
          ? ''
          : `; shortening would leave ${shortenRefused.durationMinutes} min, below the ${minimum}-minute minimum`;

      if (next === null) {
        // Held out: TIME TBD on this date (D8), with its reason. The state is
        // left as it was, so one bad date does not drag the slot down. Its
        // practice is not on this surface tonight, so it occupies nothing.
        // Refusals are counted here only: each counts a held-out date.
        const refused = /** @type {NonNullable<typeof shift>} */ (shift);
        counters.slotDatesHeldOut += 1;
        if (shortenRefused) counters.retimeRefusals[shortenRefused.code] += 1;
        counters.retimeRefusals[/** @type {string} */ (refused.refused)] += 1;
        tbd.push({
          date,
          code: AVAILABILITY_REASON.PRACTICE_PAST_SUNSET,
          shortenRefused: shortenRefused?.code ?? null,
          shiftRefused: refused.refused,
          reason: `${past}${shortenText}; starting at ${clockOf(refused.wouldStartMinutes)} is refused (${refused.refused}${refused.refused === PRACTICE_RETIME_REFUSAL.EARLIEST_START_FLOOR ? `, floor ${clockOf(/** @type {number} */ (floor))}` : ''}${refused.refused === PRACTICE_RETIME_REFUSAL.OVERLAP ? `, an earlier slot ends ${clockOf(/** @type {number} */ (earlierEnd))}` : ''})`,
          startMinutes: start,
          durationMinutes: duration,
          wouldStartMinutes: refused.wouldStartMinutes,
          floorMinutes: floor,
          earlierEndMinutes: earlierEnd,
          ...numbers,
        });
        continue;
      }

      counters.phaseTransitionsDerived += 1;
      if (retime === PRACTICE_RETIME_KIND.SHORTEN) counters.shortenings += 1;
      else if (retime === PRACTICE_RETIME_KIND.SHIFT_EARLIER) counters.shifts += 1;
      else counters.fallbackShifts += 1;
      const phase = {
        effectiveFrom: date,
        startMinutes: next.start,
        durationMinutes: next.duration,
        source: PRACTICE_PHASE_SOURCE.DERIVED,
        retime,
        reason:
          retime === PRACTICE_RETIME_KIND.SHORTEN
            ? `${past}: shortened to ${next.duration} min (${slot.durationMinutes} - ${step} x ${(slot.durationMinutes - next.duration) / step})`
            : `${past}${shortenText}: starts ${clockOf(next.start)}, keeping ${next.duration} min`,
        bound: {
          date,
          slotId: slot.id,
          surfaceId: slot.surfaceId,
          previousStartMinutes: start,
          previousDurationMinutes: duration,
          previousEndMinutes: start + duration,
          ...numbers,
          ...(retime === PRACTICE_RETIME_KIND.SHORTEN
            ? {}
            : { floorMinutes: floor, earlierEndMinutes: earlierEnd }),
        },
        supersedes: null,
      };
      if (phases[phases.length - 1].effectiveFrom === date) {
        const superseded = phases[phases.length - 1];
        if (superseded.source === PRACTICE_PHASE_SOURCE.OVERRIDE) counters.overridesSuperseded += 1;
        phase.supersedes = supersededBy(superseded);
        phases[phases.length - 1] = phase;
      } else {
        phases.push(phase);
      }
      start = next.start;
      duration = next.duration;
      ends.push(start + duration);
    }

    timelines.set(slot.id, {
      slotId: slot.id,
      surfaceId: slot.surfaceId,
      venueId: entry.venueId,
      weekday: slot.weekday,
      strategy,
      earliestStartMinutes: floor,
      plannedStartMinutes: slot.startMinutes,
      plannedDurationMinutes: slot.durationMinutes,
      phases,
      pins,
      tbd,
      slotDatesExempt: exemptDates,
    });
  }

  return { timelines, counters };
}

/**
 * G3: derive the DurationPhase schedule.
 *
 * @param {Object} input
 * @param {import('./types.js').PracticeSlotSet} input.slotSet - the input plan
 * @param {Object} input.graph - the facility graph
 * @param {Object} input.calendar - the daylight provider
 * @param {{ from: string, to: string }} input.window
 * @param {number} [input.minimumDurationMinutes] - default 40
 * @param {number} [input.durationStepMinutes] - default 10
 * @param {Array<Object>} [input.overrides] - `{ slotId, effectiveFrom, durationMinutes, reason }`
 * @param {Record<string, string>} [input.strategies] - slot id -> `shorten` | `shift-earlier`
 * @param {number|null} [input.earliestStartMinutes] - `season_settings.school_day_end`
 * @param {string[]} [input.earliestStartWeekdays] - default Mon-Thu
 * @param {Array<Object>} [input.lightingOverrides] - `{ slotId, from, until }`
 */
export function derivePracticeDurationPhases(input) {
  const options = parseOptions(input);
  const { window, lightingOverrides } = options;
  const universe = buildUnlitUniverse({ ...input, window, lightingOverrides });
  const { timelines, counters } = deriveSlotTimelines(universe, options);
  /** Unlit slots on ground the graph cannot place: judged, but named. */
  const slotsWithoutVenue = universe.unlit
    .filter((entry) => entry.venueId === null)
    .map((entry) => entry.slot.id);

  const meta = {
    slotsExamined:
      universe.unlit.length + universe.litSlotIds.length + universe.undatedSlotIds.length,
    unlitSlotsEnumerated: universe.unlit.length,
    litSlotsExempt: universe.litSlotIds.length,
    undatedSlots: universe.undatedSlotIds.length,
    unlitSlotsWithoutVenue: slotsWithoutVenue.length,
    ...counters,
  };

  // Input order, not derivation order.
  const slotPhases = universe.unlit.map((entry) => timelines.get(entry.slot.id));

  // The season's phases: every slot's boundaries and every lighting window's
  // edges, merged. Within one of these, every slot's timing is constant.
  const boundarySet = new Set([window.from]);
  for (const timeline of slotPhases) {
    for (const phase of timeline.phases) boundarySet.add(phase.effectiveFrom);
  }
  for (const override of lightingOverrides) {
    if (!timelines.has(override.slotId)) continue;
    if (override.until < window.from || override.from > window.to) continue;
    boundarySet.add(laterOf(override.from, window.from));
    const after = isoDateOfDayNumber(isoDayNumber(override.until) + 1);
    if (after <= window.to) boundarySet.add(after);
  }
  const boundaries = [...boundarySet].sort();
  const seasonPhases = boundaries.map((startDate, index) => ({
    id: `duration-phase-${String(index + 1).padStart(2, '0')}`,
    startDate,
    endDate:
      index + 1 < boundaries.length
        ? isoDateOfDayNumber(isoDayNumber(boundaries[index + 1]) - 1)
        : window.to,
    label: `practice durations from ${startDate}`,
  }));

  const exemptOn = lightingOverrideCovers(lightingOverrides);
  const timingOn = (/** @type {Object} */ timeline, /** @type {string} */ date) => {
    let current = timeline.phases[0];
    for (const phase of timeline.phases) if (phase.effectiveFrom <= date) current = phase;
    return current;
  };

  // Every dated slot of the plan, lit ones included, so the schedule is
  // complete; overrides only where a phase retimes the slot. A shifted slot
  // carries its duration with its start: `expandPracticeSlotsForSeason()`
  // would otherwise keep the planned end and shorten it silently.
  const unlitLighting = new Map(universe.unlit.map((entry) => [entry.slot.id, entry.lit]));
  const slots = [];
  for (const slot of input.slotSet.slots) {
    if (slot.validFrom === null || slot.validUntil === null) continue;
    const timeline = timelines.get(slot.id);
    /** @type {Record<string, { durationMinutes: number, startTime?: string }>} */
    const seasonOverrides = {};
    if (timeline) {
      for (const phase of seasonPhases) {
        // A lighting window's edges are phase boundaries, so a whole phase is
        // inside it or outside it: inside, the slot runs at its planned start
        // and at the operator pin in force -- never silently unpinned.
        if (exemptOn(slot.id, phase.startDate)) {
          let pinned = slot.durationMinutes;
          for (const pin of timeline.pins) {
            if (pin.effectiveFrom <= phase.startDate) pinned = pin.durationMinutes;
          }
          if (pinned !== slot.durationMinutes) {
            seasonOverrides[phase.id] = { durationMinutes: pinned };
          }
          continue;
        }
        const timing = timingOn(timeline, phase.startDate);
        const shifted = timing.startMinutes !== slot.startMinutes;
        if (shifted || timing.durationMinutes !== slot.durationMinutes) {
          seasonOverrides[phase.id] = {
            durationMinutes: timing.durationMinutes,
            ...(shifted ? { startTime: clockOf(timing.startMinutes) } : {}),
          };
        }
      }
    }
    slots.push({
      id: slot.id,
      day: WEEKDAY_NAMES[/** @type {keyof typeof WEEKDAY_NAMES} */ (slot.weekday)],
      start: clockOf(slot.startMinutes),
      durationMinutes: slot.durationMinutes,
      capacity: slot.capacity,
      validFrom: slot.validFrom,
      validUntil: slot.validUntil,
      fieldId: slot.surfaceId,
      venueId: timeline
        ? timeline.venueId
        : (getSurface(input.graph, slot.surfaceId)?.venueId ?? null),
      lit: unlitLighting.has(slot.id) ? unlitLighting.get(slot.id) : true,
      seasonOverrides,
    });
  }

  return deepFreeze({
    window,
    marginMinutes: PRACTICE_SUNSET_MARGIN_MINUTES,
    minimumDurationMinutes: options.minimumDurationMinutes,
    durationStepMinutes: options.durationStepMinutes,
    earliestStartMinutes: options.earliestStartMinutes,
    earliestStartWeekdays: options.earliestStartWeekdays,
    lightingOverrides,
    slotPhases,
    seasonPhases,
    slots,
    litSlotIds: universe.litSlotIds,
    undatedSlotIds: universe.undatedSlotIds,
    slotsWithoutVenue,
    findings: universe.findings,
    meta,
    // False means nothing was judged: a caller must treat it as a loud
    // failure, never as a clean report (CLAUDE.md, meta-assertions).
    // Enumerated and exempt counts as exercised: a season wholly under
    // approved lighting windows is a correct report, not an empty one.
    exercised: meta.unlitSlotDatesExamined + meta.slotDatesExempt > 0,
  });
}

/**
 * @param {Object} phase
 * @returns {{ source: string, startMinutes: number, durationMinutes: number, reason: string }}
 */
function supersededBy(phase) {
  return {
    source: phase.source,
    startMinutes: phase.startMinutes,
    durationMinutes: phase.durationMinutes,
    reason: phase.reason,
  };
}

/**
 * The timing a slot runs on a date under a phase schedule, read from the
 * `seasonPhases`/`seasonOverrides` pair exactly as `expandPracticeSlotsForSeason()`
 * reads it (the phase-specific key, then `default`, then the slot's own):
 * `startTime` moves the start, `durationMinutes` sets the length.
 *
 * @param {Object} phaseSchedule
 * @param {Object} scheduledSlot
 * @param {string} date
 * @returns {{ startMinutes: number, durationMinutes: number }}
 */
function timingUnder(phaseSchedule, scheduledSlot, date) {
  const phase = phaseSchedule.seasonPhases.find(
    (/** @type {any} */ candidate) => candidate.startDate <= date && date <= candidate.endDate
  );
  const overrides = scheduledSlot.seasonOverrides ?? {};
  const override = (phase ? overrides[phase.id] : undefined) ?? overrides.default ?? null;
  return {
    startMinutes: minutesOfClock(override?.startTime ?? scheduledSlot.start),
    durationMinutes: override?.durationMinutes ?? scheduledSlot.durationMinutes,
  };
}

/**
 * G4: the compression report -- hold-starts and the cascade proposal.
 *
 * **Applies nothing.** The input plan and the phase schedule are read, never
 * written; the cascade's proposed starts leave only as the entries of an 8.8
 * change log, filed under {@link PRACTICE_SUNSET_CASCADE_SOURCE_ID} (W13).
 *
 * Every slot-date is read at the schedule's timing (its start and duration,
 * {@link timingUnder}); dates under a lighting override are not judged and are
 * counted in `slotDatesExempt`. The cascade packs each night from the
 * schedule: a slot may start at the proposed end of the slot before it plus
 * their planned gap, never later than the schedule's own start. Each entry is
 * relative to the schedule: `before` is the schedule's start that date,
 * `after` the cascade's, and one is filed where that pair first changes.
 *
 * @param {Object} input
 * @param {import('./types.js').PracticeSlotSet} input.slotSet - the input plan
 * @param {Object} input.graph
 * @param {Object} input.calendar
 * @param {ReturnType<typeof derivePracticeDurationPhases>} input.phaseSchedule
 * @param {ReadonlyArray<{ teamId: string, teamName?: string|null }>} [input.teams] - the team
 *   universe proposals resolve against; defaults to the plan's own assignments
 */
export function buildPracticeCompressionReport(input) {
  const { slotSet, phaseSchedule } = input;
  if (!phaseSchedule || !Array.isArray(phaseSchedule.slots)) {
    throw new TypeError(
      'compression: requires the phase schedule derivePracticeDurationPhases() returned'
    );
  }
  const universe = buildUnlitUniverse({
    ...input,
    window: phaseSchedule.window,
    lightingOverrides: phaseSchedule.lightingOverrides,
  });
  const scheduledById = new Map(phaseSchedule.slots.map((slot) => [slot.id, slot]));

  const meta = {
    unlitSlotsEnumerated: universe.unlit.length,
    unlitSlotDatesExamined: 0,
    slotDatesExempt: 0,
    slotDatesSunsetUnknown: 0,
    holdStartSlotDatesPastSunset: 0,
    holdStartSlotDatesSavedByCascade: 0,
    cascadeSlotDatesShifted: 0,
    cascadeNightsBrokenByOverlap: 0,
    proposalEntries: 0,
  };

  /** `surfaceId\u0000weekday` -> the chain's unlit slots */
  const chains = new Map();
  for (const entry of universe.unlit) {
    if (!scheduledById.has(entry.slot.id)) {
      throw new TypeError(
        `compression: slot ${entry.slot.id} is in the plan but not in the phase schedule; derive the schedule from this plan`
      );
    }
    const key = `${entry.slot.surfaceId}\u0000${entry.slot.weekday}`;
    const list = chains.get(key) ?? [];
    list.push(entry);
    chains.set(key, list);
  }

  /** `slotId\u0000date` -> the cascade's proposed start */
  const proposedStart = new Map();
  /** The start and duration a slot runs on a date under the schedule. */
  const timingOf = (/** @type {Object} */ slot, /** @type {string} */ date) =>
    timingUnder(phaseSchedule, scheduledById.get(slot.id), date);

  for (const chain of chains.values()) {
    const byDate = new Map();
    /** `slotId\u0000date` of the chain's exempt slot-dates */
    const exempt = new Set();
    for (const entry of chain) {
      for (const slotDate of entry.dates) {
        const list = byDate.get(slotDate.date) ?? [];
        list.push(entry.slot);
        byDate.set(slotDate.date, list);
        if (slotDate.exempt) exempt.add(`${entry.slot.id}\u0000${slotDate.date}`);
      }
    }
    for (const [date, members] of byDate) {
      members.sort((a, b) => a.startMinutes - b.startMinutes || (a.id < b.id ? -1 : 1));
      let broken = false;
      // The latest planned end of every slot before this one, not only the
      // one immediately before: an overlap with any of them is an overlap.
      let latestEnd = -Infinity;
      let previousPlannedEnd = 0;
      let previousProposedEnd = 0;
      members.forEach((slot, index) => {
        const timing = timingOf(slot, date);
        let proposed = timing.startMinutes;
        // A slot under portable lighting is never compressed, the cascade
        // included: it keeps the schedule's start and the night packs around it.
        if (index > 0 && !broken && !exempt.has(`${slot.id}\u0000${date}`)) {
          if (slot.startMinutes < latestEnd) {
            // Overlapping slots are not a sequence: from here on, nothing on
            // this surface this night moves beyond the schedule.
            broken = true;
            meta.cascadeNightsBrokenByOverlap += 1;
          } else {
            proposed = Math.min(
              timing.startMinutes,
              previousProposedEnd + (slot.startMinutes - previousPlannedEnd)
            );
          }
        }
        latestEnd = Math.max(latestEnd, slot.startMinutes + slot.durationMinutes);
        previousPlannedEnd = slot.startMinutes + slot.durationMinutes;
        previousProposedEnd = proposed + timing.durationMinutes;
        proposedStart.set(`${slot.id}\u0000${date}`, proposed);
      });
    }
  }

  const flagged = [];
  for (const entry of universe.unlit) {
    const { slot } = entry;
    for (const slotDate of entry.dates) {
      if (slotDate.exempt) {
        meta.slotDatesExempt += 1;
        continue;
      }
      meta.unlitSlotDatesExamined += 1;
      const cascadeStart = /** @type {number} */ (
        proposedStart.get(`${slot.id}\u0000${slotDate.date}`)
      );
      const { startMinutes, durationMinutes: duration } = timingOf(slot, slotDate.date);
      if (cascadeStart !== startMinutes) meta.cascadeSlotDatesShifted += 1;
      if (slotDate.limitMinutes === null) {
        meta.slotDatesSunsetUnknown += 1;
        continue;
      }
      const endMinutes = startMinutes + duration;
      if (endsByDaylightLimit(endMinutes, slotDate.limitMinutes)) continue;
      const savedByCascade = endsByDaylightLimit(cascadeStart + duration, slotDate.limitMinutes);
      meta.holdStartSlotDatesPastSunset += 1;
      if (savedByCascade) meta.holdStartSlotDatesSavedByCascade += 1;
      flagged.push({
        slotId: slot.id,
        surfaceId: slot.surfaceId,
        venueId: entry.venueId,
        date: slotDate.date,
        code: AVAILABILITY_REASON.PRACTICE_PAST_SUNSET,
        reason: `start held at the schedule's ${clockOf(startMinutes)}: at its duration of ${duration} min it ends ${clockOf(endMinutes)}, ${endMinutes - slotDate.limitMinutes} min past the limit`,
        startMinutes,
        durationMinutes: duration,
        endMinutes,
        sunsetMinutes: slotDate.sunsetMinutes,
        limitMinutes: slotDate.limitMinutes,
        overrunMinutes: endMinutes - slotDate.limitMinutes,
        sunsetSource: slotDate.sunsetSource,
        teamIds: teamsOn(slotSet, slot, slotDate.date),
        // Whether the cascade would save it -- a verdict, not the proposal:
        // the proposed start itself exists only as a change-log entry (W13).
        savedByCascade,
      });
    }
  }

  // The cascade, as change-log entries only: one per team (or one for an
  // unassigned slot) at each date the cascade's start, against the schedule's
  // start that date, first changes. `before` is the schedule's start.
  const rawEntries = [];
  const practiceLabels = new Set([PRACTICE_CASCADE_UNASSIGNED_LABEL]);
  for (const entry of universe.unlit) {
    const { slot } = entry;
    let last = null;
    for (const { date } of entry.dates) {
      const proposed = /** @type {number} */ (proposedStart.get(`${slot.id}\u0000${date}`));
      const current = timingOf(slot, date).startMinutes;
      if (proposed === current) {
        last = null;
        continue;
      }
      const pair = `${current}\u0000${proposed}`;
      if (pair === last) continue;
      last = pair;
      const label = `practice ${slot.id}`;
      practiceLabels.add(label);
      const teams = teamsOn(slotSet, slot, date);
      const sides = teams.length > 0 ? teams : [PRACTICE_CASCADE_UNASSIGNED_LABEL];
      for (const side of sides) {
        rawEntries.push({
          date,
          home: side,
          away: label,
          reason: PRACTICE_SUNSET_CASCADE_REASON_TEXT,
          before: { raw: null, startMinutes: current, location: slot.surfaceId, scheduled: true },
          after: { raw: null, startMinutes: proposed, location: slot.surfaceId, scheduled: true },
        });
      }
    }
  }
  meta.proposalEntries = rawEntries.length;

  const teamUniverse =
    input.teams ??
    [...new Set(slotSet.assignments.map((assignment) => assignment.teamId))]
      .sort()
      .map((teamId) => ({ teamId, teamName: null }));
  const changelog = buildChangeLog({
    subject: 'practice sunset cascade proposals (8.9 G4) -- proposed, not applied',
    entries: rawEntries,
    teams: teamUniverse,
    sources: PRACTICE_SUNSET_CASCADE_SOURCES,
    nonTeamLabels: [...practiceLabels],
    coverage: `every unlit practice slot of the plan whose cascaded start differs from its held start, ${phaseSchedule.window.from}..${phaseSchedule.window.to}`,
  });

  return deepFreeze({
    window: phaseSchedule.window,
    marginMinutes: PRACTICE_SUNSET_MARGIN_MINUTES,
    holdStarts: { flagged },
    cascade: { changelog },
    findings: universe.findings,
    meta,
    // False means nothing was examined: a caller must treat it as a loud
    // failure, never as a clean report (CLAUDE.md, meta-assertions).
    // Enumerated and exempt counts as exercised: a season wholly under
    // approved lighting windows is a correct report, not an empty one.
    exercised: meta.unlitSlotDatesExamined + meta.slotDatesExempt > 0,
  });
}

/**
 * G5: the DST survival report -- per unlit slot of the **input** plan, does it
 * survive the season's retiming, and if not, what fixes it.
 *
 * It reads the one per-slot derivation G3 does ({@link deriveSlotTimelines}),
 * with the same options: a slot survives when G3 retimes every judged date
 * legally, by the ladder or a shift, and does not survive when any date is
 * held out as TIME TBD. A slot whose every date is under a lighting override
 * is `exempt`. The fixes are candidates, stated with what was not checked
 * (D11): a lit surface is named for its lighting only; an earlier start is not
 * checked against permits or the slots around it; another night is judged on
 * this venue's sunset at this start, shortening only; a lighting override
 * needs its request approved.
 *
 * @param {Object} input - as {@link derivePracticeDurationPhases}
 */
export function buildDstSurvivalReport(input) {
  const options = parseOptions(input);
  const { window, minimumDurationMinutes, durationStepMinutes, lightingOverrides } = options;
  const universe = buildUnlitUniverse({ ...input, window, lightingOverrides });
  const { timelines } = deriveSlotTimelines(universe, options);

  const litSurfaces = Object.keys(input.graph.surfaces ?? {})
    .sort()
    .map((surfaceId) => ({ surfaceId, ...resolveLighting(input.graph, input.calendar, surfaceId) }))
    .filter((lighting) => lighting.lit === true);
  /** surfaceId -> the earliest start any slot of the input plan has there */
  const earliestPlannedStart = new Map();
  for (const slot of input.slotSet.slots) {
    const current = earliestPlannedStart.get(slot.surfaceId);
    if (current === undefined || slot.startMinutes < current) {
      earliestPlannedStart.set(slot.surfaceId, slot.startMinutes);
    }
  }

  const survivesOn = (/** @type {number|null} */ limit, /** @type {Object} */ slot) =>
    limit !== null && survivesOnDate(limit, slot, durationStepMinutes, minimumDurationMinutes);

  const meta = {
    unlitSlotsEnumerated: universe.unlit.length,
    litSlotsExempt: universe.litSlotIds.length,
    undatedSlots: universe.undatedSlotIds.length,
    slotDatesExamined: 0,
    slotDatesExempt: 0,
    slotDatesSunsetUnknown: 0,
    slotsSurviving: 0,
    slotsNotSurviving: 0,
    slotsUnknown: 0,
    slotsWithNoDates: 0,
    slotsExempt: 0,
    fixesAvailableByKind: {
      [PRACTICE_SURVIVAL_FIX_KIND.LIT_FIELD]: 0,
      [PRACTICE_SURVIVAL_FIX_KIND.EARLIER_START]: 0,
      [PRACTICE_SURVIVAL_FIX_KIND.ANOTHER_NIGHT]: 0,
      [PRACTICE_SURVIVAL_FIX_KIND.LIGHTING_OVERRIDE]: 0,
    },
    // No scheduling fix (lit field, earlier start, another night). A lighting
    // override is always a candidate -- it needs only an approval -- so it is
    // not counted here, or this counter could never move.
    slotsWithNoFix: 0,
  };

  const rows = universe.unlit.map((entry) => {
    const { slot } = entry;
    const timeline = timelines.get(slot.id);
    const judged = entry.dates.filter((d) => !d.exempt);
    const exemptDates = entry.dates.filter((d) => d.exempt).map((d) => d.date);
    meta.slotDatesExamined += judged.length;
    meta.slotDatesExempt += exemptDates.length;
    const unknownDates = judged.filter((d) => d.limitMinutes === null).map((d) => d.date);
    meta.slotDatesSunsetUnknown += unknownDates.length;
    /** @type {Array<Object>} */
    const failing = timeline.tbd;
    const base = {
      slotId: slot.id,
      surfaceId: slot.surfaceId,
      venueId: entry.venueId,
      weekday: slot.weekday,
      startMinutes: slot.startMinutes,
      durationMinutes: slot.durationMinutes,
      strategy: timeline.strategy,
      datesExamined: entry.dates.length,
      exemptDates,
      unknownDates,
    };

    if (entry.dates.length > 0 && judged.length === 0) {
      meta.slotsExempt += 1;
      return {
        ...base,
        verdict: PRACTICE_SURVIVAL_VERDICT.EXEMPT,
        reason: 'every date in the window is under a portable-lighting override: none is judged',
        failingDates: [],
        d8: null,
        fixes: [],
      };
    }
    if (entry.dates.length === 0) {
      meta.slotsWithNoDates += 1;
      return {
        ...base,
        verdict: PRACTICE_SURVIVAL_VERDICT.NO_DATES,
        reason: 'the slot’s weekday never falls inside its range and the window',
        failingDates: [],
        d8: null,
        fixes: [],
      };
    }
    if (failing.length === 0) {
      const verdict =
        unknownDates.length > 0
          ? PRACTICE_SURVIVAL_VERDICT.UNKNOWN
          : PRACTICE_SURVIVAL_VERDICT.SURVIVES;
      if (verdict === PRACTICE_SURVIVAL_VERDICT.UNKNOWN) meta.slotsUnknown += 1;
      else meta.slotsSurviving += 1;
      return {
        ...base,
        verdict,
        reason:
          verdict === PRACTICE_SURVIVAL_VERDICT.UNKNOWN
            ? `no sunset is known on ${unknownDates.length} date(s), so survival cannot be shown (never read as surviving)`
            : `ends by sunset on every judged date: as planned, shortened to no less than ${minimumDurationMinutes} min, or started earlier`,
        failingDates: [],
        d8: null,
        fixes: [],
      };
    }

    meta.slotsNotSurviving += 1;
    const first = failing[0];
    // A date with no known sunset is never read as legal (it is listed in
    // `unknownDates`), so `legalThrough` names the last date shown legal.
    const lastLegal =
      judged.filter((d) => d.date < first.date && d.limitMinutes !== null).at(-1) ?? null;
    const knownLimits = judged.filter((d) => d.limitMinutes !== null);
    const tightest = knownLimits.reduce((a, b) =>
      /** @type {number} */ (b.limitMinutes) < /** @type {number} */ (a.limitMinutes) ? b : a
    );
    const tightestLimit = /** @type {number} */ (tightest.limitMinutes);
    const startAtFullDuration = tightestLimit - slot.durationMinutes;
    const startAtMinimum = tightestLimit - Math.min(minimumDurationMinutes, slot.durationMinutes);
    const floor = earliestPlannedStart.get(slot.surfaceId) ?? null;
    const schoolFloor = timeline.earliestStartMinutes;
    const usableLitSurfaceIds = litSurfaces
      .filter(
        (lit) =>
          lit.lightsOffMinutes === null ||
          lit.lightsOffMinutes >= slot.startMinutes + slot.durationMinutes
      )
      .map((lit) => lit.surfaceId);

    const from = laterOf(/** @type {string} */ (slot.validFrom), window.from);
    const to = earlierOf(/** @type {string} */ (slot.validUntil), window.to);
    const otherNights = WEEKDAY_CODES.filter((weekday) => weekday !== slot.weekday).filter(
      (weekday) => {
        const dates = weekdayDates(weekday, from, to);
        if (dates.length === 0) return false;
        return dates.every((date) => {
          const daylight = universe.daylightOn(entry.venueId, date, false);
          const limit =
            daylight.sunsetMinutes === null
              ? null
              : daylight.sunsetMinutes - PRACTICE_SUNSET_MARGIN_MINUTES;
          return survivesOn(limit, slot);
        });
      }
    );

    const fixes = [
      {
        kind: PRACTICE_SURVIVAL_FIX_KIND.LIT_FIELD,
        available: usableLitSurfaceIds.length > 0,
        surfaceIds: usableLitSurfaceIds,
        unchecked:
          'lighting only: a lit surface whose stated lights-off falls before this practice ends is excluded; one with no stated lights-off is taken as lit throughout (GAP-05); permits, size and capacity are not checked',
      },
      {
        kind: PRACTICE_SURVIVAL_FIX_KIND.EARLIER_START,
        // Only inside the hours this plan already runs practices on this
        // surface, and never before the school-day floor -- which must be
        // known, as G3 requires: an earlier start than that is a guess about
        // school hours and permits, not a fix.
        available:
          floor !== null &&
          startAtMinimum >= floor &&
          schoolFloor !== null &&
          startAtMinimum >= schoolFloor,
        startMinutesAtFullDuration: startAtFullDuration >= 0 ? startAtFullDuration : null,
        startMinutesAtMinimumDuration: startAtMinimum >= 0 ? startAtMinimum : null,
        earliestPlannedStartMinutes: floor,
        earliestStartFloorMinutes: schoolFloor,
        bindingDate: tightest.date,
        unchecked:
          'bounded below by the earliest start this plan uses on the surface and the school-day floor where known; permit windows and the occupancy of the slots it would move into are not checked',
      },
      {
        kind: PRACTICE_SURVIVAL_FIX_KIND.ANOTHER_NIGHT,
        available: otherNights.length > 0,
        weekdays: otherNights,
        unchecked:
          'judged on this venue’s sunset at this start, shortening only; permits and occupancy are not checked',
      },
      {
        kind: PRACTICE_SURVIVAL_FIX_KIND.LIGHTING_OVERRIDE,
        available: true,
        window: { from: first.date, until: failing[failing.length - 1].date },
        unchecked:
          'a coach requests it and an admin approves it (8.9 D14 PR B); the window has no lights-off time, which is declared, not enforced',
      },
    ];
    let any = false;
    for (const fix of fixes) {
      if (!fix.available) continue;
      meta.fixesAvailableByKind[fix.kind] += 1;
      if (fix.kind !== PRACTICE_SURVIVAL_FIX_KIND.LIGHTING_OVERRIDE) any = true;
    }
    if (!any) meta.slotsWithNoFix += 1;

    return {
      ...base,
      verdict: PRACTICE_SURVIVAL_VERDICT.DOES_NOT_SURVIVE,
      code: AVAILABILITY_REASON.PRACTICE_PAST_SUNSET,
      reason: `from ${first.date} it cannot be retimed: ${first.reason}`,
      failingDates: failing.map((d) => d.date),
      refusals: failing.map((d) => ({
        date: d.date,
        shortenRefused: d.shortenRefused,
        shiftRefused: d.shiftRefused,
      })),
      // D8 truncates at the first held-out date, so `tbdDates` counts every
      // judged date from there on -- dates G3 could retime included.
      // `heldOutDates` counts only the dates G3 itself holds out.
      d8: {
        legalThrough: lastLegal ? lastLegal.date : null,
        tbdFrom: first.date,
        tbdDates: judged.filter((d) => d.date >= first.date).length,
        heldOutDates: failing.length,
      },
      fixes,
    };
  });

  return deepFreeze({
    window,
    marginMinutes: PRACTICE_SUNSET_MARGIN_MINUTES,
    minimumDurationMinutes,
    durationStepMinutes,
    earliestStartMinutes: options.earliestStartMinutes,
    earliestStartWeekdays: options.earliestStartWeekdays,
    lightingOverrides,
    rows,
    litSlotIds: universe.litSlotIds,
    undatedSlotIds: universe.undatedSlotIds,
    findings: universe.findings,
    meta,
    // False means nothing was examined: a caller must treat it as a loud
    // failure, never as a clean report (CLAUDE.md, meta-assertions).
    exercised: meta.slotDatesExamined + meta.slotDatesExempt > 0,
  });
}
