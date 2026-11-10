/**
 * The mock held to the database for fix round 4 of the games import (PR 5; Codex's findings on e699b1f).
 *
 * `supabase/tests/game_import_round4.sql` builds one league and runs three files through the preview and the apply; this
 * file builds the same league in JavaScript, runs the same files through the mock and asserts the same numbers, each of
 * which must be in the pgTAP file with the same value (lesson 77).
 *
 *   F1  a Game ID a matched record already carries is never erased by a row that omits it;
 *   F2  two rows of one file that resolve to ONE saved record: the row that carries the Game ID is kept, the other is
 *       refused `duplicate-row` in words that say so, and the preview's result is the apply's.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  divisionDecisionKey,
  fieldDecisionKey,
  teamDecisionKey,
  toStagedGameRow,
  venueDecisionKey,
} from '../packages/core/src/scheduleImport/index.js';
import {
  DUPLICATE_TARGET_MESSAGE,
  handleGameImportRpc,
} from '../frontend/src/lib/mockGameImport.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PGTAP = readFileSync(path.join(REPO, 'supabase/tests/game_import_round4.sql'), 'utf8');
const MIGRATION = readFileSync(
  path.join(REPO, 'supabase/migrations/20261121010000_game_import.sql'),
  'utf8'
);
/** A number asserted here must be asserted, the same, by the pgTAP file. */
const inPgtap = (text) => expect(PGTAP).toContain(text);

const ORG = 'org-a';
const SEASON = 'season-a';
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let counter = 9000;
const env = { newId: () => U(++counter), now: () => '2026-11-10T12:00:00.000Z' };
const rpc = (db, name, params) =>
  handleGameImportRpc(db, name, params, { isOrgAdmin: () => true, currentUserId: U(9001), ...env });

const DIV = U(1);
const T = [null, ...[11, 12, 13, 14, 15, 16].map(U)];
const FIELD = U(21);
const hour = (start, add) => `${String(Number(start.slice(0, 2)) + add).padStart(2, '0')}:00`;
const slot = (id, date, start, week) => ({
  id,
  organization_id: ORG,
  field_id: FIELD,
  division_id: null,
  slot_date: date,
  start_time: start,
  end_time: hour(start, 1),
  week_index: week,
  capacity: 1,
  start: `${date}T${start}:00-07:00`,
  end: `${date}T${hour(start, 1)}:00-07:00`,
  created_at: '2026-04-01T00:00:00Z',
});
const game = (id, slotRow, home, away, week, ref) => ({
  id,
  organization_id: ORG,
  season_settings_id: SEASON,
  run_id: U(40),
  game_slot_id: slotRow.id,
  slot_id: slotRow.id,
  field_id: FIELD,
  home_team_id: home,
  away_team_id: away,
  division: 'FD',
  week_index: week,
  start: slotRow.start,
  end: slotRow.end,
  external_ref: ref,
  import_job_id: null,
  published: false,
  assignment_source: 'auto',
});
const tbdRow = (id, home, away, week, ref, date) => ({
  id,
  organization_id: ORG,
  season_settings_id: SEASON,
  kind: 'game',
  division_id: DIV,
  home_team_id: home,
  away_team_id: away,
  week_index: week,
  reason: 'imported-without-time',
  detail: {},
  run_id: U(40),
  external_ref: ref,
  game_date: date,
  created_at: '2026-04-01T00:00:00Z',
});
const S = [
  slot(U(30), '2027-05-01', '09:00', 1),
  slot(U(31), '2027-06-05', '09:00', 5),
  slot(U(32), '2027-06-26', '09:00', 8),
];

/** @returns {Record<string, Array<any>>} */
function world(games, tbd) {
  return {
    season_settings: [{ id: SEASON, organization_id: ORG, status: 'active', name: 'Spring' }],
    divisions: [{ id: DIV, organization_id: ORG, season_settings_id: SEASON, name: 'FD' }],
    teams: [1, 2, 3, 4, 5, 6].map((n) => ({
      id: T[n],
      organization_id: ORG,
      division_id: DIV,
      name: `F${n}`,
    })),
    locations: [{ id: U(20), organization_id: ORG, name: 'Four Park' }],
    fields: [{ id: FIELD, organization_id: ORG, location_id: U(20), name: 'Four 1' }],
    game_slots: structuredClone(S),
    scheduler_runs: [
      {
        id: U(40),
        organization_id: ORG,
        season_id: SEASON,
        season_settings_id: SEASON,
        run_type: 'game',
        status: 'completed',
        completed_at: '2026-04-03T00:00:00Z',
        created_at: '2026-04-03T00:00:00Z',
      },
    ],
    game_assignments: games,
    schedule_tbd: tbd,
    import_jobs: [],
    staging_import_rows: [],
    import_application_records: [],
    audit_log: [],
    team_players: [],
    players: [],
  };
}
const row = (n, status, gameId, home, away, date, start, end, week) =>
  toStagedGameRow(
    /** @type {any} */ ({
      rowNumber: n,
      rowKey: `row-${n}`,
      gameId,
      status,
      reason: null,
      message: null,
      tbdReason: status === 'tbd' ? 'imported-without-time' : null,
      date,
      startTime: start,
      endTime: end,
      start: start ? `${date}T${start}:00-07:00` : null,
      end: end ? `${date}T${end}:00-07:00` : null,
      venueLabel: status === 'tbd' ? '' : 'Four Park',
      fieldLabel: status === 'tbd' ? '' : 'Four 1',
      divisionLabel: 'FD',
      homeLabel: home,
      awayLabel: away,
      weekIndex: week,
      weekSource: 'file',
      flags: [],
    })
  );
const mapping = () => ({
  options: { arrive_published: false },
  divisions: { [divisionDecisionKey('FD')]: { action: 'map', id: DIV } },
  venues: { [venueDecisionKey('Four Park')]: { action: 'map', id: U(20) } },
  fields: { [fieldDecisionKey('Four Park', 'Four 1')]: { action: 'map', id: FIELD } },
  teams: Object.fromEntries(
    [1, 2, 3, 4, 5, 6].map((n) => [teamDecisionKey('FD', `F${n}`), { action: 'map', id: T[n] }])
  ),
});
let jobNo = 0;
/** Stage and map a file, preview it and apply it. */
function run(db, rows) {
  const id = `job4-${++jobNo}`;
  db.import_jobs.push({
    id,
    organization_id: ORG,
    job_type: 'games',
    status: 'importing',
    season_settings_id: SEASON,
    warning_summary: {},
  });
  rows.forEach((r, i) =>
    db.staging_import_rows.push({
      id: `${id}-r${i}`,
      organization_id: ORG,
      import_job_id: id,
      import_type: 'games',
      ...r,
    })
  );
  expect(
    rpc(db, 'map_game_import_job', { p_import_job_id: id, p_mapping: mapping() }).error
  ).toBeNull();
  const dry = rpc(db, 'apply_game_import_job', { p_import_job_id: id, p_dry_run: true });
  const out = rpc(db, 'apply_game_import_job', { p_import_job_id: id });
  return { id, dry, out };
}
const strip = (result) => ({ ...result, dry_run: undefined, ids: undefined });

describe('F1: a Game ID a matched record carries is never erased by a row that omits it', () => {
  const db = world(
    [game(U(50), S[0], T[3], T[4], 1, 'F-P')],
    [
      tbdRow(U(60), T[1], T[2], 3, 'G-1', '2027-05-15'),
      tbdRow(U(61), T[5], T[6], 4, 'F-T', '2027-05-22'),
    ]
  );
  const first = run(db, [
    row(1, 'ok', null, 'F1', 'F2', '2027-05-15', '09:00', '10:00', 3),
    row(2, 'ok', null, 'F1', 'F2', '2027-05-15', '11:00', '12:00', 3),
    row(3, 'ok', null, 'F3', 'F4', '2027-05-01', '09:00', '10:30', 1),
    row(4, 'tbd', null, 'F5', 'F6', '2027-05-29', null, null, 4),
  ]);
  const pair = () =>
    db.game_assignments
      .filter((g) => g.home_team_id === T[1] && g.away_team_id === T[2] && g.week_index === 3)
      .sort((a, b) => String(a.start).localeCompare(String(b.start)));
  it('counts what the pgTAP file counts, and the preview is the apply', () => {
    expect(first.out.error).toBeNull();
    const d = first.out.data;
    expect(
      [d.games.inserted, d.games.updated, d.time_tbd.removed, d.time_tbd.updated].join(' ')
    ).toBe('2 1 1 1');
    inPgtap("'2 1 1 1', 'F1.0");
    expect(strip(first.dry.data)).toEqual(strip(d));
  });
  it('the TIME TBD game a blank row places keeps its Game ID; the second game of the pair has none', () => {
    expect(
      pair()
        .map((g) => g.external_ref ?? 'NULL')
        .join(',')
    ).toBe('G-1,NULL');
    inPgtap("'G-1,NULL', 'F1.1");
  });
  it('a placed game and a TIME TBD game found by a blank row keep their Game IDs', () => {
    expect(db.game_assignments.find((g) => g.id === U(50)).external_ref).toBe('F-P');
    expect(db.schedule_tbd.find((s) => s.id === U(61))).toMatchObject({
      external_ref: 'F-T',
      game_date: '2027-05-29',
    });
    inPgtap("'F-T 2027-05-29'");
  });
  it('a later row carrying the Game ID finds that game: nothing inserted, one updated', () => {
    const later = run(db, [row(1, 'ok', 'G-1', 'F1', 'F2', '2027-05-15', '13:00', '14:00', 3)]);
    expect(later.out.error).toBeNull();
    expect(
      [
        later.out.data.games.inserted,
        later.out.data.games.updated,
        pair().length,
        db.game_assignments.filter((g) => g.external_ref === 'G-1').length,
      ].join(' ')
    ).toBe('0 1 2 1');
    inPgtap("'0 1 2 1', 'F1.5");
    expect(strip(later.dry.data)).toEqual(strip(later.out.data));
  });
});

describe('F2: two rows that resolve to one saved record', () => {
  const db = world(
    [game(U(51), S[1], T[1], T[3], 5, 'D-1'), game(U(52), S[2], T[5], T[6], 8, 'D-Y')],
    [tbdRow(U(62), T[2], T[4], 6, 'D-T', '2027-06-12')]
  );
  const { dry, out } = run(db, [
    row(1, 'ok', null, 'F1', 'F3', '2027-06-05', '09:00', '10:30', 5),
    row(2, 'ok', 'D-1', 'F1', 'F3', '2027-06-05', '11:00', '12:00', 5),
    row(3, 'tbd', null, 'F2', 'F4', '2027-06-13', null, null, 6),
    row(4, 'tbd', 'D-T', 'F2', 'F4', '2027-06-20', null, null, 7),
    row(5, 'ok', null, 'F5', 'F6', '2027-06-26', '09:00', '10:30', 8),
    row(6, 'tbd', 'D-Y', 'F5', 'F6', '2027-06-26', null, null, 8),
  ]);
  it('the preview refuses the three rows, and the apply goes through with the same result', () => {
    expect(dry.error).toBeNull();
    expect(dry.data.refused_by_reason).toEqual({ 'duplicate-row': 3 });
    expect(out.error).toBeNull();
    expect(
      [
        JSON.stringify(out.data.refused_by_reason).replace(':', ': '),
        out.data.games.updated,
        out.data.time_tbd.updated,
        out.data.time_tbd.converted,
      ].join(' ')
    ).toBe('{"duplicate-row": 3} 1 1 1');
    inPgtap(`'{"duplicate-row": 3} 1 1 1', 'F2.2`);
    expect(strip(dry.data)).toEqual(strip(out.data));
  });
  it('the row found by its Game ID is kept; the other is refused in words that say two rows name one saved game', () => {
    const refused = out.data.listed.refused.filter((r) => r.message === DUPLICATE_TARGET_MESSAGE);
    expect(refused.map((r) => r.row_number).join(',')).toBe('1,3,5');
    inPgtap("'1,3,5',");
    expect(DUPLICATE_TARGET_MESSAGE).toContain('names the same saved game');
    // The SQL says it in the same words (twice: a placed row and a TIME TBD row).
    expect(MIGRATION.split(DUPLICATE_TARGET_MESSAGE.replace(/'/g, "''")).length - 1).toBe(2);
  });
  it('each saved record is as the row that carries its Game ID says', () => {
    expect(new Date(db.game_assignments.find((g) => g.id === U(51)).start).toISOString()).toBe(
      '2027-06-05T18:00:00.000Z'
    );
    expect(db.schedule_tbd.find((s) => s.id === U(62))).toMatchObject({
      week_index: 7,
      game_date: '2027-06-20',
    });
    expect(db.game_assignments.some((g) => g.id === U(52))).toBe(false);
    expect(db.schedule_tbd.filter((s) => s.external_ref === 'D-Y')).toHaveLength(1);
    inPgtap("'11:00 7 2027-06-20 0 1'");
  });
});
