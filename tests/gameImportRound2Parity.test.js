/**
 * The mock held to the database for fix round 2's TIME TBD and swap cases (PR 5; the owner's answers of 2026-11-09).
 *
 * `supabase/tests/game_import_round2.sql` (sections C and D) builds one league and runs two files through the apply, the
 * preview and the rollback. This file builds the same league in JavaScript, runs the same two files through the mock, and
 * asserts the same numbers; a test reads the pgTAP file and requires every number asserted here to be in it with the same
 * value (lesson 77: a twin is held by a test that runs both over one input), so a number changed in one place and not the
 * other fails.
 *
 *   C  TIME TBD holds a DATE and no time (`game_date`), is found by (season, Game ID) first, is changed in place, becomes
 *      a placed game when the file places it, and a placed game the file now says has no time is converted with a warning
 *      unless it is held; the rollback puts all of it back;
 *   D  a game moved onto a place another game of the same file leaves is written, with the warning `games-swapped`; a place
 *      a game the file does not move holds still refuses; a held game is never moved; the rollback restores every game.
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

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PGTAP = readFileSync(path.join(REPO, 'supabase/tests/game_import_round2.sql'), 'utf8');

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

const DIV = U(300);
const T = [null, U(301), U(302), U(303), U(304), U(305), U(306)];
const F1 = U(31);
const F2 = U(32);
const slot = (id, field, date, start, week) => ({
  id,
  organization_id: ORG,
  field_id: field,
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
const RUN = U(310);
const game = (id, slotRow, home, away, week, ref, published = false) => ({
  id,
  organization_id: ORG,
  season_settings_id: SEASON,
  run_id: RUN,
  game_slot_id: slotRow.id,
  slot_id: slotRow.id,
  field_id: slotRow.field_id,
  home_team_id: home,
  away_team_id: away,
  division: 'TB',
  week_index: week,
  start: slotRow.start,
  end: slotRow.end,
  external_ref: ref,
  import_job_id: null,
  published,
  published_at: null,
  published_by: null,
  assignment_source: 'auto',
});
const tbdRow = (n, home, away, week, reason, ref, date) => ({
  id: U(380 + n),
  organization_id: ORG,
  season_settings_id: SEASON,
  kind: 'game',
  division_id: DIV,
  home_team_id: home,
  away_team_id: away,
  week_index: week,
  reason,
  detail: {},
  run_id: RUN,
  external_ref: ref,
  game_date: date,
  created_at: '2026-04-01T00:00:00Z',
});

function world() {
  const slots = [
    slot(U(320), F1, '2027-05-01', '09:00', 1),
    slot(U(321), F1, '2027-05-01', '10:00', 1),
    // D
    slot(U(350), F1, '2027-06-05', '09:00', 10),
    slot(U(351), F1, '2027-06-05', '10:00', 10),
    slot(U(352), F2, '2027-06-05', '09:00', 10),
    slot(U(353), F2, '2027-06-05', '10:00', 10),
    slot(U(354), F1, '2027-06-05', '11:00', 10),
    slot(U(355), F2, '2027-06-05', '11:00', 10),
    slot(U(356), F1, '2027-06-12', '09:00', 11),
    slot(U(357), F2, '2027-06-12', '09:00', 11),
    slot(U(358), F1, '2027-06-12', '10:00', 11),
    slot(U(359), F2, '2027-06-12', '10:00', 11),
  ];
  const s = (n) => slots.find((x) => x.id === U(n));
  return {
    season_settings: [{ id: SEASON, organization_id: ORG, status: 'active', name: 'Spring' }],
    divisions: [{ id: DIV, organization_id: ORG, season_settings_id: SEASON, name: 'TB' }],
    teams: [1, 2, 3, 4, 5, 6].map((n) => ({
      id: T[n],
      organization_id: ORG,
      division_id: DIV,
      name: `T${n}`,
    })),
    locations: [{ id: U(30), organization_id: ORG, name: 'Round Park' }],
    fields: [
      { id: F1, organization_id: ORG, location_id: U(30), name: 'Pitch 1' },
      { id: F2, organization_id: ORG, location_id: U(30), name: 'Pitch 2' },
    ],
    game_slots: slots,
    scheduler_runs: [
      {
        id: RUN,
        organization_id: ORG,
        season_id: SEASON,
        season_settings_id: SEASON,
        run_type: 'game',
        status: 'completed',
        completed_at: '2026-04-03T00:00:00Z',
        created_at: '2026-04-03T00:00:00Z',
      },
    ],
    game_assignments: [
      game(U(340), s(320), T[1], T[2], 1, 'C-PL-1'),
      game(U(341), s(321), T[3], T[4], 1, 'C-PL-2', true),
      game(U(360), s(350), T[1], T[2], 10, 'D-1'),
      game(U(361), s(351), T[1], T[2], 10, 'D-2'),
      game(U(362), s(352), T[3], T[4], 10, 'D-3'),
      game(U(363), s(354), T[5], T[6], 10, null),
      game(U(364), s(355), T[5], T[6], 10, 'D-6'),
      game(U(365), s(356), T[2], T[3], 11, 'D-H', true),
      game(U(366), s(357), T[2], T[3], 11, 'D-8'),
      game(U(367), s(359), T[1], T[3], 11, 'D-9'),
    ],
    schedule_tbd: [
      tbdRow(1, T[5], T[6], 2, 'imported-without-time', 'C-TB-1', '2027-05-08'),
      tbdRow(2, T[1], T[3], 3, 'no-slot-available', null, null),
      tbdRow(3, T[2], T[4], 6, 'imported-without-time', 'C-TB-2', '2027-06-12'),
      tbdRow(4, T[4], T[6], 7, 'imported-without-time', 'C-TB-3', '2027-06-19'),
    ],
    import_jobs: [],
    staging_import_rows: [],
    import_application_records: [],
    audit_log: [],
    team_players: [],
    players: [],
  };
}

const row = (n, status, gameId, home, away, date, start, end, week, field = 'Pitch 1') =>
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
      venueLabel: status === 'tbd' ? '' : 'Round Park',
      fieldLabel: status === 'tbd' ? '' : field,
      divisionLabel: 'TB',
      homeLabel: home,
      awayLabel: away,
      weekIndex: week,
      weekSource: 'file',
      flags: [],
    })
  );

const mapping = () => ({
  options: { arrive_published: false },
  divisions: { [divisionDecisionKey('TB')]: { action: 'map', id: DIV } },
  venues: { [venueDecisionKey('Round Park')]: { action: 'map', id: U(30) } },
  fields: {
    [fieldDecisionKey('Round Park', 'Pitch 1')]: { action: 'map', id: F1 },
    [fieldDecisionKey('Round Park', 'Pitch 2')]: { action: 'map', id: F2 },
  },
  teams: Object.fromEntries(
    [1, 2, 3, 4, 5, 6].map((n) => [teamDecisionKey('TB', `T${n}`), { action: 'map', id: T[n] }])
  ),
});

let jobNo = 0;
function addJob(db, rows) {
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
    rpc(db, 'map_game_import_job', { p_import_job_id: id, p_mapping: mapping() }).error
  ).toBeNull();
  return id;
}

/** The games and the TIME TBD rows as one comparable text, without the instant a row was last written. */
const fingerprint = (db) =>
  JSON.stringify([
    [...db.game_assignments]
      .map((g) => ({ ...g, updated_at: undefined }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    [...db.schedule_tbd].sort((a, b) => String(a.id).localeCompare(String(b.id))),
  ]);

const fileC = () => [
  row(1, 'tbd', 'C-TB-1', 'T5', 'T6', '2027-05-22', null, null, 4),
  row(2, 'tbd', 'C-NEW-1', 'T2', 'T3', '2027-05-29', null, null, 5),
  row(3, 'tbd', null, 'T1', 'T3', '2027-05-15', null, null, 3),
  row(4, 'tbd', 'C-PL-1', 'T1', 'T2', '2027-05-01', null, null, 1),
  row(5, 'tbd', 'C-PL-2', 'T3', 'T4', '2027-05-01', null, null, 1),
  row(6, 'ok', 'C-TB-2', 'T2', 'T4', '2027-06-12', '09:00', '10:00', 6),
  row(7, 'tbd', 'C-Z', 'T4', 'T6', '2027-06-19', null, null, 7),
];
const fileD = () => [
  row(1, 'ok', 'D-1', 'T1', 'T2', '2027-06-05', '10:00', '11:00', 10, 'Pitch 1'),
  row(2, 'ok', 'D-2', 'T1', 'T2', '2027-06-05', '09:00', '10:00', 10, 'Pitch 1'),
  row(3, 'ok', 'D-3', 'T3', 'T4', '2027-06-05', '10:00', '11:00', 10, 'Pitch 2'),
  row(4, 'ok', 'D-4', 'T3', 'T4', '2027-06-05', '09:00', '10:00', 10, 'Pitch 2'),
  row(5, 'ok', 'D-6', 'T5', 'T6', '2027-06-05', '11:00', '12:00', 10, 'Pitch 1'),
  row(6, 'ok', 'D-H', 'T2', 'T3', '2027-06-12', '10:00', '11:00', 11, 'Pitch 1'),
  row(7, 'ok', 'D-8', 'T2', 'T3', '2027-06-12', '09:00', '10:00', 11, 'Pitch 1'),
  row(8, 'tbd', 'D-9', 'T1', 'T3', '2027-06-12', null, null, 11),
  row(9, 'ok', 'D-10', 'T1', 'T3', '2027-06-12', '10:00', '11:00', 11, 'Pitch 2'),
];

/** A number asserted here must be asserted, the same, by the pgTAP file. */
const inPgtap = (text) => expect(PGTAP).toContain(text);

describe('C: TIME TBD holds a date and no time, found by Game ID, changed in place', () => {
  const db = world();
  const before = fingerprint(db);
  const id = addJob(db, fileC());
  const dry = rpc(db, 'apply_game_import_job', { p_import_job_id: id, p_dry_run: true }).data;
  const afterDry = fingerprint(db);
  it('a dry run writes nothing', () => {
    expect(afterDry).toBe(before);
  });
  const out = rpc(db, 'apply_game_import_job', { p_import_job_id: id });
  it('counts what the pgTAP file counts', () => {
    expect(out.error).toBeNull();
    expect(out.data.time_tbd).toEqual({
      inserted: 2,
      updated: 2,
      unchanged: 0,
      removed: 1,
      converted: 1,
    });
    inPgtap(`'{"inserted": 2, "updated": 2, "unchanged": 0, "removed": 1, "converted": 1}'::jsonb`);
    expect([
      out.data.games.inserted,
      out.data.games.skipped['skipped-published'],
      out.data.refused_by_reason,
    ]).toEqual([1, 1, { 'duplicate-row': 1 }]);
    inPgtap(`'1 1 {"duplicate-row": 1}'`);
  });
  it('the preview is the apply (its counts, lists and warnings)', () => {
    const strip = (result) => ({ ...result, dry_run: undefined, ids: undefined });
    expect(strip(dry)).toEqual(strip(out.data));
  });
  it('a TIME TBD game found by Game ID changes in place: one row, its date and week changed', () => {
    const rows = db.schedule_tbd.filter((s) => s.external_ref === 'C-TB-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ game_date: '2027-05-22', week_index: 4 });
    expect(
      db.schedule_tbd.filter((s) => s.home_team_id === T[5] && s.away_team_id === T[6])
    ).toHaveLength(1);
    inPgtap("'31>32 w4 2027-05-22 C-TB-1 imported-without-time | 1'");
  });
  it('a row with no Game ID is found by its tuple and takes the date and the reason', () => {
    const r = db.schedule_tbd.find((s) => s.home_team_id === T[1] && s.away_team_id === T[3]);
    expect(r).toMatchObject({
      game_date: '2027-05-15',
      reason: 'imported-without-time',
      external_ref: null,
    });
    inPgtap("'2d>2f w3 2027-05-15 - imported-without-time'");
  });
  it('a new one holds its date and Game ID; a converted game is gone and a dated row stands for it', () => {
    expect(db.schedule_tbd.find((s) => s.external_ref === 'C-NEW-1')).toMatchObject({
      game_date: '2027-05-29',
    });
    expect(db.game_assignments.find((g) => g.id === U(340))).toBeUndefined();
    expect(db.schedule_tbd.find((s) => s.external_ref === 'C-PL-1')).toMatchObject({
      game_date: '2027-05-01',
    });
    inPgtap("'2d>2e w1 2027-05-01 C-PL-1 imported-without-time | gone'");
  });
  it('a held game is not converted and a placed row removes the TIME TBD row it names', () => {
    expect(db.game_assignments.find((g) => g.id === U(341))).toBeDefined();
    expect(db.schedule_tbd.find((s) => s.external_ref === 'C-PL-2')).toBeUndefined();
    expect(db.schedule_tbd.find((s) => s.external_ref === 'C-TB-2')).toBeUndefined();
    expect(db.game_assignments.filter((g) => g.external_ref === 'C-TB-2')).toHaveLength(1);
  });
  it('another Game ID on a held tuple is refused; the first Game ID holds the row', () => {
    expect(db.schedule_tbd.find((s) => s.external_ref === 'C-Z')).toBeUndefined();
    expect(db.schedule_tbd.find((s) => s.external_ref === 'C-TB-3')).toBeDefined();
  });
  it('the conversion is a warning, not a refusal', () => {
    const w = out.data.warnings.filter((x) => x.type === 'game-made-time-tbd');
    expect(w.map((x) => x.details.gameId)).toEqual(['C-PL-1']);
  });
  it('every change has its record, with the image it had', () => {
    const counts = {};
    // The pgTAP file's league holds only C's games at this point; D's are seeded later, so they are left out here.
    const dGames = new Set([360, 361, 362, 363, 364, 365, 366, 367].map((n) => U(n)));
    for (const r of db.import_application_records.filter(
      (x) =>
        ['schedule_tbd', 'game_assignments'].includes(x.target_table) && !dGames.has(x.target_id)
    ))
      counts[`${r.target_table}:${r.operation}`] =
        (counts[`${r.target_table}:${r.operation}`] ?? 0) + 1;
    expect(counts).toEqual({
      'game_assignments:deleted': 1,
      'game_assignments:inserted': 1,
      'game_assignments:updated': 1,
      'schedule_tbd:deleted': 1,
      'schedule_tbd:inserted': 2,
      'schedule_tbd:updated': 2,
    });
    inPgtap(
      "'game_assignments:deleted=1,game_assignments:inserted=1,game_assignments:updated=1,schedule_tbd:deleted=1,schedule_tbd:inserted=2,schedule_tbd:updated=2'"
    );
  });
  it('the same file again is nothing to apply', () => {
    const again = addJob(db, fileC());
    const fp = fingerprint(db);
    const runs = db.scheduler_runs.filter((r) => r.run_type === 'game').length;
    const second = rpc(db, 'apply_game_import_job', { p_import_job_id: again });
    expect(second.data.nothing_to_apply).toBe(true);
    expect(second.data.time_tbd).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 4,
      removed: 0,
      converted: 0,
    });
    expect(fingerprint(db)).toBe(fp);
    expect(db.scheduler_runs.filter((r) => r.run_type === 'game')).toHaveLength(runs);
    inPgtap(`'{"inserted": 0, "updated": 0, "unchanged": 4, "removed": 0, "converted": 0}'::jsonb`);
  });
  it('the rollback restores the games and the TIME TBD rows exactly', () => {
    const back = rpc(db, 'rollback_game_import_job', { p_import_job_id: id });
    expect(back.error).toBeNull();
    expect(fingerprint(db)).toBe(before);
    expect([
      back.data.games.reinserted,
      back.data.time_tbd_restored,
      back.data.time_tbd_reinserted,
      back.data.time_tbd_deleted,
    ]).toEqual([1, 2, 1, 2]);
    inPgtap("'1 2 1 2'");
  });
});

describe('D: swaps are warnings, not blockers', () => {
  const db = world();
  const before = fingerprint(db);
  const id = addJob(db, fileD());
  const dry = rpc(db, 'apply_game_import_job', { p_import_job_id: id, p_dry_run: true }).data;
  const out = rpc(db, 'apply_game_import_job', { p_import_job_id: id });
  const startOf = (gid) => {
    const g = db.game_assignments.find((x) => x.id === gid);
    return `${db.game_slots.find((x) => x.id === g.game_slot_id).start_time}`;
  };
  it('writes the swap, the move to a free place and the new game; refuses the two real clashes; skips the held game', () => {
    expect(out.error).toBeNull();
    expect([
      out.data.games.updated,
      out.data.games.inserted,
      out.data.refused_by_reason,
      out.data.games.skipped['skipped-published'],
    ]).toEqual([3, 2, { 'duplicate-row': 2 }, 1]);
    inPgtap(`'3 2 {"duplicate-row": 2} 1'`);
  });
  it("each game stands on the other's old place", () => {
    expect([startOf(U(360)), startOf(U(361))]).toEqual(['10:00', '09:00']);
    expect(startOf(U(362))).toBe('10:00');
    const d4 = db.game_assignments.find((g) => g.external_ref === 'D-4');
    expect(db.game_slots.find((x) => x.id === d4.game_slot_id).start_time).toBe('09:00');
  });
  it('the refused rows left their games where they were and the held game did not move', () => {
    expect(startOf(U(364))).toBe('11:00');
    expect(db.game_assignments.find((g) => g.id === U(364)).field_id).toBe(F2);
    expect(startOf(U(365))).toBe('09:00');
    expect(db.game_assignments.find((g) => g.id === U(366)).field_id).toBe(F2);
  });
  it('names each game that took a leaving place in a games-swapped warning', () => {
    const w = out.data.warnings.filter((x) => x.type === 'games-swapped');
    expect(w.map((x) => x.details.gameId).sort()).toEqual(['D-1', 'D-10', 'D-2', 'D-4']);
    inPgtap("'4 D-1,D-10,D-2,D-4'");
  });
  it('a placed game given no time is taken out and a new game is written on the place it leaves', () => {
    expect(db.game_assignments.find((g) => g.id === U(367))).toBeUndefined();
    const d10 = db.game_assignments.find((g) => g.external_ref === 'D-10');
    expect(db.game_slots.find((x) => x.id === d10.game_slot_id).start_time).toBe('10:00');
    expect(out.data.warnings.filter((x) => x.type === 'game-made-time-tbd')).toHaveLength(1);
    inPgtap("'gone | 2d>2f@20/2027-06-12/10:00 w11 pub=false ref=D-10 | 1'");
  });
  it('the preview is the apply', () => {
    const strip = (result) => ({ ...result, dry_run: undefined, ids: undefined });
    expect(strip(dry)).toEqual(strip(out.data));
  });
  it('the rollback puts every game back and removes the one the import wrote', () => {
    const back = rpc(db, 'rollback_game_import_job', { p_import_job_id: id });
    expect(back.error).toBeNull();
    expect(fingerprint(db)).toBe(before);
  });
});
