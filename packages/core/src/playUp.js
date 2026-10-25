/**
 * Play-up / play-down eligibility for SquadLogic teaming.
 *
 * Pilot rule (the pilot club):
 *   - A player MAY play up a division (into an older band) ONLY when sanctioned:
 *       (A) their parent is coaching that older division (coach-child), or
 *       (B) they are buddied with a player who legitimately belongs to that
 *           older division (e.g. a coach's child).
 *   - No player may play DOWN (into a younger band) — ever.
 *
 * GotSport registers a play-up child directly in the older program, so this
 * layer mainly (1) validates that an out-of-band placement is sanctioned,
 * (2) emits diagnostics, and (3) when run across multiple divisions, remaps
 * blocked players back to their natural division so the generator never seats
 * an illegal placement.
 *
 * Pure module — no React / Supabase imports.
 */

import {
  classifyPlacement,
  computeAgeNumber,
  normalizeDivisionAgeBounds,
  parseGenderFromName,
} from './ageGroups.js';

export const PLACEMENT = Object.freeze({
  IN_BAND: 'in_band',
  PLAY_UP_SANCTIONED: 'play_up_sanctioned',
  PLAY_UP_BLOCKED: 'play_up_blocked',
  PLAY_DOWN_BLOCKED: 'play_down_blocked',
  UNKNOWN: 'unknown',
});

/** The placements that keep a player off every roster; `unknown` flags, never blocks. */
const BLOCKING_PLACEMENTS = new Set(
  /** @type {string[]} */ ([PLACEMENT.PLAY_UP_BLOCKED, PLACEMENT.PLAY_DOWN_BLOCKED])
);

/**
 * Is a player's placement one the generator must not seat (Phase B2)? Only an unsanctioned
 * play-up or a play-down, as `applyPlayUpEligibility` annotates them, while the player is still
 * in the division the placement was judged against. A player `remapBlocked` moved to their
 * natural division (`division` no longer their `registeredDivision`) is in-band there and is not
 * blocked. A player with no natural age, or no annotation at all, is not blocked (owner
 * decision 3).
 *
 * @param {any} player - a generator player (`placement` from `applyPlayUpEligibility`)
 * @returns {boolean}
 */
export function isEligibilityBlocked(player) {
  if (!BLOCKING_PLACEMENTS.has(player?.placement)) return false;
  const registered = player.registeredDivision;
  return (
    registered === undefined ||
    registered === null ||
    String(registered) === String(player.division)
  );
}

const TRUTHY = new Set(['true', 'yes', 'y', '1', 't']);

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
 * Find the division whose band naturally contains an age, preferring a gender
 * match when a hint is provided.
 *
 * @param {{ list: Array<Object> }} index
 * @param {number} naturalAge
 * @param {string} [genderHint]
 * @returns {Object|null}
 */
function findNaturalDivision(index, naturalAge, genderHint) {
  if (!Number.isFinite(naturalAge)) return null;
  const candidates = index.list.filter(
    (entry) =>
      entry.minAge !== null &&
      entry.maxAge !== null &&
      naturalAge >= entry.minAge &&
      naturalAge <= entry.maxAge
  );
  if (candidates.length === 0) return null;
  if (genderHint) {
    const matched = candidates.find(
      (entry) => normalizeGender(entry.gender) === normalizeGender(genderHint)
    );
    if (matched) return matched;
  }
  return candidates[0];
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
 * @returns {number|null}
 */
export function resolveNaturalAge(player, seasonYear, cutoffMode) {
  const explicit = player?.naturalAge ?? player?.natural_age ?? player?.ageNumber;
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    const num = Number(explicit);
    if (Number.isFinite(num)) return num;
  }
  return computeAgeNumber(
    player?.dob ?? player?.date_of_birth ?? player?.Birthdate ?? player?.birthdate,
    seasonYear,
    cutoffMode
  );
}

/**
 * Apply play-up / play-down rules across a set of players and divisions.
 *
 * @param {Object} params
 * @param {Array<Object>} params.players - each with id, division (registered),
 *   dob|naturalAge, buddyId?, and a coach-child / play-up signal.
 * @param {Array<Object>|Object} params.divisions
 * @param {number} params.seasonYear
 * @param {string} [params.cutoffMode]
 * @param {boolean} [params.remapBlocked=true] - when true, illegal placements
 *   are moved to the player's natural division (if resolvable).
 * @returns {{ players: Array<Object>, diagnostics: Object }}
 */
export function applyPlayUpEligibility({
  players,
  divisions,
  seasonYear,
  cutoffMode,
  remapBlocked = true,
}) {
  if (!Array.isArray(players)) throw new TypeError('players must be an array');
  const index = buildDivisionIndex(divisions);
  const byId = new Map(players.map((player) => [String(player.id), player]));

  // Pass 1: natural age, registered bounds, raw up/down classification, and
  // whether the player is legitimately in-band (used for buddy sanctioning).
  const pass1 = new Map();
  for (const player of players) {
    const naturalAge = resolveNaturalAge(player, seasonYear, cutoffMode);
    const registered = resolveDivisionEntry(index, player.division);
    const bounds = registered ?? { minAge: null, maxAge: null };
    const rawPlacement = classifyPlacement(naturalAge, bounds);
    const isCoachChild = isTruthy(
      player.isCoachChild ?? player.coach_child ?? player.parentCoaches
    );
    pass1.set(String(player.id), {
      naturalAge,
      registered,
      rawPlacement, // 'in_band' | 'up' | 'down' | 'unknown'
      isCoachChild,
      legitInRegistered: rawPlacement === 'in_band',
    });
  }

  const diagnostics = {
    sanctionedPlayUps: [],
    blockedPlayUps: [],
    blockedPlayDowns: [],
    unresolved: [],
    counts: { inBand: 0, playUpSanctioned: 0, playUpBlocked: 0, playDownBlocked: 0, unknown: 0 },
  };

  const resultPlayers = players.map((player) => {
    const info = pass1.get(String(player.id));
    const { naturalAge, registered, rawPlacement, isCoachChild } = info;
    const genderHint = registered ? registered.gender : null;

    /** @type {string} */
    let placement = PLACEMENT.UNKNOWN;
    let sanctioned = false;
    let needsReview = false;
    /** @type {string|null} */
    let reviewReason = null;
    let effectiveDivision = player.division;

    if (rawPlacement === 'in_band') {
      placement = PLACEMENT.IN_BAND;
      diagnostics.counts.inBand += 1;
    } else if (rawPlacement === 'up') {
      // Route A: parent coaches this (older) division.
      // Route B: buddied with a COACH'S CHILD who legitimately belongs to this
      // division (a coach child is sanctioned to be there; an in-band non-coach
      // buddy does not, by itself, sanction a play-up).
      let buddySanction = false;
      if (player.buddyId) {
        const buddy = byId.get(String(player.buddyId));
        const buddyInfo = buddy ? pass1.get(String(buddy.id)) : null;
        if (
          buddy &&
          buddyInfo &&
          String(buddy.division).toLowerCase() === String(player.division).toLowerCase() &&
          buddyInfo.isCoachChild &&
          buddyInfo.rawPlacement !== 'down'
        ) {
          buddySanction = true;
        }
      }
      sanctioned = isCoachChild || buddySanction;
      if (sanctioned) {
        placement = PLACEMENT.PLAY_UP_SANCTIONED;
        diagnostics.counts.playUpSanctioned += 1;
        diagnostics.sanctionedPlayUps.push({
          id: player.id,
          division: player.division,
          via: isCoachChild ? 'coach-child' : 'buddy',
          naturalAge,
        });
      } else {
        placement = PLACEMENT.PLAY_UP_BLOCKED;
        diagnostics.counts.playUpBlocked += 1;
        needsReview = true;
        reviewReason = 'unsanctioned play-up (no coaching parent or qualifying buddy)';
        const natural = findNaturalDivision(index, naturalAge, genderHint);
        if (remapBlocked && natural) {
          effectiveDivision = natural.id;
        } else {
          diagnostics.unresolved.push({ id: player.id, reason: 'no natural division found' });
        }
        diagnostics.blockedPlayUps.push({
          id: player.id,
          from: player.division,
          to: remapBlocked && natural ? natural.id : null,
          reason: reviewReason,
        });
      }
    } else if (rawPlacement === 'down') {
      placement = PLACEMENT.PLAY_DOWN_BLOCKED;
      diagnostics.counts.playDownBlocked += 1;
      needsReview = true;
      reviewReason = 'play-down is not permitted';
      const natural = findNaturalDivision(index, naturalAge, genderHint);
      if (remapBlocked && natural) {
        effectiveDivision = natural.id;
      } else {
        diagnostics.unresolved.push({ id: player.id, reason: 'no natural division found' });
      }
      diagnostics.blockedPlayDowns.push({
        id: player.id,
        from: player.division,
        to: remapBlocked && natural ? natural.id : null,
        reason: reviewReason,
      });
    } else {
      diagnostics.counts.unknown += 1;
    }

    return {
      ...player,
      division: effectiveDivision,
      registeredDivision: player.division,
      naturalAge,
      placement,
      playUpSanctioned: sanctioned,
      needsReview,
      reviewReason,
    };
  });

  return { players: resultPlayers, diagnostics };
}

/**
 * Lightweight single-player classifier for UI/conflict checks.
 *
 * @param {Object} params
 * @param {number} params.naturalAge
 * @param {{minAge:number|null,maxAge:number|null}} params.bounds
 * @param {boolean} [params.sanctioned]
 * @returns {string} a PLACEMENT value
 */
export function classifyPlayerPlacement({ naturalAge, bounds, sanctioned = false }) {
  const raw = classifyPlacement(naturalAge, bounds);
  if (raw === 'in_band') return PLACEMENT.IN_BAND;
  if (raw === 'up') return sanctioned ? PLACEMENT.PLAY_UP_SANCTIONED : PLACEMENT.PLAY_UP_BLOCKED;
  if (raw === 'down') return PLACEMENT.PLAY_DOWN_BLOCKED;
  return PLACEMENT.UNKNOWN;
}
