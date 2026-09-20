/**
 * Barrel for the read-only feasibility API.
 *
 * Every public export of `feasibility/` goes through this file, exactly as
 * `facility/index.js`, `timing/index.js`, `availability/index.js`,
 * `constraints/index.js`, `waivers/index.js`, `ruleEngine/index.js`,
 * `people/index.js`, `freeze/index.js`, `resolve/index.js`,
 * `attribution/index.js`, `reserve/index.js`, `publication/index.js` and
 * `scenario/index.js` do for theirs.
 *
 * ## What this module is
 *
 * The layer an administrator actually touches. *Can this game move to Thursday?
 * Can this team play at 6pm in November? What is stopping it?* — asked as one
 * call each, answered with a verdict, the constraint(s) that decided it, and a
 * margin in minutes.
 *
 * Prompt 8.7 adds a fourth question with a different shape: *a parent asked to
 * move this into that window — what can the club offer?* It is the only query
 * here that looks at anybody but the subject, and the only one that prices what
 * an exchange would cost the other party. `feasibility/moveRequest.js` says why
 * it judges a position through the availability layer rather than through
 * `canGameMove()`, and what that costs its answers.
 *
 * It decides nothing on its own. Every number it reports was computed by the
 * module that owns the question, and the whole package is a coherent shape over
 * those answers plus two things no earlier module could do: hold a verdict open
 * as `unknown`, and report the *second* threshold — the line between legal and
 * comfortable.
 *
 * ## What it deliberately is not
 *
 * - **Not a writer.** Strictly read-only, and that is a tested property rather
 *   than a promise: `tests/feasibilityApi.test.js` deep-freezes every input —
 *   graph, timing table, calendar, registry, schedule, context and state — and
 *   runs every query against them. `applyMove()`, `resolve/`'s only writer, is
 *   called nowhere here; nothing is persisted; no re-solve is committed. Where a
 *   trial placement is needed it is derived inside the call that needs it and
 *   thrown away with the return value.
 * - **Not a second evaluator.** There is no overlap test, no permit parser, no
 *   travel arithmetic and no tightness comparison over the four edges in this
 *   package. There is one search — the clean boundary — and every candidate it
 *   generates is *confirmed* through `checkKickoffAvailability()` rather than
 *   believed.
 * - **Not a solver.** It never proposes a repair and never moves a game. It says
 *   what is true of a position somebody else names.
 * - **Not persisted.** In-memory only, consistently with Phases 1-6. There is no
 *   SQL home for a feasibility answer and this work deliberately does not create
 *   one.
 * - **Not an adapter's business.** Like `attribution/`, this ships no
 *   `adapters/season2026*.js`, because it reads no corpus shape: it takes the
 *   engines the other adapters already built.
 *
 * ## The context
 *
 * A feasibility query is asked of an `AttributionContext` —
 * `attribution/context.js`'s `buildAttributionContext()`. There is deliberately
 * no second context builder: 4.3 already assembles the graph, the timing table,
 * the calendar, the registry, a rule-engine run, a coach-travel evaluation and a
 * roster, freezes every game in the `ResolveState` it derives, and *states what
 * it was built without*. A context missing its rule-engine run makes a
 * feasibility verdict `unknown` rather than `feasible`, which is the whole
 * design carried through from one layer to the next.
 *
 * @module feasibility
 */

export {
  MOVE_REQUEST_CLASS,
  MOVE_REQUEST_CLASS_ORDER,
  MOVE_REQUEST_ENTITY,
  FEASIBILITY_MARGIN_CONVENTION,
  FEASIBILITY_MARGIN_UNIT,
  FEASIBILITY_QUESTION,
  FEASIBILITY_REASON,
  FEASIBILITY_REASON_SEVERITY,
  FEASIBILITY_SEVERITY,
  FEASIBILITY_SEVERITY_EFFECT,
  FEASIBILITY_STATUS,
  FEASIBILITY_THRESHOLD,
  FEASIBILITY_TIGHTNESS,
  FEASIBILITY_UNKNOWN_BY_CODE,
  FEASIBILITY_VERDICT,
  FEASIBILITY_VERDICT_ORDER,
  assertFeasibilityFindings,
  createFeasibilityMeta,
  deriveFeasibilityEvidence,
  deriveFeasibilityStatus,
  deriveFeasibilityTightness,
  deriveFeasibilityVerdict,
  feasibilitySeverityOf,
  makeFeasibilityFinding,
  mergeFeasibilityMeta,
} from './reasonCodes.js';

export {
  KickoffBoundsQuerySchema,
  MoveFeasibilityQuerySchema,
  MoveRequestHoldingSchema,
  MoveRequestQuerySchema,
  TeamFeasibilityQuerySchema,
} from './schemas.js';

export {
  absorbUnknowns,
  assertBoundaryResult,
  bindingAt,
  blockingEvidenceOf,
  boundFindings,
  boundsOf,
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

export { canGameMove, canTeamPlay, feasibleKickoffBounds } from './queries.js';

export { analyseMoveRequest, classifyMoveRequest } from './moveRequest.js';
