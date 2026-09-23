/**
 * Types for schedule scenarios.
 *
 * JSDoc typedefs only — this file emits no runtime code.
 *
 * @module scenario/types
 */

/**
 * One finding. Same shape as every module since Phase 1.1.
 *
 * @typedef {Object} ScenarioFinding
 * @property {string} code - a `SCENARIO_REASON` value
 * @property {string} severity - looked up from the frozen table, never passed in
 * @property {string} message - for humans only; never parsed
 * @property {Record<string, unknown>} details - flat primitives and ids
 */

/**
 * **One immutable bundle of inputs per baseline.**
 *
 * These are *inputs*, not built engines. `buildFacilityGraph()`,
 * `buildAvailabilityCalendar()` and `buildConstraintRegistry()` are pure
 * functions of them, so a scenario re-derives its engines from
 * `base ∪ overrides` rather than mutating anything a sibling can see.
 *
 * @typedef {Object} SeasonInputs
 * @property {string} id
 * @property {string} label
 * @property {import('../ruleEngine/types.js').Schedule} schedule - the baseline
 * @property {Object} facilityInput - `FacilityGraphInputSchema` input, **minus** `equipmentWindows`
 * @property {Object} timingInput - `FormatTimingTableInputSchema` input
 * @property {ReadonlyArray<Object>} permits - `PermitWindowSchema` rows
 * @property {ReadonlyArray<Object>} sunsets - `SunsetRecordSchema` rows
 * @property {ReadonlyArray<Object>} lighting - `SurfaceLightingSchema` rows
 * @property {ReadonlyArray<Object>} equipment - `EquipmentWindowSchema` rows
 * @property {ReadonlyArray<Object>} constraints - `ConstraintRecordSchema` rows
 * @property {ReadonlyArray<Object>} waivers - waiver records
 * @property {ReadonlyArray<Object>} reservedSlots - `ReservedSlotSchema` rows
 * @property {{ name: string, source: string|null }} registry - what the built registry is called
 * @property {{ sunsetMarginMinutes: number, permitMarginMinutes: number, source: string|null }} calendarOptions
 * @property {Object} venueComplexes - the Phase 2.2 complex map, passed to the rule engine unchanged
 * @property {string} digest - a content digest over every record array above
 */

/**
 * One edit a scenario states. A tagged union over one named record set.
 *
 * @typedef {Object} ScenarioOverride
 * @property {string} kind - a `SCENARIO_OVERRIDE_KIND` value
 * @property {string|null} recordSet - a `SCENARIO_RECORD_SET` value; null for `venue-unavailable`
 * @property {Object|null} record - `add` only
 * @property {string|null} recordId - `remove` and `retype` only
 * @property {string|null} type - `retype` only: a `CONSTRAINT_TYPE` value
 * @property {number|null} weight - `retype` only
 * @property {string|null} venueId - `venue-unavailable` only
 * @property {ReadonlyArray<string>|null} dates - `venue-unavailable` only; null means the whole season
 * @property {string} by - who asked for this edit
 * @property {string|null} at - naive `YYYY-MM-DDTHH:MM:SS`, supplied by the caller; never a clock read
 * @property {string} reason - why, in words
 */

/**
 * A branch of a baseline. **Holds no schedule and no records** — only the edits.
 *
 * @typedef {Object} ScheduleScenario
 * @property {string} id
 * @property {string} name
 * @property {string} baselineId - the `SeasonInputs` this branches from
 * @property {string|null} parentScenarioId - another scenario whose overrides compose under this one
 * @property {ReadonlyArray<ScenarioOverride>} overrides
 * @property {string} rationale
 * @property {string} requestedBy
 * @property {string|null} createdAt - naive `YYYY-MM-DDTHH:MM:SS`, an input
 */

/**
 * What a scenario looks like once its overrides are applied to the base arrays.
 *
 * @typedef {Object} MaterialisedScenario
 * @property {ScheduleScenario} scenario
 * @property {SeasonInputs} inputs
 * @property {ReadonlyArray<ScenarioOverride>} overrides - the parent's, then this scenario's
 * @property {Record<string, ReadonlyArray<Object>>} records - the effective record arrays
 * @property {ReadonlyArray<string>} sharedRecordSets - sets carried through by reference
 * @property {Object} engines - `{ graph, table, calendar, registry, resources }`
 * @property {string} fingerprint - a structural digest over the base arrays plus the override list
 * @property {ScenarioFinding[]} findings
 * @property {string} status
 * @property {ScenarioMeta} meta
 */

/**
 * One replacement slot a proposer offers a displaced game.
 *
 * @typedef {Object} RelocationProposal
 * @property {string} gameId
 * @property {string} label
 * @property {string} format
 * @property {string} ranking - `RELOCATION_RANKING`: resolve's objective, clean first
 * @property {number} score - `scoreObjective()` of the replacement, as `resolve/` scores it
 * @property {string} grade - a `REPLACEMENT_GRADE` value
 * @property {import('../resolve/types.js').Slot} from
 * @property {import('../resolve/types.js').Slot} to
 * @property {string} fromVenueId
 * @property {string} toVenueId
 * @property {number} driftMinutes - absolute, and only ever within one date
 * @property {ReadonlyArray<string>} compromiseCodes - the codes the replacement adds
 * @property {number} candidatesConsidered - slots offered to this game before any filter
 */

/**
 * A displaced game with nowhere to go.
 *
 * @typedef {Object} UnrelocatableGame
 * @property {string} gameId
 * @property {string} label
 * @property {string} reason
 * @property {ReadonlyArray<string>} codes - the blocking codes the branch introduced
 * @property {ReadonlyArray<string>} constraintIds
 * @property {number} candidatesConsidered - slots offered to this game before any filter, none of which was legal
 */

/**
 * What {@link import('./relocation.js').proposeRelocations} returns.
 *
 * @typedef {Object} RelocationPlan
 * @property {string} ranking - `RELOCATION_RANKING`
 * @property {ReadonlyArray<string>} surfaceIds - the stated candidate ground
 * @property {RelocationProposal[]} proposals
 * @property {UnrelocatableGame[]} unrelocatable
 * @property {Object[]} capacities - every `buildReserveCapacityReport()` the grid was built from, one per displaced format, whole. Was `capacity`, which held the first report only and dropped every report's `findings` and `status` — so `RESERVE_CAPACITY_VACUOUS` and `RESERVED_SLOT_UNCOVERED`, both blocking, reached neither this plan's `findings` nor `promoteScenario()`'s gate.
 * @property {ScenarioFinding[]} findings
 * @property {string} status
 * @property {ScenarioMeta} meta
 */

/**
 * One game that stands somewhere the branch's engines refuse.
 *
 * @typedef {Object} DisplacedGame
 * @property {string} gameId
 * @property {string} label
 * @property {string} date
 * @property {string} venueId
 * @property {string} surfaceId
 * @property {number} startMinutes
 * @property {string|null} format
 * @property {ReadonlyArray<string>} codes - blocking codes the branch introduced for it
 * @property {ReadonlyArray<string>} constraintIds
 */

/**
 * The three things a scenario comparison is optimised for, and the quality
 * delta beside them.
 *
 * @typedef {Object} ScenarioDiff
 * @property {string} subject - what this is a comparison of, in words
 * @property {string} leftLabel
 * @property {string} rightLabel
 * @property {{ changed: import('../resolve/types.js').ScheduleChange[], added: import('../resolve/types.js').ScheduleChange[], removed: import('../resolve/types.js').ScheduleChange[], unchanged: number }} games
 * @property {{ byCode: Record<string, { left: number, right: number, delta: number }>, bySeverity: Record<string, { left: number, right: number, delta: number }>, newlyViolated: string[], noLongerViolated: string[], measured: boolean }} constraints
 * @property {Array<ScenarioCapacityDelta>} capacity
 * @property {{ left: number, right: number, delta: number, measured: boolean }} quality
 * @property {ScenarioFinding[]} findings
 * @property {string} status
 * @property {ScenarioMeta} meta
 */

/**
 * Capacity for one stated subject, on both sides.
 *
 * @typedef {Object} ScenarioCapacityDelta
 * @property {string} name
 * @property {string} format
 * @property {ReadonlyArray<string>} surfaceIds
 * @property {ReadonlyArray<string>} dates
 * @property {number} leftSlots
 * @property {number} rightSlots
 * @property {number} delta
 * @property {Record<string, { left: number, right: number, delta: number }>} byDate
 */

/**
 * The lazily-derived answer for one scenario. **Never stored on the scenario.**
 *
 * @typedef {Object} ScenarioResult
 * @property {string} scenarioId
 * @property {string} name
 * @property {string} fingerprint
 * @property {import('../ruleEngine/types.js').Schedule} schedule
 * @property {import('../ruleEngine/types.js').Schedule} baselineSchedule
 * @property {MaterialisedScenario} materialised
 * @property {DisplacedGame[]} displaced
 * @property {RelocationPlan} relocations
 * @property {Object|null} run - the `applyChangeRequest()` run that applied the proposals
 * @property {ReadonlyArray<import('../reserve/types.js').UnplacedFixture>} unplaced
 * @property {Object} accounting - `accountForFixtures()` over the baseline's own game ids
 * @property {Object} verification - `runRuleEngine()` over `schedule`, under the branch's engines
 * @property {ScenarioFinding[]} findings
 * @property {string} status
 * @property {ScenarioMeta} meta
 */

/**
 * A scenario promoted to primary, with the diff that justified it.
 *
 * @typedef {Object} ScenarioPromotion
 * @property {string} promotionId
 * @property {string} scenarioId
 * @property {string} baselineId
 * @property {string} fingerprint
 * @property {string} promotedAt - an input; nothing here reads a clock
 * @property {string} promotedBy
 * @property {string} rationale
 * @property {SeasonInputs} primary - the new primary bundle
 * @property {ScenarioDiff} diff - the recorded diff, travelling on the promotion
 * @property {Object} snapshot - a `publication/snapshot.js` snapshot of the promoted rows
 * @property {ReadonlyArray<string>} acceptedFindingCodes
 * @property {string} durability - always `in-memory`
 * @property {ScenarioFinding[]} findings
 * @property {string} status
 * @property {ScenarioMeta} meta
 */

/**
 * Counters proving a scenario result looked at something.
 *
 * @typedef {Object} ScenarioMeta
 * @property {number} overridesDeclared
 * @property {number} overridesApplied
 * @property {number} recordEditsApplied
 * @property {number} recordsAdded
 * @property {number} recordsRemoved
 * @property {number} recordsRetyped
 * @property {number} recordSetsShared
 * @property {number} recordSetsRebuilt
 * @property {number} gamesExamined
 * @property {number} gamesDisplaced
 * @property {number} candidatesConsidered - the sum of the per-game counts
 * @property {number} candidatesRefusedTeamClash
 * @property {number} candidatesRefusedByGate
 * @property {number} reservedSlotsHonoured - slots installed as bookings, not slots handed in
 * @property {number} relocationsProposed
 * @property {number} relocationsCompromised
 * @property {number} relocationsUnavailable
 * @property {number} gamesCompared
 * @property {number} gamesUnchanged
 * @property {number} gamesChanged
 * @property {number} gamesAdded
 * @property {number} gamesRemoved
 * @property {number} violationCodesCompared
 * @property {number} capacitySubjectsCompared
 * @property {number} scenariosPromoted
 */

export {};
