import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient.js';
import WorkflowStep from './WorkflowStep.jsx';
import ImportPanel from './ImportPanel.jsx';
import TeamOverviewPanel from './TeamOverviewPanel.jsx';
import TeamListView from './teaming/TeamListView.jsx';
import TeamPersistencePanel from './TeamPersistencePanel.jsx';
import PracticeReadinessPanel from './PracticeReadinessPanel.jsx';
import GameReadinessPanel from './GameReadinessPanel.jsx';
import OutputGenerationPanel from './OutputGenerationPanel.jsx';

import Button from './ui/Button.jsx';
import ProgressBar from './ui/ProgressBar.jsx';
import { FeatureGuard } from './ui/FeatureGuard.jsx';
import { FEATURE_FLAGS } from '../constants/featureFlags.js';
import StepRunButton from './workflow/StepRunButton.jsx';
import { usePermission } from '../hooks/usePermission.js';

const DashboardWorkflow = ({
  loading,
  teamData,
  practiceData,
  gameData,
  persistenceSnapshot,
  onImport,
  importedData,
  controlledActiveStep,
  onStepChange,
  scheduleEvaluation: _scheduleEvaluation = undefined,
}) => {
  const navigate = useNavigate();
  const totalSteps = 6;
  const [internalActiveStep, setInternalActiveStep] = useState(() => {
    const saved = localStorage.getItem('dashboardActiveStep');
    return saved ? parseInt(saved, 10) : 1;
  });
  const activeStep = controlledActiveStep !== undefined ? controlledActiveStep : internalActiveStep;

  // Permission + dependency gating for the per-step Run buttons. Teaming needs
  // team-management; scheduling needs schedule-management AND generated teams
  // (you cannot schedule practices/games before rosters exist).
  const { can, PERMISSIONS } = usePermission();
  const canManageTeams = can(PERMISSIONS.MANAGE_ALL_TEAMS) || can(PERMISSIONS.MANAGE_ORGANIZATION);
  const canManageSchedule = can(PERMISSIONS.MANAGE_SCHEDULE);
  const teamsReady = Boolean(teamData?.generatedAt);
  const teamingDisabledReason = !canManageTeams
    ? 'You need team-management permission to run teaming.'
    : '';
  const schedulingDisabledReason = !teamsReady
    ? 'Generate teams first to enable scheduling.'
    : !canManageSchedule
      ? 'You need schedule-management permission to run scheduling.'
      : '';

  useEffect(() => {
    if (controlledActiveStep === undefined) {
      localStorage.setItem('dashboardActiveStep', internalActiveStep.toString());
    }
  }, [internalActiveStep, controlledActiveStep]);
  useEffect(() => {
    // We can run side-effects on step changes if needed
  }, [activeStep]);

  const handleStepChange = (step) => {
    if (onStepChange) {
      onStepChange(step);
    } else {
      setInternalActiveStep(step);
    }
  };

  // Helper to determine step status
  const getStatus = (stepId) => {
    if (stepId < activeStep) return 'completed';
    if (stepId === activeStep) return 'active';
    if (stepId === activeStep + 1) return 'pending';
    return 'locked';
  };

  return (
    <div className="max-w-5xl mx-auto p-4 md:p-8">
      {/* Header Section */}
      <div className="mb-12 text-center relative">
        <h1 className="text-4xl md:text-5xl font-display font-bold text-transparent bg-clip-text bg-gradient-to-r from-text-primary via-brand-400 to-brand-600 mb-4 animate-fadeIn">
          League Management
        </h1>
        <p className="text-lg text-text-secondary max-w-2xl mx-auto animate-slideUp">
          Follow the steps below to set up your season.
        </p>
      </div>

      {/* Progress Bar */}
      <div className="mb-12 relative h-2 bg-bg-surface rounded-full overflow-hidden glass-panel-premium">
        <div
          className="absolute top-0 left-0 h-full bg-gradient-to-r from-brand-600 to-brand-400 transition-all duration-700 ease-out"
          style={{ width: `${(activeStep / totalSteps) * 100}%` }}
        />
      </div>

      {/* Steps Container */}
      <div className="space-y-4">
        {/* Step 1: Data Import */}
        <WorkflowStep
          title="1. Data Import"
          description="Upload player and coach data from GotSport CSVs to initialize the season."
          status={getStatus(1)}
          onClick={() => handleStepChange(1)}
        >
          <ImportPanel
            onImport={(data) => {
              onImport(data);
              handleStepChange(2); // Auto-advance
            }}
          />
        </WorkflowStep>

        {/* Step 2: Teaming & Analysis */}
        <WorkflowStep
          title="2. Teaming & Analysis"
          description="Review team generation, division capacity, and roster assignments."
          status={getStatus(2)}
          onClick={() => handleStepChange(2)}
        >
          <div className="space-y-8">
            {loading?.team || (!teamData?.generatedAt && !importedData) ? (
              <div className="p-12 text-center animate-fadeIn">
                <div className="max-w-md mx-auto">
                  <h3 className="text-xl font-bold text-text-primary mb-4">
                    {teamData?.status === 'running'
                      ? 'Generating Teams...'
                      : 'Loading Team Data...'}
                  </h3>
                  <ProgressBar
                    progress={teamData?.progress || 0}
                    label={
                      teamData?.status === 'running'
                        ? 'Processing roster rules and division caps...'
                        : 'Fetching data...'
                    }
                  />
                </div>
              </div>
            ) : !teamData?.generatedAt && importedData ? (
              <div className="bg-bg-surface p-8 rounded-xl text-center border border-border-subtle">
                <div className="text-4xl mb-4 flex justify-center">
                  <svg
                    className="w-16 h-16 text-blue-400/80"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1}
                      d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                    />
                  </svg>
                </div>
                <h3 className="text-xl font-bold text-text-primary mb-2">
                  Ready to Generate Teams
                </h3>
                <p className="text-text-secondary mb-6 max-w-md mx-auto">
                  {importedData.totalRows} records imported and ready for processing. Click below to
                  generate team structures based on the imported data.
                </p>
                <div className="flex flex-col sm:flex-row gap-3 justify-center">
                  <StepRunButton
                    label="Start Teaming"
                    size="lg"
                    onRun={() => navigate('/teams', { state: { autoRunTeaming: true } })}
                    disabled={!canManageTeams}
                    disabledReason={teamingDisabledReason}
                    testId="step-run-teaming"
                  />
                  <Button variant="secondary" size="lg" onClick={() => navigate('/teams')}>
                    Open Team Builder
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <FeatureGuard
                  flag={FEATURE_FLAGS.ACCESSIBILITY_LIST_VIEW}
                  fallback={
                    <TeamOverviewPanel
                      totals={teamData.totals}
                      divisions={teamData.divisions}
                      generatedAt={teamData.generatedAt}
                    />
                  }
                >
                  <TeamListView
                    totals={teamData.totals}
                    divisions={teamData.divisions}
                    generatedAt={teamData.generatedAt}
                  />
                </FeatureGuard>
                <TeamPersistencePanel teamPersistenceSnapshot={persistenceSnapshot} />
                <div className="flex flex-col sm:flex-row gap-3 justify-between pt-4 border-t border-border-subtle">
                  <StepRunButton
                    label="Re-run Teaming"
                    onRun={() => navigate('/teams', { state: { autoRunTeaming: true } })}
                    disabled={!canManageTeams}
                    disabledReason={teamingDisabledReason}
                    hasExisting
                    testId="step-rerun-teaming"
                  />
                  <Button variant="primary" size="lg" onClick={() => handleStepChange(3)}>
                    Confirm Teams & Proceed
                  </Button>
                </div>
              </>
            )}
          </div>
        </WorkflowStep>

        {/* Step 3: Field Management */}
        <WorkflowStep
          title="3. Field Management"
          description="Configure fields, priorities, and practice slots."
          status={getStatus(3)}
          onClick={() => handleStepChange(3)}
        >
          <div className="bg-bg-surface p-8 rounded-xl text-center border border-border-subtle">
            <div className="text-4xl mb-4 flex justify-center">
              <svg
                className="w-16 h-16 text-blue-400/80"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1}
                  d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
                />
              </svg>
            </div>
            <h3 className="text-xl font-bold text-text-primary mb-2">Field Configuration</h3>
            <p className="text-text-secondary mb-6 max-w-md mx-auto">
              Field configuration is currently handled via the{' '}
              <code>generate_practice_slots.js</code> script. Ensure you have run the generator
              before proceeding.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Button variant="secondary" onClick={() => navigate('/fields')}>
                Open Field Management
              </Button>
              <Button variant="primary" onClick={() => handleStepChange(4)}>
                Fields Configured — Continue
              </Button>
            </div>
          </div>
        </WorkflowStep>

        {/* Step 4: Practice Scheduling */}
        <WorkflowStep
          title="4. Practice Scheduling"
          description="Generate and review practice schedules based on field availability."
          status={getStatus(4)}
          onClick={() => handleStepChange(4)}
        >
          <PracticeReadinessPanel
            practiceReadinessSnapshot={practiceData.snapshot}
            dashboardLoading={{ practice: false }}
            generatedAt={practiceData?.generatedAt}
          />
          <div className="flex justify-end pt-4 mt-6 border-t border-border-subtle">
            <StepRunButton
              label={
                practiceData?.generatedAt ? 'Re-run Practice Scheduling' : 'Run Practice Scheduling'
              }
              onRun={() => navigate('/schedule/practice', { state: { autoRunPractice: true } })}
              disabled={!teamsReady || !canManageSchedule}
              disabledReason={schedulingDisabledReason}
              hasExisting={Boolean(practiceData?.generatedAt)}
              testId="step-run-practice"
            />
          </div>
        </WorkflowStep>

        {/* Step 5: Game Scheduling */}
        <WorkflowStep
          title="5. Game Scheduling"
          description="Generate and review game schedules."
          status={getStatus(5)}
          onClick={() => handleStepChange(5)}
        >
          <GameReadinessPanel
            gameReadinessSnapshot={gameData.snapshot}
            gameSummary={gameData.summary}
            generatedAt={gameData.generatedAt}
          />
          <div className="flex flex-col sm:flex-row gap-3 justify-between pt-4 mt-6 border-t border-border-subtle">
            <StepRunButton
              label={gameData?.generatedAt ? 'Re-run Game Scheduling' : 'Run Game Scheduling'}
              onRun={() => navigate('/schedule/game', { state: { autoRunGames: true } })}
              disabled={!teamsReady || !canManageSchedule}
              disabledReason={schedulingDisabledReason}
              hasExisting={Boolean(gameData?.generatedAt)}
              testId="step-run-games"
            />
            <Button variant="primary" size="lg" onClick={() => handleStepChange(6)}>
              Proceed to Output
            </Button>
          </div>
        </WorkflowStep>

        {/* Step 6: Output & Communication */}
        <WorkflowStep
          title="6. Output & Communication"
          description="Export schedules to CSV and generate coach welcome emails."
          status={getStatus(6)}
          onClick={() => handleStepChange(6)}
        >
          <OutputGenerationPanel
            teams={teamData?.teams || []}
            teamSummary={teamData?.summary || null}
            practiceAssignments={practiceData?.assignments || []}
            gameAssignments={gameData?.assignments || []}
            supabaseClient={supabase}
          />
        </WorkflowStep>
      </div>
    </div>
  );
};

export default DashboardWorkflow;
