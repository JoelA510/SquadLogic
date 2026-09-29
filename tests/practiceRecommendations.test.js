/**
 * Joint recommendations and the decline / re-offer chain (8.6 PR 3b, PR 5;
 * plan §2 "Computation", "Most eligible", "Re-offer chain"; §5 decisions 4, 5
 * and 10; the §6 witness rows for recommendations).
 *
 * Every subject set here is enumerated from the pre-repair snapshot (the plan's
 * assignments, the loss, the graph, the inventory) — never from a repair's
 * output. Each witness checks its guarantee with a predicate of its own, not
 * the repair's: clashes through `surfacesConflict()`, costs through the one
 * objective (`changeCountsFor()` and `scoreObjective()`). Plants that must turn
 * this file red, each shown in the PR body:
 *
 * - tier 2's joint check dropped (each TIME TBD series searched alone);
 * - the re-offer tie-break by assignment id only;
 * - the visited set removed;
 * - the decliner barred at every hop, not only from the declined slot;
 * - Δ cleared inside the chain;
 * - one TIME TBD recommendation dropped.
 */

import { describe, expect, it } from 'vitest';

import {
  PRACTICE_CHAIN_STOP,
  PRACTICE_REASON,
  PRACTICE_TBD_REASON,
  createRecommendationState,
  declineRecommendation,
  rebaseRecommendationState,
  repairPracticeLoss,
  toSeason2026PracticePlan,
  undoDecline,
} from '@squadlogic/core/practice/index.js';
import {
  buildSeason2026PracticeFacilityGraph,
  buildSeason2026VenueComplexMap,
  conflictingSurfacesOf,
  surfacesConflict,
} from '@squadlogic/core/facility/index.js';
import { loadFacilityGeometry, loadSeason2026Practice } from '@squadlogic/core/fixtures/index.js';
import {
  RESOLVE_OBJECTIVE_TERM,
  changeCountsFor,
  scoreObjective,
  resolveObjectiveWeights,
} from '@squadlogic/core/resolve/objective.js';

const graph = buildSeason2026PracticeFacilityGraph(loadFacilityGeometry());
const OP = (field) => `orchard-park/${field}`;
const AP = (pitch) => `alder-park/${pitch}`;
const WEIGHTS = resolveObjectiveWeights(null);
const TBD_COST = scoreObjective({ [RESOLVE_OBJECTIVE_TERM.UNPLACED_GAME]: 1 }, WEIGHTS).total;
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const weekdayOf = (iso) => WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()];
const key = (shape) =>
  `${shape.surfaceId}|${shape.weekday}|${shape.startMinutes}|${shape.durationMinutes}`;

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

/** A constructed plan: one slot and one assignment per series, ids given. */
function constructed({ series, inventory, loss = {}, extra = {} }) {
  return {
    plan: {
      slots: series.map((s) => ({
        id: `slot-${s.id}`,
        surfaceId: s.surfaceId,
        weekday: s.weekday,
        startMinutes: s.startMinutes,
        durationMinutes: s.durationMinutes ?? 60,
        validFrom: s.from ?? '2026-09-01',
        validUntil: s.until ?? '2026-11-30',
        capacity: 1,
        revisionId: 'constructed',
        label: null,
        surfaceResolution: 'resolved',
      })),
      assignments: series.map((s) => ({ id: s.id, slotId: `slot-${s.id}`, teamId: s.teamId })),
      source: 'constructed',
    },
    graph,
    loss: { surfaceIds: [OP('field-2')], from: '2026-10-05', reason: 'maintenance', ...loss },
    inventory: inventory.map((shape) => ({ durationMinutes: 60, ...shape })),
    ...extra,
  };
}

/* The corpus, dated as tests/practiceRepair.test.js dates it; no coaches, so
 * every cost is the objective's change terms and nothing else. */
const practice = loadSeason2026Practice();
const fullPlan = toSeason2026PracticePlan(
  practice.practiceSlots,
  graph,
  buildSeason2026VenueComplexMap()
);
const CORPUS_PLAN = (() => {
  const slots = fullPlan.slots
    .filter((s) => s.revisionId === '93 Combined' && s.surfaceResolution === 'resolved')
    .map((s) => ({ ...s, validFrom: '2026-08-17', validUntil: '2026-11-13' }));
  const ids = new Set(slots.map((s) => s.id));
  return {
    slots,
    assignments: fullPlan.assignments.filter((a) => ids.has(a.slotId)),
    source: fullPlan.source,
  };
})();
const CORPUS_INVENTORY = fullPlan.slots
  .filter((s) => s.surfaceResolution === 'resolved')
  .map(({ surfaceId, weekday, startMinutes, durationMinutes }) => ({
    surfaceId,
    weekday,
    startMinutes,
    durationMinutes,
  }));
const CORPUS_SURFACES = [...new Set(CORPUS_PLAN.slots.map((s) => s.surfaceId))].sort();
const CORPUS_LOSSES = [{}, { until: '2026-10-25' }];
const CORPUS_LOSSES_WITH_MINUTES = [
  ...CORPUS_LOSSES,
  { until: '2026-10-25', startMinutes: 1020, endMinutes: 1110 },
];
/** Every corpus loss, repaired once, shared by the witnesses below. */
let corpusRuns = null;
const allCorpusRuns = () => {
  corpusRuns ??= CORPUS_SURFACES.flatMap((surfaceId) =>
    CORPUS_LOSSES_WITH_MINUTES.map((loss) => {
      const input = corpusInput(surfaceId, loss);
      return { input, run: repairPracticeLoss(input) };
    })
  );
  return corpusRuns;
};
/** One starting state per corpus surface (retirement), shared by the decline witnesses. */
const corpusStates = new Map();
const corpusState = (surfaceId) => {
  if (!corpusStates.has(surfaceId)) {
    corpusStates.set(surfaceId, createRecommendationState(corpusInput(surfaceId)));
  }
  return corpusStates.get(surfaceId);
};
const corpusInput = (surfaceId, loss = {}) => ({
  plan: CORPUS_PLAN,
  graph,
  loss: { surfaceIds: [surfaceId], from: '2026-09-28', reason: 'field lost mid-season', ...loss },
  inventory: CORPUS_INVENTORY,
});

/* -------------------------------------------------------------------------- */
/* The snapshot, read independently of the repair                              */
/* -------------------------------------------------------------------------- */

/**
 * Every series of the plan held to the loss window, and which of them the loss
 * displaces: from the plan, the graph and the loss alone.
 */
function snapshot(input) {
  const { plan, loss } = input;
  const lost = new Set(loss.surfaceIds.flatMap((s) => [s, ...conflictingSurfacesOf(graph, s)]));
  const slotById = new Map(plan.slots.map((s) => [s.id, s]));
  const series = [];
  for (const assignment of plan.assignments) {
    const slot = slotById.get(assignment.slotId);
    const from = assignment.effectiveFrom ?? slot.validFrom;
    const until = assignment.effectiveUntil ?? slot.validUntil;
    const windowFrom = from < loss.from ? loss.from : from;
    const windowUntil = loss.until && until > loss.until ? loss.until : until;
    if (windowFrom > windowUntil) continue;
    // An occurrence on its weekday inside the window, read off the calendar.
    let day = windowFrom;
    let occurs = false;
    for (let i = 0; i < 7 && day <= windowUntil; i += 1) {
      if (weekdayOf(day) === slot.weekday) occurs = true;
      day = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    }
    if (!occurs) continue;
    const minutesHit =
      loss.startMinutes === undefined ||
      (slot.startMinutes < loss.endMinutes &&
        loss.startMinutes < slot.startMinutes + slot.durationMinutes);
    series.push({
      id: assignment.id,
      teamId: assignment.teamId,
      surfaceId: slot.surfaceId,
      weekday: slot.weekday,
      startMinutes: slot.startMinutes,
      durationMinutes: slot.durationMinutes,
      from: windowFrom,
      until: windowUntil,
      displaced: lost.has(slot.surfaceId) && minutesHit,
    });
  }
  return { lost, series, displaced: series.filter((s) => s.displaced) };
}

/** Two placed practices clash: same ground or conflicting ground, or one team, at once. */
function clash(a, b) {
  return (
    a.from <= b.until &&
    b.from <= a.until &&
    a.weekday === b.weekday &&
    a.startMinutes < b.startMinutes + b.durationMinutes &&
    b.startMinutes < a.startMinutes + a.durationMinutes &&
    (a.surfaceId === b.surfaceId ||
      surfacesConflict(graph, a.surfaceId, b.surfaceId).conflict ||
      a.teamId === b.teamId)
  );
}

/** A recommendation as a placed practice over its series-window. */
const placedOf = (recommendation) => ({
  ...recommendation.to,
  teamId: recommendation.teamId,
  from: recommendation.effectiveFrom,
  until: recommendation.effectiveUntil,
});

/** The meta-assertion every witness ends on: it examined something. */
function requireExamined(count, what) {
  if (count === 0) throw new Error(`the witness examined no ${what}`);
  return count;
}

/**
 * Witness: no two recommendations clash, and none lands on a frozen series.
 * Returns how many pairs it examined, for the caller's meta-assertion.
 */
function assertNoClash(input, recommendations) {
  const { series } = snapshot(input);
  const frozen = series.filter((s) => !s.displaced);
  const placed = recommendations.filter((r) => r.to !== null).map(placedOf);
  let pairs = 0;
  const clashes = [];
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      pairs += 1;
      if (clash(placed[i], placed[j])) clashes.push([placed[i], placed[j]]);
    }
    for (const other of frozen) {
      pairs += 1;
      if (clash(placed[i], other)) clashes.push([placed[i], other]);
    }
  }
  expect(clashes).toEqual([]);
  return pairs;
}

/** Witness: every displaced series-window, from the snapshot, appears exactly once. */
function assertEveryWindowOnce(input, recommendations) {
  const expected = snapshot(input)
    .displaced.map((s) => `${s.id}|${s.from}|${s.until}`)
    .sort();
  if (expected.length === 0) throw new Error('the loss displaces no series-window');
  const answered = recommendations
    .map((r) => `${r.assignmentId}|${r.effectiveFrom}|${r.effectiveUntil}`)
    .sort();
  expect(answered).toEqual(expected);
  for (const r of recommendations) {
    if (r.to === null) expect(Object.values(PRACTICE_TBD_REASON)).toContain(r.reason);
    else expect(r.reason).toBeNull();
  }
  return expected.length;
}

/** The objective's price of putting series `s` on `shape` (no coaches, no preferences). */
const costAt = (s, shape) => scoreObjective(changeCountsFor(s, shape), WEIGHTS).total;
const venue = (surfaceId) => graph.surfaces[surfaceId].venueId;

/**
 * Brute force: the series the rule should offer `x` to, after `declinerId`
 * released it, from the snapshot and the state's recommendations alone.
 */
function mostEligible(input, state, declinerId, x) {
  const { lost, series } = snapshot(input);
  const frozen = series.filter((s) => !s.displaced);
  const inventory = [...new Map(input.inventory.map((s) => [key(s), s])).values()];
  const recommendationOf = new Map(state.recommendations.map((r) => [r.assignmentId, r]));
  const declined = new Set(state.declined.map((d) => `${d.assignmentId}@${key(d.to)}`));
  declined.add(`${declinerId}@${key(x)}`);
  const legalFor = (s, shape) => {
    const at = { ...shape, teamId: s.teamId, from: s.from, until: s.until };
    return !lost.has(shape.surfaceId) && !frozen.some((other) => clash(at, other));
  };
  const eligible = [];
  for (const s of series.filter((t) => t.displaced)) {
    if (s.id === declinerId || state.enacted.includes(s.id)) continue;
    if (declined.has(`${s.id}@${key(x)}`) || s.durationMinutes !== x.durationMinutes) continue;
    if (!inventory.some((shape) => key(shape) === key(x)) || !legalFor(s, x)) continue;
    const current = recommendationOf.get(s.id).to;
    if (venue(x.surfaceId) !== venue(s.surfaceId) && current !== null) continue;
    const at = { ...x, teamId: s.teamId, from: s.from, until: s.until };
    const blocked = state.recommendations.some(
      (r) =>
        r.to !== null &&
        r.assignmentId !== s.id &&
        r.assignmentId !== declinerId &&
        clash(at, placedOf(r))
    );
    if (blocked) continue;
    const gain = (current === null ? TBD_COST : costAt(s, current)) - costAt(s, x);
    const sameVenue = inventory.filter(
      (shape) =>
        venue(shape.surfaceId) === venue(s.surfaceId) &&
        shape.durationMinutes === s.durationMinutes &&
        legalFor(s, shape)
    ).length;
    eligible.push({ id: s.id, gain, sameVenue });
  }
  const gainers = eligible
    .filter((e) => e.gain > 0)
    .sort((a, b) => b.gain - a.gain || a.sameVenue - b.sameVenue || a.id.localeCompare(b.id));
  return { best: gainers[0]?.id ?? null, gainers };
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Two TIME TBD series on the lost field, one cross-venue shape both want.
 * Standalone, each is offered it; jointly, one gets it.
 */
const CONTENDED = constructed({
  series: [
    { id: 'c-a', teamId: 'A', surfaceId: OP('field-2-a'), weekday: 'TUE', startMinutes: 1020 },
    { id: 'c-b', teamId: 'B', surfaceId: OP('field-2-b'), weekday: 'TUE', startMinutes: 1020 },
  ],
  inventory: [{ surfaceId: AP('pitch-2a'), weekday: 'TUE', startMinutes: 1020 }],
});

/**
 * A tie on gain, broken by the search's order. S holds X (field-3-a, Tuesday
 * 17:00); T1 and T2 hold the two 18:00 shapes and gain 1060 each from X. T2's
 * team also practises at 19:00 elsewhere, so it has one same-venue candidate
 * fewer: T2 is the most eligible, although T1's id sorts first. S's team
 * practises at 18:00 and 19:00 elsewhere, so S has X alone.
 */
const TIE = constructed({
  series: [
    { id: 'tie-s', teamId: 'S', surfaceId: OP('field-2-a'), weekday: 'TUE', startMinutes: 1020 },
    {
      id: 'tie-a-t1',
      teamId: 'T1',
      surfaceId: OP('field-2-b'),
      weekday: 'TUE',
      startMinutes: 1020,
    },
    {
      id: 'tie-b-t2',
      teamId: 'T2',
      surfaceId: OP('field-2'),
      weekday: 'TUE',
      startMinutes: 1020,
      from: '2026-09-01',
    },
    {
      id: 'tie-s-1080',
      teamId: 'S',
      surfaceId: AP('pitch-3a'),
      weekday: 'TUE',
      startMinutes: 1080,
    },
    {
      id: 'tie-s-1140',
      teamId: 'S',
      surfaceId: AP('pitch-3b'),
      weekday: 'TUE',
      startMinutes: 1140,
    },
    {
      id: 'tie-t2-1140',
      teamId: 'T2',
      surfaceId: AP('pitch-4a-side-1'),
      weekday: 'TUE',
      startMinutes: 1140,
    },
  ],
  inventory: [
    { surfaceId: OP('field-3-a'), weekday: 'TUE', startMinutes: 1020 },
    { surfaceId: OP('field-4-a'), weekday: 'TUE', startMinutes: 1080 },
    { surfaceId: OP('field-4-b'), weekday: 'TUE', startMinutes: 1080 },
    { surfaceId: OP('field-5'), weekday: 'TUE', startMinutes: 1140 },
  ],
});

/**
 * The visited-set fixture. Three shapes that never clash with one another:
 * Z = field-3-a Tue 17:10, X = field-4-a Tue 20:00, Y = field-5 Wed 17:00.
 * Priced by the one objective (change terms, weekday move included):
 *
 * - A (Tue 17:00): Z 1011 < X 1181 < Y 1241;
 * - B (Wed 17:00): Y 1 < Z 1251 < X 1421;
 * - S (Tue 20:00): X 1, and its team is busy over Z and Y, so X is all it has.
 *
 * The repair's optimum is S on X, A on Z, B on Y. The state the witness needs,
 * A on Y and B on Z with nothing declined, is reached through the production
 * path only: B declines Y (B goes TIME TBD), A declines Z (B takes Z, A falls
 * back to Y), then both declines are undone (neither slot is free to return).
 * S then declines X: A takes X (gain 60), releasing Y; B takes Y (gain 1250),
 * releasing Z; A would gain 170 from Z, and only the visited set stops it.
 *
 * Why a random search of fresh repairs never found a revisit: from the repair's
 * own optimum with static costs, a series that could gain from a slot its
 * neighbour later frees would already have been given it. A revisit needs a
 * state the declines themselves made sub-optimal, which is exactly what a
 * session of declines and undos produces.
 */
const VISITED = constructed({
  series: [
    { id: 'v-a', teamId: 'A', surfaceId: OP('field-2-a'), weekday: 'TUE', startMinutes: 1020 },
    { id: 'v-b', teamId: 'B', surfaceId: OP('field-2-b'), weekday: 'WED', startMinutes: 1020 },
    { id: 'v-s', teamId: 'S', surfaceId: OP('field-2-a'), weekday: 'TUE', startMinutes: 1200 },
    {
      id: 'v-s-busy-tue',
      teamId: 'S',
      surfaceId: AP('pitch-3a'),
      weekday: 'TUE',
      startMinutes: 1030,
    },
    {
      id: 'v-s-busy-wed',
      teamId: 'S',
      surfaceId: AP('pitch-3a'),
      weekday: 'WED',
      startMinutes: 1020,
    },
  ],
  inventory: [
    { surfaceId: OP('field-3-a'), weekday: 'TUE', startMinutes: 1030 },
    { surfaceId: OP('field-4-a'), weekday: 'TUE', startMinutes: 1200 },
    { surfaceId: OP('field-5'), weekday: 'WED', startMinutes: 1020 },
  ],
});
const V_Z = { surfaceId: OP('field-3-a'), weekday: 'TUE', startMinutes: 1030, durationMinutes: 60 };
const V_X = { surfaceId: OP('field-4-a'), weekday: 'TUE', startMinutes: 1200, durationMinutes: 60 };
const V_Y = { surfaceId: OP('field-5'), weekday: 'WED', startMinutes: 1020, durationMinutes: 60 };

/**
 * S re-placed inside the chain (operator ruling 2026-09-28): S holds X, T holds
 * Y and would gain 30 from X. S declines X; T takes it and releases Y; S, now
 * TIME TBD, is an ordinary candidate for Y and takes it in the chain, not in
 * the fallback.
 */
const REPLACE = constructed({
  series: [
    { id: 'r-s', teamId: 'S', surfaceId: OP('field-2-a'), weekday: 'TUE', startMinutes: 1020 },
    { id: 'r-t', teamId: 'T', surfaceId: OP('field-2-b'), weekday: 'TUE', startMinutes: 1100 },
  ],
  inventory: [
    { surfaceId: OP('field-3-a'), weekday: 'TUE', startMinutes: 1030 },
    { surfaceId: OP('field-4-a'), weekday: 'TUE', startMinutes: 1200 },
  ],
});

/** One displaced series with a best shape X and a second-best Z. */
const SOLO = constructed({
  series: [
    { id: 'solo', teamId: 'A', surfaceId: OP('field-2-a'), weekday: 'TUE', startMinutes: 1020 },
  ],
  inventory: [
    { surfaceId: OP('field-3-a'), weekday: 'TUE', startMinutes: 1020 },
    { surfaceId: OP('field-4-a'), weekday: 'TUE', startMinutes: 1080 },
  ],
});
const X_SOLO = {
  surfaceId: OP('field-3-a'),
  weekday: 'TUE',
  startMinutes: 1020,
  durationMinutes: 60,
};
const Z_SOLO = {
  surfaceId: OP('field-4-a'),
  weekday: 'TUE',
  startMinutes: 1080,
  durationMinutes: 60,
};

/* -------------------------------------------------------------------------- */
/* Tier 2                                                                      */
/* -------------------------------------------------------------------------- */

describe('recommendations :: tier 2, the joint cross-venue search (plan §2)', () => {
  it('gives contended cross-venue ground to one series, and the other is TIME TBD with its reason', () => {
    const run = repairPracticeLoss(CONTENDED);
    expect(run.recommendations.map((r) => [r.assignmentId, r.tier])).toEqual([
      ['c-a', 'cross-venue'],
      ['c-b', null],
    ]);
    expect(run.recommendations[0]).toMatchObject({
      to: { surfaceId: AP('pitch-2a'), weekday: 'TUE', startMinutes: 1020 },
      origin: 'approved-option',
    });
    expect(run.recommendations[1].reason).toBe(run.timeTbd[1].reason);
    // Never placed: both stay TIME TBD in the applied plan until enacted.
    expect(run.rehomed).toEqual([]);
    expect(run.timeTbd.map((e) => e.assignmentId)).toEqual(['c-a', 'c-b']);
    expect(run.recommendationSearch).toMatchObject({
      series: 2,
      recommended: 1,
      provenOptimal: true,
    });
    assertNoClash(CONTENDED, run.recommendations);
  });

  it('treats tier-1 placements as frozen occupants', () => {
    // One team, two displaced series: tier 1 puts the first on field-3-a at
    // 17:00, so the Alder Park shape at 17:30 would double-book the team.
    const input = constructed({
      series: [
        { id: 'o-a', teamId: 'A', surfaceId: OP('field-2-a'), weekday: 'TUE', startMinutes: 1020 },
        { id: 'o-b', teamId: 'A', surfaceId: OP('field-2-b'), weekday: 'TUE', startMinutes: 1050 },
      ],
      inventory: [
        { surfaceId: OP('field-3-a'), weekday: 'TUE', startMinutes: 1020 },
        { surfaceId: AP('pitch-2a'), weekday: 'TUE', startMinutes: 1050 },
      ],
    });
    const run = repairPracticeLoss(input);
    expect(run.recommendations.map((r) => r.tier)).toEqual(['same-venue', null]);
    // Control: without the tier-1 placement, tier 2 does recommend it.
    const alone = repairPracticeLoss({ ...input, inventory: [input.inventory[1]] });
    expect(alone.recommendations.filter((r) => r.tier === 'cross-venue')).toHaveLength(1);
    assertNoClash(input, run.recommendations);
  });

  it('leaves the rest TIME TBD with a reason, never dropped', () => {
    const run = repairPracticeLoss({ ...CONTENDED, inventory: [] });
    expect(run.recommendations.map((r) => [r.to, r.reason])).toEqual([
      [null, PRACTICE_TBD_REASON.NO_LEGAL_SLOT_AT_VENUE],
      [null, PRACTICE_TBD_REASON.NO_LEGAL_SLOT_AT_VENUE],
    ]);
  });

  it('declares, never truncates silently, a search stopped at its node limit', () => {
    // The corpus loss whose tier 2 needs the most nodes, capped far below it.
    const input = { ...corpusInput('maplewood-back/field-1-a'), searchNodeLimit: 50 };
    const run = repairPracticeLoss(input);
    const unproven = run.findings.filter(
      (f) =>
        f.code === PRACTICE_REASON.REPAIR_MINIMALITY_UNPROVEN && f.details.tier === 'cross-venue'
    );
    expect(unproven).toHaveLength(1);
    expect(run.recommendationSearch).toMatchObject({ provenOptimal: false, nodeLimit: 50 });
    // The best found is still a joint answer (greedy seeds it), and complete.
    expect(run.recommendationSearch.recommended).toBeGreaterThan(0);
    assertNoClash(input, run.recommendations);
    assertEveryWindowOnce(input, run.recommendations);
    // Control: at the default limit the same loss is proven, and says nothing.
    const full = repairPracticeLoss(corpusInput('maplewood-back/field-1-a'));
    expect(full.recommendationSearch.provenOptimal).toBe(true);
    expect(full.findings.filter((f) => f.details.tier === 'cross-venue')).toEqual([]);
  });

  it('proves every corpus loss optimal within the default limit', () => {
    let losses = 0;
    for (const { run } of allCorpusRuns()) {
      expect(run.recommendationSearch.provenOptimal).toBe(true);
      losses += 1;
    }
    expect(losses).toBe(CORPUS_SURFACES.length * CORPUS_LOSSES_WITH_MINUTES.length);
  }, 60_000);
});

/* -------------------------------------------------------------------------- */
/* Witness: no two recommendations clash                                       */
/* -------------------------------------------------------------------------- */

describe('recommendations :: no two clash (plan §6)', () => {
  it('holds over every corpus loss, retirement and blackout, by an independent predicate', () => {
    let pairs = 0;
    let crossVenue = 0;
    for (const { input, run } of allCorpusRuns()) {
      pairs += assertNoClash(input, run.recommendations);
      crossVenue += run.recommendations.filter((r) => r.tier === 'cross-venue').length;
    }
    // Meta: the witness examined real pairs, tier 2 among them.
    expect(requireExamined(pairs, 'pair')).toBeGreaterThan(1000);
    expect(crossVenue).toBeGreaterThan(0);
  }, 60_000);

  it('the meta-assertion fails on a loss that recommends nothing', () => {
    const empty = constructed({ series: [], inventory: [] });
    expect(() => requireExamined(assertNoClash(empty, []), 'pair')).toThrow('examined no pair');
  });

  it('the predicate itself catches a planted clash', () => {
    const [a] = repairPracticeLoss(CONTENDED).recommendations;
    const forged = [a, { ...a, assignmentId: 'forged', teamId: 'Z' }];
    expect(() => assertNoClash(CONTENDED, forged)).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Witness: every affected series-window exactly once (§5 decision 5)          */
/* -------------------------------------------------------------------------- */

describe('recommendations :: one per series-window (plan §5 decision 5)', () => {
  it('answers every displaced series-window of every corpus loss exactly once', () => {
    let windows = 0;
    for (const { input, run } of allCorpusRuns()) {
      windows += assertEveryWindowOnce(input, run.recommendations);
    }
    expect(windows).toBeGreaterThan(100);
  }, 60_000);

  it('still does after a decline', () => {
    const state = declineRecommendation(createRecommendationState(TIE), 'tie-s');
    expect(assertEveryWindowOnce(TIE, state.recommendations)).toBe(3);
  });

  it('the meta-assertion fails on a loss that displaces nothing', () => {
    const none = constructed({
      series: [
        { id: 'n', teamId: 'A', surfaceId: OP('field-5'), weekday: 'TUE', startMinutes: 1020 },
      ],
      inventory: [],
    });
    expect(() => assertEveryWindowOnce(none, [])).toThrow('displaces no series-window');
  });
});

/* -------------------------------------------------------------------------- */
/* Witness: decline re-offers to the most eligible                             */
/* -------------------------------------------------------------------------- */

describe('recommendations :: decline re-offers to the most eligible (plan §2)', () => {
  it('breaks a tie on gain by fewest same-venue candidates, not by id', () => {
    const state = createRecommendationState(TIE);
    const x = state.recommendations.find((r) => r.assignmentId === 'tie-s').to;
    expect(x).toMatchObject({ surfaceId: OP('field-3-a'), startMinutes: 1020 });
    const oracle = mostEligible(TIE, state, 'tie-s', x);
    // The fixture is the tie it claims to be.
    expect(oracle.gainers.map((g) => [g.id, g.gain, g.sameVenue])).toEqual([
      ['tie-b-t2', 1060, 3],
      ['tie-a-t1', 1060, 4],
    ]);
    const next = declineRecommendation(state, 'tie-s');
    expect(next.chains[0].hops[0].assignmentId).toBe(oracle.best);
    expect(next.chains[0].hops[0]).toMatchObject({ gain: 1060, to: x });
  });

  it('matches a brute-force gain from the objective on every first hop over the corpus', () => {
    let declines = 0;
    let hops = 0;
    let contested = 0;
    for (const surfaceId of CORPUS_SURFACES) {
      const input = corpusInput(surfaceId);
      const state = corpusState(surfaceId);
      for (const r of state.recommendations.filter((rec) => rec.to !== null).slice(0, 3)) {
        const oracle = mostEligible(input, state, r.assignmentId, r.to);
        const next = declineRecommendation(state, r.assignmentId);
        expect(next.chains[0].hops[0]?.assignmentId ?? null).toBe(oracle.best);
        if (oracle.best !== null) expect(next.chains[0].hops[0].gain).toBe(oracle.gainers[0].gain);
        declines += 1;
        hops += next.chains[0].hops.length;
        if (oracle.gainers.length > 1) contested += 1;
      }
    }
    // Meta: real declines, real re-offers, and some with a choice to make.
    expect(declines).toBeGreaterThan(20);
    expect(hops).toBeGreaterThan(0);
    expect(contested).toBeGreaterThan(0);
  }, 60_000);

  it('never offers an enacted series anything, and refuses to decline one', () => {
    const state = createRecommendationState(TIE, { enacted: ['tie-b-t2'] });
    const next = declineRecommendation(state, 'tie-s');
    expect(next.chains[0].hops[0].assignmentId).toBe('tie-a-t1');
    expect(() => declineRecommendation(state, 'tie-b-t2')).toThrow('enacted');
    // An enacted series' declines stand: undo refuses rather than hand X on.
    const declined = declineRecommendation(createRecommendationState(TIE), 'tie-s');
    const x = declined.declined[0].to;
    expect(() => undoDecline({ ...declined, enacted: ['tie-s'] }, 'tie-s', x)).toThrow('enacted');
  });

  it('refuses to decline a TIME TBD recommendation', () => {
    const state = createRecommendationState(CONTENDED);
    expect(() => declineRecommendation(state, 'c-b')).toThrow('nothing to decline');
  });

  it('offers a cross-venue slot only to a series that is TIME TBD', () => {
    // c-a declines the Alder Park shape; c-b is TIME TBD, so it may take it.
    const state = declineRecommendation(createRecommendationState(CONTENDED), 'c-a');
    expect(state.chains[0].hops.map((h) => h.assignmentId)).toEqual(['c-b']);
    // p-a is placed at its own venue; p-b's declined Alder Park shape would
    // gain p-a 1180, and is still not offered to it.
    const placed = constructed({
      series: [
        { id: 'p-a', teamId: 'A', surfaceId: OP('field-2-a'), weekday: 'TUE', startMinutes: 1020 },
        { id: 'p-b', teamId: 'B', surfaceId: OP('field-2-b'), weekday: 'TUE', startMinutes: 1020 },
      ],
      inventory: [
        { surfaceId: AP('pitch-2a'), weekday: 'TUE', startMinutes: 1020 },
        { surfaceId: OP('field-4-a'), weekday: 'TUE', startMinutes: 1200 },
      ],
    });
    const first = createRecommendationState(placed);
    expect(first.recommendations.map((r) => r.tier)).toEqual(['same-venue', 'cross-venue']);
    const next = declineRecommendation(first, 'p-b');
    expect(next.chains[0]).toMatchObject({ hops: [], stoppedBy: PRACTICE_CHAIN_STOP.NO_GAIN });
    expect(next.recommendations[1]).toMatchObject({
      to: null,
      reason: PRACTICE_TBD_REASON.DECLINED,
    });
  });

  it('stamps every decline locally repaired, not proven optimal', () => {
    const next = declineRecommendation(createRecommendationState(TIE), 'tie-s');
    expect(next.findings.map((f) => [f.code, f.severity])).toEqual([
      [PRACTICE_REASON.REPAIR_RECOMMENDATION_LOCAL, 'compromise'],
    ]);
  });

  it('is deterministic', () => {
    const a = declineRecommendation(createRecommendationState(TIE), 'tie-s');
    const b = declineRecommendation(createRecommendationState(TIE), 'tie-s');
    expect(JSON.stringify(a.recommendations)).toBe(JSON.stringify(b.recommendations));
  });
});

/* -------------------------------------------------------------------------- */
/* Witness: the chain terminates, and each series moves at most once           */
/* -------------------------------------------------------------------------- */

describe('recommendations :: the chain terminates (plan §2)', () => {
  it('stops on the visited set when a series would gain from a second move', () => {
    const toOf = (state) =>
      Object.fromEntries(state.recommendations.map((r) => [r.assignmentId, r.to && key(r.to)]));
    const s0 = createRecommendationState(VISITED);
    expect(toOf(s0)).toEqual({ 'v-a': key(V_Z), 'v-b': key(V_Y), 'v-s': key(V_X) });
    // The production path to A on Y and B on Z, nothing declined.
    const s1 = declineRecommendation(s0, 'v-b');
    const s2 = declineRecommendation(s1, 'v-a');
    const s3 = undoDecline(s2, 'v-b', V_Y);
    const s4 = undoDecline(s3, 'v-a', V_Z);
    expect(toOf(s4)).toEqual({ 'v-a': key(V_Y), 'v-b': key(V_Z), 'v-s': key(V_X) });
    expect(s4.declined).toEqual([]);
    // The fixture prices what it claims, through the objective.
    const [a, b] = snapshot(VISITED).displaced;
    expect([V_Z, V_X, V_Y].map((shape) => costAt(a, shape))).toEqual([1011, 1181, 1241]);
    expect([V_Y, V_Z, V_X].map((shape) => costAt(b, shape))).toEqual([1, 1251, 1421]);

    const s5 = declineRecommendation(s4, 'v-s');
    const chain = s5.chains.at(-1);
    expect(chain.hops.map((h) => [h.assignmentId, key(h.to), h.gain])).toEqual([
      ['v-a', key(V_X), 60],
      ['v-b', key(V_Y), 1250],
    ]);
    expect(chain.stoppedBy).toBe(PRACTICE_CHAIN_STOP.ALL_VISITED);
    // A would still gain 170 from Z: the visited set, not the gain, stopped it.
    expect(costAt(a, V_Z)).toBeLessThan(costAt(a, V_X));
    const moved = chain.hops.map((h) => h.assignmentId);
    expect(new Set(moved).size).toBe(moved.length);
    expect(toOf(s5)).toEqual({ 'v-a': key(V_X), 'v-b': key(V_Y), 'v-s': null });
    assertNoClash(VISITED, s5.recommendations);
  });

  it('re-places the decliner inside the chain, on a slot the chain releases', () => {
    const state = createRecommendationState(REPLACE);
    expect(state.recommendations.map((r) => r.to.surfaceId)).toEqual([
      OP('field-3-a'),
      OP('field-4-a'),
    ]);
    const next = declineRecommendation(state, 'r-s');
    const chain = next.chains[0];
    expect(chain.hops.map((h) => [h.assignmentId, h.to.surfaceId])).toEqual([
      ['r-t', OP('field-3-a')],
      ['r-s', OP('field-4-a')],
    ]);
    expect(chain.stoppedBy).toBe(PRACTICE_CHAIN_STOP.NOTHING_RELEASED);
    // Placed by the chain, so the fallback never ran.
    expect(chain.fallback).toBeNull();
    // Δ still bars S from X itself.
    expect(next.recommendations[0].to.surfaceId).not.toBe(OP('field-3-a'));
  });

  it('never exceeds |affected| hops over a run of corpus declines', () => {
    let chains = 0;
    for (const surfaceId of CORPUS_SURFACES.slice(0, 10)) {
      const input = corpusInput(surfaceId);
      let state = corpusState(surfaceId);
      for (const r of state.recommendations.filter((rec) => rec.to !== null).slice(0, 3)) {
        state = declineRecommendation(state, r.assignmentId);
      }
      const bound = snapshot(input).displaced.length;
      for (const chain of state.chains) {
        const moved = chain.hops.map((h) => h.assignmentId);
        expect(moved.length).toBeLessThanOrEqual(bound);
        expect(new Set(moved).size).toBe(moved.length);
        expect(Object.values(PRACTICE_CHAIN_STOP)).toContain(chain.stoppedBy);
        chains += 1;
      }
      assertNoClash(input, state.recommendations);
    }
    expect(chains).toBeGreaterThan(0);
  }, 60_000);
});

/* -------------------------------------------------------------------------- */
/* Witness: no declined slot comes back without undo                           */
/* -------------------------------------------------------------------------- */

describe('recommendations :: a declined slot never returns without undo (plan §2)', () => {
  it('falls back to the cheapest free candidate outside Δ', () => {
    const state = createRecommendationState(SOLO);
    expect(state.recommendations[0].to).toEqual(X_SOLO);
    const next = declineRecommendation(state, 'solo');
    expect(next.recommendations[0].to).toEqual(Z_SOLO);
    expect(next.chains[0].fallback).toEqual(Z_SOLO);
    expect(next.declined).toEqual([{ assignmentId: 'solo', to: X_SOLO }]);
  });

  it('is TIME TBD `declined` once every candidate is declined, and X only comes back by undo', () => {
    let state = declineRecommendation(createRecommendationState(SOLO), 'solo');
    state = declineRecommendation(state, 'solo');
    expect(state.recommendations[0]).toMatchObject({
      to: null,
      reason: PRACTICE_TBD_REASON.DECLINED,
    });
    expect(PRACTICE_TBD_REASON.DECLINED).toBe('declined');
    const undone = undoDecline(state, 'solo', X_SOLO);
    expect(undone.recommendations[0].to).toEqual(X_SOLO);
    expect(undone.declined).toEqual([{ assignmentId: 'solo', to: Z_SOLO }]);
    expect(undone.chains.at(-1)).toMatchObject({
      kind: 'undo',
      stoppedBy: PRACTICE_CHAIN_STOP.NOTHING_RELEASED,
    });
    expect(undone.findings.map((f) => f.code)).toEqual([
      PRACTICE_REASON.REPAIR_RECOMMENDATION_LOCAL,
      PRACTICE_REASON.REPAIR_RECOMMENDATION_LOCAL,
      PRACTICE_REASON.REPAIR_RECOMMENDATION_LOCAL,
    ]);
    expect(() => undoDecline(undone, 'solo', X_SOLO)).toThrow('never declined');
  });

  it('holds over a run of corpus declines: no series ever holds a slot it declined', () => {
    let checked = 0;
    for (const surfaceId of CORPUS_SURFACES.slice(0, 10)) {
      let state = corpusState(surfaceId);
      for (const r of state.recommendations.filter((rec) => rec.to !== null).slice(0, 3)) {
        state = declineRecommendation(state, r.assignmentId);
        const holding = new Map(
          state.recommendations
            .filter((rec) => rec.to !== null)
            .map((rec) => [rec.assignmentId, key(rec.to)])
        );
        for (const d of state.declined) {
          expect(holding.get(d.assignmentId)).not.toBe(key(d.to));
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
  }, 60_000);
});

/* -------------------------------------------------------------------------- */
/* Re-base onto a fresh read (8.6 3b PR 11 plan §1, §6 witnesses 16-20)        */
/* -------------------------------------------------------------------------- */

/**
 * A plan of explicit rows, each with its own slot and, when given, its own
 * range: what a fresh read after an enact looks like (the enacted row closed
 * at D-1, its replacement from D). Built the way the writer leaves the rows,
 * never by editing the state under test.
 */
function dated({ rows, inventory, changeBudget }) {
  return {
    plan: {
      slots: rows.map((r) => ({
        id: `slot-${r.id}`,
        ...r.shape,
        durationMinutes: 60,
        validFrom: '2026-09-01',
        validUntil: '2026-11-30',
        capacity: 1,
        revisionId: 'constructed',
        label: null,
        surfaceResolution: 'resolved',
      })),
      assignments: rows.map((r) => ({
        id: r.id,
        slotId: `slot-${r.id}`,
        teamId: r.teamId,
        effectiveFrom: r.from ?? '2026-09-01',
        effectiveUntil: r.until ?? '2026-11-30',
      })),
      source: 'constructed',
    },
    graph,
    loss: { surfaceIds: [OP('field-2')], from: '2026-10-05', reason: 'maintenance' },
    inventory: inventory.map((shape) => ({ durationMinutes: 60, ...shape })),
    ...(changeBudget === undefined ? {} : { changeBudget }),
  };
}

/*
 * A (Tue 17:00) has one shape, XA (Tue 18:00: a published-time change). C
 * (Tue 20:00) holds XC (Tue 20:00 elsewhere: no change) and could take YC
 * (Tue 21:00: a change). E (Wed 17:00) holds XE (no change). Budget 1: A
 * spends it. The fresh read after enacting A closes A at D-1, adds its
 * replacement on XA from D, and (elsewhere in the season) a frozen row Z on XC.
 */
const RB_XA = { surfaceId: OP('field-3-a'), weekday: 'TUE', startMinutes: 1080 };
const RB_XC = { surfaceId: OP('field-4-a'), weekday: 'TUE', startMinutes: 1200 };
const RB_YC = { surfaceId: OP('field-5'), weekday: 'TUE', startMinutes: 1260 };
const RB_XE = { surfaceId: OP('field-3-a'), weekday: 'WED', startMinutes: 1020 };
const RB_ROWS = [
  {
    id: 'rb-a',
    teamId: 'A',
    shape: { surfaceId: OP('field-2-a'), weekday: 'TUE', startMinutes: 1020 },
  },
  {
    id: 'rb-c',
    teamId: 'C',
    shape: { surfaceId: OP('field-2-b'), weekday: 'TUE', startMinutes: 1200 },
  },
  {
    id: 'rb-e',
    teamId: 'E',
    shape: { surfaceId: OP('field-2-a'), weekday: 'WED', startMinutes: 1020 },
  },
];
const RB_INVENTORY = [RB_XA, RB_XC, RB_YC, RB_XE];
const RB_BEFORE = dated({ rows: RB_ROWS, inventory: RB_INVENTORY, changeBudget: 1 });
/** The season after enacting `rb-a` onto `to`, with `extra` rows written elsewhere. */
const rbAfterEnact = (to, extra = [], changeBudget = 1) =>
  dated({
    rows: [
      ...RB_ROWS.map((r) => (r.id === 'rb-a' ? { ...r, until: '2026-10-04' } : r)),
      { id: 'rb-a-r', teamId: 'A', shape: to, from: '2026-10-05' },
      ...extra,
    ],
    inventory: RB_INVENTORY,
    changeBudget,
  });
const RB_Z = { id: 'rb-z', teamId: 'Z', shape: RB_XC };
const RB_N = {
  id: 'rb-n',
  teamId: 'N',
  shape: { surfaceId: OP('field-2-b'), weekday: 'WED', startMinutes: 1200 },
};

/** Brute force: the carried placements the fresh read makes inadmissible (its own clash test). */
function inadmissibleOnFreshRead(freshInput, state) {
  const { lost, series } = snapshot(freshInput);
  const frozen = series.filter((s) => !s.displaced);
  const inventory = new Set(freshInput.inventory.map(key));
  const displacedIds = new Set(series.filter((s) => s.displaced).map((s) => s.id));
  return state.recommendations
    .filter((r) => r.to !== null && displacedIds.has(r.assignmentId))
    .filter((r) => {
      const at = placedOf(r);
      return (
        lost.has(r.to.surfaceId) ||
        !inventory.has(key(r.to)) ||
        frozen.some((other) => clash(at, other))
      );
    })
    .map((r) => r.assignmentId)
    .sort();
}

/** The published-time changes a list of recommendations spends, priced from the snapshot. */
function timeChangesOf(input, recommendations) {
  const byId = new Map(snapshot(input).series.map((s) => [s.id, s]));
  return recommendations
    .filter((r) => r.to !== null)
    .reduce(
      (sum, r) =>
        sum +
        (changeCountsFor(byId.get(r.assignmentId), { ...r.to })[
          RESOLVE_OBJECTIVE_TERM.CHANGED_GAME
        ] ?? 0),
      0
    );
}

describe('recommendations :: re-base onto a fresh read (PR 11 plan §1, §6 16-20)', () => {
  const start = () => createRecommendationState(RB_BEFORE);
  const aTo = () => start().recommendations.find((r) => r.assignmentId === 'rb-a').to;

  it('the fixture exercises what it claims (meta-assertions, each with its vacuity plant)', () => {
    const state = start();
    expect(requireExamined(snapshot(RB_BEFORE).displaced.length, 'displaced series')).toBe(3);
    expect(key(aTo())).toBe(key({ ...RB_XA, durationMinutes: 60 }));
    const fresh = rbAfterEnact(aTo(), [RB_Z]);
    expect(requireExamined(inadmissibleOnFreshRead(fresh, state).length, 'release')).toBe(1);
    // The vacuity plant: the loss moved off every series.
    const off = { ...RB_BEFORE, loss: { ...RB_BEFORE.loss, surfaceIds: [OP('field-5')] } };
    expect(() => requireExamined(snapshot(off).displaced.length, 'displaced series')).toThrow(
      'examined no displaced series'
    );
    const quiet = rbAfterEnact(aTo());
    expect(() => requireExamined(inadmissibleOnFreshRead(quiet, state).length, 'release')).toThrow(
      'examined no release'
    );
  });

  it('16: no two recommendations clash after a re-base, and none lands on a fresh frozen row', () => {
    const fresh = rbAfterEnact(aTo(), [RB_Z]);
    const rebased = rebaseRecommendationState(start(), fresh, { enacted: ['rb-a'] });
    expect(requireExamined(assertNoClash(fresh, rebased.recommendations), 'pair')).toBeGreaterThan(
      0
    );
  });

  it('17: releases exactly the inadmissible carried recommendations, by brute force', () => {
    const state = start();
    const fresh = rbAfterEnact(aTo(), [RB_Z]);
    const expected = inadmissibleOnFreshRead(fresh, state);
    const rebased = rebaseRecommendationState(state, fresh, { enacted: ['rb-a'] });
    const released = rebased.chains.filter((c) => c.kind === 'release').map((c) => c.assignmentId);
    expect(requireExamined(released.length, 'release')).toBe(expected.length);
    expect(released.sort()).toEqual(expected);
    expect(rebased.findings.map((f) => f.code)).toEqual([
      PRACTICE_REASON.REPAIR_RECOMMENDATION_LOCAL,
    ]);
    // A release is not a decline: Δ is unchanged.
    expect(rebased.declined).toEqual([]);
    // And nothing is released when the fresh read changes nothing it holds.
    const quiet = rebaseRecommendationState(state, rbAfterEnact(aTo()), { enacted: ['rb-a'] });
    expect(quiet.chains).toEqual([]);
  });

  it('18: every carried series and every fresh-displaced series appears exactly once', () => {
    const state = start();
    for (const fresh of [rbAfterEnact(aTo(), [RB_Z]), rbAfterEnact(aTo(), [RB_N])]) {
      const rebased = rebaseRecommendationState(state, fresh, { enacted: ['rb-a'] });
      expect(
        requireExamined(assertEveryWindowOnce(fresh, rebased.recommendations), 'window')
      ).toBeGreaterThan(1);
      const answered = rebased.recommendations.map((r) => r.assignmentId);
      const carried = RB_ROWS.map((r) => r.id).filter((id) => id !== 'rb-a');
      for (const id of carried) expect(answered.filter((a) => a === id)).toEqual([id]);
      expect(answered).not.toContain('rb-a');
      expect(rebased.enacted).toEqual(['rb-a']);
    }
  });

  it('19: the change budget spans enacts: budget 1, A enacted with a change, C cannot change', () => {
    const state = start();
    const enactedChanges = timeChangesOf(RB_BEFORE, [
      state.recommendations.find((r) => r.assignmentId === 'rb-a'),
    ]);
    expect(requireExamined(enactedChanges, 'enacted time change')).toBe(1);
    for (const fresh of [rbAfterEnact(aTo(), [RB_Z]), rbAfterEnact(aTo(), [RB_N])]) {
      const rebased = rebaseRecommendationState(state, fresh, { enacted: ['rb-a'] });
      expect(rebased.enactedTimeChanges).toBe(1);
      expect(enactedChanges + timeChangesOf(fresh, rebased.recommendations)).toBeLessThanOrEqual(1);
    }
    const released = rebaseRecommendationState(state, rbAfterEnact(aTo(), [RB_Z]), {
      enacted: ['rb-a'],
    }).recommendations.find((r) => r.assignmentId === 'rb-c');
    expect(released.to).toBeNull();
    expect(released.reason).toBe(PRACTICE_TBD_REASON.CHANGE_BUDGET);
  });

  it('20: an enacted series still displaced on the fresh read is loud', () => {
    expect(() => rebaseRecommendationState(start(), RB_BEFORE, { enacted: ['rb-a'] })).toThrow(
      'did not land'
    );
    expect(() => rebaseRecommendationState(start(), RB_BEFORE, { enacted: ['nope'] })).toThrow(
      'cannot have been enacted'
    );
  });

  it('reopens on a season changed elsewhere, and a carried decline still never returns without undo', () => {
    let state = start();
    const declinedShape = state.recommendations.find((r) => r.assignmentId === 'rb-c').to;
    state = declineRecommendation(state, 'rb-c');
    expect(requireExamined(state.declined.length, 'decline')).toBe(1);
    const fresh = rbAfterEnact(aTo(), [RB_N]);
    const rebased = rebaseRecommendationState(state, fresh, { enacted: ['rb-a'] });
    expect(rebased.findings.find((f) => f.details?.reopened)?.details).toMatchObject({
      reopened: true,
      appeared: ['rb-n'],
    });
    // The fresh repair offered C its declined shape again: declined again, recorded.
    expect(rebased.chains.at(-1)).toMatchObject({ kind: 'decline', assignmentId: 'rb-c' });
    expect(rebased.declined.map((d) => `${d.assignmentId}@${key(d.to)}`)).toEqual([
      `rb-c@${key(declinedShape)}`,
    ]);
    const c = rebased.recommendations.find((r) => r.assignmentId === 'rb-c');
    expect(c.to === null ? null : key(c.to)).not.toBe(key(declinedShape));
    expect(assertEveryWindowOnce(fresh, rebased.recommendations)).toBe(3);
    assertNoClash(fresh, rebased.recommendations);
  });

  it('carries the state through when nothing changed, and is deterministic', () => {
    const state = declineRecommendation(start(), 'rb-e');
    const same = rebaseRecommendationState(state, RB_BEFORE);
    expect(same.recommendations).toEqual(state.recommendations);
    expect(same.declined).toEqual(state.declined);
    const fresh = rbAfterEnact(aTo(), [RB_Z]);
    expect(rebaseRecommendationState(state, fresh, { enacted: ['rb-a'] })).toEqual(
      rebaseRecommendationState(state, fresh, { enacted: ['rb-a'] })
    );
  });
});
