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
  getCanonicalBuddyId,
  normalizeBuddyLinks,
  resolveBuddyRequests,
} from './buddyLinking.js';
import { applyBuddyRule } from './teamingPipeline.js';

/** @returns {'rating'|'years'|'size'} */
export function balanceSignalKind(features = {}) {
  if (features.player_rating) return 'rating';
  if (features.years_played) return 'years';
  return 'size';
}

/** Numeric balancing weight for one player under the given signal kind. */
export function playerSignal(player, kind) {
  if (kind === 'rating') return Number(player?.rating) || 1;
  if (kind === 'years') return (Number(player?.years_played) || 0) + 1;
  return 1;
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
 * `players` is the board: one division's players, every one with the same `division`
 * (or none). `roster` is every player, each with its `division`, so a code or request
 * shared with another division is told apart; it defaults to the board.
 *
 * @param {any[]} players
 * @param {{ roster?: any[], buddyRule?: string }} [options]
 * @returns {{ mutual: Map<string, string>, oneWay: Map<string, string> }} partner ids by
 *   player id (both members of a mutual pair; the requester of an honoured one-way request)
 */
function boardBuddyLinks(players, { roster, buddyRule = BUDDY_RULES.MUTUAL } = {}) {
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
 * With `respectCoach`, units containing a coach-volunteering guardian are
 * spread first, one per team where possible.
 *
 * Buddies follow `boardBuddyLinks` (Team Analysis's rule): a mutual pair is one unit; an
 * honoured one-way request (`one_way_best_effort`) is best effort, never a unit. Whichever of
 * the two is dealt second goes to the other's team when that team is still a candidate (the
 * coach spread can rule it out), as `BuddyEvaluator` steers it in the generator.
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
      hasCoach: members.some((m) => m.willing_to_coach),
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
    coachUnits: 0,
  }));

  /** @type {Map<string, any>} the team each dealt player went to */
  const teamIdOf = new Map();
  const pick = (unit) => {
    let candidates = buckets;
    if (respectCoach && unit.hasCoach) {
      const minCoach = Math.min(...buckets.map((b) => b.coachUnits));
      candidates = buckets.filter((b) => b.coachUnits === minCoach);
    }
    // best effort: a candidate team already holding a one-way partner of a member
    const partnerTeams = new Set(
      unit.members.flatMap((member) =>
        (oneWayPartners.get(String(member.id)) ?? [])
          .filter((partnerId) => teamIdOf.has(partnerId))
          .map((partnerId) => teamIdOf.get(partnerId))
      )
    );
    const withPartner = candidates.filter((b) => partnerTeams.has(b.teamId));
    if (withPartner.length > 0) candidates = withPartner;
    // lowest signal total, then smallest roster, then stable order
    return candidates.reduce((best, bucket) => {
      if (!best) return bucket;
      if (bucket.total !== best.total) return bucket.total < best.total ? bucket : best;
      if (bucket.count !== best.count) return bucket.count < best.count ? bucket : best;
      return best;
    }, null);
  };

  const sorted = [...units].sort(
    (a, b) => (b.hasCoach ? 1 : 0) - (a.hasCoach ? 1 : 0) || b.signal - a.signal
  );

  const assignments = [];
  sorted.forEach((unit) => {
    const bucket = pick(unit);
    bucket.total += unit.signal;
    bucket.count += unit.members.length;
    if (unit.hasCoach) bucket.coachUnits += 1;
    unit.members.forEach((member) => {
      teamIdOf.set(String(member.id), bucket.teamId);
      assignments.push({ playerId: member.id, teamId: bucket.teamId });
    });
  });

  return assignments;
}
