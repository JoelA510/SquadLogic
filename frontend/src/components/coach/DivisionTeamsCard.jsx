import React, { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { Users } from 'lucide-react';
import DataErrorBanner from '../ui/DataErrorBanner.jsx';
import { supabase } from '../../lib/supabaseClient.js';
import { useFeatures } from '../../hooks/useFeatures.js';
import { divisionDisplayName } from '../../utils/divisions.js';
import { logger } from '../../lib/logger.js';

/**
 * The teams in the coach's divisions, with their coaches' names and no
 * contact details (plan docs/changes/2026-10-22-admin-focus.md, R6): the
 * server read `get_my_division_teams` (20261028010000), or, under an admin's
 * role preview, `admin_get_division_teams` for the previewed coach.
 *
 * @param {{ orgId: string, previewUserId: string | null }} props
 */
export default function DivisionTeamsCard({ orgId, previewUserId }) {
  const { genderModel } = useFeatures();
  const [state, setState] = useState(
    /** @type {{ rows: any[], loaded: boolean, error: boolean }} */ ({
      rows: [],
      loaded: false,
      error: false,
    })
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setState({ rows: [], loaded: false, error: false });
      const { data, error } = previewUserId
        ? await supabase.rpc('admin_get_division_teams', {
            p_organization_id: orgId,
            p_user_id: previewUserId,
          })
        : await supabase.rpc('get_my_division_teams', { p_organization_id: orgId });
      if (cancelled) return;
      if (error) {
        logger.error('[DivisionTeamsCard] division teams not loaded', {
          code: error.code,
          message: error.message,
        });
        setState({ rows: [], loaded: true, error: true });
        return;
      }
      setState({ rows: data || [], loaded: true, error: false });
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, previewUserId]);

  // One table per division, in the order the server returns them.
  const divisions = [];
  const byDivision = new Map();
  for (const row of state.rows) {
    const key = String(row.division_id);
    if (!byDivision.has(key)) {
      const entry = { id: key, name: row.division_name, teams: [] };
      byDivision.set(key, entry);
      divisions.push(entry);
    }
    byDivision.get(key).teams.push(row);
  }

  return (
    <section className="card" aria-labelledby="division-teams-heading">
      <div className="card-head">
        <Users size={18} style={{ color: 'var(--accent-teal)' }} aria-hidden="true" />
        <h3 id="division-teams-heading">Your division</h3>
      </div>
      <div className="card-body" aria-busy={!state.loaded}>
        {!state.loaded && <p className="muted">Loading your division…</p>}
        {state.error && (
          <DataErrorBanner message="Your division's teams could not be loaded. Try again shortly." />
        )}
        {state.loaded && !state.error && divisions.length === 0 && (
          <p className="muted">Your division appears here once you are assigned a team.</p>
        )}
        {divisions.map((division) => (
          <table
            key={division.id}
            className="w-full text-sm"
            style={{ marginBottom: 12 }}
            data-testid="division-teams"
          >
            <caption style={{ textAlign: 'left', fontWeight: 700, padding: '4px 0' }}>
              {divisionDisplayName(division.name, genderModel)}
            </caption>
            <thead>
              <tr className="muted">
                <th scope="col" style={{ textAlign: 'left', padding: '4px 0' }}>
                  Team
                </th>
                <th scope="col" style={{ textAlign: 'left', padding: '4px 0' }}>
                  Coaches
                </th>
              </tr>
            </thead>
            <tbody>
              {division.teams.map((team) => (
                <tr key={team.team_id} style={{ borderTop: '1px solid var(--border-soft)' }}>
                  <th scope="row" style={{ textAlign: 'left', padding: '6px 0', fontWeight: 600 }}>
                    {team.team_name}
                    {team.is_mine && <span className="muted"> (your team)</span>}
                  </th>
                  <td style={{ padding: '6px 0' }}>
                    {(team.coach_names || []).length > 0 ? (
                      team.coach_names.join(', ')
                    ) : (
                      <span className="muted">No coach assigned</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>
    </section>
  );
}

DivisionTeamsCard.propTypes = {
  orgId: PropTypes.string.isRequired,
  previewUserId: PropTypes.string,
};
