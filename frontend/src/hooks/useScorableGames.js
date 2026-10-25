import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { isAdminRole } from '../constants/permissions.js';
import { logger } from '../lib/logger.js';

/**
 * Which games the caller may score, as `update_game_score` decides it since
 * 20261028010000 (plan docs/changes/2026-10-22-admin-focus.md, R6): an admin
 * or staff member any game in the organization, and nobody else. (The
 * league's `score_entry` setting is the page's to check; the server refuses
 * every caller while it is off.) Under an admin's role preview of a coach,
 * nothing is scorable, as for the coach. The pages offer score entry only
 * where this says yes; the server refuses the rest regardless.
 *
 * `coachesTeam(teamId)` answers whether the caller may act as a team's coach
 * (an admin may act for any team): the calendar token, which a coach still
 * rotates, uses it. `teamIds` is the coached teams, sorted, for a query to
 * filter on; `null` for an admin, who is not limited to any. `error` is true
 * when the coached teams could not be read, so a page can say so rather than
 * look like a coach with no teams.
 *
 * With `enabled: false` (a page that has nothing to score for this caller) it
 * asks the server nothing and allows nothing, except to an admin.
 *
 * @param {{ enabled?: boolean }} [options]
 * @returns {{ ready: boolean, error: boolean, teamIds: string[] | null, canScoreGame: (game: any) => boolean, coachesTeam: (teamId: any) => boolean }}
 */
export function useScorableGames({ enabled = true } = {}) {
  const { currentOrganization, orgMember } = useOrganization();
  const { user, isImpersonating } = useAuth();
  const orgId = currentOrganization?.id ?? null;
  const previewUserId = isImpersonating ? (user?.profile?.id ?? null) : null;
  const admin = !previewUserId && isAdminRole(orgMember?.role);
  const [teamIds, setTeamIds] = useState(/** @type {Set<string> | null} */ (null));
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setTeamIds(null);
      setError(false);
      if (admin) return;
      if (!orgId || !enabled) {
        // No organization, or nothing to score here: settled, so a page does not wait on it.
        setTeamIds(new Set());
        return;
      }
      const { data, error: readError } = previewUserId
        ? await supabase.rpc('admin_get_coached_team_ids', {
            p_organization_id: orgId,
            p_user_id: previewUserId,
          })
        : await supabase.rpc('get_my_coached_team_ids', { p_organization_id: orgId });
      if (cancelled) return;
      if (readError) {
        logger.warn('[useScorableGames] coached teams not loaded', {
          code: readError.code,
          message: readError.message,
        });
        setError(true);
        setTeamIds(new Set());
        return;
      }
      setTeamIds(new Set((data || []).map(String)));
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, admin, previewUserId, enabled]);

  return useMemo(() => {
    const coachesTeam = (teamId) =>
      admin || (!!teamIds && teamId != null && teamIds.has(String(teamId)));
    return {
      ready: admin || teamIds !== null,
      error: !admin && error,
      teamIds: admin ? null : [...(teamIds ?? [])].sort(),
      coachesTeam,
      // No coach scores, their own teams' games included (20261028010000).
      canScoreGame: (game) => admin && !!game,
    };
  }, [admin, teamIds, error]);
}
