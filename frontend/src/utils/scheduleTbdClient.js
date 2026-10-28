import { scheduleTbdItemsFromRows } from '@squadlogic/core/scheduleTbd.js';

/**
 * Read the season's TIME TBD list (`get_schedule_tbd`, admin only) for the master export.
 *
 * **A list that cannot be read is an error, never an empty list.** The export is the last place a
 * missing practice or an unplaced game can go unsaid, so a refused or failed read throws and the
 * caller says the files were not made. (A caller with no season has nothing to read and does not
 * call this.)
 *
 * @param {any} client - the supabase client
 * @param {string} seasonSettingsId
 * @returns {Promise<{ rows: Array<Record<string, any>>, items: Array<import('@squadlogic/core/scheduleTbd.js').ScheduleTbdItem> }>}
 */
export async function readScheduleTbd(client, seasonSettingsId) {
  if (typeof client?.rpc !== 'function') {
    throw new Error('there is no database connection to read the TIME TBD list with');
  }
  const { data, error } = await client.rpc('get_schedule_tbd', {
    p_season_settings_id: seasonSettingsId,
  });
  if (error) throw new Error(error.message || 'the TIME TBD list could not be read');
  return { rows: data, items: scheduleTbdItemsFromRows(data) };
}

/**
 * Bring the season's practice list up to date, then read the whole list.
 *
 * `refresh_schedule_tbd_practices` rebuilds the practice rows from the roster, each division's
 * practices a week and the saved assignments, keeping the reason of a team it already listed. The
 * export calls it because the list is otherwise rebuilt only by a practice save, and a run that
 * places nothing never reaches one: without the refresh the export would leave out practices the
 * roster says are owed. **A refresh that fails is an error, never a stale list**: the caller says
 * the files were not made, because a list that could not be brought up to date may be missing
 * practices.
 *
 * @param {any} client - the supabase client
 * @param {string} seasonSettingsId
 * @param {{ readOnly?: boolean }} [options] - `readOnly`: the season is completed; read the list, do not refresh it
 * @returns {Promise<{ rows: Array<Record<string, any>>, items: Array<import('@squadlogic/core/scheduleTbd.js').ScheduleTbdItem> }>}
 */
export async function refreshAndReadScheduleTbd(
  client,
  seasonSettingsId,
  { readOnly = false } = {}
) {
  // A completed season is history (20261109010000): its list is read as it was kept, never rebuilt
  // (the database refuses the rebuild), so looking back at it and exporting it still work.
  if (!readOnly) await refreshScheduleTbd(client, seasonSettingsId);
  return readScheduleTbd(client, seasonSettingsId);
}

/**
 * Bring the season's practice list up to date (admin only; audited when it changed). Throws when the
 * refresh fails.
 *
 * @param {any} client - the supabase client
 * @param {string} seasonSettingsId
 * @returns {Promise<{ changed: boolean, practice_rows: number, missing_practices: number }>}
 */
export async function refreshScheduleTbd(client, seasonSettingsId) {
  if (typeof client?.rpc !== 'function') {
    throw new Error('there is no database connection to refresh the TIME TBD list with');
  }
  const { data, error } = await client.rpc('refresh_schedule_tbd_practices', {
    p_season_settings_id: seasonSettingsId,
  });
  if (error) throw new Error(error.message || 'the TIME TBD list could not be refreshed');
  return data;
}

/**
 * How many export rows a list gives: one per missing practice, one per unplaced game (printed for
 * both teams).
 *
 * @param {Array<import('@squadlogic/core/scheduleTbd.js').ScheduleTbdItem>} items
 * @returns {{ practices: number, games: number }}
 */
export function scheduleTbdCounts(items) {
  let practices = 0;
  let games = 0;
  for (const item of items) {
    if (item.kind === 'practice') practices += item.missingCount;
    else games += 1;
  }
  return { practices, games };
}

/**
 * The sentence beside the export for a list, or null when it is empty.
 *
 * @param {{ practices: number, games: number }} counts
 * @returns {string | null}
 */
export function scheduleTbdNote(counts) {
  const parts = [
    counts.practices > 0
      ? `${counts.practices} practice${counts.practices === 1 ? '' : 's'}`
      : null,
    counts.games > 0 ? `${counts.games} game${counts.games === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return `${parts.join(' and ')} not scheduled yet ${parts.length === 1 && counts.practices + counts.games === 1 ? 'is' : 'are'} in the files as TIME TBD, with the reason.`;
}
