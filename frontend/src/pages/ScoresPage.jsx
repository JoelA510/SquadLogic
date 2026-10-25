import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Flag } from 'lucide-react';
import Page from '../components/chrome/Page.jsx';
import PageHeader from '../components/chrome/PageHeader.jsx';
import DataGrid from '../components/grid/DataGrid.jsx';
import Badge from '../components/ui/Badge.jsx';
import { useToast } from '../components/ui/ToastHost.jsx';
import { supabase } from '../lib/supabaseClient.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useFeatures } from '../hooks/useFeatures.js';
import { useScorableGames } from '../hooks/useScorableGames.js';
import { divisionDisplayName } from '../utils/divisions.js';
import { logger } from '../lib/logger.js';
import LoadingScreen from '../components/LoadingScreen.jsx';
import DataErrorBanner from '../components/ui/DataErrorBanner.jsx';

/**
 * Scores & Results — spreadsheet-style score entry over past games,
 * persisting through the audited update_game_score RPC (the same path
 * LeagueStandings uses; standings views refresh from it). An admin page the
 * league turns on (`score_entry`; the route checks it, and the RPC refuses
 * every caller while it is off): since 20261028010000 (R6) no coach scores.
 */
export default function ScoresPage() {
  const { currentOrganization } = useOrganization();
  const { user, isImpersonating } = useAuth();
  const { genderModel } = useFeatures();
  const toast = useToast();
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  // An admin enters any game's score; nobody else enters one
  // (update_game_score, 20261028010000). Under an admin's role preview of a
  // coach the read is the coach's teams' games and none is offered.
  const {
    ready: scorableReady,
    error: scorableError,
    teamIds: scorableTeamIds,
    canScoreGame,
  } = useScorableGames();
  // null: an admin, every game; '': a coach of no team (or the read failed).
  const teamKey = scorableTeamIds ? scorableTeamIds.join(',') : null;

  const orgId = currentOrganization?.id;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!orgId || !scorableReady) return;
      if (teamKey === '') {
        setGames([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        let query = supabase
          .from('games')
          .select(
            `id, start_time, score_home, score_away,
             home_team:home_team_id (id, name, division:divisions (name)),
             away_team:away_team_id (id, name)`
          )
          .eq('organization_id', orgId)
          .lte('start_time', new Date().toISOString());
        // A previewed coach's games are found by the server, not cut out of
        // the league's latest 200, where a busy league would leave none.
        if (teamKey !== null) {
          query = query.or(`home_team_id.in.(${teamKey}),away_team_id.in.(${teamKey})`);
        }
        const { data, error } = await query.order('start_time', { ascending: false }).limit(200);
        if (error) throw error;
        if (!cancelled) setGames(data || []);
      } catch (err) {
        logger.error('[ScoresPage] load failed:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, scorableReady, teamKey]);

  const persistScore = useCallback(
    async (gameId, scoreHome, scoreAway) => {
      const previous = games.find((game) => game.id === gameId);
      setGames((current) =>
        current.map((game) =>
          game.id === gameId ? { ...game, score_home: scoreHome, score_away: scoreAway } : game
        )
      );
      try {
        const { error } = await supabase.rpc('update_game_score', {
          p_organization_id: orgId,
          p_game_id: gameId,
          p_score_home: scoreHome,
          p_score_away: scoreAway,
          p_metadata: {
            ...(isImpersonating && {
              target_user_id: user?.profile?.id,
              impersonated_by: user?.id,
              admin_email: user?.email,
            }),
          },
        });
        if (error) throw error;
        toast('Score saved', 'success');
      } catch (err) {
        logger.error('[ScoresPage] score update failed:', err);
        setGames((current) => current.map((game) => (game.id === gameId ? previous : game)));
        toast('Failed to save score', 'warning');
      }
    },
    [games, orgId, isImpersonating, user, toast]
  );

  const rows = useMemo(
    () =>
      games
        .filter((game) => canScoreGame(game))
        .map((game) => ({
          ...game,
          _date: game.start_time ? new Date(game.start_time).toLocaleDateString() : '—',
          _division: divisionDisplayName(
            game.home_team?.division?.name || game.home_team?.division || '',
            genderModel
          ),
          _home: game.home_team?.name || '—',
          _away: game.away_team?.name || '—',
          _final: game.score_home != null && game.score_away != null,
        })),
    [games, genderModel, canScoreGame]
  );

  const columns = useMemo(
    () =>
      /** @type {any[]} */ ([
        {
          key: '_date',
          label: 'Date',
          width: 110,
          sortVal: (row) => row.start_time || '',
        },
        { key: '_division', label: 'Division', width: 100 },
        { key: '_home', label: 'Home', width: 180 },
        {
          key: 'score_home',
          label: 'HS',
          width: 64,
          editable: true,
          type: 'number',
          num: true,
          min: 0,
          max: 99,
          placeholder: '–',
        },
        {
          key: 'score_away',
          label: 'AS',
          width: 64,
          editable: true,
          type: 'number',
          num: true,
          min: 0,
          max: 99,
          placeholder: '–',
        },
        { key: '_away', label: 'Away', width: 180 },
        {
          key: '_final',
          label: 'Status',
          width: 90,
          sortable: false,
          render: (row) =>
            row._final ? <Badge tone="success">Final</Badge> : <Badge>Awaiting</Badge>,
        },
      ]),
    []
  );

  if (loading || !scorableReady) return <LoadingScreen />;

  return (
    <Page
      flush
      header={
        <PageHeader
          title="Scores & Results"
          subtitle="Enter final scores for played games — standings update automatically."
          icon={
            <span className="page-obj-icon" style={{ background: 'var(--accent-amber)' }}>
              <Flag size={20} aria-hidden="true" />
            </span>
          }
        />
      }
    >
      {scorableError && (
        <DataErrorBanner
          message="Your teams could not be loaded, so no games are listed for scoring. Reload to try again."
          className="m-3 mb-0"
        />
      )}
      <DataGrid
        label="Scores grid"
        columns={columns}
        rows={rows}
        selectable={false}
        search={search}
        setSearch={setSearch}
        searchKeys={['_home', '_away', '_division', '_date']}
        onCellChange={(gameId, key, value) => {
          const game = games.find((entry) => entry.id === gameId);
          if (!game) return;
          const scoreHome = key === 'score_home' ? value : (game.score_home ?? null);
          const scoreAway = key === 'score_away' ? value : (game.score_away ?? null);
          persistScore(gameId, scoreHome, scoreAway);
        }}
        emptyText="No past games yet — scores unlock once games have been played"
      />
    </Page>
  );
}
