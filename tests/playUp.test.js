import { test } from 'vitest';
import assert from 'node:assert/strict';
import { applyPlayUpEligibility, PLACEMENT, PLAY_DOWN_FLAG } from '../packages/core/src/playUp.js';
import { prepareTeamingInput } from '../packages/core/src/teamingPipeline.js';
import { seatsFromPlacedPlayers, summarizeSeats } from '../packages/core/src/playUpSeats.js';

const MODE = 'birth_year'; // exact ages: age = 2026 - birthYear
const SEASON = 2026;

const divisions = [
  { id: 'U9B', name: 'U9 Boys', minAge: 9, maxAge: 9, gender_policy: 'boys' },
  { id: 'U9G', name: 'U9 Girls', minAge: 9, maxAge: 9, gender_policy: 'girls' },
  { id: 'U10B', name: 'U10 Boys', minAge: 10, maxAge: 10, gender_policy: 'boys' },
  { id: 'U12B', name: 'U11 - U12 Boys', minAge: 11, maxAge: 12, gender_policy: 'boys' },
];

function run(players, opts = {}) {
  return applyPlayUpEligibility({
    players,
    divisions,
    seasonYear: SEASON,
    cutoffMode: MODE,
    ...opts,
  });
}

/**
 * The league counted by the division each player plays in (`summarizeSeats`): what the placement
 * used to count by registered kind in `diagnostics.counts`, which nothing read and which is gone.
 */
function counted(players, opts = {}) {
  return summarizeSeats({
    seats: seatsFromPlacedPlayers(players),
    divisions: opts.divisions ?? divisions,
  });
}

const AGE_9 = '2017-04-01';
const AGE_10 = '2016-04-01';
const AGE_11 = '2015-04-01';

test('an in-band player is unchanged and not listed', () => {
  const { players, diagnostics } = run([{ id: 'p1', division: 'U10B', dob: AGE_10 }]);
  assert.equal(players[0].placement, PLACEMENT.IN_BAND);
  assert.equal(players[0].division, 'U10B');
  assert.equal(players[0].needsReview, false);
  const { league } = counted(players);
  assert.equal(league.seated, 1);
  assert.equal(league.playingUp + league.playingDown + league.movedIn + league.notChecked, 0);
  assert.deepEqual(diagnostics.listing, []);
});

test('an unrequested play-up plays in the player’s own age division and is listed', () => {
  const { players, diagnostics } = run([{ id: 'p1', name: 'Pia', division: 'U10B', dob: AGE_9 }]);
  assert.equal(players[0].placement, PLACEMENT.PLAY_UP);
  assert.equal(players[0].division, 'U9B'); // own age division
  assert.equal(players[0].registeredDivision, 'U10B');
  assert.equal(players[0].playUpRequested, false);
  // Played in their own age division, in band: moved from U10B to U9B, and not "playing up".
  const { byDivision, league } = counted(players);
  assert.equal(league.playingUp, 0);
  assert.equal(byDivision.get('U9B').movedIn, 1);
  assert.equal(byDivision.get('U10B').movedOut, 1);
  assert.deepEqual(diagnostics.listing, [
    {
      playerId: 'p1',
      name: 'Pia',
      kind: 'play-up',
      requested: false,
      naturalAge: 9,
      registeredDivision: 'U10B',
      registeredDivisionName: 'U10 Boys',
      playedDivision: 'U9B',
      playedDivisionName: 'U9 Boys',
      coachId: null,
      buddyId: null,
      buddyName: null,
      buddyDivision: null,
      buddyDivisionName: null,
      buddyInPlayedDivision: null,
    },
  ]);
});

test('a requested play-up plays in the older division and is listed with its facts', () => {
  const { players, diagnostics } = run([
    // age 9 registered in U10B, requested, whose parent coaches and whose buddy is in U10B
    {
      id: 'up',
      name: 'Pia',
      division: 'U10B',
      dob: AGE_9,
      play_up_requested: 'yes',
      coachId: 'coachA',
      buddyId: 'pal',
    },
    { id: 'pal', name: 'Pal', division: 'U10B', dob: AGE_10, buddyId: 'up' },
  ]);
  const up = players.find((p) => p.id === 'up');
  assert.equal(up.placement, PLACEMENT.PLAY_UP);
  assert.equal(up.division, 'U10B'); // stays up
  assert.equal(up.playUpRequested, true);
  // Age 9 plays in U10B (band 10): one play-up by seat, requested; the buddy is in band.
  assert.equal(counted(players).byDivision.get('U10B').playingUp, 1);
  assert.equal(counted(players).league.movedIn, 0);
  assert.equal(diagnostics.listing.length, 1);
  assert.deepEqual(
    {
      kind: diagnostics.listing[0].kind,
      requested: diagnostics.listing[0].requested,
      playedDivision: diagnostics.listing[0].playedDivision,
      coachId: diagnostics.listing[0].coachId,
      buddyId: diagnostics.listing[0].buddyId,
      buddyInPlayedDivision: diagnostics.listing[0].buddyInPlayedDivision,
    },
    {
      kind: 'play-up',
      requested: true,
      playedDivision: 'U10B',
      coachId: 'coachA',
      buddyId: 'pal',
      buddyInPlayedDivision: true,
    }
  );
});

test('a requested play-up with no coaching parent and a buddy elsewhere says so', () => {
  const { diagnostics } = run([
    { id: 'up', division: 'U10B', dob: AGE_9, play_up_requested: true, buddyId: 'pal' },
    // the buddy is an age-9 unrequested play-up too, so plays in U9B
    { id: 'pal', division: 'U10B', dob: AGE_9, buddyId: 'up' },
  ]);
  const entry = diagnostics.listing.find((e) => e.playerId === 'up');
  assert.equal(entry.coachId, null);
  assert.equal(entry.buddyId, 'pal');
  assert.equal(entry.buddyDivision, 'U9B');
  assert.equal(entry.buddyDivisionName, 'U9 Boys');
  assert.equal(entry.buddyInPlayedDivision, false);
});

test('a play-down plays in the player’s own age division and is listed', () => {
  const { players, diagnostics } = run([{ id: 'p1', division: 'U10B', dob: AGE_11 }]);
  assert.equal(players[0].placement, PLACEMENT.PLAY_DOWN);
  assert.equal(players[0].division, 'U12B');
  assert.equal(players[0].registeredDivision, 'U10B');
  // Plays in U12B (band 11 to 12), in band: moved, and not "playing down".
  const { byDivision, league } = counted(players);
  assert.equal(league.playingDown, 0);
  assert.equal(byDivision.get('U12B').movedIn, 1);
  assert.equal(byDivision.get('U10B').movedOut, 1);
  assert.equal(diagnostics.listing[0].kind, 'play-down');
  assert.equal(diagnostics.listing[0].playedDivision, 'U12B');
});

test('a play-down is not honoured even when the flag is set', () => {
  const { players } = run([{ id: 'p1', division: 'U10B', dob: AGE_11, play_up_requested: true }]);
  assert.equal(players[0].placement, PLACEMENT.PLAY_DOWN);
  assert.equal(players[0].division, 'U12B');
});

test('the own division honours the registered division’s gender', () => {
  const { players } = run([{ id: 'g', division: 'U10G', dob: AGE_9 }], {
    divisions: [...divisions, { id: 'U10G', name: 'U10 Girls', minAge: 10, maxAge: 10 }],
  });
  assert.equal(players[0].division, 'U9G');
});

test('a player no division can hold is blocked, listed, and stays where they registered', () => {
  // age 16: no division covers it
  const { players, diagnostics } = run([{ id: 'old', division: 'U10B', dob: '2010-04-01' }]);
  assert.equal(players[0].placement, PLACEMENT.NO_DIVISION);
  assert.equal(players[0].division, 'U10B');
  // Held out, in the division they registered in: one not eligible, seated nowhere.
  const { byDivision, league } = counted(players);
  assert.equal(byDivision.get('U10B').notEligible, 1);
  assert.equal(league.seated, 0);
  assert.equal(diagnostics.listing[0].kind, 'no-division');
  assert.equal(diagnostics.listing[0].playedDivision, null);
  assert.match(players[0].reviewReason, /no suitable division holds natural age 16/);
});

test('a request registered in the player’s own division is listed for the admin to move', () => {
  const { players, diagnostics } = run([
    { id: 'p1', division: 'U10B', dob: AGE_10, play_up_requested: 'x' },
  ]);
  assert.equal(players[0].placement, PLACEMENT.IN_BAND);
  assert.equal(players[0].division, 'U10B');
  assert.equal(diagnostics.listing[0].kind, 'requested-own-division');
});

test('every accepted spelling of a request reads as yes, anything else as no', () => {
  for (const value of ['yes', 'YES', 'true', 'True', '1', 'x', 'X', ' y ', true]) {
    const { players } = run([{ id: 'p', division: 'U10B', dob: AGE_9, play_up_requested: value }]);
    assert.equal(players[0].playUpRequested, true, `${value} is a request`);
    assert.equal(players[0].division, 'U10B');
  }
  for (const value of ['no', 'false', '0', '', null, undefined, 'maybe', false]) {
    const { players } = run([{ id: 'p', division: 'U10B', dob: AGE_9, play_up_requested: value }]);
    assert.equal(players[0].playUpRequested, false, `${String(value)} is no request`);
    assert.equal(players[0].division, 'U9B');
  }
});

test('a player with no natural age is placed where they registered and flagged only if requested', () => {
  const { players, diagnostics } = run([
    { id: 'a', division: 'U10B' },
    { id: 'b', division: 'U10B', play_up_requested: true },
  ]);
  assert.equal(players[0].placement, PLACEMENT.UNKNOWN);
  assert.equal(players[1].placement, PLACEMENT.UNKNOWN);
  // Nothing can be checked for either, and the one who asked has nothing to honour.
  const { league } = counted(players);
  assert.equal(league.notChecked, 2);
  assert.equal(league.askedToPlayUp, 1);
  assert.equal(league.seated, 2);
  assert.deepEqual(
    diagnostics.listing.map((e) => [e.playerId, e.kind]),
    [['b', 'requested-age-unknown']]
  );
});

test('the listing is enumerated from the players, one entry per listed player', () => {
  const { players, diagnostics } = run([
    { id: 'in', division: 'U10B', dob: AGE_10 },
    { id: 'up', division: 'U10B', dob: AGE_9 },
    { id: 'down', division: 'U10B', dob: AGE_11 },
    { id: 'old', division: 'U10B', dob: '2010-04-01' },
  ]);
  assert.deepEqual(
    diagnostics.listing.map((e) => e.playerId).sort(),
    players
      .filter((p) => p.needsReview)
      .map((p) => p.id)
      .sort()
  );
  assert.deepEqual(diagnostics.listing.map((e) => e.playerId).sort(), ['down', 'old', 'up']);
});

test('a player never moves to a division of the other gender: no suitable division, listed', () => {
  // A 10-year-old girl registered in U12 Girls, with a U10 Boys division but no U10 Girls one.
  const { players, diagnostics } = run([{ id: 'girl', division: 'U12G', dob: AGE_10 }], {
    divisions: [
      { id: 'U12G', name: 'U12 Girls', minAge: 12, maxAge: 12, gender_policy: 'girls' },
      { id: 'U10B', name: 'U10 Boys', minAge: 10, maxAge: 10, gender_policy: 'boys' },
    ],
  });
  assert.equal(players[0].placement, PLACEMENT.NO_DIVISION);
  assert.equal(players[0].division, 'U12G');
  assert.equal(diagnostics.listing[0].kind, 'no-division');
  assert.match(players[0].reviewReason, /no suitable division holds natural age 10/);
});

test('the same gender is found when it exists, and a co-ed division is accepted', () => {
  const girls = { id: 'U12G', name: 'U12 Girls', minAge: 12, maxAge: 12, gender_policy: 'girls' };
  const boysTen = { id: 'U10B', name: 'U10 Boys', minAge: 10, maxAge: 10, gender_policy: 'boys' };
  const girlsTen = {
    id: 'U10G',
    name: 'U10 Girls',
    minAge: 10,
    maxAge: 10,
    gender_policy: 'girls',
  };
  const coedTen = { id: 'U10C', name: 'U10 Coed', minAge: 10, maxAge: 10, gender_policy: 'coed' };
  const place = (extra) =>
    run([{ id: 'girl', division: 'U12G', dob: AGE_10 }], { divisions: [girls, boysTen, ...extra] })
      .players[0];
  assert.equal(place([girlsTen]).division, 'U10G');
  assert.equal(place([coedTen]).division, 'U10C');
  // The same gender is preferred to a co-ed division, wherever each is listed.
  assert.equal(place([coedTen, girlsTen]).division, 'U10G');
  // A co-ed registered division moves to a co-ed one only.
  const coedTwelve = {
    id: 'U12C',
    name: 'U12 Coed',
    minAge: 12,
    maxAge: 12,
    gender_policy: 'coed',
  };
  const moved = run([{ id: 'kid', division: 'U12C', dob: AGE_10 }], {
    divisions: [coedTwelve, boysTen],
  }).players[0];
  assert.equal(moved.placement, PLACEMENT.NO_DIVISION);
});

// ---------------------------------------------------------------------------------------------
// The play-down setting (play-down plan, 2026-11-03, PR 3, task C1). Off unless an admin turns it
// on: a player registered in a younger division then plays in the division they registered for,
// listed as a play-down and counted as playing down. Play-up is untouched: it stays by request.
// ---------------------------------------------------------------------------------------------

/**
 * Every kind of player, with where each plays with the setting off (today's behaviour: the
 * expectations here are the ones the tests above already pin, written out by hand) and on.
 * [id, registered division, date of birth, extra fields, plays off, plays on, placement]
 *
 * @type {Array<[string, string, string | undefined, Record<string, any>, string, string, string]>}
 */
const SETTING_CASES = [
  ['in', 'U10B', AGE_10, {}, 'U10B', 'U10B', PLACEMENT.IN_BAND],
  ['upAsked', 'U10B', AGE_9, { play_up_requested: 'yes' }, 'U10B', 'U10B', PLACEMENT.PLAY_UP],
  ['upNotAsked', 'U10B', AGE_9, {}, 'U9B', 'U9B', PLACEMENT.PLAY_UP],
  ['down', 'U10B', AGE_11, {}, 'U12B', 'U10B', PLACEMENT.PLAY_DOWN],
  // A play-down has no request to honour: asking changes nothing in either state.
  ['downAsked', 'U10B', AGE_11, { play_up_requested: 'yes' }, 'U12B', 'U10B', PLACEMENT.PLAY_DOWN],
  // Ages 13 and 16 are held by no division. Off, they are the one hold-out: blocked, listed, not
  // placed. On, a play-down plays where it registered whatever the gap, and is flagged.
  ['downNoOwn', 'U10B', '2013-04-01', {}, 'U10B', 'U10B', PLACEMENT.PLAY_DOWN],
  ['tooOld', 'U10B', '2010-04-01', {}, 'U10B', 'U10B', PLACEMENT.PLAY_DOWN],
  // Age 7 registered in U10B is a play-up nobody asked for, and no division holds 7: blocked in both.
  ['tooYoung', 'U10B', '2019-04-01', {}, 'U10B', 'U10B', PLACEMENT.NO_DIVISION],
  ['noAge', 'U10B', undefined, {}, 'U10B', 'U10B', PLACEMENT.UNKNOWN],
];
const settingPlayers = () =>
  SETTING_CASES.map(([id, division, dob, extra]) => ({ id, division, dob, ...extra }));
const where = (players) => Object.fromEntries(players.map((p) => [p.id, p.division]));

test('the setting off, absent or false, plays everyone as today, case by case', () => {
  const expectedOff = Object.fromEntries(SETTING_CASES.map(([id, , , , off]) => [id, off]));
  for (const options of [{}, { allowPlayDown: false }, { allowPlayDown: undefined }]) {
    const { players } = run(settingPlayers(), options);
    assert.deepEqual(where(players), expectedOff, JSON.stringify(options));
  }
  const { players } = run(settingPlayers());
  const placements = Object.fromEntries(players.map((p) => [p.id, p.placement]));
  assert.equal(placements.down, PLACEMENT.PLAY_DOWN);
  // Off, a play-down no division holds is the one hold-out: blocked, listed, not placed.
  assert.equal(placements.downNoOwn, PLACEMENT.NO_DIVISION);
  assert.equal(placements.tooOld, PLACEMENT.NO_DIVISION);
});

test('the setting on plays a play-down in the division registered for, and only a play-down', () => {
  const { players } = run(settingPlayers(), { allowPlayDown: true });
  const expectedOn = Object.fromEntries(SETTING_CASES.map(([id, , , , , on]) => [id, on]));
  assert.deepEqual(where(players), expectedOn);
  const byId = Object.fromEntries(players.map((p) => [p.id, p]));
  for (const id of ['down', 'downAsked', 'downNoOwn', 'tooOld']) {
    assert.equal(byId[id].division, 'U10B', id);
    assert.equal(byId[id].registeredDivision, 'U10B', id);
  }
  assert.equal(byId.down.placement, PLACEMENT.PLAY_DOWN);
  // A play-down no division holds is no longer blocked: it is seated, and flagged.
  assert.equal(byId.downNoOwn.placement, PLACEMENT.PLAY_DOWN);
  assert.equal(byId.downNoOwn.needsReview, true);
  // The others are exactly as with the setting off.
  const off = Object.fromEntries(run(settingPlayers()).players.map((p) => [p.id, p]));
  for (const id of ['in', 'upAsked', 'upNotAsked', 'tooYoung', 'noAge']) {
    assert.deepEqual(byId[id], off[id], id);
  }
});

test('the setting on lists a play-down as played in the division registered, and counts it', () => {
  const { players, diagnostics } = run(settingPlayers(), { allowPlayDown: true });
  const entry = diagnostics.listing.find((e) => e.playerId === 'down');
  assert.equal(entry.kind, 'play-down');
  assert.equal(entry.registeredDivision, 'U10B');
  assert.equal(entry.playedDivision, 'U10B');
  assert.equal(entry.playedDivisionName, 'U10 Boys');
  assert.ok(!('heldSeat' in entry));
  assert.equal(
    players.find((p) => p.id === 'down').reviewReason,
    'registered in a younger division; plays there, as the play-down setting is on'
  );
  // Counted by the division played: four players play down in U10B (ages 11, 11, 13 and 16 against
  // a band of 10), none is moved, and only the player no division can hold stays not eligible.
  const { byDivision, league } = counted(players);
  assert.equal(byDivision.get('U10B').playingDown, 4);
  assert.equal(league.playingDown, 4);
  assert.equal(byDivision.get('U12B').movedIn, 0);
  assert.equal(byDivision.get('U10B').notEligible, 1);
  // Off, the same league has no one playing down, the two players a division holds are moved to
  // U12B, and the three no division holds are not eligible.
  const off = counted(run(settingPlayers()).players);
  assert.equal(off.league.playingDown, 0);
  assert.equal(off.byDivision.get('U12B').movedIn, 2);
  assert.equal(off.byDivision.get('U10B').notEligible, 3);
});

test('the setting on honours the registered division’s gender: a girl stays in her girls division', () => {
  const girls = [
    ...divisions,
    { id: 'U10G', name: 'U10 Girls', minAge: 10, maxAge: 10, gender_policy: 'girls' },
  ];
  // Age 11, registered in U10 Girls; the only division holding 11 is boys: off, no suitable division.
  const off = run([{ id: 'g', division: 'U10G', dob: AGE_11 }], { divisions: girls });
  assert.equal(off.players[0].placement, PLACEMENT.NO_DIVISION);
  const on = run([{ id: 'g', division: 'U10G', dob: AGE_11 }], {
    divisions: girls,
    allowPlayDown: true,
  });
  assert.equal(on.players[0].placement, PLACEMENT.PLAY_DOWN);
  assert.equal(on.players[0].division, 'U10G');
});

test('the setting reaches the placement through the pipeline, and keeps a buddy pair together', () => {
  const pair = [
    { id: 'a', division: 'U10B', dob: AGE_11, buddyId: 'b' },
    { id: 'b', division: 'U10B', dob: AGE_10, buddyId: 'a' },
  ];
  const input = (extra) => ({
    players: pair,
    divisions,
    seasonYear: SEASON,
    cutoffMode: MODE,
    ...extra,
  });
  const off = prepareTeamingInput(input({}));
  assert.equal(off.players.find((p) => p.id === 'a').division, 'U12B');
  // Played apart, so the pair is told apart (as today).
  assert.ok(off.diagnostics.buddyLinking.some((d) => d.code === 'buddy-played-apart'));
  const on = prepareTeamingInput(input({ allowPlayDown: true }));
  assert.equal(on.players.find((p) => p.id === 'a').division, 'U10B');
  assert.ok(!on.diagnostics.buddyLinking.some((d) => d.code === 'buddy-played-apart'));
  assert.equal(
    on.diagnostics.playUp.listing.find((e) => e.playerId === 'a').playedDivision,
    'U10B'
  );
});

test('the setting’s key is play_down', () => {
  assert.equal(PLAY_DOWN_FLAG, 'play_down');
});
