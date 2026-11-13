import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { logger } from '../lib/logger.js';
import { SetScopedSettingSchema } from '../utils/scopedSettingSchemas.js';

/**
 * Words for a refusal of `admin_set_scoped_setting` (20261124010000), by the detail code the SQL gives it. The SQL's
 * own message names a season by its id ("Season <id> is completed ..."), which is not written for a person.
 */
const REFUSAL_WORDS = {
  season_completed:
    'this season is completed, so its programs’ and divisions’ settings are history and cannot be changed.',
  default_program: '“No program” holds no settings: its divisions follow the organization.',
  setting_value_invalid: 'that is not a value this setting takes.',
  unknown_setting: 'this setting is not one the database knows.',
  scope_invalid: 'a setting is set for the organization, a program or a division.',
};
const ACCESS_WORDS =
  'only an organization admin can change this setting, and the program or division must still exist.';
const UUID_TEXT = /\s*\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * A refusal in words: the words for its detail code, else for an access refusal (42501), else the database's own
 * message with any record id taken out.
 * @param {any} error
 */
function refusalWords(error) {
  const words =
    REFUSAL_WORDS[error?.details] ??
    (error?.code === '42501' ? ACCESS_WORDS : null) ??
    String(error?.message || 'the change could not be saved.').replace(UUID_TEXT, '');
  return `Not saved: ${words}`;
}

/**
 * One read of what the panel shows: the season's programs and divisions, and the organization's scoped setting rows.
 * @param {string} organizationId
 * @param {string | null} seasonId
 */
async function readScopedSettings(organizationId, seasonId) {
  const [programRead, divisionRead, settingRead] = await Promise.all([
    seasonId
      ? supabase
          .from('programs')
          .select('id, name, is_default')
          .eq('season_settings_id', seasonId)
          .order('name', { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    seasonId
      ? supabase
          .from('divisions')
          .select('id, name, program_id')
          .eq('season_settings_id', seasonId)
          .order('name', { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from('scoped_settings')
      .select('id, organization_id, program_id, division_id, key, value, frozen_from_organization')
      .eq('organization_id', organizationId),
  ]);
  const error = programRead.error || divisionRead.error || settingRead.error;
  if (error) {
    logger.warn('[useScopedSettings] settings not read', {
      code: error.code,
      message: error.message,
    });
    return {
      readFor: `${organizationId}|${seasonId}`,
      error: 'The settings could not be loaded. Reload the page to try again.',
    };
  }
  return {
    readFor: `${organizationId}|${seasonId}`,
    error: null,
    programs: programRead.data || [],
    divisions: divisionRead.data || [],
    rows: settingRead.data || [],
  };
}

/**
 * The scoped settings of an organization and the season's programs and divisions they apply to (F11-4b; plan
 * `docs/changes/2026-11-13-settings-scope.md`, "The screen").
 *
 * Reads under RLS (`programs`, `divisions`, `scoped_settings`: members select); writes only through
 * `admin_set_scoped_setting`, validated by a Zod schema first. `value: null` is "Inherit" and is sent as `p_value: null`
 * (PostgREST turns it into the SQL NULL the setter reads as "delete this level's row"). A refusal is thrown in words
 * (`refusalWords`); after every save the rows are read again, so what is shown is what is stored.
 *
 * @param {string | null | undefined} organizationId
 * @param {string | null | undefined} seasonId
 */
export function useScopedSettings(organizationId, seasonId) {
  const readKey = `${organizationId}|${seasonId ?? null}`;
  const [state, setState] = useState({
    readFor: /** @type {string | null} */ (null),
    error: /** @type {string | null} */ (null),
    programs: /** @type {Array<{ id: string, name: string, is_default?: boolean }>} */ ([]),
    divisions: /** @type {Array<{ id: string, name: string, program_id: string | null }>} */ ([]),
    rows: /** @type {Array<Record<string, any>>} */ ([]),
  });
  // The organization and season a read was made for, so a slow answer for one left behind is dropped.
  const latest = useRef(readKey);
  useEffect(() => {
    latest.current = readKey;
  }, [readKey]);

  const load = useCallback(async () => {
    if (!organizationId) return;
    const next = await readScopedSettings(organizationId, seasonId ?? null);
    if (latest.current === next.readFor) setState((s) => ({ ...s, ...next }));
  }, [organizationId, seasonId]);

  useEffect(() => {
    if (!organizationId) return undefined;
    let cancelled = false;
    (async () => {
      const next = await readScopedSettings(organizationId, seasonId ?? null);
      if (!cancelled) setState((s) => ({ ...s, ...next }));
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId, seasonId]);

  /**
   * Set one level's value (null = Inherit). Resolves with the setter's result
   * (`{ changed, previous, current, frozen_completed_divisions? }`); throws a refusal in words.
   * @param {{ key: string, scope: 'organization' | 'program' | 'division', scopeId: string, value: unknown }} input
   */
  const setValue = useCallback(
    async (input) => {
      const checked = SetScopedSettingSchema.safeParse(input);
      if (!checked.success) {
        throw new Error(
          `Not saved: ${checked.error.issues[0]?.message ?? 'the value is not valid.'}`
        );
      }
      const { key, scope, scopeId, value } = checked.data;
      const { data, error } = await supabase.rpc('admin_set_scoped_setting', {
        p_key: key,
        p_scope: scope,
        p_scope_id: scopeId,
        p_value: value ?? null,
      });
      if (error) {
        const failure = new Error(refusalWords(error));
        /** @type {any} */ (failure).code = error.details || error.code || null;
        // what is shown must be what is stored, also after a refusal (another admin may have changed it)
        await load();
        throw failure;
      }
      await load();
      return data;
    },
    [load]
  );

  const current = state.readFor === readKey && Boolean(organizationId);
  return {
    loading: Boolean(organizationId) && !current,
    error: current ? state.error : null,
    programs: current ? state.programs : [],
    divisions: current ? state.divisions : [],
    rows: current ? state.rows : [],
    setValue,
  };
}
