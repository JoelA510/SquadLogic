import assert from 'node:assert/strict';
import { test } from 'vitest';
import { formatCsv, generateScheduleExports } from '../packages/core/src/outputGeneration.js';

test('generateScheduleExports builds master and per-team exports', () => {
  const teams = [
    {
      id: 'U8-T01',
      name: 'Blue Bears',
      division: 'U8',
      coachName: 'Alex Coach',
      coachEmail: 'alex@example.com',
    },
    {
      id: 'U8-T02',
      name: 'Red Rockets',
      division: 'U8',
      coachName: 'Riley Coach',
      coachEmail: 'riley@example.com',
    },
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

  // 8.2 replaced `Coach Name` / `Coach Email` / `Assistant Coaches` with one
  // `Coaches` column and one `Coach Emails` column, so the header count drops
  // by one and no column asserts which coach is the head.
  assert.equal(exports.master.headers.length, 13);
  assert.ok(!exports.master.headers.includes('Assistant Coaches'));
  assert.ok(exports.master.headers.includes('Coaches'));
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

test('generateScheduleExports handles empty inputs', () => {
  const exports = generateScheduleExports({ teams: [] });
  assert.equal(exports.master.rows.length, 0);
  assert.equal(exports.perTeam.length, 0);
});

test('generateScheduleExports throws on invalid date', () => {
  const teams = [{ id: 'T1' }];
  const practiceAssignments = [
    { teamId: 'T1', start: 'invalid-date', end: '2024-08-05T23:00:00Z' },
  ];

  assert.throws(() => {
    generateScheduleExports({ teams, practiceAssignments });
  }, /invalid date/);
});

test('generateScheduleExports throws on missing required fields', () => {
  const teams = [{ id: 'T1' }];
  const practiceAssignments = [
    { teamId: 'T1', start: '2024-08-05T22:00:00Z' }, // Missing end
  ];

  assert.throws(() => {
    generateScheduleExports({ teams, practiceAssignments });
  }, /practice assignments require start and end/);
});

test('generateScheduleExports localizes dates when timezone is provided', () => {
  const teams = [{ id: 'T1', assistantCoaches: ['Coach A', 'Coach B'] }];
  const practiceAssignments = [
    { teamId: 'T1', start: '2024-08-05T22:00:00Z', end: '2024-08-05T23:00:00Z' },
  ];
  // 10:00 PM UTC = 6:00 PM EDT (America/New_York)

  const exports = generateScheduleExports({
    teams,
    practiceAssignments,
    timezone: 'America/New_York',
  });

  const row = exports.master.rows[0];
  // Both coaches, in the order the legacy shape declared them, and nothing
  // saying either is the head: the team row named no `coachName`, so position 1
  // is vacant and the two named coaches keep positions 2 and 3.
  assert.equal(row.Coaches, 'Coach A; Coach B');
  assert.match(row.Start, /6:00:00 PM/);
  assert.match(row.End, /7:00:00 PM/);
});

// ---------------------------------------------------------------------------
// TIME TBD rows (Phase D, E): a practice a team is short of and a game that could not be placed
// are rows of the master export, not silences.
// ---------------------------------------------------------------------------

const TBD_TEAMS = [
  {
    id: 'T1',
    name: 'Blue Bears',
    division: 'U8',
    coachName: 'Alex Coach',
    coachEmail: 'alex@example.com',
  },
  { id: 'T2', name: 'Red Rockets', division: 'U8' },
];

test('a practice item with missingCount 2 gives two TIME TBD rows for that team', () => {
  const exports = generateScheduleExports({
    teams: TBD_TEAMS,
    tbdItems: [{ kind: 'practice', teamId: 'T1', missingCount: 2, reason: 'no-slot-available' }],
  });
  assert.equal(exports.master.rows.length, 2);
  for (const row of exports.master.rows) {
    assert.equal(row['Team ID'], 'T1');
    assert.equal(row['Event Type'], 'Practice');
    assert.equal(row.Start, 'TIME TBD');
    assert.equal(row.End, '');
    assert.equal(row.Field, 'LOCATION TBD');
    assert.equal(row.Slot, '');
    assert.equal(row.Opponent, '');
    assert.equal(row.Role, '');
    assert.equal(row.Coaches, 'Alex Coach');
  }
  assert.match(exports.master.rows[0].Notes, /1 of 2 missing.*no slot was free for it/);
  assert.match(exports.master.rows[1].Notes, /2 of 2 missing/);
  assert.equal(exports.perTeam.length, 1, 'the team has a file of its own');
  assert.equal(exports.perTeam[0].rows.length, 2);
  assert.match(exports.master.csv, /TIME TBD,,LOCATION TBD/);
});

test('a practice item missing one practice has no "1 of 1" in its note', () => {
  const { master } = generateScheduleExports({
    teams: TBD_TEAMS,
    tbdItems: [{ kind: 'practice', teamId: 'T2', missingCount: 1, reason: 'not-scheduled-yet' }],
  });
  assert.equal(master.rows.length, 1);
  assert.equal(master.rows[0].Notes, 'Practice not scheduled: no schedule has placed it yet.');
});

test('a game item gives a home row and an away row, with the sides it was given', () => {
  const exports = generateScheduleExports({
    teams: TBD_TEAMS,
    tbdItems: [
      {
        kind: 'game',
        homeTeamId: 'T2',
        awayTeamId: 'T1',
        weekIndex: 4,
        reason: 'coach-scheduling-conflict',
      },
    ],
  });
  assert.equal(exports.master.rows.length, 2);
  const home = exports.master.rows.find((row) => row.Role === 'Home');
  const away = exports.master.rows.find((row) => row.Role === 'Away');
  assert.equal(home['Team ID'], 'T2');
  assert.equal(home.Opponent, 'Blue Bears');
  assert.equal(away['Team ID'], 'T1');
  assert.equal(away.Opponent, 'Red Rockets');
  for (const row of [home, away]) {
    assert.equal(row['Event Type'], 'Game');
    assert.equal(row.Start, 'TIME TBD');
    assert.equal(row.End, '');
    assert.equal(row.Field, 'LOCATION TBD');
    assert.match(row.Notes, /week 4.*coach/);
  }
  assert.equal(exports.perTeam.length, 2);
});

test("TIME TBD rows sort after the team's dated rows, and the dated rows are untouched", () => {
  const dated = {
    teamId: 'T1',
    start: '2026-09-07T22:00:00Z',
    end: '2026-09-07T23:00:00Z',
    fieldId: 'F1',
    slotId: 'S1',
  };
  const without = generateScheduleExports({ teams: TBD_TEAMS, practiceAssignments: [dated] });
  const withTbd = generateScheduleExports({
    teams: TBD_TEAMS,
    practiceAssignments: [dated],
    tbdItems: [{ kind: 'practice', teamId: 'T1', missingCount: 1, reason: 'no-live-date' }],
  });
  assert.equal(withTbd.master.rows.length, 2);
  assert.deepEqual(withTbd.master.rows[0], without.master.rows[0]);
  assert.equal(withTbd.master.rows[1].Start, 'TIME TBD');
  assert.deepEqual(
    withTbd.perTeam[0].rows.map((row) => row.Start),
    ['2026-09-07T22:00:00.000Z', 'TIME TBD']
  );
});

test('no tbdItems changes nothing: the export is byte-identical to the one before', () => {
  const args = {
    teams: TBD_TEAMS,
    practiceAssignments: [
      { teamId: 'T1', start: '2026-09-07T22:00:00Z', end: '2026-09-07T23:00:00Z', fieldId: 'F1' },
    ],
  };
  assert.equal(
    generateScheduleExports({ ...args, tbdItems: [] }).master.csv,
    generateScheduleExports(args).master.csv
  );
});

test('a TIME TBD item that cannot be written is an error, never a row left out', () => {
  assert.throws(
    () =>
      generateScheduleExports({
        teams: TBD_TEAMS,
        tbdItems: [
          { kind: 'practice', teamId: 'nobody', missingCount: 1, reason: 'no-slot-available' },
        ],
      }),
    /unknown team nobody/
  );
  assert.throws(
    () =>
      generateScheduleExports({
        teams: TBD_TEAMS,
        tbdItems: [
          {
            kind: 'game',
            homeTeamId: 'T1',
            awayTeamId: 'nobody',
            weekIndex: 1,
            reason: 'no-slot-available',
          },
        ],
      }),
    /unknown team nobody/
  );
  for (const bad of [
    { kind: 'practice', teamId: 'T1', missingCount: 0, reason: 'no-slot-available' },
    { kind: 'practice', teamId: 'T1', missingCount: 1, reason: 'because' },
    { kind: 'practice', teamId: 'T1', missingCount: 1, reason: 'unknown-team' },
    { kind: 'game', homeTeamId: 'T1', awayTeamId: 'T2', weekIndex: 0, reason: 'no-slot-available' },
    { kind: 'meal', teamId: 'T1' },
    null,
  ]) {
    assert.throws(
      () => generateScheduleExports({ teams: TBD_TEAMS, tbdItems: [bad] }),
      /is not a TIME TBD item/,
      JSON.stringify(bad)
    );
  }
  assert.throws(
    () => generateScheduleExports({ teams: TBD_TEAMS, tbdItems: /** @type {any} */ ('x') }),
    /tbdItems must be an array/
  );
});
