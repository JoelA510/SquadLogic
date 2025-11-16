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
 *   baseSlotDistribution: Array<{
 *     baseSlotId: string,
 *     day: string | null,
 *     representativeStart: string | null,
 *     totalAssigned: number,
 *     totalCapacity: number,
 *     utilization: number | null,
 *     divisionBreakdown: Array<{ division: string, count: number, percentage: number }>,
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
const FAIRNESS_DOMINANCE_THRESHOLD = 0.7;
const UNDERUTILIZATION_THRESHOLD = 0.25;
const DAY_CONCENTRATION_THRESHOLD = 0.65;
const MIN_ASSIGNMENTS_FOR_CONCENTRATION = 3;

export const MANUAL_FOLLOW_UP_CATEGORIES = {
  CAPACITY: 'capacity',
  COACH_AVAILABILITY: 'coach-availability',
  EXCLUDED_SLOTS: 'excluded-slots',
  UNKNOWN: 'constraints-or-unknown',
};

const normalizeManualFollowUpReasonInput = (raw) => {
  if (typeof raw !== 'string') {
    return 'unspecified';
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : 'unspecified';
};

function categorizeManualFollowUpReason(rawReason) {
  const value = normalizeManualFollowUpReasonInput(rawReason).toLowerCase();

  if (value.includes('capacity')) {
    return MANUAL_FOLLOW_UP_CATEGORIES.CAPACITY;
  }

  if (value.includes('coach')) {
    return MANUAL_FOLLOW_UP_CATEGORIES.COACH_AVAILABILITY;
  }

  if (value.includes('exclude') || value.includes('alternative slot')) {
    return MANUAL_FOLLOW_UP_CATEGORIES.EXCLUDED_SLOTS;
  }

  return MANUAL_FOLLOW_UP_CATEGORIES.UNKNOWN;
}

function calculateFairnessConcerns(baseSlotDistribution, assignmentsByDivision) {
  const assignedDivisions = new Set(assignmentsByDivision.keys());
  const fairnessConcerns = [];

  for (const entry of baseSlotDistribution) {
    if (entry.totalAssigned < 2 || entry.divisionBreakdown.length === 0) {
      continue;
    }

    const dominant = entry.divisionBreakdown[0];
    const dominantShare = Number((dominant.count / entry.totalAssigned).toFixed(4));
    const hasDiverseLeague = assignedDivisions.size > 1;
    const hasMultipleDivisionsInSlot = entry.divisionBreakdown.length > 1;

    if (dominantShare < FAIRNESS_DOMINANCE_THRESHOLD) {
      continue;
    }

    if (!hasDiverseLeague && !hasMultipleDivisionsInSlot) {
      continue;
    }

    const percentLabel = (dominantShare * 100).toFixed(1).replace(/\.0$/, '');
    fairnessConcerns.push({
      baseSlotId: entry.baseSlotId,
      day: entry.day,
      representativeStart: entry.representativeStart,
      dominantDivision: dominant.division,
      dominantShare,
      totalAssigned: entry.totalAssigned,
      totalCapacity: entry.totalCapacity,
      message: `Base slot ${entry.baseSlotId} is ${percentLabel}% filled by division ${dominant.division} (${dominant.count}/${entry.totalAssigned} assignments)`,
    });
  }

  fairnessConcerns.sort(
    (a, b) =>
      a.baseSlotId.localeCompare(b.baseSlotId) ||
      a.message.localeCompare(b.message),
  );

  return fairnessConcerns;
}

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
  const baseSlotMetadata = new Map();
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

    const baseSlotId = slot.baseSlotId ?? slot.id;

    slotsById.set(slot.id, {
      id: slot.id,
      baseSlotId,
      capacity: slot.capacity,
      start: startDate,
      end: endDate,
      day: slot.day ?? null,
    });

    const existingMeta = baseSlotMetadata.get(baseSlotId) ?? {
      baseSlotId,
      totalCapacity: 0,
      representativeStart: null,
      day: null,
    };
    existingMeta.totalCapacity += slot.capacity;
    const becomesRepresentative =
      !existingMeta.representativeStart ||
      startDate < existingMeta.representativeStart;
    if (becomesRepresentative) {
      existingMeta.representativeStart = startDate;
      existingMeta.day = slot.day ?? null;
    }
    baseSlotMetadata.set(baseSlotId, existingMeta);
  }

  const dataQualityWarnings = [];
  const seenAssignments = new Set();
  const assignedTeamIds = new Set();
  const assignmentsBySlot = new Map();
  const assignmentsByDivision = new Map();
  const assignmentsByCoach = new Map();
  const baseSlotDivisionCounts = new Map();
  const unassignedByReasonMap = new Map();
  const unassignedUnknownTeams = new Set();

  for (const entry of unassigned) {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError('each unassigned entry must be an object');
    }
    if (!entry.teamId) {
      throw new TypeError('each unassigned entry requires a teamId');
    }

    const reason = normalizeManualFollowUpReasonInput(entry.reason);

    const bucket =
      unassignedByReasonMap.get(reason) ?? {
        reason,
        count: 0,
        teamIds: [],
        divisionCounts: new Map(),
      };

    bucket.count += 1;
    bucket.teamIds.push(entry.teamId);

    const teamRecord = teamsById.get(entry.teamId);
    if (!teamRecord) {
      unassignedUnknownTeams.add(entry.teamId);
    } else if (teamRecord.division) {
      bucket.divisionCounts.set(
        teamRecord.division,
        (bucket.divisionCounts.get(teamRecord.division) ?? 0) + 1,
      );
    }

    unassignedByReasonMap.set(reason, bucket);
  }

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

    const baseSlotId = slot.baseSlotId;
    const baseEntry = baseSlotDivisionCounts.get(baseSlotId) ?? {
      totalAssigned: 0,
      divisionCounts: new Map(),
    };
    baseEntry.totalAssigned += 1;
    baseEntry.divisionCounts.set(
      team.division,
      (baseEntry.divisionCounts.get(team.division) ?? 0) + 1,
    );
    baseSlotDivisionCounts.set(baseSlotId, baseEntry);
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
  const dayConcentrationAlerts = [];
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

    const [primaryDay] = breakdown;
    if (
      counted >= MIN_ASSIGNMENTS_FOR_CONCENTRATION &&
      primaryDay &&
      primaryDay.percentage >= DAY_CONCENTRATION_THRESHOLD
    ) {
      dayConcentrationAlerts.push({
        division,
        dominantDay: primaryDay.day,
        dominantShare: primaryDay.percentage,
        dominantCount: primaryDay.count,
        totalAssignments: counted,
      });
    }
  }

  dayConcentrationAlerts.sort(
    (a, b) => a.division.localeCompare(b.division) || a.dominantDay.localeCompare(b.dominantDay),
  );

  const baseSlotDistribution = [];
  const underutilizedBaseSlots = [];
  for (const [baseSlotId, meta] of baseSlotMetadata.entries()) {
    const countsRecord = baseSlotDivisionCounts.get(baseSlotId);
    const totalAssigned = countsRecord?.totalAssigned ?? 0;
    const divisionCounts = countsRecord?.divisionCounts ?? new Map();
    const divisionBreakdown = Array.from(divisionCounts.entries())
      .map(([division, count]) => ({
        division,
        count,
        percentage: totalAssigned === 0 ? 0 : Number((count / totalAssigned).toFixed(4)),
      }))
      .sort((a, b) => {
        if (b.count !== a.count) {
          return b.count - a.count;
        }
        return a.division.localeCompare(b.division);
      });

    const totalCapacity = meta.totalCapacity;
    const utilization = totalCapacity === 0 ? null : Number((totalAssigned / totalCapacity).toFixed(4));

    baseSlotDistribution.push({
      baseSlotId,
      day: meta.day ?? null,
      representativeStart: meta.representativeStart ? meta.representativeStart.toISOString() : null,
      totalAssigned,
      totalCapacity,
      utilization,
      divisionBreakdown,
    });

    if (
      totalCapacity > 0 &&
      utilization !== null &&
      utilization < UNDERUTILIZATION_THRESHOLD
    ) {
      underutilizedBaseSlots.push({
        baseSlotId,
        day: meta.day ?? null,
        representativeStart: meta.representativeStart ? meta.representativeStart.toISOString() : null,
        totalAssigned,
        totalCapacity,
        utilization,
      });
    }
  }

  baseSlotDistribution.sort((a, b) => a.baseSlotId.localeCompare(b.baseSlotId));
  underutilizedBaseSlots.sort((a, b) => a.baseSlotId.localeCompare(b.baseSlotId));

  const fairnessConcerns = calculateFairnessConcerns(baseSlotDistribution, assignmentsByDivision);

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
  const assignmentRate =
    totalTeams === 0 ? 1 : Number(((assignedTeams / totalTeams) || 0).toFixed(4));
  const manualFollowUpRate =
    totalTeams === 0 ? 0 : Number(((unassignedTeams / totalTeams) || 0).toFixed(4));

  if (unassignedUnknownTeams.size > 0) {
    const list = Array.from(unassignedUnknownTeams).sort((a, b) => a.localeCompare(b));
    dataQualityWarnings.push(
      `Unassigned list references unknown team(s): ${list.join(', ')}`,
    );
  }

  const unassignedByReason = Array.from(unassignedByReasonMap.values())
    .map((bucket) => ({
      reason: bucket.reason,
      count: bucket.count,
      teamIds: bucket.teamIds.sort((a, b) => a.localeCompare(b)),
      divisionBreakdown: Array.from(bucket.divisionCounts.entries())
        .map(([division, count]) => ({
          division,
          count,
          percentage: Number((count / bucket.count).toFixed(4)),
        }))
        .sort(
          (a, b) =>
            b.count - a.count || a.division.localeCompare(b.division),
        ),
    }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  const manualFollowUpBreakdownMap = new Map();
  const totalManualFollowUps = unassigned.length;

  for (const entry of unassigned) {
    const normalizedReason = normalizeManualFollowUpReasonInput(entry.reason);
    const category = categorizeManualFollowUpReason(normalizedReason);
    const bucket = manualFollowUpBreakdownMap.get(category) ?? {
      category,
      count: 0,
      teamIds: [],
      reasons: new Set(),
    };

    bucket.count += 1;
    bucket.teamIds.push(entry.teamId);
    if (normalizedReason !== 'unspecified') {
      bucket.reasons.add(normalizedReason);
    }

    manualFollowUpBreakdownMap.set(category, bucket);
  }

  const manualFollowUpBreakdown = Array.from(manualFollowUpBreakdownMap.values())
    .map((bucket) => ({
      category: bucket.category,
      count: bucket.count,
      percentage:
        totalManualFollowUps === 0
          ? 0
          : Number((bucket.count / totalManualFollowUps).toFixed(4)),
      teamIds: bucket.teamIds.sort((a, b) => a.localeCompare(b)),
      reasons: Array.from(bucket.reasons).sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));

  return {
    summary: {
      totalTeams,
      assignedTeams,
      unassignedTeams,
      assignmentRate,
      manualFollowUpRate,
    },
    slotUtilization: slotUtilization.sort((a, b) => a.slotId.localeCompare(b.slotId)),
    baseSlotDistribution,
    divisionDayDistribution,
    dayConcentrationAlerts,
    coachLoad,
    coachConflicts,
    dataQualityWarnings,
    fairnessConcerns,
    underutilizedBaseSlots,
    unassignedByReason,
    manualFollowUpBreakdown,
  };
}
