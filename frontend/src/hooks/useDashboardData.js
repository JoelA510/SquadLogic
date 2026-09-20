import { useMemo } from 'react';
import { useTeamSummary } from './useTeamSummary.js';
import { usePracticeSummary } from './usePracticeSummary.js';
import { usePracticeAssignments } from './usePracticeAssignments.js';
import { useGameSummary } from './useGameSummary.js';
import { useGameAssignments } from './useGameAssignments.js';
import { ROADMAP_SECTIONS } from '../constants/roadmap.js';

/**
 * The first of the three fetches that failed, as a string.
 *
 * All three child hooks already hold an `error`, and this hook used to return
 * none of them: `WorkflowPage` destructured `error` off it, seeded a
 * `useState` from the `undefined` that came back, and rendered an error banner
 * that no fetch failure could ever open. An RLS refusal or a dropped
 * connection reached the operator as an empty dashboard.
 *
 * **A string, not the Error.** The banner renders the value straight into a
 * `<span>`, and React throws on a raw `Error` child ("Objects are not valid as
 * a React child"), so handing back the object would trade a silent failure for
 * a crashed page. `location.state?.error` — the banner's other source — is
 * already a string, so this adopts that contract rather than inventing a
 * second one.
 *
 * @param {Array<unknown>} errors
 * @returns {string|null}
 */
function firstErrorMessage(errors) {
  for (const error of errors) {
    if (!error) continue;
    if (typeof error === 'string') return error;
    const message = /** @type {{ message?: unknown }} */ (error).message;
    if (typeof message === 'string' && message) return message;
    return 'Failed to load dashboard data.';
  }
  return null;
}

export function useDashboardData() {
  const {
    summary: teamSummary,
    loading: teamLoading,
    error: teamError,
    generatedAt: teamGeneratedAt,
    status: teamStatus,
    progress: teamProgress,
  } = useTeamSummary();

  const {
    practiceSummary,
    practiceReadinessSnapshot,
    generatedAt: practiceGeneratedAt,
    loading: practiceLoading,
    error: practiceError,
    runId: practiceRunId,
  } = usePracticeSummary();

  const { assignments: practiceAssignments } = usePracticeAssignments(practiceRunId);

  const {
    gameSummary,
    gameReadinessSnapshot,
    generatedAt: gameGeneratedAt,
    loading: gameLoading,
    error: gameError,
    runId: gameRunId,
  } = useGameSummary();

  const { assignments: gameAssignments } = useGameAssignments(gameRunId);

  const error = useMemo(
    () => firstErrorMessage([teamError, practiceError, gameError]),
    [teamError, practiceError, gameError]
  );

  const roadmapStats = useMemo(() => {
    const completed = ROADMAP_SECTIONS.filter((section) => section.status === 'complete').length;
    const pending = ROADMAP_SECTIONS.length - completed;
    return { completed, pending };
  }, []);

  const resolvedTeam = {
    summary: teamSummary,
    generatedAt: teamGeneratedAt,
    totals: teamSummary?.totals,
    divisions: teamSummary?.divisions,
    teams: teamSummary?.teams,
    team_players: teamSummary?.team_players,
    status: teamStatus,
    progress: teamProgress,
  };

  const resolvedPractice = {
    summary: practiceSummary,
    snapshot: practiceReadinessSnapshot,
    generatedAt: practiceGeneratedAt,
    runId: practiceRunId,
    assignments: practiceAssignments,
  };

  const resolvedGame = {
    summary: gameSummary,
    snapshot: gameReadinessSnapshot,
    warnings: gameReadinessSnapshot?.warnings ?? [],
    generatedAt: gameGeneratedAt,
    runId: gameRunId,
    assignments: gameAssignments,
  };

  return {
    loading: {
      team: teamLoading,
      practice: practiceLoading,
      game: gameLoading,
    },
    error,
    roadmap: {
      sections: ROADMAP_SECTIONS,
      stats: roadmapStats,
    },
    team: resolvedTeam,
    practice: resolvedPractice,
    game: resolvedGame,
  };
}
