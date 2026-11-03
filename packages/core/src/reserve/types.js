/**
 * Types for placeholders, reservations, unplaced fixtures and reserve capacity.
 *
 * JSDoc typedefs only — this file emits no runtime code.
 *
 * @module reserve/types
 */

/**
 * One finding, in the shape every module in this repository uses.
 *
 * @typedef {Object} ReserveFinding
 * @property {string} code - a `RESERVE_REASON` value
 * @property {string} severity - a `RESERVE_SEVERITY` value, looked up from the frozen table
 * @property {string} message - for humans only; never parsed
 * @property {Record<string, unknown>} details - flat primitives and ids
 */

/**
 * The condition under which a slot exists at all.
 *
 * Encoded, not annotated: `surfaceIds` is derived from the facility graph's
 * overlap relation and `evaluateSlotCondition()` checks it against real
 * bookings. A condition nothing evaluates reports `SLOT_CONDITION_UNENFORCED`.
 *
 * @typedef {Object} SlotCondition
 * @property {string} kind - a `SLOT_CONDITION_KIND` value
 * @property {string[]} surfaceIds - the surfaces that must be idle, sorted
 * @property {string} derivedFrom - which relation produced this, for provenance
 * @property {string} reason - a sentence for a human; never parsed
 */

/**
 * A slot the club has committed to before knowing everything about it.
 *
 * `date`, `surfaceId`, `startMinutes`, `endMinutes` and `format` are the
 * **footprint**: the part families already have. `homeTeamId` / `awayTeamId`
 * and the two side kinds are the part that can still change.
 *
 * @typedef {Object} ReservedSlot
 * @property {string} id
 * @property {string} kind - a `RESERVE_KIND` value
 * @property {string} label - what the published schedule calls it
 * @property {string} date - `YYYY-MM-DD`
 * @property {string} venueId
 * @property {string} surfaceId
 * @property {number} startMinutes - minutes past local midnight
 * @property {number|null} endMinutes - null when the format has no timing row (GAP-14)
 * @property {string|null} format
 * @property {string|null} divisionLabel
 * @property {string|null} purpose - reservations only: what the ground is held for
 * @property {string} homeSide - a `FIXTURE_SIDE` value
 * @property {string} awaySide - a `FIXTURE_SIDE` value
 * @property {string|null} homeTeamId - non-null only when `homeSide` is `team`
 * @property {string|null} awayTeamId - non-null only when `awaySide` is `team`
 * @property {string|null} homeLabel - display text for a non-team side
 * @property {string|null} awayLabel - display text for a non-team side
 * @property {SlotCondition|null} condition
 * @property {string|null} source - where this row came from
 */

/**
 * One request to name the teams in a reserved slot.
 *
 * @typedef {Object} SlotBinding
 * @property {string} slotId
 * @property {string|null} homeTeamId
 * @property {string|null} awayTeamId
 */

/**
 * What `applySlotBindings()` produced.
 *
 * @typedef {Object} SlotBindingResult
 * @property {ReservedSlot[]} slots - the whole set, bound where asked
 * @property {string[]} boundSlotIds
 * @property {ReserveFinding[]} findings
 * @property {string} status
 * @property {ReserveMeta} meta
 */

/**
 * What evaluating one slot's condition concluded.
 *
 * @typedef {Object} ConditionEvaluation
 * @property {string} slotId
 * @property {string} verdict - a `CONDITION_VERDICT` value
 * @property {string[]} surfaceIds - the surfaces the condition names
 * @property {string[]} blockingBookingIds - what was standing there
 * @property {string[]} undecidableBookingIds - what could not be judged
 * @property {ReserveFinding[]} findings
 * @property {ReserveMeta} meta
 */

/**
 * A fixture that must exist and has no legal slot.
 *
 * Incident 10: visible, counted, exported with a reason — never dropped.
 *
 * @typedef {Object} UnplacedFixture
 * @property {string} fixtureId
 * @property {string} label
 * @property {string|null} date - null when even the date is not settled
 * @property {string|null} format
 * @property {string|null} divisionLabel
 * @property {string|null} homeTeamId
 * @property {string|null} awayTeamId
 * @property {string|null} homeLabel
 * @property {string|null} awayLabel
 * @property {string} timeStatus - always a `PUBLICATION_TBD.TIME` token
 * @property {string} locationStatus - always a `PUBLICATION_TBD.LOCATION` token
 * @property {string} reason - a sentence for a human; never parsed
 * @property {string|null} causeKind - which machinery decided: `constraint`, `global-reoptimisation`, `requested`
 * @property {string[]} reasonCodes - the machine-readable half
 * @property {string[]} constraintIds - registry constraints behind those codes
 * @property {string[]} counterpartFixtureIds - the specific fixtures it clashed with
 * @property {string[]} bindingKinds - the tightest availability edge, from Phase 1.3
 * @property {number|null} slackMinutes - by how much it missed
 * @property {string|null} publishedSurfaceId - where it used to stand
 * @property {number|null} publishedKickoffMinutes
 * @property {string|null} source - which run reported it
 */

/**
 * The reconciliation between what must exist and what a run produced.
 *
 * `placed` and `unplaced` are each source's own claim; `doubleCounted` names the
 * fixtures both claimed, counted once in `accounted`, so `accounted + missing`
 * always equals `expected`.
 *
 * @typedef {Object} FixtureAccounting
 * @property {{ expected: number, placed: number, unplaced: number, doubleCounted: number, accounted: number, missing: number }} totals
 * @property {string[]} placedFixtureIds
 * @property {string[]} unplacedFixtureIds
 * @property {string[]} doubleCountedFixtureIds - expected fixtures reported both placed and unplaced
 * @property {string[]} missingFixtureIds
 * @property {ReserveFinding[]} findings
 * @property {string} status
 * @property {ReserveMeta} meta
 */

/**
 * The stated requirement a date's capacity is judged against.
 *
 * @typedef {Object} CapacityRequirement
 * @property {number} slots - how many slots the date must hold
 * @property {string} label - what the number means, in words
 * @property {string} source - where the number comes from
 */

/**
 * An external cap on how many slots may be *reserved*, as distinct from how many
 * exist.
 *
 * @typedef {Object} CapacityCap
 * @property {number} limit
 * @property {string} label
 * @property {string} source
 */

/**
 * One surface's contribution to one date.
 *
 * @typedef {Object} SurfaceCapacity
 * @property {string} surfaceId
 * @property {string} surfaceName
 * @property {string} venueId
 * @property {boolean} conditional
 * @property {SlotCondition|null} condition
 * @property {number[]} kickoffMinutes - the slots this surface offers, ascending
 * @property {number[]} sunsetWarnedKickoffMinutes - of those, the ones that end past the daylight
 *   limit: legal, and counted, with `SUNSET_MARGIN_VIOLATED` (owner, 2026-11-02)
 * @property {number} sunsetWarnedSlots - how many of them
 * @property {number} slots
 * @property {number} conditionSatisfied
 * @property {number} conditionBlocked
 * @property {number} conditionUndecidable
 * @property {number} reserved
 * @property {number|null} firstRejectedKickoffMinutes - the candidate that ended the run
 * @property {string[]} cappedByKinds - `availability/kickoff.js` binding kinds
 * @property {string[]} blockingCodes
 * @property {string[]} constraintIds
 * @property {number|null} slackMinutes
 */

/**
 * One date of the capacity report.
 *
 * @typedef {Object} DateCapacity
 * @property {string} date
 * @property {number} slots - unconditional + conditional
 * @property {number} unconditionalSlots
 * @property {number} conditionalSlots
 * @property {number} conditionSatisfied
 * @property {number} conditionBlocked
 * @property {number} conditionUndecidable
 * @property {number} available - unconditional + satisfied conditional
 * @property {number} reserved
 * @property {number} assigned - reserved slots whose teams are known
 * @property {number} unassigned
 * @property {number} spare - slots minus reserved
 * @property {number} sunsetWarnedSlots - of `slots`, those that end past the daylight limit
 * @property {boolean} meetsRequirement - on `slots`
 * @property {boolean} availableMeetsRequirement - on `available`
 * @property {boolean} bareMinimum - `slots` equals the requirement exactly
 * @property {boolean} atCap
 * @property {boolean} overCap
 * @property {SurfaceCapacity[]} bySurface
 * @property {Array<{ kind: string, surfaceIds: string[], slotsLostVsBest: number }>} cappedBy
 * @property {ReserveFinding[]} findings
 */

/**
 * The whole capacity answer.
 *
 * @typedef {Object} ReserveCapacityReport
 * @property {string} name
 * @property {string|null} format
 * @property {CapacityRequirement} requirement
 * @property {CapacityCap|null} cap
 * @property {number} cadenceMinutes
 * @property {number} earliestKickoffMinutes
 * @property {DateCapacity[]} dates
 * @property {Record<string, number>} slotsByDate
 * @property {Record<string, number>} bestSlotsBySurface
 * @property {number|null} minSlots
 * @property {number|null} maxSlots
 * @property {number} sunsetWarnedSlots - across every date: the slots that need a lighting
 *   workaround, a subset of what `slotsByDate` counts
 * @property {string[]} bareMinimumDates
 * @property {string} status
 * @property {ReserveFinding[]} findings
 * @property {ReserveMeta} meta
 */

/**
 * One flattened publication row, in the vocabulary
 * `packages/core/src/outputGeneration.js` already uses.
 *
 * @typedef {Object} PublicationRow
 * @property {Record<string, string>} row - keyed by `SCHEDULE_EXPORT_HEADERS` values
 * @property {string} subjectId - the slot or fixture this row is about
 * @property {string|null} teamId - whose row this is, when it belongs to a team
 */

/**
 * Counters.
 *
 * @typedef {Object} ReserveMeta
 * @property {number} slotsExamined
 * @property {number} bindingsApplied
 * @property {number} bindingsRefused
 * @property {number} slotPairsCompared
 * @property {number} slotsMoved
 * @property {number} conditionsDeclared
 * @property {number} conditionsEvaluated
 * @property {number} conditionBookingsCompared
 * @property {number} datesExamined
 * @property {number} surfaceDatesExamined
 * @property {number} candidatesTested
 * @property {number} slotsGenerated
 * @property {number} slotsOtherFormat
 * @property {number} reservedSlotsUncovered
 * @property {number} reservedSlotsMatched
 * @property {number} reservedSlotsOffGrid
 * @property {number} fixturesAccountedFor
 * @property {number} fixturesTimeTbd
 * @property {number} rowsEmitted
 */

export {};
