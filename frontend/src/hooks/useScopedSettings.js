import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { logger } from '../lib/logger.js';
import { fetchAllPages } from '../lib/pagedFetch.js';
import { REFRESH_TOPICS, subscribeRefresh } from '../lib/refreshBus.js';
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

const SETTING_COLUMNS =
  'id, organization_id, program_id, division_id, key, value, frozen_from_organization';
/** Ids per `in` filter: about 3.7 KB of URL, well inside what the API takes. */
const ID_CHUNK = 100;

/** @template T @param {T[]} items @param {number} size @returns {T[][]} */
function chunks(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The `scoped_settings` rows the panel needs and no others: the organization's own row(s), and the rows of the given
 * programs and divisions (the season's). Each read is paged to completion (`fetchAllPages`), so the server's row cap
 * never cuts it, and the ids go in chunks so no request carries an unbounded list. Throws the first read error.
 *
 * @param {any} client
 * @param {{ organizationId: string, programIds: string[], divisionIds: string[] }} scope
 * @param {{ pageSize?: number, chunkSize?: number }} [options]  smaller sizes for a test only
 * @returns {Promise<Array<Record<string, any>>>}
 */
export async function readScopedSettingRows(
  client,
  { organizationId, programIds, divisionIds },
  { pageSize, chunkSize = ID_CHUNK } = {}
) {
  /** One paged read of the organization's rows, narrowed by `narrow` (ordered by `id`, the helper's default). */
  const paged = (narrow) =>
    fetchAllPages(
      () =>
        narrow(
          client
            .from('scoped_settings')
            .select(SETTING_COLUMNS)
            .eq('organization_id', organizationId)
        ),
      pageSize ? { pageSize } : undefined
    );
  const reads = [
    paged((q) => q.is('program_id', null).is('division_id', null)),
    ...chunks(programIds, chunkSize).map((ids) => paged((q) => q.in('program_id', ids))),
    ...chunks(divisionIds, chunkSize).map((ids) => paged((q) => q.in('division_id', ids))),
  ];
  return (await Promise.all(reads)).flat();
}

/**
 * One read of what the panel shows: the season's programs and divisions, then the scoped setting rows of the
 * organization and of those programs and divisions. Answers which organization and season it was read for, so a read
 * that lands after a switch is dropped by its caller.
 * @param {string} organizationId
 * @param {string | null} seasonId
 */
async function readScopedSettings(organizationId, seasonId) {
  const readFor = `${organizationId}|${seasonId}`;
  try {
    const [programRead, divisionRead] = await Promise.all([
      seasonId
        ? supabase
            .from('programs')
            .select('id, name, is_default')
            .eq('organization_id', organizationId)
            .eq('season_settings_id', seasonId)
            .order('name', { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      seasonId
        ? supabase
            .from('divisions')
            .select('id, name, program_id')
            .eq('organization_id', organizationId)
            .eq('season_settings_id', seasonId)
            .order('name', { ascending: true })
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (programRead.error) throw programRead.error;
    if (divisionRead.error) throw divisionRead.error;
    const programs = programRead.data || [];
    const divisions = divisionRead.data || [];
    const rows = await readScopedSettingRows(supabase, {
      organizationId,
      programIds: programs.map((p) => String(p.id)),
      divisionIds: divisions.map((d) => String(d.id)),
    });
    return { readFor, error: null, programs, divisions, rows };
  } catch (error) {
    logger.warn('[useScopedSettings] settings not read', {
      code: error?.code,
      message: error?.message,
    });
    return {
      readFor,
      error: 'The settings could not be loaded.',
      programs: [],
      divisions: [],
      rows: [],
    };
  }
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
 * **Only for a settled pair.** The caller passes the organization and season only once they belong together (the
 * season is the organization's and not still loading); with either null nothing is read and nothing can be saved. A
 * read that lands for an organization or season the caller has since left is dropped (`readFor` against the latest).
 * A change to the season's programs (the Programs section's writes, `REFRESH_TOPICS.PROGRAMS`) reads again.
 *
 * @param {string | null | undefined} organizationId
 * @param {string | null | undefined} seasonId
 */
export function useScopedSettings(organizationId, seasonId) {
  const readKey = organizationId ? `${organizationId}|${seasonId ?? null}` : null;
  const [state, setState] = useState({
    readFor: /** @type {string | null} */ (null),
    error: /** @type {string | null} */ (null),
    programs: /** @type {Array<{ id: string, name: string, is_default?: boolean }>} */ ([]),
    divisions: /** @type {Array<{ id: string, name: string, program_id: string | null }>} */ ([]),
    rows: /** @type {Array<Record<string, any>>} */ ([]),
  });
  // The pair the latest read is for: an answer for any other is dropped when it lands.
  const latest = useRef(readKey);
  useEffect(() => {
    latest.current = readKey;
  }, [readKey]);

  /** Read again; true when the read succeeded for the pair still shown. */
  const load = useCallback(async () => {
    if (!organizationId) return false;
    const next = await readScopedSettings(organizationId, seasonId ?? null);
    if (latest.current !== next.readFor) return false;
    setState(next);
    return next.error === null;
  }, [organizationId, seasonId]);

  useEffect(() => {
    if (!organizationId) return undefined;
    let cancelled = false;
    (async () => {
      const next = await readScopedSettings(organizationId, seasonId ?? null);
      if (!cancelled && latest.current === next.readFor) setState(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId, seasonId]);

  // A change to the season's programs (the Programs section's writes) reads again.
  useEffect(() => {
    if (!organizationId) return undefined;
    return subscribeRefresh(REFRESH_TOPICS.PROGRAMS, () => {
      load();
    });
  }, [organizationId, load]);

  const current = readKey !== null && state.readFor === readKey;

  /**
   * Set one level's value (null = Inherit). Resolves with the setter's result
   * (`{ changed, previous, current, frozen_completed_divisions? }`) and `reloaded`, false when the save went through
   * but the rows could not be read again; throws a refusal in words.
   * @param {{ key: string, scope: 'organization' | 'program' | 'division', scopeId: string, value: unknown }} input
   */
  const setValue = useCallback(
    async (input) => {
      if (!current) throw new Error('Not saved: the settings are still loading.');
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
      const reloaded = await load();
      return { ...data, reloaded };
    },
    [current, load]
  );

  return {
    loading: readKey !== null && !current,
    error: current ? state.error : null,
    programs: current ? state.programs : [],
    divisions: current ? state.divisions : [],
    rows: current ? state.rows : [],
    reload: load,
    setValue,
  };
}
