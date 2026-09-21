/**
 * Types for the recurring-practice model.
 *
 * JSDoc only — this file emits no runtime value, exactly as
 * `facility/types.js` and `availability/types.js` do.
 *
 * @module practice/types
 */

/**
 * @typedef {Object} PracticeFinding
 * @property {string} code - a `PRACTICE_REASON` value
 * @property {string} severity - a `PRACTICE_SEVERITY` value
 * @property {string} message - for humans only
 * @property {Record<string, unknown>} details
 */

/**
 * A recurring practice slot, schema-parsed.
 *
 * @typedef {Object} PracticeSlot
 * @property {string} id
 * @property {string} surfaceId
 * @property {string} weekday - `'SUN'`…`'SAT'`
 * @property {number} startMinutes
 * @property {number} durationMinutes
 * @property {string|null} validFrom - `null` means the source did not say
 * @property {string|null} validUntil
 * @property {number} capacity
 * @property {string|null} revisionId
 * @property {string|null} label
 */

/**
 * A team's hold on a slot over a range.
 *
 * @typedef {Object} PracticeAssignment
 * @property {string} id
 * @property {string} slotId
 * @property {string} teamId
 * @property {string|null} effectiveFrom - `null` inherits the slot's range
 * @property {string|null} effectiveUntil
 */

/**
 * A dated override on a slot.
 *
 * @typedef {Object} PracticeException
 * @property {string} id
 * @property {string} slotId
 * @property {string} date
 * @property {'cancelled'|'moved'|'shortened'} kind
 * @property {string} reason
 * @property {number|null} startMinutes
 * @property {number|null} durationMinutes
 */

/**
 * A validated, frozen plan.
 *
 * @typedef {Object} PracticeSlotSet
 * @property {ReadonlyArray<PracticeSlot>} slots
 * @property {ReadonlyArray<PracticeAssignment>} assignments
 * @property {ReadonlyArray<string>} slotIds
 * @property {string|null} source
 * @property {ReadonlyArray<PracticeFinding>} findings
 * @property {PracticeSlotSetStats} stats
 */

/**
 * @typedef {Object} PracticeSlotSetStats
 * @property {number} slotCount
 * @property {number} assignmentCount
 * @property {number} teamCount
 * @property {number} surfaceCount
 * @property {number} revisionCount
 * @property {number} undatedSlotCount
 * @property {Record<string, number>} slotsByWeekday
 */

/**
 * One concrete practice on one date.
 *
 * Deliberately the `FacilityBooking` shape (`facility/schemas.js:131-146`)
 * plus the provenance a practice needs, so an occurrence can go straight into
 * `checkOccupancy()` or `findClosureBreaches()` with no adapter.
 *
 * @typedef {Object} PracticeOccurrence
 * @property {string} id
 * @property {string} surfaceId
 * @property {string} date - `YYYY-MM-DD`
 * @property {number} startMinutes
 * @property {number} endMinutes
 * @property {string|null} format - always `null`; the field exists so the shape matches
 * @property {string|null} label
 * @property {string} slotId
 * @property {string|null} revisionId
 * @property {ReadonlyArray<string>} teamIds
 * @property {string|null} exceptionId - the override that altered this occurrence
 */

/**
 * @typedef {Object} PracticeMaterialisation
 * @property {ReadonlyArray<PracticeOccurrence>} occurrences
 * @property {ReadonlyArray<PracticeFinding>} findings
 * @property {string} status - a `PRACTICE_STATUS` value
 * @property {PracticeMaterialisationStats} stats
 */

/**
 * @typedef {Object} PracticeMaterialisationStats
 * @property {string} from
 * @property {string} to
 * @property {number} windowDays
 * @property {number} slotsConsidered
 * @property {number} occurrenceCount
 * @property {number} suppressedCount
 * @property {number} movedCount
 * @property {number} shortenedCount
 * @property {number} exceptionsApplied
 * @property {number} exceptionsUnmatched
 */

/**
 * One phase of a team's practice history: a range over which one arrangement
 * held.
 *
 * @typedef {Object} PracticePhase
 * @property {string|null} from - `null` when the source never dated it
 * @property {string|null} until
 * @property {string} slotId
 * @property {string} surfaceId
 * @property {string} weekday
 * @property {number} startMinutes
 * @property {number} durationMinutes
 * @property {string|null} revisionId
 * @property {string|null} label
 */

/**
 * @typedef {Object} PracticeHistory
 * @property {string} teamId
 * @property {ReadonlyArray<PracticePhase>} phases
 * @property {ReadonlyArray<PracticeFinding>} findings
 * @property {string} status - a `PRACTICE_STATUS` value
 * @property {PracticeHistoryStats} stats
 */

/**
 * @typedef {Object} PracticeHistoryStats
 * @property {number} phaseCount
 * @property {number} datedPhaseCount
 * @property {number} undatedPhaseCount
 * @property {number} overlapCount
 * @property {number} gapCount
 */

export {};
