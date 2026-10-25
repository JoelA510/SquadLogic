import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { logger } from '../lib/logger.js';

/**
 * The server's answer to "which teams does this coach coach now": the caller's
 * (`get_my_coached_team_ids`), or, under an admin's role preview, the previewed
 * coach's (`admin_get_coached_team_ids`). The one read both this hook and
 * `useScorableGames` make; returns the client's `{ data, error }`.
 *
 * @param {string} orgId
 * @param {string | null} previewUserId
 */
export function fetchCoachedTeamIds(orgId, previewUserId) {
  return previewUserId
    ? supabase.rpc('admin_get_coached_team_ids', {
        p_organization_id: orgId,
        p_user_id: previewUserId,
      })
    : supabase.rpc('get_my_coached_team_ids', { p_organization_id: orgId });
}

/**
 * The teams the caller currently coaches in the current organization, as the
 * server decides it (20261021010000): a live `team_coach_assignments` row of
 * their linked coach record, judged in each team's season timezone. An
 * admin's role preview keeps the admin's session (`auth.uid()`), so the
 * previewed coach's teams come from the admin-only read for that profile.
 *
 * Each team carries its division and its season's timezone, the clock its
 * schedule is placed on (`fetchTeamEvents`). Sorted by name.
 *
 * `loaded` is false until the read for the current organization settles;
 * `error` is true when it failed, so a page can say so rather than look like
 * a coach with no team.
 *
 * Shared by the coach home and the "My Team" link (plan
 * docs/changes/2026-10-22-admin-focus.md, R6).
 *
 * @returns {{ teams: Array<{ id: string, name: string, division_id: string | null,
 *   division: { id: string, name: string, season: { id: string, timezone: string | null } | null } | null }>,
 *   loaded: boolean, error: boolean, previewUserId: string | null }}
 */
export function useMyCoachedTeams() {
  const { currentOrganization } = useOrganization();
  const { user, isImpersonating } = useAuth();
  const orgId = currentOrganization?.id ?? null;
  const previewUserId = isImpersonating ? (user?.profile?.id ?? null) : null;
  const [state, setState] = useState({ teams: [], loaded: false, error: false, key: null });
  const key = `${orgId}|${previewUserId ?? ''}`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!orgId) return;
      try {
        const { data: teamIds, error: idsError } = await fetchCoachedTeamIds(orgId, previewUserId);
        if (idsError) throw idsError;
        const ids = (teamIds || []).map(String);
        let teams = [];
        if (ids.length > 0) {
          const { data: rows, error: teamsError } = await supabase
            .from('teams')
            .select(
              'id, name, division_id, division:divisions (id, name, season:season_settings (id, timezone))'
            )
            .eq('organization_id', orgId)
            .in('id', ids);
          if (teamsError) throw teamsError;
          teams = (rows || []).sort((a, b) => String(a.name).localeCompare(String(b.name)));
        }
        if (!cancelled) setState({ teams, loaded: true, error: false, key });
      } catch (err) {
        logger.error('[useMyCoachedTeams] load failed:', err);
        if (!cancelled) setState({ teams: [], loaded: true, error: true, key });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, previewUserId, key]);

  // No organization: nothing to read, and nothing coached.
  if (!orgId) return { teams: [], loaded: true, error: false, previewUserId };
  // Nothing of the previous organization (or previewed coach) shows while
  // this one loads.
  if (state.key !== key) return { teams: [], loaded: false, error: false, previewUserId };
  return { teams: state.teams, loaded: state.loaded, error: state.error, previewUserId };
}
