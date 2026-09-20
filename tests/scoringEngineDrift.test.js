/**
 * Cross-arm drift check: `packages/core`'s `evaluatePracticeSchedule` against
 * the Edge Function's `_shared/engines/scoring-engine.ts`.
 *
 * ## Why this file exists
 *
 * There are two implementations of `evaluatePracticeSchedule`, and nothing
 * compared them. They drifted: the Edge arm computed
 * `assignedTeams = assignments.length` while core computed
 * `assignedTeamIds.size`, so a team holding two practice slots -- a supported
 * case, with its own core test ("correctly counts teams assigned to multiple
 * slots") -- counted twice. Ten teams with twelve assignments published
 * `unassignedTeams: -2` and `coveragePercent: 120`.
 *
 * Three layers each failed to catch it, and all three are addressed:
 *   1. `scoring-engine_test.ts` was never run by CI (fixed: discovery, see
 *      `scripts/deno-mirror-tests.sh`).
 *   2. It would not have caught it anyway -- its one summary case used two
 *      teams with one assignment each, where `assignments.length` and the
 *      distinct count coincide. **The case that exposes the defect is the case
 *      it omitted**, so every vector table below contains one.
 *   3. `scoring-engine.ts` had no cross-arm check at all, unlike `seasonClock`.
 *      This file is that check.
 *
 * ## Why Vitest, and not a shared vectors table like the season clock's
 *
 * The season clock mirrors through `seasonClock.vectors.json` because **an
 * Edge Function cannot import `packages/core`** -- true, and still true. But
 * that constrains only the Edge->core direction. The reverse holds: Vitest
 * imports the Edge engine directly and already did before this file existed
 * (`tests/unit/scoring-engine.test.ts` has imported
 * `_shared/engines/scoring-engine.js` since it was written). So both arms can
 * be called in one process and compared value-against-value, which is strictly
 * stronger than two arms agreeing with a table: a table can be wrong about
 * both, and it cannot compare fields it does not enumerate.
 *
 * ## The contract, stated -- because "isomorphic" was never true
 *
 * `auto-scheduler/index.ts` called the engine "the isomorphic scoring-engine"
 * and the roadmap called it "Isomorphic `evaluatePracticeSchedule` shared
 * between client and Edge Function". The two functions do not return the same
 * shape and never have: core publishes thirteen top-level keys, the Edge arm
 * six, and only three of those names appear in both. The Edge arm is a
 * **subset** built to score hill-climbing candidates, not a port.
 *
 * What is actually promised is narrower and is what this file pins:
 * `AGREED_SUMMARY_COUNTS` and the per-slot occupancy must be identical, and
 * the arms must agree on *whether* a coach is double-booked. Everything else
 * is arm-specific and deliberately unchecked here -- listed in
 * `CORE_ONLY_KEYS` / `EDGE_ONLY_KEYS` so that "not compared" is written down
 * rather than left to be discovered as another silent divergence.
 */
import { describe, expect, it } from 'vitest';
import { evaluatePracticeSchedule as coreEvaluate } from '@squadlogic/core/practiceMetrics.js';
import { evaluatePracticeSchedule as edgeEvaluate } from '../supabase/functions/_shared/engines/scoring-engine.js';

/** Summary fields both arms publish under the same name, which must agree. */
const AGREED_SUMMARY_COUNTS = ['totalTeams', 'assignedTeams', 'unassignedTeams'];

/** Published by core alone. Named so their absence from the Edge arm is a stated fact. */
const CORE_ONLY_KEYS = [
  'baseSlotDistribution',
  'divisionDayDistribution',
  'divisionBaseSlotDistribution',
  'dayConcentrationAlerts',
  'coachLoad',
  'dataQualityWarnings',
  'fairnessConcerns',
  'underutilizedBaseSlots',
  'unassignedByReason',
  'manualFollowUpBreakdown',
];

/** Published by the Edge arm alone. */
const EDGE_ONLY_KEYS = ['status', 'issues', 'manualFollowUpResults'];

const slot = (id, day, startIso, endIso, capacity) => ({
  id,
  capacity,
  day,
  start: startIso,
  end: endIso,
});

/**
 * The shared vectors. Each names the divergence it is here to catch, so a
 * vector cannot be deleted without deleting a stated reason.
 */
const VECTORS = [
  {
    name: 'one team holding two slots — the case the old test omitted',
    // This is the vector that was red before the fix: two assignment rows,
    // one team. `assignments.length` says 2, the roster says 1.
    teamsWithTwoSlots: 1,
    teams: [
      { id: 'T1', division: 'U10', coachId: 'c1' },
      { id: 'T2', division: 'U10', coachId: 'c2' },
    ],
    slots: [
      slot('S1', 'Monday', '2026-04-06T18:00:00Z', '2026-04-06T19:00:00Z', 4),
      slot('S2', 'Wednesday', '2026-04-08T18:00:00Z', '2026-04-08T19:00:00Z', 4),
    ],
    assignments: [
      { teamId: 'T1', slotId: 'S1' },
      { teamId: 'T1', slotId: 'S2' },
    ],
  },
  {
    name: 'every team holding two slots — assignments outnumber teams 2:1',
    // The shape that produced a negative `unassignedTeams` in production
    // arithmetic: more assignment rows than rostered teams.
    teamsWithTwoSlots: 3,
    teams: [
      { id: 'T1', division: 'U10', coachId: 'c1' },
      { id: 'T2', division: 'U10', coachId: 'c2' },
      { id: 'T3', division: 'U12', coachId: 'c3' },
    ],
    slots: [
      slot('S1', 'Monday', '2026-04-06T18:00:00Z', '2026-04-06T19:00:00Z', 6),
      slot('S2', 'Wednesday', '2026-04-08T18:00:00Z', '2026-04-08T19:00:00Z', 6),
    ],
    assignments: [
      { teamId: 'T1', slotId: 'S1' },
      { teamId: 'T2', slotId: 'S1' },
      { teamId: 'T3', slotId: 'S1' },
      { teamId: 'T1', slotId: 'S2' },
      { teamId: 'T2', slotId: 'S2' },
      { teamId: 'T3', slotId: 'S2' },
    ],
  },
  {
    name: 'one slot each — the case both arms always agreed on',
    // Kept deliberately: it is the shape the old test used, and a check that
    // only contains its own hard case cannot show the easy one still holds.
    teamsWithTwoSlots: 0,
    teams: [
      { id: 'T1', division: 'U10', coachId: 'c1' },
      { id: 'T2', division: 'U10', coachId: 'c2' },
    ],
    slots: [slot('S1', 'Monday', '2026-04-06T18:00:00Z', '2026-04-06T19:00:00Z', 2)],
    assignments: [
      { teamId: 'T1', slotId: 'S1' },
      { teamId: 'T2', slotId: 'S1' },
    ],
  },
  {
    name: 'a team on no slot at all — unassignedTeams is positive and real',
    teamsWithTwoSlots: 0,
    teams: [
      { id: 'T1', division: 'U10', coachId: 'c1' },
      { id: 'T2', division: 'U10', coachId: 'c2' },
      { id: 'T3', division: 'U12', coachId: 'c3' },
    ],
    slots: [slot('S1', 'Monday', '2026-04-06T18:00:00Z', '2026-04-06T19:00:00Z', 4)],
    assignments: [{ teamId: 'T1', slotId: 'S1' }],
  },
  {
    name: 'an assignment naming an unknown team — neither arm may count it',
    // Core drops it (`assignment references unknown team`) before
    // `assignedTeamIds.add`. The Edge arm now applies the same guard its own
    // coach loop already used, rather than a third contract.
    teamsWithTwoSlots: 0,
    teams: [{ id: 'T1', division: 'U10', coachId: 'c1' }],
    slots: [slot('S1', 'Monday', '2026-04-06T18:00:00Z', '2026-04-06T19:00:00Z', 4)],
    assignments: [
      { teamId: 'T1', slotId: 'S1' },
      { teamId: 'GHOST', slotId: 'S1' },
    ],
  },
  {
    name: 'a duplicate team::slot row — counted once by both arms',
    teamsWithTwoSlots: 0,
    teams: [{ id: 'T1', division: 'U10', coachId: 'c1' }],
    slots: [slot('S1', 'Monday', '2026-04-06T18:00:00Z', '2026-04-06T19:00:00Z', 4)],
    assignments: [
      { teamId: 'T1', slotId: 'S1' },
      { teamId: 'T1', slotId: 'S1' },
    ],
  },
  {
    name: 'a coach double-booked across two teams in one slot',
    teamsWithTwoSlots: 0,
    teams: [
      { id: 'T1', division: 'U10', coachId: 'shared' },
      { id: 'T2', division: 'U12', coachId: 'shared' },
    ],
    slots: [slot('S1', 'Monday', '2026-04-06T18:00:00Z', '2026-04-06T19:00:00Z', 4)],
    assignments: [
      { teamId: 'T1', slotId: 'S1' },
      { teamId: 'T2', slotId: 'S1' },
    ],
  },
  {
    // The vacuous case. The arms disagreed here too: core calls an empty
    // roster fully covered (rate 1), the Edge arm called it 0% covered and
    // returned `action-required` for an organisation with nothing to schedule.
    name: 'no teams at all — the vacuous case is covered, not uncovered',
    teamsWithTwoSlots: 0,
    teams: [],
    slots: [slot('S1', 'Monday', '2026-04-06T18:00:00Z', '2026-04-06T19:00:00Z', 4)],
    assignments: [],
  },
  {
    // Two entries sharing an id are one slot. Core's `slotsById` collapsed
    // them and this arm's `slots.map` did not, so the two published a
    // different NUMBER of slots — a disagreement about cardinality, which the
    // per-slot comparison below could not see until it counted rows.
    name: 'two slot entries sharing one id — one slot, not two',
    teamsWithTwoSlots: 0,
    teams: [{ id: 'T1', division: 'U10', coachId: 'c1' }],
    slots: [
      slot('S1', 'Monday', '2026-04-06T18:00:00Z', '2026-04-06T19:00:00Z', 4),
      slot('S1', 'Monday', '2026-04-06T18:00:00Z', '2026-04-06T19:00:00Z', 4),
    ],
    assignments: [{ teamId: 'T1', slotId: 'S1' }],
  },
  {
    name: 'an assignment naming an unknown slot — dropped by both, reported by both',
    teamsWithTwoSlots: 0,
    teams: [{ id: 'T1', division: 'U10', coachId: 'c1' }],
    slots: [slot('S1', 'Monday', '2026-04-06T18:00:00Z', '2026-04-06T19:00:00Z', 4)],
    assignments: [
      { teamId: 'T1', slotId: 'S1' },
      { teamId: 'T1', slotId: 'NOWHERE' },
    ],
  },
];

/** Both arms, over one vector. */
const runBoth = (vector) => ({
  core: coreEvaluate({
    teams: vector.teams,
    slots: vector.slots,
    assignments: vector.assignments,
    // Both are required by core's signature and neither feeds a compared
    // field: `schoolDayEnd` gates the school-hour check (core-only) and the
    // zone is fixed so the core arm's own day handling cannot vary with the
    // host. The Edge arm takes neither.
    schoolDayEnd: undefined,
    timezone: 'UTC',
  }),
  edge: edgeEvaluate({
    teams: vector.teams,
    slots: vector.slots,
    assignments: vector.assignments,
  }),
});

describe('scoring-engine cross-arm drift', () => {
  // ---- meta-assertions on the vector table itself -------------------------
  // The subject set is the table, not anything derived from engine output: a
  // break in either engine cannot shrink it, and a table that quietly emptied
  // would otherwise make every it.each below vacuously pass.

  it('the vector table is populated and every vector is distinct', () => {
    expect(VECTORS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(VECTORS.map((v) => v.name)).size).toBe(VECTORS.length);
  });

  it('at least one vector gives a team two slots, and it really is such a case', () => {
    // The precise omission that let the defect through. Asserting the flag
    // alone would be a label checking itself, so the assignment rows are
    // counted here: a vector claiming `teamsWithTwoSlots` must contain a team
    // that genuinely appears on more than one slot.
    const multi = VECTORS.filter((v) => v.teamsWithTwoSlots > 0);
    expect(multi.length).toBeGreaterThan(0);

    for (const vector of multi) {
      const slotsPerTeam = new Map();
      for (const a of vector.assignments) {
        if (!slotsPerTeam.has(a.teamId)) slotsPerTeam.set(a.teamId, new Set());
        slotsPerTeam.get(a.teamId).add(a.slotId);
      }
      const observed = [...slotsPerTeam.values()].filter((s) => s.size > 1).length;
      expect(observed, `${vector.name}: declared vs observed multi-slot teams`).toBe(
        vector.teamsWithTwoSlots
      );
    }
  });

  it('a multi-slot vector distinguishes the two implementations at all', () => {
    // Without this, the whole file could pass against an engine that never
    // stopped counting rows -- every vector would simply have to be one where
    // rows and distinct teams coincide. This proves at least one does not.
    const separating = VECTORS.filter(
      (v) =>
        v.teamsWithTwoSlots > 0 && v.assignments.length > new Set(v.teams.map((t) => t.id)).size
    );
    expect(separating.length).toBeGreaterThan(0);
  });

  // ---- the drift check itself --------------------------------------------

  it.each(VECTORS.map((v) => [v.name, v]))('agreed summary counts match: %s', (_name, vector) => {
    const { core, edge } = runBoth(vector);
    for (const key of AGREED_SUMMARY_COUNTS) {
      expect(edge.summary[key], `summary.${key}`).toBe(core.summary[key]);
    }
  });

  it.each(VECTORS.map((v) => [v.name, v]))('assignmentRate agrees: %s', (_name, vector) => {
    const { core, edge } = runBoth(vector);
    // Core rounds to 4dp; the Edge arm publishes the raw quotient.
    expect(edge.summary.assignmentRate).toBeCloseTo(core.summary.assignmentRate, 4);
  });

  it.each(VECTORS.map((v) => [v.name, v]))('per-slot occupancy agrees: %s', (_name, vector) => {
    const { core, edge } = runBoth(vector);
    const coreBySlot = new Map(core.slotUtilization.map((s) => [s.slotId, s]));
    const edgeBySlot = new Map(edge.slotUtilization.map((s) => [s.slotId, s]));

    // Enumerated from the vector's own slot list -- the registry a break
    // leaves intact -- and not from either arm's output, so a slot dropped by
    // one engine is reported rather than silently absent from the comparison.
    for (const declared of vector.slots) {
      const c = coreBySlot.get(declared.id);
      const e = edgeBySlot.get(declared.id);
      expect(c, `core dropped slot ${declared.id}`).toBeDefined();
      expect(e, `edge dropped slot ${declared.id}`).toBeDefined();
      expect(e.assignedCount, `slot ${declared.id} assignedCount`).toBe(c.assignedCount);
      expect(e.capacity, `slot ${declared.id} capacity`).toBe(c.capacity);
    }

    // **Cardinality, which the id lookups above cannot see.** Both arms were
    // building `slotUtilization` from different sources -- core from its
    // de-duplicated `slotsById`, the Edge arm from the raw `slots` array -- so
    // two entries sharing an id produced one row and two. Every declared id
    // was still found on both sides, and the loop above passed over a real
    // disagreement about how many slots exist.
    const distinctDeclared = new Set(vector.slots.map((s) => s.id)).size;
    expect(core.slotUtilization, 'core slotUtilization row count').toHaveLength(distinctDeclared);
    expect(edge.slotUtilization, 'edge slotUtilization row count').toHaveLength(distinctDeclared);
  });

  it.each(VECTORS.map((v) => [v.name, v]))(
    'a row neither arm counts is reported by both, never silently dropped: %s',
    (_name, vector) => {
      const { core, edge } = runBoth(vector);
      // Core reports each discarded row in `dataQualityWarnings`; the Edge arm
      // has no such field and reports the same thing as a 'data-quality'
      // issue. The counts must match, or one arm is dropping rows in silence
      // -- which is the failure this whole pass exists to avoid trading into.
      const edgeDataQuality = edge.issues.filter((i) => i.category === 'data-quality');
      expect(edgeDataQuality).toHaveLength(core.dataQualityWarnings.length);
    }
  );

  it.each(VECTORS.map((v) => [v.name, v]))(
    'the arms agree on whether a coach is double-booked: %s',
    (_name, vector) => {
      const { core, edge } = runBoth(vector);
      // Counts, not wording: core's reason is 'overlapping slots' and the Edge
      // arm's is 'Coach <id> has overlapping practices on <day>'. That text
      // difference is real and out of this check's scope; whether a conflict
      // exists is not.
      expect(edge.coachConflicts.length).toBe(core.coachConflicts.length);
    }
  );

  it.each(VECTORS.map((v) => [v.name, v]))(
    'unassignedTeams is never negative in either arm: %s',
    (_name, vector) => {
      const { core, edge } = runBoth(vector);
      expect(core.summary.unassignedTeams).toBeGreaterThanOrEqual(0);
      expect(edge.summary.unassignedTeams).toBeGreaterThanOrEqual(0);
      // The Edge arm alone publishes this, and it is what `fairness-scoring`
      // persists as the `practice_coverage` metric (thresholds min 90,
      // target 100). Over 100 is the same defect wearing a percent sign.
      expect(edge.summary.coveragePercent).toBeLessThanOrEqual(100);
    }
  );

  // ---- the stated contract, kept honest -----------------------------------

  it('neither arm has grown a key this contract does not account for', () => {
    // **The whole key set, not just the declared ones.** Checking only that
    // each declared key sits on its declared side leaves a third category
    // unpoliced: a key added to BOTH arms is neither compared by this file nor
    // listed as arm-specific, so it can drift exactly as `assignedTeams` did
    // while every assertion here stays green. Pinning the full sets also makes
    // the "thirteen / six" counts in `docs/architecture/edge-functions-inventory.md`
    // and the roadmap enforced rather than merely written down.
    const { core, edge } = runBoth(VECTORS[0]);

    expect(Object.keys(core).sort()).toEqual(
      [...CORE_ONLY_KEYS, 'summary', 'slotUtilization', 'coachConflicts'].sort()
    );
    expect(Object.keys(edge).sort()).toEqual(
      [...EDGE_ONLY_KEYS, 'summary', 'slotUtilization', 'coachConflicts'].sort()
    );
  });

  it('the arms differ exactly where this file says they differ', () => {
    const { core, edge } = runBoth(VECTORS[0]);

    // Declared-core-only keys must genuinely be core-only. If the Edge arm
    // grows one of these, this check goes red and the contract gets updated
    // rather than the two arms silently converging on a third meaning.
    for (const key of CORE_ONLY_KEYS) {
      expect(core, `core is missing declared core-only key ${key}`).toHaveProperty(key);
      expect(edge, `edge unexpectedly publishes ${key}`).not.toHaveProperty(key);
    }
    for (const key of EDGE_ONLY_KEYS) {
      expect(edge, `edge is missing declared edge-only key ${key}`).toHaveProperty(key);
      expect(core, `core unexpectedly publishes ${key}`).not.toHaveProperty(key);
    }

    // And the agreed names really are present on both, or the drift check
    // above would be comparing undefined against undefined and passing.
    for (const key of AGREED_SUMMARY_COUNTS) {
      expect(core.summary, `core.summary.${key}`).toHaveProperty(key);
      expect(edge.summary, `edge.summary.${key}`).toHaveProperty(key);
      expect(typeof edge.summary[key]).toBe('number');
      expect(typeof core.summary[key]).toBe('number');
    }
  });
});
