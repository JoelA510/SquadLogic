import { assertCountsLabelled, buildCountUnitRegistry } from './counts.js';
import { SlotSchema, TeamSchema } from './schemas/index.js';
import { listTeamCoachIds, resolveSchoolDayEndFilter } from './practiceScheduling.js';

/**
 * What every number this module publishes is a number **of**.
 *
 * A practice report counts three genuinely different things and used to spell
 * all of them "assigned": a **rostered team**, a **team holding a slot**, and a
 * **practice assignment** (one team in one slot — a team with two practices is
 * one team and two assignments). The season-2026 corpus has 132 rostered teams,
 * 88 of them holding a slot, across 457 practice rows, and no single number
 * called `totalTeams` could have been all three.
 *
 * The fourth slot-unit the corpus trades in — the **field-hour** — is
 * deliberately absent, and that is a stated bound rather than an oversight:
 * `SlotSchema` carries a capacity, a start and an end but no field, so this
 * module cannot say how much ground an assignment consumes. Anything that
 * claimed to would be counting slots and calling them field-hours.
 * `facility/` holds the ground; 8.3 is where the two meet.
 *
 * @type {Readonly<Record<string, Object>>}
 */
export const PRACTICE_METRICS_COUNT_UNITS = buildCountUnitRegistry({
  'summary.totalTeams': 'ROSTERED_TEAM',
  'summary.assignedTeams': 'TEAM_SLOT_UNIT',
  'summary.unassignedTeams': 'ROSTERED_TEAM',
  'summary.assignmentsRead': 'PRACTICE_ASSIGNMENT',
  'summary.assignmentsCounted': 'PRACTICE_ASSIGNMENT',
  'summary.assignmentRate': 'SHARE_OF_ONE',
  'summary.manualFollowUpRate': 'SHARE_OF_ONE',
  // Within one slot an assignment and a team are the same thing: the report
  // refuses a duplicate `team::slot` pair, so `assignedCount` is both.
  'slotUtilization.[].assignedCount': 'TEAM_SLOT_UNIT',
  'slotUtilization.[].capacity': 'TEAM_SLOT_UNIT',
  'slotUtilization.[].utilization': 'SHARE_OF_ONE',
  // A base slot aggregates several slots, so a team practising twice under one
  // base slot is one team and two assignments. Everything below `slotUtilization`
  // therefore counts **assignments**, and labelling them "teams holding a slot"
  // would reproduce the 88-vs-457 conflation this registry exists to end.
  'baseSlotDistribution.[].totalAssigned': 'PRACTICE_ASSIGNMENT',
  'baseSlotDistribution.[].totalCapacity': 'TEAM_SLOT_UNIT',
  'baseSlotDistribution.[].utilization': 'SHARE_OF_ONE',
  'baseSlotDistribution.[].divisionBreakdown.[].count': 'PRACTICE_ASSIGNMENT',
  'baseSlotDistribution.[].divisionBreakdown.[].percentage': 'SHARE_OF_ONE',
  'divisionDayDistribution.*.totalAssigned': 'PRACTICE_ASSIGNMENT',
  'divisionDayDistribution.*.averageStartMinutes': 'MINUTES_PAST_MIDNIGHT',
  'divisionDayDistribution.*.dayBreakdown.[].count': 'PRACTICE_ASSIGNMENT',
  'divisionDayDistribution.*.dayBreakdown.[].percentage': 'SHARE_OF_ONE',
  'divisionBaseSlotDistribution.*.totalAssigned': 'PRACTICE_ASSIGNMENT',
  'divisionBaseSlotDistribution.*.baseSlots.[].count': 'PRACTICE_ASSIGNMENT',
  'divisionBaseSlotDistribution.*.baseSlots.[].percentage': 'SHARE_OF_ONE',
  'dayConcentrationAlerts.[].dominantShare': 'SHARE_OF_ONE',
  'dayConcentrationAlerts.[].dominantCount': 'PRACTICE_ASSIGNMENT',
  'dayConcentrationAlerts.[].totalAssignments': 'PRACTICE_ASSIGNMENT',
  'coachLoad.*.assignedTeams': 'PRACTICE_ASSIGNMENT',
  'coachLoad.*.distinctDays': 'DAY',
  'fairnessConcerns.[].dominantShare': 'SHARE_OF_ONE',
  'fairnessConcerns.[].totalAssigned': 'PRACTICE_ASSIGNMENT',
  'fairnessConcerns.[].totalCapacity': 'TEAM_SLOT_UNIT',
  'underutilizedBaseSlots.[].totalAssigned': 'PRACTICE_ASSIGNMENT',
  'underutilizedBaseSlots.[].totalCapacity': 'TEAM_SLOT_UNIT',
  'underutilizedBaseSlots.[].utilization': 'SHARE_OF_ONE',
  'unassignedByReason.[].count': 'ROSTERED_TEAM',
  'unassignedByReason.[].divisionBreakdown.[].count': 'ROSTERED_TEAM',
  'unassignedByReason.[].divisionBreakdown.[].percentage': 'SHARE_OF_ONE',
  'manualFollowUpBreakdown.[].count': 'ROSTERED_TEAM',
  'manualFollowUpBreakdown.[].percentage': 'SHARE_OF_ONE',
});

/**
 * Key for one overlapping pair of assignments, the same whichever side is named first, so the
 * pair merges across coaches regardless of the order each coach's list produced it.
 *
 * @param {{ teamId: string, slotId: string }} a
 * @param {{ teamId: string, slotId: string }} b
 * @returns {string}
 */
export function conflictPairKey(a, b) {
  return [`${a.teamId}::${a.slotId}`, `${b.teamId}::${b.slotId}`].sort().join('|');
}

/**
 * Evaluate the quality of practice schedule assignments and emit metrics
 * used by the admin dashboard and regression tests.
 *
 * `coachConflicts` carries one entry per overlapping pair of assignments, so a pair of teams
 * sharing two coaches is one conflict, charged once by the optimizer's fitness and once as a
 * pipeline issue; `coachIds` lists every coach the pair shares and `coachId` the first of them —
 * first in iteration order, not a rank, and no coach on the list is the team's head (8.2).
 * `coachLoad` still counts each coach's own load.
 *
 * Every number the report publishes carries a unit through
 * {@link PRACTICE_METRICS_COUNT_UNITS}; `assignmentsRead` and `assignmentsCounted` differ by the
 * duplicate and unresolvable rows, exactly as `fairness/` separates `fixturesRead` from
 * `fixturesCounted`.
 *
 * @param {Object} params
 * @param {Array<{ teamId: string, slotId: string }>} params.assignments -
 *   Array of practice assignments linking teams to slots.
 * @param {Array<{ teamId: string, reason: string }>} [params.unassigned=[]] -
 *   Teams that could not be scheduled automatically.
 * @param {Array<{ id: string, division: string, coachId?: string | null, assistantCoachIds?: string[] | null }>} params.teams -
 *   Teams participating in the scheduling run. Each team must provide an `id` and `division`.
 * @param {Array<{ id: string, capacity: number, start: string | Date, end: string | Date, day?: string | null }>} params.slots -
 *   Slot catalogue with capacity and timing metadata.
 * @returns {{
 *   summary: {
 *     totalTeams: number,
 *     assignedTeams: number,
 *     unassignedTeams: number,
 *     assignmentsRead: number,
 *     assignmentsCounted: number,
 *     assignmentRate: number,
 *   },
 *   slotUtilization: Array<{
 *     slotId: string,
 *     assignedCount: number,
 *     capacity: number,
 *     utilization: number | null,
 *     overbooked: boolean,
 *   }>,
 *   baseSlotDistribution: Array<{
 *     baseSlotId: string,
 *     day: string | null,
 *     representativeStart: string | null,
 *     totalAssigned: number,
 *     totalCapacity: number,
 *     utilization: number | null,
 *     divisionBreakdown: Array<{ division: string, count: number, percentage: number }>,
 *   }>,
 *   divisionDayDistribution: Record<string, {
 *     totalAssigned: number,
 *     averageStartMinutes: number | null,
 *     dayBreakdown: Array<{ day: string, count: number, percentage: number }>,
 *   }>,
 *   divisionBaseSlotDistribution: Record<string, {
 *     totalAssigned: number,
 *     baseSlots: Array<{ baseSlotId: string, count: number, percentage: number }>,
 *   }>,
 *   coachLoad: Record<string, {
 *     assignedTeams: number,
 *     distinctDays: number,
 *   }>,
 *   coachConflicts: Array<{
 *     coachId: string,
 *     coachIds: Array<string>,
 *     teams: Array<{ teamId: string, slotId: string }>,
 *     reason: string,
 *   }>,
 *   dataQualityWarnings: Array<string>,
 * }}
 */
const FAIRNESS_DOMINANCE_THRESHOLD = 0.7;
const UNDERUTILIZATION_THRESHOLD = 0.25;
const DAY_CONCENTRATION_THRESHOLD = 0.65;
const MIN_ASSIGNMENTS_FOR_CONCENTRATION = 3;
export const MANUAL_FOLLOW_UP_ALERT_THRESHOLD = 0.05;

export const MANUAL_FOLLOW_UP_CATEGORIES = {
  CAPACITY: 'capacity',
  COACH_AVAILABILITY: 'coach-availability',
  EXCLUDED_SLOTS: 'excluded-slots',
  UNKNOWN: 'constraints-or-unknown',
};

const normalizeManualFollowUpReasonInput = (raw) => {
  if (typeof raw !== 'string') {
    return 'unspecified';
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : 'unspecified';
};

function categorizeManualFollowUpReason(rawReason) {
  const value = normalizeManualFollowUpReasonInput(rawReason).toLowerCase();

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

function calculateFairnessConcerns(baseSlotDistribution, assignmentsByDivision) {
  const assignedDivisions = new Set(assignmentsByDivision.keys());
  const fairnessConcerns = [];

  for (const entry of baseSlotDistribution) {
    if (entry.totalAssigned < 2 || entry.divisionBreakdown.length === 0) {
      continue;
    }

    const dominant = entry.divisionBreakdown[0];
    const dominantShare = Number((dominant.count / entry.totalAssigned).toFixed(4));
    const hasDiverseLeague = assignedDivisions.size > 1;
    const hasMultipleDivisionsInSlot = entry.divisionBreakdown.length > 1;

    if (dominantShare < FAIRNESS_DOMINANCE_THRESHOLD) {
      continue;
    }

    if (!hasDiverseLeague && !hasMultipleDivisionsInSlot) {
      continue;
    }

    const percentLabel = (dominantShare * 100).toFixed(1).replace(/\.0$/, '');
    fairnessConcerns.push({
      baseSlotId: entry.baseSlotId,
      day: entry.day,
      representativeStart: entry.representativeStart,
      dominantDivision: dominant.division,
      dominantShare,
      totalAssigned: entry.totalAssigned,
      totalCapacity: entry.totalCapacity,
      message: `Base slot ${entry.baseSlotId} is ${percentLabel}% filled by division ${dominant.division} (${dominant.count}/${entry.totalAssigned} assignments)`,
    });
  }

  fairnessConcerns.sort(
    (a, b) => a.baseSlotId.localeCompare(b.baseSlotId) || a.message.localeCompare(b.message)
  );

  return fairnessConcerns;
}

/**
 * Measure an applied or proposed practice schedule.
 *
 * @param {Object} params
 * @param {Array<{ teamId: string, slotId: string }>} params.assignments
 * @param {Array<{ teamId: string, reason?: unknown }>} [params.unassigned] -
 *   `reason` is deliberately untyped: `normalizeManualFollowUpReasonInput`
 *   takes whatever a persisted run put there, and a test pins a number and an
 *   object against it.
 * @param {Array<Object>} params.teams - The roster, and the subject set for
 *   every team-shaped count: derived from `teams`, never from `assignments`.
 * @param {Array<Object>} params.slots
 * @param {string} [params.schoolDayEnd] - e.g. `'16:00'`. Omit it (or pass
 *   `null`) to opt out of the school-hours check; supplying it is a promise to
 *   apply it, so an empty or blank string refuses rather than opting out.
 * @param {string} [params.timezone] - the season's IANA zone. Required
 *   whenever `schoolDayEnd` is supplied: a wall reading needs a clock before
 *   an assignment can be compared against it.
 * @returns {Object} The practice report. `dataQualityWarnings` carries the
 *   school-hours violations, and is empty only when the check ran and found
 *   none.
 * @throws {TypeError} for malformed `assignments`, `unassigned`, `teams` or
 *   `slots`.
 * @throws {import('./timing/seasonClock.js').SeasonClockError} when
 *   `schoolDayEnd` is supplied and cannot be evaluated:
 *   `WALL_TIME_UNREADABLE` for a malformed time, `SEASON_TIMEZONE_MISSING` for
 *   no zone, `SEASON_TIMEZONE_UNKNOWN` for a zone this runtime does not know.
 *   Identical to `schedulePractices`, deliberately — a constraint that cannot
 *   be checked is refused, never reported as satisfied.
 */
export function evaluatePracticeSchedule({
  assignments,
  unassigned = [],
  teams,
  slots,
  schoolDayEnd,
  timezone,
}) {
  if (!Array.isArray(assignments)) {
    throw new TypeError('assignments must be an array');
  }
  if (!Array.isArray(unassigned)) {
    throw new TypeError('unassigned must be an array');
  }
  if (!Array.isArray(teams)) {
    throw new TypeError('teams must be an array');
  }
  if (!Array.isArray(slots)) {
    throw new TypeError('slots must be an array');
  }

  const teamsById = new Map();
  for (const team of teams) {
    TeamSchema.parse(team);

    teamsById.set(team.id, {
      id: team.id,
      division: team.division,
      coachId: team.coachId ?? null,
      coachIds: listTeamCoachIds(team),
    });
  }

  const slotsById = new Map();
  const baseSlotMetadata = new Map();
  for (const slot of slots) {
    // Read, not discarded -- see the note in `schemas/index.js` (GAP-30).
    const parsed = SlotSchema.parse(slot);

    const startDate = parsed.start;
    const endDate = parsed.end;
    const baseSlotId = slot.baseSlotId ?? slot.id;

    slotsById.set(slot.id, {
      id: slot.id,
      baseSlotId,
      capacity: slot.capacity,
      start: startDate,
      end: endDate,
      day: slot.day ?? null,
    });

    const existingMeta = baseSlotMetadata.get(baseSlotId) ?? {
      baseSlotId,
      totalCapacity: 0,
      representativeStart: null,
      day: null,
    };
    existingMeta.totalCapacity += slot.capacity;
    const becomesRepresentative =
      !existingMeta.representativeStart || startDate < existingMeta.representativeStart;
    if (becomesRepresentative) {
      existingMeta.representativeStart = startDate;
      existingMeta.day = slot.day ?? null;
    }
    baseSlotMetadata.set(baseSlotId, existingMeta);
  }

  // **The school-hours constraint is resolved once, here, or the run refuses.**
  //
  // This used to be three words inside the assignment loop --
  // `if (schoolDayEnd && timezone && slot.start)` -- and two ways past it
  // produced a report saying the schedule had no school-hours violations,
  // over a schedule nobody had checked:
  //
  //   * **no `timezone`, or a falsy one**: the guard was false, the block
  //     never ran, and `dataQualityWarnings` stayed empty;
  //   * **an unreadable `schoolDayEnd`** (`'afternoon'`, `'16'`, `'16:99'`):
  //     `split(':').map(Number)` gave `NaN` bounds, and every comparison
  //     against `NaN` is false, so no assignment could ever violate it.
  //
  // A third class was not silent but was uncoded: a TRUTHY zone string `Intl`
  // rejects -- `'   '` as much as `'Americas/New_York'` -- passed the guard
  // and threw a bare `RangeError` out of `toLocaleString`, mid-loop, in the
  // runtime's wording and with no reason code. So this function already
  // refused part of this input space; the rest of it refuses with it now,
  // rather than one arm being singled out for honesty.
  //
  // `schedulePractices` refuses all three (#420), and refuses them by name.
  // Its `resolveSchoolDayEndFilter` is reused rather than re-derived: a second
  // opinion on what a readable `schoolDayEnd` is, or on which zones exist, is
  // precisely how the solver came to refuse an input the evaluator called
  // clean. That also settles the opt-out the same way in both arms -- only
  // `undefined`/`null` opt out, and a cleared field arriving as `''` refuses
  // instead of quietly disabling the constraint.
  //
  // **Refusing, not reporting, and the callers were checked first.** There are
  // five call sites and none is an Edge Function -- `fairness-scoring` and
  // `auto-scheduler` call the Deno twin in
  // `supabase/functions/_shared/engines/scoring-engine.ts`, which takes neither
  // parameter, so no HTTP 200 becomes a 500 here. The three in
  // `autoScheduler.js` run after a `schedulePractices` call on the same two
  // values, which already refuses first. `evaluationPipeline` documents that it
  // propagates evaluator throws. `utils/practiceRunResults.js` catches and
  // records `metricsUnavailable: { reason }`, which
  // `PracticeSchedulingPage.handleApplySchedule` shows the operator while still
  // persisting their schedule -- the channel this refusal is meant to reach.
  const schoolDayEndRequested = schoolDayEnd !== undefined && schoolDayEnd !== null;
  const schoolHours = schoolDayEndRequested
    ? resolveSchoolDayEndFilter(schoolDayEnd, timezone)
    : null;

  const dataQualityWarnings = [];
  const seenAssignments = new Set();
  const assignedTeamIds = new Set();
  const assignmentsBySlot = new Map();
  const assignmentsByDivision = new Map();
  const assignmentsByCoach = new Map();
  const baseSlotDivisionCounts = new Map();
  const unassignedByReasonMap = new Map();
  const unassignedUnknownTeams = new Set();

  for (const entry of unassigned) {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError('each unassigned entry must be an object');
    }
    if (!entry.teamId) {
      throw new TypeError('each unassigned entry requires a teamId');
    }

    const reason = normalizeManualFollowUpReasonInput(entry.reason);

    const bucket = unassignedByReasonMap.get(reason) ?? {
      reason,
      count: 0,
      teamIds: [],
      divisionCounts: new Map(),
    };

    bucket.count += 1;
    bucket.teamIds.push(entry.teamId);

    const teamRecord = teamsById.get(entry.teamId);
    if (!teamRecord) {
      unassignedUnknownTeams.add(entry.teamId);
    } else if (teamRecord.division) {
      bucket.divisionCounts.set(
        teamRecord.division,
        (bucket.divisionCounts.get(teamRecord.division) ?? 0) + 1
      );
    }

    unassignedByReasonMap.set(reason, bucket);
  }

  for (const assignment of assignments) {
    if (!assignment || typeof assignment !== 'object') {
      throw new TypeError('each assignment must be an object');
    }
    if (!assignment.teamId || !assignment.slotId) {
      throw new TypeError('each assignment requires teamId and slotId');
    }

    const team = teamsById.get(assignment.teamId);
    if (!team) {
      dataQualityWarnings.push(`assignment references unknown team ${assignment.teamId}`);
      continue;
    }
    const slot = slotsById.get(assignment.slotId);
    if (!slot) {
      dataQualityWarnings.push(`assignment references unknown slot ${assignment.slotId}`);
      continue;
    }

    const key = `${assignment.teamId}::${assignment.slotId}`;
    if (seenAssignments.has(key)) {
      dataQualityWarnings.push(
        `duplicate assignment for team ${assignment.teamId} to slot ${assignment.slotId}`
      );
      continue;
    }
    seenAssignments.add(key);
    assignedTeamIds.add(team.id);

    const slotAssignments = assignmentsBySlot.get(slot.id) ?? [];
    slotAssignments.push({ teamId: assignment.teamId, team });
    assignmentsBySlot.set(slot.id, slotAssignments);

    const divisionAssignments = assignmentsByDivision.get(team.division) ?? [];
    divisionAssignments.push({ team, slot });
    assignmentsByDivision.set(team.division, divisionAssignments);

    for (const coachId of team.coachIds) {
      const coachAssignments = assignmentsByCoach.get(coachId) ?? [];
      coachAssignments.push({ teamId: team.id, slot });
      assignmentsByCoach.set(coachId, coachAssignments);
    }

    const baseSlotId = slot.baseSlotId;
    const baseEntry = baseSlotDivisionCounts.get(baseSlotId) ?? {
      totalAssigned: 0,
      divisionCounts: new Map(),
    };
    baseEntry.totalAssigned += 1;
    baseEntry.divisionCounts.set(
      team.division,
      (baseEntry.divisionCounts.get(team.division) ?? 0) + 1
    );
    baseSlotDivisionCounts.set(baseSlotId, baseEntry);

    // R3 Validation: Check School Hours. Unconditional once `schoolHours` is
    // non-null: the only way past the resolution above is a constraint that
    // can be evaluated, and `slot.start` is `SlotSchema`'s parsed instant, so
    // there is nothing left here to skip on. The old `slot.start` clause could
    // not fire -- `InstantSchema` refuses a start that is absent, naive or
    // unparseable long before this line -- and reading as though it could is
    // what let the two live arms beside it pass for defensiveness.
    if (schoolHours) {
      // `formatToParts` in the season's zone, which is the sibling filter's
      // method. The old code formatted with `toLocaleString` and re-parsed the
      // result with `new Date()`: correct only because the host-zone parse
      // cancelled the host-zone read, and silently `NaN` on any host whose
      // formatted output its own `Date` cannot parse -- a fourth way to the
      // same empty warning list.
      const parts = schoolHours.formatter.formatToParts(slot.start);
      const partValue = (type) => parts.find((part) => part.type === type)?.value;
      const weekday = partValue('weekday');

      // Mon-Thu. `en-US` is fixed by the formatter, so these five labels are
      // the whole domain; the weekday comes from the instant because
      // `slot.day` is optional here, where `schedulePractices` refuses a slot
      // without one. Deriving it rather than reading the label is the
      // label-versus-instant question (GAP-36) and is unchanged by this fix --
      // the old code derived it too.
      if (['Mon', 'Tue', 'Wed', 'Thu'].includes(weekday)) {
        const slotHour = Number.parseInt(partValue('hour'), 10);
        const slotMinute = Number.parseInt(partValue('minute'), 10);

        if (
          slotHour < schoolHours.endHour ||
          (slotHour === schoolHours.endHour && slotMinute < schoolHours.endMinute)
        ) {
          dataQualityWarnings.push(
            `Assignment for team ${team.id} violates school hours (starts at ${slotHour}:${String(slotMinute).padStart(2, '0')} ${timezone}, limit is ${schoolDayEnd})`
          );
        }
      }
    }
  }

  const slotUtilization = [];
  for (const slot of slotsById.values()) {
    const assignedCount = assignmentsBySlot.get(slot.id)?.length ?? 0;
    const capacity = slot.capacity;
    const utilization = capacity === 0 ? null : assignedCount / capacity;
    const overbooked = capacity !== 0 && assignedCount > capacity;
    if (capacity === 0 && assignedCount > 0) {
      dataQualityWarnings.push(
        `slot ${slot.id} has zero capacity but ${assignedCount} assignment(s)`
      );
    }
    slotUtilization.push({
      slotId: slot.id,
      assignedCount,
      capacity,
      utilization,
      overbooked,
    });
  }

  const divisionDayDistribution = {};
  const divisionBaseSlotDistribution = {};
  const dayConcentrationAlerts = [];
  for (const [division, divisionAssignments] of assignmentsByDivision.entries()) {
    const dayCounts = new Map();
    const baseSlotCounts = new Map();
    let totalMinutes = 0;
    let counted = 0;

    for (const { slot } of divisionAssignments) {
      const baseSlotId = slot.baseSlotId ?? slot.id;
      baseSlotCounts.set(baseSlotId, (baseSlotCounts.get(baseSlotId) ?? 0) + 1);

      const day = slot.day ?? 'unknown';
      dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
      totalMinutes += slot.start.getUTCHours() * 60 + slot.start.getUTCMinutes();
      counted += 1;
    }

    const breakdown = Array.from(dayCounts.entries())
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => {
        if (a.count !== b.count) {
          return b.count - a.count;
        }
        return a.day.localeCompare(b.day);
      })
      .map(({ day, count }) => ({
        day,
        count,
        percentage: counted === 0 ? 0 : Number((count / counted).toFixed(4)),
      }));

    divisionDayDistribution[division] = {
      totalAssigned: counted,
      averageStartMinutes: counted === 0 ? null : Number((totalMinutes / counted).toFixed(2)),
      dayBreakdown: breakdown,
    };

    const baseSlotBreakdown = Array.from(baseSlotCounts.entries())
      .map(([baseSlotId, count]) => ({ baseSlotId, count }))
      .sort((a, b) => {
        if (b.count !== a.count) {
          return b.count - a.count;
        }
        return a.baseSlotId.localeCompare(b.baseSlotId);
      })
      .map(({ baseSlotId, count }) => ({
        baseSlotId,
        count,
        percentage: counted === 0 ? 0 : Number((count / counted).toFixed(4)),
      }));

    divisionBaseSlotDistribution[division] = {
      totalAssigned: counted,
      baseSlots: baseSlotBreakdown,
    };

    const [primaryDay] = breakdown;
    if (
      counted >= MIN_ASSIGNMENTS_FOR_CONCENTRATION &&
      primaryDay &&
      primaryDay.percentage >= DAY_CONCENTRATION_THRESHOLD
    ) {
      dayConcentrationAlerts.push({
        division,
        dominantDay: primaryDay.day,
        dominantShare: primaryDay.percentage,
        dominantCount: primaryDay.count,
        totalAssignments: counted,
      });
    }
  }

  dayConcentrationAlerts.sort(
    (a, b) => a.division.localeCompare(b.division) || a.dominantDay.localeCompare(b.dominantDay)
  );

  const baseSlotDistribution = [];
  const underutilizedBaseSlots = [];
  for (const [baseSlotId, meta] of baseSlotMetadata.entries()) {
    const countsRecord = baseSlotDivisionCounts.get(baseSlotId);
    const totalAssigned = countsRecord?.totalAssigned ?? 0;
    const divisionCounts = countsRecord?.divisionCounts ?? new Map();
    const divisionBreakdown = Array.from(divisionCounts.entries())
      .map(([division, count]) => ({
        division,
        count,
        percentage: totalAssigned === 0 ? 0 : Number((count / totalAssigned).toFixed(4)),
      }))
      .sort((a, b) => {
        if (b.count !== a.count) {
          return b.count - a.count;
        }
        return a.division.localeCompare(b.division);
      });

    const totalCapacity = meta.totalCapacity;
    const utilization =
      totalCapacity === 0 ? null : Number((totalAssigned / totalCapacity).toFixed(4));

    baseSlotDistribution.push({
      baseSlotId,
      day: meta.day ?? null,
      representativeStart: meta.representativeStart ? meta.representativeStart.toISOString() : null,
      totalAssigned,
      totalCapacity,
      utilization,
      divisionBreakdown,
    });

    if (totalCapacity > 0 && utilization !== null && utilization < UNDERUTILIZATION_THRESHOLD) {
      underutilizedBaseSlots.push({
        baseSlotId,
        day: meta.day ?? null,
        representativeStart: meta.representativeStart
          ? meta.representativeStart.toISOString()
          : null,
        totalAssigned,
        totalCapacity,
        utilization,
      });
    }
  }

  baseSlotDistribution.sort((a, b) => a.baseSlotId.localeCompare(b.baseSlotId));
  underutilizedBaseSlots.sort((a, b) => a.baseSlotId.localeCompare(b.baseSlotId));

  const fairnessConcerns = calculateFairnessConcerns(baseSlotDistribution, assignmentsByDivision);

  const coachLoad = {};
  const conflictsByPair = new Map();
  for (const [coachId, coachAssignments] of assignmentsByCoach.entries()) {
    const sortedAssignments = coachAssignments
      .map(({ teamId, slot }) => ({
        teamId,
        slotId: slot.id,
        start: slot.start,
        end: slot.end,
        day: slot.day ?? 'unknown',
      }))
      .sort((a, b) => a.start - b.start || a.slotId.localeCompare(b.slotId));

    const distinctDays = new Set(sortedAssignments.map((assignment) => assignment.day));
    coachLoad[coachId] = {
      assignedTeams: sortedAssignments.length,
      distinctDays: distinctDays.size,
    };

    for (let i = 0; i < sortedAssignments.length - 1; i += 1) {
      const current = sortedAssignments[i];
      for (let j = i + 1; j < sortedAssignments.length; j += 1) {
        const candidate = sortedAssignments[j];
        if (candidate.start >= current.end) {
          break;
        }
        const pairKey = conflictPairKey(current, candidate);
        const existing = conflictsByPair.get(pairKey);
        if (existing) {
          existing.coachIds.push(coachId);
          continue;
        }
        conflictsByPair.set(pairKey, {
          coachId,
          coachIds: [coachId],
          teams: [
            { teamId: current.teamId, slotId: current.slotId },
            { teamId: candidate.teamId, slotId: candidate.slotId },
          ],
          reason: 'overlapping slots',
        });
      }
    }
  }
  const coachConflicts = [...conflictsByPair.values()];

  const totalTeams = teams.length;
  const assignedTeams = assignedTeamIds.size;
  const unassignedTeams = totalTeams - assignedTeams;
  const assignmentRate =
    totalTeams === 0 ? 1 : Number((assignedTeams / totalTeams || 0).toFixed(4));
  const manualFollowUpRate =
    totalTeams === 0 ? 0 : Number((unassignedTeams / totalTeams || 0).toFixed(4));

  if (unassignedUnknownTeams.size > 0) {
    const list = Array.from(unassignedUnknownTeams).sort((a, b) => a.localeCompare(b));
    dataQualityWarnings.push(`Unassigned list references unknown team(s): ${list.join(', ')}`);
  }

  const unassignedByReason = Array.from(unassignedByReasonMap.values())
    .map((bucket) => ({
      reason: bucket.reason,
      count: bucket.count,
      teamIds: bucket.teamIds.sort((a, b) => a.localeCompare(b)),
      divisionBreakdown: Array.from(bucket.divisionCounts.entries())
        .map(([division, count]) => ({
          division,
          count,
          percentage: Number((count / bucket.count).toFixed(4)),
        }))
        .sort((a, b) => b.count - a.count || a.division.localeCompare(b.division)),
    }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  const manualFollowUpBreakdownMap = new Map();
  const totalManualFollowUps = unassigned.length;

  for (const entry of unassigned) {
    const normalizedReason = normalizeManualFollowUpReasonInput(entry.reason);
    const category = categorizeManualFollowUpReason(normalizedReason);
    const bucket = manualFollowUpBreakdownMap.get(category) ?? {
      category,
      count: 0,
      teamIds: [],
      reasons: new Set(),
    };

    bucket.count += 1;
    bucket.teamIds.push(entry.teamId);
    if (normalizedReason !== 'unspecified') {
      bucket.reasons.add(normalizedReason);
    }

    manualFollowUpBreakdownMap.set(category, bucket);
  }

  const manualFollowUpBreakdown = Array.from(manualFollowUpBreakdownMap.values())
    .map((bucket) => ({
      category: bucket.category,
      count: bucket.count,
      percentage:
        totalManualFollowUps === 0 ? 0 : Number((bucket.count / totalManualFollowUps).toFixed(4)),
      teamIds: bucket.teamIds.sort((a, b) => a.localeCompare(b)),
      reasons: Array.from(bucket.reasons).sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));

  const report = {
    summary: {
      totalTeams,
      assignedTeams,
      unassignedTeams,
      // Read is what arrived; counted is what survived the duplicate and
      // unknown-reference checks. A single "assignments" number would hide the
      // difference, which is the shortfall `dataQualityWarnings` is about.
      assignmentsRead: assignments.length,
      assignmentsCounted: seenAssignments.size,
      assignmentRate,
      manualFollowUpRate,
    },
    slotUtilization: slotUtilization.sort((a, b) => a.slotId.localeCompare(b.slotId)),
    baseSlotDistribution,
    divisionDayDistribution,
    divisionBaseSlotDistribution,
    dayConcentrationAlerts,
    coachLoad,
    coachConflicts,
    dataQualityWarnings,
    fairnessConcerns,
    underutilizedBaseSlots,
    unassignedByReason,
    manualFollowUpBreakdown,
  };
  assertCountsLabelled(report, PRACTICE_METRICS_COUNT_UNITS, 'evaluatePracticeSchedule()');
  return report;
}
