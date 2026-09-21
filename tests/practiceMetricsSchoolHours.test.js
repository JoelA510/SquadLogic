/**
 * The solver refuses these inputs; the evaluator called them clean.
 *
 * `schedulePractices` has refused an unevaluable `schoolDayEnd` since #420.
 * `evaluatePracticeSchedule` measures the schedule that solver produces, and
 * guarded the same constraint with `if (schoolDayEnd && timezone && slot.start)`.
 * Two ways past that guard published a report whose `dataQualityWarnings` was
 * empty — which reads, to `PracticeReadinessPanel` and to
 * `scheduler_runs.results`, as "checked, no violations":
 *
 * - **no `timezone`, or a falsy one** — the guard was false and the block
 *   never ran;
 * - **an unreadable `schoolDayEnd`** — the guard was true,
 *   `split(':').map(Number)` gave `NaN` bounds, and every comparison against
 *   `NaN` is false, so no assignment could violate it.
 *
 * A third class was **not** silent and is the reason this is a change of
 * spelling rather than of kind: a truthy zone string `Intl` rejects (`'   '`,
 * `'Americas/New_York'`) passed the guard and threw a bare `RangeError` out of
 * `toLocaleString`, mid-loop, in the runtime's own words and with no reason
 * code. The function already refused part of this input space. The fix is that
 * all of it refuses, by name, in the vocabulary `schedulePractices` uses —
 * rather than one arm being singled out for honesty.
 *
 * These tests are therefore about two things, and the second is the one that
 * rots: that the constraint refuses when it cannot be evaluated, and that an
 * empty `dataQualityWarnings` still *means* something — that the check ran
 * and found nothing. Every refusal case below is paired with a positive
 * control that makes the same assertion fail, because a coverage assertion
 * that cannot be made to fail is not one (CLAUDE.md, Phase 2 review).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { evaluatePracticeSchedule } from '../packages/core/src/practiceMetrics.js';
import { schedulePractices } from '../packages/core/src/practiceScheduling.js';
import { TIMING_REASON } from '../packages/core/src/timing/reasonCodes.js';
import { SeasonClockError } from '../packages/core/src/timing/seasonClock.js';

const teams = [{ id: 't1', division: 'd1' }];

// 2025-01-01 is a Wednesday. `America/Los_Angeles` is UTC-8 in January, so
// 22:00Z is 14:00 local — inside the school day and therefore the assignment
// the check must report. Absolute instants, so the runner's own TZ cannot
// change what these tests mean (LESSONS_LEARNED #21).
const insideSchoolHours = {
  id: 's-early',
  baseSlotId: 'b1',
  start: new Date('2025-01-01T22:00:00Z'),
  end: new Date('2025-01-01T23:00:00Z'),
  capacity: 1,
  day: 'Wednesday',
};
const afterSchoolHours = {
  id: 's-late',
  baseSlotId: 'b2',
  start: new Date('2025-01-02T01:00:00Z'), // 17:00 America/Los_Angeles
  end: new Date('2025-01-02T02:00:00Z'),
  capacity: 1,
  day: 'Wednesday',
};

const ZONE = 'America/Los_Angeles';

/**
 * Evaluate one assignment; `slotId` picks which of the two slots it takes and
 * everything else overrides the evaluator's arguments.
 *
 * @param {{ slotId?: string, schoolDayEnd?: string|null, timezone?: string }} [params]
 */
const evaluate = ({ slotId = 's-early', ...overrides } = {}) =>
  evaluatePracticeSchedule({
    assignments: [{ teamId: 't1', slotId }],
    teams,
    slots: [insideSchoolHours, afterSchoolHours],
    schoolDayEnd: '16:00',
    timezone: ZONE,
    ...overrides,
  });

const schoolHoursWarnings = (report) =>
  report.dataQualityWarnings.filter((warning) => warning.includes('violates school hours'));

/**
 * The error a call threw, or `null` if it returned.
 *
 * @param {() => unknown} fn
 * @returns {any}
 */
const refusalFrom = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
};

/* -------------------------------------------------------------------------- */
/* The check runs at all — the control every "no violations" claim rests on.   */
/* -------------------------------------------------------------------------- */

describe('the school-hours check is exercised, not merely present', () => {
  it('reports an assignment inside school hours', () => {
    // Without this, every assertion below is satisfied by a check that never
    // runs — which is exactly the defect, so it is asserted first.
    const warnings = schoolHoursWarnings(evaluate());
    assert.equal(warnings.length, 1, 'the 14:00 Wednesday assignment must be reported');
    assert.match(warnings[0], /team t1 violates school hours \(starts at 14:00/);
    assert.match(warnings[0], /limit is 16:00/);
  });

  it('reports nothing for an assignment after school hours', () => {
    // The other half of the control: the check can also come back clean, so
    // "one warning" above is a measurement rather than a constant.
    assert.deepEqual(schoolHoursWarnings(evaluate({ slotId: 's-late' })), []);
  });

  it('reports nothing on Friday, Saturday or Sunday', () => {
    // 2025-01-03 is a Friday; 21:00Z is 13:00 local, well inside the school
    // day, and exempt only because of the weekday. Proves the Mon-Thu window
    // is read from the instant rather than assumed.
    const friday = {
      id: 's-fri',
      baseSlotId: 'b3',
      start: new Date('2025-01-03T21:00:00Z'),
      end: new Date('2025-01-03T22:00:00Z'),
      capacity: 1,
      day: 'Friday',
    };
    const report = evaluatePracticeSchedule({
      assignments: [{ teamId: 't1', slotId: 's-fri' }],
      teams,
      slots: [friday],
      schoolDayEnd: '16:00',
      timezone: ZONE,
    });
    assert.deepEqual(schoolHoursWarnings(report), []);
  });

  it('reads the weekday and the hour in the season zone, not the host zone', () => {
    // 2025-01-03T04:00:00Z is Friday 04:00 UTC and Thursday 20:00 in
    // `America/Los_Angeles`. A host-zone reading calls it Friday and exempts
    // it; the season's clock calls it a Thursday evening, after 16:00, and
    // also exempts it — so the two agree on the outcome and disagree on the
    // reason. Moving the bound to 21:00 separates them: only the season-zone
    // reading can report it.
    const thursdayEvening = {
      id: 's-thu-pm',
      baseSlotId: 'b4',
      start: new Date('2025-01-03T04:00:00Z'),
      end: new Date('2025-01-03T05:00:00Z'),
      capacity: 1,
      day: 'Thursday',
    };
    const report = evaluatePracticeSchedule({
      assignments: [{ teamId: 't1', slotId: 's-thu-pm' }],
      teams,
      slots: [thursdayEvening],
      schoolDayEnd: '21:00',
      timezone: ZONE,
    });
    assert.equal(schoolHoursWarnings(report).length, 1, 'Thursday 20:00 local is before 21:00');
    assert.match(schoolHoursWarnings(report)[0], /starts at 20:00/);
  });
});

/* -------------------------------------------------------------------------- */
/* The silent-pass paths                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One table, both arms. The subject set is stated here rather than derived
 * from either engine's output, so a regression that stops refusing cannot
 * also shrink the list of things it was supposed to refuse.
 */
const UNEVALUABLE = [
  {
    label: 'no timezone at all',
    args: { schoolDayEnd: '16:00', timezone: undefined },
    code: TIMING_REASON.SEASON_TIMEZONE_MISSING,
    wasSilent: true,
  },
  {
    label: 'a blank timezone',
    args: { schoolDayEnd: '16:00', timezone: '   ' },
    // `'   '` is truthy, so this passed the old guard and threw a bare
    // `RangeError` from `toLocaleString`. It refuses as MISSING rather than
    // UNKNOWN because `resolveSchoolDayEndFilter` trims first — one answer,
    // and the same one the solver gives.
    code: TIMING_REASON.SEASON_TIMEZONE_MISSING,
    wasSilent: false,
  },
  {
    label: 'a zone this runtime does not know',
    args: { schoolDayEnd: '16:00', timezone: 'Americas/New_York' },
    code: TIMING_REASON.SEASON_TIMEZONE_UNKNOWN,
    // Not silent before the fix — a bare, uncoded `RangeError`.
    wasSilent: false,
  },
  {
    label: 'a schoolDayEnd that is not a wall time',
    args: { schoolDayEnd: '16h00', timezone: ZONE },
    code: TIMING_REASON.WALL_TIME_UNREADABLE,
    wasSilent: true,
  },
  {
    label: 'an hours-only schoolDayEnd',
    args: { schoolDayEnd: '16', timezone: ZONE },
    code: TIMING_REASON.WALL_TIME_UNREADABLE,
    wasSilent: true,
  },
  {
    label: 'an out-of-range schoolDayEnd',
    args: { schoolDayEnd: '16:99', timezone: ZONE },
    code: TIMING_REASON.WALL_TIME_UNREADABLE,
    wasSilent: true,
  },
  {
    label: 'a schoolDayEnd past the end of the day',
    args: { schoolDayEnd: '24:30', timezone: ZONE },
    code: TIMING_REASON.WALL_TIME_UNREADABLE,
    wasSilent: true,
  },
  {
    label: 'a cleared schoolDayEnd arriving as an empty string',
    args: { schoolDayEnd: '', timezone: ZONE },
    code: TIMING_REASON.WALL_TIME_UNREADABLE,
    wasSilent: true,
  },
  {
    label: 'a whitespace-only schoolDayEnd',
    args: { schoolDayEnd: '   ', timezone: ZONE },
    code: TIMING_REASON.WALL_TIME_UNREADABLE,
    wasSilent: true,
  },
];

describe('the evaluator refuses what it cannot check', () => {
  it('the vector table is populated, distinct, and covers all three codes', () => {
    // Meta-assertion on the table itself: `it.each` over an empty or
    // collapsed table passes vacuously, and the table is what every case
    // below is enumerated from.
    assert.ok(UNEVALUABLE.length >= 9, `expected the full table, saw ${UNEVALUABLE.length}`);
    const keys = new Set(UNEVALUABLE.map((v) => `${v.args.schoolDayEnd}|${v.args.timezone}`));
    assert.equal(keys.size, UNEVALUABLE.length, 'every vector must be a distinct input pair');
    assert.deepEqual(
      [...new Set(UNEVALUABLE.map((v) => v.code))].sort(),
      [
        TIMING_REASON.SEASON_TIMEZONE_MISSING,
        TIMING_REASON.SEASON_TIMEZONE_UNKNOWN,
        TIMING_REASON.WALL_TIME_UNREADABLE,
      ].sort()
    );
    // Both halves of the space must stay represented. A table that drifted to
    // all-silent would stop covering the uncoded-`RangeError` arm; one that
    // drifted to none-silent would stop covering the defect this fixes.
    assert.equal(
      UNEVALUABLE.filter((v) => v.wasSilent).length,
      7,
      'the seven inputs that used to return an empty warning list'
    );
    assert.equal(
      UNEVALUABLE.filter((v) => !v.wasSilent).length,
      2,
      'the two inputs that used to throw a bare, uncoded RangeError'
    );
  });

  it.each(UNEVALUABLE)('refuses $label by name', ({ args, code }) => {
    const error = refusalFrom(() => evaluate(args));
    assert.ok(
      error instanceof SeasonClockError,
      `expected a SeasonClockError, got ${error?.name ?? 'a returned report'}: ${error?.message ?? ''}`
    );
    assert.equal(error.code, code);
    assert.ok(error.findings?.length > 0, 'the refusal must carry a finding');
  });

  it.each(UNEVALUABLE)('does not report $label as a clean schedule', ({ args }) => {
    // The assertion the defect failed, stated directly: whatever happens, the
    // one thing this function must never do with these inputs is hand back a
    // report. Held separately from the code assertion above so that a future
    // change from a throw to a finding still has to satisfy it.
    let report = null;
    try {
      report = evaluate(args);
    } catch {
      return;
    }
    assert.fail(
      `a report was returned with dataQualityWarnings ${JSON.stringify(report.dataQualityWarnings)} ` +
        'for a schedule whose school-hours constraint could not be evaluated'
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The opt-out still works                                                     */
/* -------------------------------------------------------------------------- */

describe('omitting schoolDayEnd is the opt-out', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
  ])('%s opts out, with or without a clock', (_label, schoolDayEnd) => {
    for (const timezone of [ZONE, undefined]) {
      const report = evaluate({ schoolDayEnd, timezone });
      assert.deepEqual(
        schoolHoursWarnings(report),
        [],
        'an opted-out run reports no school-hours violations'
      );
      assert.equal(report.summary.assignmentsCounted, 1, 'the rest of the report still runs');
    }
  });

  it('accepts the HH:MM:SS shape Postgres hands back for a time column', () => {
    // `season_settings.school_day_end` is a `time`, so this is the ordinary
    // production value and must not land in the refusal table above.
    assert.equal(schoolHoursWarnings(evaluate({ schoolDayEnd: '16:00:00' })).length, 1);
  });
});

/* -------------------------------------------------------------------------- */
/* Solver and evaluator agree about which inputs are evaluable                 */
/* -------------------------------------------------------------------------- */

describe('the two arms answer the same question the same way', () => {
  // The asymmetry is the defect: the solver refusing an input the evaluator
  // reports clean is how a falsely-clean report reached `scheduler_runs`.
  // Both arms are run over the one table above, so neither arm's set can be
  // derived from the other's.
  it.each(UNEVALUABLE)(
    'schedulePractices and evaluatePracticeSchedule both refuse $label',
    ({ args, code }) => {
      const solverError = refusalFrom(() =>
        schedulePractices({
          teams,
          slots: [insideSchoolHours, afterSchoolHours],
          ...args,
        })
      );
      const evaluatorError = refusalFrom(() => evaluate(args));
      assert.ok(solverError instanceof SeasonClockError, 'the solver arm must refuse');
      assert.ok(evaluatorError instanceof SeasonClockError, 'the evaluator arm must refuse');
      assert.equal(solverError.code, code, 'the solver arm');
      assert.equal(evaluatorError.code, code, 'the evaluator arm');
    }
  );

  it('both arms accept the input the other accepts', () => {
    // The falsifier for the pair above: if either arm refused everything,
    // these two calls would throw and the agreement would be vacuous.
    const scheduled = schedulePractices({
      teams,
      slots: [insideSchoolHours, afterSchoolHours],
      schoolDayEnd: '16:00',
      timezone: ZONE,
    });
    assert.equal(
      scheduled.assignments.find((a) => a.teamId === 't1')?.slotId,
      's-late',
      'the solver removes the in-school-hours slot'
    );
    assert.equal(
      schoolHoursWarnings(evaluate({ slotId: 's-early' })).length,
      1,
      'the evaluator reports the in-school-hours assignment the solver would not have made'
    );
  });
});
