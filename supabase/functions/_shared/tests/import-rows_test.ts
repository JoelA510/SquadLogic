/**
 * import-validation's row normalization, in the runtime it is deployed to
 * (docs/changes/2026-10-22-demo-mode.md, D1). `tests/importRowsParity.test.js` (Vitest) holds
 * this copy equal to the browser's; this file asks the Deno build the same questions.
 */

import { assertEquals } from 'https://deno.land/std@0.203.0/assert/mod.ts';
import { composeFullName, normalizeImportRow } from '../import-rows.ts';

const resolve = (h: string) =>
  (({ 'Email/UserID': 'email', 'Contact Email': 'email' }) as Record<string, string>)[h] ??
  h.toLowerCase();

Deno.test('a blank later column never replaces a filled earlier one', () => {
  assertEquals(normalizeImportRow({ 'Email/UserID': 'a@x.org', 'Contact Email': '' }, resolve), {
    email: 'a@x.org',
  });
  assertEquals(normalizeImportRow({ 'Email/UserID': 'a@x.org', 'Contact Email': ' ' }, resolve), {
    email: 'a@x.org',
  });
});

Deno.test('between two filled columns the later one wins', () => {
  assertEquals(
    normalizeImportRow({ 'Email/UserID': 'a@x.org', 'Contact Email': 'b@x.org' }, resolve),
    { email: 'b@x.org' }
  );
});

Deno.test('a coach full name is composed from first and last name', () => {
  assertEquals(composeFullName({ first_name: 'Ada', last_name: 'Byron' }).full_name, 'Ada Byron');
  assertEquals(composeFullName({ full_name: 'A. B.', first_name: 'Ada' }).full_name, 'A. B.');
  assertEquals(composeFullName({ first_name: '', last_name: '' }).full_name, undefined);
});
