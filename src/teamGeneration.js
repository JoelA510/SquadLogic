/**
 * Generate balanced teams for each division while honoring mutual buddy requests and coach assignments.
 *
 * Players can optionally provide a `buddyId` that references another player. When two players reference each
 * other they are treated as a single unit during assignment. Players can also specify a `coachId` to indicate
 * that their household is volunteering to coach and the player must appear on that coach's roster.
 *
 * @param {Object} params
 * @param {Array<Object>} params.players - List of player records. Each record must include an `id` and `division`.
 * @param {Object<string, { maxRosterSize: number }>} params.divisionConfigs - Map of division identifiers to
 * configuration such as `maxRosterSize`.
 * @param {Function} [params.random=Math.random] - Optional random number generator used to break ties when picking
 * between teams with the same roster size. It must return a floating point number in the range [0, 1).
 * @returns {Object<string, Array<{ id: string, coachId: string | null, players: Array<Object> }>>}
 */
export function generateTeams({ players, divisionConfigs, random = Math.random }) {
  if (!Array.isArray(players)) {
    throw new TypeError('players must be an array');
  }
  if (typeof divisionConfigs !== 'object' || divisionConfigs === null) {
    throw new TypeError('divisionConfigs must be an object');
  }
  if (typeof random !== 'function') {
    throw new TypeError('random must be a function');
  }

  const playersByDivision = new Map();
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

    const bucket = playersByDivision.get(player.division) ?? [];
    bucket.push(structuredClone(player));
    playersByDivision.set(player.division, bucket);
  }

  const results = {};

  for (const [division, divisionPlayers] of playersByDivision.entries()) {
    const config = divisionConfigs[division];
    if (!config || typeof config.maxRosterSize !== 'number') {
      throw new Error(`missing maxRosterSize for division ${division}`);
    }

    const maxRosterSize = config.maxRosterSize;
    if (maxRosterSize <= 0) {
      throw new Error(`maxRosterSize for division ${division} must be positive`);
    }

    const teams = buildTeamsForDivision({
      division,
      players: divisionPlayers,
      maxRosterSize,
      random,
    });

    results[division] = teams.map((team) => ({
      id: team.id,
      coachId: team.coachId,
      players: team.players.map((player) => structuredClone(player)),
    }));
  }

  return results;
}

function buildTeamsForDivision({ division, players, maxRosterSize, random }) {
  const coachIds = Array.from(
    new Set(players.filter((player) => player.coachId).map((player) => player.coachId)),
  );

  const requiredTeams = Math.max(
    coachIds.length || 0,
    Math.ceil(players.length / maxRosterSize) || 1,
  );

  const teams = [];
  let teamIndex = 0;

  const createTeam = (coachId = null) => {
    teamIndex += 1;
    const id = `${division}-T${String(teamIndex).padStart(2, '0')}`;
    const team = { id, division, coachId, players: [] };
    teams.push(team);
    return team;
  };

  for (const coachId of coachIds) {
    createTeam(coachId);
  }
  while (teams.length < requiredTeams) {
    createTeam(null);
  }

  const units = createAssignmentUnits(players);
  const coachUnits = [];
  const generalUnits = [];

  for (const unit of units) {
    const coachPlayer = unit.find((player) => player.coachId);
    if (coachPlayer) {
      coachUnits.push({ coachId: coachPlayer.coachId, unit });
    } else {
      generalUnits.push(unit);
    }
  }

  // Assign players that require a specific coach first.
  for (const { coachId, unit } of coachUnits) {
    let targetTeam = teams.find((team) => team.coachId === coachId);
    if (!targetTeam) {
      targetTeam = createTeam(coachId);
    }
    assignUnitToTeam({ unit, team: targetTeam, maxRosterSize, reason: 'coach assignment' });
  }

  shuffleUnits(generalUnits, random);

  for (const unit of generalUnits) {
    const team = pickTeamWithMostCapacity({ teams, unitSize: unit.length, maxRosterSize, random });
    assignUnitToTeam({ unit, team, maxRosterSize, reason: 'balancing assignment' });
  }

  return teams;
}

function createAssignmentUnits(players) {
  const units = [];
  const visited = new Set();
  const playersById = new Map(players.map((player) => [player.id, player]));

  for (const player of players) {
    if (visited.has(player.id)) {
      continue;
    }

    const buddyId = player.buddyId;
    if (buddyId && playersById.has(buddyId)) {
      const buddy = playersById.get(buddyId);
      if (buddy.buddyId === player.id && !visited.has(buddy.id)) {
        units.push([player, buddy]);
        visited.add(player.id);
        visited.add(buddy.id);
        continue;
      }
    }

    units.push([player]);
    visited.add(player.id);
  }

  return units;
}

function assignUnitToTeam({ unit, team, maxRosterSize, reason }) {
  if (team.players.length + unit.length > maxRosterSize) {
    throw new Error(
      `Cannot assign unit of size ${unit.length} to team ${team.id}; ${reason} would exceed max roster of ${maxRosterSize}.`,
    );
  }

  for (const player of unit) {
    if (team.players.some((existing) => existing.id === player.id)) {
      throw new Error(`player ${player.id} is already assigned to team ${team.id}`);
    }
    team.players.push(player);
  }
}

function pickTeamWithMostCapacity({ teams, unitSize, maxRosterSize, random }) {
  const candidates = teams.filter((team) => team.players.length + unitSize <= maxRosterSize);
  if (candidates.length === 0) {
    throw new Error('no team has enough capacity for the provided unit');
  }

  let minSize = Infinity;
  for (const candidate of candidates) {
    if (candidate.players.length < minSize) {
      minSize = candidate.players.length;
    }
  }

  const smallestTeams = candidates.filter((team) => team.players.length === minSize);
  const index = Math.floor(random() * smallestTeams.length);
  return smallestTeams[index];
}

function shuffleUnits(units, random) {
  for (let i = units.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [units[i], units[j]] = [units[j], units[i]];
  }
}
