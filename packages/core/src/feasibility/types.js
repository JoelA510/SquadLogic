/**
 * JSDoc typedefs for the read-only feasibility layer.
 *
 * Type-only module: no runtime exports, ending in `export {};` so it stays a
 * module, exactly like `facility/types.js`, `resolve/types.js` and
 * `attribution/types.js`.
 *
 * The centre of this file is {@link FeasibilityAnswer}, and the three fields
 * that make it the thing the build plan asked for:
 *
 * - `verdict` — three-valued, never two.
 * - `binding` — a **list** of {@link FeasibilityBound}, because two constraints
 *   binding at the same minute is not one constraint binding.
 * - `marginMinutes` — a number with a unit and one stated sign convention,
 *   copied from the module that computed it.
 *
 * @module feasibility/types
 */

/**
 * One machine-readable reason. Identical in shape to every other module's
 * finding, so all twelve merge into one list without a translation layer.
 *
 * @typedef {Object} FeasibilityFinding
 * @property {string} code
 * @property {string} severity
 * @property {string} message
 * @property {Record<string, unknown>} details
 */

/**
 * One question the model could not decide, and why.
 *
 * A record rather than a flag. The whole point of the three-valued verdict is
 * that `unknown` carries *what* was unknown: an answer that said `unknown` with
 * an empty list would be exactly as useless as `false`.
 *
 * @typedef {Object} FeasibilityUnknown
 * @property {string} code - a `FEASIBILITY_REASON` value
 * @property {string} subject - what could not be decided, in one noun phrase
 * @property {string} reason - the owner's own words for why
 * @property {string|null} sourceCode - the owner's reason code, when one raised it
 * @property {string|null} constraintId - the registry constraint at stake, when there is one
 * @property {boolean} verdictBearing - could this undecided thing change the
 *   verdict? Derived, never asserted: a constraint whose type gives its findings
 *   `info` moves no status anywhere in the model, so leaving it unchecked cannot
 *   turn a legal position into an illegal one. A non-bearing unknown is still
 *   reported in full — it is the answer's honesty about what nobody checked —
 *   and it still compromises the answer's `status`; it just does not pretend to
 *   be a reason the position might be illegal
 * @property {Record<string, unknown>} details
 */

/**
 * One constraint at a boundary, with what it would raise one minute later.
 *
 * `raises` is the operational definition of "binding" and the reason this
 * module never has to compare limits itself: a constraint binds at a position
 * when it *speaks* about that position. For a boundary that means one minute
 * past it — the probe in `feasibility/verdict.js` — and for a placement it means
 * at it. Two constraints that both speak are both binding, and neither is the
 * winner.
 *
 * @typedef {Object} FeasibilityBound
 * @property {string} kind - an `AVAILABILITY_CONSTRAINT` value
 * @property {string} source - an `ATTRIBUTION_SOURCE` value
 * @property {string|null} instanceId - the specific record: permit id, booking id, date
 * @property {string|null} constraintId - the registry constraint governing it, when one does
 * @property {number|null} limitMinutes - the owner's own limit
 * @property {number|null} slackMinutes - room remaining at the boundary; see the sign convention
 * @property {Array<{ code: string, severity: string }>} raises - what this
 *   constraint says about the position: one minute past a boundary, at a placement
 */

/**
 * A boundary — the latest or earliest position — at one of the two thresholds.
 *
 * **`claims` and `notApplicable` are about this boundary's own position, and
 * never about another one.** That is the whole rule, and it is narrower than the
 * one this typedef used to state. It said they are *empty* when `kickoffMinutes`
 * is null — "a boundary that does not exist has no position for a constraint to
 * have spoken about" — and the code has never done that: `latestHard` for Summit
 * HS on 2026-09-19 has no kickoff and one claim, `PERMIT_BLACKOUT` naming the
 * permit record, which is the answer to *"why is there no boundary here?"*. The
 * declaration was the thing that was wrong. Deleting the claim to satisfy it
 * would trade the explanation for a shrug, and the bounds sweep in
 * `tests/feasibilityApi.test.js` reads it precisely as an explanation.
 *
 * What must never happen is what did: the clean boundary was once built from the
 * *hard* result, describing a position no minute of the day offered in another
 * minute's constraints. So the rule is stated as the guard that enforces it —
 * `assertBoundaryResult()`, run by `boundaryOf()` where the boundary is built
 * rather than by the caller that supplies the result. A boundary with no
 * position carries the constraints that explain why it has none, which for a
 * clean boundary nobody probed is nothing at all — and, where no legal minute
 * exists, is the refusal itself.
 *
 * **And `claims` is every finding that counts, not only the ones an edge owns.**
 * A finding above `info` that no *applicable* bound of this boundary speaks for
 * becomes a claim of its own through `claimFromFinding()`, which is
 * `claimsFromBounds()`'s contract in `attribution/explain.js` rather than a
 * second one. `latestLegalKickoff()` reports no constraints at all when it finds
 * no legal minute, so its `blocking` `NO_LEGAL_KICKOFF` is owned by nothing, and
 * a positioned bound can carry a `compromise` — `LINING_MISMATCH`,
 * `PERMIT_UNDECLARED`, `OCCUPANCY_FOOTPRINT_UNKNOWN` — that belongs to none of
 * the four edges. Dropping either is how an answer seals on evidence it does not
 * publish.
 *
 * @typedef {Object} FeasibilityBoundary
 * @property {string} threshold - a `FEASIBILITY_THRESHOLD` value
 * @property {number|null} kickoffMinutes - the boundary itself, null when there is none
 * @property {number|null} endMinutes
 * @property {FeasibilityBound[]} binding - every constraint at the boundary; never truncated
 *   to one, and empty when there is no position to bind at
 * @property {number|null} marginMinutes - the tightest binding member's own slack
 * @property {string|null} marginBasis - the `kind` of the bound the margin came from
 * @property {import('../attribution/types.js').ConstraintClaim[]} claims - tightest first,
 *   from the availability answer about this boundary's own position; when there is no
 *   position they are what explains its absence
 * @property {import('../attribution/types.js').InapplicableConstraint[]} notApplicable -
 *   from the same answer, for the same reason
 * @property {number} candidatesTested
 */

/**
 * What a query was asked about.
 *
 * @typedef {Object} FeasibilitySubject
 * @property {string|null} gameId
 * @property {string|null} teamId
 * @property {string|null} surfaceId
 * @property {string|null} venueId
 * @property {string|null} date
 * @property {number|null} kickoffMinutes
 * @property {string|null} format
 */

/**
 * **The answer shape. One shape, every query.**
 *
 * @typedef {Object} FeasibilityAnswer
 * @property {string} question - a `FEASIBILITY_QUESTION` value
 * @property {FeasibilitySubject} subject
 * @property {string} verdict - a `FEASIBILITY_VERDICT` value; three, never two
 * @property {string|null} tight - a `FEASIBILITY_TIGHTNESS` value: `clean`,
 *   `tight`, or `no-clean-position`. `null` whenever the verdict is not
 *   `feasible`, because "not tight" would be a claim about a placement nobody
 *   could judge. A named value rather than a boolean because `false` was doing
 *   two jobs — "there is room" and "nothing here is clean at all" — and the
 *   second is worse than tight rather than better
 * @property {FeasibilityBound[]} binding - the constraint(s) that decided it
 * @property {number|null} marginMinutes - see `FEASIBILITY_MARGIN_CONVENTION`
 * @property {string} marginUnit - always `FEASIBILITY_MARGIN_UNIT`
 * @property {string|null} marginBasis - the `kind` of the bound the margin was
 *   copied from, never merely the first member of `binding`; `null` exactly when
 *   `marginMinutes` is
 * @property {import('../attribution/types.js').ConstraintClaim[]} blockers - tightest first
 * @property {FeasibilityUnknown[]} unknowns - empty exactly when nothing was undecidable
 * @property {import('../attribution/types.js').MinimalBlockingSet|null} minimalSet
 * @property {import('../attribution/types.js').InapplicableConstraint[]} notApplicable
 * @property {FeasibilityFinding[]} findings - about the **answer**, never about the subject
 * @property {FeasibilityMeta} meta
 * @property {string} status - the answer's own integrity, not the subject's verdict
 */

/**
 * One candidate position inside a multi-position query, with its own answer.
 *
 * Every candidate the query set out to judge appears here, including the ones
 * that could not be judged — incident 10's rule applied to a query.
 *
 * @typedef {Object} FeasibilityCandidate
 * @property {string} date
 * @property {string} surfaceId
 * @property {number} kickoffMinutes
 * @property {string} verdict
 * @property {string|null} tight - a `FEASIBILITY_TIGHTNESS` value, or null
 * @property {FeasibilityBound[]} binding
 * @property {number|null} marginMinutes
 * @property {string|null} marginBasis - the `kind` of the bound the margin came
 *   from; `null` exactly when `marginMinutes` is
 * @property {FeasibilityUnknown[]} unknowns
 * @property {import('../attribution/types.js').ConstraintClaim[]} blockers
 * @property {FeasibilityFinding[]} findings - the cell's own answer's findings,
 *   carried whole. Not decoration: `canGameMove()` publishes a compromise that
 *   no claim can name — `FEASIBILITY_EVIDENCE_UNCLAIMED` — as a finding, and a
 *   grid that kept only the claims would seal a cell's tightness on evidence it
 *   had dropped one line earlier, which is what 546 cells of this corpus did
 */

/**
 * *"Can this team play at 6pm in November?"*
 *
 * @typedef {Object} TeamFeasibilityAnswer
 * @property {string} question
 * @property {FeasibilitySubject} subject
 * @property {string} verdict - the roll-up; see `rollUpVerdicts()` for the rule
 * @property {string|null} tight - a `FEASIBILITY_TIGHTNESS` value, or null
 * @property {FeasibilityCandidate[]} candidates - every one asked about, none dropped
 * @property {Record<string, number>} verdictCounts - candidates per verdict
 * @property {string|null} carrierGameId - the team's own fixture used as the subject
 * @property {FeasibilityBound[]} binding
 * @property {number|null} marginMinutes
 * @property {string} marginUnit
 * @property {string|null} marginBasis
 * @property {FeasibilityUnknown[]} unknowns
 * @property {FeasibilityFinding[]} findings
 * @property {FeasibilityMeta} meta
 * @property {string} status
 */

/**
 * *"How late — and how early — can anything kick off here?"*
 *
 * @typedef {Object} KickoffBoundsAnswer
 * @property {string} question
 * @property {FeasibilitySubject} subject
 * @property {string} verdict - `feasible` when a hard boundary exists at all
 * @property {string|null} tight - a `FEASIBILITY_TIGHTNESS` value: `tight` when
 *   the hard boundary is later than the clean one, `no-clean-position` when
 *   there is no clean boundary at all, `clean` when the two coincide
 * @property {FeasibilityBoundary} latestHard
 * @property {FeasibilityBoundary} latestClean
 * @property {number|null} tightBandMinutes - `latestHard - latestClean`; the width of
 *   the band in which a kickoff is legal but compromised
 * @property {FeasibilityBound[]} binding - the hard boundary's binding set
 * @property {number|null} marginMinutes
 * @property {string} marginUnit
 * @property {string|null} marginBasis
 * @property {FeasibilityUnknown[]} unknowns
 * @property {number} searchedFromMinutes
 * @property {number} searchedToMinutes
 * @property {FeasibilityFinding[]} findings
 * @property {FeasibilityMeta} meta
 * @property {string} status
 */

/**
 * One candidate position in a move-request window, judged, with who stands on
 * it.
 *
 * **`occupantIds` and `undecidableOccupantIds` are two lists and never one.**
 * An occupant whose footprint is unknown (GAP-14) is not an empty field and is
 * not a holder either, and a position carrying one is never offered as a
 * vacancy. Folding the second list into the first would refuse ground that may
 * be free; folding it into neither would offer ground that may be taken.
 *
 * @typedef {Object} MoveRequestSlot
 * @property {string} slotId - `reserve/capacity.js`'s own `capacitySlotId()`, so
 *   a slot in this answer and a slot in a capacity report share one spelling
 * @property {string} date
 * @property {string} surfaceId
 * @property {number} kickoffMinutes
 * @property {number|null} endMinutes
 * @property {string} verdict - a `FEASIBILITY_VERDICT` value; three, never two
 * @property {string|null} tight - a `FEASIBILITY_TIGHTNESS` value, or null
 * @property {FeasibilityBound[]} binding
 * @property {number|null} marginMinutes
 * @property {string|null} marginBasis
 * @property {string[]} occupantIds - holdings standing on this ground, sorted
 * @property {string[]} undecidableOccupantIds - holdings that may be, sorted
 * @property {string[]} ownCommitmentClashIds - the subject's own diary, not the ground
 * @property {string[]} travelCodes - what moving here would introduce for its people
 * @property {FeasibilityUnknown[]} unknowns
 */

/**
 * What a counterparty currently satisfies and would lose by exchanging.
 *
 * `objectives` are registry constraint ids, from `registryConstraintIdsFor()`.
 * `codes` is the fuller truth: a code no constraint claims is a real loss with
 * no id, it is listed in `unclaimedCodes`, and it still makes `free` false.
 *
 * @typedef {Object} MoveRequestCost
 * @property {boolean} free - nothing above `info` is newly raised, and no travel
 *   finding is introduced
 * @property {string[]} codes - sorted
 * @property {string[]} objectives - sorted registry constraint ids
 * @property {string[]} unclaimedCodes - codes the registry cannot name
 */

/**
 * One admissible two-sided exchange.
 *
 * Both legs are judged with **both** parties' bookings lifted, by one function,
 * so a swap cannot be admitted under one standard and priced under another.
 *
 * @typedef {Object} MoveRequestSwap
 * @property {string} slotId
 * @property {string} date
 * @property {string} surfaceId
 * @property {number} kickoffMinutes
 * @property {string} counterpartyId
 * @property {string} counterpartyKind - a `MOVE_REQUEST_ENTITY` value
 * @property {{ verdict: string, tight: string|null, binding: FeasibilityBound[], marginMinutes: number|null, marginBasis: string|null }} subjectLeg
 * @property {{ verdict: string, tight: string|null, binding: FeasibilityBound[], marginMinutes: number|null, marginBasis: string|null }} counterpartyLeg
 * @property {MoveRequestCost} cost
 * @property {boolean} free - `cost.free`, carried so that `classifyMoveRequest()`
 *   reads one field rather than reaching into a nested one
 * @property {FeasibilityUnknown[]} unknowns
 */

/**
 * *"What can the club offer this move request?"*
 *
 * `classification` and `verdict` are **two channels and never one**, in the same
 * way `status` and `verdict` already are elsewhere in this module.
 * `classification` says what the club can offer; `verdict` says whether the
 * window could be judged at all. A window that is fully and legally occupied is
 * `infeasible` as a *class* while its positions are perfectly legal, and a
 * window nobody could judge is `unknown` as a *verdict* whatever its class
 * reads.
 *
 * @typedef {Object} MoveRequestAnalysis
 * @property {string} question - always `FEASIBILITY_QUESTION.ANALYSE_MOVE_REQUEST`
 * @property {FeasibilitySubject} subject
 * @property {string} entityKind - a `MOVE_REQUEST_ENTITY` value
 * @property {string} entityId
 * @property {string} classification - a `MOVE_REQUEST_CLASS` value, from
 *   `classifyMoveRequest()` and from nowhere else
 * @property {string} verdict - a `FEASIBILITY_VERDICT` value
 * @property {string|null} tight - a `FEASIBILITY_TIGHTNESS` value, or null
 * @property {MoveRequestSlot[]} feasibleSlots - **every** candidate the grid
 *   offered, including the ones that could not be judged; incident 10's rule
 *   applied to a window, which is why the list is not filtered to the feasible
 *   ones and the counts say how many of each there are
 * @property {MoveRequestSlot[]} vacancies - feasible, unoccupied, and nothing
 *   undecidable standing on them
 * @property {MoveRequestSwap[]} swaps - admissible, legal for both parties
 * @property {{ objectives: Array<{ objective: string, holderCount: number, holderIds: string[], codes: string[] }>, holderCount: number }} zeroSum -
 *   over the **costly** swaps only: which objective each counterparty would
 *   lose, and how many holders rely on it
 * @property {{ candidatesOnGrid: number, feasible: number, infeasible: number, undecidable: number, occupied: number, vacancies: number, swapsAdmissible: number, swapsFree: number, swapsCostly: number }} counts
 * @property {string} marginUnit - always `FEASIBILITY_MARGIN_UNIT`
 * @property {FeasibilityUnknown[]} unknowns
 * @property {FeasibilityFinding[]} findings
 * @property {FeasibilityMeta} meta
 * @property {string} status
 */

/**
 * Counters proving an answer looked at something.
 *
 * @typedef {Object} FeasibilityMeta
 * @property {number} questionsAsked
 * @property {number} candidatesConsidered
 * @property {number} candidatesAnswered - must equal the line above; `seal()`
 *   raises `FEASIBILITY_CANDIDATE_DROPPED` on every answer where it does not,
 *   which is what makes this an invariant rather than a docstring
 * @property {number} placementChecksRun
 * @property {number} boundaryProbesRun
 * @property {number} constraintsConsulted
 * @property {number} registryConstraintsTested
 * @property {number} claimsCarried
 * @property {number} unknownsRaised - counted once, where each was raised
 * @property {number} travelTransitionsProjected
 * @property {number} teamFixturesCompared
 * @property {number} holdingsIndexed
 * @property {number} occupancyPairsCompared
 * @property {number} capacitySlotsJoined
 * @property {number} swapsConsidered
 * @property {number} swapLegsJudged
 */

export {};
