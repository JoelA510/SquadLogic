import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { PERMISSIONS, hasPermission } from '../constants/permissions.js';
import { Trophy, CheckCircle2 } from 'lucide-react';
import { logger } from '../lib/logger.js';
import { useScorableGames } from '../hooks/useScorableGames.js';
import { useFeatures } from '../hooks/useFeatures.js';
import { divisionDisplayName } from '../utils/divisions.js';

const parseScoreInput = (score) => {
  if (score === '' || score === null || score === undefined) return null;
  const parsed = parseInt(score, 10);
  return Number.isNaN(parsed) ? null : parsed;
};

const getRpcScore = (data, key, fallback) =>
  data && Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback;

export default function LeagueStandings() {
  const { user, isImpersonating } = useAuth();
  const { currentOrganization, orgMember } = useOrganization();

  const [standings, setStandings] = useState([]);
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [updatingGameId, setUpdatingGameId] = useState(null);

  const canEditScores = hasPermission(orgMember?.role, PERMISSIONS.MANAGE_SCHEDULE);
  // Per game: an admin scores any game, a coach only their own team's
  // (update_game_score refuses the rest, 20261021020000).
  const { canScoreGame, error: scorableError } = useScorableGames({ enabled: canEditScores });
  const { genderModel } = useFeatures();

  useEffect(() => {
    async function loadData() {
      if (!currentOrganization?.id) return;
      setLoading(true);
      setError(null);
      try {
        // Load Standings View
        const { data: standingsData, error: standingsErr } = await supabase
          .from('view_league_standings')
          .select('*')
          .eq('organization_id', currentOrganization.id)
          .order('division', { ascending: true })
          .order('points', { ascending: false })
          .order('goal_differential', { ascending: false });

        if (standingsErr) throw standingsErr;
        setStandings(standingsData || []);

        // Load Games for Score Entry
        const { data: gamesData, error: gamesErr } = await supabase
          .from('games')
          .select(
            `
             id,
             start_time,
             score_home,
             score_away,
             home_team:home_team_id (id, name, division:divisions (name)),
             away_team:away_team_id (id, name, division:divisions (name))
          `
          )
          .eq('organization_id', currentOrganization.id)
          .lte('start_time', new Date().toISOString()) // Only past games
          .order('start_time', { ascending: false })
          .limit(50);

        if (gamesErr) throw gamesErr;
        setGames(gamesData || []);
      } catch (err) {
        logger.error(err);
        setError('Failed to load standings and games data.');
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, [currentOrganization?.id]);

  const handleScoreUpdate = async (gameId, homeScore, awayScore) => {
    if (!currentOrganization?.id) return;
    try {
      setUpdatingGameId(gameId);
      const hScore = parseScoreInput(homeScore);
      const aScore = parseScoreInput(awayScore);

      const { data, error } = await supabase.rpc('update_game_score', {
        p_organization_id: currentOrganization.id,
        p_game_id: gameId,
        p_score_home: hScore,
        p_score_away: aScore,
        p_metadata: {
          ...(isImpersonating && {
            target_user_id: user.profile.id,
            impersonated_by: user.id,
            admin_email: user.email,
          }),
        },
      });

      if (error) throw error;

      const persistedHomeScore = getRpcScore(data, 'score_home', hScore);
      const persistedAwayScore = getRpcScore(data, 'score_away', aScore);

      // Update local game state
      setGames((prev) =>
        prev.map((g) =>
          g.id === gameId
            ? { ...g, score_home: persistedHomeScore, score_away: persistedAwayScore }
            : g
        )
      );

      // Refresh Standings View since data changed
      const { data: standingsData } = await supabase
        .from('view_league_standings')
        .select('*')
        .eq('organization_id', currentOrganization.id)
        .order('division', { ascending: true })
        .order('points', { ascending: false })
        .order('goal_differential', { ascending: false });

      if (standingsData) setStandings(standingsData);
    } catch (err) {
      logger.error(err);
      alert('Failed to update score.');
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
        {canEditScores && scorableError && (
          <p className="text-sm text-status-warning-text mb-4" role="alert">
            Your teams could not be loaded, so no score can be entered here. Reload to try again.
          </p>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {games.map((game) => (
            <div
              key={game.id}
              className="bg-bg-app border border-border-highlight rounded-lg p-4 space-y-4"
              data-testid="game-score-card"
            >
              <div className="text-xs text-text-muted text-center border-b border-border-subtle pb-2 mb-2">
                {new Date(game.start_time).toLocaleDateString()} •{' '}
                {displayDivision(game.home_team?.division?.name || game.home_team?.division)}
              </div>
              <div className="flex justify-between items-center">
                <span className="font-semibold text-text-primary truncate w-1/3 text-right">
                  {game.home_team?.name}
                </span>
                <div className="flex items-center gap-2 w-1/3 justify-center">
                  {canEditScores && canScoreGame(game) ? (
                    <>
                      <input
                        type="number"
                        className="w-12 h-10 bg-bg-surface border border-border-highlight text-center rounded text-text-primary font-bold focus:border-color-primary focus:ring-1 focus:ring-color-primary"
                        value={game.score_home ?? ''}
                        onChange={(e) =>
                          handleScoreUpdate(game.id, e.target.value, game.score_away)
                        }
                        disabled={updatingGameId === game.id}
                        aria-label="Home Score"
                      />
                      <span className="text-text-muted font-bold">-</span>
                      <input
                        type="number"
                        className="w-12 h-10 bg-bg-surface border border-border-highlight text-center rounded text-text-primary font-bold focus:border-color-primary focus:ring-1 focus:ring-color-primary"
                        value={game.score_away ?? ''}
                        onChange={(e) =>
                          handleScoreUpdate(game.id, game.score_home, e.target.value)
                        }
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
            </div>
          ))}
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
