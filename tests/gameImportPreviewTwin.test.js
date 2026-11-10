// @vitest-environment jsdom
/**
 * The preview is the apply (plan `docs/changes/2026-11-03-schedule-expansion.md` 4.2 step 5; PR 6, tasks F3 and F7):
 * over ONE file that reaches every outcome, driven through the real mock client by the calls the panel makes,
 *
 *   F3  the preview's counts, its conflict audit and the saved result agree, and so do the rows the apply wrote when
 *       they are read back (LESSONS_LEARNED 74, 77, 104: a preview is a twin, and the readers are run over the
 *       writer's output);
 *   F7  the confirm refuses a preview that went stale (`game_import_preview_stale`, both sets of counts, nothing
 *       written), in the mock's `import-validation` AND in the Edge function's own code
 *       (`supabase/functions/_shared/schedule-import.ts`) run over the same database, beside an unchanged control that
 *       applies.
 *
 * The plant (the preview's counts computed apart from the dry run) is in the PR description: with the confirm screen's
 * counts taken from the browser's own resolution of the rows, `tests/gameImportPanel.test.jsx` goes red, and the case
 * "a count computed apart from the dry run would be wrong here" below says why it must.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FILE_HEADERS,
  FILE_ROWS,
  ORG,
  SAVED,
  SEASON,
  seedGameImportWorld,
} from './helpers/gameImportWorld.js';

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase, supabaseReady: Promise.resolve() };
});

const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
const { confirmPreview, stageMapPreview } = await import('./helpers/gameImportFlow.js');
const core = await import('../packages/core/src/scheduleImport/index.js');
const { evaluateGameSchedule } = await import('../packages/core/src/gameMetrics.js');
const edge = await import('../supabase/functions/_shared/schedule-import.ts');

const params = { organizationId: ORG, seasonSettingsId: SEASON };
/** The choices that reach every outcome (the header of helpers/gameImportWorld.js lists the rows). */
const CHOICES = {
  divisions: { [core.divisionDecisionKey('U07 Girls')]: 'create' },
  fields: { [core.fieldDecisionKey('Venue A', 'Field 9')]: 'create' },
  teams: {
    [core.teamDecisionKey('U05 Boys', 'Visiting Club A')]: 'outside',
    [core.teamDecisionKey('U07 Girls', 'U07G Team 01')]: 'create',
    [core.teamDecisionKey('U07 Girls', 'U07G Team 02')]: 'create',
  },
};
const TABLES = [
  'game_assignments',
  'game_slots',
  'teams',
  'divisions',
  'fields',
  'locations',
  'scheduler_runs',
  'schedule_tbd',
  'import_application_records',
];
async function table(name) {
  const { data, error } = await mockSupabase.from(name).select('*').eq('organization_id', ORG);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data ?? [];
}
/** Everything the import can write, as text: equal before and after means nothing was written. */
async function snapshot() {
  const out = {};
  for (const name of TABLES) {
    out[name] = (await table(name))
      .slice()
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  return JSON.stringify(out);
}
const stage = (overrides = {}) =>
  stageMapPreview(mockSupabase, {
    ...params,
    headers: FILE_HEADERS,
    rows: FILE_ROWS,
    choices: CHOICES,
    ...overrides,
  });
/** Another admin publishes the saved game the file would move (the Published switch's RPC). */
async function publishTheMovedGame() {
  const { error } = await mockSupabase.rpc('admin_set_games_published', {
    p_organization_id: ORG,
    p_assignment_ids: [SAVED.open],
    p_published: true,
    p_reason_code: null,
    p_note: null,
    p_scope: { kind: 'selection', value: 'test' },
  });
  expect(error).toBeNull();
}

beforeEach(() => {
  seedGameImportWorld();
});

describe('F3: the preview, its conflict audit and the saved result agree over one file', () => {
  it('the file reaches every outcome (a comparison over fewer would compare fewer)', async () => {
    const { preview, summary } = await stage();
    const c = core.scheduleImportConfirmCounts(preview);
    expect(c['games.inserted']).toBeGreaterThan(0); // new games
    expect(c['games.updated']).toBeGreaterThan(0); // a saved game found by its Game ID and moved
    expect(c['games.skipped.skipped-published']).toBeGreaterThan(0); // a Published game the file would move
    expect(c['time_tbd.inserted']).toBeGreaterThan(1); // no time, and a time that could not be read
    expect(c['rows.refused']).toBeGreaterThan(1);
    expect(Object.keys(preview.refused_by_reason).sort()).toEqual(['bad-date', 'unknown-team']);
    for (const key of ['divisions', 'fields', 'teams', 'outside_teams', 'slots'])
      expect(c[`created.${key}`], key).toBeGreaterThan(0);
    expect(c.not_in_file).toBeGreaterThan(0); // a saved game the file does not name
    expect(c['warnings.field-overlap']).toBe(1); // a flagged conflict, imported anyway
    expect(c['warnings.week-differs']).toBe(1);
    expect(c.arrive_published).toBe(true);
    // the parse's own warnings (F5) are the upload's
    expect(summary.warnings.map((w) => w.code).sort()).toEqual([
      'bad-time',
      'bad-week',
      'week-differs',
    ]);
    // `games.unchanged` is reached by the round trip (tests/gameImportRoundTrip.test.jsx), where it is every game
    expect(c['games.unchanged']).toBe(0);
  });

  it('the dry run writes nothing, and the apply returns the preview to the last key', async () => {
    const before = await snapshot();
    const { jobId, preview } = await stage();
    expect(preview.dry_run).toBe(true);
    // staging and mapping touch only the job and its staged rows: nothing the import writes has changed
    expect(await snapshot()).toBe(before);

    const outcome = await confirmPreview(mockSupabase, { organizationId: ORG, jobId, preview });
    expect(outcome.status).toBe('applied');
    const result = outcome.result;
    expect(result.dry_run).toBe(false);
    // every key but the two that say "this one wrote": the flag, and the ids of what it made
    const comparable = ({ dry_run: _d, ids: _i, ...rest }) => rest;
    expect(comparable(result)).toEqual(comparable(preview));
    expect(preview.ids).toEqual({ run_id: null, team_run_ids: [] });
    expect(result.ids.run_id).toEqual(expect.any(String));
    // the counts the confirm screen showed are the counts of what was done
    expect(core.scheduleImportConfirmCounts(result)).toEqual(
      core.scheduleImportConfirmCounts(preview)
    );
    expect(await snapshot()).not.toBe(before);
  });

  it('the rows the apply wrote, read back, are the counts it gave', async () => {
    const gamesBefore = await table('game_assignments');
    const { jobId, preview } = await stage();
    const { result } = await confirmPreview(mockSupabase, { organizationId: ORG, jobId, preview });
    const records = (await table('import_application_records')).filter(
      (r) => r.import_job_id === jobId
    );
    const written = (target, operation) =>
      records.filter((r) => r.target_table === target && r.operation === operation).length;
    const games = await table('game_assignments');
    const run = games.filter((g) => g.run_id === result.ids.run_id);
    // the new run is the whole visible schedule: added, changed and carried
    expect(run.length).toBe(result.games.inserted + result.games.updated + result.games.repointed);
    expect(games.length - gamesBefore.length).toBe(result.games.inserted);
    expect(written('game_assignments', 'inserted')).toBe(result.games.inserted);
    expect(games.filter((g) => g.import_job_id === jobId).length).toBeGreaterThanOrEqual(
      result.games.inserted
    );
    // new games arrive Published, as the preview said they would
    const added = games.filter(
      (g) => g.import_job_id === jobId && !gamesBefore.some((b) => b.id === g.id)
    );
    expect(added).toHaveLength(result.games.inserted);
    expect(added.every((g) => g.published === true)).toBe(result.arrive_published);
    // the records it created
    expect(written('schedule_tbd', 'inserted')).toBe(result.time_tbd.inserted);
    expect((await table('schedule_tbd')).length).toBe(result.time_tbd.inserted);
    expect(written('teams', 'inserted')).toBe(result.created.teams + result.created.outside_teams);
    expect((await table('teams')).filter((t) => t.is_external).length).toBe(
      result.created.outside_teams
    );
    expect(written('divisions', 'inserted')).toBe(result.created.divisions);
    expect(written('fields', 'inserted')).toBe(result.created.fields);
    expect(written('game_slots', 'inserted')).toBe(result.created.slots);
    // the Published game the file would have moved was not moved
    // (it is carried into the new run, which is the whole visible schedule: its run changes and nothing else does)
    const place = ({ run_id: _run, updated_at: _at, ...rest }) => rest;
    const held = games.find((g) => g.id === SAVED.published);
    expect(place(held)).toEqual(place(gamesBefore.find((g) => g.id === SAVED.published)));
    expect(held.run_id).toBe(result.ids.run_id);
    // a TIME TBD game holds its date and no time
    for (const tbd of await table('schedule_tbd')) {
      expect(tbd.game_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(tbd.reason).toBe('imported-without-time');
    }
  });

  it('the conflict audit: the preview’s, the result’s, the saved run’s, and the product’s own audit of the saved games', async () => {
    const { jobId, preview } = await stage();
    const { result } = await confirmPreview(mockSupabase, { organizationId: ORG, jobId, preview });
    // the same warnings before and after the write, and the Games page reads them from the run
    expect(result.warnings).toEqual(preview.warnings);
    const run = (await table('scheduler_runs')).find((r) => r.id === result.ids.run_id);
    expect(run.results.warnings).toEqual(result.warnings);
    expect(run.results.not_judged).toEqual(['coach-conflict', 'home-away-imbalance']);
    // the job keeps the result
    const { data: jobs } = await mockSupabase.from('import_jobs').select('*').eq('id', jobId);
    expect(jobs[0].warning_summary.game_import).toEqual(result);

    // The audit over the SAVED rows (evaluateGameSchedule, the function the Games page runs on a review) finds the
    // same field and team clashes the preview found over the staged rows.
    const saved = (await table('game_assignments')).filter((g) => g.run_id === result.ids.run_id);
    const teams = await table('teams');
    const audit = evaluateGameSchedule({
      assignments: saved.map((g) => ({
        weekIndex: g.week_index,
        division: g.division,
        slotId: g.game_slot_id,
        start: g.start,
        end: g.end,
        fieldId: g.field_id,
        homeTeamId: g.home_team_id,
        awayTeamId: g.away_team_id,
      })),
      teams: teams.map((t) => ({ id: t.id, division: t.division_id, coachId: null })),
    });
    const clash = (warnings, type, key) =>
      warnings
        .filter((w) => w.type === type)
        .map((w) => String(w.details[key]))
        .sort();
    expect(clash(audit.warnings, 'field-overlap', 'fieldId')).toEqual(
      clash(preview.warnings, 'field-overlap', 'fieldId')
    );
    expect(clash(preview.warnings, 'field-overlap', 'fieldId')).toHaveLength(1);
    const external = new Set(teams.filter((t) => t.is_external).map((t) => String(t.id)));
    expect(
      clash(audit.warnings, 'team-double-booked', 'teamId').filter((id) => !external.has(id))
    ).toEqual(clash(preview.warnings, 'team-double-booked', 'teamId'));
  });

  it('a count computed apart from the dry run would be wrong here (why the confirm reads the dry run)', async () => {
    // The browser can resolve the rows (core), and that is all it can do: it cannot know which saved game a row
    // names, which is Published, or what is already as the file has it. Its numbers and the dry run's differ on this
    // file, so a confirm screen that showed the browser's would not show what the apply does.
    const { staged, league, mapping, preview } = await stage();
    const browser = core.resolveScheduleRows({
      rows: staged,
      league,
      decisions: mapping,
      explicitOnly: true,
    });
    // they agree on what the mapping alone decides
    expect(browser.counts.refused).toBe(preview.rows.refused);
    expect(browser.counts.tbd).toBe(preview.rows.time_tbd);
    expect(browser.creations.teamShells.length).toBe(preview.created.teams);
    expect(browser.creations.outsideTeams.length).toBe(preview.created.outside_teams);
    expect(browser.creations.divisions.length).toBe(preview.created.divisions);
    expect(browser.creations.fields.length).toBe(preview.created.fields);
    // and only the dry run knows the rest
    expect(browser.counts.ok).toBe(9);
    expect(preview.games.inserted).toBe(7);
    expect(preview.games.updated).toBe(1);
    expect(preview.games.skipped).toEqual({ 'skipped-published': 1 });
    expect(browser.counts.ok).not.toBe(preview.games.inserted);
  });
});

describe('F7: a preview that went stale is refused, in the mock and in the Edge function’s own code', () => {
  it('CONTROL: an unchanged schedule applies', async () => {
    const { jobId, preview } = await stage();
    const outcome = await confirmPreview(mockSupabase, { organizationId: ORG, jobId, preview });
    expect(outcome.status).toBe('applied');
    expect(outcome.result.games.updated).toBe(1);
  });

  it('the mock’s import-validation: refused with both sets of counts, and nothing is written', async () => {
    const { jobId, preview } = await stage();
    await publishTheMovedGame();
    const before = await snapshot();
    const outcome = await confirmPreview(mockSupabase, { organizationId: ORG, jobId, preview });
    expect(outcome.status).toBe('stale');
    // the game is now held: its row is skipped, not an update, and the slot the move needed is not made
    expect(outcome.differing).toEqual([
      'created.slots',
      'games.skipped.skipped-published',
      'games.updated',
    ]);
    expect(outcome.confirmed['games.updated']).toBe(1);
    expect(outcome.current['games.updated']).toBe(0);
    expect(outcome.current['games.skipped.skipped-published']).toBe(2);
    expect(outcome.preview.dry_run).toBe(true);
    expect(await snapshot()).toBe(before);
    const { data: jobs } = await mockSupabase.from('import_jobs').select('*').eq('id', jobId);
    expect(jobs[0].status).toBe('ready_to_apply');
    // the answer itself, as the function gives it: 409, the code, both sets of counts
    const raw = await mockSupabase.functions.invoke('import-validation', {
      body: {
        import_type: 'games',
        action: 'apply',
        organization_id: ORG,
        import_job_id: jobId,
        confirmed: core.scheduleImportConfirmCounts(preview),
      },
    });
    expect(raw.data).toBeNull();
    expect(raw.error.context.status).toBe(409);
    const body = await raw.error.context.json();
    expect(body).toMatchObject({ status: 'error', code: 'game_import_preview_stale' });
    expect(Object.keys(body).sort()).toEqual(
      ['code', 'confirmed', 'current', 'differing', 'message', 'preview', 'status'].sort()
    );
    // confirming the fresh preview applies
    const again = await confirmPreview(mockSupabase, {
      organizationId: ORG,
      jobId,
      preview: outcome.preview,
    });
    expect(again.status).toBe('applied');
  });

  it('the Edge function’s own code over the same database: the same refusal, the same differing counts, nothing written', async () => {
    // `applyGameImportConfirmed` is what `import-validation` runs for `action: 'apply'`. It is given the database as
    // the function is (a call by name with its parameters); here that database is the mock.
    const rpc = (name, args) => mockSupabase.rpc(name, args);
    const { jobId, preview } = await stage();
    const confirmed = edge.gameImportConfirmCounts(preview);
    expect(confirmed).toEqual(core.scheduleImportConfirmCounts(preview));
    await publishTheMovedGame();
    const before = await snapshot();
    const outcome = await edge.applyGameImportConfirmed({ rpc, jobId, confirmed });
    expect(outcome.kind).toBe('stale');
    expect(outcome.code).toBe('game_import_preview_stale');
    // the game is now held: its row is skipped, not an update, and the slot the move needed is not made
    expect(outcome.differing).toEqual([
      'created.slots',
      'games.skipped.skipped-published',
      'games.updated',
    ]);
    expect(outcome.confirmed).toEqual(confirmed);
    expect(outcome.current['games.updated']).toBe(0);
    expect(await snapshot()).toBe(before);
    // CONTROL in the same code: the fresh counts apply, and a retry after that answers with the stored result
    const applied = await edge.applyGameImportConfirmed({
      rpc,
      jobId,
      confirmed: edge.gameImportConfirmCounts(outcome.preview),
    });
    expect(applied.kind).toBe('applied');
    expect(applied.result.dry_run).toBe(false);
    const retry = await edge.applyGameImportConfirmed({ rpc, jobId, confirmed });
    expect(retry.kind).toBe('applied');
    expect(retry.result.replayed).toBe(true);
  });

  it('a confirm with no counts is refused (it would compare nothing), and a database refusal keeps its code', async () => {
    const { jobId } = await stage();
    const before = await snapshot();
    for (const confirmed of [undefined, {}, { arrive_published: true }]) {
      const raw = await mockSupabase.functions.invoke('import-validation', {
        body: {
          import_type: 'games',
          action: 'apply',
          organization_id: ORG,
          import_job_id: jobId,
          confirmed,
        },
      });
      expect(raw.error.context.status).toBe(400);
      expect((await raw.error.context.json()).code).toBe('confirmed_counts_required');
    }
    expect(await snapshot()).toBe(before);
    // a job that is not a games job, and one of another organization
    const other = await mockSupabase.functions.invoke('import-validation', {
      body: {
        import_type: 'games',
        action: 'apply',
        organization_id: ORG,
        import_job_id: '0a000000-0000-4000-8000-00000000dead',
        confirmed: { arrive_published: true, nothing_to_apply: false, 'rows.staged': 1 },
      },
    });
    expect(other.error.context.status).toBe(404);
  });
});
