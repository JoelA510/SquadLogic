/**
 * The saved schedule, as every page that shows a game reads it (F11-3 of
 * `docs/changes/2026-11-06-games-table-source-of-truth.md`).
 *
 * A game is a row of `game_assignments`; its score, if it has one, is a row of `game_scores`; "the schedule" of a
 * season is the games of that season's current game run, which `current_game_runs` names (one SQL definition, held
 * to `useSchedulerRun` by `tests/currentGameRunsParity.test.js`). A game left in an older run (a save that did not
 * carry it) is hidden: no reader here returns it.
 *
 * One select, so the readers cannot drift: the team page and its files, the Dashboard, the Player record, Scores and
 * Standings. `game_assignments` has two foreign keys to `game_slots` and two to `teams`, so each embed hints its
 * column. The game's OWN `start` and `end` are when it is played (an imported game can end at another time than its
 * slot does); the slot gives the ground and the wall date a reader falls back to.
 */
import { wallOfInstant } from '@squadlogic/core/reports/wall.js';
import { supabase } from '../lib/supabaseClient.js';
import { fetchAllPages } from '../lib/pagedFetch.js';

export const SAVED_GAME_SELECT =
  'id, organization_id, run_id, season_settings_id, home_team_id, away_team_id, start, end, ' +
  'game_slot:game_slots!game_slot_id(slot_date, start_time, end_time, field:fields(name, location:locations(name))), ' +
  'home_team:teams!home_team_id(id, name, division:divisions(name, season_settings_id)), ' +
  'away_team:teams!away_team_id(id, name, division:divisions(name)), ' +
  'game_scores(score_home, score_away)';

/**
 * The current game run of each season of an organization (or of one season): the runs whose games are "the schedule".
 * Throws on a failed read: an empty list would read as "nothing is scheduled".
 *
 * @param {{ organizationId: string, seasonId?: string | null }} scope
 * @returns {Promise<string[]>} run ids
 */
export async function fetchCurrentGameRunIds({ organizationId, seasonId = null }) {
  let query = supabase
    .from('current_game_runs')
    .select('run_id, season_settings_id')
    .eq('organization_id', organizationId);
  if (seasonId) query = query.eq('season_settings_id', seasonId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map((row) => row.run_id);
}

/**
 * The games of the given runs, each with its sides, ground and score; `teamId` keeps the games that team plays in.
 * Paged, so a league with more games than the server's row cap is read whole; a failed page throws.
 *
 * @param {{ runIds: string[], teamId?: string | null }} scope
 * @returns {Promise<Array<Record<string, any>>>} rows of {@link SAVED_GAME_SELECT} with `score_home` and `score_away`
 */
export async function fetchSavedGames({ runIds, teamId = null }) {
  if (runIds.length === 0) return [];
  const rows = await fetchAllPages(() => {
    const query = supabase.from('game_assignments').select(SAVED_GAME_SELECT).in('run_id', runIds);
    return teamId ? query.or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`) : query;
  });
  return rows.map(withScore);
}

/**
 * The saved schedule of an organization: every season's current run, or one season's.
 *
 * @param {{ organizationId: string, seasonId?: string | null, teamId?: string | null }} scope
 */
export async function fetchCurrentSavedGames({ organizationId, seasonId = null, teamId = null }) {
  const runIds = await fetchCurrentGameRunIds({ organizationId, seasonId });
  return fetchSavedGames({ runIds, teamId });
}

/**
 * One team's games in the saved schedule: the games it plays in whose run is its season's current one. The team's
 * games are read first (they name their runs), then `current_game_runs` says which of those runs is a schedule; a
 * game left behind in an older run is not returned. Either read failing throws.
 *
 * @param {string} teamId
 */
export async function fetchTeamSavedGames(teamId) {
  const rows = await fetchAllPages(() =>
    supabase
      .from('game_assignments')
      .select(SAVED_GAME_SELECT)
      .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`)
  );
  const runIds = [...new Set(rows.map((row) => row.run_id).filter(Boolean))];
  if (runIds.length === 0) return [];
  const { data, error } = await supabase
    .from('current_game_runs')
    .select('run_id')
    .in('run_id', runIds);
  if (error) throw error;
  const current = new Set((data ?? []).map((row) => String(row.run_id)));
  return rows.filter((row) => current.has(String(row.run_id))).map(withScore);
}

/**
 * The row with its score as two fields. `game_scores` points at the game by a key PostgREST reads as one-to-many, so
 * the embed is a list of at most one row (an object, were the key ever read as one-to-one): both shapes are read, and
 * the embed is not carried under another name.
 *
 * @param {Record<string, any>} row
 * @returns {Record<string, any>}
 */
export function withScore({ game_scores: scores, ...row }) {
  const score = Array.isArray(scores) ? (scores[0] ?? null) : (scores ?? null);
  return {
    ...row,
    score_home: score ? score.score_home : null,
    score_away: score ? score.score_away : null,
  };
}

/**
 * When a saved game is played, on the season's clock: the game's own `start` and `end` read in `timeZone`. With no
 * zone, or an instant that cannot be read, the slot's wall date and times stand in (the reading before F11-3), and
 * with neither there is no date.
 *
 * @param {Record<string, any>} game - a row of {@link SAVED_GAME_SELECT}
 * @param {string | null | undefined} timeZone - the season's IANA zone
 * @returns {{ date: string | null, startTime: string | null, endTime: string | null }} `YYYY-MM-DD`, `HH:MM:SS`
 */
export function savedGameWallTimes(game, timeZone) {
  const start = wallOfInstant(game?.start, timeZone);
  if (start) {
    const end = wallOfInstant(game?.end, timeZone);
    return {
      date: start.date,
      startTime: `${start.time}:00`,
      endTime: end ? `${end.time}:00` : null,
    };
  }
  const slot = game?.game_slot;
  return {
    date: slot?.slot_date ?? null,
    startTime: slot?.start_time ?? null,
    endTime: slot?.end_time ?? null,
  };
}

/** Whether a game's start has passed (`now` is supplied by the caller). @param {Record<string, any>} game */
export function hasStarted(game, now) {
  const at = Date.parse(game?.start ?? '');
  return Number.isFinite(at) && at <= now;
}
