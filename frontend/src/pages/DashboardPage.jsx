import React, { useState } from 'react';
import Hero from '../components/Hero';
import SummaryGrid from '../components/SummaryGrid';
import DashboardWorkflow from '../components/DashboardWorkflow';
import { useDashboardData } from '../hooks/useDashboardData';
import { useTeamPersistence } from '../hooks/useTeamPersistence';
import { useImport } from '../contexts/ImportContext';
import { useTheme } from '../contexts/ThemeContext';
import LoadingScreen from '../components/LoadingScreen';

export default function DashboardPage() {
    const { loading, roadmap, team, practice, game } = useDashboardData();
    const { persistenceSnapshot } = useTeamPersistence();
    const { importedData, setImportedData } = useImport();
    const { timezone } = useTheme();
    const [activeStep, setActiveStep] = useState(1);

    if (loading.team && loading.practice && loading.game) {
        return <LoadingScreen />;
    }

    const handleImport = (data) => {
        console.log('Imported data:', data);
        setImportedData(data);
    };

    return (
        <div className="space-y-8 animate-fadeIn">
            <Hero />
            <SummaryGrid completed={roadmap.stats.completed} pending={roadmap.stats.pending} />

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
                timezone={timezone}
            />
        </div>
    );
}
