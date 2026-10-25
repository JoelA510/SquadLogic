/**
 * D2 of `docs/changes/2026-10-22-demo-mode.md`, the Edge half: the
 * auto-scheduler honours division reservations on practice slots
 * (`practice_slots.division_id`), loaded from the store as the caller.
 *
 * These witnesses execute the Edge Function's own modules
 * (`_shared/engines/practice-reservations.ts`, `practice-coaches.ts`,
 * `auto-scheduler-solver.ts`) and pin how `auto-scheduler/index.ts` wires them,
 * since the serving module cannot be imported. The rule is held equal to core's
 * twin (`reservationRefusal`) over one enumerated table. Every subject set is
 * enumerated from the roster the test builds, never from the solver's output.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';

import { runPracticeOptimizer } from '../supabase/functions/_shared/engines/auto-scheduler-solver.js';
import {
  prepareTeam,
  reservationRefuses,
} from '../supabase/functions/_shared/engines/practice-coaches.js';
import { toDaylightSlot } from '../supabase/functions/_shared/engines/practice-daylight.js';
import {
  SLOT_RESERVATIONS_UNREADABLE,
  applySlotReservations,
  loadSlotReservations,
} from '../supabase/functions/_shared/engines/practice-reservations.js';
import {
  reservationRefusal,
  reservedDivisionIdsOf,
} from '../packages/core/src/practiceScheduling.js';
import { seasonLongDating } from './fixtures/solverDatedCases.js';

const U4 = '00000000-0000-4000-8000-0000000000a4';
const U10 = '00000000-0000-4000-8000-0000000000a9';

// Saturday 2026-09-05: four reserved 30-minute U4 sessions 45 minutes apart,
// and one open hour that takes four teams.
const at = (hhmm) => new Date(`2026-09-05T${hhmm}:00Z`);
const SLOTS = [
  { id: 's-u4-0900', day: 'sat', start: at('09:00'), end: at('09:30'), capacity: 1 },
  { id: 's-u4-0945', day: 'sat', start: at('09:45'), end: at('10:15'), capacity: 1 },
  { id: 's-u4-1030', day: 'sat', start: at('10:30'), end: at('11:00'), capacity: 1 },
  { id: 's-u4-1115', day: 'sat', start: at('11:15'), end: at('11:45'), capacity: 1 },
  { id: 's-open-1700', day: 'sat', start: at('17:00'), end: at('18:00'), capacity: 4 },
];
const RESERVED = new Set(['s-u4-0900', 's-u4-0945', 's-u4-1030', 's-u4-1115']);

const COHORTS = ['a', 'b', 'c', 'd'].map((x) => ({
  id: `t-u4-${x}`,
  division: 'U4',
  coachId: `k-u4-${x}`,
}));
const U10_TEAMS = ['a', 'b', 'c', 'd'].map((x) => ({
  id: `t-u10-${x}`,
  division: 'U10',
  coachId: `k-u10-${x}`,
}));
const ROSTER = [...COHORTS, ...U10_TEAMS];

// The store: the slot and team rows the loader reads.
const STORE = {
  practice_slots: SLOTS.map((s) => ({ id: s.id, division_id: RESERVED.has(s.id) ? U4 : null })),
  teams: [
    ...COHORTS.map((t) => ({ id: t.id, division_id: U4 })),
    ...U10_TEAMS.map((t) => ({ id: t.id, division_id: U10 })),
  ],
};

/** @returns {any} a structural stand-in for a supabase-js client */
function fakeClient(tables, { failOn = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, filters: [] };
      calls.push(call);
      const q = {
        select(cols) {
          call.select = cols;
          return q;
        },
        eq(col, val) {
          call.filters.push(['eq', col, val]);
          return q;
        },
        order() {
          return q;
        },
        range(from, to) {
          if (failOn === table) return Promise.resolve({ data: null, error: { message: 'boom' } });
          return Promise.resolve({ data: (tables[table] ?? []).slice(from, to + 1), error: null });
        },
      };
      return q;
    },
  };
}

async function load(tables = STORE, options = {}) {
  return loadSlotReservations(fakeClient(tables, options), {
    organizationId: 'org',
    slotIds: SLOTS.map((s) => s.id),
    teamIds: ROSTER.map((t) => t.id),
    pageSize: 2,
  });
}

async function run(reservations) {
  const prepared = ROSTER.map((t) => prepareTeam(t));
  const { teams, slots } = reservations
    ? applySlotReservations(prepared, SLOTS, reservations)
    : { teams: prepared, slots: SLOTS };
  return runPracticeOptimizer({
    teams,
    slots,
    locked: [],
    placeableTeamIds: ROSTER.map((t) => t.id),
    dating: seasonLongDating(SLOTS, toDaylightSlot, {
      timeZone: 'UTC',
      until: '2026-11-28',
      liveFrom: '2026-09-01',
    }),
    config: { timeBudgetMs: 20000, maxIterations: 300, seed: 42 },
  });
}

describe('the loader: reservations from the store, as the caller', () => {
  it('reads every slot and team, paged, in the organization', async () => {
    const client = fakeClient(STORE);
    const loaded = await loadSlotReservations(client, {
      organizationId: 'org',
      slotIds: SLOTS.map((s) => s.id),
      teamIds: ROSTER.map((t) => t.id),
      pageSize: 2,
    });
    assert.equal(loaded.ok, true);
    assert.deepEqual([...loaded.reservedDivisionIds], [U4]);
    assert.equal(loaded.slotDivision.get('s-open-1700'), null);
    assert.equal(loaded.slotDivision.get('s-u4-0900'), U4);
    assert.equal(loaded.teamDivision.get('t-u10-a'), U10);
    for (const call of client.calls) {
      assert.deepEqual(call.filters, [['eq', 'organization_id', 'org']]);
    }
    assert.deepEqual(
      [...new Set(client.calls.map((c) => `${c.table}:${c.select}`))],
      ['practice_slots:id, division_id', 'teams:id, division_id']
    );
  });

  it('refuses a failed read of either table, and a run slot the read does not return', async () => {
    for (const table of ['practice_slots', 'teams']) {
      const loaded = await load(STORE, { failOn: table });
      assert.equal(loaded.ok, false);
      assert.equal(loaded.code, SLOT_RESERVATIONS_UNREADABLE);
      assert.match(loaded.message, new RegExp(table));
    }
    const missing = await load({ ...STORE, practice_slots: STORE.practice_slots.slice(1) });
    assert.equal(missing.ok, false);
    assert.match(missing.message, /s-u4-0900/);
  });

  it('gives a team the read does not return no division, which only narrows it', async () => {
    const loaded = await load({ ...STORE, teams: STORE.teams.filter((t) => t.id !== 't-u4-a') });
    assert.equal(loaded.ok, true);
    assert.equal(loaded.teamDivision.get('t-u4-a'), null);
  });
});

describe("the solver: a reserved slot is its division's, and the division keeps to it", () => {
  it('seats the four cohorts in the four sessions and every U10 team on open ground', async () => {
    const loaded = await load();
    const result = await run(loaded);
    assert.deepEqual(result.unassigned, []);
    const byTeam = new Map(result.placements.map((p) => [p.teamId, p.slotId]));
    for (const team of COHORTS) assert.ok(RESERVED.has(byTeam.get(team.id)), team.id);
    for (const team of U10_TEAMS) assert.equal(byTeam.get(team.id), 's-open-1700', team.id);
    assert.equal(new Set(COHORTS.map((t) => byTeam.get(t.id))).size, 4);
  });

  it('CONTROL: without the reservations the search puts a U10 team in a U4 session', async () => {
    const result = await run(null);
    const u10InSession = result.placements.some(
      (p) => p.teamId.startsWith('t-u10') && RESERVED.has(p.slotId)
    );
    assert.equal(u10InSession, true);
  });

  it('leaves a team the store gives no division off every reserved slot (TIME TBD with its reason)', async () => {
    const loaded = await load({
      ...STORE,
      practice_slots: STORE.practice_slots.map((r) =>
        r.id === 's-open-1700' ? { ...r, division_id: U10 } : r
      ),
      teams: STORE.teams.filter((t) => t.id !== 't-u4-a'),
    });
    const result = await run(loaded);
    assert.deepEqual(
      result.unassigned.map((u) => [u.teamId, u.reason]),
      [['t-u4-a', 'no-slot-available']]
    );
  });
});

describe("the Edge rule equals core's twin", () => {
  it('agrees on every pairing of team division, slot reservation and reserved set', () => {
    // Each id also as a body might spell it: blank, upper-case, padded.
    const divisions = [null, '', U4, ` ${U4.toUpperCase()} `, U10];
    const reservedSets = [new Set(), new Set([U4]), new Set([U4, U10])];
    let compared = 0;
    for (const team of divisions)
      for (const slot of divisions)
        for (const reserved of reservedSets) {
          const core =
            reservationRefusal({ divisionId: team }, { divisionId: slot }, reserved) !== null;
          const edge = reservationRefuses(
            { divisionId: team, reservedDivisionIds: reserved },
            { divisionId: slot }
          );
          assert.equal(edge, core, JSON.stringify({ team, slot, reserved: [...reserved] }));
          compared += 1;
        }
    assert.equal(compared, 75);
    assert.deepEqual(
      [...reservedDivisionIdsOf([{ divisionId: U4 }, {}, { divisionId: U4 }])],
      [U4]
    );
  });
});

describe('auto-scheduler/index.ts wiring (source pin)', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'supabase/functions/auto-scheduler/index.ts'),
    'utf8'
  );

  it('loads the reservations as the caller and refuses the run before the solver on a failed read', () => {
    assert.match(source, /loadSlotReservations\(createUserClient\(req, supabaseUrl, anonKey\), \{/);
    const guard = source.indexOf('if (!reservations.ok) {');
    const solve = source.indexOf('await runPracticeOptimizer(');
    assert.ok(guard >= 0 && solve > guard, 'the refusal does not precede the solver');
    assert.match(
      source.slice(guard, guard + 1500),
      /return jsonResponse\([\s\S]*?code: reservations\.code,[\s\S]*?503/
    );
  });

  it("hands the solver the reserved teams and slots, never the body's", () => {
    assert.match(
      source,
      /applySlotReservations\(\s*input\.teams\.map\(\(t\) => prepareTeam\(t\)\),\s*slots,\s*reservations\s*\)/
    );
    assert.match(source, /const teams = reserved\.teams;/);
    assert.match(source, /slots: reserved\.slots,/);
  });
});
