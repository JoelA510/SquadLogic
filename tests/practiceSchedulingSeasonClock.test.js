/**
 * LIVE-7, the frontend arm.
 *
 * `PracticeSchedulingPage.buildDateTime` returned the naive
 * `` `${date}T${time}` ``, and those strings were shipped to the
 * `auto-scheduler` Edge Function, which did `new Date(s.start)` on them -- the
 * **host's** zone, UTC on the Supabase edge. The request also carried
 * `timezone`, and the function contained zero occurrences of the string.
 *
 * These tests pin the instant to the season's zone and are indifferent to the
 * host's, exactly as `tests/gameSchedulingSeasonClock.test.js` does for the
 * games arm. `npm run test` is run under `TZ=UTC` and
 * `TZ=America/Los_Angeles`; every expectation below is an absolute instant, so
 * a host-zone read fails one of the two.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { partitionPracticeSlots } from '../frontend/src/pages/PracticeSchedulingPage.jsx';
import { TIMING_REASON } from '../packages/core/src/timing/index.js';

const SEASON_TZ = 'America/New_York';
const SEASON = { season_start: '2026-11-02', season_end: '2026-11-30' };

/** A `practice_slots` row exactly as Supabase hands it over. */
function slotRow(overrides = {}) {
  return {
    id: 'slot-1',
    day_of_week: 'tue',
    start_time: '16:44:00',
    end_time: '18:14:00',
    capacity: 2,
    valid_from: '2026-11-02',
    valid_until: '2026-11-30',
    ...overrides,
  };
}

const partition = (rows, timezone = SEASON_TZ) =>
  partitionPracticeSlots(rows, { seasonSetting: SEASON, timezone });

describe('practice slots compose on the season clock, not the host', () => {
  it('turns a naive wall reading into an instant carrying the season offset', () => {
    const { schedulerSlots } = partition([slotRow()]);
    expect(schedulerSlots).toHaveLength(1);
    // 2026-11-02 is a Monday; the first Tuesday is the 3rd. 16:44 EST = 21:44Z.
    expect(schedulerSlots[0].start).toBe('2026-11-03T16:44:00-05:00');
    expect(new Date(schedulerSlots[0].start).toISOString()).toBe('2026-11-03T21:44:00.000Z');
    expect(new Date(schedulerSlots[0].end).toISOString()).toBe('2026-11-03T23:14:00.000Z');
  });

  it('what it no longer emits is the naive string the edge used to read', () => {
    const { schedulerSlots } = partition([slotRow()]);
    expect(schedulerSlots[0].start).not.toBe('2026-11-03T16:44:00');
    // The control: that string IS host-dependent, which is the defect. If this
    // ever stops being true the assertion above stops meaning anything.
    const hostRead = new Date('2026-11-03T16:44:00').toISOString();
    const seasonRead = new Date(schedulerSlots[0].start).toISOString();
    if (process.env.TZ && process.env.TZ !== SEASON_TZ) {
      expect(hostRead).not.toBe(seasonRead);
    }
  });

  it('shifts with the season zone — the control that proves the zone is read', () => {
    const east = partition([slotRow()], 'America/New_York').schedulerSlots[0].start;
    const west = partition([slotRow()], 'America/Los_Angeles').schedulerSlots[0].start;
    expect(east).toBe('2026-11-03T16:44:00-05:00');
    expect(west).toBe('2026-11-03T16:44:00-08:00');
    expect(new Date(east).getTime()).not.toBe(new Date(west).getTime());
  });
});

describe('a slot that cannot be placed is reported, not dropped, and costs nothing else', () => {
  it('refuses a spring-forward slot by name', () => {
    // 2026-03-08 02:30 America/New_York does not exist.
    const { schedulerSlots, unplaceableSlots } = partition([
      slotRow({
        id: 'gap',
        day_of_week: 'sun',
        start_time: '02:30:00',
        end_time: '03:45:00',
        valid_from: '2026-03-08',
        valid_until: '2026-03-08',
      }),
    ]);
    expect(schedulerSlots).toHaveLength(0);
    expect(unplaceableSlots).toHaveLength(1);
    expect(unplaceableSlots[0].code).toBe(TIMING_REASON.WALL_TIME_NONEXISTENT);
    expect(unplaceableSlots[0].id).toBe('gap');
  });

  it('keeps every other slot when one refuses', () => {
    // The whole reason the partition is per row. Under the old single
    // try/catch this returned zero slots and a dead scheduler.
    const { schedulerSlots, unplaceableSlots } = partition([
      slotRow({
        id: 'gap',
        day_of_week: 'sun',
        start_time: '02:30:00',
        end_time: '03:45:00',
        valid_from: '2026-03-08',
        valid_until: '2026-03-08',
      }),
      slotRow({ id: 'fine-1' }),
      slotRow({ id: 'fine-2', day_of_week: 'wed' }),
    ]);
    expect(schedulerSlots.map((s) => s.id)).toEqual(['fine-1', 'fine-2']);
    expect(unplaceableSlots.map((s) => s.id)).toEqual(['gap']);
  });

  it('still reports a row that is simply malformed, with the shape code', () => {
    const { schedulerSlots, unplaceableSlots } = partition([
      slotRow({ id: 'no-times', start_time: null, end_time: null }),
      slotRow({ id: 'fine' }),
    ]);
    expect(schedulerSlots.map((s) => s.id)).toEqual(['fine']);
    expect(unplaceableSlots[0].code).toBe('SLOT_SHAPE_INVALID');
  });

  it('a season with no timezone refuses EVERY slot, which is what disables the page', () => {
    const rows = [slotRow({ id: 'a' }), slotRow({ id: 'b' }), slotRow({ id: 'c' })];
    // Not `partition(rows, undefined)` — that would take the helper's default
    // and quietly test the happy path. This is the shape the page passes when
    // `currentSeasonSetting?.timezone` is absent.
    const { schedulerSlots, unplaceableSlots } = partitionPracticeSlots(rows, {
      seasonSetting: SEASON,
      timezone: undefined,
    });
    expect(schedulerSlots).toHaveLength(0);
    expect(unplaceableSlots).toHaveLength(3);
    expect(new Set(unplaceableSlots.map((s) => s.code))).toEqual(
      new Set([TIMING_REASON.SEASON_TIMEZONE_MISSING])
    );
    // Meta-assertion: the same rows with a clock all place, so the refusal is
    // the timezone and not the fixtures.
    expect(partition(rows).schedulerSlots).toHaveLength(3);
  });
});

describe('what the page sends to the auto-scheduler', () => {
  const page = readFileSync(
    path.join(process.cwd(), 'frontend/src/pages/PracticeSchedulingPage.jsx'),
    'utf8'
  );
  const hook = readFileSync(
    path.join(process.cwd(), 'frontend/src/hooks/useAutoScheduler.js'),
    'utf8'
  );
  const schema = readFileSync(
    path.join(process.cwd(), 'supabase/functions/_shared/schemas/auto-scheduler.ts'),
    'utf8'
  );
  const fn = readFileSync(
    path.join(process.cwd(), 'supabase/functions/auto-scheduler/index.ts'),
    'utf8'
  );

  it('no longer ships `timezone` in the request body', () => {
    // Enumerated from the WRITERS of the payload, not from its readers: a field
    // nobody reads leaves every reader perfectly intact, which is how LIVE-7
    // survived. `useAutoScheduler` is the one writer of that fetch body.
    expect(hook).toContain('/auto-scheduler');
    // The BODY, not the file: a comment naming the field it no longer sends is
    // the point of the comment. `body: JSON.stringify({ … })` is the one writer.
    const bodyStart = hook.indexOf('body: JSON.stringify({');
    expect(bodyStart).toBeGreaterThan(-1);
    const body = hook.slice(bodyStart, hook.indexOf('}),', bodyStart));
    expect(body).toContain('slots,');
    expect(body).not.toMatch(/^\s*timezone,\s*$/m);
    // Control: a key it DOES still send, so the regex is known to match.
    // (`schoolDayEnd` was this control until #51 stopped sending it too.)
    expect(body).toMatch(/^\s*seasonSettingsId,\s*$/m);
    // The page still needs the zone locally, to compose with. It must not be
    // in the trigger payload.
    const triggerCall = page.slice(
      page.indexOf('autoScheduler.trigger({'),
      page.indexOf('autoScheduler.trigger({') + 600
    );
    expect(triggerCall).toContain('slots: schedulerSlots');
    expect(triggerCall).not.toMatch(/^\s*timezone,\s*$/m);
  });

  it('the function reads the season clock itself, so the field is not merely gone', () => {
    // Deleting a field that nothing read would satisfy the case above on its
    // own and leave the defect exactly where it was. The other half of
    // "honour it or delete it" is that the value is now obtained.
    expect(fn).toContain('readSeasonTimezone');
    expect(fn).toContain('anchorWallTimes');
    expect(schema).not.toMatch(/^\s*timezone:\s*z\./m);
  });

  it('the composed slots the page sends are instants, not wall strings', () => {
    const { schedulerSlots } = partition([slotRow()]);
    for (const slot of schedulerSlots) {
      expect(slot.start).toMatch(/[+-]\d{2}:\d{2}$|Z$/);
      expect(slot.end).toMatch(/[+-]\d{2}:\d{2}$|Z$/);
    }
    expect(schedulerSlots.length).toBeGreaterThan(0);
  });
});
