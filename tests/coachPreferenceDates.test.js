/**
 * The two days the preference screens use (`coachPreferencePreview.js`): the database's day for "coaches
 * this team today" (what `admin_add_practice_preference` reads, UTC) and the auto-scheduler's run date for
 * a preview (`seasonRunDate`, the later of the season's date and the UTC date).
 */
import { describe, it, expect } from 'vitest';
import { databaseIsoDate, previewRunDate } from '../frontend/src/utils/coachPreferencePreview.js';

const WEST_EVENING = new Date('2026-10-02T01:00:00Z'); // 18:00 on the 1st in Los Angeles
const EAST_NOON = new Date('2026-10-01T23:00:00Z'); // 12:00 on the 2nd in Auckland

describe('databaseIsoDate', () => {
  it('is the UTC date, whatever the host zone', () => {
    expect(databaseIsoDate(WEST_EVENING)).toBe('2026-10-02');
    expect(databaseIsoDate(EAST_NOON)).toBe('2026-10-01');
  });
});

describe('previewRunDate', () => {
  it('west of UTC in the evening is the UTC date, a day ahead of the season clock', () => {
    expect(previewRunDate(WEST_EVENING, 'America/Los_Angeles')).toBe('2026-10-02');
  });
  it('east of UTC is the season date, ahead of the UTC date', () => {
    expect(previewRunDate(EAST_NOON, 'Pacific/Auckland')).toBe('2026-10-02');
  });
  it('without a readable zone it is the database day, not the host date', () => {
    expect(previewRunDate(WEST_EVENING, null)).toBe('2026-10-02');
    expect(previewRunDate(WEST_EVENING, 'Not/AZone')).toBe('2026-10-02');
  });
});
