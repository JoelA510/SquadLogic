// Players and coaches belong to one season (Phase E3a; migration 20261108010000; plan
// docs/changes/2026-10-27-season-enrollment.md). The mock twin of the database rules, held to
// the SQL's outcomes by supabase/tests/season_enrollment.sql:
//   * a player or coach row without a season takes its division's, else the active season;
//   * the import matches in the destination season only: the same registration id or email in the
//     next season is a NEW row, the earlier season's row is untouched, a division named by id from
//     another season matches nothing, buddy requests and a coach's child ids reach the job's
//     season only, and an organization with no season refuses (22023, season_missing);
//   * the player patch refuses a division or team of another season, admin_create_player takes a
//     season, and a team's coach is of the team's season.
import { beforeEach, describe, expect, it } from 'vitest';
import { getMockData, mockSupabase as supabase } from '../frontend/src/lib/mockSupabaseClient.js';
import {
  coachTeamSeasonRefusal,
  normalizeEnrollment,
  playerPatchSeasonRefusal,
} from '../frontend/src/lib/mockEnrollment.js';
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../frontend/src/lib/mockSeedIds.js';

const NEXT = 'se-next-season';
const NEXT_DIV = 'se-next-div';
const NEXT_TEAM = 'se-next-team';
const OLD_DIV = 'u8-div-id';

const save = (patch) => window.__saveMockDB__({ ...window.__MOCK_DB__, ...patch });

// The league has rolled over: the seed season is completed and NEXT is the active one.
const rollOver = () => {
  save({
    season_settings: [
      ...getMockData('season_settings').map((s) =>
        s.id === MOCK_SEASON_ID ? { ...s, status: 'completed' } : s
      ),
      {
        id: NEXT,
        organization_id: MOCK_ORG_ID,
        name: 'Next',
        status: 'active',
        created_at: new Date().toISOString(),
      },
    ],
    divisions: [
      ...getMockData('divisions'),
      {
        id: NEXT_DIV,
        organization_id: MOCK_ORG_ID,
        season_settings_id: NEXT,
        name: 'U8 Coed',
        practices_per_week: 1,
      },
    ],
    teams: [
      ...getMockData('teams'),
      { id: NEXT_TEAM, organization_id: MOCK_ORG_ID, division_id: NEXT_DIV, name: 'Next Team' },
    ],
  });
};

const job = (id, seasonId, extra = {}) => {
  save({
    import_jobs: [
      ...getMockData('import_jobs'),
      {
        id,
        organization_id: MOCK_ORG_ID,
        job_type: 'registration',
        status: 'importing',
        season_settings_id: seasonId,
        ...extra,
      },
    ],
  });
  return id;
};
const stagePlayers = (jobId, payloads, orgId = MOCK_ORG_ID) =>
  save({
    staging_players: [
      ...getMockData('staging_players'),
      ...payloads.map((normalized_payload, i) => ({
        id: `sp-${jobId}-${i}`,
        organization_id: orgId,
        import_job_id: jobId,
        source_row_number: i + 1,
        raw_payload: {},
        normalized_payload,
        validation_errors: [],
      })),
    ],
  });
const stageCoaches = (jobId, payloads, orgId = MOCK_ORG_ID) =>
  save({
    staging_import_rows: [
      ...getMockData('staging_import_rows'),
      ...payloads.map((normalized_payload, i) => ({
        id: `sc-${jobId}-${i}`,
        organization_id: orgId,
        import_job_id: jobId,
        import_type: 'coaches',
        source_row_number: i + 1,
        raw_payload: {},
        normalized_payload,
        validation_errors: [],
      })),
    ],
  });
const finalizePlayers = (jobId) =>
  supabase.rpc('finalize_import_job', { p_import_job_id: jobId, p_validation_errors: [] });
const finalizeCoaches = (jobId) =>
  supabase.rpc('finalize_coach_import_job', { p_import_job_id: jobId, p_validation_errors: [] });
const playerOf = (externalId, seasonId) =>
  getMockData('players').find(
    (p) => p.external_registration_id === externalId && p.season_settings_id === seasonId
  );

beforeEach(() => {
  sessionStorage.clear();
  window.__saveMockDB__({});
});

describe('the fill (the two triggers)', () => {
  it("gives a player its division's season, else the active one, and a coach the active one", () => {
    const db = {
      season_settings: [
        { id: 's-a', organization_id: 'o', status: 'completed' },
        { id: 's-b', organization_id: 'o', status: 'active' },
      ],
      divisions: [{ id: 'd-a', season_settings_id: 's-a' }],
      players: [
        { id: 'p1', organization_id: 'o', division_id: 'd-a' },
        { id: 'p2', organization_id: 'o' },
        { id: 'p3', organization_id: 'o', season_settings_id: 's-a' },
        { id: 'p4', organization_id: 'nobody' },
      ],
      coaches: [
        { id: 'c1', organization_id: 'o' },
        { id: 'c2', organization_id: 'o', season_settings_id: 's-a' },
      ],
      view_org_metrics: [
        { organization_id: 'o' },
        { organization_id: 'o', season_settings_id: 's-a' },
      ],
    };
    normalizeEnrollment(db);
    expect(db.players.map((p) => p.season_settings_id)).toEqual(['s-a', 's-b', 's-a', undefined]);
    expect(db.coaches.map((c) => c.season_settings_id)).toEqual(['s-b', 's-a']);
    expect(db.view_org_metrics.map((m) => m.season_settings_id)).toEqual(['s-b', 's-a']);
  });

  it('is applied when the mock database is read: the seed people are in the seed season', () => {
    expect(getMockData('players').every((p) => p.season_settings_id === MOCK_SEASON_ID)).toBe(true);
    expect(getMockData('coaches').every((c) => c.season_settings_id === MOCK_SEASON_ID)).toBe(true);
  });
});

describe('finalize_import_job (mock): matches in the destination season only', () => {
  beforeEach(rollOver);

  it('makes the same registration id a new player in the next season and leaves the old row untouched', async () => {
    const earlier = playerOf('R-1', MOCK_SEASON_ID) ?? {
      id: 'earlier-r1',
      organization_id: MOCK_ORG_ID,
      season_settings_id: MOCK_SEASON_ID,
      division_id: OLD_DIV,
      first_name: 'Ann',
      last_name: 'Earlier',
      external_registration_id: 'R-1',
    };
    save({ players: [...getMockData('players'), earlier] });
    const before = JSON.stringify(getMockData('players').find((p) => p.id === earlier.id));

    const id = job('se-job-1', NEXT);
    stagePlayers(id, [
      {
        first_name: 'Ann',
        last_name: 'Renewed',
        external_registration_id: 'R-1',
        division_name: 'U8 Coed',
      },
    ]);
    const { data, error } = await finalizePlayers(id);
    expect(error).toBeNull();
    expect(data).toMatchObject({ inserted_players: 1, updated_players: 0 });

    expect(JSON.stringify(getMockData('players').find((p) => p.id === earlier.id))).toBe(before);
    const created = playerOf('R-1', NEXT);
    expect(created).toMatchObject({ last_name: 'Renewed', division_id: NEXT_DIV });
    expect(created.id).not.toBe(earlier.id);
  });

  it('matches the id within the season on a second import (an update, not a duplicate)', async () => {
    for (const jobId of ['se-job-a', 'se-job-b']) {
      job(jobId, NEXT);
      stagePlayers(jobId, [
        { first_name: 'Bo', last_name: jobId, external_registration_id: 'R-2' },
      ]);
    }
    expect((await finalizePlayers('se-job-a')).data).toMatchObject({ inserted_players: 1 });
    expect((await finalizePlayers('se-job-b')).data).toMatchObject({
      inserted_players: 0,
      updated_players: 1,
    });
    expect(getMockData('players').filter((p) => p.external_registration_id === 'R-2')).toHaveLength(
      1
    );
  });

  it('matches a division named by id from another season to nothing', async () => {
    const id = job('se-job-div', NEXT);
    stagePlayers(id, [
      {
        first_name: 'Cy',
        last_name: 'Division',
        external_registration_id: 'R-3',
        division_id: OLD_DIV,
      },
    ]);
    await finalizePlayers(id);
    expect(playerOf('R-3', NEXT).division_id).toBeNull();
  });

  it('refuses an organization with no season (22023, season_missing)', async () => {
    save({
      organizations: [...getMockData('organizations'), { id: 'se-empty-org', name: 'Empty' }],
    });
    const id = job('se-job-none', null, { organization_id: 'se-empty-org' });
    stagePlayers(
      id,
      [{ first_name: 'Di', last_name: 'None', external_registration_id: 'R-4' }],
      'se-empty-org'
    );
    const { error } = await finalizePlayers(id);
    expect(error?.code).toBe('22023');
    expect(error?.details).toBe('season_missing');
  });

  it("reaches a buddy request to a player of the job's season only", async () => {
    // Season 1 holds R-5 and R-6 as a pair; season 2 imports R-5 and a new R-7, each naming the other.
    save({
      players: [
        ...getMockData('players'),
        ...['R-5', 'R-6'].map((r) => ({
          id: `old-${r}`,
          organization_id: MOCK_ORG_ID,
          season_settings_id: MOCK_SEASON_ID,
          division_id: OLD_DIV,
          first_name: r,
          last_name: 'Old',
          external_registration_id: r,
        })),
      ],
    });
    const id = job('se-job-buddy', NEXT);
    stagePlayers(id, [
      {
        first_name: 'Eve',
        last_name: 'New',
        external_registration_id: 'R-5',
        division_name: 'U8 Coed',
        buddy_request: 'R-7',
      },
      {
        first_name: 'Fay',
        last_name: 'New',
        external_registration_id: 'R-7',
        division_name: 'U8 Coed',
        buddy_request: 'R-5',
      },
      {
        first_name: 'Gus',
        last_name: 'New',
        external_registration_id: 'R-8',
        division_name: 'U8 Coed',
        buddy_request: 'R-6',
      },
    ]);
    await finalizePlayers(id);
    const { data } = await supabase.rpc('materialize_import_buddy_pairs', { p_import_job_id: id });
    expect(data.materialized_pairs).toBe(1);
    const pairs = getMockData('player_buddies');
    const nextIds = new Set(
      getMockData('players')
        .filter((p) => p.season_settings_id === NEXT)
        .map((p) => p.id)
    );
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.every((p) => nextIds.has(p.player_id) && nextIds.has(p.buddy_player_id))).toBe(
      true
    );
    expect(data.unmatched_request_rows).toBe(1);
  });
});

describe('finalize_coach_import_job (mock): a row per season', () => {
  beforeEach(rollOver);

  it("makes the same email a new coach in the next season, leaves the old one, and links the season's own child", async () => {
    const oldCoach = getMockData('coaches').find((c) => c.id === 'mock-coach-id');
    const oldBefore = JSON.stringify(oldCoach);
    save({
      players: [
        ...getMockData('players'),
        {
          id: 'old-child',
          organization_id: MOCK_ORG_ID,
          season_settings_id: MOCK_SEASON_ID,
          first_name: 'Old',
          last_name: 'Child',
          external_registration_id: 'K-1',
        },
        {
          id: 'new-child',
          organization_id: MOCK_ORG_ID,
          season_settings_id: NEXT,
          first_name: 'New',
          last_name: 'Child',
          external_registration_id: 'K-1',
        },
        {
          id: 'only-old-child',
          organization_id: MOCK_ORG_ID,
          season_settings_id: MOCK_SEASON_ID,
          first_name: 'Only',
          last_name: 'Old',
          external_registration_id: 'K-2',
        },
      ],
    });
    const id = job('se-cjob', NEXT);
    stageCoaches(id, [
      {
        full_name: 'Mock Coach Renewed',
        email: 'coach@example.com',
        child_registration_id: 'K-1; K-2',
      },
    ]);
    const { data, error } = await finalizeCoaches(id);
    expect(error).toBeNull();
    expect(data).toMatchObject({
      inserted_coaches: 1,
      updated_coaches: 0,
      linked_children: 1,
      unmatched_child_id_count: 1,
    });
    expect(JSON.stringify(getMockData('coaches').find((c) => c.id === 'mock-coach-id'))).toBe(
      oldBefore
    );
    const created = getMockData('coaches').find(
      (c) => c.email === 'coach@example.com' && c.season_settings_id === NEXT
    );
    expect(created.full_name).toBe('Mock Coach Renewed');
    expect(getMockData('coach_team_requests').filter((r) => r.coach_id === created.id)).toEqual([
      expect.objectContaining({ player_id: 'new-child' }),
    ]);
  });

  it('refuses an organization with no season, and a completed one', async () => {
    const done = job('se-cjob-done', MOCK_SEASON_ID);
    stageCoaches(done, [{ full_name: 'A', email: 'a@example.com' }]);
    expect((await finalizeCoaches(done)).error?.details).toBe('season_completed');
    save({
      organizations: [...getMockData('organizations'), { id: 'se-empty-org', name: 'Empty' }],
    });
    const none = job('se-cjob-none', null, { organization_id: 'se-empty-org' });
    stageCoaches(none, [{ full_name: 'B', email: 'b@example.com' }], 'se-empty-org');
    expect((await finalizeCoaches(none)).error?.details).toBe('season_missing');
  });
});

describe('the other writers (mock)', () => {
  beforeEach(rollOver);

  it('refuses a division or team of another season in the player patch (22023)', async () => {
    // A player of the completed season is read-only (E3b); the patch rule is about a player of
    // the active season, so player-1 is brought into it first.
    save({
      season_settings: getMockData('season_settings').map((s) =>
        s.id === MOCK_SEASON_ID ? { ...s, status: 'active' } : { ...s, status: 'draft' }
      ),
    });
    const stray = await supabase.rpc('admin_update_player', {
      p_player_id: 'player-1',
      p_patch: { division_id: NEXT_DIV },
    });
    expect(stray.error).toMatchObject({ code: '22023', details: 'season_mismatch' });
    const team = await supabase.rpc('admin_update_player', {
      p_player_id: 'player-1',
      p_patch: { division_id: OLD_DIV, team_id: NEXT_TEAM },
    });
    expect(team.error?.message ?? '').toMatch(/team/);
    expect(getMockData('players').find((p) => p.id === 'player-1').division_id).toBe(OLD_DIV);
  });

  it('admin_create_player takes a season, defaults to the active one, and refuses a completed one', async () => {
    const dflt = await supabase.rpc('admin_create_player', {
      p_organization_id: MOCK_ORG_ID,
      p_fields: { first_name: 'Hal' },
    });
    expect(dflt.data.season_settings_id).toBe(NEXT);
    const done = await supabase.rpc('admin_create_player', {
      p_organization_id: MOCK_ORG_ID,
      p_fields: {},
      p_season_settings_id: MOCK_SEASON_ID,
    });
    expect(done.error).toMatchObject({ code: '22023', details: 'season_completed' });
    const wrong = await supabase.rpc('admin_create_player', {
      p_organization_id: MOCK_ORG_ID,
      p_fields: { division_id: OLD_DIV },
    });
    expect(wrong.error?.details).toBe('season_mismatch');
  });

  it('refuses a coach of another season for a team', async () => {
    expect(
      coachTeamSeasonRefusal(window.__MOCK_DB__ ? { ...window.__MOCK_DB__ } : {}, null, NEXT_TEAM)
    ).toBeNull();
    const db = {
      coaches: [{ id: 'c-old', season_settings_id: MOCK_SEASON_ID }],
      divisions: [{ id: NEXT_DIV, season_settings_id: NEXT }],
      teams: [{ id: NEXT_TEAM, division_id: NEXT_DIV }],
    };
    expect(coachTeamSeasonRefusal(db, 'c-old', NEXT_TEAM)).toMatchObject({
      error: { code: '23514' },
    });
    expect(
      playerPatchSeasonRefusal(db, { season_settings_id: NEXT }, { team_id: NEXT_TEAM })
    ).toBeNull();
  });
});
