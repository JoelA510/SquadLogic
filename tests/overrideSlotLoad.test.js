/**
 * The override panel's per-slot load (M4.7, docs/PLAN_SCORING_DATE_MODEL.md
 * §3.5, Q5): the busiest date from the season's today on, so a series that
 * has ended does not take a place. Every expectation is worked out from the
 * dates in the inputs.
 */
import { describe, expect, it } from 'vitest';
import { overrideSlotLoad } from '../frontend/src/utils/overrideSlotLoad.js';

// Wednesdays from 2026-08-12 to 2026-11-18 (validity end 2026-11-20).
const SLOT = { id: 'S1', firstDate: '2026-08-12', lastDate: '2026-11-20' };
const TODAY = '2026-10-20';

const loadOf = (assignments, seasonToday = TODAY, slots = [SLOT]) =>
  overrideSlotLoad({ slots, assignments, seasonToday }).get('S1');

describe('overrideSlotLoad', () => {
  it('a series that ended before today holds no place; a current one does', () => {
    expect(loadOf([{ slotId: 'S1', effectiveDateRange: '[2026-08-10,2026-10-05)' }])).toBe(0);
    expect(loadOf([{ slotId: 'S1', effectiveDateRange: '[2026-10-05,2026-11-21)' }])).toBe(1);
  });

  it('a closed series and its successor are one team on the slot, not two (#541)', () => {
    const rows = [
      { slotId: 'S1', effectiveDateRange: '[2026-08-10,2026-10-19]' },
      { slotId: 'S1', effectiveDateRange: '[2026-10-20,2026-11-20]' },
    ];
    expect(loadOf(rows)).toBe(1);
    // Over the whole season (no clock yet) the peak is still one: they never meet.
    expect(loadOf(rows, null)).toBe(1);
  });

  it('the busiest remaining date, not the number of rows', () => {
    const rows = [
      { slotId: 'S1', effectiveDateRange: '[2026-10-20,2026-10-28]' },
      { slotId: 'S1', effectiveDateRange: '[2026-11-01,2026-11-20]' },
      { slotId: 'S1', effectiveDateRange: '[2026-11-04,2026-11-04]' },
    ];
    // 10-21 and 10-28: one. 11-04: two. 11-11, 11-18: one.
    expect(loadOf(rows)).toBe(2);
  });

  it('a series that ends today still counts for today', () => {
    // 2026-10-21 is a Wednesday; today is the 20th, so the 21st is still ahead.
    expect(loadOf([{ slotId: 'S1', effectiveDateRange: '[2026-08-10,2026-10-21]' }])).toBe(1);
    expect(loadOf([{ slotId: 'S1', effectiveDateRange: '[2026-08-10,2026-10-21)' }])).toBe(0);
  });

  it('a range that does not read is never shown as a free place', () => {
    expect(loadOf([{ slotId: 'S1', effectiveDateRange: 'Full Season' }])).toBe(1);
  });

  it('a row with no range holds the slot for its whole validity', () => {
    expect(loadOf([{ slotId: 'S1' }])).toBe(1);
  });

  it('a slot whose dates do not read falls back to its row count', () => {
    const slots = [{ id: 'S1', firstDate: 'someday', lastDate: '2026-11-20' }];
    const rows = [
      { slotId: 'S1', effectiveDateRange: '[2026-08-10,2026-10-05)' },
      { slotId: 'S1', effectiveDateRange: '[2026-10-05,2026-11-21)' },
    ];
    expect(loadOf(rows, TODAY, slots)).toBe(2);
  });

  it('a slot whose validity has ended offers no place: null, not an empty slot', () => {
    const ended = [{ id: 'S1', firstDate: '2026-08-12', lastDate: '2026-10-01' }];
    expect(loadOf([], TODAY, ended)).toBeNull();
    expect(loadOf([{ slotId: 'S1' }], TODAY, ended)).toBeNull();
    // Control: before the clock is read, the whole validity counts.
    expect(loadOf([{ slotId: 'S1' }], null, ended)).toBe(1);
  });

  it('every slot is answered, including an empty one; rows for other slots are ignored', () => {
    const load = overrideSlotLoad({
      slots: [SLOT, { id: 'S2', firstDate: '2026-08-13', lastDate: '2026-11-20' }],
      assignments: [{ slotId: 'S9' }, { slotId: null }],
      seasonToday: TODAY,
    });
    expect([...load.entries()]).toEqual([
      ['S1', 0],
      ['S2', 0],
    ]);
  });
});
