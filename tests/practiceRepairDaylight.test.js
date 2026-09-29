/**
 * 8.9 PR 7: the daylight gate in `practice/repair.js`.
 *
 * Witness W10 of `docs/PHASE_8_9_PLAN.md` section 4: the repair refuses a
 * past-sunset re-home, and "none dropped" stays green. Each guarantee below was
 * shown red by its plant (named on its describe block) before it counted; the
 * plants are source edits, recorded in the PR and not left in the tree.
 *
 * **No real coordinates.** Every coordinate is synthetic -- round numbers, not
 * places: 40.00/-75.00 and 41.50/-73.50. Nothing is fitted, geocoded or
 * fetched here.
 *
 * **Universes come from inputs.** Displaced series are enumerated from the
 * plan and the graph; daylight legality is derived from the solar function,
 * the sunset table and the graph's lighting by plain date arithmetic -- never
 * from the repair's result, the provider or the evaluator.
 */

import { describe, expect, it } from 'vitest';

import {
  buildAvailabilityCalendar,
  buildAvailabilityCalendarFromSeason2026,
} from '@squadlogic/core/availability/index.js';
import { SEASON_2026_PRACTICE_DAYLIGHT_CONSTRAINT } from '@squadlogic/core/constraints/index.js';
import {
  buildFacilityGraph,
  buildSeason2026PracticeFacilityGraph,
  buildSeason2026VenueComplexMap,
  conflictingSurfacesOf,
} from '@squadlogic/core/facility/index.js';
import {
  loadFacilityGeometry,
  loadFacilityPermits,
  loadSeason2026Practice,
  loadSunsets,
} from '@squadlogic/core/fixtures/index.js';
import {
  PRACTICE_REASON,
  PRACTICE_TBD_REASON,
  createRecommendationState,
  declineRecommendation,
  repairPracticeLoss,
  toSeason2026PracticePlan,
} from '@squadlogic/core/practice/index.js';
import { sunsetOnDate } from '@squadlogic/core/timing/index.js';

/* -------------------------------------------------------------------------- */
/* Assumptions, stated once                                                    */
/* -------------------------------------------------------------------------- */

const TIME_ZONE = 'America/New_York';
/** SYNTHETIC coordinates, not a place. */
const SYNTHETIC_EAST = Object.freeze({ latitude: 40.0, longitude: -75.0 });
/** SYNTHETIC: a second point, for the corpus rig. */
const SYNTHETIC_NORTH = Object.freeze({ latitude: 41.5, longitude: -73.5 });

const MS_PER_DAY = 86_400_000;
const WEEKDAYS = ['THU', 'FRI', 'SAT', 'SUN', 'MON', 'TUE', 'WED']; // day 0 = 1970-01-01, a Thursday
const dayNumber = (iso) =>
  Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / MS_PER_DAY;
const isoOf = (day) => new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
const weekdayOf = (iso) => WEEKDAYS[((dayNumber(iso) % 7) + 7) % 7];
/** Every date in `[from, until]` falling on `weekday`, by plain arithmetic. */
const datesOn = (weekday, from, until) => {
  const out = [];
  for (let day = dayNumber(from); day <= dayNumber(until); day += 1) {
    if (weekdayOf(isoOf(day)) === weekday) out.push(isoOf(day));
  }
  return out;
};

/* -------------------------------------------------------------------------- */
/* The synthetic rig                                                           */
/* -------------------------------------------------------------------------- */

/**
 * `dusk` is unlit with coordinates; `quiet` declares nothing (unlit, D5) and
 * has coordinates; `bright` is lit; `dark` is unlit with no coordinates.
 */
const VENUES = Object.freeze({
  dusk: { lit: false, coordinates: SYNTHETIC_EAST },
  quiet: { lit: null, coordinates: SYNTHETIC_EAST },
  bright: { lit: true, coordinates: SYNTHETIC_EAST },
  dark: { lit: false, coordinates: null },
});
const rigGraph = buildFacilityGraph({
  venues: Object.entries(VENUES).map(([id, venue]) => ({ id, name: id, lit: venue.lit })),
  surfaces: Object.keys(VENUES).flatMap((venueId) =>
    ['f1', 'f2'].map((field) => ({
      id: `${venueId}/${field}`,
      venueId,
      name: field,
      sizes: ['7v7'],
      lined: ['7v7'],
    }))
  ),
});
const rigVenueDaylight = Object.entries(VENUES)
  .filter(([, venue]) => venue.coordinates !== null)
  .map(([venueId, venue]) => ({ venueId, ...venue.coordinates }));
const rigCalendar = (sunsets = []) =>
  buildAvailabilityCalendar({
    permitWindows: [],
    timeZone: TIME_ZONE,
    venueDaylight: rigVenueDaylight,
    sunsets,
  });

const SERIES_FROM = '2026-09-01';
const SERIES_UNTIL = '2026-11-24';
const LOSS_FROM = '2026-10-05';

/**
 * One TUE series per entry on `<venue>/f1`, dated over the autumn; the loss
 * takes `<venue>/f1` for every venue named; inventory is explicit shapes.
 *
 * @param {{ series: any[], inventory: any[], loss?: Object, calendar?: Object, extra?: Object }} rig
 */
function rigInput({ series, inventory, loss = {}, calendar, extra = {} }) {
  return {
    plan: {
      slots: series.map((entry, index) => ({
        id: `s${index}`,
        surfaceId: entry.surfaceId,
        weekday: entry.weekday ?? 'TUE',
        startMinutes: entry.startMinutes,
        durationMinutes: 60,
        validFrom: SERIES_FROM,
        validUntil: SERIES_UNTIL,
        capacity: 1,
        revisionId: 'r1',
        label: null,
        surfaceResolution: 'resolved',
      })),
      assignments: series.map((entry, index) => ({
        id: `a${index}`,
        slotId: `s${index}`,
        teamId: entry.teamId,
      })),
    },
    graph: rigGraph,
    loss: {
      surfaceIds: [...new Set(series.map((entry) => entry.surfaceId))],
      from: LOSS_FROM,
      reason: 'field retired',
      ...loss,
    },
    inventory: inventory.map((shape) => ({ weekday: 'TUE', durationMinutes: 60, ...shape })),
    ...(calendar === undefined ? {} : { calendar }),
    ...extra,
  };
}

/** Independent: floor of the computed sunset at a venue's synthetic point. */
function limitAt(venueId, date) {
  const coordinates = VENUES[venueId].coordinates;
  if (coordinates === null) return null;
  const { minutes } = sunsetOnDate({ date, ...coordinates, timeZone: TIME_ZONE });
  return minutes === null ? null : Math.floor(minutes);
}

/**
 * Independent: does a shape run past sunset (or into an unknown one) on
 * unlit or undeclared rig ground on any of its dates in the window?
 */
function rigIllegal(shape, from, until) {
  const venueId = shape.surfaceId.split('/')[0];
  if (VENUES[venueId].lit === true) return false;
  return datesOn(shape.weekday, from, until).some((date) => {
    const limit = limitAt(venueId, date);
    return limit === null || shape.startMinutes + shape.durationMinutes > limit;
  });
}

/**
 * "None dropped", enumerated from the INPUT: every assignment on lost ground
 * whose window holds an occurrence is re-homed or TIME TBD with a reason,
 * exactly once, and has exactly one recommendation.
 */
function expectNoneDropped(result, displacedIds) {
  expect(displacedIds.length).toBeGreaterThan(0);
  const placed = result.rehomed.map((entry) => entry.assignmentId);
  const tbd = result.timeTbd.map((entry) => entry.assignmentId);
  expect([...placed, ...tbd].sort()).toEqual([...displacedIds].sort());
  for (const entry of result.timeTbd) {
    expect(Object.values(PRACTICE_TBD_REASON)).toContain(entry.reason);
  }
  expect(result.recommendations.map((entry) => entry.assignmentId).sort()).toEqual(
    [...displacedIds].sort()
  );
}

/* -------------------------------------------------------------------------- */
/* Sanity on the rig: the dates the gate must see are the dates that matter    */
/* -------------------------------------------------------------------------- */

describe('the rig', () => {
  it('has a 17:00 end legal in early October and illegal after DST, and a 16:00 end always legal', () => {
    expect(limitAt('dusk', '2026-10-06')).toBeGreaterThan(17 * 60);
    expect(limitAt('dusk', '2026-11-03')).toBeLessThan(17 * 60);
    for (const date of datesOn('TUE', LOSS_FROM, SERIES_UNTIL)) {
      expect(limitAt('dusk', date)).toBeGreaterThanOrEqual(16 * 60);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* W10 -- a past-sunset re-home is refused; none dropped                       */
/* -------------------------------------------------------------------------- */

describe('W10: the repair refuses a past-sunset re-home, and none is dropped', () => {
  // Plant: remove the gate (the `judgeDaylight()` call in the candidate loop)
  // -- every test in this block goes red.
  const series = [{ teamId: 'T1', surfaceId: 'dusk/f1', startMinutes: 16 * 60 }];
  // Same published time (cheapest, but ends 17:00: past sunset after DST) and
  // an hour earlier (a time change, legal on every date).
  const inventory = [
    { surfaceId: 'dusk/f2', startMinutes: 16 * 60 },
    { surfaceId: 'dusk/f2', startMinutes: 15 * 60 },
  ];
  const ungated = repairPracticeLoss(rigInput({ series, inventory }));
  const gated = repairPracticeLoss(rigInput({ series, inventory, calendar: rigCalendar() }));

  it('without the gate the cheapest candidate is the illegal one (the case is not vacuous)', () => {
    expect(ungated.rehomed).toHaveLength(1);
    expect(rigIllegal(ungated.rehomed[0].to, LOSS_FROM, SERIES_UNTIL)).toBe(true);
    expect(ungated.daylight.checked).toBe(false);
    expect(ungated.findings.map((f) => f.code)).toContain(
      PRACTICE_REASON.REPAIR_DAYLIGHT_UNCHECKED
    );
  });

  it('with the gate the series lands on the legal candidate and the refusal is named', () => {
    expect(gated.rehomed).toHaveLength(1);
    expect(gated.rehomed[0].to).toMatchObject({ surfaceId: 'dusk/f2', startMinutes: 15 * 60 });
    expect(rigIllegal(gated.rehomed[0].to, LOSS_FROM, SERIES_UNTIL)).toBe(false);
    expect(gated.daylight).toMatchObject({
      checked: true,
      marginMinutes: 0,
      candidatesJudged: 2,
      candidatesRefusedPastSunset: 1,
      candidatesWithinDaylight: 1,
      candidatesRefusedSunsetUnknown: 0,
    });
    // The first illegal date is the first Tuesday after DST ends (2026-11-01).
    expect(gated.daylight.refused).toEqual([
      expect.objectContaining({
        assignmentId: 'a0',
        tier: 'same-venue',
        reason: PRACTICE_TBD_REASON.PAST_SUNSET,
        date: '2026-11-03',
        endMinutes: 17 * 60,
        limitMinutes: limitAt('dusk', '2026-11-03'),
        sunsetSource: 'computed',
      }),
    ]);
    const codes = gated.findings.map((f) => f.code);
    expect(codes).toContain(PRACTICE_REASON.REPAIR_CANDIDATES_PAST_SUNSET);
    expect(codes).not.toContain(PRACTICE_REASON.REPAIR_DAYLIGHT_UNCHECKED);
    expectNoneDropped(gated, ['a0']);
  });

  it('with no legal candidate the series is TIME TBD past-sunset, never dropped', () => {
    const run = repairPracticeLoss(
      rigInput({
        series: [
          { teamId: 'T1', surfaceId: 'dusk/f1', startMinutes: 16 * 60 },
          { teamId: 'T2', surfaceId: 'quiet/f1', startMinutes: 17 * 60 },
        ],
        inventory: [
          { surfaceId: 'dusk/f2', startMinutes: 16 * 60 },
          { surfaceId: 'quiet/f2', startMinutes: 17 * 60 },
        ],
        calendar: rigCalendar(),
      })
    );
    expectNoneDropped(run, ['a0', 'a1']);
    expect(run.rehomed).toEqual([]);
    expect(run.timeTbd.map((entry) => [entry.assignmentId, entry.reason])).toEqual([
      ['a0', PRACTICE_TBD_REASON.PAST_SUNSET],
      ['a1', PRACTICE_TBD_REASON.PAST_SUNSET],
    ]);
    expect(run.timeTbd[1].daylightRefused).toEqual({ pastSunset: 1, sunsetUnknown: 0 });
    expect(run.recommendations.every((entry) => entry.to === null)).toBe(true);
  });

  it('gates tier 2 too: the cross-venue recommendation is the lit one, not the dark one', () => {
    const input = (calendar) =>
      rigInput({
        series: [{ teamId: 'T1', surfaceId: 'dusk/f1', startMinutes: 16 * 60 }],
        // No same-venue inventory. Same time on undeclared ground (illegal
        // after DST), or an hour later on lit ground.
        inventory: [
          { surfaceId: 'quiet/f2', startMinutes: 16 * 60 },
          { surfaceId: 'bright/f2', startMinutes: 17 * 60 },
        ],
        calendar,
      });
    const without = repairPracticeLoss(input(undefined));
    expect(without.recommendations[0].to).toMatchObject({ surfaceId: 'quiet/f2' });
    const run = repairPracticeLoss(input(rigCalendar()));
    expectNoneDropped(run, ['a0']);
    expect(run.recommendations[0]).toMatchObject({
      tier: 'cross-venue',
      to: { surfaceId: 'bright/f2', startMinutes: 17 * 60 },
    });
    expect(run.timeTbd[0].reason).toBe(PRACTICE_TBD_REASON.NO_LEGAL_SLOT_AT_VENUE);
    expect(run.daylight.refused.map((entry) => entry.tier)).toEqual(['cross-venue']);
    expect(run.daylight.candidatesLitExempt).toBe(1);
    // The refused one stood on undeclared ground (D5), and that is counted.
    expect(run.daylight.candidatesOnUndeclaredLighting).toBe(1);
  });

  it('a decline never re-offers a refused candidate', () => {
    const state = createRecommendationState(
      rigInput({ series, inventory, calendar: rigCalendar() })
    );
    expect(state.recommendations[0].to).toMatchObject({ startMinutes: 15 * 60 });
    const next = declineRecommendation(state, 'a0');
    expect(next.recommendations[0]).toMatchObject({
      to: null,
      reason: PRACTICE_TBD_REASON.DECLINED,
    });
  });
});

describe('the registry claim is honest about the repair', () => {
  it('says the gate is enforced in the module and not live until 3b wires the repair', () => {
    expect(SEASON_2026_PRACTICE_DAYLIGHT_CONSTRAINT.source.note).toMatch(
      /practice\/repair\.js \(8\.9 PR 7\).*enforced in that module, not live until 8\.6 3b PRs 9-11/
    );
  });
});

/* -------------------------------------------------------------------------- */
/* D4 in core -- an unknown sunset refuses the candidate                       */
/* -------------------------------------------------------------------------- */

describe('D4: an unknown sunset is never allowed', () => {
  // Plant (a): in the gate, return `null` (allowed) when the evaluator lists
  // the candidate unknown -- both tests go red.
  it('refuses a candidate on unlit ground with no coordinates and no table', () => {
    const run = repairPracticeLoss(
      rigInput({
        series: [{ teamId: 'T1', surfaceId: 'dark/f1', startMinutes: 15 * 60 }],
        inventory: [{ surfaceId: 'dark/f2', startMinutes: 15 * 60 }],
        calendar: rigCalendar(),
      })
    );
    expectNoneDropped(run, ['a0']);
    expect(run.rehomed).toEqual([]);
    expect(run.timeTbd[0]).toMatchObject({
      reason: PRACTICE_TBD_REASON.SUNSET_UNKNOWN,
      daylightRefused: { pastSunset: 0, sunsetUnknown: 1 },
    });
    expect(run.daylight).toMatchObject({
      candidatesRefusedSunsetUnknown: 1,
      candidatesRefusedPastSunset: 0,
    });
    expect(run.daylight.refused[0]).toMatchObject({
      reason: PRACTICE_TBD_REASON.SUNSET_UNKNOWN,
      sunsetMinutes: null,
      limitMinutes: null,
      sunsetSource: 'unknown',
    });
    const unknown = run.findings.filter(
      (f) => f.code === PRACTICE_REASON.REPAIR_CANDIDATES_SUNSET_UNKNOWN
    );
    expect(unknown).toHaveLength(1);
    expect(unknown[0].severity).toBe('compromise');
    expect(run.status).not.toBe('ok');
  });

  it('names sunset-unknown when a venue mixes a past-sunset refusal with an unknown one', () => {
    // A table with Tuesdays only: the Tuesday shape is judged (and runs past
    // sunset), the Wednesday shape has no record and no coordinates.
    const tuesdays = datesOn('TUE', LOSS_FROM, SERIES_UNTIL).map((date) => ({
      date,
      sunsetMinutes: 16 * 60,
    }));
    const run = repairPracticeLoss(
      rigInput({
        series: [{ teamId: 'T1', surfaceId: 'dark/f1', startMinutes: 16 * 60 }],
        inventory: [
          { surfaceId: 'dark/f2', startMinutes: 16 * 60 },
          { surfaceId: 'dark/f2', weekday: 'WED', startMinutes: 15 * 60 },
        ],
        calendar: rigCalendar(tuesdays),
      })
    );
    expectNoneDropped(run, ['a0']);
    expect(run.timeTbd[0]).toMatchObject({
      reason: PRACTICE_TBD_REASON.SUNSET_UNKNOWN,
      daylightRefused: { pastSunset: 1, sunsetUnknown: 1 },
    });
    expect(run.daylight.refused.map((entry) => [entry.reason, entry.sunsetSource])).toEqual([
      [PRACTICE_TBD_REASON.PAST_SUNSET, 'table'],
      [PRACTICE_TBD_REASON.SUNSET_UNKNOWN, 'unknown'],
    ]);
  });
});

describe('the evaluator gaps stay visible in the repair', () => {
  it('counts every occurrence-date on which the table and the coordinates disagree', () => {
    // A table 16:00 on every Tuesday, far earlier than the synthetic point's
    // sunset: the table is applied (so a 15:00-16:00 practice ends exactly at
    // the limit and is legal), and every date is a disagreement.
    const dates = datesOn('TUE', LOSS_FROM, SERIES_UNTIL);
    const disagreeing = dates.filter(
      (date) => Math.abs(/** @type {number} */ (limitAt('dusk', date)) - 16 * 60) > 2
    );
    expect(disagreeing.length).toBeGreaterThan(0);
    const run = repairPracticeLoss(
      rigInput({
        series: [{ teamId: 'T1', surfaceId: 'dusk/f1', startMinutes: 14 * 60 }],
        inventory: [{ surfaceId: 'dusk/f2', startMinutes: 15 * 60 }],
        calendar: rigCalendar(dates.map((date) => ({ date, sunsetMinutes: 16 * 60 }))),
      })
    );
    expectNoneDropped(run, ['a0']);
    expect(run.rehomed).toHaveLength(1);
    expect(run.daylight.sunsetSourcesDisagree).toBe(disagreeing.length);
  });
});

/* -------------------------------------------------------------------------- */
/* W15 through the gate -- ending exactly at floor(sunset) is legal            */
/* -------------------------------------------------------------------------- */

describe('the boundary: ending at floor(sunset) is legal, one minute later is not', () => {
  // Plant (b): `<=` -> `<` in the evaluator's comparison
  // (`practice/daylight.js`) -- the "exactly at the limit" test goes red.
  const DATE = '2026-10-06';
  const LIMIT = /** @type {number} */ (limitAt('dusk', DATE));
  const blackout = (startMinutes) =>
    repairPracticeLoss(
      rigInput({
        series: [{ teamId: 'T1', surfaceId: 'dusk/f1', startMinutes: 15 * 60 }],
        inventory: [{ surfaceId: 'dusk/f2', startMinutes }],
        loss: { from: DATE, until: DATE },
        calendar: rigCalendar(),
      })
    );

  it('re-homes onto a candidate ending exactly at the limit', () => {
    const run = blackout(LIMIT - 60);
    expectNoneDropped(run, ['a0']);
    expect(run.rehomed).toHaveLength(1);
    expect(run.rehomed[0].to.startMinutes + 60).toBe(LIMIT);
    expect(run.daylight.candidatesWithinDaylight).toBe(1);
  });

  it('refuses a candidate ending one minute past it', () => {
    const run = blackout(LIMIT - 59);
    expectNoneDropped(run, ['a0']);
    expect(run.rehomed).toEqual([]);
    expect(run.timeTbd[0].reason).toBe(PRACTICE_TBD_REASON.PAST_SUNSET);
    expect(run.daylight.refused[0]).toMatchObject({ date: DATE, endMinutes: LIMIT + 1 });
  });
});

/* -------------------------------------------------------------------------- */
/* Lit ground: byte-identical to a repair with no gate                         */
/* -------------------------------------------------------------------------- */

/** A result less the two things the gate adds: its block and the unchecked finding. */
const withoutGate = (result) =>
  JSON.stringify({
    ...result,
    daylight: undefined,
    findings: result.findings.filter((f) => f.code !== PRACTICE_REASON.REPAIR_DAYLIGHT_UNCHECKED),
  });

describe('every venue lit: the result is byte-identical to one with no calendar', () => {
  // Control: with `bright` unlit, the same comparison differs (below).
  const series = [
    { teamId: 'T1', surfaceId: 'bright/f1', startMinutes: 20 * 60 },
    { teamId: 'T2', surfaceId: 'bright/f1', startMinutes: 21 * 60 },
  ];
  const inventory = [
    { surfaceId: 'bright/f2', startMinutes: 20 * 60 },
    { surfaceId: 'bright/f2', startMinutes: 19 * 60 },
  ];

  it('holds on the rig, and the gate judged every candidate as lit', () => {
    const plain = repairPracticeLoss(rigInput({ series, inventory }));
    const lit = repairPracticeLoss(rigInput({ series, inventory, calendar: rigCalendar() }));
    expect(withoutGate(lit)).toBe(withoutGate(plain));
    expect(lit.daylight.candidatesJudged).toBeGreaterThan(0);
    expect(lit.daylight.candidatesLitExempt).toBe(lit.daylight.candidatesJudged);
    expect(lit.rehomed.length).toBeGreaterThan(0);
  });

  it('control: the same comparison differs once the ground is unlit', () => {
    const unlit = series.map((entry) => ({ ...entry, surfaceId: 'dusk/f1' }));
    const unlitInventory = inventory.map((shape) => ({ ...shape, surfaceId: 'dusk/f2' }));
    const plain = repairPracticeLoss(rigInput({ series: unlit, inventory: unlitInventory }));
    const gated = repairPracticeLoss(
      rigInput({ series: unlit, inventory: unlitInventory, calendar: rigCalendar() })
    );
    expect(withoutGate(gated)).not.toBe(withoutGate(plain));
  });
});

/* -------------------------------------------------------------------------- */
/* The season-2026 corpus                                                      */
/* -------------------------------------------------------------------------- */

/** As `practiceRepair.test.js`: revision `93 Combined`, dated by assumption. */
const BASELINE_REVISION = '93 Combined';
const SEASON_FROM = '2026-08-17';
const SEASON_UNTIL = '2026-11-13';
const LOSS_DATE = '2026-09-28';
/**
 * A three-week blackout across the equinox: at the synthetic point a 19:00
 * end is legal at its start and illegal at its end, so the gate both passes
 * and refuses real corpus candidates. The retirement from {@link LOSS_DATE}
 * runs past DST, where every grid end is illegal (8.9 plan F1).
 */
const BLACKOUT = Object.freeze({ from: '2026-09-07', until: '2026-09-27' });

const sunsets = loadSunsets();
const corpusGraph = buildSeason2026PracticeFacilityGraph(loadFacilityGeometry());
const fullPlan = toSeason2026PracticePlan(
  loadSeason2026Practice().practiceSlots,
  corpusGraph,
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
const INVENTORY = fullPlan.slots
  .filter((slot) => slot.surfaceResolution === 'resolved')
  .map(({ surfaceId, weekday, startMinutes, durationMinutes }) => ({
    surfaceId,
    weekday,
    startMinutes,
    durationMinutes,
  }));
/** Every graph venue at one SYNTHETIC point: one season, one location. */
const corpusCalendar = buildAvailabilityCalendarFromSeason2026(
  loadFacilityPermits({ seasonYear: Number(sunsets[0].date.slice(0, 4)) }),
  sunsets,
  {
    timeZone: TIME_ZONE,
    venueDaylight: Object.keys(corpusGraph.venues).map((venueId) => ({
      venueId,
      ...SYNTHETIC_NORTH,
    })),
  }
);

/** Displaced series, from the plan and the graph -- never from a run. */
function displacedBy(surfaceId) {
  const lost = new Set(conflictingSurfacesOf(corpusGraph, surfaceId));
  const slotById = new Map(PLAN.slots.map((slot) => [slot.id, slot]));
  return PLAN.assignments
    .filter((assignment) => lost.has(slotById.get(assignment.slotId).surfaceId))
    .map((assignment) => assignment.id)
    .sort();
}

/**
 * Independent corpus legality over a window: lighting from the graph (the
 * input), sunset from the table row where one exists, else the floor of the
 * solar function at the synthetic point.
 */
const tableByDate = new Map(sunsets.map((row) => [row.date, row.sunsetMinutes]));
function corpusIllegal(shape, from, until) {
  const venueId = corpusGraph.surfaces[shape.surfaceId].venueId;
  if (corpusGraph.venues[venueId]?.lit === true) return false;
  return datesOn(shape.weekday, from, until).some((date) => {
    const table = tableByDate.get(date);
    const limit =
      table !== undefined
        ? Math.floor(table)
        : Math.floor(
            /** @type {number} */ (
              sunsetOnDate({ date, ...SYNTHETIC_NORTH, timeZone: TIME_ZONE }).minutes
            )
          );
    return shape.startMinutes + shape.durationMinutes > limit;
  });
}

const RETIREMENT = Object.freeze({ from: LOSS_DATE });
/** @type {(surfaceId: string, calendar?: Object, window?: { from: string, until?: string }) => any} */
const corpusRepair = (surfaceId, calendar, window = RETIREMENT) =>
  repairPracticeLoss({
    plan: PLAN,
    graph: corpusGraph,
    loss: { surfaceIds: [surfaceId], ...window, reason: 'field lost mid-season' },
    inventory: INVENTORY,
    ...(calendar === undefined ? {} : { calendar }),
  });

/**
 * Every surface the baseline stands on, retired and blacked out, repaired
 * with and without the gate. Every baseline series is dated over the whole
 * season, so each window displaces the same series.
 */
const SURFACES = [...new Set(PLAN.slots.map((slot) => slot.surfaceId))].sort();
const SWEEP = [RETIREMENT, BLACKOUT].flatMap((window) =>
  SURFACES.map((surfaceId) => ({
    surfaceId,
    window,
    displaced: displacedBy(surfaceId),
    ungated: corpusRepair(surfaceId, undefined, window),
    gated: corpusRepair(surfaceId, corpusCalendar, window),
  }))
);

describe('season-2026: every corpus loss, gated', () => {
  it('sweeps every surface the baseline stands on, and the gate judged and refused real candidates', () => {
    expect(SURFACES.length).toBe(29);
    expect(SWEEP.length).toBe(58);
    const sum = (key) => SWEEP.reduce((n, row) => n + row.gated.daylight[key], 0);
    expect(sum('candidatesJudged')).toBeGreaterThan(0);
    expect(sum('candidatesRefusedPastSunset')).toBeGreaterThan(0);
    expect(sum('candidatesWithinDaylight')).toBeGreaterThan(0);
    // Every corpus venue has (synthetic) coordinates: nothing is unknown.
    expect(sum('candidatesRefusedSunsetUnknown')).toBe(0);
  });

  it('W10: without the gate some re-home runs past sunset (not vacuous); with it, none does', () => {
    let ungatedIllegal = 0;
    let gatedLegal = 0;
    for (const { ungated, gated } of SWEEP) {
      for (const entry of ungated.recommendations) {
        if (entry.to === null) continue;
        if (corpusIllegal(entry.to, entry.effectiveFrom, entry.effectiveUntil)) ungatedIllegal += 1;
      }
      // Tier 1 and tier 2 alike: every recommendation is a candidate the gate passed.
      for (const entry of gated.recommendations) {
        if (entry.to === null) continue;
        expect(corpusIllegal(entry.to, entry.effectiveFrom, entry.effectiveUntil)).toBe(false);
        gatedLegal += 1;
      }
    }
    expect(ungatedIllegal).toBeGreaterThan(0);
    // The blackout leaves legal ground, so "none past sunset" is not "none placed".
    expect(gatedLegal).toBeGreaterThan(0);
  });

  it('every refusal the gate names is illegal by the independent derivation', () => {
    let count = 0;
    for (const { gated } of SWEEP) {
      for (const entry of gated.daylight.refused) {
        const window = gated.recommendations.find((r) => r.assignmentId === entry.assignmentId);
        expect(corpusIllegal(entry.to, window.effectiveFrom, window.effectiveUntil)).toBe(true);
        count += 1;
      }
    }
    expect(count).toBeGreaterThan(0);
  });

  it('none dropped: every displaced series from the plan is placed or TIME TBD with a reason', () => {
    let pastSunset = 0;
    for (const { displaced, gated } of SWEEP) {
      if (displaced.length === 0) continue;
      expectNoneDropped(gated, displaced);
      pastSunset += gated.timeTbd.filter(
        (entry) => entry.reason === PRACTICE_TBD_REASON.PAST_SUNSET
      ).length;
    }
    expect(pastSunset).toBeGreaterThan(0);
  });

  it('the corpus as it ships -- weekend table rows, no coordinates -- refuses unknowns, drops nothing', () => {
    // No venue in the repo has coordinates and the table holds weekend rows
    // only, so a weekday date has no sunset: D4 refuses, never allows.
    const realCalendar = buildAvailabilityCalendarFromSeason2026(
      loadFacilityPermits({ seasonYear: Number(sunsets[0].date.slice(0, 4)) }),
      sunsets,
      { timeZone: TIME_ZONE }
    );
    let unknownRefused = 0;
    let unknownTbd = 0;
    for (const surfaceId of SURFACES) {
      const run = corpusRepair(surfaceId, realCalendar);
      expectNoneDropped(run, displacedBy(surfaceId));
      unknownRefused += run.daylight.candidatesRefusedSunsetUnknown;
      unknownTbd += run.timeTbd.filter(
        (entry) => entry.reason === PRACTICE_TBD_REASON.SUNSET_UNKNOWN
      ).length;
      // Anything placed stands on lit ground or on dates the table covers, legally.
      for (const entry of run.recommendations) {
        if (entry.to === null) continue;
        const venueId = corpusGraph.surfaces[entry.to.surfaceId].venueId;
        if (corpusGraph.venues[venueId]?.lit === true) continue;
        for (const date of datesOn(entry.to.weekday, entry.effectiveFrom, entry.effectiveUntil)) {
          expect(tableByDate.has(date)).toBe(true);
          expect(entry.to.startMinutes + entry.to.durationMinutes).toBeLessThanOrEqual(
            Math.floor(/** @type {number} */ (tableByDate.get(date)))
          );
        }
      }
    }
    expect(unknownRefused).toBeGreaterThan(0);
    expect(unknownTbd).toBeGreaterThan(0);
  });

  it('every venue lit: byte-identical to the ungated repair on every corpus loss', () => {
    const allLit = buildAvailabilityCalendar({
      permitWindows: [],
      lighting: Object.keys(corpusGraph.surfaces).map((surfaceId) => ({ surfaceId, lit: true })),
    });
    let judged = 0;
    for (const { surfaceId, window, ungated } of SWEEP) {
      const lit = corpusRepair(surfaceId, allLit, window);
      expect(withoutGate(lit)).toBe(withoutGate(ungated));
      expect(lit.daylight.candidatesLitExempt).toBe(lit.daylight.candidatesJudged);
      judged += lit.daylight.candidatesJudged;
    }
    expect(judged).toBeGreaterThan(0);
  }, 15_000); // 58 corpus repairs: 2.3 s alone, 3.4 s in a local full run; the 15 s floor of docs/testing/test-timeouts.md.
});

/* -------------------------------------------------------------------------- */
/* W29 -- a lighting override lights a shape only when it lights every slot   */
/* -------------------------------------------------------------------------- */

describe('W29: repair honours a lighting override only when every plan slot of the shape has one', () => {
  // Plant 1: ignore the overrides (hand the evaluator none). The fully lit
  // case stays refused and goes red. Plant 2: `some` for `every` in
  // shapeExemptOn(); the half-lit case is re-homed and goes red.
  const series = [{ teamId: 'T1', surfaceId: 'dusk/f1', startMinutes: 16 * 60 }];
  // One candidate: dusk/f2 16:00, which ends 17:00 -- past sunset after DST.
  const inventory = [{ surfaceId: 'dusk/f2', startMinutes: 16 * 60 }];
  /** Two unassigned plan slots with the candidate's shape. */
  const twin = (id) => ({
    id,
    surfaceId: 'dusk/f2',
    weekday: 'TUE',
    startMinutes: 16 * 60,
    durationMinutes: 60,
    validFrom: SERIES_FROM,
    validUntil: SERIES_UNTIL,
    capacity: 1,
    revisionId: 'r1',
    label: null,
    surfaceResolution: 'resolved',
  });
  const run = (lightingOverrides) => {
    const input = rigInput({ series, inventory, calendar: rigCalendar() });
    input.plan.slots.push(twin('x1'), twin('x2'));
    return repairPracticeLoss({ ...input, lightingOverrides });
  };
  const whole = (slotId, until = SERIES_UNTIL) => ({ slotId, from: SERIES_FROM, until });

  it('with no override the candidate is refused past sunset (the case is not vacuous)', () => {
    const result = run([]);
    expect(result.rehomed).toHaveLength(0);
    expect(result.timeTbd.map((entry) => entry.reason)).toEqual([PRACTICE_TBD_REASON.PAST_SUNSET]);
  });

  it('one of two identical slots overridden: still refused', () => {
    const result = run([whole('x1')]);
    expect(result.rehomed).toHaveLength(0);
    expect(result.daylight.candidatesRefusedPastSunset).toBe(1);
    expect(result.daylight.occurrencesLightingOverrideExempt).toBe(0);
    expectNoneDropped(result, ['a0']);
  });

  it('every slot of the shape overridden for the window: exempt, and re-homed there', () => {
    const result = run([whole('x1'), whole('x2')]);
    expect(result.rehomed).toHaveLength(1);
    expect(result.rehomed[0].to).toMatchObject({ surfaceId: 'dusk/f2', startMinutes: 16 * 60 });
    expect(result.daylight.candidatesLightingOverrideExempt).toBe(1);
    expect(result.daylight.candidatesRefusedPastSunset).toBe(0);
    expect(result.daylight.occurrencesLightingOverrideExempt).toBe(
      result.daylight.occurrencesExamined
    );
    expectNoneDropped(result, ['a0']);
  });

  it('a window that stops before DST leaves the late dates judged: partly legal is refused', () => {
    const result = run([whole('x1', '2026-10-31'), whole('x2', '2026-10-31')]);
    expect(result.rehomed).toHaveLength(0);
    expect(result.daylight.refused[0].date).toBe('2026-11-03');
    expect(result.daylight.occurrencesLightingOverrideExempt).toBeGreaterThan(0);
  });

  it('an override on a slot the plan does not hold is refused', () => {
    expect(() => run([whole('ghost')])).toThrow(/not in the plan/);
  });
});
