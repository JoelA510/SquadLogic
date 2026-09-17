/**
 * Game schedule metrics.
 *
 * ## 8.2, part 1: the coach conflict check sees every coach
 *
 * It used to see `team.coachId` and nothing else, with a comment saying so and
 * naming this task. `listTeamCoachIds()` is the producer 8.1 introduced for the
 * practice side; the game side now uses the same one, so a person who is a
 * team's second coach and a different team's first can no longer be booked into
 * two games at once without a warning. In the season-2026 corpus that is 83
 * co-coach assignments across 82 multi-coach teams that the check could not see.
 *
 * One warning is emitted **per coach**, not per pair, which is the contract
 * this function already had for teams and fields; `practiceMetrics.js` merges by
 * pair because its own optimiser charges the pair once. The two are different
 * on purpose and both say which they are.
 *
 * ## 8.2, part 2: every count names its unit
 *
 * {@link GAME_METRICS_COUNT_UNITS} labels every number this module publishes,
 * and {@link import('./counts.js').assertCountsLabelled} refuses to return a
 * report carrying one it does not cover. "132" is not an answer; "132 rostered
 * teams" is, and it is a different number from the 131 with a game and the 140
 * sides the schedule names.
 *
 * @module gameMetrics
 */

function incrementKey(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

/**
 * @typedef {import('./types.js').Team} Team
 * @typedef {import('./types.js').GameScheduleParams} GameScheduleParams
 */

/**
 * What every number this module publishes is a number **of**.
 *
 * Patterns are dot paths through the returned report; `*` is any object key and
 * `[]` an array element. {@link assertCountsLabelled} runs this table over the
 * finished report and refuses to return one carrying a number the table does
 * not cover, so a count added later cannot ship without a unit.
 *
 * The three team counts are the point of the exercise. `teamsRostered` is the
 * teams handed in, `teamsScheduled` the ones a game actually names, and
 * `teamsReferencedUnknown` the sides a game names that the roster does not
 * carry. In the season-2026 corpus those are 132, 131 and — for a run given the
 * whole schedule — the 9 further sides `combined_schedule.csv` names, which is
 * how 140 and 132 are both true at once. One number called `totalTeams` could
 * only ever have been one of them.
 *
 * @type {Readonly<Record<string, Object>>}
 */
export const GAME_METRICS_COUNT_UNITS = buildCountUnitRegistry({
  'summary.teamsRostered': 'ROSTERED_TEAM',
  'summary.teamsScheduled': 'SCHEDULABLE_ENTITY',
  'summary.teamsReferencedUnknown': 'SCHEDULABLE_ENTITY',
  'summary.totalAssignments': 'GAME',
  'summary.assignmentsByDivision.*.games': 'GAME',
  'summary.fieldUsage.*.games': 'GAME',
  'summary.teamsWithByes.*': 'BYE',
  'summary.unscheduledByReason.*': 'UNSCHEDULED_MATCHUP',
  'summary.unscheduledByDivision.*': 'UNSCHEDULED_MATCHUP',
  'summary.teamGameLoad.*.totalGames': 'GAME',
  'summary.teamGameLoad.*.homeGames': 'GAME',
  'summary.teamGameLoad.*.awayGames': 'GAME',
  'summary.teamGameLoad.*.weeksScheduled.[]': 'WEEK_INDEX',
  'summary.sharedSlotUsage.[].weekIndex': 'WEEK_INDEX',
  'summary.sharedSlotUsage.[].totalAssignments': 'GAME',
  'summary.sharedSlotUsage.[].divisionUsage.[].count': 'GAME',
  'summary.sharedFieldDistribution.*.*': 'GAME',
  'warnings.[].details.weekIndex': 'WEEK_INDEX',
  'warnings.[].details.spread': 'GAME',
  'warnings.[].details.breakdown.*': 'UNSCHEDULED_MATCHUP',
  'warnings.[].details.divisionBreakdown.*': 'UNSCHEDULED_MATCHUP',
  'warnings.[].details.distribution.[].count': 'GAME',
  'warnings.[].details.conflicts.[].weekIndex': 'WEEK_INDEX',
});

/**
 * Evaluate a set of scheduled games for quality, resource utilization, and potential conflicts.
 *
 * @param {GameScheduleParams} params
 * @returns {{ summary: Object, warnings: Array<Object> }} every number in it
 *   covered by {@link GAME_METRICS_COUNT_UNITS}
 */
export function evaluateGameSchedule({
  assignments,
  teams,
  byes = [],
  unscheduled = [],
  sharedSlotUsage = [],
}) {
  if (!Array.isArray(assignments)) {
    throw new TypeError('assignments must be an array');
  }
  if (!Array.isArray(teams)) {
    throw new TypeError('teams must be an array');
  }
  if (!Array.isArray(byes)) {
    throw new TypeError('byes must be an array');
  }
  if (!Array.isArray(unscheduled)) {
    throw new TypeError('unscheduled must be an array');
  }
  if (!Array.isArray(sharedSlotUsage)) {
    throw new TypeError('sharedSlotUsage must be an array');
  }

  const teamsById = new Map();
  for (const team of teams) {
    TeamSchema.parse(team);
    teamsById.set(team.id, {
      id: team.id,
      division: team.division ?? null,
      coachIds: listTeamCoachIds(team),
    });
  }

  const summary = {
    // Three team counts, because they are three different populations and one
    // of them called `totalTeams` was how "132" came to mean whatever the
    // reader assumed. See GAME_METRICS_COUNT_UNITS.
    teamsRostered: teamsById.size,
    teamsScheduled: 0,
    teamsReferencedUnknown: 0,
    totalAssignments: assignments.length,
    assignmentsByDivision: {},
    fieldUsage: {},
    teamsWithByes: {},
    unscheduledByReason: {},
    unscheduledByDivision: {},
    teamGameLoad: {},
    sharedSlotUsage: [],
    sharedFieldDistribution: {},
  };

  const warnings = [];
  const seenUnknownTeams = new Set();
  const teamAssignments = new Map();
  const coachAssignments = new Map();
  const fieldAssignments = new Map();
  const teamGameLoad = new Map();

  for (const assignment of assignments) {
    // Read, not discarded -- see the note in `schemas/index.js` (GAP-30).
    const parsed = AssignmentSchema.parse(assignment);

    const start = parsed.start;
    const end = parsed.end;
    const division = assignment.division;
    const weekIndex = assignment.weekIndex;
    const fieldKey = assignment.fieldId ?? 'unassigned';
    // One assignment's identity. Widening the coach check to every coach made a
    // person who coaches *both sides of one fixture* produce two entries at the
    // same time, which `detectConflicts()` would read as two overlapping games.
    // It is one game, so the two entries carry the same key and are not paired.
    const assignmentKey =
      assignment.id ?? `${assignment.slotId}|${assignment.start}|${assignment.homeTeamId}`;

    summary.assignmentsByDivision[division] = summary.assignmentsByDivision[division] ?? {
      games: 0,
      teams: new Set(),
    };
    const divisionSummary = summary.assignmentsByDivision[division];
    divisionSummary.games += 1;
    divisionSummary.teams.add(assignment.homeTeamId);
    divisionSummary.teams.add(assignment.awayTeamId);

    summary.fieldUsage[fieldKey] = summary.fieldUsage[fieldKey] ?? {
      games: 0,
      divisions: new Set(),
    };
    const fieldSummary = summary.fieldUsage[fieldKey];
    fieldSummary.games += 1;
    fieldSummary.divisions.add(division);

    const participants = [
      { teamId: assignment.homeTeamId, role: 'home' },
      { teamId: assignment.awayTeamId, role: 'away' },
    ];
    for (const participant of participants) {
      const { teamId, role } = participant;
      if (!teamsById.has(teamId)) {
        if (!seenUnknownTeams.has(teamId)) {
          warnings.push({
            type: 'unknown-team',
            message: `Scheduled game references unknown team ${teamId}`,
            details: { teamId, weekIndex, slotId: assignment.slotId },
          });
          seenUnknownTeams.add(teamId);
        }
        continue;
      }

      const bucket = teamAssignments.get(teamId) ?? [];
      bucket.push({
        teamId,
        start,
        end,
        weekIndex,
        slotId: assignment.slotId,
        division,
      });
      teamAssignments.set(teamId, bucket);

      const teamRecord = teamsById.get(teamId);
      trackTeamGameLoad({
        teamGameLoad,
        teamId,
        role,
        start,
        fieldKey,
        weekIndex,
      });
      // 8.2: every coach on the team, not just the one the legacy shape calls
      // the head. Same producer as the practice path, so the two cannot drift.
      for (const coachId of teamRecord.coachIds) {
        const coachBucket = coachAssignments.get(coachId) ?? [];
        coachBucket.push({
          coachId,
          teamId,
          start,
          end,
          weekIndex,
          slotId: assignment.slotId,
          division,
          sourceKey: assignmentKey,
        });
        coachAssignments.set(coachId, coachBucket);
      }
    }

    const fieldBucket = fieldAssignments.get(fieldKey) ?? [];
    fieldBucket.push({
      start,
      end,
      slotId: assignment.slotId,
      weekIndex,
      division,
      teams: [assignment.homeTeamId, assignment.awayTeamId],
    });
    fieldAssignments.set(fieldKey, fieldBucket);
  }

  for (const [_division, record] of Object.entries(summary.assignmentsByDivision)) {
    record.teams = Array.from(record.teams).sort((a, b) => a.localeCompare(b));
  }
  for (const [_fieldKey, record] of Object.entries(summary.fieldUsage)) {
    record.divisions = Array.from(record.divisions).sort((a, b) => a.localeCompare(b));
  }
  summary.teamGameLoad = formatTeamGameLoad(teamGameLoad);
  summary.teamsScheduled = teamAssignments.size;
  summary.teamsReferencedUnknown = seenUnknownTeams.size;

  for (const bye of byes) {
    validateBye(bye);
    const key = bye.division;
    summary.teamsWithByes[key] = (summary.teamsWithByes[key] ?? 0) + 1;
  }

  for (const entry of unscheduled) {
    validateUnscheduled(entry);
    incrementKey(summary.unscheduledByReason, entry.reason);
    incrementKey(summary.unscheduledByDivision, entry.division);
  }

  const { sharedSlotSummaries, sharedFieldDistribution, imbalanceWarnings } =
    analyzeSharedSlotUsage(sharedSlotUsage);
  summary.sharedSlotUsage = sharedSlotSummaries;
  summary.sharedFieldDistribution = sharedFieldDistribution;
  warnings.push(...imbalanceWarnings);

  detectConflicts({
    assignmentsMap: teamAssignments,
    warnings,
    idKey: 'teamId',
    warningType: 'team-double-booked',
    messageFn: (id) => `Team ${id} has overlapping games`,
  });
  detectConflicts({
    assignmentsMap: coachAssignments,
    warnings,
    idKey: 'coachId',
    warningType: 'coach-conflict',
    messageFn: (id) => `Coach ${id} has overlapping games across teams`,
  });
  detectConflicts({
    assignmentsMap: fieldAssignments,
    warnings,
    idKey: 'fieldId',
    warningType: 'field-overlap',
    messageFn: (id) => `Field ${id} has overlapping games`,
  });

  if (unscheduled.length > 0) {
    const total = unscheduled.length;
    const breakdownEntries = Object.entries(summary.unscheduledByReason).sort(
      ([reasonA], [reasonB]) => reasonA.localeCompare(reasonB)
    );
    const breakdownLabel = breakdownEntries
      .map(([reason, count]) => `${reason}: ${count}`)
      .join(', ');
    const message = `${total} matchup(s) could not be scheduled (${breakdownLabel}).`;
    warnings.push({
      type: 'unscheduled-matchups',
      message,
      details: {
        breakdown: summary.unscheduledByReason,
        divisionBreakdown: summary.unscheduledByDivision,
      },
    });
  }

  const report = { summary, warnings };
  assertCountsLabelled(report, GAME_METRICS_COUNT_UNITS, 'evaluateGameSchedule()');
  return report;
}

function analyzeSharedSlotUsage(sharedSlotUsage) {
  const sharedSlotSummaries = [];
  const sharedFieldDistribution = {};
  const fieldAggregation = new Map();
  const imbalanceWarnings = [];

  for (const entry of sharedSlotUsage) {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError('sharedSlotUsage entries must be objects');
    }
    if (!entry.slotId) {
      throw new TypeError('sharedSlotUsage entries require slotId');
    }
    if (!Array.isArray(entry.divisionUsage)) {
      throw new TypeError('sharedSlotUsage entries require divisionUsage arrays');
    }

    const divisionUsage = entry.divisionUsage.map((record) => {
      if (!record || typeof record !== 'object') {
        throw new TypeError('divisionUsage entries must be objects');
      }
      if (!record.division) {
        throw new TypeError('divisionUsage entries require division');
      }
      if (typeof record.count !== 'number') {
        throw new TypeError('divisionUsage entries require numeric count');
      }
      return { division: record.division, count: record.count };
    });

    divisionUsage.sort((a, b) => a.division.localeCompare(b.division));
    const totalAssignments =
      typeof entry.totalAssignments === 'number'
        ? entry.totalAssignments
        : divisionUsage.reduce((sum, record) => sum + record.count, 0);

    sharedSlotSummaries.push({
      slotId: entry.slotId,
      fieldId: entry.fieldId ?? null,
      weekIndex: typeof entry.weekIndex === 'number' ? entry.weekIndex : null,
      start: entry.start ?? null,
      end: entry.end ?? null,
      totalAssignments,
      divisionUsage,
    });

    const fieldKey = entry.fieldId ?? 'unassigned';
    const bucket = fieldAggregation.get(fieldKey) ?? new Map();
    for (const record of divisionUsage) {
      bucket.set(record.division, (bucket.get(record.division) ?? 0) + record.count);
    }
    fieldAggregation.set(fieldKey, bucket);
  }

  sharedSlotSummaries.sort((a, b) => a.slotId.localeCompare(b.slotId));

  for (const [fieldId, bucket] of fieldAggregation.entries()) {
    sharedFieldDistribution[fieldId] = Object.fromEntries(
      Array.from(bucket.entries()).sort((a, b) => a[0].localeCompare(b[0]))
    );
  }

  for (const summary of sharedSlotSummaries) {
    const fieldKey = summary.fieldId ?? 'unassigned';
    const bucket = fieldAggregation.get(fieldKey);
    if (!bucket || bucket.size <= 1) {
      continue;
    }

    const slotUsageMap = new Map(
      summary.divisionUsage.map((record) => [record.division, record.count])
    );
    const distribution = Array.from(bucket.keys())
      .sort((a, b) => a.localeCompare(b))
      .map((division) => ({ division, count: slotUsageMap.get(division) ?? 0 }));

    const counts = distribution.map((record) => record.count);
    const max = Math.max(...counts);
    const min = Math.min(...counts);
    if (max - min > 1) {
      imbalanceWarnings.push({
        type: 'shared-slot-imbalance',
        message: `Shared field ${fieldKey} is imbalanced across divisions`,
        details: {
          slotId: summary.slotId,
          fieldId: summary.fieldId ?? null,
          distribution,
          spread: max - min,
        },
      });
    }
  }

  return { sharedSlotSummaries, sharedFieldDistribution, imbalanceWarnings };
}

import { assertCountsLabelled, buildCountUnitRegistry } from './counts.js';
import { listTeamCoachIds } from './practiceScheduling.js';
import { AssignmentSchema, TeamSchema } from './schemas/index.js';

function validateBye(bye) {
  if (!bye || typeof bye !== 'object') {
    throw new TypeError('byes must contain objects');
  }
  if (typeof bye.weekIndex !== 'number' || bye.weekIndex <= 0) {
    throw new TypeError('bye.weekIndex must be a positive number');
  }
  if (!bye.division) {
    throw new TypeError('bye.division is required');
  }
  if (!bye.teamId) {
    throw new TypeError('bye.teamId is required');
  }
}

function validateUnscheduled(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new TypeError('unscheduled entries must be objects');
  }
  if (typeof entry.weekIndex !== 'number' || entry.weekIndex <= 0) {
    throw new TypeError('unscheduled entries require a positive weekIndex');
  }
  if (!entry.division) {
    throw new TypeError('unscheduled entries require a division');
  }
  if (!entry.reason) {
    throw new TypeError('unscheduled entries require a reason');
  }
}

function trackTeamGameLoad({ teamGameLoad, teamId, role, start, fieldKey, weekIndex }) {
  const record = teamGameLoad.get(teamId) ?? {
    totalGames: 0,
    homeGames: 0,
    awayGames: 0,
    uniqueFields: new Set(),
    weeks: new Set(),
    earliestStart: null,
    latestStart: null,
  };

  record.totalGames += 1;
  record[`${role}Games`] += 1;

  if (fieldKey && fieldKey !== 'unassigned') {
    record.uniqueFields.add(fieldKey);
  }
  record.weeks.add(weekIndex);
  if (!record.earliestStart || start < record.earliestStart) {
    record.earliestStart = start;
  }
  if (!record.latestStart || start > record.latestStart) {
    record.latestStart = start;
  }

  teamGameLoad.set(teamId, record);
}

function formatTeamGameLoad(teamGameLoad) {
  return Object.fromEntries(
    Array.from(teamGameLoad.entries()).map(([teamId, record]) => [
      teamId,
      {
        totalGames: record.totalGames,
        homeGames: record.homeGames,
        awayGames: record.awayGames,
        uniqueFields: Array.from(record.uniqueFields).sort((a, b) => a.localeCompare(b)),
        weeksScheduled: Array.from(record.weeks).sort((a, b) => a - b),
        earliestStart: record.earliestStart?.toISOString() ?? null,
        latestStart: record.latestStart?.toISOString() ?? null,
      },
    ])
  );
}

function detectConflicts({ assignmentsMap, warnings, idKey, warningType, messageFn }) {
  for (const [id, assignments] of assignmentsMap.entries()) {
    if (idKey === 'fieldId' && id === 'unassigned') {
      continue;
    }

    assignments.sort((a, b) => a.start - b.start || a.slotId.localeCompare(b.slotId));

    for (let i = 1; i < assignments.length; i += 1) {
      const prev = assignments[i - 1];
      const curr = assignments[i];

      // Two entries from the same fixture are one commitment, not a clash: a
      // person who coaches both sides is in one place at one time.
      if (
        prev.sourceKey !== undefined &&
        curr.sourceKey !== undefined &&
        prev.sourceKey === curr.sourceKey
      ) {
        continue;
      }

      if (curr.start < prev.end) {
        warnings.push({
          type: warningType,
          message: messageFn(id),
          details: {
            [idKey]: id,
            conflicts: [simplifyAssignment(prev), simplifyAssignment(curr)],
          },
        });
        break;
      }
    }
  }
}

function simplifyAssignment(assignment) {
  const base = {
    slotId: assignment.slotId,
    start: assignment.start.toISOString(),
    end: assignment.end.toISOString(),
    weekIndex: assignment.weekIndex,
    division: assignment.division,
    teamId: assignment.teamId ?? null,
  };

  if (Array.isArray(assignment.teams)) {
    base.teams = [...assignment.teams];
  }

  return base;
}
