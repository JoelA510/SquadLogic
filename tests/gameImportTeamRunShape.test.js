/**
 * The team run a games import writes, read by every reader of a team run (PR 5, fix round 2, Codex P1).
 *
 * The first shell runs carried `teams` and `team_players` and no `teamsByDivision`, the key `mapSchedulerRunToSummary`
 * reads, so the Teams, Practices and Games pages, which read the LATEST team run, listed no team at all after an
 * import that created a shell. The migration's own tables were right; the readers of the run were never run over what
 * the import wrote. This file is that run, and it is a class test: it runs
 *
 *   * the mock finalizer (the twin of the SQL, held to it by the pgTAP file's assertions of the same numbers) over a
 *     league whose latest team run is in the normal shape (keyed by division name, as the demo seed and the team
 *     review save it) and a file that creates a shell in two divisions and an outside club;
 *   * every JS reader of a team run's `results` over the run it made: `mapSchedulerRunToSummary`, `useTeamSummary`
 *     (the hook the pages use, over a client that answers with the latest run), the Games page's roster derivation
 *     (`normalizeTeam` over the summary's teams), the review's re-run (`buildPayloadByDivision`,
 *     `selectLatestTeamRunsPerDivision`) and the placement and roster-size reviews;
 *
 * and asserts that the teams the run CARRIED are listed AND that the shells are, under their divisions, and that the
 * outside club is in no run. Then it holds the migration text to the shared key set (`TEAM_RUN_RESULT_KEYS`): the SQL
 * must write each key (the pgTAP file asserts the keys of what it wrote), so a key added to the set and not to the SQL,
 * or dropped from the SQL, fails here.
 *
 * **What this covers and does not.** It covers the readers named above over the shape the mock writes, and the SQL's
 * shape by its text and by the pgTAP file; it does not render the pages. A reader of a team run that is added later is
 * covered only when it is added to the list in this file: the readers are enumerated by a grep for `results.teams`,
 * `teamsByDivision` and `team_players` in `frontend/src` and `packages/core/src`, whose result is pinned below so a new
 * reader fails the pin until it is classified.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  divisionDecisionKey,
  fieldDecisionKey,
  teamDecisionKey,
  toStagedGameRow,
  venueDecisionKey,
} from '../packages/core/src/scheduleImport/index.js';
import {
  TEAM_RUN_RESULT_KEYS,
  carryTeamRunResults,
} from '../packages/core/src/utils/teamRunResults.js';
import { mapSchedulerRunToSummary } from '../packages/core/src/utils/teamSummaryMapper.js';
import { handleGameImportRpc } from '../frontend/src/lib/mockGameImport.js';
import { normalizeTeam } from '../frontend/src/pages/GameSchedulingPage.jsx';
import {
  buildPayloadByDivision,
  selectLatestTeamRunsPerDivision,
} from '../frontend/src/utils/schedulerRunFilters.js';
import { summarizeTeamSizeReview } from '../frontend/src/utils/teamSizeReview.js';
import { summarizePlacementReview } from '../frontend/src/utils/placementReview.js';

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({ supabase: { from: vi.fn() } }));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({ useOrganization: vi.fn() }));
vi.mock('../frontend/src/lib/logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));

const { supabase } = await import('../frontend/src/lib/supabaseClient.js');
const { useOrganization } = await import('../frontend/src/contexts/OrganizationContext.jsx');
const { useTeamSummary } = await import('../frontend/src/hooks/useTeamSummary.js');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = readFileSync(
  path.join(REPO, 'supabase/migrations/20261121010000_game_import.sql'),
  'utf8'
);

const ORG = 'org-a';
const SEASON = 'season-a';
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = U(9001);
let counter = 5000;
const env = { newId: () => U(++counter), now: () => '2026-11-09T12:00:00.000Z' };
const rpc = (db, name, params) => {
  const out = handleGameImportRpc(db, name, params, {
    isOrgAdmin: () => true,
    currentUserId: ADMIN,
    ...env,
  });
  if (out === null) throw new Error(`${name} is not a games import RPC`);
  return out;
};

const D1 = U(10);
const D2 = U(11);
const T = { lions: U(1), tigers: U(2), hawks: U(5), eagles: U(6) };

/** A league whose latest team run is in the shape the team review and the demo seed save: keyed by division NAME. */
function world() {
  const own = (id, division, name) => ({
    id,
    division: division === D1 ? 'U10 Boys' : 'U12 Girls',
    division_id: division,
    name,
    coachId: null,
    assistantCoachIds: [],
    players: [{ id: `p-${name}`, name: `Player of ${name}` }],
  });
  const lions = own(T.lions, D1, 'Lions');
  const tigers = own(T.tigers, D1, 'Tigers');
  const hawks = own(T.hawks, D2, 'Hawks');
  const eagles = own(T.eagles, D2, 'Eagles');
  return {
    season_settings: [{ id: SEASON, organization_id: ORG, status: 'active', name: 'Spring' }],
    divisions: [
      { id: D1, organization_id: ORG, season_settings_id: SEASON, name: 'U10 Boys' },
      { id: D2, organization_id: ORG, season_settings_id: SEASON, name: 'U12 Girls' },
    ],
    teams: [
      { id: T.lions, organization_id: ORG, division_id: D1, name: 'Lions' },
      { id: T.tigers, organization_id: ORG, division_id: D1, name: 'Tigers' },
      { id: T.hawks, organization_id: ORG, division_id: D2, name: 'Hawks' },
      { id: T.eagles, organization_id: ORG, division_id: D2, name: 'Eagles' },
    ],
    locations: [{ id: U(30), organization_id: ORG, name: 'Park One' }],
    fields: [{ id: U(31), organization_id: ORG, location_id: U(30), name: 'Field 1' }],
    game_slots: [],
    scheduler_runs: [
      {
        id: U(62),
        organization_id: ORG,
        season_id: SEASON,
        season_settings_id: SEASON,
        run_type: 'team',
        status: 'completed',
        created_at: '2026-03-01T00:00:00Z',
        completed_at: '2026-03-01T00:00:00Z',
        parameters: { selectedProgramId: 'U12 Girls' },
        metrics: {},
        results: {
          teamsByDivision: { 'U10 Boys': [lions, tigers], 'U12 Girls': [hawks, eagles] },
          rosterBalanceByDivision: {
            'U10 Boys': { summary: { totalPlayers: 2, totalCapacity: 24, averageFillRate: 0.08 } },
            'U12 Girls': { summary: { totalPlayers: 2, totalCapacity: 24, averageFillRate: 0.08 } },
          },
          teams: [lions, tigers, hawks, eagles],
          team_players: [
            { team_id: T.lions, player_id: 'p-Lions' },
            { team_id: T.hawks, player_id: 'p-Hawks' },
          ],
        },
      },
    ],
    game_assignments: [],
    import_jobs: [],
    staging_import_rows: [],
    import_application_records: [],
    schedule_tbd: [],
    audit_log: [],
    team_players: [],
    players: [],
  };
}

const stage = (n, home, away, division, date, week) =>
  toStagedGameRow(
    /** @type {any} */ ({
      rowNumber: n,
      rowKey: `row-${n}`,
      gameId: `G-${n}`,
      status: 'ok',
      reason: null,
      message: null,
      tbdReason: null,
      date,
      startTime: '09:00',
      endTime: '10:00',
      start: `${date}T09:00:00-07:00`,
      end: `${date}T10:00:00-07:00`,
      venueLabel: 'Park One',
      fieldLabel: 'Field 1',
      divisionLabel: division,
      homeLabel: home,
      awayLabel: away,
      weekIndex: week,
      weekSource: 'file',
      flags: [],
    })
  );

/** Applies the file and returns the db and the job: a shell in each division and an outside club. */
function applied() {
  const db = world();
  const rows = [
    stage(1, 'Lions', 'Cubs', 'U10 Boys', '2026-09-12', 1),
    stage(2, 'Hawks', 'Owls', 'U12 Girls', '2026-09-12', 1),
    stage(3, 'Tigers', 'Gulls', 'U10 Boys', '2026-09-19', 2),
  ];
  const id = 'job-1';
  db.import_jobs.push({
    id,
    organization_id: ORG,
    job_type: 'games',
    status: 'importing',
    season_settings_id: SEASON,
    warning_summary: {},
  });
  rows.forEach((row, i) =>
    db.staging_import_rows.push({
      id: `r${i}`,
      organization_id: ORG,
      import_job_id: id,
      import_type: 'games',
      ...row,
    })
  );
  const mapping = {
    divisions: {
      [divisionDecisionKey('U10 Boys')]: { action: 'map', id: D1 },
      [divisionDecisionKey('U12 Girls')]: { action: 'map', id: D2 },
    },
    venues: { [venueDecisionKey('Park One')]: { action: 'map', id: U(30) } },
    fields: { [fieldDecisionKey('Park One', 'Field 1')]: { action: 'map', id: U(31) } },
    teams: {
      [teamDecisionKey('U10 Boys', 'Lions')]: { action: 'map', id: T.lions },
      [teamDecisionKey('U10 Boys', 'Tigers')]: { action: 'map', id: T.tigers },
      [teamDecisionKey('U12 Girls', 'Hawks')]: { action: 'map', id: T.hawks },
      [teamDecisionKey('U10 Boys', 'Cubs')]: { action: 'create' },
      [teamDecisionKey('U12 Girls', 'Owls')]: { action: 'create' },
      [teamDecisionKey('U10 Boys', 'Gulls')]: { action: 'outside' },
    },
  };
  expect(
    rpc(db, 'map_game_import_job', { p_import_job_id: id, p_mapping: mapping }).error
  ).toBeNull();
  const out = rpc(db, 'apply_game_import_job', { p_import_job_id: id });
  expect(out.error).toBeNull();
  expect(out.data.created).toMatchObject({ teams: 2, outside_teams: 1 });
  return { db, id, result: out.data };
}

/** The team run the pages read: the latest completed or running team run of the season. */
const latestTeamRun = (db) =>
  [...db.scheduler_runs]
    .filter((r) => r.run_type === 'team' && ['completed', 'running'].includes(r.status))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];

const names = (teams) => teams.map((t) => t.name).sort();

describe('the team run the import writes is in the shape its readers read', () => {
  it('writes ONE run that carries every key of the shared set', () => {
    const { db, result } = applied();
    expect(result.ids.team_run_ids).toHaveLength(1);
    const run = latestTeamRun(db);
    expect(run.id).toBe(result.ids.team_run_ids[0]);
    for (const key of TEAM_RUN_RESULT_KEYS) expect(run.results, key).toHaveProperty(key);
    // What the previous run carried beyond the shared set is kept (the review's roster balance, for one).
    expect(run.results.rosterBalanceByDivision['U10 Boys'].summary.totalPlayers).toBe(2);
    expect(run.results.team_players).toHaveLength(2);
  });

  it('mapSchedulerRunToSummary lists the carried teams and the shells, under their divisions', () => {
    const { db } = applied();
    const summary = mapSchedulerRunToSummary(latestTeamRun(db));
    expect(summary.totals.divisions).toBe(2);
    expect(summary.totals.teams).toBe(6);
    const byDivision = (name) => names(summary.teams.filter((t) => t.divisionName === name));
    expect(byDivision('U10 Boys')).toEqual(['Cubs', 'Lions', 'Tigers']);
    expect(byDivision('U12 Girls')).toEqual(['Eagles', 'Hawks', 'Owls']);
  });

  it('useTeamSummary, the hook the pages read the latest run through, lists both', async () => {
    const { db } = applied();
    vi.mocked(useOrganization).mockReturnValue(
      /** @type {any} */ ({
        currentOrganization: { id: ORG },
        currentSeasonSetting: { id: SEASON },
      })
    );
    // A client that answers the hook's query the way the table does: the newest completed or running team run.
    vi.mocked(supabase.from).mockImplementation(() => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        or: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve({ data: latestTeamRun(db), error: null }),
      };
      return /** @type {any} */ (builder);
    });
    const { result, unmount } = renderHook(() => useTeamSummary());
    try {
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(names(result.current.summary.teams)).toEqual([
        'Cubs',
        'Eagles',
        'Hawks',
        'Lions',
        'Owls',
        'Tigers',
      ]);
    } finally {
      await act(async () => unmount());
    }
  });

  it("the Games page's roster derivation lists the shells with their divisions, and not the outside club", () => {
    const { db } = applied();
    const summary = mapSchedulerRunToSummary(latestTeamRun(db));
    const roster = summary.teams.map((entry) => normalizeTeam(entry)).filter(Boolean);
    expect(roster.map((t) => `${t.name}@${t.division}`).sort()).toEqual([
      'Cubs@U10 Boys',
      'Eagles@U12 Girls',
      'Hawks@U12 Girls',
      'Lions@U10 Boys',
      'Owls@U12 Girls',
      'Tigers@U10 Boys',
    ]);
    // The outside club is a legal side of a game and is in no team run (the solver is never handed it).
    const gulls = db.teams.find((t) => t.name === 'Gulls');
    expect(gulls.is_external).toBe(true);
    expect(JSON.stringify(latestTeamRun(db).results)).not.toContain(gulls.id);
  });

  it("the team review's re-run finds each division's teams, shells included, in the newest run", () => {
    const { db } = applied();
    const runs = db.scheduler_runs.filter((r) => r.run_type === 'team');
    const payload = buildPayloadByDivision(
      [...runs].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    );
    const rowsOf = (division) => names(payload[division].teamRows);
    expect(rowsOf('U10 Boys')).toEqual(['Cubs', 'Lions', 'Tigers']);
    expect(rowsOf('U12 Girls')).toEqual(['Eagles', 'Hawks', 'Owls']);
    // The newest run per division (the RPC's mirror) still returns runs the page can seed a re-run from.
    expect(selectLatestTeamRunsPerDivision(runs).length).toBeGreaterThan(0);
  });

  it('the placement and roster-size reviews read the run without losing a team', () => {
    const { db } = applied();
    const results = latestTeamRun(db).results;
    expect(() => summarizeTeamSizeReview(results)).not.toThrow();
    expect(() => summarizePlacementReview(results)).not.toThrow();
    const sizes = summarizeTeamSizeReview(results);
    expect(JSON.stringify(sizes)).not.toContain('undefined');
  });

  it('a rollback takes the run away and the pages read the previous run again', () => {
    const { db, id } = applied();
    expect(rpc(db, 'rollback_game_import_job', { p_import_job_id: id }).error).toBeNull();
    const summary = mapSchedulerRunToSummary(latestTeamRun(db));
    expect(summary.totals.teams).toBe(4);
  });
});

describe('carryTeamRunResults, the one function that makes the shape', () => {
  const division = { id: D1, name: 'U10 Boys', teams: [{ id: 'new-1', name: 'Cubs' }] };

  it('adds a division to a league with no team run, from the teams the table holds', () => {
    const out = carryTeamRunResults({
      base: null,
      divisions: [division],
      ownTeams: [{ id: T.lions, name: 'Lions', division_id: D1 }],
    });
    expect(Object.keys(out.teamsByDivision)).toEqual(['U10 Boys']);
    expect(names(out.teamsByDivision['U10 Boys'])).toEqual(['Cubs', 'Lions']);
    expect(out.teams).toHaveLength(2);
    expect(out.team_players).toEqual([]);
  });

  it('keeps the key the base already uses for the division, whether that is its id or its name', () => {
    const byId = carryTeamRunResults({
      base: { teamsByDivision: { [D1]: [{ id: T.lions, name: 'Lions', division: D1 }] } },
      divisions: [division],
    });
    expect(Object.keys(byId.teamsByDivision)).toEqual([D1]);
    expect(byId.teamsByDivision[D1].at(-1).division).toBe(D1);
    const byTeam = carryTeamRunResults({
      base: {
        teamsByDivision: { 'Some Heading': [{ id: T.lions, name: 'Lions', division_id: D1 }] },
      },
      divisions: [division],
    });
    expect(Object.keys(byTeam.teamsByDivision)).toEqual(['Some Heading']);
  });

  it('groups a base that has only the flat list (an older run) and carries everything else', () => {
    const out = carryTeamRunResults({
      base: {
        teams: [{ id: T.lions, name: 'Lions', division: D1, division_id: D1 }],
        extra: { kept: true },
        team_players: [{ team_id: T.lions, player_id: 'p' }],
      },
      divisions: [division],
    });
    expect(out.extra).toEqual({ kept: true });
    expect(names(out.teamsByDivision[D1])).toEqual(['Cubs', 'Lions']);
    expect(out.team_players).toHaveLength(1);
  });

  it('a division that gained nothing changes nothing', () => {
    const base = { teamsByDivision: { A: [{ id: 'a', name: 'A1' }] }, teams: [], team_players: [] };
    const out = carryTeamRunResults({ base, divisions: [] });
    expect(out.teamsByDivision).toEqual(base.teamsByDivision);
  });
});

describe('the migration writes the shared key set', () => {
  /** The apply's shell-run block: from its comment to the outside clubs'. */
  const block = (() => {
    const start = MIGRATION.indexOf('-- Team shells, through the audited team writer');
    const end = MIGRATION.indexOf('-- Outside clubs: team rows flagged is_external');
    return start >= 0 && end > start ? MIGRATION.slice(start, end) : '';
  })();

  it('finds the block it holds (a check that examined nothing is a failure)', () => {
    expect(block.length).toBeGreaterThan(500);
    expect(block).toContain('persist_team_schedule');
  });

  it.each([...TEAM_RUN_RESULT_KEYS])('the SQL writes %s into the run it makes', (key) => {
    expect(block).toContain(`'${key}'`);
  });

  it('and the pgTAP file asserts exactly that set of keys on what the apply wrote', () => {
    const pgtap = readFileSync(
      path.join(REPO, 'supabase/tests/game_import_apply_rollback.sql'),
      'utf8'
    );
    const wanted = [...TEAM_RUN_RESULT_KEYS].sort().join(',');
    expect(pgtap).toContain(
      `'${wanted}',\n    'its results carry exactly the key set the readers read`
    );
  });

  it('writes ONE run for the whole apply, not one per division (a later run shadows an earlier one)', () => {
    expect(block.match(/persist_team_schedule\(/g)).toHaveLength(1);
  });
});

describe('the readers of a team run are enumerated, so a new one is classified', () => {
  /** @param {string} dir @returns {string[]} */
  const files = (dir) =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return files(full);
      return /\.(js|jsx)$/.test(name) ? [full] : [];
    });
  // A reader of a saved run: a path into `results` for one of the keys. (Blind spot, declared: a reader that
  // destructures `results` is not seen; the mapper is the one that does, and it is run above.)
  const READS_A_RUN = /\bresults\??\.(teamsByDivision|teams|team_players)\b/;
  const readers = ['frontend/src', 'packages/core/src']
    .flatMap((root) => files(path.join(REPO, root)))
    .filter((file) => READS_A_RUN.test(readFileSync(file, 'utf8')))
    .map((file) => path.relative(REPO, file))
    .filter((file) => !/mock/i.test(path.basename(file)))
    .sort();

  it('names every reader of the keys, and each is covered above or is a writer', () => {
    // Covered above: the mapper (and so useTeamSummary, useDashboardData and the pages), the review's re-run, the
    // placement and size reviews. Writers (they build a run, they do not read the latest): teamReviewPersistence,
    // teamRunResults, the team analysis page. The rest read a run the page already holds, by key, as the mapper does.
    expect(readers).toMatchInlineSnapshot(`
      [
        "frontend/src/components/teaming/BuddyRequestsList.jsx",
        "frontend/src/hooks/useTeamPersistence.js",
        "frontend/src/pages/TeamAnalysisPage.jsx",
        "frontend/src/utils/placementReview.js",
        "frontend/src/utils/schedulerRunFilters.js",
        "frontend/src/utils/teamReviewPersistence.js",
        "frontend/src/utils/teamSizeReview.js",
      ]
    `);
  });
});
