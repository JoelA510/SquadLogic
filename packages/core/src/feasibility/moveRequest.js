/**
 * **The two-sided question — Prompt 8.7.**
 *
 * > *"A parent asked to move this fixture into that window. What can the club
 * > actually offer — an empty slot, a swap nobody loses by, a swap somebody
 * > loses by, or nothing?"*
 *
 * The most-repeated manual computation in the club's season, and the first one
 * in `packages/core` that looks at anybody but the subject.
 *
 * ## What already existed, and what this adds
 *
 * `feasibility/queries.js` answers three narrower questions: `canGameMove()`
 * takes **one** named destination, `canTeamPlay()` gives a dates x surfaces grid
 * at **one** caller-supplied kickoff, and `feasibleKickoffBounds()` returns a
 * boundary. None enumerates the open positions in a window.
 *
 * **On the plan's claim that "nothing anywhere in `packages/core` computes a
 * two-sided swap": it is not quite true, and the difference is worth stating
 * rather than quietly building beside.** `autoScheduler.js` `mutate()` does
 * compute a genuine two-sided exchange — it lifts two teams' practice
 * assignments and re-adds each into the other's slot, refusing the pair if
 * either fails `checkHardConstraints()`. Three things make it the wrong thing
 * to adopt here rather than a duplicate to avoid: it is a **mutation inside a
 * hill-climb**, chosen at random from a seeded PRNG rather than enumerated; it
 * lives on the shipped MVP practice path, which models time as `Date` objects
 * and so cannot meet this engine's no-`Date` rule; and it scores the **whole
 * schedule** through one objective function, so it never computes what *this*
 * counterparty loses. `practiceScheduling.js` `tryResolveTeamWithSwap()` is
 * likewise not a swap at all — it is a bump: the occupant is re-homed to a
 * *third* slot, and if no third slot exists the attempt is abandoned.
 * `resolve/stages.js` `pairRepair` is the same bump one layer up. So the
 * two-sided *legality* idea exists twice and the two-sided *cost* idea exists
 * nowhere, which is what this module is.
 *
 * ## The four things returned, and where each number comes from
 *
 * | returned | decided by |
 * | --- | --- |
 * | which positions the window even offers | `reserve/capacity.js` — `buildReserveCapacityReport()`, joined to, never recomputed |
 * | is a position legal, and how tight | `availability/kickoff.js` through `feasibility/verdict.js` — `probeKickoff()`, under the registry |
 * | does anything stand there | `facility/occupancy.js` — `surfacesConflict()` and `bookingsOverlapInTime()`, whose `null` is carried as undecidable and never as "free" |
 * | what a coach's day would cost | `waivers/coachTravel.js` — `evaluateCoachTravel()`, run before and after |
 * | which constraint owns a lost objective | `resolve/errors.js` — `registryConstraintIdsFor()`, and `waivers/coachTravel.js` — `travelConstraintIdByCode()` for the seven codes the first cannot name |
 *
 * Nothing here re-implements any of them, and the verdict, the tightness, the
 * margin and the status are `feasibility/`'s own producers — this is a new
 * question, not a replacement.
 *
 * ## The classification, and why it has one producer
 *
 * {@link MOVE_REQUEST_CLASS} is what determines what the club can *say*, so
 * {@link classifyMoveRequest} is the only thing that produces one. A caller that
 * rebuilt it from `vacancies.length` and `swaps.length` would be a second
 * producer of a derived status — and a duplicated classification is worse than
 * a duplicated number, because both copies stay plausible while they diverge.
 * The classifier is exported so that a test can drive it directly with
 * constructed parts and prove each arm, and it emits its own provenance finding
 * so the sentence a human reads and the token a machine branches on come out of
 * one call.
 *
 * ## Two sides, one judge, and the lift that makes a swap different
 *
 * A swap is not two moves. Judging the subject at the counterparty's slot
 * against a world where the counterparty is still standing there reports an
 * occupancy clash on **every** swap — which is precisely why `canGameMove()`,
 * whose `checkPlacement()` reads the resolve state as it stands, cannot answer
 * this question. So both legs of an exchange are judged with **both** parties'
 * bookings lifted, through one function, {@link judgeLeg}, built on
 * `probeKickoff()`'s `ignoreBookingIds`. One judge for the subject and for the
 * counterparty means a swap can never be admitted under one standard and priced
 * under another.
 *
 * ## What this answer does not ask, said where a reader will see it
 *
 * `judgeLeg()` is the **availability layer under the registry**, plus the
 * entity's own same-day commitments, coach travel, and rule 4 — the unenforced
 * governing constraints that turn a would-be `feasible` into `unknown`.
 *
 * **That is the same evidence `canGameMove()` reaches a counterfactual verdict
 * on, and the claim is checkable rather than asserted.** `explainKickoffTime()`
 * builds its `counterfactual.claims` from `checkPlacement()` alone, which is
 * the facility layer under the registry; the standing rule engine is folded
 * into the answer about the position the game *holds*, not the one it does not.
 * So this module does not lose a layer by probing instead of calling that
 * query, and `tests/moveRequestAnalysis.test.js` pins the two verdicts together
 * across a swept set of positions so the pair cannot drift.
 *
 * What is genuinely absent is `minimalBlockingSet()` — the certified *"which
 * smallest set of constraints makes this impossible"* answer, which is
 * per-game, expensive, and a question about one named destination rather than
 * about a window. A caller that wants it for a slot this answer named asks
 * `canGameMove()` about that slot.
 *
 * For a **practice**, one further thing is silent and says so:
 * `context.verification`'s coverage is a statement about a fixture list, so
 * rule 4's unenforced-constraint sweep is being read from a run that does not
 * govern the subject. That is `MOVE_REQUEST_LAYER_SILENT` at `info` — an
 * inapplicability, not a measurement nobody took. Making it a verdict-bearing
 * unknown would turn every practice answer `unknown` and the query useless on
 * the half of the estate it was written for.
 *
 * @module feasibility/moveRequest
 */

import { bookingsOverlapInTime, surfacesConflict } from '../facility/occupancy.js';
import { getSurface } from '../facility/facilityGraph.js';
import { formatTimingOrUnknown } from '../timing/formatTiming.js';
import { CONSTRAINT_SEVERITY } from '../constraints/reasonCodes.js';
import { registryConstraintIdsFor } from '../resolve/errors.js';
import { buildReserveCapacityReport, capacitySlotId } from '../reserve/capacity.js';
import { evaluateCoachTravel, travelConstraintIdByCode } from '../waivers/coachTravel.js';

import {
  FEASIBILITY_MARGIN_UNIT,
  FEASIBILITY_QUESTION,
  FEASIBILITY_REASON,
  FEASIBILITY_THRESHOLD,
  FEASIBILITY_TIGHTNESS,
  FEASIBILITY_VERDICT,
  MOVE_REQUEST_CLASS,
  MOVE_REQUEST_ENTITY,
  createFeasibilityMeta,
  deriveFeasibilityEvidence,
  deriveFeasibilityTightness,
  deriveFeasibilityVerdict,
  makeFeasibilityFinding,
} from './reasonCodes.js';
import { MoveRequestHoldingSchema, MoveRequestQuerySchema } from './schemas.js';
import { scopeContextOf, seal, tallyByCode } from './queries.js';
import {
  absorbUnknowns,
  boundsOf,
  makeUnknown,
  marginFrom,
  probeKickoff,
  speaksAt,
  unenforcedGoverningConstraints,
  unknownsFromCodes,
} from './verdict.js';

/* -------------------------------------------------------------------------- */
/* The classifier — the single producer of a class                            */
/* -------------------------------------------------------------------------- */

/**
 * **The only place a {@link MOVE_REQUEST_CLASS} is produced.**
 *
 * Three tests in one order, and the order is the design:
 *
 * 1. **A vacancy beats everything.** Ground nobody holds costs nobody anything,
 *    so a window with one is `vacancy_available` however many swaps also exist.
 * 2. **A free swap beats a costly one.** `free` is a property of the swap
 *    record, computed by {@link costOfSwap} from two judgements of the same
 *    counterparty, and never re-derived here.
 * 3. **Swaps that all cost something are `zero_sum_only`**, and the answer names
 *    what they cost and how many holders it costs it to.
 *
 * Otherwise there is nothing to offer. `infeasible` is a statement about the
 * **window asked about** — never about the season — and where a candidate could
 * not be judged the caller pairs it with `MOVE_REQUEST_CLASS_UNDER_UNKNOWN` and
 * an `unknown` verdict, because "we found nothing" and "we could not look" are
 * the two things this package exists not to confuse.
 *
 * @param {{ vacancies: ReadonlyArray<Object>, swaps: ReadonlyArray<{ free: boolean }> }} parts
 * @returns {{ classification: string, finding: import('./types.js').FeasibilityFinding }}
 */
export function classifyMoveRequest(parts) {
  if (!Array.isArray(parts?.vacancies) || !Array.isArray(parts?.swaps)) {
    throw new Error(
      'feasibility: classifyMoveRequest() needs { vacancies, swaps } as arrays; a class derived from an absent list is a class about nothing'
    );
  }
  for (const swap of parts.swaps) {
    if (typeof swap.free !== 'boolean') {
      throw new Error(
        `feasibility: every swap must state "free" as a boolean, not ${JSON.stringify(swap.free)}; a truthy check is how an unpriced swap becomes a free one`
      );
    }
  }
  const freeSwaps = parts.swaps.filter((swap) => swap.free === true).length;
  const classification =
    parts.vacancies.length > 0
      ? MOVE_REQUEST_CLASS.VACANCY_AVAILABLE
      : freeSwaps > 0
        ? MOVE_REQUEST_CLASS.FREE_SWAP_AVAILABLE
        : parts.swaps.length > 0
          ? MOVE_REQUEST_CLASS.ZERO_SUM_ONLY
          : MOVE_REQUEST_CLASS.INFEASIBLE;

  return {
    classification,
    finding: makeFeasibilityFinding(
      FEASIBILITY_REASON.MOVE_REQUEST_CLASS_REACHED,
      `class "${classification}" from ${parts.vacancies.length} vacancy(ies) and ${parts.swaps.length} admissible swap(s), ${freeSwaps} of them free`,
      {
        classification,
        vacancies: parts.vacancies.length,
        swaps: parts.swaps.length,
        freeSwaps,
        costlySwaps: parts.swaps.length - freeSwaps,
      }
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* The holder index                                                           */
/* -------------------------------------------------------------------------- */

/**
 * One holding, as a facility booking.
 *
 * @param {Object} holding
 * @returns {import('../facility/types.js').FacilityBooking}
 */
function bookingOf(holding) {
  return {
    id: holding.id,
    surfaceId: holding.surfaceId,
    date: holding.date,
    startMinutes: holding.startMinutes,
    endMinutes: holding.endMinutes,
    format: holding.format,
    label: holding.label ?? holding.id,
  };
}

/**
 * **Every thing standing on the club's ground, games and practices in one
 * index.**
 *
 * Games are enumerated from `context.state.gameIds` — the registry of what the
 * run holds — and practices from the caller's own list. Neither is derived from
 * the candidate grid or from the bookings a query builds, which is the rule a
 * whole review round was spent on: a holder dropped by a broken join must still
 * appear here, or `holdingsIndexed` would testify to the very set the break
 * corrupted.
 *
 * A duplicate id is `blocking` rather than a silent last-wins, because the index
 * is what occupancy, vacancy and every swap are read from: two holdings under
 * one key means one of them is invisible to all three.
 *
 * @param {import('../attribution/types.js').AttributionContext} context
 * @param {ReadonlyArray<Object>} practices - see `MoveRequestHoldingSchema`
 * @param {import('./types.js').FeasibilityMeta} meta
 * @param {import('./types.js').FeasibilityFinding[]} findings
 * @returns {{ byId: Map<string, Object>, all: Object[] }}
 */
function buildHoldingIndex(context, practices, meta, findings) {
  /** @type {Map<string, Object>} */
  const byId = new Map();
  /** @type {string[]} */
  const duplicated = [];

  /** @type {Map<string, string[]>} */
  const peopleByGameId = new Map();
  for (const commitment of context.schedule.commitments) {
    if (!commitment.gameId) continue;
    const bucket = peopleByGameId.get(commitment.gameId) ?? [];
    bucket.push(commitment.personId);
    peopleByGameId.set(commitment.gameId, bucket);
  }

  const add = (holding, kind) => {
    if (byId.has(holding.id)) {
      duplicated.push(holding.id);
      return;
    }
    byId.set(holding.id, Object.freeze({ ...holding, kind }));
    meta.holdingsIndexed += 1;
  };

  for (const gameId of context.state.gameIds) {
    const game = context.state.games[gameId];
    if (!game) continue;
    add(
      {
        id: game.id,
        date: game.date,
        surfaceId: game.surfaceId,
        startMinutes: game.startMinutes,
        endMinutes: game.endMinutes,
        format: game.format ?? null,
        teamIds: [game.homeTeamId, game.awayTeamId].filter(
          (team) => typeof team === 'string' && team.length > 0
        ),
        personIds: [...new Set(peopleByGameId.get(game.id) ?? [])].sort(),
        divisionLabel: game.divisionLabel ?? null,
        label: `${game.homeLabel} v ${game.awayLabel}`,
      },
      MOVE_REQUEST_ENTITY.GAME
    );
  }

  for (const raw of practices) {
    add(MoveRequestHoldingSchema.parse(raw), MOVE_REQUEST_ENTITY.PRACTICE);
  }

  if (duplicated.length > 0) {
    findings.push(
      makeFeasibilityFinding(
        FEASIBILITY_REASON.MOVE_REQUEST_HOLDING_DUPLICATED,
        `${duplicated.length} holding(s) share an id with one already indexed (${[...new Set(duplicated)].sort().join(', ')}), so occupancy, vacancy and every swap below were read from an index that is missing them`,
        { ids: [...new Set(duplicated)].sort(), indexed: meta.holdingsIndexed }
      )
    );
  }

  return { byId, all: [...byId.values()] };
}

/**
 * The commitments of the whole estate, one shape, games and practices.
 *
 * A game's commitments are `context.schedule.commitments`'s own rows — the
 * roster's answer, not a second derivation of it. A practice has no such rows in
 * Phase 8, so they are derived from the holding's own `personIds` by this one
 * producer; deriving them at each call site is how two callers end up disagreeing
 * about whether a practice has a venue.
 *
 * @param {import('../attribution/types.js').AttributionContext} context
 * @param {{ byId: Map<string, Object> }} holdings
 * @returns {{ rows: Object[], idsByHolding: Map<string, string[]> }}
 */
function commitmentsOf(context, holdings) {
  /** @type {Object[]} */
  const rows = [];
  /** @type {Map<string, string[]>} */
  const idsByHolding = new Map();
  const note = (holdingId, commitmentId) => {
    const bucket = idsByHolding.get(holdingId) ?? [];
    bucket.push(commitmentId);
    idsByHolding.set(holdingId, bucket);
  };

  for (const commitment of context.schedule.commitments) {
    rows.push({ ...commitment });
    if (commitment.gameId) note(commitment.gameId, commitment.id);
  }

  for (const holding of holdings.byId.values()) {
    if (holding.kind !== MOVE_REQUEST_ENTITY.PRACTICE) continue;
    // The venue is the graph's answer about the surface, never a field on the
    // holding: a caller-supplied venue could disagree with the graph, and the
    // travel model is entirely a statement about which venue a person is at.
    const venueId = venueIdOf(context, holding.surfaceId);
    if (venueId === null) continue;
    for (const personId of holding.personIds) {
      const id = `${holding.id}|${personId}`;
      rows.push({
        id,
        personId,
        date: holding.date,
        startMinutes: holding.startMinutes,
        endMinutes: holding.endMinutes,
        venueId,
        surfaceId: holding.surfaceId,
        teamId: holding.teamIds[0] ?? null,
        gameId: null,
        label: holding.label,
      });
      note(holding.id, id);
    }
  }

  return { rows, idsByHolding };
}

/* -------------------------------------------------------------------------- */
/* The judge — one function, both parties, both kinds                         */
/* -------------------------------------------------------------------------- */

/**
 * **Is this holding legal at this position, with these bookings lifted?**
 *
 * One judge, used for the subject at every candidate and for the counterparty at
 * the subject's own slot. `lift` is what makes a swap judgeable at all: both
 * parties vacate before either is placed, so neither is refused for standing in
 * the ground the other is about to leave.
 *
 * The legality is `checkKickoffAvailability()`'s, read under the registry by
 * `probeKickoff()` — this module compares no limits and parses no permits. The
 * binding set is built by `boundsOf()`, `feasibility/verdict.js`'s own, at the
 * position rather than one minute past it, because `types.js` says a constraint
 * binds at a *placement* when it speaks **at** it.
 *
 * @param {import('../attribution/types.js').AttributionContext} context
 * @param {Object} holding
 * @param {{ date: string, surfaceId: string, kickoffMinutes: number }} at
 * @param {{ lift: ReadonlyArray<string>, bookings: ReadonlyArray<Object> }} world
 * @param {import('./types.js').FeasibilityMeta} meta
 * @returns {{ verdict: string, tight: string|null, binding: import('./types.js').FeasibilityBound[], marginMinutes: number|null, marginBasis: string|null, findings: Array<{ code: string, severity: string }>, unknowns: import('./types.js').FeasibilityUnknown[], blocked: boolean, compromised: boolean, endMinutes: number|null }}
 */
function judgeLeg(context, holding, at, world, meta) {
  const lift = new Set(world.lift);
  const bookings = world.bookings.filter(
    (booking) => booking.date === at.date && !lift.has(booking.id)
  );
  const probe = probeKickoff(
    context.engines,
    {
      surfaceId: at.surfaceId,
      date: at.date,
      kickoffMinutes: at.kickoffMinutes,
      format: holding.format,
      ignoreBookingIds: [...lift],
      divisionLabel: holding.divisionLabel ?? null,
    },
    bookings,
    meta
  );
  const evidence = deriveFeasibilityEvidence(probe.findings);
  /** @type {import('./types.js').FeasibilityUnknown[]} */
  const unknowns = unknownsFromCodes(
    probe.findings,
    `"${holding.id}" at ${at.date} ${at.surfaceId} ${at.kickoffMinutes}`
  );
  // **Rule 4, on every leg — including a counterparty's.** A registry
  // constraint that governs this position and that no rule in the run enforces
  // turns a would-be `feasible` into `unknown` naming it. It lived in
  // `judgeCandidate()` for one draft, which asked it of the subject and never
  // of the party being asked to move: a swap could then be admitted as "legal
  // for both parties" with one side's governing constraints unasked, which is
  // the declared-is-not-enforced shape wearing a two-sided answer's clothes.
  // Asking it here, where a position is judged, is what makes the module
  // header's claim about this function true of every leg.
  absorbUnknowns(
    unknowns,
    unenforcedGoverningConstraints(
      context.verification,
      context.engines.registry,
      scopeContextOf(context.engines.graph, {
        date: at.date,
        surfaceId: at.surfaceId,
        venueId: venueIdOf(context, at.surfaceId),
        divisionLabel: holding.divisionLabel ?? null,
      }),
      meta
    )
  );
  const binding = boundsOf(
    context.engines,
    probe.result,
    speaksAt(FEASIBILITY_THRESHOLD.CLEAN, probe.findings)
  );
  const { marginMinutes, marginBasis } = marginFrom(binding);
  const verdict = deriveFeasibilityVerdict({ blocked: evidence.blocked, unknowns });
  return {
    verdict,
    tight: deriveFeasibilityTightness({
      verdict,
      compromised: evidence.compromised,
      cleanBoundaryExists: null,
    }),
    binding,
    marginMinutes,
    marginBasis,
    findings: probe.findings,
    unknowns,
    blocked: evidence.blocked,
    compromised: evidence.compromised,
    endMinutes: probe.result?.endMinutes ?? null,
  };
}

/**
 * Does this holding's own diary already have something in that window?
 *
 * The entity's **own commitments**, which the plan names beside travel and which
 * no per-placement check can see: a team or a coach standing somewhere else at
 * that hour is not a fact about the ground. `bookingsOverlapInTime()`'s `null`
 * is carried as an unknown and never as "no clash".
 *
 * @param {Object} subject
 * @param {ReadonlyArray<Object>} holdings
 * @param {{ date: string, startMinutes: number, endMinutes: number|null }} window
 * @param {ReadonlyArray<string>} lift
 * @param {import('./types.js').FeasibilityMeta} meta
 * @returns {{ clashes: string[], unknowns: import('./types.js').FeasibilityUnknown[] }}
 */
function ownCommitmentClash(subject, holdings, window, lift, meta) {
  const lifted = new Set(lift);
  const mine = new Set([...subject.teamIds, ...subject.personIds]);
  /** @type {string[]} */
  const clashes = [];
  /** @type {import('./types.js').FeasibilityUnknown[]} */
  const unknowns = [];
  if (mine.size === 0) return { clashes, unknowns };

  const candidate = {
    date: window.date,
    startMinutes: window.startMinutes,
    endMinutes: window.endMinutes,
  };
  for (const holding of holdings) {
    if (lifted.has(holding.id)) continue;
    if (holding.date !== window.date) continue;
    if (![...holding.teamIds, ...holding.personIds].some((entry) => mine.has(entry))) continue;
    meta.teamFixturesCompared += 1;
    const verdict = bookingsOverlapInTime(
      /** @type {import('../facility/types.js').FacilityBooking} */ (candidate),
      /** @type {import('../facility/types.js').FacilityBooking} */ (bookingOf(holding))
    );
    if (verdict === true) {
      clashes.push(holding.id);
      continue;
    }
    if (verdict === null) {
      unknowns.push(
        makeUnknown(
          FEASIBILITY_REASON.FEASIBILITY_FOOTPRINT_UNKNOWN,
          `whether "${subject.id}" and "${holding.id}" overlap on ${window.date}`,
          'one of the two has no known end (GAP-14), so the overlap could not be decided; a null from bookingsOverlapInTime() is not a "no clash"',
          { details: { holdingId: holding.id, date: window.date } }
        )
      );
    }
  }
  return { clashes, unknowns };
}

/* -------------------------------------------------------------------------- */
/* Travel, for a move that may have two sides                                 */
/* -------------------------------------------------------------------------- */

/**
 * **Coach travel under a move that may move two parties at once.**
 *
 * The same before/after discipline `queries.js`'s `projectTravel()` uses — two
 * evaluations of the same people over the same dates, and only the codes whose
 * count *grew* are reported — generalised from one relocation to a set of them,
 * because a swap moves both parties simultaneously and evaluating each half
 * against a world where the other has not moved yet reports transitions that
 * never happen. That generalisation is why this is not a call into
 * `projectTravel()`: one moving party is a special case of this function, and
 * `tests/moveRequestAnalysis.test.js` pins the two together on that case so the
 * pair cannot drift apart unnoticed.
 *
 * Without venue complexes this refuses to speak, exactly as `canGameMove()`
 * does: judging every pair of distinct venue names against the 60-minute floor
 * reports eighteen shortfalls where one is real.
 *
 * @param {import('../attribution/types.js').AttributionContext} context
 * @param {{ rows: Object[], idsByHolding: Map<string, string[]> }} commitments
 * @param {ReadonlyArray<{ holding: Object, to: { date: string, surfaceId: string, venueId: string|null, startMinutes: number } }>} moves
 * @param {Object|null} venueComplexes
 * @param {import('./types.js').FeasibilityMeta} meta
 * @returns {{ ok: boolean, introduced: Array<{ code: string, severity: string, message: string, personId: string|null }>, peopleCount: number }}
 */
function projectTravelForMoves(context, commitments, moves, venueComplexes, meta) {
  /** @type {Map<string, Object>} */
  const projectionById = new Map();
  /** @type {Set<string>} */
  const personIds = new Set();
  /** @type {Set<string>} */
  const dates = new Set();

  for (const move of moves) {
    dates.add(move.holding.date);
    dates.add(move.to.date);
    for (const commitmentId of commitments.idsByHolding.get(move.holding.id) ?? []) {
      projectionById.set(commitmentId, move.to);
    }
  }
  for (const row of commitments.rows) {
    if (projectionById.has(row.id)) personIds.add(row.personId);
  }
  if (personIds.size === 0) return { ok: true, introduced: [], peopleCount: 0 };
  if (venueComplexes === null) return { ok: false, introduced: [], peopleCount: personIds.size };

  const relevant = commitments.rows.filter(
    (row) => personIds.has(row.personId) && dates.has(row.date)
  );
  const projected = relevant.map((row) => {
    const to = projectionById.get(row.id);
    if (!to) return { ...row };
    const durationMinutes = row.endMinutes === null ? null : row.endMinutes - row.startMinutes;
    return {
      ...row,
      date: to.date,
      venueId: to.venueId ?? row.venueId,
      surfaceId: to.surfaceId,
      startMinutes: to.startMinutes,
      endMinutes: durationMinutes === null ? null : to.startMinutes + durationMinutes,
    };
  });

  const options = { registry: context.engines.registry, venueComplexes };
  const before = evaluateCoachTravel(relevant, options);
  const after = evaluateCoachTravel(projected, options);
  meta.travelTransitionsProjected += after.meta.transitionsExamined ?? 0;

  /** @type {Record<string, number>} */
  const budget = { ...tallyByCode(before.findings) };
  /** @type {Array<{ code: string, severity: string, message: string, personId: string|null }>} */
  const introduced = [];
  for (const finding of after.findings) {
    if ((budget[finding.code] ?? 0) > 0) {
      budget[finding.code] -= 1;
      continue;
    }
    if (finding.severity === CONSTRAINT_SEVERITY.INFO) continue;
    // **Whose day this is, by identity rather than by code.**
    // `evaluateCoachTravel()` returns each transition's findings by reference
    // in the flat list, so the owning transition — and therefore the person —
    // is found exactly; `queries.js` `projectTravel()` makes the same lookup
    // for the same reason, and warns that a code match would attach a
    // scan-level finding to whichever transition happened to share its code.
    //
    // A move-request exchange moves **two** parties at once, so "whose day got
    // worse" is a real question here in a way it is not for a one-sided move:
    // without it, a venue hop introduced for the *subject's* coach is charged
    // to the counterparty, and the club tells one family that another is
    // giving something up when it is not. A finding no transition owns keeps
    // `personId: null` and is charged to neither.
    const transition = after.transitions.find((entry) => entry.findings.includes(finding)) ?? null;
    introduced.push({
      code: String(finding.code),
      severity: String(finding.severity),
      message: String(finding.message),
      personId: transition === null ? null : String(transition.personId),
    });
  }
  return { ok: true, introduced, peopleCount: personIds.size };
}

/**
 * The people a holding commits, from the one commitment index.
 *
 * @param {{ rows: Object[], idsByHolding: Map<string, string[]> }} commitments
 * @param {Object} holding
 * @returns {Set<string>}
 */
function peopleOf(commitments, holding) {
  const ids = new Set(commitments.idsByHolding.get(holding.id) ?? []);
  /** @type {Set<string>} */
  const people = new Set();
  for (const row of commitments.rows) {
    if (ids.has(row.id)) people.add(row.personId);
  }
  return people;
}

/* -------------------------------------------------------------------------- */
/* The counterparty's cost                                                    */
/* -------------------------------------------------------------------------- */

/**
 * **What the other party currently satisfies and would lose.**
 *
 * Two judgements of the *same* counterparty in the *same* world — both parties
 * lifted, both times — one at the slot it holds and one at the subject's. What
 * it would lose is the codes above `info` that the second raises and the first
 * does not, plus the travel codes the exchange introduces **for its own
 * people**. Comparing against the counterparty's own standing position rather
 * than against nothing is what stops a party that already has a tight afternoon
 * being charged for it.
 *
 * **`travelIntroduced` is already filtered to this party when it arrives**, and
 * it must be. A move-request exchange moves two parties at once, so
 * `projectTravelForMoves()` returns the regressions of *both* — and charging
 * the whole list here made the subject's own coach's venue hop appear in the
 * counterparty's cost, dropping the class from `free_swap_available` to
 * `zero_sum_only` and naming the counterparty as the holder losing an
 * objective it never had. `judgeSwap()` partitions the list by the owning
 * transition's person before calling this.
 *
 * The **objective** is the constraint that claims the code, and it takes **two**
 * lookups because this corpus's registry answers in two ways. Facility and
 * availability codes are claimed through `registry.idsByReasonCode` and read by
 * `registryConstraintIdsFor()` — the one lookup `resolve/stages.js` already
 * uses, so the id an operator reads here is the id the solver would name. The
 * travel codes are claimed through the registry's **policies** instead, and
 * `registry.idsByReasonCode` holds none of the seven: asking only the first
 * lookup reported `coach-travel-between-venues` as an objective the registry
 * cannot name, when `waivers/coachTravel.js` names it in one call. So both
 * owners are asked, each for the codes it owns, and neither is re-implemented.
 *
 * A code **neither** claims is a real loss with no id; it is kept in `codes`,
 * reported as `MOVE_REQUEST_COST_UNCLAIMED`, and it still makes the swap
 * costly. Dropping it would turn a zero-sum swap into a free one.
 *
 * @param {Object} engines
 * @param {Record<string, string>} travelObjectiveByCode - `travelConstraintIdByCode()`'s map
 * @param {{ verdict: string, findings: ReadonlyArray<{ code: string, severity: string }> }} atSubjectSlot
 * @param {{ findings: ReadonlyArray<{ code: string, severity: string }> }} atOwnSlot
 * @param {ReadonlyArray<{ code: string, severity: string }>} travelIntroduced
 * @returns {import('./types.js').MoveRequestCost}
 */
function costOfSwap(engines, travelObjectiveByCode, atSubjectSlot, atOwnSlot, travelIntroduced) {
  const held = new Set(
    atOwnSlot.findings
      .filter((finding) => finding.severity !== CONSTRAINT_SEVERITY.INFO)
      .map((finding) => finding.code)
  );
  const lost = new Set(
    atSubjectSlot.findings
      .filter((finding) => finding.severity !== CONSTRAINT_SEVERITY.INFO)
      .filter((finding) => !held.has(finding.code))
      .map((finding) => finding.code)
  );
  for (const finding of travelIntroduced) lost.add(finding.code);

  const codes = [...lost].sort();
  /** @type {(code: string) => string[]} */
  const claimsOf = (code) => {
    const fromRegistry = registryConstraintIdsFor(engines.registry, [code]);
    if (fromRegistry.length > 0) return fromRegistry;
    const fromTravel = travelObjectiveByCode[code];
    return fromTravel ? [fromTravel] : [];
  };
  const objectives = [...new Set(codes.flatMap(claimsOf))].sort();
  const unclaimedCodes = codes.filter((code) => claimsOf(code).length === 0);
  return { free: codes.length === 0, codes, objectives, unclaimedCodes };
}

/* -------------------------------------------------------------------------- */
/* The query                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * **"What can the club offer this move request?"**
 *
 * @param {import('../attribution/types.js').AttributionContext} context
 * @param {Object} rawQuery - see `MoveRequestQuerySchema`
 * @param {{ venueComplexes?: Object|null, practices?: ReadonlyArray<Object> }} [options] -
 *   `practices` are the practice holdings this run should treat as standing on
 *   the ground; there is no practice engine in `packages/core` for the query to
 *   read them from, and inventing one here would be a second practice model.
 * @returns {import('./types.js').MoveRequestAnalysis}
 */
export function analyseMoveRequest(context, rawQuery, options = {}) {
  const query = MoveRequestQuerySchema.parse(rawQuery);
  const meta = createFeasibilityMeta();
  const venueComplexes = options.venueComplexes ?? null;
  /** @type {import('./types.js').FeasibilityFinding[]} */
  const findings = [];
  /** @type {import('./types.js').FeasibilityUnknown[]} */
  const unknowns = [];

  meta.questionsAsked += 1;

  const holdings = buildHoldingIndex(context, options.practices ?? [], meta, findings);
  const subject = holdings.byId.get(query.entityId) ?? null;

  /** @type {import('./types.js').FeasibilitySubject} */
  const feasibilitySubject = {
    gameId: subject?.kind === MOVE_REQUEST_ENTITY.GAME ? subject.id : null,
    teamId: subject?.teamIds?.[0] ?? null,
    surfaceId: subject?.surfaceId ?? null,
    venueId: subject
      ? (getSurface(
          /** @type {import('../facility/types.js').FacilityGraph} */ (context.engines.graph),
          subject.surfaceId
        )?.venueId ?? null)
      : null,
    date: subject?.date ?? null,
    kickoffMinutes: subject?.startMinutes ?? null,
    format: subject?.format ?? null,
  };

  /** @type {import('./types.js').MoveRequestAnalysis} */
  const answer = {
    question: FEASIBILITY_QUESTION.ANALYSE_MOVE_REQUEST,
    subject: feasibilitySubject,
    entityKind: query.entityKind,
    entityId: query.entityId,
    classification: MOVE_REQUEST_CLASS.INFEASIBLE,
    verdict: FEASIBILITY_VERDICT.UNKNOWN,
    tight: null,
    feasibleSlots: [],
    vacancies: [],
    swaps: [],
    zeroSum: { objectives: [], holderCount: 0 },
    counts: {
      candidatesOnGrid: 0,
      feasible: 0,
      infeasible: 0,
      undecidable: 0,
      occupied: 0,
      vacancies: 0,
      swapsAdmissible: 0,
      swapsFree: 0,
      swapsCostly: 0,
    },
    marginUnit: FEASIBILITY_MARGIN_UNIT,
    unknowns,
    findings,
    meta,
    status: '',
  };

  if (subject === null || subject.kind !== query.entityKind) {
    unknowns.push(
      makeUnknown(
        FEASIBILITY_REASON.MOVE_REQUEST_SUBJECT_UNKNOWN,
        `${query.entityKind} "${query.entityId}"`,
        subject === null
          ? `nothing this run holds is called "${query.entityId}"; the index carries ${meta.holdingsIndexed} holding(s), so there is no position to move from`
          : `"${query.entityId}" is a ${subject.kind} in this index and the question asked about a ${query.entityKind}; answering it as the other kind would be answering a different question`,
        {
          details: {
            entityId: query.entityId,
            entityKind: query.entityKind,
            indexed: meta.holdingsIndexed,
          },
        }
      )
    );
    findings.push(
      makeFeasibilityFinding(
        FEASIBILITY_REASON.MOVE_REQUEST_SUBJECT_UNKNOWN,
        `the question named ${query.entityKind} "${query.entityId}", which this index does not hold under that kind`,
        { entityId: query.entityId, entityKind: query.entityKind, indexed: meta.holdingsIndexed }
      )
    );
    meta.candidatesConsidered += 1;
    meta.candidatesAnswered += 1;
    return finishMoveRequest(answer, { blocked: false, compromised: false });
  }

  // **The verification channel, on exactly `canGameMove()`'s terms.** That
  // query does not re-run the standing rules against its counterfactual either
  // — `explainKickoffTime()`'s counterfactual claims are `checkPlacement()`'s,
  // which is the facility layer — so this answer carries the same unknown in
  // the same case and no other. Raising it unconditionally, which this module
  // did for one draft, made every answer `unknown` on the strength of a
  // difference that is not there, and an unknown nothing can clear is a
  // three-valued verdict collapsed to one.
  if (context.verification === null) {
    unknowns.push(
      makeUnknown(
        FEASIBILITY_REASON.FEASIBILITY_VERIFICATION_ABSENT,
        'the standing rules over every position in this window',
        'no standing-rule-engine run was supplied, so turnover floors, round-robin completeness and hosting balance were not asked about; a facility answer must not be read as a whole one',
        {}
      )
    );
  }
  if (subject.kind === MOVE_REQUEST_ENTITY.PRACTICE) {
    findings.push(
      makeFeasibilityFinding(
        FEASIBILITY_REASON.MOVE_REQUEST_LAYER_SILENT,
        'the standing rule engine run this context carries is over a fixture list — turnover floors, round-robin completeness, hosting balance — and none of those rules governs a practice, so its coverage says nothing about this subject; the silence is an inapplicability rather than a measurement nobody took',
        {
          entityId: subject.id,
          entityKind: subject.kind,
          layers: ['rule-engine'],
          verificationPresent: context.verification !== null,
        }
      )
    );
  }

  if (subject.format === null) {
    unknowns.push(
      makeUnknown(
        FEASIBILITY_REASON.FEASIBILITY_FORMAT_UNRESOLVED,
        `the format "${subject.id}" would play`,
        'this holding states no format, so no footprint can be taken and the capacity grid has no subject; state a format rather than having one picked',
        { details: { entityId: subject.id } }
      )
    );
    findings.push(
      makeFeasibilityFinding(
        FEASIBILITY_REASON.FEASIBILITY_FORMAT_UNRESOLVED,
        `"${subject.id}" states no format, so the window could not be gridded at all`,
        { entityId: subject.id }
      )
    );
    meta.candidatesConsidered += 1;
    meta.candidatesAnswered += 1;
    return finishMoveRequest(answer, { blocked: false, compromised: false });
  }

  // **Empty means "the ground this entity's own side already uses"**, derived
  // and reported, exactly as `TeamFeasibilityQuerySchema` says of its own — a
  // question about one fixture is not a question about the whole estate. The
  // entity's own surface is always in the set, so a first-season team with no
  // other commitment still has somewhere to be asked about, and the fallback
  // can never hand `buildReserveCapacityReport()` an empty surface list.
  const surfaceIds =
    query.surfaceIds.length > 0
      ? [...new Set(query.surfaceIds)].sort()
      : [
          ...new Set([
            subject.surfaceId,
            ...holdings.all
              .filter((holding) => holding.teamIds.some((team) => subject.teamIds.includes(team)))
              .map((holding) => holding.surfaceId),
          ]),
        ].sort();

  const commitments = commitmentsOf(context, holdings);
  const allBookings = holdings.all.map(bookingOf);
  // Which registry constraint claims each travel code — the waivers module's own
  // answer, resolved once for the whole query rather than per swap.
  const travelObjectiveByCode = travelConstraintIdByCode(context.engines.registry);

  /* -- the grid, from the capacity report -------------------------------- */
  const capacity = buildReserveCapacityReport(context.engines, {
    name: `move request for ${subject.kind} "${subject.id}"`,
    format: subject.format,
    dates: [...new Set(query.dates)].sort(),
    surfaceIds,
    cadenceMinutes: query.cadenceMinutes,
    earliestKickoffMinutes: query.earliestKickoffMinutes,
    latestKickoffMinutes: query.latestKickoffMinutes,
    requirement: {
      slots: 1,
      label: 'one slot for the entity asking to move',
      source: `feasibility/moveRequest.js for "${subject.id}"`,
    },
    reservedSlots: [],
    bookings: allBookings,
  });
  for (const finding of capacity.findings) {
    if (finding.severity === CONSTRAINT_SEVERITY.INFO) continue;
    findings.push(
      makeFeasibilityFinding(
        FEASIBILITY_REASON.MOVE_REQUEST_CAPACITY_IMPEACHED,
        `the capacity report this analysis joined to reports ${String(finding.code)} at ${String(finding.severity)}: ${String(finding.message)}`,
        {
          entityId: subject.id,
          sourceCode: String(finding.code),
          sourceSeverity: String(finding.severity),
          capacityStatus: capacity.status,
        }
      )
    );
  }

  /* -- every candidate the grid offers ----------------------------------- */
  /** @type {Set<string>} */
  const gridKeys = new Set();
  for (const dateRow of capacity.dates) {
    for (const surfaceRow of dateRow.bySurface) {
      for (const kickoffMinutes of surfaceRow.kickoffMinutes) {
        meta.capacitySlotsJoined += 1;
        meta.candidatesConsidered += 1;
        gridKeys.add(capacitySlotId(dateRow.date, surfaceRow.surfaceId, kickoffMinutes));
        const at = { date: dateRow.date, surfaceId: surfaceRow.surfaceId, kickoffMinutes };
        const slot = judgeCandidate(context, {
          subject,
          at,
          holdings,
          allBookings,
          commitments,
          venueComplexes,
          meta,
        });
        meta.candidatesAnswered += 1;
        answer.feasibleSlots.push(slot);
      }
    }
  }

  // **Ground the club holds inside this window that the grid does not offer.**
  // `reserve/capacity.js` reports the same thing about its own reservations as
  // `RESERVED_SLOT_OFF_GRID`, and it matters here for a reason that is this
  // module's own: the subject cannot be *placed* at a minute no candidate
  // stands on, so a holder sitting at one was never reachable as an exchange
  // at its own time, and an answer that said "no swap available" would be
  // describing the cadence rather than the season.
  //
  // **Holders the grid did reach by overlap are excluded, and the exclusion is
  // the point.** A holding at 09:30 on a 60-minute cadence overlaps the 09:00
  // candidate, becomes its occupant, and *is* considered for a swap there. The
  // first draft of this finding named it anyway and said "no swap with them
  // was considered", contradicting the swap for it one field away.
  const reachedAsOccupant = new Set(
    answer.feasibleSlots.flatMap((slot) => [...slot.occupantIds, ...slot.undecidableOccupantIds])
  );
  const windowDates = new Set(capacity.dates.map((dateRow) => dateRow.date));
  const windowSurfaces = new Set(surfaceIds);
  const offGrid = holdings.all.filter(
    (holding) =>
      holding.id !== subject.id &&
      windowDates.has(holding.date) &&
      windowSurfaces.has(holding.surfaceId) &&
      !reachedAsOccupant.has(holding.id) &&
      !gridKeys.has(capacitySlotId(holding.date, holding.surfaceId, holding.startMinutes))
  );
  if (offGrid.length > 0) {
    findings.push(
      makeFeasibilityFinding(
        FEASIBILITY_REASON.MOVE_REQUEST_OFF_CAPACITY_GRID,
        `${offGrid.length} holding(s) stand on this window's ground at a minute the capacity grid does not generate and overlap no candidate it does (${offGrid
          .map((holding) => holding.id)
          .sort()
          .join(
            ', '
          )}), so the ground they hold was never offered and no exchange with them was considered`,
        {
          entityId: subject.id,
          holdingIds: offGrid.map((holding) => holding.id).sort(),
          cadenceMinutes: query.cadenceMinutes,
          earliestKickoffMinutes: query.earliestKickoffMinutes,
        }
      )
    );
  }

  answer.counts.candidatesOnGrid = answer.feasibleSlots.length;
  for (const slot of answer.feasibleSlots) {
    if (slot.verdict === FEASIBILITY_VERDICT.FEASIBLE) answer.counts.feasible += 1;
    else if (slot.verdict === FEASIBILITY_VERDICT.INFEASIBLE) answer.counts.infeasible += 1;
    else answer.counts.undecidable += 1;
    if (slot.occupantIds.length > 0) answer.counts.occupied += 1;
    for (const entry of slot.unknowns) absorbUnknowns(unknowns, [entry]);
  }

  /* -- vacancies: feasible, and nobody holds them ------------------------ */
  //
  // **There is no third test for the undecidable occupants, and the reason is
  // that it could never fire.** Every entry of `undecidableOccupantIds` is put
  // there beside a verdict-bearing unknown — `MOVE_REQUEST_OCCUPANCY_UNDECIDABLE`
  // or `MOVE_REQUEST_HOLDING_SURFACE_UNKNOWN` — so such a slot is `unknown` and
  // the first test has already excluded it. One was written here, and
  // `tests/moveRequestAnalysis.test.js`'s break table found that removing it
  // changed no answer in the corpus: a guard nothing can make fire proves
  // nothing, which is `reserve/capacity.js`'s own conclusion about its ignore
  // list. The property it was meant to state is pinned as an invariant over
  // real answers instead — *no feasible slot has an undecidable occupant* —
  // where making the unknown non-verdict-bearing turns the test red.
  //
  // **And the subject's own position is not a vacancy.** `occupantsAt()` skips
  // the subject, so the slot it already stands on comes back feasible and
  // unoccupied — and a window that happens to contain it would otherwise
  // classify `vacancy_available`, the club answering *"yes, there is free
  // ground"* and offering the fixture the position it already holds. That is
  // `canGameMove()`'s no-op in a different shape, and it is reported the way
  // `canTeamPlay()` reports the same cell: as a fact, with
  // `FEASIBILITY_POSITION_ALREADY_HELD`, rather than as an offer.
  const heldSlotId = capacitySlotId(subject.date, subject.surfaceId, subject.startMinutes);
  const standingPosition = answer.feasibleSlots.find((slot) => slot.slotId === heldSlotId) ?? null;
  if (standingPosition !== null) {
    findings.push(
      makeFeasibilityFinding(
        FEASIBILITY_REASON.FEASIBILITY_POSITION_ALREADY_HELD,
        `the window includes the position "${subject.id}" already holds (${subject.date} ${subject.surfaceId} at minute ${subject.startMinutes}), which is reported as a candidate and is not offered as a vacancy`,
        {
          entityId: subject.id,
          slotId: heldSlotId,
          date: subject.date,
          surfaceId: subject.surfaceId,
          kickoffMinutes: subject.startMinutes,
        }
      )
    );
  }
  answer.vacancies = answer.feasibleSlots.filter(
    (slot) =>
      slot.verdict === FEASIBILITY_VERDICT.FEASIBLE &&
      slot.occupantIds.length === 0 &&
      slot.slotId !== heldSlotId
  );
  answer.counts.vacancies = answer.vacancies.length;

  /* -- swaps: legal for BOTH parties ------------------------------------- */
  for (const slot of answer.feasibleSlots) {
    if (slot.verdict !== FEASIBILITY_VERDICT.FEASIBLE) continue;
    if (slot.undecidableOccupantIds.length > 0) continue;
    if (slot.occupantIds.length !== 1) continue;
    const counterparty = holdings.byId.get(slot.occupantIds[0]);
    if (!counterparty) continue;
    const swap = judgeSwap(context, {
      subject,
      counterparty,
      slot,
      holdings,
      allBookings,
      commitments,
      venueComplexes,
      travelObjectiveByCode,
      meta,
    });
    if (swap === null) continue;
    answer.swaps.push(swap);
    for (const entry of swap.unknowns) absorbUnknowns(unknowns, [entry]);
    if (swap.cost.unclaimedCodes.length > 0) {
      findings.push(
        makeFeasibilityFinding(
          FEASIBILITY_REASON.MOVE_REQUEST_COST_UNCLAIMED,
          `swapping with "${counterparty.id}" costs it ${swap.cost.unclaimedCodes.join(', ')}, which no registry constraint claims, so the objective it would lose has no id — the loss is real and the registry cannot name it`,
          {
            entityId: subject.id,
            counterpartyId: counterparty.id,
            codes: [...swap.cost.unclaimedCodes],
            objectives: [...swap.cost.objectives],
          }
        )
      );
    }
    if (swap.unattributedTravelCodes.length > 0) {
      // A travel finding no transition owns names no person, so the exchange
      // cannot say whose day it worsens — and charging it to the counterparty
      // would name the wrong family. It is stated in this module's own
      // vocabulary instead, exactly as `canGameMove()` states the same class of
      // record, because it is evidence about the exchange that would otherwise
      // be visible nowhere.
      findings.push(
        makeFeasibilityFinding(
          FEASIBILITY_REASON.FEASIBILITY_EVIDENCE_UNCLAIMED,
          `exchanging "${subject.id}" with "${counterparty.id}" introduces ${swap.unattributedTravelCodes.join(', ')}; no coach transition owns it, so it names no person and is charged to neither party — it is stated here because it is a consequence of the exchange either way`,
          {
            entityId: subject.id,
            counterpartyId: counterparty.id,
            source: 'coach-travel',
            codes: [...swap.unattributedTravelCodes],
          }
        )
      );
    }
  }
  answer.counts.swapsAdmissible = answer.swaps.length;
  answer.counts.swapsFree = answer.swaps.filter((swap) => swap.free).length;
  answer.counts.swapsCostly = answer.swaps.length - answer.counts.swapsFree;

  /* -- what the club can say --------------------------------------------- */
  const classified = classifyMoveRequest({ vacancies: answer.vacancies, swaps: answer.swaps });
  answer.classification = classified.classification;
  findings.push(classified.finding);

  answer.zeroSum = zeroSumRollUp(answer.swaps);

  if (answer.classification === MOVE_REQUEST_CLASS.INFEASIBLE && answer.counts.undecidable > 0) {
    findings.push(
      makeFeasibilityFinding(
        FEASIBILITY_REASON.MOVE_REQUEST_CLASS_UNDER_UNKNOWN,
        `this window offers nothing, and ${answer.counts.undecidable} of its ${answer.counts.candidatesOnGrid} candidate position(s) could not be judged; "${MOVE_REQUEST_CLASS.INFEASIBLE}" is therefore a floor rather than a finding`,
        {
          entityId: subject.id,
          undecidable: answer.counts.undecidable,
          candidatesOnGrid: answer.counts.candidatesOnGrid,
        }
      )
    );
  }

  if (answer.counts.candidatesOnGrid === 0) {
    // **An empty search must never come back `feasible`.** The finding alone
    // was not enough: `seal()` derives the verdict from the blockers and the
    // `blocked` flag, both of which are empty here, so an unreachable window
    // sealed `feasible` / `clean` beside a `rejected` status — the falsely
    // perfect result in miniature. `canTeamPlay()` meets the same case with an
    // unknown and the comment *"the one thing it must never say is yes"*; this
    // is that unknown, in the same place, for the same reason.
    unknowns.push(
      makeUnknown(
        FEASIBILITY_REASON.FEASIBILITY_QUERY_VACUOUS,
        `every position "${subject.id}" could take in this window`,
        'the window produced no candidate position at all, so there is nothing this answer can be true of',
        { details: { entityId: subject.id } }
      )
    );
    findings.push(
      makeFeasibilityFinding(
        FEASIBILITY_REASON.FEASIBILITY_QUERY_VACUOUS,
        `the move request for "${subject.id}" produced no candidate position at all, so any answer it gave would be a statement about an empty search`,
        { entityId: subject.id, dates: query.dates.length, surfaces: surfaceIds.length }
      )
    );
  }

  return finishMoveRequest(answer, {
    // **The class is not the verdict, and neither derives from the other.**
    // `blocked` here is about the *subject's own window*: every position the
    // grid offered was judged and every one of them said no. A window whose
    // positions are merely all taken is not blocked — the ground is legal, it
    // is occupied — so occupancy reaches the class and never the verdict.
    blocked:
      answer.counts.candidatesOnGrid > 0 &&
      answer.counts.feasible === 0 &&
      answer.counts.undecidable === 0,
    compromised:
      answer.counts.feasible > 0 &&
      answer.feasibleSlots
        .filter((slot) => slot.verdict === FEASIBILITY_VERDICT.FEASIBLE)
        .every((slot) => slot.tight !== null && slot.tight !== FEASIBILITY_TIGHTNESS.CLEAN),
  });
}

/**
 * One candidate position, judged, with who stands on it.
 *
 * @param {import('../attribution/types.js').AttributionContext} context
 * @param {Object} work
 * @returns {import('./types.js').MoveRequestSlot}
 */
function judgeCandidate(context, work) {
  const { subject, at, holdings, allBookings, commitments, venueComplexes, meta } = work;
  const occupancy = occupantsAt(context, subject, at, holdings, meta);
  const lift = [subject.id, ...occupancy.occupantIds];
  const leg = judgeLeg(context, subject, at, { lift, bookings: allBookings }, meta);

  /** @type {import('./types.js').FeasibilityUnknown[]} */
  // Rule 4 arrives inside `leg.unknowns`; `judgeLeg()` asks it of every
  // position it judges, so the counterparty's leg cannot escape it.
  const slotUnknowns = [...leg.unknowns, ...occupancy.unknowns];
  const clash = ownCommitmentClash(
    subject,
    holdings.all,
    { date: at.date, startMinutes: at.kickoffMinutes, endMinutes: leg.endMinutes },
    lift,
    meta
  );
  absorbUnknowns(slotUnknowns, clash.unknowns);

  const travel = projectTravelForMoves(
    context,
    commitments,
    [
      {
        holding: subject,
        to: {
          date: at.date,
          surfaceId: at.surfaceId,
          venueId:
            getSurface(
              /** @type {import('../facility/types.js').FacilityGraph} */ (context.engines.graph),
              at.surfaceId
            )?.venueId ?? null,
          startMinutes: at.kickoffMinutes,
        },
      },
    ],
    venueComplexes,
    meta
  );
  if (!travel.ok) {
    absorbUnknowns(slotUnknowns, [
      makeUnknown(
        FEASIBILITY_REASON.FEASIBILITY_TRAVEL_ABSENT,
        `the day of the ${travel.peopleCount} person(s) on "${subject.id}"`,
        'no venue complexes were supplied, so coach travel could not be projected onto this position; judging every pair of distinct venue names against the 60-minute floor reports eighteen shortfalls where one is real, so this answer refuses to guess',
        { details: { peopleCount: travel.peopleCount } }
      ),
    ]);
  }

  // **Everything that decides this candidate, folded through one table.** The
  // clash records carry no reason code of this module's own, and that is
  // deliberate: `queries.js` wrote a `FEASIBILITY_TEAM_DOUBLE_BOOKED` claim for
  // exactly this fact in round seven and **withdrew** it in round eight because
  // the claim it built named a record the facility layer does not own. What
  // matters is that the reader can see the evidence, and here they can: every
  // clashing holding is named on the slot as `ownCommitmentClashIds`, beside
  // the verdict it decided, rather than being visible only inside this fold.
  const evidence = deriveFeasibilityEvidence([
    ...leg.findings,
    ...travel.introduced,
    ...clash.clashes.map(() => ({ severity: CONSTRAINT_SEVERITY.BLOCKING })),
  ]);
  const verdict = deriveFeasibilityVerdict({
    blocked: evidence.blocked,
    unknowns: slotUnknowns,
  });

  return {
    slotId: capacitySlotId(at.date, at.surfaceId, at.kickoffMinutes),
    date: at.date,
    surfaceId: at.surfaceId,
    kickoffMinutes: at.kickoffMinutes,
    endMinutes: leg.endMinutes,
    verdict,
    tight: deriveFeasibilityTightness({
      verdict,
      compromised: evidence.compromised,
      cleanBoundaryExists: null,
    }),
    binding: leg.binding,
    marginMinutes: leg.marginMinutes,
    marginBasis: leg.marginBasis,
    occupantIds: occupancy.occupantIds,
    undecidableOccupantIds: occupancy.undecidableOccupantIds,
    ownCommitmentClashIds: clash.clashes,
    travelCodes: travel.introduced.map((finding) => finding.code).sort(),
    unknowns: slotUnknowns,
  };
}

/**
 * Who stands on this candidate position?
 *
 * Surface relation is `surfacesConflict()`'s answer and time overlap is
 * `bookingsOverlapInTime()`'s; neither is re-derived here, and the latter's
 * `null` lands in `undecidableOccupantIds` rather than being read as an empty
 * field. A position with an undecidable occupant is never a vacancy.
 *
 * @param {import('../attribution/types.js').AttributionContext} context
 * @param {Object} subject
 * @param {{ date: string, surfaceId: string, kickoffMinutes: number }} at
 * @param {{ all: Object[] }} holdings
 * @param {import('./types.js').FeasibilityMeta} meta
 * @returns {{ occupantIds: string[], undecidableOccupantIds: string[], unknowns: import('./types.js').FeasibilityUnknown[] }}
 */
function occupantsAt(context, subject, at, holdings, meta) {
  /** @type {string[]} */
  const occupantIds = [];
  /** @type {string[]} */
  const undecidableOccupantIds = [];
  /** @type {import('./types.js').FeasibilityUnknown[]} */
  const unknowns = [];

  // **The candidate's footprint comes from the format**, through
  // `timing/formatTiming.js` — the same source `checkKickoffAvailability()`
  // sizes its own candidate from. Taking it from the subject's current
  // `endMinutes` instead was subtly wrong and produced the exact disagreement
  // this repository keeps paying for: an open-ended holding made *every*
  // overlap here undecidable while the probe one function away decided them
  // all from the format, so one half of the answer said "nobody knows who is
  // standing there" and the other half refused the position for a clash it had
  // measured. A format with no timing row (GAP-14) leaves the end `null` on
  // both sides, which is the case this is supposed to be about.
  const occupancyMinutes =
    formatTimingOrUnknown(
      /** @type {import('../timing/types.js').FormatTimingTable} */ (context.engines.table),
      subject.format
    )?.occupancyMinutes?.scheduled ?? null;
  const candidate = {
    date: at.date,
    startMinutes: at.kickoffMinutes,
    endMinutes: occupancyMinutes === null ? null : at.kickoffMinutes + occupancyMinutes,
  };

  for (const holding of holdings.all) {
    if (holding.id === subject.id) continue;
    if (holding.date !== at.date) continue;
    // **Guarded before the lookup, because the lookup throws.**
    // `surfacesConflict()` reaches `requireSurface()`, and a holding's surface
    // id came from data. Three modules have shipped that throw and each took
    // every other verdict in its run down with it
    // (`tests/unknownSurfaceDiscipline.test.js`). An unknown surface is carried
    // as *undecidable* rather than skipped: nobody can say it conflicts, and
    // nobody can say it does not, so the ground it might be on is never
    // offered as a vacancy.
    if (
      getSurface(
        /** @type {import('../facility/types.js').FacilityGraph} */ (context.engines.graph),
        holding.surfaceId
      ) === null
    ) {
      undecidableOccupantIds.push(holding.id);
      unknowns.push(
        makeUnknown(
          FEASIBILITY_REASON.MOVE_REQUEST_HOLDING_SURFACE_UNKNOWN,
          `whether "${holding.id}" stands on ground that conflicts with ${at.surfaceId}`,
          `"${holding.id}" stands on "${holding.surfaceId}", which the facility graph does not hold, so whether it overlaps this candidate could not be decided; it is neither counted as a holder nor treated as absent`,
          { details: { holdingId: holding.id, surfaceId: holding.surfaceId, date: at.date } }
        )
      );
      continue;
    }
    const relation = surfacesConflict(
      /** @type {import('../facility/types.js').FacilityGraph} */ (context.engines.graph),
      at.surfaceId,
      holding.surfaceId
    );
    if (!relation.conflict) continue;
    meta.occupancyPairsCompared += 1;
    const overlaps = bookingsOverlapInTime(
      /** @type {import('../facility/types.js').FacilityBooking} */ (candidate),
      /** @type {import('../facility/types.js').FacilityBooking} */ (bookingOf(holding))
    );
    if (overlaps === true) {
      occupantIds.push(holding.id);
      continue;
    }
    if (overlaps === null) {
      undecidableOccupantIds.push(holding.id);
      unknowns.push(
        makeUnknown(
          FEASIBILITY_REASON.MOVE_REQUEST_OCCUPANCY_UNDECIDABLE,
          `whether "${holding.id}" stands on ${at.surfaceId} at ${at.kickoffMinutes} on ${at.date}`,
          'one of the two footprints has no known end (GAP-14), so whether this ground is free could not be decided; an undecidable overlap is not an empty field and this position is never offered as a vacancy',
          { details: { holdingId: holding.id, surfaceId: at.surfaceId, date: at.date } }
        )
      );
    }
  }

  return {
    occupantIds: occupantIds.sort(),
    undecidableOccupantIds: undecidableOccupantIds.sort(),
    unknowns,
  };
}

/**
 * One two-sided exchange, judged for both parties and priced for the other one.
 *
 * Returns `null` when the counterparty is not legal at the subject's own slot —
 * an exchange that is illegal for the other party is not an offer the club can
 * make, and listing it as admissible-but-bad would be the club proposing
 * something it would have to refuse.
 *
 * @param {import('../attribution/types.js').AttributionContext} context
 * @param {Object} work
 * @returns {import('./types.js').MoveRequestSwap|null}
 */
function judgeSwap(context, work) {
  const { subject, counterparty, slot, holdings, allBookings, commitments, venueComplexes, meta } =
    work;
  meta.swapsConsidered += 1;
  const lift = [subject.id, counterparty.id];
  const subjectSlot = {
    date: subject.date,
    surfaceId: subject.surfaceId,
    kickoffMinutes: subject.startMinutes,
  };

  // The counterparty where the subject stands, and where it stands itself — the
  // same world both times, so the difference between them is the exchange and
  // nothing else.
  const counterAtSubject = judgeLeg(
    context,
    counterparty,
    subjectSlot,
    { lift, bookings: allBookings },
    meta
  );
  meta.swapLegsJudged += 1;
  const counterAtOwn = judgeLeg(
    context,
    counterparty,
    {
      date: counterparty.date,
      surfaceId: counterparty.surfaceId,
      kickoffMinutes: counterparty.startMinutes,
    },
    { lift, bookings: allBookings },
    meta
  );
  meta.swapLegsJudged += 1;

  if (counterAtSubject.verdict === FEASIBILITY_VERDICT.INFEASIBLE) return null;

  const counterClash = ownCommitmentClash(
    counterparty,
    holdings.all,
    {
      date: subjectSlot.date,
      startMinutes: subjectSlot.kickoffMinutes,
      endMinutes: counterAtSubject.endMinutes,
    },
    lift,
    meta
  );
  if (counterClash.clashes.length > 0) return null;

  const travel = projectTravelForMoves(
    context,
    commitments,
    [
      {
        holding: subject,
        to: {
          date: slot.date,
          surfaceId: slot.surfaceId,
          venueId: venueIdOf(context, slot.surfaceId),
          startMinutes: slot.kickoffMinutes,
        },
      },
      {
        holding: counterparty,
        to: {
          date: subjectSlot.date,
          surfaceId: subjectSlot.surfaceId,
          venueId: venueIdOf(context, subjectSlot.surfaceId),
          startMinutes: subjectSlot.kickoffMinutes,
        },
      },
    ],
    venueComplexes,
    meta
  );

  /** @type {import('./types.js').FeasibilityUnknown[]} */
  const swapUnknowns = absorbUnknowns([...counterAtSubject.unknowns], counterClash.unknowns);
  if (!travel.ok) {
    absorbUnknowns(swapUnknowns, [
      makeUnknown(
        FEASIBILITY_REASON.FEASIBILITY_TRAVEL_ABSENT,
        `the day of the ${travel.peopleCount} person(s) on the "${subject.id}" / "${counterparty.id}" exchange`,
        'no venue complexes were supplied, so coach travel could not be projected onto this exchange',
        { details: { peopleCount: travel.peopleCount } }
      ),
    ]);
  }

  // **Whose day got worse, partitioned before anything is priced.** The
  // projection above moved both parties, so its findings belong to both; only
  // the counterparty's reach the counterparty's cost. The subject's are carried
  // on the swap in their own field — they are a real consequence of the
  // exchange and the requesting family should see them — and a finding no
  // transition owns names no person, so it is charged to neither and published
  // as `FEASIBILITY_EVIDENCE_UNCLAIMED` rather than silently dropped.
  const counterpartyPeople = peopleOf(commitments, counterparty);
  const subjectPeople = peopleOf(commitments, subject);
  const counterpartyTravel = travel.introduced.filter(
    (finding) => finding.personId !== null && counterpartyPeople.has(finding.personId)
  );
  const subjectTravelCodes = [
    ...new Set(
      travel.introduced
        .filter((finding) => finding.personId !== null && subjectPeople.has(finding.personId))
        .map((finding) => finding.code)
    ),
  ].sort();
  const unattributedTravelCodes = [
    ...new Set(
      travel.introduced
        .filter((finding) => finding.personId === null)
        .map((finding) => finding.code)
    ),
  ].sort();

  const cost = costOfSwap(
    context.engines,
    work.travelObjectiveByCode,
    counterAtSubject,
    counterAtOwn,
    counterpartyTravel
  );

  return {
    slotId: slot.slotId,
    date: slot.date,
    surfaceId: slot.surfaceId,
    kickoffMinutes: slot.kickoffMinutes,
    counterpartyId: counterparty.id,
    counterpartyKind: counterparty.kind,
    subjectLeg: {
      verdict: slot.verdict,
      tight: slot.tight,
      binding: slot.binding,
      marginMinutes: slot.marginMinutes,
      marginBasis: slot.marginBasis,
    },
    counterpartyLeg: {
      verdict: counterAtSubject.verdict,
      tight: counterAtSubject.tight,
      binding: counterAtSubject.binding,
      marginMinutes: counterAtSubject.marginMinutes,
      marginBasis: counterAtSubject.marginBasis,
    },
    cost,
    free: cost.free,
    subjectTravelCodes,
    unattributedTravelCodes,
    unknowns: swapUnknowns,
  };
}

/**
 * The venue a surface stands at, from the graph and nowhere else.
 *
 * @param {import('../attribution/types.js').AttributionContext} context
 * @param {string} surfaceId
 * @returns {string|null}
 */
function venueIdOf(context, surfaceId) {
  return (
    getSurface(
      /** @type {import('../facility/types.js').FacilityGraph} */ (context.engines.graph),
      surfaceId
    )?.venueId ?? null
  );
}

/**
 * **What the zero-sum answer names: the objective, and how many holders rely on
 * it.**
 *
 * Grouped over the *costly* swaps only, because a free swap costs its
 * counterparty no objective and counting it here would inflate the number an
 * operator reads as "how many other families this affects". Each holder is
 * counted once per objective however many of its slots appear in the window.
 *
 * @param {ReadonlyArray<import('./types.js').MoveRequestSwap>} swaps
 * @returns {{ objectives: Array<{ objective: string, holderCount: number, holderIds: string[], codes: string[] }>, holderCount: number }}
 */
function zeroSumRollUp(swaps) {
  /** @type {Map<string, { holders: Set<string>, codes: Set<string> }>} */
  const byObjective = new Map();
  /** @type {Set<string>} */
  const holders = new Set();
  for (const swap of swaps) {
    if (swap.free) continue;
    holders.add(swap.counterpartyId);
    // A cost the registry cannot name is still a cost, and it is grouped under
    // its own code so that "every holder loses the same thing" stays sayable
    // when the thing has no constraint id.
    const objectives =
      swap.cost.objectives.length > 0
        ? swap.cost.objectives
        : swap.cost.codes.map((code) => `code:${code}`);
    for (const objective of objectives) {
      const bucket = byObjective.get(objective) ?? { holders: new Set(), codes: new Set() };
      bucket.holders.add(swap.counterpartyId);
      for (const code of swap.cost.codes) bucket.codes.add(code);
      byObjective.set(objective, bucket);
    }
  }
  return {
    objectives: [...byObjective.entries()]
      .map(([objective, bucket]) => ({
        objective,
        holderCount: bucket.holders.size,
        holderIds: [...bucket.holders].sort(),
        codes: [...bucket.codes].sort(),
      }))
      .sort((a, b) => b.holderCount - a.holderCount || a.objective.localeCompare(b.objective)),
    holderCount: holders.size,
  };
}

/**
 * Seal a move-request analysis through `queries.js`'s own sealer.
 *
 * The verdict, the tightness, the unknown-to-finding fold, the candidate ledger
 * and the status are all `seal()`'s, exactly as they are for `canTeamPlay()`'s
 * roll-up. Deriving them again here would be a third producer of a verdict in
 * one module.
 *
 * @param {import('./types.js').MoveRequestAnalysis} answer
 * @param {{ blocked: boolean, compromised: boolean }} state
 * @returns {import('./types.js').MoveRequestAnalysis}
 */
function finishMoveRequest(answer, state) {
  answer.meta.unknownsRaised += answer.unknowns.length;
  const rolled = seal(
    /** @type {import('./types.js').FeasibilityAnswer} */ ({
      question: answer.question,
      subject: answer.subject,
      verdict: FEASIBILITY_VERDICT.UNKNOWN,
      tight: null,
      binding: [],
      marginMinutes: null,
      marginUnit: FEASIBILITY_MARGIN_UNIT,
      marginBasis: null,
      blockers: [],
      unknowns: answer.unknowns,
      minimalSet: null,
      notApplicable: [],
      findings: answer.findings,
      meta: answer.meta,
      status: '',
    }),
    state
  );
  return {
    ...answer,
    verdict: rolled.verdict,
    tight: rolled.tight,
    findings: rolled.findings,
    status: rolled.status,
  };
}
