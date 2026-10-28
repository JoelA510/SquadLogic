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
 *   4. place each player in the division they play in: their own age division, unless they
 *      requested a play-up, and list every play-up and play-down for the admin (`playUp.js`);
 *      a buddy pair that now plays in two divisions is told apart;
 *   5. take off the waitlist a waitlisted player a coach asked for: the buddy of a coach's
 *      linked child (`waitlistException.js`).
 *
 * Pure module — no React / Supabase imports.
 */

import { linkCoachesToPlayers } from './coachLinking.js';
import { applyPlayUpEligibility, withFinalBuddyFacts } from './playUp.js';
import { applyWaitlistException } from './waitlistException.js';
import {
  BUDDY_REQUEST_FIELDS,
  BUDDY_RULES,
  applyBuddyRule,
  getCanonicalBuddyId,
  normalizeBuddyLinks,
  resolveBuddyRequests,
} from './buddyLinking.js';

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
    .filter(
      (outcome) =>
        outcome.outcome !== 'mutual' &&
        outcome.outcome !== 'coach-conflict' &&
        outcome.outcome !== 'played-apart'
    )
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

/**
 * Break every mutual pair whose two players now play in different divisions (a play-up or
 * play-down put one of them in their own age division): a pair is one unit, and a unit cannot
 * sit in two divisions. Both players keep everything else; the pair is reported, never thrown.
 */
function breakPlayedApartPairs(players) {
  const byId = new Map(players.map((player) => [String(player.id), player]));
  const broken = new Set();
  /** @type {Array<{ code: string, severity: 'info', message: string, playerIds: string[] }>} */
  const diagnostics = [];
  for (const player of players) {
    const id = String(player.id);
    const buddyId = getCanonicalBuddyId(player);
    if (!buddyId || broken.has(id)) continue;
    const buddy = byId.get(buddyId);
    if (!buddy || getCanonicalBuddyId(buddy) !== id) continue;
    if (String(buddy.division).toLowerCase() === String(player.division).toLowerCase()) continue;
    broken.add(id);
    broken.add(buddyId);
    diagnostics.push({
      code: 'buddy-played-apart',
      severity: 'info',
      message: `buddies ${id} and ${buddyId} play in different divisions (${player.division} and ${buddy.division}), so they are not placed together`,
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

/**
 * @param {Object} params
 * @param {Array<Object>} params.players - generator players (id, division, ...)
 * @param {Array<Object>} [params.coaches] - imported coaches with child links
 * @param {number} params.seasonYear
 * @param {string} [params.cutoffMode]
 * @param {Array<Object>|Object} [params.divisions] - every division of the league: a player
 *   who plays in their own age division is placed in the one that holds their natural age.
 * @param {Array<Object>} [params.roster] - every imported player (id, division, names,
 *   external registration id), so a buddy request naming someone outside the program is
 *   told apart from one naming nobody. Defaults to `players`.
 * @param {string} [params.buddyRule='mutual'] - the league's `buddy_rule` (`BUDDY_RULES`).
 * @returns {{ players: Array<Object>, diagnostics: { buddyLinking: Array<Object>, buddyRequests: Array<Object>, coachLinking: Object, playUp: Object, waitlistExceptions: Array<Object> } }}
 */
export function prepareTeamingInput({
  players,
  roster,
  coaches = [],
  divisions = [],
  seasonYear,
  cutoffMode,
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

  // Everyone plays in their own age division unless they requested a play-up; the listing
  // carries the coach and buddy facts, so it runs after both are linked.
  const playUp = applyPlayUpEligibility({
    players: restored,
    divisions,
    seasonYear,
    cutoffMode,
  });
  const apart = breakPlayedApartPairs(playUp.players);
  const requestsAfterPlay = buddyRequests.map((outcome) =>
    apart.broken.has(outcome.playerId) && outcome.outcome === 'mutual'
      ? { ...outcome, outcome: 'played-apart', honoured: false }
      : outcome
  );

  // Honoured one-way requests, last: best effort only. A requester a code paired meanwhile
  // keeps that pair (one buddy per player), and the request is listed as not honoured.
  const playedIn = new Map(playUp.players.map((p) => [String(p.id), String(p.division)]));
  const finalBuddyRequests = requestsAfterPlay.map((outcome) => {
    if (outcome.outcome !== 'one-way' || !outcome.honoured) return outcome;
    if (
      getCanonicalBuddyId(apart.players.find((p) => String(p.id) === outcome.playerId)) !==
      undefined
    ) {
      return { ...outcome, honoured: false, reason: 'requester-has-another-buddy' };
    }
    return playedIn.get(outcome.playerId)?.toLowerCase() ===
      playedIn.get(outcome.targetId)?.toLowerCase()
      ? outcome
      : { ...outcome, honoured: false, reason: 'plays-in-another-division' };
  });
  const honouredOneWay = new Set(
    finalBuddyRequests
      .filter((outcome) => outcome.outcome === 'one-way' && outcome.honoured)
      .map((outcome) => outcome.playerId)
  );
  const withOneWay = apart.players.map((player) =>
    honouredOneWay.has(String(player.id))
      ? { ...player, buddyId: ruled.oneWayBuddyIds.get(String(player.id)) }
      : player
  );
  // Last, because it reads the final links: a waitlisted player a coach asked for comes off.
  const waitlist = applyWaitlistException({ players: withOneWay });
  const outPlayers = waitlist.players;
  // The listing was built before the one-way links and the waitlist pairs above existed.
  const playUpDiagnostics = {
    ...playUp.diagnostics,
    listing: withFinalBuddyFacts(playUp.diagnostics.listing, outPlayers, divisions),
  };

  return {
    players: outPlayers,
    diagnostics: {
      buddyLinking: [
        ...requestDiagnostics(finalBuddyRequests),
        ...buddies.diagnostics,
        ...unclashed.diagnostics,
        ...apart.diagnostics,
      ],
      buddyRequests: finalBuddyRequests,
      coachLinking: linked.diagnostics,
      playUp: playUpDiagnostics,
      waitlistExceptions: waitlist.exceptions,
    },
  };
}
