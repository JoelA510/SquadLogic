/**
 * The natural age a player import stores, server side (admin-focus plan R5).
 *
 * Birth dates are never stored (owner decision 3, 2026-10-22). import-validation
 * reads the file's birth date only to compute the player's natural age (the
 * U-number the play-up rule compares with a division's band), stages the age,
 * and strips every birth key from what it stages. The browser keeps the file's
 * rows, birth dates included, for teaming during the import session.
 *
 * Twin of `importNaturalAge` and `computeAgeNumber` in
 * `packages/core/src/ageGroups.js`, which an Edge Function cannot import;
 * `tests/naturalAgeParity.test.js` holds the two equal. `finalize_import_job`
 * reads the staged `natural_age`, else the age group the export states (a row
 * staged without this function).
 */

/** The natural ages an import stores (`players.natural_age`, CHECK 1-25). */
export const NATURAL_AGE_MIN = 1;
export const NATURAL_AGE_MAX = 25;

/** First month (1-indexed) of the school-year seasonal window. */
const SCHOOL_YEAR_START_MONTH = 8;

function toUtcDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value === null || value === undefined || value === '') return null;
  const parsed = new Date(value as string | number);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** `computeAgeNumber`: the U-number for a season under a cutoff mode, or null. */
export function computeAgeNumber(
  dob: unknown,
  seasonYear: number,
  cutoffMode: string | null | undefined
): number | null {
  const date = toUtcDate(dob);
  if (!date || !Number.isFinite(seasonYear)) return null;
  const birthYear = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  if (cutoffMode === 'birth_year') return seasonYear - birthYear;
  return month >= SCHOOL_YEAR_START_MONTH ? seasonYear - birthYear - 1 : seasonYear - birthYear;
}

function storable(value: number | null): number | null {
  return value !== null &&
    Number.isInteger(value) &&
    value >= NATURAL_AGE_MIN &&
    value <= NATURAL_AGE_MAX
    ? value
    : null;
}

/**
 * The age computed from the birth date with the season's cutoff, else the age
 * group the export states (one or two digits), each only within 1-25, else
 * null. The birth date first: see core's `importNaturalAge` for why.
 */
export function importNaturalAge(params: {
  ageGroup?: unknown;
  dob?: unknown;
  seasonYear?: number | null;
  cutoffMode?: string | null;
}): number | null {
  const { ageGroup, dob, seasonYear, cutoffMode } = params;
  if (seasonYear !== null && seasonYear !== undefined && Number.isFinite(seasonYear)) {
    const computed = storable(computeAgeNumber(dob, Number(seasonYear), cutoffMode));
    if (computed !== null) return computed;
  }
  const text = ageGroup === null || ageGroup === undefined ? '' : String(ageGroup).trim();
  return /^[0-9]{1,2}$/.test(text) ? storable(Number(text)) : null;
}

/** A season row as import-validation reads it. */
export interface ImportSeason {
  id?: string | null;
  status?: string | null;
  season_year?: number | null;
  age_cutoff_mode?: string | null;
}

/**
 * The season an import's ages are counted in: the one `finalize_import_job`
 * attaches the import's divisions to. As of 20261101010000 (Phase E1) that is
 * the import job's own season (`import_jobs.season_settings_id`), or, for a job
 * made before jobs carried one, the organization's active season; nothing
 * picks a season by its dates or its age any more, so a draft is counted
 * with its own year and an active season never borrows a draft's. A job whose
 * season is not among `seasons` (it was deleted, or is another
 * organization's) has none, and the age group the file states is used.
 */
export function importSeason<T extends ImportSeason>(
  seasons: readonly T[] | null | undefined,
  jobSeasonId?: string | null
): T | null {
  const list = seasons ?? [];
  if (jobSeasonId) return list.find((season) => season.id === jobSeasonId) ?? null;
  return list.find((season) => season.status === 'active') ?? null;
}
