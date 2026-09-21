import { evaluatePracticeSchedule } from '../practiceMetrics.js';

/**
 * Build the `scheduler_runs.results` payload for an applied practice schedule.
 *
 * ## Why this exists
 *
 * Four sides describe `results` for a practice run, and until this function
 * three of them agreed and the writer did not:
 *
 * - **reader** -- `utils/practiceSummaryMapper.js` takes `run.results`
 *   verbatim as the snapshot and lifts `snapshot.summary`;
 * - **panel** -- `PracticeReadinessPanel` gates its KPI card on
 *   `summary.unassignedTeams` being a number, and renders
 *   `unassignedByReason` and `dataQualityWarnings`;
 * - **seed** -- `supabase/seed.sql`'s "rich practice run" writes the core
 *   `practiceMetrics` report: top-level `summary`, then `slotUtilization`,
 *   and so on;
 * - **writer** -- `PracticeSchedulingPage`'s apply path wrote
 *   `{ assignments, unassigned, evaluation, optimization }`, with no
 *   top-level `summary` at all.
 *
 * So the card rendered from seeded and mock data and was absent for every run
 * an operator actually applied. `unassignedByReason` and
 * `dataQualityWarnings` never arrived either -- the whole panel, not just the
 * card, was empty in production.
 *
 * **The game sibling settles which side was wrong.**
 * `GameSchedulingPage.persistReviewedAssignments` already writes
 * `results.summary` (from `summarizeGameResult`) plus the `unscheduled` and
 * `warnings` keys `GameReadinessPanel` reads. The twin arm was already
 * correct; the practice writer was the lone outlier, against its own sibling
 * as well as against its own reader.
 *
 * ## Why the report is recomputed rather than hoisted
 *
 * The obvious one-line fix -- hoist `autoScheduler.result.evaluation.summary`
 * to the top level -- is wrong twice over.
 *
 * **It is the wrong arm.** That `evaluation` is the Edge evaluator
 * (`supabase/functions/_shared/engines/scoring-engine.ts`), a deliberately
 * narrower implementation: 6 top-level keys against core's 13, and a
 * `summary` carrying `coveragePercent`/`fairnessScore` where core's carries
 * `assignmentsRead`/`assignmentsCounted`/`manualFollowUpRate`. #409
 * established the two are NOT isomorphic and corrected five places that
 * treated them as one. Writing the narrow arm's numbers under the shape that
 * means "the core `practiceMetrics` report" would put that confusion straight
 * back. It also has no `unassignedByReason` and no `dataQualityWarnings`, so
 * two thirds of the panel would stay empty.
 *
 * **It is the wrong schedule.** `evaluation` measures the auto-scheduler's
 * raw proposal. What gets persisted is `reviewAssignments`, which the
 * operator may have changed since (`handleToggleLock`,
 * `handleStageManualAssignment`) -- or may have built by hand with no
 * auto-scheduler run at all, in which case `evaluation` is `null` and there
 * is nothing to hoist. A measurement of one schedule stored as the results of
 * another is a new hollow guarantee, not a fix for the old one.
 *
 * So the core evaluator is run over the assignments actually being applied.
 *
 * ## What it does NOT do
 *
 * It does not accept two shapes and quietly flatten them. The top level is
 * always the core report and `metricsArm` says so; the Edge report is kept
 * verbatim under `edgeEvaluation`, a key naming its producer, so no reader
 * can mistake one for the other. Rows written before this function exists
 * carry neither key and no `summary`, and the panel's existing gate renders
 * no card for them -- which is the honest answer, not a normalised guess.
 *
 * `unassigned` is filtered to teams that really have no slot in the applied
 * schedule. The auto-scheduler's list goes stale the moment the operator
 * hand-assigns one of those teams, and persisting it unfiltered would
 * manufacture exactly the total-vs-breakdown divergence the panel exists to
 * report: reasons accounting for a team the card no longer counts.
 *
 * @param {Object} params
 * @param {Array<{teamId: any, slotId: any, source?: string}>} params.assignments
 *   The assignments being persisted, in persistence shape.
 * @param {Array<{teamId: any, reason?: string}>} [params.unassigned]
 *   Manual-follow-up entries from the scheduler, before filtering.
 * @param {Array<Object>} params.teams - Scheduler teams (the roster).
 * @param {Array<Object>} params.slots - Scheduler slots.
 * @param {string} [params.schoolDayEnd]
 * @param {string} [params.timezone] - The season's IANA zone.
 * @param {Object|null} [params.edgeEvaluation] - The Edge arm's report, if a
 *   run produced one. Stored under its own name, never merged.
 * @param {Object|null} [params.optimization] - The hill-climber's stats.
 * @returns {Object} The `results` payload.
 */
export function buildPracticeRunResults({
  assignments,
  unassigned = [],
  teams,
  slots,
  schoolDayEnd,
  timezone,
  edgeEvaluation = null,
  optimization = null,
}) {
  const appliedAssignments = Array.isArray(assignments) ? assignments : [];
  const assignedTeamIds = new Set(
    appliedAssignments.map((assignment) => String(assignment?.teamId))
  );
  const stillUnassigned = (Array.isArray(unassigned) ? unassigned : []).filter(
    (entry) => entry && !assignedTeamIds.has(String(entry.teamId))
  );

  const base = {
    assignments: appliedAssignments,
    unassigned: stillUnassigned,
    optimization,
    edgeEvaluation,
  };

  /** The one place this function decides a run carries no metrics. */
  const unmeasurable = (reason) => ({ metricsArm: null, metricsUnavailable: { reason }, ...base });

  try {
    const report = evaluatePracticeSchedule({
      assignments: appliedAssignments,
      unassigned: stillUnassigned,
      teams: Array.isArray(teams) ? teams : [],
      slots: Array.isArray(slots) ? slots : [],
      schoolDayEnd,
      timezone,
    });

    // **A report the engine could not resolve a single assignment for is a
    // falsely perfect one, not a true one.** `evaluatePracticeSchedule`
    // answers the vacuous case with `assignmentRate: 1` and derives
    // `unassignedTeams` as `totalTeams - assignedTeams`, so an EMPTY roster
    // against a non-empty schedule yields `unassignedTeams: 0` and a KPI card
    // reading `0` in the `good` tone -- over a run whose assignments were all
    // silently dropped for naming teams the evaluator had never heard of.
    //
    // That state is reachable, not theoretical: `teams` at the call site is
    // `team?.teams` from the dashboard summary, which is empty while the team
    // fetch is in flight, after it errors, and on a cold start. Apply is
    // guarded on `canManageSchedule && reviewAssignments?.length` only, so a
    // staged lock change can be applied in exactly that window.
    //
    // The engine already publishes the two numbers that tell this apart:
    // `assignmentsRead` is what arrived and `assignmentsCounted` is what
    // survived resolution. Nothing surviving out of something is not a
    // measurement. Read off the report rather than guessed from the inputs,
    // so it also covers a schedule whose slots were all unknown.
    const { assignmentsRead, assignmentsCounted } = report.summary;
    if (assignmentsRead > 0 && assignmentsCounted === 0) {
      return unmeasurable(
        `None of the ${assignmentsRead} applied assignment(s) could be resolved against the ` +
          `${Array.isArray(teams) ? teams.length : 0} team(s) and ` +
          `${Array.isArray(slots) ? slots.length : 0} slot(s) available, so no readiness metrics ` +
          'were computed for this run.'
      );
    }

    return { ...report, metricsArm: 'core', ...base };
  } catch (err) {
    // **Recorded and surfaced, not swallowed, and never faked.** The
    // evaluator validates its inputs (`TeamSchema`, `SlotSchema`), and a slot
    // that survives `partitionPracticeSlots` can still fail it -- a
    // non-numeric `capacity` becomes `NaN`, and an end at or before its start
    // composes fine but is refused here.
    //
    // It also refuses a `schoolDayEnd` it cannot place on the season's clock,
    // with a `SeasonClockError` carrying `WALL_TIME_UNREADABLE`,
    // `SEASON_TIMEZONE_MISSING` or `SEASON_TIMEZONE_UNKNOWN` -- the same three
    // `schedulePractices` raises. That arrives here rather than as an empty
    // `dataQualityWarnings`, which is the point: a season with a malformed
    // `school_day_end` used to persist a report reading "no school-hours
    // violations" over a schedule nothing had checked, and now persists no
    // report and says why. Persisting the operator's schedule
    // matters more than measuring it, so the apply is not failed; but the row
    // says plainly that it carries no metrics and why, rather than shipping a
    // partial report that would read as a complete one. With no `summary` the
    // panel's existing gate renders no card, which is correct.
    //
    // The caller reads `metricsUnavailable` back and tells the operator --
    // `PracticeSchedulingPage.handleApplySchedule`. A reason written only
    // into a JSON column nobody reads would be this phase's own shape: a
    // guarantee that is declared and not enforced.
    return unmeasurable(err?.message ?? 'Practice metrics could not be computed for this run.');
  }
}
