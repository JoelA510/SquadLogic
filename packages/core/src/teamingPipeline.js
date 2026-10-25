/**
 * Pre-generation teaming pipeline.
 *
 * Composes the transforms that run on generator players BEFORE
 * `generateTeams`:
 *   1. resolve buddy requests (a registration id or a name) to players, and apply the
 *      league's buddy rule (`resolveBuddyRequests`, Phase B1);
 *   2. canonicalize buddy fields (buddyId / buddy_id / mutual_buddy_code → buddyId);
 *   3. link imported coaches to their player-children (so the generator anchors
 *      a team per coaching family — separate coach exports now drive teaming), then
 *      break any mutual pair whose two players anchor different head coaches;
 *   4. flag coach-children so play-up "route A" (a coaching parent) is honored;
 *   5. apply play-up / play-down eligibility.
 *
 * Pure module — no React / Supabase imports.
 */

import { linkCoachesToPlayers } from './coachLinking.js';
import { applyPlayUpEligibility } from './playUp.js';
import {
  BUDDY_REQUEST_FIELDS,
  BUDDY_REQUEST_STATUS,
  BUDDY_RULES,
  getCanonicalBuddyId,
  listsABuddy,
  normalizeBuddyLinks,
  resolveBuddyRequests,
} from './buddyLinking.js';

/**
 * Turn resolved requests into `buddyId`s under the league's rule, and say what became of
 * each request. A mutual pair (each names the other) always links, here. A one-way request is
 * honoured only under `one_way_best_effort`, and only when the named player listed no buddy of
 * their own; its `buddyId` is returned separately (`oneWayBuddyIds`) and set on the requester
 * after play-up eligibility, so it is scored best effort by `BuddyEvaluator`, never forms a
 * unit, and never sanctions a play-up (route B needs a pair that is placed together).
 * The request text is consumed here, so `normalizeBuddyLinks` keeps its rules for codes and
 * explicit references and never reads a name as a registration key. Each `buddyId` is the
 * target's own id value (a numeric id stays a number), as the generator compares strictly.
 * TeamBuilder's auto-balance applies the same rule (`balanceSignals.js`, Phase B5).
 *
 * @param {{ players: any[], requests: any[], buddyRule?: string }} params
 */
export function applyBuddyRule({ players, requests, buddyRule }) {
  const byId = new Map(players.map((player) => [String(player.id), player]));
  const rawId = (id) => byId.get(id)?.id ?? id;
  const buddyIdByPlayer = new Map();
  const oneWayBuddyIds = new Map();
  const outcomes = requests.map((request) => {
    if (request.status !== BUDDY_REQUEST_STATUS.RESOLVED) {
      return { ...request, outcome: request.status, honoured: false };
    }
    if (request.reciprocated) {
      buddyIdByPlayer.set(request.playerId, rawId(request.targetId));
      return { ...request, outcome: 'mutual', honoured: true };
    }
    if (buddyRule !== BUDDY_RULES.ONE_WAY_BEST_EFFORT) {
      return { ...request, outcome: 'one-way', honoured: false, reason: 'buddy-rule-mutual' };
    }
    if (listsABuddy(byId.get(request.targetId))) {
      return {
        ...request,
        outcome: 'one-way',
        honoured: false,
        reason: 'named-player-listed-another-buddy',
      };
    }
    oneWayBuddyIds.set(request.playerId, rawId(request.targetId));
    return { ...request, outcome: 'one-way', honoured: true };
  });

  const consumed = new Set(requests.map((request) => request.playerId));
  const stripped = players.map((player) => {
    const id = String(player.id);
    if (!consumed.has(id)) return player;
    const next = { ...player };
    for (const key of BUDDY_REQUEST_FIELDS) delete next[key];
    if (buddyIdByPlayer.has(id)) next.buddyId = buddyIdByPlayer.get(id);
    return next;
  });
  return { players: stripped, outcomes, oneWayBuddyIds };
}

/**
 * Break every mutual pair whose two players anchor different head coaches: a pair is one
 * unit, and a unit cannot join two coaches' teams (the generator's unit guard throws).
 * Both players keep their coach; the pair is reported, never thrown.
 */
function breakCoachConflictPairs(players) {
  const byId = new Map(players.map((player) => [String(player.id), player]));
  const broken = new Set();
  /** @type {Array<{ code: string, severity: 'warning', message: string, playerIds: string[] }>} */
  const diagnostics = [];
  for (const player of players) {
    const id = String(player.id);
    const buddyId = getCanonicalBuddyId(player);
    if (!buddyId || broken.has(id)) continue;
    const buddy = byId.get(buddyId);
    if (!buddy || getCanonicalBuddyId(buddy) !== id) continue;
    const coachA = player.coachId ? String(player.coachId) : null;
    const coachB = buddy.coachId ? String(buddy.coachId) : null;
    if (!coachA || !coachB || coachA === coachB) continue;
    broken.add(id);
    broken.add(buddyId);
    diagnostics.push({
      code: 'buddy-coach-conflict',
      severity: 'warning',
      message: `buddies ${id} and ${buddyId} each anchor a different head coach's team (${coachA}, ${coachB}); they are placed with their own coaches`,
      playerIds: [id, buddyId].sort(),
    });
  }
  if (broken.size === 0) return { players, diagnostics, broken };
  const next = players.map((player) => {
    if (!broken.has(String(player.id))) return player;
    const copy = { ...player };
    delete copy.buddyId;
    delete copy.buddy_id;
    return copy;
  });
  return { players: next, diagnostics, broken };
}

/** The buddy-request outcomes that did not link a pair, as `buddyLinking` diagnostics. */
function requestDiagnostics(outcomes) {
  return outcomes
    .filter((outcome) => outcome.outcome !== 'mutual' && outcome.outcome !== 'coach-conflict')
    .map((outcome) => ({
      code:
        outcome.outcome === 'one-way'
          ? 'one-way-buddy-request'
          : `buddy-request-${outcome.outcome}`,
      severity: outcome.outcome === 'one-way' ? 'info' : 'warning',
      message:
        outcome.outcome === 'one-way'
          ? `player ${outcome.playerId}'s request for ${outcome.targetId} is not reciprocated${outcome.honoured ? ' (placed together on a best-effort basis)' : ''}`
          : `player ${outcome.playerId}'s buddy request could not be matched (${outcome.outcome})`,
      playerIds: outcome.targetId ? [outcome.playerId, outcome.targetId] : [outcome.playerId],
    }));
}

function collectCoachChildIds(coaches) {
  const ids = new Set();
  for (const coach of coaches ?? []) {
    if (Array.isArray(coach?.children)) {
      for (const child of coach.children) {
        if (child?.player_id) ids.add(String(child.player_id));
      }
    }
    const single = coach?.player_id ?? coach?.playerId;
    if (single) ids.add(String(single));
  }
  return ids;
}

/**
 * @param {Object} params
 * @param {Array<Object>} params.players - generator players (id, division, ...)
 * @param {Array<Object>} [params.coaches] - imported coaches with child links
 * @param {Array<Object>|Object} [params.divisions]
 * @param {number} params.seasonYear
 * @param {string} [params.cutoffMode]
 * @param {boolean} [params.remapBlocked=false] - single-division flows keep this
 *   false (annotate only); multi-division flows can remap illegal placements.
 * @param {Array<Object>} [params.roster] - every imported player (id, division, names,
 *   external registration id), so a buddy request naming someone outside the program is
 *   told apart from one naming nobody. Defaults to `players`.
 * @param {string} [params.buddyRule='mutual'] - the league's `buddy_rule` (`BUDDY_RULES`).
 * @returns {{ players: Array<Object>, diagnostics: { buddyLinking: Array<Object>, buddyRequests: Array<Object>, coachLinking: Object, playUp: Object } }}
 */
export function prepareTeamingInput({
  players,
  roster,
  coaches = [],
  divisions = [],
  seasonYear,
  cutoffMode,
  remapBlocked = false,
  buddyRule = BUDDY_RULES.MUTUAL,
}) {
  if (!Array.isArray(players)) throw new TypeError('players must be an array');

  // Requests (registration ids and names) resolve first; the rule decides which link.
  const { requests } = resolveBuddyRequests({ players, roster });
  const ruled = applyBuddyRule({ players, requests, buddyRule });
  const buddies = normalizeBuddyLinks(ruled.players, { roster });

  const linked = linkCoachesToPlayers({ players: buddies.players, coaches });
  const unclashed = breakCoachConflictPairs(linked.players);
  const buddyRequests = ruled.outcomes.map((outcome) =>
    unclashed.broken.has(outcome.playerId) && outcome.outcome === 'mutual'
      ? { ...outcome, outcome: 'coach-conflict', honoured: false }
      : outcome
  );

  // The request text was consumed above; hand it back so the output keeps its fields.
  const requestTextById = new Map();
  for (const player of players) {
    for (const key of BUDDY_REQUEST_FIELDS) {
      if (player?.[key] !== undefined) {
        if (!requestTextById.has(String(player.id))) requestTextById.set(String(player.id), {});
        requestTextById.get(String(player.id))[key] = player[key];
      }
    }
  }
  const restored = unclashed.players.map((player) => {
    const fields = requestTextById.get(String(player.id));
    return fields ? { ...player, ...fields } : player;
  });

  // A coach's child is coached by their parent — mark them so a play-up gains
  // the "coaching parent" sanction route.
  const coachChildIds = collectCoachChildIds(coaches);
  const flagged = restored.map((player) =>
    coachChildIds.has(String(player.id)) ? { ...player, isCoachChild: true } : player
  );

  const playUp = applyPlayUpEligibility({
    players: flagged,
    divisions,
    seasonYear,
    cutoffMode,
    remapBlocked,
  });

  // Honoured one-way requests, last: best effort only. A requester a code paired meanwhile
  // keeps that pair (one buddy per player), and the request is listed as not honoured.
  const finalBuddyRequests = buddyRequests.map((outcome) =>
    outcome.outcome === 'one-way' &&
    outcome.honoured &&
    getCanonicalBuddyId(playUp.players.find((p) => String(p.id) === outcome.playerId)) !== undefined
      ? { ...outcome, honoured: false, reason: 'requester-has-another-buddy' }
      : outcome
  );
  const honouredOneWay = new Set(
    finalBuddyRequests
      .filter((outcome) => outcome.outcome === 'one-way' && outcome.honoured)
      .map((outcome) => outcome.playerId)
  );
  const outPlayers = playUp.players.map((player) =>
    honouredOneWay.has(String(player.id))
      ? { ...player, buddyId: ruled.oneWayBuddyIds.get(String(player.id)) }
      : player
  );

  return {
    players: outPlayers,
    diagnostics: {
      buddyLinking: [
        ...requestDiagnostics(finalBuddyRequests),
        ...buddies.diagnostics,
        ...unclashed.diagnostics,
      ],
      buddyRequests: finalBuddyRequests,
      coachLinking: linked.diagnostics,
      playUp: playUp.diagnostics,
    },
  };
}
