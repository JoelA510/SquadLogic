/**
 * Machine-readable reason codes for the change-request re-solver.
 *
 * Same two rules as the six modules before it:
 *
 * 1. **`code` is the contract, `message` is decoration.** Never parse a message.
 * 2. **Severity lives in a table, never at a call site.**
 *
 * Severities and statuses come from `freeze/reasonCodes.js`, which takes them
 * from `constraints/reasonCodes.js`, which takes them from the facility module.
 * A resolve finding therefore lands in the same list as a facility one and
 * {@link deriveResolveStatus} reads nothing but `finding.severity`.
 *
 * @module resolve/reasonCodes
 */

import { FREEZE_SEVERITY, FREEZE_STATUS, deriveFreezeStatus } from '../freeze/reasonCodes.js';

/**
 * How badly a finding counts.
 *
 * @readonly
 * @enum {string}
 */
export const RESOLVE_SEVERITY = FREEZE_SEVERITY;

/**
 * The three-state outcome of a resolve run.
 *
 * @readonly
 * @enum {string}
 */
export const RESOLVE_STATUS = FREEZE_STATUS;

/**
 * Every reason the re-solver can give.
 *
 * @readonly
 * @enum {string}
 */
export const RESOLVE_REASON = Object.freeze({
  /* -- the run itself -------------------------------------------------------- */
  /**
   * The run had no games, or a change request had no changes.
   *
   * `blocking`. Incident 4: a run that examined nothing must never read as a
   * run that found nothing wrong.
   */
  RESOLVE_RUN_VACUOUS: 'RESOLVE_RUN_VACUOUS',
  /**
   * The whole run considered **zero** moves.
   *
   * `compromise`. Distinct from `RESOLVE_RUN_VACUOUS`: the run had games and
   * changes and still never asked the freeze a single question, which means the
   * "no frozen game moved" verdict below it is worth nothing.
   */
  RESOLVE_NOTHING_CONSIDERED: 'RESOLVE_NOTHING_CONSIDERED',

  /* -- the change request ---------------------------------------------------- */
  /** The change names a game the baseline does not hold. `blocking`. */
  RESOLVE_CHANGE_UNKNOWN_GAME: 'RESOLVE_CHANGE_UNKNOWN_GAME',
  /** The change asks for the slot the game already occupies. Provenance. */
  RESOLVE_CHANGE_NO_OP: 'RESOLVE_CHANGE_NO_OP',
  /** The change was applied exactly as asked. Provenance. */
  RESOLVE_CHANGE_APPLIED: 'RESOLVE_CHANGE_APPLIED',
  /**
   * The change names a game the plan freezes.
   *
   * `blocking`, and the correct answer rather than a fault: an operator who
   * froze `9v9 on 08/22` and then asked to move a 9v9 game on 08/22 has asked
   * for two contradictory things, and the resolver refuses rather than choosing
   * for them.
   */
  RESOLVE_CHANGE_REFUSED_FROZEN: 'RESOLVE_CHANGE_REFUSED_FROZEN',
  /**
   * The requested slot is not legal and the game was placed elsewhere.
   *
   * `compromise`. This is incident 3's actual resolution, made mechanical: the
   * external league's published 12:30 could not stand beside a frozen 9v9
   * block, so the fixture went to the nearest slot the schedule already used —
   * 12:00, thirty minutes earlier, which is exactly what the humans negotiated.
   */
  RESOLVE_CHANGE_DISPLACED: 'RESOLVE_CHANGE_DISPLACED',
  /**
   * A change asked for a slot the baseline schedule never used.
   *
   * Provenance, and deliberately allowed: an externally-published fixture
   * brings its own time and the club does not get to invent one for it. It is
   * recorded because every *other* slot in this run comes from the baseline's
   * own inventory, and the one exception should be visible.
   */
  RESOLVE_CHANGE_SLOT_OUTSIDE_INVENTORY: 'RESOLVE_CHANGE_SLOT_OUTSIDE_INVENTORY',
  /**
   * The games a change request moved were pinned at the slots it named.
   *
   * Provenance for `holdChanges`. The right setting for an externally-published
   * fixture: the request states a fact rather than a preference, so a slot the
   * fact cannot occupy becomes a contradiction to raise rather than a request
   * to quietly reinterpret.
   */
  RESOLVE_CHANGE_PINNED: 'RESOLVE_CHANGE_PINNED',

  /* -- placement ------------------------------------------------------------- */
  /** A thawed game was lifted out of a slot that stopped being legal. */
  RESOLVE_GAME_DISLODGED: 'RESOLVE_GAME_DISLODGED',
  /** A dislodged game found a slot. Provenance. */
  RESOLVE_GAME_REPLACED: 'RESOLVE_GAME_REPLACED',
  /**
   * A thawed game has no legal slot left and is carried as TIME TBD.
   *
   * `compromise`, never silence. Incident 10: one fixture in a reduced-venue
   * scenario genuinely had nowhere to go, and it stayed visible with a reason
   * rather than being dropped.
   */
  RESOLVE_GAME_TIME_TBD: 'RESOLVE_GAME_TIME_TBD',
  /**
   * A **frozen** game's slot is not legal and it may not move.
   *
   * `blocking`, and never conflated with `RESOLVE_GAME_TIME_TBD`. A thawed
   * game with nowhere to go is a scheduling problem; a frozen game with nowhere
   * to go is a contradiction between two things an operator asserted, and it
   * accompanies a thrown `FrozenGameUnsatisfiable` unless the caller asked for
   * it to be reported instead.
   */
  RESOLVE_FROZEN_GAME_UNSATISFIABLE: 'RESOLVE_FROZEN_GAME_UNSATISFIABLE',
  /**
   * A stage tried to place a game on a slot the baseline never used.
   *
   * `blocking`. The anti-third-solver guard at the chokepoint: this package
   * re-places existing games onto kickoffs and surfaces the schedule already
   * had, and a slot from anywhere else means something in here started
   * inventing.
   */
  RESOLVE_SLOT_OUTSIDE_INVENTORY: 'RESOLVE_SLOT_OUTSIDE_INVENTORY',

  /* -- verification ---------------------------------------------------------- */
  /**
   * The standing rule engine reports a violation on the resolved schedule that
   * the baseline did not carry.
   *
   * `compromise`. The resolver repairs *facility legality* — occupancy,
   * permits, lighting, daylight, size, lining. Turnover floors, round-robin
   * completeness and coach travel are the rule engine's, and a change that
   * breaks one of them is reported here rather than quietly repaired. Prompt
   * 4.2's objective weighs them, so a placer choosing between two legal slots
   * prefers the one that breaks fewer; nothing re-solves a season to improve
   * one, and this code is how the difference stays visible.
   */
  RESOLVE_VERIFY_NEW_VIOLATION: 'RESOLVE_VERIFY_NEW_VIOLATION',

  /* -- the objective, the budget and the dry run (Prompt 4.2) ---------------- */
  /**
   * This run is a **proposal**. Nothing has been committed.
   *
   * Provenance, and on every single run: a re-solve is a dry run by
   * construction, and `commitResolve()` is the separate, named step that turns
   * one into a schedule. The code exists so that "was this committed?" is
   * answerable from the findings an operator is already reading rather than
   * from a field they have to know to look for.
   */
  RESOLVE_DRY_RUN: 'RESOLVE_DRY_RUN',
  /**
   * The run was scored under weights the caller supplied. Provenance.
   *
   * A report whose numbers came from a non-default objective must say so, or
   * two runs of the same change request are silently incomparable.
   */
  RESOLVE_OBJECTIVE_WEIGHTS_OVERRIDDEN: 'RESOLVE_OBJECTIVE_WEIGHTS_OVERRIDDEN',
  /**
   * Every change term is weighted zero: this run was scored with **change
   * minimisation switched off**.
   *
   * `compromise`. It is a legitimate thing to ask for — it is the objective
   * incident 1's solver had, and the positive control that measures what freeze
   * prevents needs it — and it must never be mistaken for an ordinary run. A
   * schedule produced this way is the *best* one the placer could find rather
   * than the *nearest* one, which is the whole distinction Prompt 4.2 exists to
   * make.
   */
  RESOLVE_OBJECTIVE_CHANGE_TERM_DISABLED: 'RESOLVE_OBJECTIVE_CHANGE_TERM_DISABLED',
  /**
   * More games moved than the change budget allows.
   *
   * `blocking`, and the finding carries the constraint ids that forced the
   * consequential moves. *"Exceeding it is a failure with an explanation, not a
   * silent large diff."* `commitResolve()` refuses such a run outright and does
   * not offer an override: a caller who is willing to move more games says so
   * by naming a bigger number, which leaves a record of what they agreed to.
   */
  RESOLVE_CHANGE_BUDGET_EXCEEDED: 'RESOLVE_CHANGE_BUDGET_EXCEEDED',
  /**
   * A change budget was set and the run came in under it. Provenance.
   *
   * Emitted because a budget nothing reports on is a budget nobody can tell was
   * checked — declared is not enforced, and the two look identical from the
   * outside until the day it matters.
   */
  RESOLVE_CHANGE_BUDGET_MET: 'RESOLVE_CHANGE_BUDGET_MET',

  /* -- the repair scope and the bounded neighbourhood ------------------------ */
  /**
   * The run was handed a **repair scope**: games whose current position it is
   * being asked to repair rather than to accept.
   *
   * `info`. Every other run in this package accepts what it was handed and
   * repairs only what it breaks, which is the whole of "a change request is not
   * asked to repair the schedule it was handed". That policy has one blind
   * spot, and it is the event this operator exists for: when the ground under a
   * game is withdrawn, the game is illegal **at its baseline slot**, so
   * `baseline-ingest` files the breach as already-carried and `local-search`
   * skips it. Measured on the season-2026 corpus: withdrawing one venue's
   * permit for one date takes the rule engine from 62 baseline violations to
   * 74, and the re-solve over the same engines emits **not one finding naming
   * the closure**. The repair scope is how a caller says which games that
   * silence is wrong about.
   */
  RESOLVE_REPAIR_SCOPE_DECLARED: 'RESOLVE_REPAIR_SCOPE_DECLARED',
  /**
   * A repair scope was declared and **not one game in it carried a baseline
   * finding**.
   *
   * `blocking`, and the meta-assertion the scope rests on. Un-accepting the
   * baseline findings of games that had none changes nothing whatsoever, so the
   * run would report a successful bounded repair having repaired nothing and
   * examined nothing — incident 4's shape, one layer up. A caller who names the
   * wrong games, or names them after the closure has already been lifted, is
   * told so rather than handed a clean report.
   */
  RESOLVE_REPAIR_SCOPE_VACUOUS: 'RESOLVE_REPAIR_SCOPE_VACUOUS',
  /**
   * A game in the repair scope had **nowhere legal to go**, and is left
   * standing where it is.
   *
   * `compromise`. Deliberately not TIME TBD: a game on withdrawn ground still
   * has a time families were given, and taking it away buys nothing when the
   * placer has nothing to offer instead. `resolve/` can only offer slots the
   * baseline used at the same venue on the same date (see
   * `inventory.js:candidateSlotsFor`), so a whole-venue withdrawal has no
   * in-reach answer by construction and the honest report is that the repair
   * was attempted and failed, naming how many candidates were refused.
   */
  RESOLVE_REPAIR_UNAVAILABLE: 'RESOLVE_REPAIR_UNAVAILABLE',
  /**
   * The change budget **stopped the repair**, and games are unrepaired or TIME
   * TBD as a consequence.
   *
   * `compromise`, and the severity is the point. Before this the budget was
   * checked once, after the fact, on a finished run:
   * `report.js` compared `moved.length` against the cap and `commit.js` threw.
   * A run that would move forty games moved forty and was then refused whole.
   * The budget now bounds the neighbourhood the repair may spend itself on, so
   * such a run comes back **within** its cap and partially repaired — which is
   * more useful and is a different thing, and a caller gating on status must be
   * unable to mistake "we stopped early" for "we finished".
   * {@link RESOLVE_REASON.RESOLVE_CHANGE_BUDGET_MET} is `info` and would read
   * as an all-clear; this is what stops the status coming back clean.
   */
  RESOLVE_CHANGE_BUDGET_BOUND: 'RESOLVE_CHANGE_BUDGET_BOUND',

  /* -- published-time hold, as a tracked metric ------------------------------ */
  /**
   * How many games kept the kickoff the published schedule gave them.
   *
   * `info`. Every counter this package had before counted **change** —
   * `movedGames`, `gamesDislodged`, `gamesReplaced`, `gamesTimeTbd`,
   * `candidatesRejected`. The hold existed as behaviour (the anchor, and
   * `local-search`'s never-move-a-legal-game branch) and as nothing a report
   * could be read for. It is counted here by enumerating the **baseline**
   * roster, never the result, so a game the pipeline dropped is reported as
   * unplaced rather than being silently absent from the set it would have been
   * counted in.
   */
  RESOLVE_PUBLISHED_HOLD_MEASURED: 'RESOLVE_PUBLISHED_HOLD_MEASURED',
  /**
   * The hold partition does not add up.
   *
   * `blocking`. `held + moved + unplaced === baselineGames`, counted from both
   * sides rather than asserted from how the lists were built — the same
   * discipline `publication/parity.js` applies to its four buckets and reports
   * as `PARITY_PARTITION_INCOMPLETE`. A partition that does not add up means a
   * game is in two buckets or in none, and either way the hold number is a
   * number nobody should read.
   */
  RESOLVE_PUBLISHED_HOLD_PARTITION_INCOMPLETE: 'RESOLVE_PUBLISHED_HOLD_PARTITION_INCOMPLETE',
  /**
   * A game moved and **nothing in the run can say what forced it**.
   *
   * `blocking`. This is the category-(b) failure stated as a code: a
   * consequential move whose cause the pipeline never recorded is a game that
   * left the schedule families have for a reason nobody can name, which is
   * incident 1 in miniature. It is a bug in this package rather than a property
   * of the schedule, and it is reported at blocking so that it cannot be
   * committed.
   */
  RESOLVE_CONSEQUENTIAL_MOVE_UNEXPLAINED: 'RESOLVE_CONSEQUENTIAL_MOVE_UNEXPLAINED',
  /**
   * A moved game does not appear **exactly once** across the report's two
   * categories.
   *
   * `blocking`. The report's own meta-assertion, and one that can genuinely
   * fail rather than one restating how the lists were built: a `moved` list
   * naming a game twice double-counts it in category (b) *and* against the
   * change budget, producing a diff larger than the season contains and a cap
   * spent on nothing. The appearances are counted, not assumed.
   */
  RESOLVE_REPORT_PARTITION_INCOMPLETE: 'RESOLVE_REPORT_PARTITION_INCOMPLETE',
  /**
   * The run produced no quality deltas because the rule engine did not run.
   *
   * Provenance here, teeth at `commitResolve()`, which refuses such a run
   * unless the caller names the acceptance. "No quality delta" and "no quality
   * delta measured" are the same sentence to a tired operator, and only one of
   * them is good news.
   */
  RESOLVE_REPORT_QUALITY_UNMEASURED: 'RESOLVE_REPORT_QUALITY_UNMEASURED',

  /* -- the audit ------------------------------------------------------------- */
  /**
   * A frozen game's placement differs from the one it was **held at**.
   *
   * `blocking`, and this is the code the whole prompt exists to make
   * unreachable. It is derived by comparing the **final schedule against the
   * position the game was held from**, game by game, and never from the move
   * ledger — a stage that wrote around the gate would not be in the ledger,
   * which is precisely the case this must catch.
   *
   * "Held from" is the **baseline** for a game the plan froze, and the slot it
   * was **pinned at** for a game `holdChanges` froze part-way through the run
   * (`state.pinnedAt`, `details.heldFrom`). Those games have already moved by
   * the time they are pinned — that is what the change request asked for — so
   * measuring them against the baseline reports a blocking failure per game on
   * the ordinary path. A backstop that cries wolf on its own happy path is
   * worse than none, because the next reader learns to ignore it.
   */
  RESOLVE_AUDIT_FROZEN_GAME_MOVED: 'RESOLVE_AUDIT_FROZEN_GAME_MOVED',
  /**
   * A stage changed a placement without a matching entry in the move ledger.
   *
   * `blocking`. Deep-freezing the state stops a stage mutating it in place; it
   * does not stop one returning a state it built itself. This is the check that
   * does.
   */
  RESOLVE_AUDIT_STAGE_BYPASSED_GATE: 'RESOLVE_AUDIT_STAGE_BYPASSED_GATE',
  /**
   * A stage that declared no mutation kinds wrote anyway. `blocking`.
   */
  RESOLVE_AUDIT_STAGE_WROTE_WITHOUT_DECLARING: 'RESOLVE_AUDIT_STAGE_WROTE_WITHOUT_DECLARING',
  /**
   * The audit examined zero games.
   *
   * `blocking`. An audit that looked at nothing reporting "no frozen game
   * moved" is incident 4 guarding incident 1, which would be the worst of both.
   */
  RESOLVE_AUDIT_VACUOUS: 'RESOLVE_AUDIT_VACUOUS',
});

/**
 * Severity of every reason code.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const RESOLVE_REASON_SEVERITY = Object.freeze({
  [RESOLVE_REASON.RESOLVE_RUN_VACUOUS]: RESOLVE_SEVERITY.BLOCKING,
  [RESOLVE_REASON.RESOLVE_NOTHING_CONSIDERED]: RESOLVE_SEVERITY.COMPROMISE,

  [RESOLVE_REASON.RESOLVE_CHANGE_UNKNOWN_GAME]: RESOLVE_SEVERITY.BLOCKING,
  [RESOLVE_REASON.RESOLVE_CHANGE_NO_OP]: RESOLVE_SEVERITY.INFO,
  [RESOLVE_REASON.RESOLVE_CHANGE_APPLIED]: RESOLVE_SEVERITY.INFO,
  [RESOLVE_REASON.RESOLVE_CHANGE_REFUSED_FROZEN]: RESOLVE_SEVERITY.BLOCKING,
  [RESOLVE_REASON.RESOLVE_CHANGE_DISPLACED]: RESOLVE_SEVERITY.COMPROMISE,
  [RESOLVE_REASON.RESOLVE_CHANGE_SLOT_OUTSIDE_INVENTORY]: RESOLVE_SEVERITY.INFO,
  [RESOLVE_REASON.RESOLVE_CHANGE_PINNED]: RESOLVE_SEVERITY.INFO,

  [RESOLVE_REASON.RESOLVE_GAME_DISLODGED]: RESOLVE_SEVERITY.INFO,
  [RESOLVE_REASON.RESOLVE_GAME_REPLACED]: RESOLVE_SEVERITY.INFO,
  [RESOLVE_REASON.RESOLVE_GAME_TIME_TBD]: RESOLVE_SEVERITY.COMPROMISE,
  [RESOLVE_REASON.RESOLVE_FROZEN_GAME_UNSATISFIABLE]: RESOLVE_SEVERITY.BLOCKING,
  [RESOLVE_REASON.RESOLVE_SLOT_OUTSIDE_INVENTORY]: RESOLVE_SEVERITY.BLOCKING,

  [RESOLVE_REASON.RESOLVE_VERIFY_NEW_VIOLATION]: RESOLVE_SEVERITY.COMPROMISE,

  [RESOLVE_REASON.RESOLVE_DRY_RUN]: RESOLVE_SEVERITY.INFO,
  [RESOLVE_REASON.RESOLVE_OBJECTIVE_WEIGHTS_OVERRIDDEN]: RESOLVE_SEVERITY.INFO,
  [RESOLVE_REASON.RESOLVE_OBJECTIVE_CHANGE_TERM_DISABLED]: RESOLVE_SEVERITY.COMPROMISE,
  [RESOLVE_REASON.RESOLVE_CHANGE_BUDGET_EXCEEDED]: RESOLVE_SEVERITY.BLOCKING,
  [RESOLVE_REASON.RESOLVE_CHANGE_BUDGET_MET]: RESOLVE_SEVERITY.INFO,
  [RESOLVE_REASON.RESOLVE_REPAIR_SCOPE_DECLARED]: RESOLVE_SEVERITY.INFO,
  [RESOLVE_REASON.RESOLVE_REPAIR_SCOPE_VACUOUS]: RESOLVE_SEVERITY.BLOCKING,
  [RESOLVE_REASON.RESOLVE_REPAIR_UNAVAILABLE]: RESOLVE_SEVERITY.COMPROMISE,
  [RESOLVE_REASON.RESOLVE_CHANGE_BUDGET_BOUND]: RESOLVE_SEVERITY.COMPROMISE,
  [RESOLVE_REASON.RESOLVE_PUBLISHED_HOLD_MEASURED]: RESOLVE_SEVERITY.INFO,
  [RESOLVE_REASON.RESOLVE_PUBLISHED_HOLD_PARTITION_INCOMPLETE]: RESOLVE_SEVERITY.BLOCKING,
  [RESOLVE_REASON.RESOLVE_CONSEQUENTIAL_MOVE_UNEXPLAINED]: RESOLVE_SEVERITY.BLOCKING,
  [RESOLVE_REASON.RESOLVE_REPORT_PARTITION_INCOMPLETE]: RESOLVE_SEVERITY.BLOCKING,
  [RESOLVE_REASON.RESOLVE_REPORT_QUALITY_UNMEASURED]: RESOLVE_SEVERITY.INFO,

  [RESOLVE_REASON.RESOLVE_AUDIT_FROZEN_GAME_MOVED]: RESOLVE_SEVERITY.BLOCKING,
  [RESOLVE_REASON.RESOLVE_AUDIT_STAGE_BYPASSED_GATE]: RESOLVE_SEVERITY.BLOCKING,
  [RESOLVE_REASON.RESOLVE_AUDIT_STAGE_WROTE_WITHOUT_DECLARING]: RESOLVE_SEVERITY.BLOCKING,
  [RESOLVE_REASON.RESOLVE_AUDIT_VACUOUS]: RESOLVE_SEVERITY.BLOCKING,
});

/**
 * Severity of a resolve reason code.
 *
 * Throws on an unknown code rather than defaulting to `info`.
 *
 * @param {string} code - a {@link RESOLVE_REASON} value
 * @returns {string} a {@link RESOLVE_SEVERITY} value
 */
export function resolveSeverityOf(code) {
  const severity = RESOLVE_REASON_SEVERITY[code];
  if (!severity) {
    throw new Error(`resolve: reason code "${code}" has no registered severity`);
  }
  return severity;
}

/**
 * Build a resolve finding. `severity` is looked up, never passed in.
 *
 * @param {string} code - a {@link RESOLVE_REASON} value
 * @param {string} message - for humans only
 * @param {Record<string, unknown>} [details] - flat primitives and ids only
 * @returns {import('../freeze/types.js').FreezeFinding}
 */
export function makeResolveFinding(code, message, details = {}) {
  return { code, severity: resolveSeverityOf(code), message, details };
}

/**
 * Derive the status of a run mechanically from its findings.
 *
 * @param {ReadonlyArray<import('../freeze/types.js').FreezeFinding>} findings
 * @returns {string} a {@link RESOLVE_STATUS} value
 */
export function deriveResolveStatus(findings) {
  return deriveFreezeStatus(findings);
}

/**
 * Fresh zeroed counters.
 *
 * `movesRejectedByFreeze` is the one that matters most. Every per-stage probe
 * asserts it grew: without it a probe passes just as happily against a stage
 * that never looked at the freeze as against one that honoured it.
 *
 * @returns {import('./types.js').ResolveMeta}
 */
export function createResolveMeta() {
  return {
    gamesExamined: 0,
    freezeJudgements: 0,
    stagesRegistered: 0,
    stagesRun: 0,
    movesConsidered: 0,
    movesRejectedByFreeze: 0,
    movesApplied: 0,
    candidatesEvaluated: 0,
    candidatesRejected: 0,
    candidatesRefusedByRules: 0,
    ruleGateCommitmentsExamined: 0,
    ruleGateSurfacePairsExamined: 0,
    candidatesScored: 0,
    conflictsExamined: 0,
    gamesDislodged: 0,
    gamesReplaced: 0,
    gamesTimeTbd: 0,
    gamesAudited: 0,
    rulesRun: 0,
    rulesExercised: 0,
    constraintsConsulted: 0,
    slotsAvailable: 0,
    // Prompt 4.2's counters. Assigned after the pipeline, from the report,
    // exactly as `slotsAvailable` is — they are properties of the whole run
    // rather than sums of per-stage work.
    movedGames: 0,
    movedRequested: 0,
    movedConsequential: 0,
    movedConsequentialExplained: 0,
    // 8.6's counters. Every counter above this line counts **change**; these
    // are the first that count a hold and the first that count a repair the
    // run was asked for and could not make. `publishedKickoffHeld` and
    // `publishedSlotHeld` are assigned after the pipeline from the baseline
    // partition, as `movedGames` is; the other three are summed as the stages
    // run.
    /** Games the run was asked to repair rather than to accept. */
    repairScopeGames: 0,
    /** Of those, ones the placer had nothing legal to offer. */
    repairsUnavailable: 0,
    /** Moves the change budget refused before the writer saw them. */
    movesRefusedByBudget: 0,
    /** Baseline games standing at their published date **and** kickoff. */
    publishedKickoffHeld: 0,
    /** Of those, ones also standing on their published ground. */
    publishedSlotHeld: 0,
  };
}

/**
 * Add one counter set into another, in place.
 *
 * @param {import('./types.js').ResolveMeta} target
 * @param {import('./types.js').ResolveMeta} source
 * @returns {import('./types.js').ResolveMeta}
 */
export function mergeResolveMeta(target, source) {
  for (const key of Object.keys(target)) {
    target[key] += source[key] ?? 0;
  }
  return target;
}
