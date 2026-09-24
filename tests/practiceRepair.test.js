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

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import {
  PRACTICE_REASON,
  PRACTICE_TBD_REASON,
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

  it('gives every TIME TBD a reason, a finding, and whatever cross-venue options exist as proposals', () => {
    const reasons = new Set(Object.values(PRACTICE_TBD_REASON));
    const tbdFindings = RUN.findings.filter((f) => f.code === PRACTICE_REASON.REPAIR_TIME_TBD);
    expect(tbdFindings.map((f) => f.details.assignmentId).sort()).toEqual([...TBD_IDS].sort());
    for (const entry of RUN.timeTbd) {
      expect(reasons.has(entry.reason)).toBe(true);
      expect(entry.crossVenueOptions.length).toBeLessThanOrEqual(3);
      for (const option of entry.crossVenueOptions) {
        expect(option.toVenueId).not.toBe(graph.surfaces[entry.from.surfaceId].venueId);
        expect(option.applyAs.assignmentId).toBe(entry.assignmentId);
      }
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
  });
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

  it('tells two TIME TBD series when they are offered the same cross-venue ground', () => {
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
    const [a, b] = run.timeTbd;
    expect(a.crossVenueOptions[0].sharedWith).toEqual([b.assignmentId]);
    expect(b.crossVenueOptions[0].sharedWith).toEqual([a.assignmentId]);
  });
});
