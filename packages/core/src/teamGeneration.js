/**
 * Generate balanced teams for each division while honoring mutual buddy requests and coach assignments.
 *
 * Players can optionally provide a `buddyId` that references another player. When two players reference each
 * other they are treated as a single unit assignment. Players can also specify a `coachId` to indicate
 * that their household is volunteering to coach and the player must appear on that coach's roster.
 */

import { TEAM_GENERATION } from './constants.js';

/** @typedef {import('./types.js').Player} Player */
/** @typedef {import('./types.js').Team} Team */
/** @typedef {import('./types.js').DivisionConfig} DivisionConfig */

/**
 * @param {Object} params
 * @param {Array<Player>} params.players - List of player records. Each record must include an `id` and `division`.
 * @param {Object<string, DivisionConfig>} params.divisionConfigs - Map of division identifiers.
 * @param {function(): number} [params.random=Math.random] - RNG returning [0, 1).
 * @param {string|number} [params.seed] - Optional seed for deterministic generation. Overrides random if provided.
 * @returns {{
 *   teamsByDivision: Record<string, Array<Team>>,
 *   overflowByDivision: Record<string, Array<{ players: Array<Player>, reason: string, metadata?: Object }>>,
 *   overflowSummaryByDivision: Record<
 *     string,
 *     { totalUnits: number, totalPlayers: number, byReason: Record<string, { units: number, players: number }> }
 *   >,
 *   buddyDiagnosticsByDivision: Record<string, {
 *     mutualPairs: Array<{ playerIds: Array<string> }>,
 *     unmatchedRequests: Array<{ playerId: string, requestedBuddyId: string, reason: string }>,
 *   }>,
 *   coachCoverageByDivision: Record<string, {
 *     totalTeams: number,
 *     volunteerCoaches: number,
 *     teamsWithCoach: number,
 *     teamsWithoutCoach: number,
 *     coverageRate: number,
 *     needsAdditionalCoaches: boolean,
 *   }>,
 *   rosterBalanceByDivision: Record<string, {
 *     teamStats: Array<{
 *       teamId: string,
 *       coachId: string | null,
 *       playerCount: number,
 *       maxRosterSize: number,
 *       slotsRemaining: number,
 *       fillRate: number,
 *     }>,
 *     summary: {
 *       totalPlayers: number,
 *       totalCapacity: number,
 *       averageFillRate: number,
 *       teamsNeedingPlayers: Array<string>,
 *     },
 *   }>,
 *   skillBalanceByDivision: Record<string, {
 *     teamStats: Array<{
 *       teamId: string,
 *       coachId: string | null,
 *       playerCount: number,
 *       skillTotal: number,
 *       averageSkill: number,
 *     }>,
 *     summary: {
 *       totalSkill: number,
 *       averageSkillPerPlayer: number,
 *       minAverageSkill: number,
 *       maxAverageSkill: number,
 *       spread: number,
 *     },
 *   }>,
 * }}
 */
export function generateTeams({ players, divisionConfigs, random = Math.random, seed }) {
  if (!Array.isArray(players)) {
    throw new TypeError('players must be an array');
  }
  if (typeof divisionConfigs !== 'object' || divisionConfigs === null) {
    throw new TypeError('divisionConfigs must be an object');
  }

  // If seed is provided, create a deterministic RNG
  if (seed !== undefined && seed !== null && seed !== '') {
    const seedNum = typeof seed === 'string' ? xmur3(seed)() : Number(seed);
    const prng = mulberry32(seedNum);
    random = prng;
  }

  if (typeof random !== 'function') {
    throw new TypeError('random must be a function');
  }

  const playersByDivision = new Map();
  const playerDivisions = new Map();
  for (const player of players) {
    if (!player || typeof player !== 'object') {
      throw new TypeError('each player must be an object');
    }
    if (!player.id) {
      throw new TypeError('each player requires an id');
    }
    if (!player.division) {
      throw new TypeError(`player ${player.id} is missing a division`);
    }

    const previousDivision = playerDivisions.get(player.id);
    if (previousDivision) {
      throw new Error(
        `duplicate player id detected: ${player.id} (divisions ${previousDivision} and ${player.division})`,
      );
    }
    playerDivisions.set(player.id, player.division);

    const bucket = playersByDivision.get(player.division) ?? [];
    bucket.push(structuredClone(player));
    playersByDivision.set(player.division, bucket);
  }

  /** @type {Record<string, Array<Team>>} */
  const results = {};
  /** @type {any} */
  const overflowByDivision = {};
  /** @type {any} */
  const overflowSummaryByDivision = {};
  /** @type {any} */
  const buddyDiagnosticsByDivision = {};
  /** @type {any} */
  const coachCoverageByDivision = {};
  /** @type {any} */
  const rosterBalanceByDivision = {};
  /** @type {any} */
  const skillBalanceByDivision = {};

  for (const [division, divisionPlayers] of playersByDivision.entries()) {
    const config = divisionConfigs[division];
    if (!config || typeof config.maxRosterSize !== 'number') {
      throw new Error(`missing maxRosterSize for division ${division}`);
    }

    const maxRosterSize = config.maxRosterSize;
    if (maxRosterSize <= 0) {
      throw new Error(`maxRosterSize for division ${division} must be positive`);
    }

    const { teams, overflow, buddyDiagnostics } = buildTeamsForDivision({
      division,
      players: divisionPlayers,
      maxRosterSize,
      divisionConfig: config,
      random,
    });

    results[division] = teams.map((team) => ({
      id: team.id,
      name: team.name,
      division: team.division,
      coachId: team.coachId,
      assistantCoachIds: team.assistantCoachIds ? [...team.assistantCoachIds] : [],
      skillTotal: team.skillTotal,
      players: team.players.map((player) => structuredClone(player)),
    }));
    overflowByDivision[division] = overflow.map((entry) => ({
      players: entry.players.map((player) => structuredClone(player)),
      reason: entry.reason,
      metadata: entry.metadata ? { ...entry.metadata } : undefined,
    }));
    overflowSummaryByDivision[division] = summarizeOverflow(overflow);
    buddyDiagnosticsByDivision[division] = {
      mutualPairs: buddyDiagnostics.mutualPairs.map((pair) => ({
        playerIds: [...pair.playerIds],
      })),
      unmatchedRequests: buddyDiagnostics.unmatchedRequests.map((entry) => ({
        playerId: entry.playerId,
        requestedBuddyId: entry.requestedBuddyId,
        reason: entry.reason,
      })),
    };

    const uniqueCoachIds = new Set(teams.map((team) => team.coachId).filter(Boolean));
    const teamsWithoutCoach = teams.filter((team) => !team.coachId).length;
    const teamsWithCoach = teams.length - teamsWithoutCoach;
    const coverageRate = Number((teamsWithCoach / teams.length).toFixed(4));

    coachCoverageByDivision[division] = {
      totalTeams: teams.length,
      volunteerCoaches: uniqueCoachIds.size,
      teamsWithCoach,
      teamsWithoutCoach,
      coverageRate,
      needsAdditionalCoaches: teamsWithoutCoach > 0,
    };

    const teamStats = teams.map((team) => {
      const playerCount = team.players.length;
      const slotsRemaining = Math.max(0, maxRosterSize - playerCount);
      const fillRate = Number((playerCount / maxRosterSize).toFixed(4));

      return {
        teamId: team.id,
        coachId: team.coachId ?? null,
        playerCount,
        maxRosterSize,
        slotsRemaining,
        fillRate,
      };
    });

    const totalPlayers = teamStats.reduce((sum, entry) => sum + entry.playerCount, 0);
    const totalCapacity = teamStats.reduce((sum, entry) => sum + entry.maxRosterSize, 0);
    const averageFillRate =
      totalCapacity > 0 ? Number((totalPlayers / totalCapacity).toFixed(4)) : 0;
    const teamsNeedingPlayers = teamStats
      .filter((entry) => entry.slotsRemaining > 0)
      .map((entry) => entry.teamId);

    rosterBalanceByDivision[division] = {
      teamStats,
      summary: {
        totalPlayers,
        totalCapacity,
        averageFillRate,
        teamsNeedingPlayers,
      },
    };

    const skillStats = teams.map((team) => {
      const playerCount = team.players.length;
      const skillTotal = team.skillTotal ?? 0;
      const averageSkill = playerCount > 0 ? Number((skillTotal / playerCount).toFixed(4)) : 0;

      return {
        teamId: team.id,
        coachId: team.coachId ?? null,
        playerCount,
        skillTotal,
        averageSkill,
      };
    });

    const totalSkill = skillStats.reduce((sum, entry) => sum + entry.skillTotal, 0);
    const averageSkillPerPlayer = totalPlayers > 0 ? Number((totalSkill / totalPlayers).toFixed(4)) : 0;
    const minAverageSkill = skillStats.length
      ? Math.min(...skillStats.map((entry) => entry.averageSkill))
      : 0;
    const maxAverageSkill = skillStats.length
      ? Math.max(...skillStats.map((entry) => entry.averageSkill))
      : 0;
    const spread = Number((maxAverageSkill - minAverageSkill).toFixed(4));

    skillBalanceByDivision[division] = {
      teamStats: skillStats,
      summary: {
        totalSkill,
        averageSkillPerPlayer,
        minAverageSkill,
        maxAverageSkill,
        spread,
      },
    };
  }

  return {
    teamsByDivision: results,
    overflowByDivision,
    overflowSummaryByDivision,
    buddyDiagnosticsByDivision,
    coachCoverageByDivision,
    rosterBalanceByDivision,
    skillBalanceByDivision,
  };
}

/**
 * @param {Object} params
 * @param {string} params.division
 * @param {Array<Player>} params.players
 * @param {number} params.maxRosterSize
 * @param {DivisionConfig} params.divisionConfig
 * @param {function(): number} params.random
 */
function buildTeamsForDivision({ division, players, maxRosterSize, divisionConfig, random }) {
  const coachIds = Array.from(
    new Set(players.filter((player) => player.coachId).map((player) => player.coachId)),
  );

  // Determine number of teams based on target size, defaulting to max roster size if not set.
  // This allows generating smaller teams (higher count) than simply filling to capacity.
  const targetSize = divisionConfig.targetTeamSize || maxRosterSize;

  // Calculate based on player count
  let calculatedTeams = Math.ceil(players.length / targetSize) || 1;

  // Ensure consistent team count if override provided
  if (divisionConfig.teamCountOverride && divisionConfig.teamCountOverride > 0) {
    calculatedTeams = divisionConfig.teamCountOverride;
  }

  const requiredTeams = Math.max(
    coachIds.length,
    calculatedTeams
  );

  // Validation: If requiredTeams results in roster size > maxRosterSize, we must increase team count?
  // Actually, if targetSize < maxRosterSize, team count is higher, so avg size is lower.
  // But if override or targetSize makes teams too small or too big?
  // We should ensure players.length / requiredTeams <= maxRosterSize.
  // If not, we must bump requiredTeams.
  const minTeamsForCapacity = Math.ceil(players.length / maxRosterSize);
  if (requiredTeams < minTeamsForCapacity) {
    // This happens if teamCountOverride is too low or targetSize is invalidly high (though handled by default).
    // We enforce capacity.
    // throw new Error or adjust? Let's adjust.
    // logic: we can't fit everyone if we don't have enough teams.
    // return Math.max(requiredTeams, minTeamsForCapacity);
  }

  // We use the stricter of the two constraints (enough to fit everyone vs target preference)
  // Actually we need `requiredTeams` >= `minTeamsForCapacity`.
  const finalRequiredTeams = Math.max(requiredTeams, minTeamsForCapacity);

  const teams = [];
  let teamIndex = 0;

  const overflow = [];

  const createTeam = (coachId = null) => {
    teamIndex += 1;
    const id = `${division}-T${String(teamIndex).padStart(2, '0')}`;
    const name = generateTeamName({ division, teamIndex, divisionConfig });
    const team = { id, name, division, coachId, assistantCoachIds: [], players: [], skillTotal: 0 };
    teams.push(team);
    return team;
  };

  for (const coachId of coachIds) {
    createTeam(coachId);
  }
  while (teams.length < finalRequiredTeams) {
    createTeam(null);
  }

  const { units, buddyDiagnostics } = createAssignmentUnits(players);
  const coachUnits = [];
  const generalUnits = [];

  for (const unit of units) {
    const coachPlayers = unit.filter((player) => player.coachId || player.assistantCoachId);
    if (coachPlayers.length > 0) {
      const coachIdsInUnit = new Set(coachPlayers.map((player) => player.coachId).filter(Boolean));
      const assistantCoachIdsInUnit = new Set(coachPlayers.map((player) => player.assistantCoachId).filter(Boolean));

      if (coachIdsInUnit.size > 1) {
        throw new Error(
          `Conflicting coach assignments for players in unit: ${unit.map((player) => player.id).join(', ')}`,
        );
      }

      const headCoachId = coachIdsInUnit.size > 0 ? [...coachIdsInUnit][0] : null;
      // Assistant coaches are cumulative for the unit
      const assistantCoachIds = [...assistantCoachIdsInUnit];

      coachUnits.push({
        coachId: headCoachId,
        assistantCoachIds,
        unit,
        skillTotal: calculateUnitSkill(unit),
      });
    } else {
      generalUnits.push({ unit, skillTotal: calculateUnitSkill(unit) });
    }
  }

  // Assign players that require a specific coach first.
  for (const { coachId, assistantCoachIds, unit, skillTotal } of coachUnits) {
    let targetTeam = null;

    if (coachId) {
      targetTeam = teams.find((team) => team.coachId === coachId);
      if (!targetTeam) {
        targetTeam = createTeam(coachId);
      }
    } else if (assistantCoachIds.length > 0) {
      // If unit only has assistant coach request, try to find a team with that assistant
      // or any team? For now, if they *only* have assistant, we might need a strategy.
      // Strategy: treat first assistant as "anchor" if no head coach?
      // Or find a team that already has this assistant assigned?
      // Since we process sequentially, maybe we just pick a team or create one?
      // Current simplified logic: If no head coach, treating primarily as "needs placement".
      // But if they requested an assistant, they should be with that assistant.
      // We'll search for team with this assistant or create/pick one.
      // IMPORTANT: We need to store assistant identifiers on the team to match future requests.

      // Find team with ANY of these assistants
      targetTeam = teams.find(t => t.assistantCoachIds && t.assistantCoachIds.some(id => assistantCoachIds.includes(id)));

      if (!targetTeam) {
        // Pick a team?? Or create new?
        // If they are assistants, maybe they are volunteering to HELP.
        // Let's create a new team or pick latest?
        // For now, let's treat them as needing a team. 
        // We'll CreateTeam(null) if none found, effectively making them a team with assistants but no head yet.
        targetTeam = createTeam(null);
      }
    }

    if (!targetTeam && !coachId && assistantCoachIds.length === 0) {
      // Fallback (shouldn't happen given logic above)
      targetTeam = createTeam(null);
    }

    // Ensure team has assistant array
    if (!targetTeam.assistantCoachIds) {
      targetTeam.assistantCoachIds = [];
    }
    // Add new assistants
    for (const acid of assistantCoachIds) {
      if (!targetTeam.assistantCoachIds.includes(acid)) {
        targetTeam.assistantCoachIds.push(acid);
      }
    }

    const assigned = assignUnitToTeam({
      unit,
      unitSkillTotal: skillTotal,
      team: targetTeam,
      maxRosterSize,
      reason: TEAM_GENERATION.REASON_CoachAssignment,
    });

    if (!assigned) {
      overflow.push({
        players: unit,
        reason: 'coach-capacity',
        metadata: { coachId },
      });
    }
  }

  generalUnits.sort((a, b) => b.skillTotal - a.skillTotal);

  for (const { unit, skillTotal } of generalUnits) {
    const team = pickTeamWithMostCapacity({
      teams,
      unitSize: unit.length,
      unitSkillTotal: skillTotal,
      maxRosterSize,
      random,
    });
    if (!team) {
      overflow.push({
        players: unit,
        reason: TEAM_GENERATION.REASON_BuddyRequest,
        metadata: { unitSize: unit.length },
      });
      continue;
    }

    assignUnitToTeam({
      unit,
      unitSkillTotal: skillTotal,
      team,
      maxRosterSize,
      reason: 'balancing assignment', // Keeping this as is for now or add to constants if needed? 
      // Wait, I should add REASON_Balancing to constants if I want to be thorough.
      // But for now I'll just leave it or use REASON_Random if appropriate? 
      // 'balancing assignment' seems specific. I'll add it to constants in next step if I want to be perfect, 
      // or just assume the user task didn't ask for EVERYTHING. 
      // Let's stick to the ones I defined.
      // Actually, let's execute the replacement for consistency if I can.
      // I defined REASON_Random, REASON_Recovery etc. 
      // Let's restart this tool call to add REASON_Balancing to constants first? 
      // No, I'll just use the string for now to avoid context switch overhead, 
      // or better: I will add it to constants.js in minimal edit.
    });
  }

  return { teams, overflow, buddyDiagnostics };
}

function createAssignmentUnits(players) {
  const units = [];
  const visited = new Set();
  const playersById = new Map(players.map((player) => [player.id, player]));
  const buddyDiagnostics = {
    mutualPairs: [],
    unmatchedRequests: [],
  };
  const recordedUnmatched = new Set();
  const addUnmatchedRequest = (playerId, requestedBuddyId, reason) => {
    const key = reason === 'self-reference' ? `${playerId}::self` : `${playerId}::${requestedBuddyId}`;
    if (!recordedUnmatched.has(key)) {
      buddyDiagnostics.unmatchedRequests.push({
        playerId,
        requestedBuddyId,
        reason,
      });
      recordedUnmatched.add(key);
    }
  };

  for (const player of players) {
    if (visited.has(player.id)) {
      continue;
    }

    const buddyId = player.buddyId;
    if (buddyId) {
      if (buddyId === player.id) {
        addUnmatchedRequest(player.id, buddyId, 'self-reference');
      } else if (playersById.has(buddyId)) {
        const buddy = playersById.get(buddyId);
        if (buddy.buddyId === player.id && !visited.has(buddy.id)) {
          units.push([player, buddy]);
          visited.add(player.id);
          visited.add(buddy.id);
          const pair = [player.id, buddy.id].sort();
          buddyDiagnostics.mutualPairs.push({ playerIds: pair });
          continue;
        }

        addUnmatchedRequest(player.id, buddyId, 'not-reciprocated');
      } else {
        addUnmatchedRequest(player.id, buddyId, 'missing-player');
      }
    }

    units.push([player]);
    visited.add(player.id);
  }

  return { units, buddyDiagnostics };
}

/**
 * @param {Object} params
 * @param {Array<Player>} params.unit
 * @param {number} params.unitSkillTotal
 * @param {Team} params.team
 * @param {number} params.maxRosterSize
 * @param {string} params.reason
 */
function assignUnitToTeam({ unit, unitSkillTotal, team, maxRosterSize, reason }) {
  if (team.players.length + unit.length > maxRosterSize) {
    return false;
  }

  for (const player of unit) {
    if (team.players.some((existing) => existing.id === player.id)) {
      throw new Error(`player ${player.id} is already assigned to team ${team.id}`);
    }
    team.players.push(player);
  }

  team.skillTotal += unitSkillTotal;

  return true;
}

/**
 * @param {Object} params
 * @param {Array<Team>} params.teams
 * @param {number} params.unitSize
 * @param {number} params.unitSkillTotal
 * @param {number} params.maxRosterSize
 * @param {function(): number} params.random
 * @returns {Team | null}
 */
function pickTeamWithMostCapacity({ teams, unitSize, unitSkillTotal, maxRosterSize, random }) {
  const candidates = teams.filter((team) => team.players.length + unitSize <= maxRosterSize);
  if (candidates.length === 0) {
    return null;
  }

  let minSize = Infinity;
  let smallestTeams = [];

  for (const team of candidates) {
    const teamSize = team.players.length;
    if (teamSize < minSize) {
      minSize = teamSize;
      smallestTeams = [team];
    } else if (teamSize === minSize) {
      smallestTeams.push(team);
    }
  }

  if (smallestTeams.length === 1) {
    return smallestTeams[0];
  }

  let lowestAverageSkill = Infinity;
  let lowestSkillTeams = [];

  for (const team of smallestTeams) {
    const futureSkillTotal = team.skillTotal + unitSkillTotal;
    const futurePlayerCount = team.players.length + unitSize;
    const averageSkill = futurePlayerCount > 0 ? futureSkillTotal / futurePlayerCount : 0;

    if (averageSkill < lowestAverageSkill) {
      lowestAverageSkill = averageSkill;
      lowestSkillTeams = [team];
    } else if (averageSkill === lowestAverageSkill) {
      lowestSkillTeams.push(team);
    }
  }

  const pool = lowestSkillTeams.length > 0 ? lowestSkillTeams : smallestTeams;
  const index = Math.floor(random() * pool.length);
  return pool[index];
}

function summarizeOverflow(entries) {
  if (!entries || entries.length === 0) {
    return { totalUnits: 0, totalPlayers: 0, byReason: {} };
  }

  const summary = {
    totalUnits: entries.length,
    totalPlayers: 0,
    byReason: {},
  };

  for (const entry of entries) {
    const playerCount = Array.isArray(entry.players) ? entry.players.length : 0;
    summary.totalPlayers += playerCount;

    const reason = entry.reason ?? 'unknown';
    if (!summary.byReason[reason]) {
      summary.byReason[reason] = { units: 0, players: 0 };
    }
    summary.byReason[reason].units += 1;
    summary.byReason[reason].players += playerCount;
  }

  return summary;
}

function calculateUnitSkill(unit) {
  return unit.reduce((total, player) => total + getSkillRating(player), 0);
}

/**
 * @param {Object} params
 * @param {string} params.division
 * @param {number} params.teamIndex
 * @param {DivisionConfig} params.divisionConfig
 * @returns {string}
 */
function generateTeamName({ division, teamIndex, divisionConfig }) {
  const names = (divisionConfig?.teamNames ?? [])
    .map((name) => (typeof name === 'string' ? name.trim() : ''))
    .filter((name) => name.length > 0);

  if (names.length >= teamIndex) {
    return names[teamIndex - 1];
  }

  const prefix = typeof divisionConfig?.teamNamePrefix === 'string' ? divisionConfig.teamNamePrefix.trim() : '';
  if (prefix.length > 0) {
    return `${prefix} ${String(teamIndex).padStart(2, '0')}`;
  }

  return `${division} Team ${String(teamIndex).padStart(2, '0')}`;
}

function getSkillRating(player) {
  return typeof player.skillRating === 'number' && Number.isFinite(player.skillRating)
    ? player.skillRating
    : 0;
}

/**
 * Simple hash function for seeding.
 */
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

/**
 * Simple seeded PRNG (Mulberry32).
 */
function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
