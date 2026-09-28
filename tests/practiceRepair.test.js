/**
 * Phase 8.6 PR 3a — bounded local repair on the practice side, and 8.6's
 * acceptance criterion:
 *
 * > *"a field lost mid-season displaces N practice slots; the repair re-homes
 * > them with the minimum number of published-time changes, reports any it
 * > cannot place as TIME TBD with a reason, and leaves every tracked metric
 * > unchanged or better. Never silently drop an unplaceable slot."*
 *
 * **"Unchanged or better", as refined by the operator's rulings (2026-09-23):**
 * every metric the repair worsens must be a named, warned compromise; none may
 * worsen silently. Directional metrics are compared against the post-loss,
 * no-repair state. Against the pre-loss plan, the metrics a TIME TBD forces
 * must move by exactly what the TBDs account for, and every other directional
 * metric is held to "unchanged or better" as well.
 *
 * **The dating assumption.** `practice_grid.csv` has seven revisions and dates
 * none of them; the adapter refuses to invent a range, so the corpus
 * materialises to nothing. This test **assumes** that revision `93 Combined`
 * was the published plan from {@link SEASON_FROM} to {@link SEASON_UNTIL}. That
 * is the test's assumption, not the corpus's, and the zero-occurrence
 * meta-assertion below fails if the dating is removed.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import {
  PRACTICE_REASON,
  PRACTICE_TBD_REASON,
  PracticeRepairInputSchema,
  materialisePracticeOccurrences,
  repairPracticeLoss,
  toPracticeMetricsInput,
  toSeason2026PracticePlan,
} from '@squadlogic/core/practice/index.js';
import {
  buildSeason2026PracticeFacilityGraph,
  buildSeason2026VenueComplexMap,
  conflictingSurfacesOf,
  isoDateOfDayNumber,
  isoDayNumber,
  surfacesConflict,
} from '@squadlogic/core/facility/index.js';
import {
  loadFacilityGeometry,
  loadSeason2026,
  loadSeason2026Practice,
} from '@squadlogic/core/fixtures/index.js';
import { changeCountsFor } from '@squadlogic/core/resolve/index.js';
import { evaluatePracticeSchedule } from '@squadlogic/core/practiceMetrics.js';
import { tier1Projection } from './helpers/practiceRepairTier1.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* -------------------------------------------------------------------------- */
/* The corpus, and the assumption that dates it                                */
/* -------------------------------------------------------------------------- */

const BASELINE_REVISION = '93 Combined';
/** ASSUMPTION (see the module doc): the published plan's range. */
const SEASON_FROM = '2026-08-17';
const SEASON_UNTIL = '2026-11-13';
/** ASSUMPTION: the season clock. Only instants the metrics compare are built on it. */
const TIME_ZONE = 'America/Los_Angeles';
/** Mid-season: a Monday about halfway through the assumed range. */
const LOSS_DATE = '2026-09-28';
const DAY_BEFORE = isoDateOfDayNumber(isoDayNumber(LOSS_DATE) - 1);

const practice = loadSeason2026Practice();
const season = loadSeason2026();
const graph = buildSeason2026PracticeFacilityGraph(loadFacilityGeometry());
const fullPlan = toSeason2026PracticePlan(
  practice.practiceSlots,
  graph,
  buildSeason2026VenueComplexMap()
);

/** The baseline revision, dated by the assumption (or not, for the control). */
function baselinePlan({ dated = true } = {}) {
  const slots = fullPlan.slots
    .filter(
      (slot) => slot.revisionId === BASELINE_REVISION && slot.surfaceResolution === 'resolved'
    )
    .map((slot) => ({
      ...slot,
      validFrom: dated ? SEASON_FROM : null,
      validUntil: dated ? SEASON_UNTIL : null,
    }));
  const ids = new Set(slots.map((slot) => slot.id));
  return {
    slots,
    assignments: fullPlan.assignments.filter((assignment) => ids.has(assignment.slotId)),
    source: fullPlan.source,
  };
}

const PLAN = baselinePlan();
/** Every shape any revision of the published plan used: the repair's whole inventory. */
const INVENTORY = fullPlan.slots
  .filter((slot) => slot.surfaceResolution === 'resolved')
  .map(({ surfaceId, weekday, startMinutes, durationMinutes }) => ({
    surfaceId,
    weekday,
    startMinutes,
    durationMinutes,
  }));
const teamById = new Map(season.teams.map((team) => [team.id, team]));
const COACHES_BY_TEAM = Object.fromEntries(
  season.teams.map((team) => [
    team.id,
    [team.coachId, ...(team.assistantCoachIds ?? [])].filter(Boolean),
  ])
);

/**
 * The zero-occurrence meta-assertion. A plan that materialises to nothing
 * makes every "unchanged" below vacuous, so it throws rather than passing.
 */
function requireOccurrences(plan, window) {
  const { occurrences } = materialisePracticeOccurrences(plan, window);
  if (occurrences.length === 0) {
    throw new Error(`the plan materialises to zero occurrences over ${window.from}..${window.to}`);
  }
  return occurrences;
}

/** Displaced series, enumerated from the plan and the graph — never from a run. */
function displacedBy(plan, surfaceId) {
  const lost = new Set(conflictingSurfacesOf(graph, surfaceId));
  const slotById = new Map(plan.slots.map((slot) => [slot.id, slot]));
  return plan.assignments
    .filter((assignment) => lost.has(slotById.get(assignment.slotId).surfaceId))
    .map((assignment) => assignment.id)
    .sort();
}

const repair = (surfaceId, options = {}) =>
  repairPracticeLoss({
    plan: options.plan ?? PLAN,
    graph,
    loss: { surfaceIds: [surfaceId], from: LOSS_DATE, reason: 'field lost mid-season' },
    inventory: INVENTORY,
    coachesByTeam: COACHES_BY_TEAM,
    ...options.extra,
  });

/**
 * The loss the acceptance test uses: chosen from the data, as the surface whose
 * loss re-homes the most series (ties by displaced count, then id). Every
 * surface the baseline stands on is tried, so a corpus change moves the
 * choice rather than breaking a hard-coded name.
 */
const SURVEY = [...new Set(PLAN.slots.map((slot) => slot.surfaceId))].sort().map((surfaceId) => ({
  surfaceId,
  exact: repair(surfaceId),
  greedy: repair(surfaceId, { extra: { strategy: 'greedy' } }),
}));
const CHOSEN = [...SURVEY].sort(
  (a, b) =>
    b.exact.stats.rehomed - a.exact.stats.rehomed ||
    b.exact.stats.displaced - a.exact.stats.displaced ||
    a.surfaceId.localeCompare(b.surfaceId)
)[0];
const RUN = CHOSEN.exact;
const DISPLACED = displacedBy(PLAN, CHOSEN.surfaceId);

/* -------------------------------------------------------------------------- */
/* Tracked metrics: enumerated from the report, classified here                */
/* -------------------------------------------------------------------------- */

const WORSE_UP = 'lower-is-better';
const WORSE_DOWN = 'higher-is-better';
const DESCRIPTIVE = 'descriptive';

/**
 * Every key `evaluatePracticeSchedule()` returns, classified. A key the report
 * grows that is not in this table fails `classifyMetrics()` — a new metric
 * cannot join the report without being held to the criterion or said not to be.
 *
 * `measure` turns the key into the one number compared. `warnedBy` names the
 * finding that must accompany any worsening; a directional metric with no
 * `warnedBy` may never worsen.
 *
 * `load` marks a metric that removing practices improves by itself: a coach's
 * day count and a coach's clashes. Against the no-repair state those are
 * *always* worse wherever a series was re-homed, which says nothing about the
 * repair, so they are held against the **published** plan instead — the same
 * reference the repair's own warnings use. Found by this test failing, not
 * reasoned in advance.
 */
const METRIC_TABLE = Object.freeze({
  'summary.totalTeams': { kind: DESCRIPTIVE, measure: (r) => r.summary.totalTeams },
  'summary.assignedTeams': {
    kind: WORSE_DOWN,
    forced: true,
    measure: (r) => r.summary.assignedTeams,
  },
  'summary.unassignedTeams': {
    kind: WORSE_UP,
    forced: true,
    measure: (r) => r.summary.unassignedTeams,
  },
  'summary.assignmentsRead': {
    kind: WORSE_DOWN,
    forced: true,
    measure: (r) => r.summary.assignmentsRead,
  },
  'summary.assignmentsCounted': {
    kind: WORSE_DOWN,
    forced: true,
    measure: (r) => r.summary.assignmentsCounted,
  },
  'summary.assignmentRate': {
    kind: WORSE_DOWN,
    forced: true,
    measure: (r) => r.summary.assignmentRate,
  },
  'summary.manualFollowUpRate': {
    kind: WORSE_UP,
    forced: true,
    measure: (r) => r.summary.manualFollowUpRate,
  },
  slotUtilization: {
    kind: WORSE_UP,
    measure: (r) => r.slotUtilization.filter((row) => row.overbooked).length,
  },
  baseSlotDistribution: { kind: DESCRIPTIVE, measure: (r) => r.baseSlotDistribution.length },
  divisionDayDistribution: {
    kind: DESCRIPTIVE,
    measure: (r) => Object.keys(r.divisionDayDistribution).length,
  },
  divisionBaseSlotDistribution: {
    kind: DESCRIPTIVE,
    measure: (r) => Object.keys(r.divisionBaseSlotDistribution).length,
  },
  dayConcentrationAlerts: { kind: WORSE_UP, measure: (r) => r.dayConcentrationAlerts.length },
  coachLoad: {
    kind: WORSE_UP,
    load: true,
    warnedBy: PRACTICE_REASON.REPAIR_COACH_DAYS_WORSENED,
    measure: (r) => Object.values(r.coachLoad).reduce((sum, row) => sum + row.distinctDays, 0),
  },
  coachConflicts: {
    kind: WORSE_UP,
    load: true,
    warnedBy: PRACTICE_REASON.REPAIR_COACH_OVERLAP_CARRIED,
    measure: (r) => r.coachConflicts.length,
  },
  dataQualityWarnings: { kind: WORSE_UP, measure: (r) => r.dataQualityWarnings.length },
  fairnessConcerns: { kind: WORSE_UP, measure: (r) => r.fairnessConcerns.length },
  underutilizedBaseSlots: { kind: DESCRIPTIVE, measure: (r) => r.underutilizedBaseSlots.length },
  // Breakdowns of `summary.unassignedTeams`, which carries the direction.
  unassignedByReason: { kind: DESCRIPTIVE, measure: (r) => r.unassignedByReason.length },
  manualFollowUpBreakdown: { kind: DESCRIPTIVE, measure: (r) => r.manualFollowUpBreakdown.length },
});

/** The metric names a report actually carries, from the report itself. */
function metricKeysOf(report) {
  return Object.keys(report).flatMap((key) =>
    key === 'summary' ? Object.keys(report.summary).map((sub) => `summary.${sub}`) : [key]
  );
}

/** Measure every metric in a report; throws on any key the table does not classify. */
function classifyMetrics(report) {
  const out = {};
  for (const key of metricKeysOf(report)) {
    const entry = METRIC_TABLE[key];
    if (!entry) throw new Error(`metric "${key}" is not classified`);
    out[key] = entry.measure(report);
  }
  return out;
}

/** Worse, in the metric's own direction. */
function worsened(key, before, after) {
  const { kind } = METRIC_TABLE[key];
  if (kind === WORSE_UP) return after > before;
  if (kind === WORSE_DOWN) return after < before;
  return false;
}

const teamsOf = (plan) =>
  [...new Set(plan.assignments.map((assignment) => assignment.teamId))].sort().map((teamId) => {
    const team = teamById.get(teamId);
    if (!team) throw new Error(`team ${teamId} is not in the season roster`);
    // The roster states no division for two Select teams. The metrics refuse a
    // team without one, so it is labelled as missing rather than guessed from
    // the team code; the test below pins which teams those are.
    return team.division ? team : { ...team, division: DIVISION_NOT_STATED };
  });
const DIVISION_NOT_STATED = '(division not stated in the roster)';

/** A plan with every displaced series simply gone: the loss, and no repair. */
function withoutDisplaced(plan, displacedIds) {
  const gone = new Set(displacedIds);
  return {
    ...plan,
    assignments: plan.assignments.filter((assignment) => !gone.has(assignment.id)),
  };
}

function metricsFor(plan, teams, unassignedTeamIds, reason) {
  const input = toPracticeMetricsInput(
    { slots: plan.slots, assignments: plan.assignments },
    { asOf: LOSS_DATE, timeZone: TIME_ZONE }
  );
  return evaluatePracticeSchedule({
    assignments: input.assignments,
    slots: input.slots,
    teams,
    unassigned: unassignedTeamIds.map((teamId) => ({ teamId, reason })),
  });
}

const TEAMS = teamsOf(PLAN);
const assignmentById = new Map(PLAN.assignments.map((assignment) => [assignment.id, assignment]));
/** Teams left with no series at all, from the ids — not from the metrics. */
function teamsWithNothingLeft(goneIds) {
  const gone = new Set(goneIds);
  const remaining = new Set(
    PLAN.assignments.filter((assignment) => !gone.has(assignment.id)).map((a) => a.teamId)
  );
  return [...new Set(goneIds.map((id) => assignmentById.get(id).teamId))]
    .filter((teamId) => !remaining.has(teamId))
    .sort();
}
const TBD_IDS = RUN.timeTbd.map((entry) => entry.assignmentId);
const PRE = metricsFor(PLAN, TEAMS, [], 'none');
const NO_REPAIR = metricsFor(
  withoutDisplaced(PLAN, DISPLACED),
  TEAMS,
  teamsWithNothingLeft(DISPLACED),
  'field lost, no repair'
);
const REPAIRED = metricsFor(
  { slots: RUN.plan.slots, assignments: RUN.plan.assignments },
  TEAMS,
  teamsWithNothingLeft(TBD_IDS),
  'field lost, TIME TBD'
);

/* -------------------------------------------------------------------------- */

describe('practice repair :: the corpus supports the scenario', () => {
  it('reads the grid it measures against, and the baseline revision is in it', () => {
    const rows = readFileSync(
      path.join(REPO_ROOT, 'fixtures/season-2026/practice/practice_grid.csv'),
      'utf8'
    )
      .trim()
      .split('\n')
      .slice(1);
    expect(rows.length).toBe(practice.practiceSlots.length);
    const inRevision = rows.filter((row) => row.startsWith(`${BASELINE_REVISION},`));
    expect(inRevision.length).toBeGreaterThan(0);
    // Unresolved ground is left out of the baseline, and said to be.
    expect(PLAN.assignments.length).toBeGreaterThan(0);
    expect(PLAN.assignments.length).toBeLessThanOrEqual(inRevision.length);
  });

  it('materialises occurrences on both sides of the loss date (the dating assumption holds)', () => {
    expect(
      requireOccurrences(RUN.plan, { from: SEASON_FROM, to: DAY_BEFORE }).length
    ).toBeGreaterThan(0);
    expect(requireOccurrences(PLAN, { from: LOSS_DATE, to: SEASON_UNTIL }).length).toBeGreaterThan(
      0
    );
  });

  it('labels, rather than guesses, the divisions the roster does not state', () => {
    const unlabelled = teamsOf(PLAN)
      .filter((team) => team.division === DIVISION_NOT_STATED)
      .map((team) => team.id);
    const fromRoster = season.teams.filter((team) => !team.division).map((team) => team.id);
    expect(unlabelled.every((id) => fromRoster.includes(id))).toBe(true);
  });

  it('chose a loss that displaces, re-homes and strands — all three, from the data', () => {
    expect(DISPLACED.length).toBeGreaterThan(0);
    expect(RUN.stats.rehomed).toBeGreaterThan(0);
    expect(RUN.stats.timeTbd).toBeGreaterThan(0);
    expect(SURVEY.length).toBe(new Set(PLAN.slots.map((slot) => slot.surfaceId)).size);
  });
});

describe('practice repair :: the acceptance criterion', () => {
  it('answers for exactly the N displaced series: each re-homed or TIME TBD, none dropped', () => {
    const answered = [...RUN.rehomed, ...RUN.timeTbd].map((entry) => entry.assignmentId).sort();
    expect(answered).toEqual(DISPLACED);
    expect(RUN.stats.displaced).toBe(DISPLACED.length);
    expect(RUN.stats.rehomed + RUN.stats.timeTbd).toBe(DISPLACED.length);
  });

  it('gives every TIME TBD a reason, a finding, and at most one cross-venue recommendation', () => {
    const reasons = new Set(Object.values(PRACTICE_TBD_REASON));
    const tbdFindings = RUN.findings.filter((f) => f.code === PRACTICE_REASON.REPAIR_TIME_TBD);
    expect(tbdFindings.map((f) => f.details.assignmentId).sort()).toEqual([...TBD_IDS].sort());
    const recommendationOf = new Map(RUN.recommendations.map((r) => [r.assignmentId, r]));
    for (const entry of RUN.timeTbd) {
      expect(reasons.has(entry.reason)).toBe(true);
      // 8.6 PR 5 retired the standalone options (up to three, each with
      // `sharedWith`); tier 2 gives each TIME TBD one joint recommendation or none.
      expect(entry.crossVenueOptions).toBeUndefined();
      const recommendation = recommendationOf.get(entry.assignmentId);
      if (recommendation.to === null) {
        expect(recommendation.reason).toBe(entry.reason);
        continue;
      }
      expect(recommendation.tier).toBe('cross-venue');
      expect(graph.surfaces[recommendation.to.surfaceId].venueId).not.toBe(
        graph.surfaces[entry.from.surfaceId].venueId
      );
      expect(recommendation.origin).toBe('approved-option');
    }
  });

  it('never places a series at another venue', () => {
    for (const entry of RUN.rehomed) {
      expect(graph.surfaces[entry.to.surfaceId].venueId).toBe(
        graph.surfaces[entry.from.surfaceId].venueId
      );
    }
  });

  it('proves its answer optimal and its published-time changes minimal', () => {
    expect(RUN.stats.provenOptimal).toBe(true);
    expect(RUN.stats.timeChangesProvenMinimal).toBe(true);
    expect(RUN.stats.publishedTimeChanges).toBe(RUN.stats.timeChangeLowerBound);
    expect(RUN.findings.some((f) => f.code === PRACTICE_REASON.REPAIR_MINIMALITY_UNPROVEN)).toBe(
      false
    );
  });

  it('counts a same-venue ground change as a location change, not a published-time change', () => {
    for (const entry of RUN.rehomed) {
      const sameTime =
        entry.from.weekday === entry.to.weekday &&
        entry.from.startMinutes === entry.to.startMinutes;
      expect(entry.publishedTimeChanged).toBe(!sameTime);
      expect(entry.locationChanged).toBe(true);
    }
    expect(RUN.stats.locationChanges).toBe(RUN.stats.rehomed);
  });

  it('says it is unwired, on the result itself', () => {
    expect(RUN.findings.some((f) => f.code === PRACTICE_REASON.REPAIR_UNWIRED)).toBe(true);
  });

  describe('every tracked metric: enumerated from the report, then held', () => {
    const keys = metricKeysOf(PRE);
    const directional = keys.filter((key) => METRIC_TABLE[key]?.kind !== DESCRIPTIVE);

    it('classifies every metric the report carries, and some are directional', () => {
      expect(keys.length).toBeGreaterThan(0);
      expect(directional.length).toBeGreaterThan(0);
      expect(() => classifyMetrics(PRE)).not.toThrow();
    });

    it('holds each directional metric unchanged or better than the no-repair state, or names it', () => {
      const before = classifyMetrics(NO_REPAIR);
      const after = classifyMetrics(REPAIRED);
      const codes = new Set(RUN.findings.map((f) => f.code));
      let checked = 0;
      for (const key of directional) {
        checked += 1;
        if (METRIC_TABLE[key].load) continue; // held against the published plan below
        if (!worsened(key, before[key], after[key])) continue;
        const warnedBy = METRIC_TABLE[key].warnedBy;
        expect({
          key,
          before: before[key],
          after: after[key],
          warned: codes.has(warnedBy),
        }).toEqual({
          key,
          before: before[key],
          after: after[key],
          warned: true,
        });
      }
      expect(checked).toBe(directional.length);
    });

    it('holds every coach to the published day count, or names the coach and both counts', () => {
      const warned = new Map(
        RUN.findings
          .filter((f) => f.code === PRACTICE_REASON.REPAIR_COACH_DAYS_WORSENED)
          .map((f) => [f.details.coach, f.details])
      );
      const coaches = Object.keys(PRE.coachLoad);
      expect(coaches.length).toBeGreaterThan(0);
      for (const coach of coaches) {
        const before = PRE.coachLoad[coach].distinctDays;
        const after = REPAIRED.coachLoad[coach]?.distinctDays ?? 0;
        if (after <= before) continue;
        expect(warned.get(coach)).toEqual({ coach, before, after });
      }
      expect(
        REPAIRED.coachConflicts.length <= PRE.coachConflicts.length ||
          RUN.findings.some((f) => f.code === PRACTICE_REASON.REPAIR_COACH_OVERLAP_CARRIED)
      ).toBe(true);
    });

    it('improves on the no-repair state wherever it re-homed something', () => {
      const before = classifyMetrics(NO_REPAIR);
      const after = classifyMetrics(REPAIRED);
      expect(after['summary.assignmentsCounted'] - before['summary.assignmentsCounted']).toBe(
        RUN.stats.rehomed
      );
    });

    it('against the pre-loss plan: forced metrics move by exactly what the TBDs account for, the rest hold', () => {
      const before = classifyMetrics(PRE);
      const after = classifyMetrics(REPAIRED);
      expect(before['summary.assignmentsCounted'] - after['summary.assignmentsCounted']).toBe(
        RUN.stats.timeTbd
      );
      expect(after['summary.unassignedTeams'] - before['summary.unassignedTeams']).toBe(
        teamsWithNothingLeft(TBD_IDS).length
      );
      const codes = new Set(RUN.findings.map((f) => f.code));
      for (const key of directional) {
        if (METRIC_TABLE[key].forced) continue;
        if (!worsened(key, before[key], after[key])) continue;
        expect({ key, warned: codes.has(METRIC_TABLE[key].warnedBy) }).toEqual({
          key,
          warned: true,
        });
      }
    });

    it('holds published time as a tracked metric, counted from the plan', () => {
      const activeFromLoss = PLAN.assignments.length;
      expect(RUN.stats.activeSeries).toBe(activeFromLoss);
      expect(RUN.stats.publishedTimeHeld).toBe(
        activeFromLoss - RUN.stats.publishedTimeChanges - RUN.stats.timeTbd
      );
    });
  });
});

describe('practice repair :: the freeze', () => {
  it('leaves every occurrence before the loss byte-identical', () => {
    const window = { from: SEASON_FROM, to: DAY_BEFORE };
    const before = requireOccurrences(PLAN, window);
    const after = requireOccurrences(RUN.plan, window);
    expect(after).toEqual(before);
  });

  it('moves only displaced series: every other assignment is untouched', () => {
    const displaced = new Set(DISPLACED);
    const repaired = new Map(RUN.plan.assignments.map((assignment) => [assignment.id, assignment]));
    let untouched = 0;
    for (const assignment of PLAN.assignments) {
      if (displaced.has(assignment.id)) continue;
      expect(repaired.get(assignment.id)).toEqual(assignment);
      untouched += 1;
    }
    expect(untouched).toBe(PLAN.assignments.length - DISPLACED.length);
    expect(untouched).toBeGreaterThan(0);
  });

  it('puts nothing on the lost ground from the loss date, and nothing on clashing ground', () => {
    const lost = new Set(conflictingSurfacesOf(graph, CHOSEN.surfaceId));
    const after = requireOccurrences(RUN.plan, { from: LOSS_DATE, to: SEASON_UNTIL }).filter(
      (occurrence) => occurrence.teamIds.length > 0
    );
    for (const occurrence of after) expect(lost.has(occurrence.surfaceId)).toBe(false);
    const byDate = new Map();
    for (const occurrence of after)
      byDate.set(occurrence.date, [...(byDate.get(occurrence.date) ?? []), occurrence]);
    let pairs = 0;
    for (const list of byDate.values()) {
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          const a = list[i];
          const b = list[j];
          if (a.startMinutes >= b.endMinutes || b.startMinutes >= a.endMinutes) continue;
          // Clashes the published plan already had are its own (the grid
          // books some halves and their whole field at once); only a clash
          // involving a re-homed series is the repair's.
          if (!a.slotId.includes('~repair@') && !b.slotId.includes('~repair@')) continue;
          pairs += 1;
          expect(surfacesConflict(graph, a.surfaceId, b.surfaceId).conflict).toBe(false);
        }
      }
    }
    expect(pairs).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Constructed cases on the corpus's own ground                                */
/* -------------------------------------------------------------------------- */

const OP = (name) => `orchard-park/${name}`;
function constructed({ series, inventory, coaches = {}, loss = OP('field-2'), extra = {} }) {
  return repairPracticeLoss({
    plan: {
      slots: series.map((entry, index) => ({
        id: `c-slot-${index}`,
        surfaceId: entry.surfaceId,
        weekday: entry.weekday,
        startMinutes: entry.startMinutes,
        durationMinutes: entry.durationMinutes ?? 60,
        validFrom: SEASON_FROM,
        validUntil: SEASON_UNTIL,
        capacity: 1,
        revisionId: 'constructed',
        label: null,
        surfaceResolution: 'resolved',
      })),
      assignments: series.map((entry, index) => ({
        id: `c-asg-${index}`,
        slotId: `c-slot-${index}`,
        teamId: entry.teamId,
        effectiveFrom: null,
        effectiveUntil: null,
      })),
      source: 'constructed',
    },
    graph,
    loss: { surfaceIds: [loss], from: LOSS_DATE, reason: 'constructed' },
    inventory: inventory.map((shape) => ({ durationMinutes: 60, ...shape })),
    coachesByTeam: coaches,
    ...extra,
  });
}

describe('practice repair :: the weekday inversion (fragility control 2)', () => {
  const run = (extra) =>
    constructed({
      series: [{ teamId: 'T', surfaceId: OP('field-2-a'), weekday: 'TUE', startMinutes: 1020 }],
      inventory: [
        { surfaceId: OP('field-3-a'), weekday: 'THU', startMinutes: 1020 },
        { surfaceId: OP('field-3-a'), weekday: 'TUE', startMinutes: 1080 },
      ],
      extra,
    });

  it('shifts a practice an hour on its own day rather than moving the day', () => {
    const [entry] = run().rehomed;
    expect(entry.to).toMatchObject({ weekday: 'TUE', startMinutes: 1080 });
    expect(entry.weekdayChanged).toBe(false);
  });

  it('is decided by the weekday term: zero it and the day move wins again', () => {
    const [entry] = run({ weights: { changedWeekday: 0 } }).rehomed;
    expect(entry.to).toMatchObject({ weekday: 'THU', startMinutes: 1020 });
  });

  it('counts drift across a day move as clock distance, for series only', () => {
    const counts = changeCountsFor(
      { weekday: 'TUE', startMinutes: 1020, surfaceId: 'a' },
      { weekday: 'THU', startMinutes: 1080, surfaceId: 'a' }
    );
    expect(counts).toEqual({
      changedGame: 1,
      driftMinute: 60,
      changedSurface: 0,
      changedWeekday: 1,
    });
    // A game slot never reaches the series arm.
    expect(
      changeCountsFor(
        { date: '2026-09-01', startMinutes: 1020, surfaceId: 'a' },
        { date: '2026-09-03', startMinutes: 1020, surfaceId: 'a' }
      )
    ).toEqual({ changedGame: 1, driftMinute: 0, changedSurface: 0 });
  });
});

describe('practice repair :: joint contention (fragility control 3)', () => {
  it('greedy never beats the exact search on any corpus loss', () => {
    for (const { exact, greedy } of SURVEY) {
      expect(exact.stats.objectiveTotal).toBeLessThanOrEqual(greedy.stats.objectiveTotal);
    }
  });

  it('the exact search strictly beats greedy somewhere in the corpus', () => {
    const strict = SURVEY.filter(
      ({ exact, greedy }) => exact.stats.objectiveTotal < greedy.stats.objectiveTotal
    );
    expect(strict.length).toBeGreaterThan(0);
  });

  it('strictly beats greedy on a constructed two-series contention', () => {
    // A and B both lose field-2 at TUE 17:00 and tie on candidate count, so
    // greedy takes A first and gives it the one same-time slot (X). B's other
    // options are day moves; A could have shifted an hour (Y), which B cannot
    // take because B already practises then. The optimum shifts A.
    const input = {
      series: [
        { teamId: 'A', surfaceId: OP('field-2-a'), weekday: 'TUE', startMinutes: 1020 },
        { teamId: 'B', surfaceId: OP('field-2-b'), weekday: 'TUE', startMinutes: 1020 },
        { teamId: 'B', surfaceId: OP('field-4-a'), weekday: 'TUE', startMinutes: 1080 },
        { teamId: 'A', surfaceId: OP('field-4-b'), weekday: 'THU', startMinutes: 1020 },
      ],
      inventory: [
        { surfaceId: OP('field-3-a'), weekday: 'TUE', startMinutes: 1020 },
        { surfaceId: OP('field-3-a'), weekday: 'TUE', startMinutes: 1080 },
        { surfaceId: OP('field-3-b'), weekday: 'THU', startMinutes: 1020 },
        { surfaceId: OP('field-3-b'), weekday: 'WED', startMinutes: 1020 },
      ],
    };
    const exact = constructed(input);
    const greedy = constructed({ ...input, extra: { strategy: 'greedy' } });
    expect(exact.stats.rehomed).toBe(2);
    expect(greedy.stats.rehomed).toBe(2);
    expect(exact.stats.objectiveTotal).toBeLessThan(greedy.stats.objectiveTotal);
    expect(exact.stats.weekdayChanges).toBe(0);
    expect(greedy.stats.weekdayChanges).toBe(1);
    expect(greedy.findings.some((f) => f.code === PRACTICE_REASON.REPAIR_MINIMALITY_UNPROVEN)).toBe(
      true
    );
  });

  it('stamps minimality unproven when the search is cut off, and never claims it', () => {
    const run = repair(CHOSEN.surfaceId, { extra: { searchNodeLimit: 1 } });
    expect(run.stats.provenOptimal).toBe(false);
    expect(run.findings.some((f) => f.code === PRACTICE_REASON.REPAIR_MINIMALITY_UNPROVEN)).toBe(
      true
    );
  });
});

describe('practice repair :: subunit clashes (fragility control 4)', () => {
  it('will not put a series on a whole field whose half is in use at that time', () => {
    const run = constructed({
      series: [
        { teamId: 'HALF', surfaceId: OP('field-1-a'), weekday: 'TUE', startMinutes: 960 },
        { teamId: 'MOVER', surfaceId: OP('field-2-a'), weekday: 'TUE', startMinutes: 960 },
      ],
      inventory: [
        { surfaceId: OP('field-1'), weekday: 'TUE', startMinutes: 960 },
        { surfaceId: OP('field-3-a'), weekday: 'TUE', startMinutes: 1080 },
      ],
    });
    expect(run.rehomed).toHaveLength(1);
    expect(run.rehomed[0].to.surfaceId).toBe(OP('field-3-a'));
  });
});

describe('practice repair :: dropped series (fragility control 5)', () => {
  it('answers for every displaced series on every corpus loss', () => {
    let losses = 0;
    for (const { surfaceId, exact } of SURVEY) {
      const expected = displacedBy(PLAN, surfaceId);
      const answered = [...exact.rehomed, ...exact.timeTbd].map((e) => e.assignmentId).sort();
      expect(answered).toEqual(expected);
      losses += expected.length > 0 ? 1 : 0;
    }
    expect(losses).toBe(SURVEY.length);
  });
});

describe('practice repair :: metric classification (fragility control 6)', () => {
  it('refuses a metric it has not classified', () => {
    expect(() => classifyMetrics({ ...PRE, notARealMetric: [] })).toThrow(/not classified/);
  });
});

describe('practice repair :: undated plans (fragility control 1)', () => {
  it('the zero-occurrence meta-assertion fails on the undated corpus', () => {
    expect(() =>
      requireOccurrences(baselinePlan({ dated: false }), { from: SEASON_FROM, to: SEASON_UNTIL })
    ).toThrow(/zero occurrences/);
  });

  it('on an undated plan the repair displaces nothing and says why, rather than repairing', () => {
    const run = repair(CHOSEN.surfaceId, { plan: baselinePlan({ dated: false }) });
    expect(run.stats.displaced).toBe(0);
    const codes = run.findings.map((f) => f.code);
    expect(codes).toContain(PRACTICE_REASON.REPAIR_SERIES_UNDATED);
    expect(codes).toContain(PRACTICE_REASON.REPAIR_NOTHING_DISPLACED);
  });
});

describe('practice repair :: coach compromises are placed, warned and counted', () => {
  it('moves a practice to a new coach day only with a warning naming the coach and both counts', () => {
    const run = constructed({
      series: [
        { teamId: 'T1', surfaceId: OP('field-1-a'), weekday: 'TUE', startMinutes: 960 },
        { teamId: 'T2', surfaceId: OP('field-2-a'), weekday: 'TUE', startMinutes: 1020 },
      ],
      inventory: [{ surfaceId: OP('field-3-a'), weekday: 'THU', startMinutes: 1020 }],
      coaches: { T1: ['coach c'], T2: ['coach c'] },
    });
    expect(run.stats.rehomed).toBe(1);
    const warning = run.findings.find((f) => f.code === PRACTICE_REASON.REPAIR_COACH_DAYS_WORSENED);
    expect(warning?.details).toEqual({ coach: 'coach c', before: 1, after: 2 });
    expect(run.stats.candidatesWithCompromise).toBe(1);
  });

  it('prefers a clean slot while it costs less than a hundred minutes more', () => {
    const run = constructed({
      series: [
        { teamId: 'T1', surfaceId: OP('field-1-a'), weekday: 'TUE', startMinutes: 960 },
        { teamId: 'T2', surfaceId: OP('field-2-a'), weekday: 'TUE', startMinutes: 1020 },
      ],
      inventory: [
        { surfaceId: OP('field-3-a'), weekday: 'THU', startMinutes: 1020 },
        { surfaceId: OP('field-3-a'), weekday: 'TUE', startMinutes: 1200 },
      ],
      coaches: { T1: ['coach c'], T2: ['coach c'] },
    });
    expect(run.rehomed[0].to.weekday).toBe('TUE');
    expect(run.stats.coachDaysWorsened).toBe(0);
  });

  it('does NOT always prefer the clean slot: past the weights, the compromise wins (stated, not tuned)', () => {
    // Clean: same day, 360 minutes later (1000 + 360 + 1). Compromised: a new
    // coach day at the same clock (1000 + 240 + 1 + 100). The one weight table
    // prefers the compromise. The operator's ruling expected the clean slot to
    // win whenever one exists; under the table it wins only while it costs
    // less than the day move plus one compromise.
    const run = constructed({
      series: [
        { teamId: 'T1', surfaceId: OP('field-1-a'), weekday: 'TUE', startMinutes: 900 },
        { teamId: 'T2', surfaceId: OP('field-2-a'), weekday: 'TUE', startMinutes: 900 },
      ],
      inventory: [
        { surfaceId: OP('field-3-a'), weekday: 'THU', startMinutes: 900 },
        { surfaceId: OP('field-3-a'), weekday: 'TUE', startMinutes: 1260 },
      ],
      coaches: { T1: ['coach c'], T2: ['coach c'] },
    });
    expect(run.rehomed[0].to.weekday).toBe('THU');
    expect(run.stats.coachDaysWorsened).toBe(1);
  });

  it('places an overlapping coach practice as a warned compromise rather than TIME TBD', () => {
    const run = constructed({
      series: [
        { teamId: 'T1', surfaceId: OP('field-1-a'), weekday: 'TUE', startMinutes: 1020 },
        { teamId: 'T2', surfaceId: OP('field-2-a'), weekday: 'TUE', startMinutes: 900 },
      ],
      inventory: [{ surfaceId: OP('field-3-a'), weekday: 'TUE', startMinutes: 1020 }],
      coaches: { T1: ['coach c'], T2: ['coach c'] },
    });
    expect(run.stats.rehomed).toBe(1);
    const warning = run.findings.find(
      (f) => f.code === PRACTICE_REASON.REPAIR_COACH_OVERLAP_CARRIED
    );
    expect(warning?.details).toMatchObject({ coach: 'coach c', teamId: 'T2', withTeamId: 'T1' });
  });
});

describe('practice repair :: the change budget bounds the search', () => {
  it('holds published times it would otherwise change, and says the budget is why', () => {
    const input = {
      series: [{ teamId: 'T', surfaceId: OP('field-2-a'), weekday: 'TUE', startMinutes: 1020 }],
      inventory: [{ surfaceId: OP('field-3-a'), weekday: 'TUE', startMinutes: 1080 }],
    };
    expect(constructed(input).stats.rehomed).toBe(1);
    const bounded = constructed({ ...input, extra: { changeBudget: 0 } });
    expect(bounded.stats.publishedTimeChanges).toBe(0);
    expect(bounded.timeTbd[0].reason).toBe(PRACTICE_TBD_REASON.CHANGE_BUDGET);
  });

  it('refuses ground the graph does not hold', () => {
    const run = constructed({
      series: [{ teamId: 'T', surfaceId: OP('field-2-a'), weekday: 'TUE', startMinutes: 1020 }],
      inventory: [],
      loss: 'nowhere/field-9',
    });
    expect(run.status).toBe('rejected');
    expect(run.findings.map((f) => f.code)).toContain(PRACTICE_REASON.REPAIR_LOSS_UNKNOWN_SURFACE);
  });
});

describe('practice repair :: the 100:1 ratio on the corpus (measured, not changed)', () => {
  const outcome = (run) =>
    JSON.stringify([
      run.rehomed.map((entry) => [entry.assignmentId, entry.to]),
      run.timeTbd.map((entry) => [entry.assignmentId, entry.reason]),
    ]);

  it('some same-venue candidates do carry a compromise, and the chosen repair never does', () => {
    const scored = SURVEY.reduce((sum, { exact }) => sum + exact.stats.candidatesScored, 0);
    const compromised = SURVEY.reduce(
      (sum, { exact }) => sum + exact.stats.candidatesWithCompromise,
      0
    );
    expect(scored).toBeGreaterThan(0);
    expect(compromised).toBeGreaterThan(0);
    for (const { exact } of SURVEY) {
      expect(exact.stats.coachDaysWorsened + exact.stats.coachOverlapsCarried).toBe(0);
    }
  });

  it('gives the same repair at every compromise weight from 100 down to 1', () => {
    let compared = 0;
    for (const { surfaceId, exact } of SURVEY) {
      for (const compromiseViolation of [30, 10, 3, 1]) {
        const run = repair(surfaceId, { extra: { weights: { compromiseViolation } } });
        expect(outcome(run)).toBe(outcome(exact));
        compared += 1;
      }
    }
    expect(compared).toBe(SURVEY.length * 4);
  }, 65_000); // 116 corpus repairs, each with its tier-2 search (8.6 PR 5): 8.9 s alone, 7.6 / 7.8 / 15.2 / 9.6 s in four local full runs; ~4x the worst, see docs/testing/test-timeouts.md.
});

/* -------------------------------------------------------------------------- */
/* Regressions from /code-review on this PR                                    */
/* -------------------------------------------------------------------------- */

/** A constructed plan whose series carry their own ranges. */
function rangedRun({ series, inventory, extra = {} }) {
  return repairPracticeLoss({
    plan: {
      slots: series.map((entry, index) => ({
        id: `r-slot-${index}`,
        surfaceId: entry.surfaceId,
        weekday: entry.weekday,
        startMinutes: entry.startMinutes,
        durationMinutes: 60,
        validFrom: entry.from ?? null,
        validUntil: entry.until ?? null,
        capacity: 1,
        revisionId: 'constructed',
        label: null,
        surfaceResolution: 'resolved',
      })),
      assignments: series.map((entry, index) => ({
        id: `r-asg-${index}`,
        slotId: `r-slot-${index}`,
        teamId: entry.teamId,
      })),
      source: 'constructed',
    },
    graph,
    loss: { surfaceIds: [OP('field-2')], from: '2026-10-05', reason: 'pitch resurfacing' },
    inventory: inventory.map((shape) => ({ durationMinutes: 60, ...shape })),
    ...extra,
  });
}

describe('practice repair :: review regressions', () => {
  it('proves minimality when two series with disjoint ranges keep their time on one shape', () => {
    const run = rangedRun({
      series: [
        {
          teamId: 'A',
          surfaceId: OP('field-2-a'),
          weekday: 'TUE',
          startMinutes: 1020,
          from: '2026-09-01',
          until: '2026-10-20',
        },
        {
          teamId: 'B',
          surfaceId: OP('field-2-b'),
          weekday: 'TUE',
          startMinutes: 1020,
          from: '2026-10-25',
          until: '2026-11-30',
        },
      ],
      inventory: [{ surfaceId: OP('field-3-a'), weekday: 'TUE', startMinutes: 1020 }],
    });
    expect(run.stats.rehomed).toBe(2);
    expect(run.stats.publishedTimeChanges).toBe(0);
    expect(run.stats.timeChangeLowerBound).toBe(0);
    expect(run.stats.timeChangesProvenMinimal).toBe(true);
  });

  it('does not blame a change budget nobody set', () => {
    const run = rangedRun({
      series: [
        {
          teamId: 'A',
          surfaceId: OP('field-2-a'),
          weekday: 'TUE',
          startMinutes: 1020,
          from: '2026-09-01',
          until: '2026-11-30',
        },
      ],
      inventory: [{ surfaceId: OP('field-3-a'), weekday: 'THU', startMinutes: 1020 }],
      extra: { weights: { unplacedGame: 500 } },
    });
    expect(run.timeTbd[0].reason).toBe(PRACTICE_TBD_REASON.OBJECTIVE_PREFERRED_TBD);
    expect(run.findings.map((f) => f.code)).toContain(PRACTICE_REASON.REPAIR_WEIGHTS_OVERRIDDEN);
  });

  it('will not land on an undated series, which occupies its ground on every date', () => {
    const run = rangedRun({
      series: [
        { teamId: 'U', surfaceId: OP('field-3-a'), weekday: 'TUE', startMinutes: 1020 },
        {
          teamId: 'A',
          surfaceId: OP('field-2-a'),
          weekday: 'TUE',
          startMinutes: 1020,
          from: '2026-09-01',
          until: '2026-11-30',
        },
      ],
      inventory: [{ surfaceId: OP('field-3-a'), weekday: 'TUE', startMinutes: 1020 }],
    });
    expect(run.stats.rehomed).toBe(0);
    expect(run.timeTbd[0].reason).toBe(PRACTICE_TBD_REASON.NO_LEGAL_SLOT_AT_VENUE);
  });

  it('says loudly when a change term is zeroed', () => {
    const run = rangedRun({
      series: [
        {
          teamId: 'A',
          surfaceId: OP('field-2-a'),
          weekday: 'TUE',
          startMinutes: 1020,
          from: '2026-09-01',
          until: '2026-11-30',
        },
      ],
      inventory: [{ surfaceId: OP('field-3-a'), weekday: 'THU', startMinutes: 1020 }],
      extra: { weights: { changedGame: 0 } },
    });
    const disabled = run.findings.find(
      (f) => f.code === PRACTICE_REASON.REPAIR_CHANGE_TERM_DISABLED
    );
    expect(disabled?.details.disabled).toEqual(['changedGame']);
    expect(disabled?.severity).toBe('compromise');
  });

  it('carries the reason for the loss onto every TIME TBD and every new slot', () => {
    const run = rangedRun({
      series: [
        {
          teamId: 'A',
          surfaceId: OP('field-2-a'),
          weekday: 'TUE',
          startMinutes: 1020,
          from: '2026-09-01',
          until: '2026-11-30',
        },
        {
          teamId: 'B',
          surfaceId: OP('field-2-b'),
          weekday: 'WED',
          startMinutes: 1020,
          from: '2026-09-01',
          until: '2026-11-30',
        },
      ],
      inventory: [{ surfaceId: OP('field-3-a'), weekday: 'TUE', startMinutes: 1020 }],
    });
    expect(run.timeTbd.every((entry) => entry.lossReason === 'pitch resurfacing')).toBe(true);
    const repaired = run.plan.slots.filter((slot) => slot.id.includes('~repair@'));
    expect(repaired.length).toBeGreaterThan(0);
    for (const slot of repaired) expect(slot.label).toMatch(/pitch resurfacing$/);
  });

  it('does not displace a series with no occurrence left after the loss', () => {
    // 2026-10-05 is a Monday; this Tuesday series ends on the Monday.
    const run = rangedRun({
      series: [
        {
          teamId: 'A',
          surfaceId: OP('field-2-a'),
          weekday: 'TUE',
          startMinutes: 1020,
          from: '2026-09-01',
          until: '2026-10-05',
        },
      ],
      inventory: [{ surfaceId: OP('field-3-a'), weekday: 'TUE', startMinutes: 1020 }],
    });
    expect(run.stats.displaced).toBe(0);
  });

  // Retired by 8.6 PR 5 (plan §2): this was #441's `sharedWith`, which told two
  // TIME TBD series they were offered the same cross-venue ground and left the
  // clash to the operator. Tier 2 resolves it instead: one gets the ground, the
  // other stays TIME TBD with its reason.
  it('gives contended cross-venue ground to one TIME TBD series, never to two', () => {
    const run = rangedRun({
      series: [
        {
          teamId: 'A',
          surfaceId: OP('field-2-a'),
          weekday: 'TUE',
          startMinutes: 1020,
          from: '2026-09-01',
          until: '2026-11-30',
        },
        {
          teamId: 'B',
          surfaceId: OP('field-2-b'),
          weekday: 'TUE',
          startMinutes: 1020,
          from: '2026-09-01',
          until: '2026-11-30',
        },
      ],
      inventory: [{ surfaceId: 'alder-park/pitch-2a', weekday: 'TUE', startMinutes: 1020 }],
    });
    expect(run.timeTbd).toHaveLength(2);
    const recommended = run.recommendations.filter((r) => r.to !== null);
    expect(recommended).toHaveLength(1);
    expect(recommended[0]).toMatchObject({
      tier: 'cross-venue',
      to: { surfaceId: 'alder-park/pitch-2a' },
    });
    const other = run.recommendations.find((r) => r.to === null);
    expect(other.reason).toBe(
      run.timeTbd.find((entry) => entry.assignmentId === other.assignmentId).reason
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 8.6 PR 3b, PR 3: bounded losses (blackouts) — plan §1                        */
/* -------------------------------------------------------------------------- */

/** A Sunday three weeks after {@link LOSS_DATE}: the blackout's last day. */
const BLACKOUT_UNTIL = '2026-10-18';
const WEEKDAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
/** The weekday of a date, from the calendar — not from the repair's helpers. */
const weekdayOfDate = (iso) => WEEKDAY_CODES[new Date(`${iso}T00:00:00Z`).getUTCDay()];

const boundedLoss = (surfaceId, overrides = {}) => ({
  surfaceIds: [surfaceId],
  from: LOSS_DATE,
  until: BLACKOUT_UNTIL,
  reason: 'maintenance',
  ...overrides,
});
const bounded = (loss, options = {}) =>
  repairPracticeLoss({
    plan: options.plan ?? PLAN,
    graph,
    loss,
    inventory: INVENTORY,
    coachesByTeam: COACHES_BY_TEAM,
    ...options.extra,
  });

/**
 * The series-windows a loss displaces, derived from the input plan and the loss
 * alone: every assignment on the lost (or clashing) ground whose own range,
 * intersected with the loss window, holds a date on its weekday — walked day by
 * day on the calendar — and, when the loss carries minutes, whose time meets
 * them. Never read from a repair result.
 */
function expectedSeriesWindows(plan, loss) {
  const lost = new Set(loss.surfaceIds.flatMap((id) => conflictingSurfacesOf(graph, id)));
  const slotById = new Map(plan.slots.map((slot) => [slot.id, slot]));
  const lossUntil = loss.until ?? '9999-12-31';
  const out = [];
  for (const assignment of plan.assignments) {
    const slot = slotById.get(assignment.slotId);
    if (!lost.has(slot.surfaceId)) continue;
    const from = assignment.effectiveFrom ?? slot.validFrom;
    const until = assignment.effectiveUntil ?? slot.validUntil;
    if (from === null || until === null) continue;
    const windowFrom = from > loss.from ? from : loss.from;
    const windowUntil = until < lossUntil ? until : lossUntil;
    let occurs = false;
    for (let day = isoDayNumber(windowFrom); day <= isoDayNumber(windowUntil); day += 1) {
      if (weekdayOfDate(isoDateOfDayNumber(day)) === slot.weekday) {
        occurs = true;
        break;
      }
    }
    if (!occurs) continue;
    if (
      loss.startMinutes !== undefined &&
      !(
        slot.startMinutes < loss.endMinutes &&
        loss.startMinutes < slot.startMinutes + slot.durationMinutes
      )
    ) {
      continue;
    }
    out.push({ assignmentId: assignment.id, window: { from: windowFrom, until: windowUntil } });
  }
  return out.sort((a, b) => a.assignmentId.localeCompare(b.assignmentId));
}

const answeredWindows = (run) =>
  [...run.rehomed, ...run.timeTbd]
    .map((entry) => ({ assignmentId: entry.assignmentId, window: entry.window }))
    .sort((a, b) => a.assignmentId.localeCompare(b.assignmentId));

const BOUNDED_LOSS = boundedLoss(CHOSEN.surfaceId);
const BOUNDED = bounded(BOUNDED_LOSS);

describe('practice repair :: bounded losses are a temporary override (plan §1)', () => {
  it('says override, and puts the series-window on every re-homed and TIME TBD entry', () => {
    expect(BOUNDED.representation).toBe('override');
    expect(BOUNDED.rehomed.length).toBeGreaterThan(0);
    expect(BOUNDED.timeTbd.length).toBeGreaterThan(0);
    for (const entry of [...BOUNDED.rehomed, ...BOUNDED.timeTbd]) {
      expect(entry.window.from >= LOSS_DATE).toBe(true);
      expect(entry.window.until <= BLACKOUT_UNTIL).toBe(true);
    }
  });

  it('leaves every occurrence outside the window byte-identical, enumerated from the input plan', () => {
    const lost = new Set(conflictingSurfacesOf(graph, CHOSEN.surfaceId));
    const seasonWindow = { from: SEASON_FROM, to: SEASON_UNTIL };
    const outside = (occurrence) => occurrence.date < LOSS_DATE || occurrence.date > BLACKOUT_UNTIL;
    const before = requireOccurrences(PLAN, seasonWindow).filter(outside);
    const after = new Map(
      requireOccurrences(BOUNDED.plan, seasonWindow)
        .filter(outside)
        .map((occurrence) => [occurrence.id, occurrence])
    );
    // Meta: the displaced teams practise on the lost ground on both sides of
    // the window, so a split (or any edit of the series) has something to break.
    const displacedTeams = new Set(
      [...BOUNDED.rehomed, ...BOUNDED.timeTbd].map((entry) => entry.teamId)
    );
    const onLostByDisplaced = (side) =>
      before.filter(
        (o) => side(o.date) && lost.has(o.surfaceId) && o.teamIds.some((t) => displacedTeams.has(t))
      ).length;
    expect(onLostByDisplaced((date) => date < LOSS_DATE)).toBeGreaterThan(0);
    expect(onLostByDisplaced((date) => date > BLACKOUT_UNTIL)).toBeGreaterThan(0);
    for (const occurrence of before) expect(after.get(occurrence.id)).toEqual(occurrence);
    expect(after.size).toBe(before.length);
  });

  it('answers for every displaced series-window exactly once, derived from plan × window', () => {
    const expected = expectedSeriesWindows(PLAN, BOUNDED_LOSS);
    expect(expected.length).toBeGreaterThan(0);
    expect(answeredWindows(BOUNDED)).toEqual(expected);
  });

  it('answers for every series-window on every corpus surface under a blackout', () => {
    let losses = 0;
    for (const { surfaceId } of SURVEY) {
      const loss = boundedLoss(surfaceId);
      const run = bounded(loss);
      const expected = expectedSeriesWindows(PLAN, loss);
      expect(answeredWindows(run)).toEqual(expected);
      losses += expected.length > 0 ? 1 : 0;
    }
    expect(losses).toBe(SURVEY.length);
  }, 20_000); // every corpus surface blacked out, one bounded repair each: 1.8-2.6 s alone, 2.7 s in a local full run, over the 5 s default in CI (58fa722).

  it('puts no displaced team on the lost ground inside the window', () => {
    const lost = new Set(conflictingSurfacesOf(graph, CHOSEN.surfaceId));
    const displacedTeams = new Set(
      [...BOUNDED.rehomed, ...BOUNDED.timeTbd].map((entry) => entry.teamId)
    );
    const inside = requireOccurrences(BOUNDED.plan, { from: LOSS_DATE, to: BLACKOUT_UNTIL });
    for (const occurrence of inside) {
      if (!lost.has(occurrence.surfaceId)) continue;
      expect(occurrence.teamIds.filter((t) => displacedTeams.has(t))).toEqual([]);
    }
    // Every re-homed team does practise inside the window, on its new ground.
    for (const entry of BOUNDED.rehomed) {
      const moved = inside.filter(
        (o) => o.teamIds.includes(entry.teamId) && o.surfaceId === entry.to.surfaceId
      );
      expect(moved.length).toBeGreaterThan(0);
    }
  });

  it('does not displace a series whose time misses the loss minutes', () => {
    const slotById = new Map(PLAN.slots.map((slot) => [slot.id, slot]));
    const meets = (slot, minute) =>
      slot.startMinutes <= minute && minute < slot.startMinutes + slot.durationMinutes;
    // The loss, chosen from the data: the first corpus surface, and the first
    // practice start on its lost ground, whose one minute some of the practices
    // there meet and some miss.
    let pick = null;
    for (const { surfaceId } of SURVEY) {
      const lost = new Set(conflictingSurfacesOf(graph, surfaceId));
      const onLost = PLAN.assignments
        .map((assignment) => slotById.get(assignment.slotId))
        .filter((slot) => lost.has(slot.surfaceId));
      const minute = [...new Set(onLost.map((slot) => slot.startMinutes))]
        .sort((a, b) => a - b)
        .find((m) => {
          const hit = onLost.filter((slot) => meets(slot, m)).length;
          return hit > 0 && hit < onLost.length;
        });
      if (minute !== undefined) {
        pick = { surfaceId, minute };
        break;
      }
    }
    if (pick === null) throw new Error('no corpus loss has a minute that separates its series');
    const loss = boundedLoss(pick.surfaceId, {
      startMinutes: pick.minute,
      endMinutes: pick.minute + 1,
    });
    const expected = expectedSeriesWindows(PLAN, loss);
    const withoutMinutes = expectedSeriesWindows(PLAN, boundedLoss(pick.surfaceId));
    // Meta: the minutes leave some series in and put some out.
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(withoutMinutes.length);
    const run = bounded(loss);
    expect(answeredWindows(run)).toEqual(expected);
    const spared = new Set(withoutMinutes.map((e) => e.assignmentId));
    for (const e of expected) spared.delete(e.assignmentId);
    const repaired = new Map(run.plan.assignments.map((assignment) => [assignment.id, assignment]));
    let checked = 0;
    for (const assignment of PLAN.assignments) {
      if (!spared.has(assignment.id)) continue;
      expect(repaired.get(assignment.id)).toEqual(assignment);
      checked += 1;
    }
    expect(checked).toBe(spared.size);
  });

  describe('placement against frozen series looks at the window only', () => {
    const occupancyRun = (occupants) =>
      rangedRun({
        series: [
          {
            teamId: 'D',
            surfaceId: OP('field-2-a'),
            weekday: 'TUE',
            startMinutes: 1020,
            from: SEASON_FROM,
            until: SEASON_UNTIL,
          },
          ...occupants,
        ],
        inventory: [{ surfaceId: OP('field-3-a'), weekday: 'TUE', startMinutes: 1020 }],
        extra: {
          loss: {
            surfaceIds: [OP('field-2')],
            from: LOSS_DATE,
            until: BLACKOUT_UNTIL,
            reason: 'maintenance',
          },
        },
      });
    const occupant = (teamId, from, until) => ({
      teamId,
      surfaceId: OP('field-3-a'),
      weekday: 'TUE',
      startMinutes: 1020,
      from,
      until,
    });

    it('takes ground a frozen series holds only before and after the window', () => {
      const run = occupancyRun([
        occupant('EARLY', SEASON_FROM, '2026-09-27'),
        occupant('LATE', '2026-10-19', SEASON_UNTIL),
      ]);
      expect(run.representation).toBe('override');
      expect(run.rehomed.map((e) => [e.teamId, e.to.surfaceId, e.window])).toEqual([
        ['D', OP('field-3-a'), { from: LOSS_DATE, until: BLACKOUT_UNTIL }],
      ]);
    });

    it('control: the same ground held inside the window refuses it', () => {
      const run = occupancyRun([occupant('INSIDE', '2026-10-13', SEASON_UNTIL)]);
      expect(run.rehomed).toEqual([]);
      expect(run.timeTbd.map((e) => [e.teamId, e.reason, e.window])).toEqual([
        [
          'D',
          PRACTICE_TBD_REASON.NO_LEGAL_SLOT_AT_VENUE,
          { from: LOSS_DATE, until: BLACKOUT_UNTIL },
        ],
      ]);
    });
  });
});

/**
 * Unbounded losses are byte-identical to main in everything tier 1 decides.
 * Each pin is the digest of `origin/main`'s result for that surface, exact then
 * greedy, at 6db3c1b (after #458 and #464), through `tier1Projection()`: 8.6
 * PR 5 replaced the standalone cross-venue options with the joint tier-2
 * search, and the projection leaves out exactly those surfaces and the new
 * `recommendations`. `representation` (#458) is left out and asserted on its
 * own, as before. Any other change to an unbounded result turns a digest red.
 */
const UNBOUNDED_DIGESTS_ON_MAIN = {
  'alder-park/pitch-1a-side-1': ['7b945ddec8f969b3', '4a1f502a0f7a8c70'],
  'alder-park/pitch-1b-side-1': ['c6d1cdfaf55c2087', '721c21713e954c06'],
  'alder-park/pitch-2a': ['9eb6d0d9c236db5d', '3233c1823a0022b2'],
  'alder-park/pitch-2b': ['a33e8d86c259550c', 'd51ffae24d28a696'],
  'alder-park/pitch-3a': ['6b578ee996334daf', '97e7be43d1972185'],
  'alder-park/pitch-3b': ['6cbb6f6291cad723', '61608e133ca604fa'],
  'alder-park/pitch-4a-side-1': ['b65775f119fc5a4b', 'f2f5c5a84f5b7572'],
  'alder-park/pitch-4b-side-1': ['aa1a5fcc304846e0', 'f249247ec80b8f93'],
  'brookside-park/lower-a': ['df2883b0eb69215d', '0ec7a4a66d6b581b'],
  'brookside-park/lower-b': ['4ef65dff95f8e088', 'd574015a5bed7bb8'],
  'larkfield-green/field-1-a': ['dbaa691599eb524c', '1ac2beff5049bdcf'],
  'maplewood-back/field-1-a': ['89f62584a8eb4421', 'f77073b8836d58fb'],
  'maplewood-back/field-1-b': ['2ef6bf28c5ce1f0a', 'e2b2f00250372179'],
  'maplewood-back/field-2-a': ['1151dea4ab8de4a4', '381cab7bf6021a03'],
  'maplewood-back/field-2-b': ['86229a7c01f3df3d', '8bfc0bb0430843c1'],
  'maplewood-back/field-3-a': ['b8d3768d2d66becf', '672b4ba31ddc2ad8'],
  'maplewood-back/field-3-b': ['52ae697bc706c2da', '849f5c24f58a259d'],
  'maplewood-back/field-4-a': ['0228416349831755', '008c64730a17e696'],
  'maplewood-back/field-4-b': ['71622298f58d478c', '270d959d9815fdd9'],
  'orchard-park/field-1-a': ['cfb57de732d2b8df', 'd03791a9ed303bd5'],
  'orchard-park/field-1-b': ['04c97342c8f7fc63', 'f935b35ef74a7aff'],
  'orchard-park/field-2-a': ['4bd0e65c13b2238a', '2c1aeaa581be83cb'],
  'orchard-park/field-2-b': ['2f7a629d08f21fc8', 'f96f7d571fcf45a4'],
  'orchard-park/field-3-a': ['2537247d84078105', '20730687400189c8'],
  'orchard-park/field-3-b': ['a0f7efef7cad8497', 'c4779f70176ccffd'],
  'orchard-park/field-4-a': ['7df3e8749aac9c14', 'dab7744c96fe6a76'],
  'orchard-park/field-4-b': ['d75e01e7a8c00612', '61d8f070e5e2b832'],
  'orchard-park/field-5': ['853f5fb7793dc986', '0ee06b36b760db85'],
  'orchard-park/field-6': ['26c0548ed2baf5bb', '129d4c878692be0a'],
};
function resultDigest(result) {
  const { representation: _representation, ...rest } = tier1Projection(result);
  const json = JSON.stringify(rest, (key, value) => {
    if (value instanceof Map) return ['Map', [...value]];
    if (value instanceof Set) return ['Set', [...value]];
    return value;
  });
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

describe('practice repair :: unbounded losses are unchanged (plan §1)', () => {
  it('matches main on every corpus loss, exact and greedy, and says split', () => {
    const digests = Object.fromEntries(
      SURVEY.map(({ surfaceId, exact, greedy }) => [
        surfaceId,
        [resultDigest(exact), resultDigest(greedy)],
      ])
    );
    expect(Object.keys(digests).length).toBe(29);
    expect(digests).toEqual(UNBOUNDED_DIGESTS_ON_MAIN);
    for (const { exact, greedy } of SURVEY) {
      expect(exact.representation).toBe('split');
      expect(greedy.representation).toBe('split');
    }
  });
});

describe('practice repair :: loss schema (plan §1)', () => {
  const base = { surfaceIds: [OP('field-2')], from: LOSS_DATE, reason: 'maintenance' };
  const parse = (loss) =>
    PracticeRepairInputSchema.safeParse({
      plan: { slots: [], assignments: [], source: 'constructed' },
      graph,
      loss,
      inventory: [],
    });

  it('accepts a loss with no end, an end, and an end with minutes', () => {
    expect(parse(base).success).toBe(true);
    expect(parse({ ...base, until: LOSS_DATE }).success).toBe(true);
    expect(
      parse({ ...base, until: BLACKOUT_UNTIL, startMinutes: 0, endMinutes: 1440 }).success
    ).toBe(true);
  });

  it.each([
    ['until before from', { until: '2026-09-27' }],
    ['until not a date', { until: '2026-10-XX' }],
    ['start without end', { until: BLACKOUT_UNTIL, startMinutes: 1020 }],
    ['end without start', { until: BLACKOUT_UNTIL, endMinutes: 1080 }],
    ['an empty window', { until: BLACKOUT_UNTIL, startMinutes: 1080, endMinutes: 1080 }],
    ['an inverted window', { until: BLACKOUT_UNTIL, startMinutes: 1080, endMinutes: 1020 }],
    ['a negative start', { until: BLACKOUT_UNTIL, startMinutes: -1, endMinutes: 60 }],
    ['an end past midnight', { until: BLACKOUT_UNTIL, startMinutes: 0, endMinutes: 1441 }],
    ['fractional minutes', { until: BLACKOUT_UNTIL, startMinutes: 60.5, endMinutes: 120 }],
    ['a free-text note', { until: BLACKOUT_UNTIL, note: 'resurfacing' }],
    ['minutes on a loss with no end', { startMinutes: 1020, endMinutes: 1080 }],
  ])('refuses %s', (_label, extra) => {
    expect(parse({ ...base, ...extra }).success).toBe(false);
  });
});

describe('practice repair :: the override window is the series range within the loss window', () => {
  // Synthetic series with their own ranges, against a blackout of
  // LOSS_DATE (Mon 2026-09-28) .. BLACKOUT_UNTIL (Sun 2026-10-18).
  const SERIES = [
    // (a) displaced, its range ends inside the window.
    { id: 'A', surfaceId: OP('field-2-a'), weekday: 'TUE', from: SEASON_FROM, until: '2026-10-07' },
    // (b) displaced, its range starts inside the window.
    {
      id: 'B',
      surfaceId: OP('field-2-a'),
      weekday: 'WED',
      from: '2026-10-05',
      until: SEASON_UNTIL,
    },
    // (c) on the lost ground, but its range ends before the window.
    { id: 'C', surfaceId: OP('field-2-a'), weekday: 'THU', from: SEASON_FROM, until: '2026-09-20' },
    // (d) frozen, off the lost ground, its range ends before the window; it
    // held the only TUE shape A can take.
    {
      id: 'F1',
      surfaceId: OP('field-3-a'),
      weekday: 'TUE',
      from: SEASON_FROM,
      until: '2026-09-20',
    },
    // (d') frozen, its range ends inside the window, before G's starts; it
    // holds the only FRI shape G can take.
    {
      id: 'F2',
      surfaceId: OP('field-3-a'),
      weekday: 'FRI',
      from: SEASON_FROM,
      until: '2026-10-04',
    },
    {
      id: 'G',
      surfaceId: OP('field-2-a'),
      weekday: 'FRI',
      from: '2026-10-05',
      until: SEASON_UNTIL,
    },
  ];
  const plan = {
    slots: SERIES.map((s) => ({
      id: `w-slot-${s.id}`,
      surfaceId: s.surfaceId,
      weekday: s.weekday,
      startMinutes: 1020,
      durationMinutes: 60,
      validFrom: s.from,
      validUntil: s.until,
      capacity: 1,
      revisionId: 'constructed',
      label: null,
      surfaceResolution: 'resolved',
    })),
    assignments: SERIES.map((s) => ({
      id: `w-asg-${s.id}`,
      slotId: `w-slot-${s.id}`,
      teamId: `team-${s.id}`,
      effectiveFrom: null,
      effectiveUntil: null,
    })),
    source: 'constructed',
  };
  const loss = {
    surfaceIds: [OP('field-2')],
    from: LOSS_DATE,
    until: BLACKOUT_UNTIL,
    reason: 'maintenance',
  };
  const run = repairPracticeLoss({
    plan,
    graph,
    loss,
    inventory: ['TUE', 'WED', 'FRI'].map((weekday) => ({
      surfaceId: OP('field-3-a'),
      weekday,
      startMinutes: 1020,
      durationMinutes: 60,
    })),
  });
  /** max(series.from, loss.from) .. min(series.until, loss.until), from the inputs. */
  const windowOf = (id) => {
    const s = SERIES.find((entry) => entry.id === id);
    return {
      from: s.from > loss.from ? s.from : loss.from,
      until: s.until < loss.until ? s.until : loss.until,
    };
  };

  it('derives the same displaced series-windows from the inputs as the repair answers', () => {
    const expected = expectedSeriesWindows(plan, loss);
    expect(expected.map((e) => e.assignmentId)).toEqual(['w-asg-A', 'w-asg-B', 'w-asg-G']);
    expect(answeredWindows(run)).toEqual(expected);
  });

  it('(a) ends the override at the series end, (b) starts it at the series start', () => {
    const byId = new Map(run.rehomed.map((entry) => [entry.assignmentId, entry]));
    expect(windowOf('A')).toEqual({ from: LOSS_DATE, until: '2026-10-07' });
    expect(byId.get('w-asg-A')?.window).toEqual(windowOf('A'));
    expect(windowOf('B')).toEqual({ from: '2026-10-05', until: BLACKOUT_UNTIL });
    expect(byId.get('w-asg-B')?.window).toEqual(windowOf('B'));
    // No phantom practice: the override slot holds only the series-window.
    const overrideSlot = run.plan.slots.find((slot) => slot.id.includes('#w-asg-A'));
    expect([overrideSlot?.validFrom, overrideSlot?.validUntil]).toEqual([
      '2026-09-28',
      '2026-10-07',
    ]);
  });

  it('(c) leaves a series that ended before the window alone', () => {
    expect(answeredWindows(run).map((e) => e.assignmentId)).not.toContain('w-asg-C');
    const kept = run.plan.assignments.find((assignment) => assignment.id === 'w-asg-C');
    expect(kept).toEqual(plan.assignments.find((assignment) => assignment.id === 'w-asg-C'));
  });

  it('(d) frees ground a frozen series holds only outside its own range within the window', () => {
    const byId = new Map(run.rehomed.map((entry) => [entry.assignmentId, entry]));
    expect(run.timeTbd).toEqual([]);
    expect(byId.get('w-asg-A')?.to).toMatchObject({ surfaceId: OP('field-3-a'), weekday: 'TUE' });
    expect(byId.get('w-asg-G')?.to).toMatchObject({ surfaceId: OP('field-3-a'), weekday: 'FRI' });
    expect(byId.get('w-asg-G')?.window).toEqual(windowOf('G'));
  });
});
