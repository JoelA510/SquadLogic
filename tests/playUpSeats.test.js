import { test } from 'vitest';
import assert from 'node:assert/strict';
import { applyPlayUpEligibility } from '../packages/core/src/playUp.js';
import { seatsFromPlacedPlayers, summarizeSeats } from '../packages/core/src/playUpSeats.js';

/*
 * `summarizeSeats` counts a league by the division each player is SEATED in, never the one they
 * registered in (docs/changes/2026-11-03-play-down-default-and-flags.md, section 4.1 and 4.2).
 *
 * The league below is small enough to count by hand. Every expected figure in this file is worked
 * out from the seats written here, with the reasoning beside them, never read back from the
 * function under test.
 *
 *   program "junior": U8 (ages 7 to 8) and U10 (ages 9 to 10)
 *   program "senior": U12 (ages 11 to 12)
 *   no program:       OPEN, a division with no age band ("Open Play": nothing to read one from)
 *
 * A seat is { playerId, naturalAge, registeredDivision, seatedDivision, requested, waitlisted };
 * `seatedDivision` is null for a player no division can hold.
 */

const divisions = [
  { id: 'U8', name: 'U8', min_age: 7, max_age: 8, program_id: 'junior' },
  { id: 'U10', name: 'U10', min_age: 9, max_age: 10, program_id: 'junior' },
  { id: 'U12', name: 'U12', min_age: 11, max_age: 12, program_id: 'senior' },
  { id: 'OPEN', name: 'Open Play' },
];

/** A seat. `seated` defaults to the division registered in. */
function seat(playerId, naturalAge, registered, seated = registered, extra = {}) {
  return {
    playerId,
    naturalAge,
    registeredDivision: registered,
    seatedDivision: seated,
    requested: false,
    waitlisted: false,
    ...extra,
  };
}

/**
 * Seventeen registrants, one letter each.
 *
 *   a  age 10 registered U12, requested, plays U12        a play-up (10 is under U12's 11)
 *   b  age 9  registered U12, requested, plays U12        a play-up
 *   c  age 8  registered U10, requested, plays U10        a play-up (8 is under U10's 9)
 *   d  age 8  registered U10, plays U8                    an unrequested play-up, moved to their own age
 *                                                         division inside program junior
 *   e  age 10 registered U12, plays U10                   an unrequested play-up, moved junior <- senior
 *   f  age 12 registered U10, plays U12                   registered younger than the age, moved
 *                                                         junior -> senior
 *   g  age 10 registered U10, waitlisted                  in band, on the waitlist
 *   h  age 9  registered U12, requested, plays U12,       a play-up on the waitlist
 *      waitlisted
 *   i  age 15 registered U10, waitlisted, no division     waitlisted AND not eligible: counted once,
 *                                                         as not eligible (lesson 87)
 *   j  age 15 registered U12, no division                 not eligible
 *   k  no age registered U10                              placed, nothing can be checked
 *   l  no age registered U10, requested                   a request with no age to judge it by
 *   m  age 10 registered OPEN                             in a division with no band
 *   n  age 10 registered OPEN, requested                  a request, and no band to judge it by
 *   o  age 10 registered U10, requested                   a request registered in their own division
 *   p  age 9  registered U10                              in band
 *   q  age 11 registered U12                              in band
 */
const seats = [
  seat('a', 10, 'U12', 'U12', { requested: true }),
  seat('b', 9, 'U12', 'U12', { requested: true }),
  seat('c', 8, 'U10', 'U10', { requested: true }),
  seat('d', 8, 'U10', 'U8'),
  seat('e', 10, 'U12', 'U10'),
  seat('f', 12, 'U10', 'U12'),
  seat('g', 10, 'U10', 'U10', { waitlisted: true }),
  seat('h', 9, 'U12', 'U12', { requested: true, waitlisted: true }),
  seat('i', 15, 'U10', null, { waitlisted: true }),
  seat('j', 15, 'U12', null),
  seat('k', null, 'U10'),
  seat('l', null, 'U10', 'U10', { requested: true }),
  seat('m', 10, 'OPEN'),
  seat('n', 10, 'OPEN', 'OPEN', { requested: true }),
  seat('o', 10, 'U10', 'U10', { requested: true }),
  seat('p', 9, 'U10'),
  seat('q', 11, 'U12'),
];

const counts = (fields) => ({
  seated: 0,
  waitlisted: 0,
  notEligible: 0,
  playingUp: 0,
  playingDown: 0,
  askedToPlayUp: 0,
  notChecked: 0,
  movedIn: 0,
  movedOut: 0,
  ...fields,
});

test('counts every division by the seat, worked from the rule by hand', () => {
  const { byDivision } = summarizeSeats({ seats, divisions });

  // U8 holds d alone (moved in from U10; in band at U8).
  assert.deepEqual(byDivision.get('U8'), counts({ seated: 1, movedIn: 1 }));

  // U10: seated c, e, k, l, o, p = 6; waitlisted g; not eligible i (registered here).
  //   playing up: c (age 8 under 9). e is in band (moved in), g is in band.
  //   asked to play up from their own division: l (no age) and o (in band). c is a play-up, not this.
  //   not checked: k and l (no age).
  //   moved in: e. moved out: d and f.
  assert.deepEqual(
    byDivision.get('U10'),
    counts({
      seated: 6,
      waitlisted: 1,
      notEligible: 1,
      playingUp: 1,
      askedToPlayUp: 2,
      notChecked: 2,
      movedIn: 1,
      movedOut: 2,
    })
  );

  // U12: seated a, b, f, q = 4; waitlisted h; not eligible j.
  //   playing up: a, b, and h (the waitlisted are counted in the flags, owner decision 4).
  //   moved in: f. moved out: e.
  assert.deepEqual(
    byDivision.get('U12'),
    counts({ seated: 4, waitlisted: 1, notEligible: 1, playingUp: 3, movedIn: 1, movedOut: 1 })
  );

  // OPEN: m and n seated, neither can be checked (no band); n asked to play up (no band to judge by).
  assert.deepEqual(byDivision.get('OPEN'), counts({ seated: 2, askedToPlayUp: 1, notChecked: 2 }));
});

test('the partition sums to the rows: seated + waitlisted + not eligible is every registrant', () => {
  const { byDivision, byProgram, league } = summarizeSeats({ seats, divisions });
  const partition = (c) => c.seated + c.waitlisted + c.notEligible;
  assert.equal(seats.length, 17);
  assert.equal(partition(league), seats.length);
  assert.equal(
    [...byDivision.values()].reduce((sum, c) => sum + partition(c), 0),
    seats.length
  );
  assert.equal(
    [...byProgram.values()].reduce((sum, c) => sum + partition(c), 0),
    seats.length
  );
  // i is both waitlisted and not eligible: counted once, as not eligible (lesson 87).
  assert.equal(league.notEligible, 2);
  assert.equal(league.waitlisted, 2);
  assert.equal(league.seated, 13);
});

test('a division is an entry even with nobody in it, and an unknown division is not dropped', () => {
  const { byDivision } = summarizeSeats({
    seats: [seat('x', 10, 'U10'), seat('y', 10, 'GHOST')],
    divisions,
  });
  assert.deepEqual(byDivision.get('U12'), counts({}));
  // A division nobody described has no band: the player is seated, and nothing can be checked.
  assert.deepEqual(byDivision.get('GHOST'), counts({ seated: 1, notChecked: 1 }));
  assert.equal(byDivision.get('U10').seated, 1);
});

test('program counts are the sum of their divisions, and a move inside a program nets to zero', () => {
  const { byProgram, league } = summarizeSeats({ seats, divisions });

  // junior = U8 + U10. Moves: d (U10 -> U8) is inside the program, so it is neither in nor out here;
  // e came in from senior; f went out to senior.
  assert.deepEqual(
    byProgram.get('junior'),
    counts({
      seated: 1 + 6,
      waitlisted: 1,
      notEligible: 1,
      playingUp: 1,
      askedToPlayUp: 2,
      notChecked: 2,
      movedIn: 1,
      movedOut: 1,
    })
  );
  // senior = U12. f came in from junior; e went out to junior.
  assert.deepEqual(
    byProgram.get('senior'),
    counts({ seated: 4, waitlisted: 1, notEligible: 1, playingUp: 3, movedIn: 1, movedOut: 1 })
  );
  // A division in no program is its own group, last, under null.
  assert.deepEqual(byProgram.get(null), counts({ seated: 2, askedToPlayUp: 1, notChecked: 2 }));
  // In the order a division of each first appears, and the group of no program last.
  assert.deepEqual([...byProgram.keys()], ['junior', 'senior', null]);

  // The league is the sum over every division. Moves are counted once in and once out for each player
  // who plays somewhere other than where they registered: d, e and f.
  assert.deepEqual(
    league,
    counts({
      seated: 13,
      waitlisted: 2,
      notEligible: 2,
      playingUp: 4,
      askedToPlayUp: 3,
      notChecked: 4,
      movedIn: 3,
      movedOut: 3,
    })
  );
});

test('with no division in a program, every division is in one group under null', () => {
  const flat = divisions.map(({ program_id: _program, ...rest }) => rest);
  const { byProgram, league } = summarizeSeats({ seats, divisions: flat });
  assert.deepEqual([...byProgram.keys()], [null]);
  // Moves inside the one group net to zero, as inside any program.
  assert.deepEqual(byProgram.get(null), { ...league, movedIn: 0, movedOut: 0 });
});

test('a count is of the seat, not the registration: moved players are not playing up or down', () => {
  const { league } = summarizeSeats({ seats, divisions });
  // d, e (registered older than their age) and f (registered younger) all play in band. Counted from
  // the division registered in, d and e would be two more play-ups and f a play-down.
  assert.equal(league.playingUp, 4);
  assert.equal(league.playingDown, 0);
});

test('a player seated below their age is playing down, wherever they registered', () => {
  const { byDivision, league } = summarizeSeats({
    seats: [
      // age 12 seated in U10 (a roster edit, or a league that allows it): playing down, registered there.
      seat('r', 12, 'U10', 'U10'),
      // age 12 registered U12, seated in U10: playing down, and moved.
      seat('s', 12, 'U12', 'U10'),
    ],
    divisions,
  });
  assert.equal(byDivision.get('U10').playingDown, 2);
  assert.equal(byDivision.get('U10').playingUp, 0);
  assert.equal(byDivision.get('U10').movedIn, 1);
  assert.equal(byDivision.get('U12').movedOut, 1);
  assert.equal(league.playingDown, 2);
});

test('a request registered in the player’s own division is its own line, never a seat play-up', () => {
  // o: age 10 registered and seated in U10 (band 9 to 10), requested. Nothing to honour.
  const { byDivision } = summarizeSeats({
    seats: [seat('o', 10, 'U10', 'U10', { requested: true })],
    divisions,
  });
  assert.equal(byDivision.get('U10').askedToPlayUp, 1);
  assert.equal(byDivision.get('U10').playingUp, 0);
  assert.equal(byDivision.get('U10').seated, 1);
});

test('an unknown age and a division with no band are not checked, never playing up and never fine', () => {
  const { byDivision, league } = summarizeSeats({
    seats: [
      seat('noAge', null, 'U10'),
      seat('noBand', 7, 'OPEN'),
      seat('noBandUnrequested', 20, 'OPEN'),
    ],
    divisions,
  });
  assert.equal(byDivision.get('U10').notChecked, 1);
  assert.equal(byDivision.get('OPEN').notChecked, 2);
  assert.equal(league.notChecked, 3);
  assert.equal(league.playingUp, 0);
  assert.equal(league.playingDown, 0);
  // Not checked is a count of its own, and the three are seated.
  assert.equal(league.seated, 3);
});

test('a division with nobody to seat has no seated player and still lists who left or was held', () => {
  // U10 registered four: two moved out to U12, one waitlisted, one not eligible. Nobody is left to seat.
  const { byDivision } = summarizeSeats({
    seats: [
      seat('w', 12, 'U10', 'U12'),
      seat('x', 12, 'U10', 'U12'),
      seat('y', 10, 'U10', 'U10', { waitlisted: true }),
      seat('z', 15, 'U10', null),
    ],
    divisions,
  });
  assert.deepEqual(
    byDivision.get('U10'),
    counts({ seated: 0, waitlisted: 1, notEligible: 1, movedOut: 2 })
  );
  assert.equal(byDivision.get('U12').seated, 2);
  assert.equal(byDivision.get('U12').movedIn, 2);
});

test('the subject set is the seats given: none is dropped, and a repeated player is refused', () => {
  const { league } = summarizeSeats({ seats, divisions });
  // A division count that skips the held-back players (waitlisted, not eligible) would not sum to 17.
  assert.equal(league.seated + league.waitlisted + league.notEligible, 17);
  assert.throws(
    () => summarizeSeats({ seats: [seat('dup', 10, 'U10'), seat('dup', 10, 'U10')], divisions }),
    /more than one seat.*dup/
  );
  assert.throws(() => summarizeSeats({ seats: 'nope', divisions }), TypeError);
  assert.throws(
    () => summarizeSeats({ seats: [{ playerId: 'lost', naturalAge: 10 }], divisions }),
    /neither a registered nor a seated division/
  );
  // No seats is a league with nobody in it, not an error.
  const empty = summarizeSeats({ seats: [], divisions });
  assert.deepEqual(empty.league, counts({}));
  assert.equal(empty.byDivision.size, divisions.length);
});

test('a division is found by id or by name, in any case, as the placement finds it', () => {
  const { byDivision } = summarizeSeats({
    seats: [seat('n1', 10, 'u10', 'U10'), seat('n2', 12, 'u10', 'u12')],
    divisions,
  });
  // n1 registered "u10" and plays "U10": the same division, so not moved.
  // n2 registered "u10" and plays "u12": moved from U10 to U12.
  assert.equal(byDivision.get('U10').movedOut, 1);
  assert.equal(byDivision.get('U10').movedIn, 0);
  assert.equal(byDivision.get('U12').movedIn, 1);
  assert.deepEqual([...byDivision.keys()], ['U8', 'U10', 'U12', 'OPEN']);
});

/* -------------------------------------------------------------------------- */
/* Seats from the placement: one seat for every player, in order               */
/* -------------------------------------------------------------------------- */

const placementDivisions = [
  { id: 'U8', name: 'U8', min_age: 7, max_age: 8 },
  { id: 'U10', name: 'U10', min_age: 9, max_age: 10 },
  { id: 'U12', name: 'U12', min_age: 11, max_age: 12 },
];

test('seats from the real placement: one per player, a blocked player has no seat', () => {
  const players = [
    { id: 'in', division: 'U10', naturalAge: 10 },
    { id: 'up', division: 'U12', naturalAge: 10, play_up_requested: true },
    { id: 'moved', division: 'U10', naturalAge: 8 },
    { id: 'down', division: 'U8', naturalAge: 12 },
    { id: 'old', division: 'U10', naturalAge: 15, status: 'waitlist' },
    { id: 'nodob', division: 'U10' },
  ];
  const { players: placed } = applyPlayUpEligibility({
    players,
    divisions: placementDivisions,
    seasonYear: 2026,
    cutoffMode: 'birth_year',
  });
  const seats = seatsFromPlacedPlayers(placed);
  assert.deepEqual(
    seats.map((s) => s.playerId),
    players.map((p) => p.id)
  );
  assert.deepEqual(
    seats.map((s) => [
      s.playerId,
      s.registeredDivision,
      s.seatedDivision,
      s.requested,
      s.waitlisted,
    ]),
    [
      ['in', 'U10', 'U10', false, false],
      ['up', 'U12', 'U12', true, false],
      ['moved', 'U10', 'U8', false, false],
      ['down', 'U8', 'U12', false, false],
      // no division holds 15; waitlisted too, and still one seat
      ['old', 'U10', null, false, true],
      ['nodob', 'U10', 'U10', false, false],
    ]
  );
  assert.equal(seats[0].naturalAge, 10);
  assert.equal(seats[5].naturalAge, null);

  const { league, byDivision } = summarizeSeats({ seats, divisions: placementDivisions });
  assert.equal(league.seated + league.waitlisted + league.notEligible, players.length);
  assert.equal(league.notEligible, 1);
  assert.equal(league.waitlisted, 0);
  // up: age 10 seated U12 (band 11 to 12). moved: age 8 plays U8. down: age 12 plays U12.
  assert.equal(league.playingUp, 1);
  assert.equal(league.playingDown, 0);
  assert.equal(byDivision.get('U8').movedIn, 1);
  assert.equal(byDivision.get('U12').movedIn, 1);
  assert.equal(byDivision.get('U10').movedOut, 1);
  assert.equal(byDivision.get('U8').movedOut, 1);
});

test('a player nobody has placed is seated where they registered', () => {
  const seats = seatsFromPlacedPlayers([
    { id: 7, division: 'U10', naturalAge: 10 },
    { id: 8, division: 'U10', status: 'waitlist' },
  ]);
  assert.deepEqual(
    seats.map((s) => [s.playerId, s.registeredDivision, s.seatedDivision, s.waitlisted]),
    [
      ['7', 'U10', 'U10', false],
      ['8', 'U10', 'U10', true],
    ]
  );
  assert.throws(() => seatsFromPlacedPlayers(null), TypeError);
});
