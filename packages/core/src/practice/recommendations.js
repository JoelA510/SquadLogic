/**
 * Declining a practice recommendation, and the re-offer chain (8.6 PR 3b plan
 * §2, "Most eligible" and "Re-offer chain"; §5 decision 10).
 *
 * `repairPracticeLoss()` gives every displaced series-window one
 * recommendation. An operator may decline one. This module answers what
 * happens next, as a pure function of an in-memory state: no DB, no clock, no
 * randomness. Declines are **not persisted** (decision 10): the state lives as
 * long as the session holding it, and PR 11's enact audit records the pairs
 * declined along the way.
 *
 * ## The rule, exactly as the plan states it
 *
 * When series S declines shape X, (S, X) joins the declined set Δ and S is
 * treated as TIME TBD at `tbdCost` (the `unplacedGame` weight). X is then
 * offered to the **most eligible** series T. T is eligible for X when all
 * eight hold:
 *
 * 1. T is affected (displaced by the loss);
 * 2. T is not enacted;
 * 3. T ≠ S — for the declined slot X only (operator ruling 2026-09-28). On
 *    every later slot the chain releases, S is an ordinary candidate: TIME TBD
 *    at `tbdCost`, so its gain is usually the largest; Δ alone bars it from X;
 * 4. (T, X) ∉ Δ;
 * 5. T's duration is X's;
 * 6. `marginal(T, X, R∖{T}, coachDays(R∖{T}))` is not null — the repair's own
 *    clash definition, against every other recommendation R and the frozen plan;
 * 7. T's `must_keep` preferences hold, and the change budget holds over R with
 *    T moved;
 * 8. X is cross-venue only if T is currently TIME TBD: the objective prices a
 *    venue change at `changedSurface = 1`, so same-venue-first has to stay
 *    structural, as it is in tier 1.
 *
 * (6) and "X is one of T's candidates" are one test: a candidate list already
 * holds only shapes of T's duration, off the lost ground, clear of the frozen
 * plan and inside `must_keep`, so the `must_keep` half of (7) is read from it.
 *
 * `gain(T)` = the cost of T's current recommendation (its marginal, or
 * `tbdCost` if TIME TBD) − `marginal(T, X, …).cost`, from the one objective;
 * nothing here ranks by anything else. The most eligible T has the highest
 * gain, and gain > 0. Ties go to the search's own order: fewest same-venue
 * candidates, then assignment id.
 *
 * **The chain.** When T moves Y → X, Y is released and the same rule is
 * applied to Y. Each series moves at most once per event (the visited set V).
 * The chain stops when no eligible T has gain > 0, when every such T is in V,
 * or after |affected| hops, and says which; it also ends when the series that
 * moved was TIME TBD, since then nothing is released. It always terminates
 * because V only grows.
 *
 * **S's fallback.** If S was not re-placed by the chain, it takes its cheapest admissible
 * free candidate outside Δ, same-venue or cross-venue (S is TIME TBD), with no
 * new chain; otherwise it is TIME TBD with `PRACTICE_TBD_REASON.DECLINED`.
 * "Admissible" is tier 1's contract: legal, within the budget, and cheaper
 * than TIME TBD.
 *
 * **Undo.** `undoDecline(state, S, X)` removes (S, X) from Δ and re-runs the
 * rule for X, S included. It is the only way a declined slot returns to S.
 *
 * After any decline or undo the result is locally repaired, not proven
 * optimal, and says so: `PRACTICE_REPAIR_RECOMMENDATION_LOCAL`.
 *
 * @module practice/recommendations
 */

import { PRACTICE_REASON, makePracticeFinding } from './reasonCodes.js';
import {
  PRACTICE_TBD_REASON,
  buildPracticeRepairContext,
  describePracticeRecommendations,
  placementsExcept,
  repairPracticeLoss,
  shapeKey,
} from './repair.js';

/** Why a re-offer chain stopped. */
export const PRACTICE_CHAIN_STOP = Object.freeze({
  /** No eligible series gained from the released slot. */
  NO_GAIN: 'no-gain',
  /** Every eligible series that would gain had already moved in this event. */
  ALL_VISITED: 'all-visited',
  /**
   * The chain made |affected| hops. The plan's third bound, kept as a
   * backstop and **unreachable while the visited set holds**: after
   * |affected| hops every series is visited, so ALL_VISITED or NO_GAIN fires
   * first. Declared, not exercised.
   */
  HOP_LIMIT: 'hop-limit',
  /** The series that took the slot was TIME TBD, so nothing was released. */
  NOTHING_RELEASED: 'nothing-released',
});

/**
 * The state a session starts from: the repair's recommendations, nothing
 * declined. `enacted` names the series already enacted (PR 11), which are
 * never offered anything and cannot be declined.
 *
 * @param {Object} input - a `repairPracticeLoss()` input
 * @param {{ enacted?: string[] }} [options]
 */
export function createRecommendationState(input, { enacted = [] } = {}) {
  const result = repairPracticeLoss(input);
  return Object.freeze({
    input,
    recommendations: result.recommendations,
    declined: [],
    enacted: [...enacted].sort(),
    chains: [],
    findings: [],
  });
}

/**
 * The working form of a state: the repair's context, and each series'
 * current candidate (or null) read back from the state's recommendations.
 */
function open(state) {
  const context = buildPracticeRepairContext(state.input);
  const entryById = new Map(
    context.candidatesBySeries.map((entry) => [entry.series.assignmentId, entry])
  );
  const candidateFor = (assignmentId, shape) => {
    const entry = entryById.get(assignmentId);
    const key = shapeKey(shape);
    return [...entry.same, ...entry.cross].find((c) => shapeKey(c.shape) === key) ?? null;
  };
  const chosen = new Map();
  const reasons = new Map();
  for (const recommendation of state.recommendations) {
    if (!entryById.has(recommendation.assignmentId)) {
      throw new Error(
        `recommendations: ${recommendation.assignmentId} is not displaced by this loss`
      );
    }
    if (recommendation.to === null) {
      reasons.set(recommendation.assignmentId, recommendation.reason);
      continue;
    }
    const candidate = candidateFor(recommendation.assignmentId, recommendation.to);
    if (candidate === null) {
      throw new Error(
        `recommendations: ${recommendation.assignmentId} is recommended a shape that is not its candidate`
      );
    }
    chosen.set(recommendation.assignmentId, candidate);
  }
  const declined = new Set(state.declined.map((d) => `${d.assignmentId}@${shapeKey(d.to)}`));
  return { context, entryById, candidateFor, chosen, reasons, declined };
}

/**
 * What T would gain by taking `slot`, or null when T is not eligible for it
 * (conditions 1-8 of the module doc, less "not in V", which the chain applies).
 */
function eligibleGain(work, enacted, excluded, entry, slot) {
  const { context, candidateFor, chosen, declined } = work;
  const series = entry.series;
  const id = series.assignmentId;
  if (enacted.has(id) || id === excluded) return null;
  if (declined.has(`${id}@${shapeKey(slot)}`)) return null;
  if (series.durationMinutes !== slot.durationMinutes) return null;
  const candidate = candidateFor(id, slot);
  if (candidate === null) return null;
  const current = chosen.get(id) ?? null;
  const crossVenue = context.venueOf(slot.surfaceId) !== context.venueOf(series.surfaceId);
  if (crossVenue && current !== null) return null;
  const rest = placementsExcept(context, chosen, id);
  if (
    context.budget !== null &&
    rest.timeChanges + context.timeChangeOf(candidate) > context.budget
  ) {
    return null;
  }
  const m = context.marginal(series, candidate, rest.placed, rest.coachDays);
  if (m === null) return null;
  let currentCost = context.tbdCost;
  if (current !== null) {
    const held = context.marginal(series, current, rest.placed, rest.coachDays);
    if (held === null) {
      throw new Error(`recommendations: ${id}'s current recommendation clashes with another`);
    }
    currentCost = held.cost;
  }
  return { candidate, gain: currentCost - m.cost };
}

/**
 * Offer `slot` to the most eligible series, and each slot that frees to the
 * next, until a stop condition. Mutates `work.chosen`; returns the hops.
 */
function reoffer(work, enacted, excluded, slot) {
  const { context, chosen, reasons } = work;
  const visited = new Set();
  const hops = [];
  let offered = slot;
  let stoppedBy;
  for (;;) {
    if (hops.length >= context.displaced.length) {
      stoppedBy = PRACTICE_CHAIN_STOP.HOP_LIMIT;
      break;
    }
    const gainers = [];
    // `context.order` is the search's own order: fewest same-venue
    // candidates, then assignment id. A stable sort on gain keeps it for ties.
    for (const { entry } of context.order) {
      // "T ≠ S" bars the decliner from the declined slot only (the first
      // offer); every slot released after it is open to S like anyone else.
      const barred = hops.length === 0 ? excluded : null;
      const verdict = eligibleGain(work, enacted, barred, entry, offered);
      if (verdict !== null && verdict.gain > 0) gainers.push({ entry, ...verdict });
    }
    if (gainers.length === 0) {
      stoppedBy = PRACTICE_CHAIN_STOP.NO_GAIN;
      break;
    }
    const unvisited = gainers.filter(({ entry }) => !visited.has(entry.series.assignmentId));
    if (unvisited.length === 0) {
      stoppedBy = PRACTICE_CHAIN_STOP.ALL_VISITED;
      break;
    }
    const best = [...unvisited].sort((a, b) => b.gain - a.gain)[0];
    const id = best.entry.series.assignmentId;
    const previous = chosen.get(id) ?? null;
    chosen.set(id, best.candidate);
    reasons.delete(id);
    visited.add(id);
    hops.push({
      assignmentId: id,
      from: previous === null ? null : { ...previous.shape },
      to: { ...best.candidate.shape },
      gain: best.gain,
    });
    if (previous === null) {
      stoppedBy = PRACTICE_CHAIN_STOP.NOTHING_RELEASED;
      break;
    }
    offered = previous.shape;
  }
  return { offered: { ...slot }, hops, stoppedBy };
}

/** The next state, with its recommendations re-described from `work`. */
function close(state, work, { declined, chain, finding }) {
  const recommendations = describePracticeRecommendations(work.context, work.chosen, (id) =>
    work.reasons.get(id)
  );
  return Object.freeze({
    input: state.input,
    recommendations,
    declined,
    enacted: state.enacted,
    chains: [...state.chains, chain],
    findings: [...state.findings, finding],
  });
}

/**
 * S declines its recommendation. See the module doc for the rule.
 *
 * @param {ReturnType<typeof createRecommendationState>} state
 * @param {string} assignmentId - S
 */
export function declineRecommendation(state, assignmentId) {
  const work = open(state);
  const enacted = new Set(state.enacted);
  if (enacted.has(assignmentId)) {
    throw new Error(
      `recommendations: ${assignmentId} is enacted and locked; it cannot be declined`
    );
  }
  if (!work.entryById.has(assignmentId)) {
    throw new Error(`recommendations: ${assignmentId} is not displaced by this loss`);
  }
  const current = work.chosen.get(assignmentId) ?? null;
  if (current === null) {
    throw new Error(`recommendations: ${assignmentId} is TIME TBD; there is nothing to decline`);
  }
  const x = { ...current.shape };
  const declined = [...state.declined, { assignmentId, to: x }];
  work.declined.add(`${assignmentId}@${shapeKey(x)}`);
  work.chosen.delete(assignmentId);
  // Placeholder until the fallback below decides.
  work.reasons.set(assignmentId, PRACTICE_TBD_REASON.DECLINED);

  const chain = reoffer(work, enacted, assignmentId, x);

  // S's fallback: its cheapest admissible free candidate outside Δ, no chain.
  let fallback = null;
  if (!work.chosen.has(assignmentId)) {
    const { context } = work;
    const entry = work.entryById.get(assignmentId);
    const rest = placementsExcept(context, work.chosen, assignmentId);
    for (const candidate of [...entry.same, ...entry.cross]) {
      if (work.declined.has(`${assignmentId}@${shapeKey(candidate.shape)}`)) continue;
      if (
        context.budget !== null &&
        rest.timeChanges + context.timeChangeOf(candidate) > context.budget
      ) {
        continue;
      }
      const m = context.marginal(entry.series, candidate, rest.placed, rest.coachDays);
      if (m === null || m.cost >= context.tbdCost) continue;
      // Strictly cheaper only: on a tie the earlier candidate stands, and
      // same-venue candidates come first, so a tie never leaves the venue.
      if (fallback === null || m.cost < fallback.cost) fallback = { candidate, cost: m.cost };
    }
    if (fallback !== null) {
      work.chosen.set(assignmentId, fallback.candidate);
      work.reasons.delete(assignmentId);
    }
  }

  const placedAgain = work.chosen.get(assignmentId) ?? null;
  const record = {
    kind: 'decline',
    assignmentId,
    ...chain,
    fallback: fallback === null ? null : { ...fallback.candidate.shape },
  };
  return close(state, work, {
    declined,
    chain: record,
    finding: makePracticeFinding(
      PRACTICE_REASON.REPAIR_RECOMMENDATION_LOCAL,
      `${assignmentId} declined ${shapeKey(x)}: re-offered along a chain of ${chain.hops.length} move(s) (stopped: ${chain.stoppedBy}); ${placedAgain === null ? `${assignmentId} is TIME TBD (declined)` : `${assignmentId} now ${shapeKey(placedAgain.shape)}`}. The recommendations are locally repaired, not proven optimal.`,
      {
        assignmentId,
        declined: shapeKey(x),
        hops: chain.hops.length,
        stoppedBy: chain.stoppedBy,
      }
    ),
  });
}

/**
 * Undo one decline: (S, X) leaves Δ and X is offered again under the same
 * rule, S included — the only way a declined slot returns to S.
 *
 * @param {ReturnType<typeof createRecommendationState>} state
 * @param {string} assignmentId - S
 * @param {{ surfaceId: string, weekday: string, startMinutes: number, durationMinutes: number }} shape - X
 */
export function undoDecline(state, assignmentId, shape) {
  const key = `${assignmentId}@${shapeKey(shape)}`;
  const index = state.declined.findIndex((d) => `${d.assignmentId}@${shapeKey(d.to)}` === key);
  if (index === -1) {
    throw new Error(`recommendations: ${assignmentId} never declined ${shapeKey(shape)}`);
  }
  if (state.enacted.includes(assignmentId)) {
    throw new Error(`recommendations: ${assignmentId} is enacted and locked; its declines stand`);
  }
  const declined = state.declined.filter((_, i) => i !== index);
  const work = open({ ...state, declined });
  const chain = reoffer(work, new Set(state.enacted), null, { ...state.declined[index].to });
  return close(state, work, {
    declined,
    chain: { kind: 'undo', assignmentId, ...chain, fallback: null },
    finding: makePracticeFinding(
      PRACTICE_REASON.REPAIR_RECOMMENDATION_LOCAL,
      `${assignmentId} took back its decline of ${shapeKey(shape)}: re-offered along a chain of ${chain.hops.length} move(s) (stopped: ${chain.stoppedBy}). The recommendations are locally repaired, not proven optimal.`,
      {
        assignmentId,
        undone: shapeKey(shape),
        hops: chain.hops.length,
        stoppedBy: chain.stoppedBy,
      }
    ),
  });
}
