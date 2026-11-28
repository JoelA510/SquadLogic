import { useEffect, useState } from 'react';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { useImport } from '../contexts/ImportContext.jsx';
import { fetchAllPages } from '../lib/pagedFetch.js';
import { supabase } from '../lib/supabaseClient.js';
import { getPlayerExternalId } from '../utils/teamReviewPersistence.js';

/** Use this session's player import while reviewing it, and the saved season roster on return. */
export function useSeasonTeamingInput() {
  const { importedData, playerImportFromHistory } = useImport();
  const file = playerImportFromHistory ? null : importedData;
  const { currentOrganization, currentSeasonSetting } = useOrganization();
  const orgId = currentOrganization?.id;
  const seasonId = currentSeasonSetting?.id;
  const key = orgId && seasonId ? orgId + '/' + seasonId : null;
  // A caller can supply an unscoped, in-memory preview. Restored import history stays on the import screen.
  const preview = file && !file.scope ? file : null;
  const live = file?.scope === key ? file : null;
  const [saved, setSaved] = useState(null);

  useEffect(() => {
    if (!key || preview) return undefined;
    let cancelled = false;
    async function read() {
      try {
        const rows = await fetchAllPages(() =>
          supabase
            .from('players')
            .select(
              'id, external_registration_id, first_name, last_name, preferred_name, division_id, divisions(name), gender, status, natural_age, years_played, rating, skill_tier, willing_to_coach, play_up_requested, buddy_request, mutual_buddy_code'
            )
            .eq('organization_id', orgId)
            .eq('season_settings_id', seasonId)
        );
        // A late or corrected file can contain only one of the season's players. Carry over
        // transient hints for matching registrations while counting everyone on the saved roster.
        const hints = new Map();
        for (const row of live?.data ?? []) {
          // The finalizer promotes the first valid row for a registration ID, in file order.
          const registration = getPlayerExternalId(row);
          if (registration && !hints.has(registration)) hints.set(registration, row);
        }
        const idsByRegistration = new Map(
          rows
            .filter((row) => row.external_registration_id)
            .map((row) => [row.external_registration_id.trim().toLowerCase(), row.id])
        );
        const data = rows.map(({ divisions, ...player }) => {
          const buddyId = idsByRegistration.get(player.buddy_request?.trim().toLowerCase());
          return {
            ...(player.external_registration_id && hints.get(player.external_registration_id)),
            ...player,
            division_name: divisions?.name,
            ...(buddyId && buddyId !== player.id ? { buddy_id: buddyId } : {}),
          };
        });
        if (!cancelled)
          setSaved({
            key,
            live,
            input: data.length ? { data, totalRows: data.length, fromRoster: true } : null,
            error: null,
          });
      } catch (err) {
        if (!cancelled)
          setSaved({
            key,
            live,
            input: null,
            error: 'Could not load players for teaming: ' + (err?.message || 'Roster read failed.'),
          });
      }
    }
    read();
    return () => {
      cancelled = true;
    };
  }, [key, orgId, seasonId, live, preview]);

  const current = saved?.key === key && saved?.live === live ? saved : null;
  return {
    importedData: preview ?? current?.input ?? null,
    rosterError: preview ? null : current?.error,
  };
}
