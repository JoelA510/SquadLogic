import { useMemo } from 'react';
import './App.css';
import { useTeamPersistence } from './hooks/useTeamPersistence';

// Auth
import { AuthProvider, useAuth } from './contexts/AuthContext.jsx';
import { supabase } from './utils/supabaseClient';
import Login from './components/Login.jsx';
import ImportPanel from './components/ImportPanel';

// Components
import Header from './components/Header.jsx';
import Hero from './components/Hero.jsx';
import SummaryGrid from './components/SummaryGrid.jsx';
import TeamOverviewPanel from './components/TeamOverviewPanel.jsx';
import TeamPersistencePanel from './components/TeamPersistencePanel.jsx';
import PracticeReadinessPanel from './components/PracticeReadinessPanel.jsx';
import PracticePersistencePanel from './components/PracticePersistencePanel.jsx';
import GameReadinessPanel from './components/GameReadinessPanel.jsx';
import GamePersistencePanel from './components/GamePersistencePanel.jsx';
import OutputGenerationPanel from './components/OutputGenerationPanel.jsx';
import EvaluationPanel from './components/EvaluationPanel.jsx';
import RoadmapSection from './components/RoadmapSection.jsx';
import ThemeToggle from './components/ThemeToggle.jsx';
import LoadingScreen from './components/LoadingScreen.jsx';

// Data Hook
import { useDashboardData } from './hooks/useDashboardData';

function Dashboard() {
  const {
    loading,
    roadmap,
    team,
    practice,
    game
  } = useDashboardData();

  const { persistenceSnapshot, loading: persistenceLoading } = useTeamPersistence();

  const handleImport = (data) => {
    console.log('Imported data:', data);
    // TODO: Wire up to Supabase or state management
  };

  return (
    <div className="app-shell">
      <Header />
      <main className="app-main">
        <Hero />
        <SummaryGrid completed={roadmap.stats.completed} pending={roadmap.stats.pending} />

        {loading.team ? (
          <div className="flex justify-center p-8 text-white/50">Loading metrics...</div>
        ) : (
          <TeamOverviewPanel
            totals={team.totals}
            divisions={team.divisions}
            generatedAt={team.generatedAt}
          />
        )}

        <ImportPanel onImport={handleImport} />

        <div className="mb-6">
          <EvaluationPanel
            practiceData={{
              assignments: practice.snapshot.assignments,
              unassigned: practice.snapshot.unassigned,
              teams: team.teams,
              slots: practice.snapshot.slots,
            }}
            gameData={{
              assignments: game.snapshot.assignments,
              teams: team.teams,
              byes: game.snapshot.byes,
              unscheduled: game.snapshot.unscheduled,
            }}
            supabaseClient={supabase}
          />
        </div>

        {persistenceLoading ? (
          <div className="flex justify-center p-8 text-white/50">Loading persistence data...</div>
        ) : (
          <TeamPersistencePanel teamPersistenceSnapshot={persistenceSnapshot} />
        )}


        {loading.practice ? (
          <div className="flex justify-center p-8 text-white/50">Loading practice metrics...</div>
        ) : (
          <PracticeReadinessPanel
            practiceReadinessSnapshot={practice.snapshot}
            practiceSummary={practice.summary}
            generatedAt={practice.generatedAt}
          />
        )}

        <PracticePersistencePanel
          assignments={practice.snapshot.assignments}
          slots={practice.snapshot.slots}
          overrides={practice.snapshot.overrides}
          runMetadata={practice.snapshot.runMetadata}
          runId={practice.snapshot.runId}
        />

        {loading.game ? (
          <div className="flex justify-center p-8 text-white/50">Loading game metrics...</div>
        ) : (
          <GameReadinessPanel
            gameReadinessSnapshot={game.snapshot}
            gameSummary={game.summary}
            generatedAt={game.generatedAt}
          />
        )}

        <GamePersistencePanel
          assignments={game.snapshot.assignments}
          runMetadata={game.snapshot.runMetadata}
          runId={game.snapshot.runId}
        />

        <OutputGenerationPanel
          teams={team.teams}
          practiceAssignments={practice.snapshot.assignments}
          gameAssignments={game.snapshot.assignments}
          supabaseClient={supabase}
        />

        <RoadmapSection roadmapSections={roadmap.sections} />
      </main>

      <ThemeToggle />
    </div>
  );
}

function AppContent() {
  const { session, loading } = useAuth();

  if (loading) {
    return <LoadingScreen />;
  }

  if (!session) {
    return <Login />;
  }

  return <Dashboard />;
}

function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}

export default App;
