/**
 * Age-group derivation for SquadLogic.
 *
 * SquadLogic supports two configurable age-cutoff models, selectable per season
 * via `season_settings.age_cutoff_mode`:
 *
 *  - `birth_year` — calendar-year registration (US Soccer 2017+ standard). A
 *    player's U-number is `seasonYear - birthYear`; the U(N) cohort is everyone
 *    born in the calendar year `seasonYear - N` (Jan 1 – Dec 31).
 *
 *  - `school_year_aug_jul` — school-year registration (Aug 1 cutoff). The U(N)
 *    cohort is everyone born between Aug 1 of `seasonYear - N - 1` and Jul 31 of
 *    `seasonYear - N`. Relative to birth-year, an Aug–Dec birthday shifts the
 *    player one U-number younger (they are the youngest-for-grade), matching how
 *    US school grades band children around an August cutoff.
 *
 * Per-division birthdate windows (`divisions.birthdate_start` /
 * `divisions.birthdate_end`) are always authoritative when present; this module
 * computes the sensible defaults and the player's "natural" group used for
 * play-up / play-down comparisons.
 *
 * This module is framework-agnostic (no React, no Supabase imports).
 */

export const AGE_CUTOFF_MODES = Object.freeze({
  BIRTH_YEAR: 'birth_year',
  SCHOOL_YEAR_AUG_JUL: 'school_year_aug_jul',
});

/** First month (1-indexed) of the school-year seasonal window. */
const SCHOOL_YEAR_START_MONTH = 8; // August

/**
 * Coerce a value into a UTC Date or null. DOB strings such as `2016-09-15`
 * parse as UTC midnight, so all comparisons use the UTC calendar to avoid
 * timezone drift moving a birthday across a year boundary.
 *
 * @param {Date|string|number|null|undefined} value
 * @returns {Date|null}
 */
export function toUtcDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value === null || value === undefined || value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * @param {string} [mode]
 * @returns {string} a valid member of AGE_CUTOFF_MODES (defaults applied)
 */
export function normalizeCutoffMode(mode) {
  return mode === AGE_CUTOFF_MODES.BIRTH_YEAR
    ? AGE_CUTOFF_MODES.BIRTH_YEAR
    : AGE_CUTOFF_MODES.SCHOOL_YEAR_AUG_JUL;
}

/**
 * Format a U-number as a label, e.g. 10 -> "U10".
 * @param {number} ageNumber
 * @returns {string}
 */
export function ageGroupLabel(ageNumber) {
  return `U${ageNumber}`;
}

/**
 * Compute the player's "natural" U-number for a season under a cutoff mode.
 *
 * @param {Date|string} dob
 * @param {number} seasonYear
 * @param {string} [cutoffMode]
 * @returns {number|null} U-number (e.g. 10) or null when DOB is unparseable
 */
export function computeAgeNumber(dob, seasonYear, cutoffMode) {
  const date = toUtcDate(dob);
  if (!date || !Number.isFinite(seasonYear)) return null;

  const birthYear = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1; // 1-12
  const mode = normalizeCutoffMode(cutoffMode);

  if (mode === AGE_CUTOFF_MODES.BIRTH_YEAR) {
    return seasonYear - birthYear;
  }
  // school_year_aug_jul: Aug–Dec births belong to the cohort starting that Aug.
  return month >= SCHOOL_YEAR_START_MONTH ? seasonYear - birthYear - 1 : seasonYear - birthYear;
}

/** The natural ages an import stores (`players.natural_age`, CHECK 1-25). */
export const NATURAL_AGE_MIN = 1;
export const NATURAL_AGE_MAX = 25;

function storableNaturalAge(value) {
  return Number.isInteger(value) && value >= NATURAL_AGE_MIN && value <= NATURAL_AGE_MAX
    ? value
    : null;
}

/**
 * The natural age an import stores for a player (admin-focus plan R5): the one computed from the
 * file's birth date with the season's cutoff, else the age group the export states. A birth date
 * is never stored; this is what replaces it. The birth date comes first because it is what
 * teaming read before R5, so no player's placement changes; an export's age group is read
 * differently in different places (the glossary's natural age; `U(N+1)` in the division
 * derivation), so it is used only when no birth date gives an age. An age group is read only as
 * one or two digits (`9`, `09`), as `finalize_import_job` reads it; a value outside 1-25 is not a
 * natural age. With neither, null: teaming places the player and flags them (Phase B2).
 *
 * Twin of `supabase/functions/_shared/natural-age.ts` (import-validation, which computes it before
 * it stages a row); `tests/naturalAgeParity.test.js` holds the two equal.
 *
 * @param {{ ageGroup?: unknown, dob?: unknown, seasonYear?: number|null, cutoffMode?: string|null }} params
 * @returns {number|null}
 */
export function importNaturalAge({ ageGroup, dob, seasonYear, cutoffMode } = {}) {
  if (Number.isFinite(seasonYear)) {
    const computed = storableNaturalAge(
      computeAgeNumber(/** @type {any} */ (dob), Number(seasonYear), cutoffMode)
    );
    if (computed !== null) return computed;
  }
  const text = ageGroup === null || ageGroup === undefined ? '' : String(ageGroup).trim();
  return /^[0-9]{1,2}$/.test(text) ? storableNaturalAge(Number(text)) : null;
}

/**
 * Birthdate window (inclusive) for a single U-number under a cutoff mode.
 *
 * @param {number} ageNumber
 * @param {number} seasonYear
 * @param {string} [cutoffMode]
 * @returns {{ start: string, end: string }} ISO date strings (YYYY-MM-DD)
 */
export function cohortWindow(ageNumber, seasonYear, cutoffMode) {
  const mode = normalizeCutoffMode(cutoffMode);
  if (mode === AGE_CUTOFF_MODES.BIRTH_YEAR) {
    const year = seasonYear - ageNumber;
    return { start: `${pad4(year)}-01-01`, end: `${pad4(year)}-12-31` };
  }
  // school_year_aug_jul
  return {
    start: `${pad4(seasonYear - ageNumber - 1)}-08-01`,
    end: `${pad4(seasonYear - ageNumber)}-07-31`,
  };
}

/**
 * Birthdate window (inclusive) covering an age band [minAge, maxAge].
 *
 * Larger U-numbers are older players (born earlier), so the band starts at the
 * oldest cohort's start and ends at the youngest cohort's end.
 *
 * @param {number} minAge
 * @param {number} maxAge
 * @param {number} seasonYear
 * @param {string} [cutoffMode]
 * @returns {{ start: string, end: string }}
 */
export function divisionBirthWindow(minAge, maxAge, seasonYear, cutoffMode) {
  const lo = Math.min(minAge, maxAge);
  const hi = Math.max(minAge, maxAge);
  return {
    start: cohortWindow(hi, seasonYear, cutoffMode).start, // oldest -> earliest
    end: cohortWindow(lo, seasonYear, cutoffMode).end, // youngest -> latest
  };
}

/**
 * Compute a player's natural age group descriptor for a season.
 *
 * @param {Object} params
 * @param {Date|string} params.dob
 * @param {number} params.seasonYear
 * @param {string} [params.cutoffMode]
 * @returns {{ ageNumber: number, ageGroup: string, cohortStart: string, cohortEnd: string }|null}
 */
export function computeAgeGroup({ dob, seasonYear, cutoffMode }) {
  const ageNumber = computeAgeNumber(dob, seasonYear, cutoffMode);
  if (ageNumber === null) return null;
  const { start, end } = cohortWindow(ageNumber, seasonYear, cutoffMode);
  return {
    ageNumber,
    ageGroup: ageGroupLabel(ageNumber),
    cohortStart: start,
    cohortEnd: end,
  };
}

/**
 * Extract the min/max U-numbers from a free-text division/program name.
 * Handles single ("U10", "2026 U05G Grasshopper") and ranges ("U11-U12",
 * "U3 - U4", "U17 to U19").
 *
 * @param {string} name
 * @returns {{ minAge: number, maxAge: number }|null}
 */
export function parseAgeNumbersFromName(name) {
  if (!name) return null;
  const matches = [...String(name).matchAll(/u\s*0*(\d{1,2})/gi)].map((m) => Number(m[1]));
  if (matches.length === 0) return null;
  return { minAge: Math.min(...matches), maxAge: Math.max(...matches) };
}

/**
 * Infer a gender policy from a division/program name.
 * Returns 'girls' | 'boys' | 'coed' | null.
 *
 * @param {string} name
 * @returns {('girls'|'boys'|'coed')|null}
 */
export function parseGenderFromName(name) {
  if (!name) return null;
  const text = String(name).toLowerCase();
  if (/\b(coed|co-ed|both|mixed)\b/.test(text)) return 'coed';
  if (/\b(girls?|female|women|women's)\b/.test(text)) return 'girls';
  if (/\b(boys?|male|men|men's)\b/.test(text)) return 'boys';
  // Gendered U-code suffix, e.g. "U05G" / "U10B" (avoid matching a stray letter).
  if (/u\s*0*\d{1,2}\s*g\b/i.test(text)) return 'girls';
  if (/u\s*0*\d{1,2}\s*b\b/i.test(text)) return 'boys';
  return null;
}

/**
 * Normalize a division descriptor into { id, name, minAge, maxAge }.
 * Falls back to parsing the name when explicit age bounds are absent.
 *
 * @param {Object} division
 * @returns {{ id: any, name: string, minAge: number|null, maxAge: number|null }}
 */
export function normalizeDivisionAgeBounds(division) {
  const name = division?.name ?? division?.id ?? '';
  let minAge = firstFiniteNumber(division?.minAge, division?.min_age, division?.minAgeNumber);
  let maxAge = firstFiniteNumber(division?.maxAge, division?.max_age, division?.maxAgeNumber);

  if (minAge === null || maxAge === null) {
    const parsed = parseAgeNumbersFromName(name);
    if (parsed) {
      minAge = minAge ?? parsed.minAge;
      maxAge = maxAge ?? parsed.maxAge;
    }
  }
  return { id: division?.id ?? name, name, minAge, maxAge };
}

/**
 * Classify a player's natural age relative to a division band.
 *
 * @param {number} naturalAge
 * @param {{ minAge: number|null, maxAge: number|null }} bounds
 * @returns {('in_band'|'up'|'down'|'unknown')}
 */
export function classifyPlacement(naturalAge, bounds) {
  if (!Number.isFinite(naturalAge) || bounds.minAge === null || bounds.maxAge === null) {
    return 'unknown';
  }
  if (naturalAge < bounds.minAge) return 'up'; // younger than the band => playing up
  if (naturalAge > bounds.maxAge) return 'down'; // older than the band => playing down
  return 'in_band';
}

/**
 * Is the player eligible to sit naturally in this division (in-band)?
 *
 * @param {Object} params
 * @param {Date|string} params.dob
 * @param {Object} params.division
 * @param {number} params.seasonYear
 * @param {string} [params.cutoffMode]
 * @returns {boolean}
 */
export function isEligibleForDivision({ dob, division, seasonYear, cutoffMode }) {
  const naturalAge = computeAgeNumber(dob, seasonYear, cutoffMode);
  if (naturalAge === null) return false;

  // Explicit per-division birthdate window wins when configured.
  const start = toUtcDate(division?.birthdate_start);
  const end = toUtcDate(division?.birthdate_end);
  const date = toUtcDate(dob);
  if (start && end && date) {
    return date >= start && date <= end;
  }

  const bounds = normalizeDivisionAgeBounds(division);
  return classifyPlacement(naturalAge, bounds) === 'in_band';
}

function pad4(year) {
  return String(year).padStart(4, '0');
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}
