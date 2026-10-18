/**
 * 8.6 3b PR 11d-0, the Deno arm: the auto-scheduler holds a live relocated
 * slot season-wide (plan §3 gap G2). The Vitest arm,
 * `tests/autoSchedulerRelocatedLock.test.js`, runs the same modules over the
 * same seed (`tests/fixtures/relocatedLockCases.js`); this arm proves they
 * behave the same under Deno, where the Edge Function actually runs.
 *
 * Subject sets are the seed's labels (`RELOCATED_EXPECT`) and slots, never
 * the loader's or the solver's output.
 */
import { assert, assertEquals } from 'https://deno.land/std@0.203.0/assert/mod.ts';
import {
  buildLockedOccupancy,
  dateSchedulerSlots,
  runPracticeOptimizer,
  type SchedulerSlot,
} from '../engines/auto-scheduler-solver.ts';
import { toDaylightSlot } from '../engines/practice-daylight.ts';
import {
  liveRelocationsOf,
  loadSeasonPracticeLock,
  type LockReader,
  type QueryResult,
} from '../engines/practice-lock.ts';
import { prepareTeam } from '../engines/practice-coaches.ts';
import {
  GREEDY_ONLY,
  RELOCATED_DB_ASSIGNMENTS,
  RELOCATED_DB_EXCEPTIONS,
  RELOCATED_EXPECT,
  RELOCATED_ROSTER,
  RELOCATED_SLOTS,
} from '../../../../tests/fixtures/relocatedLockCases.js';
import {
  SOLVER_DATED_CASES,
  SOLVER_DATED_TODAY,
  seasonLongDating,
  solverDatedRun,
} from '../../../../tests/fixtures/solverDatedCases.js';

type Row = Record<string, unknown>;

/**
 * Applies only the `kind` filter, so the loader's own live filter is what runs.
 * Order is modelled as in the Vitest arm: `order('id', ascending)` sorts by
 * id; without it the first page comes back in insertion order and every
 * later page in reverse (an order that changed between pages), so offset
 * paging repeats the first row and skips the last, for any two or more rows.
 */
function fakeClient(relocated: Row[]): LockReader {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      let orderedById = false;
      const q = {
        select: () => q,
        eq(col: string, val: unknown) {
          filters.push([col, val]);
          return q;
        },
        is: () => q,
        order(col: string, options?: { ascending?: boolean }) {
          if (col === 'id' && (options?.ascending ?? true)) orderedById = true;
          return q;
        },
        range(from: number, to: number): PromiseLike<QueryResult> {
          const kind = filters.find(([col]) => col === 'kind')?.[1];
          const rows: Row[] =
            table === 'practice_assignments'
              ? [...RELOCATED_DB_ASSIGNMENTS]
              : kind === 'relocated'
                ? [...relocated]
                : [];
          if (orderedById) rows.sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
          else if (from > 0) rows.reverse();
          return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
        },
      };
      return q;
    },
  };
}

const slots = RELOCATED_SLOTS as unknown as SchedulerSlot[];
const teams = RELOCATED_ROSTER.map((t) => ({ ...prepareTeam(t), division: t.division }));
const teamsById = new Map(teams.map((t) => [t.id, t]));
const slotsById = new Map(slots.map((s) => [s.id, s]));
const seed = new Map<string, Row>(RELOCATED_DB_EXCEPTIONS.map((x: Row) => [String(x.id), x]));
const lockedTeams = new Set(RELOCATED_DB_ASSIGNMENTS.map((r: Row) => String(r.team_id)));
const placeable = RELOCATED_ROSTER.map((t) => t.id).filter((id) => !lockedTeams.has(id));
const slotOf = (id: string) => String(seed.get(id)!.practice_slot_id);
/** M4.8: the seed's dating, season-long from each slot's first occurrence (the Vitest arm's). */
const DATING = seasonLongDating(slots, toDaylightSlot, {
  timeZone: 'UTC',
  until: '2026-11-30',
  liveFrom: '2026-09-07',
});
const datedSlotsById = new Map(dateSchedulerSlots(slots, DATING).map((s) => [s.id, s]));

async function loadSeed() {
  const lock = await loadSeasonPracticeLock(fakeClient([...RELOCATED_DB_EXCEPTIONS]), {
    organizationId: 'org',
    seasonSettingsId: 'season',
  });
  if (!lock.ok) throw new Error(lock.message);
  return lock;
}

function lockedOf(lock: Awaited<ReturnType<typeof loadSeed>>) {
  return lock.rows.map((r) => ({ assignmentId: r.id, teamId: r.teamId, slotId: r.slotId }));
}

Deno.test(
  'relocated lock - paging one row at a time loads every live relocation once',
  async () => {
    const lock = await loadSeasonPracticeLock(fakeClient([...RELOCATED_DB_EXCEPTIONS]), {
      organizationId: 'org',
      seasonSettingsId: 'season',
      pageSize: 1,
    });
    if (!lock.ok) throw new Error(lock.message);
    const live = [...RELOCATED_EXPECT.liveInRun, ...RELOCATED_EXPECT.outsideRun];
    assert(live.length >= 2, 'fewer than two relocations: paging proves nothing');
    assertEquals(
      lock.relocations.map((r) => r.exceptionId).sort(),
      [...live].sort(),
      'paging skipped or repeated a relocation'
    );
    assertEquals(
      lock.rows.map((r) => r.id).sort(),
      RELOCATED_DB_ASSIGNMENTS.map((r: Row) => String(r.id)).sort(),
      'paging skipped or repeated a locked row'
    );
  }
);

Deno.test(
  'relocated lock - control: without the hold, the run takes every relocated slot',
  async () => {
    // The seed must tempt the run onto each held slot, or the hold witnesses
    // below would pass with no hold at all.
    const lock = await loadSeed();
    const run = await runPracticeOptimizer({
      teams,
      slots,
      locked: lockedOf(lock),
      placeableTeamIds: placeable,
      dating: DATING,
      config: { ...GREEDY_ONLY },
    });
    const taken = new Set(run.placements.map((p) => p.slotId));
    for (const id of RELOCATED_EXPECT.liveInRun) {
      assert(taken.has(slotOf(id)), `the control left ${slotOf(id)} (${id}) empty`);
    }
  }
);

Deno.test(
  'relocated lock - the loader drops withdrawn rows itself and keeps every live one',
  async () => {
    const lock = await loadSeed();
    const loaded = new Set(lock.relocations.map((r) => r.exceptionId));
    for (const id of RELOCATED_EXPECT.withdrawn) assert(!loaded.has(id), `${id} was loaded live`);
    for (const id of [...RELOCATED_EXPECT.liveInRun, ...RELOCATED_EXPECT.outsideRun]) {
      assert(loaded.has(id), `live ${id} was not loaded`);
    }
  }
);

Deno.test('relocated lock - a row with no withdrawn_at key refuses the read', () => {
  const { withdrawn_at: _drop, ...unjudged } = RELOCATED_DB_EXCEPTIONS[0] as Row;
  const judged = liveRelocationsOf([unjudged]);
  assert(judged.refusal !== null, 'an unjudgeable relocation was read as live or as withdrawn');
  // A row of another kind is not what the read asked for: refused, never slotless.
  const tbd = { ...(RELOCATED_DB_EXCEPTIONS[0] as Row), kind: 'time_tbd', practice_slot_id: null };
  assert(liveRelocationsOf([tbd]).refusal !== null, 'a time_tbd row was read as a relocation');
});

Deno.test('relocated lock - each live in-run relocation holds a unit and its coaches', async () => {
  const lock = await loadSeed();
  const base = buildLockedOccupancy(
    lockedOf(lock),
    teamsById,
    datedSlotsById,
    lock.relocations,
    DATING.liveFrom
  );
  const heldUnits = (slotId: string) => base.slotOccupants.get(slotId)?.length ?? 0;
  for (const id of RELOCATED_EXPECT.liveInRun) {
    const held = slotsById.get(slotOf(id))!;
    const units: Record<string, number> = RELOCATED_EXPECT.unitsHeld;
    assertEquals(heldUnits(held.id), units[held.id], `${id} units`);
    for (const coachId of teamsById.get(String(seed.get(id)!.team_id))!.coachIds) {
      assert(
        (base.coachAssignments.get(coachId) ?? []).some((w) => w.slotId === held.id),
        `${id} does not hold coach ${coachId}`
      );
    }
  }
  for (const id of RELOCATED_EXPECT.withdrawn) {
    const slot = slotsById.get(slotOf(id))!;
    assertEquals(heldUnits(slot.id), 0, `withdrawn ${id} holds its slot`);
  }
  assertEquals(
    base.relocatedOutsideRun.map((r) => r.exceptionId).sort(),
    [...RELOCATED_EXPECT.outsideRun].sort()
  );
});

Deno.test(
  'relocated lock - the greedy seed double-books no slot and frees the withdrawn one',
  async () => {
    const lock = await loadSeed();
    const run = await runPracticeOptimizer({
      teams,
      slots,
      locked: lockedOf(lock),
      relocated: lock.relocations,
      placeableTeamIds: placeable,
      dating: DATING,
      config: { ...GREEDY_ONLY },
    });
    const used = new Map<string, number>();
    const bump = (id: string) => used.set(id, (used.get(id) ?? 0) + 1);
    for (const r of RELOCATED_DB_ASSIGNMENTS) bump(String(r.practice_slot_id));
    const units: Record<string, number> = RELOCATED_EXPECT.unitsHeld;
    for (const [slotId, n] of Object.entries(units)) for (let i = 0; i < n; i += 1) bump(slotId);
    for (const p of run.placements) bump(p.slotId);
    for (const slot of slots) {
      assert((used.get(slot.id) ?? 0) <= slot.capacity, `${slot.id} is double-booked`);
      // One unit per (row, slot): the rest of a held slot is offered.
      const free = slot.capacity - (units[slot.id] ?? 0);
      if (slot.id in units && free > 0) {
        assertEquals(
          run.placements.filter((p) => p.slotId === slot.id).length,
          free,
          `${slot.id} does not offer its free unit(s)`
        );
      }
    }
    const { team, twinSlot } = RELOCATED_EXPECT.coachWitness;
    const seated = run.placements.find((p) => p.teamId === team);
    assert(seated && seated.slotId !== twinSlot, `${team} was booked against the moved practice`);
    for (const id of RELOCATED_EXPECT.withdrawn) {
      assert(
        run.placements.some((p) => p.slotId === slotOf(id)),
        `withdrawn ${id} still holds its slot`
      );
    }
    assertEquals(
      run.relocatedOutsideRun.map((r) => r.exceptionId).sort(),
      [...RELOCATED_EXPECT.outsideRun].sort()
    );
  }
);

// ---------------------------------------------------------------------------
// M4.8: the dated hard constraint, over the table the Vitest arm runs
// (`tests/autoSchedulerLock.test.js`), so the two runtimes answer one table.
// ---------------------------------------------------------------------------

for (const testCase of SOLVER_DATED_CASES) {
  Deno.test(`dated solver - ${testCase.name}`, async () => {
    const { slots: caseSlots, dating } = solverDatedRun(testCase, toDaylightSlot);
    const run = await runPracticeOptimizer({
      teams: testCase.teams.map((t) => ({ ...prepareTeam(t), division: t.division })),
      slots: caseSlots as unknown as SchedulerSlot[],
      locked: testCase.locked,
      placeableTeamIds: [...testCase.placeable],
      dating,
      config: { timeBudgetMs: 20000, maxIterations: 300, seed: 42 },
    });
    assertEquals(
      run.placements.map((p) => `${p.teamId} -> ${p.slotId}`).sort(),
      [...testCase.expect.placements].sort(),
      'placements'
    );
    assertEquals(
      run.unassigned.map((u) => `${u.teamId}: ${u.reason}`).sort(),
      [...testCase.expect.unassigned].sort(),
      'unplaced'
    );
    assertEquals(
      run.endedRows.map((r) => r.assignmentId),
      [...testCase.expect.ended]
    );
    assertEquals(
      run.unreadableRange.map((r) => r.assignmentId),
      [...testCase.expect.unreadable]
    );
    assertEquals(run.evaluation.summary.dateModel, 'dated');
    assertEquals(run.evaluation.coachConflicts.length, 0, 'the search created a conflict');
    assertEquals(run.liveFrom, SOLVER_DATED_TODAY);
  });
}

Deno.test('dated solver - the table reaches every shape, so no case is vacuous', () => {
  const names = SOLVER_DATED_CASES.map((c) => c.name);
  for (const shape of ['W4-S1', 'W4-S2', 'E1', 'E2', 'E3', 'DST', 'cannot be read']) {
    assert(
      names.some((n) => n.includes(shape)),
      `no case for ${shape}`
    );
  }
  assert(SOLVER_DATED_CASES.length >= 12, 'the table lost cases');
});
