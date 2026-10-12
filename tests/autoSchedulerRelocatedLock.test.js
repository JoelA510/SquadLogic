/**
 * 8.6 3b PR 11d-0 -- the auto-scheduler holds a live relocated slot
 * (`docs/PHASE_8_6_PR11D_BLACKOUT_ENACT_PLAN.md` §3 gap G2, §6, §9 Q7).
 *
 * A live `relocated` `practice_exceptions` row moves a locked practice onto
 * another slot for its window. Before 11d-0 the lock read only `time_tbd`
 * exceptions, so that slot read as free and an ordinary run could seat a team
 * there, colliding with the moved practice. These witnesses execute the Edge
 * modules (`_shared/engines/practice-lock.ts`, `auto-scheduler-solver.ts`)
 * over the seed in `tests/fixtures/relocatedLockCases.js`, which the Deno arm
 * (`_shared/tests/practice-lock_test.ts`) runs too.
 *
 * Every subject set is the seed's own labels (`RELOCATED_EXPECT`), or the
 * seed's slots -- never the loader's or the solver's output.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';

import {
  buildLockedOccupancy,
  runPracticeOptimizer,
} from '../supabase/functions/_shared/engines/auto-scheduler-solver.js';
import { loadSeasonPracticeLock } from '../supabase/functions/_shared/engines/practice-lock.js';
import { prepareTeam } from '../supabase/functions/_shared/engines/practice-coaches.js';
import {
  GREEDY_ONLY,
  RELOCATED_DB_ASSIGNMENTS,
  RELOCATED_DB_EXCEPTIONS,
  RELOCATED_EXPECT,
  RELOCATED_ROSTER,
  RELOCATED_SLOTS,
  WITH_CLIMB,
} from './fixtures/relocatedLockCases.js';

// ---------------------------------------------------------------------------
// A fake user-scoped client. It records every filter and applies NONE of
// them except `kind`, so the loader's own live filter is what is tested
// ("whatever the caller selected", plan §2.1 rule 1).
//
// Order is modelled, not ignored: a read that asks for `order('id',
// ascending)` gets its rows sorted by id; one that does not gets them in no
// stable order -- the first page in insertion order, every later page in
// reverse, an order that changed between pages -- so offset paging without
// an order repeats the first row and skips the last (for any two or more
// rows), the way PostgREST can.
// ---------------------------------------------------------------------------

const byId = (a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);

function fakeClient({
  assignments,
  relocated,
  timeTbd = [],
  failRelocated = false,
  cap = Infinity,
}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, filters: [], select: null, orders: [] };
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
        is(col, val) {
          call.filters.push(['is', col, val]);
          return q;
        },
        order(col, options) {
          call.orders.push([col, options?.ascending ?? true]);
          return q;
        },
        range(from, to) {
          const kind = call.filters.find(([op, col]) => op === 'eq' && col === 'kind')?.[2];
          let rows;
          if (table === 'practice_assignments') rows = assignments;
          else if (kind === 'relocated') rows = relocated;
          else if (kind === 'time_tbd') rows = timeTbd;
          else rows = [...timeTbd, ...relocated];
          if (failRelocated && table === 'practice_exceptions' && kind === 'relocated') {
            return Promise.resolve({ data: null, error: { message: 'boom' } });
          }
          if (call.orders.some(([col, asc]) => col === 'id' && asc === true)) {
            rows = [...rows].sort(byId);
          } else if (from > 0) {
            rows = [...rows].reverse();
          }
          const end = Math.min(to + 1, from + cap);
          return Promise.resolve({ data: rows.slice(from, end), error: null });
        },
      };
      return q;
    },
  };
}

const PARAMS = { organizationId: 'org', seasonSettingsId: 'season' };

async function loadSeed(overrides = {}) {
  const client = fakeClient({
    assignments: RELOCATED_DB_ASSIGNMENTS,
    relocated: RELOCATED_DB_EXCEPTIONS,
    ...overrides,
  });
  // `any`: the tests read both arms of the union, after asserting which one.
  const lock = /** @type {any} */ (await loadSeasonPracticeLock(client, PARAMS));
  return { client, lock };
}

const teams = RELOCATED_ROSTER.map((t) => prepareTeam(t));
const teamsById = new Map(teams.map((t) => [t.id, t]));
const slotsById = new Map(RELOCATED_SLOTS.map((s) => [s.id, s]));
const lockedTeamIds = new Set(RELOCATED_DB_ASSIGNMENTS.map((r) => r.team_id));
const placeableTeamIds = RELOCATED_ROSTER.map((t) => t.id).filter((id) => !lockedTeamIds.has(id));
const seedException = new Map(RELOCATED_DB_EXCEPTIONS.map((x) => [x.id, x]));

function lockedOf(lock) {
  return lock.rows.map((row) => ({
    assignmentId: row.id,
    teamId: row.teamId,
    slotId: row.slotId,
    effectiveDateRange: row.effectiveDateRange,
  }));
}

/** The run exactly as `auto-scheduler/index.ts` wires it. */
async function runSeed(config, { withRelocations = true } = {}) {
  const { lock } = await loadSeed();
  assert.equal(lock.ok, true, lock.ok ? '' : lock.message);
  const run = await runPracticeOptimizer({
    teams,
    slots: /** @type {any} */ (RELOCATED_SLOTS),
    locked: lockedOf(lock),
    ...(withRelocations ? { relocated: lock.relocations } : {}),
    placeableTeamIds,
    config,
  });
  return { lock, run };
}

const overlaps = (a, b) => a.start < b.end && a.end > b.start;

/** Every slot of the seed: rows + live relocations + placements never exceed capacity. */
function overfilledSlots(run) {
  const used = new Map();
  const bump = (slotId) => used.set(slotId, (used.get(slotId) ?? 0) + 1);
  for (const row of RELOCATED_DB_ASSIGNMENTS) bump(row.practice_slot_id);
  for (const [slotId, units] of Object.entries(RELOCATED_EXPECT.unitsHeld)) {
    for (let i = 0; i < units; i += 1) bump(slotId);
  }
  for (const p of run.placements) bump(p.slotId);
  let examined = 0;
  const over = [];
  for (const slot of RELOCATED_SLOTS) {
    examined += 1;
    if ((used.get(slot.id) ?? 0) > slot.capacity) over.push(`${slot.id}: ${used.get(slot.id)}`);
  }
  assert.equal(examined, RELOCATED_SLOTS.length);
  return over;
}

/** Placements whose team shares a coach with a live relocation's team at the same time. */
function coachClashes(run) {
  const clashes = [];
  for (const id of RELOCATED_EXPECT.liveInRun) {
    const x = seedException.get(id);
    const held = slotsById.get(x.practice_slot_id);
    const coaches = new Set(teamsById.get(x.team_id).coachIds);
    for (const p of run.placements) {
      const team = teamsById.get(p.teamId);
      if (!team.coachIds.some((c) => coaches.has(c))) continue;
      if (overlaps(slotsById.get(p.slotId), held)) clashes.push(`${p.teamId}@${p.slotId} vs ${id}`);
    }
  }
  return clashes;
}

describe('the seed exercises every case (meta-assertions)', () => {
  it('holds live in-run, withdrawn and outside-run relocations, each as labelled', () => {
    assert.ok(RELOCATED_EXPECT.liveInRun.length >= 1, 'no live relocation on a slot of the run');
    assert.ok(RELOCATED_EXPECT.withdrawn.length >= 1, 'no withdrawn relocation');
    assert.ok(RELOCATED_EXPECT.outsideRun.length >= 1, 'no relocation outside the run');
    for (const id of RELOCATED_EXPECT.liveInRun) {
      const x = seedException.get(id);
      assert.equal(x.withdrawn_at, null, `${id} is labelled live`);
      assert.ok(slotsById.has(x.practice_slot_id), `${id} is labelled in-run`);
      assert.ok(RELOCATED_EXPECT.unitsHeld[x.practice_slot_id] >= 1, `${id}'s slot holds no unit`);
    }
    // One row moved onto one slot twice: the (row, slot) dedup is exercised,
    // and its slot has room left, so a second unit held would show.
    const perRowSlot = new Map();
    for (const id of RELOCATED_EXPECT.liveInRun) {
      const x = seedException.get(id);
      const k = `${x.assignment_id}|${x.practice_slot_id}`;
      perRowSlot.set(k, (perRowSlot.get(k) ?? 0) + 1);
    }
    const twice = [...perRowSlot].filter(([, n]) => n >= 2).map(([k]) => k.split('|')[1]);
    assert.ok(twice.length >= 1, 'no row is moved onto one slot twice');
    for (const slotId of twice) {
      assert.ok(slotsById.get(slotId).capacity > RELOCATED_EXPECT.unitsHeld[slotId], slotId);
    }
    for (const id of RELOCATED_EXPECT.withdrawn) {
      assert.notEqual(seedException.get(id).withdrawn_at, null, `${id} is labelled withdrawn`);
    }
    for (const id of RELOCATED_EXPECT.outsideRun) {
      const x = seedException.get(id);
      assert.equal(x.withdrawn_at, null, `${id} is labelled live`);
      assert.ok(!slotsById.has(x.practice_slot_id), `${id} is labelled outside the run`);
    }
    // The hold is season-wide: a bounded, an open and an unreadable window all hold.
    const windows = RELOCATED_EXPECT.liveInRun.map((id) => seedException.get(id).window);
    assert.ok(
      windows.some((w) => /^\[\d{4}-\d\d-\d\d,\d{4}-\d\d-\d\d\]$/.test(w)),
      'no bounded window'
    );
    assert.ok(
      windows.some((w) => /,\)$/.test(w)),
      'no open window'
    );
    assert.ok(
      windows.some((w) => !/^\[/.test(w)),
      'no unreadable window'
    );
  });

  it('without the hold, an ordinary run takes every relocated slot (the control)', async () => {
    // If the seed stopped tempting the run onto a held slot, every witness
    // below would pass with or without the hold. This control is what makes
    // them discriminating, and it goes red on such a seed.
    const { run } = await runSeed(GREEDY_ONLY, { withRelocations: false });
    const taken = new Set(run.placements.map((p) => p.slotId));
    for (const id of RELOCATED_EXPECT.liveInRun) {
      const slotId = seedException.get(id).practice_slot_id;
      assert.ok(taken.has(slotId), `the control left ${slotId} (${id}) empty: it proves nothing`);
    }
    assert.ok(overfilledSlots(run).length > 0, 'the control double-books nothing');
  });
});

describe('the lock loads live relocated exceptions, as the caller, scoped like the writer', () => {
  it('reads kind relocated, live, org- and season-scoped, with the slot and team', async () => {
    const { client, lock } = await loadSeed();
    assert.equal(lock.ok, true);
    const call = client.calls.find(
      (c) =>
        c.table === 'practice_exceptions' &&
        c.filters.some(([op, col, v]) => op === 'eq' && col === 'kind' && v === 'relocated')
    );
    assert.ok(call, 'no read of relocated exceptions');
    for (const [op, col, v] of [
      ['eq', 'organization_id', 'org'],
      ['is', 'withdrawn_at', null],
      ['eq', 'teams.divisions.season_settings_id', 'season'],
    ]) {
      assert.ok(
        call.filters.some(([o, c, val]) => o === op && c === col && val === v),
        `missing ${op} ${col}`
      );
    }
    for (const column of ['practice_slot_id', 'team_id', 'withdrawn_at', 'assignment_id']) {
      assert.match(call.select, new RegExp(`\\b${column}\\b`), `does not select ${column}`);
    }
  });

  it('every lock read is ordered by id, ascending, so offset paging is stable', async () => {
    const { client } = await loadSeed();
    const reads = {
      practice_assignments: (c) => c.table === 'practice_assignments',
      'practice_exceptions time_tbd': (c) =>
        c.table === 'practice_exceptions' &&
        c.filters.some(([, col, v]) => col === 'kind' && v === 'time_tbd'),
      'practice_exceptions relocated': (c) =>
        c.table === 'practice_exceptions' &&
        c.filters.some(([, col, v]) => col === 'kind' && v === 'relocated'),
    };
    for (const [name, matches] of Object.entries(reads)) {
      const pages = client.calls.filter(matches);
      assert.ok(pages.length >= 1, `${name} was not read`);
      for (const page of pages) {
        assert.deepEqual(page.orders, [['id', true]], `${name} is not ordered by id ascending`);
      }
    }
  });

  it('paging one row at a time holds every live relocation (order is what makes it whole)', async () => {
    const client = fakeClient({
      assignments: RELOCATED_DB_ASSIGNMENTS,
      relocated: RELOCATED_DB_EXCEPTIONS,
    });
    const lock = /** @type {any} */ (
      await loadSeasonPracticeLock(client, { ...PARAMS, pageSize: 1 })
    );
    assert.equal(lock.ok, true);
    const live = [...RELOCATED_EXPECT.liveInRun, ...RELOCATED_EXPECT.outsideRun];
    assert.ok(live.length >= 2, 'fewer than two relocations: paging proves nothing');
    // Each exactly once: a skipped one leaves its slot free, a repeated one is a stale page.
    assert.deepEqual(
      lock.relocations.map((r) => r.exceptionId).sort(),
      [...live].sort(),
      'paging skipped or repeated a relocation'
    );
    const base = buildLockedOccupancy(lockedOf(lock), teamsById, slotsById, lock.relocations);
    for (const [slotId, units] of Object.entries(RELOCATED_EXPECT.unitsHeld)) {
      assert.equal(
        base.slotCapacity.get(slotId),
        slotsById.get(slotId).capacity - units,
        `${slotId} is not held after a paged read`
      );
    }
  });

  it('a withdrawn relocation is filtered by the loader itself, whatever was selected', async () => {
    const { lock } = await loadSeed();
    const loaded = new Set(lock.relocations.map((r) => r.exceptionId));
    for (const id of RELOCATED_EXPECT.withdrawn)
      assert.ok(!loaded.has(id), `${id} was loaded live`);
    for (const id of [...RELOCATED_EXPECT.liveInRun, ...RELOCATED_EXPECT.outsideRun]) {
      assert.ok(loaded.has(id), `live ${id} was not loaded`);
    }
    const live = lock.relocations.find((r) => r.exceptionId === 'x-live');
    assert.deepEqual(live, {
      exceptionId: 'x-live',
      assignmentId: 'a-moved',
      teamId: 'moved',
      slotId: 's-target',
    });
    assert.equal(lock.relocations.find((r) => r.exceptionId === 'x-no-slot').slotId, null);
  });

  it('a relocation with no withdrawn_at key cannot be judged live: the lock is refused', async () => {
    const { withdrawn_at: _drop, ...unjudged } = RELOCATED_DB_EXCEPTIONS[0];
    const { lock } = await loadSeed({ relocated: [unjudged] });
    assert.equal(lock.ok, false, 'an unjudgeable relocation was read as live or as withdrawn');
    assert.match(lock.message, /x-live/);
    assert.match(lock.message, /withdrawn_at/);
  });

  it('a row of another kind back from the relocated read refuses it, never reads as slotless', async () => {
    const { lock } = await loadSeed({
      relocated: [
        ...RELOCATED_DB_EXCEPTIONS,
        { ...RELOCATED_DB_EXCEPTIONS[0], id: 'x-tbd', kind: 'time_tbd', practice_slot_id: null },
      ],
    });
    assert.equal(lock.ok, false, 'a time_tbd row was loaded as a relocation');
    assert.match(lock.message, /x-tbd/);
  });

  it('a failed relocated read is a refusal, not an empty hold', async () => {
    const { lock } = await loadSeed({ failRelocated: true });
    assert.equal(lock.ok, false);
    assert.match(lock.message, /relocated/);
  });

  it('reads every page past the server cap', async () => {
    const { lock } = await loadSeed({ cap: 1 });
    assert.equal(lock.ok, true);
    assert.equal(
      lock.relocations.length,
      RELOCATED_EXPECT.liveInRun.length + RELOCATED_EXPECT.outsideRun.length,
      'the capped first page ended the read'
    );
  });

  it('the time_tbd read and the locked rows are unchanged by the relocated read', async () => {
    const { lock } = await loadSeed({ timeTbd: [{ id: 'x-tbd', team_id: 'moved-b' }] });
    assert.equal(lock.ok, true);
    assert.deepEqual(lock.timeTbdTeamIds, ['moved-b']);
    assert.deepEqual(
      lock.rows.map((r) => r.id),
      RELOCATED_DB_ASSIGNMENTS.map((r) => r.id)
    );
  });
});

describe('a live relocated slot is held season-wide (the locked-row contract)', () => {
  it('takes one unit of its slot and holds its team coaches there; withdrawn holds nothing', async () => {
    const { lock } = await loadSeed();
    const base = buildLockedOccupancy(lockedOf(lock), teamsById, slotsById, lock.relocations);
    for (const id of RELOCATED_EXPECT.liveInRun) {
      const x = seedException.get(id);
      const capacity = slotsById.get(x.practice_slot_id).capacity;
      assert.equal(
        base.slotCapacity.get(x.practice_slot_id),
        capacity - RELOCATED_EXPECT.unitsHeld[x.practice_slot_id],
        `${id}: ${x.practice_slot_id} does not hold exactly its units`
      );
      const held = slotsById.get(x.practice_slot_id);
      for (const coachId of teamsById.get(x.team_id).coachIds) {
        assert.ok(
          (base.coachAssignments.get(coachId) ?? []).some(
            (w) => w.slotId === held.id && w.start === held.start && w.end === held.end
          ),
          `${id} does not hold coach ${coachId} at ${held.id}`
        );
      }
    }
    for (const id of RELOCATED_EXPECT.withdrawn) {
      const slotId = seedException.get(id).practice_slot_id;
      assert.equal(
        base.slotCapacity.get(slotId),
        slotsById.get(slotId).capacity,
        `withdrawn ${id} holds ${slotId}`
      );
    }
    // Frees nothing: every locked row still holds its own slot.
    for (const row of RELOCATED_DB_ASSIGNMENTS) {
      assert.equal(base.slotCapacity.get(row.practice_slot_id), 0, `${row.id} no longer holds`);
    }
    assert.deepEqual(
      base.relocatedOutsideRun.map((r) => r.exceptionId).sort(),
      [...RELOCATED_EXPECT.outsideRun].sort()
    );
  });

  it('the greedy seed never seats a team on a held slot, nor a held coach beside it', async () => {
    const { run } = await runSeed(GREEDY_ONLY);
    assert.deepEqual(overfilledSlots(run), [], 'a relocated slot was double-booked');
    assert.deepEqual(coachClashes(run), [], 'a coach was booked against a moved practice');
    // The coach witness is exercised: its team was seated, just not on the twin.
    const { team, twinSlot } = RELOCATED_EXPECT.coachWitness;
    const seated = run.placements.find((p) => p.teamId === team);
    assert.ok(seated, `${team} was not seated, so the coach witness proves nothing`);
    assert.notEqual(seated.slotId, twinSlot);
  });

  it('a withdrawn relocation frees its slot for the run', async () => {
    const { run } = await runSeed(GREEDY_ONLY);
    for (const id of RELOCATED_EXPECT.withdrawn) {
      const slotId = seedException.get(id).practice_slot_id;
      assert.ok(
        run.placements.some((p) => p.slotId === slotId),
        `withdrawn ${id} still holds ${slotId}`
      );
    }
  });

  it('two windows of one row on one slot hold one unit, and the other is seated', async () => {
    const { run } = await runSeed(GREEDY_ONLY);
    for (const [slotId, units] of Object.entries(RELOCATED_EXPECT.unitsHeld)) {
      const free = slotsById.get(slotId).capacity - units;
      if (free <= 0) continue;
      assert.equal(
        run.placements.filter((p) => p.slotId === slotId).length,
        free,
        `${slotId} does not offer its ${free} free unit(s)`
      );
    }
  });

  it('the hill climb keeps the hold too', async () => {
    const { run } = await runSeed(WITH_CLIMB);
    assert.ok(run.iterations > 0, 'the climb did not run');
    assert.deepEqual(overfilledSlots(run), []);
    assert.deepEqual(coachClashes(run), []);
  });

  it('a relocation the run holds no time for is reported, never dropped', async () => {
    const { run } = await runSeed(GREEDY_ONLY);
    assert.deepEqual(
      run.relocatedOutsideRun.map((r) => r.exceptionId).sort(),
      [...RELOCATED_EXPECT.outsideRun].sort()
    );
  });

  it('places only placeable teams, and every roster team is accounted for', async () => {
    const { run } = await runSeed(GREEDY_ONLY);
    for (const p of run.placements) assert.ok(placeableTeamIds.includes(p.teamId), p.teamId);
    for (const id of placeableTeamIds) {
      const placed = run.placements.some((p) => p.teamId === id);
      const unplaced = run.unassigned.some((u) => u.teamId === id && u.reason);
      assert.ok(placed || unplaced, `placeable ${id} is in no outcome`);
    }
  });
});

describe('auto-scheduler/index.ts wiring (source pin)', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'supabase/functions/auto-scheduler/index.ts'),
    'utf8'
  );
  const runCall = source.slice(source.indexOf('await runPracticeOptimizer({'));

  it('hands the loaded relocations to the solver', () => {
    assert.match(runCall.slice(0, 1500), /relocated: lock\.relocations,/);
  });

  it('audits and returns the relocations held and those outside the run', () => {
    const completed = source.slice(source.indexOf("action: 'scheduler.auto_completed'"));
    assert.match(completed, /relocatedLoaded: lock\.relocations\.length/);
    assert.match(completed, /relocatedOutsideRun: run\.relocatedOutsideRun\.length/);
    const response = source.slice(source.indexOf('// 13. Response'));
    assert.match(response, /relocatedLoaded: lock\.relocations\.length/);
    assert.match(
      response,
      /relocatedOutsideRun: run\.relocatedOutsideRun\.map\(\(r\) => r\.exceptionId\)/
    );
  });
});
