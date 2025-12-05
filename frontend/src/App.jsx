import { useMemo } from 'react';
import './App.css';
import { teamSummarySnapshot } from './teamSummarySample.js';
import { practiceReadinessSnapshot } from './practiceReadinessSample.js';
import { gameReadinessSnapshot } from './gameReadinessSample.js';
import { teamPersistenceSnapshot } from './teamPersistenceSample.js';

// Auth
import { AuthProvider, useAuth } from './contexts/AuthContext.jsx';
import Login from './components/Login.jsx';
import ImportPanel from './components/ImportPanel';

// Existing Components
import TeamPersistencePanel from './components/TeamPersistencePanel.jsx';
import PracticePersistencePanel from './components/PracticePersistencePanel.jsx';
import GamePersistencePanel from './components/GamePersistencePanel.jsx';
import OutputGenerationPanel from './components/OutputGenerationPanel.jsx';
import EvaluationPanel from './components/EvaluationPanel.jsx';
import ThemeToggle from './components/ThemeToggle.jsx';

// New Extracted Components
import Header from './components/Header.jsx';
import Hero from './components/Hero.jsx';
import SummaryGrid from './components/SummaryGrid.jsx';
import TeamOverviewPanel from './components/TeamOverviewPanel.jsx';
import PracticeReadinessPanel from './components/PracticeReadinessPanel.jsx';
import GameReadinessPanel from './components/GameReadinessPanel.jsx';
import RoadmapSection from './components/RoadmapSection.jsx';
import LoadingScreen from './components/LoadingScreen.jsx';

const roadmapSections = [
  {
    id: 'team-generation',
    title: 'Team Generation',
    status: 'in-progress',
    summary:
      'Balanced roster allocator with buddy diagnostics and overflow tracking is ready; wiring the summary UI into the admin experience is underway.',
    actions: ['Connect Supabase persistence', 'Complete roster review workflows'],
  },
  {
    id: 'practice-scheduling',
    title: 'Practice Scheduling',
    status: 'in-progress',
    summary:
      'Allocator honors coach preferences, manual locks, and fairness scoring with automated swap recovery. Admin dashboards are still being assembled.',
    actions: ['Wire scheduler run logs', 'Expose manual adjustment tooling'],
  },
  {
    id: 'game-scheduling',
    title: 'Game Scheduling',
    status: 'in-progress',
    summary:
      'Round-robin generator and conflict-aware slot allocator are ready; Supabase persistence and admin tooling remain.',
    actions: ['Persist game assignments', 'Add conflict resolution dashboard'],
  },
  {
    id: 'evaluation',
    title: 'Evaluation Pipeline',
    status: 'in-progress',
    summary:
      'Practice and game metrics aggregate into readiness signals. Next step is wiring Supabase orchestration.',
    actions: ['Store evaluator snapshots', 'Surface dashboard visualisations'],
  },
  {
    id: 'output-generation',
    title: 'Output Generation',
    status: 'in-progress',
    summary:
      'CSV formatters produce master and per-team exports; storage integration and email workflows are upcoming.',
    actions: ['Implement Supabase storage uploads', 'Draft coach email templates'],
  },
];

function Dashboard() {
  const summary = useMemo(() => {
    const completed = roadmapSections.filter((section) => section.status === 'complete').length;
    const pending = roadmapSections.length - completed;
    return {
      completed,
      pending,
    };
  }, []);

  const { totals, divisions, generatedAt } = teamSummarySnapshot;
  const practiceSummary = practiceReadinessSnapshot.summary;
  const practiceGeneratedAt = practiceReadinessSnapshot.generatedAt;
  const gameSummary = gameReadinessSnapshot.summary;
  const gameGeneratedAt = gameReadinessSnapshot.generatedAt;

  const handleImport = (data) => {
    console.log('Imported data:', data);
    // TODO: Wire up to Supabase or state management
  };

  return (
    <div className="app-shell">
      <Header />

      <main className="app-main">
        <Hero />

        <SummaryGrid completed={summary.completed} pending={summary.pending} />

        <ImportPanel onImport={handleImport} />

        <div className="mb-6">
          <EvaluationPanel
            practiceData={{
              assignments: practiceReadinessSnapshot.assignments,
              unassigned: practiceReadinessSnapshot.unassigned,
              teams: teamSummarySnapshot.teams,
              slots: practiceReadinessSnapshot.slots,
            }}
            gameData={{
              assignments: gameReadinessSnapshot.assignments,
              teams: teamSummarySnapshot.teams,
              byes: gameReadinessSnapshot.byes,
              unscheduled: gameReadinessSnapshot.unscheduled,
            }}
          />
        </div>

        <TeamOverviewPanel
          totals={totals}
          divisions={divisions}
          generatedAt={generatedAt}
        />

        <TeamPersistencePanel teamPersistenceSnapshot={teamPersistenceSnapshot} />

        <PracticeReadinessPanel
          practiceReadinessSnapshot={practiceReadinessSnapshot}
          practiceSummary={practiceSummary}
          generatedAt={practiceGeneratedAt}
        />

        <PracticePersistencePanel
          assignments={practiceReadinessSnapshot.assignments}
          slots={practiceReadinessSnapshot.slots}
          overrides={practiceReadinessSnapshot.overrides}
          runMetadata={practiceReadinessSnapshot.runMetadata}
          runId={practiceReadinessSnapshot.runId}
        />

        <GameReadinessPanel
          gameReadinessSnapshot={gameReadinessSnapshot}
          gameSummary={gameSummary}
          generatedAt={gameGeneratedAt}
        />

        <GamePersistencePanel
          assignments={gameReadinessSnapshot.assignments}
          runMetadata={gameReadinessSnapshot.runMetadata}
          runId={gameReadinessSnapshot.runId}
        />

        <OutputGenerationPanel
          teams={teamSummarySnapshot.teams}
          practiceAssignments={practiceReadinessSnapshot.assignments}
          gameAssignments={gameReadinessSnapshot.assignments}
        />

        <RoadmapSection roadmapSections={roadmapSections} />
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
