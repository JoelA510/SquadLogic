import { evaluatePracticeSchedule } from './practiceMetrics.js';
import { evaluateGameSchedule } from './gameMetrics.js';

const formatPercentage = (value) =>
  (value * 100).toFixed(1).replace(/\.0$/, '');

export function filterRedundantCapacityWarnings(
  dataQualityWarnings = [],
  overbookedSlots = [],
) {
  if (!Array.isArray(dataQualityWarnings) || !Array.isArray(overbookedSlots)) {
    return dataQualityWarnings;
  }

  const overbookedSlotIds = new Set(
    overbookedSlots
      .map((slot) => slot?.slotId)
      .filter((slotId) => typeof slotId === 'string' && slotId.length > 0)
      .map((slotId) => slotId.toLowerCase()),
  );

  if (overbookedSlotIds.size === 0) {
    return dataQualityWarnings;
  }

  return dataQualityWarnings.filter((warning) => {
    const normalizedWarning = String(warning).toLowerCase();

    const referencesOverCapacity =
      normalizedWarning.includes('over capacity') ||
      normalizedWarning.includes('exceeds capacity');

    if (!referencesOverCapacity) {
      return true;
    }

    for (const slotId of overbookedSlotIds) {
      if (normalizedWarning.includes(slotId)) {
        return false;
      }
    }

    return true;
  });
}

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
      dayConcentrationAlerts = [],
      slotUtilization = [],
    } = practiceResult;

    const overbookedSlots = slotUtilization.filter((slot) => slot.overbooked);
    const filteredDataQualityWarnings = filterRedundantCapacityWarnings(
      dataQualityWarnings,
      overbookedSlots,
    );

    for (const slot of overbookedSlots) {
      issues.push({
        category: 'practice',
        severity: 'error',
        message: `Practice slot ${slot.slotId} is over capacity (${slot.assignedCount}/${slot.capacity})`,
        details: slot,
      });
    }

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

    if (totalTeams > 0 && manualFollowUpRate > 0 && Number.isFinite(manualFollowUpRate)) {
      const percentage = parseFloat((manualFollowUpRate * 100).toFixed(1));
      const manualFollowUpBreakdown = practiceResult.manualFollowUpBreakdown ?? [];

      issues.push({
        category: 'practice',
        severity: 'warning',
        message: `Manual follow-up required for ${percentage}% of teams (${unassignedTeams} of ${totalTeams})`,
        details: {
          manualFollowUpRate,
          unassignedTeams,
          totalTeams,
          unassignedByReason: practiceResult.unassignedByReason,
          manualFollowUpBreakdown,
        },
      });

      if (manualFollowUpBreakdown.length > 0) {
        const categorySummary = manualFollowUpBreakdown
          .map((bucket) => {
            const shareLabel = formatPercentage(bucket.percentage ?? 0);
            return `${bucket.category} (${bucket.count} – ${shareLabel}%)`;
          })
          .join(', ');

        issues.push({
          category: 'practice',
          severity: 'warning',
          message: `Manual follow-up categories: ${categorySummary}`,
        });
      }
    }

    for (const conflict of coachConflicts) {
      issues.push({
        category: 'practice',
        severity: 'error',
        message: `Coach ${conflict.coachId} has overlapping practices`,
        details: conflict,
      });
    }

    for (const warning of filteredDataQualityWarnings) {
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

    for (const alert of dayConcentrationAlerts) {
      const percentageLabel = formatPercentage(alert.dominantShare);

      issues.push({
        category: 'practice',
        severity: 'warning',
        message: `Division ${alert.division} is concentrated on ${alert.dominantDay} (${percentageLabel}% of ${alert.totalAssignments} assignments)`,
        details: alert,
      });
    }

    for (const slot of underutilizedBaseSlots) {
      const utilization = Number.isFinite(slot.utilization)
        ? `${formatPercentage(slot.utilization)}%`
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
