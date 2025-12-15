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
 * @property {('admin'|'coach'|'player'|'parent')} role - Primary role in the org
 * @property {string} organization_id - UUID of the organization they belong to
 * @property {string} [team_id] - UUID of the team (if player/coach)
 * @property {string} created_at - ISO timestamp
 */

/**
 * @typedef {Object} Team
 * @property {string} id - UUID
 * @property {string} name - Team name (e.g. "U10 Tigers")
 * @property {string} age_group - Age group classification
 * @property {string} organization_id - UUID
 * @property {string} [head_coach_id] - UUID of the assigned head coach
 * @property {string} created_at - ISO timestamp
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

export { };
