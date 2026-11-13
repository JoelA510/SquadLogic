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
import ScoreNotSavedAlert from '../components/ScoreNotSavedAlert.jsx';
import { scoreRefusalText } from '../utils/scoreEntry.js';
import { useScoreDrafts } from '../hooks/useScoreDrafts.js';
import { fetchCurrentGameRunIds, fetchSavedGames, hasStarted } from '../utils/savedGamesClient.js';

/**
 * How many results of the season belong to games that are not in its saved schedule (the current game run). Old data
 * only: a scored game is held, so a save cannot leave one behind. They still count in the standings, so the page
 * counts them in a sentence instead of hiding them.
 */
async function countScoresOutsideSchedule(organizationId, seasonId, runIds) {
  let query = supabase
    .from('game_assignments')
    .select('id, game_scores!inner(game_id)', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('season_settings_id', seasonId);
  // A season has one current run, or none (then every scored game of the season is outside it).
  if (runIds.length > 0) query = query.neq('run_id', runIds[0]);
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

/**
 * Scores & Results — spreadsheet-style score entry over the played games of the season's saved schedule
 * (`game_assignments` of the current game run, with their `game_scores`; F11-3), persisting through the audited
 * update_game_score RPC (the same path LeagueStandings uses; standings are computed from it). A score is both numbers
 * or none, so a half-entered score is held on the page and the two are sent together. An admin page the league turns
 * on (`score_entry`; the route checks it, and the RPC refuses every caller while it is off).
 */
export default function ScoresPage() {
  const { currentOrganization, currentSeasonSetting, availableSeasons } = useOrganization();
  const { genderModel } = useFeatures();
  const toast = useToast();
  const [games, setGames] = useState([]);
  const [notSaved, setNotSaved] = useState(/** @type {string | null} */ (null));
  const [loadFailed, setLoadFailed] = useState(false);
  const [outsideSchedule, setOutsideSchedule] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const orgId = currentOrganization?.id;
  const seasonId = currentSeasonSetting?.id ?? null;
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
      const gameSeason =
        game?.season_settings_id ?? game?.home_team?.division?.season_settings_id ?? null;
      return gameSeason !== null && completedSeasonIds.has(String(gameSeason));
    },
    [completedSeasonIds]
  );

  // What is typed and not saved yet, one game at a time (hooks/useScoreDrafts.js, shared with the Standings page).
  const {
    type: typeScoreBox,
    stateOf,
    reset: resetDrafts,
    isSaving,
  } = useScoreDrafts({
    save: async (game, entry) => {
      const { error } = await supabase.rpc('update_game_score', {
        p_organization_id: orgId,
        p_game_id: game.id,
        p_score_home: entry.score_home,
        p_score_away: entry.score_away,
      });
      if (error) throw error;
    },
    onSaved: (game, entry) => {
      setGames((current) =>
        current.map((row) => (row.id === game.id ? { ...row, ...entry } : row))
      );
      setNotSaved(null);
      toast(entry.score_home === null ? 'Score cleared' : 'Score saved', 'success');
    },
    onRefused: (err) => {
      logger.error('[ScoresPage] score update failed:', err);
      // The row goes back to the saved score, and why is said in words that stay on the page.
      setNotSaved(scoreRefusalText(err));
    },
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!orgId) return;
      setLoading(true);
      setLoadFailed(false);
      resetDrafts();
      try {
        // With no season selected there is no schedule to list.
        const runIds = seasonId
          ? await fetchCurrentGameRunIds({ organizationId: orgId, seasonId })
          : [];
        const saved = await fetchSavedGames({ runIds });
        const now = Date.now();
        const played = saved
          .filter((game) => hasStarted(game, now))
          .sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
        const outside = seasonId ? await countScoresOutsideSchedule(orgId, seasonId, runIds) : 0;
        if (cancelled) return;
        setGames(played);
        setOutsideSchedule(outside);
      } catch (err) {
        logger.error('[ScoresPage] load failed:', err);
        if (!cancelled) {
          setGames([]);
          setOutsideSchedule(0);
          setLoadFailed(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, seasonId, resetDrafts]);

  const enterScore = useCallback(
    (gameId, side, value) => {
      const saved = games.find((game) => game.id === gameId);
      if (!saved || isCompletedSeasonGame(saved)) return;
      typeScoreBox(saved, side, value);
    },
    [games, isCompletedSeasonGame, typeScoreBox]
  );

  const rows = useMemo(
    () =>
      games.map((game) => {
        // What the boxes hold: the saved score with what is typed and unsaved over it.
        const state = stateOf(game);
        return {
          ...game,
          score_home: state.score_home,
          score_away: state.score_away,
          _state: state,
          _date: game.start ? new Date(game.start).toLocaleDateString() : '—',
          _division: divisionDisplayName(
            game.home_team?.division?.name || game.home_team?.division || '',
            genderModel
          ),
          _home: game.home_team?.name || '—',
          _away: game.away_team?.name || '—',
          _final:
            !state.half && !state.notAScore && state.score_home != null && state.score_away != null,
        };
      }),
    [games, stateOf, genderModel]
  );

  const columns = useMemo(
    () =>
      /** @type {any[]} */ ([
        {
          key: '_date',
          label: 'Date',
          width: 110,
          sortVal: (row) => row.start || '',
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
          step: 1,
          inputMode: 'numeric',
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
          step: 1,
          inputMode: 'numeric',
          placeholder: '–',
        },
        { key: '_away', label: 'Away', width: 180 },
        {
          key: '_final',
          label: 'Status',
          width: 90,
          sortable: false,
          render: (row) =>
            row._state.saving ? (
              <Badge tone="info">Saving</Badge>
            ) : row._state.notAScore ? (
              <Badge tone="warning">Not a score</Badge>
            ) : row._state.half ? (
              <Badge tone="warning">Enter both scores</Badge>
            ) : row._final ? (
              <Badge tone="success">Final</Badge>
            ) : (
              <Badge>Awaiting</Badge>
            ),
        },
      ]),
    []
  );

  const hasReadOnlyGames = games.some(isCompletedSeasonGame);

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
      <ScoreNotSavedAlert message={notSaved} className="mx-4 mt-3" />
      {loadFailed && (
        <p
          role="alert"
          data-testid="scores-load-failed"
          className="mx-4 mt-3 rounded-lg border border-status-error/30 bg-status-error-bg px-4 py-2 text-sm font-medium text-status-error"
        >
          The games could not be loaded. Reload the page to try again.
        </p>
      )}
      {outsideSchedule > 0 && (
        <p
          role="note"
          data-testid="scores-outside-schedule"
          className="mx-4 mt-3 rounded-lg border border-border-subtle bg-bg-surface px-4 py-2 text-sm text-text-secondary"
        >
          {outsideSchedule === 1
            ? '1 earlier result is not listed here: its game is no longer in the saved schedule. It still counts in the standings.'
            : `${outsideSchedule} earlier results are not listed here: their games are no longer in the saved schedule. They still count in the standings.`}
        </p>
      )}
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
        isRowReadOnly={(row) => isCompletedSeasonGame(row) || isSaving(row)}
        columns={columns}
        rows={rows}
        selectable={false}
        search={search}
        setSearch={setSearch}
        searchKeys={['_home', '_away', '_division', '_date']}
        onCellChange={(gameId, key, value) => enterScore(gameId, key, value)}
        emptyText="No past games yet — scores unlock once games have been played"
      />
    </Page>
  );
}
