/**
 * Practice duration phases, compression and the DST survival report (8.9 PR 5).
 *
 * `practice/daylight.js` says which practices run past sunset. This module
 * says how the season adapts, in three reports over the same universe, and
 * **applies nothing**:
 *
 * - **G3, the DurationPhase schedule.** Per venue, an ordered
 *   `(effectiveFrom, durationMinutes)` list, each phase showing the date, the
 *   sunset and the slot that bound it. The output is exactly the
 *   `seasonPhases` + per-slot `seasonOverrides` that
 *   `expandPracticeSlotsForSeason()` already takes -- no second mechanism.
 * - **G4, the compression report.** *Hold-starts*: every slot-date still
 *   ending past sunset under that schedule. *Cascade*: a proposal to shift the
 *   later slots of a night earlier, into the minutes the shortened practices
 *   before them gave up. Cascade proposals leave this module **only** as 8.8
 *   change-log entries (`changelog/classify.js` `buildChangeLog()`); nothing
 *   here writes a start time back (W13).
 * - **G5, the DST survival report.** Per unlit slot: does it survive at any
 *   phase duration, and if not, what would fix it -- a lit field, an earlier
 *   start, another night.
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
 * ## How a phase is derived
 *
 * Per venue, over the dates any of its unlit slots occurs, in order. The
 * venue's duration starts at the longest of its slots' own durations (a cap
 * that binds nothing). On each date every occurring slot is judged at
 * `min(its duration, the cap)` with its **start held**. If any ends past the
 * limit, a phase begins on that date, and its duration is the longest that
 * brings the tightest such slot back inside the limit, floored to
 * `durationStepMinutes`. That is the least shortening that date needs, and
 * the cap never lengthens again on its own (maximum freeze). A slot whose
 * longest legal duration on a date is below `minimumDurationMinutes` cannot
 * be saved by any phase on that date; it does not drag its venue's cap down
 * to nothing -- it is **held out**, counted, and reported by G4 and G5.
 *
 * Operator overrides pin a venue's duration from a date. They apply before
 * the date is judged, so one that leaves a practice past sunset is superseded
 * by a derived phase on the same date and the phase records what it
 * superseded.
 *
 * ## What is declared, not optimised (D11)
 *
 * Nothing here chooses durations, starts or nights to maximise the number of
 * surviving slots. The phase is the least shortening per date; the cascade
 * keeps each night's first start and every gap; the fixes G5 lists are
 * candidates whose permits, sizes and capacities are **not checked**. The
 * `practice-daylight` registry claim states the same.
 *
 * ## What D8 gets from here
 *
 * A weekly slot that is legal early and illegal late is truncated at its
 * first illegal date and the remainder goes TIME TBD. That truncation belongs
 * to the Edge post-pass (8.9 PR 6). G5 reports the date for every slot that
 * needs it (`d8.tbdFrom`), so nothing it will truncate is discovered there
 * for the first time.
 *
 * ## Universes come from the input
 *
 * Every report enumerates the **input plan's** slots x dates (weekday within
 * the slot's range, clamped to the window) -- never the materialised
 * occurrences and never another report's output. Lit slots, undated slots and
 * slot-dates with no known sunset are listed and counted, never omitted.
 * Dated one-off exceptions are out of scope: they are judged per occurrence
 * by `evaluatePracticeDaylight()`.
 *
 * Enforced nowhere live: the core `practiceScheduling.js`/`autoScheduler.js`
 * do not call this, and the Edge post-pass (8.9 PR 6) is a Deno twin, not a
 * caller.
 *
 * @module practice/durationPhases
 */

import { deepFreeze, getSurface } from '../facility/facilityGraph.js';
import { isoDateOfDayNumber, isoDayNumber } from '../facility/eligibility.js';
import { resolveLighting, sunsetForVenue } from '../availability/calendar.js';
import { AVAILABILITY_REASON } from '../availability/reasonCodes.js';
import { buildChangeLog } from '../changelog/classify.js';
import { PRACTICE_SUNSET_MARGIN_MINUTES } from './daylight.js';
import { teamsOn } from './materialise.js';
import { PracticeDurationPhaseOptionsSchema } from './schemas.js';
import { firstWeekdayOnOrAfter } from './slots.js';

/** Where a phase's duration came from. */
export const PRACTICE_PHASE_SOURCE = Object.freeze({
  BASE: 'base',
  DERIVED: 'derived',
  OVERRIDE: 'override',
});

/** The fixes G5 can name for a slot that does not survive. */
export const PRACTICE_SURVIVAL_FIX_KIND = Object.freeze({
  LIT_FIELD: 'lit-field',
  EARLIER_START: 'earlier-start',
  ANOTHER_NIGHT: 'another-night',
});

/** G5's verdict per unlit slot. */
export const PRACTICE_SURVIVAL_VERDICT = Object.freeze({
  SURVIVES: 'survives',
  DOES_NOT_SURVIVE: 'does-not-survive',
  UNKNOWN: 'unknown',
  NO_DATES: 'no-dates-in-window',
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
 * The longest duration, in whole steps, a practice starting at `startMinutes`
 * can run and still end by the limit; 0 when none.
 *
 * @param {number} limitMinutes
 * @param {number} startMinutes
 * @param {number} step
 * @returns {number}
 */
function longestLegalDuration(limitMinutes, startMinutes, step) {
  const room = limitMinutes - startMinutes;
  return room <= 0 ? 0 : Math.floor(room / step) * step;
}

/**
 * Can some phase save this slot on a date, start held? Yes when it already
 * ends by the limit at its own length (a slot shorter than the minimum is not
 * penalised for it), or when its longest legal duration in whole steps is at
 * least the minimum. The one survivability contract: G3's held-out slots and
 * G5's verdicts both read it.
 *
 * @param {number} limitMinutes
 * @param {{ startMinutes: number, durationMinutes: number }} slot
 * @param {number} step
 * @param {number} minimum
 * @returns {boolean}
 */
function survivesOnDate(limitMinutes, slot, step, minimum) {
  if (endsByDaylightLimit(slot.startMinutes + slot.durationMinutes, limitMinutes)) return true;
  return longestLegalDuration(limitMinutes, slot.startMinutes, step) >= minimum;
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
 * @typedef {Object} SlotDate
 * @property {string} date
 * @property {number|null} sunsetMinutes - the enforcement minute (floored)
 * @property {number|null} limitMinutes
 * @property {'table'|'computed'|'unknown'} sunsetSource
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
 * lighting, each unlit one with its dates and the limit on each.
 *
 * @param {{ slotSet: import('./types.js').PracticeSlotSet, graph: Object, calendar: Object, window: { from: string, to: string } }} input
 */
function buildUnlitUniverse({ slotSet, graph, calendar, window }) {
  if (!slotSet || !Array.isArray(slotSet.slots)) {
    throw new TypeError('durationPhases: requires the practice slot set');
  }
  if (!graph || !calendar) {
    throw new TypeError('durationPhases: requires the facility graph and the calendar');
  }

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
  // slot-dates report; G5's what-if lookups (another night) do not, so no
  // finding names a date nothing is scheduled on. Every plan lookup happens
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
      const daylight = daylightOn(venueId, date);
      return {
        date,
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
 * G3: derive the DurationPhase schedule.
 *
 * @param {Object} input
 * @param {import('./types.js').PracticeSlotSet} input.slotSet - the input plan
 * @param {Object} input.graph - the facility graph
 * @param {Object} input.calendar - the daylight provider
 * @param {{ from: string, to: string }} input.window
 * @param {number} input.minimumDurationMinutes
 * @param {number} [input.durationStepMinutes]
 * @param {Array<Object>} [input.overrides]
 */
export function derivePracticeDurationPhases(input) {
  const options = PracticeDurationPhaseOptionsSchema.parse({
    window: input.window,
    minimumDurationMinutes: input.minimumDurationMinutes,
    durationStepMinutes: input.durationStepMinutes,
    overrides: input.overrides,
  });
  const { window, minimumDurationMinutes, durationStepMinutes, overrides } = options;
  const universe = buildUnlitUniverse({ ...input, window });

  /** @type {Map<string, UnlitSlotEntry[]>} */
  const byVenue = new Map();
  /** Unlit slots on ground the graph cannot place: no venue, so no phases. */
  const slotsWithoutVenue = [];
  for (const entry of universe.unlit) {
    if (entry.venueId === null) {
      slotsWithoutVenue.push(entry.slot.id);
      continue;
    }
    const list = byVenue.get(entry.venueId) ?? [];
    list.push(entry);
    byVenue.set(entry.venueId, list);
  }

  for (const override of overrides) {
    if (!byVenue.has(override.venueId)) {
      throw new TypeError(
        `durationPhases: override for venue "${override.venueId}" names no venue with an unlit slot in this plan`
      );
    }
    if (override.effectiveFrom < window.from || override.effectiveFrom > window.to) {
      throw new TypeError(
        `durationPhases: override for venue "${override.venueId}" is dated ${override.effectiveFrom}, outside the window ${window.from}..${window.to}`
      );
    }
  }

  const meta = {
    slotsExamined:
      universe.unlit.length + universe.litSlotIds.length + universe.undatedSlotIds.length,
    unlitSlotsEnumerated: universe.unlit.length,
    litSlotsExempt: universe.litSlotIds.length,
    undatedSlots: universe.undatedSlotIds.length,
    unlitSlotsWithoutVenue: slotsWithoutVenue.length,
    unlitSlotDatesExamined: 0,
    slotDatesSunsetUnknown: 0,
    slotDatesHeldOut: 0,
    phaseTransitionsDerived: 0,
    overridesApplied: 0,
    overridesSuperseded: 0,
  };

  const venues = [];
  for (const venueId of [...byVenue.keys()].sort()) {
    const entries = /** @type {UnlitSlotEntry[]} */ (byVenue.get(venueId));
    const baseDuration = Math.max(...entries.map((entry) => entry.slot.durationMinutes));
    /** @type {Array<Object>} */
    const phases = [
      {
        effectiveFrom: window.from,
        durationMinutes: baseDuration,
        source: PRACTICE_PHASE_SOURCE.BASE,
        reason: 'the longest of the venue’s own slot durations: shortens nothing',
        bound: null,
        supersedes: null,
      },
    ];
    /** date -> the slot-dates judged on it */
    const onDate = new Map();
    for (const entry of entries) {
      for (const slotDate of entry.dates) {
        const list = onDate.get(slotDate.date) ?? [];
        list.push({ entry, slotDate });
        onDate.set(slotDate.date, list);
      }
    }
    /** @type {Map<string, Object>} */
    const venueOverrides = new Map();
    for (const override of overrides) {
      if (override.venueId !== venueId) continue;
      // Refused, not resolved: two pins on one venue-date would leave one of
      // them silently unapplied.
      if (venueOverrides.has(override.effectiveFrom)) {
        throw new TypeError(
          `durationPhases: two overrides pin venue "${venueId}" on ${override.effectiveFrom}; one would be silently lost`
        );
      }
      venueOverrides.set(override.effectiveFrom, override);
    }
    const dates = [...new Set([...onDate.keys(), ...venueOverrides.keys()])].sort();

    let cap = baseDuration;
    let heldOut = 0;
    for (const date of dates) {
      const override = venueOverrides.get(date);
      if (override) {
        cap = override.durationMinutes;
        meta.overridesApplied += 1;
        const phase = {
          effectiveFrom: date,
          durationMinutes: cap,
          source: PRACTICE_PHASE_SOURCE.OVERRIDE,
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

      let binding = null;
      for (const { entry, slotDate } of onDate.get(date) ?? []) {
        meta.unlitSlotDatesExamined += 1;
        if (slotDate.limitMinutes === null) {
          meta.slotDatesSunsetUnknown += 1;
          continue;
        }
        const { slot } = entry;
        const endMinutes = slot.startMinutes + Math.min(slot.durationMinutes, cap);
        if (endsByDaylightLimit(endMinutes, slotDate.limitMinutes)) continue;
        const longest = longestLegalDuration(
          slotDate.limitMinutes,
          slot.startMinutes,
          durationStepMinutes
        );
        if (
          !survivesOnDate(slotDate.limitMinutes, slot, durationStepMinutes, minimumDurationMinutes)
        ) {
          heldOut += 1;
          continue;
        }
        if (
          binding === null ||
          longest < binding.longest ||
          (longest === binding.longest && slot.id < binding.slot.id)
        ) {
          binding = { slot, slotDate, endMinutes, longest };
        }
      }
      if (binding === null) continue;

      const previousDuration = cap;
      cap = binding.longest;
      meta.phaseTransitionsDerived += 1;
      const phase = {
        effectiveFrom: date,
        durationMinutes: cap,
        source: PRACTICE_PHASE_SOURCE.DERIVED,
        reason: `on ${date} slot ${binding.slot.id} (${clockOf(binding.slot.startMinutes)}) would end at ${clockOf(binding.endMinutes)}, past the limit ${clockOf(binding.slotDate.limitMinutes)} (sunset ${clockOf(binding.slotDate.sunsetMinutes)}, ${binding.slotDate.sunsetSource}, margin ${PRACTICE_SUNSET_MARGIN_MINUTES})`,
        bound: {
          date,
          slotId: binding.slot.id,
          surfaceId: binding.slot.surfaceId,
          startMinutes: binding.slot.startMinutes,
          previousDurationMinutes: previousDuration,
          previousEndMinutes: binding.endMinutes,
          sunsetMinutes: binding.slotDate.sunsetMinutes,
          limitMinutes: binding.slotDate.limitMinutes,
          marginMinutes: PRACTICE_SUNSET_MARGIN_MINUTES,
          sunsetSource: binding.slotDate.sunsetSource,
        },
        supersedes: null,
      };
      if (phases[phases.length - 1].effectiveFrom === date) {
        const superseded = phases[phases.length - 1];
        if (superseded.source === PRACTICE_PHASE_SOURCE.OVERRIDE) meta.overridesSuperseded += 1;
        phase.supersedes = supersededBy(superseded);
        phases[phases.length - 1] = phase;
      } else {
        phases.push(phase);
      }
    }
    meta.slotDatesHeldOut += heldOut;
    venues.push({
      venueId,
      slotIds: entries.map((entry) => entry.slot.id),
      phases,
      slotDatesHeldOut: heldOut,
    });
  }

  // The season's phases: every venue's boundaries, merged. Within one of
  // these, every venue's duration is constant.
  const boundaries = [
    ...new Set(venues.flatMap((venue) => venue.phases.map((phase) => phase.effectiveFrom))),
  ];
  if (!boundaries.includes(window.from)) boundaries.push(window.from);
  boundaries.sort();
  const seasonPhases = boundaries.map((startDate, index) => ({
    id: `duration-phase-${String(index + 1).padStart(2, '0')}`,
    startDate,
    endDate:
      index + 1 < boundaries.length
        ? isoDateOfDayNumber(isoDayNumber(boundaries[index + 1]) - 1)
        : window.to,
    label: `practice durations from ${startDate}`,
  }));

  const capOn = (/** @type {string} */ venueId, /** @type {string} */ date) => {
    const venue = venues.find((candidate) => candidate.venueId === venueId);
    if (!venue) return null;
    let current = null;
    for (const phase of venue.phases) if (phase.effectiveFrom <= date) current = phase;
    return current ? current.durationMinutes : null;
  };

  // Every dated slot of the plan, lit ones and venue-less ones included, so the
  // schedule is complete; overrides only where a phase shortens the slot.
  const unlitById = new Map(universe.unlit.map((entry) => [entry.slot.id, entry]));
  const slots = [];
  for (const slot of input.slotSet.slots) {
    if (slot.validFrom === null || slot.validUntil === null) continue;
    const entry = unlitById.get(slot.id);
    /** @type {Record<string, { durationMinutes: number }>} */
    const seasonOverrides = {};
    if (entry && entry.venueId !== null) {
      for (const phase of seasonPhases) {
        const cap = capOn(entry.venueId, phase.startDate);
        if (cap !== null && cap < slot.durationMinutes) {
          seasonOverrides[phase.id] = { durationMinutes: cap };
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
      venueId: entry ? entry.venueId : (getSurface(input.graph, slot.surfaceId)?.venueId ?? null),
      lit: entry ? entry.lit : true,
      seasonOverrides,
    });
  }

  return deepFreeze({
    window,
    marginMinutes: PRACTICE_SUNSET_MARGIN_MINUTES,
    minimumDurationMinutes,
    durationStepMinutes,
    venues,
    seasonPhases,
    slots,
    litSlotIds: universe.litSlotIds,
    undatedSlotIds: universe.undatedSlotIds,
    slotsWithoutVenue,
    findings: universe.findings,
    meta,
    // False means nothing was examined: a caller must treat it as a loud
    // failure, never as a clean report (CLAUDE.md, meta-assertions).
    exercised: meta.unlitSlotDatesExamined > 0,
  });
}

/**
 * @param {Object} phase
 * @returns {{ source: string, durationMinutes: number, reason: string }}
 */
function supersededBy(phase) {
  return { source: phase.source, durationMinutes: phase.durationMinutes, reason: phase.reason };
}

/**
 * The duration a slot runs on a date under a phase schedule, read from the
 * `seasonPhases`/`seasonOverrides` pair exactly as `expandPracticeSlotsForSeason()`
 * reads it (the phase-specific key, then `default`, then the slot's own).
 *
 * @param {Object} phaseSchedule
 * @param {Object} scheduledSlot
 * @param {string} date
 * @returns {number}
 */
function durationUnder(phaseSchedule, scheduledSlot, date) {
  const phase = phaseSchedule.seasonPhases.find(
    (candidate) => candidate.startDate <= date && date <= candidate.endDate
  );
  const overrides = scheduledSlot.seasonOverrides ?? {};
  const override = (phase ? overrides[phase.id] : undefined) ?? overrides.default ?? null;
  return override?.durationMinutes ?? scheduledSlot.durationMinutes;
}

/**
 * G4: the compression report -- hold-starts and the cascade proposal.
 *
 * **Applies nothing.** The input plan and the phase schedule are read, never
 * written; the cascade's proposed starts leave only as the entries of an 8.8
 * change log, filed under {@link PRACTICE_SUNSET_CASCADE_SOURCE_ID} (W13).
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
  const universe = buildUnlitUniverse({ ...input, window: phaseSchedule.window });
  const scheduledById = new Map(phaseSchedule.slots.map((slot) => [slot.id, slot]));

  const meta = {
    unlitSlotsEnumerated: universe.unlit.length,
    unlitSlotDatesExamined: 0,
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
  /** slotId -> date -> the duration under the schedule */
  const durationOf = (/** @type {Object} */ slot, /** @type {string} */ date) =>
    durationUnder(phaseSchedule, scheduledById.get(slot.id), date);

  for (const chain of chains.values()) {
    const byDate = new Map();
    for (const entry of chain) {
      for (const slotDate of entry.dates) {
        const list = byDate.get(slotDate.date) ?? [];
        list.push(entry.slot);
        byDate.set(slotDate.date, list);
      }
    }
    for (const [date, members] of byDate) {
      members.sort((a, b) => a.startMinutes - b.startMinutes || (a.id < b.id ? -1 : 1));
      let shift = 0;
      let broken = false;
      // The latest planned end of every slot before this one, not only the
      // one immediately before: an overlap with any of them is an overlap.
      let latestEnd = -Infinity;
      members.forEach((slot, index) => {
        if (index > 0 && !broken) {
          const previous = members[index - 1];
          if (slot.startMinutes < latestEnd) {
            // Overlapping slots are not a sequence: from here on, nothing on
            // this surface this night moves.
            broken = true;
            shift = 0;
            meta.cascadeNightsBrokenByOverlap += 1;
          } else {
            shift += previous.durationMinutes - durationOf(previous, date);
          }
        }
        latestEnd = Math.max(latestEnd, slot.startMinutes + slot.durationMinutes);
        proposedStart.set(`${slot.id}\u0000${date}`, slot.startMinutes - (broken ? 0 : shift));
      });
    }
  }

  const flagged = [];
  for (const entry of universe.unlit) {
    const { slot } = entry;
    for (const slotDate of entry.dates) {
      meta.unlitSlotDatesExamined += 1;
      const cascadeStart = /** @type {number} */ (
        proposedStart.get(`${slot.id}\u0000${slotDate.date}`)
      );
      if (cascadeStart !== slot.startMinutes) meta.cascadeSlotDatesShifted += 1;
      if (slotDate.limitMinutes === null) {
        meta.slotDatesSunsetUnknown += 1;
        continue;
      }
      const duration = durationOf(slot, slotDate.date);
      const endMinutes = slot.startMinutes + duration;
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
        reason: `start held at ${clockOf(slot.startMinutes)}: at the phase duration of ${duration} min it ends ${clockOf(endMinutes)}, ${endMinutes - slotDate.limitMinutes} min past the limit`,
        startMinutes: slot.startMinutes,
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
  // unassigned slot) at each date the proposed start changes from the state
  // before it. The first "before" is the plan's own start.
  const rawEntries = [];
  const practiceLabels = new Set([PRACTICE_CASCADE_UNASSIGNED_LABEL]);
  for (const entry of universe.unlit) {
    const { slot } = entry;
    let current = slot.startMinutes;
    for (const { date } of entry.dates) {
      const proposed = /** @type {number} */ (proposedStart.get(`${slot.id}\u0000${date}`));
      if (proposed === current) continue;
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
      current = proposed;
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
    exercised: meta.unlitSlotDatesExamined > 0,
  });
}

/**
 * G5: the DST survival report -- per unlit slot of the **input** plan, does it
 * survive at any phase duration, and if not, what fixes it.
 *
 * A slot survives on a date when, start held, its longest legal duration in
 * whole steps is at least `minimumDurationMinutes`. It survives when it does
 * on every date with a known sunset. The fixes are candidates, stated with
 * what was not checked (D11): a lit surface is named for its lighting only;
 * an earlier start is not checked against permits or the slots around it;
 * another night is judged on this venue's sunset at this start.
 *
 * @param {Object} input
 * @param {import('./types.js').PracticeSlotSet} input.slotSet
 * @param {Object} input.graph
 * @param {Object} input.calendar
 * @param {{ from: string, to: string }} input.window
 * @param {number} input.minimumDurationMinutes
 * @param {number} [input.durationStepMinutes]
 */
export function buildDstSurvivalReport(input) {
  const options = PracticeDurationPhaseOptionsSchema.parse({
    window: input.window,
    minimumDurationMinutes: input.minimumDurationMinutes,
    durationStepMinutes: input.durationStepMinutes,
  });
  const { window, minimumDurationMinutes, durationStepMinutes } = options;
  const universe = buildUnlitUniverse({ ...input, window });

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
    slotDatesSunsetUnknown: 0,
    slotsSurviving: 0,
    slotsNotSurviving: 0,
    slotsUnknown: 0,
    slotsWithNoDates: 0,
    fixesAvailableByKind: {
      [PRACTICE_SURVIVAL_FIX_KIND.LIT_FIELD]: 0,
      [PRACTICE_SURVIVAL_FIX_KIND.EARLIER_START]: 0,
      [PRACTICE_SURVIVAL_FIX_KIND.ANOTHER_NIGHT]: 0,
    },
    slotsWithNoFix: 0,
  };

  const rows = universe.unlit.map((entry) => {
    const { slot } = entry;
    meta.slotDatesExamined += entry.dates.length;
    const unknownDates = entry.dates.filter((d) => d.limitMinutes === null).map((d) => d.date);
    meta.slotDatesSunsetUnknown += unknownDates.length;
    const failing = entry.dates.filter(
      (d) => d.limitMinutes !== null && !survivesOn(d.limitMinutes, slot)
    );
    const base = {
      slotId: slot.id,
      surfaceId: slot.surfaceId,
      venueId: entry.venueId,
      weekday: slot.weekday,
      startMinutes: slot.startMinutes,
      durationMinutes: slot.durationMinutes,
      datesExamined: entry.dates.length,
      unknownDates,
    };

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
            : `ends by sunset on every date, at its own length or at a duration of at least ${minimumDurationMinutes} min`,
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
      entry.dates.filter((d) => d.date < first.date && d.limitMinutes !== null).at(-1) ?? null;
    const knownLimits = entry.dates.filter((d) => d.limitMinutes !== null);
    const tightest = knownLimits.reduce((a, b) =>
      /** @type {number} */ (b.limitMinutes) < /** @type {number} */ (a.limitMinutes) ? b : a
    );
    const tightestLimit = /** @type {number} */ (tightest.limitMinutes);
    const startAtFullDuration = tightestLimit - slot.durationMinutes;
    const startAtMinimum = tightestLimit - Math.min(minimumDurationMinutes, slot.durationMinutes);
    const floor = earliestPlannedStart.get(slot.surfaceId) ?? null;
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
        // surface: an earlier start than the plan's earliest there is a
        // guess about school hours and permits, not a fix.
        available: floor !== null && startAtMinimum >= floor,
        startMinutesAtFullDuration: startAtFullDuration >= 0 ? startAtFullDuration : null,
        startMinutesAtMinimumDuration: startAtMinimum >= 0 ? startAtMinimum : null,
        earliestPlannedStartMinutes: floor,
        bindingDate: tightest.date,
        unchecked:
          'bounded below by the earliest start this plan uses on the surface; permit windows and the occupancy of the slots it would move into are not checked',
      },
      {
        kind: PRACTICE_SURVIVAL_FIX_KIND.ANOTHER_NIGHT,
        available: otherNights.length > 0,
        weekdays: otherNights,
        unchecked:
          'judged on this venue’s sunset at this start; permits and occupancy are not checked',
      },
    ];
    let any = false;
    for (const fix of fixes) {
      if (!fix.available) continue;
      any = true;
      meta.fixesAvailableByKind[fix.kind] += 1;
    }
    if (!any) meta.slotsWithNoFix += 1;

    return {
      ...base,
      verdict: PRACTICE_SURVIVAL_VERDICT.DOES_NOT_SURVIVE,
      code: AVAILABILITY_REASON.PRACTICE_PAST_SUNSET,
      reason: `from ${first.date} its longest legal duration, start held at ${clockOf(slot.startMinutes)}, is below ${minimumDurationMinutes} min (limit ${clockOf(/** @type {number} */ (first.limitMinutes))}, sunset ${first.sunsetSource})`,
      failingDates: failing.map((d) => d.date),
      d8: {
        legalThrough: lastLegal ? lastLegal.date : null,
        tbdFrom: first.date,
        tbdDates: entry.dates.filter((d) => d.date >= first.date).length,
      },
      fixes,
    };
  });

  return deepFreeze({
    window,
    marginMinutes: PRACTICE_SUNSET_MARGIN_MINUTES,
    minimumDurationMinutes,
    durationStepMinutes,
    rows,
    litSlotIds: universe.litSlotIds,
    undatedSlotIds: universe.undatedSlotIds,
    findings: universe.findings,
    meta,
    // False means nothing was examined: a caller must treat it as a loud
    // failure, never as a clean report (CLAUDE.md, meta-assertions).
    exercised: meta.slotDatesExamined > 0,
  });
}
