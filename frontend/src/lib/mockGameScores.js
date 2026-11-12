/**
 * Mock arms for the score record (migration `20261122010000_game_scores.sql`; plan
 * `docs/changes/2026-11-06-games-table-source-of-truth.md`, F11-2, task B2), refusals included (LESSONS_LEARNED 13 and
 * 77: a mock that accepts what the database refuses makes every screen built on it look finished).
 *
 * - {@link mockUpdateSavedGameScore}: `update_game_score` for a SAVED game (`game_assignments`): both scores or none
 *   (22023 `score_one_sided`), a negative score (23514), the game of the organization (42501), an admin (42501), the
 *   `score_entry` setting for ENTERING a score (55000; a clear is never gated by it), a game that is not in its
 *   season's current run when a score is set (22023 `game_not_current`), a completed season (22023 `season_completed`); it writes, replaces or deletes the
 *   game's row of `game_scores` and audits `competition.score_updated` with the previous values, only on a change.
 * - {@link deriveLeagueStandings}: `view_league_standings` computed from `game_scores`: a row for an own team, none for
 *   an outside club, a result against an outside club counted only when the organization's
 *   `standings_count_outside_results` setting is a boolean true, and `results_not_counted` saying how many were left out.
 * - {@link deriveCurrentGameRuns}: `current_game_runs`, per organization and season the latest completed game run.
 *
 * Whether a game is HELD is not decided here: `mockGamePublished.js`'s `isRowHeld` reads `db.game_scores`, and every
 * refusal asks it.
 *
 * ## What the mock still does that the database does not (declared; F11-3 removes it)
 *
 * The Scores and Standings pages still read the legacy `games` table until F11-3 repoints them, and the mock's demo
 * data and the pages' tests seed that table. So (1) `update_game_score` for an id that names a row of the legacy
 * `games` table and NO saved game keeps its earlier arm in `mockSupabaseClient.js` (the database answers "Game not
 * found" for such an id), and (2) a team's STORED `view_league_standings` row (the seed, and what that legacy arm
 * counts into) is returned as it is unless the team has a result in `game_scores`, and an own team with neither has no
 * row here (the database gives it a row of zeros). `tests/mockGameScores.test.js` pins both, so neither can widen.
 */

const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
const fail = (code, message, details = null) => ({ data: null, error: { code, message, details } });

/** Whether an id names a saved game (the arm of `update_game_score` the database has). */
export function isSavedGame(db, gameId) {
  return (db.game_assignments || []).some((row) => same(row.id, gameId));
}

/**
 * `update_game_score` for a saved game, in the database's order.
 *
 * @param {any} db - mutated on success
 * @param {Record<string, any>} params
 * @param {{ currentUserId: string | null, isOrgAdmin: (org: string) => boolean, isOrgMember: (org: string) => boolean,
 *           seasonRefusal: (rows: any[]) => ({ data: null, error: object } | null), now?: () => string,
 *           newId?: () => string }} ctx
 */
export function mockUpdateSavedGameScore(db, params, ctx) {
  const org = params?.p_organization_id;
  const gameId = params?.p_game_id;
  const home = params?.p_score_home ?? null;
  const away = params?.p_score_away ?? null;
  if (org == null) return fail('23502', 'p_organization_id is required');
  if (gameId == null) return fail('23502', 'p_game_id is required');
  if (home !== null && Number(home) < 0) return fail('23514', 'p_score_home must be non-negative');
  if (away !== null && Number(away) < 0) return fail('23514', 'p_score_away must be non-negative');
  if ((home === null) !== (away === null)) {
    return fail(
      '22023',
      'enter both scores, or clear both: one score without the other is not a result',
      'score_one_sided'
    );
  }
  if (!ctx.currentUserId) return fail('42501', 'authenticated user is required');
  if (!ctx.isOrgMember(org)) {
    return fail('42501', `Access denied: caller cannot update scores for organization ${org}`);
  }
  const game = (db.game_assignments || []).find(
    (row) => same(row.id, gameId) && same(row.organization_id, org)
  );
  if (!game) return fail('42501', `Game not found in organization ${org}`);
  if (!ctx.isOrgAdmin(org)) {
    return fail('42501', 'Access denied: only an organization admin enters scores');
  }
  const organization = (db.organizations || []).find((row) => same(row.id, org));
  // The setting gates ENTERING a score; a clear is always an admin's to make (a scored game is held, and turning score
  // entry off must not leave games held with nothing to release them).
  if (home !== null && organization?.feature_flags?.score_entry !== true) {
    return fail(
      '55000',
      `Score entry is off for organization ${org}: an admin turns it on in Settings`
    );
  }
  const stored = (db.game_scores || []).find((row) => same(row.game_id, gameId));
  const previousHome = stored ? stored.score_home : null;
  const previousAway = stored ? stored.score_away : null;
  const changed = previousHome !== home || previousAway !== away;
  // A score is SET only on a game of its season's current game run (`current_game_runs`): one on a game left in an
  // older run would hold a game no screen shows. A clear is never refused for this.
  if (
    changed &&
    home !== null &&
    !deriveCurrentGameRuns(db).some(
      (run) => same(run.organization_id, org) && same(run.run_id, game.run_id)
    )
  ) {
    return fail(
      '22023',
      `Game ${game.id} is not in its season's current schedule, so it takes no score: only a game of the schedule that is shown can be scored`,
      'game_not_current'
    );
  }
  if (changed) {
    // game_scores carries the completed-season trigger: the season is read from the home team.
    const refused = ctx.seasonRefusal([game]);
    if (refused) return refused;
    const now = ctx.now ? ctx.now() : new Date().toISOString();
    if (home === null) {
      db.game_scores = (db.game_scores || []).filter((row) => !same(row.game_id, gameId));
    } else if (stored) {
      Object.assign(stored, {
        score_home: Number(home),
        score_away: Number(away),
        updated_at: now,
        updated_by: ctx.currentUserId,
      });
    } else {
      db.game_scores = [
        ...(db.game_scores || []),
        {
          // The table's columns and no other (its key is game_id; the mock's generic code keys this table by it).
          game_id: game.id,
          organization_id: game.organization_id,
          home_team_id: game.home_team_id,
          away_team_id: game.away_team_id,
          score_home: Number(home),
          score_away: Number(away),
          created_at: now,
          updated_at: now,
          updated_by: ctx.currentUserId,
        },
      ];
    }
    db.audit_log = db.audit_log || [];
    db.audit_log.push({
      id: ctx.newId ? ctx.newId() : `audit-${db.audit_log.length + 1}`,
      organization_id: org,
      action: 'competition.score_updated',
      resource_type: 'game',
      resource_id: game.id,
      user_id: ctx.currentUserId,
      metadata: {
        game_id: game.id,
        home_team_id: game.home_team_id,
        away_team_id: game.away_team_id,
        previous_score_home: previousHome,
        previous_score_away: previousAway,
        score_home: home === null ? null : Number(home),
        score_away: away === null ? null : Number(away),
        ...(params?.p_metadata && typeof params.p_metadata === 'object' ? params.p_metadata : {}),
      },
      created_at: now,
    });
  }
  return {
    data: {
      game_id: game.id,
      organization_id: org,
      score_home: home === null ? null : Number(home),
      score_away: away === null ? null : Number(away),
      previous_score_home: previousHome,
      previous_score_away: previousAway,
      changed,
    },
    error: null,
  };
}

/**
 * The rows `view_league_standings` computes from `game_scores`, for the teams that have a result there.
 *
 * @param {any} db
 * @returns {Array<Record<string, any>>}
 */
export function computeScoredStandings(db) {
  const teams = db.teams || [];
  const teamOf = (id) => teams.find((team) => same(team.id, id));
  const countsOutside = (team) =>
    (db.organizations || []).find((org) => same(org.id, team.organization_id))?.feature_flags
      ?.standings_count_outside_results === true;
  /** @type {Map<string, Record<string, any>>} */
  const rows = new Map();
  const rowFor = (team) => {
    const key = String(team.id).toLowerCase();
    if (!rows.has(key)) {
      const division = (db.divisions || []).find((d) => same(d.id, team.division_id));
      rows.set(key, {
        team_id: team.id,
        organization_id: team.organization_id,
        team_name: team.name,
        division_id: team.division_id ?? null,
        games_played: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        goals_for: 0,
        goals_against: 0,
        goal_differential: 0,
        points: 0,
        division: division?.name ?? null,
        season_settings_id: division?.season_settings_id ?? null,
        results_not_counted: 0,
      });
    }
    return rows.get(key);
  };
  for (const score of db.game_scores || []) {
    const sides = [
      [score.home_team_id, score.away_team_id, score.score_home, score.score_away],
      [score.away_team_id, score.home_team_id, score.score_away, score.score_home],
    ];
    for (const [teamId, opponentId, goalsFor, goalsAgainst] of sides) {
      const own = teamOf(teamId);
      const opponent = teamOf(opponentId);
      // An outside club never has a row; a side with no team row joins nothing (as the view's inner joins).
      if (!own || !opponent || own.is_external === true) continue;
      const row = rowFor(own);
      if (opponent.is_external === true && !countsOutside(own)) {
        row.results_not_counted += 1;
        continue;
      }
      row.games_played += 1;
      row.goals_for += Number(goalsFor);
      row.goals_against += Number(goalsAgainst);
      if (goalsFor > goalsAgainst) row.wins += 1;
      else if (goalsFor < goalsAgainst) row.losses += 1;
      else row.draws += 1;
      row.goal_differential = row.goals_for - row.goals_against;
      row.points = row.wins * 3 + row.draws;
    }
  }
  return [...rows.values()];
}

/**
 * What a read of `view_league_standings` returns in the mock: the computed row of every team with a result in
 * `game_scores`, and the stored row (the seed and the legacy arm, see the file comment) of every other team, never an
 * outside club's.
 *
 * @param {any} db
 */
export function deriveLeagueStandings(db) {
  const computed = computeScoredStandings(db);
  const scoredTeams = new Set(computed.map((row) => String(row.team_id).toLowerCase()));
  const external = new Set(
    (db.teams || []).filter((t) => t.is_external === true).map((t) => String(t.id).toLowerCase())
  );
  const stored = (db.view_league_standings || [])
    .filter((row) => !scoredTeams.has(String(row.team_id).toLowerCase()))
    .filter((row) => !external.has(String(row.team_id).toLowerCase()))
    .map((row) => ({ results_not_counted: 0, ...row }));
  return [...stored, ...computed];
}

/**
 * `current_game_runs`: per organization and season, the latest completed game run (the rule of `useSchedulerRun`: the
 * season named in `season_settings_id` or in the older `season_id`; the latest `completed_at`, a missing one first as
 * PostgREST orders a descending NULL; then `created_at`, then the id, so the answer is one row).
 *
 * @param {any} db
 */
export function deriveCurrentGameRuns(db) {
  const desc = (a, b) =>
    a === b
      ? 0
      : a === null || a === undefined
        ? -1
        : b === null || b === undefined
          ? 1
          : a < b
            ? 1
            : -1;
  const out = [];
  for (const season of db.season_settings || []) {
    const runs = (db.scheduler_runs || [])
      .filter(
        (run) =>
          same(run.organization_id, season.organization_id) &&
          run.run_type === 'game' &&
          run.status === 'completed' &&
          (same(run.season_settings_id, season.id) || same(run.season_id, season.id))
      )
      .sort(
        (a, b) =>
          desc(a.completed_at, b.completed_at) ||
          desc(a.created_at, b.created_at) ||
          desc(String(a.id), String(b.id))
      );
    if (runs.length > 0) {
      out.push({
        organization_id: season.organization_id,
        season_settings_id: season.id,
        run_id: runs[0].id,
        completed_at: runs[0].completed_at ?? null,
      });
    }
  }
  return out;
}
