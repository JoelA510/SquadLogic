/**
 * The waitlist exception (owner, 2026-10-27, docs/changes/2026-10-27-play-up-by-request.md).
 *
 * A buddy request does not take a player off the waitlist. The one exception is a player a coach
 * asked for: the buddy, under the league's buddy rule, of a coach's linked child (the link is a
 * `coach_team_requests` row, written by the coach import, for a coach who is active or pending
 * confirmation). That player comes off the waitlist, is placed on the coach's team with the
 * child, and is listed. The Teams page makes the player active when the admin saves the teams
 * (the audited status write); this module only decides who, in the run.
 *
 * "Buddy under the league's buddy rule" is the link the pipeline resolved: a reciprocated
 * request, or, under `one_way_best_effort`, a one-way request it honoured, from either side.
 * Under the default `mutual` rule a one-way request is no buddy and does nothing. Any other
 * buddy of a waitlisted player does nothing.
 *
 * Pure module: no React / Supabase imports.
 */

import { getCanonicalBuddyId } from './buddyLinking.js';
import { isEligibilityBlocked, isWaitlisted } from './playUp.js';

function sameDivision(a, b) {
  return (
    a?.division != null && String(a.division).toLowerCase() === String(b?.division).toLowerCase()
  );
}

function playerName(player) {
  if (typeof player?.name === 'string' && player.name.trim()) return player.name.trim();
  const full = `${player?.firstName ?? player?.first_name ?? ''} ${player?.lastName ?? player?.last_name ?? ''}`;
  return full.trim() || String(player?.id);
}

/**
 * @typedef {Object} WaitlistException
 * @property {string} playerId - the waitlisted player taken off the waitlist
 * @property {string} name
 * @property {string} childId - the coach's child they are the buddy of
 * @property {string} childName
 * @property {string} coachId - the coach whose child that is, and whose team they join
 * @property {string} division - the division they play in
 */

/**
 * Take off the waitlist each waitlisted player a coach asked for. Run it after buddies are
 * linked (including a honoured one-way request), coaches are linked and play-up placement has
 * moved players to the division they play in.
 *
 * A taken-off player is `status: 'active'` in the returned players, carries
 * `takenOffWaitlist: { childId, coachId }`, and is made the child's buddy both ways, so the
 * generator seats the two together as one unit on the coach's team.
 *
 * @param {Object} params
 * @param {Array<Object>} params.players - generator players with `buddyId` and `coachId` set
 * @returns {{ players: Array<Object>, exceptions: WaitlistException[] }}
 */
export function applyWaitlistException({ players }) {
  if (!Array.isArray(players)) throw new TypeError('players must be an array');
  const byId = new Map(players.map((player) => [String(player.id), player]));
  // Every link that points at a player: a one-way request is stored on the requester only, and
  // more than one player may name the same one.
  /** @type {Map<string, Object[]>} */
  const claimers = new Map();
  for (const player of players) {
    const target = getCanonicalBuddyId(player);
    if (target === undefined) continue;
    if (!claimers.has(target)) claimers.set(target, []);
    /** @type {Object[]} */ (claimers.get(target)).push(player);
  }

  /** The coach's children this waitlisted player is the buddy of, best first. */
  const childrenOf = (waitlisted) => {
    const id = String(waitlisted.id);
    const own = getCanonicalBuddyId(waitlisted);
    const linked = [own !== undefined ? byId.get(own) : undefined, ...(claimers.get(id) ?? [])];
    const seen = new Set();
    return linked
      .filter((child) => {
        if (!child || String(child.id) === id || seen.has(String(child.id))) return false;
        seen.add(String(child.id));
        if (child.coachId == null || child.coachId === '') return false;
        if (
          isWaitlisted(child) ||
          isEligibilityBlocked(child) ||
          !sameDivision(waitlisted, child)
        ) {
          return false;
        }
        // Neither may already be paired with someone else.
        if (own !== undefined && own !== String(child.id)) return false;
        const childBuddy = getCanonicalBuddyId(child);
        return childBuddy === undefined || childBuddy === id;
      })
      .sort((a, b) => {
        // A pair that names each other first, then by id: nothing here reads the row order.
        const mutual = (child) =>
          getCanonicalBuddyId(child) === id && own === String(child.id) ? 0 : 1;
        return mutual(a) - mutual(b) || String(a.id).localeCompare(String(b.id));
      });
  };

  /** @type {Map<string, WaitlistException>} */
  const taken = new Map();
  const reservedChildren = new Set();
  const waiting = players
    .filter(
      (player) =>
        isWaitlisted(player) &&
        !isEligibilityBlocked(player) &&
        // A coach's own child on the waitlist is not "a coach's child's buddy".
        (player.coachId == null || player.coachId === '')
    )
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const waitlisted of waiting) {
    // One waitlisted player per child: the coach asked for a buddy, not for a second seat.
    const child = childrenOf(waitlisted).find((entry) => !reservedChildren.has(String(entry.id)));
    if (!child) continue;
    reservedChildren.add(String(child.id));
    taken.set(String(waitlisted.id), {
      playerId: String(waitlisted.id),
      name: playerName(waitlisted),
      childId: String(child.id),
      childName: playerName(child),
      coachId: String(child.coachId),
      division: String(waitlisted.division),
    });
  }

  if (taken.size === 0) return { players, exceptions: [] };
  const childOf = new Map([...taken.values()].map((entry) => [entry.childId, entry.playerId]));
  const next = players.map((player) => {
    const id = String(player.id);
    const exception = taken.get(id);
    if (exception) {
      const copy = { ...player, status: 'active', buddyId: exception.childId };
      delete copy.buddy_id;
      copy.takenOffWaitlist = { childId: exception.childId, coachId: exception.coachId };
      return copy;
    }
    if (childOf.has(id)) {
      const copy = { ...player, buddyId: childOf.get(id) };
      delete copy.buddy_id;
      return copy;
    }
    return player;
  });
  return { players: next, exceptions: [...taken.values()] };
}
