/**
 * Play-up and play-down for SquadLogic teaming (owner, 2026-10-27,
 * docs/changes/2026-10-27-play-up-by-request.md).
 *
 * Everyone plays in their own division by default, and the app approves or refuses nothing:
 * clubs' own rules differ (play up only with a parent coaching the team, and so on), so the app
 * places the player and lists the facts for an admin.
 *   - A player registered in an older division than their natural age is a play-up. With
 *     `play_up_requested` they play in the older division they registered for; without one, in
 *     their own age division. Either way they are listed, with the facts an admin needs (the
 *     division played in, whether a parent coaches, whether a buddy is in it).
 *   - A player registered in a younger division than their natural age is a play-down. They
 *     play in their own age division and are listed.
 *   - Only a player no division can hold (none covers their natural age) is blocked: listed,
 *     not placed, with the reason (`isEligibilityBlocked`).
 *   - A player with no natural age is placed in the registered division and flagged.
 *
 * Pure module: no React / Supabase imports.
 */

import {
  classifyPlacement,
  computeAgeNumber,
  normalizeDivisionAgeBounds,
  parseGenderFromName,
  windowedAgeNumber,
} from './ageGroups.js';
import { getCanonicalBuddyId } from './buddyLinking.js';

export const PLACEMENT = Object.freeze({
  IN_BAND: 'in_band',
  /** Registered in an older division than the natural age (requested or not). */
  PLAY_UP: 'play_up',
  /** Registered in a younger division than the natural age. */
  PLAY_DOWN: 'play_down',
  /** No division in the list covers the natural age: listed, never placed. */
  NO_DIVISION: 'no_division',
  UNKNOWN: 'unknown',
});

/**
 * Is a player's placement one the generator must not seat (Phase B2)? Only a player no
 * division can hold (`no_division`), as `applyPlayUpEligibility` annotates them. A player with no
 * natural age, or no annotation at all, is not blocked (owner decision 3).
 *
 * @param {any} player - a generator player (`placement` from `applyPlayUpEligibility`)
 * @returns {boolean}
 */
export function isEligibilityBlocked(player) {
  return player?.placement === PLACEMENT.NO_DIVISION;
}

/**
 * Is a player on the waitlist (`players.status` of `waitlist`)? A waitlisted registrant has no
 * place in the league yet: the generator seats nobody on the waitlist, and the league-wide
 * averages a team-balancing score compares each player to leave them out. The Teams page sets
 * `status: 'waitlist'` on a generator player only while the Waitlist feature is on. The one
 * exception is a coach's child's buddy (`waitlistException.js`), who comes off it.
 *
 * @param {any} player - a generator player
 * @returns {boolean}
 */
export function isWaitlisted(player) {
  return player?.status === 'waitlist';
}

/**
 * Can the generator not seat this player: blocked by eligibility (`isEligibilityBlocked`) or
 * waitlisted? Such a player is left out of the league-wide averages too (owner, 2026-10-27).
 *
 * @param {any} player - a generator player
 * @returns {boolean}
 */
export function cannotBePlaced(player) {
  return isEligibilityBlocked(player) || isWaitlisted(player);
}

const TRUTHY = new Set(['true', 'yes', 'y', '1', 't', 'x']);

function isTruthy(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined) return false;
  return TRUTHY.has(String(value).trim().toLowerCase());
}

/**
 * Build a lookup of normalized division age bounds keyed by both id and
 * lowercased name.
 *
 * @param {Array<Object>|Object} divisions
 * @returns {{ list: Array<Object>, byKey: Map<string, Object> }}
 */
export function buildDivisionIndex(divisions) {
  const source = Array.isArray(divisions) ? divisions : Object.values(divisions ?? {});
  const list = source.map((division) => {
    const bounds = normalizeDivisionAgeBounds(division);
    return {
      ...bounds,
      gender: division?.gender_policy ?? division?.gender ?? parseGenderFromName(bounds.name),
      raw: division,
    };
  });

  const byKey = new Map();
  for (const entry of list) {
    if (entry.id !== undefined && entry.id !== null)
      byKey.set(String(entry.id).toLowerCase(), entry);
    if (entry.name) byKey.set(String(entry.name).toLowerCase(), entry);
  }
  return { list, byKey };
}

function resolveDivisionEntry(index, ref) {
  if (ref === undefined || ref === null || ref === '') return null;
  return index.byKey.get(String(ref).toLowerCase()) ?? null;
}

/**
 * Can a player registered in a division of gender `hint` play in one of gender `candidate`?
 * The same gender, or a division that is explicitly co-ed. A gender neither division states
 * cannot show a mismatch, so it is compatible: a girl registered in U12 Girls never goes to U10
 * Boys, but two divisions named only "U10" and "U12" are not judged on gender at all.
 */
function genderCompatible(candidate, hint) {
  const wanted = normalizeGender(hint);
  const offered = normalizeGender(candidate);
  if (!wanted || !offered) return true;
  return offered === 'coed' || offered === wanted;
}

/**
 * Find the division whose band naturally contains an age and whose gender is compatible with the
 * division the player registered in (`genderCompatible`), preferring the same gender to a co-ed
 * division. Null when none qualifies: the player is then listed as having no suitable division.
 *
 * @param {{ list: Array<Object> }} index
 * @param {number} naturalAge
 * @param {string} [genderHint] - the registered division's gender
 * @returns {Object|null}
 */
function findNaturalDivision(index, naturalAge, genderHint) {
  if (!Number.isFinite(naturalAge)) return null;
  const candidates = index.list.filter(
    (entry) =>
      entry.minAge !== null &&
      entry.maxAge !== null &&
      naturalAge >= entry.minAge &&
      naturalAge <= entry.maxAge &&
      genderCompatible(entry.gender, genderHint)
  );
  if (candidates.length === 0) return null;
  const same = candidates.find(
    (entry) => genderHint && normalizeGender(entry.gender) === normalizeGender(genderHint)
  );
  return same ?? candidates[0];
}

function normalizeGender(value) {
  const text = String(value ?? '').toLowerCase();
  if (text.startsWith('g') || text.includes('female') || text.includes('girl')) return 'girls';
  if (text.startsWith('b') || text.includes('male') || text.includes('boy')) return 'boys';
  if (text.includes('coed') || text.includes('both') || text.includes('mixed')) return 'coed';
  return text || null;
}

/**
 * Resolve a single player's natural age number from explicit value or DOB.
 *
 * The explicit value is the stored natural age (`players.natural_age`, admin-focus plan R5: the
 * birth date with the season's cutoff, else the age group the export states), which a generator
 * player carries as `naturalAge` when it has no birth date: no birth date is stored, and the
 * Teams page sends the import session's birth date, counted in the page's season, when a row has
 * one. Given both, the explicit value wins.
 *
 * @param {Object} player
 * @param {number} seasonYear
 * @param {string} [cutoffMode]
 * @param {{ cutoffMonth?: number|null, cutoffDay?: number|null, divisions?: Array<Object>|null }} [rule]
 *   the season's custom cutoff and its divisions (their birthdate windows), as the import counts
 *   an age (`importNaturalAge`): a birth date in a division's window takes that division's age
 * @returns {number|null}
 */
export function resolveNaturalAge(player, seasonYear, cutoffMode, rule = {}) {
  const explicit = player?.naturalAge ?? player?.natural_age ?? player?.ageNumber;
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    const num = Number(explicit);
    if (Number.isFinite(num)) return num;
  }
  const dob = player?.dob ?? player?.date_of_birth ?? player?.Birthdate ?? player?.birthdate;
  const standard = computeAgeNumber(dob, seasonYear, cutoffMode, {
    month: rule.cutoffMonth,
    day: rule.cutoffDay,
  });
  if (standard === null) return null;
  return windowedAgeNumber(dob, standard, rule.divisions) ?? standard;
}

function playerName(player) {
  if (typeof player?.name === 'string' && player.name.trim()) return player.name.trim();
  const full = `${player?.firstName ?? player?.first_name ?? ''} ${player?.lastName ?? player?.last_name ?? ''}`;
  return full.trim() || String(player?.id);
}

/**
 * What kind of play-up or play-down a listed player is (`diagnostics.listing[].kind`).
 * @typedef {'play-up' | 'play-down' | 'requested-own-division' | 'requested-age-unknown' | 'no-division'} PlayUpKind
 */

/**
 * One line of the Play-up section: a player an admin should know about, with the facts a
 * club's own rule needs. The app decides none of it.
 * @typedef {Object} PlayUpListing
 * @property {string} playerId
 * @property {string} name
 * @property {PlayUpKind} kind
 * @property {boolean} requested - `play_up_requested` is set on the player
 * @property {number|null} naturalAge
 * @property {string|null} registeredDivision - the division id the player registered in
 * @property {string|null} registeredDivisionName
 * @property {string|null} playedDivision - where the run seats them; null when no division can
 * @property {string|null} playedDivisionName
 * @property {string|null} coachId - the coach whose child they are (`coach_team_requests`), if any
 * @property {string|null} buddyId - their linked buddy, if any
 * @property {string|null} buddyName
 * @property {string|null} buddyDivision - where that buddy plays
 * @property {string|null} buddyDivisionName
 * @property {boolean|null} buddyInPlayedDivision - null with no buddy
 */

/** The listing's buddy columns for a buddy who plays in `buddyPlayed`, or none. */
function buddyFacts(buddy, buddyPlayed, playedDivision, nameOfDivision) {
  return {
    buddyId: buddy ? String(buddy.id) : null,
    buddyName: buddy ? playerName(buddy) : null,
    buddyDivision: buddy && buddyPlayed != null ? String(buddyPlayed) : null,
    buddyDivisionName: buddy && buddyPlayed != null ? nameOfDivision(buddyPlayed) : null,
    buddyInPlayedDivision:
      buddy && playedDivision != null && buddyPlayed != null
        ? String(buddyPlayed).toLowerCase() === String(playedDivision).toLowerCase()
        : buddy
          ? false
          : null,
  };
}

/**
 * Fill in the buddy columns of listing rows that had no buddy when the listing was built, from
 * the links the run finally holds. The listing is built before a honoured one-way request is
 * installed (and before a waitlist exception pairs two players), so a buddy the run does keep
 * would read "None". A row that already names a buddy is left as it was, even when the pair was
 * later told apart: that is the fact the admin needs. A player is also given the player whose
 * link points at them, since a one-way link is stored on the requester only.
 *
 * @param {PlayUpListing[]} listing
 * @param {Array<Object>} players - the final players (`division` is where each plays)
 * @param {Array<Object>|Object} divisions
 * @returns {PlayUpListing[]}
 */
export function withFinalBuddyFacts(listing, players, divisions) {
  const index = buildDivisionIndex(divisions);
  const nameOfDivision = (ref) => resolveDivisionEntry(index, ref)?.name ?? null;
  const byId = new Map(players.map((player) => [String(player.id), player]));
  /** @type {Map<string, Object>} */
  const claimedBy = new Map();
  for (const player of players) {
    const target = getCanonicalBuddyId(player);
    if (target !== undefined && !claimedBy.has(target)) claimedBy.set(target, player);
  }
  return listing.map((entry) => {
    if (entry.buddyId !== null) return entry;
    const player = byId.get(entry.playerId);
    const ownId = getCanonicalBuddyId(player);
    const buddy =
      (ownId !== undefined ? byId.get(ownId) : undefined) ?? claimedBy.get(entry.playerId);
    if (!buddy) return entry;
    return {
      ...entry,
      ...buddyFacts(buddy, buddy.division, entry.playedDivision, nameOfDivision),
    };
  });
}

/**
 * Apply play-up / play-down placement across a set of players and divisions. Give it every
 * division of the league and every player who may play in the run's division: a player's own
 * age division is looked up in `divisions`.
 *
 * Call it after coaches are linked and buddies resolved, so the listing's coach and buddy facts
 * are present (`teamingPipeline.js` does).
 *
 * @param {Object} params
 * @param {Array<Object>} params.players - each with id, division (registered), dob|naturalAge,
 *   `play_up_requested`, and the `coachId` and `buddyId` the pipeline gave them
 * @param {Array<Object>|Object} params.divisions
 * @param {number} params.seasonYear
 * @param {string} [params.cutoffMode]
 * @param {number|null} [params.cutoffMonth] - the season's custom cutoff month
 * @param {number|null} [params.cutoffDay] - and day
 * @returns {{ players: Array<Object>, diagnostics: { listing: PlayUpListing[], counts: Object } }}
 */
export function applyPlayUpEligibility({
  players,
  divisions,
  seasonYear,
  cutoffMode,
  cutoffMonth,
  cutoffDay,
}) {
  if (!Array.isArray(players)) throw new TypeError('players must be an array');
  const index = buildDivisionIndex(divisions);
  const rule = { cutoffMonth, cutoffDay, divisions: index.list.map((entry) => entry.raw) };
  const byId = new Map(players.map((player) => [String(player.id), player]));

  // Pass 1: where each player plays. Everyone plays in their own division unless they
  // requested to play up, and a request moves nobody out of the division they registered for.
  const decided = new Map();
  for (const player of players) {
    const naturalAge = resolveNaturalAge(player, seasonYear, cutoffMode, rule);
    const registered = resolveDivisionEntry(index, player.division);
    const raw = classifyPlacement(naturalAge, registered ?? { minAge: null, maxAge: null });
    const requested = isTruthy(player.playUpRequested ?? player.play_up_requested);

    /** @type {string} */
    let placement = PLACEMENT.UNKNOWN;
    let played = player.division;
    /** @type {PlayUpKind | null} */
    let kind = null;
    if (raw === 'in_band') {
      placement = PLACEMENT.IN_BAND;
      if (requested) kind = 'requested-own-division';
    } else if (raw === 'up' || raw === 'down') {
      placement = raw === 'up' ? PLACEMENT.PLAY_UP : PLACEMENT.PLAY_DOWN;
      kind = raw === 'up' ? 'play-up' : 'play-down';
      // A requested play-up stays where it registered; everything else goes to the player's
      // own age division, and a player no division can hold is blocked.
      if (!(raw === 'up' && requested)) {
        const own = findNaturalDivision(index, naturalAge, registered?.gender);
        if (own) {
          played = own.id;
        } else {
          placement = PLACEMENT.NO_DIVISION;
          kind = 'no-division';
        }
      }
    } else if (requested) {
      kind = 'requested-age-unknown';
    }
    decided.set(String(player.id), { naturalAge, requested, placement, played, kind });
  }

  const diagnostics = {
    listing: /** @type {PlayUpListing[]} */ ([]),
    counts: {
      inBand: 0,
      playUpRequested: 0,
      playUpUnrequested: 0,
      playDown: 0,
      noDivision: 0,
      unknown: 0,
    },
  };
  const nameOfDivision = (ref) => resolveDivisionEntry(index, ref)?.name ?? null;

  const resultPlayers = players.map((player) => {
    const info = decided.get(String(player.id));
    const { naturalAge, requested, placement, played, kind } = info;
    if (placement === PLACEMENT.IN_BAND) diagnostics.counts.inBand += 1;
    else if (placement === PLACEMENT.PLAY_UP) {
      diagnostics.counts[requested ? 'playUpRequested' : 'playUpUnrequested'] += 1;
    } else if (placement === PLACEMENT.PLAY_DOWN) diagnostics.counts.playDown += 1;
    else if (placement === PLACEMENT.NO_DIVISION) diagnostics.counts.noDivision += 1;
    else diagnostics.counts.unknown += 1;

    let reviewReason = null;
    if (kind !== null) {
      const buddyRaw = getCanonicalBuddyId(player);
      const buddy = buddyRaw ? byId.get(String(buddyRaw)) : undefined;
      const buddyPlayed = buddy ? decided.get(String(buddy.id)).played : null;
      const playedDivision = placement === PLACEMENT.NO_DIVISION ? null : played;
      reviewReason = {
        'play-up': requested
          ? 'play-up requested; plays in the division registered for'
          : 'play-up not requested; plays in their own age division',
        'play-down': 'registered in a younger division; plays in their own age division',
        'requested-own-division': 'play-up requested, but registered in their own division',
        'requested-age-unknown': 'play-up requested; natural age unknown, so nothing is checked',
        'no-division': `no suitable division holds natural age ${naturalAge}`,
      }[kind];
      diagnostics.listing.push({
        playerId: String(player.id),
        name: playerName(player),
        kind,
        requested,
        naturalAge: Number.isFinite(naturalAge) ? naturalAge : null,
        registeredDivision: player.division == null ? null : String(player.division),
        registeredDivisionName: nameOfDivision(player.division),
        playedDivision: playedDivision == null ? null : String(playedDivision),
        playedDivisionName: playedDivision == null ? null : nameOfDivision(playedDivision),
        coachId: player.coachId == null || player.coachId === '' ? null : String(player.coachId),
        ...buddyFacts(buddy, buddyPlayed, playedDivision, nameOfDivision),
      });
    }

    return {
      ...player,
      division: played,
      registeredDivision: player.division,
      naturalAge,
      placement,
      playUpRequested: requested,
      needsReview: kind !== null,
      reviewReason,
    };
  });

  return { players: resultPlayers, diagnostics };
}
