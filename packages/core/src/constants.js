/**
 * Constants for team generation and scheduling.
 */

export const DEFAULT_ALLOWED_ROLES = ['authenticated', 'service_role', 'admin', 'scheduler'];

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
  REASON_InsufficientCapacity: 'insufficient-capacity',
  REASON_Random: 'random assignment',
  REASON_Recovery: 'recovery assignment',
  REASON_ExhaustedRetries: 'exhausted retries',
  REASON_CoachCapacity: 'coach-capacity',
  REASON_Balancing: 'balancing assignment',
  REASON_BuddyTargetCapacity: 'buddy-target-capacity',
  REASON_BuddyTargetLocked: 'buddy-target-locked',
  // A player whose play-up or play-down is blocked (`isEligibilityBlocked`, playUp.js) is
  // never seated by the generator; a rostered one stays and is listed instead (Phase B2).
  REASON_EligibilityBlocked: 'eligibility-blocked',
  // A waitlisted player (`isWaitlisted`, playUp.js) is not seated either; nobody is dropped
  // silently, so each is in overflow with this reason (owner decision, 2026-10-27).
  REASON_Waitlisted: 'waitlisted',
  REASON_Unknown: 'unknown',

  // Limits
  MAX_RETRIES: 100,

  // Weights
  WEIGHT_SkillBalance: 0.6,
  WEIGHT_BuddySatisfaction: 0.2, // Lower weight as it's a constraint, not a goal
  WEIGHT_CoachSatisfaction: 0.2,
};
