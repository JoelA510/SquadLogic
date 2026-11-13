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

/** What a game's card shows (Standings' Recent Games, the Dashboard's upcoming list): no slot, no ground. */
export const GAME_CARD_SELECT =
  'id, start, home_team_id, away_team_id, ' +
  'home_team:teams!home_team_id(id, name, division:divisions(name)), ' +
  'away_team:teams!away_team_id(id, name), ' +
  'game_scores(score_home, score_away)';

/**
 * A season's games of its current run, bounded on the server (review R9): those that have started (`start` at or
 * before `now`, newest first) or those still to come (soonest first), at most `limit`, with only what a card shows.
 *
 * @param {{ organizationId: string, seasonId: string, now: string, limit: number, played: boolean }} scope
 */
export async function fetchGameCards({ organizationId, seasonId, now, limit, played }) {
  const runIds = await fetchCurrentGameRunIds({ organizationId, seasonId });
  if (runIds.length === 0) return [];
  const base = supabase
    .from('game_assignments')
    .select(GAME_CARD_SELECT)
    .eq('organization_id', organizationId)
    .in('run_id', runIds);
  const { data, error } = await (played ? base.lte('start', now) : base.gte('start', now))
    .order('start', { ascending: !played })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map(withScore);
}

/**
 * How many games a season's current run holds, counted by the server (review R9).
 *
 * @param {{ organizationId: string, seasonId: string }} scope
 * @returns {Promise<number>}
 */
export async function countCurrentGames({ organizationId, seasonId }) {
  const runIds = await fetchCurrentGameRunIds({ organizationId, seasonId });
  if (runIds.length === 0) return 0;
  const { count, error } = await supabase
    .from('game_assignments')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .in('run_id', runIds);
  if (error) throw error;
  return count ?? 0;
}

/**
 * One team's games in the saved schedule: the definition the calendar feed uses too (`teamFeed.ts`, review R8). The
 * team's organization and its division's season name the current runs (`current_game_runs`; every season of the
 * organization when the division names none), and the team's games are read from those runs only, so the read does not
 * grow with history. Any read failing throws.
 *
 * @param {string} teamId
 */
export async function fetchTeamSavedGames(teamId) {
  const { data: teams, error: teamError } = await supabase
    .from('teams')
    .select('id, organization_id, division_id')
    .eq('id', teamId);
  if (teamError) throw teamError;
  const team = teams?.[0];
  if (!team?.organization_id) return [];
  let seasonId = null;
  if (team.division_id) {
    const { data: divisions, error: divisionError } = await supabase
      .from('divisions')
      .select('id, season_settings_id')
      .eq('id', team.division_id);
    if (divisionError) throw divisionError;
    seasonId = divisions?.[0]?.season_settings_id ?? null;
  }
  const runIds = await fetchCurrentGameRunIds({ organizationId: team.organization_id, seasonId });
  if (runIds.length === 0) return [];
  const rows = await fetchAllPages(() =>
    supabase
      .from('game_assignments')
      .select(SAVED_GAME_SELECT)
      .eq('organization_id', team.organization_id)
      .in('run_id', runIds)
      .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`)
  );
  return rows.map(withScore);
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

/** Minutes of `HH:MM[:SS]`, or null. */
const wallMinutes = (value) => {
  const m = /^(\d{2}):(\d{2})/.exec(String(value ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * A slot's length in minutes (its two instants, else its two wall times), or null: the twin of the feed's
 * `gameSlotMinutes` (`_shared/calendar/icsFeed.ts`), held to it by `tests/gameEndRule.test.js`.
 *
 * @param {Record<string, any> | null | undefined} slot
 */
export function slotMinutes(slot) {
  if (!slot) return null;
  const a = slot.start ? Date.parse(String(slot.start)) : Number.NaN;
  const b = slot.end ? Date.parse(String(slot.end)) : Number.NaN;
  if (Number.isFinite(a) && Number.isFinite(b) && b > a) return Math.round((b - a) / 60_000);
  const s = wallMinutes(slot.start_time);
  const e = wallMinutes(slot.end_time);
  return s !== null && e !== null && e > s ? e - s : null;
}

/**
 * When a saved game is played, on the season's clock (review R6: the feed's rule). It starts at its own `start`; it
 * ends at its own `end` when that is not before its start, else after the slot's length from its own start, else the
 * page shows no end (the feed writes an hour, `DEFAULT_GAME_MINUTES`). With no zone, or a start that cannot be read,
 * the slot's wall date and times stand in (the reading before F11-3), and with neither there is no date.
 *
 * @param {Record<string, any>} game - a row of {@link SAVED_GAME_SELECT}
 * @param {string | null | undefined} timeZone - the season's IANA zone
 * @returns {{ date: string | null, startTime: string | null, endTime: string | null }} `YYYY-MM-DD`, `HH:MM:SS`
 */
export function savedGameWallTimes(game, timeZone) {
  const start = wallOfInstant(game?.start, timeZone);
  if (start) {
    const startMs = Date.parse(game.start);
    const ownEndMs = game?.end ? Date.parse(game.end) : Number.NaN;
    const minutes = slotMinutes(game?.game_slot);
    const endIso =
      Number.isFinite(ownEndMs) && ownEndMs >= startMs
        ? game.end
        : minutes !== null
          ? new Date(startMs + minutes * 60_000).toISOString()
          : null;
    const end = endIso ? wallOfInstant(endIso, timeZone) : null;
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
