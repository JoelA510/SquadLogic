/**
 * Play-up and play-down, counted by the division a player is SEATED in (owner, 2026-11-03,
 * docs/changes/2026-11-03-play-down-default-and-flags.md, sections 4.1 and 4.2).
 *
 * A count is a number of a population, and a league has three: who registered where, who plays
 * where, and who asked for what. This module counts the second, the one generation seats by
 * (`applyPlayUpEligibility`), so an advised team count and the teams generation builds are counts
 * of the same players. It replaces `diagnostics.counts` on the placement, which counted by the
 * division REGISTERED in and which nothing but tests ever read.
 *
 * A seat is one registrant: where they registered, where they play (null when no division can
 * hold them: `isEligibilityBlocked`), the age they are judged by, whether a play-up was
 * requested, and whether they are on the waitlist. A count does not care how a seat was decided,
 * so the same function counts the placement before generation (`seatsFromPlacedPlayers`) and, the
 * same way, any other list of seats (the rosters a run saved).
 *
 * "Playing up" and "playing down" are properties of the seat: the age against the band of the
 * division played in (`classifyPlacement`, the primitive `applyPlayUpEligibility` uses). A player
 * moved to their own age division is therefore in band, and is counted as MOVED, not as playing up.
 *
 * Pure module: no React / Supabase imports.
 */

import { classifyPlacement } from './ageGroups.js';
import { buildDivisionIndex, isEligibilityBlocked, isWaitlisted } from './playUp.js';

/**
 * One registrant and where they play.
 * @typedef {Object} Seat
 * @property {string} playerId
 * @property {number|null} naturalAge - null when unknown
 * @property {string|null} registeredDivision - the division id (or name) registered in
 * @property {string|null} seatedDivision - where they play; null when no division can hold them
 * @property {boolean} requested - a play-up was requested
 * @property {boolean} waitlisted
 */

/**
 * What is counted, each a count of the players it says. Every registrant is in exactly one of
 * `seated`, `waitlisted` and `notEligible` (a player both waitlisted and not eligible is counted
 * once, as not eligible: lesson 87); the rest are overlays on that partition.
 *
 * @typedef {Object} SeatCounts
 * @property {number} seated - play here, not waitlisted: what generation can seat, the advice's
 *   player count
 * @property {number} waitlisted - play here, on the waitlist
 * @property {number} notEligible - registered here, and no division can hold their age
 * @property {number} playingUp - play here, in a division whose band is above their age (the
 *   waitlisted included, so every request is visible)
 * @property {number} playingDown - play here, in a division whose band is below their age
 * @property {number} askedToPlayUp - registered here and play here, asked to play up, and there is
 *   nothing to honour: in their own division, or the age (or the band) is unknown
 * @property {number} notChecked - play here, and the age or the division's band is unknown: nothing
 *   was compared, which is never read as "in band" (lesson 47)
 * @property {number} movedIn - registered in another division, play here
 * @property {number} movedOut - registered here, play in another division
 */

/** @returns {SeatCounts} */
function emptyCounts() {
  return {
    seated: 0,
    waitlisted: 0,
    notEligible: 0,
    playingUp: 0,
    playingDown: 0,
    askedToPlayUp: 0,
    notChecked: 0,
    movedIn: 0,
    movedOut: 0,
  };
}

/** Fields a program sums over its divisions. A move is added separately: only across programs. */
const SUMMED_FIELDS = Object.freeze([
  'seated',
  'waitlisted',
  'notEligible',
  'playingUp',
  'playingDown',
  'askedToPlayUp',
  'notChecked',
]);

function nonEmpty(value) {
  return value === undefined || value === null || value === '' ? null : String(value);
}

/**
 * Count seats by division, by program and for the league.
 *
 * `divisions` are the league's divisions, as `applyPlayUpEligibility` takes them: each with an id,
 * a band (`min_age`/`max_age`, else read from the name) and, optionally, the program it is in
 * (`program_id` or `programId`). A division is found by id or by name, in any case, as the
 * placement finds it. A division a seat names that is not listed is still counted, with no band
 * (nothing to check) and in no program: no seat is dropped. Every listed division has an entry,
 * with zeros when nobody plays or registered there.
 *
 * `byProgram` is keyed by program id, in the order a division of each first appears, with the
 * divisions in no program last under `null`. A program's counts are the sum over its divisions,
 * each player once; `movedIn` and `movedOut` count only moves ACROSS programs there (a move inside
 * one nets to zero). `league` is the sum over every division, so its moves are every player who
 * plays somewhere other than where they registered, once in and once out.
 *
 * The subject set is the seats given, one count each, so the caller must list every registrant:
 * a seat that is not listed is not counted. A player named in two seats, or a seat with neither a
 * registered nor a seated division, is refused rather than guessed at.
 *
 * @param {Object} params
 * @param {Array<Seat>} params.seats
 * @param {Array<Object>|Object} [params.divisions]
 * @returns {{
 *   byDivision: Map<string, SeatCounts>,
 *   byProgram: Map<string|null, SeatCounts>,
 *   league: SeatCounts,
 * }}
 */
export function summarizeSeats({ seats, divisions = [] }) {
  if (!Array.isArray(seats)) throw new TypeError('seats must be an array');
  const index = buildDivisionIndex(divisions);
  // A listed id wins exactly as written, so two divisions whose ids differ only in case stay two;
  // any other reference is found by id or name, in any case, as the placement finds it.
  const exact = new Map(index.list.map((entry) => [String(entry.id), entry]));
  const entryOf = (ref) =>
    exact.get(String(ref)) ?? index.byKey.get(String(ref).toLowerCase()) ?? null;
  const keyOf = (ref) => {
    const entry = entryOf(ref);
    return entry ? String(entry.id) : String(ref);
  };

  /** @type {Map<string, string|null>} division key -> the program it is in */
  const programOfKey = new Map();
  /** @type {Map<string, SeatCounts>} */
  const byDivision = new Map();
  for (const entry of index.list) {
    const key = String(entry.id);
    programOfKey.set(key, nonEmpty(entry.raw?.program_id ?? entry.raw?.programId));
    byDivision.set(key, emptyCounts());
  }
  const division = (key) => {
    let counts = byDivision.get(key);
    if (!counts) {
      counts = emptyCounts();
      byDivision.set(key, counts);
      programOfKey.set(key, null);
    }
    return counts;
  };
  const programOf = (key) => programOfKey.get(key) ?? null;

  const league = emptyCounts();
  /** @type {Array<[string, string]>} [registered, seated] of each move, for the program level */
  const moves = [];
  const bump = (key, field) => {
    division(key)[field] += 1;
    league[field] += 1;
  };

  const seen = new Set();
  for (const seat of seats) {
    if (seat === null || typeof seat !== 'object' || nonEmpty(seat.playerId) === null) {
      throw new TypeError('every seat needs a playerId');
    }
    const playerId = String(seat.playerId);
    if (seen.has(playerId)) throw new Error(`more than one seat for player "${playerId}"`);
    seen.add(playerId);

    const registeredRef = nonEmpty(seat.registeredDivision);
    const seatedRef = nonEmpty(seat.seatedDivision);
    if (registeredRef === null && seatedRef === null) {
      throw new Error(
        `seat for player "${playerId}" has neither a registered nor a seated division`
      );
    }
    const registeredKey = registeredRef === null ? null : keyOf(registeredRef);

    if (seatedRef === null) {
      // No division can hold them: they are in the division they registered in, held out, once.
      bump(/** @type {string} */ (registeredKey), 'notEligible');
      continue;
    }

    const seatedKey = keyOf(seatedRef);
    const naturalAge = Number.isFinite(seat.naturalAge) ? seat.naturalAge : null;
    // The seat's own band, never the registration's: the point of counting by the division played.
    const verdict = classifyPlacement(
      /** @type {number} */ (naturalAge),
      entryOf(seatedRef) ?? { minAge: null, maxAge: null }
    );
    bump(seatedKey, seat.waitlisted === true ? 'waitlisted' : 'seated');
    if (verdict === 'up') bump(seatedKey, 'playingUp');
    else if (verdict === 'down') bump(seatedKey, 'playingDown');
    else if (verdict === 'unknown') bump(seatedKey, 'notChecked');

    if (registeredKey !== null && registeredKey !== seatedKey) {
      division(seatedKey).movedIn += 1;
      division(registeredKey).movedOut += 1;
      league.movedIn += 1;
      league.movedOut += 1;
      moves.push([registeredKey, seatedKey]);
    } else if (seat.requested === true && (verdict === 'in_band' || verdict === 'unknown')) {
      // A request with nothing to honour, registered where they play: its own line, never a play-up.
      bump(seatedKey, 'askedToPlayUp');
    }
  }

  /** @type {Map<string|null, SeatCounts>} */
  const byProgram = new Map();
  const programKeys = [];
  for (const key of byDivision.keys()) {
    const program = programOf(key);
    if (program !== null && !programKeys.includes(program)) programKeys.push(program);
  }
  const hasUngrouped = [...byDivision.keys()].some((key) => programOf(key) === null);
  for (const program of hasUngrouped ? [...programKeys, null] : programKeys) {
    byProgram.set(program, emptyCounts());
  }
  for (const [key, counts] of byDivision) {
    const target = /** @type {SeatCounts} */ (byProgram.get(programOf(key)));
    for (const field of SUMMED_FIELDS) target[field] += counts[field];
  }
  for (const [from, to] of moves) {
    if (programOf(from) === programOf(to)) continue;
    /** @type {SeatCounts} */ (byProgram.get(programOf(to))).movedIn += 1;
    /** @type {SeatCounts} */ (byProgram.get(programOf(from))).movedOut += 1;
  }

  return { byDivision, byProgram, league };
}

/**
 * One seat for every player the placement returned, in order: where each registered, where each
 * plays (null for a player no division can hold), the age they were judged by, the request and the
 * waitlist. Enumerated from the players, so a held-back player (waitlisted, not eligible) has a
 * seat like any other and cannot vanish from a count. A player nobody has placed (no
 * `registeredDivision`) is seated where they registered.
 *
 * @param {Array<Object>} players - generator players, as `applyPlayUpEligibility` returns them
 * @returns {Array<Seat>}
 */
export function seatsFromPlacedPlayers(players) {
  if (!Array.isArray(players)) throw new TypeError('players must be an array');
  return players.map((player) => ({
    playerId: String(player.id),
    naturalAge: Number.isFinite(player.naturalAge) ? player.naturalAge : null,
    registeredDivision: nonEmpty(player.registeredDivision ?? player.division),
    seatedDivision: isEligibilityBlocked(player) ? null : nonEmpty(player.division),
    requested: player.playUpRequested === true || player.play_up_requested === true,
    waitlisted: isWaitlisted(player),
  }));
}
