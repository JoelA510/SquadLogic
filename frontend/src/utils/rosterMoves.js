/**
 * Moving a player between teams in the roster editor, as a pure function: one path for a drag
 * and for the keyboard "Move" dialog, so the two cannot disagree about what a move does.
 *
 * Only the two teams a move touches are copied; every other team, and every player on them,
 * keeps its identity, so a memoised row is not redrawn for a move elsewhere (the editor shows
 * every roster of a league at once).
 *
 * @module utils/rosterMoves
 */

/**
 * @param {any[]} teams
 * @param {string|number} playerId
 * @returns {any|undefined} the team holding the player
 */
export function findTeamOfPlayer(teams, playerId) {
  return teams.find((team) => team.players.some((player) => player.id === playerId));
}

/**
 * Move a player to another team and mark the assignment manual. A move to the team the player is
 * already on, to a team that is not there, or of a player that is not on any team returns the
 * same `teams` array.
 *
 * @param {any[]} teams
 * @param {string|number} playerId
 * @param {string|number} destTeamId
 * @param {number} [destIndex] - where in the destination roster; the end by default
 * @returns {any[]}
 */
export function movePlayerToTeam(teams, playerId, destTeamId, destIndex) {
  const source = findTeamOfPlayer(teams, playerId);
  const dest = teams.find((team) => team.id === destTeamId);
  if (!source || !dest || source.id === dest.id) return teams;

  const player = source.players.find((entry) => entry.id === playerId);
  const moved = { ...player, assignment_source: 'manual' };
  const at =
    Number.isInteger(destIndex) && destIndex >= 0 && destIndex <= dest.players.length
      ? destIndex
      : dest.players.length;

  return teams.map((team) => {
    if (team.id === source.id) {
      return { ...team, players: team.players.filter((entry) => entry.id !== playerId) };
    }
    if (team.id === dest.id) {
      return { ...team, players: [...team.players.slice(0, at), moved, ...team.players.slice(at)] };
    }
    return team;
  });
}

/**
 * Reorder a player within their team.
 *
 * @param {any[]} teams
 * @param {string|number} teamId
 * @param {number} from
 * @param {number} to
 * @returns {any[]}
 */
export function reorderWithinTeam(teams, teamId, from, to) {
  if (from === to || from < 0 || to < 0) return teams;
  return teams.map((team) => {
    if (team.id !== teamId) return team;
    if (from >= team.players.length || to >= team.players.length) return team;
    const players = [...team.players];
    const [entry] = players.splice(from, 1);
    players.splice(to, 0, entry);
    return { ...team, players };
  });
}
