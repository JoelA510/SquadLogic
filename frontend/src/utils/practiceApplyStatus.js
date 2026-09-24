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
