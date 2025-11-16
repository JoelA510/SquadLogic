/**
 * Assign weekly practice slots to teams using a simple scoring system that respects slot capacity
 * and avoids coach conflicts.
 *
 * The algorithm prioritises teams coached by households with multiple teams to reduce the odds of
 * scheduling conflicts. For each team the available slots are scored using coach and division
 * preferences. Ties are broken by earliest start time and deterministic ordering to keep the output
 * stable for automated testing.
 *
 * @param {Object} params
 * @param {Array<Object>} params.teams - Teams requiring practice assignments. Each team must expose
 *   `id`, `division`, and `coachId` (nullable for teams without a coach assignment).
 * @param {Array<Object>} params.slots - Practice slot definitions with `id`, `start`, `end`, and
 *   `capacity` (number of teams that can share the slot). Optional `day` provides human readable
 *   metadata used for preference scoring.
 * @param {Object<string, Object>} [params.coachPreferences] - Optional coach preference map. Each
  *   entry may include `preferredDays` (array of day strings), `preferredSlotIds` (array of slot
  *   identifiers), and `unavailableSlotIds` (array of slot identifiers to avoid entirely).
 * @param {Object<string, Object>} [params.divisionPreferences] - Optional division preference map.
  *   Supports `preferredDays` similar to coach preferences.
 * @param {Array<{ teamId: string, slotId: string }>} [params.lockedAssignments] - Optional manual
  *   overrides that must be honoured ahead of auto assignments.
 * @param {Object} [params.scoringWeights] - Optional weighting overrides supporting `coachPreferredSlot`,
 *   `coachPreferredDay`, `divisionPreferredDay`, `divisionSaturationPenalty`, and
 *   `divisionDaySaturationPenalty` keys for tuning slot scoring.
 * @returns {{ assignments: Array<{ teamId: string, slotId: string, source: 'locked' | 'auto' }>, unassigned: Array<{ teamId: string, reason: string, candidates: Array<{ slotId: string, score: number }> }> }}
 */

const DEFAULT_SCORING_WEIGHTS = {
  coachPreferredSlot: 10,
  coachPreferredDay: 5,
  divisionPreferredDay: 3,
  divisionSaturationPenalty: 4,
  divisionDaySaturationPenalty: 2,
};

function sanitizeScoringWeights(weights = {}) {
  if (weights === null || typeof weights !== 'object' || Array.isArray(weights)) {
    throw new TypeError('scoringWeights must be an object when provided');
  }

  const normalized = { ...DEFAULT_SCORING_WEIGHTS };
  for (const [key, value] of Object.entries(weights)) {
    if (!(key in DEFAULT_SCORING_WEIGHTS)) {
      throw new Error(`unsupported scoring weight provided: ${key}`);
    }
    if (!Number.isFinite(value)) {
      throw new TypeError(`scoring weight ${key} must be a finite number`);
    }
    normalized[key] = value;
  }

  return normalized;
}

function getDivisionLoadKey(slotOrBaseSlotId, division) {
  const baseSlotId =
    typeof slotOrBaseSlotId === 'string'
      ? slotOrBaseSlotId
      : slotOrBaseSlotId.baseSlotId ?? slotOrBaseSlotId.id;
  return `${baseSlotId}::${division}`;
}

function getDivisionDayKey(slot, division) {
  if (!slot.day) {
    return null;
  }
  return `${slot.day}::${division}`;
}

export function schedulePractices({
  teams,
  slots,
  coachPreferences = {},
  divisionPreferences = {},
  lockedAssignments = [],
  scoringWeights,
}) {
  if (!Array.isArray(teams)) {
    throw new TypeError('teams must be an array');
  }
  if (!Array.isArray(slots)) {
    throw new TypeError('slots must be an array');
  }
  if (!Array.isArray(lockedAssignments)) {
    throw new TypeError('lockedAssignments must be an array');
  }

  const weights = sanitizeScoringWeights(scoringWeights);

  const sanitizedTeams = teams.map((team) => {
    if (!team || typeof team !== 'object') {
      throw new TypeError('each team must be an object');
    }
    if (!team.id) {
      throw new TypeError('each team requires an id');
    }
    if (!team.division) {
      throw new TypeError(`team ${team.id} is missing a division`);
    }

    return {
      id: team.id,
      division: team.division,
      coachId: team.coachId ?? null,
    };
  });

  const teamsById = new Map(sanitizedTeams.map((team) => [team.id, team]));

  const sanitizedSlots = slots.map((slot) => {
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

    return {
      id: slot.id,
      baseSlotId: slot.baseSlotId ?? slot.id,
      seasonPhaseId: slot.seasonPhaseId ?? null,
      effectiveFrom: slot.effectiveFrom ?? null,
      effectiveUntil: slot.effectiveUntil ?? null,
      day: slot.day ?? null,
      start: new Date(slot.start),
      end: new Date(slot.end),
      capacity: slot.capacity,
    };
  });

  const slotsById = new Map();
  for (const slot of sanitizedSlots) {
    if (Number.isNaN(slot.start.getTime()) || Number.isNaN(slot.end.getTime())) {
      throw new Error(`slot ${slot.id} includes an invalid timestamp`);
    }
    if (slot.end <= slot.start) {
      throw new Error(`slot ${slot.id} must end after it starts`);
    }
    if (slotsById.has(slot.id)) {
      throw new Error(`duplicate slot id detected: ${slot.id}`);
    }
    slotsById.set(slot.id, {
      ...slot,
      assignedTeams: [],
    });
  }

  const assignments = [];
  const unassigned = [];
  const coachAssignments = new Map();
  const assignedTeamIds = new Set();
  const assignmentByTeamId = new Map();
  const assignmentSources = new Map();
  const divisionLoadByBaseSlot = new Map();
  const divisionLoadByDay = new Map();

  const incrementDivisionLoad = (slot, division) => {
    const increment = (map, key) => {
      if (key) {
        map.set(key, (map.get(key) ?? 0) + 1);
      }
    };
    increment(divisionLoadByBaseSlot, getDivisionLoadKey(slot, division));
    increment(divisionLoadByDay, getDivisionDayKey(slot, division));
  };

  const decrementDivisionLoad = (slot, division) => {
    const key = getDivisionLoadKey(slot, division);
    const current = divisionLoadByBaseSlot.get(key);
    if (current) {
      if (current > 1) {
        divisionLoadByBaseSlot.set(key, current - 1);
      } else {
        divisionLoadByBaseSlot.delete(key);
      }
    }

    const dayKey = getDivisionDayKey(slot, division);
    if (dayKey) {
      const dayCurrent = divisionLoadByDay.get(dayKey);
      if (dayCurrent) {
        if (dayCurrent > 1) {
          divisionLoadByDay.set(dayKey, dayCurrent - 1);
        } else {
          divisionLoadByDay.delete(dayKey);
        }
      }
    }
  };

  const assignTeamToSlot = (team, slot, source) => {
    slot.capacity -= 1;
    slot.assignedTeams.push(team.id);
    const assignment = { teamId: team.id, slotId: slot.id, source };
    assignments.push(assignment);
    assignmentByTeamId.set(team.id, { assignment, slot });
    assignmentSources.set(team.id, source);
    assignedTeamIds.add(team.id);
    incrementDivisionLoad(slot, team.division);

    if (team.coachId) {
      const existing = coachAssignments.get(team.coachId) ?? [];
      existing.push({ teamId: team.id, slotId: slot.id, start: slot.start, end: slot.end });
      coachAssignments.set(team.coachId, existing);
    }
  };

  const removeAssignmentForTeam = (team) => {
    const record = assignmentByTeamId.get(team.id);
    if (!record) {
      return;
    }

    const { assignment, slot } = record;
    slot.capacity += 1;
    slot.assignedTeams = slot.assignedTeams.filter((id) => id !== team.id);
    decrementDivisionLoad(slot, team.division);

    const index = assignments.indexOf(assignment);
    if (index >= 0) {
      assignments.splice(index, 1);
    }

    assignmentByTeamId.delete(team.id);
    assignmentSources.delete(team.id);
    assignedTeamIds.delete(team.id);

    if (team.coachId) {
      const existing = coachAssignments.get(team.coachId) ?? [];
      const filtered = existing.filter((entry) => entry.slotId !== assignment.slotId || entry.teamId !== team.id);
      if (filtered.length === 0) {
        coachAssignments.delete(team.coachId);
      } else {
        coachAssignments.set(team.coachId, filtered);
      }
    }
  };

  for (const locked of lockedAssignments) {
    if (!locked || typeof locked !== 'object') {
      throw new TypeError('each locked assignment must be an object');
    }
    if (!locked.teamId || !locked.slotId) {
      throw new TypeError('locked assignments require teamId and slotId');
    }

    const team = teamsById.get(locked.teamId);
    if (!team) {
      throw new Error(`locked assignment references unknown team ${locked.teamId}`);
    }
    if (assignedTeamIds.has(team.id)) {
      throw new Error(`multiple locked assignments provided for team ${team.id}`);
    }

    const slot = slotsById.get(locked.slotId);
    if (!slot) {
      throw new Error(`locked assignment references unknown slot ${locked.slotId}`);
    }
    if (slot.capacity <= 0) {
      throw new Error(
        `locked assignment for team ${team.id} targets slot ${slot.id} with no remaining capacity`,
      );
    }

    assignTeamToSlot(team, slot, 'locked');
  }

  const coachTeamCounts = new Map();
  for (const team of sanitizedTeams) {
    if (team.coachId) {
      coachTeamCounts.set(team.coachId, (coachTeamCounts.get(team.coachId) ?? 0) + 1);
    }
  }

  const teamsByPriority = [...sanitizedTeams].sort((a, b) => {
    const aCoachCount = a.coachId ? coachTeamCounts.get(a.coachId) ?? 0 : 0;
    const bCoachCount = b.coachId ? coachTeamCounts.get(b.coachId) ?? 0 : 0;
    if (aCoachCount !== bCoachCount) {
      return bCoachCount - aCoachCount;
    }
    return a.id.localeCompare(b.id);
  });

  for (const team of teamsByPriority) {
    if (assignedTeamIds.has(team.id)) {
      continue;
    }
    const { slotScores, viableSlots, blockedSlots } = evaluateSlotsForTeam({
      team,
      slotsById,
      coachPreferences,
      divisionPreferences,
      coachAssignments,
      divisionLoadByBaseSlot,
      divisionLoadByDay,
      weights,
    });

    if (viableSlots.length === 0) {
      unassigned.push({
        teamId: team.id,
        reason: deriveUnassignmentReason(blockedSlots),
        candidates: slotScores,
      });
      continue;
    }

    const bestSlot = pickBestSlotCandidate(viableSlots);

    const slotRecord = slotsById.get(bestSlot.slot.id);
    assignTeamToSlot(team, slotRecord, 'auto');
  }

  const unresolved = attemptResolveUnassignedTeams({
    unassignedEntries: unassigned,
    assignTeamToSlot,
    removeAssignmentForTeam,
    teamsById,
    slotsById,
    coachPreferences,
    divisionPreferences,
    coachAssignments,
    assignmentByTeamId,
    assignmentSources,
    divisionLoadByBaseSlot,
    divisionLoadByDay,
    weights,
  });

  unassigned.length = 0;
  unassigned.push(...unresolved);

  assignments.sort((a, b) => a.teamId.localeCompare(b.teamId) || a.slotId.localeCompare(b.slotId));

  return { assignments, unassigned };
}

/**
 * Determine viable slots for a given team, applying hard constraints and generating preference
 * scores used by the scheduler to choose the optimal assignment.
 *
 * @param {Object} params
 * @param {{ id: string, division: string, coachId: string | null }} params.team - The team being
 *   evaluated.
 * @param {Map<string, { id: string, day: string | null, start: Date, end: Date, capacity: number, assignedTeams: string[] }>} params.slotsById
 *   - Lookup of slot metadata by identifier.
 * @param {Object<string, { preferredDays?: Array<string>, preferredSlotIds?: Array<string>, unavailableSlotIds?: Array<string> }>} params.coachPreferences
 *   - Optional map of coach preferences and unavailability.
 * @param {Object<string, { preferredDays?: Array<string> }>} params.divisionPreferences - Optional
 *   map of division level preferences.
 * @param {Map<string, Array<{ slotId: string, start: Date, end: Date }>>} params.coachAssignments -
 *   Existing assignments per coach used to prevent overlaps.
 * @param {Map<string, number>} params.divisionLoadByBaseSlot - Counts of assigned teams per
 *   base slot and division used to discourage stacking the same division on a single field/time.
 * @param {Map<string, number>} params.divisionLoadByDay - Counts of assigned teams per day and
 *   division used to discourage stacking a division on the same practice day.
 * @returns {{ slotScores: Array<{ slotId: string, score: number }>, viableSlots: Array<{ slot: Object, score: number }> }}
 */
function evaluateSlotsForTeam({
  team,
  slotsById,
  coachPreferences,
  divisionPreferences,
  coachAssignments,
  divisionLoadByBaseSlot,
  divisionLoadByDay,
  weights,
}, options = {}) {
  const { includeFullSlots = false, excludeSlotIds } = options;
  const excludedSlots = excludeSlotIds ? new Set(excludeSlotIds) : null;
  const slotScores = [];
  const viableSlots = [];
  const blockedSlots = [];
  const coachPref = coachPreferences[team.coachId] ?? {};
  const divisionPref = divisionPreferences[team.division] ?? {};
  const preferredCoachDays = new Set(coachPref.preferredDays ?? []);
  const preferredCoachSlots = new Set(coachPref.preferredSlotIds ?? []);
  const unavailableCoachSlots = new Set(coachPref.unavailableSlotIds ?? []);
  const preferredDivisionDays = new Set(divisionPref.preferredDays ?? []);
  const coachExistingAssignments = coachAssignments.get(team.coachId) ?? [];

  for (const slot of slotsById.values()) {
    let rejectionReason = null;
    if (excludedSlots && excludedSlots.has(slot.id)) {
      rejectionReason = 'excluded-slot';
    }

    const isFull = slot.capacity <= 0;
    const overlapsCoachSchedule =
      team.coachId &&
      overlapsExistingAssignments({
        assignments: coachExistingAssignments,
        start: slot.start,
        end: slot.end,
      });
    const isUnavailable =
      rejectionReason !== null ||
      (!includeFullSlots && isFull) ||
      unavailableCoachSlots.has(slot.id) ||
      overlapsCoachSchedule;

    if (rejectionReason === null && isUnavailable) {
      if (!includeFullSlots && isFull) {
        rejectionReason = 'no-capacity';
      } else if (unavailableCoachSlots.has(slot.id)) {
        rejectionReason = 'coach-unavailable';
      } else if (overlapsCoachSchedule) {
        rejectionReason = 'coach-conflict';
      }
    }

    if (isUnavailable) {
      blockedSlots.push({ slotId: slot.id, reason: rejectionReason });
      slotScores.push({ slotId: slot.id, score: -Infinity });
      continue;
    }

    let score = 0;
    if (preferredCoachSlots.has(slot.id)) {
      score += weights.coachPreferredSlot;
    }
    if (slot.day && preferredCoachDays.has(slot.day)) {
      score += weights.coachPreferredDay;
    }
    if (slot.day && preferredDivisionDays.has(slot.day)) {
      score += weights.divisionPreferredDay;
    }

    const divisionLoadKey = getDivisionLoadKey(slot, team.division);
    const sameDivisionCount = divisionLoadByBaseSlot.get(divisionLoadKey) ?? 0;
    if (sameDivisionCount > 0) {
      score -= sameDivisionCount * weights.divisionSaturationPenalty;
    }

    const divisionDayKey = getDivisionDayKey(slot, team.division);
    const sameDivisionDayCount = divisionDayKey
      ? divisionLoadByDay.get(divisionDayKey) ?? 0
      : 0;
    if (sameDivisionDayCount > 0) {
      score -= sameDivisionDayCount * weights.divisionDaySaturationPenalty;
    }

    slotScores.push({ slotId: slot.id, score });
    viableSlots.push({ slot, score, isFull });
  }

  return { slotScores, viableSlots, blockedSlots };
}

function deriveUnassignmentReason(blockedSlots) {
  if (!Array.isArray(blockedSlots) || blockedSlots.length === 0) {
    return 'no available slots meeting hard constraints';
  }

  const reasonCounts = blockedSlots.reduce((acc, entry) => {
    const reason = entry?.reason ?? 'unknown';
    acc[reason] = (acc[reason] ?? 0) + 1;
    return acc;
  }, {});

  const total = blockedSlots.length;

  if ((reasonCounts['no-capacity'] ?? 0) === total) {
    return 'no available capacity';
  }

  const coachBlocked = (reasonCounts['coach-conflict'] ?? 0) +
    (reasonCounts['coach-unavailable'] ?? 0);
  if (coachBlocked === total) {
    const hasConflicts = (reasonCounts['coach-conflict'] ?? 0) > 0;
    const hasUnavailability = (reasonCounts['coach-unavailable'] ?? 0) > 0;

    if (hasConflicts && !hasUnavailability) {
      return 'coach schedule conflicts on all slots';
    }
    if (hasUnavailability && !hasConflicts) {
      return 'coach availability excludes all slots';
    }
    return 'coach availability issues across all slots';
  }

  if ((reasonCounts['excluded-slot'] ?? 0) === total) {
    return 'no alternative slots available';
  }

  return 'no available slots meeting hard constraints';
}

function pickBestSlotCandidate(candidates) {
  const ranked = rankSlotCandidates(candidates);
  return ranked[0] ?? null;
}

function attemptResolveUnassignedTeams({
  unassignedEntries,
  assignTeamToSlot,
  removeAssignmentForTeam,
  teamsById,
  slotsById,
  coachPreferences,
  divisionPreferences,
  coachAssignments,
  assignmentSources,
  divisionLoadByBaseSlot,
  divisionLoadByDay,
  weights,
}) {
  const unresolved = [];

  for (const entry of unassignedEntries) {
    const team = teamsById.get(entry.teamId);
    if (!team) {
      unresolved.push(entry);
      continue;
    }

    const resolved = tryResolveTeamWithSwap({
      team,
      assignTeamToSlot,
      removeAssignmentForTeam,
      slotsById,
      coachPreferences,
      divisionPreferences,
      coachAssignments,
      teamsById,
      assignmentSources,
      divisionLoadByBaseSlot,
      divisionLoadByDay,
      weights,
    });

    if (!resolved) {
      unresolved.push(entry);
    }
  }

  return unresolved;
}

function tryResolveTeamWithSwap({
  team,
  assignTeamToSlot,
  removeAssignmentForTeam,
  slotsById,
  coachPreferences,
  divisionPreferences,
  coachAssignments,
  teamsById,
  assignmentSources,
  divisionLoadByBaseSlot,
  divisionLoadByDay,
  weights,
}) {
  const { viableSlots } = evaluateSlotsForTeam(
    {
      team,
      slotsById,
      coachPreferences,
      divisionPreferences,
      coachAssignments,
      divisionLoadByBaseSlot,
      divisionLoadByDay,
      weights,
    },
    { includeFullSlots: true },
  );

  const rankedCandidates = rankSlotCandidates(viableSlots);

  for (const candidate of rankedCandidates) {
    const targetSlot = candidate.slot;

    if (!candidate.isFull) {
      assignTeamToSlot(team, targetSlot, 'auto');
      return true;
    }

    for (const occupantTeamId of [...targetSlot.assignedTeams]) {
      if (occupantTeamId === team.id) {
        continue;
      }

      const occupantTeam = teamsById.get(occupantTeamId);
      if (!occupantTeam) {
        continue;
      }

      const occupantSource = assignmentSources.get(occupantTeamId);
      if (occupantSource === 'locked') {
        continue;
      }

      removeAssignmentForTeam(occupantTeam);

      const alternativeSlot = findBestAvailableSlotForTeam({
        team: occupantTeam,
        slotsById,
        coachPreferences,
        divisionPreferences,
        coachAssignments,
        divisionLoadByBaseSlot,
        divisionLoadByDay,
        excludeSlotIds: [targetSlot.id],
        weights,
      });

      if (alternativeSlot) {
        assignTeamToSlot(occupantTeam, alternativeSlot, occupantSource ?? 'auto');
        assignTeamToSlot(team, targetSlot, 'auto');
        return true;
      }

      assignTeamToSlot(occupantTeam, targetSlot, occupantSource ?? 'auto');
    }
  }

  return false;
}

function findBestAvailableSlotForTeam({
  team,
  slotsById,
  coachPreferences,
  divisionPreferences,
  coachAssignments,
  divisionLoadByBaseSlot,
  divisionLoadByDay,
  excludeSlotIds,
  weights,
}) {
  const { viableSlots } = evaluateSlotsForTeam(
    {
      team,
      slotsById,
      coachPreferences,
      divisionPreferences,
      coachAssignments,
      divisionLoadByBaseSlot,
      divisionLoadByDay,
      weights,
    },
    { excludeSlotIds },
  );

  const ranked = rankSlotCandidates(viableSlots);
  for (const candidate of ranked) {
    if (candidate.isFull) {
      continue;
    }
    return candidate.slot;
  }
  return null;
}

function rankSlotCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    if (a.slot.start.getTime() !== b.slot.start.getTime()) {
      return a.slot.start - b.slot.start;
    }
    return a.slot.id.localeCompare(b.slot.id);
  });
}

function overlapsExistingAssignments({ assignments, start, end }) {
  for (const existing of assignments) {
    if (start < existing.end && end > existing.start) {
      return true;
    }
  }
  return false;
}
