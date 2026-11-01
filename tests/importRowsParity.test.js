import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

  it('applies the cleaner to the composed name, so two capped parts stay under the cap', () => {
    const cap = (v) => String(v ?? '').slice(0, 500);
    const row = { first_name: 'a'.repeat(500), last_name: 'b'.repeat(500) };
    expect(browser.composeFullName(row, cap).full_name).toHaveLength(500);
    expect(edge.composeFullName(row, cap).full_name).toHaveLength(500);
  });

  it('exports the same functions', () => {
    expect(Object.keys(browser).sort()).toEqual(Object.keys(edge).sort());
  });
});

/**
 * The cleaner every imported cell goes through (`sanitizeImportText`): tags and control characters
 * out, trimmed, capped at 500. The browser's preview, the mock `import-validation` and the Edge function
 * all call it, so what a preview promises about a cell is what is staged. A tag is a `<` to the first
 * `>` after it, removed by a scan rather than a regular-expression replace (CodeQL
 * js/incomplete-multi-character-sanitization, alert 18); a lone `<` or `>` is data ("<1", "5 > 3") and
 * stays, as it always did.
 *
 * Plant: take a different span for a tag in either copy (stop at the last `>`, or drop strays) ->
 * the nested, stray and exhaustive cases go red.
 */
/** @type {Array<[string, unknown, string]>} */
const CLEAN = [
  ['an ordinary cell is unchanged', 'U10 Hawks', 'U10 Hawks'],
  [
    'punctuation that is not an angle bracket is unchanged',
    "O'Brien & Sons, 5:00 PM; (a/b)",
    "O'Brien & Sons, 5:00 PM; (a/b)",
  ],
  ['an address is unchanged', 'casey@example.test', 'casey@example.test'],
  ['a tag is removed with its brackets', '<b>Hawks</b>', 'Hawks'],
  ['a tag with attributes is removed', 'U10 <a href="x">Hawks</a>', 'U10 Hawks'],
  ['a nested tag leaves no tag', '<<script>script>', 'script>'],
  ['a tag split by another leaves no tag', '<scr<script>ipt>', 'ipt>'],
  ['brackets inside brackets', '<x<y>>', '>'],
  ['a lone closing bracket is data', 'a > b', 'a > b'],
  ['a lone opening bracket is data', 'a < b', 'a < b'],
  ['"less than one" is data', '<1', '<1'],
  ['"more than five" is data', '>5', '>5'],
  ['a span from < to > goes, as a tag would', '5 < 6 and 7 > 6', '5  6'],
  ['an unterminated tag stays, as it always did', 'x <script', 'x <script'],
  ['control characters go, tab and newline stay', 'a\u0007b\tc\nd\u007f', 'ab\tc\nd'],
  ['it is trimmed after the strip', '  <i></i> Hawks \t', 'Hawks'],
  [
    'it is capped at 500 after the strip',
    `${'x'.repeat(498)}<b>${'y'.repeat(10)}`,
    `${'x'.repeat(498)}yy`,
  ],
  ['null and undefined are blank', null, ''],
  ['a number is its text', 5, '5'],
];

/** A tag span left in `text`: a `<` with a `>` somewhere after it. */
const hasTagSpan = (text) => {
  const open = text.indexOf('<');
  return open !== -1 && text.indexOf('>', open) !== -1;
};

/** The same rule written another way (append character by character), to hold the scan to. */
const reference = (text) => {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '<') {
      const close = text.indexOf('>', i + 1);
      if (close === -1) return out + text.slice(i);
      i = close + 1;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
};

describe('the cell cleaner: browser and Edge copies agree', () => {
  for (const [label, input, expected] of CLEAN) {
    it(label, () => {
      expect(browser.sanitizeImportText(input)).toBe(expected);
      expect(edge.sanitizeImportText(input)).toBe(expected);
    });
  }

  it('takes the cap as an argument, 500 by default', () => {
    expect(browser.sanitizeImportText('abcdef', 3)).toBe('abc');
    expect(edge.sanitizeImportText('abcdef', 3)).toBe('abc');
    expect(browser.sanitizeImportText('x'.repeat(501))).toHaveLength(500);
  });

  it('leaves no tag, changes nothing a second time and agrees with the other copy, for every string over five symbols up to seven long', () => {
    const symbols = ['<', '>', 'a', ' ', '/'];
    let checked = 0;
    const walk = (prefix, remaining) => {
      const a = browser.sanitizeImportText(prefix);
      const b = edge.sanitizeImportText(prefix);
      expect(a).toBe(b);
      expect(hasTagSpan(a)).toBe(false);
      expect(browser.sanitizeImportText(a)).toBe(a);
      // The strip alone is the reference rule (the trim is the only other thing these symbols meet).
      expect(a).toBe(reference(prefix).trim());
      checked += 1;
      if (remaining === 0) return;
      for (const symbol of symbols) walk(prefix + symbol, remaining - 1);
    };
    walk('', 7);
    // 5^0 + ... + 5^7 strings: a walk that visited none would pass every assertion above.
    expect(checked).toBe(97656);
  });

  it('is linear in the input: a megabyte of unclosed brackets, of pairs and of one long tag takes well under a second', () => {
    for (const copy of [browser, edge]) {
      const started = performance.now();
      expect(copy.sanitizeImportText('<'.repeat(1_000_000), 1_000_000)).toBe('<'.repeat(1_000_000));
      expect(copy.sanitizeImportText('<>'.repeat(500_000), 1_000_000)).toBe('');
      expect(copy.sanitizeImportText(`${'<a'.repeat(300_000)}>`, 1_000_000)).toBe('');
      expect(performance.now() - started).toBeLessThan(1500);
    }
  });
});

describe('no source strips a tag with one regular-expression pass', () => {
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const roots = ['frontend/src', 'supabase/functions'];
  const sources = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'tests' && entry.name !== 'node_modules') walk(full);
      } else if (/\.(js|jsx|ts|tsx)$/.test(entry.name)) sources.push(full);
    }
  };
  for (const root of roots) walk(path.join(REPO, root));

  it('finds the sources it scans, and none holds the single-pass tag pattern', () => {
    expect(sources.length).toBeGreaterThan(100);
    const offenders = sources.filter((file) => readFileSync(file, 'utf8').includes('<[^>]*>'));
    expect(offenders.map((file) => path.relative(REPO, file))).toEqual([]);
  });

  it('import-validation cleans its cells with the shared cleaner and keeps nothing of its own', () => {
    const index = readFileSync(
      path.join(REPO, 'supabase/functions/import-validation/index.ts'),
      'utf8'
    );
    expect(index).toMatch(
      /function sanitizeString\(value: unknown\): string \{\s*return sanitizeImportText\(value, MAX_STRING_LENGTH\);\s*\}/
    );
    expect(index).toMatch(
      /import \{[^}]*\bsanitizeImportText\b[^}]*\} from '\.\.\/_shared\/import-rows\.ts'/
    );
  });
});
