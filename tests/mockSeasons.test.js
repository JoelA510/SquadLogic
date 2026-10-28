// The mock client's twin of migration 20261109010000 (plans docs/changes/2026-10-22-phase-e-seasons.md
// and docs/changes/2026-10-27-season-enrollment.md, Phase E3b): the four season writers follow the
// SQL's outcomes, refusals and audit rows (held to them by supabase/tests/season_rollover.sql and
// docs/sql/20261109010000_smoke.sql); a draft takes an import and leaves the active season's row
// untouched; a completed season is read-only for players and coaches.
import { beforeEach, describe, expect, it } from 'vitest';
import { getMockData, mockSupabase as supabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../frontend/src/lib/mockSeedIds.js';
import {
  ROLLOVER_DIVISION_SKIPPED,
  ROLLOVER_SEASON_COPIED,
  shiftYears,
  validCutoffDay,
} from '../frontend/src/lib/mockSeasons.js';

const OTHER_ORG = 'ms-other-org';
const OTHER_SEASON = 'ms-other-season';
const PROGRAM = 'ms-minis';
const U10 = 'ms-u10';
const U4 = 'ms-u4';

const rpc = (name, params) => supabase.rpc(name, params);
const auditRows = (action) => getMockData('audit_log').filter((r) => r.action === action);
const seasonByName = (name) => getMockData('season_settings').find((s) => s.name === name);

beforeEach(() => {
  sessionStorage.clear();
  window.__saveMockDB__({
    organizations: [{ id: OTHER_ORG, name: 'Other', is_onboarded: true }],
    organization_members: [
      { organization_id: OTHER_ORG, profile_id: 'other-admin', role: 'admin' },
    ],
    season_settings: [
      {
        id: MOCK_SEASON_ID,
        organization_id: MOCK_ORG_ID,
        name: 'Fall 2026',
        status: 'active',
        season_year: 2026,
        season_start: '2026-08-01',
        season_end: '2027-06-30',
        timezone: 'America/Los_Angeles',
        school_day_end: '15:30',
        age_cutoff_mode: 'custom',
        age_cutoff_month: 9,
        age_cutoff_day: 1,
        roster_formula: { minimum: 7 },
        daylight_adjustments: [{ date: '2026-11-01' }],
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: OTHER_SEASON,
        organization_id: OTHER_ORG,
        name: 'Other 2026',
        status: 'active',
        created_at: '2026-01-01T00:00:00Z',
      },
    ],
    programs: [
      {
        id: PROGRAM,
        organization_id: MOCK_ORG_ID,
        season_settings_id: MOCK_SEASON_ID,
        name: 'Minis',
        is_default: false,
        copied_from_program_id: null,
      },
    ],
    divisions: [
      {
        id: U10,
        organization_id: MOCK_ORG_ID,
        season_settings_id: MOCK_SEASON_ID,
        name: 'MS U10',
        gender_policy: 'girls',
        min_age: 9,
        max_age: 10,
        birthdate_start: '2015-09-01',
        birthdate_end: '2016-08-31',
        max_roster_size: 12,
        practices_per_week: 2,
        plays_games: false,
      },
      {
        id: U4,
        organization_id: MOCK_ORG_ID,
        season_settings_id: MOCK_SEASON_ID,
        name: 'MS U4',
        program_id: PROGRAM,
        min_age: 4,
        max_age: 4,
      },
    ],
    players: [
      {
        id: 'ms-p1',
        organization_id: MOCK_ORG_ID,
        season_settings_id: MOCK_SEASON_ID,
        division_id: U10,
        first_name: 'Pia',
        last_name: 'Active',
        external_registration_id: 'MS-1',
      },
    ],
    coaches: [
      {
        id: 'ms-c1',
        organization_id: MOCK_ORG_ID,
        season_settings_id: MOCK_SEASON_ID,
        full_name: 'Cora Active',
        email: 'cora@example.test',
        status: 'active',
      },
    ],
    audit_log: [],
  });
});

const create = (extra = {}) =>
  rpc('admin_create_season_from', {
    p_source_season_id: MOCK_SEASON_ID,
    p_name: '  Fall 2027  ',
    p_season_year: 2027,
    p_season_start: '2027-08-01',
    p_season_end: '2028-06-30',
    ...extra,
  });

describe('admin_create_season_from (mock)', () => {
  it('makes a draft with the source divisions and programs and no people, and audits it', async () => {
    // The mock seed's own divisions are in the source season too: all of them are copied.
    const sourceCount = getMockData('divisions').filter(
      (d) => d.season_settings_id === MOCK_SEASON_ID
    ).length;
    expect(sourceCount).toBeGreaterThanOrEqual(2);
    const { data, error } = await create();
    expect(error).toBeNull();
    expect(data).toMatchObject({
      status: 'draft',
      divisions_copied: sourceCount,
      programs_copied: 1,
    });
    const draft = seasonByName('Fall 2027');
    expect(draft).toMatchObject({
      status: 'draft',
      season_year: 2027,
      season_start: '2027-08-01',
      season_end: '2028-06-30',
      timezone: 'America/Los_Angeles',
      age_cutoff_mode: 'custom',
      age_cutoff_month: 9,
      age_cutoff_day: 1,
      school_day_end: '15:30',
      roster_formula: { minimum: 7 },
    });
    expect(draft.daylight_adjustments ?? []).toEqual([]);
    const divisions = getMockData('divisions').filter((d) => d.season_settings_id === draft.id);
    expect(divisions).toHaveLength(sourceCount);
    expect(divisions.map((d) => d.name)).toEqual(expect.arrayContaining(['MS U10', 'MS U4']));
    const source = getMockData('divisions').find((d) => d.id === U10);
    const copy = divisions.find((d) => d.name === 'MS U10');
    for (const [key, value] of Object.entries(source)) {
      if (ROLLOVER_DIVISION_SKIPPED.includes(key) || key.startsWith('birthdate')) continue;
      expect(copy[key], key).toEqual(value);
    }
    expect([copy.birthdate_start, copy.birthdate_end]).toEqual(['2016-09-01', '2017-08-31']);
    const programs = getMockData('programs').filter((p) => p.season_settings_id === draft.id);
    expect(programs.map((p) => p.name).sort()).toEqual(['Minis', 'No program']);
    expect(programs.filter((p) => p.is_default)).toHaveLength(1);
    const minis = programs.find((p) => p.name === 'Minis');
    expect(minis.copied_from_program_id).toBe(PROGRAM);
    expect(divisions.find((d) => d.name === 'MS U4').program_id).toBe(minis.id);
    expect(divisions.find((d) => d.name === 'MS U10').program_id).toBe(
      programs.find((p) => p.is_default).id
    );
    expect(getMockData('players').filter((p) => p.season_settings_id === draft.id)).toHaveLength(0);
    expect(getMockData('coaches').filter((c) => c.season_settings_id === draft.id)).toHaveLength(0);
    expect(getMockData('players').find((p) => p.id === 'ms-p1').season_settings_id).toBe(
      MOCK_SEASON_ID
    );
    expect(auditRows('season.created_from')).toHaveLength(1);
    expect(auditRows('season.created_from')[0].metadata).toMatchObject({
      source_season_id: MOCK_SEASON_ID,
      divisions_copied: sourceCount,
      programs_copied: 1,
      window_shift_years: 1,
    });
  });

  it('copies exactly the catalogue of season columns', async () => {
    await create();
    const draft = seasonByName('Fall 2027');
    const source = getMockData('season_settings').find((s) => s.id === MOCK_SEASON_ID);
    for (const column of ROLLOVER_SEASON_COPIED)
      expect(draft[column] ?? null, column).toEqual(source[column] ?? null);
  });

  it('moves a window by the difference in season years, and a source with no year by one', async () => {
    await create({ p_name: 'Fall 2028', p_season_year: 2028 });
    const two = getMockData('divisions').find(
      (d) => d.season_settings_id === seasonByName('Fall 2028').id && d.name === 'MS U10'
    );
    expect([two.birthdate_start, two.birthdate_end]).toEqual(['2017-09-01', '2018-08-31']);
    expect(shiftYears('2024-02-29', 1)).toBe('2025-02-28');
    expect(shiftYears(null, 1)).toBeNull();
  });

  it('refuses what the SQL refuses and leaves nothing behind', async () => {
    const before = getMockData('season_settings').length;
    const cases = [
      [{ p_source_season_id: undefined }, '23502'],
      [{ p_source_season_id: 'ms-ghost' }, '42501'],
      [{ p_source_season_id: OTHER_SEASON }, '42501'],
      [{ p_name: '   ' }, '22023'],
      [{ p_name: ' fall 2026 ' }, '23505'],
      [{ p_season_year: 1999 }, '22023', 'season_year_invalid'],
      [{ p_season_year: null }, '22023', 'season_year_invalid'],
      [
        { p_season_start: '2027-09-01', p_season_end: '2027-08-01' },
        '22023',
        'season_dates_invalid',
      ],
    ];
    for (const [extra, code, detail] of cases) {
      const { error } = await create(extra);
      expect(error?.code, JSON.stringify(extra)).toBe(code);
      if (detail) expect(error.details).toBe(detail);
    }
    expect(getMockData('season_settings')).toHaveLength(before);
    expect(auditRows('season.created_from')).toHaveLength(0);
  });

  it("refuses another organization's admin and nobody signed in", async () => {
    sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'other-admin' } }));
    expect((await create()).error?.code).toBe('42501');
  });
});

describe('admin_update_draft_season (mock)', () => {
  let draftId;
  beforeEach(async () => {
    draftId = (await create()).data.id;
  });
  const patch = (p_patch, id = draftId) =>
    rpc('admin_update_draft_season', { p_season_id: id, p_patch });

  it('patches name, dates, year and cutoff of a draft, clears with null, and audits old and new', async () => {
    const { data, error } = await patch({
      name: ' Fall 2027-28 ',
      season_end: null,
      age_cutoff_mode: 'birth_year',
    });
    expect(error).toBeNull();
    expect(data.changed).toBe(true);
    const row = getMockData('season_settings').find((s) => s.id === draftId);
    expect(row).toMatchObject({
      name: 'Fall 2027-28',
      season_end: null,
      age_cutoff_mode: 'birth_year',
      age_cutoff_month: null,
      age_cutoff_day: null,
    });
    const audit = auditRows('season.updated');
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata.changed.name).toEqual({ old: 'Fall 2027', new: 'Fall 2027-28' });
    expect(audit[0].metadata.changed).toHaveProperty('age_cutoff_month');
  });

  it('sets a custom day, and a repeat changes nothing and audits nothing', async () => {
    expect(
      (await patch({ age_cutoff_mode: 'custom', age_cutoff_month: 7, age_cutoff_day: 31 })).data
        .changed
    ).toBe(true);
    expect(
      (await patch({ age_cutoff_mode: 'custom', age_cutoff_month: 7, age_cutoff_day: 31 })).data
        .changed
    ).toBe(false);
    expect(auditRows('season.updated')).toHaveLength(1);
  });

  it('refuses each bad patch with the SQL code and detail', async () => {
    expect((await patch({ age_cutoff_mode: 'birth_year' })).error).toBeNull();
    const bad = [
      [{ age_cutoff_mode: 'custom' }, '22023', 'cutoff_day_missing'],
      [
        { age_cutoff_mode: 'custom', age_cutoff_month: 13, age_cutoff_day: 1 },
        '22023',
        'cutoff_day_invalid',
      ],
      [
        { age_cutoff_mode: 'custom', age_cutoff_month: 2, age_cutoff_day: 30 },
        '22023',
        'cutoff_day_invalid',
      ],
      [{ age_cutoff_mode: 'lunar' }, '22023'],
      [{ status: 'active' }, '22023'],
      [{ season_start: 'not a date' }, '22023'],
      [{ season_start: '2028-01-01', season_end: '2027-01-01' }, '22023', 'season_dates_invalid'],
      [{ season_year: 1800 }, '22023', 'season_year_invalid'],
      [{ name: null }, '22023'],
      [{ name: 'fall 2026' }, '23505'],
    ];
    for (const [p, code, detail] of bad) {
      const { error } = await patch(p);
      expect(error?.code, JSON.stringify(p)).toBe(code);
      if (detail) expect(error.details, JSON.stringify(p)).toBe(detail);
    }
    expect((await patch([])).error?.code).toBe('22023');
    expect(auditRows('season.updated')).toHaveLength(1); // only the switch to the calendar year
  });

  it('lets the active season change its name and dates and not its cutoff or year', async () => {
    expect(
      (await patch({ name: 'Fall 2026 (renamed)', season_end: '2027-07-15' }, MOCK_SEASON_ID)).error
    ).toBeNull();
    const cutoff = await patch({ age_cutoff_mode: 'birth_year' }, MOCK_SEASON_ID);
    expect(cutoff.error).toMatchObject({ code: '22023', details: 'season_not_draft' });
    const year = await patch({ season_year: 2027 }, MOCK_SEASON_ID);
    expect(year.error).toMatchObject({ code: '22023', details: 'season_not_draft' });
    expect((await patch({ season_year: 2026 }, MOCK_SEASON_ID)).error).toBeNull();
  });

  it('refuses the cutoff and year of a draft that has players, and still takes its name', async () => {
    window.__saveMockDB__({
      ...window.__MOCK_DB__,
      players: [
        ...getMockData('players'),
        {
          id: 'ms-p2',
          organization_id: MOCK_ORG_ID,
          season_settings_id: draftId,
          first_name: 'X',
          last_name: 'Y',
        },
      ],
    });
    const { error } = await patch({ age_cutoff_mode: 'birth_year' });
    expect(error).toMatchObject({ code: '22023', details: 'season_has_players' });
    expect((await patch({ season_year: 2028 })).error?.details).toBe('season_has_players');
    expect((await patch({ name: 'Renamed draft' })).error).toBeNull();
  });

  it('refuses a completed season and another organization', async () => {
    window.__saveMockDB__({
      ...window.__MOCK_DB__,
      season_settings: getMockData('season_settings').map((s) =>
        s.id === draftId ? { ...s, status: 'completed' } : s
      ),
    });
    expect((await patch({ name: 'x' })).error).toMatchObject({
      code: '22023',
      details: 'season_completed',
    });
    sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'other-admin' } }));
    expect((await patch({ name: 'x' }, MOCK_SEASON_ID)).error?.code).toBe('42501');
  });
});

describe('admin_set_division_birthdate_window (mock)', () => {
  let draftU4;
  beforeEach(async () => {
    const id = (await create()).data.id;
    draftU4 = getMockData('divisions').find(
      (d) => d.season_settings_id === id && d.name === 'MS U4'
    ).id;
  });
  const window_ = (id, start, end) =>
    rpc('admin_set_division_birthdate_window', {
      p_division_id: id,
      p_birthdate_start: start,
      p_birthdate_end: end,
    });

  it('sets, repeats and clears a window of a draft division, auditing the changes', async () => {
    expect((await window_(draftU4, '2023-01-01', '2024-07-31')).data.changed).toBe(true);
    expect((await window_(draftU4, '2023-01-01', '2024-07-31')).data.changed).toBe(false);
    expect((await window_(draftU4, null, null)).data.changed).toBe(true);
    const audit = auditRows('division.window_changed');
    expect(audit).toHaveLength(2);
    expect(audit[0].metadata).toMatchObject({ new_start: '2023-01-01', new_end: '2024-07-31' });
  });

  it('refuses half a window, an inverted one, a division of a season with players, and a completed season', async () => {
    expect((await window_(draftU4, '2023-01-01', null)).error?.details).toBe('window_incomplete');
    expect((await window_(draftU4, '2024-01-01', '2023-01-01')).error?.details).toBe(
      'window_invalid'
    );
    expect((await window_(U4, '2023-01-01', '2024-07-31')).error).toMatchObject({
      code: '22023',
      details: 'season_has_players',
    });
    window.__saveMockDB__({
      ...window.__MOCK_DB__,
      season_settings: getMockData('season_settings').map((s) =>
        s.id === MOCK_SEASON_ID ? { ...s, status: 'completed' } : s
      ),
    });
    expect((await window_(U4, null, null)).error?.details).toBe('season_completed');
    expect(auditRows('division.window_changed')).toHaveLength(0);
  });
});

describe('admin_activate_season (mock)', () => {
  let draftId;
  beforeEach(async () => {
    draftId = (await create()).data.id;
  });
  const activate = (id = draftId) => rpc('admin_activate_season', { p_season_id: id });
  const setDraft = (patch) =>
    window.__saveMockDB__({
      ...window.__MOCK_DB__,
      season_settings: getMockData('season_settings').map((s) =>
        s.id === draftId ? { ...s, ...patch } : s
      ),
    });

  it('refuses a draft with no timezone, dates or year, leaving it a draft', async () => {
    setDraft({ season_start: null });
    expect((await activate()).error?.details).toBe('season_dates_missing');
    setDraft({ season_start: '2027-08-01', timezone: null });
    expect((await activate()).error?.details).toBe('season_timezone_missing');
    setDraft({ timezone: 'Mars/Olympus' });
    expect((await activate()).error?.details).toBe('season_timezone_missing');
    setDraft({ timezone: 'America/Denver', season_end: '2027-01-01' });
    expect((await activate()).error?.details).toBe('season_dates_invalid');
    setDraft({ season_end: '2028-06-30', season_year: null });
    expect((await activate()).error?.details).toBe('season_year_missing');
    expect(getMockData('season_settings').find((s) => s.id === draftId).status).toBe('draft');
    expect(auditRows('season.activated')).toHaveLength(0);
  });

  it('activates the draft, completes the previous active season and audits it', async () => {
    const { data, error } = await activate();
    expect(error).toBeNull();
    expect(data.previous_active_season_id).toBe(MOCK_SEASON_ID);
    const seasons = getMockData('season_settings').filter((s) => s.organization_id === MOCK_ORG_ID);
    expect(seasons.map((s) => `${s.id === draftId ? 'draft' : 'old'}=${s.status}`).sort()).toEqual([
      'draft=active',
      'old=completed',
    ]);
    expect(auditRows('season.activated')[0].metadata.previous_active_season_id).toBe(
      MOCK_SEASON_ID
    );
  });

  it('never reactivates a completed season, nor an active one', async () => {
    await activate();
    expect((await activate(MOCK_SEASON_ID)).error?.details).toBe('season_completed');
    expect((await activate()).error?.details).toBe('season_not_draft');
  });

  it("refuses another organization's admin", async () => {
    sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'other-admin' } }));
    expect((await activate()).error?.code).toBe('42501');
  });
});

describe('a draft takes an import; a completed season is read-only', () => {
  it('imports into a draft without touching the active season’s row, for players and coaches', async () => {
    const draftId = (await create()).data.id;
    const { data: job } = await rpc('create_import_job', {
      p_organization_id: MOCK_ORG_ID,
      p_import_type: 'players',
      p_file_name: 'draft.csv',
      p_season_settings_id: draftId,
    });
    const { data: cjob } = await rpc('create_import_job', {
      p_organization_id: MOCK_ORG_ID,
      p_import_type: 'coaches',
      p_file_name: 'draft-coaches.csv',
      p_season_settings_id: draftId,
    });
    window.__saveMockDB__({
      ...window.__MOCK_DB__,
      staging_players: [
        {
          id: 'ms-sp1',
          organization_id: MOCK_ORG_ID,
          import_job_id: job.id,
          source_row_number: 1,
          raw_payload: {},
          normalized_payload: {
            first_name: 'Pia',
            last_name: 'Draft',
            external_registration_id: 'MS-1',
            division: 'MS U10',
          },
          validation_errors: [],
        },
      ],
      staging_import_rows: [
        {
          id: 'ms-sc1',
          organization_id: MOCK_ORG_ID,
          import_job_id: cjob.id,
          import_type: 'coaches',
          source_row_number: 1,
          raw_payload: {},
          normalized_payload: { full_name: 'Cora Draft', email: 'cora@example.test' },
          validation_errors: [],
        },
      ],
    });
    const activeBefore = JSON.stringify(getMockData('players').find((p) => p.id === 'ms-p1'));
    const coachBefore = JSON.stringify(getMockData('coaches').find((c) => c.id === 'ms-c1'));
    const players = await rpc('finalize_import_job', {
      p_import_job_id: job.id,
      p_validation_errors: [],
    });
    const coaches = await rpc('finalize_coach_import_job', {
      p_import_job_id: cjob.id,
      p_validation_errors: [],
    });
    expect(players.error).toBeNull();
    expect(coaches.error).toBeNull();
    expect(JSON.stringify(getMockData('players').find((p) => p.id === 'ms-p1'))).toBe(activeBefore);
    expect(JSON.stringify(getMockData('coaches').find((c) => c.id === 'ms-c1'))).toBe(coachBefore);
    const mine = getMockData('players').filter((p) => p.external_registration_id === 'MS-1');
    expect(mine.map((p) => p.season_settings_id).sort()).toEqual([MOCK_SEASON_ID, draftId].sort());
    expect(getMockData('coaches').filter((c) => c.email === 'cora@example.test')).toHaveLength(2);
    // Once the draft has players its rule is fixed.
    const locked = await rpc('admin_update_draft_season', {
      p_season_id: draftId,
      p_patch: { age_cutoff_mode: 'birth_year' },
    });
    expect(locked.error?.details).toBe('season_has_players');
  });

  it('refuses a patch, a bulk patch, a delete and a coach change in a completed season', async () => {
    const draftId = (await create()).data.id;
    await rpc('admin_activate_season', { p_season_id: draftId });
    // The coach writers read the signed-in member from the session.
    sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'mock-admin-id' } }));
    const results = [
      await rpc('admin_update_player', { p_player_id: 'ms-p1', p_patch: { notes: 'late' } }),
      await rpc('admin_bulk_update_players', {
        p_player_ids: ['ms-p1'],
        p_patch: { notes: 'late' },
      }),
      await rpc('admin_delete_players', { p_player_ids: ['ms-p1'] }),
      await rpc('admin_update_coach_status', {
        p_organization_id: MOCK_ORG_ID,
        p_coach_id: 'ms-c1',
        p_status: 'inactive',
      }),
      await rpc('admin_delete_coaches', { p_coach_ids: ['ms-c1'] }),
    ];
    for (const result of results) {
      expect(result.error).toMatchObject({ code: '22023', details: 'season_completed' });
    }
    expect(getMockData('players').find((p) => p.id === 'ms-p1')).toBeTruthy();
    expect(getMockData('coaches').find((c) => c.id === 'ms-c1').status).toBe('active');
  });
});

describe('a player import in progress fixes the rule (mock of season_has_pending_player_import)', () => {
  let draftId;
  let draftU4;
  beforeEach(async () => {
    draftId = (await create()).data.id;
    draftU4 = getMockData('divisions').find(
      (d) => d.season_settings_id === draftId && d.name === 'MS U4'
    ).id;
  });
  const job = (extra = {}) => ({
    id: 'ms-job',
    organization_id: MOCK_ORG_ID,
    season_settings_id: draftId,
    job_type: 'registration',
    status: 'ready_to_apply',
    ...extra,
  });
  const staged = (extra = {}) => ({
    id: 'ms-staged',
    import_job_id: 'ms-job',
    promoted_at: null,
    ...extra,
  });
  const seed = (jobs, rows) =>
    window.__saveMockDB__({ ...window.__MOCK_DB__, import_jobs: jobs, staging_players: rows });
  const cutoff = () =>
    rpc('admin_update_draft_season', {
      p_season_id: draftId,
      p_patch: { age_cutoff_mode: 'birth_year' },
    });
  const window_ = () =>
    rpc('admin_set_division_birthdate_window', {
      p_division_id: draftU4,
      p_birthdate_start: '2023-01-01',
      p_birthdate_end: '2023-07-31',
    });

  it('refuses a cutoff, year and window change while staged rows are waiting, and still takes a name', async () => {
    seed([job()], [staged()]);
    expect((await cutoff()).error).toMatchObject({ code: '22023', details: 'import_pending' });
    expect(
      (
        await rpc('admin_update_draft_season', {
          p_season_id: draftId,
          p_patch: { season_year: 2028 },
        })
      ).error?.details
    ).toBe('import_pending');
    expect((await window_()).error).toMatchObject({ code: '22023', details: 'import_pending' });
    expect(
      (
        await rpc('admin_update_draft_season', {
          p_season_id: draftId,
          p_patch: { name: 'Renamed draft' },
        })
      ).error
    ).toBeNull();
    // Nothing moved, and nothing was audited for the refusals.
    expect(getMockData('season_settings').find((s) => s.id === draftId).age_cutoff_mode).toBe(
      'custom'
    );
    expect(auditRows('division.window_changed')).toHaveLength(0);
  });

  it('allows the change once the job is cancelled, applied or has nothing staged', async () => {
    for (const [jobs, rows] of [
      [[job({ status: 'failed' })], [staged()]], // cancelled
      [[job({ status: 'completed' })], [staged()]],
      [[job()], [staged({ promoted_at: '2026-10-28T00:00:00Z' })]], // every row applied
      [[job()], []], // nothing staged yet
      [[job({ job_type: 'fields' })], [staged()]],
      [[job({ season_settings_id: MOCK_SEASON_ID })], [staged()]], // the active season's job
    ]) {
      seed(jobs, rows);
      expect((await cutoff()).error).toBeNull();
      await rpc('admin_update_draft_season', {
        p_season_id: draftId,
        p_patch: { age_cutoff_mode: 'custom', age_cutoff_month: 9, age_cutoff_day: 1 },
      });
    }
  });

  it('counts a legacy job with no season against the active season', async () => {
    seed([job({ season_settings_id: null })], [staged()]);
    expect(
      (
        await rpc('admin_update_draft_season', {
          p_season_id: MOCK_SEASON_ID,
          p_patch: { name: 'Fall 2026 renamed' },
        })
      ).error
    ).toBeNull();
    // The draft is not that job's season.
    expect((await cutoff()).error).toBeNull();
  });
});

describe('a file is checked under one rule (mock of import_age_rule and age_rule_changed)', () => {
  let draftId;
  let jobId;
  const validate = (rows, row_offset) =>
    supabase.functions.invoke('import-validation', {
      body: {
        import_type: 'players',
        organization_id: MOCK_ORG_ID,
        rows,
        import_job_id: jobId,
        row_offset,
      },
    });
  const player = (n) => ({
    first_name: `Zed${n}`,
    last_name: 'Stamp',
    date_of_birth: '2018-05-01',
    external_registration_id: `ST-${n}`,
  });
  const job = () => getMockData('import_jobs').find((j) => j.id === jobId);
  const season = () => getMockData('season_settings').find((s) => s.id === draftId);
  // The draft copies the active season's custom cutoff, September 1.
  const cutoff = (month) =>
    rpc('admin_update_draft_season', {
      p_season_id: draftId,
      p_patch: { age_cutoff_mode: 'custom', age_cutoff_month: month, age_cutoff_day: 1 },
    });
  const finalize = () =>
    rpc('finalize_import_job', { p_import_job_id: jobId, p_validation_errors: [] });
  beforeEach(async () => {
    draftId = (await create()).data.id;
    ({
      data: { id: jobId },
    } = await rpc('create_import_job', {
      p_organization_id: MOCK_ORG_ID,
      p_import_type: 'players',
      p_file_name: 'stamp.csv',
      p_season_settings_id: draftId,
    }));
  });

  it('stamps the job with the season and its revision on the first batch, keeps it on a later one, and takes a new one when the file is validated again', async () => {
    expect(job().age_rule_revision ?? null).toBeNull();
    await validate([], 0);
    const first = job().age_rule_revision;
    expect(first).toBe(Number(season().age_rule_revision ?? 0));
    expect(job().age_rule_season_id).toBe(draftId);
    expect((await cutoff(3)).error).toBeNull();
    expect(Number(season().age_rule_revision)).toBe(first + 1);
    await validate([], 5000);
    expect(job().age_rule_revision).toBe(first);
    await validate([], 0);
    expect(job().age_rule_revision).toBe(first + 1);
  });

  it('refuses a file whose rule changed between the stamp and the first staged row, and applies it once validated again', async () => {
    await validate([], 0); // the stamp, taken with the rule read
    expect((await cutoff(3)).error).toBeNull(); // nothing is staged yet, so the rule changes
    await validate([player(1)], 1); // a later batch: staged under the new rule, the stamp stays
    const refused = await finalize();
    expect(refused.error).toMatchObject({ code: '22023', details: 'age_rule_changed' });
    expect(getMockData('players').filter((p) => p.season_settings_id === draftId)).toHaveLength(0);
    expect(job().status).toBe('importing');

    await validate([player(1)], 0); // validated again
    const applied = await finalize();
    expect(applied.error).toBeNull();
    expect(applied.data.inserted_players).toBe(1);
  });

  it('refuses a file whose rule was changed and changed back (A, B, A): the values look the same, the revision does not', async () => {
    await validate([], 0);
    const before = { ...season() };
    expect((await cutoff(3)).error).toBeNull();
    expect((await cutoff(9)).error).toBeNull();
    expect(season().age_cutoff_month).toBe(before.age_cutoff_month);
    expect(season().age_cutoff_mode).toBe(before.age_cutoff_mode);
    expect(Number(season().age_rule_revision)).toBe(Number(before.age_rule_revision ?? 0) + 2);
    await validate([player(1)], 1);
    expect((await finalize()).error).toMatchObject({ code: '22023', details: 'age_rule_changed' });
  });

  it('applies a file whose rule did not change, and a job with no stamp whatever the rule did', async () => {
    await validate([player(1)], 0);
    expect((await finalize()).error).toBeNull();

    const { data: legacy } = await rpc('create_import_job', {
      p_organization_id: MOCK_ORG_ID,
      p_import_type: 'players',
      p_file_name: 'legacy.csv',
      p_season_settings_id: (await create({ p_name: 'Legacy Draft', p_season_year: 2029 })).data.id,
    });
    window.__saveMockDB__({
      ...window.__MOCK_DB__,
      staging_players: [
        ...getMockData('staging_players'),
        {
          id: 'ms-legacy',
          organization_id: MOCK_ORG_ID,
          import_job_id: legacy.id,
          source_row_number: 1,
          raw_payload: {},
          normalized_payload: {
            first_name: 'Old',
            last_name: 'File',
            external_registration_id: 'LG-1',
          },
          validation_errors: [],
        },
      ],
    });
    expect(
      getMockData('import_jobs').find((j) => j.id === legacy.id).age_rule_revision ?? null
    ).toBeNull();
    const result = await rpc('finalize_import_job', {
      p_import_job_id: legacy.id,
      p_validation_errors: [],
    });
    expect(result.error).toBeNull();
  });

  it('moves the revision with a window, and refuses a band change on a window-bearing division once the season has players or an import is pending', async () => {
    const u4 = getMockData('divisions').find(
      (d) => d.season_settings_id === draftId && d.name === 'MS U4'
    );
    const bandCall = (extra) =>
      rpc('upsert_division_for_import', {
        p_organization_id: MOCK_ORG_ID,
        p_season_settings_id: draftId,
        p_name: 'MS U4',
        ...extra,
      });
    const revision = () => Number(season().age_rule_revision ?? 0);
    const r0 = revision();
    // No window: the band moves freely and the revision does not.
    expect((await bandCall({ p_min_age: 4, p_max_age: 5 })).error).toBeNull();
    expect(revision()).toBe(r0);
    // A window goes on (the writer bumps), then the band bears on ages.
    expect(
      (
        await rpc('admin_set_division_birthdate_window', {
          p_division_id: u4.id,
          p_birthdate_start: '2023-01-01',
          p_birthdate_end: '2024-07-31',
        })
      ).error
    ).toBeNull();
    expect(revision()).toBe(r0 + 1);
    expect((await bandCall({})).error).toBeNull(); // asks for no change
    expect(revision()).toBe(r0 + 1);
    expect((await bandCall({ p_min_age: 4, p_max_age: 4 })).error).toBeNull();
    expect(revision()).toBe(r0 + 2);

    // A pending import fixes the band.
    window.__saveMockDB__({
      ...window.__MOCK_DB__,
      staging_players: [
        {
          id: 'ms-band',
          organization_id: MOCK_ORG_ID,
          import_job_id: jobId,
          source_row_number: 1,
          raw_payload: {},
          normalized_payload: {},
          validation_errors: [],
        },
      ],
    });
    expect((await bandCall({ p_max_age: 6 })).error).toMatchObject({
      code: '22023',
      details: 'import_pending',
    });
    // Players fix it too.
    window.__saveMockDB__({
      ...window.__MOCK_DB__,
      staging_players: [],
      players: [
        ...getMockData('players'),
        {
          id: 'ms-band-p',
          organization_id: MOCK_ORG_ID,
          season_settings_id: draftId,
          first_name: 'B',
          last_name: 'P',
        },
      ],
    });
    expect((await bandCall({ p_max_age: 6 })).error).toMatchObject({
      code: '22023',
      details: 'season_has_players',
    });
    expect(revision()).toBe(r0 + 2);
  });
});

describe('a completed season is read-only for its schedule (mock of the schedule triggers)', () => {
  const TEAM = 'ms-team-old';
  const LIVE_TEAM = 'ms-team-live';
  const OLD = 'ms-season-old';
  const OLD_DIVISION = 'ms-division-old';
  beforeEach(() => {
    window.__saveMockDB__({
      ...window.__MOCK_DB__,
      season_settings: [
        ...getMockData('season_settings'),
        { id: OLD, organization_id: MOCK_ORG_ID, name: 'Spring 2025', status: 'completed' },
      ],
      divisions: [
        ...getMockData('divisions'),
        {
          id: OLD_DIVISION,
          organization_id: MOCK_ORG_ID,
          season_settings_id: OLD,
          name: 'MS Old U10',
        },
      ],
      teams: [
        { id: TEAM, organization_id: MOCK_ORG_ID, division_id: OLD_DIVISION, name: 'Old' },
        { id: LIVE_TEAM, organization_id: MOCK_ORG_ID, division_id: U10, name: 'Live' },
      ],
      team_players: [
        { team_id: TEAM, player_id: 'ms-p1', organization_id: MOCK_ORG_ID },
        { team_id: LIVE_TEAM, player_id: 'ms-p1', organization_id: MOCK_ORG_ID },
      ],
      practice_assignments: [
        { id: 'ms-pa-old', organization_id: MOCK_ORG_ID, team_id: TEAM },
        { id: 'ms-pa-live', organization_id: MOCK_ORG_ID, team_id: LIVE_TEAM },
      ],
      practice_exceptions: [
        {
          id: 'ms-px-old',
          organization_id: MOCK_ORG_ID,
          season_settings_id: OLD,
          team_id: TEAM,
        },
      ],
      schedule_tbd: [
        {
          id: 'ms-tbd-old',
          organization_id: MOCK_ORG_ID,
          season_settings_id: OLD,
          kind: 'practice',
          team_id: TEAM,
        },
        {
          id: 'ms-tbd-live',
          organization_id: MOCK_ORG_ID,
          season_settings_id: MOCK_SEASON_ID,
          kind: 'practice',
          team_id: LIVE_TEAM,
        },
      ],
      game_assignments: [
        {
          id: 'ms-ga-old',
          organization_id: MOCK_ORG_ID,
          home_team_id: TEAM,
          away_team_id: null,
        },
        {
          id: 'ms-ga-live',
          organization_id: MOCK_ORG_ID,
          home_team_id: LIVE_TEAM,
          away_team_id: null,
        },
      ],
    });
    sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'mock-admin-id' } }));
  });
  const refused = { code: '22023', details: 'season_completed' };

  it('refuses each writer RPC on a completed season’s team or assignment, and allows the active one', async () => {
    const results = [
      await rpc('admin_update_team', { p_team_id: TEAM, p_patch: { notes: 'late' } }),
      await rpc('admin_delete_team', { p_team_id: TEAM }),
      await rpc('admin_cancel_practice_assignment', { p_assignment_id: 'ms-pa-old' }),
      await rpc('admin_cancel_game_assignment', { p_assignment_id: 'ms-ga-old' }),
      await rpc('admin_assign_team_coach', {
        p_organization_id: MOCK_ORG_ID,
        p_team_id: TEAM,
        p_coach_id: null,
      }),
    ];
    for (const result of results) expect(result.error).toMatchObject(refused);
    expect(getMockData('teams').map((t) => t.id)).toContain(TEAM);
    expect(getMockData('practice_assignments').map((a) => a.id)).toContain('ms-pa-old');
    expect(getMockData('game_assignments').map((a) => a.id)).toContain('ms-ga-old');

    expect(
      (await rpc('admin_update_team', { p_team_id: LIVE_TEAM, p_patch: { notes: 'ok' } })).error
    ).toBeNull();
    expect(
      (await rpc('admin_cancel_practice_assignment', { p_assignment_id: 'ms-pa-live' })).error
    ).toBeNull();
    expect(
      (await rpc('admin_cancel_game_assignment', { p_assignment_id: 'ms-ga-live' })).error
    ).toBeNull();
  });

  it('refuses a direct write to each of the six tables, and allows the active season’s', async () => {
    const write = async (table, run) => (await run(supabase.from(table))).error;
    expect(
      await write('teams', (t) =>
        t.insert({ organization_id: MOCK_ORG_ID, division_id: OLD_DIVISION, name: 'Late' })
      )
    ).toMatchObject(refused);
    expect(await write('teams', (t) => t.update({ notes: 'late' }).eq('id', TEAM))).toMatchObject(
      refused
    );
    // A move into the completed season, and out of it.
    expect(
      await write('teams', (t) => t.update({ division_id: OLD_DIVISION }).eq('id', LIVE_TEAM))
    ).toMatchObject(refused);
    expect(
      await write('teams', (t) => t.update({ division_id: U10 }).eq('id', TEAM))
    ).toMatchObject(refused);
    expect(await write('teams', (t) => t.delete().eq('id', TEAM))).toMatchObject(refused);
    expect(
      await write('team_players', (t) => t.insert({ team_id: TEAM, player_id: 'ms-p2' }))
    ).toMatchObject(refused);
    expect(await write('team_players', (t) => t.delete().eq('team_id', TEAM))).toMatchObject(
      refused
    );
    expect(
      await write('team_coach_assignments', (t) =>
        t.upsert({ id: 'ms-tca', organization_id: MOCK_ORG_ID, team_id: TEAM })
      )
    ).toMatchObject(refused);
    expect(
      await write('practice_assignments', (t) => t.delete().eq('id', 'ms-pa-old'))
    ).toMatchObject(refused);
    expect(
      await write('practice_exceptions', (t) => t.update({ note: 'late' }).eq('id', 'ms-px-old'))
    ).toMatchObject(refused);
    expect(
      await write('game_assignments', (t) => t.update({ field_id: 'x' }).eq('id', 'ms-ga-old'))
    ).toMatchObject(refused);
    expect(getMockData('teams').find((t) => t.id === TEAM).notes).toBeUndefined();
    expect(getMockData('team_players').filter((r) => r.team_id === TEAM)).toHaveLength(1);

    // The TIME TBD list is a schedule table too.
    expect(
      await write('schedule_tbd', (t) => t.update({ reason: 'late' }).eq('id', 'ms-tbd-old'))
    ).toMatchObject(refused);
    expect(await write('schedule_tbd', (t) => t.delete().eq('id', 'ms-tbd-old'))).toMatchObject(
      refused
    );
    expect(
      await write('schedule_tbd', (t) => t.update({ reason: 'live' }).eq('id', 'ms-tbd-live'))
    ).toBeNull();
    // The active season's rows take the same writes.
    expect(await write('teams', (t) => t.update({ notes: 'ok' }).eq('id', LIVE_TEAM))).toBeNull();
    expect(
      await write('team_players', (t) =>
        t.insert({ team_id: LIVE_TEAM, player_id: 'ms-p2', organization_id: MOCK_ORG_ID })
      )
    ).toBeNull();
    expect(
      await write('game_assignments', (t) => t.update({ field_id: 'x' }).eq('id', 'ms-ga-live'))
    ).toBeNull();
    // A table that is not a schedule table is untouched by the rule.
    expect(await write('players', (t) => t.update({ notes: 'ok' }).eq('id', 'ms-p1'))).toBeNull();
  });
});

describe('the cutoff day check', () => {
  it('accepts a real calendar day and February 29', () => {
    expect(validCutoffDay(9, 1)).toBe(true);
    expect(validCutoffDay(2, 29)).toBe(true);
    expect(validCutoffDay(2, 30)).toBe(false);
    expect(validCutoffDay(4, 31)).toBe(false);
    expect(validCutoffDay(13, 1)).toBe(false);
    expect(validCutoffDay(1, 0)).toBe(false);
    expect(validCutoffDay(null, 1)).toBe(false);
  });
});
