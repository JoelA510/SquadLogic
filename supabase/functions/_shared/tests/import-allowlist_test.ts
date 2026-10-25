/**
 * The import-validation Edge Function's allowlist, in the runtime it is
 * deployed to (plan docs/changes/2026-10-22-admin-focus.md, R0).
 * `tests/importAllowlistParity.test.js` (Vitest) holds this copy equal to the
 * browser's and to the keys the SQL finalizers read; this file asks the Deno
 * build the same questions. Placeholder values only.
 */

import { assertEquals } from 'https://deno.land/std@0.203.0/assert/mod.ts';
import {
  isAllowedImportHeader,
  isAllowedImportKey,
  keepAllowedColumns,
  declaredFieldKey,
  withDeclaredColumns,
  withoutBirthKeys,
} from '../import-allowlist.ts';
import { importNaturalAge, importSeason } from '../natural-age.ts';

const lower = (h: string) => h.toLowerCase().trim();

Deno.test('a player keeps teaming columns and drops contact, guardian and payment columns', () => {
  const row = {
    first_name: 'First1',
    last_name: 'Last1',
    date_of_birth: '2016-01-01',
    'team name': 'Team 1',
    play_up: 'yes',
    email: 'email1@example.com',
    phone: '555-100-0001',
    guardian_1_email: 'email2@example.com',
    'guardian 1 address': '1 Placeholder Way',
    payment_status: 'PAID',
  };
  assertEquals(keepAllowedColumns('players', row, lower), {
    first_name: 'First1',
    last_name: 'Last1',
    date_of_birth: '2016-01-01',
    'team name': 'Team 1',
    play_up: 'yes',
  });
});

Deno.test('a coach keeps name and sign-in email, and drops the phone and the child', () => {
  const row = {
    full_name: 'First3 Last3',
    email: 'email3@example.com',
    phone: '555-100-0003',
    "what is your player's birth date?": '2016-02-02',
    'guardian 1 mobile phone number': '555-100-0004',
  };
  assertEquals(keepAllowedColumns('coaches', row, lower), {
    full_name: 'First3 Last3',
    email: 'email3@example.com',
  });
});

Deno.test('a declared field is kept by its identity, for its own import only', () => {
  assertEquals(declaredFieldKey(' Shirt  Size '), 'shirt_size');
  assertEquals(isAllowedImportKey('coaches', 'shirt size', ['shirt_size']), true);
  assertEquals(isAllowedImportKey('coaches', 'shirt size', []), false);
  assertEquals(
    keepAllowedColumns('players', { 'Shirt Size': 'YM', Notes: 'x' }, lower, ['shirt_size']),
    { 'Shirt Size': 'YM' }
  );
});

Deno.test('field imports pass through as given', () => {
  const row = { location: 'Field Park', 'guardian 1 email address': 'kept' };
  assertEquals(keepAllowedColumns('fields', row, lower), row);
});

Deno.test(
  'a declared field whose header is also an alias is kept and carried under its identity',
  () => {
    const alias = (h: string) => (lower(h) === 'skill' ? 'skill_tier' : lower(h));
    assertEquals(isAllowedImportHeader('coaches', 'Skill', alias, ['skill']), true);
    assertEquals(isAllowedImportHeader('coaches', 'Skill', alias, []), false);
    assertEquals(
      withDeclaredColumns(
        'coaches',
        { full_name: 'First1 Last1', skill_tier: 'A' },
        { 'Full Name': 'First1 Last1', Skill: 'A' },
        alias,
        ['skill']
      ),
      { full_name: 'First1 Last1', skill: 'A' }
    );
    assertEquals(
      withDeclaredColumns('players', { skill_tier: 'advanced' }, { Skill: 'advanced' }, alias, [
        'skill',
      ]),
      { skill_tier: 'advanced', skill: 'advanced' }
    );
  }
);

Deno.test('no birth key is staged, and the natural age replaces it (R5)', () => {
  const alias = (h: string) =>
    ['date of birth', 'dob', 'birthdate'].includes(lower(h)) ? 'date_of_birth' : lower(h);
  assertEquals(
    withoutBirthKeys(
      'players',
      {
        'First Name': 'First1',
        'Date of Birth': '2016-01-01',
        DOB: '2016-01-01',
        birth_year: '2016',
      },
      alias
    ),
    { 'First Name': 'First1' }
  );
  const season = { seasonYear: 2026, cutoffMode: 'school_year_aug_jul' };
  assertEquals(importNaturalAge({ ...season, dob: '2016-03-01', ageGroup: '11' }), 10);
  assertEquals(importNaturalAge({ ...season, dob: '2016-08-01' }), 9);
  assertEquals(importNaturalAge({ ageGroup: '11' }), 11);
  assertEquals(importNaturalAge({}), null);
  assertEquals(
    importSeason([
      { status: 'draft', season_start: '2026-08-01', season_year: 2027 },
      { status: 'active', season_start: '2025-08-01', season_year: 2026 },
    ])?.season_year,
    2026
  );
});
