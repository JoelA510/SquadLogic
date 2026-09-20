import type { Team, Slot, PracticeAssignment, GameAssignment } from '../schemas/scoring.ts';
import { conflictPairKey, listTeamCoachIds } from './practice-coaches.ts';

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

/**
 * Core Logic for evaluating Practice Schedules
 */
export function evaluatePracticeSchedule(params: {
  assignments: PracticeAssignment[];
  unassigned?: Array<{ teamId: string; reason: string }> | null;
  teams: Team[];
  slots: Slot[];
}) {
  const { assignments, unassigned = [], teams, slots } = params;

  const teamsById = new Map<string, Team>(teams.map((t) => [t.id, t]));
  const slotsById = new Map<string, Slot>(slots.map((s) => [s.id, s]));

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
  const resolvedAssignments: Array<{ teamId: string; slotId: string; team: Team; slot: Slot }> = [];
  const seenAssignments = new Set<string>();
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
    const key = `${a.teamId}::${a.slotId}`;
    if (seenAssignments.has(key)) {
      dataQualityMessages.push(`duplicate assignment for team ${a.teamId} to slot ${a.slotId}`);
      continue;
    }
    seenAssignments.add(key);
    resolvedAssignments.push({ teamId: a.teamId, slotId: a.slotId, team, slot });
  }

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
    const assignedInSlot = resolvedAssignments.filter((a) => a.slotId === slot.id).length;
    const utilization = slot.capacity > 0 ? assignedInSlot / slot.capacity : null;

    if (utilization && utilization > 1.0) {
      issues.push({
        category: 'utilization',
        severity: 'error',
        message: `Slot ${slot.id} is overbooked (${assignedInSlot}/${slot.capacity})`,
        details: {
          slotId: slot.id,
          assignedCount: assignedInSlot,
          capacity: slot.capacity,
        } as Record<string, unknown>,
      });
    }

    return {
      slotId: slot.id,
      assignedCount: assignedInSlot,
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
  }> = [];
  const conflictsByPair = new Map<string, (typeof coachConflicts)[number]>();
  const coachSchedules = new Map<
    string,
    Array<{ teamId: string; slotId: string; start: Date; end: Date; day: string }>
  >();

  resolvedAssignments.forEach(({ team, slot, ...a }) => {
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
      coachSchedules.get(coachId)!.push({ teamId: a.teamId, slotId: a.slotId, start, end, day });
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
        if (candidate.start >= current.end) break;
        const pairKey = conflictPairKey(current, candidate);
        const existing = conflictsByPair.get(pairKey);
        if (existing) {
          existing.coachIds.push(coachId);
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
        };
        conflictsByPair.set(pairKey, entry);
        coachConflicts.push(entry);
      }
    }
  }

  // Reason and issue are built once the pair is fully merged, so each names every coach it shares.
  for (const conflict of coachConflicts) {
    const label =
      conflict.coachIds.length > 1
        ? `Coaches ${conflict.coachIds.join(', ')} have`
        : `Coach ${conflict.coachIds[0]} has`;
    conflict.reason = `${label} overlapping practices on ${conflict.day}`;
    issues.push({
      category: 'coach-conflict',
      severity: 'error',
      message: conflict.reason,
      details: {
        coachId: conflict.coachId,
        coachIds: conflict.coachIds,
        day: conflict.day,
      } as Record<string, unknown>,
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
    summary: { ...summary, fairnessScore },
    slotUtilization,
    coachConflicts,
    manualFollowUpResults: (unassigned || []).map((u) => ({
      ...u,
      category: categorizeManualFollowUpReason(u.reason),
    })),
  };
}

interface TimedGameAssignment extends GameAssignment {
  start: Date;
  end: Date;
}

/**
 * Core Logic for evaluating Game Schedules
 */
export function evaluateGameSchedule(params: { assignments: GameAssignment[]; teams: Team[] }) {
  const { assignments, teams } = params;
  const teamsById = new Map<string, Team>(teams.map((t) => [t.id, t]));

  const issues: Issue[] = [];
  const summary = {
    totalAssignments: assignments.length,
    coveragePercent: assignments.length > 0 ? 100 : 0, // Simplified
    divisionGameDistribution: {} as Record<string, number>,
  };

  const teamAssignments = new Map<string, TimedGameAssignment[]>();
  const coachAssignments = new Map<string, TimedGameAssignment[]>();

  assignments.forEach((a) => {
    summary.divisionGameDistribution[a.division] =
      (summary.divisionGameDistribution[a.division] ?? 0) + 1;

    const start = new Date(a.start);
    const end = new Date(a.end);

    const participants = [
      { teamId: a.homeTeamId, role: 'home' },
      { teamId: a.awayTeamId, role: 'away' },
    ];

    participants.forEach(({ teamId }) => {
      const team = teamsById.get(teamId);
      if (!team) return;

      if (!teamAssignments.has(teamId)) teamAssignments.set(teamId, []);
      teamAssignments.get(teamId)!.push({ ...a, start, end });

      // Game coach conflicts remain head-coach-only pending 8.2 (games' coach model).
      if (team.coachId) {
        if (!coachAssignments.has(team.coachId)) coachAssignments.set(team.coachId, []);
        coachAssignments.get(team.coachId)!.push({ ...a, start, end });
      }
    });
  });

  const detectConflicts = (
    map: Map<string, TimedGameAssignment[]>,
    type: string,
    severity: Severity
  ) => {
    map.forEach((events, id) => {
      events.sort((a, b) => a.start.getTime() - b.start.getTime());
      for (let i = 1; i < events.length; i++) {
        if (events[i].start < events[i - 1].end) {
          issues.push({
            category: type,
            severity,
            message: `${type.replace('-', ' ')} conflict for ${id}`,
            details: {
              id,
              events: [
                events[i - 1] as unknown as Record<string, unknown>,
                events[i] as unknown as Record<string, unknown>,
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
