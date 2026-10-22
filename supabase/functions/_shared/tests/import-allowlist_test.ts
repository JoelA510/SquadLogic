/**
 * The import-validation Edge Function's allowlist, in the runtime it is
 * deployed to (plan docs/changes/2026-10-22-admin-focus.md, R0).
 * `tests/importAllowlistParity.test.js` (Vitest) holds this copy equal to the
 * browser's and to the keys the SQL finalizers read; this file asks the Deno
 * build the same questions. Placeholder values only.
 */

import { assertEquals } from 'https://deno.land/std@0.203.0/assert/mod.ts';
import { isAllowedImportKey, keepAllowedColumns, declaredFieldKey } from '../import-allowlist.ts';

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
