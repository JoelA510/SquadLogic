/**
 * How the schedule reports tell one game from another: the one place that decides.
 *
 * `persist_game_schedule` keys a game on the TUPLE (home team, away team, game slot, week) and writes no id
 * (lesson 95), so a game moved to another slot or week is a new row, and anything keyed by `game_assignments.id`
 * (the Published flag, its audit rows) stays with the old one. The reports therefore compare games by this tuple and
 * never by an id. If the owner decides on an identity layer (the F11 plan), this is the function to change, and
 * nothing else in `reports/` names a game's key.
 *
 * A key with a part missing is `null`, and a `null` key matches nothing: a game that cannot be keyed is listed, not
 * paired with another by accident.
 *
 * @module reports/gameKey
 */

/** An id as text, lower case (the database compares uuids that way), or `null` when there is none. @param {unknown} value */
const idPart = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase();
  return text === '' ? null : text;
};

/** A week index: a positive whole number, or `null`. @param {unknown} value */
const weekPart = (value) => {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const week = Number(value);
  return Number.isInteger(week) && week > 0 ? week : null;
};

/**
 * The key of a placed game.
 *
 * @param {Record<string, any> | null | undefined} game - a saved row or a baseline game: only the four parts are read
 * @returns {string | null}
 */
export function gameKey(game) {
  if (!game || typeof game !== 'object') return null;
  const home = idPart(game.homeTeamId);
  const away = idPart(game.awayTeamId);
  const slot = idPart(game.slotId ?? game.gameSlotId);
  const week = weekPart(game.weekIndex);
  if (home === null || away === null || slot === null || week === null) return null;
  return `${home}|${away}|${slot}|${week}`;
}

/**
 * The key of a game with no slot (on the TIME TBD list): its teams and its week. Apart from every placed game's key.
 *
 * @param {Record<string, any> | null | undefined} game
 * @returns {string | null}
 */
export function tbdGameKey(game) {
  if (!game || typeof game !== 'object') return null;
  const home = idPart(game.homeTeamId);
  const away = idPart(game.awayTeamId);
  const week = weekPart(game.weekIndex);
  if (home === null || away === null || week === null) return null;
  return `tbd|${home}|${away}|${week}`;
}
