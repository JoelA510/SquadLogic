/**
 * Machine-readable vocabulary for the read-only feasibility layer — Prompt 7.1.
 *
 * Same two rules as the eleven modules before it:
 *
 * 1. **`code` is the contract, `message` is decoration.** Never parse a message.
 * 2. **Severity lives in a table, never at a call site.**
 *
 * ## Three things this file declares, and they are not the same thing
 *
 * - **{@link FEASIBILITY_VERDICT}** — the answer about *the subject*: may this
 *   happen? Three values, never two.
 * - **{@link FEASIBILITY_REASON} / {@link deriveFeasibilityStatus}** — the
 *   answer's own integrity, in the three-state `allowed` / `compromised` /
 *   `rejected` vocabulary every other module uses. This is `status`, and it is
 *   about *the answer*, exactly as `attribution/reasonCodes.js` says.
 * - **{@link FEASIBILITY_UNKNOWN_BY_CODE}** — which of the other modules' reason
 *   codes mean *"this could not be measured"* rather than *"this is fine"*.
 *
 * A `rejected` status on a perfectly good "no" is a category error, and so is an
 * `infeasible` verdict on an answer that could not be built. The two channels
 * are separate all the way down and a structural test asserts they never merge.
 *
 * ## Why `unknown` is a member of the verdict enum and not a null
 *
 * "Unknown is not zero" is the failure this repository has reproduced four times
 * (`docs/BUILD_PLAN_STATUS.md` §4). A nullable boolean invites `if (feasible)`,
 * which is `false` for `null`, which silently reads "no"; a truthy-checked
 * string invites the same thing in reverse. So the verdict is a required string
 * from a frozen three-member enum, every consumer must compare against a named
 * member, and {@link deriveFeasibilityVerdict} is the only place a verdict is
 * produced.
 *
 * @module feasibility/reasonCodes
 */

import { AVAILABILITY_REASON } from '../availability/reasonCodes.js';
import {
  CONSTRAINT_SEVERITY,
  CONSTRAINT_STATUS,
  deriveConstraintStatus,
} from '../constraints/reasonCodes.js';
import { FACILITY_REASON } from '../facility/reasonCodes.js';
import { TIMING_REASON } from '../timing/reasonCodes.js';

/**
 * How badly a finding counts against an answer.
 *
 * @readonly
 * @enum {string}
 */
export const FEASIBILITY_SEVERITY = CONSTRAINT_SEVERITY;

/**
 * The three-state outcome of an **answer**.
 *
 * @readonly
 * @enum {string}
 */
export const FEASIBILITY_STATUS = CONSTRAINT_STATUS;

/**
 * The three-state outcome about **the subject**. Three values, never two.
 *
 * `UNKNOWN` is a first-class answer and never a stand-in for either of the
 * others: it means the model was asked something it cannot decide, and
 * {@link FeasibilityAnswer.unknowns} says which questions those were and why.
 *
 * @readonly
 * @enum {string}
 */
export const FEASIBILITY_VERDICT = Object.freeze({
  /** Everything that governs this said yes, and everything that governs it was asked. */
  FEASIBLE: 'feasible',
  /** Something that governs this said no, and the answer names it. */
  INFEASIBLE: 'infeasible',
  /** Something that governs this could not be decided. Never a soft yes or a soft no. */
  UNKNOWN: 'unknown',
});

/**
 * Declared order of the verdicts, for deterministic rendering only.
 *
 * @type {ReadonlyArray<string>}
 */
export const FEASIBILITY_VERDICT_ORDER = Object.freeze([
  FEASIBILITY_VERDICT.FEASIBLE,
  FEASIBILITY_VERDICT.UNKNOWN,
  FEASIBILITY_VERDICT.INFEASIBLE,
]);

/**
 * **How much room a feasible position has**, in the same three-valued
 * discipline {@link FEASIBILITY_VERDICT} uses, and for the same reason.
 *
 * `tight` began life as a boolean, and a boolean could only say "inside a
 * stated comfort margin" or "not". That second value was doing two jobs: it
 * meant *"there is room here"* and it also meant *"no clean position exists at
 * all, so every legal kickoff on this ground is compromised"* — which is not
 * "not tight", it is worse than tight. 772 surface-date-format combinations of
 * the season corpus reported the second while reading as the first, which is
 * exactly the false confidence this module exists to replace.
 *
 * So the third state is named rather than folded into `false`, and the values
 * are strings from a frozen enum rather than booleans: `if (answer.tight)` is
 * now wrong in a way that shows up, and every consumer has to compare against a
 * member. `null` remains "there is no placement to say this about", which is
 * every answer whose verdict is not `feasible`.
 *
 * @readonly
 * @enum {string}
 */
export const FEASIBILITY_TIGHTNESS = Object.freeze({
  /** Legal, and nothing above `info` speaks about it. */
  CLEAN: 'clean',
  /** Legal, inside a stated comfort margin, and a clean position does exist. */
  TIGHT: 'tight',
  /**
   * Legal, and there is **no** clean position at all: every kickoff this bound
   * admits raises something above `info`. Strictly worse than {@link TIGHT}.
   */
  NO_CLEAN_POSITION: 'no-clean-position',
});

/**
 * The questions this module answers.
 *
 * @readonly
 * @enum {string}
 */
export const FEASIBILITY_QUESTION = Object.freeze({
  /** *"Can this game move to Thursday / to 6pm / to that field?"* */
  CAN_GAME_MOVE: 'can-game-move',
  /** *"Can this team play at 6pm in November?"* */
  CAN_TEAM_PLAY: 'can-team-play',
  /** *"How late — and how early — can anything kick off here, and what stops it?"* */
  KICKOFF_BOUNDS: 'kickoff-bounds',
  /**
   * *"A parent asked to move this fixture into that window — what can the club
   * actually offer?"*
   *
   * The two-sided question, and the only one in this module that looks at
   * anybody but the subject. See `feasibility/moveRequest.js`.
   */
  ANALYSE_MOVE_REQUEST: 'analyse-move-request',
});

/**
 * **What a club can say in answer to a move request.**
 *
 * Four classes, and the whole point of the vocabulary is that they are not four
 * shades of the same thing: each one licenses a different sentence to a family,
 * and picking the wrong one is how a club promises ground it does not have or
 * refuses a request it could have granted.
 *
 * Derived **only** by `classifyMoveRequest()`. A caller that reconstructed the
 * class from `vacancies.length` and `swaps.length` would be a second producer of
 * a derived status, which is the shape `docs/BUILD_PLAN_STATUS.md` §4 records
 * over and over — and, unlike a duplicated number, a duplicated *classification*
 * diverges silently because both copies are plausible.
 *
 * @readonly
 * @enum {string}
 */
export const MOVE_REQUEST_CLASS = Object.freeze({
  /**
   * There is feasible ground in the window that **nobody holds**. The club can
   * simply say yes.
   */
  VACANCY_AVAILABLE: 'vacancy_available',
  /**
   * No vacancy, but at least one admissible swap costs its counterparty
   * **nothing** — the other party is as well placed after the exchange as
   * before. The club can say yes subject to the other family agreeing.
   */
  FREE_SWAP_AVAILABLE: 'free_swap_available',
  /**
   * No vacancy, and **every** admissible swap takes something from the
   * counterparty. The club can only say *"yes, and somebody else loses this"*,
   * and the answer names which objective and how many holders rely on it.
   */
  ZERO_SUM_ONLY: 'zero_sum_only',
  /**
   * Nothing to offer: no vacancy and no admissible swap. Note that this is a
   * statement about the **window asked about**, and where a candidate could not
   * be judged the answer's own `verdict` is `unknown` and
   * `MOVE_REQUEST_CLASS_UNDER_UNKNOWN` says so — the class is then a floor
   * rather than a finding.
   */
  INFEASIBLE: 'infeasible',
});

/**
 * Declared order of the classes, best offer first, for deterministic rendering.
 *
 * @type {ReadonlyArray<string>}
 */
export const MOVE_REQUEST_CLASS_ORDER = Object.freeze([
  MOVE_REQUEST_CLASS.VACANCY_AVAILABLE,
  MOVE_REQUEST_CLASS.FREE_SWAP_AVAILABLE,
  MOVE_REQUEST_CLASS.ZERO_SUM_ONLY,
  MOVE_REQUEST_CLASS.INFEASIBLE,
]);

/**
 * The two kinds of thing that stand on ground in this model.
 *
 * `game` and `practice` are held in one vocabulary, and one holder index, so
 * that a practice can be the counterparty of a game's swap. Keeping two indexes
 * is how a swap gets computed against half the occupancy.
 *
 * @readonly
 * @enum {string}
 */
export const MOVE_REQUEST_ENTITY = Object.freeze({
  GAME: 'game',
  PRACTICE: 'practice',
});

/**
 * The two thresholds every bounded answer distinguishes.
 *
 * The corpus states two different 15-minute numbers and they do **not** have the
 * same status, which is the trap this enum exists to keep open:
 *
 * - Past a bound is `blocking` — `PERMIT_CLOSE_EXCEEDED`, `LIGHTS_OFF_EXCEEDED`,
 *   `SUNSET_MARGIN_VIOLATED`, an `OCCUPIED_*` clash. That is {@link HARD}.
 * - Eating into a stated comfort margin is `compromise` —
 *   `PERMIT_MARGIN_TIGHT`. That is the difference between {@link HARD} and
 *   {@link CLEAN}.
 *
 * Note that the club's daylight margin is **already inside** the hard bound:
 * `daylightLimitMinutes()` returns sunset less the margin and
 * `SUNSET_MARGIN_VIOLATED` is `blocking`, because `sunsets.csv` states "unlit
 * games must end 15 min before sunset" as a rule rather than as a comfort. The
 * permit's 15 minutes is a comfort. This module does not re-decide either; it
 * reads both off the severities their owners assign, which is why it can carry
 * the asymmetry without encoding it.
 *
 * @readonly
 * @enum {string}
 */
export const FEASIBILITY_THRESHOLD = Object.freeze({
  /** The last position at which nothing raises a `blocking` finding. */
  HARD: 'hard',
  /** The last position at which nothing raises a finding above `info` at all. */
  CLEAN: 'clean',
});

/**
 * The unit of every margin this module reports. There is exactly one.
 *
 * @type {string}
 */
export const FEASIBILITY_MARGIN_UNIT = 'minutes';

/**
 * **The sign convention, stated once and held everywhere.**
 *
 * A margin is *room remaining*, in minutes, measured from the subject toward the
 * bound: `limit - subject`.
 *
 * - **positive** — that many minutes of room left before the bound is reached
 * - **zero** — exactly at the bound; one more minute crosses it
 * - **negative** — the bound is broken by that many minutes
 * - **null** — the constraint that decided this reported no measurable bound.
 *   Never `0`, which would be a confident claim of "exactly at the edge".
 *
 * This is `slackMinutes` as `availability/kickoff.js` computes it
 * (`limitMinutes - endMinutes`) and as `attribution/claims.js` carries it. This
 * module **copies** that number and never recomputes, re-signs or negates it: a
 * second arithmetic would be free to disagree with the first, and the
 * disagreement would be a margin that contradicts the schedule it describes.
 *
 * @type {string}
 */
export const FEASIBILITY_MARGIN_CONVENTION =
  'margin = limit - subject, in minutes: positive is room remaining, zero is exactly at the bound, negative is the bound broken by that many minutes, null is a bound nobody could measure';

/**
 * Every reason a feasibility answer can give **about itself**.
 *
 * None of these is a scheduling verdict. The verdicts belong to the modules the
 * claims come from.
 *
 * @readonly
 * @enum {string}
 */
export const FEASIBILITY_REASON = Object.freeze({
  /* -- the answer could not be given -------------------------------------- */
  /**
   * The subject's footprint is unknown (GAP-14), so nothing that needs an end
   * minute could be decided.
   *
   * `compromise`. `bookingsOverlapInTime()` returns `null` for exactly this and
   * `null` is not `false`; folding it into "no clash" is the mistake this
   * repository has made four times.
   */
  FEASIBILITY_FOOTPRINT_UNKNOWN: 'FEASIBILITY_FOOTPRINT_UNKNOWN',
  /**
   * A registry constraint that governs this subject has no rule enforcing it.
   *
   * `compromise`. Returning "yes" from a check nobody performs is incident 4's
   * exact shape, so a verdict that would rest on one is `unknown` instead.
   */
  FEASIBILITY_RULE_UNENFORCED: 'FEASIBILITY_RULE_UNENFORCED',
  /**
   * No permit record covers this venue on this date, so its opening hours are
   * unknown. `compromise`.
   */
  FEASIBILITY_PERMIT_UNDECLARED: 'FEASIBILITY_PERMIT_UNDECLARED',
  /** No sunset is recorded for this date and the ground is unlit. `compromise`. */
  FEASIBILITY_DAYLIGHT_UNKNOWN: 'FEASIBILITY_DAYLIGHT_UNKNOWN',
  /**
   * The context carries no standing-rule-engine run, so turnover floors,
   * round-robin completeness and hosting balance were not asked about.
   *
   * `compromise`, and it turns a would-be `feasible` into `unknown`: a facility
   * answer must never be read as a whole one.
   */
  FEASIBILITY_VERIFICATION_ABSENT: 'FEASIBILITY_VERIFICATION_ABSENT',
  /**
   * Coach travel could not be projected onto the hypothesis, because no venue
   * complexes were supplied.
   *
   * `compromise`. Judging every pair of distinct venue names against the
   * 60-minute floor is the misreading that reported eighteen shortfalls where
   * one was real, so this module refuses to guess.
   */
  FEASIBILITY_TRAVEL_ABSENT: 'FEASIBILITY_TRAVEL_ABSENT',
  /**
   * The subject named is a placeholder label — `-`, `Select Game 7` — and not a
   * team. `compromise`: an unnamed fixture is not an opponent.
   */
  FEASIBILITY_SUBJECT_NOT_A_TEAM: 'FEASIBILITY_SUBJECT_NOT_A_TEAM',
  /** The subject named is not in this run at all. `compromise`. */
  FEASIBILITY_SUBJECT_UNKNOWN: 'FEASIBILITY_SUBJECT_UNKNOWN',
  /**
   * The subject's format could not be resolved, so no footprint could be taken.
   * `compromise`.
   */
  FEASIBILITY_FORMAT_UNRESOLVED: 'FEASIBILITY_FORMAT_UNRESOLVED',
  /**
   * The move asked about is the position the subject already holds.
   *
   * `compromise`: the comparison is between a thing and itself and its answer
   * means nothing, so it is not reported as a yes.
   */
  FEASIBILITY_MOVE_IS_NO_OP: 'FEASIBILITY_MOVE_IS_NO_OP',
  /**
   * The position asked about is one the subject **already holds**, and the
   * answer is the standing schedule's own rather than a hypothesis.
   *
   * `info`. *"Can this team play where it already plays?"* is not vacuous the
   * way *"can this game move to the slot it is in?"* is: it has an obvious true
   * answer, and refusing it as undecidable is a shrug where a fact was
   * available.
   */
  FEASIBILITY_POSITION_ALREADY_HELD: 'FEASIBILITY_POSITION_ALREADY_HELD',
  /**
   * A format was named that no fixture of this subject plays, so nothing can
   * carry the hypothesis.
   *
   * `compromise`. A team has no footprint of its own; the carrier fixture is
   * what gives the question a duration, and inventing one would be inventing
   * the answer.
   */
  FEASIBILITY_FORMAT_UNCARRIED: 'FEASIBILITY_FORMAT_UNCARRIED',

  /* -- the bound ------------------------------------------------------------ */
  /**
   * Two or more constraints bind at the same minute.
   *
   * `info`, and load-bearing: an answer that named one of them would be claiming
   * a precision it does not have. Every member is reported and none is a winner.
   */
  FEASIBILITY_BOUND_JOINT: 'FEASIBILITY_BOUND_JOINT',
  /**
   * The registry moved a bound that `availability/kickoff.js` had chosen.
   *
   * `info`, and it is provenance for a *disagreement* rather than a defect.
   * `latestLegalKickoff()` selects the latest minute at which nothing raises a
   * finding that is `blocking` **in `availability/`'s own frozen table**; every
   * other severity question this module asks goes through the registry, which
   * may make a base-`compromise` code hard (`PERMIT_MARGIN_TIGHT` under a club
   * whose permit states the comfort margin as a condition) or a base-`blocking`
   * one softer. Where the two views differ, this module reports the bound the
   * registry allows — the view it judges under — and this finding names the
   * minute availability offered, the minute reported instead, and the codes that
   * made the difference, so the disagreement is legible rather than silent.
   */
  FEASIBILITY_BOUND_UNDER_REGISTRY: 'FEASIBILITY_BOUND_UNDER_REGISTRY',
  /**
   * Nothing this run holds bounds the thing asked about, so the boundary is the
   * top of the searched range rather than a limit anybody stated.
   *
   * `compromise`. An unbounded answer is not a generous one.
   */
  FEASIBILITY_BOUND_UNSTATED: 'FEASIBILITY_BOUND_UNSTATED',
  /**
   * The constraint that decided this reported no measurable slack, so the margin
   * is `null` rather than a number. `info`.
   */
  FEASIBILITY_MARGIN_UNAVAILABLE: 'FEASIBILITY_MARGIN_UNAVAILABLE',
  /** The subject is feasible but inside a stated comfort margin. `info`. */
  FEASIBILITY_TIGHT: 'FEASIBILITY_TIGHT',
  /**
   * The subject is legal and **no clean position exists at all** — every
   * kickoff the bound admits raises something above `info`.
   *
   * `compromise`, one step above {@link FEASIBILITY_TIGHT}'s `info`, and the
   * difference is the point. A tight position is a real position with a clean
   * one still available beside it; this says the whole date offers nothing but
   * compromised positions, so an answer that hands an operator one is a
   * compromised answer in the same way `FEASIBILITY_BOUND_UNSTATED` is.
   */
  FEASIBILITY_NO_CLEAN_POSITION: 'FEASIBILITY_NO_CLEAN_POSITION',

  /* -- the answer's own integrity ------------------------------------------ */
  /**
   * The query examined zero candidates.
   *
   * `blocking`. "Nothing blocks it" is a true statement about an empty search
   * and means nothing — incident 4 with better manners.
   */
  FEASIBILITY_QUERY_VACUOUS: 'FEASIBILITY_QUERY_VACUOUS',
  /**
   * A candidate the query was asked about produced no answer.
   *
   * `blocking`, and it is incident 10's rule applied to a query: a candidate
   * that cannot be judged is surfaced with a reason, never dropped from the
   * list.
   */
  FEASIBILITY_CANDIDATE_DROPPED: 'FEASIBILITY_CANDIDATE_DROPPED',
  /**
   * A claim this answer carries names a constraint *category* and no instance.
   *
   * `blocking`, and it is 4.3's `ATTRIBUTION_CLAIM_CATEGORY_ONLY` restated in
   * this module's own vocabulary rather than forwarded in 4.3's. A finding
   * carrying a foreign code is a finding whose severity this module cannot look
   * up, and `feasibilitySeverityOf()` throws on one — so the answer would be a
   * live grenade in the hand of whoever read it.
   */
  FEASIBILITY_CLAIM_CATEGORY_ONLY: 'FEASIBILITY_CLAIM_CATEGORY_ONLY',
  /**
   * A severity-bearing record **decided this answer and could not be published
   * as a claim**, so it is stated here in this module's own vocabulary instead.
   *
   * `compromise`, and it is {@link FEASIBILITY_CLAIM_CATEGORY_ONLY}'s mirror
   * image rather than a second copy of it. That code fires when a claim naming
   * only a category got through; this one fires when one was correctly refused
   * and the evidence would otherwise have vanished with it.
   *
   * The live instance is coach travel. `projectTravel()` compares two
   * `evaluateCoachTravel()` runs and reports the codes whose count grew; a
   * finding that no *transition* owns is dropped from the claims, because
   * `claimFromFinding()` builds one with `instanceId: null` and
   * `constraintId: null` from it — `TRAVEL_SCAN_VACUOUS` carries
   * `commitmentsExamined` and `peopleExamined` and nothing that identifies a
   * record — and `isSpecificClaim()` refuses it. **The drop is right.** But the
   * record still reached `deriveFeasibilityEvidence()`, so on 546 cells of this
   * corpus's team grids it decided `tight` while every blocker the answer
   * published was `info`: the tightness was sealed on evidence the reader could
   * not see.
   *
   * So the finding names the code, the severity and the source that decided,
   * and claims nothing about a record — which is the honest half of what the
   * refused claim would have said. It is deliberately **not** in
   * {@link FEASIBILITY_UNKNOWN_BY_CODE}: a scan that examined no transition is a
   * compromise, not a measurement nobody could take, and turning it into an
   * unknown would move 546 cells off `feasible` on the strength of a
   * re-classification rather than of a fact.
   *
   * Registered at `compromise` rather than mirroring the record's own severity,
   * because the only records that can reach it are the scan-level travel codes
   * and `travelSeverityOf()` cannot make one `blocking` under any constraint
   * type — which round four proves. A `blocking` one would therefore be a new
   * fact about the model, and it would fail the corpus-wide
   * publish-what-you-seal-on rule's `infeasible` arm loudly rather than being
   * understated here in silence.
   */
  FEASIBILITY_EVIDENCE_UNCLAIMED: 'FEASIBILITY_EVIDENCE_UNCLAIMED',
  /**
   * The answer is blocked, and the layer the **minimal blocking set** speaks
   * for is not the layer that blocked it.
   *
   * `info`, and it is provenance rather than a defect: the blockers already
   * name the constraint that decided, the margin is already reported, and
   * nothing went unmeasured. What it fixes is a contradiction on the *surface*
   * of the answer. `minimalBlockingSet()` is `attribution/`'s certified
   * facility-layer answer, so when the rule engine or coach travel is what
   * blocked a position it comes back `blocked: false` carrying
   * `ATTRIBUTION_PLACEMENT_NOT_BLOCKED` — *"no set of constraints blocks it"*
   * printed beside *"infeasible"*, in one answer, to an operator this layer
   * exists to stop misleading.
   *
   * Suppressing the call was considered and refused: that a blocked position
   * has no *facility* explanation is worth saying. So the information stays and
   * the denial is qualified — this finding names the layers that did block it
   * and the codes they raised, so the answer reads "the facility layer did not
   * block this; the rule engine did" rather than a bare denial.
   */
  FEASIBILITY_BLOCKED_OUTSIDE_FACILITY: 'FEASIBILITY_BLOCKED_OUTSIDE_FACILITY',
  /** The verdict, as provenance, with the counts behind it. `info`. */
  FEASIBILITY_VERDICT_REACHED: 'FEASIBILITY_VERDICT_REACHED',

  /* -- the move request ----------------------------------------------------- */
  /**
   * The class, as provenance, with the four counts behind it. `info`.
   *
   * Emitted by `classifyMoveRequest()` itself, so the sentence a reader sees and
   * the class a consumer branches on are produced by one call and cannot drift.
   */
  MOVE_REQUEST_CLASS_REACHED: 'MOVE_REQUEST_CLASS_REACHED',
  /**
   * The class is `infeasible` **and at least one candidate position could not be
   * judged**, so "nothing to offer" is a floor rather than a finding.
   *
   * `compromise`. Without it a window with three undecidable candidates and no
   * vacancy reads exactly like a window that was searched to the bottom, which
   * is the collapse of `unknown` into "no" this package exists to refuse. The
   * answer's own `verdict` is `unknown` in that case; this is the same fact said
   * where a reader of the *class* will see it.
   */
  MOVE_REQUEST_CLASS_UNDER_UNKNOWN: 'MOVE_REQUEST_CLASS_UNDER_UNKNOWN',
  /**
   * A counterparty's cost names reason codes that **no registry constraint
   * claims**, so the objective it would lose has no id.
   *
   * `compromise`, and it is *declared is not enforced* in this module's own
   * vocabulary: a cost reported as a bare code is a real loss that the registry
   * cannot name, and reporting it as an empty objective list would make a
   * zero-sum swap read as a free one.
   */
  MOVE_REQUEST_COST_UNCLAIMED: 'MOVE_REQUEST_COST_UNCLAIMED',
  /**
   * Whether something stands on a candidate position could not be decided,
   * because a holder's footprint is unknown (GAP-14).
   *
   * `compromise`. Such a position is **never** counted as a vacancy: an
   * undecidable overlap is not an empty field, and the club would be offering
   * ground it has not checked.
   */
  MOVE_REQUEST_OCCUPANCY_UNDECIDABLE: 'MOVE_REQUEST_OCCUPANCY_UNDECIDABLE',
  /**
   * A candidate position the window names is **not on the capacity grid** — the
   * ground does not offer a slot at that minute.
   *
   * `info`. It is provenance for the join: the grid is
   * `buildReserveCapacityReport()`'s and this module does not invent a slot
   * beside one it generated.
   */
  MOVE_REQUEST_OFF_CAPACITY_GRID: 'MOVE_REQUEST_OFF_CAPACITY_GRID',
  /**
   * The capacity report this analysis joined to reported something above `info`
   * about its own integrity.
   *
   * `compromise`, and lifted rather than swallowed for the reason
   * `scenario/relocation.js` lifts the same findings: `RESERVE_CAPACITY_VACUOUS`
   * means the grid generated nothing, and "no vacancy" over an empty grid is a
   * fact about the report rather than about the season.
   */
  MOVE_REQUEST_CAPACITY_IMPEACHED: 'MOVE_REQUEST_CAPACITY_IMPEACHED',
  /**
   * The subject named is neither a game this run holds nor a practice the caller
   * supplied. `compromise`.
   */
  MOVE_REQUEST_SUBJECT_UNKNOWN: 'MOVE_REQUEST_SUBJECT_UNKNOWN',
  /**
   * Two supplied holdings share an id, or a supplied practice collides with a
   * game id.
   *
   * `blocking`. The holder index is what occupancy, vacancy and every swap are
   * read from; two holdings under one key means one of them is invisible to all
   * three, and a swap computed against half the occupancy is worse than none.
   */
  MOVE_REQUEST_HOLDING_DUPLICATED: 'MOVE_REQUEST_HOLDING_DUPLICATED',
  /**
   * A layer that speaks for a **game** does not speak for a **practice**, and
   * the answer says which.
   *
   * `info`, and not an unknown: the standing rule engine's rules are turnover
   * floors, round-robin completeness and hosting balance, which are statements
   * about a fixture list. They do not govern a practice, so leaving them unasked
   * is an inapplicability rather than a measurement nobody took — and turning it
   * into a verdict-bearing unknown would make every practice answer `unknown`
   * and the whole query useless on the half of the estate it was asked for.
   */
  MOVE_REQUEST_LAYER_SILENT: 'MOVE_REQUEST_LAYER_SILENT',
  /**
   * A holding stands on ground the facility graph does not hold, so whether it
   * overlaps anything in this window could not be decided.
   *
   * `compromise`, and it is the unknown-surface discipline
   * (`tests/unknownSurfaceDiscipline.test.js`) applied to this module.
   * `surfacesConflict()` reaches `requireSurface()`, which **throws**, and the
   * surface ids here come from data — a caller's practice list. Three modules
   * have now shipped that throw, each taking every other verdict in its run
   * down with it. So the id is guarded before the lookup and the holding is
   * carried as an **undecidable** occupant of every candidate on its date: not
   * a holder, because nobody can say it conflicts, and never absent, because
   * nobody can say it does not.
   */
  MOVE_REQUEST_HOLDING_SURFACE_UNKNOWN: 'MOVE_REQUEST_HOLDING_SURFACE_UNKNOWN',
});

/**
 * Severity of every reason code.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const FEASIBILITY_REASON_SEVERITY = Object.freeze({
  [FEASIBILITY_REASON.FEASIBILITY_FOOTPRINT_UNKNOWN]: FEASIBILITY_SEVERITY.COMPROMISE,
  [FEASIBILITY_REASON.FEASIBILITY_RULE_UNENFORCED]: FEASIBILITY_SEVERITY.COMPROMISE,
  [FEASIBILITY_REASON.FEASIBILITY_PERMIT_UNDECLARED]: FEASIBILITY_SEVERITY.COMPROMISE,
  [FEASIBILITY_REASON.FEASIBILITY_DAYLIGHT_UNKNOWN]: FEASIBILITY_SEVERITY.COMPROMISE,
  [FEASIBILITY_REASON.FEASIBILITY_VERIFICATION_ABSENT]: FEASIBILITY_SEVERITY.COMPROMISE,
  [FEASIBILITY_REASON.FEASIBILITY_TRAVEL_ABSENT]: FEASIBILITY_SEVERITY.COMPROMISE,
  [FEASIBILITY_REASON.FEASIBILITY_SUBJECT_NOT_A_TEAM]: FEASIBILITY_SEVERITY.COMPROMISE,
  [FEASIBILITY_REASON.FEASIBILITY_SUBJECT_UNKNOWN]: FEASIBILITY_SEVERITY.COMPROMISE,
  [FEASIBILITY_REASON.FEASIBILITY_FORMAT_UNRESOLVED]: FEASIBILITY_SEVERITY.COMPROMISE,
  [FEASIBILITY_REASON.FEASIBILITY_MOVE_IS_NO_OP]: FEASIBILITY_SEVERITY.COMPROMISE,
  [FEASIBILITY_REASON.FEASIBILITY_POSITION_ALREADY_HELD]: FEASIBILITY_SEVERITY.INFO,
  [FEASIBILITY_REASON.FEASIBILITY_FORMAT_UNCARRIED]: FEASIBILITY_SEVERITY.COMPROMISE,

  [FEASIBILITY_REASON.FEASIBILITY_BOUND_JOINT]: FEASIBILITY_SEVERITY.INFO,
  [FEASIBILITY_REASON.FEASIBILITY_BOUND_UNDER_REGISTRY]: FEASIBILITY_SEVERITY.INFO,
  [FEASIBILITY_REASON.FEASIBILITY_BOUND_UNSTATED]: FEASIBILITY_SEVERITY.COMPROMISE,
  [FEASIBILITY_REASON.FEASIBILITY_MARGIN_UNAVAILABLE]: FEASIBILITY_SEVERITY.INFO,
  [FEASIBILITY_REASON.FEASIBILITY_TIGHT]: FEASIBILITY_SEVERITY.INFO,
  [FEASIBILITY_REASON.FEASIBILITY_NO_CLEAN_POSITION]: FEASIBILITY_SEVERITY.COMPROMISE,

  [FEASIBILITY_REASON.FEASIBILITY_QUERY_VACUOUS]: FEASIBILITY_SEVERITY.BLOCKING,
  [FEASIBILITY_REASON.FEASIBILITY_CANDIDATE_DROPPED]: FEASIBILITY_SEVERITY.BLOCKING,
  [FEASIBILITY_REASON.FEASIBILITY_CLAIM_CATEGORY_ONLY]: FEASIBILITY_SEVERITY.BLOCKING,
  [FEASIBILITY_REASON.FEASIBILITY_EVIDENCE_UNCLAIMED]: FEASIBILITY_SEVERITY.COMPROMISE,
  [FEASIBILITY_REASON.FEASIBILITY_BLOCKED_OUTSIDE_FACILITY]: FEASIBILITY_SEVERITY.INFO,
  [FEASIBILITY_REASON.FEASIBILITY_VERDICT_REACHED]: FEASIBILITY_SEVERITY.INFO,

  [FEASIBILITY_REASON.MOVE_REQUEST_CLASS_REACHED]: FEASIBILITY_SEVERITY.INFO,
  [FEASIBILITY_REASON.MOVE_REQUEST_CLASS_UNDER_UNKNOWN]: FEASIBILITY_SEVERITY.COMPROMISE,
  [FEASIBILITY_REASON.MOVE_REQUEST_COST_UNCLAIMED]: FEASIBILITY_SEVERITY.COMPROMISE,
  [FEASIBILITY_REASON.MOVE_REQUEST_OCCUPANCY_UNDECIDABLE]: FEASIBILITY_SEVERITY.COMPROMISE,
  [FEASIBILITY_REASON.MOVE_REQUEST_OFF_CAPACITY_GRID]: FEASIBILITY_SEVERITY.INFO,
  [FEASIBILITY_REASON.MOVE_REQUEST_CAPACITY_IMPEACHED]: FEASIBILITY_SEVERITY.COMPROMISE,
  [FEASIBILITY_REASON.MOVE_REQUEST_SUBJECT_UNKNOWN]: FEASIBILITY_SEVERITY.COMPROMISE,
  [FEASIBILITY_REASON.MOVE_REQUEST_HOLDING_DUPLICATED]: FEASIBILITY_SEVERITY.BLOCKING,
  [FEASIBILITY_REASON.MOVE_REQUEST_LAYER_SILENT]: FEASIBILITY_SEVERITY.INFO,
  [FEASIBILITY_REASON.MOVE_REQUEST_HOLDING_SURFACE_UNKNOWN]: FEASIBILITY_SEVERITY.COMPROMISE,
});

/**
 * Which reason codes of the modules below mean *"this could not be measured"*.
 *
 * The centre of rule 3. Each of these is a code whose owner has already said, in
 * its own words, that it could not decide something — and a feasibility answer
 * that saw one and still said `feasible` would be reporting an all-clear from a
 * check that did not happen.
 *
 * Keyed by the owner's code so the mapping is data rather than a chain of `if`s,
 * and so `tests/feasibilityApi.test.js` can assert every key is a real code of
 * the module that owns it.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const FEASIBILITY_UNKNOWN_BY_CODE = Object.freeze({
  [TIMING_REASON.FORMAT_TIMING_UNDEFINED]: FEASIBILITY_REASON.FEASIBILITY_FOOTPRINT_UNKNOWN,
  [FACILITY_REASON.OCCUPANCY_FOOTPRINT_UNKNOWN]: FEASIBILITY_REASON.FEASIBILITY_FOOTPRINT_UNKNOWN,
  [FACILITY_REASON.SIZE_UNKNOWN_FORMAT]: FEASIBILITY_REASON.FEASIBILITY_FOOTPRINT_UNKNOWN,
  [AVAILABILITY_REASON.PERMIT_UNDECLARED]: FEASIBILITY_REASON.FEASIBILITY_PERMIT_UNDECLARED,
  [AVAILABILITY_REASON.SUNSET_UNKNOWN]: FEASIBILITY_REASON.FEASIBILITY_DAYLIGHT_UNKNOWN,
});

/**
 * Severity of a feasibility reason code.
 *
 * Throws on an unknown code rather than defaulting to `info`, for the same
 * reason the eleven modules before it do: a code with no severity is a code
 * somebody forgot to register, and defaulting would make it silently
 * non-blocking.
 *
 * @param {string} code
 * @returns {string} a {@link FEASIBILITY_SEVERITY} value
 */
export function feasibilitySeverityOf(code) {
  const severity = FEASIBILITY_REASON_SEVERITY[code];
  if (!severity) {
    throw new Error(`feasibility: reason code "${code}" has no registered severity`);
  }
  return severity;
}

/**
 * **Every finding this module emits, checked against the table that owns it.**
 *
 * The class guard behind {@link feasibilitySeverityOf}. A finding is only a
 * feasibility finding if its code is registered *and* its severity is the one
 * registered for it — so a foreign finding forwarded in from another module,
 * which is how `ATTRIBUTION_CLAIM_CATEGORY_ONLY` once reached a caller, cannot
 * leave this package pretending to be one of ours. Throwing here rather than
 * defaulting is the same choice {@link feasibilitySeverityOf} makes and for the
 * same reason: the alternative is an answer that detonates in the hand of
 * whoever reads it, at a call site that did nothing wrong.
 *
 * Run over the composed list of **every** sealed answer, so the property is
 * "this module cannot emit an unregistered finding" rather than "these codes
 * happen to be registered".
 *
 * @param {ReadonlyArray<import('./types.js').FeasibilityFinding>} findings
 * @param {string} [question] - named in the failure, so it says which answer
 * @returns {ReadonlyArray<import('./types.js').FeasibilityFinding>} the same list
 */
export function assertFeasibilityFindings(findings, question = 'an answer') {
  for (const finding of findings) {
    const severity = feasibilitySeverityOf(finding.code);
    if (finding.severity !== severity) {
      throw new Error(
        `feasibility: ${question} carries "${finding.code}" at severity ${JSON.stringify(finding.severity)}, but the frozen table registers it as "${severity}"`
      );
    }
  }
  return findings;
}

/**
 * Build a feasibility finding. `severity` is looked up, never passed in.
 *
 * @param {string} code - a {@link FEASIBILITY_REASON} value
 * @param {string} message - for humans only
 * @param {Record<string, unknown>} [details] - flat primitives and ids only
 * @returns {import('./types.js').FeasibilityFinding}
 */
export function makeFeasibilityFinding(code, message, details = {}) {
  return { code, severity: feasibilitySeverityOf(code), message, details };
}

/**
 * Derive the status of an **answer** mechanically from its findings.
 *
 * @param {ReadonlyArray<import('./types.js').FeasibilityFinding>} findings
 * @returns {string} a {@link FEASIBILITY_STATUS} value
 */
export function deriveFeasibilityStatus(findings) {
  return deriveConstraintStatus(
    /** @type {ReadonlyArray<import('../constraints/types.js').ConstraintFinding>} */ (findings)
  );
}

/**
 * **What a severity does to the answer that publishes it. One row per member of
 * the severity enum, and the derivation reads the row rather than naming a
 * severity.**
 *
 * The class of defect this closes has now been reported twice. First `blocked`
 * was `checkPlacement()`'s facility legality while `blockers` was the *merged*
 * list, so four fixtures carrying a blocking `TRAVEL_COMMITMENTS_OVERLAP`
 * sealed `feasible` / `clean`. That was fixed by adding a line about
 * `blocking` — and `compromised` was left on the facility layer's own status,
 * so `combined_schedule.csv#7` and `#18` went on sealing `clean` while
 * publishing a compromise-severity `TRAVEL_BETWEEN_VENUES_TOO_SHORT`. A third
 * line about `compromise` would have been the same fix a third time, and the
 * next severity added to `CONSTRAINT_SEVERITY` would have needed a fourth.
 *
 * So the mapping is a table. Every severity has an entry; the entry names which
 * flag of the derivation it raises, or `null` for the one that raises none; and
 * {@link deriveFeasibilityEvidence} is the only reader. A severity with no row
 * throws rather than being ignored, exactly as {@link feasibilitySeverityOf}
 * throws on an unregistered code, and for the same reason: the alternative is a
 * severity that silently decides nothing.
 *
 * @type {Readonly<Record<string, string|null>>}
 */
export const FEASIBILITY_SEVERITY_EFFECT = Object.freeze({
  /** A definite no. Nothing further can make the position legal. */
  [FEASIBILITY_SEVERITY.BLOCKING]: 'blocked',
  /** Legal and worse than it looks: the position is never `clean`. */
  [FEASIBILITY_SEVERITY.COMPROMISE]: 'compromised',
  /** Provenance. It is reported and it decides nothing. */
  [FEASIBILITY_SEVERITY.INFO]: null,
});

/**
 * **The evidence an answer publishes, folded into the two flags that decide it.**
 *
 * Takes the answer's own severity-bearing records — its `blockers`, first and
 * foremost — and returns what {@link deriveFeasibilityVerdict} and
 * {@link deriveFeasibilityTightness} need. It is the one place a severity is
 * turned into a consequence, so the property "every severity that appears in a
 * published blocker reaches the derivation" is mechanical rather than a habit
 * kept at four call sites.
 *
 * @param {ReadonlyArray<{ severity: string }>} evidence
 * @returns {{ blocked: boolean, compromised: boolean }}
 */
export function deriveFeasibilityEvidence(evidence) {
  if (!Array.isArray(evidence)) {
    throw new Error(
      'feasibility: evidence must be an array of severity-bearing records, never a boolean'
    );
  }
  const derived = { blocked: false, compromised: false };
  for (const record of evidence) {
    if (!Object.hasOwn(FEASIBILITY_SEVERITY_EFFECT, record.severity)) {
      throw new Error(
        `feasibility: evidence carries severity ${JSON.stringify(record.severity)}, which the effect table does not register; a severity nobody decided the meaning of must not decide an answer by default`
      );
    }
    const effect = FEASIBILITY_SEVERITY_EFFECT[record.severity];
    if (effect !== null) derived[effect] = true;
  }
  return derived;
}

/**
 * Does an unknown bear on a verdict?
 *
 * `true` unless the record says otherwise, which is the safe direction: an
 * unknown built by hand with no opinion counts, and only an unknown that has
 * *stated* it cannot change a verdict is discounted.
 *
 * @param {import('./types.js').FeasibilityUnknown} entry
 * @returns {boolean}
 */
export function bearsOnVerdict(entry) {
  return entry.verdictBearing !== false;
}

/**
 * **The only place a verdict is produced.**
 *
 * The order is the whole design and it is deliberately not symmetric:
 *
 * 1. A **definite no wins.** A blocking finding is decisive; no amount of
 *    further information can make a blocked placement legal, so an answer that
 *    also carries unknowns is still `infeasible` — and it still lists them, so
 *    the operator reads "no, and these were not checked either".
 * 2. **An unknown beats a yes, always.** This is rule 3 and rule 4 in one line:
 *    a question the model cannot answer can never come back as `feasible`.
 * 3. Only a clean sweep is `feasible`.
 *
 * `blocked` is compared with `=== true` rather than tested for truthiness, and
 * `unknowns` is a list of records rather than a boolean, precisely because
 * JavaScript's falsy semantics make the collapse free otherwise.
 *
 * **What step 2 counts.** The unknowns that could change the verdict, by
 * {@link bearsOnVerdict}. The distinction is not a loophole and it is not a
 * judgement made here: a constraint whose type maps to `info` in
 * `CONSTRAINT_TYPE_SEVERITY` produces findings that move no status in any
 * derivation in this repository, so an unenforced *preference* cannot be the
 * reason a position is illegal. It is still reported in `unknowns`, and it still
 * compromises the answer's `status`, because "nobody checked whether this
 * schedule is any good" is worth saying — it is just not "this might be
 * illegal". An unenforced `hard` or `soft` constraint bears, and does make the
 * verdict `unknown`.
 *
 * @param {{ blocked: boolean, unknowns: ReadonlyArray<import('./types.js').FeasibilityUnknown> }} input
 * @returns {string} a {@link FEASIBILITY_VERDICT} value
 */
export function deriveFeasibilityVerdict(input) {
  if (typeof input.blocked !== 'boolean') {
    throw new Error(
      `feasibility: "blocked" must be a boolean, not ${JSON.stringify(input.blocked)}; a nullable flag is how an unmeasured value becomes a "no"`
    );
  }
  if (!Array.isArray(input.unknowns)) {
    throw new Error('feasibility: "unknowns" must be an array of stated reasons, never a boolean');
  }
  if (input.blocked === true) return FEASIBILITY_VERDICT.INFEASIBLE;
  if (input.unknowns.some(bearsOnVerdict)) return FEASIBILITY_VERDICT.UNKNOWN;
  return FEASIBILITY_VERDICT.FEASIBLE;
}

/**
 * **The only place a tightness is produced**, exactly as
 * {@link deriveFeasibilityVerdict} is the only place a verdict is.
 *
 * The order of the three tests is the whole design:
 *
 * 1. A verdict that is not `feasible` has **no placement** to make a statement
 *    about, so the answer is `null` — the same rule the boolean carried.
 * 2. **No clean position at all wins over "inside a margin".** They are not
 *    alternatives: when nothing on this ground is clean there is no band to be
 *    inside, so the compromised flag is `false` and the old boolean reported
 *    `false` — "there is room" — about a date offering none.
 * 3. Only then does the stated comfort margin decide between `tight` and
 *    `clean`.
 *
 * `compromised` must be a real boolean and `cleanBoundaryExists` must be a real
 * boolean or an explicit `null`, for the reason `blocked` must be one: a
 * nullable flag read for truthiness is how an unmeasured value becomes a
 * confident answer. `null` there means *"this question has no second threshold"*
 * — a placement question names one position and searches nothing — and never
 * *"nobody looked"*.
 *
 * @param {{ verdict: string, compromised: boolean, cleanBoundaryExists: boolean|null }} input
 * @returns {string|null} a {@link FEASIBILITY_TIGHTNESS} value, or null
 */
export function deriveFeasibilityTightness(input) {
  if (typeof input.compromised !== 'boolean') {
    throw new Error(
      `feasibility: "compromised" must be a boolean, not ${JSON.stringify(input.compromised)}`
    );
  }
  if (input.cleanBoundaryExists !== null && typeof input.cleanBoundaryExists !== 'boolean') {
    throw new Error(
      `feasibility: "cleanBoundaryExists" must be a boolean or an explicit null, not ${JSON.stringify(input.cleanBoundaryExists)}; null means "this question has no second threshold", never "nobody looked"`
    );
  }
  if (input.verdict !== FEASIBILITY_VERDICT.FEASIBLE) return null;
  if (input.cleanBoundaryExists === false) return FEASIBILITY_TIGHTNESS.NO_CLEAN_POSITION;
  return input.compromised ? FEASIBILITY_TIGHTNESS.TIGHT : FEASIBILITY_TIGHTNESS.CLEAN;
}

/**
 * Fresh zeroed counters.
 *
 * Every one is additive, so a per-candidate answer folds into a per-query one
 * without any of them meaning something different at the two scales.
 *
 * @returns {import('./types.js').FeasibilityMeta}
 */
export function createFeasibilityMeta() {
  return {
    /** Distinct questions asked — one per candidate position judged. */
    questionsAsked: 0,
    /** Candidate positions the query set out to judge. */
    candidatesConsidered: 0,
    /** Candidate positions that produced an answer. Must equal the line above. */
    candidatesAnswered: 0,
    /** Calls into `checkPlacement()`, directly or through `attribution/`. */
    placementChecksRun: 0,
    /** Calls into `checkKickoffAvailability()` made to probe a boundary. */
    boundaryProbesRun: 0,
    /** Availability constraints read, applicable or not. */
    constraintsConsulted: 0,
    /** Registry constraints tested for applicability to the subject. */
    registryConstraintsTested: 0,
    /** Claims carried through from `attribution/`. */
    claimsCarried: 0,
    /** Stated unknowns raised. */
    unknownsRaised: 0,
    /** Coach transitions re-evaluated against a hypothesis. */
    travelTransitionsProjected: 0,
    /** Existing fixtures of the subject team compared for a time clash. */
    teamFixturesCompared: 0,
    /**
     * Holdings — games and practices — put into the holder index a move request
     * reads occupancy from.
     *
     * Enumerated from the schedule and the caller's practices, never from the
     * candidate grid: a holder that a broken join dropped must still be counted
     * here, or the counter would testify to the very set the break corrupted.
     */
    holdingsIndexed: 0,
    /** Holder-against-candidate overlap questions put to `bookingsOverlapInTime()`. */
    occupancyPairsCompared: 0,
    /** Capacity-report slots joined to, per (date, surface, kickoff). */
    capacitySlotsJoined: 0,
    /** Two-sided exchanges examined, admissible or not. */
    swapsConsidered: 0,
    /** Individual parties judged at a position inside a swap — two per exchange. */
    swapLegsJudged: 0,
  };
}

/**
 * Fold one set of counters into another.
 *
 * @param {import('./types.js').FeasibilityMeta} target
 * @param {import('./types.js').FeasibilityMeta} source
 * @returns {import('./types.js').FeasibilityMeta}
 */
export function mergeFeasibilityMeta(target, source) {
  for (const key of Object.keys(target)) {
    target[key] += source[key] ?? 0;
  }
  return target;
}
