// @vitest-environment jsdom
//
// The practice import's preview is its apply (plan docs/changes/2026-11-03-schedule-expansion.md 4.11.4; PR 11, task
// L3): over one file that reaches every outcome (tests/helpers/practiceImportWorld.js), driven through the client the
// Practices tab calls and the REAL mock client, the preview's counts and flags equal the apply's, and the counts the tab
// shows and the confirm carries are the dry run's own (`practiceImportConfirmCounts`), never a second computation.
//
// Each count is required non-zero first: a count that is zero in both would compare nothing.
import Papa from 'papaparse';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALIAS_CSV,
  DIVISIONS,
  FILE_ROWS,
  HOLD_ONLY_ROW,
  ORG,
  SEASON,
  SPRING_ROWS,
  TEAMS,
  VENUE_A,
  fileCsv,
  seedPracticeImportWorld,
} from './helpers/practiceImportWorld.js';

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase, supabaseReady: Promise.resolve() };
});

const { mockSupabase: client } = await import('../frontend/src/lib/mockSupabaseClient.js');
const C = await import('../frontend/src/utils/practiceImportClient.js');
const M = await import('../frontend/src/utils/practiceImportMapping.js');
const core = await import('../packages/core/src/practiceImport/index.js');
const { mockSyncScheduleTbdPractices } = await import('../frontend/src/lib/mockPracticeImport.js');

/** Stage the file, decide every label as the admin would, store the mapping; the job and what was decided. */
async function staged(rows) {
  const parsed = Papa.parse(fileCsv(rows), { header: true, skipEmptyLines: true });
  const started = await C.startPracticeImport(client, {
    organizationId: ORG,
    seasonSettingsId: SEASON,
    fileName: 'practices.csv',
    headers: parsed.meta.fields,
    rows: parsed.data,
    dates: null,
  });
  const stagedRows = await C.readStagedPracticeRows(client, started.jobId);
  const league = await C.readPracticeImportLeague(client, {
    organizationId: ORG,
    seasonSettingsId: SEASON,
  });
  const alias = Papa.parse(ALIAS_CSV, { header: true, skipEmptyLines: true });
  const { aliases } = core.readPracticeAliases({
    headers: alias.meta.fields,
    rows: alias.data,
    league,
  });
  const choices = { divisions: {}, locations: {}, fields: {}, subunits: {}, teams: {} };
  /** @type {any} */
  let proposal = null;
  const propose = () =>
    core.proposePracticeMapping({
      rows: stagedRows,
      league,
      aliases,
      decisions: M.decisionsFromChoices(choices, proposal),
    });
  proposal = propose();
  // the alias file's proposal, taken; every new label created; U10B-05 skipped
  for (let pass = 0; pass < 3; pass += 1) {
    for (const { group } of M.PRACTICE_MAPPING_GROUPS) {
      for (const e of proposal[group]) {
        if (choices[group][e.key] !== undefined) continue;
        if (e.label === 'Venue A Annex') choices[group][e.key] = `map:${VENUE_A}`;
        else if (e.label === 'U10B-05') choices[group][e.key] = 'skip';
        else if (!e.effective) choices[group][e.key] = 'create';
      }
    }
    proposal = propose();
  }
  const resolved = core.resolvePracticeRows({
    rows: stagedRows,
    league,
    aliases,
    decisions: M.decisionsFromChoices(choices, proposal),
  });
  return { jobId: started.jobId, proposal, choices, resolvedRows: resolved.rows, league };
}

beforeEach(() => {
  seedPracticeImportWorld();
});

describe('the preview is the apply', () => {
  it('over one file that reaches every outcome: the counts and the flags of the preview are the apply’s', async () => {
    const { jobId, proposal, choices } = await staged();
    await C.savePracticeImportMapping(
      client,
      jobId,
      M.practiceMappingForJob(proposal, choices, [])
    );
    const preview = await C.previewPracticeImport(client, jobId);
    // CONTROL: every count is non-zero, so equality below compares something
    const zero = Object.entries(preview.counts).filter(([, n]) => Number(n) === 0);
    expect(zero).toEqual([]);
    expect(Object.keys(preview.flags)).toEqual(['coach-conflict']);

    const shown = C.practiceImportConfirmCounts(preview);
    // what the tab shows is the dry run's own counts, key for key
    expect(shown).toEqual(
      Object.fromEntries(Object.entries(preview.counts).sort(([a], [b]) => (a < b ? -1 : 1)))
    );
    const applied = await C.confirmPracticeImport(client, {
      organizationId: ORG,
      seasonSettingsId: SEASON,
      jobId,
      confirmed: shown,
    });
    expect(applied.status).toBe('applied');
    expect(applied.result.counts).toEqual(preview.counts);
    expect(applied.result.flags).toEqual(preview.flags);
    expect(applied.result.flagged).toEqual(preview.flagged);
    expect(applied.result.refused).toEqual(preview.refused);
    // a team shell the import creates gets a new id in each run (the dry run's is rolled back): compared without it
    const known = new Set(Object.values(TEAMS));
    const anonymous = (rows) =>
      rows.map((a) => ({ ...a, team_id: known.has(a.team_id) ? a.team_id : 'created' }));
    expect(anonymous(applied.result.arriving)).toEqual(anonymous(preview.arriving));
    expect(applied.result.leaving).toEqual(preview.leaving);
    expect(applied.result.holds).toEqual(preview.holds);
    expect(applied.result.time_tbd).toEqual(preview.time_tbd);
    expect(applied.result.dry_run).toBe(false);
    expect(preview.dry_run).toBe(true);
  });

  it('a confirm whose counts are no longer true is refused as stale, and nothing is written', async () => {
    const { jobId, proposal, choices } = await staged();
    await C.savePracticeImportMapping(
      client,
      jobId,
      M.practiceMappingForJob(proposal, choices, [])
    );
    const preview = await C.previewPracticeImport(client, jobId);
    const before = (
      await client.from('practice_assignments').select('id').eq('organization_id', ORG)
    ).data.length;
    const outcome = await C.confirmPracticeImport(client, {
      organizationId: ORG,
      seasonSettingsId: SEASON,
      jobId,
      confirmed: { ...C.practiceImportConfirmCounts(preview), inserted: 99 },
    });
    expect(outcome.status).toBe('stale');
    expect(outcome.differing).toEqual(['inserted']);
    const after = (
      await client.from('practice_assignments').select('id').eq('organization_id', ORG)
    ).data.length;
    expect(after).toBe(before);
  });
});

describe('probable moves are the database’s', () => {
  it('a move within the saved dates is held back, and its team-level line is made from the flagged rows only', async () => {
    const { jobId, proposal, choices } = await staged();
    await C.savePracticeImportMapping(
      client,
      jobId,
      M.practiceMappingForJob(proposal, choices, [])
    );
    const preview = await C.previewPracticeImport(client, jobId);
    const moves = C.practiceProbableMoves(preview);
    expect(moves.map((m) => m.summary)).toEqual(['U10B-03: 1 row leaving, 1 row arriving']);
    expect(moves[0].teamId).toBe(TEAMS['U10B-03']);
    expect(moves[0].heldBack).toBe(1);
    // the other teams' new rows are new rows, not moves
    expect(preview.arriving.filter((a) => a.probable_move !== true).every((a) => a.added)).toBe(
      true
    );
  });

  it('a spring file over fall practices: nothing is leaving and no team is paired', async () => {
    const { jobId, proposal, choices } = await staged(SPRING_ROWS);
    await C.savePracticeImportMapping(
      client,
      jobId,
      M.practiceMappingForJob(proposal, choices, [])
    );
    const preview = await C.previewPracticeImport(client, jobId);
    // CONTROL: the team is in the file, with a saved practice of its own
    expect(preview.arriving.some((a) => a.team_id === TEAMS['U10B-03'])).toBe(true);
    expect(preview.leaving).toEqual([]);
    expect(C.practiceProbableMoves(preview)).toEqual([]);
    expect(preview.counts.held_back).toBe(0);
    // core's pairing, which sees no dates, WOULD pair the team: the reason the tab never calls it
    const pairedByCore = core.pairProbableMoves({
      leaving: [{ rowKey: 'saved', teamId: TEAMS['U10B-03'] }],
      arriving: preview.arriving.map((a) => ({ rowKey: a.row_key, teamId: a.team_id })),
    });
    expect(pairedByCore.moves.map((m) => m.teamId)).toEqual([TEAMS['U10B-03']]);
  });

  it('only a ticked row is sent, and only it is added', async () => {
    const { jobId, proposal, choices } = await staged();
    await C.savePracticeImportMapping(
      client,
      jobId,
      M.practiceMappingForJob(proposal, choices, ['row-7'])
    );
    const preview = await C.previewPracticeImport(client, jobId);
    expect(preview.counts.held_back).toBe(0);
    expect(preview.arriving.find((a) => a.row_key === 'row-7')).toMatchObject({
      probable_move: true,
      added: true,
    });
  });
});

describe('a ground only a hold names (Codex on #732)', () => {
  it('is stored as its exact existing ground, so the database knows it and flags the hold over a slot', async () => {
    const { jobId, proposal, choices, resolvedRows } = await staged([...FILE_ROWS, HOLD_ONLY_ROW]);
    const mapping = M.practiceMappingForJob(proposal, choices, [], resolvedRows);
    // CONTROL: the screen's entries do not name Venue C (only a hold does)
    expect(proposal.locations.map((e) => e.label)).not.toContain('Venue C');
    expect(Object.values(mapping.locations).map((d) => d.id)).toContain(
      '0b000000-0000-4000-8000-000000000025'
    );
    await C.savePracticeImportMapping(client, jobId, mapping);
    const preview = await C.previewPracticeImport(client, jobId);
    expect(preview.holds.find((h) => h.row === 16)).toMatchObject({ ground_known: true });
    expect(
      preview.flagged.filter((f) => f.code === 'hold-over-open-slot').map((f) => f.row)
    ).toEqual([16]);
  });

  it('a hold creates nothing: a ground that is not the league’s is stored as nothing', async () => {
    const elsewhere = { ...HOLD_ONLY_ROW, Location: 'Venue Z' };
    const { proposal, choices, resolvedRows } = await staged([...FILE_ROWS, elsewhere]);
    const mapping = M.practiceMappingForJob(proposal, choices, [], resolvedRows);
    expect(Object.keys(mapping.locations).some((k) => k.includes('venue z'))).toBe(false);
    expect(JSON.stringify(mapping)).not.toContain('create:venue z');
  });
});

describe('the confirm is the Edge function’s: the stale check is on the server (review item 4)', () => {
  it('the client sends the confirm to import-validation, which refuses a stale one and writes nothing', async () => {
    const { jobId, proposal, choices } = await staged();
    await C.savePracticeImportMapping(
      client,
      jobId,
      M.practiceMappingForJob(proposal, choices, [])
    );
    const preview = await C.previewPracticeImport(client, jobId);
    const invoke = vi.spyOn(client.functions, 'invoke');
    const rpc = vi.spyOn(client, 'rpc');
    const outcome = await C.confirmPracticeImport(client, {
      organizationId: ORG,
      seasonSettingsId: SEASON,
      jobId,
      confirmed: { ...C.practiceImportConfirmCounts(preview), held_back: 0 },
    });
    expect(outcome.status).toBe('stale');
    expect(outcome.differing).toEqual(['held_back']);
    expect(invoke.mock.calls.map(([, o]) => /** @type {any} */ (o).body.action)).toEqual(['apply']);
    // the client itself ran no dry run and no apply
    expect(rpc.mock.calls.filter(([name]) => name === 'apply_practice_import_job')).toEqual([]);
    vi.restoreAllMocks();
  });
});

describe('re-staging (review item 9)', () => {
  it('a staged (ready) job is refused another file, and keeps its rows', async () => {
    const { jobId } = await staged();
    const before = (
      await client.from('staging_import_rows').select('id').eq('import_job_id', jobId)
    ).data.length;
    expect(before).toBe(15);
    const { error } = await client.functions.invoke('import-validation', {
      body: {
        import_type: 'practice_schedule',
        action: 'stage',
        organization_id: ORG,
        import_job_id: jobId,
        headers: ['Day', 'Start', 'End', 'Location', 'Field'],
        rows: [],
        dates: null,
      },
    });
    const body = await /** @type {any} */ (error).context.json();
    expect(body.code).toBe('import_not_importing');
    const after = (await client.from('staging_import_rows').select('id').eq('import_job_id', jobId))
      .data.length;
    expect(after).toBe(before);
  });
});

describe('division settings: the roster rules are sent back only when unchanged (review item 6)', () => {
  it('refuses, in words, when the division’s rules changed after the import read them, and writes nothing', async () => {
    const rpc = vi.spyOn(client, 'rpc');
    const out = await C.applyPracticeDivisionSettings(client, {
      organizationId: ORG,
      seasonSettingsId: SEASON,
      patches: [
        {
          divisionId: DIVISIONS.u10,
          name: 'U10 Boys',
          practiceMinutes: 60,
          // what the import read: another admin has since set the max roster to 12
          roster: {
            max_roster_size: 14,
            min_roster_size: 8,
            target_team_size: 10,
            team_count_override: null,
            min_teams: 2,
            max_teams: 6,
          },
        },
      ],
    });
    expect(out.saved).toEqual([]);
    expect(out.failed[0].message).toMatch(
      /team rules \(max roster size\) changed after this import read them/
    );
    expect(rpc.mock.calls.filter(([name]) => name === 'admin_upsert_division_settings')).toEqual(
      []
    );
    vi.restoreAllMocks();
  });

  it('saves when they are unchanged, and reads the TIME TBD list back as counted with the new settings', async () => {
    // The mock's refresh rebuilds nothing (its header says so: not mirrored); here the SQL's rebuild is stood in by
    // PR 10's twin of it (`mockSyncScheduleTbdPractices`, held to the SQL by tests/mockPracticeImport.test.js), so the
    // list the client reads back is the one the database would count with the saved setting.
    const realRpc = client.rpc.bind(client);
    vi.spyOn(client, 'rpc').mockImplementation(async (name, params) => {
      const answer = await realRpc(name, params);
      if (name === 'refresh_schedule_tbd_practices' && !answer.error) {
        const db = /** @type {any} */ (window).__MOCK_DB__;
        mockSyncScheduleTbdPractices(
          db,
          ORG,
          SEASON,
          new Date().toISOString().slice(0, 10),
          () => globalThis.crypto.randomUUID(),
          new Date().toISOString()
        );
        /** @type {any} */ (window).__saveMockDB__(db);
      }
      return answer;
    });
    const { jobId, proposal, choices } = await staged();
    await C.savePracticeImportMapping(
      client,
      jobId,
      M.practiceMappingForJob(proposal, choices, [])
    );
    const preview = await C.previewPracticeImport(client, jobId);
    // CONTROL: before the settings, two U12 Girls teams are one practice short of two a week
    expect(preview.time_tbd.teams.map((t) => t.team_id)).toEqual(
      expect.arrayContaining([TEAMS['U12G-02'], TEAMS['U12G-03']])
    );
    const league = await C.readPracticeImportLeague(client, {
      organizationId: ORG,
      seasonSettingsId: SEASON,
    });
    const u12 = league.divisions.find((d) => d.id === DIVISIONS.u12);
    const applied = await C.confirmPracticeImport(client, {
      organizationId: ORG,
      seasonSettingsId: SEASON,
      jobId,
      confirmed: C.practiceImportConfirmCounts(preview),
      extra: {
        settings: [
          { divisionId: DIVISIONS.u12, name: 'U12 Girls', practicesPerWeek: 1, roster: u12.roster },
        ],
      },
    });
    expect(applied.settings.saved).toEqual([{ name: 'U12 Girls' }]);
    // lowered from two to one: the deficit is gone from the list read back
    const ids = applied.settings.tbd.map((t) => t.team_id);
    // CONTROL: the list read back is the season's real list, not an empty one (U10B-05 is skipped, so still short)
    expect(ids).toContain(TEAMS['U10B-05']);
    expect(ids).not.toContain(TEAMS['U12G-02']);
    expect(ids).not.toContain(TEAMS['U12G-03']);
    vi.restoreAllMocks();
  });
});

describe('a file with more columns than the import reads (Codex C5 on #732)', () => {
  it('is refused in words before a job is made, and nothing is staged: Team in column 201 is never cut', async () => {
    const rpc = vi.spyOn(client, 'rpc');
    const invoke = vi.spyOn(client.functions, 'invoke');
    const headers = [
      'Division',
      'Day',
      'Start',
      'End',
      'Location',
      'Field',
      ...Array.from({ length: 194 }, (_, i) => `Extra ${i}`),
      'Team',
    ];
    expect(headers).toHaveLength(201);
    expect(headers[200]).toBe('Team');
    await expect(
      C.startPracticeImport(client, {
        organizationId: ORG,
        seasonSettingsId: SEASON,
        fileName: 'wide.csv',
        headers,
        rows: [
          {
            Team: 'U10B-01',
            Division: 'U10 Boys',
            Day: 'Tue',
            Start: '16:00',
            End: '17:00',
            Location: 'Venue A',
            Field: 'Field 1',
          },
        ],
        dates: null,
      })
    ).rejects.toMatchObject({
      code: 'too-many-columns',
      message: expect.stringMatching(/201 columns; one import reads at most 200/),
    });
    expect(rpc.mock.calls.filter(([name]) => name === 'create_import_job')).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
    expect(
      (await client.from('staging_import_rows').select('id').eq('organization_id', ORG)).data
    ).toEqual([]);
    vi.restoreAllMocks();
  });
});
