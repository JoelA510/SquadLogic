import { describe, expect, it } from 'vitest';
import * as core from '../packages/core/src/ageGroups.js';
import * as edge from '../supabase/functions/_shared/natural-age.ts';
import * as browserAllowlist from '../frontend/src/utils/importAllowlist.js';
import * as edgeAllowlist from '../supabase/functions/_shared/import-allowlist.ts';

/**
 * R5 (docs/changes/2026-10-22-admin-focus.md): import-validation computes the natural age an
 * import stores with `_shared/natural-age.ts`, a twin of core's `importNaturalAge` (an Edge
 * Function cannot import `packages/core`), and stages no birth key (`withoutBirthKeys`, twinned
 * in the browser allowlist for the mock). This holds the twins equal on a corpus written here.
 */

/** @type {Array<[number|null, string|undefined]>} */
const SEASONS = [
  [2026, 'school_year_aug_jul'],
  [2026, 'birth_year'],
  [2027, undefined],
  [2027, 'anything else'],
  [null, 'birth_year'],
  [Number.NaN, 'birth_year'],
];
const AGE_GROUPS = [
  undefined,
  null,
  '',
  ' ',
  '9',
  '09',
  ' 10 ',
  '0',
  '25',
  '26',
  '100',
  'U10',
  '9.5',
  7,
  '-3',
];
const DOBS = [
  undefined,
  null,
  '',
  'not a date',
  '2016-01-01',
  '2016-07-31',
  '2016-08-01',
  '2016-12-31',
  '2000-03-01',
  '2030-03-01',
  '1990-05-05',
];

describe('the natural age, core and Edge copies', () => {
  it('have the same bounds', () => {
    expect([edge.NATURAL_AGE_MIN, edge.NATURAL_AGE_MAX]).toEqual([
      core.NATURAL_AGE_MIN,
      core.NATURAL_AGE_MAX,
    ]);
  });

  it('agree on every age group, birth date and season of the corpus', () => {
    let compared = 0;
    const seen = new Set();
    for (const [seasonYear, cutoffMode] of SEASONS) {
      for (const ageGroup of AGE_GROUPS) {
        for (const dob of DOBS) {
          const params = { ageGroup, dob, seasonYear, cutoffMode };
          const expected = core.importNaturalAge(params);
          expect(edge.importNaturalAge(params), JSON.stringify(params)).toBe(expected);
          seen.add(expected);
          compared += 1;
        }
      }
      for (const dob of DOBS) {
        expect(edge.computeAgeNumber(dob, seasonYear, cutoffMode)).toBe(
          core.computeAgeNumber(dob, seasonYear, cutoffMode)
        );
      }
    }
    expect(compared).toBe(SEASONS.length * AGE_GROUPS.length * DOBS.length);
    // Not vacuous: stated ages, computed ages on both sides of the cutoff, and none.
    for (const value of [null, 9, 10, 25, 7, 26 - 16])
      expect(seen.has(value), String(value)).toBe(true);
  });

  it('reads the birth date first, then the stated age group, then nothing', () => {
    const season = { seasonYear: 2026, cutoffMode: 'school_year_aug_jul' };
    expect(core.importNaturalAge({ ...season, ageGroup: '11', dob: '2016-03-01' })).toBe(10);
    expect(core.importNaturalAge({ ...season, dob: '2016-08-01' })).toBe(9);
    expect(core.importNaturalAge({ ...season, ageGroup: '11', dob: 'not a date' })).toBe(11);
    expect(core.importNaturalAge({ ageGroup: '11', dob: '2016-03-01' })).toBe(11);
    expect(core.importNaturalAge({ ...season, ageGroup: '11', dob: '1990-01-01' })).toBe(11);
    expect(core.importNaturalAge({ ...season, ageGroup: '30', dob: '1990-01-01' })).toBeNull();
    expect(core.importNaturalAge({ ageGroup: 'U11', dob: '2016-03-01' })).toBeNull();
  });
});

describe("the season an import's ages are counted in", () => {
  it("is the one finalize_import_job attaches divisions to: the job's season, else the active one", () => {
    const seasons = [
      { id: 'old-completed', status: 'completed', season_year: 2025 },
      { id: 'next-draft', status: 'draft', season_year: 2027 },
      { id: 'current', status: 'active', season_year: 2026 },
    ];
    // A job for a draft is counted with the draft's year; one with no season, with the active one's.
    expect(edge.importSeason(seasons, 'next-draft')?.season_year).toBe(2027);
    expect(edge.importSeason(seasons, null)?.season_year).toBe(2026);
    expect(edge.importSeason(seasons)?.id).toBe('current');
    // A draft is never borrowed: with no active season and no job season there is none.
    expect(edge.importSeason(seasons.filter((s) => s.status !== 'active'))).toBeNull();
    // A job naming a season that is not among the organization's has none, whatever is active.
    expect(edge.importSeason(seasons, 'gone')).toBeNull();
    expect(edge.importSeason([], null)).toBeNull();
    expect(edge.importSeason(null)).toBeNull();
  });
});

describe('no birth key is staged, browser and Edge copies', () => {
  const normalize = browserAllowlist.canonicalImportKey;
  it('drop every header that reads as a birth key, and nothing else', () => {
    const raw = {
      'First Name': 'First1',
      'Date of Birth': '2016-01-01',
      DOB: '2016-01-01',
      Birthdate: '2016-01-01',
      birth_year: '2016',
      // Declared fields an organization might name like a birth date: stripped too.
      'Birth Date': '2016-01-01',
      'Player DOB': '2016-01-01',
      'Age Group': '10',
      natural_age: '10',
      // Not birth-like: kept (a word containing "dob" is not a dob key).
      'Adobe ID': 'x',
    };
    for (const copy of [browserAllowlist, edgeAllowlist]) {
      expect(copy.withoutBirthKeys('players', raw, normalize)).toEqual({
        'First Name': 'First1',
        'Age Group': '10',
        natural_age: '10',
        'Adobe ID': 'x',
      });
      expect(copy.withoutBirthKeys('coaches', raw, normalize)).toBe(raw);
    }
    expect([...edgeAllowlist.PLAYER_BIRTH_KEYS]).toEqual([...browserAllowlist.PLAYER_BIRTH_KEYS]);
  });

  it('keep the birth date in transit for players only, so import-validation can read it', () => {
    for (const copy of [browserAllowlist, edgeAllowlist]) {
      for (const key of ['date_of_birth', 'dob']) {
        expect(copy.isAllowedImportKey('players', key)).toBe(true);
        expect(copy.isAllowedImportKey('coaches', key)).toBe(false);
        expect(copy.PLAYER_IMPORT_KEYS).not.toContain(key);
      }
      // A birth year alone is read by nothing, so it is dropped like any unlisted column.
      expect(copy.isAllowedImportKey('players', 'birth_year')).toBe(false);
      expect(copy.PLAYER_IMPORT_KEYS).toContain('natural_age');
    }
  });
});
