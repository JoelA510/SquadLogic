import { describe, it, expect } from 'vitest';
import { AssignmentSchema, SlotSchema } from '../packages/core/src/schemas/index.js';
import { scheduleGames, generateRoundRobinWeeks } from '../packages/core/src/gameScheduling.js';

/**
 * GAP-30's nominal subject.
 *
 * `SlotSchema.start/end` and `AssignmentSchema.start/end` were a `z.coerce`
 * date. Two things were wrong with it at once:
 *
 * 1. **It was decorative.** Every call site parsed for the side effect, dropped
 *    the result and rebuilt the same `Date` by hand one line later.
 * 2. **It was a host-zone parser.** Executed on `origin/main` under
 *    `TZ=America/Los_Angeles`, `SlotSchema.parse({start: '2026-11-07T16:44:00'})`
 *    returned `2026-11-08T00:44:00.000Z` — the schema guessing a zone in front
 *    of the code that guessed the same zone.
 *
 * It is now `InstantSchema`: it refuses a naive wall reading, and its result is
 * the only source of `start`/`end` at all five call sites. Only the first of
 * those two is testable — see the note on the second describe block.
 */

const SLOT = {
  id: 'slot-1',
  capacity: 1,
  weekIndex: 1,
  fieldId: 'field-a',
  division: 'U10',
};

const ASSIGNMENT = {
  weekIndex: 1,
  division: 'U10',
  slotId: 'slot-1',
  homeTeamId: 'team-1',
  awayTeamId: 'team-2',
};

describe('InstantSchema: what an instant is allowed to be', () => {
  it.each([
    ['a Z string', '2026-11-07T21:44:00Z'],
    ['an offset string', '2026-11-07T16:44:00-05:00'],
    ['a millisecond Z string', '2026-11-07T21:44:00.000Z'],
    ['a Date', new Date('2026-11-07T21:44:00Z')],
    ['an epoch number', Date.parse('2026-11-07T21:44:00Z')],
  ])('accepts %s and yields the same instant', (_label, start) => {
    const parsed = SlotSchema.parse({ ...SLOT, start, end: '2026-11-07T23:14:00Z' });
    expect(parsed.start).toBeInstanceOf(Date);
    expect(parsed.start.toISOString()).toBe('2026-11-07T21:44:00.000Z');
  });

  it.each([
    ['2026-11-07T16:44:00'],
    ['2026-11-07T16:44'],
    ['2026-11-07T16:44:00.000'],
  ])('refuses the naive wall reading %s', (start) => {
    let thrown = null;
    try {
      SlotSchema.parse({ ...SLOT, start, end: '2026-11-07T23:14:00Z' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown.issues[0].message).toMatch(/must carry a timezone/);
    expect(thrown.issues[0].path).toEqual(['start']);
  });

  it('refuses an unreadable value', () => {
    expect(() => SlotSchema.parse({ ...SLOT, start: 'nope', end: 'nope' })).toThrow(
      /valid date or instant/
    );
  });

  it('keeps the end-after-start refinement comparing instants', () => {
    expect(() =>
      SlotSchema.parse({ ...SLOT, start: '2026-11-07T21:44:00Z', end: '2026-11-07T20:00:00Z' })
    ).toThrow(/must end after it starts/);
    // Mixed representations of the same two instants must compare the same way,
    // which string comparison would not have managed.
    expect(() =>
      SlotSchema.parse({
        ...SLOT,
        start: '2026-11-07T21:44:00.000Z',
        end: '2026-11-07T18:14:00-05:00',
      })
    ).not.toThrow();
  });

  it('passes unknown keys through untouched', () => {
    const parsed = SlotSchema.parse({
      ...SLOT,
      start: '2026-11-07T21:44:00Z',
      end: '2026-11-07T23:14:00Z',
      priority: 7,
      baseSlotId: 'base-1',
    });
    expect(parsed.priority).toBe(7);
    expect(parsed.baseSlotId).toBe('base-1');
    expect(parsed.weekIndex).toBe(1);
  });

  it('applies the same rule to AssignmentSchema', () => {
    const parsed = AssignmentSchema.parse({
      ...ASSIGNMENT,
      start: '2026-11-07T16:44:00-05:00',
      end: '2026-11-07T18:14:00-05:00',
    });
    expect(parsed.start.toISOString()).toBe('2026-11-07T21:44:00.000Z');
    expect(() =>
      AssignmentSchema.parse({
        ...ASSIGNMENT,
        start: '2026-11-07T16:44:00',
        end: '2026-11-07T18:14:00',
      })
    ).toThrow(/must carry a timezone/);
  });
});

describe('InstantSchema: the solver refuses a naive slot rather than guessing', () => {
  // **What these do and do not prove, stated rather than implied.** The five
  // call sites now read `parsed.start` instead of rebuilding `new Date(x)`, and
  // no test here can show that, because with the schema refusing naive input
  // the two expressions are interchangeable by construction. A deliberate
  // break — reverting `gameScheduling.js` to `new Date(slot.start)` — leaves
  // all 14 of these green, which is the honest answer: honouring the parse
  // result is a duplication removal, and the *refusal* below is the behaviour
  // change. Claiming otherwise would be the hollow guarantee CLAUDE.md names.
  it('the solver refuses a naive slot rather than guessing a zone', () => {
    // Before, `indexSlots()` parsed, dropped the result, and called
    // `new Date(slot.start)` itself — so a naive slot sailed through with the
    // host's offset.
    expect(() =>
      scheduleGames({
        teams: [
          { id: 'team-1', division: 'U10' },
          { id: 'team-2', division: 'U10' },
        ],
        slots: [
          { ...SLOT, start: '2026-11-07T16:44:00', end: '2026-11-07T18:14:00' },
        ],
        roundRobinByDivision: {
          U10: generateRoundRobinWeeks({ teamIds: ['team-1', 'team-2'] }),
        },
      })
    ).toThrow(/must carry a timezone/);
  });

  it('and schedules the same slot once it carries a zone', () => {
    // The meta-assertion for the test above: a solver that threw on every slot
    // would satisfy it and be useless.
    const { assignments } = scheduleGames({
      teams: [
        { id: 'team-1', division: 'U10' },
        { id: 'team-2', division: 'U10' },
      ],
      slots: [{ ...SLOT, start: '2026-11-07T16:44:00-05:00', end: '2026-11-07T18:14:00-05:00' }],
      roundRobinByDivision: {
        U10: generateRoundRobinWeeks({ teamIds: ['team-1', 'team-2'] }),
      },
    });
    expect(assignments).toHaveLength(1);
    expect(assignments[0].start).toBe('2026-11-07T21:44:00.000Z');
  });
});
