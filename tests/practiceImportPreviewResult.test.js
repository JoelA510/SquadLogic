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
  return { jobId: started.jobId, proposal, choices };
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
