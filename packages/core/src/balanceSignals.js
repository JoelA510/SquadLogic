/**
 * Balance signals for the Team Builder board.
 *
 * The balancing signal of a player depends on the org feature config:
 *   - player_rating on  → the 1–5 rating
 *   - years_played on   → yearsPlayed + 1 (so rookies still weigh something)
 *   - neither           → 1 (balance by roster size only)
 *
 * Buddies are matched as Team Analysis matches them (Phase B5,
 * `docs/changes/2026-10-22-phase-b-teaming.md`): requests resolve through
 * `resolveBuddyRequests`, the league's `buddy_rule` decides which link, and buddy
 * codes pair as `normalizeBuddyLinks` pairs them.
 *
 * Pure module — no React, no I/O.
 */

import {
  BUDDY_RULES,
  applyBuddyRule,
  getCanonicalBuddyId,
  normalizeBuddyLinks,
  resolveBuddyRequests,
} from './buddyLinking.js';
import {
  compensatedLoad,
  countLeads,
  leadCompensation,
  orderForLeadDeal,
  withFewestLeads,
} from './coachingLeads.js';

/** @returns {'rating'|'years'|'size'} */
export function balanceSignalKind(features = {}) {
  if (features.player_rating) return 'rating';
  if (features.years_played) return 'years';
  return 'size';
}

/**
 * Numeric balancing weight for one player under the given signal kind. A board player's
 * rating is `rating`; a generator player without one reads its `skillRating` (Phase B6).
 */
export function playerSignal(player, kind) {
  if (kind === 'rating') return Number(player?.rating ?? player?.skillRating) || 1;
  if (kind === 'years') return (Number(player?.years_played) || 0) + 1;
  return 1;
}

/**
 * Whether a player holds a value for the signal kind (`playerSignal` reads it): a rating (or a
 * generator player's `skillRating`), or years played. Never for `'size'`. A player without one
 * weighs the default, so a division where nobody carries the signal has nothing to compensate
 * leads with (Phase B6).
 */
export function carriesSignal(player, kind) {
  if (kind !== 'rating' && kind !== 'years') return false;
  const value = kind === 'rating' ? (player?.rating ?? player?.skillRating) : player?.years_played;
  return value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value));
}

/** Live per-team metrics for a column of players. */
export function teamBalanceMetrics(players = []) {
  const size = players.length;
  const sum = (selector) => players.reduce((total, p) => total + (Number(selector(p)) || 0), 0);
  return {
    size,
    boys: players.filter((p) => p?.gender === 'm').length,
    girls: players.filter((p) => p?.gender === 'f').length,
    avgRating: size ? sum((p) => p.rating) / size : 0,
    avgYears: size ? sum((p) => p.years_played) / size : 0,
  };
}

/**
 * The buddy links one board honours, by the rule Team Analysis applies
 * (`prepareTeamingInput`, Phase B1): each request resolves through
 * `resolveBuddyRequests` (registration id, then name; a namesake tie settled only by
 * reciprocity), `applyBuddyRule` links a mutual pair and, under `one_way_best_effort`,
 * honours a one-way request whose named player listed no buddy, and buddy codes pair as
 * `normalizeBuddyLinks` pairs them. A one-way request is honoured last, and not when a
 * code paired the requester meanwhile (one buddy per player). A board has no head-coach
 * anchors, so the pipeline's coach-conflict break has nothing to break here.
 *
 * `players` is the board; `roster` is every player, so a code or request naming someone off
 * the board is told apart; it defaults to the board. Each carries its `division` (the
 * division id): as in Team Analysis, only two players of one division are ever linked.
 *
 * @param {any[]} players
 * @param {{ roster?: any[], buddyRule?: string }} [options]
 * @returns {{ mutual: Map<string, string>, oneWay: Map<string, string> }} partner ids by
 *   player id (both members of a mutual pair; the requester of an honoured one-way request)
 */
export function boardBuddyLinks(players, { roster, buddyRule = BUDDY_RULES.MUTUAL } = {}) {
  const { requests } = resolveBuddyRequests({ players, roster });
  const ruled = applyBuddyRule({ players, requests, buddyRule });
  const linked = normalizeBuddyLinks(ruled.players, { roster });

  const byId = new Map(linked.players.map((player) => [String(player.id), player]));
  /** @type {Map<string, string>} */
  const mutual = new Map();
  for (const [id, player] of byId) {
    const buddyId = getCanonicalBuddyId(player);
    if (buddyId === undefined || buddyId === id) continue;
    if (getCanonicalBuddyId(byId.get(buddyId)) === id) mutual.set(id, buddyId);
  }
  /** @type {Map<string, string>} */
  const oneWay = new Map();
  for (const [requesterId, targetId] of ruled.oneWayBuddyIds) {
    if (getCanonicalBuddyId(byId.get(requesterId)) !== undefined) continue;
    oneWay.set(requesterId, String(targetId));
  }
  return { mutual, oneWay };
}

/**
 * Buddy satisfaction across a division: a request counts when the league's rule honours it
 * (a mutual pair counts once per player, an honoured one-way request once); it is satisfied
 * when both share a team. A request the rule does not honour (a one-way request under
 * `mutual`, an unresolved name) is not counted. Returns { requested, satisfied }.
 *
 * @param {any[]} [players]
 * @param {{ roster?: any[], buddyRule?: string }} [options]
 */
export function buddyStats(players = [], { roster, buddyRule } = {}) {
  const { mutual, oneWay } = boardBuddyLinks(players, { roster, buddyRule });
  const teamById = new Map(players.map((player) => [String(player.id), player.team_id]));
  let requested = 0;
  let satisfied = 0;
  for (const links of [mutual, oneWay]) {
    for (const [id, partnerId] of links) {
      requested += 1;
      const teamId = teamById.get(id);
      if (teamId && teamId === teamById.get(partnerId)) satisfied += 1;
    }
  }
  return { requested, satisfied };
}

/**
 * Serpentine auto-balance of `players` across `teams` (existing team rows).
 *
 * Players are grouped into units (a mutual pair, by the league's rule, when
 * `respectBuddies`), sorted by descending unit signal, then dealt
 * serpentine-style to the team with the lowest running signal total.
 *
 * With `respectCoach` (the league's `teaming_spread_coaching_leads`, Phase B6), steps 2 and 3
 * of the rule in `coachingLeads.js` the generator also deals by (a board has no head-coach
 * anchors, so step 1 has nothing to place): units holding a coaching lead
 * (`willing_to_coach`) are dealt first, the most leads first, each to a team with the fewest
 * leads, so no two teams differ by more than one except where one unit holds two; then every
 * team's load is its signal total plus `c` per lead (`leadCompensation`: the board's mean
 * player signal; 0 when balancing by roster size only or when no player carries the signal),
 * so a team with fewer leads receives
 * more of the experienced or rated players. Without it, leads are ordinary players.
 *
 * Buddies follow `boardBuddyLinks` (Team Analysis's rule): a mutual pair is one unit; an
 * honoured one-way request (`one_way_best_effort`) is best effort, never a unit. Whichever of
 * the two is dealt second goes to the other's team when that team is still a candidate (the
 * coach spread can rule it out) and holds no more players than the team the deal would pick
 * anyway, so honouring a request never makes the rosters less even than the plain deal
 * would at that step. Many requests naming one player cannot pile onto that player's team.
 * (In the generator, `BuddyEvaluator` scores the request beside the roster limits; the board
 * has no roster limits, so the size check stands in for them.)
 *
 * `roster` is every player (each with its `division`), so a request or code naming someone
 * outside the board is not paired; `buddyRule` is the league's `buddy_rule` (default mutual).
 *
 * Returns assignments only — `[{ playerId, teamId }]` — the caller
 * persists them through the audited RPCs.
 *
 * @param {{ players?: any[], teams?: any[], signalKind?: string, respectBuddies?: boolean,
 *   respectCoach?: boolean, roster?: any[], buddyRule?: string }} params
 */
export function serpentineAssign({
  players = [],
  teams = [],
  signalKind = 'size',
  respectBuddies = true,
  respectCoach = true,
  roster,
  buddyRule = BUDDY_RULES.MUTUAL,
}) {
  if (teams.length === 0) return [];

  // ---- build units (mutual pairs stay together) ----
  const links = respectBuddies
    ? boardBuddyLinks(players, { roster, buddyRule })
    : { mutual: new Map(), oneWay: new Map() };
  const byId = new Map(players.map((player) => [String(player.id), player]));
  // Best-effort partners, both ways: the requester is steered to the named player, and the
  // named player to the requester, whichever is dealt first.
  /** @type {Map<string, string[]>} */
  const oneWayPartners = new Map();
  const addPartner = (id, partnerId) => {
    if (!oneWayPartners.has(id)) oneWayPartners.set(id, []);
    oneWayPartners.get(id).push(partnerId);
  };
  for (const [requesterId, targetId] of links.oneWay) {
    addPartner(requesterId, targetId);
    addPartner(targetId, requesterId);
  }

  const unitOf = new Map();
  const units = [];
  const addUnit = (members) => {
    const unit = {
      members,
      signal: members.reduce((total, m) => total + playerSignal(m, signalKind), 0),
      leads: respectCoach ? countLeads(members) : 0,
    };
    members.forEach((m) => unitOf.set(String(m.id), unit));
    units.push(unit);
  };

  players.forEach((player) => {
    const id = String(player.id);
    if (unitOf.has(id)) return;
    const buddy = byId.get(links.mutual.get(id) ?? '');
    if (buddy && !unitOf.has(String(buddy.id))) {
      addUnit([player, buddy]);
      return;
    }
    addUnit([player]);
  });

  // ---- deal units to teams ----
  const buckets = teams.map((team) => ({
    teamId: team.id,
    total: 0,
    count: 0,
    leads: 0,
  }));
  // What one lead adds to a team's load: 0 when no unit holds one, by roster size only, or when
  // no player carries the signal (nothing to compensate with), as in the generator.
  const c =
    units.some((unit) => unit.leads > 0) &&
    players.some((player) => carriesSignal(player, signalKind))
      ? leadCompensation(
          players.map((player) => playerSignal(player, signalKind)),
          { signalKind }
        )
      : 0;
  const loadOf = (bucket) => compensatedLoad(bucket.total, bucket.leads, c);

  /** @type {Map<string, any>} the team each dealt player went to */
  const teamIdOf = new Map();
  const pick = (unit) => {
    const candidates =
      unit.leads > 0 ? withFewestLeads(buckets, (bucket) => bucket.leads) : buckets;
    // lowest load (the signal total, plus c per lead), then smallest roster, then stable order
    const lowest = (options) =>
      options.reduce((best, bucket) => {
        if (!best) return bucket;
        if (loadOf(bucket) !== loadOf(best)) return loadOf(bucket) < loadOf(best) ? bucket : best;
        if (bucket.count !== best.count) return bucket.count < best.count ? bucket : best;
        return best;
      }, null);
    const deal = lowest(candidates);
    // best effort: a candidate team already holding a one-way partner of a member, when it
    // holds no more players than the team the deal would pick
    const partnerTeams = new Set(
      unit.members.flatMap((member) =>
        (oneWayPartners.get(String(member.id)) ?? [])
          .filter((partnerId) => teamIdOf.has(partnerId))
          .map((partnerId) => teamIdOf.get(partnerId))
      )
    );
    const withPartner = candidates.filter(
      (b) => partnerTeams.has(b.teamId) && b.count <= deal.count
    );
    return withPartner.length > 0 ? lowest(withPartner) : deal;
  };

  const sorted = orderForLeadDeal(units, {
    leadsOf: (unit) => unit.leads,
    weightOf: (unit) => unit.signal,
  });

  const assignments = [];
  sorted.forEach((unit) => {
    const bucket = pick(unit);
    bucket.total += unit.signal;
    bucket.count += unit.members.length;
    bucket.leads += unit.leads;
    unit.members.forEach((member) => {
      teamIdOf.set(String(member.id), bucket.teamId);
      assignments.push({ playerId: member.id, teamId: bucket.teamId });
    });
  });

  return assignments;
}
