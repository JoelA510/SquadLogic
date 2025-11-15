const BYE = Symbol('BYE');

/**
 * Generate a deterministic round-robin schedule for a division.
 *
 * @param {Object} params
 * @param {Array<string>} params.teamIds - Unique team identifiers.
 * @returns {Array<{ weekIndex: number, matchups: Array<{ homeTeamId: string, awayTeamId: string }>, byes: Array<string> }>}
 */
export function generateRoundRobinWeeks({ teamIds }) {
  if (!Array.isArray(teamIds)) {
    throw new TypeError('teamIds must be an array');
  }

  const uniqueTeams = Array.from(new Set(teamIds));
  if (uniqueTeams.length !== teamIds.length) {
    throw new Error('teamIds must not contain duplicates');
  }

  if (uniqueTeams.length < 2) {
    throw new Error('at least two teams are required for a round-robin schedule');
  }

  const sortedTeams = [...uniqueTeams].sort((a, b) => a.localeCompare(b));
  const rotation = [...sortedTeams];

  if (rotation.length % 2 === 1) {
    rotation.push(BYE);
  }

  const totalTeams = rotation.length;
  const weeks = totalTeams - 1;
  const half = totalTeams / 2;
  const schedule = [];

  for (let week = 0; week < weeks; week += 1) {
    const matchups = [];
    const byes = [];

    for (let i = 0; i < half; i += 1) {
      const home = rotation[i];
      const away = rotation[totalTeams - 1 - i];

      if (home === BYE || away === BYE) {
        const byeTeam = home === BYE ? away : home;
        if (byeTeam !== BYE) {
          byes.push(byeTeam);
        }
        continue;
      }

      const ordered = [home, away].sort((a, b) => a.localeCompare(b));
      matchups.push({ homeTeamId: ordered[0], awayTeamId: ordered[1] });
    }

    matchups.sort((a, b) => {
      if (a.homeTeamId !== b.homeTeamId) {
        return a.homeTeamId.localeCompare(b.homeTeamId);
      }
      return a.awayTeamId.localeCompare(b.awayTeamId);
    });

    byes.sort((a, b) => a.localeCompare(b));

    schedule.push({
      weekIndex: week + 1,
      matchups,
      byes,
    });

    const first = rotation[0];
    const rest = rotation.slice(1);
    rest.unshift(rest.pop());
    rotation.splice(0, rotation.length, first, ...rest);
  }

  return schedule;
}

/**
 * Allocate round-robin matchups into concrete game slots while respecting capacity and coach conflicts.
 *
 * @param {Object} params
 * @param {Array<{ id: string, division: string, coachId?: string | null }>} params.teams - Teams participating in scheduling.
 * @param {Array<{ id: string, division?: string | null, weekIndex: number, start: string | Date, end: string | Date, capacity: number, fieldId?: string | null }>} params.slots
 *   - Slot definitions with optional division restriction.
 * @param {Record<string, Array<{ weekIndex: number, matchups: Array<{ homeTeamId: string, awayTeamId: string }>, byes: Array<string> }>>} params.roundRobinByDivision
 *   - Precomputed round-robin output keyed by division.
 * @returns {{
 *   assignments: Array<{ weekIndex: number, division: string, slotId: string, start: string, end: string, homeTeamId: string, awayTeamId: string, fieldId: string | null }>,
 *   byes: Array<{ weekIndex: number, division: string, teamId: string }>,
 *   unscheduled: Array<{ weekIndex: number, division: string, matchup: { homeTeamId: string, awayTeamId: string }, reason: string }>,
 * }}
 */
export function scheduleGames({ teams, slots, roundRobinByDivision }) {
  if (!roundRobinByDivision || typeof roundRobinByDivision !== 'object') {
    throw new TypeError('roundRobinByDivision must be an object');
  }

  const teamsById = indexTeams(teams);
  const { divisionSlots, sharedSlots } = indexSlots(slots);
  const sharedSlotUsage = new Map();
  const sharedFieldUsage = new Map();
  const teamStartPreferences = new Map();

  const assignments = [];
  const byes = [];
  const unscheduled = [];
  const coachAssignments = new Map();
  const teamWeekAssignments = new Set();

  for (const [division, weeks] of Object.entries(roundRobinByDivision)) {
    if (!Array.isArray(weeks)) {
      throw new TypeError(`roundRobinByDivision for division ${division} must be an array`);
    }

    for (const week of weeks) {
      validateWeek({ week, division });
      collectWeekByes({ week, division, teamsById, byes });

      for (const matchup of week.matchups ?? []) {
        scheduleMatchup({
          division,
          weekIndex: week.weekIndex,
          matchup,
          teamsById,
          divisionSlots,
          sharedSlots,
          sharedSlotUsage,
          sharedFieldUsage,
          coachAssignments,
          teamWeekAssignments,
          teamStartPreferences,
          assignments,
          unscheduled,
        });
      }
    }
  }

  assignments.sort((a, b) => {
    if (a.weekIndex !== b.weekIndex) {
      return a.weekIndex - b.weekIndex;
    }
    if (a.division !== b.division) {
      return a.division.localeCompare(b.division);
    }
    if (a.start !== b.start) {
      return a.start.localeCompare(b.start);
    }
    if (a.slotId !== b.slotId) {
      return a.slotId.localeCompare(b.slotId);
    }
    return a.homeTeamId.localeCompare(b.homeTeamId);
  });

  byes.sort((a, b) => {
    if (a.weekIndex !== b.weekIndex) {
      return a.weekIndex - b.weekIndex;
    }
    if (a.division !== b.division) {
      return a.division.localeCompare(b.division);
    }
    return a.teamId.localeCompare(b.teamId);
  });

  unscheduled.sort((a, b) => {
    if (a.weekIndex !== b.weekIndex) {
      return a.weekIndex - b.weekIndex;
    }
    if (a.division !== b.division) {
      return a.division.localeCompare(b.division);
    }
    const matchupA = `${a.matchup.homeTeamId}-${a.matchup.awayTeamId}`;
    const matchupB = `${b.matchup.homeTeamId}-${b.matchup.awayTeamId}`;
    if (matchupA !== matchupB) {
      return matchupA.localeCompare(matchupB);
    }
    return a.reason.localeCompare(b.reason);
  });

  const sharedSlotUsageSummary = formatSharedSlotUsage(sharedSlotUsage);

  return { assignments, byes, unscheduled, sharedSlotUsage: sharedSlotUsageSummary };
}

function indexTeams(teams) {
  if (!Array.isArray(teams)) {
    throw new TypeError('teams must be an array');
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

  return teamsById;
}

function indexSlots(slots) {
  if (!Array.isArray(slots)) {
    throw new TypeError('slots must be an array');
  }

  const divisionSlots = new Map();
  const sharedSlots = new Map();
  const slotRecords = new Map();

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
    if (typeof slot.weekIndex !== 'number' || !Number.isInteger(slot.weekIndex) || slot.weekIndex <= 0) {
      throw new TypeError(`slot ${slot.id} must include a positive integer weekIndex`);
    }
    if (!slot.start || !slot.end) {
      throw new TypeError(`slot ${slot.id} must define start and end timestamps`);
    }

    const start = new Date(slot.start);
    const end = new Date(slot.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new Error(`slot ${slot.id} includes an invalid timestamp`);
    }
    if (end <= start) {
      throw new Error(`slot ${slot.id} must end after it starts`);
    }
    if (slotRecords.has(slot.id)) {
      throw new Error(`duplicate slot id detected: ${slot.id}`);
    }

    const record = {
      id: slot.id,
      division: slot.division ?? null,
      weekIndex: slot.weekIndex,
      start,
      end,
      remainingCapacity: slot.capacity,
      fieldId: slot.fieldId ?? null,
    };

    slotRecords.set(record.id, record);

    const key = `${record.division ?? '*'}::${record.weekIndex}`;
    const targetMap = record.division ? divisionSlots : sharedSlots;
    const bucket = targetMap.get(key) ?? [];
    bucket.push(record);
    targetMap.set(key, bucket);
  }

  for (const slotList of [...divisionSlots.values(), ...sharedSlots.values()]) {
    slotList.sort((a, b) => {
      if (a.start.getTime() !== b.start.getTime()) {
        return a.start - b.start;
      }
      if ((a.fieldId ?? '') !== (b.fieldId ?? '')) {
        return (a.fieldId ?? '').localeCompare(b.fieldId ?? '');
      }
      return a.id.localeCompare(b.id);
    });
  }

  return { divisionSlots, sharedSlots };
}

function validateWeek({ week, division }) {
  if (!week || typeof week !== 'object') {
    throw new TypeError(`week entries for division ${division} must be objects`);
  }
  if (typeof week.weekIndex !== 'number') {
    throw new TypeError(`week entries for division ${division} must include weekIndex`);
  }
}

function collectWeekByes({ week, division, teamsById, byes }) {
  for (const byeTeamId of week.byes ?? []) {
    if (!teamsById.has(byeTeamId)) {
      continue;
    }
    byes.push({ weekIndex: week.weekIndex, division, teamId: byeTeamId });
  }
}

function scheduleMatchup({
  division,
  weekIndex,
  matchup,
  teamsById,
  divisionSlots,
  sharedSlots,
  sharedSlotUsage,
  sharedFieldUsage,
  coachAssignments,
  teamWeekAssignments,
  teamStartPreferences,
  assignments,
  unscheduled,
}) {
  if (!matchup || typeof matchup !== 'object') {
    throw new TypeError(`matchups for division ${division} must be objects`);
  }

  const { homeTeamId, awayTeamId } = matchup;
  if (!homeTeamId || !awayTeamId) {
    throw new TypeError('each matchup requires homeTeamId and awayTeamId');
  }

  const homeTeam = teamsById.get(homeTeamId);
  const awayTeam = teamsById.get(awayTeamId);

  if (!homeTeam || !awayTeam) {
    unscheduled.push({
      weekIndex,
      division,
      matchup: { homeTeamId, awayTeamId },
      reason: 'unknown-team',
    });
    return;
  }

  if (homeTeam.division !== division || awayTeam.division !== division) {
    unscheduled.push({
      weekIndex,
      division,
      matchup: { homeTeamId, awayTeamId },
      reason: 'division-mismatch',
    });
    return;
  }

  const teamWeekKeyHome = `${homeTeamId}::${weekIndex}`;
  const teamWeekKeyAway = `${awayTeamId}::${weekIndex}`;
  if (teamWeekAssignments.has(teamWeekKeyHome) || teamWeekAssignments.has(teamWeekKeyAway)) {
    unscheduled.push({
      weekIndex,
      division,
      matchup: { homeTeamId, awayTeamId },
      reason: 'duplicate-matchup',
    });
    return;
  }

  if (homeTeam.coachId && homeTeam.coachId === awayTeam.coachId) {
    unscheduled.push({
      weekIndex,
      division,
      matchup: { homeTeamId, awayTeamId },
      reason: 'coach-coaches-both-teams',
    });
    return;
  }

  const { slot: selectedSlot, encounteredConflict } = selectSlotForMatchup({
    division,
    weekIndex,
    divisionSlots,
    sharedSlots,
    sharedSlotUsage,
    sharedFieldUsage,
    coachAssignments,
    teamIds: [homeTeamId, awayTeamId],
    teamStartPreferences,
    coaches: [homeTeam.coachId, awayTeam.coachId],
  });

  if (!selectedSlot) {
    unscheduled.push({
      weekIndex,
      division,
      matchup: { homeTeamId, awayTeamId },
      reason: encounteredConflict ? 'coach-scheduling-conflict' : 'no-slot-available',
    });
    return;
  }

  selectedSlot.remainingCapacity -= 1;
  teamWeekAssignments.add(teamWeekKeyHome);
  teamWeekAssignments.add(teamWeekKeyAway);
  recordCoachAssignment({
    coachAssignments,
    coachId: homeTeam.coachId,
    assignment: {
      slotId: selectedSlot.id,
      start: selectedSlot.start,
      end: selectedSlot.end,
      weekIndex,
      teamId: homeTeamId,
    },
  });
  recordCoachAssignment({
    coachAssignments,
    coachId: awayTeam.coachId,
    assignment: {
      slotId: selectedSlot.id,
      start: selectedSlot.start,
      end: selectedSlot.end,
      weekIndex,
      teamId: awayTeamId,
    },
  });

  if (!selectedSlot.division) {
    recordSharedSlotUsage({
      sharedSlotUsage,
      sharedFieldUsage,
      slot: selectedSlot,
      division,
    });
  }

  updateTeamStartPreference({
    teamStartPreferences,
    teamId: homeTeamId,
    start: selectedSlot.start,
  });
  updateTeamStartPreference({
    teamStartPreferences,
    teamId: awayTeamId,
    start: selectedSlot.start,
  });

  assignments.push({
    weekIndex,
    division,
    slotId: selectedSlot.id,
    start: selectedSlot.start.toISOString(),
    end: selectedSlot.end.toISOString(),
    homeTeamId,
    awayTeamId,
    fieldId: selectedSlot.fieldId,
  });
}

function selectSlotForMatchup({
  division,
  weekIndex,
  divisionSlots,
  sharedSlots,
  sharedSlotUsage,
  sharedFieldUsage,
  coachAssignments,
  teamIds,
  teamStartPreferences,
  coaches,
}) {
  const divisionKey = `${division}::${weekIndex}`;
  const sharedKey = `*::${weekIndex}`;
  const divisionCandidates = divisionSlots.get(divisionKey) ?? [];
  const sharedCandidates = sharedSlots.get(sharedKey) ?? [];

  let encounteredConflict = false;

  const viableDivisionSlots = [];

  for (const slotRecord of divisionCandidates) {
    if (slotRecord.remainingCapacity <= 0) {
      continue;
    }

    if (
      hasCoachConflict({
        coachAssignments,
        coaches,
        start: slotRecord.start,
        end: slotRecord.end,
      })
    ) {
      encounteredConflict = true;
      continue;
    }

    const consistencyScore = computeConsistencyScore({
      teamStartPreferences,
      teamIds,
      slotRecord,
    });

    viableDivisionSlots.push({ slotRecord, consistencyScore });
  }

  if (viableDivisionSlots.length > 0) {
    viableDivisionSlots.sort(
      (a, b) =>
        b.consistencyScore - a.consistencyScore ||
        a.slotRecord.start - b.slotRecord.start ||
        (a.slotRecord.fieldId ?? '').localeCompare(b.slotRecord.fieldId ?? '') ||
        a.slotRecord.id.localeCompare(b.slotRecord.id),
    );

    return { slot: viableDivisionSlots[0].slotRecord, encounteredConflict };
  }

  const viableSharedSlots = [];

  for (const slotRecord of sharedCandidates) {
    if (slotRecord.remainingCapacity <= 0) {
      continue;
    }

    if (
      hasCoachConflict({
        coachAssignments,
        coaches,
        start: slotRecord.start,
        end: slotRecord.end,
      })
    ) {
      encounteredConflict = true;
      continue;
    }

    const usage = getSharedSlotUsage({ sharedSlotUsage, slotId: slotRecord.id, division });
    const fieldUsage = getSharedFieldUsage({
      sharedFieldUsage,
      fieldId: slotRecord.fieldId,
      division,
    });
    const consistencyScore = computeConsistencyScore({
      teamStartPreferences,
      teamIds,
      slotRecord,
    });
    viableSharedSlots.push({ slotRecord, usage, fieldUsage, consistencyScore });
  }

  if (viableSharedSlots.length === 0) {
    return { slot: null, encounteredConflict };
  }

  viableSharedSlots.sort(
    (a, b) =>
      a.usage - b.usage ||
      a.fieldUsage - b.fieldUsage ||
      b.consistencyScore - a.consistencyScore ||
      a.slotRecord.start - b.slotRecord.start ||
      (a.slotRecord.fieldId ?? '').localeCompare(b.slotRecord.fieldId ?? '') ||
      a.slotRecord.id.localeCompare(b.slotRecord.id),
  );

  return { slot: viableSharedSlots[0].slotRecord, encounteredConflict };
}

function computeConsistencyScore({ teamStartPreferences, teamIds, slotRecord }) {
  const startKey = getStartTimeKey(slotRecord.start);
  let score = 0;
  for (const teamId of teamIds) {
    if (!teamId) {
      continue;
    }
    const record = teamStartPreferences.get(teamId);
    if (record?.preferredKey === startKey) {
      score += 1;
    }
  }
  return score;
}

function hasCoachConflict({ coachAssignments, coaches, start, end }) {
  for (const coachId of coaches) {
    if (!coachId) {
      continue;
    }
    const assignments = coachAssignments.get(coachId) ?? [];
    for (const assignment of assignments) {
      if (start < assignment.end && end > assignment.start) {
        return true;
      }
    }
  }
  return false;
}

function recordCoachAssignment({ coachAssignments, coachId, assignment }) {
  if (!coachId) {
    return;
  }
  const existing = coachAssignments.get(coachId) ?? [];
  existing.push(assignment);
  existing.sort((a, b) => a.start - b.start || a.slotId.localeCompare(b.slotId));
  coachAssignments.set(coachId, existing);
}

function updateTeamStartPreference({ teamStartPreferences, teamId, start }) {
  if (!teamId) {
    return;
  }

  const startKey = getStartTimeKey(start);
  const record = teamStartPreferences.get(teamId) ?? {
    counts: new Map(),
    preferredKey: null,
  };

  const nextCount = (record.counts.get(startKey) ?? 0) + 1;
  record.counts.set(startKey, nextCount);

  const currentPreferredCount = record.preferredKey ? record.counts.get(record.preferredKey) ?? 0 : 0;
  if (!record.preferredKey || nextCount > currentPreferredCount) {
    record.preferredKey = startKey;
  }

  teamStartPreferences.set(teamId, record);
}

function getSharedSlotUsage({ sharedSlotUsage, slotId, division }) {
  const slotUsage = sharedSlotUsage.get(slotId);
  if (!slotUsage) {
    return 0;
  }
  if (slotUsage.divisions instanceof Map) {
    return slotUsage.divisions.get(division) ?? 0;
  }
  return 0;
}

function getSharedFieldUsage({ sharedFieldUsage, fieldId, division }) {
  const fieldKey = fieldId ?? 'unassigned';
  const fieldUsage = sharedFieldUsage.get(fieldKey);
  if (!fieldUsage) {
    return 0;
  }
  return fieldUsage.get(division) ?? 0;
}

function recordSharedSlotUsage({ sharedSlotUsage, sharedFieldUsage, slot, division }) {
  const record = sharedSlotUsage.get(slot.id) ?? {
    slotId: slot.id,
    fieldId: slot.fieldId ?? null,
    weekIndex: slot.weekIndex,
    start: slot.start,
    end: slot.end,
    divisions: new Map(),
  };
  record.divisions.set(division, (record.divisions.get(division) ?? 0) + 1);
  sharedSlotUsage.set(slot.id, record);

  const fieldKey = slot.fieldId ?? 'unassigned';
  const fieldUsage = sharedFieldUsage.get(fieldKey) ?? new Map();
  fieldUsage.set(division, (fieldUsage.get(division) ?? 0) + 1);
  sharedFieldUsage.set(fieldKey, fieldUsage);
}

function formatSharedSlotUsage(sharedSlotUsage) {
  const usageSummaries = [];
  for (const record of sharedSlotUsage.values()) {
    const divisionUsage = Array.from(record.divisions.entries())
      .map(([division, count]) => ({ division, count }))
      .sort((a, b) => a.division.localeCompare(b.division));
    const totalAssignments = divisionUsage.reduce((sum, entry) => sum + entry.count, 0);
    usageSummaries.push({
      slotId: record.slotId,
      fieldId: record.fieldId,
      weekIndex: record.weekIndex,
      start: record.start.toISOString(),
      end: record.end.toISOString(),
      totalAssignments,
      divisionUsage,
    });
  }

  usageSummaries.sort((a, b) => a.slotId.localeCompare(b.slotId));
  return usageSummaries;
}

function getStartTimeKey(date) {
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}
