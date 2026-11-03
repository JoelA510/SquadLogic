/**
 * The roster editor's list of who is playing up or down on the rosters it shows (play-down plan,
 * 2026-11-03, PR 2, section 4.7). It is the one place a manual move can put a player on a team of
 * another division, so it counts the SEATS on the rosters, by the division each team belongs to, with
 * `summarizeSeats`: the same function that counts the file's seats before generation and a run's listing
 * after it, so the three cannot disagree about who is playing up.
 *
 * What it reads is what production has. A team row has no age band (the `teams` table has no age
 * column), so a seat is judged by the SAVED band of the team's division (`divisions.min_age/max_age`,
 * else the name's), and by the player's stored natural age and play-up request (`players`). It never
 * reads `team.minAge`, `team.maxAge`, or an age the page invented. An age the record does not have, and a
 * division with no band, are "not checked", never "in band" (lesson 47).
 *
 * These are flags: nothing here approves or refuses a move.
 *
 * Pure; the words are here, the markup is `RosterAgeFlags.jsx`.
 */
import { summarizeSeats } from '@squadlogic/core/playUpSeats.js';
import { normalizeDivisionAgeBounds } from '@squadlogic/core/ageGroups.js';
import { NOT_CHECKED_REASON } from './seatNotes.js';

const UNKNOWN_DIVISION = 'Unknown division';
const UNKNOWN_PLAYER = 'Unknown Player';

/**
 * @typedef {Object} RosterFlag
 * @property {string} playerId
 * @property {'up' | 'down' | 'unknown'} verdict
 * @property {string} label - "Playing up", "Playing down" or "Not checked"
 * @property {string} detail - the sentence after the label
 * @property {string} text - label and detail together
 * @property {string} playerName
 * @property {string} teamName
 * @property {string} divisionName
 */

const lower = (value) => String(value).trim().toLowerCase();
const present = (value) => value !== undefined && value !== null && String(value).trim() !== '';

/** "age 10" for a band of one age, "ages 11 to 12" otherwise. */
function bandWords(min, max) {
  return min === max ? `age ${min}` : `ages ${min} to ${max}`;
}

/**
 * @param {Array<Object>} divisions - the season's divisions, each with an id, a name and its band
 */
function indexDivisions(divisions) {
  /** @type {Map<string, Object>} */
  const byKey = new Map();
  for (const division of divisions) {
    if (present(division?.id)) byKey.set(lower(division.id), division);
    if (present(division?.name)) byKey.set(lower(division.name), division);
  }
  return byKey;
}

/**
 * The reference a team's seat is counted under: the team's division by id when the season lists it,
 * else by the division name the team carries, else whatever it names. A team that names none is an
 * unknown division, which is counted ("not checked") and not dropped.
 * @param {any} team
 * @param {Map<string, Object>} byKey
 */
function divisionRefOf(team, byKey) {
  const refs = [team?.divisionId, team?.division_id, team?.division].filter(present).map(String);
  return refs.find((ref) => byKey.has(lower(ref))) ?? refs[0] ?? UNKNOWN_DIVISION;
}

/**
 * Who is playing up, playing down or not checked on these rosters.
 *
 * @param {Object} params
 * @param {Array<any>} params.teams - the editor's teams, each with its `players`, and the division it
 *   belongs to as `divisionId` (the `division_id` of its row) and/or `division`
 * @param {Array<Object>} params.divisions - the season's divisions as the page read them
 * @returns {{ counts: { playingUp: number, playingDown: number, notChecked: number },
 *   entries: RosterFlag[] }}
 */
export function rosterAgeFlags({ teams, divisions }) {
  const byKey = indexDivisions(divisions);
  /** @type {Map<string, { player: any, team: any }>} */
  const placed = new Map();
  const seats = [];
  for (const team of teams ?? []) {
    if (!team) continue;
    const seatedDivision = divisionRefOf(team, byKey);
    for (const player of team.players ?? []) {
      if (!player || !present(player.id) || placed.has(String(player.id))) continue;
      placed.set(String(player.id), { player, team });
      seats.push({
        playerId: String(player.id),
        naturalAge: Number.isFinite(player.naturalAge) ? player.naturalAge : null,
        // A roster does not say where a player registered: nobody is "moved" here.
        registeredDivision: null,
        seatedDivision,
        requested: player.playUpRequested === true,
        waitlisted: false,
      });
    }
  }
  const { league, flagged } = summarizeSeats({ seats, divisions });
  const entries = flagged.map((seat) => {
    const { player, team } = /** @type {{ player: any, team: any }} */ (placed.get(seat.playerId));
    const division = byKey.get(lower(seat.seatedDivision));
    const divisionName = String(division?.name ?? team.division ?? seat.seatedDivision);
    const playerName = present(player.name) ? String(player.name) : UNKNOWN_PLAYER;
    const teamName = present(team.name) ? String(team.name) : 'a team';
    const where = `${playerName} (natural age ${seat.naturalAge}) is on ${teamName} in ${divisionName}`;
    const bounds = division ? normalizeDivisionAgeBounds(division) : null;
    const band =
      bounds && bounds.minAge !== null && bounds.maxAge !== null
        ? `a division for ${bandWords(bounds.minAge, bounds.maxAge)}`
        : null;
    let label;
    let detail;
    if (seat.verdict === 'up') {
      label = 'Playing up';
      detail = `${where}, ${band}. ${
        seat.requested ? 'A play-up was requested.' : 'No play-up request is on file.'
      }`;
    } else if (seat.verdict === 'down') {
      label = 'Playing down';
      detail = `${where}, ${band}.`;
    } else if (seat.naturalAge === null) {
      label = 'Not checked';
      detail = `${playerName} has no natural age on file, so nothing can be compared with ${divisionName} (${NOT_CHECKED_REASON}).`;
    } else {
      label = 'Not checked';
      detail = `${divisionName} has no age band, so ${playerName} (natural age ${seat.naturalAge}) cannot be compared with it (${NOT_CHECKED_REASON}).`;
    }
    return {
      playerId: seat.playerId,
      verdict: seat.verdict,
      label,
      detail,
      text: `${label}: ${detail}`,
      playerName,
      teamName,
      divisionName,
    };
  });
  return {
    counts: {
      playingUp: league.playingUp,
      playingDown: league.playingDown,
      notChecked: league.notChecked,
    },
    entries,
  };
}

/** What a flag says a player is, for a sentence: "playing up", "playing down" or "not checked". */
export function flagWords(verdict) {
  return verdict === 'up' ? 'playing up' : verdict === 'down' ? 'playing down' : 'not checked';
}

/**
 * What changed for one player when a move put the rosters in a new state, for the editor's announcement:
 * "Pia is now playing up." / "Pia is no longer playing up." / '' when nothing about them was flagged
 * before or after.
 * @param {RosterFlag[]} before
 * @param {RosterFlag[]} after
 * @param {string | number} playerId
 * @param {string} playerName
 */
export function moveFlagNote(before, after, playerId, playerName) {
  const id = String(playerId);
  const was = before.find((entry) => entry.playerId === id);
  const now = after.find((entry) => entry.playerId === id);
  if (now) return `${playerName} is now ${flagWords(now.verdict)}.`;
  if (was) return `${playerName} is no longer ${flagWords(was.verdict)}.`;
  return '';
}
