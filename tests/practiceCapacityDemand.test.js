// @vitest-environment node
/**
 * The capacity-versus-demand calculation (schedule expansion, PR 13, task N1;
 * `docs/changes/2026-11-03-schedule-expansion.md`, 5.9): `packages/core/src/practice/capacityDemand.js`.
 *
 * It answers one question before a run: can the slots a division may use hold the practices its
 * teams still lack? Every case below is built from a small league written out in the test, and
 * each expectation is worked out from that league (teams x practices a week, less saved rows,
 * slot capacity less the saved rows that fill it), never read back from the function's output.
 *
 * What the file holds the calculation to (plan 5.9, decisions 28 and 29):
 *
 * - **`still needed` is the solver's arithmetic.** The sum of `planTeamsForRun`'s `unitsNeeded`
 *   (the Edge function's own planner) over one shared league, with a negative control that the
 *   `max(target - held, 0)` clamp is reached (a team over its count).
 * - **The subject set is the roster** (lessons 46 and 92): a team with no saved practice and no
 *   place in any output is still counted, and a team of another season is not.
 * - **A slot open to two divisions counts in each row and once in the total** (lesson 92).
 * - **Length, reservation, weekday and date rules** the run applies (`practice-length`,
 *   `not-enough-days`, a reservation, "live from today").
 * - **A 0-a-week division is "none wanted", never short.**
 * - **Declared, not enforced**: coach overlap, coach `must` rules, daylight, closures, permits,
 *   travel, TIME TBD and saved exceptions are not read; the gap to the planner is pinned.
 *
 * Plants (shown red, then reverted; receipts in the pull request): P1, the teams taken from the
 * saved practices (the solver's side) instead of the roster; P2, the total row summing the rows'
 * slots; P3, the length rule dropped.
 */
import { describe, it, expect } from 'vitest';

import {
  CAPACITY_NO_SLOT_REASON,
  CAPACITY_VERDICT,
  CapacityDemandInputSchema,
  CapacityDemandReportSchema,
  buildCapacityDemand,
  capacityDemandInputFromRows,
  practicesStillNeeded,
} from '@squadlogic/core/practice/index.js';
import { PRACTICE_UNPLACED_REASON } from '@squadlogic/core/practiceUnplacedReasons.js';
import { RESERVATION_REASON } from '@squadlogic/core/practiceScheduling.js';
import { planTeamsForRun } from '../supabase/functions/_shared/engines/practice-lock.js';
import { runPracticeOptimizer } from '../supabase/functions/_shared/engines/auto-scheduler-solver.js';
import { prepareTeam } from '../supabase/functions/_shared/engines/practice-coaches.js';
import { applySlotReservations } from '../supabase/functions/_shared/engines/practice-reservations.js';
import { toDaylightSlot } from '../supabase/functions/_shared/engines/practice-daylight.js';
import { seasonLongDating } from './fixtures/solverDatedCases.js';

/** A Monday: "today" for every case unless a case says otherwise. */
const LIVE_FROM = '2026-10-05';
const SEASON = { start: '2026-09-07', end: '2026-11-29' };

const division = (id, practicesPerWeek = 1, practiceMinutes = null, name = id) => ({
  id,
  name,
  practicesPerWeek,
  practiceMinutes,
});
const team = (id, divisionId) => ({ id, divisionId });
/** A weekly slot over September to November, 17:00 to 18:00 and one team wide unless overridden. */
const slot = (id, dayOfWeek, over = {}) => ({
  id,
  dayOfWeek,
  startTime: '17:00:00',
  endTime: '18:00:00',
  capacity: 1,
  validFrom: '2026-09-01',
  validUntil: '2026-11-30',
  divisionId: null,
  ...over,
});
const saved = (id, teamId, slotId, effectiveDateRange = null) => ({
  id,
  teamId,
  slotId,
  effectiveDateRange,
});

/** @param {Record<string, any>} over */
const run = (over = {}) =>
  buildCapacityDemand({
    liveFrom: LIVE_FROM,
    season: SEASON,
    divisions: [],
    teams: [],
    slots: [],
    assignments: [],
    ...over,
  });
const row = (report, id) => report.divisions.find((d) => d.divisionId === id);

describe('practicesStillNeeded: the planner’s arithmetic, one place', () => {
  it.each([
    [2, 0, 2],
    [2, 1, 1],
    [2, 2, 0],
    [1, 3, 0],
    [0, 0, 0],
    [0, 2, 0],
    [3, 1, 2],
  ])('a team wanting %i that holds %i still needs %i', (target, held, needed) => {
    expect(practicesStillNeeded(target, held)).toBe(needed);
  });
});

describe('still needed equals the sum of planTeamsForRun’s unitsNeeded, over one shared league', () => {
  // Ten teams in six divisions, every outcome of the planner reached: nothing held, partly held,
  // held to the count, held over the count, a 0-a-week division that holds rows and one that holds
  // none, and a division with no team.
  const divisions = [
    division('a', 2),
    division('b', 1, 60),
    division('c', 0),
    division('d', 3),
    division('e', 1),
    division('f', 1),
  ];
  const teams = [
    team('a1', 'a'), // nothing held: needs 2
    team('a2', 'a'), // one of two held: needs 1
    team('a3', 'a'), // held to the count: needs 0
    team('b1', 'b'), // needs 1
    team('b2', 'b'), // held to the count
    team('c1', 'c'), // 0 a week, nothing held
    team('c2', 'c'), // 0 a week, but holds two rows
    team('d1', 'd'), // one of three held: needs 2
    team('e1', 'e'), // holds three, wants one: over its count
    team('e2', 'e'), // needs 1
  ];
  const assignments = [
    saved('r1', 'a2', 's1'),
    saved('r2', 'a3', 's1'),
    saved('r3', 'a3', 's2'),
    saved('r4', 'b2', 's3'),
    saved('r5', 'c2', 's1'),
    saved('r6', 'c2', 's2'),
    saved('r7', 'd1', 's2'),
    saved('r8', 'e1', 's1'),
    saved('r9', 'e1', 's2'),
    saved('r10', 'e1', 's3'),
  ];
  const targets = new Map(
    teams.map((t) => [t.id, divisions.find((d) => d.id === t.divisionId).practicesPerWeek])
  );
  const loaded = assignments.map((a) => ({
    id: a.id,
    teamId: a.teamId,
    slotId: a.slotId,
    effectiveDateRange: null,
    assignedVia: null,
  }));
  const plan = planTeamsForRun(
    teams.map((t) => t.id),
    loaded,
    [],
    targets
  );
  const plannerTotal = Object.values(plan.unitsNeeded).reduce((sum, n) => sum + n, 0);
  const report = run({ divisions, teams, assignments });

  it('the league reaches every outcome of the planner (a fixture that reaches nothing compares zeros)', () => {
    expect(plan.placeable.length).toBeGreaterThan(0);
    expect(plan.locked.length).toBeGreaterThan(0);
    expect(plan.noPractices).toContain('c1');
    // c2 holds two where its division wants none, e1 three where its division wants one.
    expect(plan.overTarget.map((o) => o.teamId)).toEqual(['c2', 'e1']);
    expect(plannerTotal).toBe(2 + 1 + 1 + 2 + 1); // a1, a2, b1, d1, e2
  });

  it('the total, and every division’s own row, equal the planner’s units', () => {
    expect(report.total.stillNeeded).toBe(plannerTotal);
    for (const d of divisions) {
      const own = teams
        .filter((t) => t.divisionId === d.id)
        .reduce((sum, t) => sum + (plan.unitsNeeded[t.id] ?? 0), 0);
      expect(row(report, d.id).stillNeeded, d.id).toBe(own);
    }
  });

  it('the clamp matters here: without it the same league sums to something else', () => {
    // e1 holds 3 of 1 (minus 2) and c2 holds 2 of 0 (minus 2): an unclamped sum would drop below
    // the planner's total, so a version without the clamp is caught by the equality above.
    const unclamped = teams.reduce(
      (sum, t) => sum + (targets.get(t.id) - assignments.filter((a) => a.teamId === t.id).length),
      0
    );
    expect(unclamped).not.toBe(plannerTotal);
  });

  it('the held rows and the teams over their count are counted as the planner counts them', () => {
    expect(report.total.held).toBe(assignments.length);
    expect(Object.values(plan.held).reduce((s, n) => s + n, 0)).toBe(report.total.held);
    expect(row(report, 'e').teamsOverCount).toBe(1);
    expect(row(report, 'c').teamsOverCount).toBe(1);
    const overCount = report.divisions.reduce((sum, d) => sum + d.teamsOverCount, 0);
    expect(overCount).toBe(plan.overTarget.length);
  });

  it('the planner leaves a TIME TBD team out and the panel does not: the declared gap, pinned', () => {
    // Declared on the panel's face (not checked: teams whose practice time is TBD). The gap is
    // exactly that team's need, so nothing else differs.
    const withTbd = planTeamsForRun(
      teams.map((t) => t.id),
      loaded,
      ['a1'],
      targets
    );
    const tbdTotal = Object.values(withTbd.unitsNeeded).reduce((sum, n) => sum + n, 0);
    expect(report.total.stillNeeded - tbdTotal).toBe(2);
  });
});

describe('the roster is the subject set (lessons 46 and 92) [plant P1]', () => {
  const divisions = [division('x', 2)];

  it('a team with no saved practice, and so in no solver output, is counted', () => {
    const report = run({
      divisions,
      teams: [team('placed', 'x'), team('lost', 'x')],
      assignments: [saved('r1', 'placed', 's1'), saved('r2', 'placed', 's2')],
    });
    const x = row(report, 'x');
    expect(x.teams).toBe(2);
    expect(x.wanted).toBe(4);
    expect(x.held).toBe(2);
    expect(x.stillNeeded).toBe(2); // placed has its two; lost has none and needs two
  });

  it('a division none of whose teams holds a saved practice is still a row, with all of its need', () => {
    const report = run({
      divisions,
      teams: [team('t1', 'x'), team('t2', 'x'), team('t3', 'x')],
      assignments: [],
    });
    expect(row(report, 'x')).toMatchObject({ teams: 3, wanted: 6, held: 0, stillNeeded: 6 });
  });

  it('a team of a division the season does not have is not counted, and a saved row of it is not held', () => {
    const report = run({
      divisions,
      teams: [team('in', 'x'), team('elsewhere', 'last-season')],
      assignments: [saved('r1', 'elsewhere', 's1')],
    });
    expect(row(report, 'x')).toMatchObject({ teams: 1, held: 0, stillNeeded: 2 });
    expect(report.total).toMatchObject({ teams: 1, held: 0, stillNeeded: 2 });
  });

  it('a division with no team at all is a row that says so, not a missing row', () => {
    const report = run({ divisions: [division('empty', 1), ...divisions], teams: [] });
    expect(report.divisions.map((d) => d.divisionId).sort()).toEqual(['empty', 'x']);
    expect(row(report, 'empty')).toMatchObject({
      teams: 0,
      wanted: 0,
      stillNeeded: 0,
      verdict: { kind: CAPACITY_VERDICT.NO_TEAMS },
    });
  });
});

describe('the practice length rule [plant P3]', () => {
  const teams = [team('t1', 'd60'), team('t2', 'd60')];
  // Two 45-minute slots, a team wide each (capacity 2).
  const shortSlots = [
    slot('tue45', 'tue', { endTime: '17:45:00', capacity: 2 }),
    slot('thu45', 'thu', { endTime: '17:45:00', capacity: 2 }),
  ];

  it('a division wanting 60 minutes over 45-minute slots has no slot open: practice-length', () => {
    const report = run({
      divisions: [division('d60', 1, 60)],
      teams,
      slots: shortSlots,
    });
    expect(row(report, 'd60')).toMatchObject({
      stillNeeded: 2,
      slots: { open: 0, weekdays: [], capacity: 0, room: 0 },
      verdict: {
        kind: CAPACITY_VERDICT.NO_SLOT,
        reason: PRACTICE_UNPLACED_REASON.PRACTICE_LENGTH,
        short: 2,
      },
    });
  });

  it('the controls: a 45-minute division, and one that takes any length, see both slots', () => {
    const report = run({
      divisions: [division('d45', 1, 45), division('any', 1, null)],
      teams: [team('a', 'd45'), team('b', 'any')],
      slots: shortSlots,
    });
    for (const id of ['d45', 'any']) {
      expect(row(report, id).slots, id).toEqual({
        open: 2,
        weekdays: ['tue', 'thu'],
        capacity: 4,
        room: 4,
      });
    }
  });

  it('a 60-minute slot beside the short ones is the only one a 60-minute division may use', () => {
    const report = run({
      divisions: [division('d60', 1, 60)],
      teams,
      slots: [...shortSlots, slot('wed60', 'wed', { capacity: 3 })],
    });
    expect(row(report, 'd60').slots).toEqual({ open: 1, weekdays: ['wed'], capacity: 3, room: 3 });
    expect(row(report, 'd60').verdict).toMatchObject({ kind: CAPACITY_VERDICT.SPARE, spare: 1 });
  });

  it('reads the length from the two times, to the second', () => {
    const report = run({
      divisions: [division('d60', 1, 60)],
      teams: [team('t', 'd60')],
      slots: [
        slot('exact', 'tue', { startTime: '17:00', endTime: '18:00' }),
        slot('a-minute-short', 'wed', { startTime: '17:00:00', endTime: '17:59:00' }),
        slot('a-second-long', 'thu', { startTime: '17:00:00', endTime: '18:00:01' }),
      ],
    });
    expect(row(report, 'd60').slots.weekdays).toEqual(['tue']);
  });
});

describe('a reservation (practice_slots.division_id)', () => {
  const divisions = [division('a'), division('b'), division('c')];
  const teams = [team('ta', 'a'), team('tb', 'b'), team('tc', 'c')];

  it('a reserved slot is used only by its division, and a division with a reserved slot uses only its own', () => {
    const report = run({
      divisions,
      teams,
      slots: [
        slot('s-a', 'tue', { divisionId: 'a' }),
        slot('s-open', 'wed'),
        slot('s-b', 'thu', { divisionId: 'b' }),
      ],
    });
    expect(row(report, 'a').slots.weekdays).toEqual(['tue']);
    expect(row(report, 'b').slots.weekdays).toEqual(['thu']);
    expect(row(report, 'c').slots.weekdays).toEqual(['wed']);
  });

  it('a division whose reserved slots are all out of date is left with none, not spilled onto open ones', () => {
    const report = run({
      divisions,
      teams,
      slots: [
        slot('s-a-old', 'tue', { divisionId: 'a', validUntil: '2026-09-29' }),
        slot('s-open', 'wed'),
      ],
    });
    expect(row(report, 'a').slots.open).toBe(0);
    expect(row(report, 'a').verdict.kind).toBe(CAPACITY_VERDICT.NO_SLOT);
    expect(row(report, 'b').slots.weekdays).toEqual(['wed']);
  });

  it('spells a division id as the solver does: trimmed and lower-case', () => {
    const report = run({
      divisions: [division('abc-1')],
      teams: [team('t', 'abc-1')],
      slots: [slot('s', 'tue', { divisionId: '  ABC-1 ' })],
    });
    expect(row(report, 'abc-1').slots.open).toBe(1);
  });

  it('a slot reserved to a division the season does not have is open to nobody', () => {
    const report = run({
      divisions: [division('a')],
      teams: [team('ta', 'a')],
      slots: [slot('s-ghost', 'tue', { divisionId: 'gone' })],
    });
    expect(row(report, 'a').slots.open).toBe(0);
    expect(report.total.slots.open).toBe(0);
    expect(report.basis.slotsOpenToNoDivision).toBe(1);
  });
});

describe('fewer weekdays than practices a week (not-enough-days)', () => {
  const teams = [team('t1', 'two'), team('t2', 'two'), team('t3', 'two')];

  it('slots on one weekday cannot give a 2-a-week division its practices, however much room they hold', () => {
    const report = run({
      divisions: [division('two', 2)],
      teams,
      slots: [slot('thu-a', 'thu', { capacity: 5 }), slot('thu-b', 'thu', { capacity: 5 })],
    });
    expect(row(report, 'two')).toMatchObject({
      stillNeeded: 6,
      slots: { open: 2, weekdays: ['thu'], capacity: 10, room: 10 },
      verdict: {
        kind: CAPACITY_VERDICT.NOT_ENOUGH_DAYS,
        reason: PRACTICE_UNPLACED_REASON.NOT_ENOUGH_DAYS,
      },
    });
  });

  it('the control: the same room on two weekdays is "to spare"', () => {
    const report = run({
      divisions: [division('two', 2)],
      teams,
      slots: [slot('tue', 'tue', { capacity: 5 }), slot('thu', 'thu', { capacity: 5 })],
    });
    expect(row(report, 'two').verdict).toMatchObject({ kind: CAPACITY_VERDICT.SPARE, spare: 4 });
  });

  it('a division wanting one a week is not told it has too few weekdays', () => {
    const report = run({
      divisions: [division('one', 1)],
      teams: [team('t', 'one')],
      slots: [slot('only', 'thu', { capacity: 2 })],
    });
    expect(row(report, 'one').verdict.kind).toBe(CAPACITY_VERDICT.SPARE);
  });

  it('a division that already has all it needs is not told so either', () => {
    const report = run({
      divisions: [division('two', 2)],
      teams: [team('t', 'two')],
      assignments: [saved('r1', 't', 'x'), saved('r2', 't', 'y')],
      slots: [slot('only', 'thu', { capacity: 2 })],
    });
    expect(row(report, 'two')).toMatchObject({ stillNeeded: 0 });
    expect(row(report, 'two').verdict.kind).toBe(CAPACITY_VERDICT.SPARE);
  });
});

describe('the weekday verdict fires on what a team still needs, not on the weekly target [plant P6]', () => {
  const two = division('two', 2);

  it('a team that holds one of two on an expired slot needs one, and one open weekday gives it: no weekday verdict (Codex, #711; the run places it)', () => {
    const report = run({
      divisions: [two],
      teams: [team('t', 'two')],
      assignments: [saved('r1', 't', 'old-mon')],
      slots: [slot('old-mon', 'mon', { validUntil: '2026-09-29' }), slot('tue', 'tue')],
    });
    expect(row(report, 'two')).toMatchObject({
      stillNeeded: 1,
      largestNeed: 1,
      slots: { open: 1, weekdays: ['tue'], room: 1 },
      verdict: { kind: CAPACITY_VERDICT.SPARE, spare: 0, short: 0 },
    });
  });

  it('the genuine case: a team that holds nothing needs two and one weekday cannot give two different days', () => {
    const report = run({
      divisions: [two],
      teams: [team('t', 'two')],
      slots: [slot('thu', 'thu', { capacity: 2 })],
    });
    expect(row(report, 'two')).toMatchObject({
      largestNeed: 2,
      verdict: {
        kind: CAPACITY_VERDICT.NOT_ENOUGH_DAYS,
        reason: PRACTICE_UNPLACED_REASON.NOT_ENOUGH_DAYS,
      },
    });
  });

  it('a team holding two of two on expired slots needs nothing: no weekday verdict, with no live slot at all', () => {
    const report = run({
      divisions: [two],
      teams: [team('t', 'two')],
      assignments: [saved('r1', 't', 'a'), saved('r2', 't', 'b')],
      slots: [
        slot('a', 'mon', { validUntil: '2026-09-29' }),
        slot('b', 'tue', { validUntil: '2026-09-29' }),
      ],
    });
    expect(row(report, 'two')).toMatchObject({ stillNeeded: 0, largestNeed: 0 });
    expect(row(report, 'two').verdict.kind).not.toBe(CAPACITY_VERDICT.NOT_ENOUGH_DAYS);
    expect(row(report, 'two').verdict.kind).toBe(CAPACITY_VERDICT.SPARE);
  });

  it('two teams, only one of which still needs two: that one decides, and it fires', () => {
    const report = run({
      divisions: [two],
      teams: [team('full', 'two'), team('empty', 'two')],
      assignments: [saved('r1', 'full', 'x'), saved('r2', 'full', 'y')],
      slots: [slot('thu', 'thu', { capacity: 5 })],
    });
    expect(row(report, 'two')).toMatchObject({
      stillNeeded: 2,
      largestNeed: 2,
      verdict: { kind: CAPACITY_VERDICT.NOT_ENOUGH_DAYS },
    });
  });

  it('two teams that each still need one, on one weekday: no team needs two different days, so no weekday verdict', () => {
    const report = run({
      divisions: [two],
      teams: [team('a', 'two'), team('b', 'two')],
      assignments: [saved('r1', 'a', 'x'), saved('r2', 'b', 'y')],
      slots: [slot('thu', 'thu', { capacity: 5 })],
    });
    expect(row(report, 'two')).toMatchObject({ stillNeeded: 2, largestNeed: 1 });
    expect(row(report, 'two').verdict.kind).toBe(CAPACITY_VERDICT.SPARE);
  });

  it("a team over its count needs nothing and offsets nobody: it neither fires nor hides another team's need", () => {
    const over = run({
      divisions: [division('one', 1)],
      teams: [team('over', 'one'), team('needs', 'one')],
      assignments: [saved('r1', 'over', 'x'), saved('r2', 'over', 'y'), saved('r3', 'over', 'z')],
      slots: [slot('thu', 'thu', { capacity: 5 })],
    });
    expect(row(over, 'one')).toMatchObject({ stillNeeded: 1, largestNeed: 1, teamsOverCount: 1 });
    expect(row(over, 'one').verdict.kind).toBe(CAPACITY_VERDICT.SPARE);
    const both = run({
      divisions: [two],
      teams: [team('over', 'two'), team('needs', 'two')],
      assignments: [saved('r1', 'over', 'x'), saved('r2', 'over', 'y'), saved('r3', 'over', 'z')],
      slots: [slot('thu', 'thu', { capacity: 5 })],
    });
    expect(row(both, 'two')).toMatchObject({ largestNeed: 2, teamsOverCount: 1 });
    expect(row(both, 'two').verdict.kind).toBe(CAPACITY_VERDICT.NOT_ENOUGH_DAYS);
  });

  it('two slots on one weekday whose live dates never meet give a team two practices on different dates: no weekday verdict (the differential, seed 102)', () => {
    // The run's rule is "never two of a team's practices on one date", not "never on one weekday": a
    // Monday slot live only on the 5th and a Monday slot that starts on the 2nd of November share no
    // date, so one team holds both, and the weekday count alone would say it cannot.
    const report = run({
      divisions: [two],
      teams: [team('t', 'two')],
      slots: [
        slot('early', 'mon', { validUntil: '2026-10-06', capacity: 2 }),
        slot('late', 'mon', { validFrom: '2026-11-02', capacity: 2 }),
      ],
    });
    expect(row(report, 'two')).toMatchObject({
      largestNeed: 2,
      maxApart: 2,
      slots: { open: 2, weekdays: ['mon'] },
      verdict: { kind: CAPACITY_VERDICT.SPARE },
    });
  });

  it('two Monday slots that share dates give a team one practice a date: it fires', () => {
    const report = run({
      divisions: [two],
      teams: [team('t', 'two')],
      slots: [slot('a', 'mon', { capacity: 2 }), slot('b', 'mon', { capacity: 2 })],
    });
    expect(row(report, 'two')).toMatchObject({
      maxApart: 1,
      verdict: { kind: CAPACITY_VERDICT.NOT_ENOUGH_DAYS },
    });
  });

  it('slots on different weekdays are always apart, whatever their dates', () => {
    const report = run({
      divisions: [two],
      teams: [team('t', 'two')],
      slots: [slot('mon', 'mon', { capacity: 2 }), slot('tue', 'tue', { capacity: 2 })],
    });
    expect(row(report, 'two')).toMatchObject({ maxApart: 2 });
    expect(row(report, 'two').verdict.kind).toBe(CAPACITY_VERDICT.SPARE);
  });

  it('three Monday slots, two of which overlap and one that comes after both, give two apart, so a need of three fires', () => {
    const slots = [
      slot('a', 'mon', { validUntil: '2026-10-20' }),
      slot('b', 'mon', { validFrom: '2026-10-12', validUntil: '2026-10-27' }),
      slot('c', 'mon', { validFrom: '2026-11-02' }),
    ];
    const report = run({
      divisions: [division('three', 3)],
      teams: [team('t', 'three')],
      slots,
    });
    expect(row(report, 'three')).toMatchObject({
      largestNeed: 3,
      maxApart: 2,
      verdict: { kind: CAPACITY_VERDICT.NOT_ENOUGH_DAYS },
    });
    const twoWanted = run({ divisions: [two], teams: [team('t', 'two')], slots });
    expect(row(twoWanted, 'two')).toMatchObject({ maxApart: 2 });
    expect(row(twoWanted, 'two').verdict.kind).toBe(CAPACITY_VERDICT.SPARE);
  });

  it('a division with no open slot has none apart', () => {
    expect(row(run({ divisions: [two], teams: [team('t', 'two')] }), 'two').maxApart).toBe(0);
  });

  it('three practices still needed on two open weekdays fires; the same need on three weekdays does not', () => {
    const three = division('three', 3);
    const slots2 = [slot('tue', 'tue', { capacity: 3 }), slot('thu', 'thu', { capacity: 3 })];
    const fires = run({ divisions: [three], teams: [team('t', 'three')], slots: slots2 });
    expect(row(fires, 'three').verdict.kind).toBe(CAPACITY_VERDICT.NOT_ENOUGH_DAYS);
    const fine = run({
      divisions: [three],
      teams: [team('t', 'three')],
      slots: [...slots2, slot('wed', 'wed', { capacity: 3 })],
    });
    expect(row(fine, 'three').verdict.kind).toBe(CAPACITY_VERDICT.SPARE);
  });
});

describe('live from today', () => {
  const oneTeam = { divisions: [division('d')], teams: [team('t', 'd')] };
  const open = (s) => row(run({ ...oneTeam, slots: [s], season: SEASON }), 'd').slots.open;

  it.each([
    ['its last Tuesday was before today', slot('s', 'tue', { validUntil: '2026-10-04' }), 0],
    ['its last Tuesday is the day after today', slot('s', 'tue', { validUntil: '2026-10-06' }), 1],
    ['its last Monday is today itself', slot('s', 'mon', { validUntil: '2026-10-05' }), 1],
    ['its last Monday was the week before', slot('s', 'mon', { validUntil: '2026-10-04' }), 0],
    ['it starts in the future', slot('s', 'tue', { validFrom: '2026-11-02' }), 1],
    [
      'it has no dates, and the season supplies them',
      slot('s', 'tue', { validFrom: null, validUntil: null }),
      1,
    ],
  ])('%s: %i slot(s) open', (_why, s, expected) => {
    expect(open(s)).toBe(expected);
  });

  it('a slot with no dates in a season with none is unreadable: counted as such, not as open', () => {
    const report = run({
      ...oneTeam,
      season: { start: null, end: null },
      slots: [slot('s', 'tue', { validFrom: null, validUntil: null }), slot('ok', 'wed')],
    });
    expect(report.basis).toMatchObject({ slotsRead: 2, slotsUnreadable: 1, slotsLive: 1 });
    expect(row(report, 'd').slots.weekdays).toEqual(['wed']);
  });

  it('the first day of a slot is the first of its weekday on or after valid_from, as the page composes it', () => {
    // valid_from is a Wednesday, so a Tuesday slot first falls on the 13th: a slot valid only to the
    // 12th never occurs, and one valid to the 13th occurs once.
    expect(open(slot('s', 'tue', { validFrom: '2026-10-07', validUntil: '2026-10-12' }))).toBe(0);
    expect(open(slot('s', 'tue', { validFrom: '2026-10-07', validUntil: '2026-10-13' }))).toBe(1);
  });
});

describe('slots that cannot be read are counted, named in the basis, and never open', () => {
  it('a bad weekday, a bad time, a window that does not end after it starts', () => {
    const report = run({
      divisions: [division('d')],
      teams: [team('t', 'd')],
      slots: [
        slot('good', 'tue'),
        slot('bad-day', 'someday'),
        slot('bad-time', 'wed', { startTime: 'later' }),
        slot('backwards', 'thu', { startTime: '18:00:00', endTime: '17:00:00' }),
        slot('empty', 'fri', { startTime: '18:00:00', endTime: '18:00:00' }),
      ],
    });
    expect(report.basis).toMatchObject({ slotsRead: 5, slotsUnreadable: 4, slotsLive: 1 });
    expect(row(report, 'd').slots).toMatchObject({ open: 1, weekdays: ['tue'] });
  });

  it('an unreadable reserved slot does not reserve its division’s other slots away', () => {
    // The run is only given the slots it can place; this one it cannot, so it reserves nothing.
    const report = run({
      divisions: [division('a')],
      teams: [team('t', 'a')],
      slots: [slot('broken', 'someday', { divisionId: 'a' }), slot('open', 'wed')],
    });
    expect(row(report, 'a').slots.weekdays).toEqual(['wed']);
  });
});

describe('capacity is the page’s: at least one, null as one', () => {
  it.each([
    [null, 1],
    [0, 1],
    [1, 1],
    [4, 4],
  ])('a stored capacity of %s counts as %i', (stored, counted) => {
    const report = run({
      divisions: [division('d')],
      teams: [team('t', 'd')],
      slots: [slot('s', 'tue', { capacity: stored })],
    });
    expect(row(report, 'd').slots.capacity).toBe(counted);
  });
});

describe('what saved practices do to room (a held case)', () => {
  const base = { divisions: [division('d')], teams: [team('t', 'd'), team('u', 'd')] };

  it('a saved practice uses a place in its slot, whichever team holds it', () => {
    const report = run({
      divisions: [division('d'), division('other')],
      teams: [team('t', 'd'), team('o', 'other')],
      slots: [slot('s', 'tue', { capacity: 3 })],
      assignments: [saved('r1', 'o', 's')],
    });
    expect(row(report, 'd').slots).toMatchObject({ capacity: 3, room: 2 });
    // The other division's saved row is its own held practice, not d's.
    expect(row(report, 'd').held).toBe(0);
    expect(row(report, 'other').held).toBe(1);
  });

  it('a full slot is no room: held practices do not count as spare places', () => {
    const report = run({
      ...base,
      slots: [slot('s', 'tue', { capacity: 2 })],
      assignments: [saved('r1', 't', 's'), saved('r2', 'u', 's')],
    });
    expect(row(report, 'd')).toMatchObject({
      held: 2,
      stillNeeded: 0,
      slots: { open: 1, capacity: 2, room: 0 },
      verdict: { kind: CAPACITY_VERDICT.SPARE, spare: 0 },
    });
  });

  it('a series that ended before today still counts as held, and no longer fills its slot', () => {
    const report = run({
      ...base,
      slots: [slot('s', 'tue', { capacity: 1 })],
      assignments: [saved('r1', 't', 's', '[2026-09-08,2026-09-30]')],
    });
    expect(row(report, 'd').held).toBe(1);
    expect(row(report, 'd').slots.room).toBe(1);
  });

  it('an open-ended or whole-slot series fills its slot', () => {
    const report = run({
      ...base,
      slots: [slot('a', 'tue'), slot('b', 'wed')],
      assignments: [saved('r1', 't', 'a', '[2026-09-08,)'), saved('r2', 'u', 'b', null)],
    });
    expect(row(report, 'd').slots).toMatchObject({ capacity: 2, room: 0 });
  });

  it('a series live only for part of the weeks still to come fills its slot for that part: the peak decides', () => {
    // Capacity 2; one series covers October, another November. At no date are both live, so the
    // peak is one and one place is spare.
    const report = run({
      ...base,
      slots: [slot('s', 'tue', { capacity: 2 })],
      assignments: [
        saved('r1', 't', 's', '[2026-10-05,2026-10-31]'),
        saved('r2', 'u', 's', '[2026-11-01,2026-11-29]'),
      ],
    });
    expect(row(report, 'd').slots.room).toBe(1);
  });

  it('a range that cannot be read fills the whole slot and is counted, not skipped', () => {
    const report = run({
      ...base,
      slots: [slot('s', 'tue', { capacity: 1 })],
      assignments: [saved('r1', 't', 's', 'not a range')],
    });
    expect(row(report, 'd').slots.room).toBe(0);
    expect(report.basis.unreadableRanges).toBe(1);
  });

  it('a saved practice whose slot is not among the slots read is held and fills nothing', () => {
    const report = run({
      ...base,
      slots: [slot('s', 'tue', { capacity: 1 })],
      assignments: [saved('r1', 't', 'gone'), saved('r2', 'u', null)],
    });
    expect(row(report, 'd')).toMatchObject({ held: 2, slots: { room: 1 } });
  });
});

describe('a 0-a-week division is "none wanted", never short', () => {
  it('whatever its teams and slots are', () => {
    for (const slots of [[], [slot('s', 'tue')]]) {
      const report = run({
        divisions: [division('none', 0)],
        teams: [team('a', 'none'), team('b', 'none'), team('c', 'none')],
        assignments: [saved('r1', 'a', 'x')],
        slots,
      });
      expect(row(report, 'none')).toMatchObject({
        teams: 3,
        wanted: 0,
        held: 1,
        stillNeeded: 0,
        // A division that wants nothing uses no slot: none is counted for it, so it adds none to the
        // whole-season line either.
        slots: { open: 0, weekdays: [], capacity: 0, room: 0 },
        verdict: { kind: CAPACITY_VERDICT.NONE_WANTED, short: 0 },
      });
      expect(report.total.slots.open).toBe(0);
    }
  });

  it('a league that wants nothing anywhere has a total that says so, not "0 to spare"', () => {
    const report = run({ divisions: [division('none', 0)], teams: [team('a', 'none')] });
    expect(report.total.verdict.kind).toBe(CAPACITY_VERDICT.NONE_WANTED);
  });
});

describe('short by N, and N to spare', () => {
  const league = (stillNeededTeams, capacity) => ({
    divisions: [division('d')],
    teams: Array.from({ length: stillNeededTeams }, (_, i) => team(`t${i}`, 'd')),
    slots: [slot('s', 'tue', { capacity })],
  });

  it('needing exactly what there is room for is "0 to spare"', () => {
    expect(row(run(league(3, 3)), 'd').verdict).toMatchObject({
      kind: CAPACITY_VERDICT.SPARE,
      spare: 0,
      short: 0,
    });
  });

  it('needing one more than there is room for is "short by 1"', () => {
    expect(row(run(league(4, 3)), 'd').verdict).toMatchObject({
      kind: CAPACITY_VERDICT.SHORT,
      short: 1,
      spare: 0,
    });
  });

  it('room beyond the need is "to spare"', () => {
    expect(row(run(league(2, 5)), 'd').verdict).toMatchObject({
      kind: CAPACITY_VERDICT.SPARE,
      spare: 3,
    });
  });

  it('no slot at all is not a spare count: it is no slot, short by the whole need', () => {
    expect(row(run({ ...league(2, 1), slots: [] }), 'd').verdict).toMatchObject({
      kind: CAPACITY_VERDICT.NO_SLOT,
      reason: PRACTICE_UNPLACED_REASON.NO_LIVE_DATE,
      short: 2,
    });
  });

  it('slots that all ended read "no date left from today", and slots reserved away read "no slot"', () => {
    const ended = run({ ...league(2, 1), slots: [slot('s', 'tue', { validUntil: '2026-09-20' })] });
    expect(row(ended, 'd').verdict.reason).toBe(PRACTICE_UNPLACED_REASON.NO_LIVE_DATE);
    const reserved = run({
      ...league(2, 1),
      slots: [slot('s', 'tue', { divisionId: 'someone-else' })],
    });
    expect(row(reserved, 'd').verdict.reason).toBe(
      RESERVATION_REASON.RESERVED_FOR_ANOTHER_DIVISION
    );
  });
});

describe('why no slot is open: the filter that left the live slots none [plant P4]', () => {
  const league = (slots, minutes = 60) => ({
    divisions: [division('d', 1, minutes)],
    teams: [team('t', 'd')],
    slots,
  });
  const verdictOf = (slots, minutes = 60) => row(run(league(slots, minutes)), 'd').verdict;
  const short45 = (id, day, over = {}) => slot(id, day, { endTime: '17:45:00', ...over });

  it('(a) the live slot of the right length is reserved to another division: that reservation, not practice-length', () => {
    expect(verdictOf([slot('s60', 'tue', { divisionId: 'someone-else' })])).toMatchObject({
      kind: CAPACITY_VERDICT.NO_SLOT,
      reason: RESERVATION_REASON.RESERVED_FOR_ANOTHER_DIVISION,
      short: 1,
    });
  });

  it('(b) every live slot is the wrong length: practice-length', () => {
    expect(verdictOf([short45('a', 'tue'), short45('b', 'wed')])).toMatchObject({
      kind: CAPACITY_VERDICT.NO_SLOT,
      reason: PRACTICE_UNPLACED_REASON.PRACTICE_LENGTH,
    });
  });

  it('(c) mixed: some live slots the wrong length, the ones of the right length reserved to another division: that reservation', () => {
    // A slot of the division's length exists, so "no slot is that long" would be false; what keeps
    // the division off it is the reservation, so that is the reason. The run itself says
    // practice-length here (pinned below), because it tests the length only among the slots left
    // after the reservation; this panel names the filter that actually excluded the right-length slot.
    expect(
      verdictOf([short45('a', 'tue'), slot('s60', 'wed', { divisionId: 'someone-else' })])
    ).toMatchObject({
      kind: CAPACITY_VERDICT.NO_SLOT,
      reason: RESERVATION_REASON.RESERVED_FOR_ANOTHER_DIVISION,
    });
  });

  it('(d) no practice length set and every live slot reserved to another division: that reservation', () => {
    expect(verdictOf([slot('s', 'tue', { divisionId: 'someone-else' })], null)).toMatchObject({
      kind: CAPACITY_VERDICT.NO_SLOT,
      reason: RESERVATION_REASON.RESERVED_FOR_ANOTHER_DIVISION,
    });
  });

  it('(e) no live date outranks everything: a length set, every slot ended, still no-live-date', () => {
    expect(
      verdictOf([
        slot('old', 'tue', { validUntil: '2026-09-20' }),
        short45('old45', 'wed', { validUntil: '2026-09-20' }),
      ])
    ).toMatchObject({
      kind: CAPACITY_VERDICT.NO_SLOT,
      reason: PRACTICE_UNPLACED_REASON.NO_LIVE_DATE,
    });
  });

  it("(f) the division's own reserved slots are all out of date and a live right-length slot is unreserved: its own reservation, not another division's", () => {
    // `reservationRefusal` has two reasons. A division with reserved slots may use only those, so an
    // unreserved slot is refused to it (`outside-division-reservation`) when every one of its own
    // is out of date; nothing is reserved to another division here, and saying so sends the admin to
    // the wrong fix (Codex, #711).
    expect(
      verdictOf([
        slot('own', 'tue', { divisionId: 'd', validUntil: '2026-09-29' }),
        slot('open', 'wed'),
      ])
    ).toMatchObject({
      kind: CAPACITY_VERDICT.NO_SLOT,
      reason: RESERVATION_REASON.OUTSIDE_DIVISION_RESERVATION,
      short: 1,
    });
  });

  it("(f2) the same with no practice length set, and with the division's own reserved slot live but the wrong length", () => {
    expect(
      verdictOf(
        [slot('own', 'tue', { divisionId: 'd', validUntil: '2026-09-29' }), slot('open', 'wed')],
        null
      ).reason
    ).toBe(RESERVATION_REASON.OUTSIDE_DIVISION_RESERVATION);
    // Its own reserved slot is live but 45 minutes: not a slot of its length, so it may use only
    // that and the unreserved 60-minute slot is closed to it.
    expect(
      verdictOf([short45('own', 'tue', { divisionId: 'd' }), slot('open', 'wed')]).reason
    ).toBe(RESERVATION_REASON.OUTSIDE_DIVISION_RESERVATION);
  });

  it("(g) both reasons among the right-length live slots: one slot reserved to another division, one closed by the division's own reservation", () => {
    expect(
      verdictOf([
        slot('other', 'tue', { divisionId: 'someone-else' }),
        slot('own', 'wed', { divisionId: 'd', validUntil: '2026-09-29' }),
        slot('open', 'thu'),
      ])
    ).toMatchObject({
      kind: CAPACITY_VERDICT.NO_SLOT,
      reason: CAPACITY_NO_SLOT_REASON.RESERVATIONS_MIXED,
    });
  });

  it('priority: a wrong-length live slot is refused for its length before its reservation, so it never reads as a reservation', () => {
    expect(verdictOf([short45('x', 'tue', { divisionId: 'someone-else' })])).toMatchObject({
      reason: PRACTICE_UNPLACED_REASON.PRACTICE_LENGTH,
    });
    // Only the right-length live slots decide between the reservation reasons.
    expect(
      verdictOf([
        short45('wrong', 'tue', { divisionId: 'someone-else' }),
        slot('right', 'wed', { divisionId: 'someone-else-too' }),
      ]).reason
    ).toBe(RESERVATION_REASON.RESERVED_FOR_ANOTHER_DIVISION);
  });

  it('the control: the same right-length slot, not reserved, is open (no reason at all)', () => {
    expect(verdictOf([slot('s60', 'tue')])).toMatchObject({ kind: CAPACITY_VERDICT.SPARE });
  });

  it('pinned difference from the run: for (a) and (c) the solver reports practice-length, the panel says more', async () => {
    // The solver's reason is derived from the slots left after the reservation, so a right-length
    // slot reserved away reads there as "no slot is that long" (`explainUnplaced`,
    // `auto-scheduler-solver.ts`). The panel deliberately does not copy that. If the solver is made
    // precise, this fails and the panel and the run are to be aligned on purpose.
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    const edgeSlot = (id, day, minutes) => {
      const start = new Date(Date.UTC(2026, 8, 7 + day, 16, 0, 0));
      return {
        id,
        day: days[day],
        start,
        end: new Date(start.getTime() + minutes * 60_000),
        capacity: 1,
      };
    };
    /**
     * @param {any[]} slots
     * @param {string[]} reservedIds
     */
    const solverReason = async (slots, reservedIds) => {
      const t = {
        ...prepareTeam({ id: 't', division: 'U10', coachId: 'c' }),
        practicesPerWeek: 1,
        practiceMinutes: 60,
      };
      const applied = applySlotReservations([t], slots, {
        slotDivision: new Map(
          slots.map((x) => [x.id, reservedIds.includes(x.id) ? 'other' : null])
        ),
        teamDivision: new Map([['t', 'mine']]),
        reservedDivisionIds: new Set(['other']),
      });
      const result = await runPracticeOptimizer({
        teams: applied.teams,
        slots: applied.slots,
        locked: [],
        placeableTeamIds: ['t'],
        unitsNeeded: { t: 1 },
        dating: seasonLongDating(slots, toDaylightSlot, {
          timeZone: 'UTC',
          until: '2026-11-30',
          liveFrom: '2026-09-01',
        }),
        config: { timeBudgetMs: 5000, maxIterations: 100, seed: 7 },
      });
      return result.unassigned.map((u) => u.reason);
    };
    const a = [edgeSlot('wed60', 2, 60)];
    const c = [edgeSlot('mon45', 0, 45), edgeSlot('wed60', 2, 60)];
    expect(await solverReason(a, ['wed60'])).toEqual(['practice-length']);
    expect(await solverReason(c, ['wed60'])).toEqual(['practice-length']);
  });
});

describe('the total row counts a slot once [plant P2]', () => {
  // Two divisions that may use the same one-slot, three-place room (capacity 3), each needing 3.
  const shared = {
    divisions: [division('a'), division('b')],
    teams: [
      team('a1', 'a'),
      team('a2', 'a'),
      team('a3', 'a'),
      team('b1', 'b'),
      team('b2', 'b'),
      team('b3', 'b'),
    ],
    slots: [slot('shared', 'tue', { capacity: 3 })],
  };

  it('the slot is in each division’s row and once in the total', () => {
    const report = run(shared);
    expect(row(report, 'a').slots).toMatchObject({ open: 1, capacity: 3, room: 3 });
    expect(row(report, 'b').slots).toMatchObject({ open: 1, capacity: 3, room: 3 });
    expect(report.total.slots).toEqual({ open: 1, inRows: 2, capacity: 3, room: 3 });
  });

  it('each row alone says "0 to spare" and the total says "short by 3": the rows do not add up to the total', () => {
    const report = run(shared);
    expect(row(report, 'a').verdict).toMatchObject({ kind: CAPACITY_VERDICT.SPARE, spare: 0 });
    expect(row(report, 'b').verdict).toMatchObject({ kind: CAPACITY_VERDICT.SPARE, spare: 0 });
    expect(report.total.stillNeeded).toBe(6);
    expect(report.total.verdict).toMatchObject({
      kind: CAPACITY_VERDICT.SHORT,
      short: 3,
      spare: 0,
    });
  });

  it('a slot open to no division is in no row and not in the total, and the basis says how many', () => {
    const report = run({
      ...shared,
      slots: [...shared.slots, slot('nobody', 'wed', { divisionId: 'someone-else' })],
    });
    expect(report.total.slots.open).toBe(1);
    expect(report.basis).toMatchObject({
      slotsRead: 2,
      slotsLive: 2,
      slotsOpenToSomeDivision: 1,
      slotsOpenToNoDivision: 1,
    });
  });

  it('three divisions over two shared slots: the total is the union, not the sum', () => {
    const report = run({
      divisions: [division('a'), division('b'), division('c')],
      teams: [team('a1', 'a'), team('b1', 'b'), team('c1', 'c')],
      slots: [slot('s1', 'tue', { capacity: 2 }), slot('s2', 'thu', { capacity: 1 })],
    });
    expect(report.total.slots).toEqual({ open: 2, inRows: 6, capacity: 3, room: 3 });
  });
});

describe('divisions are listed by name, numbers in order', () => {
  it('U8 before U10, ties by id', () => {
    const report = run({
      divisions: [
        division('2', 1, null, 'U10'),
        division('1', 1, null, 'U8'),
        division('3', 1, null, 'U8'),
      ],
    });
    expect(report.divisions.map((d) => d.divisionId)).toEqual(['1', '3', '2']);
  });
});

describe('the input and the report are schemas (trust boundary)', () => {
  const good = () => ({
    liveFrom: LIVE_FROM,
    season: SEASON,
    divisions: [division('d', 2, 60)],
    teams: [team('t', 'd')],
    slots: [slot('s', 'tue')],
    assignments: [],
  });

  it('accepts a well-formed input', () => {
    expect(CapacityDemandInputSchema.safeParse(good()).success).toBe(true);
  });

  it.each([
    ['a practices-a-week above seven', (i) => (i.divisions[0].practicesPerWeek = 8)],
    ['a negative practices-a-week', (i) => (i.divisions[0].practicesPerWeek = -1)],
    ['a fractional practices-a-week', (i) => (i.divisions[0].practicesPerWeek = 1.5)],
    ['a practice length under 15 minutes', (i) => (i.divisions[0].practiceMinutes = 10)],
    ['a practice length over 240 minutes', (i) => (i.divisions[0].practiceMinutes = 300)],
    ['a today that is not a date', (i) => (i.liveFrom = '2026-02-30')],
    ['a today in another spelling', (i) => (i.liveFrom = '10/05/2026')],
    ['two divisions with one id', (i) => i.divisions.push(division('d', 1))],
    ['two teams with one id', (i) => i.teams.push(team('t', 'd'))],
    ['two slots with one id', (i) => i.slots.push(slot('s', 'wed'))],
    ['a team with no id', (i) => (i.teams[0].id = '')],
    ['a slot with a fractional capacity', (i) => (i.slots[0].capacity = 1.5)],
  ])('refuses %s, and the function throws rather than guess', (_label, spoil) => {
    const input = good();
    spoil(input);
    expect(CapacityDemandInputSchema.safeParse(input).success).toBe(false);
    expect(() => buildCapacityDemand(input)).toThrow();
  });

  it('the report it returns parses against the report schema, and a tampered one does not', () => {
    const report = buildCapacityDemand(good());
    expect(CapacityDemandReportSchema.safeParse(report).success).toBe(true);
    const negative = structuredClone(report);
    negative.divisions[0].stillNeeded = -1;
    expect(CapacityDemandReportSchema.safeParse(negative).success).toBe(false);
    const stranger = structuredClone(report);
    /** @type {any} */ (stranger.divisions[0].verdict).kind = 'fine';
    expect(CapacityDemandReportSchema.safeParse(stranger).success).toBe(false);
  });
});

describe('rows from the tables become the input', () => {
  it('maps the stored columns, and a column a row lacks reads as none', () => {
    const input = capacityDemandInputFromRows({
      liveFrom: LIVE_FROM,
      season: { season_start: '2026-09-07', season_end: '2026-11-29' },
      divisions: [{ id: 'd', name: 'U9', practices_per_week: 2, practice_minutes: null }],
      teams: [{ id: 't', division_id: 'd' }],
      practiceSlots: [
        {
          id: 's',
          day_of_week: 'tue',
          start_time: '17:00:00',
          end_time: '18:00:00',
          capacity: 2,
          valid_from: '2026-09-01',
          valid_until: '2026-11-30',
          division_id: 'd',
        },
        // A row the select gave fewer columns of: the rest are none, not undefined.
        { id: 's2', day_of_week: 'wed', start_time: '17:00:00', end_time: '18:00:00' },
      ],
      practiceAssignments: [{ id: 'r', teamId: 't', slotId: 's', effectiveDateRange: null }],
    });
    expect(input).toEqual({
      liveFrom: LIVE_FROM,
      season: SEASON,
      divisions: [{ id: 'd', name: 'U9', practicesPerWeek: 2, practiceMinutes: null }],
      teams: [{ id: 't', divisionId: 'd' }],
      slots: [
        {
          id: 's',
          dayOfWeek: 'tue',
          startTime: '17:00:00',
          endTime: '18:00:00',
          capacity: 2,
          validFrom: '2026-09-01',
          validUntil: '2026-11-30',
          divisionId: 'd',
        },
        {
          id: 's2',
          dayOfWeek: 'wed',
          startTime: '17:00:00',
          endTime: '18:00:00',
          capacity: null,
          validFrom: null,
          validUntil: null,
          divisionId: null,
        },
      ],
      assignments: [{ id: 'r', teamId: 't', slotId: 's', effectiveDateRange: null }],
    });
    expect(CapacityDemandInputSchema.safeParse(input).success).toBe(true);
  });

  it('a season row with no dates is a season with none', () => {
    const input = capacityDemandInputFromRows({
      liveFrom: LIVE_FROM,
      season: { season_start: null },
      divisions: [],
      teams: [],
      practiceSlots: [],
      practiceAssignments: [],
    });
    expect(input.season).toEqual({ start: null, end: null });
  });
});
