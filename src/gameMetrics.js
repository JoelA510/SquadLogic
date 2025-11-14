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
  };

  const warnings = [];
  const seenUnknownTeams = new Set();
  const teamAssignments = new Map();
  const coachAssignments = new Map();
  const fieldAssignments = new Map();

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

    const participants = [assignment.homeTeamId, assignment.awayTeamId];
    for (const teamId of participants) {
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

  detectTeamConflicts({ teamAssignments, warnings });
  detectCoachConflicts({ coachAssignments, warnings });
  detectFieldConflicts({ fieldAssignments, warnings });

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

function detectTeamConflicts({ teamAssignments, warnings }) {
  for (const [teamId, assignments] of teamAssignments.entries()) {
    assignments.sort((a, b) => a.start - b.start || a.slotId.localeCompare(b.slotId));
    for (let i = 1; i < assignments.length; i += 1) {
      const prev = assignments[i - 1];
      const curr = assignments[i];
      if (curr.start < prev.end) {
        warnings.push({
          type: 'team-double-booked',
          message: `Team ${teamId} has overlapping games`,
          details: {
            teamId,
            conflicts: [
              simplifyAssignment(prev),
              simplifyAssignment(curr),
            ],
          },
        });
        break;
      }
    }
  }
}

function detectCoachConflicts({ coachAssignments, warnings }) {
  for (const [coachId, assignments] of coachAssignments.entries()) {
    assignments.sort((a, b) => a.start - b.start || a.slotId.localeCompare(b.slotId));
    for (let i = 1; i < assignments.length; i += 1) {
      const prev = assignments[i - 1];
      const curr = assignments[i];
      if (curr.start < prev.end) {
        warnings.push({
          type: 'coach-conflict',
          message: `Coach ${coachId} has overlapping games across teams`,
          details: {
            coachId,
            conflicts: [
              simplifyAssignment(prev),
              simplifyAssignment(curr),
            ],
          },
        });
        break;
      }
    }
  }
}

function detectFieldConflicts({ fieldAssignments, warnings }) {
  for (const [fieldKey, assignments] of fieldAssignments.entries()) {
    if (fieldKey === 'unassigned') {
      continue;
    }
    assignments.sort((a, b) => a.start - b.start || a.slotId.localeCompare(b.slotId));
    for (let i = 1; i < assignments.length; i += 1) {
      const prev = assignments[i - 1];
      const curr = assignments[i];
      if (curr.start < prev.end) {
        warnings.push({
          type: 'field-overlap',
          message: `Field ${fieldKey} has overlapping games`,
          details: {
            fieldId: fieldKey,
            conflicts: [
              simplifyAssignment(prev),
              simplifyAssignment(curr),
            ],
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
