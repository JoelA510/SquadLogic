/**
 * The four questions, one call each.
 *
 * > *Real questions from the source project that each required manual
 * > derivation and should be one call:*
 * >
 * > - *"Why is this game at 12:00 and not 10:30?"*
 * > - *"What's the earliest kickoff allowing a full 30-minute warm-up?"*
 * > - *"Why did this team get a conflict?"*
 * > - *"Why can't this game go later?"*
 *
 * Each of the four is a thin call over machinery that already answers it, and
 * the point of the file is which machinery:
 *
 * | question | answered by | this file adds |
 * | --- | --- | --- |
 * | why at this time | `resolve/legality.js` `checkPlacement()` at the slot it has **and** at the one it does not | the counterfactual, as a pair |
 * | earliest kickoff with a full warm-up | `timing/warmup.js` `earliestKickoffWithWarmup()` (Prompt 1.2, incident 8) | the bounding booking as a claim |
 * | why this conflict | `waivers/coachTravel.js` `evaluateCoachTravel()` + `people/roster.js` `soleCoachRiskRegister()` | the join: which team, whose game, and whether anybody could have covered |
 * | why not later | `availability/kickoff.js` `latestLegalKickoff()` | the ordered claims, and the headroom against the kickoff it has |
 *
 * Nothing here re-derives a bound, a violation or a tightness ordering.
 * `orderByTightness()` already answers *"sunset by 6 minutes, then the permit by
 * 66"*, and the ordering it produced is passed through
 * {@link import('./claims.js').mergeClaimsByTightness} untouched.
 *
 * ## `status` is about the answer, not about the game
 *
 * A game that is illegal where it stands gets a perfectly good attribution
 * saying so, whose `status` is `allowed`. The game's own verdict is
 * `placementStatus` / `legal`, straight from `checkPlacement()`. See
 * `attribution/reasonCodes.js`.
 *
 * ## One fact can arrive twice, and both copies are kept
 *
 * A `LINING_MISMATCH` on a corpus `Scrimmage` row reaches an attribution by two
 * independent routes: the placement check for that slot, and the standing rule
 * that claims the same code about the same game. Both are reported, with
 * different `source` values and different instance ids, and neither is
 * suppressed. Two paths agreeing is information — it is the difference between a
 * finding and a finding nothing else can see — and a de-duplication here would
 * be this module deciding which of two other modules to believe.
 *
 * @module attribution/explain
 */

import { latestLegalKickoff } from '../availability/kickoff.js';
import { AVAILABILITY_REASON, availabilitySeverityOf } from '../availability/reasonCodes.js';
import { CONSTRAINT_SEVERITY } from '../constraints/reasonCodes.js';
import { applyRegistrySeverity, effectiveSeverityTable } from '../constraints/severity.js';
import { getSurface } from '../facility/facilityGraph.js';
import { coCoachesOf } from '../people/roster.js';
import { registryConstraintIdsFor, violationsAbout } from '../resolve/errors.js';
import { bookingsOn, checkPlacement } from '../resolve/legality.js';
import { slotKey } from '../resolve/state.js';
import { earliestKickoffWithWarmup } from '../timing/warmup.js';

import {
  categoryOnlyClaimFindings,
  claimFromAvailabilityConstraint,
  claimFromFinding,
  claimFromRosterFinding,
  claimFromTravelTransition,
  claimFromViolation,
  claimFromWarmupBound,
  groupFindingsByConstraintKind,
  mergeClaimsByTightness,
} from './claims.js';
import {
  ATTRIBUTION_QUESTION,
  ATTRIBUTION_REASON,
  ATTRIBUTION_SEVERITY,
  ATTRIBUTION_SOURCE,
  createAttributionMeta,
  deriveAttributionStatus,
  makeAttributionFinding,
  mergeAttributionMeta,
} from './reasonCodes.js';
import {
  AlternativeTimeQuerySchema,
  EarliestKickoffQuestionSchema,
  GameAttributionQuerySchema,
  LatestKickoffQuestionSchema,
  TeamConflictQuerySchema,
} from './schemas.js';

/**
 * The game a question names, or null.
 *
 * Enumerated from the state's **baseline**, which is the schedule as handed in,
 * rather than from anything a run might have edited.
 *
 * @param {import('./types.js').AttributionContext} context
 * @param {string} gameId
 * @returns {import('../resolve/types.js').PlacedGame|null}
 */
function gameOf(context, gameId) {
  return context.state.baseline[gameId] ?? null;
}

/**
 * The finding for a question that named a game nothing holds.
 *
 * @param {import('./types.js').AttributionContext} context
 * @param {string} gameId
 * @returns {import('./types.js').AttributionFinding}
 */
function unknownGameFinding(context, gameId) {
  return makeAttributionFinding(
    ATTRIBUTION_REASON.ATTRIBUTION_GAME_UNKNOWN,
    `no game "${gameId}" is in this schedule, so nothing can be attributed to it; the run holds ${context.state.gameIds.length} games`,
    { gameId, gameCount: context.state.gameIds.length }
  );
}

/**
 * Findings that count against a placement — everything above `info`.
 *
 * @param {ReadonlyArray<import('./types.js').AttributionFinding>} findings
 * @returns {import('./types.js').AttributionFinding[]}
 */
function consequential(findings) {
  return findings.filter((finding) => finding.severity !== ATTRIBUTION_SEVERITY.INFO);
}

/**
 * The registry's own view of a set of findings, at one place on one date.
 *
 * `checkPlacement()` runs everything it reports through this seam — it is the
 * whole mechanism by which hardness is data (`docs/MODEL_GAPS.md` GAP-12) — so
 * `explainGame()` and everything built on it already honours a retyped
 * constraint. The two boundary answers read their owner's findings **directly**,
 * which means the same constraint would read `blocking` in one answer and `info`
 * in the other the moment it is retyped, with nothing to say which to believe.
 * Retyping is what Prompt 2.1 exists to make routine, so both go through the
 * same seam.
 *
 * **The seam's own provenance findings are discarded here, and
 * `checkPlacement()` no longer discards them.** The difference is what each is
 * handed. `checkPlacement()` holds the game, so a `team`-scoped record it left
 * `CONSTRAINT_SCOPE_UNJUDGED` is one it could have judged, and it now returns
 * the seam's report on `registryFindings`. This helper is handed a *place* —
 * `where` carries a surface, a venue and a date and no sides at all, because the
 * two boundary questions are asked of ground on a date rather than of a fixture.
 * An unjudged team scope from here says "the question named no team", which is
 * true of every call and so tells a reader nothing. `explainGame()` and
 * `explainKickoffTime()` reach the game's own verdict through
 * `checkPlacement()`, which is where the sides are.
 *
 * @param {import('./types.js').AttributionContext} context
 * @param {{ surfaceId: string, venueId: string|null, date: string, divisionLabel?: string|null }} where
 * @param {ReadonlyArray<import('./types.js').AttributionFinding>} findings
 * @returns {import('./types.js').AttributionFinding[]}
 */
function underRegistry(context, where, findings) {
  const surface = getSurface(
    /** @type {import('../facility/types.js').FacilityGraph} */ (context.engines.graph),
    where.surfaceId
  );
  const table = effectiveSeverityTable(
    /** @type {import('../constraints/types.js').ConstraintRegistry} */ (context.engines.registry),
    {
      date: where.date,
      // `undefined`, never `null`: `ScopeContextSchema` is `.strict()` and takes
      // an absent venue as "the context does not name one", which is what an
      // unknown surface means. A `null` is a stated venue whose id is nothing,
      // and it is a `ZodError` out of a severity lookup rather than an answer.
      // `feasibility/verdict.js` `underRegistry()` writes the same coalesce for
      // the same reason; this one was a hardcoded `null` at every call site.
      venueId: surface?.venueId ?? where.venueId ?? undefined,
      surfaceId: where.surfaceId,
      surfaceLineage: surface ? [...surface.lineage] : [where.surfaceId],
      ...(where.divisionLabel ? { divisionLabel: where.divisionLabel } : {}),
    }
  );
  return /** @type {import('./types.js').AttributionFinding[]} */ (
    applyRegistrySeverity(
      /** @type {ReadonlyArray<import('../constraints/types.js').ConstraintFinding>} */ (findings),
      table
    ).findings
  );
}

/**
 * Does running past the daylight limit block a kickoff **here, under this context's registry**?
 *
 * `latestLegalKickoff()` reads the frozen severity table by default. A what-if that retypes the
 * sunset margin `hard` makes the registry re-severity the sunset finding to blocking, and the
 * claims below are built from that view, so the search has to be told or it advertises a kickoff
 * (the permit's) that its own sunset claim calls blocking. Asked the way the claims are asked
 * ({@link underRegistry}), so the boundary and the claims read one severity.
 *
 * @param {import('./types.js').AttributionContext} context
 * @param {{ surfaceId: string, venueId: string|null, date: string, divisionLabel?: string|null }} where
 * @returns {boolean}
 */
function sunsetBlocksUnderRegistry(context, where) {
  const [judged] = underRegistry(context, where, [
    /** @type {import('./types.js').AttributionFinding} */ ({
      code: AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED,
      severity: availabilitySeverityOf(AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED),
      message: '',
      details: {},
    }),
  ]);
  return judged.severity === CONSTRAINT_SEVERITY.BLOCKING;
}

/**
 * Turn a set of availability bounds and the findings raised alongside them into
 * claims, plus the bounds that did not apply.
 *
 * **Every consequential finding reaches a claim, and that is the whole point.**
 * `groupFindingsByConstraintKind()`'s own doc-comment says a finding that
 * belongs to no bound must get a claim of its own or it becomes "a blocking
 * violation nothing reported" — and there are *two* ways to belong to no bound,
 * not one. A finding whose code no kind buckets is the obvious one. The other is
 * a finding bucketed under a kind whose bound turned out **inapplicable**: an
 * `OCCUPIED_SAME_SURFACE` against a booking that started *earlier* is filed
 * under `occupancy`, while the occupancy *edge* is inapplicable precisely
 * because nothing starts *later*. Consuming `byKind` only for applicable bounds
 * drops it, and the answer then says "blocked" while carrying no claim that says
 * by what — which is the one thing this module exists to do.
 *
 * So the kinds a bound actually took responsibility for are tracked, and
 * everything else — unbucketed, or bucketed under a kind no bound claimed —
 * becomes a claim in its own right, in the order its owner raised it.
 *
 * Used for the slot a game has, for a slot it does not, and for the latest-legal
 * kickoff query, which is what makes those three answers comparable.
 *
 * @param {ReadonlyArray<import('../availability/types.js').AvailabilityConstraint>} constraints
 * @param {ReadonlyArray<import('./types.js').AttributionFinding>} findings - already re-severitied
 * @param {{ registry: Object, source: string, gameId: string|null, surfaceId: string, venueId: string|null, date: string }} ctx
 * @param {import('./types.js').AttributionMeta} meta
 * @returns {{ claims: import('./types.js').ConstraintClaim[], notApplicable: import('./types.js').InapplicableConstraint[] }}
 */
function claimsFromBounds(constraints, findings, ctx, meta) {
  const grouped = groupFindingsByConstraintKind(consequential(findings));

  /** @type {import('./types.js').ConstraintClaim[]} */
  const bounds = [];
  /** @type {import('./types.js').InapplicableConstraint[]} */
  const notApplicable = [];
  /**
   * The kinds whose findings a bound has already taken responsibility for.
   *
   * @type {Set<string>}
   */
  const boundKinds = new Set();
  for (const constraint of constraints ?? []) {
    meta.availabilityConstraintsConsulted += 1;
    if (!constraint.applicable) {
      notApplicable.push({
        source: ATTRIBUTION_SOURCE.AVAILABILITY,
        kind: constraint.kind,
        reason: String(constraint.detail?.reason ?? 'the machinery that owns it stated no reason'),
      });
      continue;
    }
    boundKinds.add(constraint.kind);
    bounds.push(
      claimFromAvailabilityConstraint(constraint, ctx, grouped.byKind[constraint.kind] ?? [])
    );
  }

  const orphaned = [
    ...Object.entries(grouped.byKind)
      .filter(([kind]) => !boundKinds.has(kind))
      .flatMap(([, group]) => group),
    ...grouped.ungrouped,
  ];
  const others = orphaned.map((finding) =>
    claimFromFinding(finding, {
      registry: ctx.registry,
      source: ctx.source,
      gameId: ctx.gameId,
      surfaceId: ctx.surfaceId,
      venueId: ctx.venueId,
      date: ctx.date,
    })
  );

  return { claims: mergeClaimsByTightness([bounds, others]), notApplicable };
}

/**
 * Turn one `checkPlacement()` result into claims, the constraints that did not
 * apply, and what the registry could not decide about this game.
 *
 * **The third one is round 3's finding 5.** `checkPlacement()` returns the
 * severity seam's own report on `registryFindings` — which records it could not
 * judge here and therefore did not apply — and for a whole round no production
 * caller read it. A field produced and read by nobody is not a middle path
 * between merging the trace and dropping it; it is the appearance of one, and
 * it reached exactly as many reports as the drop did.
 *
 * It is surfaced *here* rather than inside `checkPlacement()` because of what
 * each is. `checkPlacement()` is called once per candidate slot by
 * `resolve/stages.js`, and merging a remark about how the registry was read
 * into `findings` would move `status` for every one of them — that reasoning
 * was sound and stands. `explainGame()` and `explainKickoffTime()` are asked
 * one question at a time, already carry a `findings` array and a `status`
 * derived from it, and hold the **game**, which is what makes an unjudged
 * `person` scope a fact worth reporting rather than the truism it would be from
 * a place-shaped question (see {@link underRegistry}).
 *
 * Only *consequential* seam findings are restated. The two the lookup can raise
 * above `info` — `CONSTRAINT_SCOPE_UNJUDGED` and `CONSTRAINT_WINDOW_UNJUDGED` —
 * both say "could not decide", which is why one code covers them; the `info`
 * provenance below (a retype, a narrower scope applied) is how the registry is
 * *meant* to work and would be noise in an operator's answer.
 *
 * @param {Object} placement - a `checkPlacement()` result
 * @param {{ registry: Object, gameId: string|null, surfaceId: string, venueId: string|null, date: string }} ctx
 * @param {import('./types.js').AttributionMeta} meta
 * @returns {{ claims: import('./types.js').ConstraintClaim[], notApplicable: import('./types.js').InapplicableConstraint[], findings: import('./types.js').AttributionFinding[] }}
 */
function claimsForPlacement(placement, ctx, meta) {
  const availability = /** @type {Object} */ (placement.availability);
  const built = claimsFromBounds(
    availability.constraints ?? [],
    /** @type {import('./types.js').AttributionFinding[]} */ (placement.findings),
    { ...ctx, source: ATTRIBUTION_SOURCE.FACILITY },
    meta
  );

  /** @type {import('./types.js').AttributionFinding[]} */
  const findings = [];
  for (const finding of /** @type {Array<Object>} */ (placement.registryFindings ?? [])) {
    if (finding.severity === ATTRIBUTION_SEVERITY.INFO) continue;
    meta.registryRecordsUnjudged += 1;
    const details = /** @type {Record<string, unknown>} */ (finding.details ?? {});
    findings.push(
      makeAttributionFinding(
        ATTRIBUTION_REASON.ATTRIBUTION_CONSTRAINT_UNJUDGED,
        `the registry could not be read cleanly for game "${ctx.gameId}" at ${ctx.surfaceId} on ${ctx.date}, so a record was not applied to it: ${finding.message}`,
        {
          gameId: ctx.gameId,
          surfaceId: ctx.surfaceId,
          date: ctx.date,
          seamCode: finding.code,
          constraintId: details.constraintId ?? null,
          scopeKind: details.scopeKind ?? null,
        }
      )
    );
  }

  return { ...built, findings };
}

/**
 * **Why is this game where it is?** — the attribution every other answer is
 * built on.
 *
 * @param {import('./types.js').AttributionContext} context
 * @param {Object} rawQuery - see `GameAttributionQuerySchema`
 * @returns {import('./types.js').GameAttribution}
 */
export function explainGame(context, rawQuery) {
  const query = GameAttributionQuerySchema.parse(rawQuery);
  const meta = createAttributionMeta();
  /** @type {import('./types.js').AttributionFinding[]} */
  const findings = [...context.findings];
  const game = gameOf(context, query.gameId);

  if (game === null) {
    findings.push(unknownGameFinding(context, query.gameId));
    return {
      gameId: query.gameId,
      label: '',
      slot: { date: '', surfaceId: '', startMinutes: 0 },
      endMinutes: null,
      format: null,
      claims: [],
      binding: null,
      bindingKinds: [],
      notApplicable: [],
      blockingCodes: [],
      legal: false,
      placementStatus: '',
      findings,
      meta,
      status: deriveAttributionStatus(findings),
    };
  }

  meta.gamesExamined += 1;
  const slot = {
    date: game.date,
    surfaceId: game.surfaceId,
    startMinutes: game.startMinutes,
  };
  const placement = checkPlacement(context.engines, context.state, query.gameId, slot);
  meta.placementChecksRun += 1;

  const ctx = {
    registry: context.engines.registry,
    gameId: query.gameId,
    surfaceId: slot.surfaceId,
    venueId: game.venueId,
    date: slot.date,
  };
  const placed = claimsForPlacement(placement, ctx, meta);
  findings.push(...placed.findings);

  /** @type {import('./types.js').ConstraintClaim[]} */
  const violationClaims = [];
  for (const violation of violationsAbout(context.verification, query.gameId)) {
    meta.violationsConsulted += 1;
    violationClaims.push(claimFromViolation(violation));
  }

  const claims = mergeClaimsByTightness([placed.claims, violationClaims]);
  findings.push(...categoryOnlyClaimFindings(claims, { gameId: query.gameId }, meta));

  if (claims.length === 0) {
    findings.push(
      makeAttributionFinding(
        ATTRIBUTION_REASON.ATTRIBUTION_GAME_UNATTRIBUTED,
        `game "${query.gameId}" produced no claim at all: nothing this run holds bounds it, forbids it or permits it, which is a gap in the model rather than a clean bill of health`,
        { gameId: query.gameId, date: slot.date, surfaceId: slot.surfaceId }
      )
    );
  } else {
    meta.gamesAttributed += 1;
  }

  return {
    gameId: query.gameId,
    label: `${game.homeLabel} v ${game.awayLabel}`,
    slot,
    endMinutes: /** @type {number|null} */ (placement.availability.endMinutes ?? null),
    format: game.format,
    claims,
    binding: claims.find((claim) => claim.binding) ?? null,
    bindingKinds: [...(placement.availability.bindingKinds ?? [])],
    notApplicable: placed.notApplicable,
    blockingCodes: [...placement.blockingCodes],
    legal: placement.legal,
    placementStatus: placement.status,
    findings,
    meta,
    status: deriveAttributionStatus(findings),
  };
}

/**
 * **"Why is this game at 12:00 and not 12:30?"**
 *
 * Both halves, always: what bounds the slot the game has, and what the
 * alternative would break. The corpus's own instance of this question is the
 * 08/22 seeding pair — the external league published 12:30, the club agreed
 * 12:00, and the reason is that at 12:30 an 11v11 on Alder Pitch 2 overlaps the
 * already-published 9v9 games on Pitches 1A and 1B by ten minutes. That answer
 * is `checkPlacement()`'s, not this function's.
 *
 * @param {import('./types.js').AttributionContext} context
 * @param {Object} rawQuery - see `AlternativeTimeQuerySchema`
 * @returns {import('./types.js').TimeAttribution}
 */
export function explainKickoffTime(context, rawQuery) {
  const query = AlternativeTimeQuerySchema.parse(rawQuery);
  const meta = createAttributionMeta();
  const current = explainGame(context, { gameId: query.gameId });
  // The half of the answer that `explainGame()` did is work this answer did.
  // Leaving it out reports `gamesExamined: 0` after examining a game and one
  // placement check after two — and the counters are exactly how a caller tells
  // "nothing applied" from "nothing was checked".
  mergeAttributionMeta(meta, current.meta);
  const game = gameOf(context, query.gameId);
  /** @type {import('./types.js').AttributionFinding[]} */
  const findings = [...current.findings];

  const alternative = {
    date: query.insteadOfDate ?? current.slot.date,
    surfaceId: query.insteadOfSurfaceId ?? current.slot.surfaceId,
    startMinutes: query.insteadOfMinutes,
  };

  /** @type {import('./types.js').TimeAttribution} */
  const answer = {
    question: ATTRIBUTION_QUESTION.WHY_THIS_TIME,
    gameId: query.gameId,
    label: current.label,
    slot: current.slot,
    alternative,
    current,
    counterfactual: {
      legal: false,
      placementStatus: '',
      claims: [],
      binding: null,
      blockingCodes: [],
      counterpartGameIds: [],
      constraintIds: [],
    },
    findings,
    meta,
    status: '',
  };

  if (game === null) return { ...answer, status: deriveAttributionStatus(findings) };

  if (slotKey(alternative) === slotKey(current.slot)) {
    findings.push(
      makeAttributionFinding(
        ATTRIBUTION_REASON.ATTRIBUTION_ALTERNATIVE_NO_OP,
        `the alternative asked about is the slot game "${query.gameId}" already occupies (${slotKey(alternative)}), so the comparison is between a thing and itself and its empty answer means nothing`,
        { gameId: query.gameId, slot: slotKey(alternative) }
      )
    );
    return { ...answer, status: deriveAttributionStatus(findings) };
  }

  const placement = checkPlacement(context.engines, context.state, query.gameId, alternative);
  meta.placementChecksRun += 1;
  const ctx = {
    registry: context.engines.registry,
    gameId: query.gameId,
    surfaceId: alternative.surfaceId,
    venueId: game.venueId,
    date: alternative.date,
  };
  const placed = claimsForPlacement(placement, ctx, meta);
  findings.push(...placed.findings);
  findings.push(
    ...categoryOnlyClaimFindings(
      placed.claims,
      { gameId: query.gameId, slot: slotKey(alternative) },
      meta
    )
  );

  const constraintIds = registryConstraintIdsFor(context.engines.registry, placement.blockingCodes);
  const blocking = placed.claims.filter(
    (claim) => claim.severity === ATTRIBUTION_SEVERITY.BLOCKING
  );
  const binding = blocking[0] ?? placed.claims.find((claim) => claim.binding) ?? null;

  // **The margin, reported only when there is one.** A claim's `slackMinutes` is
  // the room left against *its own* bound. The occupancy edge measures the gap to
  // the next booking, which is a different question from how deeply this game
  // would run into one that started *earlier* — and a permit that closes hours
  // later measures nothing about an overlap at all. Rendering `-slackMinutes`
  // regardless turned 15 minutes of room into `by -15 min` and a permit with 405
  // minutes of headroom into `by -405 min`: a confident number about a constraint
  // that blocked nothing. So the margin is taken only from the claim that
  // actually blocked the placement, and only when its owner reported that bound
  // as broken. Otherwise the answer says the margin is not available rather than
  // inventing one; the codes, the constraints and the counterpart games are the
  // answer, and they are all still there.
  const marginMinutes =
    binding !== null &&
    binding.severity === ATTRIBUTION_SEVERITY.BLOCKING &&
    binding.slackMinutes !== null &&
    binding.slackMinutes < 0
      ? binding.slackMinutes
      : null;

  findings.push(
    placement.legal
      ? makeAttributionFinding(
          ATTRIBUTION_REASON.ATTRIBUTION_ALTERNATIVE_LEGAL,
          `game "${query.gameId}" would also be legal at minute ${alternative.startMinutes} on ${alternative.surfaceId}: its time is not forced by anything this run holds`,
          {
            gameId: query.gameId,
            fromMinutes: current.slot.startMinutes,
            toMinutes: alternative.startMinutes,
          }
        )
      : makeAttributionFinding(
          ATTRIBUTION_REASON.ATTRIBUTION_ALTERNATIVE_BLOCKED,
          `game "${query.gameId}" stands at minute ${current.slot.startMinutes} rather than minute ${alternative.startMinutes} because at minute ${alternative.startMinutes} it breaks ${placement.blockingCodes.join(', ')} (${constraintIds.join(', ') || 'no registry constraint claims those codes'})${
            marginMinutes === null
              ? ', by a margin nothing that blocked it measures'
              : `, by ${-marginMinutes} min`
          }${
            placement.counterpartGameIds.length > 0
              ? `, against ${placement.counterpartGameIds.join(', ')}`
              : ''
          }`,
          {
            gameId: query.gameId,
            fromMinutes: current.slot.startMinutes,
            toMinutes: alternative.startMinutes,
            constraintIds,
            constraintId: constraintIds[0] ?? null,
            counterpartGameIds: [...placement.counterpartGameIds],
            slackMinutes: marginMinutes,
          }
        )
  );

  return {
    ...answer,
    counterfactual: {
      legal: placement.legal,
      placementStatus: placement.status,
      claims: placed.claims,
      binding,
      blockingCodes: [...placement.blockingCodes],
      counterpartGameIds: [...placement.counterpartGameIds],
      constraintIds,
    },
    findings,
    status: deriveAttributionStatus(findings),
  };
}

/**
 * **"Why can't this game go later?"** — the latest legal kickoff, and which of
 * the four edges sets it.
 *
 * The whole answer comes from `latestLegalKickoff()`, including the ordering:
 * *"sunset, and then the permit with two hours of slack"* is
 * `orderByTightness()`'s sentence, not one composed here.
 *
 * @param {import('./types.js').AttributionContext} context
 * @param {Object} rawQuery - see `LatestKickoffQuestionSchema`
 * @returns {import('./types.js').BoundaryAttribution}
 */
export function explainLatestKickoff(context, rawQuery) {
  const query = LatestKickoffQuestionSchema.parse(rawQuery);
  const meta = createAttributionMeta();
  /** @type {import('./types.js').AttributionFinding[]} */
  const findings = [...context.findings];
  const game = gameOf(context, query.gameId);

  if (game === null) {
    findings.push(unknownGameFinding(context, query.gameId));
    return {
      question: ATTRIBUTION_QUESTION.WHY_NOT_LATER,
      gameId: query.gameId,
      surfaceId: '',
      date: '',
      format: null,
      kickoffMinutes: null,
      headroomMinutes: null,
      claims: [],
      binding: null,
      bindingKinds: [],
      notApplicable: [],
      findings,
      meta,
      status: deriveAttributionStatus(findings),
    };
  }

  const result = latestLegalKickoff(
    context.engines.graph,
    context.engines.table,
    context.engines.calendar,
    {
      surfaceId: game.surfaceId,
      date: game.date,
      format: game.format,
      notBeforeMinutes: game.startMinutes,
      notAfterMinutes: query.notAfterMinutes,
      ignoreBookingIds: [query.gameId],
    },
    {
      existingBookings: bookingsOn(context.state, game.date, query.gameId),
      sunsetBlocks: sunsetBlocksUnderRegistry(context, {
        surfaceId: game.surfaceId,
        venueId: game.venueId,
        date: game.date,
        divisionLabel: game.divisionLabel ?? null,
      }),
    }
  );
  meta.boundaryQueriesRun += 1;

  const ctx = {
    registry: context.engines.registry,
    source: ATTRIBUTION_SOURCE.FACILITY,
    gameId: query.gameId,
    surfaceId: game.surfaceId,
    venueId: game.venueId,
    date: game.date,
  };
  const bounded = claimsFromBounds(
    result.constraints,
    underRegistry(
      context,
      {
        surfaceId: game.surfaceId,
        venueId: game.venueId,
        date: game.date,
        divisionLabel: game.divisionLabel ?? null,
      },
      /** @type {import('./types.js').AttributionFinding[]} */ (result.findings)
    ),
    ctx,
    meta
  );
  const claims = bounded.claims;
  const notApplicable = bounded.notApplicable;
  findings.push(...categoryOnlyClaimFindings(claims, { gameId: query.gameId }, meta));

  if (result.bindingKinds.length === 0) {
    findings.push(
      makeAttributionFinding(
        ATTRIBUTION_REASON.ATTRIBUTION_BOUND_UNSTATED,
        `nothing this run holds bounds how late game "${query.gameId}" may kick off on ${game.date}; the answer is the top of the searched range rather than a limit anybody stated`,
        { gameId: query.gameId, date: game.date, surfaceId: game.surfaceId }
      )
    );
  }

  return {
    question: ATTRIBUTION_QUESTION.WHY_NOT_LATER,
    gameId: query.gameId,
    surfaceId: game.surfaceId,
    date: game.date,
    format: game.format,
    kickoffMinutes: result.kickoffMinutes,
    headroomMinutes:
      result.kickoffMinutes === null ? null : result.kickoffMinutes - game.startMinutes,
    claims,
    binding: claims.find((claim) => claim.binding) ?? null,
    bindingKinds: [...result.bindingKinds],
    notApplicable,
    findings,
    meta,
    status: deriveAttributionStatus(findings),
  };
}

/**
 * **"What's the earliest kickoff allowing a full 30-minute warm-up?"**
 *
 * Incident 8, asked as one call. `earliestKickoffWithWarmup()` answers it and
 * reports which booking bounded the warm-up start; the point of the incident is
 * that the booking is usually on **overlapping ground rather than the pitch
 * itself**, and the claim carries both surfaces so the answer says so.
 *
 * The warm-up length is a policy the caller states. It is never defaulted: an
 * unstated warm-up is `WARMUP_DURATION_UNSPECIFIED` from the timing module, and
 * a silently applied 30 would disguise an invention as data.
 *
 * @param {import('./types.js').AttributionContext} context
 * @param {Object} rawQuery - see `EarliestKickoffQuestionSchema`
 * @returns {import('./types.js').BoundaryAttribution}
 */
export function explainEarliestKickoff(context, rawQuery) {
  const query = EarliestKickoffQuestionSchema.parse(rawQuery);
  const meta = createAttributionMeta();
  /** @type {import('./types.js').AttributionFinding[]} */
  const findings = [...context.findings];

  const ignored = new Set(query.ignoreGameIds);
  const existingBookings = bookingsOn(context.state, query.date, '').filter(
    (booking) => !ignored.has(booking.id)
  );

  const result = earliestKickoffWithWarmup(
    context.engines.graph,
    context.engines.table,
    {
      surfaceId: query.surfaceId,
      date: query.date,
      format: query.format,
      warmupMinutes: query.warmupMinutes,
      notBeforeMinutes: query.notBeforeMinutes,
      notAfterMinutes: query.notAfterMinutes,
      ignoreBookingIds: [...ignored],
    },
    { existingBookings }
  );
  meta.boundaryQueriesRun += 1;

  const bound = claimFromWarmupBound(result, {
    registry: context.engines.registry,
    surfaceId: query.surfaceId,
    date: query.date,
  });
  const others = consequential(
    underRegistry(
      context,
      { surfaceId: query.surfaceId, venueId: null, date: query.date },
      /** @type {import('./types.js').AttributionFinding[]} */ (result.findings)
    )
  ).map((finding) =>
    claimFromFinding(finding, {
      registry: context.engines.registry,
      source: ATTRIBUTION_SOURCE.WARMUP,
      gameId: null,
      surfaceId: query.surfaceId,
      venueId: null,
      date: query.date,
    })
  );
  const claims = mergeClaimsByTightness([bound === null ? [] : [bound], others]);
  findings.push(
    ...categoryOnlyClaimFindings(claims, { surfaceId: query.surfaceId, date: query.date }, meta)
  );

  if (result.kickoffMinutes === null) {
    // **What actually happened, not what a search would have looked like.** An
    // unstated warm-up length stops `earliestKickoffWithWarmup()` before it
    // tests a single candidate, and a format with no timing row stops it before
    // that; "no kickoff in the range that was searched" describes work none of
    // those three cases did. The counter is the owner's own.
    const tested = /** @type {number} */ (result.candidatesTested ?? 0);
    const warmupMinutes = /** @type {number|null} */ (result.warmupMinutes ?? null);
    const what =
      warmupMinutes === null
        ? 'no warm-up length was stated, so no candidate kickoff was tested at all'
        : tested === 0
          ? `no candidate kickoff was tested between minute ${query.notBeforeMinutes} and minute ${query.notAfterMinutes}`
          : `${tested} candidate kickoff(s) were tested between minute ${query.notBeforeMinutes} and minute ${query.notAfterMinutes} and none yields a full ${warmupMinutes} min warm-up`;
    findings.push(
      makeAttributionFinding(
        ATTRIBUTION_REASON.ATTRIBUTION_QUESTION_UNANSWERABLE,
        `no kickoff on ${query.date} can be reported as the earliest with a full warm-up on ${query.surfaceId}: ${what}, so there is no boundary to attribute`,
        {
          surfaceId: query.surfaceId,
          date: query.date,
          notBeforeMinutes: query.notBeforeMinutes,
          notAfterMinutes: query.notAfterMinutes,
          candidatesTested: tested,
          warmupMinutes,
        }
      )
    );
  } else if (bound === null) {
    findings.push(
      makeAttributionFinding(
        ATTRIBUTION_REASON.ATTRIBUTION_BOUND_UNSTATED,
        `the earliest allowed warm-up start on ${query.date} was already free, so the answer is the floor the question named rather than a bound anything set`,
        { surfaceId: query.surfaceId, date: query.date, notBeforeMinutes: query.notBeforeMinutes }
      )
    );
  }

  return {
    question: ATTRIBUTION_QUESTION.EARLIEST_KICKOFF,
    gameId: null,
    surfaceId: query.surfaceId,
    date: query.date,
    format: query.format,
    kickoffMinutes: result.kickoffMinutes,
    headroomMinutes: null,
    claims,
    binding: claims.find((claim) => claim.binding) ?? null,
    bindingKinds: bound === null ? [] : [bound.kind],
    notApplicable: [],
    findings,
    meta,
    status: deriveAttributionStatus(findings),
  };
}

/**
 * **"Why did this team get a conflict?"**
 *
 * The conflict itself is `evaluateCoachTravel()`'s — the gap, the floor it was
 * judged against, the shortfall, and which of the two floors applied. What this
 * adds is the join a human was doing by hand: *which* other team the coach is
 * committed to, *which* game of theirs, how many minutes apart the two kick off,
 * and — from `soleCoachRiskRegister()` and `coCoachesOf()` — whether that team
 * had anybody else who could have covered, by name.
 *
 * The team universe is read from the schedule's own `teamUniverse`, never
 * enumerated from the commitments: a team whose commitments a broken join
 * dropped would otherwise come back "no conflict" instead of "unknown".
 *
 * @param {import('./types.js').AttributionContext} context
 * @param {Object} rawQuery - see `TeamConflictQuerySchema`
 * @returns {import('./types.js').ConflictAttribution}
 */
export function explainTeamConflict(context, rawQuery) {
  const query = TeamConflictQuerySchema.parse(rawQuery);
  const meta = createAttributionMeta();
  /** @type {import('./types.js').AttributionFinding[]} */
  const findings = [...context.findings];
  /** @type {import('./types.js').ConflictAttribution} */
  const answer = {
    question: ATTRIBUTION_QUESTION.TEAM_CONFLICT,
    teamId: query.teamId,
    conflicts: [],
    claims: [],
    binding: null,
    findings,
    meta,
    status: '',
  };

  if (!context.schedule.teamUniverse.includes(query.teamId)) {
    findings.push(
      makeAttributionFinding(
        ATTRIBUTION_REASON.ATTRIBUTION_TEAM_UNKNOWN,
        `"${query.teamId}" is not one of the ${context.schedule.teamUniverse.length} team identifiers this schedule declares, so "no conflict" would be an answer about nothing`,
        { teamId: query.teamId, teamCount: context.schedule.teamUniverse.length }
      )
    );
    return { ...answer, status: deriveAttributionStatus(findings) };
  }

  if (context.travel === null) {
    // The context already carries `ATTRIBUTION_TRAVEL_ABSENT` at `compromise`,
    // which is what stops this empty answer reading as "no conflict".
    return { ...answer, status: deriveAttributionStatus(findings) };
  }

  /** @type {import('./types.js').ConflictAttribution['conflicts']} */
  const conflicts = [];
  /** @type {import('./types.js').ConstraintClaim[][]} */
  const groups = [];

  for (const transition of context.travel.transitions) {
    meta.transitionsConsulted += 1;
    const teamIds = [transition.from.teamId, transition.to.teamId];
    if (!teamIds.includes(query.teamId)) continue;
    if (query.date !== null && transition.date !== query.date) continue;
    const spoke = consequential(transition.findings);
    if (spoke.length === 0) continue;

    const travelClaims = spoke.map((finding) => claimFromTravelTransition(transition, finding));
    const counterpartTeamIds = [
      ...new Set(teamIds.filter((id) => typeof id === 'string' && id !== query.teamId)),
    ].sort();

    /** @type {import('./types.js').ConstraintClaim[]} */
    const rosterClaims = [];
    if (context.soleCoach !== null) {
      for (const finding of context.soleCoach.findings) {
        const details = /** @type {Record<string, unknown>} */ (finding.details ?? {});
        if (details.personId !== transition.personId) continue;
        const aboutTeam = typeof details.teamId === 'string' ? details.teamId : null;
        if (aboutTeam !== null && !teamIds.includes(aboutTeam)) continue;
        meta.rosterEntriesConsulted += 1;
        rosterClaims.push(
          claimFromRosterFinding(finding, {
            teamId: aboutTeam ?? query.teamId,
            personId: transition.personId,
          })
        );
      }
    }

    // Who *could* have taken the other fixture, from the roster rather than
    // from anything inferred here. An empty list beside a `TEAM_SOLE_COACH`
    // claim is the same fact twice from two independent roster functions, and
    // that is the point: the claim is the finding an operator reads, and this is
    // the list they act on.
    /** @type {string[]} */
    const coverPersonIds = [];
    if (context.roster !== null) {
      for (const teamId of counterpartTeamIds) {
        meta.rosterEntriesConsulted += 1;
        for (const personId of coCoachesOf(context.roster, teamId, transition.personId)) {
          if (!coverPersonIds.includes(personId)) coverPersonIds.push(personId);
        }
      }
    }

    const claims = mergeClaimsByTightness([travelClaims, rosterClaims]);
    groups.push(claims);
    conflicts.push({
      transitionId: transition.id,
      personId: transition.personId,
      date: transition.date,
      counterpartTeamIds: /** @type {string[]} */ (counterpartTeamIds),
      coverPersonIds: coverPersonIds.sort(),
      counterpartGameIds: [
        ...new Set(
          [transition.from.gameId, transition.to.gameId].filter(
            (id) => typeof id === 'string' && id.length > 0
          )
        ),
      ].sort(),
      claims,
      binding: claims.find((claim) => claim.binding) ?? null,
    });
  }

  const claims = mergeClaimsByTightness(groups);
  findings.push(...categoryOnlyClaimFindings(claims, { teamId: query.teamId }, meta));

  if (conflicts.length === 0) {
    findings.push(
      makeAttributionFinding(
        ATTRIBUTION_REASON.ATTRIBUTION_TEAM_NO_CONFLICT,
        `no transition on any coach's day involves team "${query.teamId}" and carries a finding above info; ${meta.transitionsConsulted} transitions were examined`,
        { teamId: query.teamId, transitionsExamined: meta.transitionsConsulted }
      )
    );
  }

  return {
    ...answer,
    conflicts,
    claims,
    binding: claims.find((claim) => claim.binding) ?? null,
    findings,
    status: deriveAttributionStatus(findings),
  };
}
