/**
 * The mock's games import (`frontend/src/lib/mockGameImport.js`) held to the database's (PR 5, task E3; migration
 * `20261121010000_game_import.sql`), by ONE world that reaches every outcome and the numbers the pgTAP file asserts
 * about the same world (LESSONS_LEARNED #77: a twin is held by a test that runs both over one input).
 *
 * The world is the one `supabase/tests/game_import_apply_rollback.sql` builds, written again here in JavaScript: one
 * organization, an active season, seven saved games (one Published, two hidden in an older run), six own teams, a
 * venue with two fields, and a 21-row file (new games, a conflicting pair, a TIME TBD game, six refused rows, one
 * skipped, games found by Game ID in the visible run and in a hidden one, a Published game whose row changed).
 *
 * **How the two are held together.** The expected numbers below are the pgTAP file's assertions, and a test reads that
 * file and requires every one of them to be there with the same value, so a number changed in one place and not the
 * other fails. The meta-assertions: the world reaches every outcome (a file that reached half of them would compare
 * half), and the comparison can fail (a planted wrong count is shown to be a mismatch). The PR 4 fixture (574 games)
 * is then run through the mock and held to core's own resolution of the same file.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  fieldDecisionKey,
  parseScheduleRows,
  proposeScheduleMapping,
  resolveScheduleRows,
  teamDecisionKey,
  toStagedGameRow,
} from '../packages/core/src/scheduleImport/index.js';
import { handleGameImportRpc } from '../frontend/src/lib/mockGameImport.js';
import { loadScheduleFixture, outsideDecisionsFor } from './helpers/scheduleFixtureLoad.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PGTAP = readFileSync(
  path.join(REPO, 'supabase/tests/game_import_apply_rollback.sql'),
  'utf8'
);

const ORG = 'org-a';
const SEASON = 'season-a';
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = U(9001);
const ctx = (overrides = {}) => ({ isOrgAdmin: () => true, currentUserId: ADMIN, ...overrides });
let counter = 1000;
const env = { newId: () => U(++counter), now: () => '2026-11-09T12:00:00.000Z' };
const rpc = (db, name, params, c = ctx()) => {
  const out = handleGameImportRpc(db, name, params, { ...c, ...env });
  if (out === null) throw new Error(`${name} is not a games import RPC`);
  return out;
};

const D1 = U(10);
const D2 = U(11);
const T = { lions: U(1), tigers: U(2), bears: U(3), wolves: U(4), hawks: U(5), eagles: U(6) };
const F1 = U(31);
const F2 = U(32);
const slot = (n, field, date, start, end, week) => ({
  id: U(40 + n),
  organization_id: ORG,
  field_id: field,
  division_id: null,
  slot_date: date,
  start_time: start,
  end_time: end,
  week_index: week,
  capacity: 1,
  start: `${date}T${start}:00-07:00`,
  end: `${date}T${end}:00-07:00`,
  created_at: '2026-04-01T00:00:00Z',
});
const game = (n, ref, home, away, s, run, division, published = false) => ({
  id: U(50 + n),
  organization_id: ORG,
  season_settings_id: SEASON,
  run_id: run,
  game_slot_id: s.id,
  slot_id: s.id,
  field_id: s.field_id,
  home_team_id: home,
  away_team_id: away,
  division,
  week_index: s.week_index,
  start: s.start,
  end: s.end,
  external_ref: ref,
  import_job_id: null,
  published,
  published_at: null,
  published_by: null,
  assignment_source: 'auto',
});

function world() {
  const slots = [
    slot(1, F1, '2026-05-16', '09:00', '10:00', 3),
    slot(2, F2, '2026-05-16', '09:00', '10:00', 3),
    slot(3, F1, '2026-05-23', '09:00', '10:00', 4),
    slot(4, F1, '2026-05-23', '10:00', '11:00', 4),
    slot(5, F1, '2026-05-16', '11:00', '12:00', 3),
    slot(6, F1, '2026-05-30', '09:00', '10:00', 5),
    slot(7, F2, '2026-05-30', '09:00', '10:00', 5),
  ];
  const [s1, s2, s3, s4, s5, s6, s7] = slots;
  const R0 = U(60);
  const R1 = U(61);
  return {
    season_settings: [{ id: SEASON, organization_id: ORG, status: 'active', name: 'Spring' }],
    divisions: [
      { id: D1, organization_id: ORG, season_settings_id: SEASON, name: 'Org A U10' },
      { id: D2, organization_id: ORG, season_settings_id: SEASON, name: 'Org A U12' },
    ],
    teams: [
      { id: U(99), organization_id: ORG, division_id: D1, name: 'A-Team' },
      ...Object.entries(T).map(([name, id]) => ({
        id,
        organization_id: ORG,
        division_id: id === T.hawks || id === T.eagles ? D2 : D1,
        name: name[0].toUpperCase() + name.slice(1),
      })),
    ],
    locations: [{ id: U(30), organization_id: ORG, name: 'Park One' }],
    fields: [
      { id: F1, organization_id: ORG, location_id: U(30), name: 'Field 1' },
      { id: F2, organization_id: ORG, location_id: U(30), name: 'Field 2' },
    ],
    game_slots: slots,
    scheduler_runs: [
      {
        id: R0,
        organization_id: ORG,
        season_id: SEASON,
        season_settings_id: SEASON,
        run_type: 'game',
        status: 'completed',
        completed_at: '2026-04-01T00:00:00Z',
        created_at: '2026-04-01T00:00:00Z',
      },
      {
        id: R1,
        organization_id: ORG,
        season_id: SEASON,
        season_settings_id: SEASON,
        run_type: 'game',
        status: 'completed',
        completed_at: '2026-04-02T00:00:00Z',
        created_at: '2026-04-02T00:00:00Z',
      },
      {
        id: U(62),
        organization_id: ORG,
        season_id: SEASON,
        season_settings_id: SEASON,
        run_type: 'team',
        status: 'completed',
        created_at: '2026-03-01T00:00:00Z',
        parameters: {},
        results: {
          teams: [
            { id: T.hawks, division: D2, division_id: D2, name: 'Hawks', players: [] },
            { id: T.eagles, division: D2, division_id: D2, name: 'Eagles', players: [] },
          ],
          team_players: [],
        },
      },
    ],
    game_assignments: [
      game(1, 'G-900', T.lions, T.bears, s1, R1, 'Org A U10', true),
      game(2, 'G-901', T.tigers, T.wolves, s2, R1, 'Org A U10'),
      game(3, 'G-902', T.bears, T.wolves, s3, R0, 'Org A U10'),
      game(7, 'G-903', T.lions, T.wolves, s4, R0, 'Org A U10'),
      game(4, null, T.hawks, T.eagles, s5, R1, 'Org A U12'),
      game(5, null, T.lions, T.wolves, s6, R1, 'Org A U10'),
      game(6, null, T.bears, T.tigers, s7, R1, 'Org A U10'),
    ],
    import_jobs: [],
    staging_import_rows: [],
    import_application_records: [],
    schedule_tbd: [],
    audit_log: [],
    team_players: [],
    players: [],
  };
}

let jobNo = 0;
function addJob(db, rows, mapping) {
  const id = `job-${++jobNo}`;
  db.import_jobs.push({
    id,
    organization_id: ORG,
    job_type: 'games',
    status: 'importing',
    season_settings_id: SEASON,
    warning_summary: {},
  });
  rows.forEach((row, i) =>
    db.staging_import_rows.push({
      id: `${id}-r${i}`,
      organization_id: ORG,
      import_job_id: id,
      import_type: 'games',
      ...row,
    })
  );
  expect(
    rpc(db, 'map_game_import_job', { p_import_job_id: id, p_mapping: mapping }).error
  ).toBeNull();
  return id;
}

/** The staging contract takes a full parsed row; these tests give it only the fields it reads. */
const toStaged = /** @type {(row: any) => any} */ (toStagedGameRow);
const stage = (
  n,
  status,
  gameId,
  division,
  venue,
  field,
  home,
  away,
  date,
  start,
  end,
  week,
  flags = []
) =>
  toStaged({
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
    venueLabel: venue,
    fieldLabel: field,
    divisionLabel: division,
    homeLabel: home,
    awayLabel: away,
    weekIndex: week,
    weekSource: 'file',
    flags: flags.map((code) => ({ code })),
  });
const bad = (n, code) =>
  toStaged({
    rowNumber: n,
    rowKey: `row-${n}`,
    status: 'refused',
    reason: code,
    message: 'planted',
    flags: [],
  });

const FILE = () => [
  stage(
    1,
    'ok',
    'G-100',
    'Org A U10',
    'Park One',
    'Field 1',
    'Lions',
    'Tigers',
    '2026-05-02',
    '09:00',
    '10:00',
    1,
    ['time-ambiguous']
  ),
  stage(
    2,
    'ok',
    'G-101',
    'Org A U10',
    'Park One',
    'Field 2',
    'Bears',
    'Wolves',
    '2026-05-02',
    '09:00',
    '10:00',
    1
  ),
  stage(
    3,
    'ok',
    null,
    'Org A U10',
    'Park One',
    'Field 1',
    'Lions',
    'Bears',
    '2026-05-09',
    '09:00',
    '10:00',
    2
  ),
  stage(
    4,
    'ok',
    'G-102',
    'Org A U10',
    'Park One',
    'Field 1',
    'Tigers',
    'Visiting Club A',
    '2026-05-09',
    '10:00',
    '11:00',
    2
  ),
  stage(
    5,
    'ok',
    'G-103',
    'Org A U12',
    'Park Two',
    'Field A',
    'Hawks',
    'New Shell FC',
    '2026-05-02',
    '09:00',
    '10:00',
    1
  ),
  stage(
    6,
    'ok',
    'G-104',
    'U14 Boys',
    'Park Two',
    'Field A',
    'Sharks',
    'Rays',
    '2026-05-02',
    '11:00',
    '12:00',
    1
  ),
  stage(
    7,
    'ok',
    'G-105',
    'Org A U10',
    'Park One',
    'Field 1',
    'Wolves',
    'Tigers',
    '2026-05-09',
    '09:00',
    '10:00',
    2
  ),
  stage(
    8,
    'ok',
    'G-106',
    'Org A U10',
    'Park One',
    'Field 2',
    'Lions',
    'Wolves',
    '2026-05-09',
    '09:30',
    '10:30',
    2
  ),
  stage(9, 'tbd', 'G-107', 'Org A U10', '', '', 'Bears', 'Tigers', '2026-05-09', null, null, 2),
  bad(10, 'bad-date'),
  stage(
    11,
    'ok',
    'G-108',
    'Org A U10',
    'Park One',
    'Field 1',
    'Mystery',
    'Lions',
    '2026-06-06',
    '09:00',
    '10:00',
    6
  ),
  stage(
    12,
    'ok',
    'G-109',
    'Org A U10',
    'Park One',
    'Field 1',
    'SkipMe',
    'Lions',
    '2026-06-06',
    '10:00',
    '11:00',
    6
  ),
  stage(
    13,
    'ok',
    'G-110',
    'Org A U10',
    'Park One',
    'Field 1',
    'Visiting Club A',
    'Visiting Club B',
    '2026-06-06',
    '11:00',
    '12:00',
    6
  ),
  stage(
    14,
    'ok',
    'G-111',
    'Org A U10',
    'Park One',
    'Field 1',
    'Lions',
    'LIONS ',
    '2026-06-13',
    '09:00',
    '10:00',
    7
  ),
  stage(
    15,
    'ok',
    null,
    'Org A U10',
    'Park One',
    'Field 2',
    'BEARS',
    'WOLVES',
    '2026-05-02',
    '09:00',
    '10:00',
    1
  ),
  stage(
    16,
    'ok',
    'G-900',
    'Org A U10',
    'Park One',
    'Field 1',
    'Lions',
    'Bears',
    '2026-05-16',
    '10:00',
    '11:00',
    3
  ),
  stage(
    17,
    'ok',
    'G-901',
    'Org A U10',
    'Park One',
    'Field 2',
    'Tigers',
    'Wolves',
    '2026-05-16',
    '11:00',
    '12:00',
    3
  ),
  stage(
    18,
    'ok',
    'G-902',
    'Org A U10',
    'Park One',
    'Field 1',
    'Bears',
    'Wolves',
    '2026-05-23',
    '09:00',
    '10:00',
    4
  ),
  stage(
    19,
    'ok',
    'G-903',
    'Org A U10',
    'Park One',
    'Field 1',
    'Lions',
    'Wolves',
    '2026-05-23',
    '11:00',
    '12:00',
    4
  ),
  stage(
    20,
    'ok',
    null,
    'Org A U10',
    'Park One',
    'Field 1',
    'Lions',
    'Wolves',
    '2026-05-30',
    '09:00',
    '10:00',
    5
  ),
  stage(
    21,
    'ok',
    'G-NEW1',
    'Org A U10',
    'Park One',
    'Field 2',
    'Bears',
    'Tigers',
    '2026-05-30',
    '09:00',
    '10:00',
    5
  ),
];
const MAPPING = () => ({
  options: { arrive_published: true },
  divisions: {
    'org a u10': { action: 'map', id: D1 },
    'org a u12': { action: 'map', id: D2 },
    'u14 boys': { action: 'create', name: 'U14 Boys' },
  },
  venues: {
    'park one': { action: 'map', id: U(30) },
    'park two': { action: 'create', name: 'Park Two' },
  },
  fields: {
    [fieldDecisionKey('Park One', 'Field 1')]: { action: 'map', id: F1 },
    [fieldDecisionKey('Park One', 'Field 2')]: { action: 'map', id: F2 },
    [fieldDecisionKey('Park Two', 'Field A')]: { action: 'create', name: 'Field A' },
  },
  teams: {
    [teamDecisionKey('Org A U10', 'Lions')]: { action: 'map', id: T.lions },
    [teamDecisionKey('Org A U10', 'Tigers')]: { action: 'map', id: T.tigers },
    [teamDecisionKey('Org A U10', 'Bears')]: { action: 'map', id: T.bears },
    [teamDecisionKey('Org A U10', 'Wolves')]: { action: 'map', id: T.wolves },
    [teamDecisionKey('Org A U10', 'Visiting Club A')]: { action: 'outside' },
    [teamDecisionKey('Org A U10', 'Visiting Club B')]: { action: 'outside' },
    [teamDecisionKey('Org A U10', 'SkipMe')]: { action: 'skip' },
    [teamDecisionKey('Org A U12', 'Hawks')]: { action: 'map', id: T.hawks },
    [teamDecisionKey('Org A U12', 'New Shell FC')]: { action: 'create', name: 'New Shell FC' },
    [teamDecisionKey('U14 Boys', 'Sharks')]: { action: 'create', name: 'Sharks' },
    [teamDecisionKey('U14 Boys', 'Rays')]: { action: 'create', name: 'Rays' },
  },
});

/** The numbers the pgTAP file asserts for the first apply, by the path they sit at in the result. */
const APPLY_NUMBERS = {
  'rows,staged': '21',
  'games,inserted': '8',
  'games,updated': '2',
  'games,unchanged': '2',
  'games,repointed': '5',
  'games,skipped,skipped-published': '1',
  'time_tbd,inserted': '1',
  'rows,refused': '6',
  'rows,skipped': '1',
  'reused,slots': '2',
  'not_in_file,count': '2',
};
const REIMPORT_NUMBERS = {
  'games,inserted': '0',
  'games,updated': '0',
  'games,repointed': '0',
  'games,unchanged': '12',
  'games,skipped,skipped-published': '1',
  'time_tbd,unchanged': '1',
};
const at = (result, pathText) => pathText.split(',').reduce((o, k) => o?.[k], result);
const CREATED = { divisions: 1, venues: 1, fields: 1, teams: 3, outside_teams: 1, slots: 9 };
const REFUSED = { 'bad-date': 1, 'same-team': 1, 'unknown-team': 2, 'duplicate-row': 2 };
const WARNINGS = ['field-overlap', 'team-double-booked', 'team-double-booked', 'time-ambiguous'];

describe('the mock applies the world as the database does', () => {
  const db = world();
  const jobId = addJob(db, FILE(), MAPPING());
  const before = Object.fromEntries(
    Object.entries(db).map(([table, rows]) => [table, JSON.stringify(rows)])
  );
  const dry = rpc(db, 'apply_game_import_job', { p_import_job_id: jobId, p_dry_run: true });
  const afterDry = Object.fromEntries(
    Object.entries(db).map(([table, rows]) => [table, JSON.stringify(rows)])
  );

  it('a dry run writes nothing', () => {
    expect(dry.error).toBeNull();
    for (const table of Object.keys(before)) expect(afterDry[table], table).toBe(before[table]);
    expect(dry.data.dry_run).toBe(true);
    expect(dry.data.ids.run_id).toBeNull();
  });

  const applied = rpc(db, 'apply_game_import_job', { p_import_job_id: jobId, p_dry_run: false });
  const strip = (result) => {
    const rest = { ...result };
    for (const key of ['dry_run', 'ids', 'replayed']) delete rest[key];
    return rest;
  };

  it('the apply equals the dry run in every count, list and warning', () => {
    expect(applied.error).toBeNull();
    expect(strip(applied.data)).toEqual(strip(dry.data));
  });

  it("its numbers are the pgTAP file's, which the file asserts", () => {
    for (const [pathText, value] of Object.entries(APPLY_NUMBERS)) {
      expect(String(at(applied.data, pathText)), pathText).toBe(value);
      // The same assertion is in the pgTAP file: the path and the value, on the apply's result.
      expect(PGTAP, pathText).toContain(`name = 'apply'), '${pathText}'), '${value}'`);
    }
    expect(applied.data.created).toEqual(CREATED);
    expect(applied.data.refused_by_reason).toEqual(REFUSED);
    expect(applied.data.warnings.map((w) => w.type).sort()).toEqual(WARNINGS);
    expect(applied.data.not_judged).toEqual(['coach-conflict', 'home-away-imbalance']);
    expect(applied.data.nothing_to_apply).toBe(false);
    for (const literal of [
      `'{"divisions": 1, "venues": 1, "fields": 1, "teams": 3, "outside_teams": 1, "slots": 9}'::jsonb`,
      `'{"bad-date": 1, "same-team": 1, "unknown-team": 2, "duplicate-row": 2}'::jsonb`,
      `'["field-overlap", "team-double-booked", "team-double-booked", "time-ambiguous"]'::jsonb`,
    ]) {
      expect(PGTAP).toContain(literal);
    }
  });

  it('the saved schedule is what the pgTAP file reads back', () => {
    const games = db.game_assignments;
    expect(games).toHaveLength(15);
    expect(games.every((g) => g.run_id === applied.data.ids.run_id)).toBe(true);
    expect(games.every((g) => g.season_settings_id === SEASON)).toBe(true);
    // In place, by id, and a hidden row found by its Game ID.
    const e2 = games.find((g) => g.id === U(52));
    expect(e2.start).toBe('2026-05-16T11:00:00-07:00');
    expect(games.filter((g) => g.external_ref === 'G-901')).toHaveLength(1);
    expect(games.find((g) => g.id === U(57)).start).toBe('2026-05-23T11:00:00-07:00');
    // A Published game is not changed; a row with a Game ID never matched a tuple.
    expect(games.find((g) => g.id === U(51)).start).toBe('2026-05-16T09:00:00-07:00');
    expect(
      games.filter(
        (g) => g.home_team_id === T.bears && g.away_team_id === T.tigers && g.week_index === 5
      )
    ).toHaveLength(1);
    expect(games.filter((g) => g.external_ref === 'G-NEW1')).toHaveLength(0);
    expect(games.filter((g) => g.import_job_id === jobId && g.published)).toHaveLength(8);
    expect(db.game_slots).toHaveLength(16);
    expect(db.teams.filter((t) => t.is_external)).toHaveLength(1);
    // Shells in team runs, carrying the division's earlier teams; the outside club in none.
    const teamRuns = db.scheduler_runs.filter(
      (r) => r.run_type === 'team' && r.parameters?.import_job_id === jobId
    );
    expect(teamRuns).toHaveLength(2);
    const d2 = teamRuns.find((r) => r.parameters.selectedProgramId === D2);
    expect(d2.results.teams.map((t) => t.name).sort()).toEqual(['Eagles', 'Hawks', 'New Shell FC']);
    expect(JSON.stringify(db.scheduler_runs)).not.toContain('Visiting Club A');
    expect(db.schedule_tbd).toHaveLength(1);
    // One application record per thing written.
    const counts = {};
    for (const r of db.import_application_records)
      counts[`${r.target_table}:${r.operation}`] =
        (counts[`${r.target_table}:${r.operation}`] ?? 0) + 1;
    expect(counts).toEqual({
      'divisions:inserted': 1,
      'locations:inserted': 1,
      'fields:inserted': 1,
      'teams:inserted': 4,
      'game_slots:inserted': 9,
      'game_assignments:inserted': 8,
      'game_assignments:updated': 7,
      'schedule_tbd:inserted': 1,
    });
  });

  it('a finished job answers with its stored result', () => {
    const again = rpc(db, 'apply_game_import_job', { p_import_job_id: jobId, p_dry_run: false });
    expect(again.data.replayed).toBe(true);
    expect(db.game_assignments).toHaveLength(15);
  });

  it('re-importing the same file inserts nothing and makes no run', () => {
    const runs = db.scheduler_runs.length;
    const rows = FILE().filter((r) =>
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 16, 17, 18, 19, 20].includes(r.source_row_number)
    );
    const find = (name) => db.teams.find((t) => t.name === name).id;
    const m = /** @type {any} */ (MAPPING());
    m.divisions['u14 boys'] = {
      action: 'map',
      id: db.divisions.find((d) => d.name === 'U14 Boys').id,
    };
    m.venues['park two'] = {
      action: 'map',
      id: db.locations.find((l) => l.name === 'Park Two').id,
    };
    m.fields[fieldDecisionKey('Park Two', 'Field A')] = {
      action: 'map',
      id: db.fields.find((f) => f.name === 'Field A').id,
    };
    for (const name of ['New Shell FC', 'Sharks', 'Rays']) {
      const key = Object.keys(m.teams).find((x) => x.endsWith(`"${name.toLowerCase()}"]`));
      m.teams[key] = { action: 'map', id: find(name) };
    }
    const second = addJob(db, rows, m);
    const out = rpc(db, 'apply_game_import_job', { p_import_job_id: second, p_dry_run: false });
    expect(out.error).toBeNull();
    for (const [pathText, value] of Object.entries(REIMPORT_NUMBERS)) {
      expect(String(at(out.data, pathText)), pathText).toBe(value);
      expect(PGTAP, pathText).toContain(`name = 'reimport'), '${pathText}'), '${value}'`);
    }
    expect(out.data.nothing_to_apply).toBe(true);
    expect(out.data.ids.run_id).toBeNull();
    expect(db.scheduler_runs).toHaveLength(runs);
    expect(db.teams.filter((t) => t.is_external)).toHaveLength(1);
    expect(db.game_assignments).toHaveLength(15);
    expect(db.import_jobs.find((j) => j.id === second).status).toBe('completed');
  });

  it('the world reaches every outcome the counts name (a file that reached half would compare half)', () => {
    const d = applied.data;
    for (const n of [
      d.games.inserted,
      d.games.updated,
      d.games.unchanged,
      d.games.repointed,
      d.games.skipped['skipped-published'],
      d.time_tbd.inserted,
      d.rows.refused,
      d.rows.skipped,
      d.created.outside_teams,
      d.created.teams,
      d.not_in_file.count,
    ]) {
      expect(n).toBeGreaterThan(0);
    }
  });

  it('CONTROL: a wrong number is a mismatch (the comparison can fail)', () => {
    const wrong = {
      ...applied.data,
      games: { ...applied.data.games, inserted: applied.data.games.inserted + 1 },
    };
    expect(strip(wrong)).not.toEqual(strip(dry.data));
    expect(PGTAP).not.toContain(`name = 'apply'), 'games,inserted'), '9'`);
  });
});

describe('the mock refuses as the database does', () => {
  it("a caller with no user, another organization's admin, an unknown job, another type", () => {
    const db = world();
    const id = addJob(db, FILE(), MAPPING());
    expect(
      rpc(
        db,
        'apply_game_import_job',
        { p_import_job_id: id, p_dry_run: true },
        ctx({ currentUserId: null })
      ).error.code
    ).toBe('42501');
    expect(
      rpc(
        db,
        'apply_game_import_job',
        { p_import_job_id: id, p_dry_run: true },
        ctx({ isOrgAdmin: () => false })
      ).error.code
    ).toBe('42501');
    expect(
      rpc(db, 'rollback_game_import_job', { p_import_job_id: id }, ctx({ isOrgAdmin: () => false }))
        .error.code
    ).toBe('42501');
    expect(rpc(db, 'apply_game_import_job', { p_import_job_id: 'nope' }).error.code).toBe('P0002');
    db.import_jobs.push({
      id: 'reg',
      organization_id: ORG,
      job_type: 'registration',
      status: 'importing',
      season_settings_id: SEASON,
    });
    expect(rpc(db, 'apply_game_import_job', { p_import_job_id: 'reg' }).error.code).toBe('22023');
    expect(
      rpc(db, 'apply_game_import_job', { p_import_job_id: id, p_dry_run: true }).error
    ).toBeNull();
  });

  it("a completed season, a job with no mapping, and a mapping that names another organization's record", () => {
    const db = world();
    const id = addJob(db, FILE(), MAPPING());
    db.season_settings[0].status = 'completed';
    expect(
      rpc(db, 'apply_game_import_job', { p_import_job_id: id, p_dry_run: true }).error.details
    ).toBe('season_completed');
    db.season_settings[0].status = 'active';
    db.import_jobs.push({
      id: 'nomap',
      organization_id: ORG,
      job_type: 'games',
      status: 'importing',
      season_settings_id: SEASON,
      warning_summary: {},
    });
    db.staging_import_rows.push({
      id: 'x',
      organization_id: ORG,
      import_job_id: 'nomap',
      import_type: 'games',
      ...FILE()[0],
    });
    expect(
      rpc(db, 'apply_game_import_job', { p_import_job_id: 'nomap', p_dry_run: true }).error.details
    ).toBe('mapping_required');
    const bogus = rpc(db, 'map_game_import_job', {
      p_import_job_id: 'nomap',
      p_mapping: { divisions: { x: { action: 'map', id: U(777) } } },
    });
    expect(bogus.error.code).toBe('22023');
    expect(
      rpc(db, 'map_game_import_job', {
        p_import_job_id: 'nomap',
        p_mapping: { divisions: { x: { action: 'explode' } } },
      }).error.code
    ).toBe('22023');
  });

  it('ensure_game_slot creates once and finds after, auditing only the creation', () => {
    const db = world();
    const call = () =>
      rpc(db, 'ensure_game_slot', {
        p_organization_id: ORG,
        p_field_id: F2,
        p_slot_date: '2026-06-20',
        p_start_time: '08:00',
        p_end_time: '09:00',
        p_week_index: 8,
      });
    expect(call().data.created).toBe(true);
    expect(call().data.created).toBe(false);
    expect(db.game_slots.filter((s) => s.slot_date === '2026-06-20')).toHaveLength(1);
    expect(db.audit_log.filter((a) => a.action === 'game.slot_created')).toHaveLength(1);
  });
});

describe('the rollback refuses after a change and restores exactly before one', () => {
  it('a game with changes allowed refuses it, naming the game; then it restores the schedule', () => {
    const db = world();
    const original = JSON.stringify(db.game_assignments.map((g) => ({ ...g })));
    const id = addJob(db, FILE(), MAPPING());
    const ok = rpc(db, 'apply_game_import_job', { p_import_job_id: id, p_dry_run: false });
    expect(ok.error).toBeNull();
    const imported = db.game_assignments.find((g) => g.external_ref === 'G-102');
    imported.published = false;
    const refused = rpc(db, 'rollback_game_import_job', { p_import_job_id: id });
    expect(refused.error.code).toBe('22023');
    expect(refused.error.details).toMatch(
      new RegExp(`^game_import_changed count=1 ids=${imported.id}$`)
    );
    expect(db.import_application_records.every((r) => !r.rolled_back_at)).toBe(true);
    imported.published = true;
    const back = rpc(db, 'rollback_game_import_job', { p_import_job_id: id });
    expect(back.error).toBeNull();
    expect(back.data.games).toEqual({ deleted: 8, restored: 7 });
    expect(
      JSON.stringify(db.game_assignments.map((g) => ({ ...g, updated_at: undefined }))).replaceAll(
        ',"updated_at":null',
        ''
      )
    ).toBe(
      JSON.stringify(JSON.parse(original).map((g) => ({ ...g, updated_at: undefined }))).replaceAll(
        ',"updated_at":null',
        ''
      )
    );
    expect(db.teams.filter((t) => t.is_external)).toHaveLength(0);
    expect(db.divisions.map((d) => d.name).sort()).toEqual(['Org A U10', 'Org A U12']);
    expect(db.game_slots).toHaveLength(7);
    expect(db.scheduler_runs.filter((r) => r.parameters?.import_job_id === id)).toHaveLength(0);
    expect(db.import_jobs.find((j) => j.id === id).status).toBe('needs_fix');
    expect(rpc(db, 'rollback_game_import_job', { p_import_job_id: id }).error.code).toBe('22023');
    expect(rpc(db, 'apply_game_import_job', { p_import_job_id: id }).error.code).toBe('22023');
  });
});

describe("the PR 4 fixture through the mock equals core's own resolution of it", () => {
  const fixture = loadScheduleFixture();
  const parsed = parseScheduleRows({
    headers: fixture.schedule.headers,
    rows: fixture.schedule.rows,
    season: fixture.season,
  });
  const rows = [...parsed.rows];
  // The fixture's ids are made-up text (`team:U05B Team 01`); the database's are uuids, so the league is given some.
  const uuids = new Map();
  const uid = (id) => {
    if (!uuids.has(id)) uuids.set(id, U(5000 + uuids.size));
    return uuids.get(id);
  };
  const league = {
    divisions: fixture.league.divisions.map((d) => ({ ...d, id: uid(d.id) })),
    teams: fixture.league.teams.map((t) => ({
      ...t,
      id: uid(t.id),
      divisionId: uid(t.divisionId),
      coachIds: [],
    })),
    venues: fixture.league.venues.map((v) => ({ ...v, id: uid(v.id) })),
    fields: fixture.league.fields.map((f) => ({ ...f, id: uid(f.id), venueId: uid(f.venueId) })),
  };
  const proposal = proposeScheduleMapping({ rows, league });
  const decisions = outsideDecisionsFor(proposal);
  const resolved = resolveScheduleRows({ rows, league, decisions });

  it('seeds the league, stages the file, maps, previews and applies: every placed row is a game', () => {
    /** @type {any} */
    const db = {
      season_settings: [{ id: SEASON, organization_id: ORG, status: 'active' }],
      divisions: league.divisions.map((d) => ({
        id: d.id,
        organization_id: ORG,
        season_settings_id: SEASON,
        name: d.name,
      })),
      teams: league.teams.map((t) => ({
        id: t.id,
        organization_id: ORG,
        division_id: t.divisionId,
        name: t.name,
      })),
      locations: league.venues.map((v) => ({ id: v.id, organization_id: ORG, name: v.name })),
      fields: league.fields.map((f) => ({
        id: f.id,
        organization_id: ORG,
        location_id: f.venueId,
        name: f.name,
      })),
      game_slots: [],
      scheduler_runs: [],
      game_assignments: [],
      import_jobs: [],
      staging_import_rows: [],
      import_application_records: [],
      schedule_tbd: [],
      audit_log: [],
    };
    // Every label that matches exactly one record maps on its own (core's proposal), made effective for the SQL.
    const effective = {
      options: { arrive_published: true },
      divisions: {},
      venues: {},
      fields: {},
      teams: {},
    };
    for (const group of ['divisions', 'venues', 'fields', 'teams']) {
      for (const entry of proposal[group]) {
        const d = decisions[group]?.[entry.key] ?? entry.effective;
        if (d) effective[group][entry.key] = d;
      }
    }
    const id = addJob(db, parsed.rows.map(toStagedGameRow), effective);
    const out = rpc(db, 'apply_game_import_job', { p_import_job_id: id, p_dry_run: false });
    expect(out.error).toBeNull();
    expect(out.data.rows.staged).toBe(parsed.rows.length);
    expect(out.data.games.inserted + out.data.time_tbd.inserted).toBe(
      resolved.counts.ok + resolved.counts.tbd
    );
    expect(out.data.rows.skipped).toBe(resolved.counts.skipped);
    expect(out.data.games.inserted).toBeGreaterThan(500);
    expect(db.teams.filter((t) => t.is_external).length).toBeGreaterThan(20);
  });
});
