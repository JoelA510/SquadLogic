import { test } from 'vitest';
import assert from 'node:assert/strict';
import { applyPlayUpEligibility, PLACEMENT } from '../packages/core/src/playUp.js';

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

const AGE_9 = '2017-04-01';
const AGE_10 = '2016-04-01';
const AGE_11 = '2015-04-01';

test('an in-band player is unchanged and not listed', () => {
  const { players, diagnostics } = run([{ id: 'p1', division: 'U10B', dob: AGE_10 }]);
  assert.equal(players[0].placement, PLACEMENT.IN_BAND);
  assert.equal(players[0].division, 'U10B');
  assert.equal(players[0].needsReview, false);
  assert.equal(diagnostics.counts.inBand, 1);
  assert.deepEqual(diagnostics.listing, []);
});

test('an unrequested play-up plays in the player’s own age division and is listed', () => {
  const { players, diagnostics } = run([{ id: 'p1', name: 'Pia', division: 'U10B', dob: AGE_9 }]);
  assert.equal(players[0].placement, PLACEMENT.PLAY_UP);
  assert.equal(players[0].division, 'U9B'); // own age division
  assert.equal(players[0].registeredDivision, 'U10B');
  assert.equal(players[0].playUpRequested, false);
  assert.equal(diagnostics.counts.playUpUnrequested, 1);
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
  assert.equal(diagnostics.counts.playUpRequested, 1);
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
  assert.equal(diagnostics.counts.playDown, 1);
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
  assert.equal(diagnostics.counts.noDivision, 1);
  assert.equal(diagnostics.listing[0].kind, 'no-division');
  assert.equal(diagnostics.listing[0].playedDivision, null);
  assert.match(players[0].reviewReason, /no division holds natural age 16/);
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
  assert.equal(diagnostics.counts.unknown, 2);
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
