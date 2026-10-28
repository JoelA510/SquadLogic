import { evaluatePracticeSchedule } from '../practiceMetrics.js';
import { buildPracticeAssignmentRows } from '../practiceSupabase.js';

/**
 * The exceptions this same save writes, resolved for the evaluation only.
 *
 * A row the save inserts has no id yet, so its exception names it by the
 * (team, slot, range) key it will be inserted under (`new_assignment`, built
 * by `buildPracticeAssignmentRows`: the page's `buildDaylightExceptions` and
 * the writer use the same key). Each id-less assignment whose key an
 * exception names is given an evaluation-only id (`new-row:<key>`, never a
 * UUID, so it cannot meet a stored one) and the exception is restated as a
 * stored row on it. Nothing is written: the metrics are built before the save
 * and travel inside it, so this changes no write and no write order.
 *
 * An exception whose key matches no staged row (or that does not read as an
 * object) keeps `assignment_id: null`, so the engine reports it
 * (`PRACTICE_EXCEPTION_ROW_UNREAD`) rather than this function dropping it.
 *
 * @param {{ assignments: any[], exceptions: any[], slots: any[] }} input
 * @returns {{ assignments: any[], exceptions: any[] }}
 */
function resolveSameSaveExceptions({ assignments, exceptions, slots }) {
  const keyOf = (row) =>
    `${String(row?.team_id)}|${String(row?.practice_slot_id)}|${String(row?.effective_date_range)}`;
  const idByKey = new Map();
  const resolved = assignments.map((assignment) => {
    if (assignment?.id) return assignment;
    let row;
    try {
      [row] = buildPracticeAssignmentRows({ assignments: [assignment], slots });
    } catch {
      // A row the writer itself would refuse: no exception can be keyed to it,
      // and the evaluation still reads (and reports) the assignment as sent.
      return assignment;
    }
    const key = keyOf(row);
    if (idByKey.has(key)) return assignment;
    const id = `new-row:${key}`;
    idByKey.set(key, id);
    return { ...assignment, id };
  });
  const stored = exceptions.map((exception) => ({
    id: null,
    assignment_id: idByKey.get(keyOf(exception?.new_assignment)) ?? null,
    window: exception?.window,
    kind: exception?.kind,
    tbd_reason: exception?.tbd_reason ?? null,
    withdrawn_at: null,
    practice_slot_id: exception?.practice_slot_id ?? null,
  }));
  return { assignments: resolved, exceptions: stored };
}

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
 * `unassigned` is filtered to the practices that are still missing from the
 * applied schedule. The auto-scheduler's list goes stale the moment the operator
 * hand-assigns one of those teams, and persisting it unfiltered would
 * manufacture exactly the total-vs-breakdown divergence the panel exists to
 * report: reasons accounting for a team the card no longer counts.
 *
 * **One entry is one missing practice** (Phase D PR B). It used to be one team,
 * and the filter dropped a team that held any applied assignment, so a team
 * given one of its two practices vanished from the report and its missing
 * practice was never recorded. A team whose division wants several practices a
 * week carries that count on each of its entries (`target`, set by the
 * auto-scheduler for those teams only): of its entries, as many are kept as it
 * is still short of (`target` less the assignments applied for it), so a
 * practice the operator hand-assigns since the run leaves the report. A team
 * with no `target` is the old rule: dropped once it holds any assignment. The
 * metrics engine below is still handed one entry per team with NO assignment,
 * because its `unassignedTeams` and `unassignedByReason` count teams; the
 * per-practice list is `unassigned`, and `practiceShortfall` says "1 of 2" per
 * team.
 *
 * @param {Object} params
 * @param {Array<{teamId: any, slotId: any, source?: string}>} params.assignments
 *   The assignments being persisted, in persistence shape.
 * @param {Array<{teamId: any, reason?: string, target?: number}>} [params.unassigned]
 *   Manual-follow-up entries from the scheduler, before filtering.
 * @param {Array<Object>} params.teams - Scheduler teams (the roster).
 * @param {Array<Object>} params.slots - Scheduler slots.
 * @param {Array<Object> | null} [params.exceptions] - The season's live saved
 *   practice exceptions, applied as the fairness panel applies them (the M4.7
 *   follow-up). `null` means they could not be read: the run then carries no
 *   metrics and says why, rather than a report that ignores them. Omitted
 *   (`undefined`) by a caller that predates them.
 * @param {Array<Object>} [params.sameSaveExceptions] - Exceptions this same
 *   save writes on rows it inserts, named by `new_assignment` (the daylight
 *   TIME TBD of a truncated placement). Applied with `exceptions` so the run
 *   describes the schedule it commits; the persisted `assignments` stay as
 *   sent. Ignored when `exceptions` is `null` (the run carries no metrics).
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
  exceptions,
  sameSaveExceptions = [],
  schoolDayEnd,
  timezone,
  edgeEvaluation = null,
  optimization = null,
}) {
  const appliedAssignments = Array.isArray(assignments) ? assignments : [];
  const appliedByTeam = new Map();
  for (const assignment of appliedAssignments) {
    const id = String(assignment?.teamId);
    appliedByTeam.set(id, (appliedByTeam.get(id) ?? 0) + 1);
  }
  // Per team, how many entries of a team that wants several practices a week are still wanted.
  const keptOfTeam = new Map();
  const stillUnassigned = (Array.isArray(unassigned) ? unassigned : []).filter((entry) => {
    if (!entry) return false;
    const teamId = String(entry.teamId);
    const applied = appliedByTeam.get(teamId) ?? 0;
    const target = Number.isInteger(entry.target) && entry.target > 1 ? entry.target : 1;
    if (target === 1) return applied === 0;
    const kept = keptOfTeam.get(teamId) ?? 0;
    if (kept >= target - applied) return false;
    keptOfTeam.set(teamId, kept + 1);
    return true;
  });
  // The engine counts teams: a team that holds nothing, once however many practices it lacks.
  const teamLevelUnassigned = [];
  const seenSeveral = new Set();
  for (const entry of stillUnassigned) {
    const teamId = String(entry.teamId);
    if ((appliedByTeam.get(teamId) ?? 0) > 0) continue;
    if (Number.isInteger(entry.target) && entry.target > 1) {
      if (seenSeveral.has(teamId)) continue;
      seenSeveral.add(teamId);
    }
    teamLevelUnassigned.push(entry);
  }
  // "1 of 2" per team that still lacks practices: from the entries, which carry the count.
  const shortfallByTeam = new Map();
  for (const entry of stillUnassigned) {
    if (!(Number.isInteger(entry.target) && entry.target > 1)) continue;
    const teamId = String(entry.teamId);
    const line = shortfallByTeam.get(teamId) ?? {
      teamId: entry.teamId,
      target: entry.target,
      applied: appliedByTeam.get(teamId) ?? 0,
      missing: 0,
      reasons: [],
    };
    line.missing += 1;
    if (entry.reason && !line.reasons.includes(entry.reason)) line.reasons.push(entry.reason);
    shortfallByTeam.set(teamId, line);
  }

  const base = {
    assignments: appliedAssignments,
    unassigned: stillUnassigned,
    ...(shortfallByTeam.size > 0 ? { practiceShortfall: [...shortfallByTeam.values()] } : {}),
    optimization,
    edgeEvaluation,
  };

  /** The one place this function decides a run carries no metrics. */
  const unmeasurable = (reason) => ({ metricsArm: null, metricsUnavailable: { reason }, ...base });

  // Unread is not none: a report that counted relocated weeks at their old
  // slot and TIME TBD weeks as held would read as complete.
  if (exceptions === null) {
    return unmeasurable(
      "This season's saved practice changes (moved and TIME TBD practices) could not be read, " +
        'so no practice metrics were recorded for this run.'
    );
  }

  try {
    const sameSave =
      Array.isArray(sameSaveExceptions) && sameSaveExceptions.length > 0
        ? resolveSameSaveExceptions({
            assignments: appliedAssignments,
            exceptions: sameSaveExceptions,
            slots: Array.isArray(slots) ? slots : [],
          })
        : null;
    const report = evaluatePracticeSchedule({
      assignments: sameSave ? sameSave.assignments : appliedAssignments,
      unassigned: teamLevelUnassigned,
      teams: Array.isArray(teams) ? teams : [],
      slots: Array.isArray(slots) ? slots : [],
      exceptions: sameSave ? [...(exceptions ?? []), ...sameSave.exceptions] : exceptions,
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
