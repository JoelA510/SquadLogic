// @vitest-environment jsdom
// The evaluations import (Phase E3c; migration 20261113010000; plan
// docs/changes/2026-10-27-season-enrollment.md, C2), in the mock: the mock twin of
// `finalize_evaluation_import_job`, held to the SQL's outcomes by the same scenario as
// supabase/tests/evaluations_import.sql (the same file, the same players, the same counts):
//   * it only updates: an unmatched registration id is listed and creates nothing; a blank cell
//     leaves the stored value alone, a zero is a value; a value already stored is not rewritten;
//   * identifiers are text (`007` is not `7`); another season's and another organization's player
//     with the same id are never touched; a draft season's job updates the draft's players only;
//   * a row is judged whole; a repeated id uses its first row; a key the finalizer does not read
//     changes nothing; the dry run writes nothing and the apply returns the same counts;
//   * a completed season, a stranger, a job of another type and a cancelled job are refused;
//     a finished job answers with its stored result; the audit row has counts and no ids;
//   * import-validation stages only the allowlisted columns, with an error per bad cell.
import { beforeEach, describe, expect, it } from 'vitest';
import { getMockData, mockSupabase as supabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../frontend/src/lib/mockSeedIds.js';

const DRAFT = 'ev-draft-season';
const PAST = 'ev-past-season';
const OTHER_ORG = 'ev-other-org';
const OTHER_SEASON = 'ev-other-season';

const save = (patch) => window.__saveMockDB__({ ...window.__MOCK_DB__, ...patch });

const player = (id, reg, seasonId, years, tier, rating, extra = {}) => ({
  id,
  organization_id: MOCK_ORG_ID,
  season_settings_id: seasonId,
  first_name: 'Ev',
  last_name: id,
  external_registration_id: reg,
  years_played: years,
  skill_tier: tier,
  rating,
  updated_at: '2020-01-01T00:00:00.000Z',
  ...extra,
});

const vals = (reg, seasonId = MOCK_SEASON_ID, orgId = MOCK_ORG_ID) => {
  const p = getMockData('players').find(
    (item) =>
      item.external_registration_id === reg &&
      item.season_settings_id === seasonId &&
      item.organization_id === orgId
  );
  return `${p.years_played ?? '-'}/${p.skill_tier ?? '-'}/${p.rating ?? '-'}`;
};

const seed = () => {
  save({
    season_settings: [
      ...getMockData('season_settings'),
      { id: DRAFT, organization_id: MOCK_ORG_ID, name: 'Draft 2027', status: 'draft' },
      { id: PAST, organization_id: MOCK_ORG_ID, name: 'Past 2025', status: 'draft' },
      { id: OTHER_SEASON, organization_id: OTHER_ORG, name: 'Other', status: 'active' },
    ],
    players: [
      ...getMockData('players').filter((p) => p.organization_id !== MOCK_ORG_ID),
      player('a01', '007', MOCK_SEASON_ID, null, null, null),
      player('a02', '7', MOCK_SEASON_ID, null, null, null),
      player('a03', 'EV-2', MOCK_SEASON_ID, 4, 'advanced', 5),
      player('a04', 'EV-3', MOCK_SEASON_ID, 2, 'novice', 1),
      player('a05', 'EV-4', MOCK_SEASON_ID, 6, 'developing', 3),
      player('a06', 'EV-5', MOCK_SEASON_ID, 8, 'novice', 2),
      player('a07', 'EV-6', MOCK_SEASON_ID, null, null, null),
      player('a08', 'EV-7', MOCK_SEASON_ID, 5, null, null),
      player('d01', '007', DRAFT, 9, 'advanced', 4),
      player('d02', 'EV-2', DRAFT, null, null, null),
      player('c01', 'EV-2', PAST, 7, 'developing', 3),
      player('b01', '007', OTHER_SEASON, 3, 'novice', 2, { organization_id: OTHER_ORG }),
    ],
  });
};

/** A staged-job maker: an evaluations job and its rows, as import-validation would stage them. */
let nextJob = 0;
const makeJob = (
  rows,
  { seasonId = MOCK_SEASON_ID, type = 'evaluations', status = 'importing' } = {}
) => {
  const id = `ev-job-${(nextJob += 1)}`;
  save({
    import_jobs: [
      ...getMockData('import_jobs'),
      {
        id,
        organization_id: MOCK_ORG_ID,
        job_type: type,
        status,
        season_settings_id: seasonId,
        total_rows: rows.length,
      },
    ],
    staging_import_rows: [
      ...getMockData('staging_import_rows'),
      ...rows.map(([n, payload]) => ({
        id: `${id}-r${n}`,
        organization_id: MOCK_ORG_ID,
        import_job_id: id,
        import_type: 'evaluations',
        source_row_number: n,
        raw_payload: {},
        normalized_payload: payload,
        validation_errors: [],
      })),
    ],
  });
  return id;
};

const finalize = (jobId, errors = [], dry = false) =>
  supabase.rpc('finalize_evaluation_import_job', {
    p_import_job_id: jobId,
    p_validation_errors: errors,
    ...(dry ? { p_dry_run: true } : {}),
  });

const MAIN_FILE = [
  [
    1,
    { external_registration_id: '007', years_played: '3', skill_tier: 'developing', rating: '4' },
  ],
  [2, { external_registration_id: 'EV-2', years_played: '6', skill_tier: '', rating: '' }],
  [3, { external_registration_id: 'EV-3', years_played: '2', skill_tier: 'NOVICE', rating: '1' }],
  [4, { external_registration_id: 'EV-4', years_played: '', skill_tier: '', rating: '' }],
  [5, { external_registration_id: 'NOBODY-1', years_played: '2', skill_tier: '', rating: '' }],
  [
    6,
    { external_registration_id: 'EV-5', years_played: '31', skill_tier: 'advanced', rating: '4' },
  ],
  [7, { external_registration_id: 'EV-6', years_played: '', skill_tier: 'gold', rating: '6' }],
  [8, { years_played: '2', skill_tier: '', rating: '' }],
  [9, { gotsport_id: 'EV-6', years_played: '1', skill_tier: '', rating: '' }],
  [10, { external_registration_id: 'EV-7', years_played: '0', skill_tier: '', rating: '' }],
  [11, { external_registration_id: '0001', years_played: '1', skill_tier: '', rating: '' }],
  [
    12,
    {
      external_registration_id: '7',
      first_name: 'Hacked',
      years_played: '',
      skill_tier: '',
      rating: '',
    },
  ],
];
const UPSTREAM = [
  { row: 13, field: 'rating', message: 'Rating must be a whole number from 1 to 5' },
];

beforeEach(async () => {
  sessionStorage.clear();
  window.__MOCK_DB__ = undefined;
  await supabase.auth.signInWithPassword({
    email: 'admin@example.com',
    password: 'test-password-123',
  });
  seed();
});

describe('create_import_job (mock): the evaluations type', () => {
  it('has its own job type, in the active season unless a draft is named', async () => {
    const active = await supabase.rpc('create_import_job', {
      p_organization_id: MOCK_ORG_ID,
      p_import_type: 'evaluations',
      p_file_name: 'ev.csv',
    });
    expect(active.error).toBeNull();
    expect(active.data).toMatchObject({
      job_type: 'evaluations',
      season_settings_id: MOCK_SEASON_ID,
    });
    const draft = await supabase.rpc('create_import_job', {
      p_organization_id: MOCK_ORG_ID,
      p_import_type: 'evaluations',
      p_file_name: 'ev.csv',
      p_season_settings_id: DRAFT,
    });
    expect(draft.data).toMatchObject({ job_type: 'evaluations', season_settings_id: DRAFT });
    const players = await supabase.rpc('create_import_job', {
      p_organization_id: MOCK_ORG_ID,
      p_import_type: 'players',
      p_file_name: 'p.csv',
    });
    expect(players.data.job_type).toBe('registration');
  });

  it('refuses a completed season, as for every type, and a misspelled type', async () => {
    save({
      season_settings: getMockData('season_settings').map((s) =>
        s.id === PAST ? { ...s, status: 'completed' } : s
      ),
    });
    const completed = await supabase.rpc('create_import_job', {
      p_organization_id: MOCK_ORG_ID,
      p_import_type: 'evaluations',
      p_file_name: 'ev.csv',
      p_season_settings_id: PAST,
    });
    expect(completed.error).toMatchObject({ code: '22023', details: 'season_completed' });
    const typo = await supabase.rpc('create_import_job', {
      p_organization_id: MOCK_ORG_ID,
      p_import_type: 'evaluation',
      p_file_name: 'ev.csv',
    });
    expect(typo.error.message).toMatch(/invalid import type/);
  });
});

describe('finalize_evaluation_import_job (mock): the main file, as supabase/tests/evaluations_import.sql', () => {
  it('previews the counts and writes nothing', async () => {
    const jobId = makeJob(MAIN_FILE);
    const before = JSON.stringify(getMockData('players'));
    const { data, error } = await finalize(jobId, UPSTREAM, true);
    expect(error).toBeNull();
    expect(data).toMatchObject({ status: 'preview', dry_run: true });
    expect([
      data.staged_rows,
      data.matched_rows,
      data.updated_players,
      data.unchanged_players,
      data.unmatched_rows,
      data.invalid_rows,
      data.duplicate_rows,
      data.validation_error_rows,
    ]).toEqual([12, 7, 4, 3, 2, 3, 0, 1]);
    expect([data.years_updated, data.tier_updated, data.rating_updated]).toEqual([4, 1, 1]);
    expect(JSON.stringify(getMockData('players'))).toBe(before);
    const job = getMockData('import_jobs').find((j) => j.id === jobId);
    expect(job.status).toBe('importing');
    expect(getMockData('staging_import_rows').filter((r) => r.applied_at)).toHaveLength(0);
    expect(getMockData('audit_log').filter((a) => a.resource_id === jobId)).toHaveLength(0);
  });

  it('applies the same counts, and only what the rules say', async () => {
    const jobId = makeJob(MAIN_FILE);
    const dry = (await finalize(jobId, UPSTREAM, true)).data;
    const total = getMockData('players').length;
    const { data } = await finalize(jobId, UPSTREAM);
    expect(data.status).toBe('completed_with_warnings');
    const { status: _s, dry_run: _d, ...applied } = data;
    const { status: _ps, dry_run: _pd, ...preview } = dry;
    expect(applied).toEqual(preview);

    expect(vals('007')).toBe('3/developing/4'); // all three
    expect(vals('EV-2')).toBe('6/advanced/5'); // blank tier and rating keep the stored ones
    expect(vals('EV-3')).toBe('2/novice/1'); // already stored
    expect(vals('EV-4')).toBe('6/developing/3'); // a blank row changes nothing
    expect(vals('EV-5')).toBe('8/novice/2'); // an invalid row applies none of its cells
    expect(vals('EV-6')).toBe('1/-/-'); // reached by gotsport_id; the invalid row applied nothing
    expect(vals('EV-7')).toBe('0/-/-'); // a zero is a value
    expect(vals('7')).toBe('-/-/-'); // 7 is not 007
    expect(getMockData('players').find((p) => p.id === 'a02').first_name).toBe('Ev');
    expect(getMockData('players')).toHaveLength(total); // nobody created
    expect(
      getMockData('players')
        .filter((p) => p.season_settings_id === MOCK_SEASON_ID && p.updated_at > '2021')
        .map((p) => p.external_registration_id)
        .sort()
    ).toEqual(['007', 'EV-2', 'EV-6', 'EV-7']);
    // Another season's, a draft's and another organization's players are untouched.
    expect(vals('007', DRAFT)).toBe('9/advanced/4');
    expect(vals('EV-2', PAST)).toBe('7/developing/3');
    expect(vals('007', OTHER_SEASON, OTHER_ORG)).toBe('3/novice/2');

    expect(data.unmatched).toEqual([
      { source_row_number: 5, registration_id: 'NOBODY-1' },
      { source_row_number: 11, registration_id: '0001' },
    ]);
    expect(data.invalid.map((i) => `${i.source_row_number}:${i.field}`)).toEqual([
      '6:years_played',
      '7:rating',
      '7:skill_tier',
      '8:external_registration_id',
    ]);
    expect(JSON.stringify(data.invalid)).not.toMatch(/gold|31/);
    const rows = getMockData('staging_import_rows').filter((r) => r.import_job_id === jobId);
    expect(rows.filter((r) => r.applied_at)).toHaveLength(9);
    expect(
      rows
        .filter((r) => r.validation_errors.length)
        .map((r) => r.source_row_number)
        .sort((a, b) => a - b)
    ).toEqual([6, 7, 8]);
    const job = getMockData('import_jobs').find((j) => j.id === jobId);
    expect([job.status, job.processed_rows, job.error_summary.rowErrors]).toEqual([
      'completed_with_warnings',
      9,
      UPSTREAM,
    ]);

    // Audited: the counts, the type and the season, no registration ids.
    const audits = getMockData('audit_log').filter(
      (a) => a.resource_id === jobId && a.action === 'import.completed'
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toMatchObject({
      import_type: 'evaluations',
      updated_players: 4,
      unmatched_rows: 2,
      season_settings_id: MOCK_SEASON_ID,
    });
    expect(Object.keys(audits[0].metadata)).not.toEqual(
      expect.arrayContaining(['unmatched', 'invalid', 'duplicates'])
    );
    expect(JSON.stringify(audits[0].metadata)).not.toMatch(/NOBODY/);

    // A second call answers with the stored result and writes no second audit row.
    const replay = await finalize(jobId, UPSTREAM);
    expect(replay.data).toMatchObject({ updated_players: 4, replayed: true });
    expect(
      getMockData('audit_log').filter(
        (a) => a.resource_id === jobId && a.action === 'import.completed'
      )
    ).toHaveLength(1);
  });

  it('changes nothing when the same file is imported again', async () => {
    await finalize(makeJob(MAIN_FILE), UPSTREAM);
    const after = JSON.stringify(getMockData('players'));
    const { data } = await finalize(makeJob(MAIN_FILE), UPSTREAM);
    expect([
      data.updated_players,
      data.unchanged_players,
      data.unmatched_rows,
      data.invalid_rows,
    ]).toEqual([0, 7, 2, 3]);
    expect(JSON.stringify(getMockData('players'))).toBe(after);
  });

  it('uses the first row of a repeated registration id, by row number', async () => {
    const jobId = makeJob([
      [3, { external_registration_id: 'EV-6', years_played: '3' }],
      [2, { external_registration_id: 'EV-6', years_played: '2' }],
      [1, { external_registration_id: 'EV-6', years_played: '9' }],
    ]);
    const { data } = await finalize(jobId);
    expect(vals('EV-6')).toBe('9/-/-');
    expect([data.duplicate_rows, data.updated_players, data.status]).toEqual([
      2,
      1,
      'completed_with_warnings',
    ]);
    expect(data.duplicates).toEqual([
      { source_row_number: 2, registration_id: 'EV-6' },
      { source_row_number: 3, registration_id: 'EV-6' },
    ]);
  });

  it("updates a draft season's players only, for a job of the draft", async () => {
    const jobId = makeJob(
      [
        [
          1,
          {
            external_registration_id: '007',
            years_played: '11',
            skill_tier: 'novice',
            rating: '2',
          },
        ],
        [2, { external_registration_id: 'EV-2', years_played: '1' }],
      ],
      { seasonId: DRAFT }
    );
    const { data } = await finalize(jobId);
    expect([data.updated_players, data.status, data.season_settings_id]).toEqual([
      2,
      'completed',
      DRAFT,
    ]);
    expect(vals('007', DRAFT)).toBe('11/novice/2');
    expect(vals('EV-2', DRAFT)).toBe('1/-/-');
    expect(vals('007')).toBe('-/-/-');
    expect(vals('EV-2')).toBe('4/advanced/5');
  });
});

describe('finalize_evaluation_import_job (mock): refusals', () => {
  const rows = [[1, { external_registration_id: 'EV-2', years_played: '20' }]];

  it('refuses a season completed since the job was made, apply and dry run alike, writing nothing', async () => {
    const jobId = makeJob(rows, { seasonId: PAST });
    save({
      season_settings: getMockData('season_settings').map((s) =>
        s.id === PAST ? { ...s, status: 'completed' } : s
      ),
    });
    for (const dry of [false, true]) {
      const { data, error } = await finalize(jobId, [], dry);
      expect(data).toBeNull();
      expect(error).toMatchObject({ code: '22023', details: 'season_completed' });
    }
    expect(vals('EV-2', PAST)).toBe('7/developing/3');
    expect(getMockData('import_jobs').find((j) => j.id === jobId).status).toBe('importing');
    expect(getMockData('staging_import_rows').filter((r) => r.applied_at)).toHaveLength(0);
  });

  it('refuses a job whose season is not there (season_missing)', async () => {
    // The mock re-merges its seed season on every read, so the organization cannot be left with
    // none; a job naming a season that does not exist reaches the same refusal.
    const jobId = makeJob(rows, { seasonId: 'ev-no-such-season' });
    expect((await finalize(jobId)).error).toMatchObject({
      code: '22023',
      details: 'season_missing',
    });
  });

  it('refuses a stranger, a job that is not there, another type, a cancelled job and a bad error list', async () => {
    const jobId = makeJob(rows);
    expect((await finalize('no-such-job')).error.code).toBe('P0002');
    expect((await finalize(makeJob(rows, { type: 'registration' }))).error.code).toBe('22023');
    expect((await finalize(makeJob(rows, { status: 'failed' }))).error.code).toBe('22023');
    // @ts-expect-error -- the RPC takes an array; an object is the bad input under test
    expect((await finalize(jobId, {})).error.code).toBe('22023');
    sessionStorage.setItem(
      '__MOCK_SESSION__',
      JSON.stringify({ user: { id: 'a-stranger', email: 'stranger@example.com' } })
    );
    expect((await finalize(jobId)).error.code).toBe('42501');
    expect((await finalize(jobId, [], true)).error.code).toBe('42501');
    sessionStorage.clear();
    expect(vals('EV-2')).toBe('4/advanced/5');
  });

  it('can be marked ready and cancelled as an evaluations job, and as nothing else', async () => {
    const jobId = makeJob(rows);
    const registration = makeJob(rows, { type: 'registration' });
    const ready = await supabase.rpc('mark_import_job_ready_to_apply', {
      p_import_job_id: jobId,
      p_import_type: 'evaluations',
      p_validation_errors: [],
    });
    expect(ready.data).toMatchObject({
      status: 'ready_to_apply',
      import_type: 'evaluations',
      staged_rows: 1,
    });
    expect(
      (
        await supabase.rpc('mark_import_job_ready_to_apply', {
          p_import_job_id: registration,
          p_import_type: 'evaluations',
        })
      ).error
    ).toBeTruthy();
    expect(
      (
        await supabase.rpc('cancel_ready_import_job', {
          p_import_job_id: registration,
          p_import_type: 'evaluations',
        })
      ).error
    ).toBeTruthy();
    const canceled = await supabase.rpc('cancel_ready_import_job', {
      p_import_job_id: jobId,
      p_import_type: 'evaluations',
    });
    expect(canceled.data.status).toBe('canceled');
  });
});

describe('import-validation (mock): evaluations rows', () => {
  const invoke = (rows, importJobId) =>
    supabase.functions.invoke('import-validation', {
      body: {
        import_type: 'evaluations',
        organization_id: MOCK_ORG_ID,
        rows,
        row_offset: 0,
        ...(importJobId ? { import_job_id: importJobId } : {}),
      },
    });

  it('stages the id and the three values only, under their canonical keys, and errors per bad cell', async () => {
    const created = await supabase.rpc('create_import_job', {
      p_organization_id: MOCK_ORG_ID,
      p_import_type: 'evaluations',
      p_file_name: 'ev.csv',
    });
    const { data } = await invoke(
      [
        {
          'Registration ID': '0042',
          'First Name': 'First1',
          'Date of Birth': '2016-01-01',
          'Guardian 1 Email Address': 'email1@example.com',
          'Years Played': '2',
          'Skill Tier': 'Developing',
          Rating: '3',
        },
        { 'Registration ID': 'GS-2', 'Years Played': '40', Rating: '9', 'Skill Level': '4' },
        { 'Years Played': '1' },
      ],
      created.data.id
    );
    expect(data.valid_rows).toBe(1);
    expect(data.validation_errors.map((e) => `${e.row}:${e.field}`)).toEqual([
      '2:years_played',
      '2:skill_tier',
      '2:rating',
      '3:external_registration_id',
    ]);
    expect(JSON.stringify(data.validation_errors)).not.toMatch(/40|Skill Level/);
    expect(data.validated_data[0]).toEqual({
      external_registration_id: '0042',
      years_played: '2',
      skill_tier: 'Developing',
      rating: '3',
    });
    const staged = getMockData('staging_import_rows').filter(
      (r) => r.import_job_id === created.data.id
    );
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({ import_type: 'evaluations', source_row_number: 1 });
    expect(Object.keys(staged[0].normalized_payload).sort()).toEqual([
      'external_registration_id',
      'rating',
      'skill_tier',
      'years_played',
    ]);
  });
});
