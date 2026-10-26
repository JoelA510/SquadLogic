// The mock client's twin of migration 20261101020000 (plan
// docs/changes/2026-10-22-phase-e-seasons.md, E2; owner rules 2026-10-26): every season has one
// default program ("No program"), every division is in a program of its own season, and the four
// writers follow the SQL's refusals and audit rows. Programs are optional: an organization that
// never makes one imports, forms teams and schedules as before, and the grouping helper shows
// nothing to group.
import { beforeEach, describe, expect, it } from 'vitest';
import { getMockData, mockSupabase as supabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../frontend/src/lib/mockSeedIds.js';
import { defaultProgramIdFor, normalizePrograms } from '../frontend/src/lib/mockPrograms.js';
import { groupByProgram } from '../frontend/src/utils/programGroups.js';

const OTHER_ORG = 'prog-other-org';
const DRAFT = 'prog-draft-season';
const DONE = 'prog-done-season';
const OTHER_SEASON = 'prog-other-season';

const setSession = (userId) =>
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: userId } }));

const season = (id, org, name, status) => ({
  id,
  organization_id: org,
  name,
  status,
  created_at: '2026-01-01T00:00:00Z',
});
const division = (id, org, seasonId, name) => ({
  id,
  organization_id: org,
  season_settings_id: seasonId,
  name,
  gender_policy: 'coed',
});

beforeEach(() => {
  sessionStorage.clear();
  window.__saveMockDB__({
    organizations: [{ id: OTHER_ORG, name: 'Other', is_onboarded: true }],
    organization_members: [
      { organization_id: OTHER_ORG, profile_id: 'other-admin', role: 'admin' },
      { organization_id: MOCK_ORG_ID, profile_id: 'mock-coach-id', role: 'coach' },
    ],
    season_settings: [
      season(DRAFT, MOCK_ORG_ID, 'Draft 2027', 'draft'),
      season(DONE, MOCK_ORG_ID, 'Done 2025', 'completed'),
      season(OTHER_SEASON, OTHER_ORG, 'Other 2026', 'active'),
    ],
    divisions: [
      division('p-u7b', MOCK_ORG_ID, MOCK_SEASON_ID, 'P U7B'),
      division('p-u7g', MOCK_ORG_ID, MOCK_SEASON_ID, 'P U7G'),
      division('p-u8b', MOCK_ORG_ID, MOCK_SEASON_ID, 'P U8B'),
      division('p-draft', MOCK_ORG_ID, DRAFT, 'Draft U7B'),
      division('p-done', MOCK_ORG_ID, DONE, 'Done U7B'),
      division('p-other', OTHER_ORG, OTHER_SEASON, 'Other U9B'),
    ],
  });
});

const programsOf = (seasonId) =>
  getMockData('programs').filter((p) => p.season_settings_id === seasonId);
const programOf = (divisionId) => {
  const d = getMockData('divisions').find((x) => x.id === divisionId);
  return getMockData('programs').find((p) => p.id === d.program_id);
};
const idByName = (seasonId, name) => programsOf(seasonId).find((p) => p.name === name)?.id;
const auditRows = (action) => getMockData('audit_log').filter((r) => r.action === action);
const rpc = (name, params) => supabase.rpc(name, params);

describe('the default program and the division rule', () => {
  it('gives every season exactly one default program, "No program"', () => {
    for (const s of getMockData('season_settings')) {
      const defaults = programsOf(s.id).filter((p) => p.is_default);
      expect(defaults, s.name).toHaveLength(1);
      expect(defaults[0].name).toBe('No program');
    }
  });

  it('puts every division in a program of its own season, the default when it names none', () => {
    for (const d of getMockData('divisions')) {
      const p = programOf(d.id);
      expect(p?.season_settings_id, d.name).toBe(d.season_settings_id);
      expect(p.is_default, d.name).toBe(true);
    }
  });

  it("moves a division whose program is another season's back to its own default", () => {
    const db = {
      season_settings: [season('a', 'o', 'A', 'active'), season('b', 'o', 'B', 'draft')],
      divisions: [{ id: 'd', season_settings_id: 'a', program_id: defaultProgramIdFor('b') }],
      programs: [],
    };
    normalizePrograms(db);
    expect(db.divisions[0].program_id).toBe(defaultProgramIdFor('a'));
  });

  it('is stable: normalizing twice adds nothing', () => {
    const db = { season_settings: [season('a', 'o', 'A', 'active')], divisions: [], programs: [] };
    normalizePrograms(db);
    normalizePrograms(db);
    expect(db.programs).toHaveLength(1);
  });
});

describe('admin_upsert_program', () => {
  it('creates a program (trimmed) and audits it: created, no old name, the new name', async () => {
    const { data, error } = await rpc('admin_upsert_program', {
      p_season_id: MOCK_SEASON_ID,
      p_id: null,
      p_name: '  Junior ',
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({ name: 'Junior', is_default: false, changed: true });
    expect(auditRows('program.upserted')).toHaveLength(1);
    expect(auditRows('program.upserted')[0].metadata).toMatchObject({
      operation: 'created',
      old_name: null,
      new_name: 'Junior',
    });
  });

  it("refuses a duplicate name ignoring case and padding (23505), the default's name included", async () => {
    await rpc('admin_upsert_program', {
      p_season_id: MOCK_SEASON_ID,
      p_id: null,
      p_name: 'Junior',
    });
    const dup = await rpc('admin_upsert_program', {
      p_season_id: MOCK_SEASON_ID,
      p_id: null,
      p_name: ' JUNIOR',
    });
    expect(dup.error?.code).toBe('23505');
    const dflt = await rpc('admin_upsert_program', {
      p_season_id: MOCK_SEASON_ID,
      p_id: null,
      p_name: 'no program',
    });
    expect(dflt.error?.code).toBe('23505');
    expect(auditRows('program.upserted')).toHaveLength(1);
  });

  it('allows the same name in another season', async () => {
    await rpc('admin_upsert_program', {
      p_season_id: MOCK_SEASON_ID,
      p_id: null,
      p_name: 'Junior',
    });
    const { error } = await rpc('admin_upsert_program', {
      p_season_id: DRAFT,
      p_id: null,
      p_name: 'Junior',
    });
    expect(error).toBeNull();
  });

  it('renames, auditing the old and the new name; the same name changes and audits nothing', async () => {
    await rpc('admin_upsert_program', { p_season_id: MOCK_SEASON_ID, p_id: null, p_name: 'Micro' });
    const id = idByName(MOCK_SEASON_ID, 'Micro');
    const renamed = await rpc('admin_upsert_program', {
      p_season_id: MOCK_SEASON_ID,
      p_id: id,
      p_name: 'Mini',
    });
    expect(renamed.data).toMatchObject({ name: 'Mini', changed: true });
    expect(auditRows('program.upserted').at(-1).metadata).toMatchObject({
      operation: 'updated',
      old_name: 'Micro',
      new_name: 'Mini',
    });
    const same = await rpc('admin_upsert_program', {
      p_season_id: MOCK_SEASON_ID,
      p_id: id,
      p_name: 'Mini',
    });
    expect(same.data.changed).toBe(false);
    expect(auditRows('program.upserted')).toHaveLength(2);
  });

  it('refuses to rename the default (22023) and a blank or over-long name', async () => {
    const dflt = idByName(MOCK_SEASON_ID, 'No program');
    expect(
      (
        await rpc('admin_upsert_program', {
          p_season_id: MOCK_SEASON_ID,
          p_id: dflt,
          p_name: 'All',
        })
      ).error?.code
    ).toBe('22023');
    for (const name of ['   ', 'x'.repeat(81)]) {
      const { error } = await rpc('admin_upsert_program', {
        p_season_id: MOCK_SEASON_ID,
        p_id: null,
        p_name: name,
      });
      expect(error?.code).toBe('22023');
    }
  });

  it("refuses a completed season, and a completed season's program named with the active season's id", async () => {
    const done = await rpc('admin_upsert_program', {
      p_season_id: DONE,
      p_id: null,
      p_name: 'History',
    });
    expect(done.error).toMatchObject({ code: '22023', details: 'season_completed' });
    const sneaky = await rpc('admin_upsert_program', {
      p_season_id: MOCK_SEASON_ID,
      p_id: idByName(DONE, 'No program'),
      p_name: 'Edited through the active season',
    });
    expect(sneaky.error?.code).toBe('23503');
    expect(idByName(DONE, 'Edited through the active season')).toBeUndefined();
  });

  it("refuses a coach and another organization's admin (42501), writing no audit row", async () => {
    setSession('mock-coach-id');
    const coach = await rpc('admin_upsert_program', {
      p_season_id: MOCK_SEASON_ID,
      p_id: null,
      p_name: 'Coach made',
    });
    expect(coach.error?.code).toBe('42501');
    setSession('other-admin');
    const other = await rpc('admin_upsert_program', {
      p_season_id: MOCK_SEASON_ID,
      p_id: null,
      p_name: 'Not mine',
    });
    expect(other.error?.code).toBe('42501');
    expect(auditRows('program.upserted')).toHaveLength(0);
  });
});

describe('admin_set_division_program', () => {
  beforeEach(async () => {
    await rpc('admin_upsert_program', {
      p_season_id: MOCK_SEASON_ID,
      p_id: null,
      p_name: 'Junior',
    });
    await rpc('admin_upsert_program', { p_season_id: MOCK_SEASON_ID, p_id: null, p_name: 'Mini' });
  });

  it('assigns, moves and removes a division; a division is in one program only', async () => {
    const junior = idByName(MOCK_SEASON_ID, 'Junior');
    const mini = idByName(MOCK_SEASON_ID, 'Mini');
    expect(
      (await rpc('admin_set_division_program', { p_division_id: 'p-u7b', p_program_id: junior }))
        .data.changed
    ).toBe(true);
    expect(programOf('p-u7b').name).toBe('Junior');
    await rpc('admin_set_division_program', { p_division_id: 'p-u7b', p_program_id: mini });
    expect(programOf('p-u7b').name).toBe('Mini');
    await rpc('admin_set_division_program', { p_division_id: 'p-u7b', p_program_id: null });
    expect(programOf('p-u7b')).toMatchObject({ name: 'No program', is_default: true });
    const rows = auditRows('division.program_changed').filter((r) => r.resource_id === 'p-u7b');
    expect(rows.map((r) => [r.metadata.from_program_name, r.metadata.to_program_name])).toEqual([
      ['No program', 'Junior'],
      ['Junior', 'Mini'],
      ['Mini', 'No program'],
    ]);
  });

  it('changes and audits nothing when the division is already there', async () => {
    const { data } = await rpc('admin_set_division_program', {
      p_division_id: 'p-u7b',
      p_program_id: null,
    });
    expect(data.changed).toBe(false);
    expect(auditRows('division.program_changed')).toHaveLength(0);
  });

  it("raises 23503 for another season's program, 22023 for a completed season, 42501 for a stranger", async () => {
    const draftDefault = idByName(DRAFT, 'No program');
    expect(
      (
        await rpc('admin_set_division_program', {
          p_division_id: 'p-u7b',
          p_program_id: draftDefault,
        })
      ).error?.code
    ).toBe('23503');
    expect(
      (await rpc('admin_set_division_program', { p_division_id: 'p-done', p_program_id: null }))
        .error?.code
    ).toBe('22023');
    setSession('other-admin');
    expect(
      (await rpc('admin_set_division_program', { p_division_id: 'p-u7b', p_program_id: null }))
        .error?.code
    ).toBe('42501');
    expect(auditRows('division.program_changed')).toHaveLength(0);
  });
});

describe('admin_delete_program and admin_merge_programs', () => {
  let junior;
  let mini;
  beforeEach(async () => {
    await rpc('admin_upsert_program', {
      p_season_id: MOCK_SEASON_ID,
      p_id: null,
      p_name: 'Junior',
    });
    await rpc('admin_upsert_program', { p_season_id: MOCK_SEASON_ID, p_id: null, p_name: 'Mini' });
    junior = idByName(MOCK_SEASON_ID, 'Junior');
    mini = idByName(MOCK_SEASON_ID, 'Mini');
    await rpc('admin_set_division_program', { p_division_id: 'p-u7b', p_program_id: junior });
    await rpc('admin_set_division_program', { p_division_id: 'p-u7g', p_program_id: junior });
    await rpc('admin_set_division_program', { p_division_id: 'p-u8b', p_program_id: mini });
  });

  it('a delete moves the divisions to the default, removes the program and audits the moved ids', async () => {
    const { data } = await rpc('admin_delete_program', { p_program_id: junior });
    expect(data.moved_division_ids).toEqual(['p-u7b', 'p-u7g']);
    expect(programsOf(MOCK_SEASON_ID).some((p) => p.id === junior)).toBe(false);
    expect(programOf('p-u7b').is_default).toBe(true);
    expect(programOf('p-u8b').name).toBe('Mini');
    expect(auditRows('program.deleted')[0].metadata).toMatchObject({
      name: 'Junior',
      moved_division_ids: ['p-u7b', 'p-u7g'],
    });
  });

  it("a merge moves the source's divisions to the target, which keeps its name, and audits it", async () => {
    const { data } = await rpc('admin_merge_programs', { p_source_id: junior, p_target_id: mini });
    expect(data.moved_division_ids).toEqual(['p-u7b', 'p-u7g']);
    expect(programsOf(MOCK_SEASON_ID).some((p) => p.id === junior)).toBe(false);
    expect(['p-u7b', 'p-u7g', 'p-u8b'].map((id) => programOf(id).name)).toEqual([
      'Mini',
      'Mini',
      'Mini',
    ]);
    expect(auditRows('program.merged')[0].metadata).toMatchObject({
      source_name: 'Junior',
      target_name: 'Mini',
      moved_division_ids: ['p-u7b', 'p-u7g'],
    });
  });

  it('can merge into the default, which is a delete by another name', async () => {
    const dflt = idByName(MOCK_SEASON_ID, 'No program');
    const { error } = await rpc('admin_merge_programs', { p_source_id: junior, p_target_id: dflt });
    expect(error).toBeNull();
    expect(programOf('p-u7b').is_default).toBe(true);
  });

  it('refuses the default (delete, merge away), a self-merge, two seasons and a completed season', async () => {
    const dflt = idByName(MOCK_SEASON_ID, 'No program');
    expect((await rpc('admin_delete_program', { p_program_id: dflt })).error?.code).toBe('22023');
    expect(
      (await rpc('admin_merge_programs', { p_source_id: dflt, p_target_id: junior })).error?.code
    ).toBe('22023');
    expect(
      (await rpc('admin_merge_programs', { p_source_id: junior, p_target_id: junior })).error?.code
    ).toBe('22023');
    expect(
      (
        await rpc('admin_merge_programs', {
          p_source_id: junior,
          p_target_id: idByName(DRAFT, 'No program'),
        })
      ).error?.code
    ).toBe('22023');
    expect(
      (await rpc('admin_delete_program', { p_program_id: idByName(DONE, 'No program') })).error
        ?.code
    ).toBe('22023');
    expect(auditRows('program.deleted')).toHaveLength(0);
    expect(auditRows('program.merged')).toHaveLength(0);
  });

  it('refuses a stranger, and a program that does not exist, the same way (42501)', async () => {
    setSession('other-admin');
    expect((await rpc('admin_delete_program', { p_program_id: junior })).error?.code).toBe('42501');
    expect(
      (await rpc('admin_delete_program', { p_program_id: 'no-such-program' })).error?.code
    ).toBe('42501');
    expect(
      (await rpc('admin_merge_programs', { p_source_id: junior, p_target_id: mini })).error?.code
    ).toBe('42501');
  });
});

describe('programs are optional', () => {
  it('a division written by the import writers joins the default program without anyone naming one', async () => {
    const { data } = await rpc('admin_upsert_division_settings', {
      p_organization_id: MOCK_ORG_ID,
      p_season_settings_id: MOCK_SEASON_ID,
      p_division_id: null,
      p_name: 'P U12B',
      p_max_roster_size: 14,
    });
    expect(data.program_id).toBe(idByName(MOCK_SEASON_ID, 'No program'));
    const created = await rpc('upsert_division_for_import', {
      p_organization_id: MOCK_ORG_ID,
      p_season_settings_id: MOCK_SEASON_ID,
      p_name: 'P U10G',
      p_gender: 'girls',
    });
    expect(created.data.program_id).toBe(idByName(MOCK_SEASON_ID, 'No program'));
    expect(
      getMockData('programs').filter((p) => p.season_settings_id === MOCK_SEASON_ID)
    ).toHaveLength(1);
  });

  it('a league with only the default program has nothing to group: no heading, no "No program"', () => {
    const programs = programsOf(MOCK_SEASON_ID);
    const items = getMockData('divisions')
      .filter((d) => d.season_settings_id === MOCK_SEASON_ID)
      .map((d) => ({ id: d.id }));
    const programIdOf = (item) => getMockData('divisions').find((d) => d.id === item.id).program_id;
    expect(groupByProgram({ items, programIdOf, programs })).toBeNull();
  });

  it('groups once a program of its own holds a division, "No program" last', async () => {
    await rpc('admin_upsert_program', {
      p_season_id: MOCK_SEASON_ID,
      p_id: null,
      p_name: 'Junior',
    });
    await rpc('admin_set_division_program', {
      p_division_id: 'p-u7b',
      p_program_id: idByName(MOCK_SEASON_ID, 'Junior'),
    });
    const programs = programsOf(MOCK_SEASON_ID);
    const items = getMockData('divisions')
      .filter((d) => d.season_settings_id === MOCK_SEASON_ID)
      .map((d) => ({ id: d.id }));
    const programIdOf = (item) => getMockData('divisions').find((d) => d.id === item.id).program_id;
    const groups = groupByProgram({ items, programIdOf, programs });
    expect(groups.map((g) => [g.label, g.ids])).toEqual([
      ['Junior', ['p-u7b']],
      ['No program', expect.arrayContaining(['p-u7g', 'p-u8b'])],
    ]);
  });

  it('an empty program with no divisions makes no heading either', async () => {
    await rpc('admin_upsert_program', { p_season_id: MOCK_SEASON_ID, p_id: null, p_name: 'Empty' });
    const programs = programsOf(MOCK_SEASON_ID);
    const items = [{ id: 'p-u7b' }];
    expect(
      groupByProgram({ items, programIdOf: () => programs.find((p) => p.is_default).id, programs })
    ).toBeNull();
  });
});
