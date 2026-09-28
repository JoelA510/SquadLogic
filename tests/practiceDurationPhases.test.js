/**
 * 8.9 PR 5: DurationPhase derivation (G3), the compression report (G4) and
 * the DST survival report (G5), `practice/durationPhases.js`.
 *
 * Witnesses, numbered as in `docs/PHASE_8_9_PLAN.md` section 4. Each was shown
 * red by its plant (listed on the describe block) before it counted; the plants
 * are source edits recorded in the PR, not left in the tree.
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
  PRACTICE_DAYLIGHT_CONSTRAINT_ID,
  PRACTICE_PHASE_SOURCE,
  PRACTICE_SUNSET_CASCADE_SOURCE_ID,
  PRACTICE_SURVIVAL_FIX_KIND,
  PRACTICE_SURVIVAL_VERDICT,
  buildDstSurvivalReport,
  buildPracticeCompressionReport,
  buildPracticeSlotSet,
  derivePracticeDurationPhases,
  endsByDaylightLimit,
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
    minimumDurationMinutes: 30,
  });
  const [venue] = schedule.venues;

  it('the comparison: equality is legal, one minute over is not', () => {
    expect(endsByDaylightLimit(19 * 60, 19 * 60)).toBe(true);
    expect(endsByDaylightLimit(19 * 60 + 1, 19 * 60)).toBe(false);
  });

  it('the transition is 10/20, not the 10/13 equality date', () => {
    expect(venue.venueId).toBe('dark');
    expect(venue.phases.map((p) => [p.effectiveFrom, p.durationMinutes, p.source])).toEqual([
      ['2026-10-06', 60, PRACTICE_PHASE_SOURCE.BASE],
      ['2026-10-20', 59, PRACTICE_PHASE_SOURCE.DERIVED],
    ]);
  });

  it('the derivation is shown: the date, the sunset and the slot that bound it', () => {
    expect(venue.phases[1].bound).toEqual({
      date: '2026-10-20',
      slotId: 'late',
      surfaceId: 'dark/f',
      startMinutes: 18 * 60,
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
      ['duration-phase-02', 59, '2026-10-20'],
    ]);
  });

  it('an override pins a duration; one that would pass sunset is superseded, not honoured', () => {
    const pinned = derivePracticeDurationPhases({
      slotSet: plan,
      graph: rigGraph,
      calendar,
      window: RIG_WINDOW,
      minimumDurationMinutes: 30,
      overrides: [
        { venueId: 'dark', effectiveFrom: '2026-10-13', durationMinutes: 50, reason: 'club asked' },
      ],
    });
    expect(
      pinned.venues[0].phases.map((p) => [p.effectiveFrom, p.durationMinutes, p.source])
    ).toEqual([
      ['2026-10-06', 60, 'base'],
      ['2026-10-13', 50, 'override'],
    ]);
    const tooLong = derivePracticeDurationPhases({
      slotSet: plan,
      graph: rigGraph,
      calendar,
      window: RIG_WINDOW,
      minimumDurationMinutes: 30,
      overrides: [
        { venueId: 'dark', effectiveFrom: '2026-10-20', durationMinutes: 60, reason: 'club asked' },
      ],
    });
    const last = tooLong.venues[0].phases.at(-1);
    expect(last).toMatchObject({
      effectiveFrom: '2026-10-20',
      durationMinutes: 59,
      source: 'derived',
    });
    expect(last.supersedes).toEqual({
      source: 'override',
      durationMinutes: 60,
      reason: 'club asked',
    });
    expect(tooLong.meta.overridesSuperseded).toBe(1);
    expect(() =>
      derivePracticeDurationPhases({
        slotSet: plan,
        graph: rigGraph,
        calendar,
        window: RIG_WINDOW,
        minimumDurationMinutes: 30,
        overrides: [
          { venueId: 'nowhere', effectiveFrom: '2026-10-13', durationMinutes: 50, reason: 'x' },
        ],
      })
    ).toThrow(/names no venue/);
  });

  it('the minimum duration is required, never defaulted', () => {
    expect(() =>
      // @ts-expect-error -- the omission is the point: the schema must refuse it
      derivePracticeDurationPhases({ slotSet: plan, graph: rigGraph, calendar, window: RIG_WINDOW })
    ).toThrow(/minimumDurationMinutes/);
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
  // Four back-to-back 45-minute practices from 17:00. On 10/13 sunset is
  // 19:00: C (18:30) binds the phase at 30 min, D (19:15) cannot be saved with
  // its start held -- but the cascade, packing the night from 17:00, ends D
  // at exactly 19:00.
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
  });
  const scheduleBefore = JSON.stringify(schedule);
  const report = buildPracticeCompressionReport({
    slotSet: plan,
    graph: rigGraph,
    calendar,
    phaseSchedule: schedule,
  });

  it('G3 on the rig: C binds a 30-minute phase from 10/13; D is held out', () => {
    expect(schedule.venues[0].phases.map((p) => [p.effectiveFrom, p.durationMinutes])).toEqual([
      ['2026-10-06', 45],
      ['2026-10-13', 30],
    ]);
    expect(schedule.venues[0].phases[1].bound.slotId).toBe('c');
    expect(schedule.meta.slotDatesHeldOut).toBe(1);
    expect(schedule.litSlotIds).toEqual(['lit']);
  });

  it('the input plan and the schedule are byte-identical after the report', () => {
    expect(JSON.stringify(plan)).toBe(before);
    expect(JSON.stringify(schedule)).toBe(scheduleBefore);
  });

  it('hold-starts flags D on 10/13, and says the cascade would save it', () => {
    expect(
      report.holdStarts.flagged.map((f) => [
        f.slotId,
        f.date,
        f.endMinutes,
        f.overrunMinutes,
        f.savedByCascade,
      ])
    ).toEqual([['d', '2026-10-13', 19 * 60 + 45, 45, true]]);
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
      [
        '2026-10-13',
        'T-b v practice b',
        17 * 60 + 45,
        17 * 60 + 30,
        PRACTICE_SUNSET_CASCADE_SOURCE_ID,
      ],
      ['2026-10-13', 'T-c v practice c', 18 * 60 + 30, 18 * 60, PRACTICE_SUNSET_CASCADE_SOURCE_ID],
      [
        '2026-10-13',
        'T-d v practice d',
        19 * 60 + 15,
        18 * 60 + 30,
        PRACTICE_SUNSET_CASCADE_SOURCE_ID,
      ],
    ]);
    expect(changelog.bySource[PRACTICE_SUNSET_CASCADE_SOURCE_ID]).toBe(3);
    expect(changelog.bySource['(undeclared)']).toBe(0);
    expect(changelog.meta.participantsUnresolved).toBe(0);
    expect(changelog.entries.every((e) => e.participants.some((p) => p.teamId !== null))).toBe(
      true
    );
    expect(report.meta.proposalEntries).toBe(changelog.entries.length);
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

/* -------------------------------------------------------------------------- */
/* The corpus                                                                  */
/* -------------------------------------------------------------------------- */

const BASELINE_REVISION = '93 Combined';
const SEASON_FROM = '2026-08-17';
const SEASON_UNTIL = '2026-11-13';
/**
 * ASSUMPTION for this sweep, not a policy: the plan sets no minimum practice
 * length, so the module requires the caller to state one. 30 minutes here.
 */
const MINIMUM = 30;

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
const corpusInput = {
  slotSet: corpusSlotSet,
  graph,
  calendar: corpusCalendar,
  window: WINDOW,
  minimumDurationMinutes: MINIMUM,
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
 * The independent universe: plan slots x dates, lighting from the raw
 * geometry by venue name, sunset from the table row or floor(sunsetOnDate())
 * at the synthetic point. Nothing here calls the module or the provider.
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
  const notSurviving = new Set();
  for (const slot of PLAN.slots) {
    const dates = unlit.get(slot.id);
    if (!dates) continue;
    // Fails a date when it ends past the limit at its own length AND the room
    // left before the limit is under the minimum.
    const fails = (date) =>
      slot.startMinutes + slot.durationMinutes > limitOn(date) &&
      limitOn(date) - slot.startMinutes < MINIMUM;
    if (dates.some(fails)) notSurviving.add(slot.id);
  }
  return { unlit, notSurviving, limitOn };
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

  it('two overrides on one venue-date are refused, not resolved silently', () => {
    expect(() =>
      derivePracticeDurationPhases({
        ...base,
        slotSet: rigPlan([rigSlot('s', 17 * 60, 45)]),
        minimumDurationMinutes: 30,
        overrides: [
          { venueId: 'dark', effectiveFrom: '2026-10-13', durationMinutes: 40, reason: 'A' },
          { venueId: 'dark', effectiveFrom: '2026-10-13', durationMinutes: 35, reason: 'B' },
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
    const schedule = derivePracticeDurationPhases({
      ...base,
      window: outside,
      slotSet,
      minimumDurationMinutes: 30,
    });
    expect(schedule.exercised).toBe(false);
    expect(
      buildDstSurvivalReport({ ...base, window: outside, slotSet, minimumDurationMinutes: 30 })
        .exercised
    ).toBe(false);
    expect(
      buildPracticeCompressionReport({ ...base, slotSet, phaseSchedule: schedule }).exercised
    ).toBe(false);
  });
});

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
  it('the non-surviving set equals the independent derivation and is non-empty', () => {
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

  it('every non-survivor names its D8 truncation date and all three fix kinds, with what was not checked', () => {
    for (const row of corpus().survival.rows) {
      if (row.verdict !== PRACTICE_SURVIVAL_VERDICT.DOES_NOT_SURVIVE) continue;
      expect(row.d8.tbdFrom).toBe(row.failingDates[0]);
      expect(row.fixes.map((f) => f.kind)).toEqual(Object.values(PRACTICE_SURVIVAL_FIX_KIND));
      for (const fix of row.fixes) expect(fix.unchecked.length).toBeGreaterThan(0);
      const earlier = row.fixes.find((f) => f.kind === PRACTICE_SURVIVAL_FIX_KIND.EARLIER_START);
      if (earlier.available) {
        const tightest = Math.min(...independent.unlit.get(row.slotId).map(independent.limitOn));
        expect(earlier.startMinutesAtMinimumDuration).toBe(tightest - MINIMUM);
      }
    }
  });
});

describe('G3/G4 on the season-2026 corpus', () => {
  it('W12 holds on every derived phase: previous duration fails that date, and held on every date before', () => {
    let derivedPhases = 0;
    for (const venue of corpus().schedule.venues) {
      const slots = PLAN.slots.filter((s) => venue.slotIds.includes(s.id));
      venue.phases.forEach((phase, index) => {
        if (phase.source !== PRACTICE_PHASE_SOURCE.DERIVED) return;
        derivedPhases += 1;
        const previousCap = venue.phases[index - 1].durationMinutes;
        const { bound } = phase;
        expect(bound.previousEndMinutes).toBeGreaterThan(bound.limitMinutes);
        expect(independent.limitOn(bound.date)).toBe(bound.limitMinutes);
        // On every date from the previous phase up to this one, each savable
        // slot was legal at the previous cap.
        for (const slot of slots) {
          for (const date of independent.unlit.get(slot.id)) {
            if (date < venue.phases[index - 1].effectiveFrom || date >= phase.effectiveFrom)
              continue;
            const limit = independent.limitOn(date);
            if (limit - slot.startMinutes < MINIMUM) continue;
            expect(
              slot.startMinutes + Math.min(slot.durationMinutes, previousCap)
            ).toBeLessThanOrEqual(limit);
          }
        }
      });
    }
    expect(derivedPhases).toBeGreaterThan(0);
  });

  it('hold-starts = the independent sweep of the expanded schedule, and non-empty', () => {
    const expanded = expandPracticeSlotsForSeason({
      slots: corpus().schedule.slots,
      seasonPhases: corpus().schedule.seasonPhases,
    });
    const expected = new Set();
    const planById = new Map(PLAN.slots.map((s) => [s.id, s]));
    for (const record of expanded) {
      const slot = planById.get(record.baseSlotId);
      if (!independent.unlit.has(slot.id)) continue;
      const minutes = (record.end - record.start) / 60000;
      for (const date of slotDates(
        { ...slot, validFrom: record.effectiveFrom, validUntil: record.effectiveUntil },
        SEASON_FROM,
        SEASON_UNTIL
      )) {
        if (slot.startMinutes + minutes > independent.limitOn(date))
          expected.add(`${slot.id}|${date}`);
      }
    }
    const actual = new Set(
      corpus().compression.holdStarts.flagged.map((f) => `${f.slotId}|${f.date}`)
    );
    expect(actual.size).toBeGreaterThan(0);
    expect([...actual].sort()).toEqual([...expected].sort());
  });

  it('cascade entries are all declared, resolved and dated inside the window', () => {
    const { changelog } = corpus().compression.cascade;
    expect(changelog.entries.length).toBe(corpus().compression.meta.proposalEntries);
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

  it('hold-starts flags exactly the slot-dates no phase can save (independently: room below the minimum)', () => {
    const planById = new Map(PLAN.slots.map((s) => [s.id, s]));
    const unsavable = new Set();
    for (const [slotId, dates] of independent.unlit) {
      const slot = planById.get(slotId);
      for (const date of dates) {
        if (independent.limitOn(date) - slot.startMinutes < MINIMUM)
          unsavable.add(`${slotId}|${date}`);
      }
    }
    const flagged = new Set(
      corpus().compression.holdStarts.flagged.map((f) => `${f.slotId}|${f.date}`)
    );
    expect(unsavable.size).toBeGreaterThan(0);
    expect([...flagged].sort()).toEqual([...unsavable].sort());
    expect(corpus().schedule.meta.slotDatesHeldOut).toBe(unsavable.size);
    expect(corpus().compression.meta.holdStartSlotDatesSavedByCascade).toBeGreaterThan(0);
    expect(corpus().survival.meta.slotsUnknown).toBe(0);
    expect(corpus().schedule.venues.every((v) => v.phases.length > 1)).toBe(true);
  });
});
