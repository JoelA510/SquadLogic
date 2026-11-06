/**
 * The Games page's view of the Published switch (plan `docs/changes/2026-11-03-schedule-expansion.md`, 3.4 and 3.6,
 * PR 3): which state a saved game is in, how many of each, and which games a bulk scope names.
 *
 * Pure, so the page, the bar, the dialog and their tests share one rule. The database is the authority
 * (`admin_set_games_published`, the guard trigger); this module only decides what the screen offers and counts.
 *
 * **The subject set is the saved set.** Every function here takes the games of the loaded saved schedule
 * (`game.assignments` of `useDashboardData`, one per `game_assignments` row of the latest run) and never a filtered
 * view of it: a scope that read the filtered list would publish a smaller set than the count promised (lesson 92, and
 * the plant of PR 3). The page passes one array to the bar and a different, filtered one to the list.
 *
 * **Identity.** A game is its row: `persist_game_schedule` keys on (home, away, slot, week) and writes no id, so a
 * game moved to another slot or week is a NEW row that starts not Published (lesson 95). Nothing here pretends a flag
 * follows a move; the screen says so (see `movedGameNote` in `gamePublishedText.js`).
 *
 * @module gamePublishedScope
 */

import { splitGameIds } from '@squadlogic/core/gamePublished.js';

/**
 * Where a saved game stands:
 * - `unsaved`: a game of a staged review that has no row yet (no switch: "Apply the schedule first");
 * - `published`: the flag is on, so the guard holds it where it is;
 * - `changes-allowed`: the flag is off after having been on (`published_at` is kept when it is turned off), so an
 *   admin deliberately allowed changes and nobody has published it again;
 * - `not-published`: never published.
 *
 * Camel and snake spellings of the row are both read: the page's saved games are camel-cased by the hook, a row
 * straight from the database is not.
 *
 * @param {Record<string, any> | null | undefined} game
 * @returns {'unsaved' | 'published' | 'changes-allowed' | 'not-published'}
 */
export function publishedStateOf(game) {
  if (!game || game.persisted === false || !game.id) return 'unsaved';
  if (game.published === true) return 'published';
  if (game.publishedAt ?? game.published_at) return 'changes-allowed';
  return 'not-published';
}

/** The words the screen says for each state, never colour alone. */
export const PUBLISHED_STATE_WORDS = Object.freeze({
  unsaved: 'Apply the schedule first',
  published: 'Published',
  'changes-allowed': 'Changes allowed',
  'not-published': 'Not published',
});

/** The list's filter choices. `all` shows every saved game. */
export const PUBLISHED_FILTERS = Object.freeze([
  Object.freeze({ id: 'all', label: 'All games' }),
  Object.freeze({ id: 'published', label: 'Published' }),
  Object.freeze({ id: 'changes-allowed', label: 'Changes allowed' }),
  Object.freeze({ id: 'not-published', label: 'Not published' }),
]);

/**
 * The games a list filter keeps. A filter shapes what is LISTED; it is never an input to a bulk scope.
 *
 * @template {Record<string, any>} T
 * @param {T[]} games
 * @param {string} filterId - one of {@link PUBLISHED_FILTERS}
 * @returns {T[]}
 */
export function filterByPublishedState(games, filterId) {
  if (filterId === 'all' || !PUBLISHED_FILTERS.some((filter) => filter.id === filterId)) {
    return games;
  }
  return games.filter((game) => publishedStateOf(game) === filterId);
}

/**
 * How many saved games are in each state. `notPublished` is everything that is not Published (it includes the games
 * with changes allowed), the population "Publish" can act on.
 *
 * @param {Array<Record<string, any>>} saved
 */
export function publishedCounts(saved) {
  let published = 0;
  let changesAllowed = 0;
  for (const game of saved) {
    const state = publishedStateOf(game);
    if (state === 'published') published += 1;
    else if (state === 'changes-allowed') changesAllowed += 1;
  }
  return {
    total: saved.length,
    published,
    changesAllowed,
    notPublished: saved.length - published,
  };
}

const plural = (count, one, many) => (count === 1 ? one : many);

/**
 * The persistent line. It says what the numbers are a count of (the saved games of the loaded schedule), and that a
 * game with changes allowed is a separate number, so a forgotten one shows (owner decision 11).
 *
 * @param {{ total: number, published: number, changesAllowed: number }} counts
 */
export function describePublishedCounts({ total, published, changesAllowed }) {
  return (
    `${published} of ${total} saved ${plural(total, 'game', 'games')} Published, ` +
    `${changesAllowed} with changes allowed`
  );
}

const zoneFormats = new Map();

/**
 * The calendar date of an instant on a clock, `YYYY-MM-DD`. The date scope is a date on the season's clock, not the
 * browser's. Null for an instant that does not read or a zone that does not exist, never a guess.
 *
 * @param {unknown} instant
 * @param {string | null | undefined} timeZone
 * @returns {string | null}
 */
export function dateKeyInZone(instant, timeZone) {
  if (!instant || !timeZone) return null;
  const at = Date.parse(String(instant));
  if (Number.isNaN(at)) return null;
  try {
    let format = zoneFormats.get(timeZone);
    if (!format) {
      format = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      zoneFormats.set(timeZone, format);
    }
    return format.format(new Date(at));
  } catch (err) {
    // Only a zone name Intl does not know is expected here; anything else is a defect.
    if (!(err instanceof RangeError)) throw err;
    return null;
  }
}

/**
 * A date key as the picklist says it: the weekday and the key, fixed text so the label does not move with the browser
 * locale (`Sat 2026-10-03`).
 *
 * @param {string} key - `YYYY-MM-DD`
 */
export function dateLabel(key) {
  const day = new Date(`${key}T12:00:00Z`);
  if (Number.isNaN(day.getTime())) return key;
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(
    day
  );
  return `${weekday} ${key}`;
}

/** @typedef {{ venueOf?: (game: Record<string, any>) => string | null, timezone?: string | null }} ScopeContext */

/**
 * What a scope kind reads off a game.
 *
 * @param {Record<string, any>} game
 * @param {string} kind - `division`, `date` or `venue`
 * @param {ScopeContext} context
 * @returns {string | null}
 */
function scopeValueOf(game, kind, { venueOf, timezone }) {
  if (kind === 'division') {
    const division = game.division;
    return division === undefined || division === null || String(division).trim() === ''
      ? null
      : String(division);
  }
  if (kind === 'date') return dateKeyInZone(game.start ?? game.kickoff, timezone);
  if (kind === 'venue') {
    const venue = venueOf ? venueOf(game) : null;
    return venue === undefined || venue === null || String(venue).trim() === ''
      ? null
      : String(venue);
  }
  return null;
}

/**
 * The picklists of the scope pickers, enumerated from the saved set: every division, date and venue that a saved
 * game has, with how many games each holds. Enumerated from the games and not from the filtered list, so a filter can
 * never hide a division from the picker.
 *
 * @param {Array<Record<string, any>>} saved
 * @param {ScopeContext} context
 * @returns {{ division: Array<{ value: string, count: number }>, date: Array<{ value: string, count: number }>,
 *   venue: Array<{ value: string, count: number }> }}
 */
export function scopeOptions(saved, context = {}) {
  const out = { division: new Map(), date: new Map(), venue: new Map() };
  for (const game of saved) {
    for (const kind of /** @type {const} */ (['division', 'date', 'venue'])) {
      const value = scopeValueOf(game, kind, context);
      if (value !== null) out[kind].set(value, (out[kind].get(value) ?? 0) + 1);
    }
  }
  const sorted = (map) =>
    [...map.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([value, count]) => ({ value, count }));
  return { division: sorted(out.division), date: sorted(out.date), venue: sorted(out.venue) };
}

/**
 * The ids a bulk call would carry, and the scope the audit row records. `publish` names the games of the scope that
 * are not Published (including those with changes allowed); `allow-changes` names the games of the scope that are.
 * Games with no row yet (a staged review) are never named: there is nothing to publish.
 *
 * @param {Array<Record<string, any>>} saved - the saved set, never a filtered view
 * @param {{ kind: string, value?: string | null }} scope
 * @param {'publish' | 'allow-changes'} want
 * @param {ScopeContext} [context]
 * @returns {{ ids: string[], games: Array<Record<string, any>>, inScope: number, eligible: number, calls: number,
 *   scope: { kind: string, value?: string } }}
 */
export function resolveScope(saved, scope, want, context = {}) {
  const kind = scope?.kind ?? 'all';
  const value = scope?.value ?? null;
  const inScopeGames = saved.filter((game) => {
    if (publishedStateOf(game) === 'unsaved') return false;
    if (kind === 'all') return true;
    // A division, date or venue with no value names no games: never "everything".
    if (value === null || value === '') return false;
    return scopeValueOf(game, kind, context) === value;
  });
  const games = inScopeGames.filter((game) =>
    want === 'publish' ? game.published !== true : game.published === true
  );
  const ids = games.map((game) => String(game.id));
  return {
    ids,
    games,
    inScope: inScopeGames.length,
    eligible: ids.length,
    calls: ids.length === 0 ? 0 : splitGameIds(ids).length,
    // The audit value is at most 100 characters; the ids are what the call acts on.
    scope:
      kind === 'all' || value === null || value === ''
        ? { kind: 'all' }
        : { kind, value: [...String(value)].slice(0, 100).join('') },
  };
}

const lowerOf = (value) => String(value ?? '').toLowerCase();
// The matchup tuple the save keys a game on: a game with another tuple is another row (lesson 95).
const tupleOf = (game) =>
  [
    game.homeTeamId ?? game.home_team_id,
    game.awayTeamId ?? game.away_team_id,
    game.slotId ?? game.gameSlotId ?? game.slot_id ?? game.game_slot_id,
    game.weekIndex ?? game.week_index,
  ]
    .map(lowerOf)
    .join('|');

/**
 * The saved games with a Published history that a staged schedule no longer holds where they were: moved by hand, or
 * placed elsewhere by a new run. The save keys a game on (home, away, slot, week) and writes no id, so the staged game
 * at another slot or week is saved as a NEW row that starts not Published, and the history stays with the old row.
 * The page says so when a move is staged and when the schedule is applied, so nobody expects the flag to follow the
 * game (lesson 95; an identity layer is a separate, pending decision).
 *
 * Judged on the tuple and not on any changed field: a change to the field, start or end alone, with the same slot and
 * week, keeps the row (and so the flag and the history). A Published game is in the staged schedule by construction
 * (the generator carries it and the save refuses a schedule that leaves one out), so in practice these are the games
 * that had changes allowed.
 *
 * @param {Array<Record<string, any>>} review - the staged games
 * @param {Array<Record<string, any>>} saved - the saved set
 * @returns {Array<Record<string, any>>} the saved games left behind, in the saved order
 */
export function movedHistoryGames(review, saved) {
  const staged = new Set(review.map(tupleOf));
  return saved.filter((game) => {
    const hasHistory = game.published === true || Boolean(game.publishedAt ?? game.published_at);
    return hasHistory && !staged.has(tupleOf(game));
  });
}

/** How a scope reads in a sentence. */
export function describeScope(scope) {
  const kind = scope?.kind ?? 'selection';
  const value = scope?.value;
  if (kind === 'all') return 'all saved games';
  if (kind === 'division') return `division ${value ?? ''}`.trim();
  if (kind === 'date') return `date ${value ?? ''}`.trim();
  if (kind === 'venue') return `venue ${value ?? ''}`.trim();
  return value ? `selected games (${value})` : 'selected games';
}
