import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCsv, generateScheduleExports } from '../src/outputGeneration.js';

test('generateScheduleExports builds master and per-team exports', () => {
  const teams = [
    { id: 'U8-T01', name: 'Blue Bears', division: 'U8', coachName: 'Alex Coach', coachEmail: 'alex@example.com' },
    { id: 'U8-T02', name: 'Red Rockets', division: 'U8', coachName: 'Riley Coach', coachEmail: 'riley@example.com' },
  ];

  const practiceAssignments = [
    {
      teamId: 'U8-T01',
      start: '2024-08-05T22:00:00Z',
      end: '2024-08-05T23:00:00Z',
      fieldId: 'Field-1',
      slotId: 'practice-slot-1',
      notes: 'Half-field with cones',
    },
  ];

  const gameAssignments = [
    {
      homeTeamId: 'U8-T01',
      awayTeamId: 'U8-T02',
      start: '2024-08-10T15:00:00Z',
      end: '2024-08-10T16:00:00Z',
      fieldId: 'Field-A',
      slotId: 'game-slot-1',
      notes: 'Opening day showdown',
    },
  ];

  const exports = generateScheduleExports({ teams, practiceAssignments, gameAssignments });

  assert.equal(exports.master.headers.length, 13);
  assert.equal(exports.master.rows.length, 3, 'one practice plus two game entries');
  assert.equal(exports.perTeam.length, 2, 'two teams represented');

  const [firstMasterRow] = exports.master.rows;
  assert.equal(firstMasterRow['Event Type'], 'Practice');
  assert.equal(firstMasterRow['Team ID'], 'U8-T01');
  assert.equal(firstMasterRow.Field, 'Field-1');
  assert.equal(firstMasterRow.Slot, 'practice-slot-1');
  assert.equal(firstMasterRow.Notes, 'Half-field with cones');

  const homeGameRow = exports.master.rows.find((row) => row.Role === 'Home');
  assert(homeGameRow, 'home game row present');
  assert.equal(homeGameRow.Opponent, 'Red Rockets');
  assert.equal(homeGameRow['Team Name'], 'Blue Bears');
  assert.equal(homeGameRow.Field, 'Field-A');

  const redTeamExport = exports.perTeam.find((entry) => entry.teamId === 'U8-T02');
  assert(redTeamExport, 'red team export exists');
  assert.equal(redTeamExport.rows.length, 1, 'red team only has the game event');
  assert.equal(redTeamExport.rows[0].Role, 'Away');
});

test('formatCsv quotes values containing commas and quotes', () => {
  const headers = ['Column A', 'Column B'];
  const rows = [
    { 'Column A': 'Simple', 'Column B': 'Needs, quoting' },
    { 'Column A': 'He said "Hello"', 'Column B': 'Line\nBreak' },
  ];

  const csv = formatCsv(headers, rows);
  const lines = csv.split('\n');

  assert.equal(lines[0], 'Column A,Column B');
  assert.equal(lines[1], 'Simple,"Needs, quoting"');
  assert.equal(lines.slice(2).join('\n'), '"He said ""Hello""","Line\nBreak"');
});

test('formatCsv quotes values containing carriage returns', () => {
  const headers = ['Column'];
  const rows = [{ Column: 'Return\rCheck' }];

  const csv = formatCsv(headers, rows);

  assert.equal(csv, 'Column\n"Return\rCheck"');
});

test('generateScheduleExports throws for unknown teams', () => {
  const teams = [{ id: 'U8-T01' }];
  const practiceAssignments = [
    { teamId: 'U8-T99', start: '2024-08-05T22:00:00Z', end: '2024-08-05T23:00:00Z' },
  ];

  assert.throws(() => {
    generateScheduleExports({ teams, practiceAssignments });
  }, /unknown team U8-T99/);
});
