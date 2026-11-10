/**
 * The games import rollback judges EVERY record it undoes against what stands now: the class test, run through the mock
 * (PR 5, fix round 3). The database half is `supabase/tests/game_import_rollback_class.sql`; this is its twin, held to it
 * by what both read and by the scenario table they share (lesson 77: a twin is held by a test that runs both over one
 * input).
 *
 * Codex found the second rollback-safety defect of this PR in 305137b: the pre-check compared only PLACED games, so a
 * TIME TBD game an import inserted was deleted by its rollback even after a later import had corrected it (the first was
 * a permit scope on a field the import made). So the subject set here is derived, never listed:
 *
 *   1. the (table, operation) pairs the apply can write are read out of the MIGRATION's source and out of the MOCK's
 *      source and must be the same set; ONE real apply through the mock must write every one of them and nothing else;
 *   2. every pair must have a scenario in tests/fixtures/rollbackClassScenarios.json, and every scenario must name a pair
 *      the apply can write; the table must equal the one in the pgTAP file;
 *   3. for every scenario a later writer changes the record, and the rollback must either REFUSE (22023
 *      `game_import_changed`, naming the record) or KEEP it and say so in `kept`, as the scenario says, and what the
 *      later writer did must still be there afterwards.
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
import { handleGameImportRpc } from '../frontend/src/lib/mockGameImport.js';
import { readCurrentSavedGameIds } from '../frontend/src/utils/gamePublishedClient.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(REPO, file), 'utf8');
const MIGRATION = read('supabase/migrations/20261121010000_game_import.sql');
const MOCK = read('frontend/src/lib/mockGameImport.js');
const PGTAP = read('supabase/tests/game_import_rollback_class.sql');
const SCENARIOS = JSON.parse(read('tests/fixtures/rollbackClassScenarios.json')).scenarios;

const ORG = 'org-a';
const SEASON = 'season-a';
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let counter = 9000;
const env = { newId: () => U(++counter), now: () => '2026-11-09T12:00:00.000Z' };
const rpc = (db, name, params) => {
  const out = handleGameImportRpc(db, name, params, {
    isOrgAdmin: () => true,
    currentUserId: U(9001),
    ...env,
  });
  if (out === null) throw new Error(`${name} is not a games import RPC`);
  return out;
};

// ------------------------------------------------------------------------------------------------ the league
const DIV = U(1);
const T = [null, ...[11, 12, 13, 14, 15, 16].map(U)];
const FIELD = U(21);
const slot = (id, date, start, week) => ({
  id,
  organization_id: ORG,
  field_id: FIELD,
  division_id: null,
  slot_date: date,
  start_time: start,
  end_time: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00`,
  week_index: week,
  capacity: 1,
  start: `${date}T${start}:00-07:00`,
  end: `${date}T${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00:00-07:00`,
  created_at: '2026-04-01T00:00:00Z',
});
const game = (id, slotRow, home, away, week, ref) => ({
  id,
  organization_id: ORG,
  season_settings_id: SEASON,
  run_id: U(40),
  game_slot_id: slotRow.id,
  slot_id: slotRow.id,
  field_id: slotRow.field_id,
  home_team_id: home,
  away_team_id: away,
  division: 'QD',
  week_index: week,
  start: slotRow.start,
  end: slotRow.end,
  external_ref: ref,
  import_job_id: null,
  published: false,
  published_at: null,
  published_by: null,
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

/**
 * The league of the pgTAP file's section Q, as the mock holds it: every kind of record the apply can write is in play.
 * @returns {Record<string, Array<any>>}
 */
function world() {
  const s1 = slot(U(30), '2027-05-01', '09:00', 1);
  const s2 = slot(U(31), '2027-05-01', '10:00', 1);
  return {
    season_settings: [{ id: SEASON, organization_id: ORG, status: 'active', name: 'Spring' }],
    divisions: [{ id: DIV, organization_id: ORG, season_settings_id: SEASON, name: 'QD' }],
    teams: [1, 2, 3, 4, 5, 6].map((n) => ({
      id: T[n],
      organization_id: ORG,
      division_id: DIV,
      name: `Q${n}`,
    })),
    locations: [{ id: U(20), organization_id: ORG, name: 'Class Park' }],
    fields: [{ id: FIELD, organization_id: ORG, location_id: U(20), name: 'Class 1' }],
    game_slots: [s1, s2],
    scheduler_runs: [
      ...[
        [40, '2026-04-03T00:00:00Z'],
        [41, '2026-03-03T00:00:00Z'],
      ].map(([n, at]) => ({
        id: U(n),
        organization_id: ORG,
        season_id: SEASON,
        season_settings_id: SEASON,
        run_type: 'game',
        status: 'completed',
        completed_at: at,
        created_at: at,
      })),
    ],
    game_assignments: [
      game(U(50), s1, T[1], T[2], 1, 'Q-PL-1'),
      game(U(51), s2, T[3], T[4], 1, 'Q-PL-2'),
    ],
    schedule_tbd: [
      tbdRow(U(60), T[5], T[6], 2, 'Q-TB-1', '2027-05-08'),
      tbdRow(U(61), T[2], T[4], 6, 'Q-TB-2', '2027-06-12'),
    ],
    import_jobs: [],
    staging_import_rows: [],
    import_application_records: [],
    audit_log: [],
    team_players: [],
    players: [],
    field_blackouts: [],
    facility_permit_scopes: [],
    field_subunits: [],
    evaluation_runs: [],
  };
}

const row = (n, p) =>
  toStagedGameRow(
    /** @type {any} */ ({
      rowNumber: n,
      rowKey: `row-${n}`,
      gameId: p.gameId,
      status: p.status,
      reason: null,
      message: null,
      tbdReason: p.status === 'tbd' ? 'imported-without-time' : null,
      date: p.date,
      startTime: p.start ?? null,
      endTime: p.end ?? null,
      start: p.start ? `${p.date}T${p.start}:00-07:00` : null,
      end: p.end ? `${p.date}T${p.end}:00-07:00` : null,
      venueLabel: p.venue ?? '',
      fieldLabel: p.field ?? '',
      divisionLabel: p.division,
      homeLabel: p.home,
      awayLabel: p.away,
      weekIndex: p.week,
      weekSource: 'file',
      flags: [],
    })
  );

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
    rpc(db, 'map_game_import_job', { p_import_job_id: id, p_mapping: mapping }).error
  ).toBeNull();
  return id;
}

// The file of the pgTAP file's job `jq`: every pair is written by it.
const fileQ = () => [
  row(1, {
    status: 'tbd',
    gameId: 'Q-TB-1',
    division: 'QD',
    home: 'Q5',
    away: 'Q6',
    date: '2027-05-22',
    week: 4,
  }),
  row(2, {
    status: 'tbd',
    gameId: 'Q-PL-1',
    division: 'QD',
    home: 'Q1',
    away: 'Q2',
    date: '2027-05-01',
    week: 1,
  }),
  row(3, {
    status: 'ok',
    gameId: 'Q-TB-2',
    division: 'QD',
    venue: 'New Park',
    field: 'New 1',
    home: 'Q2',
    away: 'Q4',
    date: '2027-06-12',
    start: '09:00',
    end: '10:00',
    week: 6,
  }),
  row(4, {
    status: 'ok',
    gameId: 'Q-NEW-2',
    division: 'QNEW',
    venue: 'New Park',
    field: 'New 1',
    home: 'Shell A',
    away: 'Outside FC',
    date: '2027-06-12',
    start: '10:00',
    end: '11:00',
    week: 6,
  }),
  row(5, {
    status: 'tbd',
    gameId: 'Q-NEW-1',
    division: 'QD',
    home: 'Q2',
    away: 'Q3',
    date: '2027-05-29',
    week: 5,
  }),
  row(6, {
    status: 'ok',
    gameId: 'Q-NEW-3',
    division: 'QNEW',
    venue: 'New Park',
    field: 'New 1',
    home: 'Shell B',
    away: 'Outside FC',
    date: '2027-06-12',
    start: '11:00',
    end: '12:00',
    week: 6,
  }),
];
const mappingQ = () => ({
  options: { arrive_published: false },
  divisions: {
    [divisionDecisionKey('QD')]: { action: 'map', id: DIV },
    [divisionDecisionKey('QNEW')]: { action: 'create', name: 'QNEW' },
  },
  venues: {
    [venueDecisionKey('Class Park')]: { action: 'map', id: U(20) },
    [venueDecisionKey('New Park')]: { action: 'create', name: 'New Park' },
  },
  fields: {
    [fieldDecisionKey('Class Park', 'Class 1')]: { action: 'map', id: FIELD },
    [fieldDecisionKey('New Park', 'New 1')]: { action: 'create', name: 'New 1' },
  },
  teams: {
    ...Object.fromEntries(
      [1, 2, 3, 4, 5, 6].map((n) => [teamDecisionKey('QD', `Q${n}`), { action: 'map', id: T[n] }])
    ),
    [teamDecisionKey('QNEW', 'Shell A')]: { action: 'create', name: 'Shell A' },
    [teamDecisionKey('QNEW', 'Shell B')]: { action: 'create', name: 'Shell B' },
    [teamDecisionKey('QNEW', 'Outside FC')]: { action: 'outside' },
  },
});

/** The schedule's own tables as one text, without the instant a row was last written. */
const fingerprint = (db) =>
  JSON.stringify(
    [
      'game_assignments',
      'game_slots',
      'teams',
      'divisions',
      'locations',
      'fields',
      'schedule_tbd',
      'scheduler_runs',
      'field_blackouts',
    ].map((t) =>
      [...(db[t] || [])]
        .map((r) => ({ ...r, updated_at: undefined }))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    )
  );

// ------------------------------------------------------------------------------------- the pairs, read from the sources
/** The pairs the migration's apply writes into the application records, read out of the text of its inserts. */
const migrationPairs = () => {
  const start = MIGRATION.indexOf('CREATE FUNCTION public.apply_game_import_job');
  const end = MIGRATION.indexOf('CREATE FUNCTION public.rollback_game_import_job');
  const apply = MIGRATION.slice(start, end);
  const re =
    /INSERT INTO public\.import_application_records[^;]*?SELECT v_org, p_import_job_id, 'games', '([a-z_]+)', [a-z_]+\.id, '(inserted|updated|deleted)'/g;
  return [...new Set([...apply.matchAll(re)].map((m) => `${m[1]}:${m[2]}`))].sort();
};
/** The pairs the mock's apply writes, read out of its `record(table, id, operation, ...)` calls. */
const mockPairs = () => {
  const start = MOCK.indexOf('function applyJob');
  const end = MOCK.indexOf('function rollbackJob');
  const apply = MOCK.slice(start, end);
  const re = /\brecord\(\s*'([a-z_]+)',\s*[^,]+,\s*'(inserted|updated|deleted)'/g;
  return [...new Set([...apply.matchAll(re)].map((m) => `${m[1]}:${m[2]}`))].sort();
};

describe('the pairs the apply can write are read from the sources, never listed', () => {
  it('reads real pairs out of the migration (a scan of nothing would pass)', () => {
    expect(migrationPairs().length).toBeGreaterThanOrEqual(11);
  });
  it('the mock writes exactly the pairs the migration writes', () => {
    expect(mockPairs()).toEqual(migrationPairs());
  });
  it('the scan can fail: a pair added to the migration text is not in the mock', () => {
    const planted = `${MIGRATION}`.replace(
      "'games', 'divisions', dv.id, 'inserted'",
      "'games', 'fields', dv.id, 'updated'"
    );
    expect(planted).not.toBe(MIGRATION);
    const start = planted.indexOf('CREATE FUNCTION public.apply_game_import_job');
    const re =
      /INSERT INTO public\.import_application_records[^;]*?SELECT v_org, p_import_job_id, 'games', '([a-z_]+)', [a-z_]+\.id, '(inserted|updated|deleted)'/g;
    const pairs = new Set([...planted.slice(start).matchAll(re)].map((m) => `${m[1]}:${m[2]}`));
    expect(pairs.has('fields:updated')).toBe(true);
    expect(mockPairs()).not.toContain('fields:updated');
  });
});

describe('the scenario table is the one the pgTAP file runs', () => {
  it('the pgTAP file declares the same scenarios, in the same order, with the same expectations', () => {
    const declared = [
      ...PGTAP.matchAll(
        /^\s*\((\d+),\s+'([a-z_]+)',\s+'([a-z]+)',\s+'([a-z-]+)',\s+'(keep|refuse)'/gm
      ),
    ].map((m) => ({
      ord: Number(m[1]),
      table: m[2],
      operation: m[3],
      name: m[4],
      expect: m[5],
    }));
    expect(declared.length).toBeGreaterThanOrEqual(23);
    expect(declared).toEqual(SCENARIOS);
  });
  it('every pair the apply can write has a scenario, and every scenario names such a pair or an unrecorded table', () => {
    const pairs = migrationPairs();
    const covered = new Set(SCENARIOS.map((s) => `${s.table}:${s.operation}`));
    expect(pairs.filter((p) => !covered.has(p))).toEqual([]);
    expect(
      SCENARIOS.filter(
        (s) => s.operation !== 'unrecorded' && !pairs.includes(`${s.table}:${s.operation}`)
      )
    ).toEqual([]);
  });
});

// -------------------------------------------------------------------------- the later writer, in JavaScript
const idsOf = (db, table, operation) =>
  db.import_application_records
    .filter((r) => r.target_table === table && r.operation === operation)
    .map((r) => r.target_id);
const rowsIn = (db, table, ids) => (db[table] || []).filter((r) => ids.includes(r.id));
const nextDay = (d) => new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10);
let later = 0;

/** Per scenario: what the later writer does, and a check that it is still there after the rollback. */
const WRITERS = {
  'divisions:inserted/edit': {
    mutate: (db, t) => rowsIn(db, 'divisions', t).forEach((r) => (r.name += ' renamed')),
    witness: (db, t) =>
      rowsIn(db, 'divisions', t).length === t.length &&
      rowsIn(db, 'divisions', t).every((r) => r.name.endsWith(' renamed')),
  },
  'divisions:inserted/attach': {
    mutate: (db, t) =>
      t.forEach((id) =>
        db.teams.push({
          id: U(7000 + ++later),
          organization_id: ORG,
          division_id: id,
          name: 'later team',
        })
      ),
    witness: (db, t) =>
      rowsIn(db, 'divisions', t).length === t.length &&
      db.teams.filter((x) => x.name === 'later team' && t.includes(x.division_id)).length ===
        t.length,
  },
  'locations:inserted/edit': {
    mutate: (db, t) => rowsIn(db, 'locations', t).forEach((r) => (r.address = 'Edited Way 1')),
    witness: (db, t) =>
      rowsIn(db, 'locations', t).length === t.length &&
      rowsIn(db, 'locations', t).every((r) => r.address === 'Edited Way 1'),
  },
  'locations:inserted/attach': {
    mutate: (db, t) =>
      t.forEach((id) =>
        db.fields.push({
          id: U(7000 + ++later),
          organization_id: ORG,
          location_id: id,
          name: 'later field',
        })
      ),
    witness: (db, t) =>
      rowsIn(db, 'locations', t).length === t.length &&
      db.fields.filter((f) => f.name === 'later field' && t.includes(f.location_id)).length ===
        t.length,
  },
  'fields:inserted/edit': {
    mutate: (db, t) => rowsIn(db, 'fields', t).forEach((r) => (r.name += ' renamed')),
    witness: (db, t) =>
      rowsIn(db, 'fields', t).length === t.length &&
      rowsIn(db, 'fields', t).every((r) => r.name.endsWith(' renamed')),
  },
  'fields:inserted/attach': {
    mutate: (db, t) =>
      t.forEach((id) =>
        db.field_blackouts.push({
          id: U(7000 + ++later),
          organization_id: ORG,
          field_id: id,
          blackout_from: '2027-07-04',
          blackout_until: '2027-07-04',
        })
      ),
    witness: (db, t) =>
      rowsIn(db, 'fields', t).length === t.length &&
      db.field_blackouts.filter((b) => t.includes(b.field_id)).length === t.length,
  },
  'teams:inserted/edit': {
    mutate: (db, t) => rowsIn(db, 'teams', t).forEach((r) => (r.notes = 'edited later')),
    witness: (db, t) =>
      rowsIn(db, 'teams', t).length === t.length &&
      rowsIn(db, 'teams', t).every((r) => r.notes === 'edited later'),
  },
  'teams:inserted/attach': {
    mutate: (db, t) =>
      db.scheduler_runs.push({
        id: U(7000 + ++later),
        organization_id: ORG,
        run_type: 'team',
        status: 'completed',
        parameters: {},
        results: { teams: t.map((id) => ({ id })) },
        completed_at: '2027-01-01T00:00:00Z',
      }),
    witness: (db, t) => rowsIn(db, 'teams', t).length === t.length,
  },
  'game_slots:inserted/edit': {
    mutate: (db, t) => rowsIn(db, 'game_slots', t).forEach((r) => (r.capacity = 2)),
    witness: (db, t) =>
      rowsIn(db, 'game_slots', t).length === t.length &&
      rowsIn(db, 'game_slots', t).every((r) => r.capacity === 2),
  },
  'game_slots:inserted/attach': {
    mutate: (db, t) =>
      rowsIn(db, 'game_slots', t).forEach((gs) =>
        db.game_assignments.push({
          ...game(U(7000 + ++later), gs, T[1], T[3], 9, null),
          division: 'QD',
        })
      ),
    witness: (db, t) =>
      rowsIn(db, 'game_slots', t).length === t.length &&
      db.game_assignments.filter((g) => g.week_index === 9 && t.includes(g.game_slot_id)).length ===
        t.length,
  },
  'game_assignments:inserted/edit': {
    mutate: (db, t) => rowsIn(db, 'game_assignments', t).forEach((r) => (r.division += ' x')),
    witness: (db, t) =>
      rowsIn(db, 'game_assignments', t).length === t.length &&
      rowsIn(db, 'game_assignments', t).every((r) => r.division.endsWith(' x')),
  },
  'game_assignments:inserted/remove': {
    mutate: (db, t) => {
      db.game_assignments = db.game_assignments.filter((g) => !t.includes(g.id));
    },
    witness: (db, t) => rowsIn(db, 'game_assignments', t).length === 0,
  },
  'game_assignments:updated/edit': {
    mutate: (db, t) => rowsIn(db, 'game_assignments', t).forEach((r) => (r.division += ' x')),
    witness: (db, t) =>
      rowsIn(db, 'game_assignments', t).length === t.length &&
      rowsIn(db, 'game_assignments', t).every((r) => r.division.endsWith(' x')),
  },
  'game_assignments:updated/remove': {
    mutate: (db, t) => {
      db.game_assignments = db.game_assignments.filter((g) => !t.includes(g.id));
    },
    witness: (db, t) => rowsIn(db, 'game_assignments', t).length === 0,
  },
  'game_assignments:updated/later-run': {
    mutate: (db, t) => rowsIn(db, 'game_assignments', t).forEach((r) => (r.run_id = U(41))),
    witness: (db, t) =>
      rowsIn(db, 'game_assignments', t).length === t.length &&
      rowsIn(db, 'game_assignments', t).every((r) => r.run_id === U(41)),
  },
  'game_assignments:deleted/stands-again': {
    mutate: (db) =>
      db.import_application_records
        .filter((r) => r.target_table === 'game_assignments' && r.operation === 'deleted')
        .forEach((r) => db.game_assignments.push({ ...r.previous_payload })),
    witness: (db, t) => rowsIn(db, 'game_assignments', t).length === t.length,
  },
  'schedule_tbd:inserted/edit': {
    mutate: (db, t) =>
      rowsIn(db, 'schedule_tbd', t).forEach((r) => (r.game_date = nextDay(r.game_date))),
    witness: (db, t) => tbdMovedOneDay(db, 'inserted', t),
  },
  'schedule_tbd:inserted/remove': {
    mutate: (db, t) => {
      db.schedule_tbd = db.schedule_tbd.filter((s) => !t.includes(s.id));
    },
    witness: (db, t) => rowsIn(db, 'schedule_tbd', t).length === 0,
  },
  'schedule_tbd:updated/edit': {
    mutate: (db, t) =>
      rowsIn(db, 'schedule_tbd', t).forEach((r) => (r.game_date = nextDay(r.game_date))),
    witness: (db, t) => tbdMovedOneDay(db, 'updated', t),
  },
  'schedule_tbd:updated/remove': {
    mutate: (db, t) => {
      db.schedule_tbd = db.schedule_tbd.filter((s) => !t.includes(s.id));
    },
    witness: (db, t) => rowsIn(db, 'schedule_tbd', t).length === 0,
  },
  'schedule_tbd:deleted/stands-again': {
    mutate: (db) =>
      db.import_application_records
        .filter((r) => r.target_table === 'schedule_tbd' && r.operation === 'deleted')
        .forEach((r) => db.schedule_tbd.push({ ...r.previous_payload })),
    witness: (db, t) => rowsIn(db, 'schedule_tbd', t).length === t.length,
  },
  'scheduler_runs:unrecorded/game-saved-into-the-run': {
    mutate: (db, t) =>
      t.forEach((id) =>
        db.game_assignments.push({
          ...game(U(7000 + ++later), slot(U(7900), '2027-07-01', '09:00', 8), T[2], T[4], 8, null),
          run_id: id,
          game_slot_id: null,
          slot_id: null,
          field_id: FIELD,
        })
      ),
    witness: (db, t) =>
      db.game_assignments.some((g) => g.week_index === 8 && t.includes(g.run_id)) && t.length === 1,
  },
  'scheduler_runs:unrecorded/evaluation-names-the-run': {
    mutate: (db, t) =>
      t.forEach((id) =>
        db.evaluation_runs.push({
          id: U(7000 + ++later),
          organization_id: ORG,
          scheduler_run_id: id,
          scheduler_run_type: 'game',
          status: 'completed',
        })
      ),
    witness: (db, t) => db.evaluation_runs.some((e) => t.includes(e.scheduler_run_id)),
  },
};

// ------------------------------------------------------------------ the readers of the CURRENT schedule, after a rollback
/** A PostgREST-shaped client over the mock's tables: what the real readers call, and nothing else. */
function clientOver(db) {
  const query = (table) => {
    let rows = [...(db[table] || [])];
    const q = {
      select: () => q,
      eq: (k, v) => ((rows = rows.filter((r) => String(r[k]) === String(v))), q),
      in: (k, list) => ((rows = rows.filter((r) => list.includes(r[k]))), q),
      or: (expr) => {
        const alts = expr.split(',').map((part) => part.split('.eq.'));
        rows = rows.filter((r) => alts.some(([k, v]) => String(r[k]) === v));
        return q;
      },
      order: (k, { ascending = true } = {}) => {
        rows.sort((a, b) => String(a[k]).localeCompare(String(b[k])) * (ascending ? 1 : -1));
        return q;
      },
      limit: (n) => ((rows = rows.slice(0, n)), q),
      range: (from, to) => Promise.resolve({ data: rows.slice(from, to + 1), error: null }),
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
    };
    return q;
  };
  return { from: query };
}
/**
 * What the pages and the exports read as the current schedule, by their own code where it can be called
 * (`readCurrentSavedGameIds`, which the Exports page uses and whose query is `useSchedulerRun`'s) and by `useTeamSummary`'s
 * rule for the team run (the latest that is completed or running). 'ok', or what is wrong.
 */
async function readers(db, jobId) {
  const problems = [];
  const current = await readCurrentSavedGameIds({
    organizationId: ORG,
    seasonSettingsId: SEASON,
    client: /** @type {any} */ (clientOver(db)),
  });
  if (current.runId !== U(40))
    problems.push('the current game run is not the run before the import');
  if (![U(50), U(51)].every((id) => current.ids.has(id)))
    problems.push('the current game run does not show the restored games');
  const live = new Set(db.teams.map((t) => String(t.id)));
  for (const run of db.scheduler_runs.filter(
    (r) => r.run_type === 'team' && r.parameters?.import_job_id === jobId
  )) {
    const listed = [
      ...Object.values(run.results?.teamsByDivision || {}).flat(),
      ...(run.results?.teams || []),
    ];
    if (listed.some((t) => !live.has(String(t.id))))
      problems.push('a team run of the import lists a team that does not exist');
  }
  const taken = db.scheduler_runs.filter(
    (r) => r.run_type === 'team' && ['completed', 'running'].includes(r.status)
  );
  for (const r of db.import_application_records.filter(
    (x) => x.import_job_id === jobId && x.target_table === 'teams'
  )) {
    const team = db.teams.find((t) => t.id === r.target_id);
    if (
      team &&
      !team.is_external &&
      !taken.some((run) => JSON.stringify(run.results).includes(team.id))
    )
      problems.push('a kept shell is in no team run a reader takes');
  }
  return problems.length ? problems.join('; ') : 'ok';
}
/** Every record of the pair still holds the date the apply left, one day on. */
function tbdMovedOneDay(db, operation, ids) {
  return (
    ids.length > 0 &&
    db.import_application_records
      .filter((r) => r.target_table === 'schedule_tbd' && r.operation === operation)
      .every((r) => {
        const now = db.schedule_tbd.find((s) => s.id === r.target_id);
        return now && now.game_date === nextDay(r.applied_payload.game_date);
      })
  );
}

const LISTED = /^game_import_changed count=(\d+) ids=([0-9a-f,-]*)( tbd_ids=([0-9a-f,-]+))?$/;

describe('the rollback judges every record it undoes (the class)', () => {
  // ONE real apply, through the mock.
  const seed = world();
  const seedFingerprint = fingerprint(seed);
  const applied = world();
  const jobId = addJob(applied, fileQ(), mappingQ());
  const out = rpc(applied, 'apply_game_import_job', { p_import_job_id: jobId });
  const runId = applied.scheduler_runs.find(
    (r) => r.parameters?.import_job_id === jobId && r.run_type === 'game'
  )?.id;

  it('applies, and writes every pair the sources say it can, and no other', () => {
    expect(out.error).toBeNull();
    const wrote = [
      ...new Set(applied.import_application_records.map((r) => `${r.target_table}:${r.operation}`)),
    ].sort();
    expect(wrote).toEqual(migrationPairs());
    expect(runId).toBeTruthy();
  });

  it('the control: with no later change the rollback keeps nothing and every table is as it was before the apply', () => {
    const db = structuredClone(applied);
    const back = rpc(db, 'rollback_game_import_job', { p_import_job_id: jobId });
    expect(back.error).toBeNull();
    expect(back.data.kept).toEqual([]);
    expect(fingerprint(db)).toBe(seedFingerprint);
  });

  it('has a JavaScript writer for every scenario of the table, and none for a scenario that is not in it', () => {
    const keys = SCENARIOS.map((s) => `${s.table}:${s.operation}/${s.name}`).sort();
    expect(Object.keys(WRITERS).sort()).toEqual(keys);
  });

  describe.each(SCENARIOS)('$table $operation: $name -> $expect', (scenario) => {
    it('is refused, or kept and named, and what the later writer did is still there', async () => {
      const db = structuredClone(applied);
      const targets =
        scenario.table === 'scheduler_runs'
          ? [runId]
          : idsOf(db, scenario.table, scenario.operation);
      expect(targets.length).toBeGreaterThan(0);
      const writer = WRITERS[`${scenario.table}:${scenario.operation}/${scenario.name}`];
      writer.mutate(db, targets);
      const before = JSON.stringify(db);
      const back = rpc(db, 'rollback_game_import_job', { p_import_job_id: jobId });
      if (scenario.expect === 'refuse') {
        expect(back.error?.code).toBe('22023');
        const listed = LISTED.exec(back.error?.details ?? '');
        expect(listed, back.error?.details).not.toBeNull();
        const named = [...(listed[2] || '').split(','), ...(listed[4] || '').split(',')];
        for (const id of targets) expect(named).toContain(id);
        // A refusal writes nothing.
        expect(JSON.stringify(db)).toBe(before);
      } else {
        expect(back.error).toBeNull();
        for (const id of targets)
          expect(back.data.kept).toContainEqual({ table: scenario.table, id });
      }
      expect(writer.witness(db, targets)).toBe(true);
      // After a rollback that went through, the readers of the CURRENT schedule see the restored one (a run the
      // rollback kept is retired, never current; no team run lists a team that is gone).
      if (scenario.expect === 'keep') expect(await readers(db, jobId)).toBe('ok');
    });
  });

  it('a team run kept for a shell that stays is not retired, and lists the kept shell and not the one that is gone', async () => {
    const db = structuredClone(applied);
    db.teams.find((t) => t.name === 'Shell A').notes = 'kept';
    const back = rpc(db, 'rollback_game_import_job', { p_import_job_id: jobId });
    expect(back.error).toBeNull();
    expect(
      db.teams.filter((t) => ['Shell A', 'Shell B'].includes(t.name)).map((t) => t.name)
    ).toEqual(['Shell A']);
    const run = db.scheduler_runs.find(
      (r) => r.run_type === 'team' && r.parameters?.import_job_id === jobId
    );
    expect(run.status).toBe('completed');
    expect(
      run.results.teams.filter((t) => String(t.name).startsWith('Shell')).map((t) => t.name)
    ).toEqual(['Shell A']);
    expect(PGTAP).toContain("'1 completed:Shell A | ok'");
    expect(await readers(db, jobId)).toBe('ok');
  });

  it('the readers this file runs are the ones the pages use: both ask for the latest COMPLETED game run', () => {
    for (const file of [
      'frontend/src/hooks/useSchedulerRun.js',
      'frontend/src/utils/gamePublishedClient.js',
    ]) {
      const src = read(file);
      expect(src, file).toMatch(
        /\.eq\('status', 'completed'\)\s*\.order\('completed_at', \{ ascending: false \}\)/
      );
    }
    expect(read('frontend/src/hooks/useTeamSummary.js')).toMatch(
      /\.in\('status', \['completed', 'running'\]\)/
    );
  });
});

describe('the finding as reported: a season with no placed games', () => {
  const db = world();
  db.game_assignments = [];
  db.schedule_tbd = [];
  const tbd = (n, gameId, date, week) =>
    row(n, { status: 'tbd', gameId, division: 'QD', home: 'Q1', away: 'Q2', date, week });
  const map = () => ({
    options: { arrive_published: false },
    divisions: { [divisionDecisionKey('QD')]: { action: 'map', id: DIV } },
    teams: Object.fromEntries(
      [1, 2].map((n) => [teamDecisionKey('QD', `Q${n}`), { action: 'map', id: T[n] }])
    ),
  });
  const a = addJob(db, [tbd(1, 'R-G1', '2027-03-06', 1)], map());
  rpc(db, 'apply_game_import_job', { p_import_job_id: a });
  const b = addJob(db, [tbd(1, 'R-G1', '2027-03-13', 2)], map());
  rpc(db, 'apply_game_import_job', { p_import_job_id: b });
  const g1 = () => db.schedule_tbd.filter((s) => s.external_ref === 'R-G1');

  it('import B corrected the row in place', () => {
    expect(g1()).toHaveLength(1);
    expect(g1()[0]).toMatchObject({ game_date: '2027-03-13', week_index: 2 });
  });
  it("rolling import A back is refused, names the TIME TBD game, and leaves B's correction", () => {
    const back = rpc(db, 'rollback_game_import_job', { p_import_job_id: a });
    expect(back.error?.code).toBe('22023');
    expect(back.error?.details).toBe(`game_import_changed count=1 ids= tbd_ids=${g1()[0].id}`);
    expect(g1()[0]).toMatchObject({ game_date: '2027-03-13', week_index: 2 });
  });
  it('B can be rolled back first (the row is put back as A wrote it), and then A can', () => {
    const backB = rpc(db, 'rollback_game_import_job', { p_import_job_id: b });
    expect(backB.error).toBeNull();
    expect(backB.data.time_tbd_restored).toBe(1);
    expect(g1()[0]).toMatchObject({ game_date: '2027-03-06', week_index: 1 });
    const backA = rpc(db, 'rollback_game_import_job', { p_import_job_id: a });
    expect(backA.error).toBeNull();
    expect(backA.data.time_tbd_deleted).toBe(1);
    expect(g1()).toHaveLength(0);
  });
});
