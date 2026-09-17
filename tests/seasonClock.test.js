import { describe, it, expect } from 'vitest';
import {
  SeasonClockError,
  anchorToSeasonClock,
  isNaiveDateTime,
  requireZonedInstant,
  resolveZonedInstant,
} from '../packages/core/src/timing/seasonClock.js';
import {
  TIMING_REASON,
  TIMING_REASON_SEVERITY,
  TIMING_SEVERITY,
  timingSeverityOf,
} from '../packages/core/src/timing/index.js';

/**
 * Run `fn` with the process pretending to sit in `zone`.
 *
 * Node re-reads `process.env.TZ` on the next `Date`/`Intl` operation, which is
 * what lets one test file stand in for three browsers. Executed check that it
 * really does: `browserZonesDisagreeOnANaiveString` below.
 */
function inHostZone(zone, fn) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

/**
 * The control for `inHostZone` itself.
 *
 * Every zone-independence assertion in this file is worthless if the harness
 * cannot actually move the host zone — the assertions would pass by all three
 * "browsers" being the same browser. This proves the opposite directly: the
 * unfixed operation (`new Date` on a naive string) must still disagree across
 * the three zones. If this ever goes green-by-agreement, the zone-independence
 * tests below have stopped testing anything.
 */
function browserZonesDisagreeOnANaiveString() {
  return new Set(
    ['UTC', 'America/Los_Angeles', 'America/New_York'].map((zone) =>
      inHostZone(zone, () => new Date('2026-11-07T16:44:00').toISOString())
    )
  );
}

describe('seasonClock: the harness that the zone tests stand on', () => {
  it('can actually move the host zone (control for inHostZone)', () => {
    const spread = browserZonesDisagreeOnANaiveString();
    expect(spread.size).toBe(3);
    expect(spread).toContain('2026-11-07T16:44:00.000Z');
    expect(spread).toContain('2026-11-08T00:44:00.000Z');
    expect(spread).toContain('2026-11-07T21:44:00.000Z');
  });
});

describe('seasonClock: composing a wall time onto the season clock', () => {
  it('places a plain wall time on the season zone, not the host zone', () => {
    const { iso, findings } = resolveZonedInstant({
      date: '2026-11-07',
      time: '16:44:00',
      timeZone: 'America/New_York',
    });
    expect(iso).toBe('2026-11-07T16:44:00-05:00');
    expect(new Date(/** @type {string} */ (iso)).toISOString()).toBe('2026-11-07T21:44:00.000Z');
    expect(findings).toEqual([]);
  });

  it('gives the same instant from every host zone', () => {
    const results = ['UTC', 'America/Los_Angeles', 'America/New_York', 'Australia/Sydney'].map(
      (zone) =>
        inHostZone(zone, () => {
          const { iso } = resolveZonedInstant({
            date: '2026-11-07',
            time: '16:44:00',
            timeZone: 'America/New_York',
          });
          return new Date(/** @type {string} */ (iso)).toISOString();
        })
    );
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe('2026-11-07T21:44:00.000Z');
  });

  it('reads the season zone rather than ignoring it', () => {
    // The positive control for the assertion above. A composer that dropped
    // `timeZone` on the floor and parsed as UTC would satisfy "16:44 UTC is
    // 16:44Z"; it cannot also satisfy "16:44 New York is 21:44Z".
    const utc = resolveZonedInstant({ date: '2026-11-07', time: '16:44', timeZone: 'UTC' });
    const newYork = resolveZonedInstant({
      date: '2026-11-07',
      time: '16:44',
      timeZone: 'America/New_York',
    });
    const kolkata = resolveZonedInstant({
      date: '2026-11-07',
      time: '16:44',
      timeZone: 'Asia/Kolkata',
    });
    const instants = [utc, newYork, kolkata].map((r) =>
      new Date(/** @type {string} */ (r.iso)).toISOString()
    );
    expect(instants).toEqual([
      '2026-11-07T16:44:00.000Z',
      '2026-11-07T21:44:00.000Z',
      '2026-11-07T11:14:00.000Z',
    ]);
    expect(new Set(instants).size).toBe(3);
  });

  it('reads the clock forms Postgres can hand over', () => {
    // The meta-assertion for the refusals below: a parser that rejected
    // everything would satisfy every "unreadable" case and be useless.
    for (const [time, expected] of [
      ['00:00', '2026-06-13T00:00:00-07:00'],
      ['09:30:00', '2026-06-13T09:30:00-07:00'],
      ['09:30:00.000', '2026-06-13T09:30:00-07:00'],
      ['23:59:59', '2026-06-13T23:59:59-07:00'],
    ]) {
      const { iso, findings } = resolveZonedInstant({
        date: '2026-06-13',
        time,
        timeZone: 'America/Los_Angeles',
      });
      expect(iso, String(time)).toBe(expected);
      expect(findings).toEqual([]);
    }
  });

  it('composes 24:00 as midnight ending the day', () => {
    // Postgres `time` legally stores it, and `game_slots_time_check
    // (end_time > start_time)` permits a 22:00 -> 24:00 slot, so an end time
    // of midnight is data nobody typed wrong. `new Date('...T24:00:00')`
    // composed it on `main`; refusing it here would be a regression dressed
    // as strictness.
    expect(
      resolveZonedInstant({ date: '2026-07-04', time: '24:00:00', timeZone: 'America/New_York' })
        .iso
    ).toBe('2026-07-05T00:00:00-04:00');
    expect(resolveZonedInstant({ date: '2026-07-04', time: '24:00', timeZone: 'UTC' }).iso).toBe(
      '2026-07-05T00:00:00+00:00'
    );
    // The domain spelling of the same thing.
    expect(resolveZonedInstant({ date: '2026-07-04', time: 1440, timeZone: 'UTC' }).iso).toBe(
      '2026-07-05T00:00:00+00:00'
    );
  });

  it('takes the post-transition offset for a 24:00 that rolls across a DST boundary', () => {
    // The one case where hour-24 and daylight saving interact. 2026-11-01
    // 24:00 New York is 2026-11-02 00:00, after the fall-back, so -05:00 and
    // not the -04:00 in force when the day began.
    const { iso, findings } = resolveZonedInstant({
      date: '2026-11-01',
      time: '24:00:00',
      timeZone: 'America/New_York',
    });
    expect(iso).toBe('2026-11-02T00:00:00-05:00');
    expect(new Date(/** @type {string} */ (iso)).toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(findings).toEqual([]);

    // …and the spring-forward side, where the roll lands the day before the gap.
    expect(
      resolveZonedInstant({ date: '2026-03-07', time: '24:00:00', timeZone: 'America/New_York' })
        .iso
    ).toBe('2026-03-08T00:00:00-05:00');
  });

  it('refuses every hour-24 value that is not exactly midnight', () => {
    // The control for the two tests above: an implementation that simply
    // raised the hour ceiling would accept 24:30, which names no instant.
    for (const time of ['24:30', '24:00:01', '24:59:59', '25:00:00']) {
      const { iso, findings } = resolveZonedInstant({
        date: '2026-07-04',
        time,
        timeZone: 'UTC',
      });
      expect(iso, time).toBeNull();
      expect(findings[0].code, time).toBe(TIMING_REASON.WALL_TIME_UNREADABLE);
    }
    expect(resolveZonedInstant({ date: '2026-07-04', time: 1441, timeZone: 'UTC' }).iso).toBeNull();
  });

  it('accepts minutes past midnight as well as a clock reading', () => {
    const fromClock = resolveZonedInstant({
      date: '2026-06-13',
      time: '09:30',
      timeZone: 'America/Los_Angeles',
    });
    const fromMinutes = resolveZonedInstant({
      date: '2026-06-13',
      time: 9 * 60 + 30,
      timeZone: 'America/Los_Angeles',
    });
    expect(fromMinutes.iso).toBe(fromClock.iso);
    expect(fromClock.iso).toBe('2026-06-13T09:30:00-07:00');
  });

  it('carries the seconds a Postgres `time` can hold', () => {
    // Validated-and-dropped is the shape CLAUDE.md names. `16:44:30` composing
    // to `16:44:00` would shift the slot and then be compared against `end`.
    const { iso } = resolveZonedInstant({
      date: '2026-11-07',
      time: '16:44:30',
      timeZone: 'America/New_York',
    });
    expect(iso).toBe('2026-11-07T16:44:30-05:00');
    expect(new Date(/** @type {string} */ (iso)).toISOString()).toBe('2026-11-07T21:44:30.000Z');
  });

  it('reports an unreadable wall reading rather than throwing', () => {
    // These arrive from the database and are read on a render path, so a throw
    // would take a panel down. `24:00:00` is a value Postgres `time` legally
    // stores, so this is reachable from data nobody typed wrong.
    for (const [date, time] of [
      ['13/06/2026', '09:30'],
      ['2026-06-13', '25:70'],
      ['2026-06-13', '24:30:00'],
      ['2026-06-13', '25:00:00'],
      ['2026-06-13', '16:60'],
      ['2026-06-13', 'kickoff'],
      ['2026-06-13', -1],
      [null, '09:30'],
    ]) {
      const { iso, findings } = resolveZonedInstant(
        /** @type {any} */ ({ date, time, timeZone: 'UTC' })
      );
      expect(iso, `${date} ${time}`).toBeNull();
      expect(findings.map((f) => f.code)).toEqual([TIMING_REASON.WALL_TIME_UNREADABLE]);
      expect(findings[0].severity).toBe(TIMING_SEVERITY.BLOCKING);
    }
  });

  it('never throws, for any input at all', () => {
    // The blanket form of the contract, because the JSDoc now states it
    // absolutely. A single reachable throw makes the display layer fragile.
    for (const bad of [undefined, null, 42, {}, [], new Date(), 'nonsense']) {
      const input = /** @type {any} */ ({ date: bad, time: bad, timeZone: bad });
      expect(() => resolveZonedInstant(input)).not.toThrow();
    }
  });
});

describe('seasonClock: daylight saving, by name and date', () => {
  // America/New_York 2026: DST ends 2026-11-01 02:00 EDT -> 01:00 EST, and
  // begins 2026-03-08 02:00 EST -> 03:00 EDT. A youth league does schedule
  // Sunday-morning games on both dates.

  it('fall-back 2026-11-01 01:30 America/New_York is ambiguous and takes the first occurrence', () => {
    const { iso, findings } = resolveZonedInstant({
      date: '2026-11-01',
      time: '01:30',
      timeZone: 'America/New_York',
    });
    // 05:30Z is EDT (UTC-4), the first of the two 01:30s. 06:30Z is EST.
    expect(new Date(/** @type {string} */ (iso)).toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(iso).toBe('2026-11-01T01:30:00-04:00');

    const ambiguous = findings.filter((f) => f.code === TIMING_REASON.WALL_TIME_AMBIGUOUS);
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].severity).toBe(TIMING_SEVERITY.INFO);
    expect(ambiguous[0].details.occurrences).toBe(2);
    expect(ambiguous[0].details.chosenOffsetMinutes).toBe(-240);
    expect(ambiguous[0].details.discardedOffsetMinutes).toBe(-300);
  });

  it('spring-forward 2026-03-08 02:30 America/New_York does not exist and is refused', () => {
    const { iso, findings } = resolveZonedInstant({
      date: '2026-03-08',
      time: '02:30',
      timeZone: 'America/New_York',
    });
    expect(iso).toBeNull();
    expect(findings.map((f) => f.code)).toEqual([TIMING_REASON.WALL_TIME_NONEXISTENT]);
    expect(findings[0].severity).toBe(TIMING_SEVERITY.BLOCKING);
  });

  it('refuses only the skipped hour, not the whole spring-forward day', () => {
    // The meta-assertion for the refusal above: a check that refused every time
    // on 2026-03-08 would pass that test and be useless. These two must compose.
    const before = resolveZonedInstant({
      date: '2026-03-08',
      time: '01:30',
      timeZone: 'America/New_York',
    });
    const after = resolveZonedInstant({
      date: '2026-03-08',
      time: '03:30',
      timeZone: 'America/New_York',
    });
    expect(new Date(/** @type {string} */ (before.iso)).toISOString()).toBe(
      '2026-03-08T06:30:00.000Z'
    );
    expect(new Date(/** @type {string} */ (after.iso)).toISOString()).toBe(
      '2026-03-08T07:30:00.000Z'
    );
    expect(before.findings).toEqual([]);
    expect(after.findings).toEqual([]);
  });

  it('applies the same two rules outside North America', () => {
    const ambiguous = resolveZonedInstant({
      date: '2026-10-25',
      time: '01:30',
      timeZone: 'Europe/London',
    });
    expect(new Date(/** @type {string} */ (ambiguous.iso)).toISOString()).toBe(
      '2026-10-25T00:30:00.000Z'
    );
    expect(ambiguous.findings.map((f) => f.code)).toEqual([TIMING_REASON.WALL_TIME_AMBIGUOUS]);

    const nonexistent = resolveZonedInstant({
      date: '2026-03-29',
      time: '01:30',
      timeZone: 'Europe/London',
    });
    expect(nonexistent.iso).toBeNull();
    expect(nonexistent.findings.map((f) => f.code)).toEqual([TIMING_REASON.WALL_TIME_NONEXISTENT]);
  });

  it('decides daylight saving from the season zone, never the host zone', () => {
    const results = ['UTC', 'America/Los_Angeles', 'Australia/Sydney'].map((zone) =>
      inHostZone(zone, () => {
        const ambiguous = resolveZonedInstant({
          date: '2026-11-01',
          time: '01:30',
          timeZone: 'America/New_York',
        });
        const nonexistent = resolveZonedInstant({
          date: '2026-03-08',
          time: '02:30',
          timeZone: 'America/New_York',
        });
        return `${ambiguous.iso}|${nonexistent.iso}|${nonexistent.findings[0].code}`;
      })
    );
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe(
      `2026-11-01T01:30:00-04:00|null|${TIMING_REASON.WALL_TIME_NONEXISTENT}`
    );
  });
});

describe('seasonClock: a season with no timezone refuses rather than guessing', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace', '   '],
  ])('refuses when the season timezone is %s', (_label, timeZone) => {
    const { iso, findings } = resolveZonedInstant({
      date: '2026-11-07',
      time: '16:44',
      timeZone,
      label: 'slot start',
    });
    expect(iso).toBeNull();
    expect(findings.map((f) => f.code)).toEqual([TIMING_REASON.SEASON_TIMEZONE_MISSING]);
    expect(findings[0].severity).toBe(TIMING_SEVERITY.BLOCKING);
    expect(findings[0].details.date).toBe('2026-11-07');
  });

  it('distinguishes an unrecognised timezone from a missing one', () => {
    // Different remedies: "set the season's timezone" versus "the timezone you
    // set is not a zone". Folding them into one code would tell an operator who
    // typed `Americas/New_York` that they had set nothing.
    const typo = resolveZonedInstant({
      date: '2026-11-07',
      time: '16:44',
      timeZone: 'Americas/New_York',
    });
    expect(typo.iso).toBeNull();
    expect(typo.findings.map((f) => f.code)).toEqual([TIMING_REASON.SEASON_TIMEZONE_UNKNOWN]);
    expect(typo.findings[0].severity).toBe(TIMING_SEVERITY.BLOCKING);
    expect(typo.findings[0].details.timeZone).toBe('Americas/New_York');

    const missing = resolveZonedInstant({ date: '2026-11-07', time: '16:44', timeZone: null });
    expect(missing.findings[0].code).toBe(TIMING_REASON.SEASON_TIMEZONE_MISSING);
    expect(missing.findings[0].code).not.toBe(typo.findings[0].code);
  });

  it('refuses identically from every host zone (no silent browser fallback)', () => {
    const results = ['UTC', 'America/Los_Angeles', 'America/New_York'].map((zone) =>
      inHostZone(zone, () => resolveZonedInstant({ date: '2026-11-07', time: '16:44' }).iso)
    );
    expect(results).toEqual([null, null, null]);
  });

  it('requireZonedInstant throws a SeasonClockError carrying the code', () => {
    let thrown = null;
    try {
      requireZonedInstant({ date: '2026-11-07', time: '16:44', timeZone: null });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SeasonClockError);
    expect(thrown.code).toBe(TIMING_REASON.SEASON_TIMEZONE_MISSING);
    expect(thrown.findings).toHaveLength(1);
  });

  it('requireZonedInstant returns the instant when the season has a clock', () => {
    expect(
      requireZonedInstant({ date: '2026-11-07', time: '16:44', timeZone: 'America/New_York' })
    ).toBe('2026-11-07T16:44:00-05:00');
  });
});

describe('seasonClock: recognising what still needs a clock', () => {
  it.each([
    // Postgres renders a zone-less timestamp with a space; that form is
    // exactly as zone-less as the ISO one, and calling it "not naive" is the
    // one answer this predicate exists to give, given wrong.
    ['2026-11-07 16:44:00', true],
    ['2026-11-07 16:44:00Z', false],
    ['2026-11-07 16:44:00-05:00', false],
    ['2026-11-07T16:44:00', true],
    ['2026-11-07T16:44', true],
    ['2026-11-07T16:44:00Z', false],
    ['2026-11-07T16:44:00.000Z', false],
    ['2026-11-07T16:44:00-05:00', false],
    ['2026-11-07T16:44:00+0530', false],
    ['2026-11-07', false],
  ])('classifies %s', (value, naive) => {
    expect(isNaiveDateTime(value)).toBe(naive);
  });

  it('treats a Date and a number as not naive', () => {
    expect(isNaiveDateTime(new Date())).toBe(false);
    expect(isNaiveDateTime(1_762_544_640_000)).toBe(false);
  });

  it('anchorToSeasonClock composes a naive value and leaves everything else alone', () => {
    expect(anchorToSeasonClock('2026-11-07T16:44:00', 'America/New_York').iso).toBe(
      '2026-11-07T16:44:00-05:00'
    );
    // Postgres renders a zone-less timestamp with a space, and that form is
    // exactly as zone-less as the ISO one.
    expect(anchorToSeasonClock('2026-11-07 16:44:00', 'America/New_York').iso).toBe(
      '2026-11-07T16:44:00-05:00'
    );
    expect(anchorToSeasonClock('2026-11-07T21:44:00.000Z', 'America/New_York').iso).toBe(
      '2026-11-07T21:44:00.000Z'
    );
    const date = new Date('2026-11-07T21:44:00Z');
    expect(anchorToSeasonClock(date, 'America/New_York').iso).toBe(date);
    expect(anchorToSeasonClock(null, 'America/New_York').iso).toBeNull();
  });

  it('anchorToSeasonClock refuses a naive value with no season clock', () => {
    const { iso, findings } = anchorToSeasonClock('2026-11-07T16:44:00', null);
    expect(iso).toBeNull();
    expect(findings.map((f) => f.code)).toEqual([TIMING_REASON.SEASON_TIMEZONE_MISSING]);
  });
});

describe('seasonClock: the codes are registered, not invented', () => {
  it.each([
    TIMING_REASON.SEASON_TIMEZONE_MISSING,
    TIMING_REASON.SEASON_TIMEZONE_UNKNOWN,
    TIMING_REASON.WALL_TIME_UNREADABLE,
    TIMING_REASON.WALL_TIME_NONEXISTENT,
    TIMING_REASON.WALL_TIME_AMBIGUOUS,
  ])('%s has a registered severity', (code) => {
    expect(TIMING_REASON_SEVERITY[code]).toBeDefined();
    expect(() => timingSeverityOf(code)).not.toThrow();
  });

  it('an unregistered code still throws (control for the check above)', () => {
    // Without this, "has a registered severity" would pass for a registry that
    // hands out `info` for anything at all.
    expect(() => timingSeverityOf('WALL_TIME_INVENTED')).toThrow(/no registered severity/);
  });
});
