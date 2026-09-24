/**
 * The status line shown after a practice schedule is applied, or `null` when
 * there is nothing to say beyond "applied".
 *
 * #64: a save replaces the season's practice schedule. What it superseded, and
 * the manual rows it kept for teams the schedule does not mention, come back
 * from `practice-persistence`; this is where they reach the operator instead
 * of sitting unread in the response.
 *
 * @param {{ metricsUnavailableReason?: string | null, supersededCount?: unknown, retainedManualCount?: unknown }} input
 * @returns {string | null}
 */
export function buildPracticeApplyStatus({
  metricsUnavailableReason = null,
  supersededCount = 0,
  retainedManualCount = 0,
} = {}) {
  const superseded = Number(supersededCount) || 0;
  const retainedManual = Number(retainedManualCount) || 0;
  const notes = [
    metricsUnavailableReason
      ? `Readiness metrics were not computed for this run: ${metricsUnavailableReason}`
      : null,
    superseded > 0 ? `${superseded} earlier practice assignment(s) were replaced.` : null,
    retainedManual > 0
      ? `${retainedManual} manual assignment(s) for teams not in this schedule were kept.`
      : null,
  ].filter(Boolean);
  return notes.length > 0 ? `Schedule applied. ${notes.join(' ')}` : null;
}

/** Shown when a team has no solver reason: the save simply did not place it. */
export const NOT_IN_SCHEDULE_REASON = 'not in this schedule';

/**
 * One warning per team the save left with no practice (#64).
 *
 * The operator accepted that a team the solver cannot place loses its earlier
 * practice on one condition: a warning for EACH such team. So this returns a
 * list, one entry per `teamsWithoutPractice` row -- which the RPC enumerates
 * from the season roster -- and never folds two teams into a count.
 *
 * The reason is the solver's `unassigned` reason for that team when it gave
 * one, otherwise {@link NOT_IN_SCHEDULE_REASON}; "an earlier practice was
 * removed" is added when the team had a practice before this save.
 *
 * @param {{
 *   teamsWithoutPractice?: Array<{ team_id: string, team_name?: string, had_prior_rows?: boolean }> | null,
 *   unassigned?: Array<{ teamId: unknown, reason?: string }> | null,
 * }} input
 * @returns {Array<{ teamId: string, teamName: string, message: string }>}
 */
export function buildTeamsWithoutPracticeWarnings({
  teamsWithoutPractice = [],
  unassigned = [],
} = {}) {
  const reasonByTeam = new Map(
    (unassigned ?? [])
      .filter((entry) => entry && entry.teamId != null && entry.reason)
      .map((entry) => [String(entry.teamId), String(entry.reason)])
  );
  return (teamsWithoutPractice ?? []).map((team) => {
    const teamId = String(team.team_id);
    const reason = reasonByTeam.get(teamId) ?? NOT_IN_SCHEDULE_REASON;
    return {
      teamId,
      teamName: team.team_name || teamId,
      message: team.had_prior_rows ? `${reason}; an earlier practice was removed` : reason,
    };
  });
}
