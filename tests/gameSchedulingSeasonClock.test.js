import { describe, it, expect } from 'vitest';
import {
  buildDateTime,
  composeSchedulerReadinessMessage,
  describeUnplaceableSlots,
  normalizeGameSlot,
  partitionGameSlots,
} from '../frontend/src/pages/GameSchedulingPage.jsx';
import { buildGameAssignmentRows } from '../packages/core/src/gameSupabase.js';
import { generateRoundRobinWeeks, scheduleGames } from '../packages/core/src/gameScheduling.js';
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
    const label = inHostZone(
      'America/Los_Angeles',
      () => normalize(slotRow(), 'America/Los_Angeles').label
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
      { id: 'team-1', name: 'Team 1', division: 'U10' },
      { id: 'team-2', name: 'Team 2', division: 'U10' },
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
          // Built by the production producer rather than hand-forged, so the
          // week shape cannot drift away from what the solver really receives.
          roundRobinByDivision: {
            U10: generateRoundRobinWeeks({ teamIds: ['team-1', 'team-2'] }),
          },
        });
        expect(assignments).toHaveLength(1);
        return assignments[0].start;
      })
    );
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe('2026-11-07T21:44:00.000Z');
  });
});

describe('GAP-30: one unplaceable slot does not void the grid', () => {
  // The page used to wrap the whole map in one try/catch. A single slot that
  // could not be placed returned no slots at all, so 400 good slots vanished
  // behind one bad one -- CLAUDE.md's "never silently drop an unplaceable
  // fixture" inverted into dropping every placeable one.
  const good = [
    slotRow({ id: 'good-1' }),
    slotRow({ id: 'good-2', start_time: '18:30:00', end_time: '20:00:00' }),
  ];
  const dstGap = slotRow({ id: 'tbd-1', slot_date: '2026-03-08', start_time: '02:30:00' });

  it('keeps the placeable slots and reports the rest as TIME TBD', () => {
    const { gameSlots, slotById, unplaceableSlots } = partitionGameSlots([...good, dstGap], {
      ...REFERENCE,
      timezone: SEASON_TZ,
    });
    expect(gameSlots.map((s) => s.id)).toEqual(['good-1', 'good-2']);
    expect(slotById.size).toBe(2);
    expect(unplaceableSlots).toHaveLength(1);
    expect(unplaceableSlots[0]).toMatchObject({
      id: 'tbd-1',
      date: '2026-03-08',
      time: '02:30:00',
      code: TIMING_REASON.WALL_TIME_NONEXISTENT,
    });
  });

  it('reports a malformed row without a reason code under its own label', () => {
    const { gameSlots, unplaceableSlots } = partitionGameSlots(
      [...good, { ...slotRow(), id: null }],
      { ...REFERENCE, timezone: SEASON_TZ }
    );
    expect(gameSlots).toHaveLength(2);
    expect(unplaceableSlots[0].code).toBe('SLOT_SHAPE_INVALID');
  });

  it('still blocks the whole season when the season has no clock', () => {
    // Not by a special rule: one season, one clock, so every row is unplaceable
    // and `gameSlots` is empty, which is what the page's existing guard reads.
    const { gameSlots, unplaceableSlots } = partitionGameSlots([...good, dstGap], {
      ...REFERENCE,
      timezone: null,
    });
    expect(gameSlots).toEqual([]);
    expect(unplaceableSlots).toHaveLength(3);
    expect(new Set(unplaceableSlots.map((u) => u.code))).toEqual(
      new Set([TIMING_REASON.SEASON_TIMEZONE_MISSING])
    );
  });

  /**
   * `count` distinct slots, each at its own wall time, all unplaceable for the
   * same reason -- which is what a season with a null `timezone` produces for
   * every row it holds.
   *
   * **The times have to differ.** This test used to build 40 rows that shared
   * one `slot_date` and one `start_time` and differed only by `id`, and every
   * reason string `resolveZonedInstant` writes embeds the date and the time --
   * so the forty entries shared one reason, the `reason`-keyed bucketing
   * collapsed them, and the assertion passed over a state the production path
   * cannot reach. Two rows at the same second on the same pitch are not a
   * season. Measured on the real shape: 5 slots produced 5 lines, 50 produced
   * 50 over 8 KB, and a 400-slot season rendered tens of kilobytes into one
   * `<p>`.
   */
  function slotsAtDistinctTimes(count) {
    return Array.from({ length: count }, (_, i) =>
      slotRow({
        id: `s${i}`,
        // 07:00 onward in one-minute steps: distinct dates AND distinct times,
        // so nothing about the bucketing can be satisfied by a coincidence.
        slot_date: `2026-${String(4 + Math.floor(i / 400)).padStart(2, '0')}-${String((Math.floor(i / 20) % 28) + 1).padStart(2, '0')}`,
        start_time: `${String(7 + Math.floor((i % 20) / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}:00`,
        end_time: '23:30:00',
      })
    );
  }

  it('collapses one cause shared by many slots into one line', () => {
    const { unplaceableSlots } = partitionGameSlots(slotsAtDistinctTimes(40), {
      ...REFERENCE,
      timezone: null,
    });
    // The meta-assertion the old version lacked: the forty entries really do
    // carry forty different reason strings, so bucketing on `reason` could not
    // collapse them and this test is exercising the change rather than a
    // coincidence.
    expect(new Set(unplaceableSlots.map((entry) => entry.reason)).size).toBe(40);

    const message = describeUnplaceableSlots(unplaceableSlots);
    expect(message).toMatch(/^40 slots shown as TIME TBD \(SEASON_TIMEZONE_MISSING\)/);
    expect(message.split('·')).toHaveLength(1);
  });

  it('does not grow with the size of the season', () => {
    // The HIGH finding, as a number rather than a shape. One line per distinct
    // code means the banner is bounded by the code registry, not by the slot
    // count -- so five slots and four hundred differ only in the count they
    // print.
    const sizes = [5, 50, 400];
    const messages = sizes.map((n) => {
      const { unplaceableSlots } = partitionGameSlots(slotsAtDistinctTimes(n), {
        ...REFERENCE,
        timezone: null,
      });
      expect(unplaceableSlots).toHaveLength(n);
      return describeUnplaceableSlots(unplaceableSlots);
    });

    for (const [index, message] of messages.entries()) {
      expect(message.split('·'), `${sizes[index]} slots`).toHaveLength(1);
      expect(message.length, `${sizes[index]} slots`).toBeLessThan(300);
    }
    // Identical once the count is normalised away: the 400-slot line says
    // nothing the 5-slot line does not.
    const normalised = messages.map((message) => message.replace(/^\d+ slots?/, 'N slots'));
    expect(new Set(normalised).size).toBe(1);
  });

  it('names one example per cause and no more', () => {
    const { unplaceableSlots } = partitionGameSlots(slotsAtDistinctTimes(50), {
      ...REFERENCE,
      timezone: null,
    });
    const message = describeUnplaceableSlots(unplaceableSlots);
    // The per-slot detail belongs on the entries, which the grid and any
    // future TIME TBD row read. The aggregate names one, so the line still
    // points somewhere.
    expect(message).toContain(`(first: ${unplaceableSlots[0].date} ${unplaceableSlots[0].time})`);
    expect(message.match(/first:/g)).toHaveLength(1);
    for (const entry of unplaceableSlots) {
      expect(entry.date).toBeTruthy();
      expect(entry.time).toBeTruthy();
    }
  });

  it('has a slot-independent cause for every code the page can produce', () => {
    // **Driven through `partitionGameSlots`, not asserted against a list.**
    // Each case below is a real refusal the production path emits; a code with
    // no cause of its own falls back to the entry's own `reason`, which
    // carries that slot's date and time, so the check is simply that no line
    // repeats the raw reason string.
    /** @type {Array<{ code: string, rows: Array<Object>, timezone: string|null }>} */
    const cases = [
      { code: TIMING_REASON.SEASON_TIMEZONE_MISSING, rows: [slotRow()], timezone: null },
      { code: TIMING_REASON.SEASON_TIMEZONE_UNKNOWN, rows: [slotRow()], timezone: 'Mars/Phobos' },
      {
        code: TIMING_REASON.WALL_TIME_NONEXISTENT,
        rows: [slotRow({ slot_date: '2026-03-08', start_time: '02:30:00' })],
        timezone: SEASON_TZ,
      },
      {
        code: TIMING_REASON.WALL_TIME_UNREADABLE,
        rows: [slotRow({ start_time: '99:99:99' })],
        timezone: SEASON_TZ,
      },
      { code: 'SLOT_SHAPE_INVALID', rows: [slotRow({ id: null })], timezone: SEASON_TZ },
    ];

    for (const { code, rows, timezone } of cases) {
      const { unplaceableSlots } = partitionGameSlots(rows, { ...REFERENCE, timezone });
      // Meta-assertion: the case really does produce the code it claims. A
      // typo here would otherwise test the generic arm five times over.
      expect(
        unplaceableSlots.map((entry) => entry.code),
        String(code)
      ).toEqual([code]);

      const message = describeUnplaceableSlots(unplaceableSlots);
      expect(message, String(code)).toContain(`(${code})`);
      expect(
        message,
        `${code} has no cause of its own, so the banner falls back to the slot-specific reason and grows with the season`
      ).not.toContain(unplaceableSlots[0].reason);
    }
  });

  it('names each distinct cause once, and says nothing when there is none', () => {
    const { unplaceableSlots } = partitionGameSlots(
      [dstGap, slotRow({ id: 'bad', start_time: '99:99:99' })],
      { ...REFERENCE, timezone: SEASON_TZ }
    );
    const message = describeUnplaceableSlots(unplaceableSlots);
    expect(message).toMatch(new RegExp(TIMING_REASON.WALL_TIME_NONEXISTENT));
    expect(message).toMatch(new RegExp(TIMING_REASON.WALL_TIME_UNREADABLE));
    expect(message.split('\u00b7')).toHaveLength(2);
    // The meta-assertion: a describer that always produced a line would pass
    // every assertion above.
    expect(describeUnplaceableSlots([])).toBeNull();
    expect(
      describeUnplaceableSlots(
        partitionGameSlots(good, { ...REFERENCE, timezone: SEASON_TZ }).unplaceableSlots
      )
    ).toBeNull();
  });
});

/**
 * The readiness banner's sentence.
 *
 * Both defects here were in the REPORTING layer, which is the layer #396's own
 * twelve positive controls never perturbed: they all pushed on the composer,
 * and the composer had been right for three reviews.
 */
describe('GAP-30 follow-up: the readiness banner says each thing once', () => {
  const READY = {
    referenceError: null,
    teamCount: 8,
    placeableSlotCount: 24,
    unplaceableSlotCount: 0,
    seasonClockLoading: false,
  };

  it('says nothing when there is nothing to say', () => {
    expect(composeSchedulerReadinessMessage(READY)).toBeNull();
  });

  it('does not carry the unplaceable summary, which has its own line', () => {
    // The finding: this sentence is rendered at `GameSchedulingPage.jsx`'s
    // `applyError || statusMessage || schedulerReadinessMessage` arm, and the
    // unplaceable summary is rendered again directly below it. Appending it
    // here printed it twice in the common case -- no apply error, no status
    // message.
    const message = composeSchedulerReadinessMessage({
      ...READY,
      placeableSlotCount: 0,
      unplaceableSlotCount: 40,
    });
    expect(message).toBeNull();
    // And with a genuine second fact to report, the sentence carries that one
    // and still not the summary.
    const withNoTeams = composeSchedulerReadinessMessage({
      ...READY,
      teamCount: 0,
      placeableSlotCount: 0,
      unplaceableSlotCount: 40,
    });
    expect(withNoTeams).toBe('No generated teams are available for game scheduling.');
    expect(withNoTeams).not.toMatch(/TIME TBD/);
  });

  it('still distinguishes "no slots at all" from "slots nothing can place"', () => {
    // The arm that was already right, kept: 40 unplaceable slots are not the
    // same fact as an organisation with no slots, and reporting the second for
    // the first would send the operator to the wrong screen.
    expect(
      composeSchedulerReadinessMessage({ ...READY, teamCount: 0, placeableSlotCount: 0 })
    ).toBe(
      'No generated teams are available for game scheduling. · No game slots are available for this organization.'
    );
  });

  it('joins several facts rather than reporting only the first', () => {
    expect(
      composeSchedulerReadinessMessage({
        ...READY,
        referenceError: 'Game schedule reference data could not be loaded.',
        teamCount: 0,
        placeableSlotCount: 0,
      })
    ).toBe(
      'Game schedule reference data could not be loaded. · No generated teams are available for game scheduling. · No game slots are available for this organization.'
    );
  });

  it('does not accuse a season of having no clock before the season has loaded', () => {
    // `currentSeasonSetting` is null both when the season has no timezone and
    // before OrganizationContext has answered, and the slot read is keyed only
    // on the organisation -- so on the losing order every slot is unplaceable
    // and the operator was told to set a timezone that was already set.
    const loading = composeSchedulerReadinessMessage({
      ...READY,
      teamCount: 0,
      placeableSlotCount: 0,
      unplaceableSlotCount: 40,
      seasonClockLoading: true,
    });
    expect(loading).toBe('Loading this season’s settings…');
    expect(loading).not.toMatch(/No game slots/);
    expect(loading).not.toMatch(/timezone/i);
  });

  it('still reports a failed reference read while the season is loading', () => {
    // A read that already failed is a fact about now, not about a pending
    // fetch, and suppressing it would be the opposite mistake.
    expect(
      composeSchedulerReadinessMessage({
        ...READY,
        referenceError: 'Game schedule reference data could not be loaded.',
        seasonClockLoading: true,
      })
    ).toBe('Game schedule reference data could not be loaded. · Loading this season’s settings…');
  });
});
