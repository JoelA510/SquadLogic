import { listTeamCoachIds } from './practiceScheduling.js';
import { SlotSchema, TeamSchema } from './schemas/index.js';

/** @typedef {import('./types.js').Team} Team */
/** @typedef {import('./types.js').GameSlot} GameSlot */

const BYE = '__BYE__';

/**
 * The round robins a season's teams play, by division, and the divisions that
 * play none (plan `docs/changes/2026-10-22-demo-mode.md`, D2).
 *
 * A team whose division is practice-only (`divisions.plays_games = false`,
 * carried as `playsGames: false`) gets no fixture, and its division is listed
 * in `practiceOnlyDivisions` rather than left to read as unscheduled: it was
 * never meant to play. Every other division with two or more teams gets a
 * round robin, as the game page always built one; a division of one team gets
 * none (there is no one to play). `playsGames` absent means it plays, the
 * column's default, so a caller that does not read the setting schedules
 * exactly what it did before.
 *
 * `keepSides` (see {@link savedSides}) are the sides a saved schedule already
 * decided: each division's round robin is given the entries whose two teams
 * are both in that division, so a regenerate keeps who hosts whom. An entry
 * for a pair in no division (a team moved or removed since) is not an error
 * here; it just has nothing to keep.
 *
 * @template {{ id: string, division: string, playsGames?: boolean }} T
 * @param {ReadonlyArray<T>} teams
 * @param {{ keepSides?: ReadonlyArray<{ homeTeamId: string, awayTeamId: string }> }} [options]
 * @returns {{
 *   roundRobinByDivision: Record<string, ReturnType<typeof generateRoundRobinWeeks>>,
 *   gameTeams: T[],
 *   practiceOnlyDivisions: Array<{ division: string, teamIds: string[] }>,
 * }}
 */
export function buildDivisionRoundRobins(teams, { keepSides = [] } = {}) {
  if (!Array.isArray(teams)) {
    throw new TypeError('teams must be an array');
  }
  /** @type {Map<string, string[]>} */
  const playing = new Map();
  /** @type {Map<string, string[]>} */
  const practiceOnly = new Map();
  const gameTeams = [];
  for (const team of teams) {
    const bucket = team.playsGames === false ? practiceOnly : playing;
    const ids = bucket.get(team.division) ?? [];
    ids.push(team.id);
    bucket.set(team.division, ids);
    if (team.playsGames !== false) gameTeams.push(team);
  }

  /** @type {Record<string, ReturnType<typeof generateRoundRobinWeeks>>} */
  const roundRobinByDivision = {};
  for (const [division, teamIds] of playing.entries()) {
    if (teamIds.length >= 2) {
      const members = new Set(teamIds);
      roundRobinByDivision[division] = generateRoundRobinWeeks({
        teamIds,
        keepSides: keepSides.filter(
          (entry) => members.has(entry?.homeTeamId) && members.has(entry?.awayTeamId)
        ),
      });
    }
  }
  const practiceOnlyDivisions = [...practiceOnly.entries()]
    .map(([division, teamIds]) => ({ division, teamIds: [...teamIds].sort() }))
    .sort((a, b) => a.division.localeCompare(b.division));
  return { roundRobinByDivision, gameTeams, practiceOnlyDivisions };
}

/**
 * The sides a saved schedule decided, one entry per pair, for `keepSides`.
 *
 * A pair saved twice with opposite sides (reachable only through manual edits)
 * keeps the sides of its earliest week, so the answer does not depend on the
 * order the rows arrive in. Rows that name no home or away team are skipped:
 * they decide nothing.
 *
 * @param {ReadonlyArray<{ homeTeamId?: string | null, awayTeamId?: string | null, weekIndex?: number }>} assignments
 * @returns {Array<{ homeTeamId: string, awayTeamId: string }>}
 */
export function savedSides(assignments) {
  if (!Array.isArray(assignments)) {
    throw new TypeError('assignments must be an array');
  }
  /** @type {Map<string, { homeTeamId: string, awayTeamId: string, weekIndex: number }>} */
  const byPair = new Map();
  for (const row of assignments) {
    const { homeTeamId, awayTeamId } = row ?? {};
    if (typeof homeTeamId !== 'string' || typeof awayTeamId !== 'string') continue;
    if (homeTeamId === awayTeamId) continue;
    const weekIndex = Number.isFinite(row.weekIndex) ? /** @type {number} */ (row.weekIndex) : 0;
    const key = pairKey(homeTeamId, awayTeamId);
    const held = byPair.get(key);
    const earlier =
      !held ||
      weekIndex < held.weekIndex ||
      (weekIndex === held.weekIndex && homeTeamId.localeCompare(held.homeTeamId) < 0);
    if (earlier) byPair.set(key, { homeTeamId, awayTeamId, weekIndex });
  }
  return [...byPair.values()].map(({ homeTeamId, awayTeamId }) => ({ homeTeamId, awayTeamId }));
}

/**
 * Generate a deterministic round-robin schedule for a division.
 *
 * **Who hosts** (plan `docs/changes/2026-10-27-phase-d-scheduling.md`, PR A).
 * The pairings and byes are the circle method's, as they always were: the
 * smallest id is fixed at rotation index 0 and the rest rotate one place a
 * week. Orientation reads the rotation index, not the id: for the pair at
 * indices `i` and `N - 1 - i` (`N` the rotation length, a bye counted), the team at the
 * **odd** index hosts, because the two indices sum to the odd `N - 1` and so
 * exactly one is odd. The pair at index 0 is the exception: with an even
 * number of teams the fixed team hosts in even (0-based) weeks; with an odd
 * number it hosts unless its opponent's own bye falls at an odd index, in which
 * case the opponent does (the host that bye cost it comes back there). Every
 * team then hosts within one game of half its games, and exactly (n - 1) / 2
 * when n is odd; nobody keeps one side for more than two weeks running.
 * (Proved and executed in `tests/gameScheduling.test.js`, n = 2..16.)
 *
 * Matchups within a week stay sorted by the alphabetised pair, whichever side
 * hosts, so `scheduleGames` sees them in the order it always did and places
 * each pair in the same week and slot.
 *
 * @param {Object} params
 * @param {Array<string>} params.teamIds - Unique team identifiers.
 * @param {Array<{ homeTeamId: string, awayTeamId: string }>} [params.keepSides]
 *   - Pairs whose sides are already decided (a saved schedule): each entry's
 *   `homeTeamId` hosts that pair, whatever the rule says. Not named `freeze`:
 *   `scheduleGames` refuses that word on purpose. A malformed entry, a team
 *   that is not in `teamIds`, or two entries for one pair throws a TypeError.
 * @returns {Array<{ weekIndex: number, matchups: Array<{ homeTeamId: string, awayTeamId: string }>, byes: Array<string> }>}
 */
export function generateRoundRobinWeeks({ teamIds, keepSides = [] }) {
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

  const kept = indexKeepSides(keepSides, new Set(uniqueTeams));

  const sortedTeams = [...uniqueTeams].sort((a, b) => a.localeCompare(b));
  let rotation = [...sortedTeams];

  if (rotation.length % 2 === 1) {
    rotation.push(BYE);
  }

  const totalTeams = rotation.length;
  const oddTeamCount = uniqueTeams.length % 2 === 1;
  const weeks = totalTeams - 1;
  const half = totalTeams / 2;

  // First pass: the rotation each week, and (odd n) the index each team sits
  // at when it meets the bye, which decides its fixed-team game.
  const rotations = [];
  /** @type {Map<string, number>} */
  const byeIndex = new Map();
  for (let week = 0; week < weeks; week += 1) {
    rotations.push(rotation);
    for (let i = 0; i < half; i += 1) {
      const low = rotation[i];
      const high = rotation[totalTeams - 1 - i];
      if (low === BYE) byeIndex.set(high, totalTeams - 1 - i);
      if (high === BYE) byeIndex.set(low, i);
    }
    const [first, ...rest] = rotation;
    rest.unshift(/** @type {string} */ (rest.pop()));
    rotation = [first, ...rest];
  }

  const schedule = [];
  for (let week = 0; week < weeks; week += 1) {
    const current = rotations[week];
    const matchups = [];
    const byes = [];

    for (let i = 0; i < half; i += 1) {
      const low = current[i];
      const high = current[totalTeams - 1 - i];

      if (low === BYE || high === BYE) {
        const byeTeam = low === BYE ? high : low;
        if (byeTeam !== BYE) {
          byes.push(byeTeam);
        }
        continue;
      }

      let lowHosts;
      if (i === 0) {
        lowHosts = oddTeamCount ? (byeIndex.get(high) ?? 0) % 2 === 0 : week % 2 === 0;
      } else {
        lowHosts = i % 2 === 1;
      }
      let [homeTeamId, awayTeamId] = lowHosts ? [low, high] : [high, low];

      const keptHome = kept.get(pairKey(low, high));
      if (keptHome !== undefined) {
        homeTeamId = keptHome;
        awayTeamId = keptHome === low ? high : low;
      }
      matchups.push({ homeTeamId, awayTeamId });
    }

    // The alphabetised pair, not the host: placement order is unchanged by
    // who hosts, so no pair moves to another week or slot.
    matchups.sort((a, b) => {
      const [aFirst, aSecond] = [a.homeTeamId, a.awayTeamId].sort((x, y) => x.localeCompare(y));
      const [bFirst, bSecond] = [b.homeTeamId, b.awayTeamId].sort((x, y) => x.localeCompare(y));
      if (aFirst !== bFirst) {
        return aFirst.localeCompare(bFirst);
      }
      return aSecond.localeCompare(bSecond);
    });

    byes.sort((a, b) => a.localeCompare(b));

    schedule.push({
      weekIndex: week + 1,
      matchups,
      byes,
    });
  }

  return schedule;
}

/** One key for a pair, whichever side is named first. */
function pairKey(a, b) {
  return a.localeCompare(b) <= 0 ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/**
 * Validate `keepSides` and index it by pair: pair key -> the hosting team id.
 *
 * @param {unknown} keepSides
 * @param {Set<string>} teamSet
 * @returns {Map<string, string>}
 */
function indexKeepSides(keepSides, teamSet) {
  if (!Array.isArray(keepSides)) {
    throw new TypeError('keepSides must be an array');
  }
  /** @type {Map<string, string>} */
  const kept = new Map();
  for (const entry of keepSides) {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError('keepSides entries must be objects');
    }
    const { homeTeamId, awayTeamId } = /** @type {Record<string, unknown>} */ (entry);
    if (typeof homeTeamId !== 'string' || typeof awayTeamId !== 'string') {
      throw new TypeError('keepSides entries require string homeTeamId and awayTeamId');
    }
    if (homeTeamId === awayTeamId) {
      throw new TypeError(`keepSides entry names team ${homeTeamId} on both sides`);
    }
    for (const id of [homeTeamId, awayTeamId]) {
      if (!teamSet.has(id)) {
        throw new TypeError(`keepSides names team ${id}, which is not in teamIds`);
      }
    }
    const key = pairKey(homeTeamId, awayTeamId);
    if (kept.has(key)) {
      throw new TypeError(`keepSides names the pair ${homeTeamId} / ${awayTeamId} more than once`);
    }
    kept.set(key, homeTeamId);
  }
  return kept;
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
  // re-solve. GAP-32 (week index vs calendar date) and GAP-35 (no persisted
  // freeze scope) are why the bridge does not exist yet.
  if (freeze !== undefined) {
    throw new TypeError(
      'gameScheduling: scheduleGames() cannot honour a freeze and will not pretend to. It is week-indexed, it generates matchups rather than re-placing existing games, and its assignments carry no game id to freeze. Use resolve/applyChangeRequest() to apply a scoped change to an existing schedule, or resolve/reoptimiseWholeSeason() to re-solve one on purpose. See GAP-35 and GAP-32.'
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
