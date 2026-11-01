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

/**
 * Phase E3b (docs/changes/2026-10-27-season-enrollment.md, C3): the custom cutoff day and a
 * division's birth-date window are read by both copies, on a corpus written here.
 */
describe('the custom cutoff and division windows, core and Edge copies', () => {
  const CUTOFFS = [
    [undefined, undefined],
    [9, 1],
    [8, 1],
    [1, 1],
    [2, 29],
    [3, 1],
    [12, 31],
    [13, 1],
    [2, 30],
    [4, 31],
    [null, null],
    [9, undefined],
  ];
  const MODES = ['school_year_aug_jul', 'birth_year', 'custom', 'lunar', undefined];
  const WINDOWS = [
    undefined,
    null,
    [],
    [
      {
        name: 'U4',
        min_age: 4,
        max_age: 4,
        birthdate_start: '2024-01-01',
        birthdate_end: '2024-07-31',
      },
    ],
    [{ name: 'U4 Coed', birthdate_start: '2024-01-01', birthdate_end: '2024-07-31' }],
    [{ name: 'Little', birthdate_start: '2024-01-01', birthdate_end: '2024-07-31' }],
    [{ name: 'U4', birthdate_start: '2024-01-01' }],
    [
      {
        name: 'U4',
        min_age: 4,
        max_age: 4,
        birthdate_start: '2015-06-01',
        birthdate_end: '2016-12-31',
      },
      { name: 'U11-U12', birthdate_start: '2014-01-01', birthdate_end: '2016-03-01' },
      {
        name: 'U3',
        min_age: 3,
        max_age: 3,
        birthdate_start: '2016-01-01',
        birthdate_end: '2016-12-31',
      },
    ],
    [
      {
        name: 'U10',
        min_age: '10',
        max_age: '10',
        birthdate_start: 'not a date',
        birthdate_end: '2016-12-31',
      },
    ],
  ];
  const DOBS = [
    undefined,
    'not a date',
    '2024-03-15',
    '2024-01-01',
    '2024-07-31',
    '2023-12-31',
    '2016-02-29',
    '2016-02-28',
    '2016-03-01',
    '2016-08-31',
    '2016-09-01',
    '2016-12-31',
    '2015-07-04',
    '2017-02-28',
  ];

  it('agree on every cutoff day, mode, window list and birth date of the corpus', () => {
    let compared = 0;
    let windowed = 0;
    const changedByWindow = new Set();
    for (const mode of MODES) {
      for (const [cutoffMonth, cutoffDay] of CUTOFFS) {
        for (const divisions of WINDOWS) {
          for (const dob of DOBS) {
            const params = {
              ageGroup: '7',
              dob,
              seasonYear: 2026,
              cutoffMode: mode,
              cutoffMonth,
              cutoffDay,
              divisions,
            };
            const expected = core.importNaturalAge(params);
            expect(edge.importNaturalAge(params), JSON.stringify(params)).toBe(expected);
            const standard = core.computeAgeNumber(dob, 2026, mode, {
              month: cutoffMonth,
              day: cutoffDay,
            });
            expect(
              edge.computeAgeNumber(dob, 2026, mode, { month: cutoffMonth, day: cutoffDay }),
              JSON.stringify(params)
            ).toBe(standard);
            if (standard !== null) {
              const w = core.windowedAgeNumber(dob, standard, divisions);
              expect(edge.windowedAgeNumber(dob, standard, divisions), JSON.stringify(params)).toBe(
                w
              );
              if (w !== null) {
                windowed += 1;
                if (w !== standard) changedByWindow.add(`${mode}/${dob}`);
              }
            }
            compared += 1;
          }
        }
      }
    }
    expect(compared).toBe(MODES.length * CUTOFFS.length * WINDOWS.length * DOBS.length);
    // Not vacuous: windows held dates, and moved ages the cutoff alone would have given.
    expect(windowed).toBeGreaterThan(100);
    expect(changedByWindow.size).toBeGreaterThan(5);
  });

  it('agree on the calendar days a custom cutoff accepts', () => {
    for (const month of [0, 1, 2, 4, 12, 13, '9', 'x', null, undefined, 2.5]) {
      for (const day of [0, 1, 28, 29, 30, 31, 32, '1', null, undefined]) {
        expect(edge.cutoffMonthDay(month, day), `${month}/${day}`).toBe(
          core.cutoffMonthDay({ month, day })
        );
      }
    }
    expect(core.cutoffMonthDay({ month: 2, day: 29 })).toBe(229);
    expect(core.cutoffMonthDay({ month: 4, day: 31 })).toBeNull();
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
