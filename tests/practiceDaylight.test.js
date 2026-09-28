/**
 * 8.9 PR 4: the daylight provider, the DST season event and the practice
 * daylight evaluator (`practice/daylight.js`).
 *
 * Witnesses, numbered as in `docs/PHASE_8_9_PLAN.md` section 4. Each was shown
 * red by its plant (listed on the describe block) before it counted; the plants
 * are source edits and are recorded in the PR, not left in the tree.
 *
 * **No real coordinates.** Every coordinate below is synthetic -- round
 * numbers chosen for the arithmetic, not places: 40.00/-75.00, 40.00/-76.50
 * and 41.50/-73.50. The corpus's own location is never fitted here, and
 * nothing is geocoded or fetched.
 *
 * **Universes come from inputs.** Every expected set or count is derived from
 * the practice plan (slots x dates), the raw geometry and the sunset table --
 * never from the evaluator's result or from the materialised occurrences.
 */

import { describe, expect, it } from 'vitest';

import {
  AVAILABILITY_REASON,
  SUNSET_SOURCES_TOLERANCE_MINUTES,
  buildAvailabilityCalendar,
  buildAvailabilityCalendarFromSeason2026,
  sunsetForVenue,
} from '@squadlogic/core/availability/index.js';
import {
  SEASON_2026_CONSTRAINT_ID,
  buildSeason2026ConstraintRegistry,
  buildSeason2026PracticeConstraintRegistry,
  constraintsForReasonCode,
  getConstraint,
} from '@squadlogic/core/constraints/index.js';
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
  PRACTICE_SUNSET_MARGIN_MINUTES,
  buildPracticeSlotSet,
  evaluatePracticeDaylight,
  materialisePracticeOccurrences,
  toSeason2026PracticePlan,
} from '@squadlogic/core/practice/index.js';
import {
  SEASON_CLOCK_EVENT,
  TIMING_REASON,
  deriveSeasonClockEvents,
  parseClockChangeNote,
  sunsetOnDate,
} from '@squadlogic/core/timing/index.js';

/* -------------------------------------------------------------------------- */
/* Assumptions, stated once                                                    */
/* -------------------------------------------------------------------------- */

/** The corpus names no zone; its README says tests read it in New York. */
const TIME_ZONE = 'America/New_York';
/** SYNTHETIC coordinates, not a place: round numbers in the season's zone. */
const SYNTHETIC_EAST = Object.freeze({ latitude: 40.0, longitude: -75.0 });
/** SYNTHETIC: 1.5 degrees of longitude west of {@link SYNTHETIC_EAST}. */
const SYNTHETIC_WEST = Object.freeze({ latitude: 40.0, longitude: -76.5 });
/** SYNTHETIC: a third point for the single-venue rigs. */
const SYNTHETIC_NORTH = Object.freeze({ latitude: 41.5, longitude: -73.5 });

/** The published baseline revision and the range `practiceRepair.test.js` assumes for it. */
const BASELINE_REVISION = '93 Combined';
const SEASON_FROM = '2026-08-17';
const SEASON_UNTIL = '2026-11-13';
/** What the `Note` column claims and the zone must reproduce. */
const DST_END = '2026-11-01';

const MS_PER_DAY = 86_400_000;
const WEEKDAYS = ['THU', 'FRI', 'SAT', 'SUN', 'MON', 'TUE', 'WED'];
/** Day number and weekday by plain arithmetic -- not the library's walk. */
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

/* -------------------------------------------------------------------------- */
/* The corpus                                                                  */
/* -------------------------------------------------------------------------- */

const rawGeometry = loadFacilityGeometry();
const sunsets = loadSunsets();
const SEASON_YEAR = Number(sunsets[0].date.slice(0, 4));
const permits = loadFacilityPermits({ seasonYear: SEASON_YEAR });
const graph = buildSeason2026PracticeFacilityGraph(rawGeometry);
const practice = loadSeason2026Practice();
const fullPlan = toSeason2026PracticePlan(
  practice.practiceSlots,
  graph,
  buildSeason2026VenueComplexMap()
);

/** The baseline revision, dated by the stated assumption. */
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

/** Every graph venue gets the same synthetic point: one season, one location. */
const corpusVenueDaylight = Object.keys(graph.venues).map((venueId) => ({
  venueId,
  ...SYNTHETIC_EAST,
}));
const corpusCalendar = buildAvailabilityCalendarFromSeason2026(permits, sunsets, {
  timeZone: TIME_ZONE,
  venueDaylight: corpusVenueDaylight,
});

const WINDOW = { from: SEASON_FROM, to: SEASON_UNTIL };
const occurrences = materialisePracticeOccurrences(buildPracticeSlotSet(PLAN), WINDOW).occurrences;
const corpusResult = evaluatePracticeDaylight({ occurrences, graph, calendar: corpusCalendar });

/**
 * The independent derivation: plan slots x dates x sunset x lighting.
 *
 * Dates are walked by plain arithmetic; lighting is read from the raw
 * `facility_geometry.json` by venue name (practice-only venues are absent
 * there and are `null`, undeclared); sunset is the table row where one exists,
 * else `floor(sunsetOnDate())` at the synthetic point. Nothing here calls the
 * materialiser, the provider or the evaluator.
 */
function deriveIndependently() {
  const tableByDate = new Map(sunsets.map((row) => [row.date, row.sunsetMinutes]));
  const flagged = new Set();
  let unlit = 0;
  let teamPractices = 0;
  const teamsBySlot = new Map();
  for (const a of PLAN.assignments) {
    const set = teamsBySlot.get(a.slotId) ?? new Set();
    set.add(a.teamId);
    teamsBySlot.set(a.slotId, set);
  }
  const dates = datesBetween(SEASON_FROM, SEASON_UNTIL);
  for (const slot of PLAN.slots) {
    const venue = graph.venues[graph.surfaces[slot.surfaceId].venueId];
    const lit = rawGeometry.venues[venue.name]?.lit ?? null;
    for (const date of dates) {
      if (weekdayOf(date) !== slot.weekday) continue;
      teamPractices += teamsBySlot.get(slot.id)?.size ?? 0;
      if (lit === true) continue;
      unlit += 1;
      const sunset = tableByDate.has(date)
        ? tableByDate.get(date)
        : Math.floor(sunsetOnDate({ date, ...SYNTHETIC_EAST, timeZone: TIME_ZONE }).minutes);
      if (slot.startMinutes + slot.durationMinutes > sunset) flagged.add(`${slot.id}|${date}`);
    }
  }
  return { flagged, unlit, teamPractices };
}
const derived = deriveIndependently();
const flaggedKeys = (result) => new Set(result.flagged.map((v) => `${v.slotId}|${v.date}`));

/* -------------------------------------------------------------------------- */
/* W4 -- the fixture sweep                                                     */
/* -------------------------------------------------------------------------- */

describe('W4: the season-2026 sweep flags exactly the independently derived set', () => {
  // Plant: an early `return` in evaluatePracticeDaylight() with nothing flagged.
  it('the plan and the derivation are not empty (meta)', () => {
    expect(PLAN.slots.length).toBeGreaterThan(0);
    expect(occurrences.length).toBeGreaterThan(0);
    expect(derived.flagged.size).toBeGreaterThan(0);
  });

  it('flagged set = derived set, and non-empty', () => {
    const actual = flaggedKeys(corpusResult);
    expect(actual.size).toBeGreaterThan(0);
    expect([...actual].sort()).toEqual([...derived.flagged].sort());
  });

  it('F1: after the 11/01 fall-back every unlit practice ending at 17:00 or later is flagged', () => {
    // The universe is the plan's own slots x dates after DST, not the result.
    const afterDst = datesBetween(DST_END, SEASON_UNTIL);
    const lateAfter = [];
    const earlyAfter = [];
    for (const slot of PLAN.slots) {
      for (const date of afterDst) {
        if (weekdayOf(date) !== slot.weekday) continue;
        const end = slot.startMinutes + slot.durationMinutes;
        (end >= 17 * 60 ? lateAfter : earlyAfter).push(`${slot.id}|${date}`);
      }
    }
    const actual = flaggedKeys(corpusResult);
    expect(lateAfter.length).toBeGreaterThan(0);
    for (const key of lateAfter) expect(actual.has(key)).toBe(true);
    // Large after DST: the only survivors are the 16:00-16:45 slots, which end
    // before a mid-November sunset (plan F1 says "every grid slot"; these
    // are the exception, and they are few).
    const flaggedAfter = [...actual].filter((key) => key.slice(-10) >= DST_END).length;
    expect(flaggedAfter / (lateAfter.length + earlyAfter.length)).toBeGreaterThan(0.95);
    expect(corpusResult.flagged.some((v) => v.date < DST_END)).toBe(true);
    expect(corpusResult.unknown).toHaveLength(0);
  });

  it('every violation carries a sunset attribution with the numbers (for 8.10)', () => {
    for (const v of corpusResult.flagged) {
      expect(v.attribution).toMatchObject({
        kind: 'sunset',
        constraintId: PRACTICE_DAYLIGHT_CONSTRAINT_ID,
        code: AVAILABILITY_REASON.PRACTICE_PAST_SUNSET,
        marginMinutes: 0,
      });
      expect(v.attribution.endMinutes - v.attribution.limitMinutes).toBe(v.overrunMinutes);
      expect(v.overrunMinutes).toBeGreaterThan(0);
    }
    const codes = corpusResult.findings.filter(
      (f) => f.code === AVAILABILITY_REASON.PRACTICE_PAST_SUNSET
    );
    expect(codes).toHaveLength(corpusResult.flagged.length);
  });

  it('the registry claims the code the evaluator emits, enforced in core evaluation', () => {
    const registry = buildSeason2026PracticeConstraintRegistry();
    const record = getConstraint(registry, PRACTICE_DAYLIGHT_CONSTRAINT_ID);
    expect(record?.id).toBe(PRACTICE_DAYLIGHT_CONSTRAINT_ID);
    expect(record?.enforcement).toBe('reason-codes');
    expect(record?.parameters.marginMinutes).toBe(PRACTICE_SUNSET_MARGIN_MINUTES);
    expect(record?.source.note).toMatch(/practiceScheduling\.js or autoScheduler\.js/);
    expect(
      constraintsForReasonCode(registry, AVAILABILITY_REASON.PRACTICE_PAST_SUNSET).map((c) => c.id)
    ).toEqual([PRACTICE_DAYLIGHT_CONSTRAINT_ID]);
    // D7: the game record says the live game path is declared, not enforced.
    const games = getConstraint(registry, SEASON_2026_CONSTRAINT_ID.SUNSET_MARGIN);
    expect(games?.source.note).toMatch(/declared, not enforced/);
    expect(games?.parameters.marginMinutes).toBe(15);
    // The game registry does not carry the practice claim: the rule engine
    // would report it unenforced in every game run (a change to game results).
    const gameRegistry = buildSeason2026ConstraintRegistry();
    expect(getConstraint(gameRegistry, PRACTICE_DAYLIGHT_CONSTRAINT_ID)).toBeNull();
    expect(registry.stats.constraintCount).toBe(gameRegistry.stats.constraintCount + 1);
  });
});

/* -------------------------------------------------------------------------- */
/* W5 -- exercise counters against the plan                                    */
/* -------------------------------------------------------------------------- */

describe('W5: the evaluator examined unlit practices, as many as the plan implies', () => {
  // Plants: every venue lit (examined -> 0); materialise drops one team.
  it('unlitPracticeOccurrencesExamined > 0 and equals the derived unlit count', () => {
    expect(corpusResult.meta.unlitPracticeOccurrencesExamined).toBeGreaterThan(0);
    expect(corpusResult.meta.unlitPracticeOccurrencesExamined).toBe(derived.unlit);
  });

  it('practicesExamined equals the team-practices derived from the plan', () => {
    expect(derived.teamPractices).toBeGreaterThan(0);
    expect(corpusResult.meta.practicesExamined).toBe(derived.teamPractices);
  });

  it('negative control: a dropped team turns the plan-derived check red, the output-derived one would not', () => {
    const dropped = PLAN.assignments[0].teamId;
    const thinned = occurrences.map((o) => ({
      ...o,
      teamIds: o.teamIds.filter((t) => t !== dropped),
    }));
    const result = evaluatePracticeDaylight({
      occurrences: thinned,
      graph,
      calendar: corpusCalendar,
    });
    expect(result.meta.practicesExamined).not.toBe(derived.teamPractices);
    const fromOutput = thinned.reduce((n, o) => n + o.teamIds.length, 0);
    expect(result.meta.practicesExamined).toBe(fromOutput);
  });
});

/* -------------------------------------------------------------------------- */
/* Synthetic rigs                                                              */
/* -------------------------------------------------------------------------- */

const RIG_DATE = '2026-10-06';
const rigGraph = buildFacilityGraph({
  venues: [
    { id: 'east', name: 'East', lit: false },
    { id: 'west', name: 'West', lit: false },
    { id: 'dark', name: 'Dark', lit: false },
    { id: 'quiet', name: 'Quiet', lit: null },
    { id: 'bright', name: 'Bright', lit: true },
  ],
  surfaces: ['east', 'west', 'dark', 'quiet', 'bright'].map((venueId) => ({
    id: `${venueId}/f`,
    venueId,
    name: 'F',
    sizes: ['7v7'],
    lined: ['7v7'],
  })),
});

/** Materialise one weekly slot per entry over a one-date window. */
function rigOccurrences(entries, date = RIG_DATE) {
  const slots = entries.map((entry, index) => ({
    id: `s${index}`,
    surfaceId: entry.surfaceId,
    weekday: weekdayOf(date),
    startMinutes: entry.endMinutes - 60,
    durationMinutes: 60,
    validFrom: date,
    validUntil: date,
    capacity: 1,
    revisionId: 'r',
    label: null,
  }));
  const assignments = slots.map((slot, index) => ({
    id: `a${index}`,
    slotId: slot.id,
    teamId: `T${index}`,
  }));
  const set = buildPracticeSlotSet({ slots, assignments, source: 'rig' });
  const { occurrences: out } = materialisePracticeOccurrences(set, { from: date, to: date });
  expect(out).toHaveLength(entries.length);
  return out;
}

const rigCalendar = (venueDaylight, sunsetsInput = []) =>
  buildAvailabilityCalendar({ timeZone: TIME_ZONE, venueDaylight, sunsets: sunsetsInput });

/* -------------------------------------------------------------------------- */
/* W6 -- no coordinates is unknown, never allowed                              */
/* -------------------------------------------------------------------------- */

describe('W6: a venue without coordinates is flagged unknown, counted, never allowed', () => {
  // Plant: the provider answers a far-future sunset when it has none.
  const calendar = rigCalendar([{ venueId: 'east', ...SYNTHETIC_EAST }]);
  const occ = rigOccurrences([
    { surfaceId: 'dark/f', endMinutes: 10 * 60 },
    { surfaceId: 'quiet/f', endMinutes: 10 * 60 },
    { surfaceId: 'bright/f', endMinutes: 23 * 60 },
  ]);
  const result = evaluatePracticeDaylight({ occurrences: occ, graph: rigGraph, calendar });

  it('both unlit and undeclared ground without coordinates are unknown', () => {
    expect(result.meta.daylightUnknownOccurrences).toBe(2);
    expect(result.unknown.map((v) => v.surfaceId).sort()).toEqual(['dark/f', 'quiet/f']);
    expect(result.allowed).toEqual([]);
    expect(result.flagged).toEqual([]);
    const unknownFindings = result.findings.filter(
      (f) => f.code === AVAILABILITY_REASON.SUNSET_UNKNOWN
    );
    expect(unknownFindings).toHaveLength(2);
    for (const f of unknownFindings) expect(f.details.cause).toBe('venue-coordinates-missing');
    expect(result.meta.undeclaredLightingOccurrences).toBe(1);
  });

  it('lit ground is exempt, even at 23:00 with no coordinates', () => {
    expect(result.meta.litPracticeOccurrencesExempt).toBe(1);
    expect(result.meta.unlitPracticeOccurrencesExamined).toBe(2);
    expect(result.meta.practicesExamined).toBe(3);
    expect(result.meta.litOccurrencesWithLightsOff).toBe(0);
  });

  it('a lit field with a stated lights-off time is exempt here but counted, not silently passed', () => {
    const withLightsOff = buildAvailabilityCalendar({
      timeZone: TIME_ZONE,
      lighting: [{ surfaceId: 'bright/f', lit: true, lightsOffMinutes: 20 * 60 }],
    });
    const late = rigOccurrences([{ surfaceId: 'bright/f', endMinutes: 21 * 60 }]);
    const out = evaluatePracticeDaylight({
      occurrences: late,
      graph: rigGraph,
      calendar: withLightsOff,
    });
    expect(out.meta.litPracticeOccurrencesExempt).toBe(1);
    expect(out.meta.litOccurrencesWithLightsOff).toBe(1);
  });

  it('the provider itself answers null with the cause, not a number', () => {
    const answer = sunsetForVenue(calendar, { venueId: 'dark', date: RIG_DATE });
    expect(answer.sunsetMinutes).toBeNull();
    expect(answer.source).toBe('unknown');
    expect(answer.findings[0].details.cause).toBe('venue-coordinates-missing');
  });
});

/* -------------------------------------------------------------------------- */
/* W8 -- per-venue, not per-season                                             */
/* -------------------------------------------------------------------------- */

describe('W8: two venues 1.5 degrees of longitude apart get different limits', () => {
  // Plant: the provider reads the first venue's coordinates for every venue.
  const calendar = rigCalendar([
    { venueId: 'east', ...SYNTHETIC_EAST },
    { venueId: 'west', ...SYNTHETIC_WEST },
  ]);
  const east = Math.floor(
    sunsetOnDate({ date: RIG_DATE, ...SYNTHETIC_EAST, timeZone: TIME_ZONE }).minutes
  );
  const west = Math.floor(
    sunsetOnDate({ date: RIG_DATE, ...SYNTHETIC_WEST, timeZone: TIME_ZONE }).minutes
  );

  it('the two limits are minutes apart (meta)', () => {
    expect(west - east).toBeGreaterThanOrEqual(5);
  });

  it('one slot, legal in the west, illegal in the east', () => {
    const occ = rigOccurrences([
      { surfaceId: 'east/f', endMinutes: west },
      { surfaceId: 'west/f', endMinutes: west },
    ]);
    const result = evaluatePracticeDaylight({ occurrences: occ, graph: rigGraph, calendar });
    expect(result.flagged.map((v) => v.venueId)).toEqual(['east']);
    expect(result.allowed).toEqual([occ[1].id]);
    expect(result.flagged[0].sunsetSource).toBe('computed');
  });
});

/* -------------------------------------------------------------------------- */
/* W15 -- the margin is sunset itself                                          */
/* -------------------------------------------------------------------------- */

describe('W15: the practice margin is 0 -- ending at floor(sunset) is legal, a minute later is not', () => {
  // Plant: PRACTICE_SUNSET_MARGIN_MINUTES = 15.
  it('the constant is pinned to 0', () => {
    expect(PRACTICE_SUNSET_MARGIN_MINUTES).toBe(0);
  });

  it('computed sunset: the boundary minute is floor(sunset)', () => {
    const calendar = rigCalendar([{ venueId: 'east', ...SYNTHETIC_NORTH }]);
    const exact = sunsetOnDate({ date: RIG_DATE, ...SYNTHETIC_NORTH, timeZone: TIME_ZONE }).minutes;
    const floor = Math.floor(exact);
    expect(exact).not.toBe(floor); // the floor is doing work (meta)
    const occ = rigOccurrences([
      { surfaceId: 'east/f', endMinutes: floor },
      { surfaceId: 'east/f', endMinutes: floor + 1 },
    ]);
    const result = evaluatePracticeDaylight({ occurrences: occ, graph: rigGraph, calendar });
    expect(result.allowed).toEqual([occ[0].id]);
    expect(result.flagged.map((v) => v.occurrenceId)).toEqual([occ[1].id]);
    expect(result.flagged[0]).toMatchObject({ limitMinutes: floor, overrunMinutes: 1 });
  });

  it('table sunset: the same boundary', () => {
    const calendar = rigCalendar([], [{ date: RIG_DATE, sunsetMinutes: 18 * 60 + 30 }]);
    const occ = rigOccurrences([
      { surfaceId: 'dark/f', endMinutes: 18 * 60 + 30 },
      { surfaceId: 'dark/f', endMinutes: 18 * 60 + 31 },
    ]);
    const result = evaluatePracticeDaylight({ occurrences: occ, graph: rigGraph, calendar });
    expect(result.allowed).toEqual([occ[0].id]);
    expect(result.flagged.map((v) => v.occurrenceId)).toEqual([occ[1].id]);
    expect(result.flagged[0].sunsetSource).toBe('table');
  });
});

/* -------------------------------------------------------------------------- */
/* The provider: precedence and disagreement (D10)                             */
/* -------------------------------------------------------------------------- */

describe('daylight provider: table, then coordinates, then unknown', () => {
  const computed = sunsetOnDate({ date: RIG_DATE, ...SYNTHETIC_EAST, timeZone: TIME_ZONE }).minutes;

  it('the table wins where present, silently when within tolerance', () => {
    const near = Math.round(computed);
    const calendar = rigCalendar(
      [{ venueId: 'east', ...SYNTHETIC_EAST }],
      [{ date: RIG_DATE, sunsetMinutes: near }]
    );
    const answer = sunsetForVenue(calendar, { venueId: 'east', date: RIG_DATE });
    expect(answer).toMatchObject({ source: 'table', sunsetMinutes: near, findings: [] });
  });

  it('above 2 minutes apart: the table still wins and SUNSET_SOURCES_DISAGREE says so', () => {
    const off = Math.round(computed) + SUNSET_SOURCES_TOLERANCE_MINUTES + 2;
    const calendar = rigCalendar(
      [{ venueId: 'east', ...SYNTHETIC_EAST }],
      [{ date: RIG_DATE, sunsetMinutes: off }]
    );
    const answer = sunsetForVenue(calendar, { venueId: 'east', date: RIG_DATE });
    expect(answer.source).toBe('table');
    expect(answer.sunsetMinutes).toBe(off);
    expect(answer.findings.map((f) => f.code)).toEqual([
      AVAILABILITY_REASON.SUNSET_SOURCES_DISAGREE,
    ]);
  });

  it('no table row: computed from coordinates, floored', () => {
    const calendar = rigCalendar([{ venueId: 'east', ...SYNTHETIC_EAST }]);
    const answer = sunsetForVenue(calendar, { venueId: 'east', date: RIG_DATE });
    expect(answer).toMatchObject({ source: 'computed', sunsetMinutes: Math.floor(computed) });
  });

  it('refuses a half pair, a duplicate venue and coordinates without a zone', () => {
    expect(() =>
      buildAvailabilityCalendar({
        timeZone: TIME_ZONE,
        venueDaylight: [{ venueId: 'x', latitude: 40, longitude: null }],
      })
    ).toThrow();
    expect(() =>
      buildAvailabilityCalendar({
        timeZone: TIME_ZONE,
        venueDaylight: [
          { venueId: 'x', ...SYNTHETIC_EAST },
          { venueId: 'x', ...SYNTHETIC_WEST },
        ],
      })
    ).toThrow(/two daylight sources/);
    expect(() =>
      buildAvailabilityCalendar({ venueDaylight: [{ venueId: 'x', ...SYNTHETIC_EAST }] })
    ).toThrow(/timeZone/);
  });

  it('the game path is untouched: a calendar without the new inputs has no zone, no sources, no events', () => {
    const plain = buildAvailabilityCalendarFromSeason2026(permits, sunsets);
    expect(plain.timeZone).toBeNull();
    expect(plain.clockChanges).toEqual([]);
    expect(plain.stats.daylightVenueCount).toBe(0);
    expect(plain.stats.clockChangeNotesExamined).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* W11 -- DST is derived from the zone and matches the Note                    */
/* -------------------------------------------------------------------------- */

describe('W11: the DST season event is derived from the zone and matches the Note (D12)', () => {
  // Plant: the offset reader hardcodes -5 hours.
  it('the corpus calendar derives dst-end on 2026-11-01 and confirms both notes', () => {
    expect(corpusCalendar.clockChanges).toEqual([
      {
        name: SEASON_CLOCK_EVENT.DST_END,
        date: DST_END,
        offsetBeforeMinutes: -240,
        offsetAfterMinutes: -300,
      },
    ]);
    const notedRows = sunsets.filter((row) => parseClockChangeNote(row.note, row.date) !== null);
    expect(notedRows.length).toBeGreaterThan(0);
    expect(corpusCalendar.stats.clockChangeNotesExamined).toBe(notedRows.length);
    for (const row of notedRows)
      expect(parseClockChangeNote(row.note, row.date)?.date).toBe(DST_END);
    expect(corpusCalendar.findings.map((f) => f.code)).not.toContain(
      TIMING_REASON.CLOCK_CHANGE_NOTE_DISAGREES
    );
  });

  it('pre-DST rows read on the same clock as the table (an hour-sized error cannot hide)', () => {
    // Coarse on purpose: the synthetic point is not the corpus's location, so
    // only an error the size of a clock change (60 min) is being tested for.
    for (const row of sunsets) {
      const minutes = sunsetOnDate({
        date: row.date,
        ...SYNTHETIC_EAST,
        timeZone: TIME_ZONE,
      }).minutes;
      expect(Math.abs(minutes - row.sunsetMinutes)).toBeLessThan(30);
    }
  });

  it('negative control: a note naming the wrong date is reported', () => {
    const wrong = sunsets.map((row) => (row.note ? { ...row, note: 'DST ends 11/08' } : row));
    const calendar = buildAvailabilityCalendarFromSeason2026(permits, wrong, {
      timeZone: TIME_ZONE,
    });
    const found = calendar.findings.filter(
      (f) => f.code === TIMING_REASON.CLOCK_CHANGE_NOTE_DISAGREES
    );
    expect(found.length).toBe(wrong.filter((row) => row.note).length);
  });

  it('another zone gives its own date, from the zone rather than a US rule', () => {
    const { events } = deriveSeasonClockEvents({
      from: '2026-03-01',
      to: '2026-11-30',
      timeZone: 'Europe/London',
    });
    expect(events.map((e) => [e.name, e.date])).toEqual([
      [SEASON_CLOCK_EVENT.DST_START, '2026-03-29'],
      [SEASON_CLOCK_EVENT.DST_END, '2026-10-25'],
    ]);
  });
});
