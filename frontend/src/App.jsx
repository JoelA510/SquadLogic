import { useMemo } from 'react';
import './App.css';
import { teamSummarySnapshot } from './teamSummarySample.js';
import { practiceReadinessSnapshot } from './practiceReadinessSample.js';
import { gameReadinessSnapshot } from './gameReadinessSample.js';
import { teamPersistenceSnapshot } from './teamPersistenceSample.js';

// Auth
import { AuthProvider, useAuth } from './contexts/AuthContext.jsx';
import { useTeamSummary } from './hooks/useTeamSummary.js';
import { usePracticeSummary } from './hooks/usePracticeSummary.js';
import { useGameSummary } from './hooks/useGameSummary.js';
import { supabase } from './utils/supabaseClient';
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

/**
 * Helper to resolve data between dynamic hook result and static snapshot fallback.
 * Validates the hook data is populated before using it.
 */
function resolveData({ hookSummary, hookSnapshot, hookGeneratedAt, staticSnapshot, checkKey = 'summary' }) {
  // Check if the hook successfully returned a populated snapshot
  // e.g. baseSlotDistribution for practice, totalGames for game
  const isValid = hookSnapshot && (
    checkKey === 'baseSlotDistribution' ? hookSnapshot.baseSlotDistribution :
      checkKey === 'totalGames' ? hookSnapshot.summary?.totalGames !== undefined :
        true
  );

  return {
    summary: isValid ? hookSummary : staticSnapshot.summary,
    generatedAt: isValid ? hookGeneratedAt : staticSnapshot.generatedAt,
    snapshot: isValid ? hookSnapshot : staticSnapshot
  };
}

function Dashboard() {
  const summary = useMemo(() => {
    const completed = roadmapSections.filter((section) => section.status === 'complete').length;
    const pending = roadmapSections.length - completed;
    return {
      completed,
      pending,
    };
  }, []);

  const { summary: teamSummary, loading: teamLoading } = useTeamSummary();
  const {
    practiceSummary: hookPracticeSummary,
    practiceReadinessSnapshot: hookPracticeSnapshot,
    generatedAt: hookPracticeGeneratedAt,
    loading: practiceLoading
  } = usePracticeSummary();

  const {
    gameSummary: hookGameSummary,
    gameReadinessSnapshot: hookGameSnapshot,
    generatedAt: hookGameGeneratedAt,
    loading: gameLoading
  } = useGameSummary();

  const totals = teamSummary ? teamSummary.totals : teamSummarySnapshot.totals;
  const divisions = teamSummary ? teamSummary.divisions : teamSummarySnapshot.divisions;
  const generatedAt = teamSummary ? teamSummary.generatedAt : teamSummarySnapshot.generatedAt;

  // Resolve Practice Data
  const {
    summary: practiceSummary,
    generatedAt: practiceGeneratedAt,
    snapshot: realPracticeSnapshot
  } = resolveData({
    hookSummary: hookPracticeSummary,
    hookSnapshot: hookPracticeSnapshot,
    hookGeneratedAt: hookPracticeGeneratedAt,
    staticSnapshot: practiceReadinessSnapshot,
    checkKey: 'baseSlotDistribution'
  });

  // Resolve Game Data
  const {
    summary: gameSummary,
    generatedAt: gameGeneratedAt,
    snapshot: realGameSnapshot
  } = resolveData({
    hookSummary: hookGameSummary,
    hookSnapshot: hookGameSnapshot,
    hookGeneratedAt: hookGameGeneratedAt,
    staticSnapshot: gameReadinessSnapshot,
    checkKey: 'totalGames'
  });

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

        {teamLoading ? (
          <div className="flex justify-center p-8 text-white/50">Loading metrics...</div>
        ) : (
          <TeamOverviewPanel
            totals={totals}
            divisions={divisions}
            generatedAt={generatedAt}
          />
        )}

        <ImportPanel onImport={handleImport} />

        <div className="mb-6">
          <EvaluationPanel
            practiceData={{
              assignments: realPracticeSnapshot.assignments,
              unassigned: realPracticeSnapshot.unassigned,
              teams: teamSummary ? teamSummary.teams : teamSummarySnapshot.teams,
              slots: realPracticeSnapshot.slots,
            }}
            gameData={{
              assignments: realGameSnapshot.assignments,
              teams: teamSummary ? teamSummary.teams : teamSummarySnapshot.teams,
              byes: realGameSnapshot.byes,
              unscheduled: realGameSnapshot.unscheduled,
            }}
            supabaseClient={supabase}
          />
        </div>

        <TeamPersistencePanel teamPersistenceSnapshot={teamPersistenceSnapshot} />

        {practiceLoading ? (
          <div className="flex justify-center p-8 text-white/50">Loading practice metrics...</div>
        ) : (
          <PracticeReadinessPanel
            practiceReadinessSnapshot={realPracticeSnapshot}
            practiceSummary={practiceSummary}
            generatedAt={practiceGeneratedAt}
          />
        )}

        <PracticePersistencePanel
          assignments={realPracticeSnapshot.assignments}
          slots={realPracticeSnapshot.slots}
          overrides={realPracticeSnapshot.overrides}
          runMetadata={realPracticeSnapshot.runMetadata}
          runId={realPracticeSnapshot.runId}
        />

        {gameLoading ? (
          <div className="flex justify-center p-8 text-white/50">Loading game metrics...</div>
        ) : (
          <GameReadinessPanel
            gameReadinessSnapshot={realGameSnapshot}
            gameSummary={gameSummary}
            generatedAt={gameGeneratedAt}
          />
        )}

        <GamePersistencePanel
          assignments={realGameSnapshot.assignments}
          runMetadata={realGameSnapshot.runMetadata}
          runId={realGameSnapshot.runId}
        />

        <OutputGenerationPanel
          teams={teamSummary ? teamSummary.teams : teamSummarySnapshot.teams}
          practiceAssignments={realPracticeSnapshot.assignments}
          gameAssignments={realGameSnapshot.assignments}
          supabaseClient={supabase}
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
