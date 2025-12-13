/**
 * @typedef {Object} Player
 * @property {string} id
 * @property {string} division
 * @property {string} [buddyId]
 * @property {string} [coachId]
 * @property {string} [assistantCoachId]
 * @property {number} [skillRating]
 * @property {string} [name]
 * @property {string} [skillTier] - 'novice' | 'developing' | 'advanced'
 * @property {boolean} [willingToCoach]
 * @property {Object} [medicalInfo]
 * @property {Object} [contactInfo]
 */

/**
 * @typedef {Object} Team
 * @property {string} id
 * @property {string} name
 * @property {string} division
 * @property {string|null} [coachId]
 * @property {string[]} [assistantCoachIds]
 * @property {Player[]} [players]
 * @property {number} [skillTotal]
 */

/**
 * @typedef {Object} PracticeSlot
 * @property {string} id
 * @property {string} [baseSlotId]
 * @property {string|Date} start
 * @property {string|Date} end
 * @property {number} capacity
 * @property {string} [day]
 * @property {string} [seasonPhaseId]
 * @property {string} [effectiveFrom]
 * @property {string} [effectiveUntil]
 * @property {string} [fieldId]
 * @property {number} [priority]
 * @property {string} [division]
 * @property {string[]} [assignedTeams]
 * @property {number} [remainingCapacity]
 */

/**
 * @typedef {Object} GameSlot
 * @property {string} id
 * @property {string} [division]
 * @property {number} weekIndex
 * @property {string|Date} start
 * @property {string|Date} end
 * @property {number} capacity
 * @property {string} [fieldId]
 * @property {number} [priority]
 */

/**
 * @typedef {Object} ScoringWeights
 * @property {number} coachPreferredSlot
 * @property {number} coachPreferredDay
 * @property {number} divisionPreferredDay
 * @property {number} divisionSaturationPenalty
 * @property {number} divisionDaySaturationPenalty
 */

/**
 * @typedef {Object} DivisionConfig
 * @property {number} maxRosterSize
 * @property {string[]} [teamNames]
 * @property {string} [teamNamePrefix]
 * @property {string} [format] - e.g. '5v5'
 * @property {number} [targetTeamSize]
 * @property {number} [teamCountOverride]
 */

export { };
