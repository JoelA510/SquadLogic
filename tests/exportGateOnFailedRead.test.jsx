/**
 * A failed read is not an empty season, and the export path now says so.
 *
 * `ExportsPage` rendered a banner when `useDashboardData().error` was set and
 * then handed the panel `teams={team?.teams || []}` with every control live.
 * `|| []` is the line that makes a refused `scheduler_runs` read and a season
 * with no teams in it the same value, so an operator who read the banner and
 * pressed Generate anyway shipped a zero-row CSV to a league. #427 named the
 * deferral; this closes it.
 *
 * Three claims are under test here, and each is paired with the case that
 * makes it fail:
 *
 * 1. **The hook can say which read failed.** It returned one `error` string
 *    for what are five fetches. It now also returns `errors`, per source --
 *    and folds in the two assignments reads it was dropping on the floor
 *    entirely.
 * 2. **The gate is per artifact, not per panel.** The CSV export reads all
 *    three sources; the coach drafts read teams and practices only. A refused
 *    `game_assignments` read stops the first and not the second, because a
 *    welcome email never mentions a game.
 * 3. **Both call sites are gated.** Enumerated from the source tree, because
 *    the count is the part a later edit breaks, and then driven through the
 *    DOM on each one.
 *
 * Every assertion about the gate is made by pressing the operator's button
 * and looking at what the DOM says afterwards. An assertion on `aria-disabled`
 * alone would pass over a panel that generated the file anyway.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, renderHook, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ *
 * The five reads beneath `useDashboardData`, driven per source.
 *
 * The hook itself is REAL in every case below -- including the two that
 * render `ExportsPage`. Stubbing the hook would have let the page be fed a
 * shape the hook cannot produce, which is how a passing test comes to
 * describe nothing.
 * ------------------------------------------------------------------ */

const reads = vi.hoisted(() => ({
  /** @type {Record<string, any>} */
  errors: {
    team: null,
    practiceSummary: null,
    practiceAssignments: null,
    gameSummary: null,
    gameAssignments: null,
  },
}));

/**
 * The rows the stubbed reads return. Hoisted because the `vi.mock` factories
 * close over them and `vi.mock` is lifted above ordinary declarations.
 */
const fixtures = vi.hoisted(() => ({
  TEAMS: [
    { id: 't-1', name: 'Blue Bears', division: 'U10', coachName: 'Alex', coachEmail: 'a@x.test' },
    { id: 't-2', name: 'Red Foxes', division: 'U10', coachName: 'Robin', coachEmail: 'r@x.test' },
  ],
  PRACTICES: [
    {
      teamId: 't-1',
      start: '2026-04-06T17:30:00Z',
      end: '2026-04-06T18:30:00Z',
      day: 'Monday',
      fieldId: 'Field 1',
      slotId: 'practice_17:30',
    },
  ],
  GAMES: [
    {
      homeTeamId: 't-1',
      awayTeamId: 't-2',
      start: '2026-04-11T09:00:00Z',
      end: '2026-04-11T10:00:00Z',
      fieldId: 'pitch-1',
      slotId: 's-1',
    },
  ],
}));

vi.mock('../frontend/src/hooks/useTeamSummary.js', () => ({
  useTeamSummary: () => ({
    summary: { teams: fixtures.TEAMS },
    loading: false,
    error: reads.errors.team,
    status: 'completed',
    progress: 100,
    generatedAt: '2026-03-01',
  }),
}));
vi.mock('../frontend/src/hooks/usePracticeSummary.js', () => ({
  usePracticeSummary: () => ({
    practiceSummary: null,
    practiceReadinessSnapshot: null,
    generatedAt: null,
    loading: false,
    error: reads.errors.practiceSummary,
    runId: 'practice-run-1',
  }),
}));
vi.mock('../frontend/src/hooks/usePracticeAssignments.js', () => ({
  usePracticeAssignments: () => ({
    assignments: reads.errors.practiceAssignments ? [] : fixtures.PRACTICES,
    loading: false,
    error: reads.errors.practiceAssignments,
  }),
}));
vi.mock('../frontend/src/hooks/useGameSummary.js', () => ({
  useGameSummary: () => ({
    gameSummary: null,
    gameReadinessSnapshot: null,
    generatedAt: null,
    loading: false,
    error: reads.errors.gameSummary,
    runId: 'game-run-1',
  }),
}));
vi.mock('../frontend/src/hooks/useGameAssignments.js', () => ({
  useGameAssignments: () => ({
    assignments: reads.errors.gameAssignments ? [] : fixtures.GAMES,
    loading: false,
    error: reads.errors.gameAssignments,
  }),
}));

// The panel's own surroundings, which this file is not about.
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'admin-1' } }),
}));
vi.mock('../frontend/src/hooks/usePublicationBaselines.js', async () => {
  const actual = /** @type {Record<string, unknown>} */ (
    await vi.importActual('../frontend/src/hooks/usePublicationBaselines.js')
  );
  return {
    ...actual,
    usePublicationBaselines: () => ({
      baselines: [],
      loading: false,
      error: null,
      refresh: vi.fn(),
      publishBaseline: vi.fn(),
      compareWithBaseline: vi.fn(),
    }),
  };
});
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), log: vi.fn() },
}));
vi.mock('../frontend/src/hooks/usePermission.js', async () => {
  const { PERMISSIONS } = await import('../frontend/src/constants/permissions.js');
  return { usePermission: () => ({ can: () => true, role: 'admin', PERMISSIONS }) };
});
// DashboardWorkflow's other children, so only the output panel is real there.
vi.mock('../frontend/src/components/ImportPanel.jsx', () => ({ default: () => null }));
vi.mock('../frontend/src/components/TeamOverviewPanel.jsx', () => ({ default: () => null }));
vi.mock('../frontend/src/components/teaming/TeamListView.jsx', () => ({ default: () => null }));
vi.mock('../frontend/src/components/TeamPersistencePanel.jsx', () => ({ default: () => null }));
vi.mock('../frontend/src/components/PracticeReadinessPanel.jsx', () => ({ default: () => null }));
vi.mock('../frontend/src/components/GameReadinessPanel.jsx', () => ({ default: () => null }));
vi.mock('../frontend/src/components/ui/FeatureGuard.jsx', () => ({
  FeatureGuard: ({ children }) => children,
}));

const { TEAMS, PRACTICES, GAMES } = fixtures;

const REFUSED = 'permission denied for table practice_assignments';

const { useDashboardData } = await import('../frontend/src/hooks/useDashboardData.js');
const { default: OutputGenerationPanel } =
  await import('../frontend/src/components/OutputGenerationPanel.jsx');
const { default: ExportsPage } = await import('../frontend/src/pages/ExportsPage.jsx');
const { default: DashboardWorkflow } =
  await import('../frontend/src/components/DashboardWorkflow.jsx');

beforeEach(() => {
  reads.errors = {
    team: null,
    practiceSummary: null,
    practiceAssignments: null,
    gameSummary: null,
    gameAssignments: null,
  };
  localStorage.clear();
});

/* ------------------------------------------------------------------ *
 * 1. The hook can say which read failed.
 * ------------------------------------------------------------------ */

describe('useDashboardData reports its reads one by one', () => {
  it('partitions the failure to the source that had it', () => {
    reads.errors.gameSummary = new Error('permission denied for table scheduler_runs');
    const { result } = renderHook(() => useDashboardData());

    // Meta-assertion: all three arms exist, so "practice is null" is a
    // statement about the practice read and not about a missing key.
    expect(Object.keys(result.current.errors).sort()).toEqual(['game', 'practice', 'team']);
    expect(result.current.errors.game).toContain('permission denied');
    expect(result.current.errors.team).toBeNull();
    expect(result.current.errors.practice).toBeNull();
  });

  it('surfaces a refused assignments read, which nothing surfaced before', () => {
    // The purest form of the defect this PR is about: `usePracticeAssignments`
    // holds an error, the hook destructured only its `assignments`, and on a
    // refusal those stay `[]`. No banner anywhere, and those are the rows the
    // CSV is made of.
    reads.errors.practiceAssignments = new Error(REFUSED);
    const { result } = renderHook(() => useDashboardData());

    expect(result.current.errors.practice).toBe(REFUSED);
    expect(result.current.error).toBe(REFUSED);
    // Meta-assertion: the empty list the operator would otherwise have
    // exported really is what the page receives.
    expect(result.current.practice.assignments).toEqual([]);
  });

  it('keeps the aggregate a string, and equal to one of the three arms', () => {
    reads.errors.team = new Error('team summary fetch failed');
    reads.errors.gameAssignments = new Error('game rows refused');
    const { result } = renderHook(() => useDashboardData());

    expect(typeof result.current.error).toBe('string');
    // `error` is derived from `errors`, so it can never name a failure the
    // per-source map does not have. Team first, matching the old order.
    expect(result.current.error).toBe(result.current.errors.team);
    expect(result.current.errors.game).toBe('game rows refused');
  });

  it('is all-null when every read succeeded', () => {
    const { result } = renderHook(() => useDashboardData());
    expect(result.current.error).toBeNull();
    expect(result.current.errors).toEqual({ team: null, practice: null, game: null });
    // Meta-assertion: the reads really did return their rows, so the nulls
    // above are a clean load rather than a hook that ran on nothing.
    expect(result.current.team.teams).toHaveLength(2);
    expect(result.current.practice.assignments).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * 2. The gate is per artifact.
 * ------------------------------------------------------------------ */

const GENERATE = 'Generate CSVs';
const DRAFTS = 'Generate Draft Welcome Emails';

function renderPanel(sourceErrors, sourceLoading = undefined) {
  return render(
    <OutputGenerationPanel
      teams={TEAMS}
      practiceAssignments={PRACTICES}
      gameAssignments={GAMES}
      supabaseClient={null}
      sourceErrors={sourceErrors}
      sourceLoading={sourceLoading}
    />
  );
}

/**
 * Press a control and let the work it would have started finish.
 *
 * `handleGenerate` builds the CSVs inside a `setTimeout(..., 0)`, so
 * asserting "Generated Files is absent" on the line after `fireEvent.click`
 * is true of a panel that is about to generate them. It was: the first draft
 * of this file made that assertion three times and only one of the three
 * went red when the guard was deleted. The macrotask is flushed here, and
 * `generates when nothing is blocked` below presses through this same helper
 * so the wait is known to be long enough rather than assumed.
 *
 * @param {HTMLElement} control
 */
async function press(control) {
  await act(async () => {
    fireEvent.click(control);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('OutputGenerationPanel refuses only what the failed read feeds', () => {
  it('exports a genuinely empty season, because empty is not the same as unread', async () => {
    // The negative twin of the whole file. Without it, "the panel refuses"
    // would pass just as well on a panel that refuses everything.
    render(
      <OutputGenerationPanel
        teams={[]}
        practiceAssignments={[]}
        gameAssignments={[]}
        supabaseClient={null}
      />
    );

    await press(screen.getByRole('button', { name: GENERATE }));
    // Through the same helper the refusal cases use: this is what proves the
    // flush is long enough for a generation to have appeared if one ran.
    expect(screen.getByText('Generated Files')).toBeInTheDocument();
    expect(screen.getByText('Master Schedule: 0 rows')).toBeInTheDocument();
    expect(screen.queryByTestId('csv-blocked-reason')).toBeNull();
  });

  it('will not generate CSVs after a refused game read, and says which read', async () => {
    renderPanel({ team: null, practice: null, game: 'game rows refused' });

    const button = screen.getByRole('button', { name: GENERATE });
    expect(button).toHaveAttribute('aria-disabled', 'true');

    // The gate, pressed. Not the attribute -- the file.
    await press(button);
    expect(screen.queryByText('Generated Files')).toBeNull();

    const reason = screen.getByTestId('csv-blocked-reason');
    expect(reason).toHaveTextContent('the game assignments could not be read');
    // The reason is reachable from the control, and the control is still in
    // the tab order to reach it from (WCAG 2.2 AA; a native `disabled`
    // button would be neither).
    expect(button.getAttribute('aria-describedby')).toBe(reason.getAttribute('id'));
    expect(button.hasAttribute('disabled')).toBe(false);
  });

  it('still writes coach drafts after a refused game read, which they never mention', async () => {
    // The precision claim. A single panel-wide gate would fail here, and so
    // would a gate keyed on the hook's aggregate `error`.
    renderPanel({ team: null, practice: null, game: 'game rows refused' });

    const button = screen.getByRole('button', { name: DRAFTS });
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    expect(screen.queryByTestId('emails-blocked-reason')).toBeNull();

    await press(button);
    expect(screen.getByText(/Generated 2 email drafts/)).toBeInTheDocument();
  });

  it('refuses both after a refused practice read, which both artifacts carry', async () => {
    renderPanel({ team: null, practice: REFUSED, game: null });

    await press(screen.getByRole('button', { name: GENERATE }));
    await press(screen.getByRole('button', { name: DRAFTS }));

    expect(screen.queryByText('Generated Files')).toBeNull();
    expect(screen.queryByText(/email drafts/)).toBeNull();
    expect(screen.getByTestId('csv-blocked-reason')).toHaveTextContent(
      'the practice assignments could not be read'
    );
    // Named, because a draft would otherwise tell a coach their practices are
    // "TBD" when the truth is that nobody could look them up.
    expect(screen.getByTestId('emails-blocked-reason')).toHaveTextContent(
      'the practice assignments could not be read'
    );
  });

  it('names every failed source, not just the first', () => {
    renderPanel({ team: 'teams refused', practice: REFUSED, game: 'games refused' });

    expect(screen.getByTestId('csv-blocked-reason')).toHaveTextContent(
      'the teams, the practice assignments and the game assignments could not be read'
    );
  });

  it('refuses a read still in flight, and does not call it a failure', async () => {
    // The first paint of `/exports`: empty arrays, no error anywhere, and the
    // fetches not back yet. Gating on `sourceErrors` alone left this open,
    // and it reaches the same zero-row CSV by a route with no failure in it.
    render(
      <OutputGenerationPanel
        teams={[]}
        practiceAssignments={[]}
        gameAssignments={[]}
        supabaseClient={null}
        sourceLoading={{ team: true, practice: true, game: true }}
      />
    );

    await press(screen.getByRole('button', { name: GENERATE }));
    expect(screen.queryByText('Generated Files')).toBeNull();

    const reason = screen.getByTestId('csv-blocked-reason');
    expect(reason).toHaveTextContent('have not finished loading');
    // "Could not be read" would be a false statement about a slow fetch --
    // the same class of falsehood the gate exists to stop, in miniature.
    expect(reason.textContent).not.toMatch(/could not be read/);
  });

  it('withdraws a generated artifact, and its publish path, when a read then fails', async () => {
    const { rerender } = renderPanel(undefined);

    await press(screen.getByRole('button', { name: GENERATE }));
    // Meta-assertion: the artifact and both ways of shipping it really are on
    // screen first, so their absence below is a withdrawal and not a page
    // that never got that far.
    expect(screen.getByText('Master Schedule: 3 rows')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload to Storage' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download Master CSV' })).toBeInTheDocument();

    rerender(
      <OutputGenerationPanel
        teams={TEAMS}
        practiceAssignments={PRACTICES}
        gameAssignments={GAMES}
        supabaseClient={null}
        sourceErrors={{ team: null, practice: null, game: 'game rows refused' }}
      />
    );

    // Gating Generate alone left the zero-row CSV reachable one button to the
    // right: Upload writes it to the bucket AND records it as a published
    // baseline, which is the moment this app sends a schedule out.
    expect(screen.queryByRole('button', { name: 'Upload to Storage' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download Master CSV' })).toBeNull();
    expect(screen.queryByText('Master Schedule: 3 rows')).toBeNull();
    expect(screen.getByTestId('csv-blocked-reason')).toBeInTheDocument();
  });

  it('withdraws coach drafts, whose mailto links are live, when a read then fails', async () => {
    const { rerender } = renderPanel(undefined);

    await press(screen.getByRole('button', { name: DRAFTS }));
    expect(screen.getByText(/Generated 2 email drafts/)).toBeInTheDocument();
    // Meta-assertion: the drafts and their live `mailto:` links really are on
    // screen first.
    expect(screen.getAllByRole('link', { name: 'Open in Mail App' })).toHaveLength(2);

    rerender(
      <OutputGenerationPanel
        teams={TEAMS}
        practiceAssignments={PRACTICES}
        gameAssignments={GAMES}
        supabaseClient={null}
        sourceErrors={{ team: null, practice: REFUSED, game: null }}
      />
    );

    expect(screen.queryAllByRole('link', { name: 'Open in Mail App' })).toHaveLength(0);
    expect(screen.getByTestId('emails-blocked-reason')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * 3. Both call sites are gated.
 * ------------------------------------------------------------------ */

/**
 * Every module under `frontend/src` that renders `<OutputGenerationPanel`.
 *
 * Enumerated from the source tree and not from the two driven below: a third
 * call site added later must fail this rather than quietly inherit an
 * ungated panel. Comments are stripped first, so a file that merely names the
 * component in prose is not counted -- the fault the sibling scan in
 * `dashboardErrorConsumers.test.jsx` actually had.
 */
function callSitesOfPanel() {
  const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../frontend/src');
  /** @type {string[]} */
  const found = [];

  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.jsx?$/.test(entry.name)) continue;
      const source = readFileSync(full, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      if (source.includes('<OutputGenerationPanel')) found.push(entry.name.replace(/\.jsx?$/, ''));
    }
  };

  walk(srcDir);
  return found.sort();
}

describe('every call site of the panel hands it the distinction', () => {
  it('there are exactly two, enumerated from the source tree', () => {
    const sites = callSitesOfPanel();
    // Meta-assertion: a scan that matched nothing would make the comparison
    // below trivially true.
    expect(sites.length).toBeGreaterThan(0);
    expect(sites).toEqual(['DashboardWorkflow', 'ExportsPage']);
  });

  it('the enumeration can fail -- a call site missing from the list is caught', () => {
    const sites = callSitesOfPanel();
    expect(sites).not.toEqual(['ExportsPage']);
    expect(sites.length).toBe(2);
  });

  it('ExportsPage gates the export on the read that actually failed', async () => {
    // The real page, the real hook, the real panel: only the five fetches are
    // stubbed, and one of them is refused.
    reads.errors.practiceAssignments = new Error(REFUSED);
    render(
      <MemoryRouter>
        <ExportsPage />
      </MemoryRouter>
    );

    // Meta-assertion: the page mounted, so what follows is about the page.
    expect(screen.getByRole('heading', { name: 'Exports' })).toBeTruthy();
    // The banner #427 added still tells them...
    expect(screen.getByTestId('data-error-banner')).toHaveTextContent(REFUSED);
    // ...and now the export does not offer to ship the emptiness behind it.
    await press(screen.getByRole('button', { name: GENERATE }));
    expect(screen.queryByText('Generated Files')).toBeNull();
    expect(screen.getByTestId('csv-blocked-reason')).toBeInTheDocument();
  });

  it('ExportsPage exports normally when every read succeeded', async () => {
    render(
      <MemoryRouter>
        <ExportsPage />
      </MemoryRouter>
    );

    expect(screen.queryByTestId('data-error-banner')).toBeNull();
    expect(screen.queryByTestId('csv-blocked-reason')).toBeNull();
    await press(screen.getByRole('button', { name: GENERATE }));
    expect(screen.getByText('Generated Files')).toBeInTheDocument();
    // Meta-assertion: the rows are the stubbed practice and the two sides of
    // the stubbed game, so the pass above is a real export and not an empty
    // one that happened not to be blocked.
    expect(screen.getByText('Master Schedule: 3 rows')).toBeInTheDocument();
  });

  it('the pipeline call site is gated too, not only the page it was reported on', () => {
    const step = render(
      <MemoryRouter>
        <DashboardWorkflow
          loading={{}}
          teamData={{ teams: TEAMS }}
          practiceData={{ snapshot: {}, assignments: PRACTICES }}
          gameData={{ snapshot: {}, assignments: [] }}
          persistenceSnapshot={null}
          onImport={() => {}}
          importedData={{ totalRows: 5 }}
          controlledActiveStep={6}
          onStepChange={() => {}}
          sourceErrors={{ team: null, practice: null, game: 'game rows refused' }}
        />
      </MemoryRouter>
    ).container;

    // Meta-assertion: step 6 is the one holding the panel, so the reason
    // below is inside the output step rather than anywhere on the page.
    const output = within(step).getByTestId('workflow-step-6-output-communication');
    expect(within(output).getByRole('button', { name: GENERATE })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    expect(within(output).getByTestId('csv-blocked-reason')).toHaveTextContent(
      'the game assignments could not be read'
    );
  });
});
