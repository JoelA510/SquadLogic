import type {
  Team,
  Slot,
  PracticeAssignment,
  PracticeException,
  GameAssignment,
} from '../schemas/scoring.ts';
import { datedSlotsIssue, undatedExceptionsIssue } from '../schemas/scoring.ts';
import { conflictPairKey, listTeamCoachIds } from './practice-coaches.ts';
import {
  LIVE_SPAN_STATUS,
  applyExceptionsToLiveRows,
  assignmentLiveSpan,
  calendarDayNumber,
  peakPieceCount,
  sharedHeldDates,
  sharedLiveDates,
  spanPiece,
  wallSeconds,
} from './practice-live-dates.ts';
import type { LiveRow, Piece } from './practice-live-dates.ts';

export type Severity = 'info' | 'warning' | 'error';

export interface Issue {
  category: string;
  message: string;
  severity: Severity;
  details?: Record<string, unknown>;
}

export type EvaluationStatus = 'ok' | 'attention-needed' | 'action-required';

export interface EvaluationResult {
  status: EvaluationStatus;
  issues: Issue[];
  practice?: ReturnType<typeof evaluatePracticeSchedule> | null;
  games?: ReturnType<typeof evaluateGameSchedule> | null;
  metrics: {
    fairnessScore: number;
    combinedScore: number;
    executionTimeMs?: number;
  };
}

/**
 * Fairness Scoring Engine (Deno/TS)
 *
 * A **separate, narrower** implementation of the evaluators in
 * `packages/core/src/practiceMetrics.js` and `gameMetrics.js` -- not a shared
 * module and not isomorphic with them, though this header claimed to be both
 * until the two arms were measured against each other. An Edge Function cannot
 * import `packages/core`, so the logic exists twice and can drift; it did.
 *
 * The agreed contract, and the fields that are deliberately arm-specific, are
 * stated and enforced in `tests/scoringEngineDrift.test.js`, which imports
 * both arms and runs them over one vector table.
 */

const _FAIRNESS_DOMINANCE_THRESHOLD = 0.7;
const _UNDERUTILIZATION_THRESHOLD = 0.25;
const _DAY_CONCENTRATION_THRESHOLD = 0.65;
const _MIN_ASSIGNMENTS_FOR_CONCENTRATION = 3;

export const MANUAL_FOLLOW_UP_CATEGORIES = {
  CAPACITY: 'capacity',
  COACH_AVAILABILITY: 'coach-availability',
  EXCLUDED_SLOTS: 'excluded-slots',
  UNKNOWN: 'constraints-or-unknown',
} as const;

function categorizeManualFollowUpReason(rawReason: string) {
  const value = (rawReason ?? 'unspecified').toLowerCase();

  if (value.includes('capacity')) {
    return MANUAL_FOLLOW_UP_CATEGORIES.CAPACITY;
  }
  if (value.includes('coach')) {
    return MANUAL_FOLLOW_UP_CATEGORIES.COACH_AVAILABILITY;
  }
  if (value.includes('exclude') || value.includes('alternative slot')) {
    return MANUAL_FOLLOW_UP_CATEGORIES.EXCLUDED_SLOTS;
  }
  return MANUAL_FOLLOW_UP_CATEGORIES.UNKNOWN;
}

/** One slot's dating, validated (M4.7). */
interface SlotDating {
  firstDay: number;
  lastDay: number;
  startSec: number;
  endSec: number;
}

const isDatedSlot = (slot: Slot) =>
  (slot.firstDate !== undefined && slot.firstDate !== null) ||
  (slot.lastDate !== undefined && slot.lastDate !== null);

/**
 * Core `resolveDateModel` (`practiceMetrics.js`): every slot carries
 * `firstDate`, `lastDate`, `startTime` and `endTime`, or none carries a date;
 * a mix throws. The rule is `datedSlotsIssue` (`schemas/scoring.ts`), which
 * `fairness-scoring` answers with a 422 first, so a throw here is a caller bug.
 */
function resolveDateModel(slots: Slot[]): Map<string, SlotDating> | null {
  const issue = datedSlotsIssue(slots);
  if (issue !== null) throw new TypeError(issue);
  if (!slots.some(isDatedSlot)) return null;
  const datings = new Map<string, SlotDating>();
  for (const slot of slots) {
    // Two entries sharing an id are one slot, the last one standing, as `slotsById` reads them.
    datings.set(slot.id, {
      firstDay: calendarDayNumber(slot.firstDate) as number,
      lastDay: calendarDayNumber(slot.lastDate) as number,
      startSec: wallSeconds(slot.startTime) as number,
      endSec: wallSeconds(slot.endTime) as number,
    });
  }
  return datings;
}

/**
 * Core Logic for evaluating Practice Schedules
 *
 * **Dated or undated (M4.7, `docs/PLAN_SCORING_DATE_MODEL.md`)**, exactly as
 * core's `evaluatePracticeSchedule`: with every slot dated, two assignments
 * clash only on a shared live date with overlapping wall windows, and a slot's
 * `assignedCount` is its busiest date (rows as `assignmentRows`); with none,
 * first-occurrence instants and row counts, unchanged. `summary.dateModel`
 * says which ran. The auto-scheduler's own scoring is dated since M4.8, from
 * the store's slot dating (`auto-scheduler-solver.ts` `scoreSchedule`, Q1).
 *
 * **Saved practice exceptions (the M4.7 follow-up, plan Q1)**, exactly as
 * core: a dated call may pass `exceptions` (`practice_exceptions` rows as
 * stored), applied through the calendar's `applyPracticeExceptions` twin. A
 * `relocated` date is compared and counted at its new slot; a `time_tbd` date
 * is in neither comparison and comes back in `timeTbd` and as a `time-tbd`
 * warning issue. An exception the helper could not apply is a `data-quality`
 * issue. An undated call refuses a non-empty `exceptions`
 * (`undatedExceptionsIssue`, which `fairness-scoring` answers with a 422).
 */
export function evaluatePracticeSchedule(params: {
  assignments: PracticeAssignment[];
  unassigned?: Array<{ teamId: string; reason: string }> | null;
  teams: Team[];
  slots: Slot[];
  exceptions?: PracticeException[];
}) {
  const { assignments, unassigned = [], teams, slots, exceptions } = params;

  const teamsById = new Map<string, Team>(teams.map((t) => [t.id, t]));
  const slotsById = new Map<string, Slot>(slots.map((s) => [s.id, s]));
  const datings = resolveDateModel(slots);
  const dateModel: 'dated' | 'undated' = datings ? 'dated' : 'undated';
  const exceptionsIssue = undatedExceptionsIssue(slots, exceptions);
  if (exceptionsIssue !== null) throw new TypeError(exceptionsIssue);

  // **One resolution pass, which is core's contract rather than a fourth one.**
  // This function used to decide what an assignment row was worth in three
  // different places: the summary counted every row (`assignments.length`),
  // `slotUtilization` counted every row naming the slot with no resolution at
  // all, and the coach loop alone dropped rows whose team or slot was unknown.
  // `practiceMetrics.js:345-373` makes that decision once -- unknown team,
  // unknown slot and duplicate `team::slot` are each dropped, then everything
  // downstream reads what survived -- and that is adopted here.
  //
  // Each of the three disagreed with core in a way the cross-arm check
  // (`tests/scoringEngineDrift.test.js`) now pins:
  //   * `assignedTeams = assignments.length` counted a team holding two slots
  //     twice. That is a supported case, not a malformed one -- core has a test
  //     named "correctly counts teams assigned to multiple slots" -- so ten
  //     teams with twelve assignments published `unassignedTeams: -2` and
  //     `coveragePercent: 120`.
  //
  //     **Reachable through `fairness-scoring`, not through the hill-climber.**
  //     `fairness-scoring/index.ts` passes the request's `practice.assignments`
  //     straight through, so a payload with two rows for one team lands here
  //     and `practice_coverage` is persisted over 100 against a min-90
  //     threshold. `auto-scheduler` cannot reach it: `buildState` keeps
  //     assignments in an `assignmentMap: Map<teamId, slotId>`, so a team can
  //     never hold two slots there. Stated precisely because an earlier draft
  //     of this comment blamed the optimizer and would have sent the next
  //     reader hunting a bug that is not there.
  //   * `slotUtilization` counted a duplicate row twice and an unknown team's
  //     row at all, reporting a slot as fuller than core does.
  //   * the coach loop read duplicates as two distinct practices, so a repeated
  //     `team::slot` row raised a phantom conflict between a team and itself.
  //
  // **Dropping is reported, not just done.** Core pushes a line into
  // `dataQualityWarnings` for each row it discards; this arm has no such field,
  // so the equivalent goes into `issues[]`, which is its only output channel.
  // Filtering without reporting would trade one silent wrong number for a
  // silent missing one -- before this pass, a row naming an unknown slot at
  // least inflated `slotUtilization` visibly.
  type Span = { first: number; last: number };
  const resolvedAssignments: Array<{
    teamId: string;
    slotId: string;
    team: Team;
    slot: Slot;
    span: Span | null;
    row: number;
    id: unknown;
    range: unknown;
  }> = [];
  const seenAssignments = new Set<string>();
  // Core's dated duplicate rule: a team may hold one slot in two series
  // (the table's key is team, slot, range); a duplicate is the same range or
  // one sharing a live date with a kept series.
  const seriesByKey = new Map<string, Array<{ range: string; span: Span | null }>>();
  const dataQualityMessages: string[] = [];
  for (const a of assignments) {
    const team = teamsById.get(a.teamId);
    const slot = slotsById.get(a.slotId);
    if (!team) {
      dataQualityMessages.push(`assignment references unknown team ${a.teamId}`);
      continue;
    }
    if (!slot) {
      dataQualityMessages.push(`assignment references unknown slot ${a.slotId}`);
      continue;
    }
    // Core's order: an unreadable range is dropped and reported before the
    // duplicate check; a readable one with no live date is kept and reported.
    const dating = datings?.get(slot.id) ?? null;
    const span = dating
      ? assignmentLiveSpan({
          firstDay: dating.firstDay,
          lastDay: dating.lastDay,
          range: a.effectiveDateRange,
        })
      : null;
    if (span?.status === LIVE_SPAN_STATUS.UNREADABLE) {
      dataQualityMessages.push(
        `assignment for team ${a.teamId} to slot ${a.slotId} has an unreadable date range ${String(a.effectiveDateRange)}`
      );
      continue;
    }
    const key = `${a.teamId}::${a.slotId}`;
    if (span) {
      const range = String(a.effectiveDateRange ?? '');
      const kept = seriesByKey.get(key) ?? [];
      const duplicate = kept.some(
        (series) =>
          series.range === range ||
          (series.span !== null &&
            span.status === LIVE_SPAN_STATUS.LIVE &&
            sharedLiveDates(series.span, span).count > 0)
      );
      if (duplicate) {
        dataQualityMessages.push(`duplicate assignment for team ${a.teamId} to slot ${a.slotId}`);
        continue;
      }
      kept.push({
        range,
        span: span.status === LIVE_SPAN_STATUS.LIVE ? { first: span.first, last: span.last } : null,
      });
      seriesByKey.set(key, kept);
    } else {
      if (seenAssignments.has(key)) {
        dataQualityMessages.push(`duplicate assignment for team ${a.teamId} to slot ${a.slotId}`);
        continue;
      }
      seenAssignments.add(key);
    }
    if (span?.status === LIVE_SPAN_STATUS.NONE) {
      dataQualityMessages.push(
        `assignment for team ${a.teamId} has no date inside slot ${a.slotId}'s validity`
      );
    }
    resolvedAssignments.push({
      teamId: a.teamId,
      slotId: a.slotId,
      team,
      slot,
      span: span?.status === LIVE_SPAN_STATUS.LIVE ? { first: span.first, last: span.last } : null,
      row: resolvedAssignments.length,
      id: a.id ?? null,
      range: a.effectiveDateRange,
    });
  }

  // Saved exceptions (plan Q1), core's pass: each row they touch holds
  // explicit dates per slot (its pieces); TIME TBD dates are held nowhere.
  const applied =
    datings && exceptions !== undefined && exceptions.length > 0
      ? applyExceptionsToLiveRows({
          rows: resolvedAssignments.map(
            (a): LiveRow => ({
              id: a.id,
              teamId: a.teamId,
              slotId: a.slotId,
              firstDay: (datings.get(a.slotId) as SlotDating).firstDay,
              lastDay: (datings.get(a.slotId) as SlotDating).lastDay,
              range: a.range,
              span: a.span,
            })
          ),
          exceptions,
          slotFirstDays: new Map([...datings].map(([id, d]) => [id, d.firstDay])),
        })
      : null;
  const piecesOfRow = (row: number) => applied?.pieces[row] ?? null;
  for (const finding of applied?.findings ?? []) {
    dataQualityMessages.push(
      `practice exception ${String(finding.exceptionId)} on assignment ${String(finding.assignmentId)}${finding.date ? ` (${finding.date})` : ''}: ${finding.code}`
    );
  }
  const piecesBySlot = new Map<string, Piece[]>();
  resolvedAssignments.forEach((a) => {
    const pieces = piecesOfRow(a.row);
    const held: Array<{ slotId: string; span?: Span; days?: number[] }> = pieces ?? spanPiece(a);
    for (const piece of held) {
      const list = piecesBySlot.get(piece.slotId) ?? [];
      list.push(piece.days ? { days: piece.days } : { span: piece.span });
      piecesBySlot.set(piece.slotId, list);
    }
  });

  const totalTeams = teams.length;
  const assignedTeams = new Set(resolvedAssignments.map((a) => a.teamId)).size;
  const unassignedTeams = totalTeams - assignedTeams;

  const issues: Issue[] = [];

  for (const message of dataQualityMessages) {
    issues.push({ category: 'data-quality', severity: 'warning', message });
  }

  // 1. Summary Metrics
  //
  // **An empty roster is fully covered, not uncovered.** `totalTeams === 0`
  // used to yield `assignmentRate: 0` and `coveragePercent: 0`, which tripped
  // the "Low practice assignment coverage: 0.0%" error below and returned
  // `status: 'action-required'` for an organisation that has nothing to
  // schedule -- and `fairness-scoring` persisted `practice_coverage: 0`
  // against a min-90 threshold. Core answers the vacuous case with
  // `assignmentRate = 1` (`practiceMetrics.js:622`); that contract is adopted
  // here rather than a second answer to the same question.
  const summary = {
    totalTeams,
    assignedTeams,
    unassignedTeams,
    assignmentRate: totalTeams > 0 ? assignedTeams / totalTeams : 1,
    coveragePercent: totalTeams > 0 ? (assignedTeams / totalTeams) * 100 : 100,
  };

  if (summary.coveragePercent < 90) {
    issues.push({
      category: 'coverage',
      severity: summary.coveragePercent < 75 ? 'error' : 'warning',
      message: `Low practice assignment coverage: ${summary.coveragePercent.toFixed(1)}%`,
    });
  }

  // 2. Slot Utilization
  //
  // Iterated over `slotsById.values()`, not `slots`: two entries sharing an id
  // are one slot, which is what core's `slotsById` map already made them. From
  // `slots` this arm published a row per entry and core published one, so the
  // two disagreed on how many slots exist before they could disagree on any
  // number in them.
  const slotUtilization = [...slotsById.values()].map((slot) => {
    const rowsInSlot = resolvedAssignments.filter((a) => a.slotId === slot.id);
    const assignmentRows = rowsInSlot.length;
    // Dated: the busiest date's load (plan Q4), a relocated date at its new
    // slot and a TIME TBD date nowhere. Undated: every row.
    const assignedInSlot = datings
      ? peakPieceCount(piecesBySlot.get(slot.id) ?? [])
      : assignmentRows;
    const utilization = slot.capacity > 0 ? assignedInSlot / slot.capacity : null;

    if (utilization && utilization > 1.0) {
      issues.push({
        category: 'utilization',
        severity: 'error',
        message: datings
          ? `Slot ${slot.id} is overbooked on its busiest date (${assignedInSlot}/${slot.capacity})`
          : `Slot ${slot.id} is overbooked (${assignedInSlot}/${slot.capacity})`,
        details: {
          slotId: slot.id,
          assignedCount: assignedInSlot,
          ...(datings ? { assignmentRows } : {}),
          capacity: slot.capacity,
        } as Record<string, unknown>,
      });
    }

    return {
      slotId: slot.id,
      assignedCount: assignedInSlot,
      ...(datings ? { assignmentRows } : {}),
      capacity: slot.capacity,
      utilization,
      overbooked: assignedInSlot > slot.capacity,
    };
  });

  // 3. Coach Load & Conflicts
  // One entry per overlapping pair of assignments; `coachIds` lists every coach the pair shares
  // (head plus assistants). Mirrors packages/core/src/practiceMetrics.js: each coach's assignments
  // are sorted, every overlapping pair is visited, and the same pair merges across coaches.
  const coachConflicts: Array<{
    coachId: string;
    coachIds: string[];
    teams: Array<{ teamId: string; slotId: string }>;
    reason: string;
    day: string;
    firstDate?: string;
    sharedDates?: number;
  }> = [];
  const conflictsByPair = new Map<string, (typeof coachConflicts)[number]>();
  const coachSchedules = new Map<
    string,
    Array<{
      teamId: string;
      slotId: string;
      start: Date;
      end: Date;
      day: string;
      dating: SlotDating | null;
      span: Span | null;
      row: number;
    }>
  >();
  // Core's dated merge: the dates each pair of ROWS shares, summed per placement pair.
  const datesByPair = new Map<string, Map<string, { count: number; firstDate: string | null }>>();

  resolvedAssignments.forEach(({ team, slot, span, row, teamId, slotId }) => {
    const a = { teamId, slotId };
    const start = new Date(slot.start);
    const end = new Date(slot.end);
    // `slot.day ?? 'unknown'`, which is what `practiceMetrics.js:582` does.
    //
    // This used to be
    // `slot.day || start.toLocaleDateString('en-US', { weekday: 'long' })` --
    // a weekday derived from a **host-zone** reading of the instant. Executed:
    // a 9pm Saturday New York practice reads back as Sunday on a UTC host,
    // which is the Supabase edge default, so the conflict a coach was shown
    // named the wrong day. That made three contracts for one field: the page
    // sends a day, core reads `slot.day ?? …` and never derives, and this
    // derived a different one whenever the page's was absent.
    //
    // Deriving it correctly is not the fix either -- it would be a fourth
    // contract, and the season's clock is not this function's to know. The
    // caller that has a weekday sends it; a caller that does not gets
    // 'unknown', visibly, in the conflict message.
    const day = slot.day ?? 'unknown';

    // Recomputed from the validated fields on every call: a request-supplied `coachIds` key
    // would otherwise pass through the schema and override the conflict set.
    for (const coachId of listTeamCoachIds(team)) {
      if (!coachSchedules.has(coachId)) coachSchedules.set(coachId, []);
      coachSchedules.get(coachId)!.push({
        teamId: a.teamId,
        slotId: a.slotId,
        start,
        end,
        day,
        dating: datings?.get(slot.id) ?? null,
        span,
        row,
      });
    }
  });

  for (const [coachId, schedule] of coachSchedules) {
    const sorted = [...schedule].sort(
      (x, y) => x.start.getTime() - y.start.getTime() || x.slotId.localeCompare(y.slotId)
    );
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const current = sorted[i];
      for (let j = i + 1; j < sorted.length; j += 1) {
        const candidate = sorted[j];
        let shared: { count: number; firstDate: string | null } | null = null;
        if (datings) {
          // Core's dated rule: every pair, a shared live date, overlapping wall windows.
          const currentPieces = piecesOfRow(current.row);
          const candidatePieces = piecesOfRow(candidate.row);
          if (currentPieces === null && candidatePieces === null) {
            if (!current.span || !candidate.span || !current.dating || !candidate.dating) continue;
            const windowsOverlap =
              current.dating.startSec < candidate.dating.endSec &&
              candidate.dating.startSec < current.dating.endSec;
            if (!windowsOverlap) continue;
            shared = sharedLiveDates(current.span, candidate.span);
          } else {
            // Core's `sharedHeldDates`: each piece on its own slot's wall window.
            shared = sharedHeldDates(
              currentPieces ?? spanPiece(current),
              candidatePieces ?? spanPiece(candidate),
              (slotId) => datings.get(slotId) as SlotDating
            );
          }
          if (shared.count === 0) continue;
        } else if (candidate.start >= current.end) {
          break;
        }
        const pairKey = conflictPairKey(current, candidate);
        if (shared) {
          const rows = datesByPair.get(pairKey) ?? new Map();
          rows.set(
            `${Math.min(current.row, candidate.row)}|${Math.max(current.row, candidate.row)}`,
            shared
          );
          datesByPair.set(pairKey, rows);
        }
        const existing = conflictsByPair.get(pairKey);
        if (existing) {
          if (!shared || !existing.coachIds.includes(coachId)) existing.coachIds.push(coachId);
          continue;
        }
        const entry = {
          coachId,
          coachIds: [coachId],
          teams: [
            { teamId: current.teamId, slotId: current.slotId },
            { teamId: candidate.teamId, slotId: candidate.slotId },
          ],
          reason: '', // finalised below, once every coach the pair shares is known
          day: current.day,
          ...(shared ? { firstDate: shared.firstDate as string, sharedDates: shared.count } : {}),
        };
        conflictsByPair.set(pairKey, entry);
        coachConflicts.push(entry);
      }
    }
  }

  for (const [pairKey, rows] of datesByPair) {
    const conflict = conflictsByPair.get(pairKey)!;
    const all = [...rows.values()];
    conflict.firstDate = all.map((d) => d.firstDate as string).sort()[0];
    conflict.sharedDates = all.reduce((sum, d) => sum + d.count, 0);
  }

  // Reason and issue are built once the pair is fully merged, so each names every coach it shares.
  for (const conflict of coachConflicts) {
    const label =
      conflict.coachIds.length > 1
        ? `Coaches ${conflict.coachIds.join(', ')} have`
        : `Coach ${conflict.coachIds[0]} has`;
    // Dated runs name the first clashing date and how many there are (plan Q7).
    conflict.reason =
      conflict.firstDate !== undefined
        ? `${label} overlapping practices on ${conflict.day}, from ${conflict.firstDate} (${conflict.sharedDates} date(s))`
        : `${label} overlapping practices on ${conflict.day}`;
    issues.push({
      category: 'coach-conflict',
      severity: 'error',
      message: conflict.reason,
      details: {
        coachId: conflict.coachId,
        coachIds: conflict.coachIds,
        day: conflict.day,
        ...(conflict.firstDate !== undefined
          ? { firstDate: conflict.firstDate, sharedDates: conflict.sharedDates }
          : {}),
      } as Record<string, unknown>,
    });
  }

  // Every TIME TBD date, with its row and reason (core's `timeTbd`): out of
  // both comparisons above, and a warning here so it is never silent.
  const timeTbd = applied
    ? applied.timeTbd.map(({ row, exceptionId, code, dates }) => ({
        teamId: resolvedAssignments[row].teamId,
        slotId: resolvedAssignments[row].slotId,
        exceptionId,
        code,
        dates,
      }))
    : exceptions !== undefined && datings
      ? []
      : undefined;
  for (const entry of timeTbd ?? []) {
    issues.push({
      category: 'time-tbd',
      severity: 'warning',
      message:
        entry.dates.length > 0
          ? `Practice for team ${entry.teamId} at slot ${entry.slotId} is TIME TBD on ${entry.dates.length} date(s) from ${entry.dates[0]} (${entry.code})`
          : `Practice for team ${entry.teamId} at slot ${entry.slotId} is TIME TBD with no date (${entry.code})`,
      details: { ...entry } as Record<string, unknown>,
    });
  }

  // Fairness Score Calculation
  const conflictPenalty = coachConflicts.length * 0.15;
  const coveragePenalty = (1 - summary.assignmentRate) * 0.5;
  const fairnessScore = Math.max(0, 1 - (conflictPenalty + coveragePenalty));

  // Determine Status
  const status: EvaluationStatus = issues.some((i) => i.severity === 'error')
    ? 'action-required'
    : issues.some((i) => i.severity === 'warning')
      ? 'attention-needed'
      : 'ok';

  return {
    status,
    issues,
    summary: { ...summary, fairnessScore, dateModel },
    slotUtilization,
    coachConflicts,
    ...(timeTbd !== undefined ? { timeTbd } : {}),
    manualFollowUpResults: (unassigned || []).map((u) => ({
      ...u,
      category: categorizeManualFollowUpReason(u.reason),
    })),
  };
}

interface TimedGameAssignment extends GameAssignment {
  start: Date;
  end: Date;
  /**
   * One fixture's identity (core `gameMetrics.js`'s `assignmentKey`): a coach
   * on both sides of one game holds two entries carrying the same key, which
   * are one commitment, never a clash. Set on coach entries only.
   */
  sourceKey?: string;
}

/** The message of the Edge's unknown-team warning; `tests/fixtures/gameScoringProjection.js` reads it. */
export const GAME_UNKNOWN_TEAM_MESSAGE = 'game references unknown team';

/**
 * Core Logic for evaluating Game Schedules
 *
 * **Core's contract, adopted (#576 follow-up, `docs/PLAN_GAME_EVALUATOR_UNKNOWN_TEAM.md`).**
 * Core `evaluateGameSchedule` (`packages/core/src/gameMetrics.js`) is the
 * sibling that already settles each of these, so this arm follows it rather
 * than inventing a third answer:
 *
 * - **A side the roster does not carry is reported**, once per team id in
 *   schedule order, as a `data-quality` warning -- the shape this file's
 *   practice evaluator gives an unknown team. It used to be dropped without a
 *   word, so a roster matching no game scored `ok` and a team renamed between
 *   roster and schedule played nothing, invisibly. The game still counts in
 *   `totalAssignments` and its known side is still checked.
 * - **Coverage is from the roster**: `teamsRostered`, `teamsScheduled` and
 *   `teamsReferencedUnknown`, counted as core counts them, and
 *   `coveragePercent = round(100 x teamsScheduled / teamsRostered, 2)`. It
 *   used to be 100 whenever there was a game ("Simplified").
 * - **A schedule that names no rostered team examined nothing** and is an
 *   `error` issue, so a direct caller is never told `ok`; `fairness-scoring`
 *   refuses it first (422 `GAME_ROSTER_UNMATCHED`).
 * - **Every coach on a team** is conflict-checked (`listTeamCoachIds`, 8.2),
 *   not the head coach alone.
 * - **The two entries of one fixture are one commitment** (core's
 *   `sourceKey`): a coach on both sides of a game is in one place.
 *
 * Declared, not enforced: core's `field-overlap` check has no twin here (the
 * game input carries no field model this arm reads); a clash through an
 * unknown team cannot be seen by either arm, and the unknown-team warning is
 * the signal. `tests/scoringEngineDrift.test.js` holds both arms to
 * `game-scoring-vectors.json`, and the parity tests to the season-2026 games.
 */
export function evaluateGameSchedule(params: { assignments: GameAssignment[]; teams: Team[] }) {
  const { assignments, teams } = params;
  const teamsById = new Map<string, Team>(teams.map((t) => [t.id, t]));

  const issues: Issue[] = [];
  const summary = {
    totalAssignments: assignments.length,
    teamsRostered: teamsById.size,
    teamsScheduled: 0,
    teamsReferencedUnknown: 0,
    coveragePercent: 0,
    divisionGameDistribution: {} as Record<string, number>,
  };

  const teamAssignments = new Map<string, TimedGameAssignment[]>();
  const coachAssignments = new Map<string, TimedGameAssignment[]>();
  const seenUnknownTeams = new Set<string>();

  assignments.forEach((a) => {
    summary.divisionGameDistribution[a.division] =
      (summary.divisionGameDistribution[a.division] ?? 0) + 1;

    const start = new Date(a.start);
    const end = new Date(a.end);
    const slotId = (a as { slotId?: unknown }).slotId;
    // Core's `assignmentKey`, spelled the same way.
    const sourceKey = String(
      (a as { id?: unknown }).id ?? `${String(slotId)}|${String(a.start)}|${a.homeTeamId}`
    );

    const participants = [
      { teamId: a.homeTeamId, role: 'home' },
      { teamId: a.awayTeamId, role: 'away' },
    ];

    participants.forEach(({ teamId }) => {
      const team = teamsById.get(teamId);
      if (!team) {
        if (!seenUnknownTeams.has(teamId)) {
          seenUnknownTeams.add(teamId);
          issues.push({
            category: 'data-quality',
            severity: 'warning',
            message: `${GAME_UNKNOWN_TEAM_MESSAGE} ${teamId}`,
            details: { teamId, weekIndex: a.weekIndex, slotId: slotId ?? null },
          });
        }
        return;
      }

      if (!teamAssignments.has(teamId)) teamAssignments.set(teamId, []);
      // `sourceKey` set to nothing: a team's own entries are never one
      // commitment (a client-sent `sourceKey` passes the schema's
      // passthrough, and must not hide a team double-booked).
      teamAssignments.get(teamId)!.push({ ...a, start, end, sourceKey: undefined });

      // Every coach on the team (8.2), through the producer the practice
      // evaluator above already uses.
      for (const coachId of listTeamCoachIds(team)) {
        if (!coachAssignments.has(coachId)) coachAssignments.set(coachId, []);
        coachAssignments.get(coachId)!.push({ ...a, start, end, sourceKey });
      }
    });
  });

  summary.teamsScheduled = teamAssignments.size;
  summary.teamsReferencedUnknown = seenUnknownTeams.size;
  summary.coveragePercent =
    summary.teamsRostered > 0
      ? Math.round((10000 * summary.teamsScheduled) / summary.teamsRostered) / 100
      : 0;

  if (assignments.length > 0 && summary.teamsScheduled === 0) {
    issues.push({
      category: 'coverage',
      severity: 'error',
      message:
        `No game names a rostered team: ${assignments.length} game(s) against ` +
        `${summary.teamsRostered} rostered team(s), so nothing was examined`,
      details: {
        totalAssignments: assignments.length,
        teamsRostered: summary.teamsRostered,
        teamsReferencedUnknown: summary.teamsReferencedUnknown,
      },
    });
  }

  const detectConflicts = (
    map: Map<string, TimedGameAssignment[]>,
    type: string,
    severity: Severity
  ) => {
    map.forEach((events, id) => {
      // Core's order: by start, then slot, so one fixture's two entries sit
      // side by side.
      events.sort(
        (a, b) =>
          a.start.getTime() - b.start.getTime() ||
          String((a as { slotId?: unknown }).slotId ?? '').localeCompare(
            String((b as { slotId?: unknown }).slotId ?? '')
          )
      );
      for (let i = 1; i < events.length; i++) {
        const prev = events[i - 1];
        const curr = events[i];
        // One fixture is one commitment, not a clash (core's `sourceKey`).
        if (prev.sourceKey !== undefined && prev.sourceKey === curr.sourceKey) continue;
        if (curr.start < prev.end) {
          issues.push({
            category: type,
            severity,
            message: `${type.replace('-', ' ')} conflict for ${id}`,
            details: {
              id,
              events: [
                prev as unknown as Record<string, unknown>,
                curr as unknown as Record<string, unknown>,
              ],
            },
          });
        }
      }
    });
  };

  detectConflicts(teamAssignments, 'team-double-booked', 'error');
  detectConflicts(coachAssignments, 'coach-game-conflict', 'error');

  const status: EvaluationStatus = issues.some((i) => i.severity === 'error')
    ? 'action-required'
    : issues.some((i) => i.severity === 'warning')
      ? 'attention-needed'
      : 'ok';

  return {
    status,
    issues,
    summary,
  };
}
