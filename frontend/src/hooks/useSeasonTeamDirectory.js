import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { logger } from '../lib/logger.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { readSeasonTeamDirectory } from '../utils/scheduleReportsRead.js';

const NONE = /** @type {Array<any>} */ (Object.freeze([]));

/**
 * The season's teams as the tables hold them, outside clubs included, for a page that NAMES the teams of saved games
 * (PR 5, fix round 2). The latest team run holds the league's own teams only: an outside club is in no run, so a name
 * looked up there shows the club as its id. This is for names only (a page that hands teams to the solver keeps using the
 * run's teams, which is right: an outside club is never scheduled).
 *
 * **Best effort, said so:** a directory that cannot be read leaves the names as they were (the id, as before), logged;
 * nothing is written or exported from it. The exports read the directory all-or-nothing instead
 * (`readSeasonTeamDirectory`, `OutputGenerationPanel`), because a file made over a partial directory leaves games out.
 *
 * @returns {Array<{ id: string, name: string, divisionId: string, division: string, isExternal: boolean }>}
 */
export function useSeasonTeamDirectory() {
  const { currentOrganization, currentSeasonSetting } = useOrganization() || {};
  const organizationId = currentOrganization?.id ?? null;
  const seasonSettingsId = currentSeasonSetting?.id ?? null;
  // The read is kept with the key it was made for, so another season's teams are never shown for this one.
  const key = organizationId && seasonSettingsId ? `${organizationId}:${seasonSettingsId}` : null;
  const [read, setRead] = useState({ key: null, teams: NONE });
  useEffect(() => {
    if (!key) return undefined;
    let current = true;
    readSeasonTeamDirectory(supabase, { organizationId, seasonSettingsId }).then(
      (result) => {
        if (!current) return;
        if (result.ok === true) setRead({ key, teams: result.teams });
        else
          logger?.warn?.(
            'Season team directory not read; team names stay as they were:',
            result.message
          );
      },
      (err) => {
        // Best-effort display lookup: a rejected read leaves the names as they were.
        logger?.warn?.('Season team directory read failed:', err);
      }
    );
    return () => {
      current = false;
    };
  }, [key, organizationId, seasonSettingsId]);
  return read.key === key ? read.teams : NONE;
}
