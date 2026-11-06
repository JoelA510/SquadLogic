/**
 * `scheduleGames({ pinned })`: the generator keeps Published games (plan
 * `docs/changes/2026-11-03-schedule-expansion.md`, section 3.5, PR 2 task B1; rule 14, the solver).
 *
 * **What `pinned` is.** An array of SAVED games (the shape the page holds after a read:
 * `id`, `slotId`, `weekIndex`, `homeTeamId`, `awayTeamId`, `start`, `end`, ...). Each one
 *
 *   1. takes one unit of its slot's capacity,
 *   2. consumes one matchup of its unordered pair, the same week if the round robin has one,
 *      else the pair's earliest other week; a pair outside every round robin consumes none,
 *   3. is registered where a placed game is (its teams' week, its coaches' time, the shared-slot
 *      usage, each team's usual start time), so a new game cannot clash with it,
 *   4. is returned unchanged, in `carried`, beside the new `assignments`.
 *
 * **The first block is the one that matters most.** With no `pinned` the function is today's, byte
 * for byte: the digests below were taken from `origin/main` (4750b2d) BEFORE `gameScheduling.js`
 * was touched, over a league built from `fixtures/schedule-2026/` (132 teams, nine Saturdays)
 * and over a small league that reaches every reason a matchup can be left unplaced. A digest
 * that cannot move proves nothing, so the block also shows it moves when the input does.
 *
 * **Identity, said plainly.** The save keys its upsert on (home, away, slot, week) and writes no
 * id, so a pinned game keeps its row, and its id, only if it comes back with the same tuple.
 * `carried` is the pinned game itself, id and all; nothing here can move one.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Papa from 'papaparse';
import { describe, expect, it } from 'vitest';
import {
  buildDivisionRoundRobins,
  savedSides,
  scheduleGames,
} from '../packages/core/src/gameScheduling.js';

/* -------------------------------------------------------------------------- */
/* Digests of the BASE (origin/main 4750b2d), taken before the solver was touched */
/* -------------------------------------------------------------------------- */

const BASE_DIGESTS = Object.freeze({
  seasonRoomy: 'cad9b44ee534feeae9de077fda52c8e5615efea21ddbaf7dd028b7aac55b851a',
  seasonTight: 'a68a26955b5f39683e770152b12b3df8058b478166c4c3515daa97289385af5f',
  small: '8df62de990fe0fde2445e25458fbb75bb67f373f2a2ae60f81a2e8474f6d7d23',
});

const digestOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/* -------------------------------------------------------------------------- */
/* The league of fixtures/schedule-2026, as inputs to the generator             */
/* -------------------------------------------------------------------------- */

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'schedule-2026'
);
const readCsv = (name) =>
  Papa.parse(readFileSync(path.join(FIXTURE_DIR, name), 'utf8'), {
    header: true,
    skipEmptyLines: true,
  }).data;

const SATURDAYS = [
  '2026-09-12',
  '2026-09-19',
  '2026-09-26',
  '2026-10-03',
  '2026-10-10',
  '2026-10-17',
  '2026-10-24',
  '2026-10-31',
  '2026-11-07',
];
/** First start and block length (minutes) by venue letter; venue G hosts only outside clubs. */
const VENUE_RULES = {
  A: ['08:00', 60],
  B: ['08:00', 60],
  C: ['08:30', 75],
  D: ['08:30', 75],
  E: ['09:00', 90],
  F: ['09:00', 90],
};
const BLOCK_GAP = 15;
const pad2 = (n) => String(n).padStart(2, '0');
const hhmm = (minutes) => `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
const minutesOf = (text) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5));

/**
 * The 132 teams of the fixture, a round robin of nine weeks per division (the product's cycle,
 * then the same cycle with the sides swapped, as the fixture builder lays it), and a grid of
 * slots: every field of venues A to F, nine Saturdays, `blocks` games a field a day.
 */
function seasonLeague({ blocks }) {
  const teams = readCsv('teams.csv').map((row) => ({
    id: row.Team,
    name: row.Team,
    division: row.Division,
    coachId: row['Coach 1'],
    assistantCoachIds: [row['Coach 2'], row['Coach 3']].filter(Boolean),
  }));
  const first = buildDivisionRoundRobins(teams).roundRobinByDivision;
  const swapped = [];
  for (const weeks of Object.values(first))
    for (const w of weeks)
      for (const m of w.matchups)
        swapped.push({ homeTeamId: m.awayTeamId, awayTeamId: m.homeTeamId });
  const second = buildDivisionRoundRobins(teams, { keepSides: swapped }).roundRobinByDivision;
  const roundRobinByDivision = {};
  for (const division of Object.keys(first)) {
    const one = first[division];
    const two = second[division];
    roundRobinByDivision[division] = Array.from({ length: 9 }, (_, i) => {
      const src = i < one.length ? one[i] : two[(i - one.length) % two.length];
      return { weekIndex: i + 1, matchups: src.matchups, byes: src.byes };
    });
  }
  const slots = [];
  for (const { Venue, Field } of readCsv('venues.csv')) {
    const letter = Venue.slice(-1);
    if (!VENUE_RULES[letter]) continue;
    const [base, length] = VENUE_RULES[letter];
    for (let w = 0; w < SATURDAYS.length; w += 1)
      for (let b = 0; b < blocks; b += 1) {
        const start = hhmm(minutesOf(base) + b * (length + BLOCK_GAP));
        const end = hhmm(minutesOf(start) + length);
        slots.push({
          id: `slot-${letter}${Field.slice(-1)}-w${w + 1}-b${b + 1}`,
          weekIndex: w + 1,
          capacity: 1,
          fieldId: `${letter}${Field.slice(-1)}`,
          start: `${SATURDAYS[w]}T${start}:00Z`,
          end: `${SATURDAYS[w]}T${end}:00Z`,
        });
      }
  }
  return { teams, slots, roundRobinByDivision };
}

/* -------------------------------------------------------------------------- */
/* A small league that reaches every reason a matchup is left unplaced           */
/* -------------------------------------------------------------------------- */

function smallLeague() {
  const teams = [
    { id: 't1', name: 'T1', division: 'U10', coachId: 'cx' },
    { id: 't2', name: 'T2', division: 'U10', coachId: 'cy' },
    { id: 't3', name: 'T3', division: 'U10', coachId: 'cy' },
    { id: 't4', name: 'T4', division: 'U10', coachId: 'c4' },
    { id: 't5', name: 'T5', division: 'U10', coachId: 'c5' },
    { id: 'u1', name: 'U1', division: 'U12', coachId: 'cx' },
    { id: 'u2', name: 'U2', division: 'U12', coachId: 'c6' },
    { id: 'u3', name: 'U3', division: 'U12', coachId: 'c7' },
    { id: 'u4', name: 'U4', division: 'U12', coachId: 'c8' },
  ];
  const rr = buildDivisionRoundRobins(teams).roundRobinByDivision;
  const u10 = [
    ...rr.U10,
    // A team the roster does not hold, a team of another division, and a week repeated.
    { weekIndex: 1, matchups: [{ homeTeamId: 't1', awayTeamId: 'ghost' }], byes: [] },
    { weekIndex: 2, matchups: [{ homeTeamId: 't1', awayTeamId: 'u1' }], byes: [] },
    { weekIndex: 1, matchups: [rr.U10[0].matchups[0]], byes: [] },
  ];
  const slots = [];
  for (let w = 1; w <= 5; w += 1) {
    const day = `2026-10-0${w}`;
    // Shared slots: two fields, one hour apart so a shared coach has an overlap to fall into.
    slots.push({
      id: `sh-${w}-a`,
      weekIndex: w,
      capacity: 1,
      fieldId: 'field-a',
      priority: 2,
      start: `${day}T09:00:00Z`,
      end: `${day}T10:00:00Z`,
    });
    // Week 5 has no second shared slot, so one of its U10 matchups has nowhere to go.
    if (w !== 5) {
      slots.push({
        id: `sh-${w}-b`,
        weekIndex: w,
        capacity: w === 3 ? 2 : 1,
        fieldId: 'field-b',
        priority: 1,
        start: `${day}T09:30:00Z`,
        end: `${day}T10:30:00Z`,
      });
    }
    // A division slot for U12 only.
    if (w !== 4) {
      slots.push({
        id: `u12-${w}`,
        division: 'U12',
        weekIndex: w,
        capacity: 1,
        fieldId: 'field-c',
        priority: 1,
        start: `${day}T11:00:00Z`,
        end: `${day}T12:00:00Z`,
      });
    }
  }
  return { teams, slots, roundRobinByDivision: { ...rr, U10: u10 } };
}

const REASONS = [
  'unknown-team',
  'division-mismatch',
  'duplicate-matchup',
  'coach-coaches-both-teams',
  'coach-scheduling-conflict',
  'no-slot-available',
];
const reasonsOf = (result) => new Set(result.unscheduled.map((entry) => entry.reason));

/* -------------------------------------------------------------------------- */
/* Small builders for the hand-made worlds below                                 */
/* -------------------------------------------------------------------------- */

const team = (id, division = 'U10', coachId = `coach-${id}`) => ({
  id,
  name: id,
  division,
  coachId,
});
const slotAt = (id, weekIndex, hour, extra = {}) => ({
  id,
  weekIndex,
  capacity: 1,
  fieldId: `field-${id}`,
  start: `2026-10-0${weekIndex}T${pad2(hour)}:00:00Z`,
  end: `2026-10-0${weekIndex}T${pad2(hour + 1)}:00:00Z`,
  ...extra,
});
const weekOf = (weekIndex, ...pairs) => ({
  weekIndex,
  matchups: pairs.map(([homeTeamId, awayTeamId]) => ({ homeTeamId, awayTeamId })),
  byes: [],
});
/** A SAVED game on a slot, as the page reads one back (camel-cased columns, a zone-carrying offset). */
const savedOn = (slot, homeTeamId, awayTeamId, id, extra = {}) => ({
  id,
  runId: 'run-0',
  organizationId: 'org-1',
  division: 'U10',
  weekIndex: slot.weekIndex,
  slotId: slot.id,
  gameSlotId: slot.id,
  fieldId: slot.fieldId,
  start: slot.start.replace('Z', '+00:00'),
  end: slot.end.replace('Z', '+00:00'),
  homeTeamId,
  awayTeamId,
  assignmentSource: 'auto',
  published: true,
  ...extra,
});
const pairOf = (game) => [game.homeTeamId, game.awayTeamId].sort().join('-');
const placed = (result) =>
  result.assignments.map((a) => `${a.weekIndex}:${pairOf(a)}@${a.slotId}`).sort();

describe('scheduleGames with no pinned is the base, byte for byte', () => {
  const rooms = {
    seasonRoomy: () => seasonLeague({ blocks: 4 }),
    seasonTight: () => seasonLeague({ blocks: 1 }),
    small: smallLeague,
  };

  it('reaches what the digests claim to cover (a digest over nothing proves nothing)', () => {
    const roomy = scheduleGames(rooms.seasonRoomy());
    expect(roomy.assignments.length).toBeGreaterThan(500);
    expect(roomy.unscheduled).toEqual([]);

    const tight = scheduleGames(rooms.seasonTight());
    expect(tight.assignments.length).toBeGreaterThan(100);
    expect(reasonsOf(tight).has('no-slot-available')).toBe(true);

    const small = scheduleGames(rooms.small());
    for (const reason of REASONS) {
      expect(reasonsOf(small).has(reason), `the small league reaches ${reason}`).toBe(true);
    }
    expect(small.byes.length).toBeGreaterThan(0);
    expect(small.sharedSlotUsage.length).toBeGreaterThan(0);
  });

  for (const name of Object.keys(rooms)) {
    it(`${name}: the output hashes to what origin/main produced`, () => {
      expect(digestOf(scheduleGames(rooms[name]()))).toBe(BASE_DIGESTS[name]);
    });
  }

  it('the output has no `carried` key at all when nothing is pinned', () => {
    expect(Object.keys(scheduleGames(rooms.small())).sort()).toEqual([
      'assignments',
      'byes',
      'sharedSlotUsage',
      'unscheduled',
    ]);
  });

  it('an empty pinned list changes nothing but adds an empty carried', () => {
    for (const name of Object.keys(rooms)) {
      const plain = scheduleGames(rooms[name]());
      const withEmpty = scheduleGames({ ...rooms[name](), pinned: [] });
      expect(withEmpty.carried).toEqual([]);
      const { carried, ...rest } = withEmpty;
      expect(carried).toEqual([]);
      expect(digestOf(rest)).toBe(digestOf(plain));
    }
  });

  it('the digest can fail: one slot more capacity moves it', () => {
    const input = rooms.small();
    const roomier = {
      ...input,
      slots: input.slots.map((slot) =>
        slot.id === 'sh-1-a' ? { ...slot, capacity: slot.capacity + 1 } : slot
      ),
    };
    expect(digestOf(scheduleGames(roomier))).not.toBe(BASE_DIGESTS.small);
  });
});

describe('scheduleGames({ pinned }) holds a saved game where it is', () => {
  it('a pinned game on the only slot leaves the new matchup TIME TBD instead of double-booking it', () => {
    const teams = [team('a'), team('b'), team('c'), team('d')];
    const slots = [slotAt('s1', 1, 9)];
    const roundRobinByDivision = { U10: [weekOf(1, ['a', 'b'], ['c', 'd'])] };

    // The control: nothing pinned, the first matchup takes the slot and the second is the one left out.
    const plain = scheduleGames({ teams, slots, roundRobinByDivision });
    expect(placed(plain)).toEqual(['1:a-b@s1']);
    expect(plain.unscheduled.map((u) => pairOf(u.matchup))).toEqual(['c-d']);

    // Pinned: (c, d) holds the slot, so the new matchup is (a, b) and it has nowhere to go.
    const pinned = [savedOn(slots[0], 'c', 'd', 'ga-1')];
    const out = scheduleGames({ teams, slots, roundRobinByDivision, pinned });
    expect(out.assignments).toEqual([]);
    expect(out.unscheduled).toEqual([
      {
        weekIndex: 1,
        division: 'U10',
        matchup: { homeTeamId: 'a', awayTeamId: 'b' },
        reason: 'no-slot-available',
      },
    ]);
    expect(out.carried).toEqual(pinned);
  });

  it('carried is the pinned game itself: id, slot, time, sides and every other field', () => {
    const teams = [team('a'), team('b')];
    const slots = [slotAt('s1', 1, 9), slotAt('s2', 2, 9)];
    const roundRobinByDivision = { U10: [weekOf(1, ['a', 'b'])] };
    const pinned = [
      savedOn(slots[1], 'b', 'a', 'ga-77', {
        publishedAt: '2026-11-01T10:00:00+00:00',
        publishedBy: 'user-9',
        note: 'kept as is',
      }),
    ];
    const snapshot = JSON.stringify(pinned);
    const out = scheduleGames({ teams, slots, roundRobinByDivision, pinned });
    expect(out.carried).toEqual(pinned);
    expect(out.carried[0].id).toBe('ga-77');
    expect(JSON.stringify(out.carried)).toBe(snapshot);
    // The caller's own array is not touched, and the result does not alias it.
    expect(JSON.stringify(pinned)).toBe(snapshot);
    expect(out.carried[0]).not.toBe(pinned[0]);
    // (a, b) was in the round robin once, the pinned game consumed it: nothing new for the pair.
    expect(out.assignments).toEqual([]);
    expect(out.unscheduled).toEqual([]);
  });

  describe('a pinned game consumes one matchup of its pair, the same week when it can', () => {
    // (a, b) meets twice, in weeks 1 and 3 (the second cycle of a season); weeks hold two slots.
    const teams = [team('a'), team('b'), team('c'), team('d')];
    const slots = [];
    for (let w = 1; w <= 4; w += 1) {
      slots.push(slotAt(`s${w}a`, w, 9), slotAt(`s${w}b`, w, 11));
    }
    const roundRobinByDivision = {
      U10: [
        weekOf(1, ['a', 'b'], ['c', 'd']),
        weekOf(2, ['a', 'c'], ['b', 'd']),
        weekOf(3, ['a', 'b'], ['c', 'd']),
      ],
    };
    const slot = (id) => slots.find((s) => s.id === id);
    const abWeeks = (result) =>
      result.assignments
        .filter((a) => pairOf(a) === 'a-b')
        .map((a) => a.weekIndex)
        .sort();

    it('the control: nothing pinned generates both meetings', () => {
      expect(abWeeks(scheduleGames({ teams, slots, roundRobinByDivision }))).toEqual([1, 3]);
    });

    it('pinned in week 3: the week-3 meeting is the one consumed', () => {
      const pinned = [savedOn(slot('s3b'), 'a', 'b', 'ga-1')];
      const out = scheduleGames({ teams, slots, roundRobinByDivision, pinned });
      expect(abWeeks(out)).toEqual([1]);
      expect(out.unscheduled).toEqual([]);
    });

    it('pinned in week 1: the week-1 meeting is the one consumed', () => {
      const pinned = [savedOn(slot('s1b'), 'a', 'b', 'ga-1')];
      const out = scheduleGames({ teams, slots, roundRobinByDivision, pinned });
      expect(abWeeks(out)).toEqual([3]);
    });

    it('pinned in a week the pair does not meet: the earliest meeting is consumed, and both teams are busy that week', () => {
      const pinned = [savedOn(slot('s2b'), 'a', 'b', 'ga-1')];
      const out = scheduleGames({ teams, slots, roundRobinByDivision, pinned });
      expect(abWeeks(out)).toEqual([3]);
      // Week 2 had (a, c) and (b, d); a and b are playing the pinned game, so both wait, said so.
      expect(
        out.unscheduled.map((u) => `${u.weekIndex}:${pairOf(u.matchup)}:${u.reason}`).sort()
      ).toEqual(['2:a-c:duplicate-matchup', '2:b-d:duplicate-matchup']);
    });

    it('two pinned games of the pair consume both meetings, whatever order they arrive in', () => {
      const early = savedOn(slot('s1b'), 'a', 'b', 'ga-1');
      const late = savedOn(slot('s3b'), 'b', 'a', 'ga-2');
      const forward = scheduleGames({ teams, slots, roundRobinByDivision, pinned: [early, late] });
      const backward = scheduleGames({ teams, slots, roundRobinByDivision, pinned: [late, early] });
      expect(abWeeks(forward)).toEqual([]);
      expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
    });

    it('a third pinned game of the pair has no meeting left to consume and consumes none', () => {
      const pinned = [
        savedOn(slot('s1b'), 'a', 'b', 'ga-1'),
        savedOn(slot('s3b'), 'a', 'b', 'ga-2'),
        savedOn(slot('s4b'), 'a', 'b', 'ga-3'),
      ];
      const out = scheduleGames({ teams, slots, roundRobinByDivision, pinned });
      expect(abWeeks(out)).toEqual([]);
      expect(out.carried.map((g) => g.id)).toEqual(['ga-1', 'ga-2', 'ga-3']);
      // Every other meeting is still generated: (c, d) twice and (a, c), (b, d).
      expect(placed(out).filter((p) => !p.includes('a-b'))).toHaveLength(4);
    });
  });

  it('a pair outside the round robin occupies its slot and consumes no matchup', () => {
    const teams = [team('a'), team('b'), team('x', 'U12')];
    const slots = [slotAt('s1', 1, 9), slotAt('s2', 1, 11)];
    const roundRobinByDivision = { U10: [weekOf(1, ['a', 'b'])] };

    // (a, x) are different divisions: no round robin holds the pair (an exhibition, an outside side).
    const pinned = [savedOn(slots[0], 'a', 'x', 'ga-1', { division: 'U10' })];
    const out = scheduleGames({ teams, slots, roundRobinByDivision, pinned });
    expect(out.carried.map((g) => g.id)).toEqual(['ga-1']);
    // Nothing was consumed: (a, b) is still a matchup of the round robin. But `a` plays the pinned
    // game that week, so it waits, and says why.
    expect(out.assignments).toEqual([]);
    expect(out.unscheduled).toEqual([
      {
        weekIndex: 1,
        division: 'U10',
        matchup: { homeTeamId: 'a', awayTeamId: 'b' },
        reason: 'duplicate-matchup',
      },
    ]);

    // The slot is occupied all the same: a different pair that week has only the other slot.
    const other = scheduleGames({
      teams: [...teams, team('c'), team('d')],
      slots,
      roundRobinByDivision: { U10: [weekOf(1, ['c', 'd'])] },
      pinned,
    });
    expect(placed(other)).toEqual(['1:c-d@s2']);
  });

  describe('a new game cannot clash with a pinned game', () => {
    it("a team does not play twice in the pinned game's week", () => {
      const teams = [team('a'), team('b'), team('c'), team('d')];
      const slots = [slotAt('s1', 1, 9), slotAt('s2', 1, 11), slotAt('s3', 2, 9)];
      const roundRobinByDivision = {
        U10: [weekOf(1, ['a', 'c'], ['b', 'd']), weekOf(2, ['a', 'b'], ['c', 'd'])],
      };
      const control = scheduleGames({ teams, slots, roundRobinByDivision });
      expect(placed(control)).toContain('1:a-c@s1');
      expect(placed(control)).toContain('1:b-d@s2');

      const pinned = [savedOn(slots[0], 'a', 'b', 'ga-1')];
      const out = scheduleGames({ teams, slots, roundRobinByDivision, pinned });
      expect(
        out.unscheduled.map((u) => `${u.weekIndex}:${pairOf(u.matchup)}:${u.reason}`).sort()
      ).toEqual(['1:a-c:duplicate-matchup', '1:b-d:duplicate-matchup', '2:c-d:no-slot-available']);
      // The pinned game took (a, b)'s only meeting (week 2) and the one slot of week 2 goes to (c, d)... or
      // nowhere: week 2 has one slot and (a, b) was consumed, so (c, d) is the game left to place.
      expect(out.assignments.map((a) => `${a.weekIndex}:${pairOf(a)}`)).toEqual(['2:c-d']);
    });

    it("a coach is not at two places at the pinned game's time", () => {
      // `a` and `e` share a coach; `a` has a pinned game 09:00-10:00 on field one. `e`'s only other
      // slot overlaps it, so the new game goes to the slot that does not.
      const teams = [
        team('a', 'U10', 'shared'),
        team('b'),
        team('e', 'U12', 'shared'),
        team('f', 'U12'),
      ];
      const pinnedSlot = slotAt('s1', 1, 9);
      const overlapping = slotAt('s2', 1, 9, {
        start: '2026-10-01T09:30:00Z',
        end: '2026-10-01T10:30:00Z',
      });
      const clear = slotAt('s3', 1, 11);
      const roundRobinByDivision = { U12: [weekOf(1, ['e', 'f'])] };
      const pinned = [savedOn(pinnedSlot, 'a', 'b', 'ga-1')];

      // Without the slot that is clear of the pinned game, the new game is left out for the coach.
      const blocked = scheduleGames({
        teams,
        slots: [pinnedSlot, overlapping],
        roundRobinByDivision,
        pinned,
      });
      expect(blocked.assignments).toEqual([]);
      expect(blocked.unscheduled.map((u) => u.reason)).toEqual(['coach-scheduling-conflict']);

      // With it, the new game takes that one.
      const free = scheduleGames({
        teams,
        slots: [pinnedSlot, overlapping, clear],
        roundRobinByDivision,
        pinned,
      });
      expect(placed(free)).toEqual(['1:e-f@s3']);

      // The control: with nothing pinned the overlapping slot was fine, so it is the pin that moved it.
      const plain = scheduleGames({
        teams,
        slots: [pinnedSlot, overlapping],
        roundRobinByDivision,
      });
      expect(plain.assignments).toHaveLength(1);
    });
  });

  it('a pinned game keeps the sides it was saved with, and the pair is not generated again', () => {
    const teams = [team('a'), team('b'), team('c'), team('d')];
    const slots = [
      slotAt('s1', 1, 9),
      slotAt('s2', 1, 11),
      slotAt('s3', 2, 9),
      slotAt('s4', 2, 11),
    ];
    // The rule alone has the smaller id host; the saved game has b at home to a.
    const naturalWeeks = buildDivisionRoundRobins(teams).roundRobinByDivision;
    const natural = naturalWeeks.U10.flatMap((w) => w.matchups).find((m) => pairOf(m) === 'a-b');
    expect(natural.homeTeamId).toBe('a');

    const pinned = [savedOn(slots[0], 'b', 'a', 'ga-1')];
    // The page's own pipeline: the saved sides feed the round robin, then the generator.
    const { roundRobinByDivision } = buildDivisionRoundRobins(teams, {
      keepSides: savedSides(pinned),
    });
    const out = scheduleGames({ teams, slots, roundRobinByDivision, pinned });
    expect(out.carried[0].homeTeamId).toBe('b');
    expect(out.carried[0].awayTeamId).toBe('a');
    expect(out.assignments.filter((g) => pairOf(g) === 'a-b')).toEqual([]);

    // And without keepSides the round robin may say the opposite; the carried game still says b.
    const unkept = scheduleGames({
      teams,
      slots,
      roundRobinByDivision: naturalWeeks,
      pinned,
    });
    expect(unkept.carried[0].homeTeamId).toBe('b');
    expect(unkept.assignments.filter((g) => pairOf(g) === 'a-b')).toEqual([]);
  });

  it('is the same whatever order the pinned games arrive in', () => {
    const { teams, slots, roundRobinByDivision } = smallLeague();
    const base = scheduleGames({ teams, slots, roundRobinByDivision });
    const pinned = base.assignments
      .filter((_, i) => i % 3 === 0)
      .map((a, i) =>
        savedOn(
          slots.find((s) => s.id === a.slotId),
          a.homeTeamId,
          a.awayTeamId,
          `ga-${i}`,
          { division: a.division }
        )
      );
    expect(pinned.length).toBeGreaterThan(2);
    const forward = scheduleGames({ teams, slots, roundRobinByDivision, pinned });
    const backward = scheduleGames({
      teams,
      slots,
      roundRobinByDivision,
      pinned: [...pinned].reverse(),
    });
    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
  });

  it('carries a pinned game whose slot is not among the slots, and still keeps its teams busy that week', () => {
    const teams = [team('a'), team('b'), team('c'), team('d')];
    const slots = [slotAt('s1', 1, 9), slotAt('s2', 1, 11)];
    const gone = slotAt('gone', 1, 13);
    const pinned = [savedOn(gone, 'a', 'b', 'ga-1')];
    const out = scheduleGames({
      teams,
      slots,
      roundRobinByDivision: { U10: [weekOf(1, ['a', 'b'], ['c', 'd'])] },
      pinned,
    });
    expect(out.carried.map((g) => g.id)).toEqual(['ga-1']);
    expect(placed(out)).toEqual(['1:c-d@s1']);
  });

  it('counts a pinned game on a shared slot in the shared-slot usage, and a division slot not', () => {
    const teams = [team('a'), team('b'), team('c'), team('d')];
    const shared = slotAt('sh', 1, 9, { capacity: 2 });
    const own = slotAt('own', 1, 11, { division: 'U10' });
    const roundRobinByDivision = { U10: [weekOf(1, ['c', 'd'])] };
    const onShared = scheduleGames({
      teams,
      slots: [shared, own],
      roundRobinByDivision,
      pinned: [savedOn(shared, 'a', 'b', 'ga-1')],
    });
    expect(onShared.sharedSlotUsage.find((u) => u.slotId === 'sh')?.totalAssignments).toBe(1);
    const onOwn = scheduleGames({
      teams,
      slots: [shared, own],
      roundRobinByDivision,
      pinned: [savedOn(own, 'a', 'b', 'ga-1')],
    });
    expect(onOwn.sharedSlotUsage.find((u) => u.slotId === 'own')).toBeUndefined();
  });

  it("a team's pinned game sets the start time its new games prefer", () => {
    const teams = [team('a'), team('b'), team('c'), team('d')];
    const early = slotAt('early', 2, 8, { division: 'U10' });
    const usual = slotAt('usual', 2, 10, { division: 'U10' });
    const week1 = slotAt('w1', 1, 10, { division: 'U10' });
    const roundRobinByDivision = { U10: [weekOf(2, ['a', 'c'])] };
    // Nothing pinned: the earliest slot.
    expect(placed(scheduleGames({ teams, slots: [early, usual], roundRobinByDivision }))).toEqual([
      '2:a-c@early',
    ]);
    // `a` has a pinned game at ten o'clock in week 1, so ten o'clock is its usual time.
    const out = scheduleGames({
      teams,
      slots: [early, usual, week1],
      roundRobinByDivision,
      pinned: [savedOn(week1, 'a', 'b', 'ga-1')],
    });
    expect(placed(out)).toEqual(['2:a-c@usual']);
  });

  it('refuses a freeze, now naming pinned as the way to hold saved games', () => {
    const input = {
      teams: [team('a'), team('b')],
      slots: [slotAt('s1', 1, 9)],
      roundRobinByDivision: { U10: [weekOf(1, ['a', 'b'])] },
    };
    for (const extra of [{ freeze: {} }, { freeze: null }, { freeze: {}, pinned: [] }]) {
      let error = null;
      try {
        scheduleGames({ ...input, ...extra });
      } catch (thrown) {
        error = thrown;
      }
      expect(error).toBeInstanceOf(TypeError);
      expect(error.message).toContain('resolve/applyChangeRequest()');
      expect(error.message).toContain('pinned');
    }
  });

  describe('refuses a pinned list it cannot honour, rather than skip a Published game', () => {
    const slots = [slotAt('s1', 1, 9)];
    const teams = [team('a'), team('b')];
    const roundRobinByDivision = { U10: [weekOf(1, ['a', 'b'])] };
    const call = (pinned) => () => scheduleGames({ teams, slots, roundRobinByDivision, pinned });
    const good = savedOn(slots[0], 'a', 'b', 'ga-1');

    it('not an array', () => {
      expect(call(null)).toThrow(TypeError);
      expect(call({})).toThrow(/pinned must be an array/);
    });

    it('an entry that is not a game', () => {
      expect(call([null])).toThrow(TypeError);
      expect(call([{ ...good, homeTeamId: undefined }])).toThrow(/pinned\[0\]/);
      expect(call([{ ...good, awayTeamId: 'a' }])).toThrow(/pinned\[0\]/);
      expect(call([{ ...good, slotId: undefined, gameSlotId: undefined }])).toThrow(/pinned\[0\]/);
      expect(call([{ ...good, weekIndex: 0 }])).toThrow(/pinned\[0\]/);
    });

    it('a time that carries no zone, or ends before it starts', () => {
      expect(call([{ ...good, start: '2026-10-01T09:00:00', end: '2026-10-01T10:00:00' }])).toThrow(
        /pinned\[0\]/
      );
      expect(call([{ ...good, start: good.end, end: good.start }])).toThrow(/pinned\[0\]/);
    });

    it('a game with no time on a slot that is not among the slots', () => {
      const lost = {
        ...good,
        slotId: 'gone',
        gameSlotId: 'gone',
        start: undefined,
        end: undefined,
      };
      expect(call([lost])).toThrow(/pinned\[0\]/);
      // The same game on a known slot reads its time from the slot.
      const found = scheduleGames({
        teams,
        slots,
        roundRobinByDivision,
        pinned: [{ ...good, start: undefined, end: undefined }],
      });
      expect(found.carried).toHaveLength(1);
    });
  });
});

describe('a regeneration around pinned games, over the whole season league', () => {
  /** What must hold of every set of games that are all going to be saved together. */
  function violations({ games, teams, slots }) {
    const out = [];
    const capacity = new Map(slots.map((s) => [s.id, s.capacity]));
    const perSlot = new Map();
    const perTeamWeek = new Map();
    const coachesOf = new Map(
      teams.map((t) => [t.id, [t.coachId, ...(t.assistantCoachIds ?? [])]])
    );
    const perCoach = new Map();
    for (const g of games) {
      perSlot.set(g.slotId, (perSlot.get(g.slotId) ?? 0) + 1);
      for (const id of [g.homeTeamId, g.awayTeamId]) {
        const key = `${id}::${g.weekIndex}`;
        perTeamWeek.set(key, (perTeamWeek.get(key) ?? 0) + 1);
        for (const coach of coachesOf.get(id) ?? []) {
          const list = perCoach.get(coach) ?? [];
          list.push([Date.parse(g.start), Date.parse(g.end), `${g.homeTeamId}-${g.awayTeamId}`]);
          perCoach.set(coach, list);
        }
      }
    }
    for (const [id, n] of perSlot) if (n > capacity.get(id)) out.push(`slot ${id} holds ${n}`);
    for (const [key, n] of perTeamWeek) if (n > 1) out.push(`${key} plays ${n}`);
    for (const [coach, list] of perCoach) {
      list.sort((x, y) => x[0] - y[0]);
      for (let i = 1; i < list.length; i += 1) {
        // The same game reaches a coach twice when they coach both sides; that is one game.
        if (list[i][0] < list[i - 1][1] && list[i][2] !== list[i - 1][2])
          out.push(`coach ${coach} is at ${list[i - 1][2]} and ${list[i][2]}`);
      }
    }
    return out;
  }

  const league = seasonLeague({ blocks: 4 });
  const base = scheduleGames(league);
  const saved = base.assignments.map((a, i) => ({
    ...a,
    id: `ga-${i}`,
    gameSlotId: a.slotId,
    published: true,
  }));
  const pinned = saved.filter((_, i) => i % 3 === 0);

  it('the checker can fail: a base run and the same pins laid over it are double-booked', () => {
    // A generator that ignored `pinned` lays a fresh run beside the saved games; the checker must object.
    const ignoring = scheduleGames(league).assignments;
    const found = violations({
      games: [...pinned, ...ignoring],
      teams: league.teams,
      slots: league.slots,
    });
    expect(found.length).toBeGreaterThan(pinned.length);
    expect(
      violations({ games: base.assignments, teams: league.teams, slots: league.slots })
    ).toEqual([]);
  });

  it('a third of the league pinned: the pinned games come back as they were, the rest fills around them', () => {
    const out = scheduleGames({ ...league, pinned });
    expect(out.carried).toHaveLength(pinned.length);
    expect(out.carried.map((g) => g.id).sort()).toEqual(pinned.map((g) => g.id).sort());
    for (const kept of out.carried) {
      const was = pinned.find((g) => g.id === kept.id);
      expect(kept).toEqual(was);
    }
    // Each pinned game used up exactly one matchup, so nothing is gained or lost.
    expect(out.carried.length + out.assignments.length + out.unscheduled.length).toBe(
      base.assignments.length + base.unscheduled.length
    );
    expect(out.unscheduled).toEqual([]);
    // No new game is a pinned one again.
    const pinnedKeys = new Set(pinned.map((g) => `${g.weekIndex}:${pairOf(g)}`));
    expect(out.assignments.filter((a) => pinnedKeys.has(`${a.weekIndex}:${pairOf(a)}`))).toEqual(
      []
    );
    expect(
      violations({
        games: [...out.carried, ...out.assignments],
        teams: league.teams,
        slots: league.slots,
      })
    ).toEqual([]);
  });

  it('every game pinned: nothing new is placed, nothing is left out, all of it is carried', () => {
    const out = scheduleGames({ ...league, pinned: saved });
    expect(out.assignments).toEqual([]);
    expect(out.unscheduled).toEqual([]);
    expect(out.carried).toHaveLength(saved.length);
  });
});
