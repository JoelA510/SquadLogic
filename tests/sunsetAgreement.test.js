/**
 * Cross-arm agreement: what core's practice repair (`practice/repair.js`) and the Deno
 * auto-scheduler's daylight post-pass (`_shared/engines/practice-daylight.ts`) do with one weekly
 * practice on one venue, over the full product of what can differ.
 *
 * **Owner, 2026-11-02:** an unknown sunset is flagged, never refused ("refusal would break configs
 * that users may otherwise stick with"). The Edge pass has flagged it since 8.9 PR 6 (D4); the repair
 * refused it until now. Neither arm may refuse any case below, and both must put every case in the
 * same class:
 *
 * - `exempt`  lit ground, or every date under a portable-lighting override;
 * - `within`  every judged date ends by `floor(sunset)`;
 * - `past`    a judged date ends after it: kept and flagged (owner, 2026-10-27);
 * - `unknown` a judged date has no sunset (no coordinates here): kept and flagged, with the cause
 *             and the first date and the number of dates both arms report.
 *
 * There was no daylight drift test before this one (the three product digests under
 * `supabase/functions/_shared/tests/` cover coach preferences, lighting overrides and practice
 * exceptions), which is how the two arms could disagree about an unknown sunset without any test
 * saying so. The expected class of each case comes from an ORACLE written from the rule and plain
 * date arithmetic, never from either arm; the product's size is the arithmetic of its dimensions,
 * not the enumerator's length.
 *
 * Coordinates are synthetic (40.00/-75.00). Nothing geocodes.
 */
import { describe, expect, it } from 'vitest';

import { buildAvailabilityCalendar } from '@squadlogic/core/availability/index.js';
import { buildFacilityGraph } from '@squadlogic/core/facility/index.js';
import { repairPracticeLoss } from '@squadlogic/core/practice/index.js';
import { sunsetEnforcementMinutes, sunsetOnDate } from '@squadlogic/core/timing/index.js';
import {
  DAYLIGHT_UNKNOWN_CAUSE,
  applyDaylightPostPass,
} from '../supabase/functions/_shared/engines/practice-daylight.js';

const ZONE = 'America/New_York';
const COORDINATES = Object.freeze({ latitude: 40.0, longitude: -75.0 });
/** The window both arms judge: Tuesdays from the first to the last, DST ending 2026-11-01. */
const FROM = '2026-10-06';
const UNTIL = '2026-11-24';
const SLOT_VALID_FROM = '2026-09-01';

/* -- the oracle: plain date arithmetic, the rule, and the solar function ------------------------ */

const MS_PER_DAY = 86_400_000;
const dayNumber = (iso) =>
  Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / MS_PER_DAY;
const isoOf = (day) => new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
/** Every Tuesday (day 0 = 1970-01-01, a Thursday; Tuesday is 5 days on) in `[from, until]`. */
const tuesdays = (from, until) => {
  const out = [];
  for (let day = dayNumber(from); day <= dayNumber(until); day += 1) {
    if (((day % 7) + 7) % 7 === 5) out.push(isoOf(day));
  }
  return out;
};
const WINDOW_DATES = tuesdays(FROM, UNTIL);

/** The limit on a date at the synthetic point: the floor of the solar sunset (margin 0). */
const limitOn = (date) =>
  sunsetEnforcementMinutes(sunsetOnDate({ date, ...COORDINATES, timeZone: ZONE }));

/**
 * @param {{ lighting: string, coordinates: string, practice: string, override: string }} c one of
 *   {@link DIMENSIONS}' values on each axis
 */
function oracle(c) {
  if (c.lighting === 'lit') return { class: 'exempt', unknownDates: [] };
  const overrideUntil = /** @type {Record<string, string|null>} */ ({
    none: null,
    whole: UNTIL,
    'before-dst': '2026-10-31',
  })[c.override];
  const judged = WINDOW_DATES.filter((date) => overrideUntil === null || date > overrideUntil);
  if (judged.length === 0) return { class: 'exempt', unknownDates: [] };
  if (c.coordinates === 'none') return { class: 'unknown', unknownDates: judged };
  const end = c.practice === 'early' ? 16 * 60 : 17 * 60;
  return judged.some((date) => end > limitOn(date))
    ? { class: 'past', unknownDates: [] }
    : { class: 'within', unknownDates: [] };
}

/* -- the product ---------------------------------------------------------------------------------- */

const DIMENSIONS = Object.freeze({
  lighting: ['lit', 'unlit', 'undeclared'],
  coordinates: ['none', 'present'],
  practice: ['early', 'late'],
  override: ['none', 'whole', 'before-dst'],
});
/** The product's size from the dimensions' arithmetic, not from the enumerator below. */
const EXPECTED_CASES = 3 * 2 * 2 * 3;

const CASES = DIMENSIONS.lighting.flatMap((lighting) =>
  DIMENSIONS.coordinates.flatMap((coordinates) =>
    DIMENSIONS.practice.flatMap((practice) =>
      DIMENSIONS.override.map((override) => ({ lighting, coordinates, practice, override }))
    )
  )
);
const name = (c) => `${c.lighting}/${c.coordinates}/${c.practice}/${c.override}`;
const startMinutes = (c) => (c.practice === 'early' ? 15 * 60 : 16 * 60);
const overrideWindow = (c) =>
  c.override === 'none'
    ? []
    : [{ from: '2026-10-05', until: c.override === 'whole' ? UNTIL : '2026-10-31' }];

/* -- the core arm: one displaced series, one candidate on the same venue -------------------------- */

function coreArm(c) {
  const lit = { lit: true, unlit: false, undeclared: null }[c.lighting];
  const graph = buildFacilityGraph({
    venues: [{ id: 'v', name: 'v', lit }],
    surfaces: ['f1', 'f2'].map((field) => ({
      id: `v/${field}`,
      venueId: 'v',
      name: field,
      sizes: ['7v7'],
      lined: ['7v7'],
    })),
  });
  const shape = {
    weekday: 'TUE',
    startMinutes: startMinutes(c),
    durationMinutes: 60,
    validFrom: SLOT_VALID_FROM,
    validUntil: UNTIL,
    capacity: 1,
    revisionId: 'r1',
    label: null,
    surfaceResolution: 'resolved',
  };
  const input = {
    plan: {
      // s0 is the series on the lost ground; x1 is the plan slot of the candidate's shape that an
      // override is placed on (a candidate is a shape, and it is exempt only when every plan slot of
      // that shape is overridden).
      slots: [
        { id: 's0', surfaceId: 'v/f1', ...shape },
        { id: 'x1', surfaceId: 'v/f2', ...shape },
      ],
      assignments: [{ id: 'a0', slotId: 's0', teamId: 'T1' }],
    },
    graph,
    loss: { surfaceIds: ['v/f1'], from: '2026-10-05', reason: 'field retired' },
    inventory: [
      { surfaceId: 'v/f2', weekday: 'TUE', startMinutes: startMinutes(c), durationMinutes: 60 },
    ],
    calendar: buildAvailabilityCalendar({
      permitWindows: [],
      timeZone: ZONE,
      venueDaylight: c.coordinates === 'present' ? [{ venueId: 'v', ...COORDINATES }] : [],
      sunsets: [],
    }),
    lightingOverrides: overrideWindow(c).map((window) => ({ slotId: 'x1', ...window })),
  };
  const result = repairPracticeLoss(input);
  const kept = result.rehomed.length === 1 && result.timeTbd.length === 0;
  const entry = result.rehomed[0];
  const d = result.daylight;
  let cls = 'unclassified';
  if (entry?.daylightSunsetUnknown) cls = 'unknown';
  else if (entry?.daylightPastSunset) cls = 'past';
  else if (d.candidatesLitExempt > 0 || d.candidatesLightingOverrideExempt > 0) cls = 'exempt';
  else if (d.candidatesWithinDaylight > 0) cls = 'within';
  return {
    kept,
    class: cls,
    unknown: entry?.daylightSunsetUnknown ?? null,
    flagsBoth: Boolean(entry?.daylightSunsetUnknown && entry?.daylightPastSunset),
  };
}

/* -- the Edge arm: one placement in the same slot on the same venue ------------------------------- */

function edgeArm(c) {
  const lit = { lit: true, unlit: false, undeclared: null }[c.lighting];
  const start = startMinutes(c);
  const slot = {
    id: 's1',
    fieldId: 'f1',
    firstDate: SLOT_VALID_FROM,
    effectiveUntil: UNTIL,
    startSeconds: start * 60,
    endSeconds: (start + 60) * 60,
    endMinutes: start + 60,
  };
  const venue = {
    fieldId: 'f1',
    locationId: 'l1',
    lit,
    latitude: c.coordinates === 'present' ? COORDINATES.latitude : null,
    longitude: c.coordinates === 'present' ? COORDINATES.longitude : null,
  };
  const placement = { teamId: 't1', slotId: 's1', source: /** @type {'auto'} */ ('auto') };
  const pass = applyDaylightPostPass({
    placements: [placement],
    unassigned: [],
    locked: [],
    slots: new Map([['s1', slot]]),
    venues: new Map([['f1', venue]]),
    timeZone: ZONE,
    today: FROM,
    lightingOverrides: overrideWindow(c).map((window) => ({ slotId: 's1', ...window })),
  });
  const { meta } = pass.report;
  let cls = 'unclassified';
  if (pass.report.unknown.length > 0) cls = 'unknown';
  else if (pass.report.pastSunset.length > 0) cls = 'past';
  else if (meta.litPlacementsExempt > 0) cls = 'exempt';
  else if (meta.occurrencesWithinDaylight > 0) cls = 'within';
  else if (meta.lightingOverrideOccurrencesExempt > 0) cls = 'exempt';
  return {
    kept: pass.placements.length === 1 && pass.placements[0] === placement,
    class: cls,
    unknown: pass.report.unknown[0] ?? null,
  };
}

describe('the repair and the Edge pass agree on every case, and neither refuses one', () => {
  const rows = CASES.map((c) => ({ c, expected: oracle(c), core: coreArm(c), edge: edgeArm(c) }));

  it('enumerates the full product, and every class is reached by the oracle and by both arms', () => {
    expect(CASES).toHaveLength(EXPECTED_CASES);
    expect(new Set(CASES.map(name)).size).toBe(EXPECTED_CASES);
    for (const klass of ['exempt', 'within', 'past', 'unknown']) {
      expect(
        rows.filter((r) => r.expected.class === klass).length,
        `oracle: ${klass}`
      ).toBeGreaterThan(0);
      expect(rows.filter((r) => r.core.class === klass).length, `core: ${klass}`).toBeGreaterThan(
        0
      );
      expect(rows.filter((r) => r.edge.class === klass).length, `edge: ${klass}`).toBeGreaterThan(
        0
      );
    }
  });

  it('neither arm refuses a case: the practice is kept whatever the sunset', () => {
    for (const { c, core, edge } of rows) {
      expect(core.kept, `core refused ${name(c)}`).toBe(true);
      expect(edge.kept, `edge refused ${name(c)}`).toBe(true);
    }
  });

  it('both arms put every case in the class the rule gives it', () => {
    for (const { c, expected, core, edge } of rows) {
      expect(core.class, `core: ${name(c)}`).toBe(expected.class);
      expect(edge.class, `edge: ${name(c)}`).toBe(expected.class);
    }
  });

  it('an unknown sunset is the same flag in both arms: code, cause, first date and number of dates', () => {
    let compared = 0;
    for (const { c, expected, core, edge } of rows) {
      if (expected.class !== 'unknown') continue;
      compared += 1;
      expect(core.unknown, `core: ${name(c)}`).toEqual({
        code: 'SUNSET_UNKNOWN',
        cause: DAYLIGHT_UNKNOWN_CAUSE.VENUE_COORDINATES_MISSING,
        date: expected.unknownDates[0],
        occurrences: expected.unknownDates.length,
      });
      expect(edge.unknown, `edge: ${name(c)}`).toMatchObject({
        code: 'SUNSET_UNKNOWN',
        cause: DAYLIGHT_UNKNOWN_CAUSE.VENUE_COORDINATES_MISSING,
        occurrences: expected.unknownDates.length,
      });
    }
    // The number of unknown cases is the arithmetic of the dimensions: unlit or undeclared (2) x no
    // coordinates (1) x either practice (2) x an override that leaves dates judged (2).
    expect(compared).toBe(2 * 1 * 2 * 2);
  });

  it('no case carries both flags here: unknown and past never overlap without a table', () => {
    // With no sunset table a venue has coordinates or it has not, so a date is known or unknown
    // for the whole window. (Both flags together are tested in practiceRepairDaylight.test.js.)
    expect(rows.filter((r) => r.core.flagsBoth)).toEqual([]);
  });
});
