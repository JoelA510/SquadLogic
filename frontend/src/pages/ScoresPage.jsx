import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Flag } from 'lucide-react';
import Page from '../components/chrome/Page.jsx';
import PageHeader from '../components/chrome/PageHeader.jsx';
import DataGrid from '../components/grid/DataGrid.jsx';
import Badge from '../components/ui/Badge.jsx';
import { useToast } from '../components/ui/ToastHost.jsx';
import { supabase } from '../lib/supabaseClient.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { useFeatures } from '../hooks/useFeatures.js';
import { divisionDisplayName } from '../utils/divisions.js';
import { logger } from '../lib/logger.js';
import LoadingScreen from '../components/LoadingScreen.jsx';

/**
 * Scores & Results — spreadsheet-style score entry over past games,
 * persisting through the audited update_game_score RPC (the same path
 * LeagueStandings uses; standings views refresh from it). An admin page the
 * league turns on (`score_entry`; the route checks it, and the RPC refuses
 * every caller while it is off).
 */
/**
 * Whether a refused save is one this page cannot ever make as it stands: the database does not find the game (the id
 * is a legacy `games` row, and a score names a saved game), or was sent one score without the other.
 * @param {any} err
 */
function isNotSavableFromThisPage(err) {
  return (
    err?.details === 'score_one_sided' ||
    (err?.code === '42501' && /^Game not found/.test(String(err?.message ?? '')))
  );
}

export default function ScoresPage() {
  const { currentOrganization, availableSeasons } = useOrganization();
  const { genderModel } = useFeatures();
  const toast = useToast();
  const [games, setGames] = useState([]);
  const [cannotSave, setCannotSave] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const orgId = currentOrganization?.id;
  // A completed season's scores are history (20261111010000: the database refuses the write): its
  // games are listed and cannot be edited. A game's season is its own, else its division's.
  const completedSeasonIds = useMemo(
    () =>
      new Set(
        (availableSeasons ?? [])
          .filter((season) => season.status === 'completed')
          .map((season) => String(season.id))
      ),
    [availableSeasons]
  );
  const isCompletedSeasonGame = useCallback(
    (game) => {
      const seasonId = game?.season_id ?? game?.home_team?.division?.season_settings_id ?? null;
      return seasonId !== null && completedSeasonIds.has(String(seasonId));
    },
    [completedSeasonIds]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!orgId) return;
      setLoading(true);
      try {
        const { data, error } = await supabase
          .from('games')
          .select(
            `id, season_id, start_time, score_home, score_away,
             home_team:home_team_id (id, name, division:divisions (name, season_settings_id)),
             away_team:away_team_id (id, name)`
          )
          .eq('organization_id', orgId)
          .lte('start_time', new Date().toISOString())
          .order('start_time', { ascending: false })
          .limit(200);
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
  }, [orgId]);

  const persistScore = useCallback(
    async (gameId, scoreHome, scoreAway) => {
      const previous = games.find((game) => game.id === gameId);
      if (isCompletedSeasonGame(previous)) return;
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
        });
        if (error) throw error;
        setCannotSave(false);
        toast('Score saved', 'success');
      } catch (err) {
        logger.error('[ScoresPage] score update failed:', err);
        setGames((current) => current.map((game) => (game.id === gameId ? previous : game)));
        // Since 20261122010000 a score is kept against the SAVED schedule and both scores are entered together,
        // while this page still lists the earlier games table and saves one cell at a time (it is repointed by F11-3
        // of docs/changes/2026-11-06-games-table-source-of-truth.md). The database then answers "not found" or "one
        // score without the other": said here in words that stay on the page, because trying again cannot work.
        if (isNotSavableFromThisPage(err)) setCannotSave(true);
        else toast('Failed to save score', 'warning');
      }
    },
    [games, orgId, toast, isCompletedSeasonGame]
  );

  const rows = useMemo(
    () =>
      games.map((game) => ({
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
    [games, genderModel]
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

  const hasReadOnlyGames = games.some(isCompletedSeasonGame);
  const cannotSaveNote = cannotSave && (
    <p
      role="alert"
      data-testid="scores-cannot-save"
      className="mx-4 mt-3 rounded-lg border border-status-error/30 bg-status-error-bg px-4 py-2 text-sm font-medium text-status-error"
    >
      The score was not saved. Scores are now kept against the saved schedule, and this page still
      lists games from the earlier games table, so it cannot save a score yet. Nothing was changed.
    </p>
  );

  if (loading) return <LoadingScreen />;

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
      {cannotSaveNote}
      {hasReadOnlyGames && (
        <p
          role="note"
          data-testid="season-readonly-note"
          className="mx-4 mt-3 rounded-lg border border-border-subtle bg-bg-surface px-4 py-2 text-sm text-text-secondary"
        >
          Games of a completed season are read-only: their scores are history and cannot be changed.
        </p>
      )}
      <DataGrid
        label="Scores grid"
        isRowReadOnly={isCompletedSeasonGame}
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
