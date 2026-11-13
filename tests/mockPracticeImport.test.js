/**
 * The mock's practice schedule import (`frontend/src/lib/mockPracticeImport.js`) held to the database's (PR 10, task
 * K3; migration `20261123010000_practice_import.sql`) by ONE world: the shipped placeholder fixture, the same 710 staged
 * rows, the same league and the same mapping the pgTAP file loads (`supabase/tests/_practice_import_fixture.sql`, which
 * this file requires to be what `tests/helpers/practiceImportPgtapFixture.js` builds from the fixture now).
 *
 * **How the twin is held** (LESSONS_LEARNED #102, item 3): every number the pgTAP file asserts about the fixture is
 * computed here by the mock and required to be in the pgTAP file's text beside the same description, so a number
 * changed in one place and not the other fails; the flags are also held to the fixture's INDEPENDENT counts (the
 * sweep of `tests/helpers/practiceSweep.js`, which reads the CSV and imports neither the generator nor the product);
 * and a wrong number is shown to be a mismatch. Then: the preview is the apply, a re-import inserts nothing and reports
 * the same flags, a probable move is held back until ticked, the rollback refuses after a change and restores the
 * world, and a run after the import (`planTeamsForRun`, the practice solver's own planning) places only the short
 * teams and keeps every other one locked.
 *
 * The TIME TBD rebuild reads the date (`sync_schedule_tbd_practices` counts only practices that end after today), so
 * the mock is given 2026-11-13, a day inside the fixture's season, as the pgTAP file's numbers assume (it says so).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  handlePracticeImportRpc,
  mockPracticeImportReferenced,
  PRACTICE_IMPORT_REFERENCES,
} from '../frontend/src/lib/mockPracticeImport.js';
import { pairProbableMoves } from '../packages/core/src/practiceImport/index.js';
import { planTeamsForRun } from '../supabase/functions/_shared/engines/practice-lock.ts';
import {
  PRACTICE_PGTAP_ORG as ORG,
  PRACTICE_PGTAP_SEASON as SEASON,
  buildPracticeImportPgtapSql,
  practicePgtapWorld,
} from './helpers/practiceImportPgtapFixture.js';
import { countPlants } from './helpers/practiceSweep.js';
import { tableColumnsFromMigrations } from './helpers/sqlColumns.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INCLUDE = 'supabase/tests/_practice_import_fixture.sql';
const PGTAP = readFileSync(
  path.join(REPO, 'supabase/tests/practice_import_apply_rollback.sql'),
  'utf8'
);

const ADMIN = '11111111-1111-1111-1111-111111111111';
let counter = 0;
const env = {
  newId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
  now: () => '2026-11-13T12:00:00.000Z',
};
const ctx = { isOrgAdmin: (org) => org === ORG, currentUserId: ADMIN, ...env };
const rpc = (db, name, params, c = ctx) => handlePracticeImportRpc(db, name, params, c);

const W = practicePgtapWorld();

/** The pgTAP file's world, as mock tables: the fixture's league, a saved practice of A-Team, and its slot. */
function seedDb() {
  const L = W.league;
  const stamp = '2026-11-01T00:00:00.000Z';
  return {
    season_settings: [
      {
        id: SEASON,
        organization_id: ORG,
        name: 'Org A Spring 2026',
        status: 'active',
        season_start: W.season.startDate,
        season_end: W.season.endDate,
      },
    ],
    divisions: L.divisions.map((d) => ({
      id: d.id,
      organization_id: ORG,
      season_settings_id: SEASON,
      name: d.name,
      practices_per_week: d.practicesPerWeek,
      practice_minutes: d.practiceMinutes,
    })),
    teams: L.teams.map((t) => ({
      id: t.id,
      organization_id: ORG,
      division_id: t.divisionId,
      name: t.name,
      is_external: false,
    })),
    team_coach_assignments: L.coachOf.map((a, i) => ({
      id: `tca-${i}`,
      organization_id: ORG,
      team_id: a.team,
      coach_id: a.coach,
      role: a.role,
      effective_from: W.season.startDate,
      effective_to: null,
    })),
    locations: L.locations.map((l) => ({ id: l.id, organization_id: ORG, name: l.name })),
    fields: L.fields.map((f) => ({
      id: f.id,
      organization_id: ORG,
      location_id: f.locationId,
      name: f.name,
      supports_halves: true,
    })),
    field_subunits: L.subunits.map((s) => ({
      id: s.id,
      organization_id: ORG,
      field_id: s.fieldId,
      label: s.name,
    })),
    practice_slots: [],
    practice_assignments: [],
    practice_exceptions: [],
    schedule_tbd: [],
    scheduler_runs: [],
    import_jobs: [],
    staging_import_rows: [],
    import_application_records: [],
    audit_log: [],
    created_at: stamp,
  };
}

/** A job of the fixture, staged and mapped as the pgTAP file stages and maps it. */
function stageJob(db, id, mapping = W.mapping) {
  db.import_jobs.push({
    id,
    organization_id: ORG,
    job_type: 'practice_schedule',
    status: 'ready_to_apply',
    season_settings_id: SEASON,
    warning_summary: {},
  });
  for (const s of W.staged) {
    db.staging_import_rows.push({
      id: `${id}-${s.source_row_number}`,
      organization_id: ORG,
      import_job_id: id,
      import_type: 'practice_schedule',
      source_row_number: s.source_row_number,
      normalized_payload: s.normalized_payload,
      validation_errors: s.validation_errors,
    });
  }
  const mapped = rpc(db, 'map_practice_import_job', { p_import_job_id: id, p_mapping: mapping });
  expect(mapped.error).toBeNull();
  return mapped.data;
}

/** The description of one pgTAP assertion, and the value it must assert: the line that holds the description holds it. */
function pgtapAsserts(description, value) {
  const at = PGTAP.indexOf(`'${description}`);
  expect(at, `the pgTAP file has the assertion "${description}"`).toBeGreaterThan(-1);
  const statement = PGTAP.slice(PGTAP.lastIndexOf('SELECT ', at), at);
  return statement.includes(`'${value}'`);
}

describe('the pgTAP include is the fixture as core stages it now', () => {
  it('is generated, and equal to a fresh build (WRITE_PRACTICE_PGTAP=1 rewrites it)', () => {
    const built = buildPracticeImportPgtapSql();
    // The one write a test makes, and only on request: a regeneration, never in CI.
    if (process.env.WRITE_PRACTICE_PGTAP === '1') writeFileSync(path.join(REPO, INCLUDE), built);
    expect(
      readFileSync(path.join(REPO, INCLUDE), 'utf8') === built,
      'the include differs: regenerate it'
    ).toBe(true);
  });

  it('holds the 710 rows and every label decided (a world that examined nothing is no world)', () => {
    expect(W.staged).toHaveLength(710);
    expect(
      Object.fromEntries(Object.entries(W.mapping).map(([g, m]) => [g, Object.keys(m).length]))
    ).toEqual({
      divisions: 20,
      locations: 8,
      fields: 29,
      subunits: 58,
      teams: 132,
    });
    // the alias file's spellings reached the mapping as alias decisions
    expect(
      Object.values(W.mapping.fields).filter((d) => d.source === 'alias').length
    ).toBeGreaterThan(10);
  });
});

describe('the fixture through the mock equals the pgTAP file', () => {
  const db = seedDb();
  stageJob(db, 'job-1');
  const before = structuredClone(db);
  const dry = rpc(db, 'apply_practice_import_job', { p_import_job_id: 'job-1', p_dry_run: true });
  const afterDry = structuredClone(db);
  const apply = rpc(db, 'apply_practice_import_job', {
    p_import_job_id: 'job-1',
    p_dry_run: false,
  });
  const r = apply.data;
  const n = (p) => p.split(',').reduce((o, k) => (o == null ? o : o[k]), r);
  const pair = (code) => `${r.flags[code]?.teams}/${r.flags[code]?.rows}`;

  it("a dry run writes nothing, and its result is the apply's", () => {
    expect(dry.error).toBeNull();
    expect(afterDry).toEqual(before);
    const strip = (x) => {
      const { dry_run: _d, ids: _i, ...rest } = x;
      return rest;
    };
    expect(strip(dry.data)).toEqual(strip(r));
  });

  it("every number the pgTAP file asserts about the fixture is the mock's too", () => {
    const cases = [
      [
        'placements, open slots, holds and refused rows of the fixture',
        `${n('counts,placements')} ${n('counts,open')} ${n('counts,holds')} ${n('counts,refused')}`,
      ],
      [
        'the first import inserts 236 practices and makes 705 slots',
        `${n('counts,inserted')} ${n('counts,slots_created')} ${n('counts,unchanged')} ${n('counts,slots_found')}`,
      ],
      ['weekday: 6 teams, 12 rows', pair('weekday')],
      ['count: 1 team, 3 rows', pair('count')],
      ['capacity: one cell, 2 rows', pair('capacity')],
      ['coach-conflict: one coach, two teams', pair('coach-conflict')],
      ['team-on-both-halves: one team, two rows', pair('team-on-both-halves')],
      [
        'TIME TBD: the 29 one-practice teams of the file',
        String(r.time_tbd.teams.filter((t) => t.in_file).length),
      ],
      [
        'coverage says how many teams coach overlap was judged for',
        `${n('coverage,coach_judged_teams')}/${n('coverage,file_teams')}`,
      ],
    ];
    for (const [description, value] of cases) {
      expect(pgtapAsserts(description, value), `${description}: the mock says ${value}`).toBe(true);
    }
    expect(r.refused_by_reason).toEqual({ 'slot-overlaps-another': 1 });
    expect(r.refused[0].message).toMatch(/overlaps the slot of row 552/);
    expect([r.flags.reservation, r.flags.length, r.flags['hold-over-open-slot']]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('PLANT: a number the pgTAP file does not assert is a mismatch', () => {
    expect(pgtapAsserts('weekday: 6 teams, 12 rows', '7/12')).toBe(false);
    expect(pgtapAsserts('count: 1 team, 3 rows', '1/2')).toBe(false);
  });

  it("the flags equal the fixture's independent counts (the sweep reads the CSV, not the product)", () => {
    const { counts } = countPlants({
      rows: W.fixture.schedule.rows,
      teams: W.fixture.teams.rows,
      divisions: W.fixture.divisions.rows,
    });
    // a double-placed team and the team on both halves each hold two rows on one weekday
    expect(r.flags.weekday.teams).toBe(counts.doublePlaced + counts.teamOnBothHalves);
    // the team on both halves holds three rows, one over its count of two
    expect(r.flags.count.teams).toBe(counts.teamOnBothHalves);
    expect(r.flags['team-on-both-halves'].teams).toBe(counts.teamOnBothHalves);
    // each over-capacity cell flags the two teams in it; each coach clash flags both of the coach's teams
    expect(r.flags.capacity.rows).toBe(2 * counts.overCapacity);
    expect(r.flags['coach-conflict'].teams).toBe(2 * counts.coachClashes);
    expect(r.counts.refused).toBe(counts.overlappingSlots);
    expect(r.counts.holds).toBe(counts.holds);
    expect(r.time_tbd.teams.filter((t) => t.in_file).length).toBe(counts.shortTeams);
    // the counts the comparison rests on are not zero
    for (const k of [
      'doublePlaced',
      'teamOnBothHalves',
      'overCapacity',
      'coachClashes',
      'overlappingSlots',
      'shortTeams',
      'holds',
    ]) {
      expect(counts[k], k).toBeGreaterThan(0);
    }
  });

  it('writes manual practices in no run, and one application record per row written', () => {
    const recs = db.import_application_records.filter((x) => x.import_job_id === 'job-1');
    expect(recs.filter((x) => x.target_table === 'practice_assignments')).toHaveLength(236);
    expect(recs.filter((x) => x.target_table === 'practice_slots')).toHaveLength(705);
    expect(
      db.practice_assignments.every(
        (pa) => pa.source === 'manual' && pa.assigned_via === 'manual' && pa.run_id === null
      )
    ).toBe(true);
    expect(new Set(db.practice_assignments.map((pa) => pa.effective_date_range))).toEqual(
      new Set(['[2026-09-07,2026-11-21)'])
    );
    expect(
      pgtapAsserts(
        'the import stores [from, until] as the writer canonicalises it',
        '[2026-09-07,2026-11-21)'
      )
    ).toBe(true);
    expect(db.scheduler_runs).toEqual([]);
  });

  it('a run after the import places only the short teams and keeps every other one locked (planTeamsForRun)', () => {
    const teamIds = W.league.teams.map((t) => t.id);
    const targets = new Map(
      W.league.teams.map((t) => [
        t.id,
        W.league.divisions.find((d) => d.id === t.divisionId).practicesPerWeek,
      ])
    );
    const rows = /** @type {any} */ (db.practice_assignments.map((pa) => ({ teamId: pa.team_id })));
    const plan = planTeamsForRun(teamIds, rows, [], targets);
    const short = r.time_tbd.teams
      .filter((t) => t.in_file)
      .map((t) => t.team_id)
      .sort();
    expect([...plan.placeable].sort()).toEqual(short);
    expect(short.every((id) => plan.unitsNeeded[id] === 1)).toBe(true);
    expect(plan.locked.length).toBe(teamIds.length - short.length);
    expect(plan.overTarget.length).toBe(1);
  });

  it('a re-import inserts nothing and reports the same flags', () => {
    stageJob(db, 'job-2');
    const re = rpc(db, 'apply_practice_import_job', {
      p_import_job_id: 'job-2',
      p_dry_run: false,
    }).data;
    expect([
      re.counts.inserted,
      re.counts.unchanged,
      re.counts.slots_created,
      re.counts.slots_found,
    ]).toEqual([0, 236, 0, 705]);
    expect(
      pgtapAsserts('a re-import inserts nothing: 236 unchanged, 705 slots found', '0 236 0 705')
    ).toBe(true);
    expect(re.flags).toEqual(r.flags);
  });

  it('the rollback refuses after a change, and before one restores the world', () => {
    const first = db.practice_assignments[0];
    const saved = first.source;
    first.source = 'auto';
    const refused = rpc(db, 'apply_practice_import_job', { p_import_job_id: 'job-1' }); // a replay, not a write
    expect(refused.data.replayed).toBe(true);
    const out = rpc(db, 'rollback_practice_import_job', { p_import_job_id: 'job-1' });
    expect(out.error?.details).toBe('practice_import_changed');
    expect(out.error?.message).toBe(`practice_import_changed count=1 ids=${first.id}`);
    first.source = saved;
    const done = rpc(db, 'rollback_practice_import_job', { p_import_job_id: 'job-1' });
    expect(done.error).toBeNull();
    expect([
      done.data.assignments_deleted,
      done.data.deleted.practice_slots,
      done.data.kept,
    ]).toEqual([236, 705, []]);
    expect(db.practice_assignments).toEqual([]);
    expect(db.practice_slots).toEqual([]);
  });
});

describe("the TIME TBD numbers after the fixture's season has ended (the sync reads the date)", () => {
  it("every team of the file is short of its whole count, as the pgTAP file's other branch says", () => {
    const db = seedDb();
    stageJob(db, 'job-1');
    const late = { ...ctx, now: () => '2026-12-01T12:00:00.000Z' };
    const r = rpc(
      db,
      'apply_practice_import_job',
      { p_import_job_id: 'job-1', p_dry_run: true },
      late
    ).data;
    const inFile = r.time_tbd.teams.filter((t) => t.in_file);
    expect(inFile.length).toBe(132);
    expect(inFile.reduce((n, t) => n + t.missing_count, 0)).toBe(264);
    expect(PGTAP).toContain("CASE WHEN current_date <= '2026-11-20' THEN '29' ELSE '132' END");
    expect(PGTAP).toContain(
      "CASE WHEN current_date <= '2026-11-20' THEN '29/29' ELSE '132/264' END"
    );
  });
});

describe('a probable move is held back until it is ticked, and pairs as core pairs the two lists', () => {
  const db = seedDb();
  stageJob(db, 'job-1');
  rpc(db, 'apply_practice_import_job', { p_import_job_id: 'job-1', p_dry_run: false });
  // job-3: the file again, its first placement moved onto the first open row's cell
  const moved = W.staged.find((s) => s.normalized_payload?.status === 'placement');
  const open = W.staged.find((s) => s.normalized_payload?.status === 'open');
  const movedPayload = {
    ...open.normalized_payload,
    row_key: moved.normalized_payload.row_key,
    status: 'placement',
    division: moved.normalized_payload.division,
    division_key: moved.normalized_payload.division_key,
    team: moved.normalized_payload.team,
    team_key: moved.normalized_payload.team_key,
  };
  const stageMoved = (id, mapping) => {
    db.import_jobs.push({
      id,
      organization_id: ORG,
      job_type: 'practice_schedule',
      status: 'ready_to_apply',
      season_settings_id: SEASON,
      warning_summary: {},
    });
    for (const s of W.staged) {
      if (s === open) continue;
      db.staging_import_rows.push({
        id: `${id}-${s.source_row_number}`,
        organization_id: ORG,
        import_job_id: id,
        import_type: 'practice_schedule',
        source_row_number: s.source_row_number,
        normalized_payload: s === moved ? movedPayload : s.normalized_payload,
        validation_errors: s.validation_errors,
      });
    }
    expect(
      rpc(db, 'map_practice_import_job', { p_import_job_id: id, p_mapping: mapping }).error
    ).toBeNull();
  };

  it('unticked: one team, one row arriving and held back, nothing inserted; ticked: the row is inserted', () => {
    stageMoved('job-3', W.mapping);
    const un = rpc(db, 'apply_practice_import_job', {
      p_import_job_id: 'job-3',
      p_dry_run: true,
    }).data;
    expect([
      un.counts.arriving,
      un.counts.probable_move_teams,
      un.counts.held_back,
      un.counts.inserted,
    ]).toEqual([1, 1, 1, 0]);
    expect(
      pgtapAsserts(
        'UNTICKED: the moved row arrives as a probable move of one team, held back, and nothing is inserted',
        '1 1 1 0'
      )
    ).toBe(true);
    // the database's flag is core's pairing over the two lists the dry run returns
    const pairing = pairProbableMoves({
      leaving: un.leaving.map((l) => ({ rowKey: l.assignment_id, teamId: l.team_id })),
      arriving: un.arriving.map((a) => ({ rowKey: a.row_key, teamId: a.team_id })),
    });
    expect(pairing.arrivals.map((a) => [a.rowKey, a.probableMove, a.defaultTicked])).toEqual(
      un.arriving.map((a) => [a.row_key, a.probable_move, a.added])
    );
    stageMoved('job-4', {
      ...W.mapping,
      options: { add_moved_rows: [moved.normalized_payload.row_key] },
    });
    const ticked = rpc(db, 'apply_practice_import_job', {
      p_import_job_id: 'job-4',
      p_dry_run: true,
    }).data;
    expect([ticked.counts.held_back, ticked.counts.inserted, ticked.arriving[0].added]).toEqual([
      0,
      1,
      true,
    ]);
  });
});

describe('the refusals', () => {
  const db = seedDb();
  stageJob(db, 'job-1');

  it("no user, another organization's admin, a job of another type, a malformed staged row", () => {
    expect(
      rpc(
        db,
        'apply_practice_import_job',
        { p_import_job_id: 'job-1' },
        { ...ctx, currentUserId: null }
      ).error.code
    ).toBe('42501');
    expect(
      rpc(
        db,
        'apply_practice_import_job',
        { p_import_job_id: 'job-1' },
        { ...ctx, isOrgAdmin: () => false }
      ).error.code
    ).toBe('42501');
    db.import_jobs.push({
      id: 'job-g',
      organization_id: ORG,
      job_type: 'games',
      status: 'ready_to_apply',
      season_settings_id: SEASON,
    });
    expect(
      rpc(db, 'apply_practice_import_job', { p_import_job_id: 'job-g' }).error.message
    ).toMatch(/is games, not practice_schedule/);
    db.staging_import_rows.find(
      (s) => s.import_job_id === 'job-1' && s.normalized_payload?.status === 'open'
    ).normalized_payload.end_time = '00:30';
    expect(
      rpc(db, 'apply_practice_import_job', { p_import_job_id: 'job-1', p_dry_run: true }).error
        .details
    ).toBe('practice_import_staged_invalid');
  });

  it('a draft or completed season, and a mapping onto an outside club', () => {
    db.season_settings[0].status = 'draft';
    expect(
      rpc(db, 'apply_practice_import_job', { p_import_job_id: 'job-1', p_dry_run: true }).error
        .details
    ).toBe('season_not_active');
    db.season_settings[0].status = 'completed';
    expect(
      rpc(db, 'rollback_practice_import_job', { p_import_job_id: 'job-1' }).error.details
    ).toBe('season_completed');
    db.season_settings[0].status = 'active';
    db.teams.push({
      id: '99999999-0000-4000-8000-000000000001',
      organization_id: ORG,
      division_id: W.league.divisions[0].id,
      name: 'Club',
      is_external: true,
    });
    const out = rpc(db, 'map_practice_import_job', {
      p_import_job_id: 'job-1',
      p_mapping: { teams: { x: { action: 'map', id: '99999999-0000-4000-8000-000000000001' } } },
    });
    expect(out.error.message).toMatch(/an outside club has no practice/);
  });
});

describe("the rollback's reference list is the migrations' foreign keys onto the tables it deletes from", () => {
  /** `REFERENCES public.<table> (id)` in a CREATE TABLE or ALTER TABLE of `<child>`, from the migration text. */
  function migrationReferences() {
    const dir = path.join(REPO, 'supabase/migrations');
    const found = new Set();
    // From the definitive schema on (20260331000000 rebuilt every table; the files before it describe tables it replaced),
    // and only for a child table that still exists (a table dropped since takes its keys with it).
    const live = tableColumnsFromMigrations();
    for (const f of readdirSync(dir)
      .filter((x) => x.endsWith('.sql') && x >= '20260331000000')
      .sort()) {
      const sql = readFileSync(path.join(dir, f), 'utf8').replace(/--[^\n]*/g, '');
      for (const stmt of sql.split(';')) {
        const head =
          /\b(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE(?:\s+ONLY)?(?:\s+IF\s+EXISTS)?)\s+(?:public\.)?(\w+)/i.exec(
            stmt
          );
        if (!head) continue;
        for (const m of stmt.matchAll(
          /(\w+)\s+uuid[^,()]*?REFERENCES\s+(?:public\.)?(\w+)\s*(?:\(\s*id\s*\))?/gi
        )) {
          if (m[2] in PRACTICE_IMPORT_REFERENCES && live.get(head[1])?.has(m[1]))
            found.add(`${m[2]}<-${head[1]}.${m[1]}`);
        }
      }
    }
    return found;
  }

  it('lists every reference the migrations declare onto the six tables and scheduler_runs (or the calendar token, which is derived)', () => {
    const listed = new Set(
      Object.entries(PRACTICE_IMPORT_REFERENCES).flatMap(([t, refs]) =>
        refs.map(([c, col]) => `${t}<-${c}.${col}`)
      )
    );
    const declared = [...migrationReferences()].filter(
      (x) => !x.startsWith('teams<-team_calendar_tokens.')
    );
    expect(declared.length).toBeGreaterThan(15);
    expect(declared.filter((x) => !listed.has(x)).sort()).toEqual([]);
  });

  it('PLANT: a reference the list does not hold is reported, and the check reads the list', () => {
    const db = {
      fields: [{ id: 'f1' }],
      field_blackouts: [{ field_id: 'f1' }],
      schedule_tbd: [{ kind: 'practice', team_id: 't1' }],
    };
    expect(mockPracticeImportReferenced(db, 'fields', 'f1')).toBe(true);
    expect(mockPracticeImportReferenced(db, 'teams', 't1')).toBe(false);
    expect(mockPracticeImportReferenced(db, 'fields', 'f2')).toBe(false);
  });
});
