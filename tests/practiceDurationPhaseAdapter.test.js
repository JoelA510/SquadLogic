/**
 * The duration-phase input adapter (`practice/durationPhaseAdapter.js`):
 * database rows in, the input of the three duration-phase reports out.
 *
 * Plan: `docs/changes/2026-11-02-duration-phases-wiring.md`, task A3. The
 * adapter's builders are a duplicate of `repairAdapter.js`'s, held to them here
 * by a parity test over one snapshot (lesson 77), and it adds three rules the
 * repair does not need: an undated slot is dated by the season window and never
 * skipped, a missing season zone is an error, and an unreadable `school_day_end`
 * is `null` so a shift is refused.
 *
 * **Every expected value is derived from the INPUT rows and plain date
 * arithmetic**, never from the adapter's or the reports' output: the slots to
 * be judged are enumerated from `practiceSlots` (so a slot with no assignment,
 * or with no dates, must still be there), the dates by counting weekdays in the
 * season, the ground's lighting by following a slot's field to its location row.
 * Synthetic data only: no real venue, club, person or coordinate (40.00/-75.00
 * is a round number, not a place).
 */

import { describe, expect, it } from 'vitest';

import {
  DURATION_PHASE_OVERRIDE_NOT_APPLIED,
  PRACTICE_LIGHTING_OVERRIDE_KIND,
  PRACTICE_LIGHTING_OVERRIDE_STATUS,
  PRACTICE_RETIME_KIND,
  PRACTICE_RETIME_REFUSAL,
  PRACTICE_SURVIVAL_VERDICT,
  buildDstSurvivalReport,
  buildDurationPhaseInput,
  buildPracticeCompressionReport,
  buildPracticeRepairInput,
  derivePracticeDurationPhases,
} from '@squadlogic/core/practice/index.js';

/* -- synthetic rows ------------------------------------------------------- */

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LOC_DARK = uuid(101); // unlit, coordinates as strings (PostgREST `numeric`)
const LOC_BRIGHT = uuid(102); // lit
const LOC_BLIND = uuid(103); // unlit, only a latitude: no coordinate pair
const [F_DARK_1, F_DARK_2, F_BRIGHT, F_BLIND] = [uuid(201), uuid(202), uuid(203), uuid(204)];
const SUB_DARK_2A = uuid(251); // a sub-unit of F_DARK_2
const SL = Object.fromEntries(
  ['dated', 'wed', 'sub', 'lit', 'undated', 'noTeam', 'half', 'blind', 'expired'].map((name, i) => [
    name,
    uuid(501 + i),
  ])
);
const BLACKOUT = uuid(701);
const RANGE = '[2026-09-01,2026-12-01)';

const SEASON_FROM = '2026-09-01';
const SEASON_TO = '2026-11-30';
const SEASON = Object.freeze({
  timezone: 'America/New_York',
  season_start: SEASON_FROM,
  season_end: SEASON_TO,
  school_day_end: '16:00:00',
});

const locations = () => [
  {
    id: LOC_DARK.toUpperCase(), // read back in any case; the graph lowercases
    name: 'Dark Park',
    lighting_available: false,
    latitude: '40.00',
    longitude: '-75.00',
  },
  {
    id: LOC_BRIGHT,
    name: 'Bright Park',
    lighting_available: true,
    latitude: null,
    longitude: null,
  },
  {
    id: LOC_BLIND,
    name: 'Blind Park',
    lighting_available: false,
    latitude: '40.00',
    longitude: null,
  },
];
const FIELDS = [
  { id: F_DARK_1, location_id: LOC_DARK, name: 'Field 1' },
  { id: F_DARK_2, location_id: LOC_DARK, name: 'Field 2' },
  { id: F_BRIGHT, location_id: LOC_BRIGHT, name: 'Field 3' },
  { id: F_BLIND, location_id: LOC_BLIND, name: 'Field 4' },
];
const SUBUNITS = [{ id: SUB_DARK_2A, field_id: F_DARK_2, label: 'Half A' }];
const slotRow = (id, field, day, start, end, validFrom, validUntil, subunit = null) => ({
  id,
  field_id: field,
  field_subunit_id: subunit,
  day_of_week: day,
  start_time: start,
  end_time: end,
  valid_from: validFrom,
  valid_until: validUntil,
});
const SLOTS = [
  slotRow(SL.dated, F_DARK_1, 'mon', '17:00:00', '18:00:00', SEASON_FROM, SEASON_TO),
  slotRow(SL.wed, F_DARK_2, 'wed', '18:00:00', '19:00:00', SEASON_FROM, SEASON_TO),
  slotRow(SL.sub, F_DARK_2, 'tue', '17:00:00', '18:00:00', SEASON_FROM, SEASON_TO, SUB_DARK_2A),
  slotRow(SL.lit, F_BRIGHT, 'mon', '17:00:00', '18:00:00', SEASON_FROM, SEASON_TO),
  // No dates of its own at all.
  slotRow(SL.undated, F_DARK_1, 'thu', '17:00:00', '18:00:00', null, null),
  // Dated, and nobody is assigned to it.
  slotRow(SL.noTeam, F_DARK_1, 'sat', '09:00:00', '10:00:00', SEASON_FROM, SEASON_TO),
  // Half-dated: a start, and no end.
  slotRow(SL.half, F_DARK_2, 'sun', '10:00:00', '11:00:00', '2026-10-05', null),
  slotRow(SL.blind, F_BLIND, 'mon', '17:00:00', '18:00:00', SEASON_FROM, SEASON_TO),
  // Ended before the season began, and says only that.
  slotRow(SL.expired, F_DARK_1, 'fri', '17:00:00', '18:00:00', null, '2026-08-15'),
];
const assignment = (id, team, slotId) => ({
  id,
  team_id: team,
  practice_slot_id: slotId,
  effective_date_range: RANGE,
  source: 'auto',
});
const ASSIGNMENTS = [
  assignment(uuid(601), uuid(301), SL.dated),
  assignment(uuid(602), uuid(302), SL.wed),
  assignment(uuid(603), uuid(303), SL.sub),
  assignment(uuid(604), uuid(304), SL.lit),
  assignment(uuid(605), uuid(305), SL.undated),
  assignment(uuid(606), uuid(306), SL.blind),
];
/** @param {string} slotId @param {string} window @param {string} [status] */
const override = (slotId, window, status = PRACTICE_LIGHTING_OVERRIDE_STATUS.APPROVED) => ({
  practice_slot_id: slotId,
  window,
  kind: PRACTICE_LIGHTING_OVERRIDE_KIND,
  status,
});

/** The rows a caller reads, with anything replaced. */
const rowsWith = (replace = {}) => ({
  locations: locations(),
  fields: FIELDS,
  fieldSubunits: SUBUNITS,
  practiceSlots: SLOTS,
  practiceAssignments: ASSIGNMENTS,
  lightingOverrides: [],
  season: { ...SEASON },
  ...replace,
});

/* -- arithmetic, independent of the adapter ------------------------------- */

const MS_PER_DAY = 86_400_000;
const WEEKDAYS = ['THU', 'FRI', 'SAT', 'SUN', 'MON', 'TUE', 'WED']; // day number 0 is Thursday
const dayNumber = (iso) =>
  Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / MS_PER_DAY;
const isoOf = (day) => new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
const weekdayOf = (iso) => WEEKDAYS[((dayNumber(iso) % 7) + 7) % 7];
/** The dates of a weekday between two dates, both inclusive. */
const datesOf = (weekday, from, to) => {
  const out = [];
  for (let day = dayNumber(from); day <= dayNumber(to); day += 1) {
    if (weekdayOf(isoOf(day)) === weekday) out.push(isoOf(day));
  }
  return out;
};
/** Is a slot row on unlit ground, followed from its field to its location row? */
const isUnlitRow = (row) => {
  const field = FIELDS.find((candidate) => candidate.id === row.field_id);
  const location = locations().find(
    (candidate) => candidate.id.toLowerCase() === field.location_id
  );
  return location.lighting_available !== true;
};
const upper = (row) => String(row.day_of_week).toUpperCase();

/** What the season rule dates each partly or wholly undated row by, written by hand. */
const SEASON_DATING = Object.freeze({
  [SL.undated]: [SEASON_FROM, SEASON_TO],
  [SL.half]: ['2026-10-05', SEASON_TO],
  // Its end is before the season: it stays before the season, not stretched across it.
  [SL.expired]: ['2026-08-15', '2026-08-15'],
});

/* -------------------------------------------------------------------------- */
/* Held to the repair adapter                                                  */
/* -------------------------------------------------------------------------- */

describe('A3: the builders are held to the repair adapter (the twin is a tested twin)', () => {
  // Not planted in this PR (the cap is three); the last test here is the control:
  // it changes one side's rows only and shows the comparisons see it.
  const repairRows = (rows) => ({
    locations: rows.locations,
    fields: rows.fields,
    fieldSubunits: rows.fieldSubunits,
    practiceSlots: rows.practiceSlots,
    practiceAssignments: rows.practiceAssignments,
    loss: {
      kind: /** @type {'blackout'} */ ('blackout'),
      blackout: {
        id: BLACKOUT,
        field_id: F_DARK_1,
        location_id: null,
        blackout_from: '2026-10-01',
        blackout_until: '2026-10-02',
        start_minutes: null,
        end_minutes: null,
        reason: 'maintenance',
      },
    },
    daylight: { timeZone: rows.season.timezone, sunsets: [] },
  });
  const mine = buildDurationPhaseInput(rowsWith());
  const repair = buildPracticeRepairInput(repairRows(rowsWith()));
  const pick = (slot) => ({
    id: slot.id,
    surfaceId: slot.surfaceId,
    weekday: slot.weekday,
    startMinutes: slot.startMinutes,
    durationMinutes: slot.durationMinutes,
    validFrom: slot.validFrom,
    validUntil: slot.validUntil,
  });

  it('the graph equals the repair’s: venues are locations, a sub-unit is a child, lighting is the flag', () => {
    expect(mine.input.graph).toEqual(repair.input.graph);
    // ... and it is the graph the rows describe, not two empty ones agreeing.
    expect(Object.keys(mine.input.graph.venues).sort()).toEqual(
      [LOC_DARK, LOC_BRIGHT, LOC_BLIND].sort()
    );
    expect(mine.input.graph.surfaces[SUB_DARK_2A].parentId).toBe(F_DARK_2);
    expect(mine.input.graph.venues[LOC_BRIGHT].lit).toBe(true);
  });

  it('the calendar equals the repair’s: string coordinates are read, half a pair is none', () => {
    expect(mine.input.calendar).toEqual(repair.input.calendar);
    const { daylightByVenue } = mine.input.calendar;
    expect(daylightByVenue[LOC_DARK]).toMatchObject({ latitude: 40, longitude: -75 });
    expect(daylightByVenue[LOC_BLIND]).toMatchObject({ latitude: null, longitude: null });
  });

  it('the slots equal the repair’s, but for the dates the season gives a slot that has none', () => {
    const repairSlots = repair.input.plan.slots;
    expect(repairSlots).toHaveLength(SLOTS.length);
    const expected = repairSlots.map((slot) => {
      const dating = SEASON_DATING[slot.id];
      if (dating === undefined) return slot;
      // The repair keeps what the row says: a null end. That is the difference.
      expect(slot.validFrom === null || slot.validUntil === null).toBe(true);
      return { ...slot, validFrom: dating[0], validUntil: dating[1] };
    });
    expect(mine.input.slotSet.slots.map(pick)).toEqual(expected);
  });

  it('the assignments equal the repair’s', () => {
    expect(mine.input.slotSet.assignments).toEqual(repair.input.plan.assignments);
    expect(mine.input.slotSet.assignments).toHaveLength(ASSIGNMENTS.length);
  });

  it('the comparison can fail: a lighting flag changed on one side only is seen', () => {
    const changed = rowsWith({
      locations: locations().map((row, i) =>
        i === 0 ? { ...row, lighting_available: true } : row
      ),
    });
    const other = buildPracticeRepairInput(repairRows(changed));
    expect(mine.input.graph).not.toEqual(other.input.graph);
    const moved = rowsWith({
      locations: locations().map((row, i) => (i === 0 ? { ...row, latitude: '41.00' } : row)),
    });
    expect(mine.input.calendar).not.toEqual(
      buildPracticeRepairInput(repairRows(moved)).input.calendar
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The subject set comes from the rows                                         */
/* -------------------------------------------------------------------------- */

describe('A3: every slot row is judged -- the subject set is the rows, not the assignments', () => {
  // Plant (P3): enumerate the slots from the assignments' slot ids. The slot
  // nobody is assigned to, and the one with no dates of its own, vanish from the
  // reports, and this goes red.
  const { input, declared } = buildDurationPhaseInput(rowsWith());

  it('the slot set holds exactly the slot rows read, assigned or not', () => {
    const expected = SLOTS.map((row) => row.id).sort();
    expect(input.slotSet.slots.map((slot) => slot.id).sort()).toEqual(expected);
    const assigned = new Set(ASSIGNMENTS.map((row) => row.practice_slot_id));
    // The cases are not vacuous: some rows have no assignment at all.
    expect(SLOTS.filter((row) => !assigned.has(row.id)).length).toBeGreaterThan(0);
  });

  it('a slot with no dates is dated by the season window, named, and judged: never "undated"', () => {
    expect(declared.datedBySeasonWindow).toEqual([SL.undated, SL.half, SL.expired]);
    const survival = buildDstSurvivalReport(input);
    expect(survival.undatedSlotIds).toEqual([]);
    const schedule = derivePracticeDurationPhases(input);
    expect(schedule.undatedSlotIds).toEqual([]);
    expect(schedule.meta.undatedSlots).toBe(0);
    const undated = survival.rows.find((row) => row.slotId === SL.undated);
    // 13 Thursdays in the season, counted here by arithmetic.
    expect(datesOf('THU', SEASON_FROM, SEASON_TO)).toHaveLength(13);
    expect(undated.datesExamined).toBe(datesOf('THU', SEASON_FROM, SEASON_TO).length);
    const half = survival.rows.find((row) => row.slotId === SL.half);
    expect(half.datesExamined).toBe(datesOf('SUN', '2026-10-05', SEASON_TO).length);
  });

  it('a slot that ended before the season is left before it: no dates, never stretched', () => {
    const survival = buildDstSurvivalReport(input);
    const expired = survival.rows.find((row) => row.slotId === SL.expired);
    expect(expired.verdict).toBe(PRACTICE_SURVIVAL_VERDICT.NO_DATES);
    expect(expired.datesExamined).toBe(0);
    // And one that starts after it ends, with no end of its own, likewise.
    const late = buildDurationPhaseInput(
      rowsWith({
        practiceSlots: [
          slotRow(SL.expired, F_DARK_1, 'fri', '17:00:00', '18:00:00', '2026-12-10', null),
        ],
        practiceAssignments: [],
      })
    );
    const [slot] = late.input.slotSet.slots;
    expect([slot.validFrom, slot.validUntil]).toEqual(['2026-12-10', '2026-12-10']);
    expect(buildDstSurvivalReport(late.input).rows[0].verdict).toBe(
      PRACTICE_SURVIVAL_VERDICT.NO_DATES
    );
  });

  it('the survival report has a row for every unlit slot row and lists the lit one apart', () => {
    const unlit = SLOTS.filter(isUnlitRow).map((row) => row.id);
    expect(unlit.length).toBeGreaterThan(0);
    const survival = buildDstSurvivalReport(input);
    expect(survival.rows.map((row) => row.slotId).sort()).toEqual([...unlit].sort());
    expect(survival.litSlotIds).toEqual([SL.lit]);
    expect(survival.exercised).toBe(true);
    // The date counts are the weekday counts of each row, followed by hand.
    for (const row of survival.rows) {
      const source = SLOTS.find((candidate) => candidate.id === row.slotId);
      const dating = SEASON_DATING[source.id] ?? [source.valid_from, source.valid_until];
      const from = dating[0] > SEASON_FROM ? dating[0] : SEASON_FROM;
      const to = dating[1] < SEASON_TO ? dating[1] : SEASON_TO;
      expect(row.datesExamined).toBe(datesOf(upper(source), from, to).length);
    }
  });

  it('a venue with no coordinate pair is `unknown` on every date, never surviving', () => {
    const survival = buildDstSurvivalReport(input);
    const blind = survival.rows.find((row) => row.slotId === SL.blind);
    expect(blind.verdict).toBe(PRACTICE_SURVIVAL_VERDICT.UNKNOWN);
    expect(blind.unknownDates).toEqual(datesOf('MON', SEASON_FROM, SEASON_TO));
    expect(survival.meta.slotsSurviving).toBe(
      survival.rows.filter((row) => row.verdict === PRACTICE_SURVIVAL_VERDICT.SURVIVES).length
    );
  });

  it('all three reports run on the output, as the page will call them', () => {
    const schedule = derivePracticeDurationPhases(input);
    expect(schedule.exercised).toBe(true);
    expect(schedule.slotPhases.length).toBe(SLOTS.filter(isUnlitRow).length);
    const compression = buildPracticeCompressionReport({
      slotSet: input.slotSet,
      graph: input.graph,
      calendar: input.calendar,
      phaseSchedule: schedule,
    });
    expect(compression.exercised).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The season: zone, window, school_day_end                                    */
/* -------------------------------------------------------------------------- */

describe('A3: the season zone and window are required; school_day_end is known or refused', () => {
  // Not planted in this PR (the cap is three): a missing zone read as UTC would
  // return instead of throwing, and the calendar would say 'UTC'; both are asserted.
  it('no zone is an error, never a guess', () => {
    for (const timezone of [null, undefined, '', '   ', 42]) {
      expect(() => buildDurationPhaseInput(rowsWith({ season: { ...SEASON, timezone } }))).toThrow(
        /no time zone/
      );
    }
  });

  it('a zone the runtime does not know is an error naming it', () => {
    expect(() =>
      buildDurationPhaseInput(rowsWith({ season: { ...SEASON, timezone: 'Mars/Olympus' } }))
    ).toThrow(/"Mars\/Olympus" is not one this runtime knows/);
  });

  it('the calendar is built on the season’s own zone', () => {
    const eastern = buildDurationPhaseInput(rowsWith());
    const pacific = buildDurationPhaseInput(
      rowsWith({ season: { ...SEASON, timezone: 'America/Los_Angeles' } })
    );
    expect(eastern.input.calendar.timeZone).toBe('America/New_York');
    expect(pacific.input.calendar.timeZone).toBe('America/Los_Angeles');
    expect(eastern.declared.timeZone).toBe('America/New_York');
  });

  it('a season with no dates, one that ends before it starts, or no row at all is an error', () => {
    for (const patch of [{ season_start: null }, { season_end: null }, { season_end: 'soon' }]) {
      expect(() => buildDurationPhaseInput(rowsWith({ season: { ...SEASON, ...patch } }))).toThrow(
        /no start and end date/
      );
    }
    expect(() =>
      buildDurationPhaseInput(
        rowsWith({ season: { ...SEASON, season_start: '2026-11-30', season_end: '2026-09-01' } })
      )
    ).toThrow(/ends \(2026-09-01\) before it starts/);
    for (const season of [undefined, null]) {
      expect(() => buildDurationPhaseInput(rowsWith({ season }))).toThrow(/settings were not read/);
    }
  });

  it('the window is the season’s dates', () => {
    const { input, declared } = buildDurationPhaseInput(rowsWith());
    expect(input.window).toEqual({ from: SEASON_FROM, to: SEASON_TO });
    expect(declared.window).toEqual({ from: SEASON_FROM, to: SEASON_TO });
  });

  it('school_day_end: a time is minutes; absent or unreadable is null, with the reason', () => {
    const read = (school_day_end) =>
      buildDurationPhaseInput(rowsWith({ season: { ...SEASON, school_day_end } }));
    expect(read('16:00:00').input.earliestStartMinutes).toBe(16 * 60);
    expect(read('16:00').input.earliestStartMinutes).toBe(16 * 60);
    expect(read('09:30:00').input.earliestStartMinutes).toBe(9 * 60 + 30);
    expect(read('16:00:00').declared.earliestStart).toEqual({ minutes: 16 * 60, note: null });
    for (const value of [null, undefined]) {
      const { input, declared } = read(value);
      expect(input.earliestStartMinutes).toBeNull();
      expect(declared.earliestStart.note).toMatch(/no school_day_end/);
    }
    for (const value of ['', 'abc', '25:00:00', '24:00:00', '16:60', '16:00:30', 1600]) {
      const { input, declared } = read(value);
      expect(input.earliestStartMinutes).toBeNull();
      expect(declared.earliestStart.note).toMatch(/not a whole-minute time of day/);
    }
  });

  it('without a known school_day_end a shift is refused with its reason, never assumed', () => {
    // SL.wed is a Wednesday 18:00-19:00 on unlit ground at a venue with
    // coordinates. In late September and October the sun sets between about
    // 18:20 and 18:00 on those evenings, so the hour ends 40 to 60 minutes past
    // sunset: shortening to the 40-minute minimum cannot save it, and moving
    // earlier can, but only if the earliest start is known. SL.dated, a Monday
    // 17:00-18:00, is past saving by November whatever the floor is.
    const run = (school_day_end) => {
      const { input } = buildDurationPhaseInput(
        rowsWith({ season: { ...SEASON, school_day_end } })
      );
      const schedule = derivePracticeDurationPhases(input);
      const timeline = (slotId) => schedule.slotPhases.find((entry) => entry.slotId === slotId);
      const refusals = schedule.slotPhases.flatMap((entry) =>
        entry.flagged.map((flag) => flag.shiftRefused)
      );
      return { schedule, timeline, refusals };
    };

    const unknown = run('not a time');
    const flaggedWed = unknown.timeline(SL.wed).flagged;
    expect(flaggedWed.length).toBeGreaterThan(0);
    expect(new Set(flaggedWed.map((flag) => flag.shiftRefused))).toEqual(
      new Set([PRACTICE_RETIME_REFUSAL.EARLIEST_START_UNKNOWN])
    );
    // No floor, so nothing is ever shifted: not by choice, not as the fallback.
    expect(unknown.schedule.meta.fallbackShifts).toBe(0);
    expect(unknown.schedule.meta.shifts).toBe(0);
    expect(new Set(unknown.refusals)).toEqual(
      new Set([PRACTICE_RETIME_REFUSAL.EARLIEST_START_UNKNOWN])
    );

    const known = run('16:00:00');
    const kindsWed = known.timeline(SL.wed).phases.map((phase) => phase.retime);
    expect(kindsWed).toContain(PRACTICE_RETIME_KIND.FALLBACK_SHIFT);
    // A known floor is a reason of its own: SL.dated is refused by it in November.
    expect(known.timeline(SL.dated).flagged.map((flag) => flag.shiftRefused)).toContain(
      PRACTICE_RETIME_REFUSAL.EARLIEST_START_FLOOR
    );
    expect(known.refusals).not.toContain(PRACTICE_RETIME_REFUSAL.EARLIEST_START_UNKNOWN);
  });
});

/* -------------------------------------------------------------------------- */
/* Portable lighting                                                           */
/* -------------------------------------------------------------------------- */

describe('A3: approved portable-lighting windows exempt a slot; the ones the module would refuse are named', () => {
  const OCT_12_TO_19 = '[2026-10-12,2026-10-20)'; // stored with the end exclusive
  const rows = rowsWith({
    lightingOverrides: [
      override(SL.dated, OCT_12_TO_19),
      override(SL.wed, '[2026-10-14,2026-10-21)', PRACTICE_LIGHTING_OVERRIDE_STATUS.REQUESTED),
      override(SL.wed, '[2026-10-21,2026-10-22)', PRACTICE_LIGHTING_OVERRIDE_STATUS.REJECTED),
      override(SL.lit, OCT_12_TO_19),
      override(uuid(999), OCT_12_TO_19),
    ],
  });
  const { input, declared } = buildDurationPhaseInput(rows);

  it('only the approved window on an unlit slot is passed, as inclusive dates', () => {
    expect(input.lightingOverrides).toEqual([
      { slotId: SL.dated, from: '2026-10-12', until: '2026-10-19' },
    ]);
  });

  it('a window on lit ground or on no slot read is named, not passed and not dropped silently', () => {
    expect(declared.lightingOverrides).toEqual({
      rowsRead: 5,
      approved: 3,
      applied: 1,
      notApplied: [
        {
          slotId: SL.lit,
          from: '2026-10-12',
          until: '2026-10-19',
          why: DURATION_PHASE_OVERRIDE_NOT_APPLIED.LIT_GROUND,
        },
        {
          slotId: uuid(999),
          from: '2026-10-12',
          until: '2026-10-19',
          why: DURATION_PHASE_OVERRIDE_NOT_APPLIED.UNKNOWN_SLOT,
        },
      ],
    });
  });

  it('the reports run (the module would have refused those windows) and exempt exactly the window’s Mondays', () => {
    const survival = buildDstSurvivalReport(input);
    const row = survival.rows.find((candidate) => candidate.slotId === SL.dated);
    expect(row.exemptDates).toEqual(datesOf('MON', '2026-10-12', '2026-10-19'));
    expect(row.exemptDates).toEqual(['2026-10-12', '2026-10-19']);
    const schedule = derivePracticeDurationPhases(input);
    expect(schedule.meta.slotDatesExempt).toBe(2);
    // The same read with the window passed on the lit slot directly is the module's refusal:
    // the adapter is what keeps that from taking the whole report down.
    expect(() =>
      derivePracticeDurationPhases({
        ...input,
        lightingOverrides: [{ slotId: SL.lit, from: '2026-10-12', until: '2026-10-19' }],
      })
    ).toThrow(/no unlit, dated slot in this plan/);
  });

  it('a malformed row is refused, not read as no window', () => {
    expect(() =>
      buildDurationPhaseInput(
        rowsWith({ lightingOverrides: [{ ...override(SL.dated, OCT_12_TO_19), status: 'maybe' }] })
      )
    ).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Trust boundary: a partial or unreadable read is refused                     */
/* -------------------------------------------------------------------------- */

describe('A3: a table that was not read, or a row that cannot be read, refuses the input', () => {
  it('each table missing is named', () => {
    for (const key of [
      'locations',
      'fields',
      'fieldSubunits',
      'practiceSlots',
      'practiceAssignments',
      'lightingOverrides',
    ]) {
      const rows = rowsWith();
      delete rows[key];
      expect(() => buildDurationPhaseInput(rows)).toThrow(`${key} were not read`);
      expect(() => buildDurationPhaseInput({ ...rowsWith(), [key]: null })).toThrow(
        `${key} were not read`
      );
    }
  });

  it('a location that is not a uuid, a sub-unit of an unread field, a slot with no ground or time', () => {
    expect(() =>
      buildDurationPhaseInput(
        rowsWith({ locations: [{ ...locations()[0], id: 'north-park' }, ...locations().slice(1)] })
      )
    ).toThrow(/is not a uuid/);
    expect(() =>
      buildDurationPhaseInput(
        rowsWith({ fieldSubunits: [{ id: uuid(260), field_id: uuid(299), label: 'Half' }] })
      )
    ).toThrow(/names an unread field/);
    const bad = (patch) =>
      rowsWith({ practiceSlots: [{ ...SLOTS[0], ...patch }], practiceAssignments: [] });
    expect(() => buildDurationPhaseInput(bad({ field_id: null, field_subunit_id: null }))).toThrow(
      /names no field/
    );
    expect(() => buildDurationPhaseInput(bad({ start_time: '5pm' }))).toThrow(
      /not a whole-minute time/
    );
    expect(() => buildDurationPhaseInput(bad({ day_of_week: 'someday' }))).toThrow(/day_of_week/);
    expect(() => buildDurationPhaseInput(bad({ end_time: '17:00:00' }))).toThrow(
      /does not end after it starts/
    );
  });

  it('an assignment on a slot that was not read, or with a range that cannot be read', () => {
    expect(() =>
      buildDurationPhaseInput(
        rowsWith({ practiceAssignments: [assignment(uuid(690), uuid(390), uuid(998))] })
      )
    ).toThrow(/names unread slot/);
    expect(() =>
      buildDurationPhaseInput(
        rowsWith({
          practiceAssignments: [
            {
              ...assignment(uuid(691), uuid(391), SL.dated),
              effective_date_range: '[2026-09-01,)',
            },
          ],
        })
      )
    ).toThrow(/no readable effective_date_range/);
  });
});
