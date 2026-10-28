import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { REFRESH_TOPICS, subscribeRefresh } from '../lib/refreshBus.js';

const EMPTY = { players: null, coaches: null, teams: null };

/**
 * Lightweight counts for the side-nav badges: the players and coaches of the season the header
 * shows (20261108010000), the teams of the organization. Asks the server to count
 * (`{ count: 'exact', head: true }`: no rows come back), because counting the
 * rows returned is capped by the server's row limit (`max_rows = 1000`) and a
 * league of 1,259 players read "1000". Null means "no badge" (loading, error,
 * or zero). Re-fetches when a mutation elsewhere emits the NAV_BADGES refresh
 * topic (e.g. player add/delete).
 */
export function useNavBadges() {
  const { currentOrganization, currentSeasonSetting } = useOrganization();
  const orgId = currentOrganization?.id;
  const seasonId = currentSeasonSetting?.id ?? null;
  // Keyed by org and season so a stale one's counts never render after switching.
  const [state, setState] = useState({ key: null, badges: EMPTY });
  const key = orgId ? `${orgId}|${seasonId}` : null;
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(
    () => subscribeRefresh(REFRESH_TOPICS.NAV_BADGES, () => setRefreshTick((tick) => tick + 1)),
    []
  );

  useEffect(() => {
    if (!orgId) return undefined;
    let cancelled = false;

    const countRows = async (table, seasonScoped = false) => {
      try {
        let query = supabase
          .from(table)
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', orgId);
        if (seasonScoped) query = query.eq('season_settings_id', seasonId);
        const { count, error } = await query;
        // An unanswered count is no badge, never a wrong number.
        if (error || typeof count !== 'number') return null;
        return count || null;
      } catch {
        return null;
      }
    };

    (async () => {
      const [players, coaches, teams] = await Promise.all([
        // No season shown (none yet, or still loading): no people badge, never a wrong number.
        seasonId ? countRows('players', true) : null,
        seasonId ? countRows('coaches', true) : null,
        countRows('teams'),
      ]);
      if (!cancelled) {
        setState({ key, badges: { players, coaches, teams } });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [orgId, seasonId, key, refreshTick]);

  return state.key === key ? state.badges : EMPTY;
}
