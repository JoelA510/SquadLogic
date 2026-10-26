import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { fetchAllPages } from '../lib/pagedFetch.js';
import { logger } from '../lib/logger.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';

const IDLE = { status: 'idle', key: null, players: null, coaches: null, error: null };

/**
 * The people a roster names: every durable player (id to name and rating) and every coach (id
 * to name) of the active organization, for the manual roster editor.
 *
 * ## Why this exists
 *
 * A team run keeps its rosters as ids (`team_players: [{ team_id, player_id }]`) and each team
 * its coaches as ids (`coachId`, `assistantCoachIds`). The editor took names from the signed-in
 * user's own player import (`useImport().importedData`, a per-user `imports` row) and from a
 * `player_name` only a reviewed save writes. A league formed any other way, such as the demo
 * league's seeded run, or opened by an admin who did not do the import, had neither, so every
 * player read "Unknown Player" and every coach "1 on file, 1 name not loaded". The names are in
 * `players` and `coaches`; this reads them.
 *
 * ## Never partial
 *
 * Both reads page to the end (`fetchAllPages`): an unranged select is cut at the server's row
 * cap (`max_rows = 1000`), and a league of more than 1,000 players would have named the first
 * thousand and called the rest unknown. A page that fails fails the read: `status` is `'error'`
 * and no rows are served, so the editor never shows half the names as if they were all.
 *
 * Reads only while `enabled` (the editor is open), once per organization.
 *
 * @param {{ enabled: boolean }} options
 * @returns {{
 *   status: 'idle' | 'loading' | 'ready' | 'error',
 *   players: Map<string, { name: string, rating: number | null }>,
 *   coaches: Map<string, string>,
 *   error: string | null,
 *   retry: () => void,
 * }}
 */
export function useRosterDirectory({ enabled }) {
  const { currentOrganization } = useOrganization();
  const orgId = currentOrganization?.id ?? null;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState(IDLE);
  const key = orgId ? `${orgId}|${attempt}` : null;

  useEffect(() => {
    if (!enabled || !orgId || !key) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const [playerRows, coachRows] = await Promise.all([
          fetchAllPages(() =>
            supabase
              .from('players')
              .select('id, first_name, last_name, rating')
              .eq('organization_id', orgId)
          ),
          fetchAllPages(() =>
            supabase.from('coaches').select('id, full_name').eq('organization_id', orgId)
          ),
        ]);
        if (cancelled) return;
        const players = new Map();
        for (const row of playerRows) {
          const name = [row.first_name, row.last_name]
            .map((part) => String(part ?? '').trim())
            .filter(Boolean)
            .join(' ');
          players.set(String(row.id), {
            name,
            rating: Number.isFinite(row.rating) ? row.rating : null,
          });
        }
        const coaches = new Map();
        for (const row of coachRows) {
          const name = String(row.full_name ?? '').trim();
          if (name) coaches.set(String(row.id), name);
        }
        setState({ status: 'ready', key, players, coaches, error: null });
      } catch (err) {
        if (cancelled) return;
        logger.error('[useRosterDirectory] read failed:', err);
        setState({
          status: 'error',
          key,
          players: null,
          coaches: null,
          error: err?.message || 'Player and coach names could not be loaded.',
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, orgId, key]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  // A result for another organization or attempt is never served.
  const current = state.key === key;
  const status = /** @type {'idle' | 'loading' | 'ready' | 'error'} */ (
    !enabled || !orgId ? 'idle' : current ? state.status : 'loading'
  );
  const players = current && state.players ? state.players : EMPTY_PLAYERS;
  const coaches = current && state.coaches ? state.coaches : EMPTY_COACHES;
  const error = current ? state.error : null;
  // One object per result, so a memo keyed on it is recomputed when the read changes and not
  // on every render of the page.
  return useMemo(
    () => ({ status, players, coaches, error, retry }),
    [status, players, coaches, error, retry]
  );
}

const EMPTY_PLAYERS = new Map();
const EMPTY_COACHES = new Map();
