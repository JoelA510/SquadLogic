import { describe, expect, it } from 'vitest';
import {
  AGE_CUTOFF_MODES,
  cohortWindow,
  computeAgeGroup,
  computeAgeNumber,
  cutoffMonthDay,
  divisionBirthWindow,
  importNaturalAge,
  isEligibleForDivision,
  normalizeCutoffMode,
  windowedAgeNumber,
} from '../packages/core/src/ageGroups.js';
import { applyPlayUpEligibility, resolveNaturalAge } from '../packages/core/src/playUp.js';

/**
 * The age cutoff of a season (Phase E3b; plan docs/changes/2026-10-27-season-enrollment.md, C3):
 * the school year (the default), the calendar year, and a custom day of the year, each counted for
 * a season year (the year the season starts); and a division's own birth-date window, which takes
 * every player born in it as that division's age (a U4 that also takes older 2-year-olds).
 */

describe('the three cutoff modes', () => {
  const dob = (text) => text;
  it('names custom, and an unknown mode is the school year', () => {
    expect(AGE_CUTOFF_MODES.CUSTOM).toBe('custom');
    expect(normalizeCutoffMode('custom')).toBe('custom');
    expect(normalizeCutoffMode('lunar')).toBe('school_year_aug_jul');
    expect(normalizeCutoffMode(undefined)).toBe('school_year_aug_jul');
  });

  it('counts the school year from Aug 1 and the calendar year from Jan 1', () => {
    expect(computeAgeNumber(dob('2016-07-31'), 2026, 'school_year_aug_jul')).toBe(10);
    expect(computeAgeNumber(dob('2016-08-01'), 2026, 'school_year_aug_jul')).toBe(9);
    expect(computeAgeNumber(dob('2016-12-31'), 2026, 'birth_year')).toBe(10);
    expect(computeAgeNumber(dob('2016-01-01'), 2026, 'birth_year')).toBe(10);
  });

  it('counts a custom cutoff day: on or after it is the younger group', () => {
    const sep1 = { month: 9, day: 1 };
    expect(computeAgeNumber(dob('2016-08-31'), 2026, 'custom', sep1)).toBe(10);
    expect(computeAgeNumber(dob('2016-09-01'), 2026, 'custom', sep1)).toBe(9);
    expect(computeAgeNumber(dob('2016-01-15'), 2026, 'custom', sep1)).toBe(10);
    expect(computeAgeNumber(dob('2016-12-31'), 2026, 'custom', sep1)).toBe(9);
    // The same day differs from the school year only between Aug 1 and Aug 31.
    expect(computeAgeNumber(dob('2016-08-15'), 2026, 'custom', sep1)).toBe(10);
    expect(computeAgeNumber(dob('2016-08-15'), 2026, 'school_year_aug_jul')).toBe(9);
  });

  it('reads a custom Aug 1 as the school year and a custom Jan 1 as the calendar year', () => {
    for (const d of ['2016-01-01', '2016-07-31', '2016-08-01', '2016-12-31']) {
      expect(computeAgeNumber(d, 2026, 'custom', { month: 8, day: 1 })).toBe(
        computeAgeNumber(d, 2026, 'school_year_aug_jul')
      );
      expect(computeAgeNumber(d, 2026, 'custom', { month: 1, day: 1 })).toBe(
        computeAgeNumber(d, 2026, 'birth_year')
      );
    }
  });

  it('counts February 29 as March 1 in a year without one', () => {
    const leap = { month: 2, day: 29 };
    expect(computeAgeNumber('2016-02-29', 2026, 'custom', leap)).toBe(9);
    expect(computeAgeNumber('2016-02-28', 2026, 'custom', leap)).toBe(10);
    expect(computeAgeNumber('2017-02-28', 2026, 'custom', leap)).toBe(9);
    expect(computeAgeNumber('2017-03-01', 2026, 'custom', leap)).toBe(8);
  });

  it('treats a custom season with no usable day as the school year', () => {
    for (const cutoff of [
      undefined,
      {},
      { month: 9 },
      { month: 13, day: 1 },
      { month: 2, day: 30 },
    ]) {
      expect(computeAgeNumber('2016-08-15', 2026, 'custom', cutoff)).toBe(9);
    }
    expect(cutoffMonthDay({ month: 2, day: 29 })).toBe(229);
    expect(cutoffMonthDay({ month: 4, day: 31 })).toBeNull();
    expect(cutoffMonthDay({ month: '9', day: '1' })).toBe(901);
  });

  it('gives the cohort window of a custom cutoff, and it agrees with the age it counts', () => {
    expect(cohortWindow(10, 2026, 'custom', { month: 9, day: 1 })).toEqual({
      start: '2015-09-01',
      end: '2016-08-31',
    });
    expect(cohortWindow(10, 2026, 'custom', { month: 1, day: 1 })).toEqual(
      cohortWindow(10, 2026, 'birth_year')
    );
    expect(cohortWindow(10, 2026, 'custom', { month: 3, day: 1 })).toEqual({
      start: '2015-03-01',
      end: '2016-02-29',
    });
    expect(cohortWindow(9, 2026, 'custom', { month: 3, day: 1 })).toEqual({
      start: '2016-03-01',
      end: '2017-02-28',
    });
    // Every date in a cohort's window counts as that age, and the day outside on either side does not.
    for (const cutoff of [
      { month: 9, day: 1 },
      { month: 3, day: 1 },
      { month: 2, day: 29 },
    ]) {
      const { start, end } = cohortWindow(10, 2026, 'custom', cutoff);
      const day = (text, delta) => {
        const d = new Date(`${text}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + delta);
        return d.toISOString().slice(0, 10);
      };
      expect(computeAgeNumber(start, 2026, 'custom', cutoff)).toBe(10);
      expect(computeAgeNumber(end, 2026, 'custom', cutoff)).toBe(10);
      expect(computeAgeNumber(day(start, -1), 2026, 'custom', cutoff)).toBe(11);
      expect(computeAgeNumber(day(end, 1), 2026, 'custom', cutoff)).toBe(9);
    }
    expect(divisionBirthWindow(9, 10, 2026, 'custom', { month: 9, day: 1 })).toEqual({
      start: '2015-09-01',
      end: '2017-08-31',
    });
  });

  it('threads the cutoff day through the group and the eligibility', () => {
    const custom = { cutoffMode: 'custom', cutoffMonth: 9, cutoffDay: 1 };
    expect(computeAgeGroup({ dob: '2016-08-31', seasonYear: 2026, ...custom })?.ageGroup).toBe(
      'U10'
    );
    expect(computeAgeGroup({ dob: '2016-09-01', seasonYear: 2026, ...custom })?.ageGroup).toBe(
      'U9'
    );
    expect(
      isEligibleForDivision({
        dob: '2016-08-31',
        division: { name: 'U10 Boys' },
        seasonYear: 2026,
        ...custom,
      })
    ).toBe(true);
    expect(
      isEligibleForDivision({
        dob: '2016-09-01',
        division: { name: 'U10 Boys' },
        seasonYear: 2026,
        ...custom,
      })
    ).toBe(false);
  });
});

describe('a division window takes every player born in it as that division', () => {
  // A U4 that takes the older 2-year-olds: born Jan 1 - Jul 31, 2024 (the school year counts them U2).
  const u4 = {
    name: 'U4 Coed',
    min_age: 4,
    max_age: 4,
    birthdate_start: '2024-01-01',
    birthdate_end: '2024-07-31',
  };
  const season = { seasonYear: 2026, cutoffMode: 'school_year_aug_jul' };

  it('counts an older 2-year-old as 4, and a child outside the window by the cutoff', () => {
    expect(computeAgeNumber('2024-03-15', 2026, 'school_year_aug_jul')).toBe(2);
    expect(importNaturalAge({ ...season, dob: '2024-03-15', divisions: [u4] })).toBe(4);
    expect(importNaturalAge({ ...season, dob: '2024-03-15' })).toBe(2);
    // The day before and the day after the window: counted by the cutoff alone.
    expect(importNaturalAge({ ...season, dob: '2023-12-31', divisions: [u4] })).toBe(2);
    expect(importNaturalAge({ ...season, dob: '2024-08-01', divisions: [u4] })).toBe(1);
    // The window's own ends are inside it.
    expect(importNaturalAge({ ...season, dob: '2024-01-01', divisions: [u4] })).toBe(4);
    expect(importNaturalAge({ ...season, dob: '2024-07-31', divisions: [u4] })).toBe(4);
  });

  it('brings an age into the division band, never out of it', () => {
    const band = {
      name: 'Junior',
      min_age: 7,
      max_age: 8,
      birthdate_start: '2017-01-01',
      birthdate_end: '2019-12-31',
    };
    // Under the band: raised to 7. Within it: kept. Over it: lowered to 8.
    expect(
      windowedAgeNumber('2019-05-01', computeAgeNumber('2019-05-01', 2026, 'birth_year'), [band])
    ).toBe(7);
    expect(windowedAgeNumber('2018-05-01', 8, [band])).toBe(8);
    expect(windowedAgeNumber('2018-05-01', 7, [band])).toBe(7);
    expect(windowedAgeNumber('2017-05-01', 9, [band])).toBe(8);
  });

  it('reads the band from the name when the columns are empty, and ignores a window with no band', () => {
    const named = { name: 'U4 Coed', birthdate_start: '2024-01-01', birthdate_end: '2024-07-31' };
    expect(importNaturalAge({ ...season, dob: '2024-03-15', divisions: [named] })).toBe(4);
    const unnamed = {
      name: 'Little ones',
      birthdate_start: '2024-01-01',
      birthdate_end: '2024-07-31',
    };
    expect(importNaturalAge({ ...season, dob: '2024-03-15', divisions: [unnamed] })).toBe(2);
  });

  it('ignores half a window, and takes the lower age when two windows hold the date', () => {
    const half = { name: 'U4', birthdate_start: '2024-01-01' };
    expect(windowedAgeNumber('2024-03-15', 2, [half])).toBeNull();
    const u3 = {
      name: 'U3',
      min_age: 3,
      max_age: 3,
      birthdate_start: '2024-01-01',
      birthdate_end: '2024-12-31',
    };
    expect(windowedAgeNumber('2024-03-15', 2, [u4, u3])).toBe(3);
    expect(windowedAgeNumber('2024-03-15', 2, [u3, u4])).toBe(3);
    expect(windowedAgeNumber('2024-03-15', 2, [])).toBeNull();
    expect(windowedAgeNumber('2024-03-15', 2, null)).toBeNull();
    expect(windowedAgeNumber('not a date', 2, [u4])).toBeNull();
  });

  it('applies to a window under a custom cutoff too, and the age group of the export is the fallback', () => {
    const custom = { seasonYear: 2026, cutoffMode: 'custom', cutoffMonth: 9, cutoffDay: 1 };
    expect(importNaturalAge({ ...custom, dob: '2024-03-15', divisions: [u4] })).toBe(4);
    expect(importNaturalAge({ ...custom, dob: '2022-09-15' })).toBe(3);
    expect(importNaturalAge({ ...custom, ageGroup: '5', dob: 'not a date', divisions: [u4] })).toBe(
      5
    );
  });

  it('is what play-up counts for a player the Teams page knows only by birth date', () => {
    const divisions = [
      {
        id: 'u4',
        name: 'U4',
        min_age: 4,
        max_age: 4,
        birthdate_start: '2024-01-01',
        birthdate_end: '2024-07-31',
      },
      { id: 'u3', name: 'U3', min_age: 3, max_age: 3 },
    ];
    const player = { id: 'p1', division: 'u4', dob: '2024-03-15' };
    expect(resolveNaturalAge(player, 2026, 'school_year_aug_jul')).toBe(2);
    expect(resolveNaturalAge(player, 2026, 'school_year_aug_jul', { divisions })).toBe(4);
    // Registered in U4 and counted 4: in band, not a play-up.
    const placed = applyPlayUpEligibility({
      players: [player],
      divisions,
      seasonYear: 2026,
      cutoffMode: 'school_year_aug_jul',
    });
    expect(placed.players[0].placement).toBe('in_band');
    // Without the window the same child is a 2-year-old registered in U4 that no division holds.
    const bare = applyPlayUpEligibility({
      players: [player],
      divisions: divisions.map(({ id, name, min_age, max_age }) => ({
        id,
        name,
        min_age,
        max_age,
      })),
      seasonYear: 2026,
      cutoffMode: 'school_year_aug_jul',
    });
    expect(bare.players[0].placement).toBe('no_division');
    // The stored natural age still wins over a birth date.
    expect(
      resolveNaturalAge({ ...player, natural_age: 6 }, 2026, 'school_year_aug_jul', { divisions })
    ).toBe(6);
  });
});
