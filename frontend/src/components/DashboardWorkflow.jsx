import React, { useState, useEffect } from 'react';
import { supabase } from '../utils/supabaseClient';
import WorkflowStep from './WorkflowStep';
import ImportPanel from './ImportPanel';
import TeamOverviewPanel from './TeamOverviewPanel';
import TeamPersistencePanel from './TeamPersistencePanel';
import PracticeReadinessPanel from './PracticeReadinessPanel';
import GameReadinessPanel from './GameReadinessPanel';

import Button from './ui/Button';
import ProgressBar from './ui/ProgressBar';

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
    timezone
}) => {
    const [internalActiveStep, setInternalActiveStep] = useState(() => {
        const saved = localStorage.getItem('dashboardActiveStep');
        return saved ? parseInt(saved, 10) : 1;
    });
    const activeStep = controlledActiveStep !== undefined ? controlledActiveStep : internalActiveStep;

    useEffect(() => {
        if (controlledActiveStep === undefined) {
            localStorage.setItem('dashboardActiveStep', internalActiveStep.toString());
        }
    }, [internalActiveStep, controlledActiveStep]);
    const [progress, setProgress] = useState(0);

    const totalSteps = 5;

    useEffect(() => {
        // Calculate progress percentage
        const p = ((activeStep - 1) / totalSteps) * 100;
        setProgress(p);
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
                    <ImportPanel onImport={(data) => {
                        onImport(data);
                        handleStepChange(2); // Auto-advance
                    }} />
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
                                        {teamData?.status === 'running' ? 'Generating Teams...' : 'Loading Team Data...'}
                                    </h3>
                                    <ProgressBar
                                        progress={teamData?.progress || 0}
                                        label={teamData?.status === 'running' ? 'Processing roster rules and division caps...' : 'Fetching data...'}
                                    />
                                </div>
                            </div>
                        ) : !teamData?.generatedAt && importedData ? (
                            <div className="bg-bg-surface p-8 rounded-xl text-center border border-border-subtle">
                                <div className="text-4xl mb-4 flex justify-center">
                                    <svg className="w-16 h-16 text-blue-400/80" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                                    </svg>
                                </div>
                                <h3 className="text-xl font-bold text-text-primary mb-2">Ready to Generate Teams</h3>
                                <p className="text-text-secondary mb-6 max-w-md mx-auto">
                                    {importedData.totalRows} records imported and ready for processing.
                                    Click below to generate team structures based on the imported data.
                                </p>
                                <Button
                                    variant="primary"
                                    size="lg"
                                    onClick={async () => {
                                        // Attempt real insert
                                        try {
                                            // Fetch season settings ID first
                                            const { data: settings } = await supabase
                                                .from('season_settings')
                                                .select('id')
                                                .limit(1)
                                                .single();

                                            if (settings) {
                                                await supabase.from('scheduler_runs').insert({
                                                    season_settings_id: settings.id,
                                                    run_type: 'team',
                                                    status: 'running',
                                                    metrics: { progress: 0 },
                                                    started_at: new Date().toISOString()
                                                });
                                            }
                                        } catch (e) {
                                            console.error('Backend insert failed', e);
                                        }
                                    }}
                                >
                                    Generate Teams
                                </Button>
                            </div>
                        ) : (
                            <>
                                <TeamOverviewPanel
                                    totals={teamData.totals}
                                    divisions={teamData.divisions}
                                    generatedAt={teamData.generatedAt}
                                />
                                <TeamPersistencePanel teamPersistenceSnapshot={persistenceSnapshot} />
                                <div className="flex justify-end pt-4 border-t border-border-subtle">
                                    <Button
                                        variant="primary"
                                        size="lg"
                                        onClick={() => handleStepChange(3)}
                                    >
                                        Confirm Teams & Proceed
                                    </Button>
                                </div>
                            </>
                        )}
                    </div>
                </WorkflowStep>

                {/* Step 3: Field Management */}
                < WorkflowStep
                    title="3. Field Management"
                    description="Configure fields, priorities, and practice slots."
                    status={getStatus(3)}
                    onClick={() => handleStepChange(3)}
                >
                    <div className="bg-bg-surface p-8 rounded-xl text-center border border-border-subtle">
                        <div className="text-4xl mb-4 flex justify-center">
                            <svg className="w-16 h-16 text-blue-400/80" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
                            </svg>
                        </div>
                        <h3 className="text-xl font-bold text-text-primary mb-2">Field Configuration</h3>
                        <p className="text-text-secondary mb-6 max-w-md mx-auto">
                            Field configuration is currently handled via the <code>generate_practice_slots.js</code> script.
                            Ensure you have run the generator before proceeding.
                        </p>
                        <Button
                            variant="secondary"
                            onClick={() => handleStepChange(4)}
                        >
                            Mark as Configured
                        </Button>
                    </div>
                </WorkflowStep >

                {/* Step 4: Practice Scheduling */}
                < WorkflowStep
                    title="4. Practice Scheduling"
                    description="Generate and review practice schedules based on field availability."
                    status={getStatus(4)}
                    onClick={() => handleStepChange(4)}
                >
                    <PracticeReadinessPanel
                        practiceReadinessSnapshot={practiceData.snapshot}
                        practiceSummary={practiceData.summary}
                        generatedAt={practiceData.generatedAt}
                        timezone={timezone}
                    />
                </WorkflowStep >

                {/* Step 5: Game Scheduling */}
                < WorkflowStep
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
                </WorkflowStep >
            </div >
        </div >
    );
};

export default DashboardWorkflow;
