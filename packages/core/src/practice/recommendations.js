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

import { RESOLVE_OBJECTIVE_TERM } from '../resolve/objective.js';
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
    // Published-time changes the session's enacts spent (PR 11): see
    // `rebaseRecommendationState`, which charges them to the change budget.
    enactedTimeChanges: 0,
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

/**
 * S's fallback after a decline or a release: its cheapest admissible free
 * candidate outside Δ, no chain. Taken into `work` when found; null when not.
 */
function takeFallback(work, assignmentId) {
  const { context } = work;
  const entry = work.entryById.get(assignmentId);
  const rest = placementsExcept(context, work.chosen, assignmentId);
  let fallback = null;
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
  return fallback;
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
    enactedTimeChanges: state.enactedTimeChanges ?? 0,
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

  const fallback = work.chosen.has(assignmentId) ? null : takeFallback(work, assignmentId);

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

/** The published-time change a recommendation spends: 1 when its move changes the time. */
function timeChangeOfRecommendation(recommendation) {
  if (recommendation.to === null) return 0;
  return (recommendation.objective.counts[RESOLVE_OBJECTIVE_TERM.CHANGED_GAME] ?? 0) === 1 ? 1 : 0;
}

/**
 * Re-base a session's state onto a FRESH repair input, after an enact or
 * before re-judging one (8.6 3b PR 11 plan §1, "Re-validate and release").
 * Pure: no DB. `enacted` names the series enacted since `state` was made;
 * they join the state's enacted set.
 *
 * 1. Every enacted series must be ABSENT from the fresh displaced set. One
 *    still present means the write did not land as planned: this throws.
 * 2. If a carried series that is not enacted is missing from the fresh
 *    displaced set, or the fresh set holds one the state never had, the
 *    season changed elsewhere: the state is reopened from the fresh repair,
 *    never re-based piecemeal. Δ pairs whose series is still displaced or
 *    enacted are carried. Where the fresh repair recommends a series the
 *    very shape it declined, that shape is declined again (a recorded
 *    chain), so a declined slot still never returns without undo. A finding
 *    says the state was reopened.
 * 3. Otherwise the carried placements are walked in the search's own order.
 *    Each is kept while its `to` is still a candidate, the change budget holds
 *    over the kept ones, and its marginal against the kept ones is not null.
 *    Each that fails is RELEASED: its shape is re-offered exactly as a
 *    decline's is (S barred from it for the first hop only), then S takes the
 *    decline fallback, else is TIME TBD with the reason the fresh repair gives
 *    it (`contended` when the fresh repair placed it). A release is not a
 *    decline: (S, X) does not join Δ. Each release stamps
 *    `PRACTICE_REPAIR_RECOMMENDATION_LOCAL` and a `kind: 'release'` chain.
 *
 * **The change budget spans enacts.** An enacted series leaves the displaced
 * set, so its published-time change would stop counting. The fresh input's
 * `changeBudget` (the caller passes the adapter's, unreduced) is charged with
 * every time change enacted this session, and the state keeps the total in
 * `enactedTimeChanges`. Enacts from an earlier session are not counted:
 * declared, not enforced.
 *
 * @param {ReturnType<typeof createRecommendationState>} state
 * @param {Object} freshInput - a `repairPracticeLoss()` input from a fresh read
 * @param {{ enacted?: string[] }} [options] - series enacted since `state`
 */
export function rebaseRecommendationState(state, freshInput, { enacted: newly = [] } = {}) {
  const carriedById = new Map(state.recommendations.map((r) => [r.assignmentId, r]));
  const enactedBefore = new Set(state.enacted);
  let spent = state.enactedTimeChanges ?? 0;
  for (const assignmentId of new Set(newly)) {
    if (enactedBefore.has(assignmentId)) {
      throw new Error(`recommendations: ${assignmentId} is already enacted`);
    }
    const recommendation = carriedById.get(assignmentId);
    if (recommendation === undefined) {
      throw new Error(
        `recommendations: ${assignmentId} is not one of this state's recommendations; it cannot have been enacted`
      );
    }
    spent += timeChangeOfRecommendation(recommendation);
  }
  const enactedIds = [...new Set([...state.enacted, ...newly])].sort();
  const enacted = new Set(enactedIds);
  const budget = freshInput.changeBudget ?? null;
  const input =
    budget === null ? freshInput : { ...freshInput, changeBudget: Math.max(0, budget - spent) };

  const work = open({ input, recommendations: [], declined: state.declined });
  const { context } = work;
  const freshIds = new Set(context.displaced.map((series) => series.assignmentId));
  const stillDisplaced = enactedIds.filter((assignmentId) => freshIds.has(assignmentId));
  if (stillDisplaced.length > 0) {
    throw new Error(
      `recommendations: enacted ${stillDisplaced.join(', ')} still displaced on the fresh read; the enact did not land as planned`
    );
  }
  const carriedIds = [...carriedById.keys()].filter((assignmentId) => !enacted.has(assignmentId));
  const sameSet =
    carriedIds.length === freshIds.size &&
    carriedIds.every((assignmentId) => freshIds.has(assignmentId));
  if (!sameSet) {
    return reopen(state, input, enactedIds, spent, {
      lost: carriedIds.filter((assignmentId) => !freshIds.has(assignmentId)).sort(),
      appeared: [...freshIds].filter((assignmentId) => !carriedById.has(assignmentId)).sort(),
    });
  }

  // Step 3: walk the carried placements in the search's own order.
  const released = [];
  for (const { entry } of context.order) {
    const assignmentId = entry.series.assignmentId;
    const carried = /** @type {any} */ (carriedById.get(assignmentId));
    if (carried.to === null) {
      work.reasons.set(assignmentId, carried.reason);
      continue;
    }
    const candidate = work.candidateFor(assignmentId, carried.to);
    let keep = candidate !== null;
    if (keep) {
      const rest = placementsExcept(context, work.chosen, assignmentId);
      keep =
        (context.budget === null ||
          rest.timeChanges + context.timeChangeOf(candidate) <= context.budget) &&
        context.marginal(entry.series, candidate, rest.placed, rest.coachDays) !== null;
    }
    if (keep) work.chosen.set(assignmentId, candidate);
    else released.push({ assignmentId, shape: { ...carried.to } });
  }

  const chains = [];
  const findings = [];
  if (released.length > 0) {
    // The sibling's contract for a series left TIME TBD: the fresh repair's reason.
    const freshTbd = new Map(
      repairPracticeLoss(input).timeTbd.map((entry) => [entry.assignmentId, entry.reason])
    );
    for (const { assignmentId } of released) {
      work.reasons.set(assignmentId, freshTbd.get(assignmentId) ?? PRACTICE_TBD_REASON.CONTENDED);
    }
    for (const { assignmentId, shape } of released) {
      const chain = reoffer(work, enacted, assignmentId, shape);
      const fallback = work.chosen.has(assignmentId) ? null : takeFallback(work, assignmentId);
      const placedAgain = work.chosen.get(assignmentId) ?? null;
      chains.push({
        kind: 'release',
        assignmentId,
        ...chain,
        fallback: fallback === null ? null : { ...fallback.candidate.shape },
      });
      findings.push(
        makePracticeFinding(
          PRACTICE_REASON.REPAIR_RECOMMENDATION_LOCAL,
          `${assignmentId}'s recommendation ${shapeKey(shape)} is no longer admissible on the fresh read and was released: re-offered along a chain of ${chain.hops.length} move(s) (stopped: ${chain.stoppedBy}); ${placedAgain === null ? `${assignmentId} is TIME TBD (${work.reasons.get(assignmentId)})` : `${assignmentId} now ${shapeKey(placedAgain.shape)}`}. The recommendations are locally repaired, not proven optimal.`,
          {
            assignmentId,
            released: shapeKey(shape),
            hops: chain.hops.length,
            stoppedBy: chain.stoppedBy,
          }
        )
      );
    }
  }

  return Object.freeze({
    input,
    recommendations: describePracticeRecommendations(context, work.chosen, (assignmentId) =>
      work.reasons.get(assignmentId)
    ),
    declined: state.declined,
    enacted: enactedIds,
    enactedTimeChanges: spent,
    chains: [...state.chains, ...chains],
    findings: [...state.findings, ...findings],
  });
}

/**
 * Step 2 of the re-base: the season changed elsewhere, so the state reopens
 * from the fresh repair and Δ is re-applied to it.
 */
function reopen(state, input, enactedIds, spent, { lost, appeared }) {
  const enacted = new Set(enactedIds);
  const opened = createRecommendationState(input, { enacted: enactedIds });
  const freshIds = new Set(opened.recommendations.map((r) => r.assignmentId));
  const carried = state.declined.filter(
    (d) => freshIds.has(d.assignmentId) || enacted.has(d.assignmentId)
  );
  /** @type {any} */
  let next = Object.freeze({
    ...opened,
    enactedTimeChanges: spent,
    chains: [...state.chains],
    findings: [
      ...state.findings,
      makePracticeFinding(
        PRACTICE_REASON.REPAIR_RECOMMENDATION_LOCAL,
        `The season changed since these recommendations were made (no longer displaced: ${lost.length === 0 ? 'none' : lost.join(', ')}; newly displaced: ${appeared.length === 0 ? 'none' : appeared.join(', ')}). They were reopened from a fresh repair, and ${carried.length} declined pair(s) were carried over.`,
        { reopened: true, lost, appeared, declinedCarried: carried.length }
      ),
    ],
  });
  for (const pair of carried) {
    const current = next.recommendations.find((r) => r.assignmentId === pair.assignmentId);
    if (current?.to && shapeKey(current.to) === shapeKey(pair.to)) {
      // The fresh repair offers S the very shape it declined: declined again.
      next = declineRecommendation(next, pair.assignmentId);
    } else {
      next = Object.freeze({ ...next, declined: [...next.declined, pair] });
    }
  }
  return next;
}
