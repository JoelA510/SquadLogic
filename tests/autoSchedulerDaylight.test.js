/**
 * 8.9 PR 6 -- the auto-scheduler's daylight post-pass (plan §3, witnesses W7,
 * W9 and the Deno half of W15; decisions D2, D4, D5, D6, D8, D11).
 *
 * These witnesses execute the Edge Function's own modules
 * (`_shared/engines/practice-daylight.ts`, `auto-scheduler-solver.ts`,
 * `_shared/timing/anchorWallTimes.ts`) over a request body parsed by the
 * function's own schema, and pin how `auto-scheduler/index.ts` wires them,
 * since the serving module cannot be imported.
 *
 * **Independence.** Every expectation is derived here from the INPUT: the
 * roster, the request's slots, the database's venue rows and CORE's sunset
 * (`packages/core/src/timing/solar.js`, which `tests/solarDrift.test.js`
 * holds exactly equal to the Edge twin). The placements the pass judges are
 * the search's own, taken from a run with no daylight context -- never from the
 * post-pass's output (the #444 `teams_without_practice` precedent).
 *
 * Coordinates are synthetic (40.00/-75.00, 41.50/-73.50). Nothing geocodes.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';

import { runPracticeOptimizer } from '../supabase/functions/_shared/engines/auto-scheduler-solver.js';
import {
  applyDaylightPostPass,
  DAYLIGHT_CODE,
  DAYLIGHT_TBD_REASON,
  DAYLIGHT_UNKNOWN_CAUSE,
  PRACTICE_SUNSET_MARGIN_MINUTES as EDGE_MARGIN,
  addDays,
  loadVenueDaylight,
  toDaylightSlot,
} from '../supabase/functions/_shared/engines/practice-daylight.js';
import { prepareTeam } from '../supabase/functions/_shared/engines/practice-coaches.js';
import { anchorWallTimes } from '../supabase/functions/_shared/timing/anchorWallTimes.js';
import { AutoSchedulerInputSchema } from '../supabase/functions/_shared/schemas/auto-scheduler.js';
import {
  PRACTICE_SUNSET_MARGIN_MINUTES as CORE_MARGIN,
  PRACTICE_TBD_REASON,
} from '../packages/core/src/practice/index.js';
import { AVAILABILITY_REASON } from '../packages/core/src/availability/reasonCodes.js';
import { sunsetEnforcementMinutes, sunsetOnDate } from '../packages/core/src/timing/solar.js';
import { newPlacementRange } from '../frontend/src/pages/PracticeSchedulingPage.jsx';
import { describeDaylightReport } from '../frontend/src/utils/daylightReport.js';

const ZONE = 'America/New_York';
const TODAY = '2026-09-01';
const ORG = '00000000-0000-4000-8000-000000000001';

// ---------------------------------------------------------------------------
// The database: fields -> locations. Synthetic coordinates only.
// ---------------------------------------------------------------------------

const F = {
  unlit: '00000000-0000-4000-8000-0000000000f1',
  unlit2: '00000000-0000-4000-8000-0000000000f2',
  lit: '00000000-0000-4000-8000-0000000000f3',
  noCoords: '00000000-0000-4000-8000-0000000000f4',
  undeclared: '00000000-0000-4000-8000-0000000000f5',
};
const FIELD_ROWS = [
  field(F.unlit, 'l1', { latitude: 40.0, longitude: -75.0, lighting_available: false }),
  // PostgREST may serialise numeric as a string.
  field(F.unlit2, 'l2', { latitude: '41.5000', longitude: '-73.5000', lighting_available: false }),
  field(F.lit, 'l3', { latitude: 40.0, longitude: -75.0, lighting_available: true }),
  field(F.noCoords, 'l4', { latitude: null, longitude: null, lighting_available: false }),
  field(F.undeclared, 'l5', { latitude: 41.5, longitude: -73.5, lighting_available: null }),
];
function field(id, locationId, location) {
  return { id, location_id: locationId, locations: location };
}

/**
 * @param {Record<string, any[]>} tables
 * @param {{ fail?: string|null }} [options]
 * @returns {any} a structural stand-in for the caller's supabase-js client
 */
function fakeClient(tables, { fail = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, filters: [], ranges: [] };
      calls.push(call);
      const q = {
        select(cols) {
          call.select = cols;
          return q;
        },
        eq(col, val) {
          call.filters.push([col, val]);
          return q;
        },
        order() {
          return q;
        },
        range(from, to) {
          call.ranges.push([from, to]);
          return Promise.resolve(
            fail === table
              ? { data: null, error: { message: 'boom' } }
              : { data: (tables[table] ?? []).slice(from, to + 1), error: null }
          );
        },
      };
      return q;
    },
  };
}

// ---------------------------------------------------------------------------
// The request: slots as the page sends them, with instants on the season clock.
// ---------------------------------------------------------------------------

/** Offset of America/New_York on a 2026 date (DST ends 2026-11-01). */
const offsetOn = (date) => (date < '2026-11-01' ? '-04:00' : '-05:00');
function slot(id, fieldId, firstDate, until, start, end, extra = {}) {
  return {
    id,
    day: 'tue',
    start: `${firstDate}T${start}:00${offsetOn(firstDate)}`,
    end: `${firstDate}T${end}:00${offsetOn(firstDate)}`,
    capacity: 1,
    ...(fieldId ? { fieldId } : {}),
    effectiveFrom: firstDate,
    effectiveUntil: until,
    startTime: start,
    endTime: end,
    ...extra,
  };
}

const BODY_SLOTS = [
  // Unlit, coordinates: past sunset from late September -> truncated.
  slot('s-a-unlit', F.unlit, '2026-09-01', '2026-11-24', '17:30', '19:00'),
  // Unlit, coordinates, early: within daylight on every date.
  slot('s-b-early', F.unlit, '2026-09-01', '2026-10-27', '16:00', '17:00'),
  // Unlit, coordinates, after DST: past sunset on its first date -> withdrawn.
  slot('s-c-late', F.unlit2, '2026-11-03', '2026-11-24', '17:00', '18:00'),
  // Lit: exempt, however late.
  slot('s-d-lit', F.lit, '2026-09-01', '2026-11-24', '19:00', '20:30'),
  // Unlit with no coordinates: unknown (D4), flagged, never allowed.
  slot('s-e-nocoords', F.noCoords, '2026-09-01', '2026-11-24', '18:00', '19:30'),
  // Undeclared lighting: unlit (D5), coordinates -> truncated.
  slot('s-f-undeclared', F.undeclared, '2026-09-01', '2026-11-24', '17:45', '19:15'),
  // No end date in the store or the body: unknown, never judged or passed.
  slot('s-g-nodates', F.unlit, '2026-09-01', undefined, '17:00', '18:00'),
  // The locked row's slot.
  slot('s-h-locked', F.unlit, '2026-09-01', '2026-11-24', '18:00', '19:30'),
];

/** `practice_slots` as the store holds them: the venue and last date. */
const SLOT_ROWS = BODY_SLOTS.map((s) => storedRow(s));
/** A body slot as `practice_slots` stores it (every fixture date is a Tuesday). */
function storedRow(s) {
  return {
    id: s.id,
    field_id: s.fieldId,
    valid_from: s.effectiveFrom,
    valid_until: s.effectiveUntil ?? null,
    day_of_week: 'tue',
    end_time: `${s.endTime}:00`,
  };
}
const TABLES = { practice_slots: SLOT_ROWS, fields: FIELD_ROWS };

const PLACEABLE = ['t1', 't2', 't3', 't4', 't5', 't6', 't7'];
const ROSTER = [...PLACEABLE, 't-locked'].map((id) => ({
  id,
  division: 'U10',
  coachId: `k-${id}`,
}));
const LOCKED = [
  {
    assignmentId: 'a-locked',
    teamId: 't-locked',
    slotId: 's-h-locked',
    effectiveDateRange: '[2026-09-01,2026-11-25)',
  },
];
const CONFIG = { timeBudgetMs: 20000, maxIterations: 300, seed: 42 };

/** The request as `index.ts` sees it: schema-parsed, then anchored. */
/** @returns {any[]} */
function anchoredSlots(bodySlots = BODY_SLOTS) {
  const input = AutoSchedulerInputSchema.parse({
    organizationId: ORG,
    teams: ROSTER,
    slots: bodySlots,
  });
  const anchored = anchorWallTimes(/** @type {any[]} */ (input.slots), ZONE, 'slots');
  assert.equal(anchored.blocking.length, 0, 'the fixture slots must all anchor');
  return anchored.rows;
}

/** @returns {Promise<any>} the loader's result, which must have succeeded */
async function loadDaylight(tables = TABLES, rows = anchoredSlots()) {
  /** @type {any} */
  const loaded = await loadVenueDaylight(fakeClient(tables), {
    organizationId: ORG,
    slotIds: rows.map((s) => String(s.id)),
  });
  if (!loaded.ok) throw new Error(`the fixture's venue load refused: ${loaded.message}`);
  return loaded;
}

/**
 * The solver as `index.ts` calls it.
 *
 * @param {{ daylight?: boolean, tables?: any, bodySlots?: any[], roster?: any[] }} [options]
 */
async function run({
  daylight = true,
  tables = TABLES,
  bodySlots = BODY_SLOTS,
  roster = ROSTER,
} = {}) {
  /** @type {any[]} */
  const rows = anchoredSlots(bodySlots);
  const placeable = roster.map((t) => t.id).filter((id) => id !== 't-locked');
  const loaded = daylight ? await loadDaylight(tables, rows) : null;
  return runPracticeOptimizer({
    teams: roster.map((t) => prepareTeam(t)),
    slots: rows.map((s) => ({
      id: s.id,
      day: s.day,
      start: s.start,
      end: s.end,
      capacity: s.capacity,
    })),
    locked: roster.some((t) => t.id === 't-locked') ? LOCKED : [],
    placeableTeamIds: placeable,
    config: CONFIG,
    daylight: loaded
      ? {
          slots: new Map(rows.map((s) => [s.id, toDaylightSlot(s, ZONE, loaded.slots.get(s.id))])),
          venues: loaded.venues,
          timeZone: ZONE,
          today: TODAY,
        }
      : undefined,
  });
}

// ---------------------------------------------------------------------------
// The independent derivation: input slot x dates x CORE sunset x DB lighting.
// ---------------------------------------------------------------------------

const FIELD_BY_ID = new Map(FIELD_ROWS.map((r) => [r.id, r.locations]));
const BODY_BY_ID = new Map(BODY_SLOTS.map((s) => [s.id, s]));
const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Every weekly date the input slot runs from TODAY, by its own fields. */
function derivedDates(slotId) {
  const s = BODY_BY_ID.get(slotId);
  const dates = [];
  for (let d = s.effectiveFrom; d <= s.effectiveUntil; d = addDays(d, 7)) {
    if (d >= TODAY) dates.push(d);
  }
  return dates;
}

/** What the rule says of one input slot, derived without the Edge module. */
function derive(slotId) {
  const s = BODY_BY_ID.get(slotId);
  const loc = s.fieldId ? FIELD_BY_ID.get(s.fieldId) : null;
  if (loc?.lighting_available === true) return { kind: 'lit' };
  const lat = loc ? Number(loc.latitude ?? NaN) : NaN;
  const lon = loc ? Number(loc.longitude ?? NaN) : NaN;
  if (!s.effectiveUntil) return { kind: 'unknown', dates: [] };
  const dates = derivedDates(slotId);
  if (!loc || !Number.isFinite(lat) || !Number.isFinite(lon) || loc.latitude === null) {
    return { kind: 'unknown', dates };
  }
  const end = minutesOf(s.endTime);
  const legal = [];
  for (const date of dates) {
    const limit =
      sunsetEnforcementMinutes(
        sunsetOnDate({ date, latitude: lat, longitude: lon, timeZone: ZONE })
      ) - CORE_MARGIN;
    if (end > limit) return { kind: 'judged', dates, legal, firstIllegal: date };
    legal.push(date);
  }
  return { kind: 'judged', dates, legal, firstIllegal: null };
}

/**
 * W7: every roster team is placed, TIME TBD with a reason, or locked; and for
 * every placement the SEARCH made, the kept range and the TBD remainder
 * partition its derived dates exactly. Returns the number of violations, so a
 * plant's red count is visible.
 */
function w7Violations(baseline, result) {
  const problems = [];
  const placed = new Map(result.placements.map((p) => [p.teamId, p]));
  const unplaced = new Map(result.unassigned.map((u) => [u.teamId, u]));
  const locked = new Set(LOCKED.map((l) => l.teamId));
  // Universe 1: the roster.
  for (const { id } of ROSTER) {
    const where = [placed.has(id), unplaced.has(id), locked.has(id)].filter(Boolean).length;
    if (where !== 1) problems.push(`${id} is in ${where} places`);
    if (unplaced.has(id) && !unplaced.get(id).reason)
      problems.push(`${id} unplaced with no reason`);
  }
  // Universe 2: the search's placements x their input slot's derived dates.
  for (const p of baseline.placements) {
    const expected = derive(p.slotId);
    const tbd = result.timeTbdByTeam.get(p.teamId);
    const now = placed.get(p.teamId);
    if (expected.kind !== 'judged' || expected.firstIllegal === null) {
      if (!now || now.slotId !== p.slotId || 'effectiveUntil' in now || tbd) {
        problems.push(`${p.teamId} changed though its slot needs no truncation`);
      }
      continue;
    }
    if (!tbd) {
      problems.push(`${p.teamId}: no TIME TBD entry for its past-sunset remainder`);
      continue;
    }
    if (tbd.from !== expected.firstIllegal || tbd.reason !== DAYLIGHT_TBD_REASON) {
      problems.push(`${p.teamId}: TBD from ${tbd.from}, expected ${expected.firstIllegal}`);
    }
    const kept =
      expected.legal.length === 0
        ? []
        : expected.dates.filter((d) => now && d <= now.effectiveUntil);
    const remainder = expected.dates.filter((d) => d >= tbd.from && d <= tbd.until);
    const union = [...kept, ...remainder];
    if (
      union.length !== expected.dates.length ||
      new Set(union).size !== union.length ||
      union.some((d, i) => d !== expected.dates[i])
    ) {
      problems.push(
        `${p.teamId}: kept ${kept.length} + TBD ${remainder.length} != ${expected.dates.length}`
      );
    }
    if (expected.legal.length === 0) {
      if (now || unplaced.get(p.teamId)?.reason !== DAYLIGHT_TBD_REASON) {
        problems.push(`${p.teamId}: nothing legal, yet not withdrawn with the daylight reason`);
      }
    } else if (!now || now.effectiveUntil !== addDays(expected.firstIllegal, -1)) {
      problems.push(`${p.teamId}: not truncated the day before ${expected.firstIllegal}`);
    }
  }
  return problems;
}

function withTbdIndex(result) {
  return { ...result, timeTbdByTeam: new Map(result.daylight.timeTbd.map((t) => [t.teamId, t])) };
}

// ---------------------------------------------------------------------------

describe('W15 (Deno twin): the practice margin is 0 and equals core', () => {
  it('the twin equals core, and both are 0', () => {
    assert.equal(EDGE_MARGIN, CORE_MARGIN);
    assert.equal(EDGE_MARGIN, 0);
  });

  it("the TIME TBD reason is core's, not a third spelling", () => {
    assert.equal(DAYLIGHT_TBD_REASON, PRACTICE_TBD_REASON.PAST_SUNSET);
    assert.equal(DAYLIGHT_TBD_REASON, 'past-sunset');
  });

  it('the codes are spelled as core spells them', () => {
    assert.equal(DAYLIGHT_CODE.PRACTICE_PAST_SUNSET, AVAILABILITY_REASON.PRACTICE_PAST_SUNSET);
    assert.equal(DAYLIGHT_CODE.SUNSET_UNKNOWN, AVAILABILITY_REASON.SUNSET_UNKNOWN);
  });

  it('ending exactly at floor(sunset) is legal; one minute later is not', async () => {
    const date = '2026-09-15';
    const floor = sunsetEnforcementMinutes(
      sunsetOnDate({ date, latitude: 40.0, longitude: -75.0, timeZone: ZONE })
    );
    const hhmm = (m) =>
      `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const verdict = async (endMinutes) => {
      const body = [slot('s-edge', F.unlit, date, date, hhmm(endMinutes - 60), hhmm(endMinutes))];
      const tables = {
        ...TABLES,
        practice_slots: body.map((s) => storedRow(s)),
      };
      const result = await run({ tables, bodySlots: body, roster: [ROSTER[0]] });
      return result.daylight;
    };
    const atLimit = await verdict(floor);
    assert.equal(atLimit.meta.occurrencesExamined, 1, 'the boundary occurrence was not examined');
    assert.equal(atLimit.meta.occurrencesWithinDaylight, 1);
    assert.equal(atLimit.timeTbd.length, 0);
    const oneLater = await verdict(floor + 1);
    assert.equal(oneLater.meta.occurrencesExamined, 1);
    assert.equal(oneLater.timeTbd.length, 1);
    assert.equal(oneLater.timeTbd[0].limitMinutes, floor);
  });
});

describe('the venue loader: from the database, as the caller, paged', () => {
  const SLOT_IDS = BODY_SLOTS.map((s) => s.id);

  it('reads practice_slots, then fields -> locations, under the org filter, page by page', async () => {
    const client = fakeClient(TABLES);
    /** @type {any} */
    const loaded = await loadVenueDaylight(client, {
      organizationId: ORG,
      slotIds: SLOT_IDS,
      pageSize: 2,
    });
    assert.equal(loaded.ok, true);
    const slotCalls = client.calls.filter((c) => c.table === 'practice_slots');
    const fieldCalls = client.calls.filter((c) => c.table === 'fields');
    assert.equal(
      slotCalls[0].select,
      'id, field_id, valid_from, valid_until, day_of_week, end_time'
    );
    assert.match(
      fieldCalls[0].select,
      /locations!inner\(latitude, longitude, lighting_available\)/
    );
    for (const call of client.calls) assert.deepEqual(call.filters, [['organization_id', ORG]]);
    // Every page until an empty one: 8 slot rows in 4 pages, 5 fields in 3, plus each empty page.
    assert.equal(slotCalls.length, 5);
    assert.equal(fieldCalls.length, 4);
    assert.equal(loaded.fieldsLoaded, FIELD_ROWS.length);
    assert.deepEqual(loaded.venues.get(F.unlit2), {
      fieldId: F.unlit2,
      locationId: 'l2',
      lit: false,
      latitude: 41.5,
      longitude: -73.5,
    });
    assert.equal(loaded.venues.get(F.undeclared).lit, null);
    assert.equal(loaded.venues.get(F.noCoords).latitude, null);
    assert.deepEqual(loaded.slots.get('s-a-unlit'), {
      fieldId: F.unlit,
      validUntil: '2026-11-24',
      firstDate: '2026-09-01',
      endMinutes: 19 * 60,
    });
    assert.equal(loaded.slots.get('s-g-nodates').validUntil, null);
  });

  it('a failed read of either table refuses', async () => {
    for (const table of ['practice_slots', 'fields']) {
      /** @type {any} */
      const loaded = await loadVenueDaylight(fakeClient(TABLES, { fail: table }), {
        organizationId: ORG,
        slotIds: SLOT_IDS,
      });
      assert.deepEqual(
        { ok: loaded.ok, code: loaded.code, table: loaded.message.startsWith(table) },
        { ok: false, code: 'VENUE_DAYLIGHT_UNREADABLE', table: true }
      );
    }
  });

  it('a run slot the store did not return refuses (a partial read)', async () => {
    /** @type {any} */
    const loaded = await loadVenueDaylight(
      fakeClient({ ...TABLES, practice_slots: SLOT_ROWS.slice(1) }),
      { organizationId: ORG, slotIds: SLOT_IDS }
    );
    assert.equal(loaded.ok, false);
    assert.match(loaded.message, /s-a-unlit/);
  });

  it("a slot's field the read did not return refuses (a partial read)", async () => {
    /** @type {any} */
    const loaded = await loadVenueDaylight(fakeClient({ ...TABLES, fields: FIELD_ROWS.slice(1) }), {
      organizationId: ORG,
      slotIds: SLOT_IDS,
    });
    assert.equal(loaded.ok, false);
    assert.match(loaded.message, new RegExp(F.unlit));
  });

  it('a half coordinate pair is no coordinates', async () => {
    /** @type {any} */
    const loaded = await loadVenueDaylight(
      fakeClient({
        practice_slots: [{ id: 's', field_id: F.unlit, valid_until: null }],
        fields: [
          field(F.unlit, 'l1', { latitude: 40, longitude: null, lighting_available: false }),
        ],
      }),
      { organizationId: ORG, slotIds: ['s'] }
    );
    assert.equal(loaded.ok && loaded.venues.get(F.unlit).latitude, null);
  });
});

describe('W9: the body never supplies the venue, its coordinates or its lighting', () => {
  it('reads only the instants and, where the store has none, the end date', () => {
    /** @type {any[]} */
    const [row] = anchoredSlots([
      slot('s-x', F.lit, '2026-09-01', '2026-11-24', '17:30', '19:00', {
        latitude: 0,
        longitude: 0,
        lighting_available: true,
        lightingAvailable: true,
      }),
    ]);
    // The schema keeps the passthrough keys -- so only the copy protects the pass.
    assert.equal(row.lightingAvailable, true);
    const read = toDaylightSlot(row, ZONE, { fieldId: F.unlit, validUntil: '2026-10-01' });
    assert.deepEqual(Object.keys(read).sort(), [
      'effectiveUntil',
      'endMinutes',
      'fieldId',
      'firstDate',
      'id',
    ]);
    assert.equal(read.fieldId, F.unlit, "the body's fieldId was read");
    assert.equal(read.effectiveUntil, '2026-10-01', "the body's end date beat the store's");
  });

  it('a body claiming a lit field, lit ground, other coordinates or an earlier end changes nothing', async () => {
    const lying = BODY_SLOTS.map((s) => ({
      ...s,
      // Thirty seconds after the start: in daylight on every date, if believed.
      end: s.start.replace(':00-0', ':30-0'),
      fieldId: F.lit,
      latitude: 0,
      longitude: 0,
      lighting_available: true,
      lightingAvailable: true,
      lit: true,
    }));
    const honest = await run();
    const lied = await run({ bodySlots: lying });
    assert.ok(honest.daylight.timeTbd.length > 0, 'the fixture truncates nothing');
    assert.deepEqual(lied.placements, honest.placements);
    assert.deepEqual(lied.daylight, honest.daylight);
  });
});

describe('W7: nothing silently dropped; truncated + TIME TBD = the full span', () => {
  it('every roster team is accounted for and every span partitions exactly', async () => {
    const baseline = await run({ daylight: false });
    const result = withTbdIndex(await run());
    // The fixture must exercise every branch, or the witness proves nothing.
    const kinds = baseline.placements.map((p) => derive(p.slotId));
    assert.equal(baseline.placements.length, PLACEABLE.length, 'the search left a team unplaced');
    assert.ok(
      kinds.some((k) => k.kind === 'lit'),
      'no lit placement'
    );
    assert.ok(
      kinds.some((k) => k.kind === 'unknown'),
      'no unknown placement'
    );
    assert.ok(
      kinds.some((k) => k.kind === 'judged' && k.firstIllegal === null),
      'none in daylight'
    );
    assert.ok(
      kinds.some((k) => k.kind === 'judged' && k.firstIllegal && k.legal.length > 0),
      'none truncated'
    );
    assert.ok(
      kinds.some((k) => k.kind === 'judged' && k.firstIllegal && k.legal.length === 0),
      'none withdrawn'
    );

    assert.deepEqual(w7Violations(baseline, result), []);
    // The counters agree with the derivation, not with the output.
    const meta = result.daylight.meta;
    assert.equal(meta.placementsExamined, baseline.placements.length);
    assert.equal(meta.litPlacementsExempt, kinds.filter((k) => k.kind === 'lit').length);
    assert.equal(meta.litPlacementsExempt + meta.unlitPlacementsExamined, meta.placementsExamined);
    assert.equal(
      meta.placementsTruncated,
      kinds.filter((k) => k.kind === 'judged' && k.firstIllegal && k.legal.length > 0).length
    );
    assert.equal(
      meta.placementsWithdrawn,
      kinds.filter((k) => k.kind === 'judged' && k.firstIllegal && k.legal.length === 0).length
    );
    // D5: the undeclared venue was judged as unlit.
    assert.equal(meta.undeclaredLightingPlacements, 1, 'the undeclared venue was not counted');
  });

  it('a withdrawn placement re-measures the evaluation over what remains', async () => {
    const result = await run();
    assert.ok(result.daylight.meta.placementsWithdrawn > 0);
    assert.equal(result.evaluation.summary.assignedTeams, result.placements.length + LOCKED.length);
  });

  it('the page honours the truncated range, and never extends it', () => {
    const window = { effectiveFrom: '2026-09-01', effectiveUntil: '2026-11-24' };
    assert.equal(newPlacementRange(window, TODAY, '2026-09-21'), '[2026-09-01,2026-09-21]');
    assert.equal(newPlacementRange(window, TODAY, null), '[2026-09-01,2026-11-24]');
    assert.equal(newPlacementRange(window, TODAY, '2026-12-31'), '[2026-09-01,2026-11-24]');
  });
});

describe('D4: an unlit venue with no coordinates is flagged, counted, never allowed', () => {
  it('stays placed, is listed unknown with its cause, and is not counted as daylight', async () => {
    const baseline = await run({ daylight: false });
    const result = await run();
    const byCause = new Map(
      result.daylight.unknown.filter((u) => !u.assignmentId).map((u) => [u.slotId, u])
    );
    const noCoords = baseline.placements.find((p) => p.slotId === 's-e-nocoords');
    assert.ok(noCoords, 'the fixture did not place the no-coordinates slot');
    assert.equal(
      byCause.get('s-e-nocoords').cause,
      DAYLIGHT_UNKNOWN_CAUSE.VENUE_COORDINATES_MISSING
    );
    assert.equal(byCause.get('s-e-nocoords').code, 'SUNSET_UNKNOWN');
    assert.equal(byCause.get('s-g-nodates').cause, DAYLIGHT_UNKNOWN_CAUSE.SLOT_DATES_UNREADABLE);
    assert.ok(
      result.placements.some((p) => p.slotId === 's-g-nodates' && !('effectiveUntil' in p))
    );
    assert.ok(
      result.placements.some((p) => p.slotId === 's-e-nocoords' && !('effectiveUntil' in p))
    );
    assert.equal(
      result.daylight.meta.daylightUnknownOccurrences,
      derivedDates('s-e-nocoords').length
    );
    assert.equal(result.daylight.meta.daylightUnknownPlacements, 2);
    // Never allowed: the within-daylight count is the judged slots' alone.
    const judgedWithin = baseline.placements
      .map((p) => derive(p.slotId))
      .filter((k) => k.kind === 'judged')
      .reduce((n, k) => n + k.legal.length, 0);
    assert.equal(result.daylight.meta.occurrencesWithinDaylight, judgedWithin);
  });
});

describe('locked rows: reported with a proposed fix, never changed (3b ruling 2)', () => {
  it('the locked row past sunset is reported and absent from the placements', async () => {
    const result = await run();
    const expected = derive('s-h-locked');
    assert.ok(expected.firstIllegal, 'the fixture locked row never runs past sunset');
    assert.deepEqual(
      result.daylight.lockedPastSunset.map((l) => ({
        id: l.assignmentId,
        date: l.date,
        fix: l.proposedFix,
      })),
      [
        {
          id: 'a-locked',
          date: expected.firstIllegal,
          fix: {
            effectiveUntil: addDays(expected.firstIllegal, -1),
            timeTbdFrom: expected.firstIllegal,
            applied: false,
          },
        },
      ]
    );
    assert.equal(result.daylight.meta.lockedRowsExamined, 1);
    assert.equal(
      result.placements.some((p) => p.teamId === 't-locked'),
      false
    );
    assert.equal(
      result.unassigned.some((u) => u.teamId === 't-locked'),
      false
    );
  });

  it('a row past sunset from its first date is proposed whole as TIME TBD; lit rows are exempt', () => {
    const first = derive('s-h-locked').firstIllegal;
    const slots = new Map(
      anchoredSlots().map((s) => [
        s.id,
        toDaylightSlot(s, ZONE, {
          fieldId: String(s.fieldId),
          validUntil: s.effectiveUntil ?? null,
        }),
      ])
    );
    const venues = new Map(
      FIELD_ROWS.map((r) => [
        r.id,
        {
          fieldId: r.id,
          locationId: r.location_id,
          lit: r.locations.lighting_available,
          latitude: r.locations.latitude === null ? null : Number(r.locations.latitude),
          longitude: r.locations.longitude === null ? null : Number(r.locations.longitude),
        },
      ])
    );
    const pass = applyDaylightPostPass({
      placements: [],
      unassigned: [],
      locked: [
        {
          assignmentId: 'a-first',
          teamId: 'tf',
          slotId: 's-h-locked',
          effectiveDateRange: `[${first},2026-11-25)`,
        },
        // Lit ground with an unreadable range: exempt, never reported.
        { assignmentId: 'a-lit', teamId: 'tl', slotId: 's-d-lit', effectiveDateRange: 'empty' },
        // Unlit ground with an unreadable range: reported unknown, never judged.
        { assignmentId: 'a-bad', teamId: 'tb', slotId: 's-a-unlit', effectiveDateRange: null },
      ],
      slots,
      venues,
      timeZone: ZONE,
      today: TODAY,
    });
    assert.deepEqual(
      pass.report.lockedPastSunset.map((l) => [l.assignmentId, l.proposedFix]),
      [['a-first', { effectiveUntil: null, timeTbdFrom: first, applied: false }]]
    );
    assert.deepEqual(
      pass.report.unknown.map((u) => [u.assignmentId, u.cause]),
      [['a-bad', DAYLIGHT_UNKNOWN_CAUSE.SLOT_DATES_UNREADABLE]]
    );
    assert.equal(pass.report.meta.lockedRowsExamined, 2);
  });
});

describe('with no unlit venue, or every venue in daylight, the output is unchanged', () => {
  const strip = (r) => JSON.stringify({ ...r, elapsedMs: 0, daylight: null });

  it('every venue lit: byte-identical to a run with no daylight pass', async () => {
    const allLit = FIELD_ROWS.map((r) => ({
      ...r,
      locations: { ...r.locations, lighting_available: true },
    }));
    // Every slot but the one with no end date (which is unknown on any ground
    // but lit -- and lit here) keeps the roster at one team per slot.
    const body = BODY_SLOTS;
    const roster = ROSTER;
    const without = await run({ daylight: false, bodySlots: body, roster });
    const withPass = await run({ tables: { ...TABLES, fields: allLit }, bodySlots: body, roster });
    assert.equal(withPass.daylight.meta.placementsExamined, without.placements.length);
    assert.equal(withPass.daylight.meta.litPlacementsExempt, without.placements.length);
    assert.equal(strip(withPass), strip(without));
  });

  it('unlit venues whose practices all end in daylight: byte-identical too', async () => {
    const body = BODY_SLOTS.filter((s) => s.id === 's-b-early' || s.id === 's-d-lit');
    const roster = ROSTER.slice(0, 2);
    const without = await run({ daylight: false, bodySlots: body, roster });
    const withPass = await run({ bodySlots: body, roster });
    assert.ok(withPass.daylight.meta.occurrencesExamined > 0, 'nothing unlit was examined');
    assert.equal(withPass.daylight.timeTbd.length, 0);
    assert.equal(strip(withPass), strip(without));
  });
});

describe('the page surfaces the report', () => {
  it('names each kind, and says nothing when there is nothing', async () => {
    const { daylight } = await run();
    const text = describeDaylightReport(daylight);
    assert.match(text, /TIME TBD from that date/);
    assert.match(text, /not placed; no earlier date/);
    assert.match(text, /the venue has no coordinates/);
    assert.match(text, /stay unchanged \(proposed, not applied\)/);
    assert.equal(describeDaylightReport({ timeTbd: [], unknown: [], lockedPastSunset: [] }), null);
    assert.equal(describeDaylightReport(null), null);
  });
});

describe('auto-scheduler/index.ts wiring (source pin)', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'supabase/functions/auto-scheduler/index.ts'),
    'utf8'
  );

  it('loads venues as the caller and refuses a failed read before the solver runs', () => {
    assert.match(source, /loadVenueDaylight\(createUserClient\(req, supabaseUrl, anonKey\), \{/);
    const guard = source.indexOf('if (!venueDaylight.ok) {');
    const solve = source.indexOf('await runPracticeOptimizer(');
    assert.ok(guard >= 0 && solve > guard, 'the refusal does not precede the solver');
    assert.match(
      source.slice(guard, guard + 1500),
      /return jsonResponse\([\s\S]*?code: venueDaylight\.code,[\s\S]*?503/
    );
  });

  it('hands the loaded venues to the solver and returns and audits the report', () => {
    assert.match(
      source,
      /toDaylightSlot\(s, season\.timezone, venueDaylight\.slots\.get\(s\.id\)\)/
    );
    assert.match(source, /status: warningCount === 0 \? 'completed' : 'completed_with_warnings'/);
    assert.match(source, /venues: venueDaylight\.venues,/);
    assert.match(source, /effectiveDateRange: row\.effectiveDateRange,/);
    assert.match(source, /^ {8}daylight,$/m);
    assert.match(source, /daylightTimeTbd: daylight\.timeTbd\.map\(/);
    // W9: nothing in the handler reads a venue, coordinate or lighting key off a slot.
    assert.doesNotMatch(
      source,
      /\.(?:fieldId|latitude|longitude|lightingAvailable|lighting_available)\b/
    );
  });
});
