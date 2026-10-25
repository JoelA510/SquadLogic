/**
 * Link imported coaches to their player-children so the team generator anchors
 * a team around each coaching family.
 *
 * The generator (`teamGeneration.js`) creates one team per unique
 * `player.coachId` within a division and keeps the coach's child on that team.
 * Historically `coachId` was derived from a `willing_to_coach` flag on the
 * player row; this module instead projects the durable `coaches` table (and its
 * resolved child links) onto the player set, so a separately-imported coach
 * roster actually drives teaming. Since Phase B6 a `willing_to_coach` player is
 * a coaching lead (`coachingLeads.js`), not a coach, and carries no `coachId`.
 *
 * Pure module — no React / Supabase imports.
 */

/**
 * @param {Object} coach
 * @returns {Array<{ playerId: string, playingUp?: boolean }>}
 */
function coachChildLinks(coach) {
  const links = [];
  if (Array.isArray(coach?.children)) {
    for (const child of coach.children) {
      const playerId = child?.player_id ?? child?.playerId;
      if (playerId)
        links.push({
          playerId: String(playerId),
          playingUp: !!(child?.playing_up ?? child?.playingUp),
        });
    }
  }
  const single = coach?.player_id ?? coach?.playerId;
  if (single && !links.some((link) => link.playerId === String(single))) {
    links.push({ playerId: String(single), playingUp: false });
  }
  return links;
}

/**
 * Attach coachId / assistantCoachId to players based on imported coaches.
 *
 * @param {Object} params
 * @param {Array<Object>} params.players - generator players (each with an id)
 * @param {Array<Object>} params.coaches - imported coach rows with child links
 * @param {boolean} [params.overrideExisting=true] - when true, an imported coach
 *   link wins over a coachId already on the player (one the import row names).
 * @returns {{ players: Array<Object>, diagnostics: Object }}
 */
export function linkCoachesToPlayers({ players, coaches, overrideExisting = true }) {
  if (!Array.isArray(players)) throw new TypeError('players must be an array');
  const coachList = Array.isArray(coaches) ? coaches : [];
  const playerIds = new Set(players.map((player) => String(player.id)));

  // childPlayerId -> { coachId, coCoachId }
  const childToCoach = new Map();
  const diagnostics = {
    linkedCoaches: [],
    unlinkedCoaches: [],
    multiTeamCoaches: [],
    linkedPlayers: 0,
  };

  for (const coach of coachList) {
    const coachId = String(coach?.id ?? coach?.coach_id ?? coach?.email ?? '').trim();
    if (!coachId) continue;
    const links = coachChildLinks(coach).filter((link) => playerIds.has(link.playerId));
    const coCoachId = coach?.preferred_co_coach_id ?? coach?.assistant_coach_id ?? null;

    if (links.length === 0) {
      diagnostics.unlinkedCoaches.push({ coachId, reason: 'no child player in roster' });
      continue;
    }
    if (links.length > 1 || coach?.can_coach_multiple_teams) {
      diagnostics.multiTeamCoaches.push({ coachId, children: links.map((l) => l.playerId) });
    }
    diagnostics.linkedCoaches.push({ coachId, children: links.map((l) => l.playerId) });

    for (const link of links) {
      childToCoach.set(link.playerId, { coachId, coCoachId });
    }
  }

  const resultPlayers = players.map((player) => {
    const link = childToCoach.get(String(player.id));
    if (!link) return player;
    const next = { ...player };
    if (overrideExisting || !next.coachId) {
      next.coachId = link.coachId;
      diagnostics.linkedPlayers += 1;
    }
    if (link.coCoachId && !next.assistantCoachId) {
      next.assistantCoachId = String(link.coCoachId);
    }
    return next;
  });

  return { players: resultPlayers, diagnostics };
}
