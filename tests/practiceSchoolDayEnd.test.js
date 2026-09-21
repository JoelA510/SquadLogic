/**
 * `schoolDayEnd` is a constraint the scheduler declares. These tests are about
 * whether it is one.
 *
 * Before this file, six separate inputs disabled it while the run reported
 * success:
 *
 * - no `timezone` at all — every comparison lived inside `if (timezone)` and
 *   the block ended in a bare `return true`;
 * - a `timezone` `Intl` rejects — caught, logged to a `console.error` nothing
 *   collects, then fell through to the same `return true`;
 * - a `schoolDayEnd` that is not a readable wall time — `NaN` bounds, and
 *   every comparison against `NaN` is false;
 * - an empty-string `schoolDayEnd`, which read as the opt-out;
 * - a slot with no `day`, exempted outright;
 * - a zoneless slot `start`, read in the runner's zone rather than the
 *   season's, so the answer depended on `TZ`.
 *
 * All six now refuse, in the season clock's vocabulary. The two timezone arms
 * are additionally held to the same loudness, because an asymmetry between
 * them is what made the original block hard to reason about.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { schedulePractices } from '../packages/core/src/practiceScheduling.js';
import {
  TIMING_REASON,
  TIMING_SEVERITY,
  timingSeverityOf,
} from '../packages/core/src/timing/reasonCodes.js';
import { SeasonClockError } from '../packages/core/src/timing/seasonClock.js';

const teams = [{ id: 't1', division: 'd1' }];

// 2025-01-01 is a Wednesday. PST is UTC-8 in January, so 14:00 local is
// 22:00Z — before a 16:00 school-day end, and therefore the slot the
// constraint must remove. Built as an absolute instant so the runner's own
// TZ cannot change what the test means (LESSONS_LEARNED #21).
const beforeSchoolEnds = {
  id: 's-early',
  start: new Date('2025-01-01T22:00:00Z'),
  end: new Date('2025-01-01T23:00:00Z'),
  capacity: 1,
  day: 'Wednesday',
};
const afterSchoolEnds = {
  id: 's-late',
  start: new Date('2025-01-02T01:00:00Z'), // 17:00 America/Los_Angeles
  end: new Date('2025-01-02T02:00:00Z'),
  capacity: 1,
  day: 'Wednesday',
};

const run = (overrides) =>
  schedulePractices({
    teams,
    slots: [beforeSchoolEnds, afterSchoolEnds],
    schoolDayEnd: '16:00',
    ...overrides,
  });

describe('schoolDayEnd is enforced or refused, never skipped', () => {
  it('removes a pre-school-end slot when the season has a clock', () => {
    const result = run({ timezone: 'America/Los_Angeles' });

    const assignment = result.assignments.find((a) => a.teamId === 't1');
    assert.ok(assignment, 'the team should still be placed');
    assert.equal(
      assignment.slotId,
      's-late',
      'the 14:00 slot is before the school day ends and must not be offered'
    );
  });

  it('refuses a run whose timezone is missing', () => {
    // The default path. This used to return a full schedule with the team in
    // the 14:00 slot: the constraint was asked for and silently not applied.
    assert.throws(
      () => run({}),
      (error) => {
        assert.ok(error instanceof SeasonClockError, 'expected a SeasonClockError');
        assert.equal(error.code, TIMING_REASON.SEASON_TIMEZONE_MISSING);
        return true;
      }
    );
  });

  it('refuses a run whose timezone this runtime does not know', () => {
    // The twin arm. It was the quietest of the three — a `console.error`
    // nothing collects — and disabled the constraint just as completely.
    assert.throws(
      () => run({ timezone: 'Americas/New_York' }),
      (error) => {
        assert.ok(error instanceof SeasonClockError, 'expected a SeasonClockError');
        assert.equal(error.code, TIMING_REASON.SEASON_TIMEZONE_UNKNOWN);
        return true;
      }
    );
  });

  it('refuses a schoolDayEnd that is not a readable wall time', () => {
    // `''` is in this list, not the opt-out list: a cleared `school_day_end`
    // field must not disable the constraint silently. `24:00` is midnight
    // ending the day and is accepted below; `24:30`/`24:00:30` name no
    // instant, which is `timing/seasonClock.js`'s ruling, not a new one.
    for (const schoolDayEnd of ['16h00', '', '   ', '99:00', '16:99', '24:30', '24:00:30']) {
      assert.throws(
        () => run({ schoolDayEnd, timezone: 'America/Los_Angeles' }),
        (error) => {
          assert.ok(error instanceof SeasonClockError, `expected a refusal for ${schoolDayEnd}`);
          assert.equal(error.code, TIMING_REASON.WALL_TIME_UNREADABLE);
          return true;
        },
        `schoolDayEnd "${schoolDayEnd}" was accepted`
      );
    }
  });

  it('accepts the HH:MM:SS shape Postgres hands back for a time column', () => {
    // `season_settings.school_day_end` is a `time`, so this is the ordinary
    // production value, not an edge case.
    const result = run({ schoolDayEnd: '16:00:00', timezone: 'America/Los_Angeles' });
    assert.equal(result.assignments.find((a) => a.teamId === 't1')?.slotId, 's-late');
  });

  it('refuses a slot whose start the filter cannot read, naming the slot', () => {
    // This reached `formatToParts`, threw into the swallowing catch and
    // passed the slot. `SlotSchema` rejects it too, but only further down —
    // by then the constraint had already been skipped for every other slot.
    assert.throws(
      () =>
        schedulePractices({
          teams,
          slots: [{ ...beforeSchoolEnds, id: 's-broken', start: 'not-a-time' }],
          schoolDayEnd: '16:00',
          timezone: 'America/Los_Angeles',
        }),
      (error) => {
        assert.ok(error instanceof SeasonClockError, 'expected a SeasonClockError');
        assert.equal(error.code, TIMING_REASON.WALL_TIME_UNREADABLE);
        assert.match(error.message, /s-broken/, 'the refusal must name the slot');
        return true;
      }
    );
  });

  it('refuses a zoneless slot start rather than reading it in the host zone', () => {
    // `Number.isNaN(getTime())` cannot see this one: a naive string parses,
    // in the RUNNER's zone, so the answer depended on `TZ`. Under `TZ=UTC`
    // the 14:00 slot was quietly dropped as if it were 14:00Z; the value is
    // the one `InstantSchema` exists to refuse, reached before it.
    assert.throws(
      () =>
        schedulePractices({
          teams,
          slots: [{ ...beforeSchoolEnds, id: 's-naive', start: '2025-01-01T14:00:00' }],
          schoolDayEnd: '16:00',
          timezone: 'America/Los_Angeles',
        }),
      (error) => {
        assert.ok(error instanceof SeasonClockError, 'expected a SeasonClockError');
        assert.equal(error.code, TIMING_REASON.WALL_TIME_UNREADABLE);
        assert.match(error.message, /s-naive/, 'the refusal must name the slot');
        return true;
      }
    );
  });

  it('refuses a slot with no weekday instead of exempting it', () => {
    // `day` is optional in `SlotSchema`, and a slot without one cannot be
    // shown to fall outside Mon-Thu. Passing it was a per-slot hole in the
    // constraint the rest of this function refuses to leave.
    assert.throws(
      () =>
        schedulePractices({
          teams,
          slots: [{ ...beforeSchoolEnds, id: 's-dayless', day: undefined }],
          schoolDayEnd: '16:00',
          timezone: 'America/Los_Angeles',
        }),
      (error) => {
        assert.ok(error instanceof SeasonClockError, 'expected a SeasonClockError');
        assert.equal(error.code, TIMING_REASON.WALL_TIME_UNREADABLE);
        assert.match(error.message, /s-dayless/, 'the refusal must name the slot');
        return true;
      }
    );
  });

  it('treats an omitted schoolDayEnd as the opt-out, with or without a clock', () => {
    for (const timezone of [undefined, 'America/Los_Angeles']) {
      const result = schedulePractices({
        teams,
        slots: [beforeSchoolEnds, afterSchoolEnds],
        timezone,
      });
      assert.equal(
        result.assignments.length,
        1,
        'not asking for the constraint must not refuse the run'
      );
    }
  });

  it('gives the two timezone arms the same loudness', () => {
    // The asymmetry is the defect, so it gets its own assertion rather than
    // being implied by the two cases above passing.
    const arms = [{}, { timezone: 'Americas/New_York' }].map((overrides) => {
      try {
        run(overrides);
        return null;
      } catch (error) {
        return error;
      }
    });

    assert.ok(
      arms.every((error) => error instanceof SeasonClockError),
      'one arm refused and the other did not'
    );
    assert.notEqual(arms[0].code, arms[1].code, 'the two arms must stay distinguishable');
    for (const error of arms) {
      assert.equal(
        timingSeverityOf(error.code),
        TIMING_SEVERITY.BLOCKING,
        `${error.code} is not BLOCKING, so one arm is quieter than the other`
      );
      assert.ok(error.findings.length > 0, `${error.code} carries no finding`);
      assert.equal(error.findings[0].code, error.code);
    }
  });
});
