/**
 * Machine-readable reason codes for schedule scenarios: branching a baseline,
 * materialising a branch, proposing replacements for displaced games, diffing
 * two branches and promoting one to primary.
 *
 * Same two rules as the twelve modules before it:
 *
 * 1. **`code` is the contract, `message` is decoration.** Never parse a message.
 * 2. **Severity lives in a table, never at a call site.**
 *
 * Severities and statuses come from `constraints/reasonCodes.js`, which takes
 * them from the facility module, so a scenario finding lands in the same list as
 * a facility, timing, availability, constraint, waiver, rule, resolve,
 * attribution, people, reserve or publication one, and
 * {@link deriveScenarioStatus} reads nothing but `finding.severity`.
 *
 * @module scenario/reasonCodes
 */

import {
  CONSTRAINT_SEVERITY,
  CONSTRAINT_STATUS,
  deriveConstraintStatus,
} from '../constraints/reasonCodes.js';

/**
 * How badly a finding counts against a scenario result.
 *
 * @readonly
 * @enum {string}
 */
export const SCENARIO_SEVERITY = CONSTRAINT_SEVERITY;

/**
 * The three-state outcome of any check in this module.
 *
 * @readonly
 * @enum {string}
 */
export const SCENARIO_STATUS = CONSTRAINT_STATUS;

/**
 * The record sets a scenario override may edit.
 *
 * A scenario edits **inputs**, never built engines: `buildFacilityGraph()`,
 * `buildAvailabilityCalendar()` and `buildConstraintRegistry()` are pure
 * functions of these arrays, so a branch re-derives rather than mutates. Every
 * set here is one the baseline's {@link import('./types.js').SeasonInputs}
 * carries, and every member of every set carries an `id`.
 *
 * @readonly
 * @enum {string}
 */
export const SCENARIO_RECORD_SET = Object.freeze({
  /** `availability/schemas.js` `PermitWindowSchema` rows. */
  PERMITS: 'permits',
  /** `availability/schemas.js` `SurfaceLightingSchema` rows. */
  LIGHTING: 'lighting',
  /** `facility/schemas.js` `EquipmentWindowSchema` rows. */
  EQUIPMENT: 'equipment',
  /** `constraints/schemas.js` `ConstraintRecordSchema` rows. */
  CONSTRAINTS: 'constraints',
  /** `waivers/schemas.js` waiver records. */
  WAIVERS: 'waivers',
  /** `reserve/schemas.js` `ReservedSlotSchema` rows. */
  RESERVED_SLOTS: 'reservedSlots',
});

/**
 * The four edits a scenario may state.
 *
 * `add`, `remove` and `retype` are **set operations on record arrays, applied
 * before any engine is built**. They do not compete for precedence at
 * consultation time, which is why this module declares no specificity ladder
 * and forks none of the three that exist (`CONSTRAINT_SCOPE_SPECIFICITY`,
 * `WAIVER_SCOPE_SPECIFICITY`, `FREEZE_SCOPE_TIE_BREAK`). Two overrides touching
 * one record id is a **conflict**, reported at blocking, not a question about
 * which is narrower.
 *
 * `venue-unavailable` is the one derived kind, and it is derived for a reason:
 * "this site is gone" written by hand is five blackout rows whose correctness
 * depends on the author having enumerated every weekday and every date
 * exception. Stated once with a `venueId`, the materialiser expands it — and
 * withdraws the venue's own rows as it goes, because a blackout laid *beside* an
 * open window is `PERMIT_PRECEDENCE_AMBIGUOUS` on every consultation for that
 * venue even though `restrictiveness()` applies the blackout.
 *
 * @readonly
 * @enum {string}
 */
export const SCENARIO_OVERRIDE_KIND = Object.freeze({
  /** Append a record the baseline does not hold. */
  ADD: 'add',
  /** Withdraw a record the baseline holds, by id. */
  REMOVE: 'remove',
  /** Change a constraint's hardness, through `retypeConstraint()`. */
  RETYPE: 'retype',
  /** Withdraw a venue, wholly or on named dates. Expands into permit rows. */
  VENUE_UNAVAILABLE: 'venue-unavailable',
});

/**
 * How a replacement slot compares with the ground the game was published on.
 *
 * Two grades and no third, because the facility model has exactly two answers
 * for a size-eligible surface: the lining matches the format, or it does not
 * and `LINING_MISMATCH` says so at `compromise`. **There is deliberately no
 * `undersized` grade** — `SIZE_TOO_SMALL` is blocking and the size policy is
 * downward-closed, so a game is refused rather than placed on ground too small
 * for it. See `docs/SCENARIOS.md` §6.
 *
 * @readonly
 * @enum {string}
 */
export const REPLACEMENT_GRADE = Object.freeze({
  /** Size-eligible and lined for the format. No compromise added. */
  CLEAN: 'clean',
  /** Size-eligible, lined for something else: an added `LINING_MISMATCH`. */
  COMPROMISED: 'compromised',
});

/**
 * How {@link import('./relocation.js').proposeRelocations} orders the slots it
 * offers a displaced game — **one ordering, not a choice of two** (#53).
 *
 * This was `RELOCATION_POLICY`, two comparators of the proposer's own
 * (`nearest-kickoff`: drift first; `prefer-clean`: grade first) beside the
 * objective `resolve/` places every other game by — two definitions of
 * "better" in one package. On the 30 games the 679-run displacement sweep
 * places on a coach overlap, the proposer's pick differed from the objective's
 * best clean option in 19 of 22. Now: clean first (the operator's ruling —
 * a replacement with no compromise code beats any with one), then
 * `resolve/objective.js` `scoreObjective()`, then `candidateSlotsFor()`'s
 * tie-break (kickoff, then surface id). The value is still stated on every
 * proposal and report line, so a reader can check which ordering produced it.
 *
 * @type {string}
 */
export const RELOCATION_RANKING = 'clean-first, then resolve objective';

/**
 * Every reason a scenario check can give.
 *
 * @readonly
 * @enum {string}
 */
export const SCENARIO_REASON = Object.freeze({
  /* -- materialising a branch ---------------------------------------------- */
  /** An override was applied to a base record array. Provenance. */
  SCENARIO_OVERRIDE_APPLIED: 'SCENARIO_OVERRIDE_APPLIED',
  /**
   * Two overrides in one scenario touch the same record id.
   *
   * `blocking`, and deliberately not a precedence question. Overrides are set
   * operations applied before anything is built, so there is no consultation at
   * which one could beat the other; picking a winner would be this module
   * inventing a fourth specificity ladder to resolve an ambiguity the author
   * can simply remove.
   */
  SCENARIO_OVERRIDE_CONFLICT: 'SCENARIO_OVERRIDE_CONFLICT',
  /**
   * A `remove` or `retype` names a record **the branch does not hold at that
   * point** — the baseline never held it, or an earlier override withdrew it.
   *
   * `blocking`: an override that withdraws nothing is a scenario that models
   * something other than what its author wrote, and it would otherwise be
   * indistinguishable from one that worked.
   *
   * The message and `precededBy` say which of the two it was. Since the
   * record-id claim became per authoring scenario, an ancestor's `remove` is a
   * routine way for a descendant's to find nothing, and a finding that blamed
   * the baseline sent the operator to records nobody had touched.
   *
   * **`baselineHeld` is read from the baseline's own record set, never deduced
   * from the preceding edit.** A chain three links long — an `add`, then two
   * `remove`s — leaves the last edit looking like the baseline's row being
   * withdrawn twice, and the message said so about a row the corpus never had.
   */
  SCENARIO_OVERRIDE_TARGET_MISSING: 'SCENARIO_OVERRIDE_TARGET_MISSING',
  /**
   * An `add` uses an id **the branch already holds at that point** — the
   * baseline's own, or one an earlier override added (including the rows a
   * `venue-unavailable` derives). `blocking`, and `precededBy` says whose edit
   * put it there. `baselineHeld` answers the separate question of whether the
   * baseline holds the id, read from the baseline rather than deduced: a
   * `remove` then two `add`s down a chain denied the baseline one of its own
   * records while the last edit was, quite correctly, an `add`.
   */
  SCENARIO_OVERRIDE_ID_COLLIDES: 'SCENARIO_OVERRIDE_ID_COLLIDES',
  /**
   * One override retypes a constraint and another withdraws it.
   *
   * `blocking`. A retype is **deferred**: `retypeConstraint()` is the one place
   * a hardness change is written and it writes the change into the record's own
   * history, so it runs after the registry is built. A withdrawal of the same
   * record leaves it nothing to write on — `requireConstraint()` threw out of
   * `materialiseScenario()`, past the caller that expected findings — and there
   * is no coherent branch to build either way: "this rule is a preference" and
   * "this rule does not exist" are two different seasons. The withdrawal is
   * refused, the retype stands, and the author is told to remove one of the two
   * rather than being handed whichever the ordering happened to favour.
   *
   * `retypedBy` / `retypeType` name the **last** retype queued for that record,
   * because the retypes are applied in order and that is the hardness the
   * branch ends up carrying. With two ancestors retyping one constraint,
   * naming the first reported a type the record does not have.
   *
   * Reachable only across authors: two edits of one record id written by one
   * scenario are {@link SCENARIO_REASON.SCENARIO_OVERRIDE_CONFLICT} first.
   */
  SCENARIO_OVERRIDE_RETYPE_WITHDRAWN: 'SCENARIO_OVERRIDE_RETYPE_WITHDRAWN',
  /**
   * An override changed no result at all: the branch's schedule, its violations
   * and its capacity are identical to the baseline's.
   *
   * `compromise`, mirroring `CONSTRAINT_PROJECTION_VACUOUS` exactly. A scenario
   * that reports "nothing changed" having modelled a venue the schedule never
   * uses is the same shape as a query that examined nothing and reported a
   * clean answer — incident 4.
   */
  SCENARIO_OVERRIDE_VACUOUS: 'SCENARIO_OVERRIDE_VACUOUS',
  /** This scenario branches from another scenario, and the overrides compose. */
  SCENARIO_BRANCHED_FROM_SCENARIO: 'SCENARIO_BRANCHED_FROM_SCENARIO',
  /**
   * The ancestry handed for a branch of a branch is not the parent chain the
   * branch names — the wrong parent, a broken chain, one crossing baselines, or
   * none at all where the branch names one.
   *
   * `blocking`. `composedOverrides()` applies whatever array it is given, so an
   * unchecked ancestry composes a stranger's edits under this branch's own id
   * and produces a fingerprint that looks entirely legitimate.
   * `materialiseScenario()` refuses outright; this code is how the reporting
   * entry points — {@link import('./run.js').ScenarioMemo.check} — say the same
   * thing without throwing at a caller who is reconciling a cache.
   */
  SCENARIO_ANCESTRY_UNRESOLVED: 'SCENARIO_ANCESTRY_UNRESOLVED',

  /* -- the memo ------------------------------------------------------------ */
  /**
   * A cached scenario result was read whose fingerprint no longer matches the
   * inputs and overrides it was derived from.
   *
   * `blocking`. A scenario holds no schedule and no diff on purpose — a stored
   * diff describes a baseline that may no longer exist, which is incident 1's
   * shape in a new place — so the one thing that *is* cached is fingerprinted,
   * and a stale read is refused rather than served.
   */
  SCENARIO_RESULT_STALE: 'SCENARIO_RESULT_STALE',

  /* -- what the branch displaced ------------------------------------------- */
  /**
   * Games the scenario leaves standing somewhere its own engines refuse.
   * Aggregate, with the codes that grew and a sample of the ids.
   */
  SCENARIO_GAME_DISPLACED: 'SCENARIO_GAME_DISPLACED',

  /* -- relocation ---------------------------------------------------------- */
  /**
   * Replacement slots were proposed. Names the policy, the surfaces and the
   * grades — never the solver, which did not find them.
   */
  SCENARIO_RELOCATION_PROPOSED: 'SCENARIO_RELOCATION_PROPOSED',
  /**
   * Some replacements are legal but wrongly lined. `compromise`, because that
   * is exactly what the facility model calls playing a format on ground painted
   * for another one, and a scenario report that buried it would be hiding the
   * price of the branch.
   */
  SCENARIO_RELOCATION_COMPROMISED: 'SCENARIO_RELOCATION_COMPROMISED',
  /**
   * A displaced game has no replacement slot at all and is carried as
   * TIME TBD / LOCATION TBD with a reason (incident 10). `compromise`.
   */
  SCENARIO_RELOCATION_UNAVAILABLE: 'SCENARIO_RELOCATION_UNAVAILABLE',
  /**
   * The proposer was switched off for this run. The negative control, and it
   * says so on the record rather than only in a test name.
   */
  SCENARIO_RELOCATIONS_DISABLED: 'SCENARIO_RELOCATIONS_DISABLED',

  /* -- the diff ------------------------------------------------------------ */
  /**
   * The games-moved partition does not reconcile against both inputs.
   * `blocking`, and falsifiable through the exported
   * {@link import('./diff.js').scheduleDiffPartitionFindings}.
   */
  SCENARIO_DIFF_PARTITION_INCOMPLETE: 'SCENARIO_DIFF_PARTITION_INCOMPLETE',
  /**
   * A diff that compared no game, or a quality delta neither side measured.
   * `compromise` — "nothing changed" and "nothing was compared" read the same
   * to a tired operator and only one of them is news.
   */
  SCENARIO_DIFF_VACUOUS: 'SCENARIO_DIFF_VACUOUS',
  /**
   * A capacity delta, for one stated (dates, format, surfaces) subject.
   *
   * There is **no single capacity-lost scalar** and this code is per subject
   * for that reason: `ReserveCapacityInputSchema` requires a format, a surface
   * set, a date set, a first kickoff and a requirement, so a headline number
   * over "capacity" would be a fabrication.
   */
  SCENARIO_CAPACITY_DELTA: 'SCENARIO_CAPACITY_DELTA',
  /**
   * A diff was asked for capacity and no subject was stated, so it reports
   * none. `compromise` rather than silence, for the reason above.
   */
  SCENARIO_CAPACITY_SUBJECT_UNSTATED: 'SCENARIO_CAPACITY_SUBJECT_UNSTATED',

  /* -- promotion ----------------------------------------------------------- */
  /** A scenario became primary, with the diff recorded on the promotion. */
  SCENARIO_PROMOTED: 'SCENARIO_PROMOTED',
  /**
   * Promotion was refused because the recorded diff carries blocking findings
   * the caller did not accept by code. `blocking`.
   */
  SCENARIO_PROMOTION_REFUSED: 'SCENARIO_PROMOTION_REFUSED',
});

/**
 * Severity of every reason code. **The frozen table.**
 *
 * @type {Readonly<Record<string, string>>}
 */
export const SCENARIO_REASON_SEVERITY = Object.freeze({
  [SCENARIO_REASON.SCENARIO_OVERRIDE_APPLIED]: SCENARIO_SEVERITY.INFO,
  [SCENARIO_REASON.SCENARIO_OVERRIDE_CONFLICT]: SCENARIO_SEVERITY.BLOCKING,
  [SCENARIO_REASON.SCENARIO_OVERRIDE_TARGET_MISSING]: SCENARIO_SEVERITY.BLOCKING,
  [SCENARIO_REASON.SCENARIO_OVERRIDE_ID_COLLIDES]: SCENARIO_SEVERITY.BLOCKING,
  [SCENARIO_REASON.SCENARIO_OVERRIDE_RETYPE_WITHDRAWN]: SCENARIO_SEVERITY.BLOCKING,
  [SCENARIO_REASON.SCENARIO_OVERRIDE_VACUOUS]: SCENARIO_SEVERITY.COMPROMISE,
  [SCENARIO_REASON.SCENARIO_BRANCHED_FROM_SCENARIO]: SCENARIO_SEVERITY.INFO,
  [SCENARIO_REASON.SCENARIO_ANCESTRY_UNRESOLVED]: SCENARIO_SEVERITY.BLOCKING,

  [SCENARIO_REASON.SCENARIO_RESULT_STALE]: SCENARIO_SEVERITY.BLOCKING,

  [SCENARIO_REASON.SCENARIO_GAME_DISPLACED]: SCENARIO_SEVERITY.INFO,

  [SCENARIO_REASON.SCENARIO_RELOCATION_PROPOSED]: SCENARIO_SEVERITY.INFO,
  [SCENARIO_REASON.SCENARIO_RELOCATION_COMPROMISED]: SCENARIO_SEVERITY.COMPROMISE,
  [SCENARIO_REASON.SCENARIO_RELOCATION_UNAVAILABLE]: SCENARIO_SEVERITY.COMPROMISE,
  [SCENARIO_REASON.SCENARIO_RELOCATIONS_DISABLED]: SCENARIO_SEVERITY.INFO,

  [SCENARIO_REASON.SCENARIO_DIFF_PARTITION_INCOMPLETE]: SCENARIO_SEVERITY.BLOCKING,
  [SCENARIO_REASON.SCENARIO_DIFF_VACUOUS]: SCENARIO_SEVERITY.COMPROMISE,
  [SCENARIO_REASON.SCENARIO_CAPACITY_DELTA]: SCENARIO_SEVERITY.INFO,
  [SCENARIO_REASON.SCENARIO_CAPACITY_SUBJECT_UNSTATED]: SCENARIO_SEVERITY.COMPROMISE,

  [SCENARIO_REASON.SCENARIO_PROMOTED]: SCENARIO_SEVERITY.INFO,
  [SCENARIO_REASON.SCENARIO_PROMOTION_REFUSED]: SCENARIO_SEVERITY.BLOCKING,
});

/**
 * Severity of a scenario reason code.
 *
 * Throws on an unknown code rather than defaulting to `info`, for the same
 * reason the twelve modules before it do: a code with no severity is a code
 * somebody misspelled, and defaulting would make it silently non-blocking.
 *
 * @param {string} code
 * @returns {string} a {@link SCENARIO_SEVERITY} value
 */
export function scenarioSeverityOf(code) {
  const severity = SCENARIO_REASON_SEVERITY[code];
  if (!severity) {
    throw new Error(`scenario: reason code "${code}" has no registered severity`);
  }
  return severity;
}

/**
 * Build a scenario finding. `severity` is looked up, never passed in.
 *
 * @param {string} code - a {@link SCENARIO_REASON} value
 * @param {string} message - for humans only
 * @param {Record<string, unknown>} [details] - flat primitives and ids only
 * @returns {import('./types.js').ScenarioFinding}
 */
export function makeScenarioFinding(code, message, details = {}) {
  return { code, severity: scenarioSeverityOf(code), message, details };
}

/**
 * Derive the status of a result mechanically from its findings.
 *
 * @param {ReadonlyArray<import('./types.js').ScenarioFinding>} findings
 * @returns {string} a {@link SCENARIO_STATUS} value
 */
export function deriveScenarioStatus(findings) {
  return deriveConstraintStatus(
    /** @type {ReadonlyArray<import('../constraints/types.js').ConstraintFinding>} */ (findings)
  );
}

/**
 * Fresh zeroed counters.
 *
 * Incident 4 is a validator that matched zero records and reported a perfect
 * score. Every result in this module carries these so a test can assert the
 * work was not vacuous — and the three named falsifications in
 * `docs/SCENARIOS.md` §8 each rest on one of them.
 *
 * @returns {import('./types.js').ScenarioMeta}
 */
export function createScenarioMeta() {
  return {
    /** Overrides this scenario states, including a parent's. */
    overridesDeclared: 0,
    /** Overrides the materialiser applied at least one edit for. */
    overridesApplied: 0,
    /**
     * Primitive record edits those overrides became.
     *
     * One `venue-unavailable` is one override and seventeen edits, and keeping
     * the two under one name is what reported "17 applied against 1 declared".
     */
    recordEditsApplied: 0,
    /** Records the overrides added. */
    recordsAdded: 0,
    /** Records the overrides withdrew. */
    recordsRemoved: 0,
    /** Constraints retyped through `retypeConstraint()`. */
    recordsRetyped: 0,
    /**
     * Record arrays carried through from the base **by reference**.
     *
     * The sharing guarantee is structural rather than promised, and this is the
     * number that proves it: a set no override touches is the same array object
     * the baseline holds, so a constraint fixed once is fixed in every branch.
     */
    recordSetsShared: 0,
    /** Record arrays the overrides rebuilt. */
    recordSetsRebuilt: 0,
    /** Games judged against the branch's engines. */
    gamesExamined: 0,
    /** Games the branch leaves standing somewhere its engines refuse. */
    gamesDisplaced: 0,
    /** Candidate replacement slots the proposer scored. */
    candidatesConsidered: 0,
    /**
     * Candidates refused because they would put a team in two places at once.
     *
     * `checkKickoffAvailability()` is a statement about *ground*: it knows who
     * is standing on a surface, never who is playing. A team clash is therefore
     * the proposer's own check, and this is the number that proves it ran.
     */
    candidatesRefusedTeamClash: 0,
    /** Free, team-clean slots `resolve/`'s facility model or rule gate refused (#53). */
    candidatesRefusedByGate: 0,
    /** Reserved slots the proposer treated as ground already held. */
    reservedSlotsHonoured: 0,
    /** Displaced games given a replacement slot. */
    relocationsProposed: 0,
    /** Of those, replacements that add a lining compromise. */
    relocationsCompromised: 0,
    /** Displaced games with no replacement slot at all. */
    relocationsUnavailable: 0,
    /** Games compared, from both sides, by the schedule diff. */
    gamesCompared: 0,
    /** Games the diff found in the same slot on both sides. */
    gamesUnchanged: 0,
    /** Games the diff found in different slots. */
    gamesChanged: 0,
    /** Games only the right-hand side holds. */
    gamesAdded: 0,
    /** Games only the left-hand side holds. */
    gamesRemoved: 0,
    /** Violation codes compared across the two rule-engine runs. */
    violationCodesCompared: 0,
    /** Capacity subjects the diff was given. */
    capacitySubjectsCompared: 0,
    /** Scenarios promoted. */
    scenariosPromoted: 0,
  };
}

/**
 * Fold one set of counters into another, in place.
 *
 * @param {import('./types.js').ScenarioMeta} target
 * @param {import('./types.js').ScenarioMeta} source
 * @returns {import('./types.js').ScenarioMeta}
 */
export function mergeScenarioMeta(target, source) {
  for (const key of Object.keys(target)) {
    target[key] += source[key] ?? 0;
  }
  return target;
}
