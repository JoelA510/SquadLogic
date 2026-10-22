import { describe, expect, it } from 'vitest';
import * as browser from '../frontend/src/utils/importRows.js';
import * as edge from '../supabase/functions/_shared/import-rows.ts';

/**
 * Import rows are normalized in three places: import-validation (the Edge copy, which stages
 * what is persisted), and ImportPanel's preview and the mock `import-validation` (the browser
 * copy). This holds the two copies to the same answers on every case below
 * (docs/changes/2026-10-22-demo-mode.md, D1). The expected answers are written here, not taken
 * from either copy, so a rule dropped from both is caught too.
 */

const ALIASES = { 'Email/UserID': 'email', 'Contact Email': 'email', 'First Name': 'first_name' };
const resolve = (h) => (Object.hasOwn(ALIASES, h) ? ALIASES[h] : h.toLowerCase());

/** @type {Array<[string, Record<string, unknown>, Record<string, string>]>} */
const NORMALIZE = [
  [
    'a blank later column keeps the earlier value',
    { 'Email/UserID': 'a@x.org', 'Contact Email': '' },
    { email: 'a@x.org' },
  ],
  [
    'a whitespace-only later column keeps the earlier value',
    { 'Email/UserID': 'a@x.org', 'Contact Email': '   ' },
    { email: 'a@x.org' },
  ],
  [
    'a filled later column wins over a filled earlier one',
    { 'Email/UserID': 'a@x.org', 'Contact Email': 'b@x.org' },
    { email: 'b@x.org' },
  ],
  [
    'a filled later column fills a blank earlier one',
    { 'Email/UserID': '', 'Contact Email': 'b@x.org' },
    { email: 'b@x.org' },
  ],
  ['both blank keeps the key, blank', { 'Email/UserID': '', 'Contact Email': '' }, { email: '' }],
  [
    'null and undefined become blank',
    { 'Email/UserID': null, Notes: undefined },
    { email: '', notes: '' },
  ],
  [
    'a header named like an Object member is kept',
    { constructor: 'x', toString: 'y' },
    { constructor: 'x', tostring: 'y' },
  ],
];

/** @type {Array<[string, Record<string, string>, string | undefined]>} */
const COMPOSE = [
  ['first and last compose', { first_name: 'Ada', last_name: 'Byron' }, 'Ada Byron'],
  ['parts are trimmed', { first_name: ' Ada ', last_name: ' Byron ' }, 'Ada Byron'],
  ['first name alone', { first_name: 'Ada', last_name: '' }, 'Ada'],
  ['last name alone', { last_name: 'Byron' }, 'Byron'],
  [
    'an existing full name is kept',
    { full_name: 'A. B.', first_name: 'Ada', last_name: 'Byron' },
    'A. B.',
  ],
  [
    'a blank full name is replaced',
    { full_name: ' ', first_name: 'Ada', last_name: 'Byron' },
    'Ada Byron',
  ],
  ['no parts leaves it absent', { first_name: '', last_name: '' }, undefined],
];

describe('import row normalization: browser and Edge copies agree', () => {
  for (const [label, row, expected] of NORMALIZE) {
    it(label, () => {
      expect(browser.normalizeImportRow(row, resolve)).toEqual(expected);
      expect(edge.normalizeImportRow(row, resolve)).toEqual(expected);
    });
  }

  it('applies the cleaner before deciding a value is blank', () => {
    const clean = (v) =>
      String(v ?? '')
        .replaceAll('<', '')
        .trim();
    const row = { 'Email/UserID': 'a@x.org', 'Contact Email': '<' };
    expect(browser.normalizeImportRow(row, resolve, clean)).toEqual({ email: 'a@x.org' });
    expect(edge.normalizeImportRow(row, resolve, clean)).toEqual({ email: 'a@x.org' });
  });

  for (const [label, row, expected] of COMPOSE) {
    it(`full name: ${label}`, () => {
      expect(browser.composeFullName(row).full_name).toBe(expected);
      expect(edge.composeFullName(row).full_name).toBe(expected);
    });
  }

  it('exports the same functions', () => {
    expect(Object.keys(browser).sort()).toEqual(Object.keys(edge).sort());
  });
});
