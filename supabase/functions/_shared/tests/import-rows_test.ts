/**
 * import-validation's row normalization, in the runtime it is deployed to
 * (docs/changes/2026-10-22-demo-mode.md, D1). `tests/importRowsParity.test.js` (Vitest) holds
 * this copy equal to the browser's; this file asks the Deno build the same questions.
 */

import { assertEquals } from 'https://deno.land/std@0.203.0/assert/mod.ts';
import { composeFullName, normalizeImportRow, sanitizeImportText } from '../import-rows.ts';

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

// The cell cleaner (`tests/importRowsParity.test.js` holds this copy to the browser's over a larger
// corpus; this file asks the Deno build the same questions). It strips a tag by scanning: a `<` to the
// first `>` after it, so a nested or split tag leaves no tag, and a lone bracket is data and stays.
const hasTagSpan = (text: string): boolean => {
  const open = text.indexOf('<');
  return open !== -1 && text.indexOf('>', open) !== -1;
};

Deno.test('an ordinary cell is unchanged and a tag goes with its brackets', () => {
  assertEquals(sanitizeImportText('U10 Hawks'), 'U10 Hawks');
  assertEquals(sanitizeImportText("O'Brien & Sons, 5:00 PM"), "O'Brien & Sons, 5:00 PM");
  assertEquals(sanitizeImportText('<b>Hawks</b>'), 'Hawks');
  assertEquals(sanitizeImportText('U10 <a href="x">Hawks</a>'), 'U10 Hawks');
});

Deno.test('a nested or split tag leaves no tag, and a lone bracket is data', () => {
  assertEquals(sanitizeImportText('<<script>script>'), 'script>');
  assertEquals(sanitizeImportText('<scr<script>ipt>'), 'ipt>');
  assertEquals(sanitizeImportText('<x<y>>'), '>');
  assertEquals(sanitizeImportText('a > b'), 'a > b');
  assertEquals(sanitizeImportText('<1'), '<1');
  assertEquals(sanitizeImportText('x <script'), 'x <script');
});

Deno.test('control characters go, the cell is trimmed, then capped', () => {
  assertEquals(sanitizeImportText('a\u0007b\tc'), 'ab\tc');
  assertEquals(sanitizeImportText('  <i></i> Hawks '), 'Hawks');
  assertEquals(
    sanitizeImportText(`${'x'.repeat(498)}<b>${'y'.repeat(10)}`),
    `${'x'.repeat(498)}yy`
  );
  assertEquals(sanitizeImportText(null), '');
  assertEquals(sanitizeImportText('abcdef', 3), 'abc');
});

Deno.test(
  'every string over five symbols up to six long leaves no tag and is a fixed point',
  () => {
    const symbols = ['<', '>', 'a', ' ', '/'];
    let checked = 0;
    const walk = (prefix: string, remaining: number) => {
      const out = sanitizeImportText(prefix);
      assertEquals(hasTagSpan(out), false);
      assertEquals(sanitizeImportText(out), out);
      checked += 1;
      if (remaining === 0) return;
      for (const symbol of symbols) walk(prefix + symbol, remaining - 1);
    };
    walk('', 6);
    assertEquals(checked, 19531);
  }
);
