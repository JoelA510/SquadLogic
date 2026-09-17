import { describe, it, expect } from 'vitest';
import { normalizeTimestamp } from '../packages/core/src/utils/normalization.js';
import { buildGameAssignmentRows } from '../packages/core/src/gameSupabase.js';

/**
 * LIVE-6.
 *
 * `normalizeTimestamp(value, label, fallbackIso)` was called from
 * `gameSupabase.js` with the row `index` in the `fallbackIso` slot. Executed
 * against `origin/main`:
 *
 *   start null, end set => start: 0                          end: "2026-...Z"
 *   start set, end null => start: "2026-...Z"                end: 0
 *   both null           => threw: assignments[0] end must be after start
 *
 * Two defects from one signature mismatch: an integer `0` written into a
 * `timestamptz`, and an `end <= start` guard defeated because `"2026-..." <= 0`
 * coerces to `NaN <= 0` and is `false`. The "both null" case threw only because
 * both fallbacks happened to be the same index.
 */

const ASSIGNMENT = {
  division: 'U10',
  weekIndex: 1,
  slotId: 'slot-1',
  homeTeamId: 'team-1',
  awayTeamId: 'team-2',
  start: '2026-11-07T16:44:00Z',
  end: '2026-11-07T18:14:00Z',
};

function build(overrides, index = 0) {
  const assignments = Array.from({ length: index + 1 }, () => ({ ...ASSIGNMENT }));
  assignments[index] = { ...ASSIGNMENT, ...overrides };
  return buildGameAssignmentRows({ assignments });
}

describe('LIVE-6: normalizeTimestamp takes an index, never a fallback', () => {
  it('refuses a missing value instead of returning the third argument', () => {
    expect(() => normalizeTimestamp(null, 'start', 7)).toThrow(TypeError);
    expect(() => normalizeTimestamp(null, 'start', 7)).toThrow('start is required at index 7');
    expect(() => normalizeTimestamp(undefined, 'end', 0)).toThrow('end is required at index 0');
  });

  it('carries the index the message was always written to carry', () => {
    // The old signature never put `index` in a message at all; it silently
    // returned it. These two must differ, or the index is still being dropped.
    let first = null;
    let second = null;
    try {
      normalizeTimestamp('nonsense', 'start', 0);
    } catch (error) {
      first = error.message;
    }
    try {
      normalizeTimestamp('nonsense', 'start', 4);
    } catch (error) {
      second = error.message;
    }
    expect(first).toBe('start must be a valid date or timestamp string at index 0');
    expect(second).toBe('start must be a valid date or timestamp string at index 4');
    expect(first).not.toBe(second);
  });

  it('omits the index clause when no index is given', () => {
    expect(() => normalizeTimestamp(null, 'syncedAt')).toThrow('syncedAt is required');
    expect(() => normalizeTimestamp(null, 'syncedAt')).not.toThrow(/index/);
  });

  it('matches its siblings, which already read (value, label, index)', () => {
    // `normalizeString` is the contract being adopted rather than re-invented.
    expect(() => normalizeTimestamp('', 'start', 2)).toThrow(/at index 2/);
  });

  it('still normalises a Date, an ISO string and an epoch number', () => {
    const iso = '2026-11-07T21:44:00.000Z';
    expect(normalizeTimestamp(new Date(iso), 'start', 0)).toBe(iso);
    expect(normalizeTimestamp(iso, 'start', 0)).toBe(iso);
    expect(normalizeTimestamp(Date.parse(iso), 'start', 0)).toBe(iso);
    expect(normalizeTimestamp('2026-11-07T16:44:00-05:00', 'start', 0)).toBe(iso);
  });
});

describe('LIVE-6: the three executed cases, through the real builder', () => {
  it('a missing start no longer writes the integer 0', () => {
    let thrown = null;
    try {
      build({ start: null });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown.message).toBe('start is required at index 0');
  });

  it('a missing end no longer writes the integer 0', () => {
    let thrown = null;
    try {
      build({ end: null });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown.message).toBe('end is required at index 0');
  });

  it('both missing fails for the stated reason, not by coincidence', () => {
    // On `origin/main` this threw `end must be after start`, which was false --
    // both were the integer 0. The reason has to be the missing value itself.
    let thrown = null;
    try {
      build({ start: null, end: null });
    } catch (error) {
      thrown = error;
    }
    expect(thrown.message).toBe('start is required at index 0');
    expect(thrown.message).not.toMatch(/after start/);
  });

  it('names the row that is actually broken, not row 0', () => {
    // The whole point of the index argument. With `fallbackIso` this message
    // could not exist.
    let thrown = null;
    try {
      build({ end: null }, 3);
    } catch (error) {
      thrown = error;
    }
    expect(thrown.message).toBe('end is required at index 3');
  });

  it('keeps the end-after-start guard working on real timestamps', () => {
    // The guard the integer 0 used to defeat. Both operands are now always ISO
    // strings, so the comparison is a real one.
    expect(() => build({ end: '2026-11-07T15:00:00Z' })).toThrow(/end must be after start/);
    expect(() => build({ end: ASSIGNMENT.start })).toThrow(/end must be after start/);
  });

  it('still builds a well-formed row when both timestamps are present', () => {
    // The meta-assertion: every test above asserts a throw, and a builder that
    // threw unconditionally would pass all of them.
    const [row] = build({});
    expect(row.start).toBe('2026-11-07T16:44:00.000Z');
    expect(row.end).toBe('2026-11-07T18:14:00.000Z');
    expect(row.week_index).toBe(1);
    expect(row.home_team_id).toBe('team-1');
  });
});
