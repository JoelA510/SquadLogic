/**
 * The evaluations import's row rules (E3c of docs/changes/2026-10-27-season-enrollment.md): a
 * file of registration ids with years played, a skill tier and/or a 1-5 rating, that only
 * updates players already in the season.
 *
 * Twin of `frontend/src/utils/importEvaluations.js`, which the browser preview and the mock
 * `import-validation` use; `tests/importEvaluationsParity.test.js` holds the two equal. The
 * finalizer repeats the same rules in SQL (`finalize_evaluation_import_job`, migration
 * 20261113010000), because the staging table can be written without this function. Change all
 * three, or none.
 *
 * A row is judged whole: one bad cell and the row is not applied, so correcting the file and
 * importing it again is all it takes. A blank cell is not an error and not a zero: it leaves the
 * stored value alone. No message quotes the cell's value (R0): the row and field say where.
 */

/** The canonical keys a registration id arrives under, in the order the player import reads them. */
export const EVALUATION_ID_KEYS: readonly string[] = Object.freeze([
  'external_registration_id',
  'gotsport_id',
  'registration_id',
  'player_id',
]);

/** The skill tier arrives as `skill_tier`, or `skill_level` when the header was not aliased. */
export const EVALUATION_TIER_KEYS: readonly string[] = Object.freeze(['skill_tier', 'skill_level']);

/** The values an evaluations file can carry; a file needs at least one of them. */
export const EVALUATION_VALUE_KEYS: readonly string[] = Object.freeze([
  'years_played',
  'skill_tier',
  'rating',
]);

/** `players.years_played` is 0 to 30 (migration 20260611000000). */
export const MAX_YEARS_PLAYED = 30;
/** `players.skill_tier`. */
export const SKILL_TIERS: readonly string[] = Object.freeze(['novice', 'developing', 'advanced']);
/** `players.rating` is 1 to 5 (migration 20260611000000). */
export const MIN_RATING = 1;
export const MAX_RATING = 5;

export interface EvaluationRowError {
  field: string;
  message: string;
}

const isBlank = (value: unknown): boolean =>
  value === undefined || value === null || String(value).trim() === '';

/** The first non-blank value among `keys`, trimmed; else null. */
function firstFilled(row: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    if (!isBlank(row[key])) return String(row[key]).trim();
  }
  return null;
}

/** The row's registration id, as text (leading zeros kept), or null. */
export function evaluationRegistrationId(row: Record<string, unknown>): string | null {
  return firstFilled(row, EVALUATION_ID_KEYS);
}

/**
 * The errors of one normalized row: a missing registration id, and each value present but out of
 * range. An empty list means the row can be staged. `field` is the canonical key.
 */
export function validateEvaluationRow(row: Record<string, unknown>): EvaluationRowError[] {
  const errors: EvaluationRowError[] = [];

  if (evaluationRegistrationId(row) === null) {
    errors.push({
      field: 'external_registration_id',
      message: 'Missing required field: external_registration_id',
    });
  }

  const years = firstFilled(row, ['years_played']);
  if (years !== null && !(/^[0-9]{1,2}$/.test(years) && Number(years) <= MAX_YEARS_PLAYED)) {
    errors.push({
      field: 'years_played',
      message: `Years played must be a whole number from 0 to ${MAX_YEARS_PLAYED}`,
    });
  }

  const tier = firstFilled(row, EVALUATION_TIER_KEYS);
  if (tier !== null && !SKILL_TIERS.includes(tier.toLowerCase())) {
    errors.push({
      field: 'skill_tier',
      message:
        'Skill tier must be novice, developing or advanced (a number from 1 to 5 belongs in a Rating column)',
    });
  }

  const rating = firstFilled(row, ['rating']);
  if (rating !== null && !new RegExp(`^[${MIN_RATING}-${MAX_RATING}]$`).test(rating)) {
    errors.push({
      field: 'rating',
      message: `Rating must be a whole number from ${MIN_RATING} to ${MAX_RATING}`,
    });
  }

  return errors;
}
