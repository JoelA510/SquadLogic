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
  if (!Array.isArray(teams)) {
    throw new TypeError('teams must be an array');
  }
  if (!Array.isArray(slots)) {
    throw new TypeError('slots must be an array');
  }
  if (!roundRobinByDivision || typeof roundRobinByDivision !== 'object') {
    throw new TypeError('roundRobinByDivision must be an object');
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
      if (!week || typeof week !== 'object') {
        throw new TypeError(`week entries for division ${division} must be objects`);
      }
      if (typeof week.weekIndex !== 'number') {
        throw new TypeError(`week entries for division ${division} must include weekIndex`);
      }

      for (const byeTeamId of week.byes ?? []) {
        if (!teamsById.has(byeTeamId)) {
          continue;
        }
        byes.push({ weekIndex: week.weekIndex, division, teamId: byeTeamId });
      }

      for (const matchup of week.matchups ?? []) {
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
            weekIndex: week.weekIndex,
            division,
            matchup: { homeTeamId, awayTeamId },
            reason: 'unknown-team',
          });
          continue;
        }

        if (homeTeam.division !== division || awayTeam.division !== division) {
          unscheduled.push({
            weekIndex: week.weekIndex,
            division,
            matchup: { homeTeamId, awayTeamId },
            reason: 'division-mismatch',
          });
          continue;
        }

        const teamWeekKeyHome = `${homeTeamId}::${week.weekIndex}`;
        const teamWeekKeyAway = `${awayTeamId}::${week.weekIndex}`;
        if (teamWeekAssignments.has(teamWeekKeyHome) || teamWeekAssignments.has(teamWeekKeyAway)) {
          unscheduled.push({
            weekIndex: week.weekIndex,
            division,
            matchup: { homeTeamId, awayTeamId },
            reason: 'duplicate-matchup',
          });
          continue;
        }

        if (homeTeam.coachId && homeTeam.coachId === awayTeam.coachId) {
          unscheduled.push({
            weekIndex: week.weekIndex,
            division,
            matchup: { homeTeamId, awayTeamId },
            reason: 'coach-conflict',
          });
          continue;
        }

        const divisionKey = `${division}::${week.weekIndex}`;
        const sharedKey = `*::${week.weekIndex}`;
        const candidateSlots = [
          ...(divisionSlots.get(divisionKey) ?? []),
          ...(sharedSlots.get(sharedKey) ?? []),
        ];

        let selectedSlot = null;
        let encounteredConflict = false;

        for (const slotRecord of candidateSlots) {
          if (slotRecord.remainingCapacity <= 0) {
            continue;
          }

          if (
            hasCoachConflict({
              coachAssignments,
              coaches: [homeTeam.coachId, awayTeam.coachId],
              start: slotRecord.start,
              end: slotRecord.end,
            })
          ) {
            encounteredConflict = true;
            continue;
          }

          selectedSlot = slotRecord;
          break;
        }

        if (!selectedSlot) {
          unscheduled.push({
            weekIndex: week.weekIndex,
            division,
            matchup: { homeTeamId, awayTeamId },
            reason: encounteredConflict ? 'coach-conflict' : 'no-slot-available',
          });
          continue;
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
            weekIndex: week.weekIndex,
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
            weekIndex: week.weekIndex,
            teamId: awayTeamId,
          },
        });

        assignments.push({
          weekIndex: week.weekIndex,
          division,
          slotId: selectedSlot.id,
          start: selectedSlot.start.toISOString(),
          end: selectedSlot.end.toISOString(),
          homeTeamId,
          awayTeamId,
          fieldId: selectedSlot.fieldId,
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

  return { assignments, byes, unscheduled };
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
