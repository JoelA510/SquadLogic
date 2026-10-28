import { useCallback } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import {
  ActivateSeasonSchema,
  CreateSeasonFromSchema,
  DivisionWindowSchema,
  UpdateSeasonSchema,
} from '../utils/seasonSchemas.js';

/**
 * The season writers (Phase E3b; migration 20261109010000): start the next season from one, edit
 * a draft, set a division's birth-date window and activate a draft.
 *
 * Writes go through the four admin definer RPCs only (`admin_create_season_from`,
 * `admin_update_draft_season`, `admin_set_division_birthdate_window`, `admin_activate_season`), each
 * validated by a Zod schema first. A refusal is thrown with the database's own message and code for
 * the caller to say. After every write the organization's seasons are read again, so what the
 * header and the pages show is what is stored.
 */
export function useSeasonAdmin() {
  const { refetchOrgs } = useOrganization();

  /** Runs one writer and refreshes the seasons; throws the database's error. */
  const write = useCallback(
    async (rpc, args) => {
      const { data, error } = await supabase.rpc(rpc, args);
      if (error) {
        const failure = new Error(error.message || 'The change could not be saved.');
        /** @type {any} */ (failure).code = error.code ?? null;
        /** @type {any} */ (failure).detail = error.details ?? null;
        throw failure;
      }
      refetchOrgs();
      return data;
    },
    [refetchOrgs]
  );

  const createFrom = useCallback(
    (sourceId, { name, year, start, end }) => {
      const parsed = CreateSeasonFromSchema.parse({ sourceId, name, year, start, end });
      return write('admin_create_season_from', {
        p_source_season_id: parsed.sourceId,
        p_name: parsed.name,
        p_season_year: parsed.year,
        p_season_start: parsed.start,
        p_season_end: parsed.end,
      });
    },
    [write]
  );

  const updateSeason = useCallback(
    (seasonId, patch) => {
      const parsed = UpdateSeasonSchema.parse({ seasonId, patch });
      return write('admin_update_draft_season', {
        p_season_id: parsed.seasonId,
        p_patch: parsed.patch,
      });
    },
    [write]
  );

  const setDivisionWindow = useCallback(
    (divisionId, start, end) => {
      const parsed = DivisionWindowSchema.parse({ divisionId, start, end });
      return write('admin_set_division_birthdate_window', {
        p_division_id: parsed.divisionId,
        p_birthdate_start: parsed.start,
        p_birthdate_end: parsed.end,
      });
    },
    [write]
  );

  const activate = useCallback(
    (seasonId) => {
      const parsed = ActivateSeasonSchema.parse({ seasonId });
      return write('admin_activate_season', { p_season_id: parsed.seasonId });
    },
    [write]
  );

  return { createFrom, updateSeason, setDivisionWindow, activate };
}
