import { describe, it, expect } from 'vitest';
import {
  buildDateTime,
  normalizeGameSlot,
} from '../frontend/src/pages/GameSchedulingPage.jsx';
import { buildGameAssignmentRows } from '../packages/core/src/gameSupabase.js';
import { scheduleGames } from '../packages/core/src/gameScheduling.js';
import { formatDateTime } from '../frontend/src/utils/formatters.js';
import { TIMING_REASON } from '../packages/core/src/timing/index.js';

/**
 * GAP-30, end to end.
 *
 * `game_slots` holds `slot_date` + `start_time` — a naive wall reading. The
 * chain `buildDateTime -> normalizeGameSlot -> scheduleGames ->
 * buildGameAssignmentRows` used to hand that naive string to `new Date()`,
 * which reads it in the **host's** zone, so one 4:44 PM slot persisted as three
 * instants eight hours apart. These tests pin the instant to the season's zone
 * and are indifferent to the host's.
 */

const SEASON_TZ = 'America/New_York';

/** A `game_slots` row exactly as Supabase hands it over. */
function slotRow(overrides = {}) {
  return {
    id: 'slot-1',
    slot_date: '2026-11-07',
    start_time: '16:44:00',
    end_time: '18:14:00',
    week_index: 1,
    capacity: 1,
    field_id: 'field-a',
    division_id: 'div-u10',
    ...overrides,
  };
}

const REFERENCE = {
  fieldById: new Map([['field-a', { name: 'Field A', priority_rating: 3 }]]),
  divisionById: new Map([['div-u10', 'U10']]),
};

function normalize(row, timezone) {
  return normalizeGameSlot({ ...row }, { ...REFERENCE, timezone });
}

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

/** The full chain, from a database row to the `game_assignments` payload. */
function persistedInstants(timezone) {
  const slot = normalize(slotRow(), timezone);
  const [row] = buildGameAssignmentRows({
    assignments: [
      {
        division: 'U10',
        weekIndex: 1,
        slotId: slot.id,
        homeTeamId: 'team-1',
        awayTeamId: 'team-2',
        start: slot.start,
        end: slot.end,
      },
    ],
  });
  return { start: row.start, end: row.end };
}

describe('GAP-30: the persisted instant follows the season, not the browser', () => {
  it('writes the same instant from every browser timezone', () => {
    const results = ['UTC', 'America/Los_Angeles', 'America/New_York', 'Europe/London'].map(
      (zone) => inHostZone(zone, () => persistedInstants(SEASON_TZ))
    );
    const starts = new Set(results.map((r) => r.start));
    expect(starts.size).toBe(1);
    // 4:44 PM in New York on 2026-11-07 is 21:44 UTC. Only one of the three
    // instants the old chain produced was this one.
    expect(results[0].start).toBe('2026-11-07T21:44:00.000Z');
    expect(results[0].end).toBe('2026-11-07T23:14:00.000Z');
  });

  it('follows the season zone when the season moves and the browser does not', () => {
    // The positive control for the assertion above: a chain that still ignored
    // the season zone would produce one instant for all three seasons.
    const instants = inHostZone('America/Los_Angeles', () =>
      ['UTC', 'America/New_York', 'America/Los_Angeles'].map(
        (seasonTz) => persistedInstants(seasonTz).start
      )
    );
    expect(instants).toEqual([
      '2026-11-07T16:44:00.000Z',
      '2026-11-07T21:44:00.000Z',
      '2026-11-08T00:44:00.000Z',
    ]);
    expect(new Set(instants).size).toBe(3);
  });

  it('buildDateTime emits an instant, not a naive wall string', () => {
    const composed = buildDateTime('2026-11-07', '16:44:00', SEASON_TZ);
    expect(composed).toBe('2026-11-07T16:44:00-05:00');
    expect(new Date(composed).toISOString()).toBe('2026-11-07T21:44:00.000Z');
    expect(buildDateTime(null, '16:44:00', SEASON_TZ)).toBeNull();
    expect(buildDateTime('2026-11-07', null, SEASON_TZ)).toBeNull();
  });

  it('accepts a row that already carries an instant, untouched', () => {
    const slot = normalize(slotRow({ start: '2026-11-07T21:44:00.000Z', end: null }), SEASON_TZ);
    expect(slot.start).toBe('2026-11-07T21:44:00.000Z');
  });
});

describe('GAP-30 no-op guard: browser zone equals season zone', () => {
  // This is the regression risk. Everything was already correct for an admin
  // whose browser matched the season, which is why nobody noticed the defect.
  // These are the exact values `origin/main` produced in that case, recorded
  // literally rather than recomputed, so a change to either end shows up here.
  const MAIN_LABEL = 'Sat, 11/7/2026 · 4:44 PM';
  const MAIN_PERSISTED_START = '2026-11-07T21:44:00.000Z';
  const MAIN_PERSISTED_END = '2026-11-07T23:14:00.000Z';

  it('renders the identical label', () => {
    const label = inHostZone(SEASON_TZ, () => normalize(slotRow(), SEASON_TZ).label);
    expect(label).toBe(MAIN_LABEL);
  });

  it('persists the identical instants', () => {
    const { start, end } = inHostZone(SEASON_TZ, () => persistedInstants(SEASON_TZ));
    expect(start).toBe(MAIN_PERSISTED_START);
    expect(end).toBe(MAIN_PERSISTED_END);
  });

  it('renders the identical label for a Pacific season on a Pacific browser', () => {
    const label = inHostZone('America/Los_Angeles', () =>
      normalize(slotRow(), 'America/Los_Angeles').label
    );
    expect(label).toBe('Sat, 11/7/2026 · 4:44 PM');
  });
});

describe('GAP-30: the display double shift', () => {
  it('shows the season wall time from every browser timezone', () => {
    const labels = ['America/New_York', 'America/Los_Angeles', 'Europe/London'].map((zone) =>
      inHostZone(zone, () => normalize(slotRow(), SEASON_TZ).label)
    );
    // `origin/main` produced 4:44 PM, 7:44 PM and 11:44 AM here.
    expect(new Set(labels).size).toBe(1);
    expect(labels[0]).toBe('Sat, 11/7/2026 · 4:44 PM');
  });

  it('formatDateTime reads a naive wall string against the zone it is asked to render in', () => {
    const labels = ['America/New_York', 'America/Los_Angeles', 'Europe/London'].map((zone) =>
      inHostZone(zone, () => formatDateTime('2026-11-07T16:44:00', SEASON_TZ))
    );
    expect(new Set(labels).size).toBe(1);
    expect(labels[0]).toBe('Sat, 11/7/2026 · 4:44 PM');
  });

  it('still renders a zone-less caller in the browser zone', () => {
    // `PersistenceHistoryList`, `TeamPersistencePanel`, `PracticeReadinessPanel`
    // and `TeamOverviewPanel` all call these with no timezone, on audit
    // timestamps that already carry a `Z`. Browser-local is right for them.
    const audit = '2026-11-07T21:44:00.000Z';
    expect(inHostZone('America/New_York', () => formatDateTime(audit))).toBe(
      'Sat, 11/7/2026 · 4:44 PM'
    );
    expect(inHostZone('America/Los_Angeles', () => formatDateTime(audit))).toBe(
      'Sat, 11/7/2026 · 1:44 PM'
    );
  });

  it('refuses to label a wall time that has no season clock', () => {
    expect(formatDateTime('2026-11-07T16:44:00', null)).toBe('unspecified time');
  });
});

describe('GAP-30: a season with no timezone refuses rather than guessing', () => {
  it('normalizeGameSlot surfaces the reason code instead of composing', () => {
    let thrown = null;
    try {
      normalize(slotRow(), null);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown.code).toBe(TIMING_REASON.SEASON_TIMEZONE_MISSING);
    expect(thrown.message).toMatch(/timezone/i);
  });

  it('refuses a slot whose wall time does not exist in the season zone', () => {
    let thrown = null;
    try {
      normalize(slotRow({ slot_date: '2026-03-08', start_time: '02:30:00' }), SEASON_TZ);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown.code).toBe(TIMING_REASON.WALL_TIME_NONEXISTENT);
  });

  it('places a fall-back slot on the first occurrence', () => {
    const slot = normalize(
      slotRow({ slot_date: '2026-11-01', start_time: '01:30:00', end_time: '03:00:00' }),
      SEASON_TZ
    );
    expect(new Date(slot.start).toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });
});

describe('GAP-30: the solver needed no change, verified rather than assumed', () => {
  it('scheduleGames round-trips a zone-carrying slot to the same instant', () => {
    const teams = [
      { id: 'team-1', division: 'U10' },
      { id: 'team-2', division: 'U10' },
    ];
    const slot = normalize(slotRow(), SEASON_TZ);
    const results = ['UTC', 'America/Los_Angeles', 'Australia/Sydney'].map((zone) =>
      inHostZone(zone, () => {
        const { assignments } = scheduleGames({
          teams,
          slots: [
            {
              id: slot.id,
              weekIndex: slot.weekIndex,
              start: slot.start,
              end: slot.end,
              capacity: 1,
              fieldId: slot.fieldId,
            },
          ],
          roundRobinByDivision: { U10: [[{ homeTeamId: 'team-1', awayTeamId: 'team-2' }]] },
        });
        expect(assignments).toHaveLength(1);
        return assignments[0].start;
      })
    );
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe('2026-11-07T21:44:00.000Z');
  });
});
