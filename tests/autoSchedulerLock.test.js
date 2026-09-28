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

import { runPracticeOptimizer } from '../supabase/functions/_shared/engines/auto-scheduler-solver.js';
import {
  classifyTeamsForRun,
  crossCheckLockedAssignments,
  describeLockMismatch,
  loadSeasonPracticeLock,
  TIME_TBD_EXCLUDED_REASON,
} from '../supabase/functions/_shared/engines/practice-lock.js';
import { prepareTeam } from '../supabase/functions/_shared/engines/practice-coaches.js';
import { seasonCalendarDate } from '../packages/core/src/timing/index.js';
import { buildPracticeAssignmentRows } from '../packages/core/src/practiceSupabase.js';
import {
  newPlacementRange,
  toPersistenceAssignment,
} from '../frontend/src/pages/PracticeSchedulingPage.jsx';

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
    coachPreferences: {},
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
        const call = { table, filters: [], ranges: [] };
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
          order() {
            return q;
          },
          range(from, to) {
            call.ranges.push([from, to]);
            if (failOn === table)
              return Promise.resolve({ data: null, error: { message: 'boom' } });
            const end = Math.min(to + 1, from + serverCap);
            return Promise.resolve({ data: tables[table].slice(from, end), error: null });
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
    assert.match(source, /assignments: bestAssignments,/);
    assert.doesNotMatch(source, /input\.lockedAssignments\.map|generateGreedySeed/);
  });

  it('audits the locked rows loaded and the placements proposed', () => {
    const completed = source.slice(source.indexOf("action: 'scheduler.auto_completed'"));
    assert.match(completed, /lockedLoaded: lock\.rows\.length/);
    assert.match(completed, /placementsProposed: bestAssignments\.length/);
  });
});

describe('the page payload (plan §3 "Payload builder")', () => {
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
