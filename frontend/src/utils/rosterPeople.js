/**
 * The roster editor's people, from the durable tables (see `useRosterDirectory`).
 *
 * `applyRosterDirectory` lays the player and coach names over the teams the Teams page maps from
 * a team run. It returns the same object for any team or player it has nothing to change, so a
 * memoised row does not re-render for a read that told it nothing new.
 *
 * @module utils/rosterPeople
 */
import { teamCoachFields } from './teamCoaches.js';
import { skillTierKey } from '../constants/skillTier.js';

/** What the page prints for a roster entry it could not name. */
export const UNKNOWN_PLAYER = 'Unknown Player';
const PLACEHOLDER_NAMES = new Set([UNKNOWN_PLAYER, 'Unnamed Player', '']);

const hasName = (name) => !PLACEHOLDER_NAMES.has(String(name ?? '').trim());

/**
 * @param {any} player
 * @param {Map<string, { name: string, rating: number | null, skillTier?: string | null,
 *   naturalAge?: number | null, playUpRequested?: boolean }>} people
 * @param {{ skillTier: boolean }} options
 */
function withPlayerDetails(player, people, { skillTier }) {
  const known = people.get(String(player.id));
  if (!known) return player;
  const next = { ...player };
  // The durable name wins (the Player Record page edits it there); an import's or a saved
  // review's stays only for a player the table has no name for.
  if (known.name) next.name = known.name;
  // The record's rating travels as `rating`, which the roster editor shows only with Player Rating
  // on. It is also the entry's `skill` when the run carries none, marked `skillIsRating` so the
  // editor can tell a rating from a skill tier (the Skill Tier option shows only the tier).
  if (known.rating !== null) next.rating = known.rating;
  // With the Skill Tier option on, the record's tier is the entry's skill and wins over the file's or
  // a saved review's, as it does for the generator (`withDurableIdentity`); a null or blank one keeps
  // what the entry had. With it off no tier is read into the entry.
  const storedTier = skillTier ? skillTierKey(known.skillTier) : null;
  if (storedTier) {
    next.skill = storedTier;
    delete next.skillIsRating;
  } else if (!player.skill && known.rating !== null) {
    next.skill = String(known.rating);
    next.skillIsRating = true;
  }
  // What the play-up and play-down list judges the seat by: the stored natural age (null when the
  // record has none: unknown, never 0) and whether a play-up was requested.
  if (known.naturalAge !== undefined) next.naturalAge = known.naturalAge;
  if (known.playUpRequested !== undefined) next.playUpRequested = known.playUpRequested;
  return next.name === player.name &&
    next.skill === player.skill &&
    next.rating === player.rating &&
    next.skillIsRating === player.skillIsRating &&
    next.naturalAge === player.naturalAge &&
    next.playUpRequested === player.playUpRequested
    ? player
    : next;
}

/**
 * @param {any} team
 * @param {Map<string, string>} coaches
 */
function withCoachNames(team, coaches) {
  const fields = teamCoachFields(team);
  const ids = [fields.coachId, ...fields.assistantCoachIds];
  if (!ids.some((id) => id && coaches.has(id))) return team;
  const next = { ...team };
  const headName = fields.coachId ? coaches.get(fields.coachId) : null;
  if (headName) next.coachName = headName;
  // Aligned to the id list, as `teamCoachFields` pads it: a name for the id it belongs to.
  next.assistantCoaches = fields.assistantCoachIds.map(
    (id, index) => (id ? coaches.get(id) : null) ?? fields.assistantCoaches[index] ?? null
  );
  return next;
}

/**
 * @param {any[]} teams
 * @param {{ players: Map<string, { name: string, rating: number | null, skillTier?: string | null,
 *   naturalAge?: number | null, playUpRequested?: boolean }>, coaches: Map<string, string> }} directory
 * @param {{ skillTier?: boolean }} [options] - `skillTier`: the Skill Tier option is on
 * @returns {any[]}
 */
export function applyRosterDirectory(teams, { players, coaches }, { skillTier = false } = {}) {
  let changed = false;
  const result = teams.map((team) => {
    let next = withCoachNames(team, coaches);
    let nextPlayers = team.players;
    if (Array.isArray(team.players)) {
      let playersChanged = false;
      const mapped = team.players.map((player) => {
        const withDetails = withPlayerDetails(player, players, { skillTier });
        if (withDetails !== player) playersChanged = true;
        return withDetails;
      });
      if (playersChanged) nextPlayers = mapped;
    }
    if (nextPlayers !== team.players) next = { ...next, players: nextPlayers };
    if (next !== team) changed = true;
    return next;
  });
  return changed ? result : teams;
}

/**
 * Roster entries still without a name once the directory is applied: a player id on a roster
 * that no `players` row (or no name on it) answers for. Said on the page, never papered over.
 *
 * @param {any[]} teams
 * @returns {number}
 */
export function countUnnamedPlayers(teams) {
  let count = 0;
  for (const team of teams) {
    for (const player of team.players ?? []) if (!hasName(player.name)) count += 1;
  }
  return count;
}
