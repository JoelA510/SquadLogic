/**
 * **The one seed both arms of the 11d-0 witness are held to** (8.6 3b PR 11d-0,
 * `docs/PHASE_8_6_PR11D_BLACKOUT_ENACT_PLAN.md` §3 gap G2, §6 row 11d-0).
 *
 * The auto-scheduler's lock must hold the slot a live `relocated`
 * `practice_exceptions` row moved a practice onto, season-wide, as it holds a
 * locked row's own slot. `tests/autoSchedulerRelocatedLock.test.js` (Vitest)
 * and `supabase/functions/_shared/tests/practice-lock_test.ts` (Deno) run the
 * same Edge modules over this table, so parity is through this file rather
 * than claimed by a comment in either.
 *
 * Plain ESM with no imports, so Deno loads it by relative path. Synthetic ids
 * only.
 *
 * ## The seed
 *
 * Three locked teams, each on its own slot, each with a live relocation onto
 * a slot an ordinary run would otherwise fill first (the slot order below is
 * the greedy seed's order). The windows are a bounded one, an open one and an
 * unreadable one: the hold is season-wide, so none of them is read, and each
 * must hold its slot all the same. One more relocation is withdrawn, one names
 * a slot outside the run, and one carries no slot at all (the table's CHECK
 * forbids that; it is defended, not reachable).
 *
 * `p-coach` shares a coach with `moved`, and `s-twin` runs at the same time as
 * `moved`'s relocated slot `s-target`: it is the coach-window witness.
 */

/** Slot instants, UTC, in the week of Monday 2026-09-07. */
function slot(id, date, startHour, capacity) {
  const hh = String(startHour).padStart(2, '0');
  const h2 = String(startHour + 1).padStart(2, '0');
  return {
    id,
    start: new Date(`${date}T${hh}:00:00Z`),
    end: new Date(`${date}T${h2}:00:00Z`),
    capacity,
  };
}

/**
 * Order matters: the greedy seed takes the first legal slot, so a slot the
 * lock fails to hold is the one a placeable team lands on.
 */
export const RELOCATED_SLOTS = Object.freeze([
  slot('s-target', '2026-09-08', 17, 1),
  slot('s-open', '2026-09-09', 17, 1),
  slot('s-garbled', '2026-09-10', 17, 1),
  // Same instant as `s-target`: free of capacity, but `moved`'s coach is there.
  slot('s-twin', '2026-09-08', 17, 1),
  slot('s-freed', '2026-09-11', 17, 1),
  slot('s-spare', '2026-09-07', 20, 10),
  slot('s-own-a', '2026-09-07', 17, 1),
  slot('s-own-b', '2026-09-07', 18, 1),
  slot('s-own-c', '2026-09-07', 19, 1),
]);

export const RELOCATED_ROSTER = Object.freeze([
  { id: 'moved', division: 'U10', coachId: 'c-moved' },
  { id: 'moved-b', division: 'U10', coachId: 'c-b' },
  { id: 'moved-c', division: 'U10', coachId: 'c-c' },
  { id: 'p-coach', division: 'U10', coachId: 'c-moved' },
  { id: 'p-1', division: 'U10', coachId: 'c-p1' },
  { id: 'p-2', division: 'U10', coachId: 'c-p2' },
  { id: 'p-3', division: 'U10', coachId: 'c-p3' },
  { id: 'p-4', division: 'U10', coachId: 'c-p4' },
]);

/** `practice_assignments` rows, as the database returns them. */
export const RELOCATED_DB_ASSIGNMENTS = Object.freeze([
  dbRow('a-moved', 'moved', 's-own-a'),
  dbRow('a-moved-b', 'moved-b', 's-own-b'),
  dbRow('a-moved-c', 'moved-c', 's-own-c'),
]);

function dbRow(id, teamId, slotId) {
  return {
    id,
    team_id: teamId,
    practice_slot_id: slotId,
    slot_id: null,
    effective_date_range: '[2026-09-07,2026-11-30]',
    assigned_via: 'auto',
  };
}

/**
 * `practice_exceptions` rows of kind `relocated`, as the database returns
 * them -- withdrawn ones included, because the loader must filter them itself
 * whatever the query selected (plan §2.1 rule 1).
 */
export const RELOCATED_DB_EXCEPTIONS = Object.freeze([
  dbException('x-live', 'a-moved', 'moved', 's-target', '[2026-09-08,2026-09-08]', null),
  dbException('x-open', 'a-moved-b', 'moved-b', 's-open', '[2026-10-07,)', null),
  dbException('x-garbled', 'a-moved-c', 'moved-c', 's-garbled', 'garbled', null),
  dbException(
    'x-withdrawn',
    'a-moved',
    'moved',
    's-freed',
    '[2026-09-11,2026-09-11]',
    '2026-09-01T00:00:00Z'
  ),
  dbException('x-outside', 'a-moved-b', 'moved-b', 's-not-in-run', '[2026-09-14,2026-09-14]', null),
  dbException('x-no-slot', 'a-moved-c', 'moved-c', null, '[2026-09-21,2026-09-21]', null),
]);

function dbException(id, assignmentId, teamId, slotId, window, withdrawnAt) {
  return {
    id,
    assignment_id: assignmentId,
    team_id: teamId,
    practice_slot_id: slotId,
    kind: 'relocated',
    window,
    withdrawn_at: withdrawnAt,
  };
}

/**
 * What the seed is, written down independently of any filter under test: the
 * subject sets of the witnesses are these lists, never the loader's output.
 */
export const RELOCATED_EXPECT = Object.freeze({
  /** Live, on a slot of the run: each must hold its slot. */
  liveInRun: Object.freeze(['x-live', 'x-open', 'x-garbled']),
  /** Withdrawn: must hold nothing. */
  withdrawn: Object.freeze(['x-withdrawn']),
  /** Live, but the run holds no time for the slot: reported, never dropped. */
  outsideRun: Object.freeze(['x-outside', 'x-no-slot']),
  /** The team whose coach is at `s-target` through `x-live`, and its coach's twin slot. */
  coachWitness: Object.freeze({ team: 'p-coach', relocation: 'x-live', twinSlot: 's-twin' }),
});

/** Greedy seed only: the placements are exactly the seed's, so they can be named. */
export const GREEDY_ONLY = Object.freeze({ timeBudgetMs: 20000, maxIterations: 0, seed: 7 });
/** The hill climb as well: only invariants are asserted over it. */
export const WITH_CLIMB = Object.freeze({ timeBudgetMs: 20000, maxIterations: 400, seed: 11 });
