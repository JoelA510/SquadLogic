import React, { useState, useEffect, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import DashboardWorkflow from '../components/DashboardWorkflow.jsx';
import { useDashboardData } from '../hooks/useDashboardData.js';
import { useTeamPersistence } from '../hooks/useTeamPersistence.js';
import { useImport } from '../contexts/ImportContext.jsx';
import { useTheme } from '../contexts/ThemeContext.jsx';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import LoadingScreen from '../components/LoadingScreen.jsx';
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
  // until dismissed. Dismissing a data error records which message was
  // dismissed, so a different failure afterwards still opens the banner.
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

  if (loading && !team) {
    return <LoadingScreen message="Aggregating league status..." />;
  }

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

      {readinessScore === 0 && (
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
                  <span
                    className={`text-sm font-bold ${readinessScore >= 70 ? 'text-green-400' : 'text-amber-400'}`}
                  >
                    {readinessScore}%
                  </span>
                </div>
                <div className="w-full bg-bg-glass h-2 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-500 ${readinessScore >= 70 ? 'bg-green-500' : 'bg-amber-500'}`}
                    style={{ width: `${readinessScore}%` }}
                  />
                </div>
              </div>

              {/* Status List */}
              <div className="space-y-4">
                <StatusItem
                  icon={<Users size={18} />}
                  label="Team Rosters"
                  status={team?.generatedAt ? 'Complete' : 'Pending'}
                  isReady={!!team?.generatedAt}
                />
                <StatusItem
                  icon={<Calendar size={18} />}
                  label="Practice Slots"
                  status={practice?.generatedAt ? 'Optimized' : 'Unscheduled'}
                  isReady={!!practice?.generatedAt}
                />
                <StatusItem
                  icon={<Trophy size={18} />}
                  label="Game Schedule"
                  status={game?.generatedAt ? 'Finalized' : 'In Progress'}
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

      {loading && <IngestionOverlay />}
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
