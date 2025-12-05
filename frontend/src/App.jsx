import { useMemo } from 'react';
import './App.css';
import { useTeamPersistence } from './hooks/useTeamPersistence';

function Dashboard() {
  const {
    loading,
    roadmap,
    team,
    practice,
    game
  } = useDashboardData();

  const { persistenceSnapshot, loading: persistenceLoading } = useTeamPersistence();

  // ... handleImport ...

  return (
    <div className="app-shell">
      {/* ... Header, Hero, SummaryGrid ... */}
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
            // ... props ...
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
