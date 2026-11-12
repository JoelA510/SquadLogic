import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { PERMISSIONS, hasPermission } from '../constants/permissions.js';
import { Trophy, CheckCircle2 } from 'lucide-react';
import { logger } from '../lib/logger.js';
import { useFeatures } from '../hooks/useFeatures.js';
import { FEATURE_FLAGS } from '../constants/featureFlags.js';
import { divisionDisplayName } from '../utils/divisions.js';
import ScoreNotSavedAlert from '../components/ScoreNotSavedAlert.jsx';
import { isHalfEntered, scoreRefusalText, typeScore } from '../utils/scoreEntry.js';
import { fetchCurrentSavedGames, hasStarted } from '../utils/savedGamesClient.js';

/** How many played games the page lists for score entry, newest first. */
const RECENT_GAMES = 50;

// Divisions belong to a season, so the view holds an organization's teams from
// every season: rank only the selected season's. With no season selected there
// is nothing to rank.
const fetchStandings = (organizationId, seasonId) =>
  seasonId
    ? supabase
        .from('view_league_standings')
        .select('*')
        .eq('organization_id', organizationId)
        .eq('season_settings_id', seasonId)
        .order('division', { ascending: true })
        .order('points', { ascending: false })
        .order('goal_differential', { ascending: false })
    : Promise.resolve({ data: [], error: null });

export default function LeagueStandings() {
  const { currentOrganization, currentSeasonSetting, orgMember } = useOrganization();
  const seasonId = currentSeasonSetting?.id ?? null;

  const [standings, setStandings] = useState([]);
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [updatingGameId, setUpdatingGameId] = useState(null);
  // What is typed and not saved yet, by game: one number of a score whose other is still empty.
  const [drafts, setDrafts] = useState(/** @type {Record<string, any>} */ ({}));
  const [scoreNotSaved, setScoreNotSaved] = useState(/** @type {string | null} */ (null));

  const { genderModel, isEnabled } = useFeatures();
  // Score entry is an admin function the league turns on (20261028010000, R6):
  // update_game_score refuses a non-admin, and anyone while the setting is off.
  const canEditScores =
    hasPermission(orgMember?.role, PERMISSIONS.MANAGE_SCHEDULE) &&
    isEnabled(FEATURE_FLAGS.SCORE_ENTRY);

  useEffect(() => {
    async function loadData() {
      if (!currentOrganization?.id) return;
      setLoading(true);
      setError(null);
      try {
        // Load Standings View
        const { data: standingsData, error: standingsErr } = await fetchStandings(
          currentOrganization.id,
          seasonId
        );

        if (standingsErr) throw standingsErr;
        setStandings(standingsData || []);

        // The season's saved games whose start has passed, newest first (F11-3: the saved schedule and its
        // scores, the rows the standings above are computed from).
        const saved = seasonId
          ? await fetchCurrentSavedGames({ organizationId: currentOrganization.id, seasonId })
          : [];
        const now = Date.now();
        setDrafts({});
        setGames(
          saved
            .filter((game) => hasStarted(game, now))
            .sort((a, b) => Date.parse(b.start) - Date.parse(a.start))
            .slice(0, RECENT_GAMES)
        );
      } catch (err) {
        logger.error(err);
        setError('Failed to load standings and games data.');
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, [currentOrganization?.id, seasonId]);

  const forgetDraft = (gameId) =>
    setDrafts((current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => id !== gameId))
    );

  // A score is both numbers or none (the database refuses one without the other): one number is held on the page
  // until the other is entered, and the two are sent together.
  const handleScoreUpdate = async (game, side, value) => {
    if (!currentOrganization?.id) return;
    const { entry, send } = typeScore(game, drafts[game.id], side, value);
    setDrafts((current) => ({ ...current, [game.id]: entry }));
    if (!send) {
      if (!isHalfEntered(entry)) forgetDraft(game.id);
      return;
    }
    try {
      setUpdatingGameId(game.id);
      const { error } = await supabase.rpc('update_game_score', {
        p_organization_id: currentOrganization.id,
        p_game_id: game.id,
        p_score_home: entry.score_home,
        p_score_away: entry.score_away,
      });

      if (error) throw error;
      setScoreNotSaved(null);
      setGames((prev) => prev.map((g) => (g.id === game.id ? { ...g, ...entry } : g)));
      forgetDraft(game.id);

      // Refresh Standings View since data changed
      const { data: standingsData } = await fetchStandings(currentOrganization.id, seasonId);

      if (standingsData) setStandings(standingsData);
    } catch (err) {
      logger.error(err);
      // The boxes go back to the saved score, and why is said on the page, in the Scores page's words.
      forgetDraft(game.id);
      setScoreNotSaved(scoreRefusalText(err));
    } finally {
      setUpdatingGameId(null);
    }
  };

  // Group standings by division (co-ed display model folds U10B/U10G → U10)
  const displayDivision = (name) =>
    divisionDisplayName(name || 'Uncategorized', genderModel) || 'Uncategorized';
  const divisions = [...new Set(standings.map((s) => displayDivision(s.division)))];

  if (loading)
    return (
      <div className="text-center p-8 animate-pulse text-text-secondary">
        Loading League Data...
      </div>
    );

  // One result against an outside club is one game of one own team, so the sum over teams is a count of results.
  const outsideResultsNotCounted = standings.reduce(
    (sum, row) => sum + (Number(row.results_not_counted) || 0),
    0
  );

  return (
    <div className="max-w-7xl mx-auto space-y-8 animate-fadeIn">
      <div className="flex items-center gap-3 mb-6">
        <Trophy className="text-color-primary w-8 h-8" />
        <div>
          <h1 className="text-3xl font-display font-bold text-text-primary">League Standings</h1>
          <p className="text-text-secondary">Track season progress and record game scores.</p>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-status-error-bg border border-status-error/30 text-status-error rounded-xl text-sm font-medium">
          {error}
        </div>
      )}

      {/* What the numbers below leave out (lesson 92: say what a number is a count of). The view counts a result
          against an outside club only when the organization says so, and says per team how many it left out. */}
      {outsideResultsNotCounted > 0 && (
        <p className="text-sm text-text-secondary" data-testid="standings-outside-not-counted">
          {outsideResultsNotCounted === 1
            ? '1 result against an outside club is not counted.'
            : `${outsideResultsNotCounted} results against outside clubs are not counted.`}{' '}
          An admin can count them in Settings, under Features.
        </p>
      )}

      {/* Standings Tables by Division */}
      <div className="space-y-8">
        {divisions.map((division) => (
          <div
            key={division}
            className="bg-bg-surface border border-border-subtle rounded-xl overflow-hidden shadow-md"
          >
            <div className="bg-bg-app px-6 py-4 border-b border-border-subtle flex items-center justify-between">
              <h2 className="text-lg font-bold text-text-primary uppercase tracking-wide">
                {division} Division
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left text-text-secondary">
                <thead className="text-xs text-text-muted uppercase bg-bg-surface border-b border-border-subtle">
                  <tr>
                    <th className="px-6 py-3 font-semibold tracking-wider w-12">Rank</th>
                    <th className="px-6 py-3 font-semibold tracking-wider">Team</th>
                    <th className="px-4 py-3 font-semibold tracking-wider text-center">GP</th>
                    <th className="px-4 py-3 font-semibold tracking-wider text-center">W</th>
                    <th className="px-4 py-3 font-semibold tracking-wider text-center">L</th>
                    <th className="px-4 py-3 font-semibold tracking-wider text-center">D</th>
                    <th className="px-4 py-3 font-semibold tracking-wider text-center">GF</th>
                    <th className="px-4 py-3 font-semibold tracking-wider text-center">GA</th>
                    <th className="px-4 py-3 font-semibold tracking-wider text-center">GD</th>
                    <th className="px-6 py-3 font-bold text-color-primary tracking-wider text-center">
                      PTS
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {standings
                    .filter((s) => displayDivision(s.division) === division)
                    .map((team, idx) => (
                      <tr
                        key={team.team_id}
                        className="hover:bg-bg-app/50 transition-colors"
                        data-testid={`standings-row-${team.team_name.replace(/\s+/g, '-').toLowerCase()}`}
                      >
                        <td className="px-6 py-4 text-center font-bold text-text-muted">
                          {idx + 1}
                        </td>
                        <td className="px-6 py-4 font-bold text-text-primary">{team.team_name}</td>
                        <td className="px-4 py-4 text-center">{team.games_played}</td>
                        <td className="px-4 py-4 text-center text-status-success">{team.wins}</td>
                        <td className="px-4 py-4 text-center text-status-error">{team.losses}</td>
                        <td className="px-4 py-4 text-center text-status-warning-text">
                          {team.draws}
                        </td>
                        <td className="px-4 py-4 text-center">{team.goals_for}</td>
                        <td className="px-4 py-4 text-center">{team.goals_against}</td>
                        <td className="px-4 py-4 text-center font-medium">
                          {team.goal_differential > 0
                            ? `+${team.goal_differential}`
                            : team.goal_differential}
                        </td>
                        <td className="px-6 py-4 text-center font-black text-color-primary text-base">
                          {team.points}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
        {divisions.length === 0 && (
          <div className="text-center py-12 text-text-secondary bg-bg-surface border border-border-subtle rounded-xl">
            No teams or standings available for this organization.
          </div>
        )}
      </div>

      {/* Recent Games Section - visible to all roles */}
      <div className="bg-bg-surface border border-border-subtle rounded-xl p-6 shadow-md mt-12">
        <h2 className="text-xl font-bold text-text-primary mb-6 flex items-center gap-2">
          <CheckCircle2 className="text-text-muted w-5 h-5" /> Recent Games{' '}
          {canEditScores && '- Score Entry'}
        </h2>

        <ScoreNotSavedAlert message={scoreNotSaved} className="mb-4" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {games.map((saved) => {
            // What the boxes hold: the saved score with what is typed and unsaved over it.
            const game = { ...saved, ...(drafts[saved.id] ?? {}) };
            const half = isHalfEntered(drafts[saved.id]);
            return (
              <div
                key={game.id}
                className="bg-bg-app border border-border-highlight rounded-lg p-4 space-y-4"
                data-testid="game-score-card"
              >
                <div className="text-xs text-text-muted text-center border-b border-border-subtle pb-2 mb-2">
                  {new Date(game.start).toLocaleDateString()} •{' '}
                  {displayDivision(game.home_team?.division?.name || game.home_team?.division)}
                </div>
                <div className="flex justify-between items-center">
                  <span className="font-semibold text-text-primary truncate w-1/3 text-right">
                    {game.home_team?.name}
                  </span>
                  <div className="flex items-center gap-2 w-1/3 justify-center">
                    {canEditScores ? (
                      <>
                        <input
                          type="number"
                          className="w-12 h-10 bg-bg-surface border border-border-highlight text-center rounded text-text-primary font-bold focus:border-color-primary focus:ring-1 focus:ring-color-primary"
                          value={game.score_home ?? ''}
                          onChange={(e) => handleScoreUpdate(saved, 'score_home', e.target.value)}
                          disabled={updatingGameId === game.id}
                          aria-label="Home Score"
                        />
                        <span className="text-text-muted font-bold">-</span>
                        <input
                          type="number"
                          className="w-12 h-10 bg-bg-surface border border-border-highlight text-center rounded text-text-primary font-bold focus:border-color-primary focus:ring-1 focus:ring-color-primary"
                          value={game.score_away ?? ''}
                          onChange={(e) => handleScoreUpdate(saved, 'score_away', e.target.value)}
                          disabled={updatingGameId === game.id}
                          aria-label="Away Score"
                        />
                      </>
                    ) : (
                      <div className="text-lg font-bold text-text-primary">
                        {game.score_home ?? '-'} <span className="text-text-muted mx-1">-</span>{' '}
                        {game.score_away ?? '-'}
                      </div>
                    )}
                  </div>
                  <span className="font-semibold text-text-primary truncate w-1/3 text-left">
                    {game.away_team?.name}
                  </span>
                </div>
                {half && (
                  <p
                    className="text-xs text-text-secondary text-center"
                    data-testid="score-needs-both"
                    role="status"
                  >
                    Enter both scores to save.
                  </p>
                )}
              </div>
            );
          })}
          {games.length === 0 && (
            <div className="col-span-full text-center py-8 text-text-secondary">
              No past games found to enter scores.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
