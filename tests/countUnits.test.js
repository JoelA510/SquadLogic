/**
 * Every exposed count names its unit (Phase 8.2, part 2).
 *
 * The rule this file enforces is the one `fairness/` already keeps and the two
 * metric reports did not: a number a report publishes must say what it is a
 * number **of**. "132" was true of the roster, of the teams with a game, of the
 * sides the schedule names and of the teams holding a practice slot, and those
 * are four different numbers.
 *
 * Enforcement, not documentation: `assertCountsLabelled()` runs inside both
 * producers, so an unlabelled count cannot be returned at all. The tests below
 * check that guard in **both** directions — a number with no unit fails, and a
 * registry pattern that matches nothing is reported — and every one of them has
 * its failing case constructed beside it.
 */

import { describe, expect, it } from 'vitest';

import {
  COUNT_SUBJECT_KIND,
  COUNT_UNIT,
  COUNT_UNITS_DECLARED_ONLY,
  assertCountsLabelled,
  buildCountUnitRegistry,
  countPatternMatches,
  countUnitFor,
  decodeCountPath,
  describeCount,
  encodeCountSegment,
  numericLeaves,
  subjectKindOf,
  unlabelledCountPaths,
  unmatchedCountPatterns,
} from '@squadlogic/core/counts.js';
import { GAME_METRICS_COUNT_UNITS, evaluateGameSchedule } from '@squadlogic/core/gameMetrics.js';
import {
  PRACTICE_METRICS_COUNT_UNITS,
  evaluatePracticeSchedule,
} from '@squadlogic/core/practiceMetrics.js';

/* ========================================================================== */
/* The vocabulary                                                              */
/* ========================================================================== */

describe('counts :: the unit vocabulary', () => {
  it('renders a number with its unit and refuses an unregistered one', () => {
    expect(describeCount(132, 'ROSTERED_TEAM')).toBe('132 rostered teams');
    expect(describeCount(1, 'ROSTERED_TEAM')).toBe('1 rostered team');
    expect(describeCount(0.5, 'SHARE_OF_ONE')).toBe('0.5 share of 1');
    expect(() => describeCount(1, 'TEAMS')).toThrow(/no unit is registered/);
    expect(() => subjectKindOf('TEAMS')).toThrow(/no unit is registered/);
    // A prototype key is not a unit. A bare `COUNT_UNIT[key]` lookup returns a
    // function for these and sails past the `undefined` check, so
    // `describeCount(5, 'toString')` used to return "5 undefined".
    for (const key of ['toString', 'constructor', 'hasOwnProperty']) {
      expect(() => describeCount(5, key)).toThrow(/no unit is registered/);
      expect(() => subjectKindOf(key)).toThrow(/no unit is registered/);
      expect(() => buildCountUnitRegistry({ 'summary.x': key })).toThrow(/unregistered unit/);
    }
  });

  it('puts every unit on exactly one of the three axes, or on none deliberately', () => {
    const kinds = new Set(Object.values(COUNT_UNIT).map((unit) => unit.subjectKind));
    for (const kind of kinds) {
      expect(Object.values(COUNT_SUBJECT_KIND)).toContain(kind);
    }
    // The three populations the plan asks for are each represented.
    expect(subjectKindOf('ROSTERED_TEAM')).toBe(COUNT_SUBJECT_KIND.ROSTERED_TEAM);
    expect(subjectKindOf('SCHEDULABLE_ENTITY')).toBe(COUNT_SUBJECT_KIND.SCHEDULABLE_ENTITY);
    for (const unitKey of ['TEAM_SLOT_UNIT', 'PRACTICE_GROUP', 'FIELD_HOUR']) {
      expect(subjectKindOf(unitKey)).toBe(COUNT_SUBJECT_KIND.SLOT_UNIT);
    }
  });

  it('names exactly the units no report uses, in both directions', () => {
    const used = new Set(
      [
        ...Object.values(GAME_METRICS_COUNT_UNITS),
        ...Object.values(PRACTICE_METRICS_COUNT_UNITS),
      ].map((entry) => entry.unit)
    );
    const unused = Object.keys(COUNT_UNIT)
      .filter((key) => !used.has(key))
      .sort();
    // Declared is not enforced: a unit nothing produces has to say so.
    expect(unused).toEqual(Object.keys(COUNT_UNITS_DECLARED_ONLY).sort());
    // …and every reason is a real sentence, not a placeholder.
    for (const reason of Object.values(COUNT_UNITS_DECLARED_ONLY)) {
      expect(reason.length).toBeGreaterThan(40);
    }
    // Meta-assertion: the used set is non-empty, or the equality above would
    // hold for a repo in which nothing labelled anything.
    expect(used.size).toBeGreaterThan(5);
  });

  it('rejects a registry naming a unit that does not exist', () => {
    expect(() => buildCountUnitRegistry({ 'summary.x': 'NOT_A_UNIT' })).toThrow(
      /unregistered unit/
    );
  });
});

/* ========================================================================== */
/* The walker and the matcher                                                  */
/* ========================================================================== */

describe('counts :: paths, patterns and leaves', () => {
  it('walks numeric leaves only, and collapses array indices to one segment', () => {
    const leaves = numericLeaves({
      a: 1,
      b: 'two',
      c: null,
      d: new Date(0),
      e: [{ f: 3 }, { f: 4 }],
      g: { h: { i: 5 } },
    });
    expect([...leaves.keys()].sort()).toEqual(['a', 'e.[].f', 'g.h.i']);
    // A Date is not a count and is not walked; the assertion above would list
    // its numeric internals if it were.
    expect([...leaves.keys()].some((path) => path.startsWith('d'))).toBe(false);
  });

  it('matches wildcards without letting `*` swallow an array segment', () => {
    expect(countPatternMatches('a.*.b', 'a.key.b')).toBe(true);
    expect(countPatternMatches('a.*.b', 'a.[].b')).toBe(false);
    expect(countPatternMatches('a.[].b', 'a.[].b')).toBe(true);
    expect(countPatternMatches('a.b', 'a.b.c')).toBe(false);
  });

  it('prefers the most specific pattern regardless of table order', () => {
    const registry = buildCountUnitRegistry({
      'summary.*': 'GAME',
      'summary.totalTeams': 'ROSTERED_TEAM',
    });
    expect(countUnitFor(registry, 'summary.totalTeams').unit).toBe('ROSTERED_TEAM');
    expect(countUnitFor(registry, 'summary.other').unit).toBe('GAME');
    const reversed = buildCountUnitRegistry({
      'summary.totalTeams': 'ROSTERED_TEAM',
      'summary.*': 'GAME',
    });
    expect(countUnitFor(reversed, 'summary.totalTeams').unit).toBe('ROSTERED_TEAM');
  });

  it('survives a map key containing the separator, because live data contains them', () => {
    // A division literally called "Div. A" or a field called "Field 1.5" would
    // otherwise split into two segments, match no pattern and make the guard
    // throw on a perfectly well-formed report.
    expect(encodeCountSegment('Div. A')).toBe('Div%2E A');
    expect(decodeCountPath('summary.x.Div%2E A.games')).toBe('summary.x.Div. A.games');
    const registry = buildCountUnitRegistry({ 'summary.byDivision.*.games': 'GAME' });
    const report = { summary: { byDivision: { 'Div. A': { games: 2 }, U10: { games: 1 } } } };
    expect(unlabelledCountPaths(report, registry)).toEqual([]);
    // POSITIVE CONTROL: an unlabelled dotted key is still reported, decoded.
    expect(() =>
      assertCountsLabelled(
        { summary: { byDivision: { 'Div. A': { games: 2, mystery: 1 } } } },
        registry,
        'a test report'
      )
    ).toThrow(/Div\. A\.mystery/);
  });

  it('does not let an encoded key impersonate the array marker', () => {
    const registry = buildCountUnitRegistry({ 'summary.*.games': 'GAME' });
    // A key spelled "[]" encodes, so `*` still matches it and `[]` does not.
    const report = { summary: { '[]': { games: 1 } } };
    expect(unlabelledCountPaths(report, registry)).toEqual([]);
  });

  it('reports a pattern that matches nothing — the half a one-way check misses', () => {
    const registry = buildCountUnitRegistry({
      'summary.totalTeams': 'ROSTERED_TEAM',
      'summary.ghost': 'GAME',
    });
    const report = { summary: { totalTeams: 3 } };
    expect(unlabelledCountPaths(report, registry)).toEqual([]);
    expect(unmatchedCountPatterns(report, registry)).toEqual(['summary.ghost']);
  });
});

/* ========================================================================== */
/* The guard, and the wrong implementation it has to reject                    */
/* ========================================================================== */

describe('counts :: assertCountsLabelled refuses an unlabelled number', () => {
  const registry = buildCountUnitRegistry({ 'summary.totalTeams': 'ROSTERED_TEAM' });

  it('passes a report whose every number is covered', () => {
    expect(() =>
      assertCountsLabelled({ summary: { totalTeams: 3 } }, registry, 'a test report')
    ).not.toThrow();
  });

  it('POSITIVE CONTROL: adding one unlabelled number makes it fail, and names the path', () => {
    expect(() =>
      assertCountsLabelled(
        { summary: { totalTeams: 3, mysteryNumber: 132 } },
        registry,
        'a test report'
      )
    ).toThrow(/summary\.mysteryNumber/);
  });
});

/* ========================================================================== */
/* The two reports the plan named                                              */
/* ========================================================================== */

describe('counts :: gameMetrics publishes no number without a unit', () => {
  const teams = [
    { id: 'A', name: 'A', division: 'U10', coachId: 'c1', assistantCoachIds: ['c2'] },
    { id: 'B', name: 'B', division: 'U10', coachId: 'c2', assistantCoachIds: [] },
  ];
  const game = (id, start, end, fieldId, awayTeamId = 'B', weekIndex = 1) => ({
    id,
    homeTeamId: 'A',
    awayTeamId,
    division: 'U10',
    weekIndex,
    slotId: id,
    fieldId,
    start,
    end,
  });

  /** A run that reaches every branch of the report that publishes a number. */
  const report = evaluateGameSchedule({
    assignments: [
      game('g1', '2026-09-12T14:00:00Z', '2026-09-12T16:00:00Z', 'F1'),
      game('g2', '2026-09-12T15:00:00Z', '2026-09-12T17:00:00Z', 'F1'),
      game('g3', '2026-09-19T14:00:00Z', '2026-09-19T16:00:00Z', 'F2', 'Z', 2),
    ],
    teams,
    byes: [{ weekIndex: 1, division: 'U10', teamId: 'A' }],
    unscheduled: [{ weekIndex: 3, division: 'U10', reason: 'no-field' }],
    sharedSlotUsage: [
      {
        slotId: 's1',
        fieldId: 'F1',
        weekIndex: 1,
        divisionUsage: [
          { division: 'U10', count: 5 },
          { division: 'U12', count: 1 },
        ],
      },
      {
        slotId: 's2',
        fieldId: 'F1',
        weekIndex: 1,
        divisionUsage: [
          { division: 'U10', count: 0 },
          { division: 'U12', count: 3 },
        ],
      },
    ],
  });

  it('exercised the branches whose counts would otherwise go unchecked', () => {
    // Meta-assertion: an empty report would satisfy "every number is labelled"
    // by publishing no numbers.
    const paths = [...numericLeaves(report).keys()];
    expect(paths.length).toBeGreaterThan(25);
    const types = new Set(report.warnings.map((warning) => warning.type));
    expect([...types].sort()).toEqual([
      'coach-conflict',
      'field-overlap',
      'home-away-imbalance',
      'shared-slot-imbalance',
      'team-double-booked',
      'unknown-team',
      'unscheduled-matchups',
    ]);
  });

  it('labels every number, and leaves no registry pattern unmatched', () => {
    expect(unlabelledCountPaths(report, GAME_METRICS_COUNT_UNITS)).toEqual([]);
    expect(unmatchedCountPatterns(report, GAME_METRICS_COUNT_UNITS)).toEqual([]);
  });

  it('separates the three team populations that "132" used to conflate', () => {
    expect(report.summary.teamsRostered).toBe(2);
    expect(report.summary.teamsScheduled).toBe(2);
    expect(report.summary.teamsReferencedUnknown).toBe(1);
    expect(countUnitFor(GAME_METRICS_COUNT_UNITS, 'summary.teamsRostered').subjectKind).toBe(
      COUNT_SUBJECT_KIND.ROSTERED_TEAM
    );
    expect(countUnitFor(GAME_METRICS_COUNT_UNITS, 'summary.teamsScheduled').subjectKind).toBe(
      COUNT_SUBJECT_KIND.SCHEDULABLE_ENTITY
    );
  });
});

describe('counts :: practiceMetrics publishes no number without a unit', () => {
  const slot = (id, baseSlotId, capacity, start, end, day) => ({
    id,
    baseSlotId,
    capacity,
    start,
    end,
    day,
  });
  const slots = [
    slot('slot-a', 'base-a', 2, '2026-09-14T22:00:00Z', '2026-09-14T23:00:00Z', 'Mon'),
    slot('slot-c', 'base-a', 2, '2026-09-14T23:00:00Z', '2026-09-15T00:00:00Z', 'Mon'),
    slot('slot-b', 'base-b', 4, '2026-09-16T22:00:00Z', '2026-09-16T23:00:00Z', 'Wed'),
    // Ten places, one taken: the underutilisation branch.
    slot('slot-d', 'base-c', 10, '2026-09-16T23:00:00Z', '2026-09-17T00:00:00Z', 'Wed'),
  ];
  const teams = [
    { id: 't1', division: 'U10', coachId: 'c1' },
    { id: 't2', division: 'U10', coachId: 'c2' },
    { id: 't3', division: 'U10', coachId: 'c1' },
    { id: 't4', division: 'U12', coachId: null },
    { id: 't5', division: 'U10', coachId: 'c3' },
    { id: 't6', division: 'U12', coachId: 'c4' },
  ];

  const report = evaluatePracticeSchedule({
    assignments: [
      { teamId: 't1', slotId: 'slot-a' },
      { teamId: 't2', slotId: 'slot-a' },
      { teamId: 't3', slotId: 'slot-c' },
      // The duplicate: read but not counted.
      { teamId: 't3', slotId: 'slot-c' },
      { teamId: 't5', slotId: 'slot-b' },
      { teamId: 't6', slotId: 'slot-d' },
    ],
    unassigned: [{ teamId: 't4', reason: 'no capacity' }],
    teams,
    slots,
    schoolDayEnd: undefined,
    timezone: undefined,
  });

  it('exercised enough of the report for the labelling claim to mean something', () => {
    expect([...numericLeaves(report).keys()].length).toBeGreaterThan(30);
    expect(report.dataQualityWarnings.length).toBeGreaterThan(0);
    // The branches whose registry patterns would otherwise never be exercised.
    expect(report.dayConcentrationAlerts.length).toBeGreaterThan(0);
    expect(report.underutilizedBaseSlots.length).toBeGreaterThan(0);
    expect(report.fairnessConcerns.length).toBeGreaterThan(0);
  });

  // The same schedule, dated (M4.7): every slot on one week's dates and its
  // wall window, and t3 moved onto t1's window so the pair clashes. Only a
  // dated report publishes `assignmentRows` and a conflict's `sharedDates`.
  const DATED_ONLY = ['coachConflicts.[].sharedDates', 'slotUtilization.[].assignmentRows'];
  const wall = (iso) => iso.slice(11, 16);
  const datedReport = evaluatePracticeSchedule({
    assignments: [
      { teamId: 't1', slotId: 'slot-a' },
      { teamId: 't2', slotId: 'slot-a' },
      { teamId: 't3', slotId: 'slot-a' },
      { teamId: 't3', slotId: 'slot-c', effectiveDateRange: '[2026-09-14,2026-10-31]' },
      { teamId: 't5', slotId: 'slot-b' },
      { teamId: 't6', slotId: 'slot-d' },
    ],
    unassigned: [{ teamId: 't4', reason: 'no capacity' }],
    teams,
    slots: slots.map((s) => ({
      ...s,
      firstDate: s.start.slice(0, 10),
      lastDate: '2026-11-20',
      startTime: wall(s.start),
      endTime: s.end.slice(0, 10) === s.start.slice(0, 10) ? wall(s.end) : '23:59',
    })),
    schoolDayEnd: undefined,
    timezone: undefined,
  });

  it('labels every number; only the dated-only patterns go unmatched undated', () => {
    expect(report.summary.dateModel).toBe('undated');
    expect(unlabelledCountPaths(report, PRACTICE_METRICS_COUNT_UNITS)).toEqual([]);
    expect(unmatchedCountPatterns(report, PRACTICE_METRICS_COUNT_UNITS)).toEqual(DATED_ONLY);
  });

  it('a dated report labels every number and leaves no registry pattern unmatched', () => {
    expect(datedReport.summary.dateModel).toBe('dated');
    expect(datedReport.coachConflicts.length).toBeGreaterThan(0);
    expect(unlabelledCountPaths(datedReport, PRACTICE_METRICS_COUNT_UNITS)).toEqual([]);
    expect(unmatchedCountPatterns(datedReport, PRACTICE_METRICS_COUNT_UNITS)).toEqual([]);
  });

  it('says whether a number counts rostered teams, teams holding a slot, or assignments', () => {
    // Six rostered teams; five of them hold a slot; six assignment rows were
    // read and five survived deduplication. One number could not be all three.
    expect(report.summary.totalTeams).toBe(6);
    expect(report.summary.assignedTeams).toBe(5);
    expect(report.summary.assignmentsRead).toBe(6);
    expect(report.summary.assignmentsCounted).toBe(5);
    expect(countUnitFor(PRACTICE_METRICS_COUNT_UNITS, 'summary.totalTeams').subjectKind).toBe(
      COUNT_SUBJECT_KIND.ROSTERED_TEAM
    );
    expect(countUnitFor(PRACTICE_METRICS_COUNT_UNITS, 'summary.assignedTeams').subjectKind).toBe(
      COUNT_SUBJECT_KIND.SLOT_UNIT
    );
    // A base slot aggregates slots, so its total is assignments and not teams —
    // the distinction the old single label collapsed.
    expect(
      countUnitFor(PRACTICE_METRICS_COUNT_UNITS, 'baseSlotDistribution.[].totalAssigned').unit
    ).toBe('PRACTICE_ASSIGNMENT');
    expect(
      countUnitFor(PRACTICE_METRICS_COUNT_UNITS, 'baseSlotDistribution.[].totalCapacity').unit
    ).toBe('TEAM_SLOT_UNIT');
    expect(
      describeCount(
        report.summary.totalTeams,
        countUnitFor(PRACTICE_METRICS_COUNT_UNITS, 'summary.totalTeams').unit
      )
    ).toBe('6 rostered teams');
  });
});
