/**
 * The test oracle for the game save's omission check (`persist_game_schedule`, migrations 20261119010000 and
 * 20261120010000): which Published saved games a save would leave out. A TEST HELPER: nothing in the app calls it (the
 * Games page sends the games and the database decides; F11-3 task C7 moved it out of `@squadlogic/core/gamePublished.js`,
 * which had no shipped caller of it). It is used as the oracle of what a regeneration must carry, and its own cases are
 * `tests/publishedOmissions.test.js`.
 */
import { changedPublishedFields } from '../../packages/core/src/gamePublished.js';

const CAMEL = Object.freeze({
  game_slot_id: 'gameSlotId',
  slot_id: 'slotId',
  home_team_id: 'homeTeamId',
  away_team_id: 'awayTeamId',
  week_index: 'weekIndex',
});
const read = (row, field) => {
  const value = row?.[field] ?? row?.[CAMEL[field]];
  return value === undefined ? null : value;
};

/** Whether a change to a saved game is one the Published guard refuses (the trigger's column test). */
export function changesPublishedPlacement(before, after) {
  return changedPublishedFields(before, after).length > 0;
}

// The matchup key, or null when a part is missing: as in SQL, a NULL part matches nothing (NULL = NULL is not true).
const keyOf = (row) => {
  const parts = [
    read(row, 'home_team_id'),
    read(row, 'away_team_id'),
    read(row, 'game_slot_id') ?? read(row, 'slot_id'),
    read(row, 'week_index'),
  ];
  if (parts.some((part) => part === null || part === '')) return null;
  return parts.map((part) => String(part).toLowerCase()).join('|');
};

/**
 * The Published saved games a save would leave out: the twin of the check in `persist_game_schedule`. A save carries
 * every Published game of its season, unchanged; a game it leaves out is not deleted but orphaned in an older run and
 * gone from the page. A game is carried when its matchup tuple (home, away, slot, week) OR its `id` is in the payload
 * (the save updates a game in place when an assignment names it by id; a payload row without one is upserted on the
 * tuple).
 *
 * `saved` is the set the save is about: the caller scopes it to the season (the database scopes by the home team's
 * division's season, or by the organization's seasons that are not completed when the run names no season). Only a
 * game a save can carry is an omission, as in the database: a row with an incomplete key is not listed (no save could
 * carry it; the guard trigger still holds it), and a game of a completed season, which is read-only, is the caller's
 * to leave out.
 *
 * @param {Array<Record<string, any>>} saved - saved games (`published` true marks the guarded ones)
 * @param {Array<Record<string, any>>} payload - the games the save carries
 * @returns {Array<Record<string, any>>} the omitted Published games, in id order
 */
export function publishedOmissions(saved, payload) {
  const carried = new Set((payload ?? []).map(keyOf).filter((key) => key !== null));
  // 20261120010000: a game is carried if its id OR its tuple is in the payload (an assignment that names a saved game by
  // id continues it wherever it is sent; the guard then judges the move).
  const carriedIds = new Set(
    (payload ?? [])
      .map((row) => row?.id)
      .filter((id) => typeof id === 'string' && id !== '')
      .map((id) => id.toLowerCase())
  );
  return (saved ?? [])
    .filter((row) => {
      if (row?.published !== true) return false;
      if (typeof row.id === 'string' && carriedIds.has(row.id.toLowerCase())) return false;
      const key = keyOf(row);
      return key !== null && !carried.has(key);
    })
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}
