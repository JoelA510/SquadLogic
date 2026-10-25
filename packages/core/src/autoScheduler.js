/**
 * @module autoScheduler
 *
 * Hill Climbing optimizer for practice schedules. Takes the same inputs as
 * `schedulePractices` and iteratively improves fairness by applying
 * constraint-respecting mutations (swap, relocate, chain-swap) scored via
 * `evaluatePracticeSchedule` from practiceMetrics.js.
 *
 * Design decisions:
 * - Pure JS, zero framework dependencies — runs in Node (Vitest) and Deno (Edge Function).
 * - Deterministic via seeded PRNG (mulberry32) so runs are reproducible when given the same seed.
 * - Wall-clock budget prevents Edge Function timeouts (default 25 000 ms).
 * - Locked assignments (source === 'locked') are never mutated.
 * - Random restarts escape local optima when score stalls.
 *
 * **Not on a live path, and undated (M4.8, `docs/PLAN_SOLVER_DATE_MODEL.md`
 * Q6, declared).** No frontend or Edge file imports this module: the product's
 * auto-scheduler is the Edge solver (`supabase/functions/_shared/engines/
 * auto-scheduler-solver.ts`), which judges dated occupancy since M4.8. This
 * one still compares each slot's first-occurrence instants and holds a locked
 * assignment for the whole season, so it double-books a coach across
 * staggered slots and blocks a slot with an ended series. It was not ported:
 * a second solver nobody runs would double the test surface for no user.
 * Retiring it is a separate refactor, to be flagged first.
 */

import {
  listTeamCoachIds,
  reservationRefusal,
  reservedDivisionIdsOf,
  schedulePractices,
} from './practiceScheduling.js';
import { evaluatePracticeSchedule } from './practiceMetrics.js';

// ---------------------------------------------------------------------------
// Seeded PRNG — mulberry32 (deterministic, 32-bit state)
// ---------------------------------------------------------------------------

/**
 * Create a seeded pseudo-random number generator.
 * @param {number} seed - Integer seed value.
 * @returns {() => number} Returns values in [0, 1).
 */
export function createPRNG(seed) {
  let state = seed | 0;
  return function mulberry32() {
    state += 0x6d2b79f5;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Configuration defaults
// ---------------------------------------------------------------------------

/** @typedef {'swap' | 'relocate' | 'chain-swap'} MutationType */

/**
 * @typedef {Object} AutoSchedulerConfig
 * @property {number} [timeBudgetMs=25000] - Wall-clock time limit for optimization.
 * @property {number} [maxIterations=2000] - Hard iteration cap.
 * @property {number} [stallLimit=80] - Consecutive non-improving iterations before random restart.
 * @property {number} [maxRestarts=5] - Maximum random restarts before giving up.
 * @property {number} [seed=42] - PRNG seed for determinism.
 * @property {number} [progressInterval=50] - Emit progress callback every N iterations.
 * @property {(progress: ProgressEvent) => void} [onProgress] - Optional progress callback.
 */

/**
 * @typedef {Object} ProgressEvent
 * @property {number} iteration
 * @property {number} bestScore
 * @property {number} currentScore
 * @property {number} elapsedMs
 * @property {number} restartCount
 * @property {string} lastMutation
 */

/**
 * @typedef {Object} AutoSchedulerResult
 * @property {Array<{ teamId: string, slotId: string, source: string }>} assignments
 * @property {Array<Object>} unassigned
 * @property {Object} divisionLoadSummary
 * @property {Object} evaluation - Full practiceMetrics evaluation of best schedule.
 * @property {Object} optimizationMeta - Statistics about the optimization run.
 */

const DEFAULT_CONFIG = {
  timeBudgetMs: 25000,
  maxIterations: 2000,
  stallLimit: 80,
  maxRestarts: 5,
  seed: 42,
  progressInterval: 50,
  onProgress: null,
};

// ---------------------------------------------------------------------------
// Fitness function
// ---------------------------------------------------------------------------

/**
 * Compute a single scalar fitness score from practiceMetrics evaluation output.
 *
 * Higher is better. Weights:
 * - Coverage (assignment rate): 0.30  — getting all teams assigned is critical
 * - Fairness (no dominant division): 0.25  — balanced division distribution
 * - Coach conflict penalty: 0.25  — zero conflicts is mandatory for valid schedules
 * - Utilization balance: 0.10  — even slot usage
 * - Low manual follow-up rate: 0.10  — fewer unresolved issues
 *
 * @param {Object} evaluation - Return value of evaluatePracticeSchedule.
 * @returns {number} Fitness in [0, 1] range.
 */
export function computeFitness(evaluation) {
  const { summary, coachConflicts, fairnessConcerns, slotUtilization } = evaluation;

  // Coverage: ratio of assigned teams
  const coverage = summary.totalTeams > 0 ? summary.assignedTeams / summary.totalTeams : 1;

  // Coach conflict penalty: each conflict drops score
  const conflictPenalty = Math.min(1, (coachConflicts?.length ?? 0) * 0.25);

  // Fairness: count of fairness concern alerts (division dominance, day concentration)
  const fairnessIssues = fairnessConcerns?.length ?? 0;
  const fairnessScore = Math.max(0, 1 - fairnessIssues * 0.15);

  // Utilization balance: standard deviation of utilization rates
  const utilRates = (slotUtilization ?? [])
    .filter((s) => s.capacity > 0)
    .map((s) => s.utilization ?? 0);
  let utilBalance = 1;
  if (utilRates.length > 1) {
    const mean = utilRates.reduce((a, b) => a + b, 0) / utilRates.length;
    const variance = utilRates.reduce((a, r) => a + (r - mean) ** 2, 0) / utilRates.length;
    const stdDev = Math.sqrt(variance);
    utilBalance = Math.max(0, 1 - stdDev);
  }

  // Manual follow-up rate (lower is better)
  const followUpScore = Math.max(0, 1 - (summary.manualFollowUpRate ?? 0));

  return (
    coverage * 0.3 +
    (1 - conflictPenalty) * 0.25 +
    fairnessScore * 0.25 +
    utilBalance * 0.1 +
    followUpScore * 0.1
  );
}

// ---------------------------------------------------------------------------
// Hard constraint checking for mutations
// ---------------------------------------------------------------------------

/**
 * Check if assigning a team to a slot violates hard constraints.
 * Reuses the same logic as practiceScheduling.js without importing private functions.
 *
 * @param {Object} params
 * @param {{ id: string, coachId?: string | null, coachIds: string[], divisionId?: string | null, reservedDivisionIds?: ReadonlySet<string> }} params.team - Carries
 *   `coachIds` (head plus assistants) and the division reservation (D2) precomputed by
 *   `optimizePracticeSchedule`.
 * @param {Object} params.slot
 * @param {Map<string, Array<{ start: Date, end: Date }>>} params.coachAssignments
 * @param {Map<string, number>} params.slotCapacityMap - Remaining capacity per slot.
 * @param {Record<string, { unavailableSlotIds?: string[] }>} params.coachPreferences
 * @returns {{ valid: boolean, reason?: string }}
 */
function checkHardConstraints({ team, slot, coachAssignments, slotCapacityMap, coachPreferences }) {
  // A division reservation (D2), as the seed honours it.
  const reserved = reservationRefusal(team, slot, team.reservedDivisionIds ?? new Set());
  if (reserved) {
    return { valid: false, reason: reserved };
  }

  // Capacity
  if ((slotCapacityMap.get(slot.id) ?? 0) <= 0) {
    return { valid: false, reason: 'no-capacity' };
  }

  // Coach unavailability, for every coach on the team (head plus assistants)
  for (const coachId of team.coachIds) {
    if (coachPreferences[coachId]?.unavailableSlotIds?.includes(slot.id)) {
      return { valid: false, reason: 'coach-unavailable' };
    }
  }

  // Coach time overlap, for every coach on the team
  for (const coachId of team.coachIds) {
    const existing = coachAssignments.get(coachId) ?? [];
    for (const a of existing) {
      if (slot.start < a.end && slot.end > a.start) {
        return { valid: false, reason: 'coach-conflict' };
      }
    }
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Mutation operators
// ---------------------------------------------------------------------------

/**
 * Build the mutable state representation from a schedule result.
 */
function buildState(result, teams, slots, coachPreferences) {
  const assignmentMap = new Map(); // teamId → slotId
  const lockedTeams = new Set();
  const autoTeams = [];

  for (const a of result.assignments) {
    assignmentMap.set(a.teamId, a.slotId);
    if (a.source === 'locked') {
      lockedTeams.add(a.teamId);
    } else {
      autoTeams.push(a.teamId);
    }
  }

  const slotsById = new Map(slots.map((s) => [s.id, s]));
  const teamsById = new Map(teams.map((t) => [t.id, t]));

  // Compute slot capacity map (remaining after all assignments)
  const slotCapacityMap = new Map(slots.map((s) => [s.id, s.capacity]));
  for (const [, slotId] of assignmentMap) {
    slotCapacityMap.set(slotId, (slotCapacityMap.get(slotId) ?? 0) - 1);
  }

  // Build coach assignments timeline
  const coachAssignments = new Map();
  for (const [teamId, slotId] of assignmentMap) {
    const team = teamsById.get(teamId);
    const slot = slotsById.get(slotId);
    if (!team || !slot) continue;
    for (const coachId of team.coachIds) {
      const existing = coachAssignments.get(coachId) ?? [];
      existing.push({ teamId, slotId, start: new Date(slot.start), end: new Date(slot.end) });
      coachAssignments.set(coachId, existing);
    }
  }

  return {
    assignmentMap,
    lockedTeams,
    autoTeams,
    slotsById,
    teamsById,
    slotCapacityMap,
    coachAssignments,
    coachPreferences: coachPreferences ?? {},
    unassignedTeamIds: result.unassigned.map((u) => u.teamId),
  };
}

/**
 * Apply a mutation to the state and return a new assignments array.
 * Returns null if the mutation is invalid (hard constraint violation).
 *
 * @param {Object} state - Mutable state from buildState.
 * @param {() => number} rand - Seeded PRNG.
 * @returns {{ assignments: Array<{ teamId: string, slotId: string, source: string }>, unassigned: Array<{ teamId: string, reason: string }>, type: MutationType } | null}
 */
function mutate(state, rand) {
  const { autoTeams, unassignedTeamIds, slotsById, teamsById, coachPreferences } = state;

  // Choose mutation type based on current state
  const hasUnassigned = unassignedTeamIds.length > 0;
  const hasMultipleAuto = autoTeams.length >= 2;

  const r = rand();
  /** @type {MutationType} */
  let mutationType;

  if (hasUnassigned && r < 0.4) {
    mutationType = 'relocate';
  } else if (hasMultipleAuto && r < 0.85) {
    mutationType = 'swap';
  } else if (hasMultipleAuto && autoTeams.length >= 3) {
    mutationType = 'chain-swap';
  } else if (hasMultipleAuto) {
    mutationType = 'swap';
  } else {
    return null; // Nothing to mutate
  }

  // Clone state for trial
  const newAssignmentMap = new Map(state.assignmentMap);
  const newSlotCapacity = new Map(state.slotCapacityMap);
  const newCoachAssignments = new Map();
  for (const [k, v] of state.coachAssignments) {
    newCoachAssignments.set(k, [...v]);
  }

  const removeAssignment = (teamId) => {
    const slotId = newAssignmentMap.get(teamId);
    if (!slotId) return;
    newAssignmentMap.delete(teamId);
    newSlotCapacity.set(slotId, (newSlotCapacity.get(slotId) ?? 0) + 1);
    const team = teamsById.get(teamId);
    if (!team) return;
    for (const coachId of team.coachIds) {
      const entries = newCoachAssignments.get(coachId) ?? [];
      newCoachAssignments.set(
        coachId,
        entries.filter((e) => e.teamId !== teamId)
      );
    }
  };

  const addAssignment = (teamId, slotId) => {
    const team = teamsById.get(teamId);
    const slot = slotsById.get(slotId);
    if (!team || !slot) return false;

    const check = checkHardConstraints({
      team,
      slot,
      coachAssignments: newCoachAssignments,
      slotCapacityMap: newSlotCapacity,
      coachPreferences,
    });
    if (!check.valid) return false;

    newAssignmentMap.set(teamId, slotId);
    newSlotCapacity.set(slotId, (newSlotCapacity.get(slotId) ?? 0) - 1);
    for (const coachId of team.coachIds) {
      const entries = newCoachAssignments.get(coachId) ?? [];
      entries.push({ teamId, slotId, start: new Date(slot.start), end: new Date(slot.end) });
      newCoachAssignments.set(coachId, entries);
    }
    return true;
  };

  if (mutationType === 'swap') {
    const i = Math.floor(rand() * autoTeams.length);
    let j = Math.floor(rand() * (autoTeams.length - 1));
    if (j >= i) j++;

    const teamA = autoTeams[i];
    const teamB = autoTeams[j];
    const slotA = newAssignmentMap.get(teamA);
    const slotB = newAssignmentMap.get(teamB);

    if (!slotA || !slotB || slotA === slotB) return null;

    // Remove both, then add in swapped positions
    removeAssignment(teamA);
    removeAssignment(teamB);

    if (!addAssignment(teamA, slotB) || !addAssignment(teamB, slotA)) {
      return null; // Hard constraint violation
    }
  } else if (mutationType === 'relocate') {
    // Pick a random unassigned team and try a random slot
    const targetTeamId = hasUnassigned
      ? unassignedTeamIds[Math.floor(rand() * unassignedTeamIds.length)]
      : autoTeams[Math.floor(rand() * autoTeams.length)];

    const slotIds = [...slotsById.keys()];
    const targetSlotId = slotIds[Math.floor(rand() * slotIds.length)];
    const currentSlotId = newAssignmentMap.get(targetTeamId);

    if (currentSlotId === targetSlotId) return null;

    if (currentSlotId) {
      removeAssignment(targetTeamId);
    }

    if (!addAssignment(targetTeamId, targetSlotId)) {
      // Rollback: re-add to original if it had one
      if (currentSlotId) {
        addAssignment(targetTeamId, currentSlotId);
      }
      return null;
    }
  } else if (mutationType === 'chain-swap') {
    // 3-team rotation: A→B's slot, B→C's slot, C→A's slot
    if (autoTeams.length < 3) return null;

    const indices = new Set();
    while (indices.size < 3) {
      indices.add(Math.floor(rand() * autoTeams.length));
    }
    const [iA, iB, iC] = [...indices];
    const teamA = autoTeams[iA];
    const teamB = autoTeams[iB];
    const teamC = autoTeams[iC];
    const slotA = newAssignmentMap.get(teamA);
    const slotB = newAssignmentMap.get(teamB);
    const slotC = newAssignmentMap.get(teamC);

    if (!slotA || !slotB || !slotC) return null;
    if (slotA === slotB || slotB === slotC || slotA === slotC) return null;

    removeAssignment(teamA);
    removeAssignment(teamB);
    removeAssignment(teamC);

    if (
      !addAssignment(teamA, slotB) ||
      !addAssignment(teamB, slotC) ||
      !addAssignment(teamC, slotA)
    ) {
      return null;
    }
  }

  // Build new assignments array
  const assignments = [];
  for (const [teamId, slotId] of newAssignmentMap) {
    const source = state.lockedTeams.has(teamId) ? 'locked' : 'auto';
    assignments.push({ teamId, slotId, source });
  }
  assignments.sort((a, b) => a.teamId.localeCompare(b.teamId) || a.slotId.localeCompare(b.slotId));

  // Determine which teams are now unassigned
  const assignedSet = new Set(newAssignmentMap.keys());
  const unassigned = [...teamsById.keys()]
    .filter((id) => !assignedSet.has(id))
    .map((teamId) => ({ teamId, reason: 'optimizer-unplaced' }));

  return { assignments, unassigned, type: mutationType };
}

// ---------------------------------------------------------------------------
// Main optimizer
// ---------------------------------------------------------------------------

/**
 * Run the Hill Climbing auto-scheduler.
 *
 * @param {Object} params - Same inputs as schedulePractices, plus config.
 * @param {import('./types.js').Team[]} params.teams
 * @param {import('./types.js').PracticeSlot[]} params.slots
 * @param {Record<string, Object>} [params.coachPreferences]
 * @param {Record<string, Object>} [params.divisionPreferences]
 * @param {Array<{ teamId: string, slotId: string }>} [params.lockedAssignments]
 * @param {Object} [params.scoringWeights]
 * @param {string} [params.schoolDayEnd]
 * @param {string} [params.timezone]
 * @param {Partial<AutoSchedulerConfig>} [params.config]
 * @returns {AutoSchedulerResult}
 */
export function optimizePracticeSchedule({
  teams,
  slots,
  coachPreferences = {},
  divisionPreferences = {},
  lockedAssignments = [],
  scoringWeights = {},
  schoolDayEnd,
  timezone,
  config = {},
}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const rand = createPRNG(cfg.seed);
  const startTime = Date.now();

  // 1. Generate greedy seed via existing scheduler
  const seedResult = schedulePractices({
    teams,
    slots,
    coachPreferences,
    divisionPreferences,
    lockedAssignments,
    scoringWeights,
    schoolDayEnd,
    timezone,
  });

  // 2. Evaluate seed
  const seedEval = evaluatePracticeSchedule({
    assignments: seedResult.assignments,
    unassigned: seedResult.unassigned,
    teams,
    slots,
    schoolDayEnd,
    timezone,
  });

  let bestAssignments = seedResult.assignments;
  let bestUnassigned = seedResult.unassigned;
  let bestDivisionLoadSummary = seedResult.divisionLoadSummary;
  let bestEval = seedEval;
  let bestScore = computeFitness(seedEval);

  let currentAssignments = bestAssignments;
  let currentUnassigned = bestUnassigned;
  let currentScore = bestScore;

  let stallCount = 0;
  let restartCount = 0;
  let iteration = 0;
  let improvementCount = 0;
  let lastMutation = 'seed';

  // Prepare team/slot objects with Date instances for constraint checking
  const preparedSlots = slots.map((s) => ({
    ...s,
    start: new Date(s.start),
    end: new Date(s.end),
  }));
  // Every coach per team (head plus assistants), resolved once rather than per mutation.
  // And the division reservations (D2), so a mutation cannot move a team onto
  // another division's slot or a reserved division onto an open one.
  const reservedDivisionIds = reservedDivisionIdsOf(slots);
  const preparedTeams = teams.map((t) => ({
    ...t,
    coachIds: listTeamCoachIds(t),
    reservedDivisionIds,
  }));

  // 3. Hill Climbing loop
  while (iteration < cfg.maxIterations) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= cfg.timeBudgetMs) {
      break;
    }

    iteration++;

    // Build mutable state from current schedule
    const state = buildState(
      { assignments: currentAssignments, unassigned: currentUnassigned },
      preparedTeams,
      preparedSlots,
      coachPreferences
    );

    // Attempt mutation
    const mutated = mutate(state, rand);
    if (!mutated) {
      stallCount++;
      if (stallCount >= cfg.stallLimit && restartCount < cfg.maxRestarts) {
        // Random restart: re-seed with modified scoring weights
        restartCount++;
        stallCount = 0;
        const restartResult = schedulePractices({
          teams,
          slots,
          coachPreferences,
          divisionPreferences,
          lockedAssignments,
          scoringWeights,
          schoolDayEnd,
          timezone,
        });
        currentAssignments = restartResult.assignments;
        currentUnassigned = restartResult.unassigned;
        const restartEval = evaluatePracticeSchedule({
          assignments: currentAssignments,
          unassigned: currentUnassigned,
          teams,
          slots,
          schoolDayEnd,
          timezone,
        });
        currentScore = computeFitness(restartEval);
        lastMutation = 'restart';
      }
      continue;
    }

    // Evaluate candidate
    const candidateEval = evaluatePracticeSchedule({
      assignments: mutated.assignments,
      unassigned: mutated.unassigned,
      teams,
      slots,
      schoolDayEnd,
      timezone,
    });
    const candidateScore = computeFitness(candidateEval);

    if (candidateScore > currentScore) {
      currentAssignments = mutated.assignments;
      currentUnassigned = mutated.unassigned;
      currentScore = candidateScore;
      lastMutation = mutated.type;
      stallCount = 0;
      improvementCount++;

      if (candidateScore > bestScore) {
        bestAssignments = mutated.assignments;
        bestUnassigned = mutated.unassigned;
        bestEval = candidateEval;
        bestScore = candidateScore;
      }
    } else {
      stallCount++;
      if (stallCount >= cfg.stallLimit && restartCount < cfg.maxRestarts) {
        restartCount++;
        stallCount = 0;
        // Restart from seed (deterministic)
        currentAssignments = seedResult.assignments;
        currentUnassigned = seedResult.unassigned;
        currentScore = computeFitness(seedEval);
        lastMutation = 'restart';
      }
    }

    // Progress callback
    if (cfg.onProgress && iteration % cfg.progressInterval === 0) {
      cfg.onProgress({
        iteration,
        bestScore,
        currentScore,
        elapsedMs: Date.now() - startTime,
        restartCount,
        lastMutation,
      });
    }
  }

  const totalElapsed = Date.now() - startTime;

  return {
    assignments: bestAssignments,
    unassigned: bestUnassigned,
    divisionLoadSummary: bestDivisionLoadSummary,
    evaluation: bestEval,
    optimizationMeta: {
      seedScore: computeFitness(seedEval),
      bestScore,
      improvement: bestScore - computeFitness(seedEval),
      iterations: iteration,
      improvements: improvementCount,
      restarts: restartCount,
      elapsedMs: totalElapsed,
      terminationReason:
        totalElapsed >= cfg.timeBudgetMs
          ? 'time-budget'
          : iteration >= cfg.maxIterations
            ? 'max-iterations'
            : 'converged',
    },
  };
}
