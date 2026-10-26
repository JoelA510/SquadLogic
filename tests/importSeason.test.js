// Imports carry their season (Phase E1; migration 20261101010000; plan
// docs/changes/2026-10-22-phase-e-seasons.md, point 5). The mock twin: `create_import_job` fixes
// the season (the active one unless a draft is named; another organization's and a completed one
// are refused), and `finalize_import_job` and `finalize_field_import_job` read the job's season,
// not "the active one first, then the newest". And the browser's call: the season is sent only
// when it is not the active one, so a call for the active season has the shape it always had.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getMockData, mockSupabase as supabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../frontend/src/lib/mockSeedIds.js';
import { createImportJob } from '../frontend/src/utils/importJobLifecycleActions.js';

const DRAFT = 'is-draft';
const DONE = 'is-done';
const OTHER = 'is-other-season';

beforeEach(() => {
  sessionStorage.clear();
  window.__saveMockDB__({
    organizations: [{ id: 'is-other-org', name: 'Other', is_onboarded: true }],
    season_settings: [
      {
        id: DRAFT,
        organization_id: MOCK_ORG_ID,
        name: 'Draft 2027',
        status: 'draft',
        created_at: new Date(Date.now() + 86400000).toISOString(),
      },
      {
        id: DONE,
        organization_id: MOCK_ORG_ID,
        name: 'Done',
        status: 'completed',
        created_at: '2020-01-01T00:00:00Z',
      },
      {
        id: OTHER,
        organization_id: 'is-other-org',
        name: 'Other',
        status: 'active',
        created_at: '2020-01-01T00:00:00Z',
      },
    ],
  });
});

const make = (extra = {}) =>
  supabase.rpc('create_import_job', {
    p_organization_id: MOCK_ORG_ID,
    p_import_type: 'players',
    p_file_name: 'players.csv',
    ...extra,
  });

const stage = (jobId, payload) => {
  const rows = getMockData('staging_players');
  rows.push({
    id: `row-${jobId}`,
    organization_id: MOCK_ORG_ID,
    import_job_id: jobId,
    source_row_number: 1,
    raw_payload: {},
    normalized_payload: payload,
    validation_errors: [],
  });
  window.__saveMockDB__({ ...window.__MOCK_DB__, staging_players: rows });
};

const PLAYER = (id) => ({
  first_name: 'Dee',
  last_name: 'Season',
  external_registration_id: id,
  'age group': '9',
  gender: 'M',
});

describe('create_import_job (mock)', () => {
  it('fixes the active season when none is named, even with a newer draft', async () => {
    const { data, error } = await make();
    expect(error).toBeNull();
    expect(data.season_settings_id).toBe(MOCK_SEASON_ID);
  });

  it('takes a named draft season', async () => {
    const { data } = await make({ p_season_settings_id: DRAFT });
    expect(data.season_settings_id).toBe(DRAFT);
  });

  it("refuses another organization's season (42501) and a completed one (22023) and creates no job", async () => {
    const before = getMockData('import_jobs').length;
    expect((await make({ p_season_settings_id: OTHER })).error?.code).toBe('42501');
    expect((await make({ p_season_settings_id: DONE })).error?.code).toBe('22023');
    expect(getMockData('import_jobs')).toHaveLength(before);
  });
});

describe('finalize_import_job (mock)', () => {
  it('finalizes a job made for a draft season into the draft, not the active season', async () => {
    const { data: job } = await make({ p_season_settings_id: DRAFT });
    stage(job.id, PLAYER('IS-1'));
    const { error } = await supabase.rpc('finalize_import_job', {
      p_import_job_id: job.id,
      p_validation_errors: [],
    });
    expect(error).toBeNull();
    const made = getMockData('divisions').filter((d) => d.name === 'U10B');
    expect(made.map((d) => d.season_settings_id)).toEqual([DRAFT]);
    // The division joined its season's default program without anyone naming one.
    expect(made[0].program_id).toBe(
      getMockData('programs').find((p) => p.season_settings_id === DRAFT && p.is_default).id
    );
  });

  it('finalizes a job made for the active season into it, though a newer draft exists', async () => {
    const { data: job } = await make();
    stage(job.id, PLAYER('IS-2'));
    await supabase.rpc('finalize_import_job', { p_import_job_id: job.id, p_validation_errors: [] });
    expect(
      getMockData('divisions')
        .filter((d) => d.name === 'U10B')
        .map((d) => d.season_settings_id)
    ).toEqual([MOCK_SEASON_ID]);
  });

  it('lands a legacy job (no season) in the active season', async () => {
    const { data: job } = await make();
    job.season_settings_id = null;
    const jobs = getMockData('import_jobs').map((j) =>
      j.id === job.id ? { ...j, season_settings_id: null } : j
    );
    window.__saveMockDB__({ ...window.__MOCK_DB__, import_jobs: jobs });
    stage(job.id, PLAYER('IS-3'));
    await supabase.rpc('finalize_import_job', { p_import_job_id: job.id, p_validation_errors: [] });
    expect(
      getMockData('divisions')
        .filter((d) => d.name === 'U10B')
        .map((d) => d.season_settings_id)
    ).toEqual([MOCK_SEASON_ID]);
  });

  it('refuses a job whose season has been completed since (22023) and promotes nobody', async () => {
    const { data: job } = await make({ p_season_settings_id: DRAFT });
    stage(job.id, PLAYER('IS-4'));
    const seasons = getMockData('season_settings').map((s) =>
      s.id === DRAFT ? { ...s, status: 'completed' } : s
    );
    window.__saveMockDB__({ ...window.__MOCK_DB__, season_settings: seasons });
    const { error } = await supabase.rpc('finalize_import_job', {
      p_import_job_id: job.id,
      p_validation_errors: [],
    });
    expect(error?.code).toBe('22023');
    expect(getMockData('players').some((p) => p.external_registration_id === 'IS-4')).toBe(false);
  });
});

describe("the browser's create call", () => {
  const rpcSpy = () => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: 'job-1' }, error: null });
    return { rpc, supabase: { rpc } };
  };

  it('sends no season for the active season: the call keeps the shape it always had', async () => {
    const { rpc, supabase: client } = rpcSpy();
    await createImportJob({
      supabase: client,
      organizationId: 'org',
      type: 'players',
      fileName: 'a.csv',
    });
    expect(rpc).toHaveBeenCalledWith('create_import_job', {
      p_organization_id: 'org',
      p_import_type: 'players',
      p_file_name: 'a.csv',
    });
    expect(Object.keys(rpc.mock.calls[0][1])).not.toContain('p_season_settings_id');
  });

  it("sends the draft season's id when one is named", async () => {
    const { rpc, supabase: client } = rpcSpy();
    await createImportJob({
      supabase: client,
      organizationId: 'org',
      type: 'players',
      fileName: 'a.csv',
      seasonSettingsId: 'season-draft',
    });
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_season_settings_id: 'season-draft' });
  });
});
