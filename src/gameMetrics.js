import { isDeepStrictEqual } from 'node:util';

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
export function evaluateGameSchedule({ assignments, teams, byes = [], unscheduled = [] }) {
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
    teamGameLoad: {},
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
    summary.unscheduledByReason[entry.reason] =
      (summary.unscheduledByReason[entry.reason] ?? 0) + 1;
  }

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
    warnings.push({
      type: 'unscheduled-matchups',
      message: 'Some matchups could not be scheduled.',
      details: { breakdown: summary.unscheduledByReason },
    });
  }

  return { summary, warnings };
}

function validateAssignment(assignment) {
  if (!assignment || typeof assignment !== 'object') {
    throw new TypeError('assignments must contain objects');
  }
  if (typeof assignment.weekIndex !== 'number' || assignment.weekIndex <= 0) {
    throw new TypeError('assignment.weekIndex must be a positive number');
  }
  if (!assignment.division) {
    throw new TypeError('assignment.division is required');
  }
  if (!assignment.slotId) {
    throw new TypeError('assignment.slotId is required');
  }
  if (!assignment.homeTeamId || !assignment.awayTeamId) {
    throw new TypeError('assignments require homeTeamId and awayTeamId');
  }
  if (!assignment.start || !assignment.end) {
    throw new TypeError('assignments require start and end timestamps');
  }
  const start = new Date(assignment.start);
  const end = new Date(assignment.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new TypeError('assignments must have valid ISO timestamps');
  }
  if (end <= start) {
    throw new TypeError('assignment end time must be after the start time');
  }
}

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
  if (role === 'home') {
    record.homeGames += 1;
  } else {
    record.awayGames += 1;
  }

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
  const result = {};
  for (const [teamId, record] of teamGameLoad.entries()) {
    result[teamId] = {
      totalGames: record.totalGames,
      homeGames: record.homeGames,
      awayGames: record.awayGames,
      uniqueFields: Array.from(record.uniqueFields).sort((a, b) => a.localeCompare(b)),
      weeksScheduled: Array.from(record.weeks).sort((a, b) => a - b),
      earliestStart: record.earliestStart ? record.earliestStart.toISOString() : null,
      latestStart: record.latestStart ? record.latestStart.toISOString() : null,
    };
  }
  return result;
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

// Avoid unused import warnings when linting via node --check
void isDeepStrictEqual;
