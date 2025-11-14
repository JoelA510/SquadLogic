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
 * @returns {{ assignments: Array<{ teamId: string, slotId: string }>, unassigned: Array<{ teamId: string, reason: string, candidates: Array<{ slotId: string, score: number }> }> }}
 */

const PREFERRED_COACH_SLOT_SCORE = 10;
const PREFERRED_COACH_DAY_SCORE = 5;
const PREFERRED_DIVISION_DAY_SCORE = 3;

export function schedulePractices({
  teams,
  slots,
  coachPreferences = {},
  divisionPreferences = {},
}) {
  if (!Array.isArray(teams)) {
    throw new TypeError('teams must be an array');
  }
  if (!Array.isArray(slots)) {
    throw new TypeError('slots must be an array');
  }

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
    const { slotScores, viableSlots } = evaluateSlotsForTeam({
      team,
      slotsById,
      coachPreferences,
      divisionPreferences,
      coachAssignments,
    });

    if (viableSlots.length === 0) {
      unassigned.push({
        teamId: team.id,
        reason: 'no available slots meeting hard constraints',
        candidates: slotScores,
      });
      continue;
    }

    const bestSlot = viableSlots.reduce((chosen, candidate) => {
      if (!chosen) {
        return candidate;
      }
      if (candidate.score !== chosen.score) {
        return candidate.score > chosen.score ? candidate : chosen;
      }
      if (candidate.slot.start.getTime() !== chosen.slot.start.getTime()) {
        return candidate.slot.start < chosen.slot.start ? candidate : chosen;
      }
      return candidate.slot.id.localeCompare(chosen.slot.id) < 0 ? candidate : chosen;
    }, null);

    const slotRecord = slotsById.get(bestSlot.slot.id);
    slotRecord.assignedTeams.push(team.id);
    slotRecord.capacity -= 1;
    assignments.push({ teamId: team.id, slotId: slotRecord.id });

    if (team.coachId) {
      const existing = coachAssignments.get(team.coachId) ?? [];
      existing.push({ slotId: slotRecord.id, start: slotRecord.start, end: slotRecord.end });
      coachAssignments.set(team.coachId, existing);
    }
  }

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
 * @returns {{ slotScores: Array<{ slotId: string, score: number }>, viableSlots: Array<{ slot: Object, score: number }> }}
 */
function evaluateSlotsForTeam({
  team,
  slotsById,
  coachPreferences,
  divisionPreferences,
  coachAssignments,
}) {
  const slotScores = [];
  const viableSlots = [];
  const coachPref = coachPreferences[team.coachId] ?? {};
  const divisionPref = divisionPreferences[team.division] ?? {};
  const preferredCoachDays = new Set(coachPref.preferredDays ?? []);
  const preferredCoachSlots = new Set(coachPref.preferredSlotIds ?? []);
  const unavailableCoachSlots = new Set(coachPref.unavailableSlotIds ?? []);
  const preferredDivisionDays = new Set(divisionPref.preferredDays ?? []);
  const coachExistingAssignments = coachAssignments.get(team.coachId) ?? [];

  for (const slot of slotsById.values()) {
    const isUnavailable =
      slot.capacity <= 0 ||
      unavailableCoachSlots.has(slot.id) ||
      (team.coachId &&
        overlapsExistingAssignments({
          assignments: coachExistingAssignments,
          start: slot.start,
          end: slot.end,
        }));

    if (isUnavailable) {
      slotScores.push({ slotId: slot.id, score: -Infinity });
      continue;
    }

    let score = 0;
    if (preferredCoachSlots.has(slot.id)) {
      score += PREFERRED_COACH_SLOT_SCORE;
    }
    if (slot.day && preferredCoachDays.has(slot.day)) {
      score += PREFERRED_COACH_DAY_SCORE;
    }
    if (slot.day && preferredDivisionDays.has(slot.day)) {
      score += PREFERRED_DIVISION_DAY_SCORE;
    }

    slotScores.push({ slotId: slot.id, score });
    viableSlots.push({ slot, score });
  }

  return { slotScores, viableSlots };
}

function overlapsExistingAssignments({ assignments, start, end }) {
  for (const existing of assignments) {
    if (start < existing.end && end > existing.start) {
      return true;
    }
  }
  return false;
}
