import { listTeamCoachIds } from './practiceScheduling.js';
import { SlotSchema, TeamSchema } from './schemas/index.js';

/** @typedef {import('./types.js').Team} Team */
/** @typedef {import('./types.js').GameSlot} GameSlot */

const BYE = '__BYE__';

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
 * `fieldId` on each returned assignment is an opaque string; the physical model
 * behind it (containment, spatial overlap, size vs lining, date-scoped
 * equipment) lives in `facility/` and is deliberately not consulted here - this
 * engine is week-indexed, the facility graph is date-indexed.
 * @see {@link import('./facility/types.js').FacilitySurface}
 *
 * @param {Object} params
 * @param {Team[]} params.teams - Teams participating in scheduling.
 * @param {GameSlot[]} params.slots
 *   - Slot definitions with optional division restriction.
 * @param {Record<string, Array<{ weekIndex: number, matchups: Array<{ homeTeamId: string, awayTeamId: string }>, byes: Array<string> }>>} params.roundRobinByDivision
 *   - Precomputed round-robin output keyed by division.
 * @param {unknown} [params.freeze]
 *   - **Refused.** See {@link scheduleGames} for why this parameter exists only
 *     to throw.
 * @returns {{
 *   assignments: Array<{ weekIndex: number, division: string, slotId: string, start: string, end: string, homeTeamId: string, awayTeamId: string, fieldId: string | null }>,
 *   byes: Array<{ weekIndex: number, division: string, teamId: string }>,
 *   unscheduled: Array<{ weekIndex: number, division: string, matchup: { homeTeamId: string, awayTeamId: string }, reason: string }>,
 *   sharedSlotUsage: Array<Object>,
 * }}
 */
export function scheduleGames({ teams, slots, roundRobinByDivision, freeze }) {
  // Freeze scopes are Phase 4.1 and they do not live here. This engine is
  // week-indexed and *generates* matchups from a round robin; it has no game
  // ids (assignments are keyed by division, week and the alphabetised pair) and
  // it cannot ingest an existing schedule, so there is nothing here for a
  // freeze to hold still. Accepting the argument and ignoring it would be the
  // worst available answer — that is incident 1's shape exactly: a caller who
  // believes a schedule is protected while every game is free to move.
  //
  // The real path is `packages/core/src/resolve/`:
  // `resolve/applyChangeRequest()` for a scoped change, and
  // `resolve/reoptimiseWholeSeason()` for the deliberate, named global
  // re-solve. GAP-32 (week index vs calendar date) and GAP-29 (no persisted
  // freeze scope) are why the bridge does not exist yet.
  if (freeze !== undefined) {
    throw new TypeError(
      'gameScheduling: scheduleGames() cannot honour a freeze and will not pretend to. It is week-indexed, it generates matchups rather than re-placing existing games, and its assignments carry no game id to freeze. Use resolve/applyChangeRequest() to apply a scoped change to an existing schedule, or resolve/reoptimiseWholeSeason() to re-solve one on purpose. See GAP-29 and GAP-32.'
    );
  }

  if (!roundRobinByDivision || typeof roundRobinByDivision !== 'object') {
    throw new TypeError('roundRobinByDivision must be an object');
  }

  if (!Array.isArray(teams)) {
    throw new TypeError('teams must be an array');
  }
  if (!Array.isArray(slots)) {
    throw new TypeError('slots must be an array');
  }

  const teamsById = indexTeams(teams);
  const { divisionSlots, sharedSlots, slotCapacityMap } = indexSlots(slots);
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
          slotCapacityMap,
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
    TeamSchema.parse(team);

    teamsById.set(team.id, {
      id: team.id,
      division: team.division,
      // 8.2: every coach on the team, through the same producer the practice
      // solver and both metric modules use. Leaving the solver on `coachId`
      // while `gameMetrics.evaluateGameSchedule()` checks every coach would
      // have the solver book a clash the report then raises and no rerun can
      // clear — the half-migrated state 8.1 avoided on the practice side by
      // widening solver and metric together.
      coachIds: listTeamCoachIds(team),
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
    // The parse result is the *only* source of `start`/`end` below. It used to
    // be discarded and `new Date(slot.start)` written out by hand one line
    // later, which left the schema's coercion decorative (GAP-30).
    const parsed = SlotSchema.parse(slot);

    if (
      typeof slot.weekIndex !== 'number' ||
      !Number.isInteger(slot.weekIndex) ||
      slot.weekIndex <= 0
    ) {
      throw new TypeError(`slot ${slot.id} must include a positive integer weekIndex`);
    }

    if (slotRecords.has(slot.id)) {
      throw new Error(`duplicate slot id detected: ${slot.id}`);
    }

    const record = {
      id: slot.id,
      division: slot.division ?? null,
      weekIndex: slot.weekIndex,
      start: parsed.start,
      end: parsed.end,
      remainingCapacity: slot.capacity,
      fieldId: slot.fieldId ?? null,
      priority: slot.priority ?? 1,
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
      // Primary Sort: Field Priority (Descending)
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }
      if (a.start.getTime() !== b.start.getTime()) {
        return a.start - b.start;
      }
      if ((a.fieldId ?? '') !== (b.fieldId ?? '')) {
        return (a.fieldId ?? '').localeCompare(b.fieldId ?? '');
      }
      return a.id.localeCompare(b.id);
    });
  }

  // Track remaining capacity in separate map instead of mutating slot objects
  const slotCapacityMap = new Map();
  for (const slotList of [...divisionSlots.values(), ...sharedSlots.values()]) {
    for (const slot of slotList) {
      slotCapacityMap.set(slot.id, slot.remainingCapacity);
    }
  }

  return { divisionSlots, sharedSlots, slotCapacityMap };
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
  slotCapacityMap,
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

  // 8.2: **any** coach in common, not only the first one on each row. A person
  // who is one side's second coach and the other's first is just as unable to
  // stand on both touchlines.
  const sharedCoachIds = homeTeam.coachIds.filter((coachId) => awayTeam.coachIds.includes(coachId));
  if (sharedCoachIds.length > 0) {
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
    coaches: [...homeTeam.coachIds, ...awayTeam.coachIds],
    slotCapacityMap,
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

  slotCapacityMap.set(selectedSlot.id, slotCapacityMap.get(selectedSlot.id) - 1);
  teamWeekAssignments.add(teamWeekKeyHome);
  teamWeekAssignments.add(teamWeekKeyAway);
  for (const [team, teamId] of [
    [homeTeam, homeTeamId],
    [awayTeam, awayTeamId],
  ]) {
    for (const coachId of team.coachIds) {
      recordCoachAssignment({
        coachAssignments,
        coachId,
        assignment: {
          slotId: selectedSlot.id,
          start: selectedSlot.start,
          end: selectedSlot.end,
          weekIndex,
          teamId,
        },
      });
    }
  }

  if (!selectedSlot.division) {
    recordSharedSlotUsage({
      sharedSlotUsage,
      sharedFieldUsage,
      slot: selectedSlot,
      division,
    });
  }

  for (const teamId of [homeTeamId, awayTeamId]) {
    updateTeamStartPreference({
      teamStartPreferences,
      teamId,
      start: selectedSlot.start,
    });
  }

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
  slotCapacityMap,
}) {
  const divisionKey = `${division}::${weekIndex}`;
  const sharedKey = `*::${weekIndex}`;
  const divisionCandidates = divisionSlots.get(divisionKey) ?? [];
  const sharedCandidates = sharedSlots.get(sharedKey) ?? [];

  let encounteredConflict = false;

  // 1. Try Division-Specific Slots
  let bestDivisionSlot = null;
  let bestDivisionScore = -1;

  for (const slotRecord of divisionCandidates) {
    const remainingCapacity = slotCapacityMap.get(slotRecord.id);
    if (remainingCapacity <= 0) {
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

    if (bestDivisionSlot === null) {
      bestDivisionSlot = slotRecord;
      bestDivisionScore = consistencyScore;
      continue;
    }

    // Compare: Higher score implies time consistency.
    // BUT we also want high priority fields.
    // Strategy: Priority > Score > Start Time
    if (slotRecord.priority > bestDivisionSlot.priority) {
      bestDivisionSlot = slotRecord;
      bestDivisionScore = consistencyScore;
    } else if (slotRecord.priority < bestDivisionSlot.priority) {
      continue;
    } else {
      // Equal priority: check score
      if (consistencyScore > bestDivisionScore) {
        bestDivisionSlot = slotRecord;
        bestDivisionScore = consistencyScore;
      } else if (consistencyScore === bestDivisionScore) {
        // Tie-breakers
        if (slotRecord.start < bestDivisionSlot.start) {
          bestDivisionSlot = slotRecord;
        } else if (slotRecord.start.getTime() === bestDivisionSlot.start.getTime()) {
          // ... field comparison ...
          const fieldA = slotRecord.fieldId ?? '';
          const fieldB = bestDivisionSlot.fieldId ?? '';
          if (fieldA < fieldB) {
            bestDivisionSlot = slotRecord;
          } else if (fieldA === fieldB) {
            if (slotRecord.id < bestDivisionSlot.id) {
              bestDivisionSlot = slotRecord;
            }
          }
        }
      }
    }
  }

  if (bestDivisionSlot) {
    return { slot: bestDivisionSlot, encounteredConflict };
  }

  // 2. Try Shared Slots
  let bestSharedSlot = null;
  let bestSharedMetrics = null; // { usage, fieldUsage, consistencyScore, priority }

  for (const slotRecord of sharedCandidates) {
    const remainingCapacity = slotCapacityMap.get(slotRecord.id);
    if (remainingCapacity <= 0) {
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
    const priority = slotRecord.priority;

    if (bestSharedSlot === null) {
      bestSharedSlot = slotRecord;
      bestSharedMetrics = { usage, fieldUsage, consistencyScore, priority };
      continue;
    }

    // Compare: Priority (High) > Usage (Low) > FieldUsage (Low) > Score (High)

    // 1. Priority
    if (priority > bestSharedMetrics.priority) {
      bestSharedSlot = slotRecord;
      bestSharedMetrics = { usage, fieldUsage, consistencyScore, priority };
      continue;
    } else if (priority < bestSharedMetrics.priority) {
      continue;
    }

    // 2. Usage (load balancing)
    if (usage < bestSharedMetrics.usage) {
      bestSharedSlot = slotRecord;
      bestSharedMetrics = { usage, fieldUsage, consistencyScore, priority };
      continue;
    } else if (usage > bestSharedMetrics.usage) {
      continue;
    }

    // 3. Field Usage (load balancing)
    if (fieldUsage < bestSharedMetrics.fieldUsage) {
      bestSharedSlot = slotRecord;
      bestSharedMetrics = { usage, fieldUsage, consistencyScore, priority };
      continue;
    } else if (fieldUsage > bestSharedMetrics.fieldUsage) {
      continue;
    }

    // 4. Consistency Score
    if (consistencyScore > bestSharedMetrics.consistencyScore) {
      bestSharedSlot = slotRecord;
      bestSharedMetrics = { usage, fieldUsage, consistencyScore, priority };
      continue;
    } else if (consistencyScore < bestSharedMetrics.consistencyScore) {
      continue;
    }

    // Tie-breakers: start, fieldId, id
    if (slotRecord.start < bestSharedSlot.start) {
      bestSharedSlot = slotRecord;
      bestSharedMetrics = { usage, fieldUsage, consistencyScore, priority };
    } else if (slotRecord.start.getTime() === bestSharedSlot.start.getTime()) {
      const fieldA = slotRecord.fieldId ?? '';
      const fieldB = bestSharedSlot.fieldId ?? '';
      if (fieldA < fieldB) {
        bestSharedSlot = slotRecord;
        bestSharedMetrics = { usage, fieldUsage, consistencyScore, priority };
      } else if (fieldA === fieldB) {
        if (slotRecord.id < bestSharedSlot.id) {
          bestSharedSlot = slotRecord;
          bestSharedMetrics = { usage, fieldUsage, consistencyScore, priority };
        }
      }
    }
  }

  return { slot: bestSharedSlot, encounteredConflict };
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

  const currentPreferredCount = record.preferredKey
    ? (record.counts.get(record.preferredKey) ?? 0)
    : 0;
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
