import { useMemo } from 'react';
import { useTeamSummary } from './useTeamSummary.js';
import { usePracticeSummary } from './usePracticeSummary.js';
import { usePracticeAssignments } from './usePracticeAssignments.js';
import { useGameSummary } from './useGameSummary.js';
import { useGameAssignments } from './useGameAssignments.js';
import { ROADMAP_SECTIONS } from '../constants/roadmap.js';

/**
 * The first of the supplied fetches that failed, as a string.
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

  const {
    assignments: practiceAssignments,
    loading: practiceAssignmentsLoading,
    error: practiceAssignmentsError,
  } = usePracticeAssignments(practiceRunId);

  const {
    gameSummary,
    gameReadinessSnapshot,
    generatedAt: gameGeneratedAt,
    loading: gameLoading,
    error: gameError,
    runId: gameRunId,
  } = useGameSummary();

  const {
    assignments: gameAssignments,
    loading: gameAssignmentsLoading,
    error: gameAssignmentsError,
  } = useGameAssignments(gameRunId);

  /**
   * One message per source, so a caller can tell which read failed.
   *
   * `error` below is one string for what are five independent fetches, and a
   * page that renders only one source has no way to know whether the string
   * is about that source or another. `DataErrorBanner`'s docstring recorded
   * that as over-reporting and named per-source errors on this hook as the
   * remedy; this is it. `error` is now derived from these three rather than
   * computed a second time, so the aggregate and the parts cannot disagree.
   *
   * **The assignments reads are in here, and they were in nothing before.**
   * `usePracticeAssignments` and `useGameAssignments` each hold an `error`
   * and this hook destructured only their `assignments`. On a refused read
   * those stay `[]` -- so a refused `practice_assignments` read produced the
   * exact empty-looking-but-unread state the banner exists to prevent, with
   * no banner anywhere, and those are the rows the CSV export is built from.
   * Folding them in widens `error` for every existing consumer, in the one
   * direction that is a fix: they showed nothing for these failures.
   *
   * Practice and game each fold their summary and their assignments into one
   * message, because no consumer distinguishes "the run" from "the rows of
   * the run" -- both mean the same thing to a reader of `practice`.
   *
   * @type {{ team: string|null, practice: string|null, game: string|null }}
   */
  const errors = useMemo(
    () => ({
      team: firstErrorMessage([teamError]),
      practice: firstErrorMessage([practiceError, practiceAssignmentsError]),
      game: firstErrorMessage([gameError, gameAssignmentsError]),
    }),
    [teamError, practiceError, practiceAssignmentsError, gameError, gameAssignmentsError]
  );

  const error = useMemo(
    () => firstErrorMessage([errors.team, errors.practice, errors.game]),
    [errors]
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
      // The assignments reads are folded in here for the same reason their
      // errors are: a source whose rows have not arrived is not a source that
      // returned none, and `practice` means the run and its rows to every
      // reader of it.
      practice: practiceLoading || practiceAssignmentsLoading,
      game: gameLoading || gameAssignmentsLoading,
    },
    error,
    errors,
    roadmap: {
      sections: ROADMAP_SECTIONS,
      stats: roadmapStats,
    },
    team: resolvedTeam,
    practice: resolvedPractice,
    game: resolvedGame,
  };
}
