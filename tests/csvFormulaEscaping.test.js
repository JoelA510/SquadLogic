import assert from 'node:assert/strict';
import { test } from 'vitest';
import { escapeCsvCell, neutraliseFormula } from '../packages/core/src/csv.js';
import { formatCsv, generateScheduleExports } from '../packages/core/src/outputGeneration.js';

// DS-4: a cell a spreadsheet would run as a formula is written as text.

test('every formula lead character is neutralised, and quoting still applies after it', () => {
  assert.equal(escapeCsvCell('=1+1'), "'=1+1");
  assert.equal(escapeCsvCell('+SUM(A1:A9)'), "'+SUM(A1:A9)");
  assert.equal(escapeCsvCell('-2+cmd|calc'), "'-2+cmd|calc");
  assert.equal(escapeCsvCell('@SUM(1)'), "'@SUM(1)");
  assert.equal(escapeCsvCell('\t=1+1'), "'\t=1+1");
  // Leading spaces do not hide a formula (the July audit's fix approach).
  assert.equal(escapeCsvCell('  =1+1'), "'  =1+1");
  // Nor does a mix of whitespace before the lead (Codex, #609): a space then a tab or CR.
  assert.equal(escapeCsvCell(' \t=1+1'), "' \t=1+1");
  assert.equal(escapeCsvCell(' \r=1+1'), '"\' \r=1+1"');
  assert.equal(escapeCsvCell(' \n@SUM(1)'), '"\' \n@SUM(1)"');
  // A leading CR also forces RFC 4180 quoting, after the prefix.
  assert.equal(escapeCsvCell('\r=1+1'), '"\'\r=1+1"');
  // The payload that carries a comma and a quote is prefixed, then quoted.
  assert.equal(escapeCsvCell('=HYPERLINK("http://x","go")'), '"\'=HYPERLINK(""http://x"",""go"")"');
});

test('ordinary text, empty cells and a formula character that is not first are untouched', () => {
  assert.equal(escapeCsvCell('Blue Bears'), 'Blue Bears');
  assert.equal(escapeCsvCell('U8-T01'), 'U8-T01');
  assert.equal(escapeCsvCell('a=b'), 'a=b');
  assert.equal(escapeCsvCell('x =1'), 'x =1');
  assert.equal(escapeCsvCell(''), '');
  assert.equal(escapeCsvCell(null), '');
  assert.equal(escapeCsvCell(undefined), '');
  assert.equal(escapeCsvCell('2026-10-19T09:00:00Z'), '2026-10-19T09:00:00Z');
});

test('legitimate negative and signed numbers are not corrupted', () => {
  assert.equal(escapeCsvCell(-5), '-5');
  assert.equal(escapeCsvCell(-0.25), '-0.25');
  assert.equal(escapeCsvCell('-5'), '-5');
  assert.equal(escapeCsvCell(' -5'), ' -5');
  assert.equal(escapeCsvCell('-0.25'), '-0.25');
  assert.equal(escapeCsvCell('+15551234567'), '+15551234567');
  // Not a plain number: an operator, a second sign, a unit or a bare sign.
  for (const text of [
    '-5+3',
    '--5',
    '-5 ',
    '- 5',
    '-',
    '+',
    '-1e3',
    '-5%',
    '+1 (555) 123',
    '\t-5',
    '\r+5',
  ]) {
    assert.equal(neutraliseFormula(text), `'${text}`, text);
  }
});

test('formatCsv neutralises header and data cells', () => {
  const csv = formatCsv(['=Header', 'Name'], [{ '=Header': 'ok', Name: '=cmd|calc' }]);
  assert.equal(csv, "'=Header,Name\nok,'=cmd|calc");
});

test('the schedule exports neutralise a team, coach and opponent that start with a formula', () => {
  const exports = generateScheduleExports({
    teams: [
      {
        id: 'U8-T01',
        name: '=HYPERLINK("http://example.invalid")',
        division: 'U8',
        coachName: '@SUM(1)',
        coachEmail: 'coach@example.invalid',
      },
    ],
    practiceAssignments: [
      {
        teamId: 'U8-T01',
        start: '2024-08-05T22:00:00Z',
        end: '2024-08-05T23:00:00Z',
        fieldId: '+Field',
        notes: '-1+1',
      },
    ],
  });
  for (const csv of [exports.master.csv, exports.perTeam[0].csv]) {
    for (const line of csv.split('\n').slice(1)) {
      assert.doesNotMatch(line, /(^|,)"?[=+@-]/, `a cell starts with a formula character: ${line}`);
    }
    assert.match(csv, /'=HYPERLINK/);
    assert.match(csv, /'@SUM\(1\)/);
  }
});
