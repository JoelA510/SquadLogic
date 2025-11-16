import { evaluatePracticeSchedule } from './practiceMetrics.js';
import { evaluateGameSchedule } from './gameMetrics.js';

const MANUAL_FOLLOW_UP_WARNING_THRESHOLD = 0.05;
const PRACTICE_DAY_DOMINANCE_THRESHOLD = 0.7;
const MIN_ASSIGNMENTS_FOR_DAY_BALANCE_ALERT = 3;

/**
 * Run practice and game schedule evaluations, returning an aggregated
 * dashboard-friendly payload describing overall readiness and key issues.
 *
 * @param {Object} [params]
 * @param {Object} [params.practice] - Practice evaluation inputs.
 * @param {Array<Object>} [params.practice.assignments]
 * @param {Array<Object>} [params.practice.unassigned]
 * @param {Array<Object>} [params.practice.teams]
 * @param {Array<Object>} [params.practice.slots]
 * @param {Object} [params.games] - Game evaluation inputs.
 * @param {Array<Object>} [params.games.assignments]
 * @param {Array<Object>} [params.games.teams]
 * @param {Array<Object>} [params.games.byes]
 * @param {Array<Object>} [params.games.unscheduled]
 * @returns {{
 *   generatedAt: string,
 *   status: 'ok' | 'attention-needed' | 'action-required',
 *   issues: Array<{ category: string, severity: 'warning' | 'error', message: string, details?: Object }>,
 *   practice: ReturnType<typeof evaluatePracticeSchedule> | null,
 *   games: ReturnType<typeof evaluateGameSchedule> | null,
 * }}
 * @throws {TypeError} When provided practice or game payloads omit required arrays expected by the evaluators.
 */
export function runScheduleEvaluations({ practice, games } = {}) {
  if (practice !== undefined && (practice === null || typeof practice !== 'object')) {
    throw new TypeError('practice must be an object when provided');
  }
  if (games !== undefined && (games === null || typeof games !== 'object')) {
    throw new TypeError('games must be an object when provided');
  }

  const practiceResult =
    practice === undefined
      ? null
      : evaluatePracticeSchedule({
          assignments: practice.assignments,
          unassigned: practice.unassigned ?? [],
          teams: practice.teams,
          slots: practice.slots,
        });

  const gameResult =
    games === undefined
      ? null
      : evaluateGameSchedule({
          assignments: games.assignments,
          teams: games.teams,
          byes: games.byes ?? [],
          unscheduled: games.unscheduled ?? [],
          sharedSlotUsage: games.sharedSlotUsage ?? [],
        });

  const issues = [];

  if (practiceResult) {
    const {
      summary: { unassignedTeams, totalTeams, manualFollowUpRate = 0 },
      coachConflicts,
      dataQualityWarnings,
      fairnessConcerns = [],
      underutilizedBaseSlots = [],
    } = practiceResult;

    if (unassignedTeams > 0) {
      issues.push({
        category: 'practice',
        severity: 'error',
        message: `${unassignedTeams} team(s) lack practice assignments`,
        details: {
          unassignedTeams,
          unassignedByReason: practiceResult.unassignedByReason,
        },
      });
    }

    if (
      totalTeams > 0 &&
      manualFollowUpRate > MANUAL_FOLLOW_UP_WARNING_THRESHOLD &&
      Number.isFinite(manualFollowUpRate)
    ) {
      const percentage = parseFloat((manualFollowUpRate * 100).toFixed(1));
      issues.push({
        category: 'practice',
        severity: 'warning',
        message: `Manual follow-up required for ${percentage}% of teams (${unassignedTeams} of ${totalTeams})`,
        details: {
          manualFollowUpRate,
          unassignedTeams,
          totalTeams,
          unassignedByReason: practiceResult.unassignedByReason,
        },
      });
    }

    for (const conflict of coachConflicts) {
      issues.push({
        category: 'practice',
        severity: 'error',
        message: `Coach ${conflict.coachId} has overlapping practices`,
        details: conflict,
      });
    }

    for (const warning of dataQualityWarnings) {
      issues.push({
        category: 'practice',
        severity: 'warning',
        message: warning,
      });
    }

    for (const concern of fairnessConcerns) {
      issues.push({
        category: 'practice',
        severity: 'warning',
        message: concern.message,
        details: concern,
      });
    }

    for (const [division, dayCoverage] of Object.entries(
      practiceResult.divisionDayDistribution ?? {},
    )) {
      const dayBreakdown = dayCoverage.dayBreakdown ?? [];
      const totalAssigned = dayCoverage.totalAssigned ?? 0;

      if (
        totalAssigned < MIN_ASSIGNMENTS_FOR_DAY_BALANCE_ALERT ||
        dayBreakdown.length === 0
      ) {
        continue;
      }

      const dominant = dayBreakdown[0];
      const dominantShare = Number(dominant.percentage ?? 0);

      if (Number.isNaN(dominantShare) || dominantShare < PRACTICE_DAY_DOMINANCE_THRESHOLD) {
        continue;
      }

      const percentageLabel = (dominantShare * 100).toFixed(1).replace(/\.0$/, '');
      issues.push({
        category: 'practice',
        severity: 'warning',
        message: `Division ${division} is concentrated on ${dominant.day} (${percentageLabel}% of ${totalAssigned} assignments)`,
        details: {
          division,
          dominantDay: dominant.day,
          dominantShare,
          totalAssigned,
          dayBreakdown,
        },
      });
    }

    for (const slot of underutilizedBaseSlots) {
      const utilization = Number.isFinite(slot.utilization)
        ? `${(slot.utilization * 100).toFixed(1).replace(/\.0$/, '')}%`
        : 'unknown';
      issues.push({
        category: 'practice',
        severity: 'warning',
        message: `Base slot ${slot.baseSlotId} is underutilized (${slot.totalAssigned}/${slot.totalCapacity} teams, ${utilization})`,
        details: slot,
      });
    }
  }

  if (gameResult) {
    const errorTypes = new Set([
      'team-double-booked',
      'coach-conflict',
      'field-overlap',
    ]);
    for (const warning of gameResult.warnings) {
      issues.push({
        category: 'games',
        severity: errorTypes.has(warning.type) ? 'error' : 'warning',
        message: warning.message,
        details: warning.details,
      });
    }
  }

  const status = determineStatus(issues);

  return {
    generatedAt: new Date().toISOString(),
    status,
    issues,
    practice: practiceResult,
    games: gameResult,
  };
}

function determineStatus(issues) {
  if (issues.some((issue) => issue.severity === 'error')) {
    return 'action-required';
  }
  if (issues.length > 0) {
    return 'attention-needed';
  }
  return 'ok';
}
