/**
 * **The read-only feasibility API** — Prompt 7.1.
 *
 * > *Can this game move to Thursday? Can this team play at 6pm in November?
 * > What is stopping it?*
 *
 * Three questions, one answer shape, and four properties that are the point of
 * the module rather than decoration on it:
 *
 * 1. **Strictly read-only.** Nothing here mutates an input, persists anything,
 *    or commits a re-solve. The one trial placement the answers need is derived
 *    inside `checkKickoffAvailability()` / `checkPlacement()` and thrown away
 *    with the call. `attribution/context.js` freezes every game in the state it
 *    builds and `applyMove()` — `resolve/`'s only writer — is called from
 *    nowhere in this package.
 * 2. **Every answer carries its binding constraint and a margin.** The binding
 *    *set*, because two constraints binding at the same minute is not one
 *    constraint binding, and a margin in minutes under one stated sign
 *    convention (`FEASIBILITY_MARGIN_CONVENTION`).
 * 3. **Three-valued, never two.** `feasible` / `infeasible` / `unknown`, from
 *    `deriveFeasibilityVerdict()`, which is the only producer of a verdict.
 * 4. **A query governed by an unenforced rule cannot be answered.**
 *    `unenforcedGoverningConstraints()` turns a would-be `feasible` into
 *    `unknown` naming the constraint. `coach-maximum-gap` is the live instance.
 *
 * ## What it composes, and what it adds
 *
 * | it needs | it asks |
 * | --- | --- |
 * | why this game is here, and what an alternative would break | `attribution/explain.js` — `explainGame()`, `explainKickoffTime()` |
 * | the smallest set of constraints that make a placement impossible | `attribution/minimal.js` — `minimalBlockingSet()`, certified |
 * | how late anything may kick off | `availability/kickoff.js` — `latestLegalKickoff()` |
 * | what a coach's day costs, through the venue-complex model | `waivers/coachTravel.js` — `evaluateCoachTravel()` |
 * | whether two fixtures overlap in time | `facility/occupancy.js` — `bookingsOverlapInTime()`, whose `null` is carried as `unknown` and never as "no clash" |
 * | what a softer constraint would change | `constraints/whatIf.js` — through `minimalBlockingSet()`, which projects rather than adopts |
 *
 * What it adds is the **second threshold**. The corpus states two 15-minute
 * numbers with different status — past a bound is `blocking`, inside a stated
 * comfort margin is `compromise` — so a bounded answer reports both: the last
 * position that is legal, and the last position that is legal *and* clean. The
 * band between them is where a schedule is defensible but uncomfortable, and
 * collapsing it was how an operator ended up deriving it by hand.
 *
 * @module feasibility/queries
 */

import { latestLegalKickoff } from '../availability/kickoff.js';
import {
  ATTRIBUTION_REASON,
  ATTRIBUTION_SEVERITY,
  ATTRIBUTION_SOURCE,
  createAttributionMeta,
} from '../attribution/reasonCodes.js';
import {
  categoryOnlyClaimFindings,
  claimFromAvailabilityConstraint,
  claimFromFinding,
  claimFromTravelTransition,
  groupFindingsByConstraintKind,
  mergeClaimsByTightness,
} from '../attribution/claims.js';
import { explainKickoffTime } from '../attribution/explain.js';
import { minimalBlockingSet } from '../attribution/minimal.js';
import { CONSTRAINT_SEVERITY } from '../constraints/reasonCodes.js';
import { bookingsOverlapInTime } from '../facility/occupancy.js';
import { getSurface } from '../facility/facilityGraph.js';
import { formatTimingOrUnknown } from '../timing/formatTiming.js';
import { evaluateCoachTravel } from '../waivers/coachTravel.js';

import {
  FEASIBILITY_QUESTION,
  FEASIBILITY_REASON,
  FEASIBILITY_THRESHOLD,
  FEASIBILITY_MARGIN_UNIT,
  FEASIBILITY_TIGHTNESS,
  FEASIBILITY_VERDICT,
  assertFeasibilityFindings,
  createFeasibilityMeta,
  deriveFeasibilityEvidence,
  deriveFeasibilityStatus,
  deriveFeasibilityTightness,
  deriveFeasibilityVerdict,
  makeFeasibilityFinding,
  mergeFeasibilityMeta,
} from './reasonCodes.js';
import {
  KickoffBoundsQuerySchema,
  MoveFeasibilityQuerySchema,
  TeamFeasibilityQuerySchema,
} from './schemas.js';
import {
  absorbUnknowns,
  assertBoundaryResult,
  bindingAt,
  blockingEvidenceOf,
  boundFindings,
  candidateAccountingFindings,
  makeUnknown,
  marginFrom,
  probeKickoff,
  speaksAt,
  standingBookings,
  underRegistry,
  unenforcedGoverningConstraints,
  unknownsFromCodes,
} from './verdict.js';

/**
 * One claim, as a bound.
 *
 * `raises` here is what the constraint *did* say about the position, at the
 * severity the registry gave it. Nothing is recomputed: the limit, the slack and
 * the severity are the claim's, which are the owning module's.
 *
 * @param {import('../attribution/types.js').ConstraintClaim} claim
 * @returns {import('./types.js').FeasibilityBound}
 */
function boundFromClaim(claim) {
  return {
    kind: claim.kind,
    source: claim.source,
    instanceId: claim.instanceId,
    constraintId: claim.constraintId,
    limitMinutes: claim.limitMinutes,
    slackMinutes: claim.slackMinutes,
    raises: claim.codes.map((code) => ({ code, severity: claim.severity })),
  };
}

/**
 * The claims that decided a placement.
 *
 * A blocking claim decided it; failing that, the claim(s) the owning machinery
 * marked `binding`. Both are read off what somebody else reported — this
 * function chooses between two already-computed lists and never ranks limits.
 *
 * Every member at the decisive level is kept, so a tie stays a tie.
 *
 * @param {ReadonlyArray<import('../attribution/types.js').ConstraintClaim>} claims
 * @returns {import('../attribution/types.js').ConstraintClaim[]}
 */
function decisiveClaims(claims) {
  const blocking = claims.filter((claim) => claim.severity === ATTRIBUTION_SEVERITY.BLOCKING);
  if (blocking.length > 0) return blocking;
  return claims.filter((claim) => claim.binding === true);
}

/**
 * Claim codes as finding-shaped rows, for the unknown table.
 *
 * @param {ReadonlyArray<import('../attribution/types.js').ConstraintClaim>} claims
 * @returns {Array<{ code: string, severity: string, message: string }>}
 */
function codeRowsOf(claims) {
  return claims.flatMap((claim) =>
    claim.codes.map((code) => ({ code, severity: claim.severity, message: claim.detail || code }))
  );
}

/**
 * The scope context a registry record is judged against, for one position.
 *
 * Exported **within the package only**, like {@link seal}: `moveRequest.js`
 * judges the same registry records against the same kind of position, and a
 * second scope builder would be free to disagree about which venue a surface
 * stands at — which is the one field the whole applicability answer turns on.
 *
 * @param {Object} graph
 * @param {{ date: string, surfaceId: string, venueId: string|null, divisionLabel?: string|null }} where
 * @returns {import('../constraints/types.js').ScopeContext}
 */
export function scopeContextOf(graph, where) {
  const surface = getSurface(
    /** @type {import('../facility/types.js').FacilityGraph} */ (graph),
    where.surfaceId
  );
  return {
    date: where.date,
    venueId: surface?.venueId ?? where.venueId ?? undefined,
    surfaceId: where.surfaceId,
    surfaceLineage: surface ? [...surface.lineage] : [where.surfaceId],
    ...(where.divisionLabel ? { divisionLabel: where.divisionLabel } : {}),
  };
}

/**
 * Count findings by code.
 *
 * Exported within the package only; `moveRequest.js` runs the same before/after
 * travel comparison over a two-sided move and needs the same tally.
 *
 * @param {ReadonlyArray<{ code: string }>} findings
 * @returns {Record<string, number>}
 */
export function tallyByCode(findings) {
  /** @type {Record<string, number>} */
  const byCode = {};
  for (const finding of findings) byCode[finding.code] = (byCode[finding.code] ?? 0) + 1;
  return byCode;
}

/**
 * **Coach travel, projected onto a hypothesis and compared with the baseline.**
 *
 * Two evaluations of the *same* people over the *same* dates — one as things
 * stand, one with the game moved — and only the codes whose count **grew** are
 * reported. Without the comparison, a coach who already has a tight afternoon
 * would make every proposed move look like the cause of it.
 *
 * Both runs go through `evaluateCoachTravel()` with the season's declared venue
 * complexes. Without them, that evaluator judges every pair of distinct venue
 * names against the 60-minute drive floor and reports eighteen shortfalls where
 * one is real (`docs/RULE_ENGINE.md` §9) — so a caller supplies the complexes or
 * gets `FEASIBILITY_TRAVEL_ABSENT` and an answer that admits it cannot speak
 * about coaches.
 *
 * The projection builds new commitment objects. Nothing on the schedule is
 * touched, and a commitment whose end is unknown (GAP-14) keeps its `null`
 * rather than acquiring an invented duration.
 *
 * @param {import('../attribution/types.js').AttributionContext} context
 * @param {{ gameId: string, from: Object, to: { date: string, surfaceId: string, startMinutes: number, venueId: string|null } }} move
 * @param {Object|null} venueComplexes
 * @param {import('./types.js').FeasibilityMeta} meta
 * @returns {{ ok: boolean, findings: Array<Object>, claims: Array<import('../attribution/types.js').ConstraintClaim>, unclaimed: Array<Object>, peopleCount: number }}
 */
function projectTravel(context, move, venueComplexes, meta) {
  const commitments = context.schedule.commitments;
  const personIds = new Set(
    commitments.filter((entry) => entry.gameId === move.gameId).map((entry) => entry.personId)
  );
  if (personIds.size === 0) {
    return { ok: true, findings: [], claims: [], unclaimed: [], peopleCount: 0 };
  }
  if (venueComplexes === null) {
    return { ok: false, findings: [], claims: [], unclaimed: [], peopleCount: personIds.size };
  }

  const dates = new Set([move.from.date, move.to.date]);
  const relevant = commitments.filter(
    (entry) => personIds.has(entry.personId) && dates.has(entry.date)
  );
  const projected = relevant.map((entry) => {
    if (entry.gameId !== move.gameId) return { ...entry };
    const durationMinutes =
      entry.endMinutes === null ? null : entry.endMinutes - entry.startMinutes;
    return {
      ...entry,
      date: move.to.date,
      venueId: move.to.venueId ?? entry.venueId,
      surfaceId: move.to.surfaceId,
      startMinutes: move.to.startMinutes,
      endMinutes: durationMinutes === null ? null : move.to.startMinutes + durationMinutes,
    };
  });

  const options = { registry: context.engines.registry, venueComplexes };
  const before = evaluateCoachTravel(relevant, options);
  const after = evaluateCoachTravel(projected, options);
  meta.travelTransitionsProjected += after.meta.transitionsExamined ?? 0;

  const beforeCounts = tallyByCode(before.findings);
  /** @type {Record<string, number>} */
  const budget = { ...beforeCounts };
  /** @type {Array<Object>} */
  const introduced = [];
  for (const finding of after.findings) {
    if ((budget[finding.code] ?? 0) > 0) {
      budget[finding.code] -= 1;
      continue;
    }
    if (finding.severity === CONSTRAINT_SEVERITY.INFO) continue;
    introduced.push(finding);
  }

  /** @type {Array<import('../attribution/types.js').ConstraintClaim>} */
  const claims = [];
  /** @type {Array<Object>} */
  const unclaimed = [];
  for (const finding of introduced) {
    // **Identity, never code.** `evaluateCoachTravel()` returns its transitions'
    // own findings by reference in the flat list, so the owning transition is
    // found exactly. Falling back to a code match would attach a scan-level
    // finding — one that belongs to no transition — to whichever transition
    // happened to share its code, and the claim would then name the wrong
    // person's afternoon.
    const transition = after.transitions.find((entry) => entry.findings.includes(finding)) ?? null;
    // **Dropped from the claims and returned, rather than dropped.** A finding
    // no transition owns names no record, so `claimFromFinding()` would build a
    // claim with `instanceId: null` and `constraintId: null` — the category-only
    // claim this module refuses. It still counts against the answer, so it is
    // handed back for the caller to publish in this module's own vocabulary;
    // returning it and returning nothing are the difference between an
    // unclaimable compromise and an invisible one.
    if (transition === null) {
      unclaimed.push(finding);
      continue;
    }
    claims.push(
      claimFromTravelTransition(
        transition,
        /** @type {import('../attribution/types.js').AttributionFinding} */ (finding)
      )
    );
  }

  return { ok: true, findings: introduced, claims, unclaimed, peopleCount: personIds.size };
}

/**
 * The empty answer, so every early return has the same shape as every late one.
 *
 * @param {string} question
 * @param {import('./types.js').FeasibilitySubject} subject
 * @param {import('./types.js').FeasibilityMeta} meta
 * @returns {import('./types.js').FeasibilityAnswer}
 */
function emptyAnswer(question, subject, meta) {
  return {
    question,
    subject,
    verdict: FEASIBILITY_VERDICT.UNKNOWN,
    tight: null,
    binding: [],
    marginMinutes: null,
    marginUnit: FEASIBILITY_MARGIN_UNIT,
    marginBasis: null,
    blockers: [],
    unknowns: [],
    minimalSet: null,
    notApplicable: [],
    findings: [],
    meta,
    status: '',
  };
}

/**
 * Seal an answer: derive the verdict once, in the one place that may.
 *
 * `tight` is `null` unless the verdict is `feasible`, because "not tight" is a
 * statement about a placement, and there is no placement to make it about when
 * the answer is `infeasible` or `unknown`. Where the verdict *is* `feasible` it
 * is one of {@link FEASIBILITY_TIGHTNESS}'s three named values, produced by
 * `deriveFeasibilityTightness()` and never here.
 *
 * **The evidence the answer publishes reaches its verdict and its tightness
 * here, and here only.** `deriveFeasibilityEvidence()` folds every claim in
 * `answer.blockers` through the frozen severity table, so a severity cannot
 * reach the list an operator reads without reaching the verdict derived beside
 * it. This ran twice as a fix at a call site before it was written as a rule:
 * once for `blocking` and once, nearly, for `compromise`. The `state` a caller
 * passes carries only the facts *no* blocker can express — "every cell of the
 * grid said no", "this date offers no boundary at all" — and is folded in
 * beside the published evidence rather than instead of it.
 *
 * Exported **within the package only** — it is deliberately absent from
 * `feasibility/index.js`. `canTeamPlay()` and `analyseMoveRequest()` both build
 * a synthetic {@link import('./types.js').FeasibilityAnswer} and pass it through
 * here rather than re-deriving a verdict, a tightness and a status beside it;
 * three sealers for one answer shape is the drift this repository has paid for
 * before. A caller outside the package has no `FeasibilityAnswer` to seal.
 *
 * This function reads the meta it is handed and never writes to it: the counter
 * it used to add to is shared with every nested answer that fed into this one,
 * and adding there counted the grid's unknowns once per cell and again in the
 * roll-up. Each level now counts what it raised, where it raised it.
 *
 * @param {import('./types.js').FeasibilityAnswer} answer
 * @param {{ blocked: boolean, compromised: boolean, cleanBoundaryExists?: boolean|null }} state
 * @returns {import('./types.js').FeasibilityAnswer}
 */
export function seal(answer, state) {
  const published = deriveFeasibilityEvidence(answer.blockers);
  const verdict = deriveFeasibilityVerdict({
    blocked: published.blocked || state.blocked,
    unknowns: answer.unknowns,
  });
  const tight = deriveFeasibilityTightness({
    verdict,
    compromised: published.compromised || state.compromised,
    cleanBoundaryExists: state.cleanBoundaryExists ?? null,
  });
  const findings = [...answer.findings];

  // **Every stated unknown reaches the findings list**, once per code, so an
  // answer's `status` can never read `allowed` while its `unknowns` are
  // non-empty. This is the seam the two channels meet at: `verdict` is about the
  // subject and `status` is about the answer, but "there is something I could
  // not check" is a fact about the answer as well, and an answer that hid it in
  // a field a caller might not read would be a thin explanation wearing a
  // complete one's clothes.
  const already = new Set(findings.map((finding) => finding.code));
  for (const entry of answer.unknowns) {
    if (already.has(entry.code)) continue;
    already.add(entry.code);
    const sameCode = answer.unknowns.filter((other) => other.code === entry.code);
    findings.push(
      makeFeasibilityFinding(
        entry.code,
        `${sameCode.length} question(s) this answer depends on could not be decided (${sameCode.map((other) => other.subject).join('; ')}): ${entry.reason}`,
        {
          question: answer.question,
          count: sameCode.length,
          verdictBearing: sameCode.some((other) => other.verdictBearing !== false),
          constraintIds: sameCode.map((other) => other.constraintId).filter(Boolean),
        }
      )
    );
  }
  if (tight === FEASIBILITY_TIGHTNESS.TIGHT) {
    findings.push(
      makeFeasibilityFinding(
        FEASIBILITY_REASON.FEASIBILITY_TIGHT,
        'this position is legal but sits inside a stated comfort margin; it is feasible and it is not clean',
        { question: answer.question, marginMinutes: answer.marginMinutes }
      )
    );
  }
  if (tight === FEASIBILITY_TIGHTNESS.NO_CLEAN_POSITION) {
    findings.push(
      makeFeasibilityFinding(
        FEASIBILITY_REASON.FEASIBILITY_NO_CLEAN_POSITION,
        'this bound is legal and there is no clean position beneath it at all: every kickoff it admits raises something above info, so there is no uncompromised time to move to',
        { question: answer.question, marginMinutes: answer.marginMinutes }
      )
    );
  }
  // **The candidate ledger, on every shape.** `types.js` requires
  // `candidatesAnswered` to equal `candidatesConsidered`; this is where that
  // stops being a docstring. It runs from `seal()` rather than from any one
  // query so a future early return cannot escape it the way the unknown-game
  // one did.
  findings.push(...candidateAccountingFindings(answer.meta, { question: answer.question }));
  findings.push(
    makeFeasibilityFinding(
      FEASIBILITY_REASON.FEASIBILITY_VERDICT_REACHED,
      `verdict "${verdict}" from ${answer.meta.candidatesAnswered} candidate answer(s), ${answer.binding.length} binding constraint(s) and ${answer.unknowns.length} stated unknown(s)`,
      {
        question: answer.question,
        verdict,
        tight,
        bindingKinds: answer.binding.map((bound) => bound.kind),
        unknownCodes: answer.unknowns.map((entry) => entry.code),
        marginMinutes: answer.marginMinutes,
        marginUnit: answer.marginUnit,
      }
    )
  );
  // **Nothing leaves here carrying a code this module cannot look up.** A
  // finding forwarded in from another module keeps that module's vocabulary,
  // and `feasibilitySeverityOf()` throws on it — at the call site of whoever
  // reads the answer rather than here, which is the worst place for it to
  // happen. One funnel, checked once, over every answer of every shape.
  assertFeasibilityFindings(findings, `the "${answer.question}" answer`);
  return { ...answer, verdict, tight, findings, status: deriveFeasibilityStatus(findings) };
}

/* -------------------------------------------------------------------------- */
/* 1. Can this game move?                                                      */
/* -------------------------------------------------------------------------- */

/**
 * **"Can this game move to Thursday? To 6pm? To that field?"**
 *
 * The whole legality answer is `explainKickoffTime()`'s, which is
 * `checkPlacement()`'s, which is Phase 1.3's. This adds the verdict, the
 * unknowns, the binding set, the margin, and — when the answer is no — the
 * certified minimal blocking set, so the reply is *"no, because these two
 * constraints, by this many minutes"* rather than *"no"*.
 *
 * @param {import('../attribution/types.js').AttributionContext} context
 * @param {Object} rawQuery - see `MoveFeasibilityQuerySchema`
 * @param {{ venueComplexes?: Object|null, minimalSet?: boolean, standingPositionIsAnAnswer?: boolean }} [options] -
 *   `standingPositionIsAnAnswer` says the caller is asking whether the position
 *   is legal rather than whether the game may move to it, so naming the slot the
 *   game already holds is answered from the standing schedule instead of being
 *   refused as a comparison between a thing and itself. `canTeamPlay()` is the
 *   caller that needs it; the move question does not.
 * @returns {import('./types.js').FeasibilityAnswer}
 */
export function canGameMove(context, rawQuery, options = {}) {
  const query = MoveFeasibilityQuerySchema.parse(rawQuery);
  const meta = createFeasibilityMeta();
  const venueComplexes = options.venueComplexes ?? null;
  const game = context.state.baseline[query.gameId] ?? null;

  meta.questionsAsked += 1;
  meta.candidatesConsidered += 1;

  // **One surface, resolved once.** The subject describes the position the
  // question is about, which is the *destination* — so its venue is the
  // destination surface's venue. Reading it off the game instead paired a
  // riverbend pitch with `summit-hs`, in the field an operator reads first.
  const destinationSurfaceId = query.insteadOfSurfaceId ?? game?.surfaceId ?? null;
  const destinationSurface =
    destinationSurfaceId === null
      ? null
      : getSurface(
          /** @type {import('../facility/types.js').FacilityGraph} */ (context.engines.graph),
          destinationSurfaceId
        );

  /** @type {import('./types.js').FeasibilitySubject} */
  const subject = {
    gameId: query.gameId,
    teamId: null,
    surfaceId: destinationSurfaceId,
    venueId: destinationSurface?.venueId ?? null,
    date: query.insteadOfDate ?? game?.date ?? null,
    kickoffMinutes: query.insteadOfMinutes ?? game?.startMinutes ?? null,
    format: game?.format ?? null,
  };

  const answer = emptyAnswer(FEASIBILITY_QUESTION.CAN_GAME_MOVE, subject, meta);

  /**
   * Seal this answer, counting the unknowns it raised **once**, here, where
   * they were raised. `seal()` used to add them to a meta it did not own, which
   * counted a grid cell's unknowns again in the roll-up that absorbed them.
   *
   * @param {{ blocked: boolean, compromised: boolean }} state
   * @returns {import('./types.js').FeasibilityAnswer}
   */
  const finish = (state) => {
    meta.unknownsRaised += answer.unknowns.length;
    return seal(answer, state);
  };

  if (game === null) {
    answer.unknowns.push(
      makeUnknown(
        FEASIBILITY_REASON.FEASIBILITY_SUBJECT_UNKNOWN,
        `game "${query.gameId}"`,
        `no game "${query.gameId}" is in this schedule, so there is nothing to move; the run holds ${context.state.gameIds.length} games`,
        { details: { gameId: query.gameId, gameCount: context.state.gameIds.length } }
      )
    );
    answer.findings.push(
      makeFeasibilityFinding(
        FEASIBILITY_REASON.FEASIBILITY_SUBJECT_UNKNOWN,
        `the question named game "${query.gameId}", which this run does not hold`,
        { gameId: query.gameId }
      )
    );
    // **The candidate was answered — with `unknown`, and with a reason.** That
    // is what a three-valued verdict is for, and it is the difference between
    // a good answer to a bad question and a dropped candidate. Leaving the
    // counter behind made the ledger `types.js` requires read 1 considered / 0
    // answered on every such call, with nothing saying so.
    meta.candidatesAnswered += 1;
    return finish({ blocked: false, compromised: false });
  }

  const destination = {
    date: query.insteadOfDate ?? game.date,
    surfaceId: /** @type {string} */ (destinationSurfaceId),
    startMinutes: query.insteadOfMinutes ?? game.startMinutes,
  };

  const time = explainKickoffTime(context, {
    gameId: query.gameId,
    insteadOfMinutes: destination.startMinutes,
    insteadOfSurfaceId: destination.surfaceId,
    insteadOfDate: destination.date,
  });
  mergeMetaFromAttribution(meta, time.meta);

  const noOp = time.findings.some(
    (finding) => finding.code === ATTRIBUTION_REASON.ATTRIBUTION_ALTERNATIVE_NO_OP
  );
  // **A no-op is vacuous for the move question and not for the team one.**
  // *"Can this game move to the slot it is in?"* compares a thing with itself.
  // *"Can this team play where it already plays?"* does not — it has an obvious
  // true answer, and the standing schedule is where that answer lives. So the
  // caller says which question it is asking, and only the second reads
  // `time.current`: the game at the position it holds, as `explainGame()`
  // already judged it. Nothing is re-derived and no hypothesis is invented.
  const standingPosition = noOp && options.standingPositionIsAnAnswer === true;
  if (noOp && !standingPosition) {
    answer.unknowns.push(
      makeUnknown(
        FEASIBILITY_REASON.FEASIBILITY_MOVE_IS_NO_OP,
        `game "${query.gameId}" moving to the slot it already holds`,
        'the destination asked about is the position the game already occupies, so the comparison is between a thing and itself and its empty answer means nothing',
        { details: { ...destination } }
      )
    );
    answer.findings.push(
      makeFeasibilityFinding(
        FEASIBILITY_REASON.FEASIBILITY_MOVE_IS_NO_OP,
        `the destination asked about for game "${query.gameId}" is the slot it already holds`,
        { gameId: query.gameId, ...destination }
      )
    );
    meta.candidatesAnswered += 1;
    return finish({ blocked: false, compromised: false });
  }
  if (standingPosition) {
    answer.findings.push(
      makeFeasibilityFinding(
        FEASIBILITY_REASON.FEASIBILITY_POSITION_ALREADY_HELD,
        `the position asked about is the one game "${query.gameId}" already holds, so this answer is the standing schedule's own rather than a hypothesis`,
        { gameId: query.gameId, ...destination }
      )
    );
  }

  const counterfactual = standingPosition ? time.current : time.counterfactual;
  // `claimsCarried` is already fed by `mergeMetaFromAttribution()` above, from
  // `explainKickoffTime()`'s own `claimsBuilt`. Counting them a second time here
  // would make the counter that proves this answer looked at something say twice
  // what it looked at.
  meta.candidatesAnswered += 1;

  /** @type {import('../attribution/types.js').ConstraintClaim[]} */
  let blockers = [...counterfactual.claims];
  // **Nothing decides this answer that the answer does not publish.**
  // `counterfactual.legal` and `counterfactual.placementStatus` are
  // `checkPlacement()`'s two flags, and reading them here is what let the
  // verdict and the tightness disagree with the blockers twice over: the
  // flags are the *facility* layer's, while `blockers` is the merged list
  // `explainGame()` folds the rule engine into and coach travel adds to below.
  // Both facts are published as claims before they are derived from — every
  // position this corpus's facility layer calls illegal carries a blocking
  // claim, and every one it calls compromised carries a compromise claim — so
  // `seal()` derives them off the published list and the two channels of one
  // answer can no longer contradict each other.
  /** @type {Array<{ severity: string, source: string, codes: string[] }>} */
  const travelFindings = [];

  /* -- unknowns ---------------------------------------------------------- */
  absorbUnknowns(
    answer.unknowns,
    unknownsFromCodes(
      codeRowsOf(counterfactual.claims),
      `game "${query.gameId}" at the destination`
    )
  );
  absorbUnknowns(
    answer.unknowns,
    unenforcedGoverningConstraints(
      context.verification,
      context.engines.registry,
      scopeContextOf(context.engines.graph, {
        date: destination.date,
        surfaceId: destination.surfaceId,
        venueId: destinationSurface?.venueId ?? game.venueId,
        divisionLabel: game.divisionLabel ?? null,
      }),
      meta
    )
  );
  if (context.verification === null) {
    answer.unknowns.push(
      makeUnknown(
        FEASIBILITY_REASON.FEASIBILITY_VERIFICATION_ABSENT,
        'the standing rules over this destination',
        'no standing-rule-engine run was supplied, so turnover floors, round-robin completeness and hosting balance were not asked about; a facility answer must not be read as a whole one',
        {}
      )
    );
  }

  /* -- coach travel, through the venue-complex model ---------------------- */
  const travel = projectTravel(
    context,
    {
      gameId: query.gameId,
      from: { date: game.date },
      to: { ...destination, venueId: destinationSurface?.venueId ?? null },
    },
    venueComplexes,
    meta
  );
  if (!travel.ok) {
    answer.unknowns.push(
      makeUnknown(
        FEASIBILITY_REASON.FEASIBILITY_TRAVEL_ABSENT,
        `the day of the ${travel.peopleCount} coach(es) on game "${query.gameId}"`,
        'no venue complexes were supplied, so coach travel could not be projected onto this move; judging every pair of distinct venue names against the 60-minute floor reports eighteen shortfalls where one is real, so this answer refuses to guess',
        { details: { peopleCount: travel.peopleCount } }
      )
    );
  } else if (travel.claims.length > 0 || travel.findings.length > 0) {
    blockers = mergeClaimsByTightness([blockers, travel.claims]);
    meta.claimsCarried += travel.claims.length;
    // Every introduced travel finding this corpus produces is owned by a
    // transition and therefore becomes one of the claims merged above, so this
    // list is the same evidence twice on every path the season exercises. It is
    // carried anyway, and through the same table rather than through a pair of
    // severity tests written out here, because `projectTravel()` drops a
    // finding no transition owns and an unclaimed blocker must not become an
    // unnoticed one.
    //
    // Each is carried as a **source-bearing record**, in the shape a claim
    // publishes, so the list that decides the verdict is also a list the answer
    // can name its sources from. Carrying bare findings here is what let
    // `FEASIBILITY_BLOCKED_OUTSIDE_FACILITY` say "what blocks it is stated in
    // the blockers" about something the blockers do not state: the fold read
    // this list and the sentence read only `blockers`.
    travelFindings.push(
      ...travel.findings.map((finding) => ({
        severity: String(finding.severity),
        source: ATTRIBUTION_SOURCE.COACH_TRAVEL,
        codes: [String(finding.code)],
      }))
    );
    // **And the ones that decide this answer and can never be claims are said
    // out loud.** `projectTravel()` is right to drop a finding no transition
    // owns — a claim built from one names no instance and no constraint, which
    // is the category-only claim `FEASIBILITY_CLAIM_CATEGORY_ONLY` exists to
    // refuse — but the record reaches `deriveFeasibilityEvidence()` through the
    // list above all the same. On 546 cells of this corpus's team grids that
    // made the difference between `clean` and `tight` while every published
    // blocker was `info`: the tightness was decided by evidence the reader had
    // no way to see. It is published here in this module's own vocabulary,
    // naming the code, the severity and the source that decided, and claiming
    // nothing about a record — the honest half of what the refused claim would
    // have said.
    answer.findings.push(
      ...travel.unclaimed.map((finding) =>
        makeFeasibilityFinding(
          FEASIBILITY_REASON.FEASIBILITY_EVIDENCE_UNCLAIMED,
          `moving game "${query.gameId}" here introduces ${String(finding.code)} at ${String(finding.severity)} ("${String(finding.message)}"); no coach transition owns it, so it names no record and cannot be published as a claim — it is stated here because it decides this answer either way`,
          {
            gameId: query.gameId,
            ...destination,
            source: ATTRIBUTION_SOURCE.COACH_TRAVEL,
            sourceCode: String(finding.code),
            sourceSeverity: String(finding.severity),
          }
        )
      )
    );
    absorbUnknowns(
      answer.unknowns,
      unknownsFromCodes(
        travel.findings.map((finding) => ({
          code: finding.code,
          severity: finding.severity,
          message: finding.message,
        })),
        `coach travel around game "${query.gameId}"`
      )
    );
  }

  /* -- the binding set and the margin ------------------------------------ */
  const binding = decisiveClaims(blockers).map(boundFromClaim);
  const { marginMinutes, marginBasis } = marginFrom(binding);
  answer.binding = binding;
  answer.marginMinutes = marginMinutes;
  answer.marginBasis = marginBasis;
  answer.blockers = blockers;
  // The destination's *inapplicable* constraints — "the field is lit, so sunset
  // does not bound it" — are the difference between a rule that did not apply
  // and a rule nobody checked, and `explainKickoffTime()` reports them for the
  // slot the game **has** rather than the one it does not. One more read of the
  // same function `checkPlacement()` calls, over the same inputs, rather than a
  // second derivation of the same fact.
  const destinationProbe = probeKickoff(
    context.engines,
    {
      surfaceId: destination.surfaceId,
      date: destination.date,
      kickoffMinutes: destination.startMinutes,
      format: game.format,
      ignoreBookingIds: [query.gameId],
      divisionLabel: game.divisionLabel ?? null,
    },
    standingBookings(context.state, destination.date, [query.gameId]),
    meta
  );
  answer.notApplicable = (destinationProbe.result.constraints ?? [])
    .filter((constraint) => !constraint.applicable)
    .map((constraint) => ({
      source: ATTRIBUTION_SOURCE.AVAILABILITY,
      kind: constraint.kind,
      reason: String(constraint.detail?.reason ?? 'the machinery that owns it stated no reason'),
    }));
  answer.findings.push(
    ...boundFindings(binding, marginMinutes, {
      gameId: query.gameId,
      date: destination.date,
      surfaceId: destination.surfaceId,
      kickoffMinutes: destination.startMinutes,
    })
  );

  /* -- what is stopping it ------------------------------------------------ */
  // The same fold `seal()` runs, run here as well because the minimal blocking
  // set is only worth asking for when the answer is blocked. One function and
  // one severity table, at both points.
  const decisive = [...blockers, ...travelFindings];
  const evidence = deriveFeasibilityEvidence(decisive);
  if (evidence.blocked && options.minimalSet !== false) {
    const minimal = minimalBlockingSet(context, { gameId: query.gameId, slot: destination });
    answer.minimalSet = minimal;
    mergeMetaFromAttribution(meta, minimal.meta);
    // **A denial has to say what it is a denial about.** `minimalBlockingSet()`
    // is the certified *facility-layer* answer, so a position the rule engine
    // or coach travel blocked comes back `blocked: false` carrying
    // `ATTRIBUTION_PLACEMENT_NOT_BLOCKED` — "no set of constraints blocks it"
    // beside "infeasible", in one answer. Suppressing the call would hide that
    // a blocked answer has no facility explanation, which is worth saying; so
    // the information stays and the denial is qualified with the layers that
    // did block it, read off the claims this answer publishes.
    if (minimal.blocked === false) {
      // **Named from the list the verdict was derived from, not from a subset
      // of it.** `blockingEvidenceOf()` reads `decisive`, which is what
      // `deriveFeasibilityEvidence()` above read, so this finding cannot be
      // reached with nothing to name: `evidence.blocked` is true exactly when
      // that list holds a `blocking` record, and every such record carries a
      // source and its codes. The old sentence's "stated in the blockers"
      // fallback described a case the blockers could not describe, and is gone
      // with the case.
      const decided = blockingEvidenceOf(decisive);
      answer.findings.push(
        makeFeasibilityFinding(
          FEASIBILITY_REASON.FEASIBILITY_BLOCKED_OUTSIDE_FACILITY,
          `the facility layer did not block game "${query.gameId}" at this position, so the minimal blocking set is that layer's answer and not this one's; what blocks it is ${decided.sources.join(', ')} (${decided.codes.join(', ')})`,
          {
            gameId: query.gameId,
            ...destination,
            sources: decided.sources,
            codes: decided.codes,
          }
        )
      );
    }
  }

  return finish(evidence);
}

/**
 * Fold an `attribution/` meta into a feasibility one.
 *
 * The two vocabularies overlap on exactly the counters that mean the same thing,
 * and the fold is written out rather than done by key so a counter added to
 * either module cannot start silently summing into the other.
 *
 * @param {import('./types.js').FeasibilityMeta} target
 * @param {import('../attribution/types.js').AttributionMeta} source
 * @returns {import('./types.js').FeasibilityMeta}
 */
function mergeMetaFromAttribution(target, source) {
  target.placementChecksRun += source.placementChecksRun ?? 0;
  target.constraintsConsulted += source.availabilityConstraintsConsulted ?? 0;
  target.claimsCarried += source.claimsBuilt ?? 0;
  target.boundaryProbesRun += source.boundaryQueriesRun ?? 0;
  return target;
}

/* -------------------------------------------------------------------------- */
/* 2. Can this team play at that time?                                         */
/* -------------------------------------------------------------------------- */

/**
 * **"Can this team play at 6pm in November?"**
 *
 * Asked as a grid: every date crossed with every candidate surface, each cell
 * carrying its own verdict, binding set and margin. **No cell is ever dropped**
 * — incident 10's rule applied to a query — and a cell that could not be judged
 * is `unknown` with a reason rather than absent.
 *
 * The hypothesis is carried by one of the team's own fixtures, named on the
 * answer as `carrierGameId`: a team has no footprint of its own, and inventing a
 * synthetic fixture would mean inventing a format and therefore a duration. The
 * carrier is the team's earliest-dated fixture, so the choice is deterministic.
 *
 * On top of `canGameMove()`'s answer for each cell, this adds the one check a
 * per-placement question cannot make: **does this team already have a fixture
 * overlapping that window?** That is `bookingsOverlapInTime()`'s question, and
 * its `null` — one of the two fixtures has an unknown footprint — is carried
 * here as `unknown`. It is never read as `false`, which is the collapse this
 * repository has made four times.
 *
 * @param {import('../attribution/types.js').AttributionContext} context
 * @param {Object} rawQuery - see `TeamFeasibilityQuerySchema`
 * @param {{ venueComplexes?: Object|null }} [options]
 * @returns {import('./types.js').TeamFeasibilityAnswer}
 */
export function canTeamPlay(context, rawQuery, options = {}) {
  const query = TeamFeasibilityQuerySchema.parse(rawQuery);
  const meta = createFeasibilityMeta();
  /** @type {import('./types.js').FeasibilityFinding[]} */
  const findings = [];
  /** @type {import('./types.js').FeasibilityUnknown[]} */
  const unknowns = [];

  const schedule = context.schedule;
  const isPlaceholder = schedule.placeholderLabels.includes(query.teamId);
  const teamGames = schedule.games.filter(
    (game) => game.homeTeamId === query.teamId || game.awayTeamId === query.teamId
  );

  /** @type {import('./types.js').TeamFeasibilityAnswer} */
  const answer = {
    question: FEASIBILITY_QUESTION.CAN_TEAM_PLAY,
    subject: {
      gameId: null,
      teamId: query.teamId,
      surfaceId: null,
      venueId: null,
      date: query.dates[0],
      kickoffMinutes: query.kickoffMinutes,
      format: query.format,
    },
    verdict: FEASIBILITY_VERDICT.UNKNOWN,
    tight: null,
    candidates: [],
    verdictCounts: {},
    carrierGameId: null,
    binding: [],
    marginMinutes: null,
    marginUnit: FEASIBILITY_MARGIN_UNIT,
    marginBasis: null,
    unknowns,
    findings,
    meta,
    status: '',
  };

  if (isPlaceholder) {
    unknowns.push(
      makeUnknown(
        FEASIBILITY_REASON.FEASIBILITY_SUBJECT_NOT_A_TEAM,
        `"${query.teamId}"`,
        `"${query.teamId}" is a placeholder label this schedule declares, not a team; an unnamed fixture has no opponent and no roster, so nothing can be asked on its behalf`,
        { details: { teamId: query.teamId } }
      )
    );
    findings.push(
      makeFeasibilityFinding(
        FEASIBILITY_REASON.FEASIBILITY_SUBJECT_NOT_A_TEAM,
        `the question named "${query.teamId}", which this schedule lists among its placeholder labels`,
        { teamId: query.teamId }
      )
    );
    return sealTeam(answer);
  }

  if (teamGames.length === 0) {
    unknowns.push(
      makeUnknown(
        FEASIBILITY_REASON.FEASIBILITY_SUBJECT_UNKNOWN,
        `team "${query.teamId}"`,
        `no fixture in this run names team "${query.teamId}", so there is no format, no venue history and no carrier fixture to ask on its behalf`,
        { details: { teamId: query.teamId, teamCount: schedule.teamUniverse.length } }
      )
    );
    findings.push(
      makeFeasibilityFinding(
        FEASIBILITY_REASON.FEASIBILITY_SUBJECT_UNKNOWN,
        `the question named team "${query.teamId}", which no fixture in this run mentions`,
        { teamId: query.teamId }
      )
    );
    return sealTeam(answer);
  }

  const observedFormats = [...new Set(teamGames.map((game) => game.format))];
  const format = query.format ?? (observedFormats.length === 1 ? observedFormats[0] : null);
  answer.subject.format = format;
  if (format === null) {
    unknowns.push(
      makeUnknown(
        FEASIBILITY_REASON.FEASIBILITY_FORMAT_UNRESOLVED,
        `the format team "${query.teamId}" would play`,
        `this team's fixtures span ${observedFormats.length} formats (${observedFormats.map((entry) => entry ?? '(none)').join(', ')}) and the question named none, so no footprint can be taken; state a format rather than having one picked`,
        { details: { teamId: query.teamId, observedFormats: observedFormats.length } }
      )
    );
  }

  const ordered = [...teamGames].sort((a, b) =>
    a.date === b.date ? a.id.localeCompare(b.id) : a.date.localeCompare(b.date)
  );
  // **The carrier carries the format, because the carrier is what the grid is
  // judged through.** Every cell is a `canGameMove()` of this fixture, and
  // `checkPlacement()` reads that fixture's own format — so a `format` on the
  // query that did not choose the carrier was reported on the subject, used to
  // size the clash window, and silently ignored by every cell. A field that
  // reads as load-bearing and is not is how incident 9's waiver got lost, so it
  // is honoured here and refused below when nothing can carry it.
  const carriers = format === null ? ordered : ordered.filter((game) => game.format === format);
  const carrier = carriers[0] ?? null;
  answer.carrierGameId = carrier?.id ?? null;
  if (carrier === null) {
    unknowns.push(
      makeUnknown(
        FEASIBILITY_REASON.FEASIBILITY_FORMAT_UNCARRIED,
        `a "${format}" fixture for team "${query.teamId}"`,
        `no fixture of team "${query.teamId}" plays "${format}" (it plays ${observedFormats.map((entry) => entry ?? '(none)').join(', ')}), so nothing can carry the hypothesis; a team has no footprint of its own and inventing a fixture would be inventing the duration this answer turns on`,
        { details: { teamId: query.teamId, format, observedFormats: observedFormats.length } }
      )
    );
    findings.push(
      makeFeasibilityFinding(
        FEASIBILITY_REASON.FEASIBILITY_FORMAT_UNCARRIED,
        `the question named format "${format}" for team "${query.teamId}", which none of its ${teamGames.length} fixture(s) plays`,
        { teamId: query.teamId, format, fixtures: teamGames.length }
      )
    );
    return sealTeam(answer);
  }

  const surfaceIds =
    query.surfaceIds.length > 0
      ? [...new Set(query.surfaceIds)].sort()
      : [...new Set(teamGames.map((game) => game.surfaceId))].sort();

  const timing = format === null ? null : formatTimingOrUnknown(context.engines.table, format);
  const occupancyMinutes = timing?.occupancyMinutes?.scheduled ?? null;
  const endMinutes = occupancyMinutes === null ? null : query.kickoffMinutes + occupancyMinutes;
  if (occupancyMinutes === null && format !== null) {
    absorbUnknowns(
      unknowns,
      unknownsFromCodes(
        /** @type {Array<{ code: string, severity: string, message: string }>} */ (
          timing?.findings ?? []
        ),
        `the footprint of a "${format}" fixture`
      )
    );
  }

  /* -- the grid; every cell answered ------------------------------------- */
  for (const date of query.dates) {
    for (const surfaceId of surfaceIds) {
      meta.candidatesConsidered += 1;
      const cell = canGameMove(
        context,
        {
          gameId: carrier.id,
          insteadOfDate: date,
          insteadOfSurfaceId: surfaceId,
          insteadOfMinutes: query.kickoffMinutes,
        },
        {
          venueComplexes: options.venueComplexes ?? null,
          minimalSet: false,
          standingPositionIsAnAnswer: true,
        }
      );
      mergeFeasibilityMeta(meta, cell.meta);
      // `canGameMove()` counts its own single candidate; the grid counts cells.
      meta.candidatesConsidered -= cell.meta.candidatesConsidered;
      meta.candidatesAnswered -= cell.meta.candidatesAnswered;

      // The one cell that can coincide with the carrier's own position says so
      // on the answer as well as inside itself, because "this is where the team
      // already plays" is the reason that cell reads differently from its
      // neighbours and a reader has no other way to see it.
      if (
        cell.findings.some(
          (finding) => finding.code === FEASIBILITY_REASON.FEASIBILITY_POSITION_ALREADY_HELD
        )
      ) {
        findings.push(
          makeFeasibilityFinding(
            FEASIBILITY_REASON.FEASIBILITY_POSITION_ALREADY_HELD,
            `team "${query.teamId}" already plays on ${date} at ${surfaceId} at this kickoff, through fixture "${carrier.id}", so that cell is answered from the standing schedule`,
            { teamId: query.teamId, gameId: carrier.id, date, surfaceId }
          )
        );
      }

      /** @type {import('./types.js').FeasibilityUnknown[]} */
      const cellUnknowns = [...cell.unknowns];
      const clash = teamClashAt(
        teamGames,
        carrier.id,
        date,
        query.kickoffMinutes,
        endMinutes,
        meta
      );
      absorbUnknowns(cellUnknowns, clash.unknowns);
      // Only what *this* level added: the cell's own unknowns were counted by
      // the answer that raised them and arrived here through the merge above.
      meta.unknownsRaised += cellUnknowns.length - cell.unknowns.length;

      const blocked = cell.verdict === FEASIBILITY_VERDICT.INFEASIBLE || clash.overlaps === true;
      const verdict = deriveFeasibilityVerdict({ blocked, unknowns: cellUnknowns });
      meta.candidatesAnswered += 1;

      answer.candidates.push({
        date,
        surfaceId,
        kickoffMinutes: query.kickoffMinutes,
        verdict,
        tight: verdict === FEASIBILITY_VERDICT.FEASIBLE ? cell.tight : null,
        binding: cell.binding,
        marginMinutes: cell.marginMinutes,
        marginBasis: cell.marginBasis,
        unknowns: cellUnknowns,
        blockers: cell.blockers,
        // **The cell's own findings, carried whole.** `FeasibilityCandidate` is
        // documented as a candidate *with its own answer*, and dropping the
        // findings made that false in the one place it mattered: a compromise
        // that no claim can name is published by `canGameMove()` as a finding,
        // and a grid that kept only the claims would seal on evidence it had
        // thrown away one line earlier.
        findings: cell.findings,
      });
    }
  }

  // **The grid size is derived from the query, not from the loop that filled
  // it.** A counter incremented beside every `push` can never disagree with the
  // list it counts, which is a guard that cannot fire; this one is computed from
  // the dates and surfaces the question named, so a `continue` added to the loop
  // above would trip it. Incident 10's rule: a position that cannot be judged is
  // reported with a reason, never dropped.
  const gridSize = query.dates.length * surfaceIds.length;
  if (answer.candidates.length !== gridSize) {
    findings.push(
      makeFeasibilityFinding(
        FEASIBILITY_REASON.FEASIBILITY_CANDIDATE_DROPPED,
        `${gridSize} candidate position(s) were asked about (${query.dates.length} date(s) x ${surfaceIds.length} surface(s)) and ${answer.candidates.length} produced an answer`,
        {
          teamId: query.teamId,
          candidatesConsidered: gridSize,
          candidatesAnswered: answer.candidates.length,
        }
      )
    );
  }
  if (gridSize === 0) {
    findings.push(
      makeFeasibilityFinding(
        FEASIBILITY_REASON.FEASIBILITY_QUERY_VACUOUS,
        `the question about team "${query.teamId}" produced no candidate position at all, so any answer it gave would be a statement about an empty search`,
        { teamId: query.teamId, dates: query.dates.length, surfaces: surfaceIds.length }
      )
    );
  }

  /* -- the roll-up -------------------------------------------------------- */
  /** @type {Record<string, number>} */
  const verdictCounts = {
    [FEASIBILITY_VERDICT.FEASIBLE]: 0,
    [FEASIBILITY_VERDICT.INFEASIBLE]: 0,
    [FEASIBILITY_VERDICT.UNKNOWN]: 0,
  };
  for (const candidate of answer.candidates) verdictCounts[candidate.verdict] += 1;
  answer.verdictCounts = verdictCounts;

  // **The roll-up rule, stated once.** "Can this team play at 6pm?" is answered
  // yes when *some* position works, because one legal position is all a fixture
  // needs. It is `unknown` when none is known to work and at least one could not
  // be judged — an unjudged cell can never be counted as a "no". Only when every
  // cell was judged and every one of them said no is the roll-up `infeasible`.
  const feasibleCells = verdictCounts[FEASIBILITY_VERDICT.FEASIBLE];
  const unknownCells = verdictCounts[FEASIBILITY_VERDICT.UNKNOWN];
  if (answer.candidates.length === 0) {
    // Belt and braces against a future edit: a grid with no cells has nothing to
    // say, and the one thing it must never say is yes. The schema already makes
    // this unreachable — one date minimum, and the surfaces fall back to the
    // team's own — which is why the code is registered as such in the reason-code
    // audit rather than being left to look reachable.
    unknowns.push(
      makeUnknown(
        FEASIBILITY_REASON.FEASIBILITY_QUERY_VACUOUS,
        `every position team "${query.teamId}" could take on the dates asked about`,
        'the question produced no candidate position at all, so there is nothing this answer can be true of',
        { details: { teamId: query.teamId } }
      )
    );
  }
  // The unknowns this level raised itself — a placeholder subject, an
  // unresolvable format, a vacuous grid. The cells' own were counted in the
  // loop; the roll-up below merely *absorbs* those, and counting an absorbed
  // list again is what made this counter read 20 where 16 were raised.
  meta.unknownsRaised += unknowns.length;
  const rolled = seal(
    /** @type {import('./types.js').FeasibilityAnswer} */ ({
      question: FEASIBILITY_QUESTION.CAN_TEAM_PLAY,
      subject: answer.subject,
      verdict: FEASIBILITY_VERDICT.UNKNOWN,
      tight: null,
      binding: [],
      marginMinutes: null,
      marginUnit: FEASIBILITY_MARGIN_UNIT,
      marginBasis: null,
      blockers: [],
      // **When nothing worked, everything that went unchecked is part of the
      // answer.** A cell that is feasible carries no unknowns by construction —
      // an unknown would have made it `unknown` — so a roll-up with a feasible
      // cell has nothing to carry, while one without has all of it.
      unknowns:
        feasibleCells > 0
          ? []
          : answer.candidates.reduce(
              (all, candidate) => absorbUnknowns(all, candidate.unknowns),
              absorbUnknowns([], unknowns)
            ),
      minimalSet: null,
      notApplicable: [],
      findings,
      meta,
      status: '',
    }),
    {
      blocked: feasibleCells === 0 && unknownCells === 0 && answer.candidates.length > 0,
      // (see the roll-up rule above; `compromised` is only consulted when the
      // verdict lands on `feasible`)
      compromised:
        feasibleCells > 0 &&
        answer.candidates
          .filter((candidate) => candidate.verdict === FEASIBILITY_VERDICT.FEASIBLE)
          .every((candidate) => candidate.tight === FEASIBILITY_TIGHTNESS.TIGHT),
    }
  );

  const best =
    answer.candidates.find((candidate) => candidate.verdict === FEASIBILITY_VERDICT.FEASIBLE) ??
    answer.candidates.find((candidate) => candidate.verdict === FEASIBILITY_VERDICT.INFEASIBLE) ??
    null;

  return {
    ...answer,
    verdict: rolled.verdict,
    tight: rolled.tight,
    binding: best?.binding ?? [],
    marginMinutes: best?.marginMinutes ?? null,
    // **The basis is the candidate's own**, copied beside the number it names.
    // `binding[0]` is claim order, not tightness order, so it named a different
    // constraint whenever two bound at once — and named one at all when the
    // margin was `null`, which is a source for a number that does not exist.
    marginBasis: best?.marginBasis ?? null,
    unknowns: rolled.unknowns,
    findings: rolled.findings,
    status: rolled.status,
  };
}

/**
 * Does this team already hold a fixture overlapping that window?
 *
 * `bookingsOverlapInTime()` owns the question and answers it in three values:
 * `true`, `false`, and `null` for *"one of these two has no known end"*. The
 * `null` is carried out of here as an `unknown` and is never coerced — folding
 * an unmeasurable overlap into "no clash" is the failure
 * `docs/BUILD_PLAN_STATUS.md` §4 records four times over.
 *
 * @param {ReadonlyArray<Object>} teamGames
 * @param {string} carrierGameId
 * @param {string} date
 * @param {number} startMinutes
 * @param {number|null} endMinutes
 * @param {import('./types.js').FeasibilityMeta} meta
 * @returns {{ overlaps: boolean, unknowns: import('./types.js').FeasibilityUnknown[] }}
 */
function teamClashAt(teamGames, carrierGameId, date, startMinutes, endMinutes, meta) {
  /** @type {import('./types.js').FeasibilityUnknown[]} */
  const unknowns = [];
  const candidate = { date, startMinutes, endMinutes, surfaceId: 'n/a' };
  let overlaps = false;
  for (const game of teamGames) {
    if (game.id === carrierGameId) continue;
    if (game.date !== date) continue;
    meta.teamFixturesCompared += 1;
    const verdict = bookingsOverlapInTime(
      /** @type {import('../facility/types.js').FacilityBooking} */ (candidate),
      /** @type {import('../facility/types.js').FacilityBooking} */ (game)
    );
    if (verdict === true) {
      // **KNOWN GAP — a cell refused *only* by this clash publishes no
      // blocker.** The overlap reaches `blocked` in `canTeamPlay()` and nothing
      // else, so such a cell would seal `infeasible` over a blocking list that
      // names nothing — the shape rounds five and six closed elsewhere.
      //
      // It is **unreachable on the season-2026 corpus**: every one of the 338
      // cells that meets a clash here is already `infeasible` for an
      // independent reason, and an acceptance case states that no team in this
      // season plays twice on one date. That is why the corpus-wide
      // publish-what-you-seal-on rule has never met it.
      //
      // A fix was written in round seven and **withdrawn** in round eight: it
      // published a `FEASIBILITY_TEAM_DOUBLE_BOOKED` claim from here, and that
      // claim introduced four defects on paths this corpus *does* reach — a
      // refused candidate still carrying the cell's `binding`/`marginMinutes`,
      // a claim sourced to the facility layer that does not own the fact, a
      // `slackMinutes: null` that sorted the only blocking claim behind three
      // `info` ones, and a roll-up finding emitted per (date, surface) although
      // this function ignores surface. Trading an unreachable gap for four
      // reachable defects is a bad trade. See `docs/BUILD_PLAN_STATUS.md`,
      // "the withdrawn team-clash blocker", before writing the fix again: it
      // needs a claim this layer can honestly own and a per-clash roll-up.
      overlaps = true;
      continue;
    }
    if (verdict === null) {
      unknowns.push(
        makeUnknown(
          FEASIBILITY_REASON.FEASIBILITY_FOOTPRINT_UNKNOWN,
          `whether this team's fixture "${game.id}" overlaps the window on ${date}`,
          'one of the two fixtures has no known end (GAP-14), so the overlap could not be decided; a null from bookingsOverlapInTime() is not a "no clash"',
          { details: { gameId: game.id, date } }
        )
      );
    }
  }
  return { overlaps, unknowns };
}

/**
 * Seal a team answer that ended before the grid ran.
 *
 * @param {import('./types.js').TeamFeasibilityAnswer} answer
 * @returns {import('./types.js').TeamFeasibilityAnswer}
 */
function sealTeam(answer) {
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
    { blocked: false, compromised: false }
  );
  return {
    ...answer,
    verdict: rolled.verdict,
    tight: rolled.tight,
    findings: rolled.findings,
    status: rolled.status,
  };
}

/* -------------------------------------------------------------------------- */
/* 3. How late, and how late cleanly?                                          */
/* -------------------------------------------------------------------------- */

/**
 * **"How late can anything kick off here — and how late without eating into a
 * margin?"**
 *
 * Two boundaries, because the corpus states two thresholds with different
 * status:
 *
 * - `latestHard` — the last kickoff at which nothing raises a `blocking`
 *   finding. `latestLegalKickoff()`'s answer, **confirmed under the registry**:
 *   that function selects on `availability/`'s own frozen severities, this
 *   module judges everything under the registry's, and where a registry record
 *   makes a base-`compromise` code hard the bound moves down to the latest
 *   minute the registry allows and `FEASIBILITY_BOUND_UNDER_REGISTRY` says so.
 *   On a registry that governs no availability code more harshly than its base
 *   — the season corpus — the confirmation changes nothing and the answer is
 *   `latestLegalKickoff()`'s, whole.
 * - `latestClean` — the last kickoff at which nothing raises a finding above
 *   `info` at all. Never later than the hard one, and often earlier: on the
 *   corpus's lit venue the permit's 15-minute comfort margin puts it a quarter
 *   of an hour back.
 *
 * The clean boundary is found by **generating candidate minutes and confirming
 * every one of them** through `checkKickoffAvailability()`. The candidates are
 * over-generated on purpose — each applicable limit, less each margin the
 * calendar declares, less the format's occupancy, plus each standing booking's
 * start — so this module never has to claim which margin belongs to which
 * constraint. Confirmation is what makes the answer true; generation only has to
 * be broad enough to contain it, which
 * `tests/feasibilityApi.test.js` establishes against a minute-by-minute scan.
 *
 * @param {import('../attribution/types.js').AttributionContext} context
 * @param {Object} rawQuery - see `KickoffBoundsQuerySchema`
 * @returns {import('./types.js').KickoffBoundsAnswer}
 */
export function feasibleKickoffBounds(context, rawQuery) {
  const query = KickoffBoundsQuerySchema.parse(rawQuery);
  const meta = createFeasibilityMeta();
  /** @type {import('./types.js').FeasibilityFinding[]} */
  const findings = [];
  /** @type {import('./types.js').FeasibilityUnknown[]} */
  const unknowns = [];
  const engines = context.engines;

  meta.questionsAsked += 1;
  const existingBookings = standingBookings(context.state, query.date, query.ignoreGameIds);
  const surface = getSurface(
    /** @type {import('../facility/types.js').FacilityGraph} */ (engines.graph),
    query.surfaceId
  );

  const hardResult = latestLegalKickoff(
    engines.graph,
    engines.table,
    engines.calendar,
    {
      surfaceId: query.surfaceId,
      date: query.date,
      format: query.format,
      notBeforeMinutes: query.notBeforeMinutes,
      notAfterMinutes: query.notAfterMinutes,
      ignoreBookingIds: [...query.ignoreGameIds],
    },
    { existingBookings }
  );
  meta.boundaryProbesRun += 1;
  meta.constraintsConsulted += hardResult.constraints.length;
  meta.candidatesConsidered += 1;

  const at = {
    surfaceId: query.surfaceId,
    date: query.date,
    format: query.format,
    ignoreBookingIds: query.ignoreGameIds,
    divisionLabel: null,
  };

  absorbUnknowns(
    unknowns,
    unknownsFromCodes(
      /** @type {Array<{ code: string, severity: string, message: string }>} */ (
        hardResult.findings
      ),
      `kickoff bounds on ${query.surfaceId} on ${query.date}`
    )
  );
  absorbUnknowns(
    unknowns,
    unenforcedGoverningConstraints(
      context.verification,
      engines.registry,
      scopeContextOf(engines.graph, {
        date: query.date,
        surfaceId: query.surfaceId,
        venueId: surface?.venueId ?? null,
      }),
      meta
    )
  );

  // **The bound is chosen under the severities it is judged under.**
  // `latestLegalKickoff()` selects on `availability/`'s frozen table, and
  // `boundaryOf()` builds the claims that decide this answer's verdict from the
  // *registry's* view of the same minute. A registry that makes a
  // base-`compromise` availability code hard — which is what a registry is for
  // — therefore produced a boundary chosen under one view and refused under the
  // other: 217 of this corpus's 1,872 bounds combinations came back
  // `infeasible` while naming a latest legal kickoff, a margin and a binding
  // set, which is the self-contradiction round three removed re-entering from
  // the selection side.
  //
  // So availability's answer is *confirmed* under the registry, and where the
  // registry refuses it the same generate-and-confirm search the clean boundary
  // uses continues downward from it. The confirmation costs nothing on ground
  // where the two views agree — the gate below is `underRegistry()`, the same
  // lookup `boundaryOf()` runs anyway — so no answer this corpus produces
  // moves.
  //
  // The search only ever proposes minutes at or below availability's own, so
  // this module can be more conservative than `availability/kickoff.js` and
  // never less. A registry that *softens* a base-`blocking` code leaves the
  // hard bound where availability put it, which under-reports the ground
  // available rather than over-reporting it, and is the direction a read-only
  // answer should err in.
  const availabilityMinutes = hardResult.kickoffMinutes;
  // **The refusal is read off the list the confirmation reads, not off the
  // searcher's.** `latestLegalKickoff()` returns the accepted minute's own
  // findings *plus* summaries of its own search — `LATEST_KICKOFF_BOUND` is
  // one, synthesised after a minute is accepted and raised by
  // `checkKickoffAvailability()` never. A registry that governs such a code made
  // this comparison report a bound the registry had moved when the search
  // re-accepted the identical minute, with `availabilityKickoffMinutes` equal to
  // `kickoffMinutes` in the finding that said so. So the decision is taken on a
  // fresh probe of availability's own bound: the same function
  // `searchBoundary()` confirms every candidate through, judged by the same
  // `speaksAt()`, so selection and judgment read one list in fact.
  //
  // The probe is only taken where a refusal is possible at all. Everything a
  // probe says about a minute is carried by the search that accepted that
  // minute — the searcher pushes `attempt.findings` whole — so a registry that
  // refuses nothing in the searcher's larger list refuses nothing in the
  // probe's smaller one, and the season corpus, which governs no availability
  // code more harshly than its base, pays for no probe at all. The containment
  // is asserted over the corpus in `tests/feasibilityApi.test.js` rather than
  // assumed here.
  const refusalPossible =
    availabilityMinutes !== null &&
    speaksAt(
      FEASIBILITY_THRESHOLD.HARD,
      underRegistry(
        engines,
        {
          surfaceId: query.surfaceId,
          venueId: hardResult.venueId ?? surface?.venueId ?? null,
          date: query.date,
        },
        hardResult.findings ?? []
      )
    ).length > 0;
  const boundProbe = refusalPossible
    ? probeKickoff(
        engines,
        { ...at, kickoffMinutes: /** @type {number} */ (availabilityMinutes) },
        existingBookings,
        meta
      )
    : null;
  const refusedAtAvailabilityBound =
    boundProbe === null ? [] : speaksAt(FEASIBILITY_THRESHOLD.HARD, boundProbe.findings);
  const hardMinutes =
    refusedAtAvailabilityBound.length === 0
      ? availabilityMinutes
      : searchBoundary(
          engines,
          at,
          existingBookings,
          hardResult,
          availabilityMinutes,
          FEASIBILITY_THRESHOLD.HARD,
          meta
        );
  // A boundary describes its own position, so a bound the registry moved is
  // described by a fresh probe of the minute it moved to — never in the words
  // of the minute availability offered. `assertBoundaryResult()` enforces it.
  //
  // **And a bound the registry refused everywhere describes the refusal.** This
  // branch used to substitute `{ constraints: [], findings: [] }`, so the answer
  // sealed `infeasible` while publishing an empty binding set, no claims and no
  // inapplicable constraints: the verdict rode on the caller's `blocked` flag
  // while `deriveFeasibilityEvidence()` saw nothing, about a position the
  // registry had a great deal to say about. The blackout path has always done
  // the opposite — Summit HS on 2026-09-19 has no boundary and publishes
  // `PERMIT_BLACKOUT` — so this is the same treatment rather than a second one.
  // The evidence is the refusal's own probe with the position taken off it,
  // because there is no position: nothing is invented, and nothing that spoke
  // is discarded.
  const hardBoundaryResult =
    hardMinutes === availabilityMinutes
      ? hardResult
      : hardMinutes === null
        ? {
            .../** @type {{ result: Object }} */ (boundProbe).result,
            endMinutes: null,
            kickoffMinutes: null,
          }
        : probeKickoff(engines, { ...at, kickoffMinutes: hardMinutes }, existingBookings, meta)
            .result;
  // **Emitted from the comparison it asserts.** The sentence is *"the bound this
  // answer reports is not the one availability offered"*, so it is said when
  // those two minutes differ rather than when a refusal was found. The two are
  // the same condition — the search's first candidate is availability's own
  // minute and the refusal is exactly what rejects it — and stating it this way
  // means the finding cannot outlive that being true.
  if (refusedAtAvailabilityBound.length > 0 && hardMinutes !== availabilityMinutes) {
    findings.push(
      makeFeasibilityFinding(
        FEASIBILITY_REASON.FEASIBILITY_BOUND_UNDER_REGISTRY,
        `availability's own latest legal kickoff here is minute ${availabilityMinutes}; under this registry ${refusedAtAvailabilityBound.map((finding) => finding.code).join(', ')} counts as blocking there, so the hard bound this answer reports is ${JSON.stringify(hardMinutes)}`,
        {
          surfaceId: query.surfaceId,
          date: query.date,
          format: query.format,
          availabilityKickoffMinutes: availabilityMinutes,
          kickoffMinutes: hardMinutes,
          codes: [...new Set(refusedAtAvailabilityBound.map((finding) => finding.code))].sort(),
        }
      )
    );
  }

  /** @type {Array<Object>} */
  const categoryOnlyClaims = [];
  const hard = boundaryOf(
    engines,
    at,
    existingBookings,
    hardBoundaryResult,
    hardMinutes,
    FEASIBILITY_THRESHOLD.HARD,
    meta,
    categoryOnlyClaims
  );

  const cleanMinutes = searchBoundary(
    engines,
    at,
    existingBookings,
    hardResult,
    hardMinutes,
    FEASIBILITY_THRESHOLD.CLEAN,
    meta
  );
  // **A boundary that does not exist has nothing to describe.** Handing
  // `hardResult` to the clean boundary walked the *hard* result a second time:
  // it counted every one of its claims again in `meta.claimsCarried` — the
  // counter that says how much this answer looked at — and would have raised a
  // second copy of any category-only finding for the same cell. It also
  // reported the hard boundary's constraints under the clean threshold's name,
  // about a position no minute of the day offers. 1,620 of this corpus's 1,872
  // combinations reach here, 869 of them with a non-empty claim list.
  const cleanResult =
    cleanMinutes === null
      ? { constraints: [], findings: [], endMinutes: null, venueId: surface?.venueId ?? null }
      : probeKickoff(engines, { ...at, kickoffMinutes: cleanMinutes }, existingBookings, meta)
          .result;
  const clean = boundaryOf(
    engines,
    at,
    existingBookings,
    cleanResult,
    cleanMinutes,
    FEASIBILITY_THRESHOLD.CLEAN,
    meta,
    categoryOnlyClaims
  );
  meta.candidatesAnswered += 1;
  // **Translated, never forwarded.** 4.3's guard speaks 4.3's vocabulary, and a
  // finding carrying `ATTRIBUTION_CLAIM_CATEGORY_ONLY` is one this module cannot
  // look up a severity for — `feasibilitySeverityOf()` throws on it, in the hand
  // of whoever read the answer. The finding is restated under this module's own
  // code, with the original kept in `details.sourceCode` so nothing is lost.
  findings.push(
    ...categoryOnlyClaims.map((finding) =>
      makeFeasibilityFinding(
        FEASIBILITY_REASON.FEASIBILITY_CLAIM_CATEGORY_ONLY,
        String(finding.message),
        { ...finding.details, sourceCode: finding.code }
      )
    )
  );

  // **Both boundaries report their own bound.** The joint case lives at the
  // clean threshold on this corpus — Alder's permit close and its daylight limit
  // coincide on 08/22 — so reporting only the hard boundary's bound would hide
  // the one tie the season actually contains.
  findings.push(
    ...boundFindings(hard.binding, hard.marginMinutes, {
      surfaceId: query.surfaceId,
      date: query.date,
      threshold: FEASIBILITY_THRESHOLD.HARD,
    }),
    ...boundFindings(clean.binding, clean.marginMinutes, {
      surfaceId: query.surfaceId,
      date: query.date,
      threshold: FEASIBILITY_THRESHOLD.CLEAN,
    })
  );

  // **The vacuity guard, over what the query examined rather than what it
  // returned.** A surface the graph does not hold makes `latestLegalKickoff()`
  // return before it evaluates a single edge, and "nothing bounds this" would
  // then be a statement about an empty search rather than about a venue.
  if (meta.constraintsConsulted === 0) {
    findings.push(
      makeFeasibilityFinding(
        FEASIBILITY_REASON.FEASIBILITY_QUERY_VACUOUS,
        `the bounds question about "${query.surfaceId}" on ${query.date} evaluated zero constraints, so any boundary it reported would be a statement about an empty search`,
        { surfaceId: query.surfaceId, date: query.date, format: query.format }
      )
    );
  }

  const tightBandMinutes =
    hard.kickoffMinutes === null || clean.kickoffMinutes === null
      ? null
      : hard.kickoffMinutes - clean.kickoffMinutes;

  meta.unknownsRaised += unknowns.length;

  const sealed = seal(
    /** @type {import('./types.js').FeasibilityAnswer} */ ({
      question: FEASIBILITY_QUESTION.KICKOFF_BOUNDS,
      subject: {
        gameId: null,
        teamId: null,
        surfaceId: query.surfaceId,
        venueId: surface?.venueId ?? null,
        date: query.date,
        kickoffMinutes: hard.kickoffMinutes,
        format: query.format,
      },
      verdict: FEASIBILITY_VERDICT.UNKNOWN,
      tight: null,
      binding: hard.binding,
      marginMinutes: hard.marginMinutes,
      marginUnit: FEASIBILITY_MARGIN_UNIT,
      marginBasis: hard.marginBasis,
      blockers: hard.claims,
      unknowns,
      minimalSet: null,
      notApplicable: hard.notApplicable,
      findings,
      meta,
      status: '',
    }),
    {
      blocked: hard.kickoffMinutes === null,
      // **The band is reported; the tightness is derived.** `tightBandMinutes >
      // 0` said the same thing on every one of this corpus's 1,872
      // combinations — a hard bound later than the clean one is a hard bound
      // with something above `info` speaking at it — but it said it in a second
      // arithmetic that was free to disagree with the claims the answer
      // publishes. `seal()` folds those claims through the one severity table
      // instead, so this shape obeys the same rule as every other.
      compromised: false,
      // **Whether a clean position exists at all**, which is a different fact
      // from the width of the band and used to be collapsed into it: a null
      // clean boundary makes the band null, which made `compromised` false,
      // which reported "not tight" about ground where every legal kickoff is
      // compromised. 772 of this corpus's surface-date-format combinations said
      // exactly that.
      cleanBoundaryExists: clean.kickoffMinutes !== null,
    }
  );

  return {
    question: FEASIBILITY_QUESTION.KICKOFF_BOUNDS,
    subject: sealed.subject,
    verdict: sealed.verdict,
    tight: sealed.tight,
    latestHard: hard,
    latestClean: clean,
    tightBandMinutes,
    binding: hard.binding,
    marginMinutes: hard.marginMinutes,
    marginUnit: FEASIBILITY_MARGIN_UNIT,
    marginBasis: hard.marginBasis,
    unknowns: sealed.unknowns,
    searchedFromMinutes: hardResult.searchedFromMinutes,
    searchedToMinutes: hardResult.searchedToMinutes,
    findings: sealed.findings,
    meta,
    status: sealed.status,
  };
}

/**
 * One boundary, with its binding set, its claims and its margin.
 *
 * The first thing it does is check that the availability result it was handed is
 * about the position it is building a boundary for — `assertBoundaryResult()`,
 * which is where `FeasibilityBoundary`'s contract about `claims` and
 * `notApplicable` is now enforced. It used to be enforced by the clean call
 * site handing in an empty result, which is one caller remembering rather than
 * the builder guaranteeing.
 *
 * @param {Object} engines
 * @param {Object} at
 * @param {ReadonlyArray<Object>} existingBookings
 * @param {Object} result - the availability answer at the boundary
 * @param {number|null} kickoffMinutes
 * @param {string} threshold
 * @param {import('./types.js').FeasibilityMeta} meta
 * @param {Array<Object>} categoryOnlyClaims - collector for claims that fail the
 *   specific-instance test; never expected to receive one
 * @returns {import('./types.js').FeasibilityBoundary}
 */
function boundaryOf(
  engines,
  at,
  existingBookings,
  result,
  kickoffMinutes,
  threshold,
  meta,
  categoryOnlyClaims
) {
  assertBoundaryResult(result, kickoffMinutes, threshold);
  const probesBefore = meta.boundaryProbesRun;
  /** @type {import('./types.js').FeasibilityBound[]} */
  const binding =
    kickoffMinutes === null
      ? []
      : bindingAt(engines, { ...at, kickoffMinutes }, existingBookings, result, threshold, meta);
  const { marginMinutes, marginBasis } = marginFrom(binding);

  const claimCtx = {
    registry: engines.registry,
    gameId: null,
    surfaceId: at.surfaceId,
    venueId: result.venueId ?? null,
    date: at.date,
  };
  // **Each bound gets the findings that are about it**, grouped by 4.3's own
  // table. Handing the builder an empty list instead loses the codes, and a
  // bound with no codes *and* no measurable numbers — the permit on a blacked-out
  // date is exactly that — becomes a claim that names a category. The reason-code
  // audit caught precisely that here, which is what the guard below is for.
  const grouped = groupFindingsByConstraintKind(
    /** @type {ReadonlyArray<import('../attribution/types.js').AttributionFinding>} */ (
      underRegistry(
        engines,
        { surfaceId: at.surfaceId, venueId: result.venueId ?? null, date: at.date },
        result.findings ?? []
      ).filter((finding) => finding.severity !== CONSTRAINT_SEVERITY.INFO)
    )
  );
  const bounds = (result.constraints ?? [])
    .filter((constraint) => constraint.applicable)
    .map((constraint) =>
      claimFromAvailabilityConstraint(constraint, claimCtx, grouped.byKind[constraint.kind] ?? [])
    );
  // **Every finding that counts, owned by a bound or not.**
  // `claimsFromBounds()` in `attribution/explain.js` already states this
  // contract: the kinds a bound took responsibility for are tracked, and
  // everything else — bucketed under a kind no *applicable* bound claimed, or
  // bucketed under nothing at all — becomes a claim in its own right through
  // `claimFromFinding()`. This is that function's contract adopted whole rather
  // than a third one invented (`CLAUDE.md` section 3).
  //
  // It was adopted narrowly first, for the one case a review had a name for: a
  // boundary refused at every minute of the day by a code no availability kind
  // owns. That left the general case standing. `latestLegalKickoff()` returns
  // `constraints: []` when it finds no legal minute, so its `blocking`
  // `NO_LEGAL_KICKOFF` was owned by nothing and dropped — 745 of this corpus's
  // 751 infeasible bounds answers sealed `infeasible` while
  // `deriveFeasibilityEvidence()` looked at an empty list. And at a boundary
  // that *does* exist, a `compromise` no edge owns — `LINING_MISMATCH` on
  // ground lined for another format, `PERMIT_UNDECLARED`, an unknown
  // footprint — was dropped the same way, on 869 positioned boundaries.
  //
  // So the orphan set is the general one: the findings of this boundary's own
  // minute, at the registry's severities, that no applicable bound of this
  // boundary speaks for.
  const ownedKinds = new Set(
    (result.constraints ?? [])
      .filter((constraint) => constraint.applicable)
      .map((constraint) => constraint.kind)
  );
  const orphans = [
    ...Object.entries(grouped.byKind)
      .filter(([kind]) => !ownedKinds.has(kind))
      .flatMap(([, group]) => group),
    ...grouped.ungrouped,
  ].map((finding) =>
    claimFromFinding(finding, {
      registry: engines.registry,
      source: ATTRIBUTION_SOURCE.AVAILABILITY,
      gameId: null,
      surfaceId: at.surfaceId,
      venueId: result.venueId ?? null,
      date: at.date,
    })
  );
  const claims =
    orphans.length === 0
      ? bounds
      : /** @type {import('../attribution/types.js').ConstraintClaim[]} */ (
          mergeClaimsByTightness([bounds, orphans])
        );
  meta.claimsCarried += claims.length;
  // **The bar every claim has to clear, checked here too.** 4.3 runs this from
  // every one of its own answers because the one place that did not — the
  // minimal blocking set — was the one place a category-only claim could have
  // passed unremarked. A boundary's claims are built by the same public builder,
  // and are checked by the same public guard rather than trusted because of it.
  categoryOnlyClaims.push(
    ...categoryOnlyClaimFindings(
      claims,
      { surfaceId: at.surfaceId, date: at.date },
      createAttributionMeta()
    )
  );

  return {
    threshold,
    kickoffMinutes,
    endMinutes: kickoffMinutes === null ? null : (result.endMinutes ?? null),
    binding,
    marginMinutes,
    marginBasis,
    claims,
    notApplicable: (result.constraints ?? [])
      .filter((constraint) => !constraint.applicable)
      .map((constraint) => ({
        source: ATTRIBUTION_SOURCE.AVAILABILITY,
        kind: constraint.kind,
        reason: String(constraint.detail?.reason ?? 'the machinery that owns it stated no reason'),
      })),
    candidatesTested: meta.boundaryProbesRun - probesBefore,
  };
}

/**
 * The latest kickoff at or below `ceiling` at which nothing speaks at
 * `threshold`.
 *
 * Generate broadly, confirm every candidate. The generation uses the calendar's
 * own declared margins without deciding which constraint each belongs to: every
 * applicable limit is offered less each margin, and the wrong combinations
 * simply fail confirmation. That is why this function contains no reasoning
 * about permits or daylight at all.
 *
 * **One searcher, both thresholds.** It used to serve the clean boundary alone
 * while the hard one came from `latestLegalKickoff()`, which selects on
 * `availability/`'s base severities — so a registry that hardened a
 * base-`compromise` code moved the *judgment* of the hard bound without moving
 * its *selection*. Confirmation here goes through `probeKickoff()`, whose
 * findings are always the registry's view, and `speaksAt()` is the one place a
 * threshold becomes a severity test. Selection and judgment therefore read one
 * table by construction rather than by coincidence.
 *
 * @param {Object} engines
 * @param {Object} at
 * @param {ReadonlyArray<Object>} existingBookings
 * @param {Object} hardResult - the day's own shape: occupancy, floor, limits
 * @param {number|null} ceiling - the latest minute worth confirming
 * @param {string} threshold - a `FEASIBILITY_THRESHOLD` value
 * @param {import('./types.js').FeasibilityMeta} meta
 * @returns {number|null}
 */
function searchBoundary(engines, at, existingBookings, hardResult, ceiling, threshold, meta) {
  if (ceiling === null) return null;
  const occupancy = hardResult.occupancyMinutes;
  if (occupancy === null) return null;
  const floor = hardResult.searchedFromMinutes;
  const margins = [
    0,
    engines.calendar.permitMarginMinutes ?? 0,
    engines.calendar.sunsetMarginMinutes ?? 0,
  ];

  /** @type {number[]} */
  const raw = [ceiling];
  for (const constraint of hardResult.constraints ?? []) {
    if (!constraint.applicable || constraint.limitMinutes === null) continue;
    for (const margin of margins) raw.push(constraint.limitMinutes - margin - occupancy);
  }
  for (const booking of existingBookings) {
    if (booking.date !== at.date) continue;
    for (const margin of margins) raw.push(booking.startMinutes - margin - occupancy);
  }

  const candidates = [...new Set(raw)]
    .filter((minute) => minute >= floor && minute <= ceiling)
    .sort((a, b) => b - a);

  for (const kickoffMinutes of candidates) {
    const probe = probeKickoff(engines, { ...at, kickoffMinutes }, existingBookings, meta);
    if (speaksAt(threshold, probe.findings).length === 0) return kickoffMinutes;
  }
  return null;
}
