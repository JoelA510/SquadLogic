import { describe, expect, it } from 'vitest';
import * as browser from '../frontend/src/utils/importEvaluations.js';
import * as edge from '../supabase/functions/_shared/import-evaluations.ts';

/**
 * The evaluations import's row rules (docs/changes/2026-10-27-season-enrollment.md, C2; E3c) live
 * in three places: `import-validation` (the Edge copy, which decides what is staged), the browser
 * preview and the mock `import-validation` (the browser copy), and the SQL finalizer
 * (`finalize_evaluation_import_job`, held to the same cases by supabase/tests/evaluations_import.sql
 * and docs/sql/20261113010000_smoke.sql). This holds the two code copies to the same answers on
 * every case below. The expected answers are written here, not taken from either copy, so a rule
 * dropped from both is caught too.
 */

const ID = { external_registration_id: 'GS-1' };
const MISSING = 'Missing required field: external_registration_id';
const YEARS = 'Years played must be a whole number from 0 to 30';
const TIER =
  'Skill tier must be novice, developing or advanced (a number from 1 to 5 belongs in a Rating column)';
const RATING = 'Rating must be a whole number from 1 to 5';

/** @type {Array<[string, Record<string, unknown>, Array<{ field: string, message: string }>]>} */
const CASES = [
  [
    'an id and all three values in range',
    { ...ID, years_played: '3', skill_tier: 'developing', rating: '4' },
    [],
  ],
  ['an id alone is valid (nothing to set)', { ...ID }, []],
  ['blank cells are not errors', { ...ID, years_played: '', skill_tier: '  ', rating: '' }, []],
  ['a zero is a value', { ...ID, years_played: '0' }, []],
  ['the top of each range', { ...ID, years_played: '30', rating: '5' }, []],
  ['the bottom of the rating', { ...ID, rating: '1' }, []],
  ['a leading zero is a whole number', { ...ID, years_played: '05' }, []],
  ['a tier in capitals', { ...ID, skill_tier: 'NOVICE' }, []],
  ['a tier under skill_level', { ...ID, skill_level: 'Advanced' }, []],
  ['the id under gotsport_id', { gotsport_id: 'GS-9', years_played: '1' }, []],
  ['the id under registration_id', { registration_id: 'GS-9' }, []],
  ['the id under player_id', { player_id: '0042' }, []],
  ['no id', { years_played: '2' }, [{ field: 'external_registration_id', message: MISSING }]],
  [
    'a blank id',
    { external_registration_id: '   ', rating: '3' },
    [{ field: 'external_registration_id', message: MISSING }],
  ],
  ['years 31', { ...ID, years_played: '31' }, [{ field: 'years_played', message: YEARS }]],
  ['years 100', { ...ID, years_played: '100' }, [{ field: 'years_played', message: YEARS }]],
  ['years negative', { ...ID, years_played: '-1' }, [{ field: 'years_played', message: YEARS }]],
  [
    'years with a decimal',
    { ...ID, years_played: '2.5' },
    [{ field: 'years_played', message: YEARS }],
  ],
  ['years with text', { ...ID, years_played: '3+' }, [{ field: 'years_played', message: YEARS }]],
  [
    'a tier that is not one',
    { ...ID, skill_tier: 'gold' },
    [{ field: 'skill_tier', message: TIER }],
  ],
  [
    'a number in the tier column',
    { ...ID, skill_tier: '4' },
    [{ field: 'skill_tier', message: TIER }],
  ],
  ['rating 0', { ...ID, rating: '0' }, [{ field: 'rating', message: RATING }]],
  ['rating 6', { ...ID, rating: '6' }, [{ field: 'rating', message: RATING }]],
  ['rating with a decimal', { ...ID, rating: '3.5' }, [{ field: 'rating', message: RATING }]],
  ['rating 10', { ...ID, rating: '10' }, [{ field: 'rating', message: RATING }]],
  [
    'every cell bad, in a fixed order',
    { years_played: 'x', skill_tier: 'y', rating: 'z' },
    [
      { field: 'external_registration_id', message: MISSING },
      { field: 'years_played', message: YEARS },
      { field: 'skill_tier', message: TIER },
      { field: 'rating', message: RATING },
    ],
  ],
];

describe.each([
  ['the Edge copy', edge],
  ['the browser copy', browser],
])('%s of the evaluations row rules', (_name, copy) => {
  it.each(CASES)('%s', (_label, row, expected) => {
    expect(copy.validateEvaluationRow(row)).toEqual(expected);
  });

  it('reads the registration id as text, first non-blank key in the player import order', () => {
    expect(copy.evaluationRegistrationId({ player_id: '0042', gotsport_id: ' 7 ' })).toBe('7');
    expect(copy.evaluationRegistrationId({ external_registration_id: '0042' })).toBe('0042');
    expect(
      copy.evaluationRegistrationId({ external_registration_id: '', registration_id: 'R-1' })
    ).toBe('R-1');
    expect(copy.evaluationRegistrationId({ years_played: '2' })).toBeNull();
  });

  it('quotes no value from the file in any message', () => {
    const errors = copy.validateEvaluationRow({
      years_played: 'SECRET-1',
      skill_tier: 'SECRET-2',
      rating: 'SECRET-3',
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(errors)).not.toMatch(/SECRET/);
  });
});

describe('the two copies agree', () => {
  it('on the constants', () => {
    expect([...edge.EVALUATION_ID_KEYS]).toEqual([...browser.EVALUATION_ID_KEYS]);
    expect([...edge.EVALUATION_TIER_KEYS]).toEqual([...browser.EVALUATION_TIER_KEYS]);
    expect([...edge.EVALUATION_VALUE_KEYS]).toEqual([...browser.EVALUATION_VALUE_KEYS]);
    expect([...edge.SKILL_TIERS]).toEqual([...browser.SKILL_TIERS]);
    expect([edge.MAX_YEARS_PLAYED, edge.MIN_RATING, edge.MAX_RATING]).toEqual([
      browser.MAX_YEARS_PLAYED,
      browser.MIN_RATING,
      browser.MAX_RATING,
    ]);
  });

  it('and the ranges are the columns of the players table', () => {
    // players.years_played CHECK 0..30 and players.rating CHECK 1..5 (migration 20260611000000),
    // players.skill_tier IN (novice, developing, advanced).
    expect([browser.MAX_YEARS_PLAYED, browser.MIN_RATING, browser.MAX_RATING]).toEqual([30, 1, 5]);
    expect([...browser.SKILL_TIERS]).toEqual(['novice', 'developing', 'advanced']);
  });
});
