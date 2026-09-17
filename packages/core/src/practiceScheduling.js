import { coachesOfTeamRow } from './people/coachList.js';
import { SlotSchema, TeamSchema } from './schemas/index.js';

/** @typedef {import('./types.js').Team} Team */
/** @typedef {import('./types.js').PracticeSlot} PracticeSlot */
/** @typedef {import('./types.js').ScoringWeights} ScoringWeights */

/**
 * @typedef {Object} ScheduleResult
 * @property {Array<{ teamId: string, slotId: string, source: 'locked' | 'auto' }>} assignments
 * @property {Array<{ teamId: string, reason: string, candidates: Array<{ slotId: string, score: number }> }>} unassigned
 * @property {Object} divisionLoadSummary
 */

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
 * @param {Team[]} params.teams - Teams requiring practice assignments.
 * @param {PracticeSlot[]} params.slots - Practice slot definitions.
 * @param {Record<string, { preferredDays?: string[], preferredSlotIds?: string[], unavailableSlotIds?: string[] }>} [params.coachPreferences]
 * @param {Record<string, { preferredDays?: string[] }>} [params.divisionPreferences]
 * @param {Array<{ teamId: string, slotId: string }>} [params.lockedAssignments]
 * @param {Partial<ScoringWeights>} [params.scoringWeights]
 * @param {string} [params.schoolDayEnd] - e.g. '16:00'
 * @param {string} [params.timezone]
 * @returns {ScheduleResult}
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
      : (slotOrBaseSlotId.baseSlotId ?? slotOrBaseSlotId.id);
  return `${baseSlotId}::${division}`;
}

function getDivisionDayKey(slot, division) {
  if (!slot.day) {
    return null;
  }
  return `${slot.day}::${division}`;
}

/**
 * **Every coach a team carries, whichever shape the team arrived in.**
 *
 * 8.1 introduced this as "head coach plus assistants" over the legacy
 * `coachId` + `assistantCoachIds[]` columns. 8.2 made the *reconciled* shape —
 * a `coaches` list of `{ personId, displayName, email, slot }` — first class in
 * every artifact, and for one round this function did not know about it: two
 * teams sharing a coach through `coaches` produced **no** conflict while the
 * same pair spelled the legacy way produced one, so a team was protected or not
 * according to which shape it happened to arrive in. That is the 8.1 defect
 * with a new spelling.
 *
 * So this is now a thin call on `people/coachList.js`, the single producer
 * every artifact already goes through. There is one answer to "who coaches this
 * team" and the solver, both metric modules and every export read it.
 *
 * What it keeps from the 8.1 contract, deliberately:
 *
 * - **Order.** Slot order, which is the clash-breaker `people/roster.js`
 *   defends — not a rank of whose conflicts matter.
 * - **Deduplication.** A person named twice on one team is one coach.
 * - **Blank is absent.** An empty id contributes nobody.
 * - **A malformed list is refused, not read as "no coaches"**, so a broken team
 *   never passes as conflict-free. The message now names the offending value as
 *   well as the field.
 *
 * What it hands back are the **clash keys**: the coaches an id corroborates.
 * A coach the row can only name or address (an id-less `coachName`, a bare
 * email) is still a coach — the export lists them and the reconciliation
 * reports them — but nothing proves two such rows are one person, so they are
 * not compared here: a matchup is never refused on the strength of a spelling.
 * Nor is their absence silent: `people/coachList.js` raises
 * `COACH_IDENTITY_UNCORROBORATED` for each one, saying a clash involving them
 * cannot be detected. The rule and the reason for each fallback are in that
 * module's header.
 *
 * @param {{ id?: unknown, coachId?: string | null, assistantCoachIds?: string[] | null, assistant_coach_ids?: string[] | null, coaches?: Array<Object> | null }} team
 * @returns {string[]}
 */
export function listTeamCoachIds(team) {
  return [...coachesOfTeamRow(team).corroboratedPersonIds];
}

export function schedulePractices({
  teams,
  slots,
  coachPreferences = {},
  divisionPreferences = {},
  lockedAssignments = [],
  scoringWeights = {},
  schoolDayEnd = undefined,
  timezone = undefined,
}) {
  if (!Array.isArray(teams)) {
    throw new TypeError('teams must be an array');
  }
  if (!Array.isArray(slots)) {
    throw new TypeError('slots must be an array');
  }

  // Filter slots based on schoolDayEnd if provided and day is Mon-Thu
  // Note: We assume slots.start is a Date object or ISO string.
  // We need to be careful about timezone. If slots are UTC and schoolDayEnd is local, we need conversion.
  // For R3 MVP, we will assume simple hour comparison if timezone handling is external,
  // OR we implement robust checking here.
  // Given Refactor.md says "scheduling logic... to respect these values", we should filter here.

  let effectiveSlots = slots;
  if (schoolDayEnd) {
    const [endHour, endMinute] = schoolDayEnd.split(':').map(Number);
    effectiveSlots = slots.filter((slot) => {
      if (!slot.day || ['Friday', 'Saturday', 'Sunday'].includes(slot.day)) {
        return true;
      }
      const start = new Date(slot.start);
      if (timezone) {
        // Use Intl.DateTimeFormat to get local components without brittle string parsing
        try {
          const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            hour: 'numeric',
            minute: 'numeric',
            hour12: false,
          });
          const parts = formatter.formatToParts(start);
          const localHour = parseInt(parts.find((p) => p.type === 'hour').value, 10);
          const localMinute = parseInt(parts.find((p) => p.type === 'minute').value, 10);

          if (localHour < endHour || (localHour === endHour && localMinute < endMinute)) {
            return false;
          }
        } catch {
          console.error(
            `Invalid timezone provided: ${timezone}. Skipping schoolDayEnd filter for slot ${slot.id}.`
          );
        }
      }
      return true;
    });
  }
  if (!Array.isArray(lockedAssignments)) {
    throw new TypeError('lockedAssignments must be an array');
  }

  const weights = sanitizeScoringWeights(scoringWeights);

  const sanitizedTeams = teams.map((team) => {
    TeamSchema.parse(team);

    return {
      id: team.id,
      division: team.division,
      coachId: team.coachId ?? null,
      coachIds: listTeamCoachIds(team),
      busiestCoachCount: 0,
    };
  });

  const teamsById = new Map(sanitizedTeams.map((team) => [team.id, team]));

  // Track remaining capacity and team assignments in separate maps instead of mutating slot objects
  const slotCapacityMap = new Map();
  const slotAssignmentsMap = new Map();

  const sanitizedSlots = effectiveSlots.map((slot) => {
    // Read, not discarded -- see the note in `schemas/index.js` (GAP-30).
    const parsed = SlotSchema.parse(slot);

    const slotRecord = {
      id: slot.id,
      baseSlotId: slot.baseSlotId ?? slot.id,
      seasonPhaseId: slot.seasonPhaseId ?? null,
      effectiveFrom: slot.effectiveFrom ?? null,
      effectiveUntil: slot.effectiveUntil ?? null,
      day: slot.day ?? null,
      start: parsed.start,
      end: parsed.end,
      capacity: slot.capacity,
    };

    slotCapacityMap.set(slot.id, slot.capacity);
    slotAssignmentsMap.set(slot.id, []);

    return slotRecord;
  });

  const slotsById = new Map();
  for (const slot of sanitizedSlots) {
    // Deliberately an assertion with no field read: these records were built
    // from already-parsed slots two blocks up, so there is no conversion to
    // honour here, only a shape re-check. Not the GAP-30 shape.
    SlotSchema.parse(slot);
    if (slotsById.has(slot.id)) {
      throw new Error(`duplicate slot id detected: ${slot.id}`);
    }
    slotsById.set(slot.id, slot);
  }

  const assignments = [];
  const unassigned = [];
  const coachAssignments = new Map();
  const assignedTeamIds = new Set();
  const assignmentByTeamId = new Map();
  const assignmentSources = new Map();
  const divisionLoadByBaseSlot = new Map();
  const divisionLoadByDay = new Map();

  const adjustDivisionLoad = (map, key, delta) => {
    if (!key) {
      return;
    }

    const current = map.get(key) ?? 0;
    const next = current + delta;

    if (next > 0) {
      map.set(key, next);
    } else {
      map.delete(key);
    }
  };

  const incrementDivisionLoad = (slot, division) => {
    adjustDivisionLoad(divisionLoadByBaseSlot, getDivisionLoadKey(slot, division), 1);
    adjustDivisionLoad(divisionLoadByDay, getDivisionDayKey(slot, division), 1);
  };

  const decrementDivisionLoad = (slot, division) => {
    adjustDivisionLoad(divisionLoadByBaseSlot, getDivisionLoadKey(slot, division), -1);
    adjustDivisionLoad(divisionLoadByDay, getDivisionDayKey(slot, division), -1);
  };

  const assignTeamToSlot = (team, slot, source) => {
    slotCapacityMap.set(slot.id, slotCapacityMap.get(slot.id) - 1);
    const teamIds = slotAssignmentsMap.get(slot.id);
    teamIds.push(team.id);

    const assignment = { teamId: team.id, slotId: slot.id, source };
    assignments.push(assignment);
    assignmentByTeamId.set(team.id, { assignment, slot });
    assignmentSources.set(team.id, source);
    assignedTeamIds.add(team.id);
    incrementDivisionLoad(slot, team.division);

    for (const coachId of team.coachIds) {
      const existing = coachAssignments.get(coachId) ?? [];
      existing.push({ teamId: team.id, slotId: slot.id, start: slot.start, end: slot.end });
      coachAssignments.set(coachId, existing);
    }
  };

  const removeAssignmentForTeam = (team) => {
    const record = assignmentByTeamId.get(team.id);
    if (!record) {
      return;
    }

    const { assignment, slot } = record;
    slotCapacityMap.set(slot.id, slotCapacityMap.get(slot.id) + 1);
    const teamIds = slotAssignmentsMap.get(slot.id);
    const updatedTeamIds = teamIds.filter((id) => id !== team.id);
    slotAssignmentsMap.set(slot.id, updatedTeamIds);

    decrementDivisionLoad(slot, team.division);

    const index = assignments.indexOf(assignment);
    if (index >= 0) {
      assignments.splice(index, 1);
    }

    assignmentByTeamId.delete(team.id);
    assignmentSources.delete(team.id);
    assignedTeamIds.delete(team.id);

    for (const coachId of team.coachIds) {
      const existing = coachAssignments.get(coachId) ?? [];
      const filtered = existing.filter(
        (entry) => entry.slotId !== assignment.slotId || entry.teamId !== team.id
      );
      if (filtered.length === 0) {
        coachAssignments.delete(coachId);
      } else {
        coachAssignments.set(coachId, filtered);
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
    const currentCapacity = slotCapacityMap.get(slot.id);
    if (currentCapacity <= 0) {
      throw new Error(
        `locked assignment for team ${team.id} targets slot ${slot.id} with no remaining capacity`
      );
    }

    assignTeamToSlot(team, slot, 'locked');
  }

  const coachTeamCounts = new Map();
  for (const team of sanitizedTeams) {
    for (const coachId of team.coachIds) {
      coachTeamCounts.set(coachId, (coachTeamCounts.get(coachId) ?? 0) + 1);
    }
  }
  for (const team of sanitizedTeams) {
    team.busiestCoachCount = Math.max(
      0,
      ...team.coachIds.map((coachId) => coachTeamCounts.get(coachId) ?? 0)
    );
  }

  const teamsByPriority = [...sanitizedTeams].sort((a, b) => {
    const aCoachCount = a.busiestCoachCount;
    const bCoachCount = b.busiestCoachCount;
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
      slotCapacityMap,
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
    slotCapacityMap,
    slotAssignmentsMap,
  });

  unassigned.length = 0;
  unassigned.push(...unresolved);

  assignments.sort((a, b) => a.teamId.localeCompare(b.teamId) || a.slotId.localeCompare(b.slotId));

  const divisionLoadSummary = {
    byBaseSlot: Array.from(divisionLoadByBaseSlot.entries())
      .map(([key, count]) => {
        const separatorIndex = key.lastIndexOf('::');
        const baseSlotId = key.substring(0, separatorIndex);
        const division = key.substring(separatorIndex + 2);
        return { baseSlotId, division, count };
      })
      .sort(
        (a, b) => a.baseSlotId.localeCompare(b.baseSlotId) || a.division.localeCompare(b.division)
      ),
    byDay: Array.from(divisionLoadByDay.entries())
      .map(([key, count]) => {
        const separatorIndex = key.lastIndexOf('::');
        const day = key.substring(0, separatorIndex);
        const division = key.substring(separatorIndex + 2);
        return { day, division, count };
      })
      .sort((a, b) => a.day.localeCompare(b.day) || a.division.localeCompare(b.division)),
  };

  return { assignments, unassigned, divisionLoadSummary };
}

/**
 * Determine viable slots for a given team, applying hard constraints and generating preference
 * scores used by the scheduler to choose the optimal assignment.
 *
 * @param {Object} params
 * @param {{ id: string, division: string, coachId: string | null, coachIds: string[] }} params.team
 *   - The team being evaluated. `coachIds` carries every coach (head plus assistants).
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
 * @param {ScoringWeights} params.weights - Scoring weights for evaluation.
 * @param {Map<string, number>} params.slotCapacityMap - Remaining capacity per slot.
 * @returns {{ slotScores: Array<{ slotId: string, score: number }>, viableSlots: Array<{ slot: Object, score: number, isFull: boolean }>, blockedSlots: Array<{ slotId: string, reason: string }> }}
 */
function evaluateSlotsForTeam(
  {
    team,
    slotsById,
    coachPreferences,
    divisionPreferences,
    coachAssignments,
    divisionLoadByBaseSlot,
    divisionLoadByDay,
    weights,
    slotCapacityMap,
  },
  options = {}
) {
  const { includeFullSlots = false, excludeSlotIds } = options;
  const excludedSlots = excludeSlotIds ? new Set(excludeSlotIds) : null;
  const slotScores = [];
  const viableSlots = [];
  const blockedSlots = [];
  const divisionPref = divisionPreferences[team.division] ?? {};
  // 8.2: every coach's preferences count, not just the one the legacy shape calls the head.
  // Unavailability was already unioned over the whole team; preferred days and slots were
  // read from `team.coachId` alone, which gave coach slot 1 a say the others did not have —
  // the coach *order* is a clash-breaker, never a rank of whose preferences matter.
  const preferredCoachDays = new Set(
    team.coachIds.flatMap((coachId) => coachPreferences[coachId]?.preferredDays ?? [])
  );
  const preferredCoachSlots = new Set(
    team.coachIds.flatMap((coachId) => coachPreferences[coachId]?.preferredSlotIds ?? [])
  );
  const unavailableCoachSlots = new Set(
    team.coachIds.flatMap((coachId) => coachPreferences[coachId]?.unavailableSlotIds ?? [])
  );
  const preferredDivisionDays = new Set(divisionPref.preferredDays ?? []);
  const coachExistingAssignments = team.coachIds.flatMap(
    (coachId) => coachAssignments.get(coachId) ?? []
  );

  for (const slot of slotsById.values()) {
    let rejectionReason = null;
    if (excludedSlots && excludedSlots.has(slot.id)) {
      rejectionReason = 'excluded-slot';
    }

    const currentCapacity = slotCapacityMap.get(slot.id);
    const isFull = currentCapacity <= 0;
    const overlapsCoachSchedule =
      coachExistingAssignments.length > 0 &&
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
    const sameDivisionDayCount = divisionDayKey ? (divisionLoadByDay.get(divisionDayKey) ?? 0) : 0;
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

  const coachBlocked =
    (reasonCounts['coach-conflict'] ?? 0) + (reasonCounts['coach-unavailable'] ?? 0);
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
  assignmentByTeamId: _assignmentByTeamId,
  assignmentSources,
  divisionLoadByBaseSlot,
  divisionLoadByDay,
  weights,
  slotCapacityMap,
  slotAssignmentsMap,
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
      slotCapacityMap,
      slotAssignmentsMap,
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
  slotCapacityMap,
  slotAssignmentsMap,
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
      slotCapacityMap,
    },
    { includeFullSlots: true }
  );

  const rankedCandidates = rankSlotCandidates(viableSlots);

  for (const candidate of rankedCandidates) {
    const targetSlot = candidate.slot;

    if (!candidate.isFull) {
      assignTeamToSlot(team, targetSlot, 'auto');
      return true;
    }

    const targetSlotTeamIds = slotAssignmentsMap.get(targetSlot.id) || [];
    for (const occupantTeamId of [...targetSlotTeamIds]) {
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
        slotCapacityMap,
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
  slotCapacityMap,
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
      slotCapacityMap,
    },
    { excludeSlotIds }
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
