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
  runPracticeOptimizer,
  type SchedulerSlot,
} from '../engines/auto-scheduler-solver.ts';
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

type Row = Record<string, unknown>;

/** Applies only the `kind` filter, so the loader's own live filter is what runs. */
function fakeClient(relocated: Row[]): LockReader {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const q = {
        select: () => q,
        eq(col: string, val: unknown) {
          filters.push([col, val]);
          return q;
        },
        is: () => q,
        order: () => q,
        range(from: number, to: number): PromiseLike<QueryResult> {
          const kind = filters.find(([col]) => col === 'kind')?.[1];
          const rows: Row[] =
            table === 'practice_assignments'
              ? [...RELOCATED_DB_ASSIGNMENTS]
              : kind === 'relocated'
                ? relocated
                : [];
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
  const base = buildLockedOccupancy(lockedOf(lock), teamsById, slotsById, lock.relocations);
  for (const id of RELOCATED_EXPECT.liveInRun) {
    const held = slotsById.get(slotOf(id))!;
    const units: Record<string, number> = RELOCATED_EXPECT.unitsHeld;
    assertEquals(base.slotCapacity.get(held.id), held.capacity - units[held.id], `${id} units`);
    for (const coachId of teamsById.get(String(seed.get(id)!.team_id))!.coachIds) {
      assert(
        (base.coachAssignments.get(coachId) ?? []).some((w) => w.slotId === held.id),
        `${id} does not hold coach ${coachId}`
      );
    }
  }
  for (const id of RELOCATED_EXPECT.withdrawn) {
    const slot = slotsById.get(slotOf(id))!;
    assertEquals(base.slotCapacity.get(slot.id), slot.capacity, `withdrawn ${id} holds its slot`);
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
