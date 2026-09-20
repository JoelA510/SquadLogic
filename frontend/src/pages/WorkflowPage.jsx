import React, { useState, useEffect, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import DashboardWorkflow from '../components/DashboardWorkflow.jsx';
import { useDashboardData } from '../hooks/useDashboardData.js';
import { useTeamPersistence } from '../hooks/useTeamPersistence.js';
import { useImport } from '../contexts/ImportContext.jsx';
import { useTheme } from '../contexts/ThemeContext.jsx';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { Building2, Calendar, Users, Trophy, ArrowRight, Sparkles } from 'lucide-react';
import { FeatureGuard } from '../components/ui/FeatureGuard.jsx';
import { FEATURE_FLAGS } from '../constants/featureFlags.js';
import { IngestionOverlay } from '../components/ui/IngestionOverlay.jsx';
import Button from '../components/ui/Button.jsx';

export default function WorkflowPage() {
  // E2E Testing Error Trigger
  if (
    typeof window !== 'undefined' &&
    (window.__FORCE_ERROR__ === true || localStorage.getItem('__FORCE_ERROR__') === 'true')
  ) {
    throw new Error('E2E forced error for resilience testing.');
  }

  // No `timezone` here: the two consumers were `TeamListView` and
  // `GameReadinessPanel`, which both render a `scheduler_runs` timestamp on
  // the viewer's clock and no longer declare the prop. `useDashboardData` has
  // never returned a zone, so the binding was `undefined` in every render this
  // page has ever had. `error` it DOES return, now that it stops swallowing
  // the three fetch failures underneath it.
  const { team, practice, game, loading, error: dataError } = useDashboardData();
  const { persistenceSnapshot, loading: _persistenceLoading } = useTeamPersistence();
  const { importedData, setImportedData } = useImport();
  const { theme: _theme } = useTheme();
  const { currentOrganization } = useOrganization();
  // The banner has two sources with different lifetimes, and collapsing them
  // into one `useState` made it a one-way latch: the old effect only ever
  // called `setError`, never cleared it. That was harmless while `dataError`
  // was permanently `undefined` and is not now. `useTeamSummary` re-polls
  // every 2s while a run is `running`, so one failed poll followed by a
  // successful one would leave a red "permission denied" banner over a fully
  // loaded dashboard until the operator dismissed it by hand.
  //
  // `dataError` is therefore *live* state — it disappears when the fetch
  // recovers — while a navigation error is a one-shot message that stays
  // until dismissed.
  //
  // Dismissal is scoped to the **occurrence**, not to the message. Recording
  // only the string meant an identical failure recurring after a recovery
  // ("permission denied" → dismissed → poll succeeds → "permission denied"
  // again) compared equal to the dismissed value and stayed shut. The effect
  // below clears the record the moment the error goes away, so the next
  // failure opens the banner whether or not it reads the same.
  const [navError, setNavError] = useState(null);
  const [dismissedDataError, setDismissedDataError] = useState(null);
  const [activeStep, setActiveStep] = useState(1);

  const location = useLocation();

  const error = navError ?? (dataError === dismissedDataError ? null : dataError);

  const dismissError = () => {
    if (navError) setNavError(null);
    else setDismissedDataError(dataError);
  };

  useEffect(() => {
    if (!dataError && dismissedDataError !== null) {
      setDismissedDataError(null);
    }
  }, [dataError, dismissedDataError]);

  useEffect(() => {
    if (location.state?.error) {
      setNavError(location.state.error);
    }
  }, [location.state]);

  // Consume ?step=N from setup-wizard redirect exactly once on mount.
  // Re-running on later location changes would revert user-driven step changes.
  useEffect(() => {
    const step = new URLSearchParams(location.search).get('step');
    if (step) {
      setActiveStep(parseInt(step, 10));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Calculate high-level status metrics
  const readinessScore = useMemo(() => {
    let score = 0;
    if (team?.generatedAt) score += 40;
    if (practice?.generatedAt) score += 30;
    if (game?.generatedAt) score += 30;
    return score;
  }, [team, practice, game]);

  // **`loading` is `{ team, practice, game }`, and the three are read
  // separately because they are three sources with three lifetimes.**
  //
  // This page used to open with `if (loading && !team) return <LoadingScreen
  // .../>`. Both operands were permanently truthy -- `loading` is an object
  // literal `useDashboardData` builds on every render, and `team` is
  // `resolvedTeam`, another unconditional object literal -- so the branch was
  // dead and that screen had never been seen. `DashboardWorkflow` two hundred
  // lines below consumed the same value correctly, as an object, which is how
  // the shape stayed right while these two reads went wrong.
  //
  // **No page-level screen replaces it, and that is a decision rather than an
  // omission.** Neither gate it could have is correct:
  //
  //   * on `loading.team` it would swallow the very UI built for the state it
  //     claims to cover. `useTeamSummary` holds `loading` true for the WHOLE
  //     of a running teaming job (`useTeamSummary.js:92`, re-polling every 2s),
  //     and `DashboardWorkflow` renders a live "Generating Teams..."
  //     ProgressBar off `team.status`/`team.progress` for exactly that window.
  //     A full-page screen over it would hide the progress it exists to show.
  //   * on anything true at first paint it would blank the dashboard on every
  //     navigation. The route is lazy and the hooks remount, so "no data yet"
  //     is true every single visit.
  //
  // What the dead branch was actually groping at is real, though, and it is
  // per-source: while a source is in flight this page cannot honestly say
  // what that source found. Unguarded it asserted `readinessScore === 0`,
  // three Pending/Unscheduled/In Progress rows, and "Your season hasn't
  // started yet" -- over a fully scheduled season, on every navigation, for
  // as long as the fetches took. So each of the three claims now waits for
  // its own flag, and the aggregate ones wait for all three.
  const teamPending = Boolean(loading?.team);
  const practicePending = Boolean(loading?.practice);
  const gamePending = Boolean(loading?.game);

  // **In flight is not the same as unknown, and the score turns on the
  // difference.** `readinessScore` is built from the three `generatedAt`
  // values, so a source that has already produced one contributes a known
  // 40/30/30 no matter what its fetch is doing now. Gating the aggregate on
  // the raw flags would blank a fully scheduled season's "100%" to "—" for
  // the whole of a re-run -- `loading.team` stays true for the duration of
  // one -- while the three rows beside it still read Complete / Optimized /
  // Finalized. A source is unknown only when it is in flight AND has yet to
  // report anything, which is the same condition the rows below use.
  const teamUnknown = teamPending && !team?.generatedAt;
  const practiceUnknown = practicePending && !practice?.generatedAt;
  const gameUnknown = gamePending && !game?.generatedAt;
  const readinessKnown = !teamUnknown && !practiceUnknown && !gameUnknown;

  const handleImport = (data) => {
    setImportedData(data);
  };

  return (
    <div className="animate-fadeIn">
      {error && (
        <div className="bg-red-500/10 border border-red-500 text-red-500 p-4 rounded-md mb-4 flex justify-between items-center">
          <span>{error}</span>
          <button
            onClick={dismissError}
            aria-label="Dismiss error"
            className="text-red-500 hover:text-red-700 font-bold"
          >
            ✕
          </button>
        </div>
      )}

      {/* Page Header */}
      <header className="mb-8">
        <h1 className="text-3xl font-display font-bold text-text-primary tracking-tight mb-1">
          Season Setup Workflow
        </h1>
        <p className="text-text-secondary">
          Follow these steps to configure and generate your league schedule.
        </p>
      </header>

      {readinessKnown && readinessScore === 0 && (
        <div className="glass-panel p-12 text-center mb-12 animate-fadeIn border-brand-400/20 relative overflow-hidden">
          <div className="absolute top-0 right-0 p-8 opacity-10 pointer-events-none">
            <Sparkles size={120} className="text-brand-400" />
          </div>
          <div className="max-w-md mx-auto relative z-10">
            <h2 className="text-2xl font-display font-bold text-text-primary mb-4">
              Welcome to the SquadLogic Command Center
            </h2>
            <p className="text-text-secondary mb-8">
              Your season hasn&apos;t started yet. Let&apos;s get your organization up and running
              by importing your player data.
            </p>
            <Button
              variant="primary"
              size="lg"
              className="flex items-center gap-2 mx-auto"
              onClick={() => setActiveStep(1)}
            >
              Begin Season Import <ArrowRight size={18} />
            </Button>
          </div>
        </div>
      )}

      {/* 2/3 + 1/3 Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left: Workflow Steps (2/3) */}
        <div className="lg:col-span-2">
          <DashboardWorkflow
            loading={loading}
            teamData={team}
            practiceData={practice}
            gameData={game}
            persistenceSnapshot={persistenceSnapshot}
            onImport={handleImport}
            importedData={importedData}
            controlledActiveStep={activeStep}
            onStepChange={setActiveStep}
          />
        </div>

        {/* Right: League Status (1/3) */}
        <div className="lg:col-span-1">
          <div className="glass-panel sticky top-8 p-6">
            <h3 className="text-lg font-bold text-text-primary mb-4 border-b border-border-subtle pb-4">
              League Status
            </h3>

            <div className="space-y-6">
              {/* Overall Readiness */}
              <div className="bg-bg-surface-hover/50 p-4 rounded-lg border border-border-subtle">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm font-medium text-text-secondary">Overall Readiness</span>
                  {/* A partial score is not a small error, it is a different
                      number: every source still in flight contributes 0, so
                      the figure reads as "nothing is ready" rather than "not
                      counted yet". Withheld until all three have answered. */}
                  <span
                    className={`text-sm font-bold ${
                      !readinessKnown
                        ? 'text-text-muted'
                        : readinessScore >= 70
                          ? 'text-green-400'
                          : 'text-amber-400'
                    }`}
                  >
                    {readinessKnown ? `${readinessScore}%` : '—'}
                  </span>
                </div>
                <div className="w-full bg-bg-glass h-2 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-500 ${readinessScore >= 70 ? 'bg-green-500' : 'bg-amber-500'}`}
                    style={{ width: `${readinessKnown ? readinessScore : 0}%` }}
                  />
                </div>
              </div>

              {/* Status List */}
              <div className="space-y-4">
                {/* Each row waits on its OWN flag. "Pending", "Unscheduled"
                    and "In Progress" are findings about a source, and none of
                    them can be reported before that source has answered.
                    `team` additionally distinguishes a run in flight, because
                    `useTeamSummary` keeps `loading.team` true for the whole of
                    one and "Checking..." would be wrong for minutes. */}
                <StatusItem
                  icon={<Users size={18} />}
                  label="Team Rosters"
                  status={
                    team?.generatedAt
                      ? 'Complete'
                      : teamPending
                        ? team?.status === 'running'
                          ? 'Generating'
                          : 'Checking…'
                        : 'Pending'
                  }
                  isReady={!!team?.generatedAt}
                />
                <StatusItem
                  icon={<Calendar size={18} />}
                  label="Practice Slots"
                  status={
                    practice?.generatedAt
                      ? 'Optimized'
                      : practicePending
                        ? 'Checking…'
                        : 'Unscheduled'
                  }
                  isReady={!!practice?.generatedAt}
                />
                <StatusItem
                  icon={<Trophy size={18} />}
                  label="Game Schedule"
                  status={
                    game?.generatedAt ? 'Finalized' : gamePending ? 'Checking…' : 'In Progress'
                  }
                  isReady={!!game?.generatedAt}
                />
              </div>

              {/* Org Context */}
              <FeatureGuard flag={FEATURE_FLAGS.MULTI_TENANCY}>
                <div className="pt-6 border-t border-border-subtle">
                  <div className="flex items-center gap-3 text-text-muted">
                    <Building2 size={16} />
                    <span className="text-xs uppercase tracking-wider font-semibold">
                      Organization
                    </span>
                  </div>
                  <p className="mt-1 text-sm font-medium text-text-primary">
                    {currentOrganization?.name || 'Local Environment'}
                  </p>
                </div>
              </FeatureGuard>
            </div>
          </div>
        </div>
      </div>

      {/* Unguarded, because the guard that was here was not about this
          component. `IngestionOverlay` shows CSV-ingestion progress and
          decides its own visibility from `ImportContext` (`isImporting`,
          `activeJob`, `importStatus`) behind its own `isVisible` state; it
          has no relationship to the three scheduler-run fetches `loading`
          describes. `{loading && ...}` reduced to `{true && ...}` against the
          always-truthy object, so the overlay already mounted on every render
          and only looked deliberate. Removing a condition that never
          subtracted anything, rather than inventing one it never had. */}
      <IngestionOverlay />
    </div>
  );
}

function StatusItem({ icon, label, status, isReady }) {
  return (
    <div className="flex items-center justify-between group">
      <div className="flex items-center gap-3">
        <div
          className={`p-2 rounded-md transition-colors ${
            isReady ? 'bg-green-500/10 text-green-400' : 'bg-bg-glass text-text-muted'
          }`}
        >
          {icon}
        </div>
        <span className="text-sm font-medium text-text-secondary group-hover:text-text-primary transition-colors">
          {label}
        </span>
      </div>
      <span
        className={`text-xs font-semibold px-2 py-1 rounded-full ${
          isReady ? 'bg-green-500/10 text-green-400' : 'bg-bg-glass text-text-muted'
        }`}
      >
        {status}
      </span>
    </div>
  );
}
