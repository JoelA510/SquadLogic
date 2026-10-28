/**
 * Age-group derivation for SquadLogic.
 *
 * SquadLogic supports three configurable age-cutoff models, selectable per season
 * via `season_settings.age_cutoff_mode` (Phase E3b; plan
 * docs/changes/2026-10-27-season-enrollment.md, C3):
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
 *  - `custom` — a cutoff month and day the club picks (`age_cutoff_month`,
 *    `age_cutoff_day`), applied every season year. A player born on or after the
 *    cutoff belongs to the cohort one U-number younger, as with the school year's
 *    Aug 1; a cutoff of Jan 1 starts the calendar year and is the same as
 *    `birth_year`. The season year is the year the season starts.
 *
 * Per-division birthdate windows (`divisions.birthdate_start` /
 * `divisions.birthdate_end`) are always authoritative when present; this module
 * computes the sensible defaults and the player's "natural" group used for
 * play-up / play-down comparisons. An import counts a birth date that falls in a
 * division's window as that division's age (`importNaturalAge`).
 *
 * This module is framework-agnostic (no React, no Supabase imports).
 */

export const AGE_CUTOFF_MODES = Object.freeze({
  BIRTH_YEAR: 'birth_year',
  SCHOOL_YEAR_AUG_JUL: 'school_year_aug_jul',
  CUSTOM: 'custom',
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
  if (mode === AGE_CUTOFF_MODES.BIRTH_YEAR) return AGE_CUTOFF_MODES.BIRTH_YEAR;
  if (mode === AGE_CUTOFF_MODES.CUSTOM) return AGE_CUTOFF_MODES.CUSTOM;
  return AGE_CUTOFF_MODES.SCHOOL_YEAR_AUG_JUL;
}

/**
 * The custom cutoff as a month-day number (August 1 is 801), or null when the month or day is
 * not a real calendar day (February 29 is accepted). A `custom` season with no usable cutoff
 * counts as the school year, as an unknown mode does.
 *
 * @param {{ month?: unknown, day?: unknown } | null | undefined} cutoff
 * @returns {number|null}
 */
export function cutoffMonthDay(cutoff) {
  const month = Number(cutoff?.month);
  const day = Number(cutoff?.day);
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12) return null;
  const longest = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day >= 1 && day <= longest ? month * 100 + day : null;
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
 * @param {{ month?: unknown, day?: unknown }} [cutoff] - the `custom` mode's cutoff day
 * @returns {number|null} U-number (e.g. 10) or null when DOB is unparseable
 */
export function computeAgeNumber(dob, seasonYear, cutoffMode, cutoff) {
  const date = toUtcDate(dob);
  if (!date || !Number.isFinite(seasonYear)) return null;

  const birthYear = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1; // 1-12
  const mode = normalizeCutoffMode(cutoffMode);

  if (mode === AGE_CUTOFF_MODES.BIRTH_YEAR) {
    return seasonYear - birthYear;
  }
  if (mode === AGE_CUTOFF_MODES.CUSTOM) {
    const cut = cutoffMonthDay(cutoff);
    if (cut !== null) {
      // On or after the cutoff day is the younger cohort; Jan 1 starts the calendar year.
      return cut > 101 && month * 100 + date.getUTCDate() >= cut
        ? seasonYear - birthYear - 1
        : seasonYear - birthYear;
    }
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
 * The U-number a birth date takes from the divisions' own birthdate windows (Phase E3b, C3), or
 * null when no division's window holds it. A division with a window (`birthdate_start` and
 * `birthdate_end`, both) and an age band (`min_age`/`max_age`, else read from its name: "U4")
 * takes every player born in the window: their natural age is the cutoff's age brought into the
 * band (a U4 that takes the older 2-year-olds counts them as 4). A date that two windows hold
 * takes the lower age. A division with a window and no readable band is ignored: it names no age.
 *
 * Twin of `windowedAgeNumber` in `supabase/functions/_shared/natural-age.ts`.
 *
 * @param {Date|string} dob
 * @param {number} standardAge - the age the season's cutoff gives the date
 * @param {Array<Object>|DivisionWindows|null|undefined} divisions - or `compileDivisionWindows(divisions)`
 * @returns {number|null}
 */
export function windowedAgeNumber(dob, standardAge, divisions) {
  if (!Number.isFinite(standardAge)) return null;
  let compiled;
  if (divisions instanceof DivisionWindows) compiled = divisions;
  else if (Array.isArray(divisions)) compiled = compileDivisionWindows(divisions);
  else return null;
  if (compiled.windows.length === 0) return null;
  const date = toUtcDate(dob);
  if (!date) return null;
  let found = null;
  for (const { start, end, minAge, maxAge } of compiled.windows) {
    if (date < start || date > end) continue;
    const age = Math.min(Math.max(standardAge, minAge), maxAge);
    if (found === null || age < found) found = age;
  }
  return found;
}

/** A season's divisions reduced to the windows that can take a player (`compileDivisionWindows`). */
export class DivisionWindows {
  /** @param {Array<{ start: Date, end: Date, minAge: number, maxAge: number }>} windows */
  constructor(windows) {
    this.windows = windows;
  }
}

/**
 * The divisions that can take a player by birth date, parsed once: each has both window dates and
 * a readable age band. A caller that counts many ages against the same divisions compiles them
 * once and passes the result where `windowedAgeNumber` and `birthDateAge` take divisions, so the
 * dates are not parsed again per player (the season fixture's play-up comparison counts ages
 * 600,000 times). The result is a snapshot: compile again after a division changes.
 *
 * @param {Array<Object>|null|undefined} divisions
 * @returns {DivisionWindows}
 */
export function compileDivisionWindows(divisions) {
  const windows = [];
  for (const division of Array.isArray(divisions) ? divisions : []) {
    const start = toUtcDate(division?.birthdate_start ?? division?.birthdateStart);
    const end = toUtcDate(division?.birthdate_end ?? division?.birthdateEnd);
    if (!start || !end) continue;
    const { minAge, maxAge } = normalizeDivisionAgeBounds(division);
    if (minAge === null || maxAge === null) continue;
    windows.push({ start, end, minAge, maxAge });
  }
  return new DivisionWindows(windows);
}

/**
 * The U-number a birth date has in a season: the age the season's cutoff gives, brought into the
 * band of a division whose birth-date window holds the date (`windowedAgeNumber`). The one rule the
 * import (`importNaturalAge`), the Teams page's play-up (`resolveNaturalAge`) and its program
 * grouping (`computeAgeGroup`) all use; the Edge twin is `importNaturalAge` in
 * `supabase/functions/_shared/natural-age.ts`.
 *
 * @param {Date|string|null|undefined} dob
 * @param {number} seasonYear
 * @param {string|null|undefined} cutoffMode
 * @param {{ month?: unknown, day?: unknown }} [cutoff] - the `custom` mode's cutoff day
 * @param {Array<Object>|DivisionWindows|null} [divisions] - the season's divisions (their birth-date
 *   windows and bands), or `compileDivisionWindows(divisions)` when counting many ages
 * @returns {number|null} null when the date is unparseable or the year is not a number
 */
export function birthDateAge(dob, seasonYear, cutoffMode, cutoff, divisions) {
  const date = toUtcDate(/** @type {any} */ (dob));
  const standard = computeAgeNumber(date, seasonYear, cutoffMode, cutoff);
  if (standard === null) return null;
  // Nothing to look up in a season whose divisions have no windows (nearly all of them).
  if (divisions instanceof DivisionWindows && divisions.windows.length === 0) return standard;
  return windowedAgeNumber(date, standard, divisions) ?? standard;
}

/**
 * The natural age an import stores for a player (admin-focus plan R5): the one computed from the
 * file's birth date with the season's cutoff and its divisions' birthdate windows, else the age
 * group the export states. A birth date
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
 * @param {{ ageGroup?: unknown, dob?: unknown, seasonYear?: number|null, cutoffMode?: string|null, cutoffMonth?: number|null, cutoffDay?: number|null, divisions?: Array<Object>|null }} params
 * @returns {number|null}
 */
export function importNaturalAge({
  ageGroup,
  dob,
  seasonYear,
  cutoffMode,
  cutoffMonth,
  cutoffDay,
  divisions,
} = {}) {
  if (Number.isFinite(seasonYear)) {
    const computed = storableNaturalAge(
      birthDateAge(
        /** @type {any} */ (dob),
        Number(seasonYear),
        cutoffMode,
        {
          month: cutoffMonth,
          day: cutoffDay,
        },
        divisions
      )
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
 * @param {{ month?: unknown, day?: unknown }} [cutoff] - the `custom` mode's cutoff day
 * @returns {{ start: string, end: string }} ISO date strings (YYYY-MM-DD)
 */
export function cohortWindow(ageNumber, seasonYear, cutoffMode, cutoff) {
  const mode = normalizeCutoffMode(cutoffMode);
  if (mode === AGE_CUTOFF_MODES.BIRTH_YEAR) {
    const year = seasonYear - ageNumber;
    return { start: `${pad4(year)}-01-01`, end: `${pad4(year)}-12-31` };
  }
  if (mode === AGE_CUTOFF_MODES.CUSTOM) {
    const cut = cutoffMonthDay(cutoff);
    if (cut === 101) return cohortWindow(ageNumber, seasonYear, AGE_CUTOFF_MODES.BIRTH_YEAR);
    if (cut !== null) {
      // From the cutoff day of the year before, through the day before it in the cohort's year.
      // February 29 is Mar 1 in a year without one, as the comparison in `computeAgeNumber` reads it.
      const month = Math.floor(cut / 100);
      const day = cut % 100;
      const startYear = seasonYear - ageNumber - 1;
      const endYear = seasonYear - ageNumber;
      const last = new Date(Date.UTC(endYear, month - 1, day));
      last.setUTCDate(last.getUTCDate() - 1);
      return {
        start: isoUtc(new Date(Date.UTC(startYear, month - 1, day))),
        end: isoUtc(last),
      };
    }
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
 * @param {{ month?: unknown, day?: unknown }} [cutoff]
 * @returns {{ start: string, end: string }}
 */
export function divisionBirthWindow(minAge, maxAge, seasonYear, cutoffMode, cutoff) {
  const lo = Math.min(minAge, maxAge);
  const hi = Math.max(minAge, maxAge);
  return {
    start: cohortWindow(hi, seasonYear, cutoffMode, cutoff).start, // oldest -> earliest
    end: cohortWindow(lo, seasonYear, cutoffMode, cutoff).end, // youngest -> latest
  };
}

/**
 * Compute a player's natural age group descriptor for a season.
 *
 * @param {Object} params
 * @param {Date|string} params.dob
 * @param {number} params.seasonYear
 * @param {string} [params.cutoffMode]
 * @param {number|null} [params.cutoffMonth] - the `custom` mode's cutoff month
 * @param {number|null} [params.cutoffDay] - and day
 * @param {Array<Object>|null} [params.divisions] - the season's divisions: a birth date in one's
 *   birth-date window is that division's age (`birthDateAge`)
 * @returns {{ ageNumber: number, ageGroup: string, cohortStart: string, cohortEnd: string }|null}
 */
export function computeAgeGroup({
  dob,
  seasonYear,
  cutoffMode,
  cutoffMonth,
  cutoffDay,
  divisions,
}) {
  const cutoff = { month: cutoffMonth, day: cutoffDay };
  const ageNumber = birthDateAge(dob, seasonYear, cutoffMode, cutoff, divisions);
  if (ageNumber === null) return null;
  const { start, end } = cohortWindow(ageNumber, seasonYear, cutoffMode, cutoff);
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
 * @param {number|null} [params.cutoffMonth] - the `custom` mode's cutoff month
 * @param {number|null} [params.cutoffDay] - and day
 * @returns {boolean}
 */
export function isEligibleForDivision({
  dob,
  division,
  seasonYear,
  cutoffMode,
  cutoffMonth,
  cutoffDay,
}) {
  const naturalAge = computeAgeNumber(dob, seasonYear, cutoffMode, {
    month: cutoffMonth,
    day: cutoffDay,
  });
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

/** `YYYY-MM-DD` of a UTC date. */
function isoUtc(date) {
  return `${pad4(date.getUTCFullYear())}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}
