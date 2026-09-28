/**
 * 8.6 PR 3b PR 8 -- the auto-scheduler honours approved coach preferences
 * (plan §4 "Deno side", §5 decision 3, §6 "`must_keep` hard -> coach-preference
 * TBD").
 *
 * These witnesses execute the Edge Function's own modules
 * (`_shared/engines/coach-preference-load.ts`, `auto-scheduler-solver.ts`) and
 * pin how `auto-scheduler/index.ts` wires them, since the serving module
 * cannot be imported. Every subject set is enumerated from the ROSTER or the
 * loaded rows, never from the solver's output.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';

import { runPracticeOptimizer } from '../supabase/functions/_shared/engines/auto-scheduler-solver.js';
import {
  loadCoachPreferenceContext,
  seasonRunDate,
  startMinutesOf,
  weekdayCode,
} from '../supabase/functions/_shared/engines/coach-preference-load.js';
import { prepareTeam } from '../supabase/functions/_shared/engines/practice-coaches.js';
import { AutoSchedulerInputSchema } from '../supabase/functions/_shared/schemas/auto-scheduler.js';

const LOC_A = '00000000-0000-4000-8000-00000000000a';
const LOC_B = '00000000-0000-4000-8000-00000000000b';
const RUN_DATE = '2026-10-01';

// Five slots, in the order the greedy seed tries them: Mon at A, Tue at A,
// Wed at B, Thu at A, Thu at B. Each holds one team.
const SLOT_ROWS = [
  { id: 's-mon-a', day_of_week: 'mon', start_time: '17:00:00', fields: { location_id: LOC_A } },
  { id: 's-tue-a', day_of_week: 'tue', start_time: '17:00:00', fields: { location_id: LOC_A } },
  { id: 's-wed-b', day_of_week: 'wed', start_time: '18:00:00', fields: { location_id: LOC_B } },
  { id: 's-thu-a', day_of_week: 'thu', start_time: '17:00:00', fields: { location_id: LOC_A } },
  { id: 's-thu-b', day_of_week: 'thu', start_time: '18:00:00', fields: { location_id: LOC_B } },
];
const SLOTS = SLOT_ROWS.map((row, i) => ({
  id: row.id,
  day: row.day_of_week,
  start: new Date(`2026-09-0${i + 1}T17:00:00Z`),
  end: new Date(`2026-09-0${i + 1}T18:00:00Z`),
  capacity: 1,
}));

// The roster. Coaches on the body are the clash keys; preference coaches come
// from team_coach_assignments below.
const ROSTER = [
  { id: 't-free', division: 'U10', coachId: 'k-free' },
  // must_keep weekday WED: only s-wed-b keeps it.
  { id: 't-must-wed', division: 'U10', coachId: 'k-wed' },
  // must_keep weekday SAT: no slot keeps it -> coach-preference.
  { id: 't-must-sat', division: 'U10', coachId: 'k-sat' },
  // prefer_keep venue B: s-wed-b is taken by t-must-wed, so s-thu-b.
  { id: 't-prefer-b', division: 'U10', coachId: 'k-venue' },
  // Locked: holds s-mon-a. Its coach's must_keep would reject s-mon-a, and
  // must never touch the locked row.
  { id: 't-locked', division: 'U10', coachId: 'k-locked' },
];
const LOCKED = [{ assignmentId: 'a-locked', teamId: 't-locked', slotId: 's-mon-a' }];
const PLACEABLE = ROSTER.map((t) => t.id).filter((id) => id !== 't-locked');

const ASSIGNMENTS = [
  tca('t-free', 'k-free'),
  tca('t-must-wed', 'k-wed'),
  tca('t-must-sat', 'k-sat'),
  tca('t-prefer-b', 'k-venue'),
  tca('t-locked', 'k-locked'),
  // Ended before the run date: this coach's must_keep must not apply.
  { ...tca('t-free', 'k-ended'), effective_to: '2026-09-15' },
];
const PREFERENCES = [
  pref('k-wed', 'weekday', 'must_keep', 'WED'),
  pref('k-sat', 'weekday', 'must_keep', 'SAT'),
  pref('k-venue', 'venue', 'prefer_keep', LOC_B),
  pref('k-locked', 'weekday', 'must_keep', 'FRI'),
  pref('k-ended', 'weekday', 'must_keep', 'SUN'),
];

function tca(teamId, coachId) {
  return {
    id: `tca-${teamId}-${coachId}`,
    team_id: teamId,
    coach_id: coachId,
    effective_from: '2026-08-01',
    effective_to: null,
  };
}
function pref(coachId, dimension, level, value) {
  return {
    id: `p-${coachId}-${dimension}`,
    coach_id: coachId,
    dimension,
    level,
    value,
    effective_from: '2026-08-01',
    effective_to: null,
  };
}

/** @returns {any} a structural stand-in for a supabase-js client */
function fakeClient(tables, { failOn = null, count = undefined } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, filters: [] };
      calls.push(call);
      const result = () =>
        failOn === table
          ? { data: null, error: { message: 'boom' }, count: null }
          : { data: tables[table], error: null, count: count ?? tables[table].length };
      const q = {
        select(cols, options) {
          call.select = cols;
          call.options = options;
          return q;
        },
        eq(col, val) {
          call.filters.push(['eq', col, val]);
          return q;
        },
        lte(col, val) {
          call.filters.push(['lte', col, val]);
          return q;
        },
        or(filter) {
          call.filters.push(['or', filter]);
          return q;
        },
        order() {
          return q;
        },
        range(from, to) {
          const r = result();
          return Promise.resolve({ ...r, data: r.data ? r.data.slice(from, to + 1) : null });
        },
        then(resolve, reject) {
          return Promise.resolve(result()).then(resolve, reject);
        },
      };
      return q;
    },
  };
}

const TABLES = {
  team_coach_assignments: ASSIGNMENTS,
  coach_practice_preferences: PREFERENCES,
  practice_slots: SLOT_ROWS,
};

/** @returns {Promise<{ context: any, user: any, service: any }>} */
async function load(options = {}) {
  const user = fakeClient(TABLES, options.user);
  const service = fakeClient(TABLES, options.service);
  const context = await loadCoachPreferenceContext(user, service, {
    organizationId: 'org',
    runDate: RUN_DATE,
    placeableTeamIds: PLACEABLE,
    slotIds: SLOTS.map((s) => s.id),
  });
  return { context, user, service };
}

/** The gate of a load that must have succeeded. */
async function loadGate() {
  const { context } = await load();
  if (!context.ok) throw new Error(`the fixture's load refused: ${context.message}`);
  return context.gate;
}

async function run(gate) {
  return runPracticeOptimizer({
    teams: ROSTER.map((t) => prepareTeam(t)),
    slots: SLOTS,
    locked: LOCKED,
    placeableTeamIds: PLACEABLE,
    preferenceGate: gate,
    config: { timeBudgetMs: 20000, maxIterations: 300, seed: 42 },
  });
}

describe('the loader: approved preferences, server-side, as the caller', () => {
  it('builds verdicts only for placeable teams a current coach constrains', async () => {
    const { context } = await load();
    assert.equal(context.ok, true);
    // Enumerated from the roster: the constrained teams are exactly those with
    // a current coach holding a non-dont_care, value-set preference.
    assert.deepEqual([...context.gate.verdicts.keys()].sort(), [
      't-must-sat',
      't-must-wed',
      't-prefer-b',
    ]);
    // The ended coach's SUN must_keep does not reach t-free; the locked team is not judged.
    assert.equal(context.gate.verdicts.has('t-free'), false);
    assert.equal(context.gate.verdicts.has('t-locked'), false);
    const wed = context.gate.verdicts.get('t-must-wed');
    assert.deepEqual(
      SLOTS.filter((s) => !wed.get(s.id).mustKeepViolated).map((s) => s.id),
      ['s-wed-b']
    );
    const venue = context.gate.verdicts.get('t-prefer-b');
    assert.deepEqual(
      SLOTS.map((s) => venue.get(s.id).preferKeepBreaches),
      [1, 1, 0, 1, 0]
    );
  });

  it('reads only approved rows, in force on the run date, through the user client', async () => {
    const { user, service } = await load();
    const prefCall = user.calls.find((c) => c.table === 'coach_practice_preferences');
    assert.ok(
      prefCall.filters.some(([op, col, v]) => op === 'eq' && col === 'status' && v === 'approved')
    );
    assert.ok(!prefCall.filters.some(([, col]) => col === 'effective_from'));
    // The service client is used for ONE count and reads no row content.
    assert.deepEqual(
      service.calls.map((c) => [c.table, c.select, c.options]),
      [['coach_practice_preferences', 'id', { count: 'exact', head: true }]]
    );
  });

  it('a failed read refuses: every table, and the count', async () => {
    for (const table of [
      'team_coach_assignments',
      'coach_practice_preferences',
      'practice_slots',
    ]) {
      const { context } = await load({ user: { failOn: table } });
      assert.equal(context.ok, false, table);
      assert.equal(context.code, 'COACH_PREFERENCES_UNREADABLE', table);
    }
    const { context } = await load({ service: { failOn: 'coach_practice_preferences' } });
    assert.equal(context.ok, false);
  });

  it('a partial read (RLS showed the caller fewer rows than exist) refuses', async () => {
    const { context } = await load({ service: { count: PREFERENCES.length + 1 } });
    assert.equal(context.ok, false);
    assert.equal(context.code, 'COACH_PREFERENCES_NOT_VISIBLE');
  });

  it('a run slot the store cannot describe refuses rather than being judged', async () => {
    const user = fakeClient({ ...TABLES, practice_slots: SLOT_ROWS.slice(1) });
    const context = await loadCoachPreferenceContext(user, fakeClient(TABLES), {
      organizationId: 'org',
      runDate: RUN_DATE,
      placeableTeamIds: PLACEABLE,
      slotIds: SLOTS.map((s) => s.id),
    });
    assert.equal(context.ok, false);
  });

  it('the run date is the later of the season date and UTC, and slot rows map to preference values', () => {
    // 03:00Z on 1 Oct is still 30 Sep in Los Angeles, but set_team_coaches
    // stamps the database's UTC date, so the run reads on 1 Oct.
    const instant = Date.parse('2026-10-01T03:00:00Z');
    assert.equal(seasonRunDate(instant, 'America/Los_Angeles'), '2026-10-01');
    // East of UTC the season's date is the later one.
    assert.equal(
      seasonRunDate(Date.parse('2026-10-01T12:00:00Z'), 'Pacific/Kiritimati'),
      '2026-10-02'
    );
    assert.equal(seasonRunDate(instant, 'UTC'), '2026-10-01');
    assert.equal(seasonRunDate(instant, null), null);
    assert.equal(seasonRunDate(instant, 'Not/AZone'), null);
    assert.equal(weekdayCode('thu'), 'THU');
    assert.equal(weekdayCode('xyz'), null);
    assert.equal(startMinutesOf('17:30:00'), 1050);
    assert.equal(startMinutesOf('25:00'), null);
  });
});

describe('the solver honours the gate', () => {
  it('must_keep filters new placements; a team it leaves no legal slot is coach-preference TBD', async () => {
    const { context } = await load();
    const result = await run(context.gate);
    const placed = new Map(result.placements.map((p) => [p.teamId, p.slotId]));
    const unplaced = new Map(result.unassigned.map((u) => [u.teamId, u]));
    // Every placeable roster team is accounted for exactly once.
    for (const teamId of PLACEABLE) {
      assert.equal(placed.has(teamId) !== unplaced.has(teamId), true, teamId);
    }
    // No placement violates a must_keep verdict (enumerated from the roster).
    for (const teamId of PLACEABLE) {
      const slotId = placed.get(teamId);
      if (slotId)
        assert.equal(
          context.gate.verdicts.get(teamId)?.get(slotId)?.mustKeepViolated ?? false,
          false,
          teamId
        );
    }
    assert.equal(placed.get('t-must-wed'), 's-wed-b');
    assert.deepEqual(unplaced.get('t-must-sat'), {
      teamId: 't-must-sat',
      reason: 'coach-preference',
      dimensions: ['weekday'],
    });
    // Locked rows are never placed, moved or judged.
    assert.equal(placed.has('t-locked'), false);
    assert.equal(unplaced.has('t-locked'), false);
  });

  it('prefer_keep is a tiebreak: fewer breaches first among feasible slots', async () => {
    const gate = await loadGate();
    const result = await run(gate);
    const placed = new Map(result.placements.map((p) => [p.teamId, p.slotId]));
    assert.equal(placed.get('t-prefer-b'), 's-thu-b');
    assert.equal(result.preferKeepBreaches, 0);
    // Control: the same gate without that team's prefer_keep puts it on the
    // first free slot, at venue A -- so the tiebreak, not slot order, chose B.
    const verdicts = new Map(gate.verdicts);
    verdicts.delete('t-prefer-b');
    const control = await run({ verdicts });
    const controlPlaced = new Map(control.placements.map((p) => [p.teamId, p.slotId]));
    assert.equal(controlPlaced.get('t-prefer-b'), 's-thu-a');
  });

  it('no preferences is byte-identical to no gate at all', async () => {
    const empty = await run({ verdicts: new Map() });
    const none = await run(undefined);
    const strip = (r) => ({ ...r, elapsedMs: 0 });
    assert.deepEqual(strip(empty), strip(none));
    assert.equal(none.preferKeepBreaches, 0);
  });
});

describe('auto-scheduler/index.ts wiring (source pin)', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'supabase/functions/auto-scheduler/index.ts'),
    'utf8'
  );

  it('never reads preferences from the request body', () => {
    assert.doesNotMatch(source, /coachPreferences|unavailableSlotIds/);
    const parsed = AutoSchedulerInputSchema.parse({
      organizationId: '00000000-0000-4000-8000-000000000001',
      teams: [{ id: 't', division: 'U10', coachId: 'c' }],
      slots: [{ id: 's', start: '2026-09-01T17:00:00Z', end: '2026-09-01T18:00:00Z', capacity: 1 }],
      coachPreferences: { c: { unavailableSlotIds: ['s'] } },
    });
    assert.equal('coachPreferences' in parsed, false, 'the body key is still parsed');
  });

  it('loads preferences as the caller, and hands the gate to the solver', () => {
    assert.match(
      source,
      /loadCoachPreferenceContext\(\s*createUserClient\(req, supabaseUrl, anonKey\),/
    );
    assert.match(source, /preferenceGate: preferences\.gate,/);
  });

  it('a failed preference read refuses the run before the solver runs', () => {
    const guard = source.indexOf('if (!preferences.ok) {');
    const solve = source.indexOf('await runPracticeOptimizer(');
    assert.ok(guard >= 0 && solve > guard, 'the refusal does not precede the solver');
    assert.match(
      source.slice(guard, guard + 1500),
      /return jsonResponse\([\s\S]*?code: preferences\.code,[\s\S]*?503/
    );
  });
});
