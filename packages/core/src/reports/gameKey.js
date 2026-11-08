/**
 * How the schedule reports tell one game from another: the one place that decides.
 *
 * A game is identified by its MATCHUP TUPLE (home team, away team, game slot, week), and by nothing else. That is how
 * `persist_game_schedule` upserts a game (it writes no id from the save, lesson 95), and it is also all a baseline can
 * be compared by: a publication baseline is the master export's rows, which carry each game's teams, slot and week
 * and not which game is which. So the tuple stays the comparison key even if the owner's identity layer (the F11
 * plan) gives a moved game its id: a baseline cannot be keyed by an id it never stored. If the layer changes what
 * identifies a game on the saved side, this is the function to look at, and nothing else in `reports/` names a key.
 *
 * A key with a part missing is `null`, and a `null` key matches nothing: a game that cannot be keyed is listed, not
 * paired with another by accident. A week is a positive whole number (`positiveWeek`): a null, a zero or a fraction
 * is no week, and is never turned into one.
 *
 * @module reports/gameKey
 */

/** An id as text, lower case (the database compares uuids that way), or `null` when there is none. @param {unknown} value */
const idPart = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase();
  return text === '' ? null : text;
};

/**
 * A week index: a positive whole number, or `null`. `Number(null)` is 0 and `Number('')` is 0, neither a week, so a
 * missing week is `null` here and nowhere is it read as a number first.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function positiveWeek(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const week = Number(value);
  return Number.isInteger(week) && week > 0 ? week : null;
}

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
  const week = positiveWeek(game.weekIndex);
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
  const week = positiveWeek(game.weekIndex);
  if (home === null || away === null || week === null) return null;
  return `tbd|${home}|${away}|${week}`;
}
