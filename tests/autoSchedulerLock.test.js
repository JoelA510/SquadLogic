/**
 * 8.6 PR 3b PR 7 -- the auto-scheduler honours the lock (plan §3, §5 decision
 * 4, §6 "Edge never moves a locked team").
 *
 * Operator ruling 2: every practice already assigned is locked unless an admin
 * accepts an override prompt. These witnesses execute the Edge Function's own
 * solver and lock modules (`_shared/engines/auto-scheduler-solver.ts`,
 * `_shared/engines/practice-lock.ts`) and pin how `auto-scheduler/index.ts`
 * wires them, since the serving module cannot be imported.
 *
 * Every subject set is enumerated from the fixture's LOADED ROWS or ROSTER --
 * never from the solver's output, which is what a break would corrupt.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';

import {
  NO_LIVE_DATE_REASON,
  runPracticeOptimizer,
  undatableSlotIds,
} from '../supabase/functions/_shared/engines/auto-scheduler-solver.js';
import {
  classifyTeamsForRun,
  crossCheckLockedAssignments,
  describeLockMismatch,
  loadSeasonPracticeLock,
  TIME_TBD_EXCLUDED_REASON,
} from '../supabase/functions/_shared/engines/practice-lock.js';
import { prepareTeam } from '../supabase/functions/_shared/engines/practice-coaches.js';
import { toDaylightSlot } from '../supabase/functions/_shared/engines/practice-daylight.js';
import { evaluatePracticeSchedule as evaluateCore } from '../packages/core/src/practiceMetrics.js';
import { seasonCalendarDate } from '../packages/core/src/timing/index.js';
import { buildPracticeAssignmentRows } from '../packages/core/src/practiceSupabase.js';
import {
  newPlacementRange,
  runLiveFrom,
  toPersistenceAssignment,
} from '../frontend/src/pages/PracticeSchedulingPage.jsx';
import {
  SOLVER_DATED_CASES,
  SOLVER_DATED_TODAY,
  SOLVER_DATED_ZONE,
  seasonLongDating,
  solverDatedRun,
} from './fixtures/solverDatedCases.js';

// ---------------------------------------------------------------------------
// The fixture: a two-row team, a one-row team, a TIME TBD team, and three
// teams with no row -- two placeable, one that cannot be placed.
// ---------------------------------------------------------------------------

function slot(id, day, startHour, capacity) {
  const hh = String(startHour).padStart(2, '0');
  const h2 = String(startHour + 1).padStart(2, '0');
  return {
    id,
    day,
    start: new Date(
      `2026-09-0${1 + ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].indexOf(day)}T${hh}:00:00Z`
    ),
    end: new Date(`2026-09-0${1 + ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].indexOf(day)}T${h2}:00:00Z`),
    capacity,
  };
}

// Order matters: the greedy seed takes the first legal slot, so a slot a
// locked row fails to occupy is the one a new team lands on.
const SLOTS = [
  slot('s-mon', 'Mon', 17, 1),
  slot('s-wed', 'Wed', 17, 1),
  slot('s-tue', 'Tue', 17, 1),
  slot('s-thu', 'Thu', 17, 1),
  slot('s-fri', 'Fri', 17, 3),
];

const ROSTER = [
  { id: 'two-row', division: 'U10', coachId: 'c-two' },
  { id: 'one-row', division: 'U10', coachId: 'c-one' },
  { id: 'tbd', division: 'U10', coachId: 'c-tbd' },
  { id: 'new-1', division: 'U10', coachId: 'c-shared' },
  { id: 'new-2', division: 'U10', coachId: 'c-new2' },
  // Shares a coach with new-1, whose only free slot is the same Friday hour.
  { id: 'new-3', division: 'U10', coachId: 'c-shared' },
];

const ROWS = [
  row('a-two-mon', 'two-row', 's-mon'),
  row('a-two-wed', 'two-row', 's-wed'),
  row('a-one', 'one-row', 's-tue'),
  row('a-tbd', 'tbd', 's-thu'),
];
const TIME_TBD_TEAMS = ['tbd'];

/**
 * The fixture's dating (M4.8): every slot from its own first occurrence to the
 * end of November, and `liveFrom` on the first day of the week, so the dated
 * rule judges this pre-M4.8 fixture exactly as the undated one did.
 */
const DATING = seasonLongDating(SLOTS, toDaylightSlot, {
  timeZone: 'UTC',
  until: '2026-11-30',
  liveFrom: '2026-09-01',
});

function row(id, teamId, slotId) {
  return {
    id,
    teamId,
    slotId,
    effectiveDateRange: '[2026-09-01,2026-12-01)',
    assignedVia: 'auto',
  };
}

async function runFixture() {
  const teams = ROSTER.map((t) => prepareTeam(t));
  const classification = classifyTeamsForRun(
    ROSTER.map((t) => t.id),
    ROWS,
    TIME_TBD_TEAMS
  );
  const run = await runPracticeOptimizer({
    teams,
    slots: SLOTS,
    locked: ROWS.map((r) => ({ assignmentId: r.id, teamId: r.teamId, slotId: r.slotId })),
    placeableTeamIds: classification.placeable,
    dating: DATING,
    config: { timeBudgetMs: 20000, maxIterations: 300, seed: 42 },
  });
  return { classification, run };
}

const teamsWithRows = new Set(ROWS.map((r) => r.teamId));
const capacityOf = new Map(SLOTS.map((s) => [s.id, s.capacity]));

describe('the Edge never moves a locked team', () => {
  it('the fixture exercises a two-row team, a TIME TBD team and teams with no row', () => {
    // Meta-assertion, from the loaded rows and the roster: a fixture that lost
    // its two-row team would leave the collapse witness below proving nothing.
    const rowsPerTeam = new Map();
    for (const r of ROWS) rowsPerTeam.set(r.teamId, (rowsPerTeam.get(r.teamId) ?? 0) + 1);
    assert.ok(
      [...rowsPerTeam.values()].some((n) => n >= 2),
      'no team holds two rows'
    );
    assert.ok(
      TIME_TBD_TEAMS.every((id) => teamsWithRows.has(id)),
      'the TIME TBD team has a row'
    );
    assert.ok(
      ROSTER.filter((t) => !teamsWithRows.has(t.id)).length >= 2,
      'fewer than two teams without a row'
    );
  });

  it('every loaded row stays locked on its own slot, and no placement over-fills one', async () => {
    const { run } = await runFixture();
    const placedPerSlot = new Map();
    for (const p of run.placements)
      placedPerSlot.set(p.slotId, (placedPerSlot.get(p.slotId) ?? 0) + 1);
    const lockedPerSlot = new Map();
    for (const r of ROWS) lockedPerSlot.set(r.slotId, (lockedPerSlot.get(r.slotId) ?? 0) + 1);

    let examined = 0;
    for (const loaded of ROWS) {
      examined += 1;
      // Untouched: the team gets no placement, and the row is not "outside" the run.
      assert.ok(
        !run.placements.some((p) => p.teamId === loaded.teamId),
        `locked team ${loaded.teamId} (row ${loaded.id}) was given a placement`
      );
      assert.ok(
        !run.lockedOutsideRun.some((o) => o.assignmentId === loaded.id),
        `row ${loaded.id} was not counted on its slot`
      );
      // Occupies its slot: locked rows + new placements never exceed capacity.
      const used =
        (lockedPerSlot.get(loaded.slotId) ?? 0) + (placedPerSlot.get(loaded.slotId) ?? 0);
      assert.ok(
        used <= capacityOf.get(loaded.slotId),
        `slot ${loaded.slotId} holds ${used} > capacity ${capacityOf.get(loaded.slotId)}: row ${loaded.id} does not occupy it`
      );
    }
    assert.equal(examined, ROWS.length, 'not every loaded row was examined');
  });
});

describe('an ordinary run places only teams with no row, and returns only those', () => {
  it('returns placements for no-row teams only, and accounts for every roster team', async () => {
    const { classification, run } = await runFixture();
    const placeable = ROSTER.map((t) => t.id).filter(
      (id) => !teamsWithRows.has(id) && !TIME_TBD_TEAMS.includes(id)
    );
    assert.deepEqual([...classification.placeable].sort(), placeable.sort());
    assert.ok(run.placements.length > 0, 'the fixture placed nothing, so this proves nothing');
    for (const p of run.placements) {
      assert.ok(
        placeable.includes(p.teamId),
        `returned a placement for ${p.teamId}, which has a row`
      );
      assert.equal(p.source, 'auto');
    }
    // Never silently dropped: every roster team is placed, unplaced with a
    // reason, locked, or TIME TBD -- enumerated from the roster.
    for (const team of ROSTER) {
      const placed = run.placements.some((p) => p.teamId === team.id);
      const unplaced = run.unassigned.find((u) => u.teamId === team.id);
      const accounted =
        placed ||
        Boolean(unplaced?.reason) ||
        classification.locked.includes(team.id) ||
        classification.timeTbd.includes(team.id);
      assert.ok(accounted, `roster team ${team.id} is in no outcome`);
    }
    // The unplaceable one is reported with its reason, not dropped.
    assert.deepEqual(
      run.unassigned.map((u) => u.teamId),
      ['new-3'],
      'the coach-clash team should be the one reported unplaced'
    );
    assert.ok(run.unassigned[0].reason);
  });
});

describe("the solver scores dated, from the store's dating, whatever the page sends (M4.8 Q1)", () => {
  // Inverted from M4.7's guard ("the solver scores undated"). The page sends
  // its whole slot objects; if they carry the scoring engine's date fields,
  // they must change nothing: the objective is dated from `dating` (the
  // store's reading, `index.ts`), never from the body.
  const pageDated = SLOTS.map((s) => ({
    ...s,
    firstDate: '2026-11-02',
    lastDate: '2026-11-03',
    startTime: '06:00:00',
    endTime: '06:30:00',
  }));
  const runWith = (slots) => {
    const teams = ROSTER.map((t) => prepareTeam(t));
    const classification = classifyTeamsForRun(
      ROSTER.map((t) => t.id),
      ROWS,
      TIME_TBD_TEAMS
    );
    return runPracticeOptimizer({
      teams,
      slots,
      locked: ROWS.map((r) => ({
        assignmentId: r.id,
        teamId: r.teamId,
        slotId: r.slotId,
        effectiveDateRange: r.effectiveDateRange,
      })),
      placeableTeamIds: classification.placeable,
      dating: DATING,
      config: { timeBudgetMs: 20000, maxIterations: 300, seed: 42 },
    });
  };

  it('scores dated, and slots carrying other dates give the same run', async () => {
    const plain = await runWith(SLOTS);
    const withDates = await runWith(pageDated);
    // Meta: the page's slots really carry every field that would date a call.
    assert.ok(pageDated.every((s) => s.firstDate && s.lastDate && s.startTime && s.endTime));
    assert.ok(plain.placements.length > 0, 'the fixture placed nothing');
    assert.equal(plain.evaluation.summary.dateModel, 'dated');
    // The dated shape (M4.7 §11): each slot's busiest date beside its rows.
    assert.ok(plain.evaluation.slotUtilization.every((u) => 'assignmentRows' in u));
    assert.deepEqual(withDates.placements, plain.placements);
    assert.deepEqual(withDates.unassigned, plain.unassigned);
    assert.deepEqual(withDates.evaluation, plain.evaluation);
    assert.equal(withDates.seedScore, plain.seedScore);
    assert.equal(withDates.bestScore, plain.bestScore);
  });

  it("the persisted evaluation dates a conflict between locked rows, as the panel's does", async () => {
    // W4's shape between two LOCKED rows: Tuesday 16:00 from 08-11 and from
    // 09-01, one coach. The search cannot create a conflict; this one is the
    // operator's, and the run reports it with its dates (12 Tuesdays from
    // 09-01), which the undated evaluation reported with none.
    const testCase = SOLVER_DATED_CASES[0];
    const { slots, dating } = solverDatedRun(testCase, toDaylightSlot);
    const locked = [
      {
        assignmentId: 'a1',
        teamId: 'T1',
        slotId: 'sA',
        effectiveDateRange: '[2026-08-10,2026-11-21)',
      },
      {
        assignmentId: 'a2',
        teamId: 'T2',
        slotId: 'sB',
        effectiveDateRange: '[2026-08-10,2026-11-21)',
      },
    ];
    const teams = testCase.teams.map((t) => prepareTeam(t));
    const run = await runPracticeOptimizer({
      teams,
      slots,
      locked,
      placeableTeamIds: [],
      dating,
      config: { timeBudgetMs: 20000, maxIterations: 50, seed: 42 },
    });
    assert.equal(run.evaluation.summary.dateModel, 'dated');
    assert.deepEqual(
      run.evaluation.coachConflicts.map((c) => ({
        coachIds: c.coachIds,
        firstDate: c.firstDate,
        sharedDates: c.sharedDates,
      })),
      [{ coachIds: ['c1'], firstDate: '2026-09-01', sharedDates: 12 }]
    );
    // Core's dated engine, given the same dated inputs, agrees.
    const core = evaluateCore({
      teams,
      slots: slots.map((s) => {
        const d = dating.slots.get(s.id);
        return {
          ...s,
          day: 'Tuesday',
          firstDate: d.firstDate,
          lastDate: d.effectiveUntil,
          startTime: '16:00:00',
          endTime: '17:00:00',
        };
      }),
      assignments: locked.map((r) => ({
        teamId: r.teamId,
        slotId: r.slotId,
        effectiveDateRange: r.effectiveDateRange,
      })),
    });
    assert.equal(core.coachConflicts.length, 1);
    assert.equal(core.coachConflicts[0].firstDate, '2026-09-01');
    assert.equal(core.coachConflicts[0].sharedDates, 12);
  });
});

describe('the dated hard constraint (M4.8 §3, the shared witness table)', () => {
  it('the table exercises every rule it claims', () => {
    // Meta-assertions, from the table's own inputs: a table that lost a shape
    // would leave its plant with nothing to turn red.
    const names = SOLVER_DATED_CASES.map((c) => c.name);
    for (const shape of ['W4-S1', 'W4-S2', 'E1', 'E2', 'E3', 'DST', 'cannot be read']) {
      assert.ok(
        names.some((n) => n.includes(shape)),
        `no case for ${shape}`
      );
    }
    assert.ok(
      SOLVER_DATED_CASES.some((c) =>
        c.expect.unassigned.some((u) => u.endsWith(NO_LIVE_DATE_REASON))
      )
    );
    assert.ok(SOLVER_DATED_CASES.some((c) => c.expect.ended.length > 0));
    assert.ok(SOLVER_DATED_CASES.some((c) => c.expect.unreadable.length > 0));
    assert.ok(SOLVER_DATED_CASES.some((c) => c.slots.some((s) => s.capacity > 1)));
  });

  for (const testCase of SOLVER_DATED_CASES) {
    it(testCase.name, async () => {
      const { slots, dating } = solverDatedRun(testCase, toDaylightSlot);
      const run = await runPracticeOptimizer({
        teams: testCase.teams.map((t) => prepareTeam(t)),
        slots,
        locked: testCase.locked,
        placeableTeamIds: testCase.placeable,
        dating,
        config: { timeBudgetMs: 20000, maxIterations: 300, seed: 42 },
      });
      assert.deepEqual(
        run.placements.map((p) => `${p.teamId} -> ${p.slotId}`).sort(),
        [...testCase.expect.placements].sort(),
        'placements'
      );
      assert.deepEqual(
        run.unassigned.map((u) => `${u.teamId}: ${u.reason}`).sort(),
        [...testCase.expect.unassigned].sort(),
        'unplaced'
      );
      assert.deepEqual(
        run.endedRows.map((r) => r.assignmentId),
        testCase.expect.ended,
        'ended rows'
      );
      assert.deepEqual(
        run.unreadableRange.map((r) => r.assignmentId),
        testCase.expect.unreadable,
        'unreadable ranges'
      );
      // Never silently dropped: every placeable team is placed or unplaced
      // with a reason, enumerated from the case's own placeable list.
      for (const teamId of testCase.placeable) {
        const placed = run.placements.some((p) => p.teamId === teamId);
        const reason = run.unassigned.find((u) => u.teamId === teamId)?.reason;
        assert.ok(placed !== Boolean(reason), `${teamId} is in no outcome, or in two`);
      }
      // One rule: the run's own dated evaluation finds no conflict and no
      // overbooked slot in what the dated constraint admitted.
      assert.equal(run.evaluation.summary.dateModel, 'dated');
      assert.equal(run.evaluation.coachConflicts.length, 0, 'the search created a conflict');
      assert.ok(
        run.evaluation.slotUtilization.every((u) => !u.overbooked),
        'overbooked'
      );
      assert.equal(run.liveFrom, SOLVER_DATED_TODAY);
      // The judged range the page writes, derived here from the case's own
      // slot: [max(first date, today), last date], one per placement.
      assert.deepEqual(
        Object.keys(run.placementRanges).sort(),
        run.placements.map((p) => p.teamId).sort()
      );
      for (const p of run.placements) {
        const s = testCase.slots.find((x) => x.id === p.slotId);
        const from = s.firstDate > SOLVER_DATED_TODAY ? s.firstDate : SOLVER_DATED_TODAY;
        assert.equal(run.placementRanges[p.teamId], `[${from},${s.validUntil}]`, p.teamId);
      }
    });
  }

  it('a run with no slots at all is not "no live date": the teams have no slot', async () => {
    const run = await runPracticeOptimizer({
      teams: [prepareTeam({ id: 'N', division: 'U10', coachId: 'cN' })],
      slots: [],
      locked: [],
      placeableTeamIds: ['N'],
      dating: { liveFrom: SOLVER_DATED_TODAY, slots: new Map() },
      config: { timeBudgetMs: 20000, maxIterations: 10, seed: 1 },
    });
    assert.deepEqual(run.unassigned, [{ teamId: 'N', reason: 'no-slot-available' }]);
  });

  it('a slot the solver cannot date throws, naming it, and is what index.ts refuses', async () => {
    const { slots, dating } = solverDatedRun(SOLVER_DATED_CASES[0], toDaylightSlot);
    // The store holds no first date and the body's start and end fall on two
    // dates: `toDaylightSlot` reads no first date (plan §3.7).
    const overnight = {
      id: 'sN',
      start: new Date('2026-08-11T23:30:00-04:00'),
      end: new Date('2026-08-12T00:30:00-04:00'),
      capacity: 1,
    };
    const read = toDaylightSlot(overnight, SOLVER_DATED_ZONE, {
      fieldId: 'f',
      validUntil: '2026-11-20',
    });
    assert.equal(read.firstDate, null);
    const withOvernight = new Map([...dating.slots, ['sN', read]]);
    assert.deepEqual(undatableSlotIds(['sA', 'sB', 'sN'], withOvernight), ['sN']);
    // Each unreadable field on its own, and a window that does not end after it starts.
    const good = dating.slots.get('sA');
    for (const bad of [
      { firstDate: null },
      { effectiveUntil: '2026-02-30' },
      { startSeconds: null },
      { endSeconds: good.startSeconds },
      // 24:00 is not a wall time the scoring engine reads, so it is undatable here.
      { endSeconds: 86400 },
      { startSeconds: 1.5 },
    ]) {
      assert.deepEqual(
        undatableSlotIds(['sA'], new Map([['sA', { ...good, ...bad }]])),
        ['sA'],
        JSON.stringify(bad)
      );
    }
    assert.deepEqual(undatableSlotIds(['sA'], new Map()), ['sA'], 'a slot with no dating');
    assert.deepEqual(undatableSlotIds(['sA'], dating.slots), [], 'control: a dated slot');
    await assert.rejects(
      runPracticeOptimizer({
        teams: [],
        slots: [...slots, overnight],
        locked: [],
        placeableTeamIds: [],
        dating: { ...dating, slots: withOvernight },
        config: { timeBudgetMs: 20000, maxIterations: 10, seed: 1 },
      }),
      /SLOT_DATING_UNREADABLE: sN/
    );
  });
});

describe('a TIME TBD series is excluded from ordinary runs (decision 4)', () => {
  it('is classified TIME TBD, never placed, never reported as unplaced', async () => {
    const { classification, run } = await runFixture();
    for (const teamId of TIME_TBD_TEAMS) {
      assert.ok(classification.timeTbd.includes(teamId), `${teamId} is not classified TIME TBD`);
      assert.ok(!classification.placeable.includes(teamId), `${teamId} was offered to the run`);
      assert.ok(!run.placements.some((p) => p.teamId === teamId), `${teamId} was placed`);
      assert.ok(!run.unassigned.some((u) => u.teamId === teamId), `${teamId} reported unplaced`);
    }
    assert.equal(TIME_TBD_EXCLUDED_REASON, 'time-tbd-series');
  });

  it('every roster team lands in exactly one class', () => {
    const c = classifyTeamsForRun(
      ROSTER.map((t) => t.id),
      ROWS,
      TIME_TBD_TEAMS
    );
    const all = [...c.placeable, ...c.locked, ...c.timeTbd].sort();
    assert.deepEqual(all, ROSTER.map((t) => t.id).sort());
  });
});

describe('the client list is a cross-check: a mismatch refuses the run', () => {
  const client = ROWS.map(({ id, teamId, slotId, effectiveDateRange, assignedVia }) => ({
    id,
    teamId,
    slotId,
    effectiveDateRange,
    assignedVia,
  }));

  it('passes only when both sides name the same rows with the same fields', () => {
    assert.equal(crossCheckLockedAssignments(ROWS, client).ok, true);
  });

  it('refuses in each direction, and on a changed field, naming the ids', () => {
    const missing = crossCheckLockedAssignments(ROWS, client.slice(1));
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.missingFromClient, ['a-two-mon']);

    const extra = crossCheckLockedAssignments(ROWS, [...client, { ...client[0], id: 'a-ghost' }]);
    assert.equal(extra.ok, false);
    assert.deepEqual(extra.unknownToServer, ['a-ghost']);

    for (const change of [
      { slotId: 's-fri' },
      { teamId: 'new-1' },
      { effectiveDateRange: '[2026-10-01,2026-12-01)' },
      { assignedVia: 'manual' },
    ]) {
      const moved = crossCheckLockedAssignments(ROWS, [
        { ...client[0], ...change },
        ...client.slice(1),
      ]);
      assert.equal(moved.ok, false, JSON.stringify(change));
      assert.deepEqual(moved.differing, ['a-two-mon'], JSON.stringify(change));
    }

    const noId = crossCheckLockedAssignments(ROWS, [...client, { teamId: 'x', slotId: 's-fri' }]);
    assert.equal(noId.ok, false);
    assert.equal(noId.withoutId, 1);

    const text = describeLockMismatch(missing);
    assert.match(text, /a-two-mon/);
  });

  it('an old client that sent only manual rows without ids is refused', () => {
    const old = crossCheckLockedAssignments(ROWS, [{ teamId: 'one-row', slotId: 's-tue' }]);
    assert.equal(old.ok, false);
    assert.equal(old.missingFromClient.length, ROWS.length);
  });
});

describe('the lock is loaded as the caller, whole, and scoped like the writer', () => {
  // `serverCap` models PostgREST `max-rows`: a page never holds more rows
  // than the server allows, whatever range was asked for.
  function fakeClient(tables, { failOn = null, serverCap = Infinity } = {}) {
    const calls = [];
    return {
      calls,
      from(table) {
        const call = { table, filters: [], ranges: [], orders: [] };
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
            call.ranges.push([from, to]);
            if (failOn === table)
              return Promise.resolve({ data: null, error: { message: 'boom' } });
            const end = Math.min(to + 1, from + serverCap);
            // 11d-0: the lock also reads `kind = 'relocated'` exceptions; those
            // are seeded and witnessed in tests/autoSchedulerRelocatedLock.test.js.
            const relocatedRead = call.filters.some(
              ([op, col, v]) => op === 'eq' && col === 'kind' && v === 'relocated'
            );
            const rows = relocatedRead ? [] : tables[table];
            return Promise.resolve({ data: rows.slice(from, end), error: null });
          },
        };
        return q;
      },
    };
  }

  const dbRows = Array.from({ length: 5 }, (_, i) => ({
    id: `a${i}`,
    team_id: `t${i}`,
    practice_slot_id: `s${i}`,
    effective_date_range: '[2026-09-01,2026-12-01)',
    source: 'auto',
    assigned_via: i === 0 ? 'repair' : 'auto',
  }));

  it('a server cap below the page size is not read as the end of the rows', async () => {
    const client = fakeClient(
      { practice_assignments: dbRows, practice_exceptions: [] },
      { serverCap: 2 }
    );
    const lock = await loadSeasonPracticeLock(client, {
      organizationId: 'org',
      seasonSettingsId: 'season',
      pageSize: 1000,
    });
    assert.equal(lock.ok, true);
    assert.equal(lock.rows.length, dbRows.length, 'the capped first page ended the read');
  });

  it('reads the writer slot column when practice_slot_id is empty', async () => {
    const legacy = [{ ...dbRows[1], practice_slot_id: null, slot_id: 'legacy-slot' }];
    const client = fakeClient({ practice_assignments: legacy, practice_exceptions: [] });
    const lock = await loadSeasonPracticeLock(client, {
      organizationId: 'o',
      seasonSettingsId: 's',
    });
    assert.equal(lock.ok, true);
    assert.equal(lock.rows[0].slotId, 'legacy-slot');
  });

  it('reads every page past the PostgREST cap, never a truncated first page', async () => {
    const client = fakeClient({
      practice_assignments: dbRows,
      practice_exceptions: [{ id: 'e1', team_id: 't3' }],
    });
    const lock = await loadSeasonPracticeLock(client, {
      organizationId: 'org',
      seasonSettingsId: 'season',
      pageSize: 2,
    });
    assert.equal(lock.ok, true);
    assert.deepEqual(
      lock.rows.map((r) => r.id),
      dbRows.map((r) => r.id)
    );
    assert.equal(lock.rows[0].assignedVia, 'repair');
    assert.deepEqual(lock.timeTbdTeamIds, ['t3']);
    const assignmentsCall = client.calls.find((c) => c.table === 'practice_assignments');
    assert.ok(client.calls.filter((c) => c.table === 'practice_assignments').length >= 3);
    assert.ok(
      assignmentsCall.filters.some(
        ([, col, v]) => col === 'teams.divisions.season_settings_id' && v === 'season'
      )
    );
    const exceptionsCall = client.calls.find((c) => c.table === 'practice_exceptions');
    assert.ok(
      exceptionsCall.filters.some(
        ([op, col, v]) => op === 'eq' && col === 'kind' && v === 'time_tbd'
      )
    );
    assert.ok(
      exceptionsCall.filters.some(
        ([op, col, v]) => op === 'is' && col === 'withdrawn_at' && v === null
      )
    );
    // Offset paging is only whole over a stable order: every page of every
    // lock read is ordered by id, ascending.
    for (const call of client.calls) {
      assert.deepEqual(call.orders, [['id', true]], `${call.table} page is not ordered by id`);
    }
  });

  it('a failed read is a refusal, not an empty lock', async () => {
    for (const table of ['practice_assignments', 'practice_exceptions']) {
      const client = fakeClient(
        { practice_assignments: dbRows, practice_exceptions: [] },
        { failOn: table }
      );
      const lock = await loadSeasonPracticeLock(client, {
        organizationId: 'o',
        seasonSettingsId: 's',
      });
      assert.equal(lock.ok, false, table);
    }
  });
});

describe('auto-scheduler/index.ts wiring (source pin)', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'supabase/functions/auto-scheduler/index.ts'),
    'utf8'
  );

  it('loads the lock with the USER-scoped client, not the service role', () => {
    assert.match(
      source,
      /loadSeasonPracticeLock\(createUserClient\(req, supabaseUrl, anonKey\)/,
      'the lock is not read as the caller'
    );
  });

  it('refuses the run when the cross-check fails', () => {
    const call = source.indexOf('crossCheckLockedAssignments(lock.rows, input.lockedAssignments)');
    assert.ok(call >= 0, 'the cross-check is not called on the loaded rows');
    const guard = source.slice(call, call + 2000);
    assert.match(
      guard,
      /if \(!lockCheck\.ok\) \{[\s\S]*?code: 'LOCKED_ASSIGNMENTS_MISMATCH'[\s\S]*?409/
    );
  });

  it('searches the placeable teams only, locks every loaded row, and returns only placements', () => {
    assert.match(source, /placeableTeamIds: classification\.placeable/);
    assert.match(source, /locked: lock\.rows\.map\(/);
    assert.match(source, /const bestAssignments = run\.placements;/);
    assert.match(source, /assignments: bestAssignments\.map\(/);
    // M4.8: each placement goes out with the range it was judged on.
    assert.match(source, /effectiveDateRange: run\.placementRanges\[placement\.teamId\],/);
    assert.doesNotMatch(source, /input\.lockedAssignments\.map|generateGreedySeed/);
  });

  it('dates the run from the store, refuses a slot it cannot date, and returns liveFrom (M4.8)', () => {
    // One today and one dating, shared with the daylight pass.
    assert.match(source, /const liveFrom = seasonCalendarDate\(Date\.now\(\), season\.timezone\);/);
    assert.match(source, /today: liveFrom,/);
    assert.match(source, /dating: \{ liveFrom, slots: daylightSlots \}/);
    assert.match(source, /slots: daylightSlots,/);
    // The refusal precedes the solver, as a 422 naming the slots (Q3).
    const guard = source.indexOf('if (liveFrom === null || undatable.length > 0) {');
    const solve = source.indexOf('await runPracticeOptimizer(');
    assert.ok(guard >= 0 && solve > guard, 'the dating refusal does not precede the solver');
    assert.match(
      source.slice(guard, guard + 2500),
      /return jsonResponse\([\s\S]*?code: SLOT_DATING_UNREADABLE,[\s\S]*?slotIds: undatable,[\s\S]*?422/
    );
    // The response carries the date judged, and the lock its ended and unreadable rows.
    const response = source.slice(source.indexOf('// 13. Response'));
    assert.match(response, /liveFrom: run\.liveFrom,/);
    assert.match(response, /endedRows: run\.endedRows\.map\(/);
    assert.match(response, /unreadableRange: run\.unreadableRange\.map\(/);
  });

  it('fails the run when its evaluation record does not save, before auditing it completed', () => {
    // It used to `console.error` and carry on: the response and the `scheduler.auto_completed`
    // row went out with a null runId, and the failure reached only the function's console.
    // fairness-scoring throws on the same RPC; this adopts its contract.
    const persist = source.indexOf(".rpc('persist_evaluation_run'");
    const completed = source.indexOf("action: 'scheduler.auto_completed'");
    assert.ok(persist >= 0 && completed > persist, 'the run is not recorded before it is audited');
    const between = source.slice(persist, completed);
    assert.match(
      between,
      /if \(persistError\) \{\s*throw Object\.assign\(new Error\(`Persistence failed: \$\{persistError\.message\}`\)/
    );
    assert.doesNotMatch(between, /console\.(error|log|warn)/);
    // The throw lands in the handler's catch, which logs it and audits the failure.
    const handlerCatch = source.slice(source.lastIndexOf('} catch (error) {'));
    assert.match(handlerCatch, /await logFailure\(logCtx, 'Auto-scheduler failed', error\);/);
    assert.match(handlerCatch, /action: 'scheduler\.auto_failed'/);
    assert.match(handlerCatch, /500\)/);
  });

  it('audits the locked rows loaded and the placements proposed', () => {
    const completed = source.slice(source.indexOf("action: 'scheduler.auto_completed'"));
    assert.match(completed, /lockedLoaded: lock\.rows\.length/);
    assert.match(completed, /placementsProposed: bestAssignments\.length/);
  });
});

describe('the page payload (plan §3 "Payload builder")', () => {
  it("the review dates new placements from the run's liveFrom, not the page's clock (M4.8 Q7)", () => {
    assert.equal(runLiveFrom({ liveFrom: '2026-10-17' }), '2026-10-17');
    // Anything else is not a date the page may write from: it falls back.
    for (const bad of [undefined, null, '', '2026-10-17T00:00:00Z', '2026-02-30', 20261017]) {
      assert.equal(runLiveFrom({ liveFrom: bad }), null, String(bad));
    }
    assert.equal(runLiveFrom(null), null);
    const page = readFileSync(
      path.join(process.cwd(), 'frontend/src/pages/PracticeSchedulingPage.jsx'),
      'utf8'
    );
    assert.match(page, /const pageToday = seasonCalendarDate\(Date\.now\(\), timezone\);/);
    assert.match(page, /const seasonToday = runLiveFrom\(autoScheduler\.result\) \?\? pageToday;/);
    // The staged range starts from the run's date; "ended" is judged on the later clock.
    assert.match(page, /newPlacementRange\(\s*slot,\s*seasonToday,/);
    assert.match(page, /slot\.effectiveUntil < endedBefore/);
    const hook = readFileSync(
      path.join(process.cwd(), 'frontend/src/hooks/useAutoScheduler.js'),
      'utf8'
    );
    assert.match(hook, /liveFrom: data\.liveFrom \?\? null,/);
  });

  it('a new placement starts at max(slot.validFrom, today on the season clock)', () => {
    const slotWindow = { effectiveFrom: '2026-09-01', effectiveUntil: '2026-11-30' };
    assert.equal(newPlacementRange(slotWindow, '2026-10-15'), '[2026-10-15,2026-11-30]');
    assert.equal(newPlacementRange(slotWindow, '2026-08-20'), '[2026-09-01,2026-11-30]');
  });

  it("today is the season's date, not the host's or UTC's", () => {
    // 03:00Z on 1 Oct is still 30 Sep in Los Angeles and already 1 Oct in UTC.
    const instant = Date.parse('2026-10-01T03:00:00Z');
    assert.equal(seasonCalendarDate(instant, 'America/Los_Angeles'), '2026-09-30');
    assert.equal(seasonCalendarDate(instant, 'UTC'), '2026-10-01');
    assert.equal(seasonCalendarDate(instant, null), null);
    assert.equal(seasonCalendarDate(instant, 'Not/AZone'), null);
  });

  it('a persisted row keeps its id, exact range and provenance; a synthetic id is not sent', () => {
    const persisted = toPersistenceAssignment({
      id: 'a-two-mon',
      teamId: 'two-row',
      practiceSlotId: 's-mon',
      source: 'auto',
      effectiveDateRange: '[2026-09-15,2026-12-01)',
      assignedVia: 'repair',
    });
    assert.deepEqual(persisted, {
      id: 'a-two-mon',
      teamId: 'two-row',
      slotId: 's-mon',
      source: 'auto',
      effectiveDateRange: '[2026-09-15,2026-12-01)',
      assignedVia: 'repair',
      effectiveFrom: '2026-09-15',
      effectiveUntil: '2026-11-30',
    });
    const staged = toPersistenceAssignment({
      id: 'run-x-new-1',
      persisted: false,
      teamId: 'new-1',
      slotId: 's-fri',
    });
    assert.equal(staged.id, null);
    // An open-ended stored range is sent verbatim for the cross-check (the
    // function compares the raw string) and leaves the builder's bounds unset.
    const open = toPersistenceAssignment({
      id: 'a-open',
      teamId: 't1',
      slotId: 's-mon',
      effectiveDateRange: '[2026-11-02,)',
    });
    assert.equal(open.effectiveDateRange, '[2026-11-02,)');
    assert.equal(open.effectiveFrom, undefined);
    assert.equal(open.effectiveUntil, undefined);
  });

  it('the row the writer receives keeps the persisted key and the v2 key set', () => {
    const [rowOut] = buildPracticeAssignmentRows({
      assignments: [
        toPersistenceAssignment({
          id: 'a1',
          teamId: 't1',
          slotId: 'slot-a',
          effectiveDateRange: '[2026-09-15,2026-12-01)',
          assignedVia: 'auto',
        }),
      ],
      slots: [{ id: 'slot-a', effectiveFrom: '2026-09-01', effectiveUntil: '2026-11-30' }],
    });
    // `[2026-09-15,2026-11-30]` is the same daterange Postgres stored as
    // `[2026-09-15,2026-12-01)`, so the v3 lock sees its key unchanged.
    assert.equal(rowOut.effective_date_range, '[2026-09-15,2026-11-30]');
    assert.deepEqual(Object.keys(rowOut).sort(), [
      'effective_date_range',
      'practice_slot_id',
      'run_id',
      'source',
      'team_id',
    ]);
  });
});
