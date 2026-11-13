/**
 * F11-3 task C5 (docs/changes/2026-11-06-games-table-source-of-truth.md; lesson 74: a second implementation drifts):
 * `current_game_runs`, the one SQL definition of "the schedule" that every repointed reader asks, picks the run the
 * Games page's own hook picks (`useSchedulerRun('game', ...)`).
 *
 * Three arms over one fixture: the hook, run as the page runs it over the mock client; the mock's copy of the view
 * (`deriveCurrentGameRuns`), which is what the readers' tests read; and the view's SQL, held by its text to the same
 * rule and by `supabase/tests/game_scores.sql` section 6 (the pgTAP cases named below are required to be there).
 *
 * The fixture: two seasons of one organization; season one has an older and a newer completed game run, and later a
 * failed game run and a completed practice run; season two names its run only in the older `season_id` column; a
 * completed game run with no season is the newest of all; another organization's newer run; a season with none.
 *
 * Declared, not covered: two runs completed at the same instant. The hook orders by `completed_at` alone and takes
 * the first the server returns; the view breaks the tie by `created_at`, then `id`. A save stamps its own instant, so
 * a tie needs two saves in one microsecond.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seedMockDb } from './helpers/seedMockDb.js';

const ORG = 'org-parity';
const S1 = 'season-parity-1';
const S2 = 'season-parity-2';
const S_NONE = 'season-parity-none';
const context = vi.hoisted(() => ({ seasonId: /** @type {string | null} */ (null) }));

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: 'org-parity' },
    currentSeasonSetting: context.seasonId ? { id: context.seasonId } : null,
  }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { useSchedulerRun } = await import('../frontend/src/hooks/useSchedulerRun.js');
const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
const { deriveCurrentGameRuns } = await import('../frontend/src/lib/mockGameScores.js');

const run = (id, over) => ({
  id,
  organization_id: ORG,
  run_type: 'game',
  status: 'completed',
  season_settings_id: null,
  season_id: null,
  created_at: over.completed_at,
  ...over,
});
const RUNS = [
  run('r1-older', { season_settings_id: S1, completed_at: '2026-09-01T00:00:00Z' }),
  run('r1-newer', { season_settings_id: S1, completed_at: '2026-09-05T00:00:00Z' }),
  run('r1-failed', {
    season_settings_id: S1,
    status: 'failed',
    completed_at: '2026-09-09T00:00:00Z',
  }),
  run('r1-practice', {
    season_settings_id: S1,
    run_type: 'practice',
    completed_at: '2026-09-10T00:00:00Z',
  }),
  run('r2-old-column', { season_id: S2, completed_at: '2026-08-01T00:00:00Z' }),
  run('r-no-season', { completed_at: '2026-12-01T00:00:00Z' }),
  run('r-other-org', {
    organization_id: 'org-elsewhere',
    season_settings_id: S1,
    completed_at: '2026-12-02T00:00:00Z',
  }),
];
/** What each season's schedule is, from the fixture alone. */
const EXPECTED = { [S1]: 'r1-newer', [S2]: 'r2-old-column', [S_NONE]: null };

beforeEach(() => {
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  seedMockDb({
    season_settings: [S1, S2, S_NONE].map((id) => ({ id, organization_id: ORG, status: 'active' })),
    scheduler_runs: RUNS,
    schedule_evaluations: [],
  });
});

async function hookRun(seasonId) {
  context.seasonId = seasonId;
  const { result } = renderHook(() =>
    useSchedulerRun('game', (row) => ({ runId: row.id }), { runId: null })
  );
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.error).toBeNull();
  return result.current.data.runId;
}
async function viewRun(seasonId) {
  const { data, error } = await mockSupabase
    .from('current_game_runs')
    .select('run_id')
    .eq('organization_id', ORG)
    .eq('season_settings_id', seasonId);
  expect(error).toBeNull();
  expect(data.length).toBeLessThanOrEqual(1);
  return data[0]?.run_id ?? null;
}

describe('current_game_runs picks the run useSchedulerRun picks', () => {
  it.each(Object.entries(EXPECTED))('season %s', async (seasonId, expected) => {
    expect(await hookRun(seasonId)).toBe(expected);
    expect(await viewRun(seasonId)).toBe(expected);
  });

  it('the view has one row per season with a run, and none for a run with no season', async () => {
    const rows = deriveCurrentGameRuns(JSON.parse(sessionStorage.getItem('__MOCK_DB__')));
    expect(
      rows.filter((r) => r.organization_id === ORG).map((r) => [r.season_settings_id, r.run_id])
    ).toEqual([
      [S1, 'r1-newer'],
      [S2, 'r2-old-column'],
    ]);
  });

  it('PLANT: a view that read only season_settings_id would disagree with the hook (so the case can fail)', async () => {
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__'));
    const planted = deriveCurrentGameRuns({
      ...db,
      scheduler_runs: db.scheduler_runs.map(({ season_id: _gone, ...rest }) => rest),
    });
    expect(planted.find((r) => r.season_settings_id === S2)).toBeUndefined();
    expect(await hookRun(S2)).toBe('r2-old-column');
  });
});

describe('the SQL of the view and the hook state the same rule', () => {
  const MIGRATION = readFileSync(
    path.join(process.cwd(), 'supabase/migrations/20261122010000_game_scores.sql'),
    'utf8'
  );
  const view = MIGRATION.slice(
    MIGRATION.indexOf('CREATE VIEW public.current_game_runs'),
    MIGRATION.indexOf('REVOKE ALL ON public.current_game_runs')
  );
  const HOOK = readFileSync(
    path.join(process.cwd(), 'frontend/src/hooks/useSchedulerRun.js'),
    'utf8'
  );
  const FILTER = readFileSync(
    path.join(process.cwd(), 'frontend/src/utils/schedulerRunFilters.js'),
    'utf8'
  );
  const PGTAP = readFileSync(path.join(process.cwd(), 'supabase/tests/game_scores.sql'), 'utf8');

  it('a completed game run of the organization and of the season by either column, the latest first', () => {
    expect(view.length).toBeGreaterThan(100);
    expect(view).toMatch(/sr\.run_type = 'game'/);
    expect(view).toMatch(/sr\.status = 'completed'/);
    expect(view).toMatch(/sr\.organization_id = s\.organization_id/);
    expect(view).toMatch(/\(sr\.season_settings_id = s\.id OR sr\.season_id = s\.id\)/);
    expect(view).toMatch(/ORDER BY s\.organization_id, s\.id, sr\.completed_at DESC/);
    // The hook: the same filters and order (the season by either column, through the shared filter).
    expect(HOOK).toMatch(/\.eq\('run_type', runType\)/);
    expect(HOOK).toMatch(/\.eq\('status', 'completed'\)/);
    expect(HOOK).toMatch(/\.order\('completed_at', \{ ascending: false \}\)/);
    expect(HOOK).toMatch(/scopeSchedulerRunsToActiveSeason\(runQuery/);
    expect(FILTER).toContain(
      'season_settings_id.eq.${seasonSettingId},season_id.eq.${seasonSettingId}'
    );
  });

  it('the pgTAP runs the cases this fixture runs against the real view', () => {
    for (const text of [
      "the season''s current run is the latest completed game run, as the page picks it",
      'a later run that failed, a later practice run and a later run with no season do not take its place',
      'a run that names its season only in the older season_id column is found, as the page finds it',
      'a season with no game run has no row',
    ]) {
      expect(PGTAP, text).toContain(text);
    }
  });
});
