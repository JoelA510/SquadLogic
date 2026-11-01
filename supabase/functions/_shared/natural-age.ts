/**
 * The natural age a player import stores, server side (admin-focus plan R5).
 *
 * Birth dates are never stored (owner decision 3, 2026-10-22). import-validation
 * reads the file's birth date only to compute the player's natural age (the
 * U-number the play-up rule compares with a division's band), stages the age,
 * and strips every birth key from what it stages. The browser keeps the file's
 * rows, birth dates included, for teaming during the import session.
 *
 * Twin of `importNaturalAge`, `computeAgeNumber` and `windowedAgeNumber` in
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

/**
 * `cutoffMonthDay`: the custom cutoff as a month-day number (August 1 is 801), or null when the
 * month or day is not a real calendar day (February 29 is accepted).
 */
export function cutoffMonthDay(month: unknown, day: unknown): number | null {
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(m) || !Number.isInteger(d) || m < 1 || m > 12) return null;
  const longest = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return d >= 1 && d <= longest ? m * 100 + d : null;
}

/** `computeAgeNumber`: the U-number for a season under a cutoff mode, or null. */
export function computeAgeNumber(
  dob: unknown,
  seasonYear: number,
  cutoffMode: string | null | undefined,
  cutoff?: { month?: unknown; day?: unknown } | null
): number | null {
  const date = toUtcDate(dob);
  if (!date || !Number.isFinite(seasonYear)) return null;
  const birthYear = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  if (cutoffMode === 'birth_year') return seasonYear - birthYear;
  if (cutoffMode === 'custom') {
    const cut = cutoffMonthDay(cutoff?.month, cutoff?.day);
    if (cut !== null) {
      // On or after the cutoff day is the younger cohort; Jan 1 starts the calendar year.
      return cut > 101 && month * 100 + date.getUTCDate() >= cut
        ? seasonYear - birthYear - 1
        : seasonYear - birthYear;
    }
  }
  return month >= SCHOOL_YEAR_START_MONTH ? seasonYear - birthYear - 1 : seasonYear - birthYear;
}

/** A division as the windows read it (`divisions` columns). */
export interface WindowedDivision {
  name?: string | null;
  min_age?: number | string | null;
  max_age?: number | string | null;
  birthdate_start?: string | null;
  birthdate_end?: string | null;
}

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/** `normalizeDivisionAgeBounds`: the explicit band, else the U-numbers in the name ("U4", "U11-U12"). */
function divisionBand(division: WindowedDivision): {
  minAge: number | null;
  maxAge: number | null;
} {
  let minAge = finiteOrNull(division.min_age);
  let maxAge = finiteOrNull(division.max_age);
  if (minAge === null || maxAge === null) {
    const found = [...String(division.name ?? '').matchAll(/u\s*0*(\d{1,2})/gi)].map((m) =>
      Number(m[1])
    );
    if (found.length > 0) {
      minAge = minAge ?? Math.min(...found);
      maxAge = maxAge ?? Math.max(...found);
    }
  }
  return { minAge, maxAge };
}

/**
 * `windowedAgeNumber`: the U-number a birth date takes from the divisions' own birthdate
 * windows, or null when no division's window holds it. A division with a window (both ends) and
 * a readable age band takes every player born in it: the cutoff's age brought into the band; a
 * date two windows hold takes the lower age.
 */
export function windowedAgeNumber(
  dob: unknown,
  standardAge: number,
  divisions: readonly WindowedDivision[] | null | undefined
): number | null {
  const date = toUtcDate(dob);
  if (!date || !Number.isFinite(standardAge) || !Array.isArray(divisions)) return null;
  let found: number | null = null;
  for (const division of divisions) {
    const start = toUtcDate(division?.birthdate_start);
    const end = toUtcDate(division?.birthdate_end);
    if (!start || !end || date < start || date > end) continue;
    const { minAge, maxAge } = divisionBand(division);
    if (minAge === null || maxAge === null) continue;
    const age = Math.min(Math.max(standardAge, minAge), maxAge);
    if (found === null || age < found) found = age;
  }
  return found;
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
 * The age computed from the birth date with the season's cutoff and its divisions' birthdate
 * windows, else the age group the export states (one or two digits), each only within 1-25, else
 * null. The birth date first: see core's `importNaturalAge` for why.
 */
export function importNaturalAge(params: {
  ageGroup?: unknown;
  dob?: unknown;
  seasonYear?: number | null;
  cutoffMode?: string | null;
  cutoffMonth?: number | null;
  cutoffDay?: number | null;
  divisions?: readonly WindowedDivision[] | null;
}): number | null {
  const { ageGroup, dob, seasonYear, cutoffMode, cutoffMonth, cutoffDay, divisions } = params;
  if (seasonYear !== null && seasonYear !== undefined && Number.isFinite(seasonYear)) {
    const standard = computeAgeNumber(dob, Number(seasonYear), cutoffMode, {
      month: cutoffMonth,
      day: cutoffDay,
    });
    const windowed = standard === null ? null : windowedAgeNumber(dob, standard, divisions);
    const computed = storable(windowed ?? standard);
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
  age_cutoff_month?: number | null;
  age_cutoff_day?: number | null;
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
