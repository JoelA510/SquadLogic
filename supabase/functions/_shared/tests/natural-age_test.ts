/**
 * The natural age an import stores, with the season's age cutoff and its divisions' birth-date
 * windows, in the runtime the import-validation Edge Function is deployed to (Phase E3b; plan
 * docs/changes/2026-10-27-season-enrollment.md, C3). `tests/naturalAgeParity.test.js` (Vitest)
 * holds this copy equal to core's on a corpus; this file asks the Deno build the same questions.
 * Placeholder dates only.
 */

import { assertEquals } from 'https://deno.land/std@0.203.0/assert/mod.ts';
import {
  computeAgeNumber,
  cutoffMonthDay,
  importNaturalAge,
  windowedAgeNumber,
} from '../natural-age.ts';

Deno.test('a custom cutoff day: on or after it is the younger group', () => {
  const sep1 = { month: 9, day: 1 };
  assertEquals(computeAgeNumber('2016-08-31', 2026, 'custom', sep1), 10);
  assertEquals(computeAgeNumber('2016-09-01', 2026, 'custom', sep1), 9);
  // Aug 15 differs from the school year, which starts its younger group on Aug 1.
  assertEquals(computeAgeNumber('2016-08-15', 2026, 'custom', sep1), 10);
  assertEquals(computeAgeNumber('2016-08-15', 2026, 'school_year_aug_jul'), 9);
});

Deno.test(
  'a custom Aug 1 is the school year, a custom Jan 1 the calendar year, a bad day the school year',
  () => {
    for (const d of ['2016-01-01', '2016-07-31', '2016-08-01', '2016-12-31']) {
      assertEquals(
        computeAgeNumber(d, 2026, 'custom', { month: 8, day: 1 }),
        computeAgeNumber(d, 2026, 'school_year_aug_jul')
      );
      assertEquals(
        computeAgeNumber(d, 2026, 'custom', { month: 1, day: 1 }),
        computeAgeNumber(d, 2026, 'birth_year')
      );
    }
    assertEquals(computeAgeNumber('2016-08-15', 2026, 'custom', { month: 2, day: 30 }), 9);
    assertEquals(computeAgeNumber('2016-08-15', 2026, 'custom', undefined), 9);
    assertEquals(cutoffMonthDay(2, 29), 229);
    assertEquals(cutoffMonthDay(4, 31), null);
  }
);

Deno.test(
  'a division window takes a birth date in it as that division, brought into its band',
  () => {
    const u4 = {
      name: 'U4 Coed',
      min_age: 4,
      max_age: 4,
      birthdate_start: '2024-01-01',
      birthdate_end: '2024-07-31',
    };
    const season = { seasonYear: 2026, cutoffMode: 'school_year_aug_jul' };
    assertEquals(importNaturalAge({ ...season, dob: '2024-03-15' }), 2);
    assertEquals(importNaturalAge({ ...season, dob: '2024-03-15', divisions: [u4] }), 4);
    // The window's ends are inside it; the day outside on either side is counted by the cutoff.
    assertEquals(importNaturalAge({ ...season, dob: '2024-01-01', divisions: [u4] }), 4);
    assertEquals(importNaturalAge({ ...season, dob: '2024-07-31', divisions: [u4] }), 4);
    assertEquals(importNaturalAge({ ...season, dob: '2023-12-31', divisions: [u4] }), 2);
    assertEquals(importNaturalAge({ ...season, dob: '2024-08-01', divisions: [u4] }), 1);
    // The band comes from the name when the columns are empty; a window with no band names no age.
    assertEquals(windowedAgeNumber('2024-03-15', 2, [{ ...u4, min_age: null, max_age: null }]), 4);
    assertEquals(
      windowedAgeNumber('2024-03-15', 2, [
        { ...u4, name: 'Little ones', min_age: null, max_age: null },
      ]),
      null
    );
    // Half a window is no window; two windows holding a date give the lower age.
    assertEquals(
      windowedAgeNumber('2024-03-15', 2, [{ name: 'U4', birthdate_start: '2024-01-01' }]),
      null
    );
    assertEquals(
      windowedAgeNumber('2024-03-15', 2, [
        u4,
        {
          name: 'U3',
          min_age: 3,
          max_age: 3,
          birthdate_start: '2024-01-01',
          birthdate_end: '2024-12-31',
        },
      ]),
      3
    );
  }
);

Deno.test('the age group the export states is still the fallback', () => {
  assertEquals(
    importNaturalAge({
      ageGroup: '5',
      dob: 'not a date',
      seasonYear: 2026,
      cutoffMode: 'custom',
      cutoffMonth: 9,
      cutoffDay: 1,
    }),
    5
  );
  assertEquals(importNaturalAge({ ageGroup: '5' }), 5);
  assertEquals(importNaturalAge({}), null);
});
