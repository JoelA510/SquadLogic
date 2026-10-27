import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { logger } from '../lib/logger.js';
import {
  CreateProgramSchema,
  DeleteProgramSchema,
  MergeProgramsSchema,
  RenameProgramSchema,
  SetDivisionProgramSchema,
} from '../utils/programSchemas.js';

/**
 * One read of a season's programs and divisions, as the state the hook holds. Before the migration
 * there is no table (42P01, or PGRST205 through the API) and no column (42703): programs do not
 * exist yet, `available` is false and the section stays out of the way.
 * @param {string} seasonId
 */
async function readSeasonPrograms(seasonId) {
  const [programRead, divisionRead] = await Promise.all([
    supabase
      .from('programs')
      .select('id, name, is_default')
      .eq('season_settings_id', seasonId)
      .order('name', { ascending: true }),
    supabase
      .from('divisions')
      .select('id, name, program_id')
      .eq('season_settings_id', seasonId)
      .order('name', { ascending: true }),
  ]);
  const missing = (error) => ['42P01', 'PGRST205', '42703'].includes(error?.code);
  if (missing(programRead.error) || missing(divisionRead.error)) {
    return { forSeason: seasonId, available: false, error: null };
  }
  const error = programRead.error || divisionRead.error;
  if (error) {
    logger.warn('[usePrograms] programs not read', { code: error.code, message: error.message });
    return { forSeason: seasonId, error: error.message || 'Programs could not be loaded.' };
  }
  const rows = programRead.data || [];
  return {
    forSeason: seasonId,
    available: true,
    error: null,
    defaultProgram: rows.find((p) => p.is_default) ?? null,
    programs: rows.filter((p) => !p.is_default),
    divisions: divisionRead.data || [],
  };
}

/**
 * A season's programs and the divisions in them (Phase E2; migration 20261101020000).
 *
 * Reads under RLS (`programs`, `divisions`); writes through the four admin definer RPCs only
 * (`admin_upsert_program`, `admin_set_division_program`, `admin_delete_program`,
 * `admin_merge_programs`), each validated by a Zod schema first. A refusal is thrown with the
 * database's own message and code for the caller to say. After every write the season is read again,
 * so what is shown is what is stored.
 *
 * **Programs are optional.** Nothing here is needed to import, form teams or schedule; a season has
 * one default program ("No program", `is_default`) that holds every division in none of its own,
 * and `programs` below lists only the programs an admin made. `available` is false before the
 * migration (the table or column does not exist yet), when the section simply does not render.
 *
 * @param {string | null | undefined} seasonId
 */
export function usePrograms(seasonId) {
  const [state, setState] = useState({
    // The season the rows below were read for; rows of another season are never shown.
    forSeason: /** @type {string | null | undefined} */ (null),
    available: true,
    error: /** @type {string | null} */ (null),
    defaultProgram: /** @type {{ id: string, name: string } | null} */ (null),
    programs: /** @type {Array<{ id: string, name: string }>} */ ([]),
    divisions: /** @type {Array<{ id: string, name: string, program_id: string | null }>} */ ([]),
  });
  // The season a read was made for, so a slow answer for a season left behind is dropped.
  const latest = useRef(seasonId);
  useEffect(() => {
    latest.current = seasonId;
  }, [seasonId]);

  // The read after a write, so what is shown is what is stored.
  const load = useCallback(async () => {
    if (!seasonId) return;
    const next = await readSeasonPrograms(seasonId);
    if (latest.current === seasonId) setState((s) => ({ ...s, ...next }));
  }, [seasonId]);

  useEffect(() => {
    if (!seasonId) return undefined;
    let cancelled = false;
    (async () => {
      const next = await readSeasonPrograms(seasonId);
      if (!cancelled) setState((s) => ({ ...s, ...next }));
    })();
    return () => {
      cancelled = true;
    };
  }, [seasonId]);

  /** Runs one writer and reads the season again; throws the database's error. */
  const write = useCallback(
    async (rpc, args) => {
      const { data, error } = await supabase.rpc(rpc, args);
      if (error) {
        const failure = new Error(error.message || 'The change could not be saved.');
        /** @type {any} */ (failure).code = error.code ?? null;
        throw failure;
      }
      await load();
      return data;
    },
    [load]
  );

  const createProgram = useCallback(
    (name) => {
      const parsed = CreateProgramSchema.parse({ seasonId, name });
      return write('admin_upsert_program', {
        p_season_id: parsed.seasonId,
        p_id: null,
        p_name: parsed.name,
      });
    },
    [seasonId, write]
  );

  const renameProgram = useCallback(
    (programId, name) => {
      const parsed = RenameProgramSchema.parse({ seasonId, programId, name });
      return write('admin_upsert_program', {
        p_season_id: parsed.seasonId,
        p_id: parsed.programId,
        p_name: parsed.name,
      });
    },
    [seasonId, write]
  );

  const deleteProgram = useCallback(
    (programId) => {
      const parsed = DeleteProgramSchema.parse({ programId });
      return write('admin_delete_program', { p_program_id: parsed.programId });
    },
    [write]
  );

  const mergePrograms = useCallback(
    (sourceId, targetId) => {
      const parsed = MergeProgramsSchema.parse({ sourceId, targetId });
      return write('admin_merge_programs', {
        p_source_id: parsed.sourceId,
        p_target_id: parsed.targetId,
      });
    },
    [write]
  );

  const setDivisionProgram = useCallback(
    (divisionId, programId) => {
      const parsed = SetDivisionProgramSchema.parse({ divisionId, programId });
      return write('admin_set_division_program', {
        p_division_id: parsed.divisionId,
        p_program_id: parsed.programId,
      });
    },
    [write]
  );

  const current = state.forSeason === seasonId && Boolean(seasonId);
  return {
    available: state.available,
    error: current ? state.error : null,
    defaultProgram: current ? state.defaultProgram : null,
    programs: current ? state.programs : [],
    divisions: current ? state.divisions : [],
    loading: Boolean(seasonId) && !current,
    reload: load,
    createProgram,
    renameProgram,
    deleteProgram,
    mergePrograms,
    setDivisionProgram,
  };
}
