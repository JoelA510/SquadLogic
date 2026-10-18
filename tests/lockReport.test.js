/**
 * The auto-scheduler's lock report on the page (M4.8): saved practices the run
 * held season-long because their range could not be read (actionable), and
 * those that have ended (their slot offered). `utils/lockReport.js`.
 */
import { describe, expect, it } from 'vitest';
import { describeLockReport } from '../frontend/src/utils/lockReport.js';

describe('describeLockReport', () => {
  it('says nothing when there is nothing to say, or no report', () => {
    expect(describeLockReport(null)).toBeNull();
    expect(describeLockReport(undefined)).toBeNull();
    expect(describeLockReport({ unreadableRange: [], endedRows: [] })).toBeNull();
    // Malformed parts are not read as ids.
    expect(describeLockReport({ unreadableRange: 'r-1', endedRows: [null, ''] })).toBeNull();
  });

  it('names the unreadable ranges first, and counts the rest past three', () => {
    expect(
      describeLockReport({ unreadableRange: ['a', 'b', 'c', 'd'], endedRows: ['e', 'f'] })
    ).toBe(
      '4 saved practices have date ranges that could not be read, so their slots were held for ' +
        'the whole season: a, b, c and 1 more. Save them again with their dates to free the ' +
        'weeks they do not use. 2 saved practices have ended, so their slots were offered to ' +
        'other teams from today.'
    );
  });

  it('speaks of one practice in the singular', () => {
    expect(describeLockReport({ endedRows: ['e'] })).toBe(
      '1 saved practice has ended, so its slot was offered to other teams from today.'
    );
  });
});
