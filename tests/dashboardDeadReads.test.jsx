/**
 * Two dead reads on the workflow dashboard, and the twin-arm shape underneath
 * both.
 *
 * ## The `timezone` that nothing produced
 *
 * `WorkflowPage` destructured `timezone` from `useDashboardData()`, which has
 * never returned one, and threaded the resulting `undefined` through
 * `DashboardWorkflow` into `TeamListView` and `GameReadinessPanel`. Both leaves
 * spent it on `formatDate(generatedAt, timezone)`.
 *
 * **`generatedAt` is the wrong value to zone.** It is
 * `scheduler_runs.completed_at || created_at` (see `practiceSummaryMapper` and
 * `gameSummaryMapper`) -- a real instant carrying a zone, not a season wall
 * time. #402 settled what that reads on for `PracticeReadinessPanel` and
 * `TeamOverviewPanel`: the viewer's own clock, and the absence of the prop is
 * the contract. Those two panels were fixed and their two siblings were not,
 * which is this phase's recurring shape rather than a new one.
 *
 * So the remedy is to delete the prop, not to supply it. Supplying it is what
 * `GameSchedulingPage` already did -- it holds a real
 * `currentSeasonSetting.timezone` and passed it to `GameReadinessPanel` -- and
 * that is the one place the defect was rendering rather than merely latent: a
 * run timestamp read on the season's clock instead of the operator's.
 *
 * ## The four KPI cards no producer could fill
 *
 * `PracticeReadinessPanel` read `balancedScore`, `manualActionRequiredCount`,
 * `venueSaturation` and `conflictFreeTeams` off the practice snapshot. The
 * snapshot is `scheduler_runs.results` verbatim, i.e. `evaluatePracticeSchedule`'s
 * report, and it has never carried any of those four keys. Each card had a
 * `?? 0` / `?? 'Unknown'` fallback, so all four rendered a confident constant.
 *
 * That is LIVE-8's defect (`lastCalculated`, no producer) on LIVE-8's own
 * component: the fix landed on the header line and left the four cards beside
 * it. Only one of the four has a metric that measures the same quantity --
 * `summary.unassignedTeams`, "teams requiring manual slot assignment" -- so
 * that one is wired and the other three are deleted. Deriving venue saturation
 * from `slotUtilization` or conflict-free teams from `coachConflicts` would
 * produce a plausible number that could not be told from a real one.
 *
 * **Subject sets here are taken from the producer, never from the reader.**
 * The engine is called and its own keys are the universe, so re-introducing any
 * of the four in `practiceMetrics.js` changes this file's answer. Enumerating
 * from the panel would only prove what the panel happens to mention.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { evaluatePracticeSchedule } from '@squadlogic/core/practiceMetrics.js';
import { mapSchedulerRunToPracticeSummary } from '@squadlogic/core/utils/practiceSummaryMapper.js';
import { mapSchedulerRunToGameSummary } from '@squadlogic/core/utils/gameSummaryMapper.js';
import { makeSchedulerRun } from './factories/index.js';
import { formatDate } from '../frontend/src/utils/formatters.js';
import GameReadinessPanel from '../frontend/src/components/GameReadinessPanel.jsx';
import PracticeReadinessPanel from '../frontend/src/components/PracticeReadinessPanel.jsx';
import TeamListView from '../frontend/src/components/teaming/TeamListView.jsx';
import TeamOverviewPanel from '../frontend/src/components/TeamOverviewPanel.jsx';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Deliberately just after UTC midnight, so a westward zone reads it as the
 * PREVIOUS calendar day. `formatDate` prints a date and nothing else, so an
 * instant at midday would render identically in both zones and the assertions
 * below could not tell a fixed panel from a broken one.
 */
const COMPLETED_AT = '2026-03-04T02:30:00Z';

/**
 * A season zone that this host reads the instant above differently from.
 *
 * Every assertion below is "it rendered the viewer's date, not the season's",
 * so a season zone that happens to equal the runner's own zone would make the
 * two strings identical and every one of them would pass over a completely
 * unfixed component. Hard-coding one zone bought that silence on any
 * contributor whose machine sat in it -- `vitest.config.js` pins no `TZ`, so
 * the runner's zone is whatever the machine has.
 *
 * The zone is therefore chosen against the host at load time, from candidates
 * spread far enough around the clock that no single host zone can collide with
 * all of them. `undefined` here is a loud failure in the precondition test
 * below, never a skipped assertion.
 */
const SEASON_TZ = ['America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Kiritimati', 'Etc/GMT+12'].find(
  (zone) => formatDate(COMPLETED_AT, zone) !== formatDate(COMPLETED_AT)
);

/** The real engine report a practice run persists into `scheduler_runs.results`. */
function engineReport({ assignedCount = 3, unassignedCount = 2 } = {}) {
  const total = assignedCount + unassignedCount;
  const teams = Array.from({ length: total }, (_, i) => ({
    id: `t${i + 1}`,
    division: i % 2 === 0 ? 'U10' : 'U12',
    coachId: `c${i + 1}`,
  }));
  const slots = [
    {
      id: 's1',
      capacity: 10,
      start: '2026-03-02T22:00:00Z',
      end: '2026-03-02T23:00:00Z',
      day: 'Monday',
    },
  ];
  const assignments = teams
    .slice(0, assignedCount)
    .map((team) => ({ teamId: team.id, slotId: 's1' }));
  const unassigned = teams
    .slice(assignedCount)
    .map((team) => ({ teamId: team.id, reason: 'no available slot' }));

  return evaluatePracticeSchedule({
    assignments,
    unassigned,
    teams,
    slots,
    schoolDayEnd: undefined,
    timezone: SEASON_TZ,
  });
}

/* ------------------------------------------------------------------ *
 * Defect A -- the timezone nothing produced
 * ------------------------------------------------------------------ */

describe('the two zones a run timestamp could be read on are distinguishable here', () => {
  it('the viewer reading and the season reading of the same instant differ', () => {
    // Every assertion in the next two describes is "it rendered A, not B". If
    // A and B were the same string in this environment the tests would pass
    // over a completely unfixed component. This is the precondition that makes
    // them capable of failing, so it fails loudly rather than being assumed.
    expect(SEASON_TZ).toBeDefined();
    expect(formatDate(COMPLETED_AT)).not.toBe(formatDate(COMPLETED_AT, SEASON_TZ));
  });
});

describe('a run timestamp renders on the viewer clock in every panel that shows one', () => {
  /**
   * The subject set is the four panels that render a `scheduler_runs`
   * timestamp, enumerated by hand from the components rather than from the
   * props any one of them happens to accept -- a panel that stopped accepting
   * `generatedAt` entirely must still appear here and fail, not vanish.
   */
  it('GameReadinessPanel shows the viewer reading of the run timestamp', () => {
    const mapped = mapSchedulerRunToGameSummary(
      makeSchedulerRun({
        run_type: 'game',
        results: { summary: { scheduledRate: 1, unscheduledMatchups: 0, teamsWithByes: 0 } },
        completed_at: COMPLETED_AT,
      })
    );

    render(
      <GameReadinessPanel
        gameReadinessSnapshot={mapped.gameReadinessSnapshot}
        gameSummary={mapped.gameSummary}
        generatedAt={mapped.generatedAt}
      />
    );

    const heading = screen.getByRole('heading', { name: 'Game readiness' });
    const header = heading.closest('header');
    expect(within(header).getByText(new RegExp(escapeRe(formatDate(COMPLETED_AT))))).toBeTruthy();
    expect(
      within(header).queryByText(new RegExp(escapeRe(formatDate(COMPLETED_AT, SEASON_TZ))))
    ).toBeNull();
  });

  it('TeamListView shows the viewer reading of the run timestamp', () => {
    render(<TeamListView totals={teamTotals()} divisions={[]} generatedAt={COMPLETED_AT} />);

    expect(screen.getByText(`Generated on ${formatDate(COMPLETED_AT)}`)).toBeTruthy();
    expect(screen.queryByText(`Generated on ${formatDate(COMPLETED_AT, SEASON_TZ)}`)).toBeNull();
  });

  it('TeamListView and TeamOverviewPanel agree: they are one panel behind a flag, not two timestamps', () => {
    // `DashboardWorkflow` renders these two as the fallback/child of a single
    // `FeatureGuard`, handed the identical `teamData.generatedAt`. A docblock
    // on `TeamOverviewPanel` claimed they "render different timestamps, not
    // the same one two ways" and used that to justify one honouring a zone and
    // the other not. They render the same value; this is the assertion that
    // says so.
    const { unmount } = render(
      <TeamListView totals={teamTotals()} divisions={[]} generatedAt={COMPLETED_AT} />
    );
    const listDate = screen.getByText(/^Generated on /).textContent.replace('Generated on ', '');
    unmount();

    render(
      <TeamOverviewPanel totals={overviewTotals()} divisions={[]} generatedAt={COMPLETED_AT} />
    );
    const overviewLine = screen.getByText(/^Generated /).textContent;

    // `TeamOverviewPanel` uses `formatDateTime` (date + time) and
    // `TeamListView` uses `formatDate`, so the date half must be common to
    // both. If either arm drifted onto a season zone this stops holding.
    expect(listDate).toBe(formatDate(COMPLETED_AT));
    expect(overviewLine).toContain(formatDate(COMPLETED_AT));
  });
});

describe('no component on the workflow dashboard chain still threads a timezone', () => {
  /**
   * The chain `WorkflowPage -> DashboardWorkflow -> {TeamListView,
   * GameReadinessPanel}`, plus the one page that holds a real season zone and
   * used to spend it on a run timestamp.
   */
  const CHAIN = [
    'frontend/src/pages/WorkflowPage.jsx',
    'frontend/src/components/DashboardWorkflow.jsx',
    'frontend/src/components/teaming/TeamListView.jsx',
    'frontend/src/components/GameReadinessPanel.jsx',
  ];

  /** A file that legitimately carries the word, so the matcher is shown working. */
  const STILL_ZONED = 'frontend/src/pages/GameSchedulingPage.jsx';

  const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

  /**
   * Code only. Each of these files now carries a docblock explaining why it
   * takes no zone, and a check that cannot tell that prose from a live
   * binding would force the explanation to be deleted to stay green.
   */
  const codeOf = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('positive control: the matcher finds timezone in code, after comments are stripped', () => {
    // Two things at once, because a scan that returns zero proves nothing
    // until the pattern has been shown matching something: the pattern works,
    // AND `codeOf` does not hide a real binding. `GameSchedulingPage` places
    // naive slot wall times on the season clock and must keep its zone.
    const source = read(STILL_ZONED);
    const code = codeOf(source);
    expect(code.length).toBeLessThan(source.length); // the stripper really stripped
    expect(/\btimezone\b/.test(code)).toBe(true);
  });

  it('positive control: the stripper does not swallow a binding that looks like prose', () => {
    // `codeOf` is only trustworthy if a `timezone` sitting in ordinary code
    // next to comments survives it.
    const sample =
      '/** timezone in a docblock */\n// timezone in a line comment\nconst timezone = x;';
    expect(/\btimezone\b/.test(codeOf(sample))).toBe(true);
    expect(codeOf('/** timezone */').trim()).toBe('');
  });

  it.each(CHAIN)('%s reads no timezone', (rel) => {
    const source = read(rel);
    // Meta-assertion: the file was really read and is really the component,
    // so "no match" is a statement about the source and not about an empty
    // string or a path typo.
    expect(source.length).toBeGreaterThan(200);
    expect(source).toContain('generatedAt');
    expect(codeOf(source)).not.toMatch(/\btimezone\b/i);
  });

  it('GameSchedulingPage no longer hands its season zone to GameReadinessPanel', () => {
    const source = read(STILL_ZONED);
    const call = source.slice(source.indexOf('<GameReadinessPanel'));
    const element = call.slice(0, call.indexOf('/>') + 2);
    // Meta-assertion: we really sliced the element out, not an empty string.
    expect(element).toContain('gameReadinessSnapshot');
    expect(element).toContain('generatedAt');
    expect(element).not.toMatch(/\btimezone\b/);
  });
});

/* ------------------------------------------------------------------ *
 * Defect B -- the KPI cards no producer could fill
 * ------------------------------------------------------------------ */

/** The four names the panel used to read. None was ever written by anything. */
const DEAD_SNAPSHOT_FIELDS = [
  'balancedScore',
  'manualActionRequiredCount',
  'venueSaturation',
  'conflictFreeTeams',
];

describe('the practice snapshot never carried the fields the KPI cards read', () => {
  it('the engine report, which IS the snapshot, has none of the four', () => {
    const report = engineReport();
    // Meta-assertion: a populated report, so "the key is absent" is a
    // statement about the engine and not about an empty object.
    expect(Object.keys(report).length).toBeGreaterThan(5);
    expect(Object.keys(report)).toContain('summary');
    expect(report.summary.totalTeams).toBeGreaterThan(0);

    for (const field of DEAD_SNAPSHOT_FIELDS) {
      expect(report).not.toHaveProperty(field);
      expect(report.summary).not.toHaveProperty(field);
    }
  });

  it('and the mapper passes the report through untouched, so it cannot acquire them', () => {
    const results = engineReport();
    const mapped = mapSchedulerRunToPracticeSummary(
      makeSchedulerRun({ run_type: 'practice', results, completed_at: COMPLETED_AT })
    );
    expect(mapped.practiceReadinessSnapshot).toBe(results);
    for (const field of DEAD_SNAPSHOT_FIELDS) {
      expect(mapped.practiceReadinessSnapshot).not.toHaveProperty(field);
    }
  });

  it('positive control: the same check catches a field that IS present', () => {
    // The loop above is only worth reading if `not.toHaveProperty` can fail
    // here. `summary` is a key the report really has.
    const report = engineReport();
    expect(() => expect(report).not.toHaveProperty('summary')).toThrow();
  });
});

describe('PracticeReadinessPanel renders only cards a producer can fill', () => {
  function renderWithRun(overrides) {
    const mapped = mapSchedulerRunToPracticeSummary(
      makeSchedulerRun({
        run_type: 'practice',
        results: engineReport(overrides),
        completed_at: COMPLETED_AT,
      })
    );
    render(
      <PracticeReadinessPanel
        practiceReadinessSnapshot={mapped.practiceReadinessSnapshot}
        generatedAt={mapped.generatedAt}
      />
    );
    return mapped;
  }

  it('the surviving card reports the engine’s unassignedTeams', () => {
    const mapped = renderWithRun({ assignedCount: 3, unassignedCount: 2 });
    expect(mapped.practiceReadinessSnapshot.summary.unassignedTeams).toBe(2);

    const card = screen.getByLabelText('Manual Actions');
    expect(within(card).getByText('2')).toBeTruthy();
  });

  it('positive control: a different run moves the number, so the card is wired and not a constant', () => {
    // The card it replaced showed `?? 0` forever. A test that only ever saw
    // one run could not tell the difference.
    const mapped = renderWithRun({ assignedCount: 2, unassignedCount: 5 });
    expect(mapped.practiceReadinessSnapshot.summary.unassignedTeams).toBe(5);

    const card = screen.getByLabelText('Manual Actions');
    expect(within(card).getByText('5')).toBeTruthy();
    expect(within(card).queryByText('0')).toBeNull();
  });

  it('the three cards with no producer are gone, not defaulted', () => {
    renderWithRun();
    for (const label of ['Field Distribution', 'Venue Saturation', 'Conflict Free']) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }
    // ...and the panel still rendered, so the absences above are not an empty
    // DOM.
    expect(screen.getByRole('heading', { name: 'Practice Readiness' })).toBeTruthy();
    expect(screen.getByLabelText('Manual Actions')).toBeTruthy();
  });

  it('an empty snapshot renders no fabricated number at all', () => {
    render(<PracticeReadinessPanel practiceReadinessSnapshot={{}} />);
    // The old panel answered "0%", "0", "Unknown", "0%" to a snapshot it knew
    // nothing about. The replacement says nothing rather than something false.
    expect(screen.queryByLabelText('Manual Actions')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Practice Readiness' })).toBeTruthy();
  });

  it('the KPI gate is satisfied by every report the engine produces', () => {
    // The loading skeleton shows a KPI placeholder, and the card is gated on
    // `summary.unassignedTeams` being a number. That promise is only honest
    // if the engine always supplies one. Driven from the engine across the
    // interesting shapes rather than asserted once.
    for (const shape of [
      { assignedCount: 0, unassignedCount: 0 },
      { assignedCount: 3, unassignedCount: 0 },
      { assignedCount: 0, unassignedCount: 4 },
      { assignedCount: 2, unassignedCount: 5 },
    ]) {
      expect(typeof engineReport(shape).summary.unassignedTeams).toBe('number');
    }
  });
});

/* ------------------------------------------------------------------ *
 * Supervisor finding 1 -- a total and a breakdown that can disagree
 * ------------------------------------------------------------------ */

/**
 * `summary.unassignedTeams` and `unassignedByReason[].count` are two different
 * quantities that usually coincide, and the panel puts them next to each other
 * as a total and its breakdown.
 *
 * `unassignedTeams` is `totalTeams - assignedTeams`, from the roster.
 * `unassignedByReason` increments its bucket **before** the roster lookup
 * (`practiceMetrics.js:331`), so it counts list entries. Every divergence
 * below is produced by the real engine from inputs it accepts -- none is a
 * hand-built snapshot -- and each is asserted to actually diverge before the
 * rendering is checked, so a future engine change that made them agree turns
 * these red rather than leaving them vacuous.
 */
function divergenceCase({ teams, assignments, unassigned }) {
  const report = evaluatePracticeSchedule({
    assignments,
    unassigned,
    teams,
    slots: [
      {
        id: 's1',
        capacity: 10,
        start: '2026-03-02T22:00:00Z',
        end: '2026-03-02T23:00:00Z',
        day: 'Monday',
      },
    ],
    schoolDayEnd: undefined,
    timezone: undefined,
  });
  const reasonsTotal = report.unassignedByReason.reduce((sum, entry) => sum + entry.count, 0);
  return { report, reasonsTotal, card: report.summary.unassignedTeams };
}

const TEAM_A = { id: 't1', division: 'U10' };
const TEAM_B = { id: 't2', division: 'U10' };
const TEAM_C = { id: 't3', division: 'U10' };

describe('the practice panel never shows a total and a breakdown that silently disagree', () => {
  it('divergence A: an unassigned entry naming a team not on the roster', () => {
    const { report, reasonsTotal, card } = divergenceCase({
      teams: [TEAM_A, TEAM_B],
      assignments: [{ teamId: 't1', slotId: 's1' }],
      unassigned: [
        { teamId: 't2', reason: 'no available slot' },
        { teamId: 'GHOST', reason: 'no available slot' },
      ],
    });
    // The divergence is real before anything is rendered.
    expect(card).toBe(1);
    expect(reasonsTotal).toBe(2);
    expect(report.dataQualityWarnings.join(' ')).toContain('GHOST');

    render(<PracticeReadinessPanel practiceReadinessSnapshot={report} />);

    expect(screen.getByText(/Reasons account for 2 teams, but 1 is unassigned/)).toBeTruthy();
    // The engine's own explanation, which nothing in the app used to render.
    expect(screen.getByText(/Unassigned list references unknown team/)).toBeTruthy();
    // Here there ARE notes, so the line may point at them.
    expect(screen.getByText(/See the data-quality notes below/)).toBeTruthy();
  });

  it('divergence B: a team in neither list — and the engine raises no warning', () => {
    const { report, reasonsTotal, card } = divergenceCase({
      teams: [TEAM_A, TEAM_B, TEAM_C],
      assignments: [{ teamId: 't1', slotId: 's1' }],
      unassigned: [{ teamId: 't2', reason: 'no available slot' }],
    });
    expect(card).toBe(2);
    expect(reasonsTotal).toBe(1);
    // This is why rendering `dataQualityWarnings` alone would not have been a
    // fix: on this divergence there is nothing to render.
    expect(report.dataQualityWarnings).toEqual([]);

    render(<PracticeReadinessPanel practiceReadinessSnapshot={report} />);

    expect(screen.getByText(/Reasons account for 1 team, but 2 are unassigned/)).toBeTruthy();
    // ...and because there are none, the line must not send the reader to a
    // data-quality section that is not rendered. This is the branch the whole
    // reconciliation exists for, so a pointer to nothing lands exactly here.
    expect(screen.queryByText(/data-quality notes/)).toBeNull();
    expect(screen.queryByText(/Data quality:/)).toBeNull();
    // The explanation still stands on its own without the pointer.
    expect(screen.getByText(/counts this run's unassigned entries/)).toBeTruthy();
  });

  it('divergence C: an assignment naming a team not on the roster', () => {
    const { report, reasonsTotal, card } = divergenceCase({
      teams: [TEAM_A],
      assignments: [{ teamId: 'GHOST2', slotId: 's1' }],
      unassigned: [],
    });
    expect(card).toBe(1);
    expect(reasonsTotal).toBe(0);

    render(<PracticeReadinessPanel practiceReadinessSnapshot={report} />);

    // No reasons at all, so the empty state carries the reconciliation --
    // and it must not claim everyone was assigned.
    expect(
      screen.getByText(/recorded no reasons for the 1 team needing manual assignment/)
    ).toBeTruthy();
    expect(screen.queryByText('All teams assigned automatically.')).toBeNull();
    expect(screen.getByText(/assignment references unknown team/)).toBeTruthy();
  });

  it('a snapshot with no unassigned list at all does not claim everyone was assigned', () => {
    // The shape any writer that omits `unassigned` persists, which is
    // divergence B for every team at once.
    const { report, reasonsTotal, card } = divergenceCase({
      teams: [TEAM_A, TEAM_B, TEAM_C],
      assignments: [],
      unassigned: [],
    });
    expect(card).toBe(3);
    expect(reasonsTotal).toBe(0);

    render(<PracticeReadinessPanel practiceReadinessSnapshot={report} />);

    expect(
      screen.getByText(/recorded no reasons for the 3 teams needing manual assignment/)
    ).toBeTruthy();
    expect(screen.queryByText('All teams assigned automatically.')).toBeNull();
  });

  it('negative control: a run that reconciles shows no discrepancy line', () => {
    const { report, reasonsTotal, card } = divergenceCase({
      teams: [TEAM_A, TEAM_B],
      assignments: [{ teamId: 't1', slotId: 's1' }],
      unassigned: [{ teamId: 't2', reason: 'no available slot' }],
    });
    // Meta-assertion: this case really does reconcile, so the absence below
    // is a statement about agreement and not about an empty panel.
    expect(card).toBe(1);
    expect(reasonsTotal).toBe(1);

    render(<PracticeReadinessPanel practiceReadinessSnapshot={report} />);

    expect(screen.queryByText(/Reasons account for/)).toBeNull();
    expect(screen.getByText(/no available slot/)).toBeTruthy();
  });

  it('negative control: a fully assigned run still says everyone was assigned', () => {
    const { report, card } = divergenceCase({
      teams: [TEAM_A],
      assignments: [{ teamId: 't1', slotId: 's1' }],
      unassigned: [],
    });
    expect(card).toBe(0);

    render(<PracticeReadinessPanel practiceReadinessSnapshot={report} />);

    expect(screen.getByText('All teams assigned automatically.')).toBeTruthy();
    expect(screen.queryByText(/Reasons account for/)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Defect A3 -- the error useDashboardData swallowed
 * ------------------------------------------------------------------ */

const runState = vi.hoisted(() => ({
  /** @type {Record<string, any>} */ byType: { team: null, practice: null, game: null },
  /** @type {Error|null} */ error: null,
  /** @type {Error|null} */ teamError: null,
}));

vi.mock('../frontend/src/hooks/useSchedulerRun.js', () => ({
  useSchedulerRun: (runType, mapper, emptyState) => {
    const run = runState.byType[runType];
    const mapped = run ? mapper(run) : null;
    return {
      data: mapped ?? emptyState,
      evaluation: null,
      loading: false,
      error: runState.error,
    };
  },
}));
vi.mock('../frontend/src/hooks/useTeamSummary.js', () => ({
  useTeamSummary: () => ({
    summary: null,
    loading: false,
    generatedAt: null,
    error: runState.teamError,
    status: 'idle',
    progress: 0,
  }),
}));
vi.mock('../frontend/src/hooks/usePracticeAssignments.js', () => ({
  usePracticeAssignments: () => ({ assignments: [], loading: false, error: null }),
}));
vi.mock('../frontend/src/hooks/useGameAssignments.js', () => ({
  useGameAssignments: () => ({ assignments: [], loading: false, error: null }),
}));
vi.mock('../frontend/src/hooks/useTeamPersistence.js', () => ({
  useTeamPersistence: () => ({ persistenceSnapshot: null, loading: false }),
}));
vi.mock('../frontend/src/contexts/ImportContext.jsx', () => ({
  useImport: () => ({ importedData: null, setImportedData: () => {} }),
}));
vi.mock('../frontend/src/contexts/ThemeContext.jsx', () => ({
  useTheme: () => ({ theme: 'light' }),
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({ currentOrganization: { id: 'org-1', name: 'Smoke FC' } }),
}));
vi.mock('../frontend/src/components/DashboardWorkflow.jsx', () => ({ default: () => null }));
vi.mock('../frontend/src/components/ui/FeatureGuard.jsx', () => ({
  FeatureGuard: ({ children }) => children,
}));

const { useDashboardData } = await import('../frontend/src/hooks/useDashboardData.js');
const { default: WorkflowPage } = await import('../frontend/src/pages/WorkflowPage.jsx');

describe('useDashboardData', () => {
  beforeEach(() => {
    runState.byType = { team: null, practice: null, game: null };
    runState.error = null;
    runState.teamError = null;
  });

  it('returns no timezone, which is why every reader of one was dead', () => {
    const { result } = renderHook(() => useDashboardData());
    // Meta-assertion: a populated return, so "the key is absent" describes the
    // hook rather than an empty object.
    const keys = Object.keys(result.current);
    expect(keys).toEqual(expect.arrayContaining(['team', 'practice', 'game', 'loading']));
    expect(keys).not.toContain('timezone');
  });

  it('surfaces a scheduler-run failure instead of swallowing it', () => {
    runState.error = new Error('permission denied for table scheduler_runs');
    const { result } = renderHook(() => useDashboardData());
    expect(result.current.error).toContain('permission denied');
  });

  it('surfaces a team-summary failure too, not just the scheduler-run arm', () => {
    // The twin arm. `useTeamSummary` is a separate hook with its own fetch and
    // its own error state; a fix that forwarded only `useSchedulerRun`'s would
    // pass the test above and still lose this one.
    runState.teamError = new Error('team summary fetch failed');
    const { result } = renderHook(() => useDashboardData());
    expect(result.current.error).toContain('team summary fetch failed');
  });

  it('reports the error as a string, so the banner cannot be handed an Error object', () => {
    // `WorkflowPage` renders `{error}` directly into a span. React throws on a
    // raw Error there ("Objects are not valid as a React child"), so the
    // string contract is load-bearing and not cosmetic.
    runState.error = new Error('boom');
    const { result } = renderHook(() => useDashboardData());
    expect(typeof result.current.error).toBe('string');
  });

  it('is null when nothing failed', () => {
    const { result } = renderHook(() => useDashboardData());
    expect(result.current.error).toBeNull();
  });
});

describe('WorkflowPage shows the dashboard error it is now given', () => {
  beforeEach(() => {
    runState.byType = { team: null, practice: null, game: null };
    runState.error = null;
    runState.teamError = null;
  });

  function renderPage() {
    return render(
      <MemoryRouter>
        <WorkflowPage />
      </MemoryRouter>
    );
  }

  it('renders the banner when a child hook reported a failure', () => {
    runState.error = new Error('permission denied for table scheduler_runs');
    renderPage();
    expect(screen.getByText(/permission denied for table scheduler_runs/)).toBeTruthy();
  });

  it('negative control: no banner when nothing failed', () => {
    renderPage();
    expect(screen.queryByText(/permission denied/)).toBeNull();
    // ...and the page really rendered, so the absence is not an empty DOM.
    expect(screen.getByRole('heading', { name: 'Season Setup Workflow' })).toBeTruthy();
  });

  it('clears the banner when the fetch recovers, rather than latching it open', () => {
    // `useTeamSummary` re-polls every 2s while a run is `running`. One failed
    // poll followed by a successful one must not leave a red banner over a
    // loaded dashboard. The old single `useState` + set-only effect did
    // exactly that, and it was unreachable only because `dataError` was
    // permanently `undefined`.
    runState.error = new Error('permission denied for table scheduler_runs');
    const { rerender } = renderPage();
    expect(screen.getByText(/permission denied/)).toBeTruthy();

    runState.error = null;
    rerender(
      <MemoryRouter>
        <WorkflowPage />
      </MemoryRouter>
    );

    expect(screen.queryByText(/permission denied/)).toBeNull();
    expect(screen.getByRole('heading', { name: 'Season Setup Workflow' })).toBeTruthy();
  });

  it('dismisses on demand, and a different failure afterwards still opens', () => {
    runState.error = new Error('permission denied for table scheduler_runs');
    const { rerender } = renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByText(/permission denied/)).toBeNull();

    // A dismissal must silence the message that was dismissed, not the
    // banner for good.
    runState.error = new Error('network request failed');
    rerender(
      <MemoryRouter>
        <WorkflowPage />
      </MemoryRouter>
    );
    expect(screen.getByText(/network request failed/)).toBeTruthy();
  });

  it('reopens when the IDENTICAL error recurs after a recovery', () => {
    // Dismissal is scoped to the occurrence, not the message. Recording only
    // the string meant the commonest real sequence -- a flaky 2s poll failing
    // with the same message twice around one success -- stayed silenced
    // forever after the first dismissal.
    const paint = (rerender) => {
      const ui = (
        <MemoryRouter>
          <WorkflowPage />
        </MemoryRouter>
      );
      return rerender ? rerender(ui) : render(ui);
    };

    runState.error = new Error('permission denied for table scheduler_runs');
    const { rerender } = paint();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByText(/permission denied/)).toBeNull();

    // The poll recovers...
    runState.error = null;
    paint(rerender);
    expect(screen.queryByText(/permission denied/)).toBeNull();

    // ...and then fails again with the very same message.
    runState.error = new Error('permission denied for table scheduler_runs');
    paint(rerender);
    expect(screen.getByText(/permission denied for table scheduler_runs/)).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function teamTotals() {
  return { divisions: 2, teams: 8, playersAssigned: 96, overflowPlayers: 0 };
}

function overviewTotals() {
  return { playersAssigned: 96, playersTarget: 96, manualReviewRequired: 0, totalTeams: 8 };
}
