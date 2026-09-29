/**
 * 8.9 PR 5, reworked by 8.9 D14: DurationPhase derivation (G3), the
 * compression report (G4) and the DST survival report (G5),
 * `practice/durationPhases.js`.
 *
 * Witnesses, numbered as in `docs/PHASE_8_9_PLAN.md` section 4 and the D14
 * plan (`docs/PHASE_8_9_D14_PLAN.md`). Each was shown red by its plant (listed
 * on the describe block) before it counted; the plants are source edits
 * recorded in the PR, not left in the tree.
 *
 * **No real coordinates.** The one coordinate below is synthetic -- round
 * numbers, not a place (40.00/-75.00), the same point `practiceDaylight.test.js`
 * uses. Nothing is fitted, geocoded or fetched.
 *
 * **Universes come from inputs.** Every expected set or count is derived from
 * the practice plan (slots x dates by plain arithmetic), the raw geometry and
 * the sunset table -- never from a report's own output.
 */

import { describe, expect, it } from 'vitest';

import {
  buildAvailabilityCalendar,
  buildAvailabilityCalendarFromSeason2026,
} from '@squadlogic/core/availability/index.js';
import { getConstraint } from '@squadlogic/core/constraints/index.js';
import { buildSeason2026PracticeConstraintRegistry } from '@squadlogic/core/constraints/index.js';
import {
  buildFacilityGraph,
  buildSeason2026PracticeFacilityGraph,
  buildSeason2026VenueComplexMap,
} from '@squadlogic/core/facility/index.js';
import {
  loadFacilityGeometry,
  loadFacilityPermits,
  loadSeason2026Practice,
  loadSunsets,
} from '@squadlogic/core/fixtures/index.js';
import {
  PRACTICE_COMPRESSION_STEP_MINUTES,
  PRACTICE_COMPRESSION_STRATEGY,
  PRACTICE_DAYLIGHT_CONSTRAINT_ID,
  PRACTICE_MINIMUM_DURATION_MINUTES,
  PRACTICE_PHASE_SOURCE,
  PRACTICE_RETIME_KIND,
  PRACTICE_RETIME_REFUSAL,
  PRACTICE_SUNSET_CASCADE_SOURCE_ID,
  PRACTICE_SURVIVAL_FIX_KIND,
  PRACTICE_SURVIVAL_VERDICT,
  buildDstSurvivalReport,
  buildPracticeCompressionReport,
  buildPracticeSlotSet,
  derivePracticeDurationPhases,
  endsByDaylightLimit,
  evaluatePracticeDaylight,
  ladderDuration,
  materialisePracticeOccurrences,
  shiftedStart,
  toSeason2026PracticePlan,
} from '@squadlogic/core/practice/index.js';
import { expandPracticeSlotsForSeason } from '@squadlogic/core/practiceSlotExpansion.js';
import { sunsetOnDate } from '@squadlogic/core/timing/index.js';

/* -------------------------------------------------------------------------- */
/* Arithmetic, independent of the module                                       */
/* -------------------------------------------------------------------------- */

const TIME_ZONE = 'America/New_York';
/** SYNTHETIC coordinates, not a place. */
const SYNTHETIC_EAST = Object.freeze({ latitude: 40.0, longitude: -75.0 });

const MS_PER_DAY = 86_400_000;
const WEEKDAYS = ['THU', 'FRI', 'SAT', 'SUN', 'MON', 'TUE', 'WED'];
const dayNumber = (iso) =>
  Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / MS_PER_DAY;
const isoOf = (day) => {
  const d = new Date(day * MS_PER_DAY);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};
const weekdayOf = (iso) => WEEKDAYS[((dayNumber(iso) % 7) + 7) % 7];
const datesBetween = (from, to) => {
  const out = [];
  for (let day = dayNumber(from); day <= dayNumber(to); day += 1) out.push(isoOf(day));
  return out;
};
const slotDates = (slot, from, to) =>
  datesBetween(
    slot.validFrom > from ? slot.validFrom : from,
    slot.validUntil < to ? slot.validUntil : to
  ).filter((date) => weekdayOf(date) === slot.weekday);
const minutesOfDate = (date) => date.getUTCHours() * 60 + date.getUTCMinutes();

/* -------------------------------------------------------------------------- */
/* A synthetic rig: one unlit surface, sunsets set to the minute               */
/* -------------------------------------------------------------------------- */

const rigGraph = buildFacilityGraph({
  venues: [
    { id: 'dark', name: 'Dark Park', lit: false },
    { id: 'bright', name: 'Bright Park', lit: true },
  ],
  surfaces: [
    { id: 'dark/f', venueId: 'dark', name: 'F', sizes: ['7v7'], lined: ['7v7'] },
    { id: 'bright/f', venueId: 'bright', name: 'F', sizes: ['7v7'], lined: ['7v7'] },
  ],
});
const rigCalendar = (rows) => buildAvailabilityCalendar({ timeZone: TIME_ZONE, sunsets: rows });
const rigSlot = (id, startMinutes, durationMinutes, extra = {}) => ({
  id,
  surfaceId: 'dark/f',
  weekday: 'TUE',
  startMinutes,
  durationMinutes,
  validFrom: '2026-10-06',
  validUntil: '2026-10-20',
  capacity: 1,
  revisionId: 'r',
  label: null,
  ...extra,
});
const rigPlan = (slots) =>
  buildPracticeSlotSet({
    slots,
    assignments: slots.map((slot) => ({
      id: `a-${slot.id}`,
      slotId: slot.id,
      teamId: `T-${slot.id}`,
    })),
    source: 'rig',
  });
const RIG_WINDOW = { from: '2026-10-06', to: '2026-10-20' };
/** The derived phases of one slot, as `[date, start, duration, retime]`. */
const derivedOf = (schedule, slotId) =>
  schedule.slotPhases
    .find((entry) => entry.slotId === slotId)
    .phases.filter((phase) => phase.source === PRACTICE_PHASE_SOURCE.DERIVED)
    .map((phase) => [phase.effectiveFrom, phase.startMinutes, phase.durationMinutes, phase.retime]);
const tbdOf = (schedule, slotId) =>
  schedule.slotPhases
    .find((entry) => entry.slotId === slotId)
    .tbd.map((entry) => [entry.date, entry.shortenRefused, entry.shiftRefused]);

/* -------------------------------------------------------------------------- */
/* W12 -- the phase transition                                                 */
/* -------------------------------------------------------------------------- */

describe('W12: a phase begins on the first date the last unlit end EXCEEDS the limit', () => {
  // Plant: `limitMinutes > endMinutes` in endsByDaylightLimit() (`>` where
  // `>=` is meant). The 10/13 equality date then starts the phase a week
  // early and every assertion on the transition date goes red.
  const calendar = rigCalendar([
    { date: '2026-10-06', sunsetMinutes: 19 * 60 + 5 },
    { date: '2026-10-13', sunsetMinutes: 19 * 60 }, // the 19:00 end equals floor(sunset): legal
    { date: '2026-10-20', sunsetMinutes: 19 * 60 - 1 }, // one minute short: the phase starts
  ]);
  const plan = rigPlan([rigSlot('late', 18 * 60, 60)]);
  const schedule = derivePracticeDurationPhases({
    slotSet: plan,
    graph: rigGraph,
    calendar,
    window: RIG_WINDOW,
  });
  const [timeline] = schedule.slotPhases;

  it('the comparison: equality is legal, one minute over is not', () => {
    expect(endsByDaylightLimit(19 * 60, 19 * 60)).toBe(true);
    expect(endsByDaylightLimit(19 * 60 + 1, 19 * 60)).toBe(false);
  });

  it('the transition is 10/20, not the 10/13 equality date (W16: one minute needed, 60 -> 50)', () => {
    expect(timeline.slotId).toBe('late');
    expect(timeline.phases.map((p) => [p.effectiveFrom, p.durationMinutes, p.source])).toEqual([
      ['2026-10-06', 60, PRACTICE_PHASE_SOURCE.BASE],
      ['2026-10-20', 50, PRACTICE_PHASE_SOURCE.DERIVED],
    ]);
  });

  it('the derivation is shown: the date, the sunset and the slot that bound it', () => {
    expect(timeline.phases[1].bound).toEqual({
      date: '2026-10-20',
      slotId: 'late',
      surfaceId: 'dark/f',
      previousStartMinutes: 18 * 60,
      previousDurationMinutes: 60,
      previousEndMinutes: 19 * 60,
      sunsetMinutes: 19 * 60 - 1,
      limitMinutes: 19 * 60 - 1,
      marginMinutes: 0,
      sunsetSource: 'table',
    });
  });

  it('G3 output is exactly what expandPracticeSlotsForSeason consumes', () => {
    expect(schedule.seasonPhases).toEqual([
      {
        id: 'duration-phase-01',
        startDate: '2026-10-06',
        endDate: '2026-10-19',
        label: 'practice durations from 2026-10-06',
      },
      {
        id: 'duration-phase-02',
        startDate: '2026-10-20',
        endDate: '2026-10-20',
        label: 'practice durations from 2026-10-20',
      },
    ]);
    const expanded = expandPracticeSlotsForSeason({
      slots: schedule.slots,
      seasonPhases: schedule.seasonPhases,
    });
    expect(
      expanded.map((e) => [e.seasonPhaseId, (e.end - e.start) / 60000, e.effectiveFrom])
    ).toEqual([
      ['duration-phase-01', 60, '2026-10-06'],
      ['duration-phase-02', 50, '2026-10-20'],
    ]);
  });

  it('an override pins a slot duration; one that would pass sunset is superseded, not honoured', () => {
    const base = { slotSet: plan, graph: rigGraph, calendar, window: RIG_WINDOW };
    const pin = (effectiveFrom, durationMinutes, slotId = 'late') => [
      { slotId, effectiveFrom, durationMinutes, reason: 'club asked' },
    ];
    const pinned = derivePracticeDurationPhases({ ...base, overrides: pin('2026-10-13', 50) });
    expect(
      pinned.slotPhases[0].phases.map((p) => [p.effectiveFrom, p.durationMinutes, p.source])
    ).toEqual([
      ['2026-10-06', 60, 'base'],
      ['2026-10-13', 50, 'override'],
    ]);
    const tooLong = derivePracticeDurationPhases({ ...base, overrides: pin('2026-10-20', 60) });
    const last = tooLong.slotPhases[0].phases.at(-1);
    expect(last).toMatchObject({
      effectiveFrom: '2026-10-20',
      durationMinutes: 50,
      source: 'derived',
    });
    expect(last.supersedes).toEqual({
      source: 'override',
      startMinutes: 18 * 60,
      durationMinutes: 60,
      reason: 'club asked',
    });
    expect(tooLong.meta.overridesSuperseded).toBe(1);
    expect(() =>
      derivePracticeDurationPhases({ ...base, overrides: pin('2026-10-13', 50, 'nowhere') })
    ).toThrow(/names no unlit slot/);
    // A pin may neither lengthen the plan nor go below the minimum.
    expect(() =>
      derivePracticeDurationPhases({ ...base, overrides: pin('2026-10-13', 70) })
    ).toThrow(/longer than the slot/);
    expect(() =>
      derivePracticeDurationPhases({ ...base, overrides: pin('2026-10-13', 30) })
    ).toThrow(/below the 40-minute minimum/);
  });

  it('the D14 defaults: a 40-minute minimum and a 10-minute step', () => {
    expect(PRACTICE_MINIMUM_DURATION_MINUTES).toBe(40);
    expect(PRACTICE_COMPRESSION_STEP_MINUTES).toBe(10);
    expect(schedule.minimumDurationMinutes).toBe(40);
    expect(schedule.durationStepMinutes).toBe(10);
  });
});

/* -------------------------------------------------------------------------- */
/* W16 / W17 -- the ladder                                                     */
/* -------------------------------------------------------------------------- */

describe('W16/W17: the default is the 10-minute ladder, from the slot’s own length', () => {
  // W16 plant: the step default 1 (schema default or constant). 60 -> 59 and
  // 60 -> 48 turn red. W17 plant: the old floor-to-step rule
  // (`floor((limit - start) / step) * step`); the 75-minute slot gets 70, red.
  const calendar = rigCalendar([
    { date: '2026-10-06', sunsetMinutes: 19 * 60 + 5 },
    { date: '2026-10-13', sunsetMinutes: 19 * 60 - 1 },
    { date: '2026-10-20', sunsetMinutes: 19 * 60 - 12 },
  ]);
  const schedule = derivePracticeDurationPhases({
    slotSet: rigPlan([rigSlot('sixty', 18 * 60, 60), rigSlot('long', 17 * 60 + 45, 75)]),
    graph: rigGraph,
    calendar,
    window: RIG_WINDOW,
  });

  it('ladderDuration: 60 -> 50 for one minute, 60 -> 40 for twelve, 75 -> 65 for one', () => {
    const at = (start, duration, limit, current) =>
      ladderDuration({
        plannedDurationMinutes: duration,
        currentDurationMinutes: current,
        startMinutes: start,
        limitMinutes: limit,
      });
    expect(at(18 * 60, 60, 19 * 60 - 1)).toBe(50);
    expect(at(18 * 60, 60, 19 * 60 - 12)).toBe(40);
    expect(at(17 * 60 + 45, 75, 19 * 60 - 1)).toBe(65);
    // k never decreases: already at 40, a date needing one step keeps 40.
    expect(at(18 * 60, 60, 19 * 60 - 1, 40)).toBe(40);
    expect(at(18 * 60, 60, 18 * 60)).toBe(0);
  });

  it('G3 takes several steps in one phase and never walks back', () => {
    expect(derivedOf(schedule, 'sixty')).toEqual([
      ['2026-10-13', 18 * 60, 50, PRACTICE_RETIME_KIND.SHORTEN],
      ['2026-10-20', 18 * 60, 40, PRACTICE_RETIME_KIND.SHORTEN],
    ]);
    expect(derivedOf(schedule, 'long')).toEqual([
      ['2026-10-13', 17 * 60 + 45, 65, PRACTICE_RETIME_KIND.SHORTEN],
      ['2026-10-20', 17 * 60 + 45, 55, PRACTICE_RETIME_KIND.SHORTEN],
    ]);
  });

  it('cuts are per slot: the earlier slot is not cut because the later one needed it', () => {
    const perSlot = derivePracticeDurationPhases({
      slotSet: rigPlan([rigSlot('early', 17 * 60, 60), rigSlot('later', 18 * 60, 60)]),
      graph: rigGraph,
      calendar,
      window: RIG_WINDOW,
    });
    expect(derivedOf(perSlot, 'early')).toEqual([]);
    expect(perSlot.slots.find((s) => s.id === 'early').seasonOverrides).toEqual({});
  });
});

/* -------------------------------------------------------------------------- */
/* W19 -- below the minimum with no legal shift: TIME TBD with its date        */
/* -------------------------------------------------------------------------- */

describe('W19: a slot below the minimum with no legal shift is TIME TBD, never emitted', () => {
  // Plant: drop the minimum check in the SHORTEN branch (accept any rung). The
  // slot is then emitted at 20 minutes and every assertion here goes red.
  const calendar = rigCalendar([
    { date: '2026-10-06', sunsetMinutes: 19 * 60 + 5 },
    { date: '2026-10-13', sunsetMinutes: 18 * 60 + 25 },
    { date: '2026-10-20', sunsetMinutes: 18 * 60 + 20 },
  ]);
  const plan = rigPlan([rigSlot('dusk', 18 * 60, 60)]);
  const input = { slotSet: plan, graph: rigGraph, calendar, window: RIG_WINDOW };
  const schedule = derivePracticeDurationPhases(input);

  it('held out on each date with its reasons; nothing shorter than 40 is emitted', () => {
    expect(tbdOf(schedule, 'dusk')).toEqual([
      [
        '2026-10-13',
        PRACTICE_RETIME_REFUSAL.BELOW_MINIMUM,
        PRACTICE_RETIME_REFUSAL.EARLIEST_START_UNKNOWN,
      ],
      [
        '2026-10-20',
        PRACTICE_RETIME_REFUSAL.BELOW_MINIMUM,
        PRACTICE_RETIME_REFUSAL.EARLIEST_START_UNKNOWN,
      ],
    ]);
    expect(schedule.slotPhases[0].tbd[0].reason).toMatch(/below the 40-minute minimum/);
    expect(derivedOf(schedule, 'dusk')).toEqual([]);
    for (const slot of schedule.slots) {
      for (const override of Object.values(slot.seasonOverrides)) {
        expect(override.durationMinutes).toBeGreaterThanOrEqual(40);
      }
    }
    expect(schedule.meta.slotDatesHeldOut).toBe(2);
  });

  it('G5 names the D8 date; G4 flags the same dates', () => {
    const [row] = buildDstSurvivalReport(input).rows;
    expect(row.verdict).toBe(PRACTICE_SURVIVAL_VERDICT.DOES_NOT_SURVIVE);
    expect(row.d8).toEqual({
      legalThrough: '2026-10-06',
      tbdFrom: '2026-10-13',
      tbdDates: 2,
      heldOutDates: 2,
    });
    const report = buildPracticeCompressionReport({ ...input, phaseSchedule: schedule });
    expect(report.holdStarts.flagged.map((f) => f.date)).toEqual(['2026-10-13', '2026-10-20']);
  });
});

/* -------------------------------------------------------------------------- */
/* W20 / W21 -- SHIFT_EARLIER: the floor, and the duration kept                */
/* -------------------------------------------------------------------------- */

describe('W20/W21: SHIFT_EARLIER keeps the duration and never starts before the floor', () => {
  // W20 plant: remove the floor check in shiftedStart(); 10/13 then shifts to
  // 16:40, before the 16:45 floor, and the TBD assertion goes red.
  // W21 plant: shorten as well as shift (the ladder's rung as the duration);
  // the 60-minute assertions go red.
  const calendar = rigCalendar([
    { date: '2026-10-06', sunsetMinutes: 17 * 60 + 50 },
    { date: '2026-10-13', sunsetMinutes: 17 * 60 + 40 },
    { date: '2026-10-20', sunsetMinutes: 17 * 60 + 55 },
  ]);
  const plan = rigPlan([rigSlot('s', 17 * 60, 60)]);
  const input = {
    slotSet: plan,
    graph: rigGraph,
    calendar,
    window: RIG_WINDOW,
    strategies: { s: PRACTICE_COMPRESSION_STRATEGY.SHIFT_EARLIER },
    earliestStartMinutes: 16 * 60 + 45,
  };
  const schedule = derivePracticeDurationPhases(input);

  it('W20: 10/06 moves to 16:50; 10/13 would need 16:40, before the floor: TIME TBD', () => {
    expect(derivedOf(schedule, 's')).toEqual([
      ['2026-10-06', 16 * 60 + 50, 60, PRACTICE_RETIME_KIND.SHIFT_EARLIER],
    ]);
    expect(tbdOf(schedule, 's')).toEqual([
      ['2026-10-13', null, PRACTICE_RETIME_REFUSAL.EARLIEST_START_FLOOR],
    ]);
    expect(schedule.slotPhases[0].tbd[0].wouldStartMinutes).toBe(16 * 60 + 40);
    expect(
      shiftedStart({
        startMinutes: 17 * 60,
        durationMinutes: 60,
        limitMinutes: 17 * 60 + 40,
        floorMinutes: 16 * 60 + 45,
      })
    ).toEqual({
      startMinutes: null,
      refused: PRACTICE_RETIME_REFUSAL.EARLIEST_START_FLOOR,
      wouldStartMinutes: 16 * 60 + 40,
    });
  });

  it('W21: the shifted slot keeps its 60 minutes, start and duration together', () => {
    const slot = schedule.slots.find((s) => s.id === 's');
    expect(Object.values(slot.seasonOverrides)).toEqual([
      { durationMinutes: 60, startTime: '16:50' },
    ]);
    const expanded = expandPracticeSlotsForSeason({
      slots: schedule.slots,
      seasonPhases: schedule.seasonPhases,
    });
    for (const record of expanded) expect((record.end - record.start) / 60000).toBe(60);
    expect(expanded.map((record) => minutesOfDate(record.start))).toEqual([16 * 60 + 50]);
  });

  it('the floor is never assumed: SHIFT_EARLIER without it is refused at the input', () => {
    expect(() =>
      derivePracticeDurationPhases({ ...input, earliestStartMinutes: undefined })
    ).toThrow(/earliestStartMinutes/);
    // And on a night the floor does not cover (Mon-Thu), the shift is refused.
    expect(() =>
      derivePracticeDurationPhases({ ...input, strategies: { ghost: 'shift-earlier' } })
    ).toThrow(/no unlit, dated slot in this plan/);
    const friday = derivePracticeDurationPhases({
      ...input,
      slotSet: rigPlan([
        rigSlot('s', 17 * 60, 60, {
          weekday: 'FRI',
          validFrom: '2026-10-09',
          validUntil: '2026-10-09',
        }),
      ]),
      window: { from: '2026-10-09', to: '2026-10-09' },
      calendar: rigCalendar([{ date: '2026-10-09', sunsetMinutes: 17 * 60 + 50 }]),
    });
    expect(tbdOf(friday, 's')).toEqual([
      ['2026-10-09', null, PRACTICE_RETIME_REFUSAL.EARLIEST_START_UNKNOWN],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* W22 -- no shifted-slot overlap                                              */
/* -------------------------------------------------------------------------- */

describe('W22: a shifted slot never overlaps an earlier slot on its surface that night', () => {
  // Plant: skip the overlap check in shiftedStart(); `after` then moves into
  // `before` (17:50 while `before` ends 18:00) and goes red.
  const calendar = rigCalendar([
    { date: '2026-10-06', sunsetMinutes: 20 * 60 },
    { date: '2026-10-13', sunsetMinutes: 18 * 60 + 50 },
    { date: '2026-10-20', sunsetMinutes: 20 * 60 },
  ]);
  const derive = (earlierStart) =>
    derivePracticeDurationPhases({
      slotSet: rigPlan([rigSlot('before', earlierStart, 60), rigSlot('after', 18 * 60, 60)]),
      graph: rigGraph,
      calendar,
      window: RIG_WINDOW,
      strategies: { after: PRACTICE_COMPRESSION_STRATEGY.SHIFT_EARLIER },
      earliestStartMinutes: 16 * 60,
    });

  it('back to back: the shift would overlap, so 10/13 is TIME TBD `overlap`', () => {
    const schedule = derive(17 * 60);
    expect(derivedOf(schedule, 'after')).toEqual([]);
    expect(tbdOf(schedule, 'after')).toEqual([
      ['2026-10-13', null, PRACTICE_RETIME_REFUSAL.OVERLAP],
    ]);
    expect(schedule.slotPhases.find((s) => s.slotId === 'after').tbd[0].earlierEndMinutes).toBe(
      18 * 60
    );
  });

  it('with a gap before it, the same shift is legal (the case is not vacuous)', () => {
    const schedule = derive(16 * 60);
    expect(derivedOf(schedule, 'after')).toEqual([
      ['2026-10-13', 17 * 60 + 50, 60, PRACTICE_RETIME_KIND.SHIFT_EARLIER],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Auto-fallback: SHORTEN below the minimum shifts when the floor allows       */
/* -------------------------------------------------------------------------- */

describe('auto-fallback: SHORTEN that would go below 40 shifts earlier when the floor allows', () => {
  // Plant: disable the fallback (no shift for a SHORTEN slot); 10/13 goes
  // TIME TBD and the fallback assertions go red.
  const calendar = rigCalendar([
    { date: '2026-10-06', sunsetMinutes: 18 * 60 + 55 },
    { date: '2026-10-13', sunsetMinutes: 18 * 60 + 35 },
    { date: '2026-10-20', sunsetMinutes: 18 * 60 + 30 },
  ]);
  const schedule = derivePracticeDurationPhases({
    slotSet: rigPlan([rigSlot('f', 18 * 60, 60)]),
    graph: rigGraph,
    calendar,
    window: RIG_WINDOW,
    earliestStartMinutes: 16 * 60,
  });

  it('shortens to 50, then keeps 50 and moves earlier rather than cut to 30', () => {
    expect(derivedOf(schedule, 'f')).toEqual([
      ['2026-10-06', 18 * 60, 50, PRACTICE_RETIME_KIND.SHORTEN],
      ['2026-10-13', 17 * 60 + 40, 50, PRACTICE_RETIME_KIND.FALLBACK_SHIFT],
    ]);
    expect(tbdOf(schedule, 'f')).toEqual([]);
    expect(schedule.meta.fallbackShifts).toBe(1);
    // Refusals count held-out dates only: the ladder's refusal on 10/13 was
    // rescued by the shift, so nothing is counted.
    expect(Object.values(schedule.meta.retimeRefusals)).toEqual([0, 0, 0, 0]);
    expect(schedule.slots[0].seasonOverrides).toEqual({
      'duration-phase-01': { durationMinutes: 50 },
      'duration-phase-02': { durationMinutes: 50, startTime: '17:40' },
    });
  });
});

/* -------------------------------------------------------------------------- */
/* W23 -- a lighting override exempts only its own window                      */
/* -------------------------------------------------------------------------- */

describe('W23: an override exempts only its window; a boundary moved one day turns only that date red', () => {
  // Plant: `date < window.until` in lightingOverrideCovers(). The window's last
  // date (10/20) is then judged and goes TIME TBD; the exact-set assertion
  // goes red.
  const window = { from: '2026-10-06', to: '2026-10-27' };
  // 10/13 has no sunset at all (no row, no coordinates): exempt, it is never
  // SUNSET_UNKNOWN.
  const calendar = rigCalendar([
    { date: '2026-10-06', sunsetMinutes: 17 * 60 + 30 },
    { date: '2026-10-20', sunsetMinutes: 17 * 60 + 30 },
    { date: '2026-10-27', sunsetMinutes: 17 * 60 + 30 },
  ]);
  const slotSet = rigPlan([rigSlot('lamp', 18 * 60, 60, { validUntil: '2026-10-27' })]);
  const run = (from, until) =>
    derivePracticeDurationPhases({
      slotSet,
      graph: rigGraph,
      calendar,
      window,
      lightingOverrides: [{ slotId: 'lamp', from, until }],
    });
  const tbdDates = (schedule) => schedule.slotPhases[0].tbd.map((entry) => entry.date);

  it('inside the window nothing is judged, nothing is unknown, and the slot runs as planned', () => {
    const schedule = run('2026-10-13', '2026-10-20');
    expect(tbdDates(schedule)).toEqual(['2026-10-06', '2026-10-27']);
    expect(schedule.meta.slotDatesExempt).toBe(2);
    expect(schedule.meta.slotDatesSunsetUnknown).toBe(0);
    expect(schedule.findings.filter((f) => f.details?.date === '2026-10-13')).toEqual([]);
    const expanded = expandPracticeSlotsForSeason({
      slots: schedule.slots,
      seasonPhases: schedule.seasonPhases,
    });
    // The window's edges are phase boundaries; inside it the slot is as planned.
    expect(schedule.seasonPhases.map((p) => p.startDate)).toEqual([
      '2026-10-06',
      '2026-10-13',
      '2026-10-21',
    ]);
    for (const record of expanded) {
      expect([minutesOfDate(record.start), (record.end - record.start) / 60000]).toEqual([
        18 * 60,
        60,
      ]);
    }
  });

  it('moving either edge one day in turns exactly that date red', () => {
    const base = new Set(tbdDates(run('2026-10-13', '2026-10-20')));
    const early = tbdDates(run('2026-10-13', '2026-10-19')).filter((d) => !base.has(d));
    const late = tbdDates(run('2026-10-14', '2026-10-20')).filter((d) => !base.has(d));
    expect(early).toEqual(['2026-10-20']);
    // 10/13 has no sunset: judged, it is unknown -- never read as legal.
    expect(late).toEqual([]);
    expect(run('2026-10-14', '2026-10-20').meta.slotDatesSunsetUnknown).toBe(1);
  });

  it('an override on a slot the plan does not hold is refused', () => {
    expect(() =>
      derivePracticeDurationPhases({
        slotSet,
        graph: rigGraph,
        calendar,
        window,
        lightingOverrides: [{ slotId: 'ghost', from: '2026-10-06', until: '2026-10-06' }],
      })
    ).toThrow(/no unlit, dated slot in this plan/);
  });

  it('G5: a slot overridden on every date is `exempt`; else the fix kind is offered', () => {
    const all = buildDstSurvivalReport({
      slotSet,
      graph: rigGraph,
      calendar,
      window,
      lightingOverrides: [{ slotId: 'lamp', from: '2026-10-01', until: '2026-10-31' }],
    });
    expect(all.rows[0].verdict).toBe(PRACTICE_SURVIVAL_VERDICT.EXEMPT);
    expect(all.meta.slotsExempt).toBe(1);
    // Enumerated and exempt is exercised: a wholly lit season is not empty.
    expect(all.exercised).toBe(true);
    const none = buildDstSurvivalReport({ slotSet, graph: rigGraph, calendar, window });
    const fix = none.rows[0].fixes.find(
      (f) => f.kind === PRACTICE_SURVIVAL_FIX_KIND.LIGHTING_OVERRIDE
    );
    expect(fix).toMatchObject({
      available: true,
      window: { from: '2026-10-06', until: '2026-10-27' },
    });
  });
});

/* -------------------------------------------------------------------------- */
/* /code-review: a shift is re-checked every night; pins survive a window      */
/* -------------------------------------------------------------------------- */

describe('a shifted slot is re-checked every night, and a lighting window keeps the operator pin', () => {
  // Plants: drop the nightly re-check (10/13 and 10/20 stop being held out);
  // drop the pin inside the window (`seasonOverrides` loses 40, and B is held
  // out on the lit night because A would run its full hour).
  const calendar = rigCalendar([
    { date: '2026-10-06', sunsetMinutes: 17 * 60 + 50 },
    { date: '2026-10-13', sunsetMinutes: 17 * 60 + 50 },
    { date: '2026-10-20', sunsetMinutes: 17 * 60 + 50 },
  ]);
  const base = {
    slotSet: rigPlan([rigSlot('A', 16 * 60, 60), rigSlot('B', 17 * 60, 60)]),
    graph: rigGraph,
    calendar,
    window: RIG_WINDOW,
    strategies: { B: PRACTICE_COMPRESSION_STRATEGY.SHIFT_EARLIER },
    earliestStartMinutes: 15 * 60,
  };
  const pin = (effectiveFrom, durationMinutes) => ({
    slotId: 'A',
    effectiveFrom,
    durationMinutes,
    reason: 'club asked',
  });

  it('B moves into the room A’s pin frees; when A is pinned back, those nights are held out', () => {
    const schedule = derivePracticeDurationPhases({
      ...base,
      overrides: [pin('2026-10-06', 40), pin('2026-10-13', 60)],
    });
    expect(derivedOf(schedule, 'B')).toEqual([
      ['2026-10-06', 16 * 60 + 50, 60, PRACTICE_RETIME_KIND.SHIFT_EARLIER],
    ]);
    expect(tbdOf(schedule, 'B')).toEqual([
      ['2026-10-13', null, PRACTICE_RETIME_REFUSAL.OVERLAP],
      ['2026-10-20', null, PRACTICE_RETIME_REFUSAL.OVERLAP],
    ]);
  });

  it('inside A’s lighting window A keeps its pin, so B stays clear', () => {
    const schedule = derivePracticeDurationPhases({
      ...base,
      overrides: [pin('2026-10-06', 40)],
      lightingOverrides: [{ slotId: 'A', from: '2026-10-13', until: '2026-10-13' }],
    });
    expect(tbdOf(schedule, 'B')).toEqual([]);
    const a = schedule.slots.find((slot) => slot.id === 'A');
    expect(Object.values(a.seasonOverrides)).toEqual([
      { durationMinutes: 40 },
      { durationMinutes: 40 },
      { durationMinutes: 40 },
    ]);
  });

  it('a strategy on a lit slot is refused: it would never be read', () => {
    expect(() =>
      derivePracticeDurationPhases({
        ...base,
        slotSet: rigPlan([
          rigSlot('A', 16 * 60, 60),
          rigSlot('L', 17 * 60, 60, { surfaceId: 'bright/f' }),
        ]),
        strategies: { L: PRACTICE_COMPRESSION_STRATEGY.SHIFT_EARLIER },
      })
    ).toThrow(/no unlit, dated slot/);
  });

  it('G5 never offers an earlier start when the floor is unknown', () => {
    const report = buildDstSurvivalReport({
      ...base,
      calendar: rigCalendar([{ date: '2026-10-13', sunsetMinutes: 18 * 60 + 25 }]),
      slotSet: rigPlan([rigSlot('early', 16 * 60, 60), rigSlot('late', 18 * 60, 60)]),
      strategies: {},
      earliestStartMinutes: undefined,
    });
    const row = report.rows.find((r) => r.slotId === 'late');
    expect(row.verdict).toBe(PRACTICE_SURVIVAL_VERDICT.DOES_NOT_SURVIVE);
    const earlier = row.fixes.find((f) => f.kind === PRACTICE_SURVIVAL_FIX_KIND.EARLIER_START);
    // Inside the plan's hours (17:45 >= 16:00), but the floor is not known.
    expect(earlier.startMinutesAtMinimumDuration).toBe(17 * 60 + 45);
    expect(earlier.available).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* W13 -- cascade proposals are change-log entries, never applied              */
/* -------------------------------------------------------------------------- */

describe('W13: the cascade proposes through the 8.8 change log and applies nothing', () => {
  // Plant: write each proposed start back onto the input slot in
  // buildPracticeCompressionReport() (`slot.startMinutes = proposed`). The
  // byte-identity check goes red.
  //
  // Four back-to-back 45-minute practices from 17:00 (step 1, minimum 30, as
  // PR 5 ran them). On 10/13 sunset is 19:00: C (18:30) is cut to 30, D
  // (19:15) cannot be saved (no floor, so no shift) -- and the cascade packs
  // D in behind C at 19:00, which still does not save it.
  const calendar = rigCalendar([
    { date: '2026-10-06', sunsetMinutes: 20 * 60 },
    { date: '2026-10-13', sunsetMinutes: 19 * 60 },
  ]);
  const window = { from: '2026-10-06', to: '2026-10-13' };
  const frozenPlan = rigPlan([
    rigSlot('a', 17 * 60, 45),
    rigSlot('b', 17 * 60 + 45, 45),
    rigSlot('c', 18 * 60 + 30, 45),
    rigSlot('d', 19 * 60 + 15, 45),
    rigSlot('lit', 19 * 60 + 15, 45, { surfaceId: 'bright/f' }),
  ]);
  // Unfrozen, so an auto-apply would succeed rather than throw -- the witness
  // is the byte comparison, not the freeze.
  const plan = structuredClone(frozenPlan);
  const before = JSON.stringify(plan);
  const schedule = derivePracticeDurationPhases({
    slotSet: plan,
    graph: rigGraph,
    calendar,
    window,
    minimumDurationMinutes: 30,
    durationStepMinutes: 1,
  });
  const scheduleBefore = JSON.stringify(schedule);
  const report = buildPracticeCompressionReport({
    slotSet: plan,
    graph: rigGraph,
    calendar,
    phaseSchedule: schedule,
  });

  it('G3 on the rig: only C is cut, to 30 from 10/13; D is held out', () => {
    expect(derivedOf(schedule, 'c')).toEqual([
      ['2026-10-13', 18 * 60 + 30, 30, PRACTICE_RETIME_KIND.SHORTEN],
    ]);
    for (const id of ['a', 'b']) expect(derivedOf(schedule, id)).toEqual([]);
    expect(tbdOf(schedule, 'd')).toEqual([
      [
        '2026-10-13',
        PRACTICE_RETIME_REFUSAL.BELOW_MINIMUM,
        PRACTICE_RETIME_REFUSAL.EARLIEST_START_UNKNOWN,
      ],
    ]);
    expect(schedule.meta.slotDatesHeldOut).toBe(1);
    expect(schedule.litSlotIds).toEqual(['lit']);
  });

  it('the input plan and the schedule are byte-identical after the report', () => {
    expect(JSON.stringify(plan)).toBe(before);
    expect(JSON.stringify(schedule)).toBe(scheduleBefore);
  });

  it('hold-starts flags D on 10/13, and says the cascade would not save it', () => {
    expect(
      report.holdStarts.flagged.map((f) => [
        f.slotId,
        f.date,
        f.endMinutes,
        f.overrunMinutes,
        f.savedByCascade,
      ])
    ).toEqual([['d', '2026-10-13', 20 * 60, 60, false]]);
    expect(report.holdStarts.flagged[0].teamIds).toEqual(['T-d']);
  });

  it('proposals exist only as change-log entries, under the declared cascade source', () => {
    expect(Object.keys(report).sort()).toEqual(
      ['cascade', 'exercised', 'findings', 'holdStarts', 'marginMinutes', 'meta', 'window'].sort()
    );
    expect(Object.keys(report.cascade)).toEqual(['changelog']);
    const { changelog } = report.cascade;
    expect(
      changelog.entries.map((e) => [
        e.date,
        e.label,
        e.before.startMinutes,
        e.after.startMinutes,
        e.sourceId,
      ])
    ).toEqual([
      ['2026-10-13', 'T-d v practice d', 19 * 60 + 15, 19 * 60, PRACTICE_SUNSET_CASCADE_SOURCE_ID],
    ]);
    expect(changelog.bySource[PRACTICE_SUNSET_CASCADE_SOURCE_ID]).toBe(1);
    expect(changelog.bySource['(undeclared)']).toBe(0);
    expect(changelog.meta.participantsUnresolved).toBe(0);
    expect(report.meta.proposalEntries).toBe(changelog.entries.length);
  });

  it('a slot under portable lighting is neither flagged nor moved by the cascade', () => {
    const lit = derivePracticeDurationPhases({
      slotSet: plan,
      graph: rigGraph,
      calendar,
      window,
      minimumDurationMinutes: 30,
      durationStepMinutes: 1,
      lightingOverrides: [{ slotId: 'd', from: '2026-10-13', until: '2026-10-13' }],
    });
    const litReport = buildPracticeCompressionReport({
      slotSet: plan,
      graph: rigGraph,
      calendar,
      phaseSchedule: lit,
    });
    expect(litReport.holdStarts.flagged).toEqual([]);
    expect(litReport.cascade.changelog.entries).toEqual([]);
    expect(litReport.meta.slotDatesExempt).toBe(1);
    expect(litReport.meta.cascadeSlotDatesShifted).toBe(0);
  });

  it('and the frozen plan is refused any write, too', () => {
    expect(() =>
      buildPracticeCompressionReport({
        slotSet: frozenPlan,
        graph: rigGraph,
        calendar,
        phaseSchedule: schedule,
      })
    ).not.toThrow();
  });
});

describe('edges /code-review raised', () => {
  const calendar = rigCalendar([
    { date: '2026-10-06', sunsetMinutes: 17 * 60 + 50 },
    { date: '2026-10-13', sunsetMinutes: 17 * 60 + 50 },
    { date: '2026-10-20', sunsetMinutes: 17 * 60 + 50 },
  ]);
  const base = { graph: rigGraph, calendar, window: RIG_WINDOW };

  it('a slot shorter than the minimum that ends by sunset at its own length survives', () => {
    const report = buildDstSurvivalReport({
      ...base,
      slotSet: rigPlan([rigSlot('short', 17 * 60, 45)]),
      minimumDurationMinutes: 60,
    });
    expect(report.rows[0].verdict).toBe(PRACTICE_SURVIVAL_VERDICT.SURVIVES);
    expect(report.rows[0].d8).toBeNull();
  });

  it('an earlier start is offered only inside the hours the plan already uses on the surface', () => {
    const report = buildDstSurvivalReport({
      ...base,
      slotSet: rigPlan([rigSlot('first', 17 * 60 + 40, 45)]),
      minimumDurationMinutes: 30,
    });
    const earlier = report.rows[0].fixes.find((f) => f.kind === 'earlier-start');
    // It would need to start by 17:20; the plan's earliest start there is 17:40.
    expect(earlier.startMinutesAtMinimumDuration).toBe(17 * 60 + 20);
    expect(earlier.available).toBe(false);
    expect(report.meta.fixesAvailableByKind['earlier-start']).toBe(0);
  });

  it('two overrides on one slot-date are refused, not resolved silently', () => {
    expect(() =>
      derivePracticeDurationPhases({
        ...base,
        slotSet: rigPlan([rigSlot('s', 17 * 60, 60)]),
        overrides: [
          { slotId: 's', effectiveFrom: '2026-10-13', durationMinutes: 50, reason: 'A' },
          { slotId: 's', effectiveFrom: '2026-10-13', durationMinutes: 45, reason: 'B' },
        ],
      })
    ).toThrow(/silently lost/);
  });

  it('an overlap freezes the rest of the night: nothing after it moves', () => {
    const plan = rigPlan([
      rigSlot('long', 16 * 60, 120),
      rigSlot('inside', 16 * 60 + 30, 30),
      rigSlot('after', 18 * 60 + 15, 30),
    ]);
    const schedule = derivePracticeDurationPhases({
      ...base,
      slotSet: plan,
      minimumDurationMinutes: 20,
    });
    const report = buildPracticeCompressionReport({
      ...base,
      slotSet: plan,
      phaseSchedule: schedule,
    });
    expect(report.cascade.changelog.entries).toHaveLength(0);
    expect(report.meta.cascadeNightsBrokenByOverlap).toBe(3);
  });

  it('a report over nothing says so: exercised is false', () => {
    const outside = { from: '2026-12-01', to: '2026-12-31' };
    const slotSet = rigPlan([rigSlot('s', 17 * 60, 45)]);
    const schedule = derivePracticeDurationPhases({ ...base, window: outside, slotSet });
    expect(schedule.exercised).toBe(false);
    expect(buildDstSurvivalReport({ ...base, window: outside, slotSet }).exercised).toBe(false);
    expect(
      buildPracticeCompressionReport({ ...base, slotSet, phaseSchedule: schedule }).exercised
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The corpus                                                                  */
/* -------------------------------------------------------------------------- */

const BASELINE_REVISION = '93 Combined';
const SEASON_FROM = '2026-08-17';
const SEASON_UNTIL = '2026-11-13';
/** `season_settings.school_day_end`'s default (16:00), on Mon-Thu. */
const FLOOR = 16 * 60;
const FLOOR_WEEKDAYS = ['MON', 'TUE', 'WED', 'THU'];
const MINIMUM = 40;
const STEP = 10;

const rawGeometry = loadFacilityGeometry();
const sunsets = loadSunsets();
const SEASON_YEAR = Number(sunsets[0].date.slice(0, 4));
const graph = buildSeason2026PracticeFacilityGraph(rawGeometry);
const fullPlan = toSeason2026PracticePlan(
  loadSeason2026Practice().practiceSlots,
  graph,
  buildSeason2026VenueComplexMap()
);
const PLAN = (() => {
  const slots = fullPlan.slots
    .filter((s) => s.revisionId === BASELINE_REVISION && s.surfaceResolution === 'resolved')
    .map((s) => ({ ...s, validFrom: SEASON_FROM, validUntil: SEASON_UNTIL }));
  const ids = new Set(slots.map((s) => s.id));
  return {
    slots,
    assignments: fullPlan.assignments.filter((a) => ids.has(a.slotId)),
    source: fullPlan.source,
  };
})();
const corpusSlotSet = buildPracticeSlotSet(PLAN);
const corpusCalendar = buildAvailabilityCalendarFromSeason2026(
  loadFacilityPermits({ seasonYear: SEASON_YEAR }),
  sunsets,
  {
    timeZone: TIME_ZONE,
    venueDaylight: Object.keys(graph.venues).map((venueId) => ({ venueId, ...SYNTHETIC_EAST })),
  }
);
const WINDOW = { from: SEASON_FROM, to: SEASON_UNTIL };
/** Defaults for the minimum and the step: the corpus runs what D14 ruled. */
const corpusInput = {
  slotSet: corpusSlotSet,
  graph,
  calendar: corpusCalendar,
  window: WINDOW,
  earliestStartMinutes: FLOOR,
};
/**
 * Built on first use, not at import, so a defect that throws fails the tests
 * that need these reports rather than the whole file before any witness runs.
 */
let corpusMemo = null;
const corpus = () => {
  if (corpusMemo) return corpusMemo;
  const schedule = derivePracticeDurationPhases(corpusInput);
  corpusMemo = {
    schedule,
    compression: buildPracticeCompressionReport({
      slotSet: corpusSlotSet,
      graph,
      calendar: corpusCalendar,
      phaseSchedule: schedule,
    }),
    survival: buildDstSurvivalReport(corpusInput),
  };
  return corpusMemo;
};

/**
 * The independent universe and sweep: plan slots x dates, lighting from the
 * raw geometry by venue name, sunset from the table row or
 * floor(sunsetOnDate()) at the synthetic point, and the D14 rules by plain
 * loops (a step at a time, never the module's ceilings). Nothing here calls
 * the module or the provider.
 */
const independent = (() => {
  const tableByDate = new Map(sunsets.map((row) => [row.date, row.sunsetMinutes]));
  const limitOn = (date) =>
    tableByDate.has(date)
      ? Math.floor(tableByDate.get(date))
      : Math.floor(sunsetOnDate({ date, ...SYNTHETIC_EAST, timeZone: TIME_ZONE }).minutes);
  /** slotId -> its dates */
  const unlit = new Map();
  for (const slot of PLAN.slots) {
    const venue = graph.venues[graph.surfaces[slot.surfaceId].venueId];
    if ((rawGeometry.venues[venue.name]?.lit ?? null) === true) continue;
    unlit.set(slot.id, slotDates(slot, SEASON_FROM, SEASON_UNTIL));
  }

  /** slotId -> [[date, start, duration]] of each retiming */
  const retimes = new Map();
  /** `slotId|date` of every held-out slot-date */
  const tbd = new Set();
  /** `surfaceId|date` -> the latest end of the slots already swept that night */
  const nightEnd = new Map();
  const ordered = PLAN.slots
    .filter((slot) => unlit.has(slot.id))
    .sort((a, b) => a.startMinutes - b.startMinutes || (a.id < b.id ? -1 : 1));
  for (const slot of ordered) {
    let start = slot.startMinutes;
    let duration = slot.durationMinutes;
    const list = [];
    for (const date of unlit.get(slot.id)) {
      const limit = limitOn(date);
      const night = `${slot.surfaceId}|${date}`;
      const before = nightEnd.has(night) ? nightEnd.get(night) : null;
      const occupy = (end) => nightEnd.set(night, Math.max(nightEnd.get(night) ?? 0, end));
      // Already moved, and an earlier slot runs into it tonight: held out.
      if (start < slot.startMinutes && before !== null && start < before) {
        tbd.add(`${slot.id}|${date}`);
        continue;
      }
      if (start + duration <= limit) {
        occupy(start + duration);
        continue;
      }
      let saved = false;
      if (start === slot.startMinutes) {
        let rung = duration;
        while (start + rung > limit && rung > 0) rung -= STEP;
        if (rung >= MINIMUM) {
          duration = rung;
          saved = true;
        }
      }
      if (!saved) {
        let moved = start;
        while (moved + duration > limit) moved -= STEP;
        const floor = FLOOR_WEEKDAYS.includes(slot.weekday) ? FLOOR : null;
        if (floor !== null && moved >= floor && (before === null || moved >= before)) {
          start = moved;
          saved = true;
        }
      }
      if (!saved) {
        // TIME TBD tonight: not on the surface, so it occupies nothing.
        tbd.add(`${slot.id}|${date}`);
        continue;
      }
      list.push([date, start, duration]);
      occupy(start + duration);
    }
    retimes.set(slot.id, list);
  }
  const notSurviving = new Set([...tbd].map((key) => key.split('|')[0]));
  return { unlit, limitOn, retimes, tbd, notSurviving };
})();

/** The G5 coverage meta-assertion, against the independent universe. */
function assertCoversEveryUnlitSlot(report, universe) {
  const got = new Map(report.rows.map((row) => [row.slotId, row.datesExamined]));
  if (universe.size === 0) throw new Error('the independent universe is empty');
  const missing = [...universe.keys()].filter((id) => !got.has(id));
  const extra = [...got.keys()].filter((id) => !universe.has(id));
  const wrongDates = [...universe].filter(
    ([id, dates]) => got.has(id) && got.get(id) !== dates.length
  );
  if (missing.length || extra.length || wrongDates.length) {
    throw new Error(
      `survival coverage: ${missing.length} missing, ${extra.length} extra, ${wrongDates.length} with the wrong date count`
    );
  }
}

describe('G5 coverage: the survival report covers every unlit slot of the INPUT plan', () => {
  // Plant: enumerate `universe.unlit.slice(0, -1)` in buildDstSurvivalReport().
  // One slot vanishes and the corpus coverage assertion goes red.
  it('covers every unlit slot, with every date', () => {
    expect(independent.unlit.size).toBeGreaterThan(0);
    expect(() => assertCoversEveryUnlitSlot(corpus().survival, independent.unlit)).not.toThrow();
    expect(corpus().survival.meta.unlitSlotsEnumerated).toBe(independent.unlit.size);
  });

  it('the meta-assertion can fail: a dropped row, an extra row, a lost date', () => {
    const rows = corpus().survival.rows;
    expect(() => assertCoversEveryUnlitSlot({ rows: rows.slice(1) }, independent.unlit)).toThrow(
      /1 missing/
    );
    expect(() =>
      assertCoversEveryUnlitSlot(
        { rows: [...rows, { slotId: 'ghost', datesExamined: 1 }] },
        independent.unlit
      )
    ).toThrow(/1 extra/);
    expect(() =>
      assertCoversEveryUnlitSlot(
        { rows: rows.map((r, i) => (i === 0 ? { ...r, datesExamined: r.datesExamined - 1 } : r)) },
        independent.unlit
      )
    ).toThrow(/1 with the wrong date count/);
    expect(() => assertCoversEveryUnlitSlot(corpus().survival, new Map())).toThrow(/empty/);
  });

  it('a plan with a slot removed is a report with a row removed -- nothing invents it', () => {
    const smaller = buildPracticeSlotSet({
      ...PLAN,
      slots: PLAN.slots.slice(1),
      assignments: PLAN.assignments.filter((a) => a.slotId !== PLAN.slots[0].id),
    });
    const report = buildDstSurvivalReport({ ...corpusInput, slotSet: smaller });
    expect(() => assertCoversEveryUnlitSlot(report, independent.unlit)).toThrow(/missing/);
  });
});

describe('G5: survival and fixes on the season-2026 corpus', () => {
  it('the non-surviving set equals the independent sweep and is non-empty', () => {
    const actual = new Set(
      corpus()
        .survival.rows.filter((r) => r.verdict === PRACTICE_SURVIVAL_VERDICT.DOES_NOT_SURVIVE)
        .map((r) => r.slotId)
    );
    expect(actual.size).toBeGreaterThan(0);
    expect([...actual].sort()).toEqual([...independent.notSurviving].sort());
    expect(corpus().survival.meta.slotsSurviving).toBe(
      independent.unlit.size - independent.notSurviving.size
    );
    expect(corpus().survival.meta.slotsSurviving).toBeGreaterThan(0);
  });

  it('every non-survivor names its D8 truncation date and all four fix kinds, with what was not checked', () => {
    for (const row of corpus().survival.rows) {
      if (row.verdict !== PRACTICE_SURVIVAL_VERDICT.DOES_NOT_SURVIVE) continue;
      expect(row.d8.tbdFrom).toBe(row.failingDates[0]);
      expect(row.fixes.map((f) => f.kind)).toEqual(Object.values(PRACTICE_SURVIVAL_FIX_KIND));
      for (const fix of row.fixes) expect(fix.unchecked.length).toBeGreaterThan(0);
      const earlier = row.fixes.find((f) => f.kind === PRACTICE_SURVIVAL_FIX_KIND.EARLIER_START);
      if (earlier.available) {
        const tightest = Math.min(...independent.unlit.get(row.slotId).map(independent.limitOn));
        expect(earlier.startMinutesAtMinimumDuration).toBe(tightest - MINIMUM);
        expect(earlier.startMinutesAtMinimumDuration).toBeGreaterThanOrEqual(FLOOR);
      }
    }
  });
});

describe('G3/G4 on the season-2026 corpus', () => {
  it('every slot’s retimings equal the independent sweep, and some of each kind happen', () => {
    const got = new Map(
      corpus().schedule.slotPhases.map((timeline) => [
        timeline.slotId,
        timeline.phases
          .filter((p) => p.source === PRACTICE_PHASE_SOURCE.DERIVED)
          .map((p) => [p.effectiveFrom, p.startMinutes, p.durationMinutes]),
      ])
    );
    expect([...got.keys()].sort()).toEqual([...independent.retimes.keys()].sort());
    for (const [slotId, expected] of independent.retimes) expect(got.get(slotId)).toEqual(expected);
    const { meta } = corpus().schedule;
    expect(meta.shortenings).toBeGreaterThan(0);
    expect(meta.fallbackShifts).toBeGreaterThan(0);
    for (const code of Object.values(PRACTICE_RETIME_REFUSAL)) {
      expect(meta.retimeRefusals[code]).toBeGreaterThan(0);
    }
  });

  it('W18: phases only shorten by 10k from the slot’s own length, never below 40, and never walk back', () => {
    // Plant: reset the duration to the slot's own at each date. A slot then
    // re-derives the same rung each week, and consecutive phases stop being
    // strict retimings: red.
    let checked = 0;
    for (const timeline of corpus().schedule.slotPhases) {
      const d0 = timeline.plannedDurationMinutes;
      timeline.phases.forEach((phase, index) => {
        if (index === 0) return;
        checked += 1;
        const previous = timeline.phases[index - 1];
        expect((d0 - phase.durationMinutes) % STEP).toBe(0);
        if (phase.durationMinutes < d0) expect(phase.durationMinutes).toBeGreaterThanOrEqual(40);
        expect(phase.durationMinutes).toBeLessThanOrEqual(previous.durationMinutes);
        expect(phase.startMinutes).toBeLessThanOrEqual(previous.startMinutes);
        expect(
          phase.durationMinutes < previous.durationMinutes ||
            phase.startMinutes < previous.startMinutes
        ).toBe(true);
        if (phase.startMinutes < previous.startMinutes) {
          expect(phase.durationMinutes).toBe(previous.durationMinutes);
        }
      });
    }
    expect(checked).toBeGreaterThan(0);
    expect(corpus().schedule.meta.phaseTransitionsDerived).toBe(
      [...independent.retimes.values()].reduce((sum, list) => sum + list.length, 0)
    );
  });

  it('W12 holds on every derived phase: the previous timing fails that date', () => {
    let derived = 0;
    for (const timeline of corpus().schedule.slotPhases) {
      for (const phase of timeline.phases) {
        if (phase.source !== PRACTICE_PHASE_SOURCE.DERIVED) continue;
        derived += 1;
        const { bound } = phase;
        expect(bound.previousEndMinutes).toBeGreaterThan(bound.limitMinutes);
        expect(independent.limitOn(bound.date)).toBe(bound.limitMinutes);
        expect(phase.startMinutes + phase.durationMinutes).toBeLessThanOrEqual(bound.limitMinutes);
      }
    }
    expect(derived).toBeGreaterThan(0);
  });

  it('hold-starts = the independent sweep of the expanded schedule = the TIME TBD set, non-empty', () => {
    const expanded = expandPracticeSlotsForSeason({
      slots: corpus().schedule.slots,
      seasonPhases: corpus().schedule.seasonPhases,
    });
    const expected = new Set();
    const planById = new Map(PLAN.slots.map((s) => [s.id, s]));
    for (const record of expanded) {
      const slot = planById.get(record.baseSlotId);
      if (!independent.unlit.has(slot.id)) continue;
      const start = minutesOfDate(record.start);
      const minutes = (record.end - record.start) / 60000;
      for (const date of slotDates(
        { ...slot, validFrom: record.effectiveFrom, validUntil: record.effectiveUntil },
        SEASON_FROM,
        SEASON_UNTIL
      )) {
        if (start + minutes > independent.limitOn(date)) expected.add(`${slot.id}|${date}`);
      }
    }
    const actual = new Set(
      corpus().compression.holdStarts.flagged.map((f) => `${f.slotId}|${f.date}`)
    );
    expect(actual.size).toBeGreaterThan(0);
    expect([...actual].sort()).toEqual([...expected].sort());
    expect([...actual].sort()).toEqual([...independent.tbd].sort());
    expect(corpus().schedule.meta.slotDatesHeldOut).toBe(independent.tbd.size);
    expect(corpus().survival.meta.slotsUnknown).toBe(0);
  });

  it('cascade entries are all declared, resolved and dated inside the window', () => {
    const { changelog } = corpus().compression.cascade;
    expect(changelog.entries.length).toBe(corpus().compression.meta.proposalEntries);
    expect(changelog.entries.length).toBeGreaterThan(0);
    expect(changelog.bySource['(undeclared)']).toBe(0);
    expect(changelog.bySource['(ambiguous)']).toBe(0);
    for (const entry of changelog.entries) {
      expect(entry.after.startMinutes).toBeLessThan(entry.before.startMinutes);
      expect(entry.date >= SEASON_FROM && entry.date <= SEASON_UNTIL).toBe(true);
    }
  });

  it('D11 is stated in the registry claim: declared, not optimised', () => {
    const claim = getConstraint(
      buildSeason2026PracticeConstraintRegistry(),
      PRACTICE_DAYLIGHT_CONSTRAINT_ID
    );
    expect(claim.source.note).toMatch(/declared, not optimised \(D11\)/);
    expect(claim.source.note).toMatch(/never applied/);
  });
});

/* -------------------------------------------------------------------------- */
/* W28 -- the exempt count, independently                                      */
/* -------------------------------------------------------------------------- */

describe('W28: the exempt count equals an independent derivation, is non-zero, and is its own counter', () => {
  // Plant: fold the exemption into the lit counter in evaluatePracticeDaylight()
  // (`litPracticeOccurrencesExempt += 1` for an overridden occurrence). The lit
  // counter then moves and the separation assertion goes red.
  const OVERRIDES = PLAN.slots
    .filter((slot) => independent.unlit.has(slot.id))
    .slice(0, 5)
    .map((slot, index) => ({
      slotId: slot.id,
      from: ['2026-09-01', '2026-10-01', '2026-10-20', '2026-11-01', '2026-08-01'][index],
      until: ['2026-09-30', '2026-10-31', '2026-10-20', '2026-12-31', '2026-08-20'][index],
    }));
  /** override dates x the slot's weekday, clamped to the slot and the window */
  const expectedExempt = OVERRIDES.reduce((sum, override) => {
    const slot = PLAN.slots.find((s) => s.id === override.slotId);
    const from = override.from > SEASON_FROM ? override.from : SEASON_FROM;
    const until = override.until < SEASON_UNTIL ? override.until : SEASON_UNTIL;
    return sum + slotDates(slot, from, until).length;
  }, 0);

  it('G3 counts exactly the independent exempt slot-dates', () => {
    expect(expectedExempt).toBeGreaterThan(0);
    const schedule = derivePracticeDurationPhases({ ...corpusInput, lightingOverrides: OVERRIDES });
    expect(schedule.meta.slotDatesExempt).toBe(expectedExempt);
    expect(schedule.meta.unlitSlotDatesExamined + schedule.meta.slotDatesExempt).toBe(
      [...independent.unlit.values()].reduce((sum, dates) => sum + dates.length, 0)
    );
    expect(schedule.meta.litSlotsExempt).toBe(corpus().schedule.meta.litSlotsExempt);
  });

  it('the evaluator counts it apart from lit ground, and unlit = examined + exempt', () => {
    const { occurrences } = materialisePracticeOccurrences(corpusSlotSet, WINDOW);
    const plain = evaluatePracticeDaylight({ occurrences, graph, calendar: corpusCalendar });
    const lamps = evaluatePracticeDaylight({
      occurrences,
      graph,
      calendar: corpusCalendar,
      lightingOverrides: OVERRIDES,
    });
    expect(lamps.meta.lightingOverrideOccurrencesExempt).toBe(expectedExempt);
    expect(lamps.exempt).toHaveLength(expectedExempt);
    expect(lamps.meta.litPracticeOccurrencesExempt).toBe(plain.meta.litPracticeOccurrencesExempt);
    expect(
      lamps.meta.unlitPracticeOccurrencesExamined + lamps.meta.lightingOverrideOccurrencesExempt
    ).toBe(plain.meta.unlitPracticeOccurrencesExamined);
    expect(plain.meta.lightingOverrideOccurrencesExempt).toBe(0);
    expect(lamps.meta.lightingOverridesUnused).toBe(
      OVERRIDES.filter((override) => {
        const slot = PLAN.slots.find((s) => s.id === override.slotId);
        const from = override.from > SEASON_FROM ? override.from : SEASON_FROM;
        const until = override.until < SEASON_UNTIL ? override.until : SEASON_UNTIL;
        return slotDates(slot, from, until).length === 0;
      }).length
    );
    // An override the input does not hold is counted, never silently unread.
    const stray = evaluatePracticeDaylight({
      occurrences,
      graph,
      calendar: corpusCalendar,
      lightingOverrides: [
        { slotId: 'no-such-slot', from: SEASON_FROM, until: SEASON_UNTIL },
        { ...OVERRIDES[0], from: '2027-01-01', until: '2027-01-31' },
      ],
    });
    expect(stray.meta.lightingOverridesUnused).toBe(2);
    expect(stray.meta.lightingOverrideOccurrencesExempt).toBe(0);
  });
});
