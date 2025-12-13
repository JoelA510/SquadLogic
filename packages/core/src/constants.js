/**
 * Constants for team generation and scheduling.
 */

export const DEFAULT_ALLOWED_ROLES = ['authenticated', 'service_role'];

export const PERSISTENCE_STATUS = {
    UNAUTHORIZED: 'unauthorized',
    FORBIDDEN: 'forbidden',
    SUCCESS: 'success',
    ERROR: 'error',
    BLOCKED: 'blocked',
};

export const TEAM_GENERATION = {
    // Failure reasons
    REASON_SkillDisparity: 'skill disparity',
    REASON_CoachAssignment: 'coach assignment',
    REASON_BuddyRequest: 'buddy request',
    REASON_Random: 'random assignment',
    REASON_Recovery: 'recovery assignment',
    REASON_ExhaustedRetries: 'exhausted retries',

    // Limits
    MAX_RETRIES: 100,

    // Weights
    WEIGHT_SkillBalance: 0.6,
    WEIGHT_BuddySatisfaction: 0.2, // Lower weight as it's a constraint, not a goal
    WEIGHT_CoachSatisfaction: 0.2
};

export const SCHEDULING = {
    BYE_TEAM: '__BYE__',
};
