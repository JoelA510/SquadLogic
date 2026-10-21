import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { isAdminRole } from '../constants/permissions.js';
import { logger } from '../lib/logger.js';

/**
 * Which games the caller may score, as `update_game_score` decides it
 * (20261021020000): an admin or staff member any game in the organization,
 * anyone else only a game of a team they currently coach
 * (`get_my_coached_team_ids`, or `admin_get_coached_team_ids` for the coach an
 * admin is previewing). The pages offer score entry only where this says yes;
 * the server refuses the rest regardless.
 *
 * `coachesTeam(teamId)` answers the same question for a team: whether the
 * caller may act as its coach (an admin may act for any team).
 *
 * @returns {{ ready: boolean, canScoreGame: (game: any) => boolean, coachesTeam: (teamId: any) => boolean }}
 */
export function useScorableGames() {
  const { currentOrganization, orgMember } = useOrganization();
  const { user, isImpersonating } = useAuth();
  const orgId = currentOrganization?.id ?? null;
  const previewUserId = isImpersonating ? (user?.profile?.id ?? null) : null;
  const admin = !previewUserId && isAdminRole(orgMember?.role);
  const [teamIds, setTeamIds] = useState(/** @type {Set<string> | null} */ (null));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setTeamIds(null);
      if (admin) return;
      if (!orgId) {
        // No organization, no team to coach: settled, so a page does not wait on it.
        setTeamIds(new Set());
        return;
      }
      const { data, error } = previewUserId
        ? await supabase.rpc('admin_get_coached_team_ids', {
            p_organization_id: orgId,
            p_user_id: previewUserId,
          })
        : await supabase.rpc('get_my_coached_team_ids', { p_organization_id: orgId });
      if (cancelled) return;
      if (error) {
        // No team ids means no score entry; the read failure is logged, not shown.
        logger.warn('[useScorableGames] coached teams not loaded', {
          code: error.code,
          message: error.message,
        });
        setTeamIds(new Set());
        return;
      }
      setTeamIds(new Set((data || []).map(String)));
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, admin, previewUserId]);

  return useMemo(() => {
    const teamOf = (side) => (side && typeof side === 'object' ? side.id : side);
    const coachesTeam = (teamId) =>
      admin || (!!teamIds && teamId != null && teamIds.has(String(teamId)));
    return {
      ready: admin || teamIds !== null,
      coachesTeam,
      canScoreGame: (game) => {
        if (admin) return true;
        if (!teamIds || !game) return false;
        const home = teamOf(game.home_team) ?? game.home_team_id;
        const away = teamOf(game.away_team) ?? game.away_team_id;
        return teamIds.has(String(home)) || teamIds.has(String(away));
      },
    };
  }, [admin, teamIds]);
}
