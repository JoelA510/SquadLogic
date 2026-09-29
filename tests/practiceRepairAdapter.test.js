// 8.6 PR 3b PR 9: the practice repair adapter (DB rows -> repair input;
// repair result -> practice-persistence payload).
//
// Every witness enumerates its subjects from the INPUT rows (the pre-apply
// snapshot, the roster, the location rows), never from the adapter's output.
// Synthetic data only: no real venue, club, person or coordinate.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { z as z3 } from 'zod/v3';
import {
  PRACTICE_EXCEPTION_ROW_KIND,
  PRACTICE_REASON,
  PRACTICE_REPAIR_CAUSE_KIND,
  PRACTICE_REPAIR_PAYLOAD_REFUSAL,
  PRACTICE_TBD_REASON,
  buildPracticeRepairInput,
  buildPracticeRepairPayload,
  repairPracticeLoss,
} from '../packages/core/src/practice/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* -- synthetic rows ------------------------------------------------------- */
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LOC_A = uuid(101);
const LOC_B = uuid(102);
const F1 = uuid(201);
const F2 = uuid(202);
const F3 = uuid(203);
const S2A = uuid(251); // a subunit of F2, not used by any slot
const [T1, T2, T3, T4] = [uuid(301), uuid(302), uuid(303), uuid(304)];
const [C1, C2, C8, C9] = [uuid(401), uuid(402), uuid(408), uuid(409)];
const [SL1, SL2, SL3, SL4, SL5] = [uuid(501), uuid(502), uuid(503), uuid(504), uuid(505)];
const [A1, A2, A3, A4] = [uuid(601), uuid(602), uuid(603), uuid(604)];
const BLACKOUT = uuid(701);
const RANGE = '[2026-09-01,2026-12-01)'; // canonical: 2026-09-01 .. 2026-11-30

function locations({ lit = false, coordinates = false } = {}) {
  return [LOC_A, LOC_B].map((id, i) => ({
    id: id.toUpperCase(), // read back in any case; the graph lowercases
    name: `Venue ${i + 1}`,
    lighting_available: lit,
    latitude: coordinates ? '40.00' : null,
    longitude: coordinates ? '-75.00' : null,
  }));
}
const FIELDS = [
  { id: F1, location_id: LOC_A, name: 'Field 1', effective_to: '2026-10-14' },
  { id: F2, location_id: LOC_A, name: 'Field 2' },
  { id: F3, location_id: LOC_B, name: 'Field 3' },
];
const SUBUNITS = [{ id: S2A, field_id: F2, label: 'Half A' }];
const slot = (id, field, day, start, end) => ({
  id,
  field_id: field,
  field_subunit_id: null,
  day_of_week: day,
  start_time: start,
  end_time: end,
  valid_from: '2026-09-01',
  valid_until: '2026-11-30',
});
const SLOTS = [
  slot(SL1, F1, 'mon', '17:00:00', '18:00:00'),
  slot(SL2, F1, 'wed', '17:00:00', '18:00:00'),
  slot(SL3, F2, 'mon', '17:00:00', '18:00:00'),
  slot(SL4, F2, 'wed', '18:00:00', '19:00:00'),
  slot(SL5, F3, 'mon', '17:00:00', '18:00:00'),
];
const assignment = (id, team, slotId) => ({
  id,
  team_id: team,
  practice_slot_id: slotId,
  effective_date_range: RANGE,
  source: 'auto',
});
/** The pre-apply snapshot: every current row of the season. */
const SNAPSHOT = [
  assignment(A1, T1, SL1),
  assignment(A2, T2, SL2),
  assignment(A3, T3, SL4),
  assignment(A4, T4, SL5),
];
/** One coach source; C9 left T1 before the loss, C8 joins T2 after it. */
const COACH_ROWS = [
  { team_id: T1, coach_id: C1, role: 'lead', effective_from: '2026-08-01', effective_to: null },
  {
    team_id: T1,
    coach_id: C9,
    role: 'assistant',
    effective_from: '2026-08-01',
    effective_to: '2026-09-30',
  },
  { team_id: T2, coach_id: C2, role: 'lead', effective_from: '2026-08-01', effective_to: null },
  {
    team_id: T2,
    coach_id: C8,
    role: 'assistant',
    effective_from: '2026-11-01',
    effective_to: null,
  },
  {
    team_id: T3,
    coach_id: C1,
    role: 'assistant',
    effective_from: '2026-08-01',
    effective_to: null,
  },
];
const RETIREMENT = { kind: 'retirement', field: { id: F1, effective_to: '2026-10-14' } };
const blackout = (from, until) => ({
  kind: 'blackout',
  blackout: {
    id: BLACKOUT,
    field_id: F1,
    location_id: null,
    blackout_from: from,
    blackout_until: until,
    start_minutes: null,
    end_minutes: null,
    reason: 'maintenance',
    note: 'free text the adapter must never carry',
  },
});
function rowsFor(loss, extra = {}) {
  return {
    locations: locations(extra.locationOptions),
    fields: FIELDS,
    fieldSubunits: SUBUNITS,
    practiceSlots: SLOTS,
    practiceAssignments: SNAPSHOT,
    loss,
    teamCoachAssignments: COACH_ROWS,
    ...extra.rows,
  };
}
function run(loss, extra = {}) {
  const adapted = buildPracticeRepairInput(rowsFor(loss, extra));
  const result = repairPracticeLoss(adapted.input);
  return { adapted, result, written: buildPracticeRepairPayload(adapted, result) };
}

/* -- independent helpers (no adapter code) -------------------------------- */
const DAY_MS = 86400000;
const WEEKDAY = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const plusDays = (date, n) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
function datesOn(day, from, until) {
  const out = [];
  for (let d = from; d <= until; d = plusDays(d, 1)) {
    if (new Date(`${d}T00:00:00Z`).getUTCDay() === WEEKDAY[day]) out.push(d);
  }
  return out;
}
/** `[a,b)` or `[a,b]` -> inclusive dates, parsed here, not by the adapter. */
function inclusive(range) {
  const m = range.match(/^\[(\d{4}-\d{2}-\d{2}),(\d{4}-\d{2}-\d{2})([\])])$/);
  assert.ok(m, `unreadable range ${range}`);
  return { from: m[1], until: m[3] === ')' ? plusDays(m[2], -1) : m[2] };
}
const slotById = new Map(SLOTS.map((s) => [s.id, s]));

/** Every occurrence of the snapshot, by its own range: team|slot|date. */
function expandSnapshot() {
  const out = new Map();
  for (const row of SNAPSHOT) {
    const s = slotById.get(row.practice_slot_id);
    const { from, until } = inclusive(row.effective_date_range);
    for (const date of datesOn(s.day_of_week, from, until)) {
      out.set(`${row.team_id}|${s.id}|${date}`, { row, date });
    }
  }
  return out;
}
/** The occurrences after the planned write: rows by range, closes applied, exceptions applied in their windows. */
function expandAfter(plan) {
  const out = new Set();
  const closes = new Map(plan.closes.map((c) => [c.assignment_id, c.last_day]));
  const exceptionsOf = (id) => plan.exceptions.filter((e) => e.assignment_id === id);
  const rows = [
    ...SNAPSHOT.filter((r) => closes.has(r.id)).map((r) => ({
      id: r.id,
      team: r.team_id,
      slot: r.practice_slot_id,
      from: inclusive(r.effective_date_range).from,
      until: closes.get(r.id),
    })),
    ...plan.assignmentRows.map((r) => {
      const known = SNAPSHOT.find(
        (s) =>
          s.team_id === r.team_id &&
          s.practice_slot_id === r.practice_slot_id &&
          s.effective_date_range === r.effective_date_range
      );
      return {
        id: known?.id ?? null,
        team: r.team_id,
        slot: r.practice_slot_id,
        ...inclusive(r.effective_date_range),
      };
    }),
  ];
  for (const row of rows) {
    const day = slotById.get(row.slot).day_of_week;
    for (const date of datesOn(day, row.from, row.until)) {
      const hit = exceptionsOf(row.id).find((e) => {
        const w = inclusive(e.window);
        return date >= w.from && date <= w.until;
      });
      if (!hit) out.add(`${row.team}|${row.slot}|${date}`);
      else if (hit.kind === 'relocated') {
        const moved = slotById.get(hit.practice_slot_id);
        // The moved practice's own weekday in that week (same week, Monday-based).
        const shift = WEEKDAY[moved.day_of_week] - WEEKDAY[day];
        out.add(`${row.team}|${moved.id}|${plusDays(date, shift)}`);
      }
    }
  }
  return out;
}
/** Displaced series-windows from the SNAPSHOT x the loss: assignment_id -> window. */
function displacedWindows(lossFrom, lossUntil) {
  const out = new Map();
  for (const row of SNAPSHOT) {
    const s = slotById.get(row.practice_slot_id);
    if (s.field_id !== F1) continue;
    const r = inclusive(row.effective_date_range);
    const from = r.from > lossFrom ? r.from : lossFrom;
    const until = lossUntil === null || r.until < lossUntil ? r.until : lossUntil;
    if (datesOn(s.day_of_week, from, until).length > 0) out.set(row.id, `[${from},${until}]`);
  }
  return out;
}

/** The Edge PracticeRepairSchema, evaluated from its own source under zod v3. */
function edgeRepairSchema() {
  const source = readFileSync(
    path.join(REPO_ROOT, 'supabase/functions/practice-persistence/index.ts'),
    'utf8'
  );
  const start = source.indexOf('const Uuid = ');
  const end = source.indexOf('const PersistencePayloadSchema');
  assert.ok(start > 0 && end > start, 'the Edge schema block was not found; this test is stale');
  const block = source.slice(start, end).replace('export const', 'const');
  return new Function('z', `${block}\nreturn PracticeRepairSchema;`)(z3);
}
function edgeEnum(name) {
  const source = readFileSync(
    path.join(REPO_ROOT, 'supabase/functions/practice-persistence/index.ts'),
    'utf8'
  );
  const found = source.match(new RegExp(`${name}: z\\s*\\.enum\\(\\[([^\\]]*)\\]\\)`));
  assert.ok(found, `the Edge ${name} enum was not found; this test is stale`);
  return [...found[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
}
/** The writer's assignment recordset columns, from the last migration that defines it. */
function writerAssignmentColumns() {
  const dir = path.join(REPO_ROOT, 'supabase/migrations');
  const pattern = /jsonb_to_recordset\(assignments\) AS raw_assignments\(([^)]*)\)/;
  const sql = readdirSync(dir)
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .map((n) => readFileSync(path.join(dir, n), 'utf8'))
    .filter((s) => pattern.test(s))
    .pop();
  assert.ok(sql, 'no migration defines the writer recordset; this test is stale');
  return new Set(
    sql
      .match(pattern)[1]
      .split(',')
      .map((c) => c.trim().split(/\s+/)[0])
  );
}
const LOCATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/* -- MUST 1: venues are location ids ------------------------------------- */
describe('facility graph', () => {
  it('uses every location id (lowercase uuid) as venueId, never a slug', () => {
    const { input } = buildPracticeRepairInput(rowsFor(RETIREMENT));
    const expected = locations()
      .map((l) => l.id.toLowerCase())
      .sort();
    const surfaces = Object.values(input.graph.surfaces);
    // Meta: every field and subunit row became a surface.
    assert.equal(surfaces.length, FIELDS.length + SUBUNITS.length);
    assert.deepEqual(Object.keys(input.graph.venues).sort(), expected);
    for (const surface of surfaces) assert.match(surface.venueId, LOCATION_ID);
    assert.equal(input.graph.surfaces[S2A].parentId, F2);
  });

  it('lets a must_keep venue preference run (the repair refuses slug venues)', () => {
    const { adapted, result } = run(RETIREMENT, {
      rows: {
        coachPreferences: [
          {
            coach_id: C1,
            dimension: 'venue',
            level: 'must_keep',
            value: LOC_A,
            status: 'approved',
            effective_from: '2026-09-01',
            effective_to: null,
          },
        ],
      },
    });
    assert.equal(adapted.input.coachPreferences.length, 1);
    assert.equal(result.stats.displaced, 2);
  });
});

/* -- MUST 2: one coach source --------------------------------------------- */
describe('coaches', () => {
  it('derives coachesByTeam from the teamCoachAssignments it passes, on the loss date', () => {
    const { input } = buildPracticeRepairInput(
      rowsFor(RETIREMENT, {
        rows: {
          coachPreferences: [
            {
              coach_id: C2,
              dimension: 'weekday',
              level: 'prefer_keep',
              value: null,
              status: 'approved',
              effective_from: '2026-09-01',
              effective_to: null,
            },
          ],
        },
      })
    );
    assert.equal(input.teamCoachAssignments.length, COACH_ROWS.length);
    // Teams from the SNAPSHOT (the roster the loss reads), coaches recomputed here.
    const teams = [...new Set(SNAPSHOT.map((r) => r.team_id))].sort();
    let withCoach = 0;
    for (const team of teams) {
      const expected = input.teamCoachAssignments
        .filter(
          (r) =>
            r.team_id === team &&
            r.effective_from <= input.loss.from &&
            (r.effective_to === null || r.effective_to >= input.loss.from)
        )
        .map((r) => r.coach_id)
        .sort();
      assert.deepEqual(input.coachesByTeam[team], expected, team);
      if (expected.length > 0) withCoach += 1;
    }
    // Meta: the dated rows decided something (C9 gone, C8 not yet).
    assert.equal(withCoach, 3);
    assert.deepEqual(input.coachesByTeam[T1], [C1]);
    assert.deepEqual(input.coachesByTeam[T2], [C2]);
  });

  it('passes only approved preferences (the Edge loader contract), undated', () => {
    const { input, declared } = buildPracticeRepairInput(
      rowsFor(RETIREMENT, {
        rows: {
          coachPreferences: [
            {
              coach_id: C1,
              dimension: 'weekday',
              level: 'must_keep',
              value: 'MON',
              status: 'approved',
              effective_from: '2026-09-01',
              effective_to: null,
            },
            {
              coach_id: C2,
              dimension: 'weekday',
              level: 'must_keep',
              value: 'WED',
              status: 'requested',
              effective_from: null,
              effective_to: null,
            },
            {
              coach_id: C2,
              dimension: 'venue',
              level: 'must_keep',
              value: LOC_B,
              status: 'superseded',
              effective_from: '2026-09-01',
              effective_to: '2026-10-20',
            },
            // Approved after the loss date: still the row in force.
            {
              coach_id: C2,
              dimension: 'start_time',
              level: 'prefer_keep',
              value: 1020,
              status: 'approved',
              effective_from: '2026-11-01',
              effective_to: null,
            },
          ],
        },
      })
    );
    assert.deepEqual(input.coachPreferences, [
      { coachId: C1, dimension: 'weekday', level: 'must_keep', value: 'MON' },
      { coachId: C2, dimension: 'start_time', level: 'prefer_keep', value: 1020 },
    ]);
    assert.deepEqual(declared.coachPreferences, { rowsRead: 4, approved: 2 });
  });
});

/* -- MUST 3: daylight calendar -------------------------------------------- */
const SUNSETS = datesOn('mon', '2026-10-15', '2026-11-30')
  .concat(datesOn('wed', '2026-10-15', '2026-11-30'))
  .map((date) => ({ date, sunsetMinutes: 1000 }));
describe('daylight', () => {
  it('passes a calendar built from the location rows and the sunset table', () => {
    const { adapted, result } = run(RETIREMENT, {
      locationOptions: { lit: true, coordinates: true },
      rows: { daylight: { timeZone: 'America/New_York', sunsets: SUNSETS } },
    });
    const calendar = adapted.input.calendar;
    assert.ok(calendar, 'no calendar reached the repair');
    assert.deepEqual(calendar.daylightByVenue[LOC_A], {
      venueId: LOC_A,
      latitude: 40,
      longitude: -75,
      source: null,
    });
    assert.equal(adapted.input.graph.venues[LOC_A].lit, true);
    assert.equal(result.daylight.checked, true);
    assert.ok(result.daylight.candidatesJudged > 0, 'the gate judged nothing');
    assert.ok(result.daylight.candidatesLitExempt > 0);
    assert.ok(!result.findings.some((f) => f.code === PRACTICE_REASON.REPAIR_DAYLIGHT_UNCHECKED));
    assert.equal(adapted.declared.daylight.supplied, true);
  });

  it('without one, the repair says DAYLIGHT_UNCHECKED and the adapter declares it', () => {
    const { adapted, result } = run(RETIREMENT);
    assert.equal(adapted.input.calendar, undefined);
    assert.equal(result.daylight.checked, false);
    assert.ok(result.findings.some((f) => f.code === PRACTICE_REASON.REPAIR_DAYLIGHT_UNCHECKED));
    assert.equal(adapted.declared.daylight.supplied, false);
  });

  it('never geocodes: no coordinates and no table row is sunset-unknown', () => {
    const { result, written } = run(RETIREMENT, {
      rows: { daylight: { timeZone: 'America/New_York', sunsets: [] } },
    });
    assert.ok(result.daylight.candidatesRefusedSunsetUnknown > 0);
    const tbd = written.plan.exceptions.find(
      (e) => e.tbd_reason === PRACTICE_TBD_REASON.SUNSET_UNKNOWN
    );
    assert.ok(tbd, 'no sunset-unknown TIME TBD was written');
    assert.equal(tbd.cause_kind, PRACTICE_REPAIR_CAUSE_KIND.RETIREMENT);
  });

  it('a past-sunset TIME TBD keeps cause_kind retirement; daylight is only the reason', () => {
    const { written } = run(RETIREMENT, {
      rows: { daylight: { timeZone: 'America/New_York', sunsets: SUNSETS } },
    });
    const reasons = written.plan.exceptions.map((e) => [e.tbd_reason, e.cause_kind]);
    assert.deepEqual(reasons, [
      ['past-sunset', 'retirement'],
      ['past-sunset', 'retirement'],
    ]);
    assert.ok(written.payload, 'a tail retirement window was refused');
  });
});

/* -- MUST 7: portable lighting ------------------------------------------- */
describe('lighting overrides (D14)', () => {
  it('pass through in the PR A shape, and the repair honours them', () => {
    const overrides = [{ slotId: SL3.toUpperCase(), from: '2026-10-15', until: '2026-11-30' }];
    const { adapted, result } = run(RETIREMENT, {
      rows: {
        daylight: { timeZone: 'America/New_York', sunsets: SUNSETS },
        lightingOverrides: overrides,
      },
    });
    assert.deepEqual(adapted.input.lightingOverrides, [
      { slotId: SL3, from: '2026-10-15', until: '2026-11-30' },
    ]);
    assert.deepEqual(adapted.declared.lightingOverrides, { supplied: true, count: 1 });
    // SL3's shape is exempt, so T1 re-homes onto it despite the 16:40 sunset.
    assert.ok(result.daylight.candidatesLightingOverrideExempt > 0);
    assert.deepEqual(
      result.rehomed.map((e) => e.assignmentId),
      [A1]
    );
  });

  it('none supplied is declared, not silent', () => {
    const { adapted } = run(RETIREMENT);
    assert.equal('lightingOverrides' in adapted.input, false);
    assert.equal(adapted.declared.lightingOverrides.supplied, false);
    assert.match(adapted.declared.lightingOverrides.note, /no date is exempt/);
  });
});

/* -- plan §6 adapter witnesses + MUST 4 ----------------------------------- */
describe('blackout (override)', () => {
  it('leaves every snapshot occurrence outside the window unchanged', () => {
    const { written } = run(blackout('2026-10-15', '2026-10-28'));
    const before = expandSnapshot();
    const after = expandAfter(written.plan);
    let outside = 0;
    let afterWindow = 0;
    for (const [key, { row, date }] of before) {
      const lost = slotById.get(row.practice_slot_id).field_id === F1;
      if (lost && date >= '2026-10-15' && date <= '2026-10-28') continue;
      assert.ok(after.has(key), `occurrence ${key} changed`);
      outside += 1;
      if (lost && date > '2026-10-28') afterWindow += 1;
    }
    // Meta: the lost ground has occurrences after the window, and they were checked.
    assert.ok(afterWindow >= 8, `only ${afterWindow} post-window occurrences examined`);
    assert.equal(outside, before.size - 4);
  });

  it('names every displaced series-window exactly once', () => {
    const { written } = run(blackout('2026-10-15', '2026-10-28'));
    const expected = displacedWindows('2026-10-15', '2026-10-28');
    assert.equal(expected.size, 2, 'the fixture displaces two series');
    const seen = written.plan.exceptions.map((e) => `${e.assignment_id}${e.window}`).sort();
    assert.deepEqual(seen, [...expected].map(([id, w]) => `${id}${w}`).sort());
    assert.equal(written.plan.closes.length, 0, 'a blackout must not split');
  });

  it('refuses every mid-range window loudly, keeping each in the plan', () => {
    const { written } = run(blackout('2026-10-15', '2026-10-28'));
    assert.equal(written.payload, null);
    assert.deepEqual(
      written.refused.map((r) => [r.assignment_id, r.why]),
      [
        [A1, PRACTICE_REPAIR_PAYLOAD_REFUSAL.MID_RANGE_WINDOW],
        [A2, PRACTICE_REPAIR_PAYLOAD_REFUSAL.MID_RANGE_WINDOW],
      ]
    );
    assert.deepEqual(
      written.refused.map((r) => r.exception),
      written.plan.exceptions
    );
    // Both kinds are refused: a relocation and a TIME TBD.
    assert.deepEqual(written.plan.exceptions.map((e) => e.kind).sort(), ['relocated', 'time_tbd']);
  });

  it('refuses a window reaching the series end while it lies inside the unclosed row', () => {
    const { written } = run(blackout('2026-10-15', '2026-12-31'));
    assert.equal(written.payload, null);
    assert.deepEqual(
      [...new Set(written.refused.map((r) => r.why))],
      [PRACTICE_REPAIR_PAYLOAD_REFUSAL.WINDOW_INSIDE_ROW]
    );
    assert.equal(written.refused.length, displacedWindows('2026-10-15', '2026-12-31').size);
  });
});

describe('retirement (split)', () => {
  it('leaves every snapshot occurrence before D unchanged', () => {
    const { written } = run(RETIREMENT);
    const before = expandSnapshot();
    const after = expandAfter(written.plan);
    let kept = 0;
    for (const [key, { row, date }] of before) {
      if (slotById.get(row.practice_slot_id).field_id === F1 && date >= '2026-10-15') continue;
      assert.ok(after.has(key), `occurrence ${key} changed`);
      kept += 1;
    }
    assert.ok(kept > 20, `only ${kept} occurrences examined`);
  });

  it('names every displaced series exactly once: closed, then re-homed or TIME TBD', () => {
    const { written } = run(RETIREMENT);
    const expected = displacedWindows('2026-10-15', null);
    assert.equal(expected.size, 2, 'the fixture displaces two series');
    assert.deepEqual(
      written.plan.closes.map((c) => c.assignment_id).sort(),
      [...expected.keys()].sort()
    );
    for (const close of written.plan.closes) assert.equal(close.last_day, '2026-10-14');
    const newRows = written.plan.assignmentRows.filter((r) => r.assigned_via === 'repair');
    const tbd = written.plan.exceptions.map((e) => `${e.assignment_id}${e.window}`);
    const placedTeams = newRows.map((r) => `${r.team_id}${r.effective_date_range}`);
    const accounted = [...expected].map(([id, window]) => {
      const team = SNAPSHOT.find((r) => r.id === id).team_id;
      return (
        Number(tbd.includes(`${id}${window}`)) + Number(placedTeams.includes(`${team}${window}`))
      );
    });
    assert.deepEqual(accounted, [1, 1]);
    assert.equal(newRows.length + tbd.length, expected.size);
    assert.deepEqual(
      written.plan.unlockRequired.map((u) => u.assignment_id).sort(),
      [...expected.keys()].sort()
    );
    assert.ok(written.payload, 'a retirement plan was refused');
    assert.deepEqual(written.refused, []);
  });

  it('re-sends every snapshot key it does not close', () => {
    const { written } = run(RETIREMENT);
    const closed = new Set(written.plan.closes.map((c) => c.assignment_id));
    for (const row of SNAPSHOT) {
      const present = written.payload.assignmentRows.some(
        (r) =>
          r.team_id === row.team_id &&
          r.practice_slot_id === row.practice_slot_id &&
          r.effective_date_range === row.effective_date_range
      );
      assert.equal(present, !closed.has(row.id), row.id);
    }
  });
});

/* -- MUST 6: the payload meets the Edge and the writer --------------------- */
describe('payload contract', () => {
  it('validates against the Edge PracticeRepairSchema (evaluated from its source)', () => {
    const schema = edgeRepairSchema();
    const cases = [
      run(RETIREMENT).written,
      run(RETIREMENT, { rows: { daylight: { timeZone: 'America/New_York', sunsets: SUNSETS } } })
        .written,
    ];
    let exceptions = 0;
    for (const written of cases) {
      const parsed = schema.safeParse(written.payload.repair);
      assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
      exceptions += written.payload.repair.exceptions.length;
    }
    // Refused blackout plans are well-formed too: only the reader rule withholds them.
    const refused = run(blackout('2026-10-15', '2026-10-28')).written.plan;
    const parsed = schema.safeParse({ closes: [], exceptions: refused.exceptions });
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
    exceptions += refused.exceptions.length;
    // Meta: the schema judged relocated and TIME TBD entries.
    assert.ok(exceptions >= 5, `only ${exceptions} exceptions validated`);
    // And it can fail: an exception naming both rows is refused.
    const both = {
      ...refused.exceptions[0],
      new_assignment: { team_id: T1, practice_slot_id: SL1, effective_date_range: RANGE },
    };
    assert.equal(schema.safeParse({ exceptions: [both] }).success, false);
  });

  it('names each exception row exactly once, within the DB enums', () => {
    const plans = [
      run(RETIREMENT).written.plan,
      run(blackout('2026-10-15', '2026-10-28')).written.plan,
      run(RETIREMENT, { rows: { daylight: { timeZone: 'America/New_York', sunsets: [] } } }).written
        .plan,
    ];
    const all = plans.flatMap((p) => p.exceptions);
    assert.ok(all.length >= 5);
    const reasons = new Set(edgeEnum('tbd_reason'));
    for (const e of all) {
      assert.notEqual('assignment_id' in e, 'new_assignment' in e);
      assert.ok(['blackout', 'retirement'].includes(e.cause_kind), e.cause_kind);
      assert.equal(e.kind === 'relocated', 'practice_slot_id' in e);
      assert.equal(e.kind === 'time_tbd', reasons.has(e.tbd_reason));
      assert.ok(inclusive(e.window).from <= inclusive(e.window).until, e.window);
    }
  });

  it('pins the adapter enums to the Edge enums', () => {
    assert.deepEqual(Object.values(PRACTICE_EXCEPTION_ROW_KIND).sort(), edgeEnum('kind'));
    assert.deepEqual(
      [...Object.values(PRACTICE_REPAIR_CAUSE_KIND), 'daylight'].sort(),
      edgeEnum('cause_kind')
    );
    assert.deepEqual(Object.values(PRACTICE_TBD_REASON).sort(), edgeEnum('tbd_reason'));
  });

  it('sends only assignment keys the writer reads', () => {
    const columns = writerAssignmentColumns();
    assert.ok(columns.has('assigned_via') && columns.has('effective_date_range'));
    const rows = run(RETIREMENT).written.payload.assignmentRows;
    assert.ok(rows.some((r) => r.assigned_via === 'repair'));
    for (const row of rows) for (const key of Object.keys(row)) assert.ok(columns.has(key), key);
  });
});

/* -- snapshot edge cases (code review) ------------------------------------- */
const withA1 = (patch) => ({
  rows: { practiceAssignments: [{ ...SNAPSHOT[0], ...patch }, ...SNAPSHOT.slice(1)] },
});
describe('snapshot rows', () => {
  it('refuses a snapshot row the feed cannot read (NULL, open, empty), naming it', () => {
    for (const range of ['[2026-09-01,)', null, 'empty', '(,2026-12-01)']) {
      assert.throws(
        () => run(RETIREMENT, withA1({ effective_date_range: range })),
        (error) => error instanceof TypeError && error.message.includes(A1),
        String(range)
      );
    }
  });

  it('refuses a retirement TIME TBD on a row that starts after D as not closable', () => {
    const late = '[2026-10-20,2026-12-01)';
    const noFreeSlot = SLOTS.filter((s) => s.id !== SL3);
    const { result, written } = run(RETIREMENT, {
      rows: {
        practiceSlots: noFreeSlot,
        practiceAssignments: [{ ...SNAPSHOT[0], effective_date_range: late }, ...SNAPSHOT.slice(1)],
      },
    });
    assert.ok(result.timeTbd.some((e) => e.assignmentId === A1));
    const a1 = written.refused.filter((r) => r.assignment_id === A1);
    assert.deepEqual(
      a1.map((r) => [r.why, r.window]),
      [[PRACTICE_REPAIR_PAYLOAD_REFUSAL.ROW_NOT_CLOSABLE, '[2026-10-20,2026-11-30]']]
    );
    assert.equal(written.payload, null);
  });

  // The reader rule's boundary: a window starting ON the row's last day still
  // overlaps it by one day; one starting the day after does not.
  it('refuses a blackout window that starts on the row last day (one-day overlap)', () => {
    // 2026-11-30 is a Monday and A1's last day; A2 (Wednesday) has no date in it.
    const { written } = run(blackout('2026-11-30', '2026-12-31'));
    assert.deepEqual(
      written.refused.map((r) => [r.assignment_id, r.window, r.why]),
      [[A1, '[2026-11-30,2026-11-30]', PRACTICE_REPAIR_PAYLOAD_REFUSAL.WINDOW_INSIDE_ROW]]
    );
    assert.equal(written.payload, null);
  });

  it('refuses a non-closable retirement TIME TBD that starts on the row last day', () => {
    const { written } = run(RETIREMENT, {
      rows: {
        practiceSlots: SLOTS.filter((s) => s.id !== SL3),
        practiceAssignments: [
          { ...SNAPSHOT[0], effective_date_range: '[2026-11-30,2026-12-01)' },
          ...SNAPSHOT.slice(1),
        ],
      },
    });
    assert.deepEqual(
      written.refused.map((r) => [r.assignment_id, r.window, r.why]),
      [[A1, '[2026-11-30,2026-11-30]', PRACTICE_REPAIR_PAYLOAD_REFUSAL.ROW_NOT_CLOSABLE]]
    );
    assert.equal(written.payload, null);
  });

  it('admits a closed retirement TIME TBD that starts the day after the row last day', () => {
    const { written } = run(RETIREMENT);
    const tbd = written.plan.exceptions.filter((e) => e.kind === 'time_tbd');
    assert.ok(tbd.length > 0, 'the fixture has no TIME TBD to judge');
    for (const e of tbd) {
      const close = written.plan.closes.find((c) => c.assignment_id === e.assignment_id);
      assert.equal(inclusive(e.window).from, plusDays(close.last_day, 1));
    }
    assert.deepEqual(written.refused, []);
    assert.deepEqual(written.payload.repair.exceptions, written.plan.exceptions);
  });

  it('refuses a slot that does not end after it starts', () => {
    const bad = [{ ...SLOTS[0], end_time: '17:00:00' }, ...SLOTS.slice(1)];
    assert.throws(
      () => buildPracticeRepairInput(rowsFor(RETIREMENT, { rows: { practiceSlots: bad } })),
      /does not end after it starts/
    );
  });

  it('replaces a row that starts after D: its key is not re-sent, the new row keeps its start', () => {
    const late = '[2026-10-20,2026-12-01)';
    const { written } = run(RETIREMENT, withA1({ effective_date_range: late }));
    assert.deepEqual(written.refused, []);
    assert.ok(written.payload, 'the save was refused');
    const keys = written.payload.assignmentRows.map((r) => `${r.team_id}${r.effective_date_range}`);
    assert.ok(!keys.includes(`${T1}${late}`), 'the replaced key was re-sent');
    assert.ok(keys.includes(`${T1}[2026-10-20,2026-11-30]`), 'the re-home lost its start');
    assert.ok(!written.plan.closes.some((c) => c.assignment_id === A1));
    assert.ok(written.plan.unlockRequired.some((u) => u.assignment_id === A1));
  });

  it('keeps a manual series manual when it is re-homed', () => {
    const { written } = run(RETIREMENT, withA1({ source: 'manual' }));
    const repaired = written.plan.assignmentRows.filter((r) => r.assigned_via === 'repair');
    assert.deepEqual(
      repaired.map((r) => [r.team_id, r.source]),
      [[T1, 'manual']]
    );
  });

  it('refuses a slot that names no field', () => {
    const bad = [{ ...SLOTS[0], field_id: null }, ...SLOTS.slice(1)];
    assert.throws(
      () => buildPracticeRepairInput(rowsFor(RETIREMENT, { rows: { practiceSlots: bad } })),
      /names no field/
    );
  });
});

describe('options and declarations', () => {
  it('passes the search knobs and refuses any other option key', () => {
    const { input } = buildPracticeRepairInput(
      rowsFor(RETIREMENT, { rows: { options: { strategy: 'greedy', changeBudget: 1 } } })
    );
    assert.equal(/** @type {any} */ (input).strategy, 'greedy');
    assert.equal(/** @type {any} */ (input).changeBudget, 1);
    for (const options of [{ coachesByTeam: {} }, { graph: null }, { changebudget: 2 }]) {
      assert.throws(
        () => buildPracticeRepairInput(rowsFor(RETIREMENT, { rows: { options } })),
        /unknown options/
      );
    }
  });

  it('declares missing coach rows', () => {
    const { declared } = buildPracticeRepairInput(
      rowsFor(RETIREMENT, { rows: { teamCoachAssignments: [] } })
    );
    assert.equal(declared.coaches.supplied, false);
    assert.match(declared.coaches.note, /no coach overlap/);
  });
});
