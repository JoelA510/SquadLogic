import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { fetchAllPages } from '../lib/pagedFetch.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { logger } from '../lib/logger.js';
import { REFRESH_TOPICS, emitRefresh } from '../lib/refreshBus.js';

const NO_ROWS = Object.freeze([]);

/**
 * Players-grid data layer: the players and divisions of the season the header shows
 * (20261108010000: a player belongs to one season, and so does a division), with optimistic
 * mutations that all flow through the audited admin RPCs (never direct
 * table writes). Failed mutations roll back to the server snapshot.
 *
 * The season filter is not an authorization boundary: RLS stays organization-scoped, and the
 * filter only chooses which of the organization's seasons the page is about.
 */
export function usePlayersData() {
  const { currentOrganization, currentSeasonSetting, seasonSettingsLoading } = useOrganization();
  const orgId = currentOrganization?.id;
  const seasonId = currentSeasonSetting?.id;
  const isActiveSeason = currentSeasonSetting?.status === 'active';
  const [players, setPlayers] = useState([]);
  const [divisions, setDivisions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // What the loaded rows are of, and which fetch is the latest: a response for the season shown
  // before a switch must never replace the season shown after it, and the rows of the season left
  // are not served while the next one loads (a bulk action on the page would submit them).
  const key = orgId && seasonId ? `${orgId}|${seasonId}` : null;
  const [loadedKey, setLoadedKey] = useState(/** @type {string | null} */ (null));
  const latestRequestRef = useRef(0);

  const fetchAll = useCallback(async () => {
    if (!orgId || seasonSettingsLoading) return;
    const requestId = ++latestRequestRef.current;
    if (!seasonId) {
      // An organization with no season has no players to show.
      setPlayers([]);
      setDivisions([]);
      setLoadedKey(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [playersData, divisionsData] = await Promise.all([
        fetchAllPages(() =>
          supabase
            .from('players')
            .select('*')
            .eq('organization_id', orgId)
            .eq('season_settings_id', seasonId)
        ),
        fetchAllPages(() =>
          supabase
            .from('divisions')
            .select('*')
            .eq('organization_id', orgId)
            .eq('season_settings_id', seasonId)
        ),
      ]);
      if (latestRequestRef.current !== requestId) return;
      setPlayers(playersData);
      setDivisions(divisionsData);
      setLoadedKey(`${orgId}|${seasonId}`);
    } catch (err) {
      if (latestRequestRef.current !== requestId) return;
      logger.error('[usePlayersData] fetch failed:', err);
      setError(err.message || 'Failed to load players');
    } finally {
      if (latestRequestRef.current === requestId) setLoading(false);
    }
  }, [orgId, seasonId, seasonSettingsLoading]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  /** Optimistically apply `patch` to `ids`, run `rpc`, roll back on error. */
  const optimistic = useCallback(async (ids, patch, runRpc) => {
    const requestId = latestRequestRef.current;
    let snapshot;
    setPlayers((current) => {
      snapshot = current;
      return current.map((player) => (ids.includes(player.id) ? { ...player, ...patch } : player));
    });
    try {
      const { error: rpcError } = await runRpc();
      if (rpcError) throw rpcError;
      return { success: true };
    } catch (err) {
      logger.error('[usePlayersData] mutation failed:', err);
      // Another season may be shown by now: its rows are not the snapshot's to replace.
      if (latestRequestRef.current === requestId) setPlayers(snapshot);
      return { success: false, error: err.message || 'Update failed' };
    }
  }, []);

  const updatePlayer = useCallback(
    (playerId, patch) =>
      optimistic([playerId], patch, () =>
        supabase.rpc('admin_update_player', { p_player_id: playerId, p_patch: patch })
      ),
    [optimistic]
  );

  const bulkUpdatePlayers = useCallback(
    (playerIds, patch) =>
      optimistic(playerIds, patch, () =>
        supabase.rpc('admin_bulk_update_players', { p_player_ids: playerIds, p_patch: patch })
      ),
    [optimistic]
  );

  const createPlayer = useCallback(
    async (fields = {}) => {
      try {
        const { data, error: rpcError } = await supabase.rpc('admin_create_player', {
          p_organization_id: orgId,
          p_fields: fields,
          // Named only when the season shown is not the active one, which a call without it
          // means (20261108010000): a call for the active season keeps the shape it always had,
          // so a browser and a database a deploy apart still understand each other.
          ...(seasonId && !isActiveSeason ? { p_season_settings_id: seasonId } : {}),
        });
        if (rpcError) throw rpcError;
        if (data) setPlayers((current) => [...current, data]);
        emitRefresh(REFRESH_TOPICS.NAV_BADGES);
        return { success: true, player: data };
      } catch (err) {
        logger.error('[usePlayersData] create failed:', err);
        return { success: false, error: err.message || 'Create failed' };
      }
    },
    [orgId, seasonId, isActiveSeason]
  );

  const deletePlayers = useCallback(async (playerIds) => {
    const requestId = latestRequestRef.current;
    let snapshot;
    setPlayers((current) => {
      snapshot = current;
      return current.filter((player) => !playerIds.includes(player.id));
    });
    try {
      const { error: rpcError } = await supabase.rpc('admin_delete_players', {
        p_player_ids: playerIds,
      });
      if (rpcError) throw rpcError;
      emitRefresh(REFRESH_TOPICS.NAV_BADGES);
      return { success: true };
    } catch (err) {
      logger.error('[usePlayersData] delete failed:', err);
      if (latestRequestRef.current === requestId) setPlayers(snapshot);
      return { success: false, error: err.message || 'Delete failed' };
    }
  }, []);

  const current = key === loadedKey;
  return {
    players: current ? players : NO_ROWS,
    divisions: current ? divisions : NO_ROWS,
    loading: loading || (key !== null && !current),
    error,
    refetch: fetchAll,
    updatePlayer,
    bulkUpdatePlayers,
    createPlayer,
    deletePlayers,
  };
}
