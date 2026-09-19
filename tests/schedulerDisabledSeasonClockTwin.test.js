/**
 * The `schedulerDisabled` twin arms, and the clause only one of them had.
 *
 * `PracticeSchedulingPage`'s `schedulerDisabled` included `seasonClockLoading`
 * and `GameSchedulingPage`'s did not. The briefed reading was that the clause
 * is redundant -- a season with no timezone refuses every slot, so
 * `!schedulerSlots.length` already fires -- and that the practice arm should
 * drop it to match its twin.
 *
 * **That reading is true of one of `isSeasonClockLoading`'s three reasons and
 * false of another, so the divergence was resolved the other way**: the clause
 * is correct and the game arm has grown it. The tests below are the proof,
 * because "prove the loading race is still covered" has to be a check and not
 * a paragraph.
 *
 * - Reason (1), nothing read yet: `currentSeasonSetting` is null, `timezone`
 *   is `undefined`, every slot lands unplaceable, the count arm fires. The
 *   clause is genuinely redundant here.
 * - Reason (3), the organisation just switched: the season row still in hand
 *   belongs to the organisation being left, so it carries a timezone. Every
 *   slot places. The count arm is FALSE, and nothing but `seasonClockLoading`
 *   stands between the operator and a run launched for the new organisation
 *   over the old one's slots on the old one's clock.
 *
 * Both page partitioners are exercised, not one of them: a clause added to the
 * arm someone happened to be reading is how this divergence arose.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { partitionPracticeSlots } from '../frontend/src/pages/PracticeSchedulingPage.jsx';
import { partitionGameSlots } from '../frontend/src/pages/GameSchedulingPage.jsx';
import { isSeasonClockLoading } from '../frontend/src/utils/seasonClockSlots.js';

const LEAVING_ORG = 'org-leaving';
const ARRIVING_ORG = 'org-arriving';

/** The season row of the organisation being navigated away from. */
const STALE_SEASON = {
  id: 'season-leaving',
  organization_id: LEAVING_ORG,
  season_start: '2026-11-02',
  season_end: '2026-11-30',
  timezone: 'America/New_York',
};

function practiceSlotRow(overrides = {}) {
  return {
    id: 'practice-slot-1',
    day_of_week: 'tue',
    start_time: '16:44:00',
    end_time: '18:14:00',
    capacity: 2,
    valid_from: '2026-11-02',
    valid_until: '2026-11-30',
    ...overrides,
  };
}

function gameSlotRow(overrides = {}) {
  return {
    id: 'game-slot-1',
    slot_date: '2026-11-03',
    start_time: '16:44:00',
    end_time: '18:14:00',
    week_index: 1,
    field_id: 'field-1',
    division_id: 'division-1',
    ...overrides,
  };
}

const GAME_REFERENCE = {
  fieldById: new Map([['field-1', { id: 'field-1', name: 'Pitch One' }]]),
  divisionById: new Map([['division-1', { id: 'division-1', name: 'U10' }]]),
};

describe('isSeasonClockLoading reason (3): a stale season row still has a clock', () => {
  it('is true after an organisation switch, while the held row belongs to the old one', () => {
    expect(
      isSeasonClockLoading({
        organizationLoading: false,
        seasonSettingsLoading: false,
        currentOrganization: { id: ARRIVING_ORG },
        currentSeasonSetting: STALE_SEASON,
      })
    ).toBe(true);
  });

  it('positive control: the same row under its own organisation is not loading', () => {
    expect(
      isSeasonClockLoading({
        organizationLoading: false,
        seasonSettingsLoading: false,
        currentOrganization: { id: LEAVING_ORG },
        currentSeasonSetting: STALE_SEASON,
      })
    ).toBe(false);
  });
});

describe('the slot-count arm cannot stand in for the clause', () => {
  it('practice: a stale season row places every slot, so !schedulerSlots.length is false', () => {
    const rows = [
      practiceSlotRow({ id: 'a' }),
      practiceSlotRow({ id: 'b' }),
      practiceSlotRow({ id: 'c' }),
    ];
    const { schedulerSlots, unplaceableSlots } = partitionPracticeSlots(rows, {
      seasonSetting: STALE_SEASON,
      timezone: STALE_SEASON.timezone,
    });

    expect(schedulerSlots).toHaveLength(3);
    expect(unplaceableSlots).toHaveLength(0);
    // The arm the "redundant" reading relies on, evaluated: it is false, so it
    // disables nothing in this window.
    expect(!schedulerSlots.length).toBe(false);
  });

  it('game: the same, through the games partitioner', () => {
    const rows = [gameSlotRow({ id: 'a' }), gameSlotRow({ id: 'b' })];
    const { gameSlots, unplaceableSlots } = partitionGameSlots(rows, {
      ...GAME_REFERENCE,
      timezone: STALE_SEASON.timezone,
    });

    expect(gameSlots).toHaveLength(2);
    expect(unplaceableSlots).toHaveLength(0);
    expect(!gameSlots.length).toBe(false);
  });

  it('control: reason (1) really is covered by the count arm, on both pages', () => {
    // Nothing read yet -- no season row at all, so no clock for any slot. This
    // is the case the "redundant" reading was drawn from, and it holds.
    const practice = partitionPracticeSlots([practiceSlotRow()], {
      seasonSetting: null,
      timezone: undefined,
    });
    expect(practice.schedulerSlots).toHaveLength(0);
    expect(practice.unplaceableSlots).toHaveLength(1);

    const game = partitionGameSlots([gameSlotRow()], {
      ...GAME_REFERENCE,
      timezone: undefined,
    });
    expect(game.gameSlots).toHaveLength(0);
    expect(game.unplaceableSlots).toHaveLength(1);
  });
});

describe('both schedulerDisabled arms carry the clause', () => {
  /**
   * Read from the source because the expression is inline in a component and
   * there is no seam to call. The slice is the `schedulerDisabled` declaration
   * itself, not the file: `seasonClockLoading` appears elsewhere in both pages
   * (the readiness sentence, the unplaceable summary), so a file-wide `toContain`
   * would have passed on the divergence this test exists to catch.
   */
  function schedulerDisabledExpression(relativePath) {
    const source = readFileSync(path.join(process.cwd(), relativePath), 'utf8');
    const start = source.indexOf('const schedulerDisabled =');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf(';', start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  const PAGES = [
    'frontend/src/pages/PracticeSchedulingPage.jsx',
    'frontend/src/pages/GameSchedulingPage.jsx',
  ];

  it.each(PAGES)('%s disables the scheduler while the season clock is loading', (page) => {
    const expression = schedulerDisabledExpression(page);
    expect(expression).toMatch(/^\s*seasonClockLoading \|\|$/m);
  });

  it('meta-assertion: the slice is the expression and not the whole file', () => {
    for (const page of PAGES) {
      const expression = schedulerDisabledExpression(page);
      // Short enough to be one declaration...
      expect(expression.length).toBeLessThan(400);
      // ...and it really is the one, carrying the arm both pages already had.
      expect(expression).toMatch(/canManageSchedule/);
      // The control that makes the `toMatch` above meaningful: a clause the
      // expression does NOT contain is not found by the same reader.
      expect(expression).not.toMatch(/^\s*seasonClockMissing \|\|$/m);
    }
  });
});
