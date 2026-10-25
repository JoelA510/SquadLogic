/**
 * @namespace SquadLogic
 */

/**
 * @typedef {Object} Organization
 * @property {string} id - UUID
 * @property {string} name - Display name of the organization (Club/League)
 * @property {Object} settings - JSON blob for org-specific config
 * @property {string} created_at - ISO timestamp
 */

/**
 * @typedef {Object} Profile
 * @property {string} id - UUID (matches Auth ID)
 * @property {string} email - User email
 * @property {string} full_name - Display name
 * @property {('admin'|'coach'|'staff'|'tenant_admin')} role - Primary role in the org (no
 *   parent or player since 20261024010000)
 * @property {string} organization_id - UUID of the organization they belong to
 * @property {string} [team_id] - UUID of the team (if coach)
 * @property {string} created_at - ISO timestamp
 */

/**
 * @typedef {Object} Team
 * @property {string} id - UUID or generated ID
 * @property {string} name - Team name
 * @property {string} division - Division identifier
 * @property {string} [age_group] - Age group classification
 * @property {string} [organization_id] - UUID
 * @property {string} [coachId] - UUID of the assigned head coach (engine terminology)
 * @property {boolean} [coachNeeded] - True when the team has no head coach yet (placeholder slot)
 * @property {string} [head_coach_id] - UUID of the assigned head coach (DB terminology)
 * @property {string[]} [assistantCoachIds] - Array of assistant coach IDs
 * @property {string|null} [divisionId] - The division's id (D2: matched against a slot's reservation)
 * @property {boolean} [playsGames] - false for a practice-only division's team (D2; absent: plays)
 * @property {number} [skillTotal] - Total skill rating of all players
 * @property {Player[]} [players] - List of players on the team
 * @property {string} [created_at] - ISO timestamp
 */

/**
 * @typedef {Object} Player
 * @property {string} id - UUID
 * @property {string} [first_name] - First name (DB)
 * @property {string} [last_name] - Last name (DB)
 * @property {string} [firstName] - First name (Engine)
 * @property {string} [lastName] - Last name (Engine)
 * @property {string} division - Division identifier
 * @property {number} [skillRating] - Numeric skill level (Engine)
 * @property {number} [skillLevel] - Numeric skill level (Engine/Tests)
 * @property {string} [skill_tier] - DB skill tier (novice, etc)
 * @property {string} [buddyId] - Requested buddy (Engine)
 * @property {string} [buddy_id] - Requested buddy (DB)
 * @property {string} [coachId] - Voluntary coach link (Engine)
 * @property {string} [coach_id] - Voluntary coach link (DB)
 * @property {string} [assistantCoachId] - Voluntary assistant link
 * @property {Record<string, any>} [custom_attributes] - Dynamic attributes
 */

/**
 * @typedef {Object} PracticeSlot
 * @property {string} id
 * @property {string} [day]
 * @property {string} start - ISO string or Date
 * @property {string} end - ISO string or Date
 * @property {number} capacity
 * @property {string|null} [divisionId] - The division the slot is reserved to (D2); absent: open
 */

/**
 * @typedef {Object} GameSlot
 * @property {string} id
 * @property {string} start
 * @property {string} end
 * @property {number} capacity
 * @property {number} [weekIndex] - required by `scheduleGames()`, which refuses a slot without one
 * @property {string} [division] - absent means the slot is shared across divisions
 * @property {string} [fieldId]
 *   - Opaque field identifier. The physical model behind it (venue, parent/child
 *     pitch configurations, spatial overlap, size vs lining, date-scoped
 *     equipment) lives in `facility/`.
 *     @see {@link import('./facility/types.js').FacilitySurface}
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
 * @property {string} id
 * @property {number} teamsCount
 * @property {number} slotsPerWeek
 * @property {number} [maxRosterSize]
 * @property {number} [minRosterSize]
 * @property {number} [targetTeamSize]
 * @property {number} [teamCountOverride]
 * @property {number} [minTeams]
 * @property {number} [maxTeams]
 * @property {string[]} [teamNames]
 * @property {string} [teamNamePrefix]
 */

/**
 * @typedef {Object} Event
 * @property {string} id - UUID
 * @property {string} title - Event title
 * @property {string} start_time - ISO timestamp
 * @property {string} end_time - ISO timestamp
 * @property {('game'|'practice'|'meeting'|'other')} type - Event category
 * @property {string} [location_id] - UUID of the venue/field
 * @property {string} [home_team_id] - UUID (if game)
 * @property {string} [away_team_id] - UUID (if game)
 * @property {string} organization_id - UUID
 * @property {Object} [meta] - Additional JSON data (scores, notes)
 */

/**
 * @typedef {Object} GameScheduleParams
 * @property {Array<Object>} assignments
 * @property {Team[]} teams
 * @property {Array<{ weekIndex: number, division: string, teamId: string }>} [byes]
 * @property {Array<Object>} [unscheduled]
 * @property {Array<Object>} [sharedSlotUsage]
 */

/**
 * @typedef {Object} PersistenceSnapshot
 * @property {string} [lastRunId]
 * @property {Object} [payload]
 * @property {string} [runId]
 */

/**
 * @typedef {Object} PracticePersistenceSnapshot
 * @property {string} [runId]
 * @property {Array<Object>} [assignments]
 * @property {Array<Object>} [slots]
 * @property {Array<Object>} [practiceOverrides]
 * @property {Array<Object>} [runHistory]
 * @property {Array<Object>} [schedulerRuns]
 * @property {Date | null} [lastSyncedAt]
 * @property {Object} [runMetadata]
 * @property {string} [pendingManualOverrideGoal]
 */

/**
 * @typedef {Object} GamePersistenceSnapshot
 * @property {string} [runId]
 * @property {Array<Object>} [assignments]
 * @property {Array<Object>} [runHistory]
 * @property {Array<Object>} [schedulerRuns]
 * @property {Date | null} [lastSyncedAt]
 * @property {Object} [runMetadata]
 */

/**
 * @typedef {Object} TeamPersistenceSnapshot
 * @property {string} [runId]
 * @property {Array<Object>} [teamOverrides]
 * @property {Array<Object>} [manualAssignments]
 * @property {Array<Object>} [runHistory]
 * @property {Array<Object>} [schedulerRuns]
 * @property {Date | null} [lastSyncedAt]
 * @property {Object} [runMetadata]
 * @property {string} [pendingManualOverrideGoal]
 * @property {Record<string, any[]>} [teamsByDivision]
 * @property {Record<string, string>} [divisionIdMap]
 */

export {};
