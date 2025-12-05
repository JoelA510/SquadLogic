

function incrementKey(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

/**
 * Evaluate a set of scheduled games for quality, resource utilization, and potential conflicts.
 *
 * @param {Object} params
 * @param {Array<Object>} params.assignments - Scheduled matchups returned from the game scheduler.
 * @param {Array<Object>} params.teams - Team definitions used to map coach assignments.
 * @param {Array<Object>} [params.byes=[]] - Bye records keyed by week and division.
 * @param {Array<Object>} [params.unscheduled=[]] - Unscheduled matchup descriptors with reasons.
 * @returns {{ summary: Object, warnings: Array<Object> }}
 */
export function evaluateGameSchedule({
  assignments,
  teams,
  byes = [],
  unscheduled = [],
  sharedSlotUsage = [],
}) {
  if (!Array.isArray(assignments)) {
    throw new TypeError('assignments must be an array');
  }
  if (!Array.isArray(teams)) {
    throw new TypeError('teams must be an array');
  }
  if (!Array.isArray(byes)) {
    throw new TypeError('byes must be an array');
  }
  if (!Array.isArray(unscheduled)) {
    throw new TypeError('unscheduled must be an array');
  }
  if (!Array.isArray(sharedSlotUsage)) {
    throw new TypeError('sharedSlotUsage must be an array');
  }

  const teamsById = new Map();
  for (const team of teams) {
    if (!team || typeof team !== 'object') {
      throw new TypeError('each team must be an object');
    }
    if (!team.id) {
      throw new TypeError('each team requires an id');
    }
    teamsById.set(team.id, {
      id: team.id,
      division: team.division ?? null,
      coachId: team.coachId ?? null,
    });
  }

  const summary = {
    totalAssignments: assignments.length,
    assignmentsByDivision: {},
    fieldUsage: {},
    teamsWithByes: {},
    unscheduledByReason: {},
    unscheduledByDivision: {},
    teamGameLoad: {},
    sharedSlotUsage: [],
    sharedFieldDistribution: {},
  };

  const warnings = [];
  const seenUnknownTeams = new Set();
  const teamAssignments = new Map();
  const coachAssignments = new Map();
  const fieldAssignments = new Map();
  const teamGameLoad = new Map();

  for (const assignment of assignments) {
    validateAssignment(assignment);

    const start = new Date(assignment.start);
    const end = new Date(assignment.end);
    const division = assignment.division;
    const weekIndex = assignment.weekIndex;
    const fieldKey = assignment.fieldId ?? 'unassigned';

    summary.assignmentsByDivision[division] = summary.assignmentsByDivision[division] ?? {
      games: 0,
      teams: new Set(),
    };
    const divisionSummary = summary.assignmentsByDivision[division];
    divisionSummary.games += 1;
    divisionSummary.teams.add(assignment.homeTeamId);
    divisionSummary.teams.add(assignment.awayTeamId);

    summary.fieldUsage[fieldKey] = summary.fieldUsage[fieldKey] ?? {
      games: 0,
      divisions: new Set(),
    };
    const fieldSummary = summary.fieldUsage[fieldKey];
    fieldSummary.games += 1;
    fieldSummary.divisions.add(division);

    const participants = [
      { teamId: assignment.homeTeamId, role: 'home' },
      { teamId: assignment.awayTeamId, role: 'away' },
    ];
    for (const participant of participants) {
      const { teamId, role } = participant;
      if (!teamsById.has(teamId)) {
        if (!seenUnknownTeams.has(teamId)) {
          warnings.push({
            type: 'unknown-team',
            message: `Scheduled game references unknown team ${teamId}`,
            details: { teamId, weekIndex, slotId: assignment.slotId },
          });
          seenUnknownTeams.add(teamId);
        }
        continue;
      }

      const bucket = teamAssignments.get(teamId) ?? [];
      bucket.push({
        teamId,
        start,
        end,
        weekIndex,
        slotId: assignment.slotId,
        division,
      });
      teamAssignments.set(teamId, bucket);

      const teamRecord = teamsById.get(teamId);
      trackTeamGameLoad({
        teamGameLoad,
        teamId,
        role,
        start,
        fieldKey,
        weekIndex,
      });
      if (teamRecord.coachId) {
        const coachBucket = coachAssignments.get(teamRecord.coachId) ?? [];
        coachBucket.push({
          coachId: teamRecord.coachId,
          teamId,
          start,
          end,
          weekIndex,
          slotId: assignment.slotId,
          division,
        });
        coachAssignments.set(teamRecord.coachId, coachBucket);
      }
    }

    const fieldBucket = fieldAssignments.get(fieldKey) ?? [];
    fieldBucket.push({
      start,
      end,
      slotId: assignment.slotId,
      weekIndex,
      division,
      teams: [assignment.homeTeamId, assignment.awayTeamId],
    });
    fieldAssignments.set(fieldKey, fieldBucket);
  }

  for (const [division, record] of Object.entries(summary.assignmentsByDivision)) {
    record.teams = Array.from(record.teams).sort((a, b) => a.localeCompare(b));
  }
  for (const [fieldKey, record] of Object.entries(summary.fieldUsage)) {
    record.divisions = Array.from(record.divisions).sort((a, b) => a.localeCompare(b));
  }
  summary.teamGameLoad = formatTeamGameLoad(teamGameLoad);

  for (const bye of byes) {
    validateBye(bye);
    const key = bye.division;
    summary.teamsWithByes[key] = (summary.teamsWithByes[key] ?? 0) + 1;
  }

  for (const entry of unscheduled) {
    validateUnscheduled(entry);
    incrementKey(summary.unscheduledByReason, entry.reason);
    incrementKey(summary.unscheduledByDivision, entry.division);
  }

  const { sharedSlotSummaries, sharedFieldDistribution, imbalanceWarnings } =
    analyzeSharedSlotUsage(sharedSlotUsage);
  summary.sharedSlotUsage = sharedSlotSummaries;
  summary.sharedFieldDistribution = sharedFieldDistribution;
  warnings.push(...imbalanceWarnings);

  detectConflicts({
    assignmentsMap: teamAssignments,
    warnings,
    idKey: 'teamId',
    warningType: 'team-double-booked',
    messageFn: (id) => `Team ${id} has overlapping games`,
  });
  detectConflicts({
    assignmentsMap: coachAssignments,
    warnings,
    idKey: 'coachId',
    warningType: 'coach-conflict',
    messageFn: (id) => `Coach ${id} has overlapping games across teams`,
  });
  detectConflicts({
    assignmentsMap: fieldAssignments,
    warnings,
    idKey: 'fieldId',
    warningType: 'field-overlap',
    messageFn: (id) => `Field ${id} has overlapping games`,
  });

  if (unscheduled.length > 0) {
    const total = unscheduled.length;
    const breakdownEntries = Object.entries(summary.unscheduledByReason).sort(
      ([reasonA], [reasonB]) => reasonA.localeCompare(reasonB),
    );
    const breakdownLabel = breakdownEntries
      .map(([reason, count]) => `${reason}: ${count}`)
      .join(', ');
    const message = `${total} matchup(s) could not be scheduled (${breakdownLabel}).`;
    warnings.push({
      type: 'unscheduled-matchups',
      message,
      details: {
        breakdown: summary.unscheduledByReason,
        divisionBreakdown: summary.unscheduledByDivision,
      },
    });
  }

  return { summary, warnings };
}

function analyzeSharedSlotUsage(sharedSlotUsage) {
  const sharedSlotSummaries = [];
  const sharedFieldDistribution = {};
  const fieldAggregation = new Map();
  const imbalanceWarnings = [];

  for (const entry of sharedSlotUsage) {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError('sharedSlotUsage entries must be objects');
    }
    if (!entry.slotId) {
      throw new TypeError('sharedSlotUsage entries require slotId');
    }
    if (!Array.isArray(entry.divisionUsage)) {
      throw new TypeError('sharedSlotUsage entries require divisionUsage arrays');
    }

    const divisionUsage = entry.divisionUsage.map((record) => {
      if (!record || typeof record !== 'object') {
        throw new TypeError('divisionUsage entries must be objects');
      }
      if (!record.division) {
        throw new TypeError('divisionUsage entries require division');
      }
      if (typeof record.count !== 'number') {
        throw new TypeError('divisionUsage entries require numeric count');
      }
      return { division: record.division, count: record.count };
    });

    divisionUsage.sort((a, b) => a.division.localeCompare(b.division));
    const totalAssignments =
      typeof entry.totalAssignments === 'number'
        ? entry.totalAssignments
        : divisionUsage.reduce((sum, record) => sum + record.count, 0);

    sharedSlotSummaries.push({
      slotId: entry.slotId,
      fieldId: entry.fieldId ?? null,
      weekIndex: typeof entry.weekIndex === 'number' ? entry.weekIndex : null,
      start: entry.start ?? null,
      end: entry.end ?? null,
      totalAssignments,
      divisionUsage,
    });

    const fieldKey = entry.fieldId ?? 'unassigned';
    const bucket = fieldAggregation.get(fieldKey) ?? new Map();
    for (const record of divisionUsage) {
      bucket.set(record.division, (bucket.get(record.division) ?? 0) + record.count);
    }
    fieldAggregation.set(fieldKey, bucket);
  }

  sharedSlotSummaries.sort((a, b) => a.slotId.localeCompare(b.slotId));

  for (const [fieldId, bucket] of fieldAggregation.entries()) {
    sharedFieldDistribution[fieldId] = Object.fromEntries(
      Array.from(bucket.entries()).sort((a, b) => a[0].localeCompare(b[0])),
    );
  }

  for (const summary of sharedSlotSummaries) {
    const fieldKey = summary.fieldId ?? 'unassigned';
    const bucket = fieldAggregation.get(fieldKey);
    if (!bucket || bucket.size <= 1) {
      continue;
    }

    const slotUsageMap = new Map(
      summary.divisionUsage.map((record) => [record.division, record.count]),
    );
    const distribution = Array.from(bucket.keys())
      .sort((a, b) => a.localeCompare(b))
      .map((division) => ({ division, count: slotUsageMap.get(division) ?? 0 }));

    const counts = distribution.map((record) => record.count);
    const max = Math.max(...counts);
    const min = Math.min(...counts);
    if (max - min > 1) {
      imbalanceWarnings.push({
        type: 'shared-slot-imbalance',
        message: `Shared field ${fieldKey} is imbalanced across divisions`,
        details: {
          slotId: summary.slotId,
          fieldId: summary.fieldId ?? null,
          distribution,
          spread: max - min,
        },
      });
    }
  }

  return { sharedSlotSummaries, sharedFieldDistribution, imbalanceWarnings };
}

import { validateAssignment } from './utils/validation.js';

function validateBye(bye) {
  if (!bye || typeof bye !== 'object') {
    throw new TypeError('byes must contain objects');
  }
  if (typeof bye.weekIndex !== 'number' || bye.weekIndex <= 0) {
    throw new TypeError('bye.weekIndex must be a positive number');
  }
  if (!bye.division) {
    throw new TypeError('bye.division is required');
  }
  if (!bye.teamId) {
    throw new TypeError('bye.teamId is required');
  }
}

function validateUnscheduled(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new TypeError('unscheduled entries must be objects');
  }
  if (typeof entry.weekIndex !== 'number' || entry.weekIndex <= 0) {
    throw new TypeError('unscheduled entries require a positive weekIndex');
  }
  if (!entry.division) {
    throw new TypeError('unscheduled entries require a division');
  }
  if (!entry.reason) {
    throw new TypeError('unscheduled entries require a reason');
  }
}

function trackTeamGameLoad({ teamGameLoad, teamId, role, start, fieldKey, weekIndex }) {
  const record = teamGameLoad.get(teamId) ?? {
    totalGames: 0,
    homeGames: 0,
    awayGames: 0,
    uniqueFields: new Set(),
    weeks: new Set(),
    earliestStart: null,
    latestStart: null,
  };

  record.totalGames += 1;
  record[`${role}Games`] += 1;

  if (fieldKey && fieldKey !== 'unassigned') {
    record.uniqueFields.add(fieldKey);
  }
  record.weeks.add(weekIndex);
  if (!record.earliestStart || start < record.earliestStart) {
    record.earliestStart = start;
  }
  if (!record.latestStart || start > record.latestStart) {
    record.latestStart = start;
  }

  teamGameLoad.set(teamId, record);
}

function formatTeamGameLoad(teamGameLoad) {
  return Object.fromEntries(
    Array.from(teamGameLoad.entries()).map(([teamId, record]) => [
      teamId,
      {
        totalGames: record.totalGames,
        homeGames: record.homeGames,
        awayGames: record.awayGames,
        uniqueFields: Array.from(record.uniqueFields).sort((a, b) => a.localeCompare(b)),
        weeksScheduled: Array.from(record.weeks).sort((a, b) => a - b),
        earliestStart: record.earliestStart?.toISOString() ?? null,
        latestStart: record.latestStart?.toISOString() ?? null,
      },
    ]),
  );
}

function detectConflicts({ assignmentsMap, warnings, idKey, warningType, messageFn }) {
  for (const [id, assignments] of assignmentsMap.entries()) {
    if (idKey === 'fieldId' && id === 'unassigned') {
      continue;
    }

    assignments.sort((a, b) => a.start - b.start || a.slotId.localeCompare(b.slotId));

    for (let i = 1; i < assignments.length; i += 1) {
      const prev = assignments[i - 1];
      const curr = assignments[i];

      if (curr.start < prev.end) {
        warnings.push({
          type: warningType,
          message: messageFn(id),
          details: {
            [idKey]: id,
            conflicts: [simplifyAssignment(prev), simplifyAssignment(curr)],
          },
        });
        break;
      }
    }
  }
}

function simplifyAssignment(assignment) {
  const base = {
    slotId: assignment.slotId,
    start: assignment.start.toISOString(),
    end: assignment.end.toISOString(),
    weekIndex: assignment.weekIndex,
    division: assignment.division,
    teamId: assignment.teamId ?? null,
  };

  if (Array.isArray(assignment.teams)) {
    base.teams = [...assignment.teams];
  }

  return base;
}


