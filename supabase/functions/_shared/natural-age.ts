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
  status?: string | null;
  season_start?: string | null;
  created_at?: string | null;
  season_year?: number | null;
  age_cutoff_mode?: string | null;
}

/**
 * The season an import's ages are counted in: the one `finalize_import_job`
 * attaches the import's divisions to (`ORDER BY (status = 'active') DESC,
 * season_start DESC NULLS LAST, created_at DESC LIMIT 1`), ordered as
 * PostgreSQL orders it: `DESC` puts NULLs first unless told otherwise, so a
 * season with no status ranks before an active one, as it does there.
 */
export function importSeason<T extends ImportSeason>(
  seasons: readonly T[] | null | undefined
): T | null {
  const list = [...(seasons ?? [])];
  // (status = 'active') DESC: NULL, then true, then false.
  const statusRank = (status: string | null | undefined) =>
    status === null || status === undefined ? 2 : status === 'active' ? 1 : 0;
  // A date or timestamp, DESC, with NULLs where `nullsFirst` says.
  const desc = (
    a: string | null | undefined,
    b: string | null | undefined,
    nullsFirst: boolean
  ) => {
    const ta = a === null || a === undefined ? null : Date.parse(a);
    const tb = b === null || b === undefined ? null : Date.parse(b);
    if (ta === tb) return 0;
    if (ta === null) return nullsFirst ? -1 : 1;
    if (tb === null) return nullsFirst ? 1 : -1;
    return tb - ta;
  };
  list.sort(
    (a, b) =>
      statusRank(b.status) - statusRank(a.status) ||
      desc(a.season_start, b.season_start, false) ||
      desc(a.created_at, b.created_at, true)
  );
  return list[0] ?? null;
}
