/**
 * Evaluate the quality of practice schedule assignments and emit metrics
 * used by the admin dashboard and regression tests.
 *
 * @param {Object} params
 * @param {Array<{ teamId: string, slotId: string }>} params.assignments -
 *   Array of practice assignments linking teams to slots.
 * @param {Array<{ teamId: string, reason: string }>} [params.unassigned=[]] -
 *   Teams that could not be scheduled automatically.
 * @param {Array<{ id: string, division: string, coachId?: string | null }>} params.teams -
 *   Teams participating in the scheduling run. Each team must provide an `id` and `division`.
 * @param {Array<{ id: string, capacity: number, start: string | Date, end: string | Date, day?: string | null }>} params.slots -
 *   Slot catalogue with capacity and timing metadata.
 * @returns {
 *   summary: {
 *     totalTeams: number,
 *     assignedTeams: number,
 *     unassignedTeams: number,
 *     assignmentRate: number,
 *   },
 *   slotUtilization: Array<{
 *     slotId: string,
 *     assignedCount: number,
 *     capacity: number,
 *     utilization: number | null,
 *     overbooked: boolean,
 *   }>,
 *   divisionDayDistribution: Record<string, {
 *     totalAssigned: number,
 *     averageStartMinutes: number | null,
 *     dayBreakdown: Array<{ day: string, count: number, percentage: number }>,
 *   }>,
 *   coachLoad: Record<string, {
 *     assignedTeams: number,
 *     distinctDays: number,
 *   }>,
 *   coachConflicts: Array<{
 *     coachId: string,
 *     teams: Array<{ teamId: string, slotId: string }>,
 *     reason: string,
 *   }>,
 *   dataQualityWarnings: Array<string>,
 * }
 */
export function evaluatePracticeSchedule({ assignments, unassigned = [], teams, slots }) {
  if (!Array.isArray(assignments)) {
    throw new TypeError('assignments must be an array');
  }
  if (!Array.isArray(unassigned)) {
    throw new TypeError('unassigned must be an array');
  }
  if (!Array.isArray(teams)) {
    throw new TypeError('teams must be an array');
  }
  if (!Array.isArray(slots)) {
    throw new TypeError('slots must be an array');
  }

  const teamsById = new Map();
  for (const team of teams) {
    if (!team || typeof team !== 'object') {
      throw new TypeError('each team must be an object');
    }
    if (!team.id) {
      throw new TypeError('each team requires an id');
    }
    if (!team.division) {
      throw new TypeError(`team ${team.id} is missing a division`);
    }

    teamsById.set(team.id, {
      id: team.id,
      division: team.division,
      coachId: team.coachId ?? null,
    });
  }

  const slotsById = new Map();
  for (const slot of slots) {
    if (!slot || typeof slot !== 'object') {
      throw new TypeError('each slot must be an object');
    }
    if (!slot.id) {
      throw new TypeError('each slot requires an id');
    }
    if (typeof slot.capacity !== 'number' || slot.capacity < 0) {
      throw new TypeError(`slot ${slot.id} must define a non-negative capacity`);
    }
    if (!slot.start || !slot.end) {
      throw new TypeError(`slot ${slot.id} must define start and end timestamps`);
    }

    const startDate = new Date(slot.start);
    const endDate = new Date(slot.end);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      throw new Error(`slot ${slot.id} includes an invalid timestamp`);
    }
    if (endDate <= startDate) {
      throw new Error(`slot ${slot.id} must end after it starts`);
    }

    slotsById.set(slot.id, {
      id: slot.id,
      capacity: slot.capacity,
      start: startDate,
      end: endDate,
      day: slot.day ?? null,
    });
  }

  const dataQualityWarnings = [];
  const seenAssignments = new Set();
  const assignedTeamIds = new Set();
  const assignmentsBySlot = new Map();
  const assignmentsByDivision = new Map();
  const assignmentsByCoach = new Map();

  for (const assignment of assignments) {
    if (!assignment || typeof assignment !== 'object') {
      throw new TypeError('each assignment must be an object');
    }
    if (!assignment.teamId || !assignment.slotId) {
      throw new TypeError('each assignment requires teamId and slotId');
    }

    const team = teamsById.get(assignment.teamId);
    if (!team) {
      dataQualityWarnings.push(`assignment references unknown team ${assignment.teamId}`);
      continue;
    }
    const slot = slotsById.get(assignment.slotId);
    if (!slot) {
      dataQualityWarnings.push(`assignment references unknown slot ${assignment.slotId}`);
      continue;
    }

    const key = `${assignment.teamId}::${assignment.slotId}`;
    if (seenAssignments.has(key)) {
      dataQualityWarnings.push(`duplicate assignment for team ${assignment.teamId} to slot ${assignment.slotId}`);
      continue;
    }
    seenAssignments.add(key);
    assignedTeamIds.add(team.id);

    const slotAssignments = assignmentsBySlot.get(slot.id) ?? [];
    slotAssignments.push({ teamId: assignment.teamId, team });
    assignmentsBySlot.set(slot.id, slotAssignments);

    const divisionAssignments = assignmentsByDivision.get(team.division) ?? [];
    divisionAssignments.push({ team, slot });
    assignmentsByDivision.set(team.division, divisionAssignments);

    if (team.coachId) {
      const coachAssignments = assignmentsByCoach.get(team.coachId) ?? [];
      coachAssignments.push({ teamId: team.id, slot });
      assignmentsByCoach.set(team.coachId, coachAssignments);
    }
  }

  const slotUtilization = [];
  for (const slot of slotsById.values()) {
    const assignedCount = assignmentsBySlot.get(slot.id)?.length ?? 0;
    const capacity = slot.capacity;
    const utilization = capacity === 0 ? null : assignedCount / capacity;
    const overbooked = capacity !== 0 && assignedCount > capacity;
    if (capacity === 0 && assignedCount > 0) {
      dataQualityWarnings.push(`slot ${slot.id} has zero capacity but ${assignedCount} assignment(s)`);
    }
    if (overbooked) {
      dataQualityWarnings.push(`slot ${slot.id} exceeds capacity (${assignedCount}/${capacity})`);
    }
    slotUtilization.push({
      slotId: slot.id,
      assignedCount,
      capacity,
      utilization,
      overbooked,
    });
  }

  const divisionDayDistribution = {};
  for (const [division, divisionAssignments] of assignmentsByDivision.entries()) {
    const dayCounts = new Map();
    let totalMinutes = 0;
    let counted = 0;

    for (const { slot } of divisionAssignments) {
      const day = slot.day ?? 'unknown';
      dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
      totalMinutes += slot.start.getHours() * 60 + slot.start.getMinutes();
      counted += 1;
    }

    const breakdown = Array.from(dayCounts.entries())
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => {
        if (a.count !== b.count) {
          return b.count - a.count;
        }
        return a.day.localeCompare(b.day);
      })
      .map(({ day, count }) => ({
        day,
        count,
        percentage: counted === 0 ? 0 : Number((count / counted).toFixed(4)),
      }));

    divisionDayDistribution[division] = {
      totalAssigned: counted,
      averageStartMinutes: counted === 0 ? null : Number((totalMinutes / counted).toFixed(2)),
      dayBreakdown: breakdown,
    };
  }

  const coachLoad = {};
  const coachConflicts = [];
  for (const [coachId, coachAssignments] of assignmentsByCoach.entries()) {
    const sortedAssignments = coachAssignments
      .map(({ teamId, slot }) => ({
        teamId,
        slotId: slot.id,
        start: slot.start,
        end: slot.end,
        day: slot.day ?? 'unknown',
      }))
      .sort((a, b) => a.start - b.start || a.slotId.localeCompare(b.slotId));

    const distinctDays = new Set(sortedAssignments.map((assignment) => assignment.day));
    coachLoad[coachId] = {
      assignedTeams: sortedAssignments.length,
      distinctDays: distinctDays.size,
    };

    const conflicts = [];
    for (let i = 0; i < sortedAssignments.length - 1; i += 1) {
      const current = sortedAssignments[i];
      for (let j = i + 1; j < sortedAssignments.length; j += 1) {
        const candidate = sortedAssignments[j];
        if (candidate.start >= current.end) {
          break;
        }
        conflicts.push({
          coachId,
          teams: [
            { teamId: current.teamId, slotId: current.slotId },
            { teamId: candidate.teamId, slotId: candidate.slotId },
          ],
          reason: 'overlapping slots',
        });
      }
    }
    if (conflicts.length > 0) {
      coachConflicts.push(...conflicts);
    }
  }

  const totalTeams = teams.length;
  const assignedTeams = assignedTeamIds.size;
  const unassignedTeams = totalTeams - assignedTeams;
  const assignmentRate = totalTeams === 0 ? 1 : Number(((assignedTeams / totalTeams) || 0).toFixed(4));

  return {
    summary: {
      totalTeams,
      assignedTeams,
      unassignedTeams,
      assignmentRate,
    },
    slotUtilization: slotUtilization.sort((a, b) => a.slotId.localeCompare(b.slotId)),
    divisionDayDistribution,
    coachLoad,
    coachConflicts,
    dataQualityWarnings,
  };
}
