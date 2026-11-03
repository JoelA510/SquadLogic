import { test } from 'vitest';
import assert from 'node:assert/strict';
import { cannotBePlaced } from '../packages/core/src/playUp.js';
import { seatsFromPlacedPlayers, summarizeSeats } from '../packages/core/src/playUpSeats.js';
import { generateTeams } from '../packages/core/src/teamGeneration.js';
import { prepareTeamingInput } from '../packages/core/src/teamingPipeline.js';

/*
 * Advice and generation cannot disagree: shown, not stated (plan section 4.1, "Parity is the
 * guarantee"). A league with every kind of player goes through the real pipeline and the real
 * generator, division by division, as the Teams page runs it. The count made from the PLACEMENT
 * (what the advice is built on) must equal the count made from the ROSTERS generation saved, per
 * division and per program, and the players generation held back (the waitlisted, the not
 * eligible) must be the ones the placement counts as such.
 *
 * Every player is written below with the division they registered in and the age they are judged
 * by, and the expectation is worked from the rule, not read back from either side.
 *
 *   program junior: U8 (ages 7 to 8), U10 (9 to 10); program senior: U12 (11 to 12)
 */

const divisions = [
  { id: 'U8', name: 'U8', min_age: 7, max_age: 8, program_id: 'junior' },
  { id: 'U10', name: 'U10', min_age: 9, max_age: 10, program_id: 'junior' },
  { id: 'U12', name: 'U12', min_age: 11, max_age: 12, program_id: 'senior' },
];

const kid = (id, division, naturalAge, extra = {}) => ({ id, division, naturalAge, ...extra });

const registrants = [
  // U8: three in band; one aged 12 registered younger than their age (moved to U12).
  kid('s1', 'U8', 8),
  kid('s2', 'U8', 7),
  kid('s3', 'U8', 8),
  kid('s4', 'U8', 12),
  // U10: four in band; t5 aged 8 and not asking: plays U8. t6 aged 8 asking: stays, playing up.
  // t7 aged 12: plays U12. t8 aged 15: no division holds 15. t9 has no age. t10 is waitlisted.
  // t11 is aged 15 and waitlisted: both, counted once.
  kid('t1', 'U10', 10),
  kid('t2', 'U10', 9),
  kid('t3', 'U10', 10),
  kid('t4', 'U10', 9),
  kid('t5', 'U10', 8),
  kid('t6', 'U10', 8, { play_up_requested: true }),
  kid('t7', 'U10', 12),
  kid('t8', 'U10', 15),
  kid('t9', 'U10', null),
  kid('t10', 'U10', 10, { status: 'waitlist' }),
  kid('t11', 'U10', 15, { status: 'waitlist' }),
  // U12: three in band; u4 aged 10 asking: stays, playing up. u5 aged 10 and not asking: plays U10.
  // u6 aged 11 asking from their own division: nothing to honour.
  kid('u1', 'U12', 11),
  kid('u2', 'U12', 12),
  kid('u3', 'U12', 11),
  kid('u4', 'U12', 10, { play_up_requested: true }),
  kid('u5', 'U12', 10),
  kid('u6', 'U12', 11, { play_up_requested: true }),
];

/** Run the league as the page does: one placement for everyone, then one generation per division. */
function runLeague() {
  const prepared = prepareTeamingInput({
    players: registrants.map((player) => ({ ...player })),
    divisions,
    seasonYear: 2026,
    cutoffMode: 'birth_year',
  }).players;

  const teams = [];
  const held = { waitlisted: 0, 'eligibility-blocked': 0 };
  for (const division of divisions) {
    // Everyone who plays in this division, and the held-back who registered in it (they stay where
    // they registered), as the page seats a division.
    const pool = prepared.filter((player) => String(player.division) === division.id);
    const result = generateTeams({
      players: pool,
      divisionConfigs: {
        [division.id]: { id: division.id, teamsCount: 1, slotsPerWeek: 0, maxRosterSize: 4 },
      },
      seed: 'parity',
    });
    teams.push(...(result.teamsByDivision[division.id] ?? []));
    for (const entry of result.overflowByDivision[division.id] ?? []) {
      assert.ok(entry.reason in held, `unexpected overflow reason ${entry.reason}`);
      held[entry.reason] += entry.players.length;
    }
  }
  return { prepared, teams, held };
}

/** The seats the saved rosters hold: what a reload would count, with no placement in sight. */
function rosterSeats(teams) {
  return teams.flatMap((team) =>
    team.players.map((player) => ({
      playerId: String(player.id),
      naturalAge: Number.isFinite(player.naturalAge) ? player.naturalAge : null,
      registeredDivision: player.registeredDivision,
      seatedDivision: team.division,
      requested: player.playUpRequested === true,
      waitlisted: false,
    }))
  );
}

const plain = (map) => Object.fromEntries(map);

test('the league has every kind of player the parity must cover', () => {
  const { prepared } = runLeague();
  const { league } = summarizeSeats({ seats: seatsFromPlacedPlayers(prepared), divisions });
  // Worked from the registrants above: t6, u4 play up; t5, s4, t7, u5 are moved; t8 and t11 are not
  // eligible; t10 is waitlisted; t9 cannot be checked; u6 asked with nothing to honour. A league
  // that lost a kind would compare nothing about it.
  assert.equal(league.playingUp, 2);
  assert.equal(league.movedIn, 4);
  assert.equal(league.notEligible, 2);
  assert.equal(league.waitlisted, 1);
  assert.equal(league.notChecked, 1);
  assert.equal(league.askedToPlayUp, 1);
  // Generation seats nobody below their age: the registered-younger player is moved, not playing down.
  assert.equal(league.playingDown, 0);
  assert.equal(league.seated + league.waitlisted + league.notEligible, registrants.length);
});

test('the count from the placement equals the count from the saved rosters, per division and program', () => {
  const { prepared, teams } = runLeague();

  // The placement side: every registrant, then only those generation can seat.
  const placement = summarizeSeats({ seats: seatsFromPlacedPlayers(prepared), divisions });
  const seatable = prepared.filter((player) => !cannotBePlaced(player));
  const fromPlacement = summarizeSeats({ seats: seatsFromPlacedPlayers(seatable), divisions });

  // The roster side: the seats of the teams the run built, from the rosters alone.
  const fromRosters = summarizeSeats({ seats: rosterSeats(teams), divisions });

  assert.deepEqual(plain(fromRosters.byDivision), plain(fromPlacement.byDivision));
  assert.deepEqual(plain(fromRosters.byProgram), plain(fromPlacement.byProgram));
  assert.deepEqual(fromRosters.league, fromPlacement.league);

  // The advice's player count for a division is the number of players on its teams.
  for (const division of divisions) {
    const onTeams = teams
      .filter((team) => team.division === division.id)
      .reduce((sum, team) => sum + team.players.length, 0);
    assert.equal(placement.byDivision.get(division.id).seated, onTeams, `${division.id} seated`);
  }

  // Worked by hand: U8 seats s1 s2 s3 and the moved t5 (4); U10 seats t1 t2 t3 t4, t6 (playing up),
  // t9 (no age) and the moved u5 (7); U12 seats u1 u2 u3, u4 (playing up), u6, and the moved s4 and
  // t7 (7).
  assert.deepEqual(
    divisions.map((division) => placement.byDivision.get(division.id).seated),
    [4, 7, 7]
  );
  assert.equal(
    teams.reduce((sum, team) => sum + team.players.length, 0),
    18
  );
});

test('the players generation held back are the ones the placement counts as waitlisted or not eligible', () => {
  const { prepared, held } = runLeague();
  const { league } = summarizeSeats({ seats: seatsFromPlacedPlayers(prepared), divisions });
  // From the generator's own overflow: t10 waitlisted; t8 and t11 blocked (t11 is also waitlisted, and
  // the generator reports it once, as blocked, as the placement counts it).
  assert.equal(league.waitlisted, held.waitlisted);
  assert.equal(league.notEligible, held['eligibility-blocked']);
  assert.deepEqual(held, { waitlisted: 1, 'eligibility-blocked': 2 });
});

test('the parity can fail: a player moved by hand to another division is counted where they now sit', () => {
  const { prepared, teams } = runLeague();
  const seatable = prepared.filter((player) => !cannotBePlaced(player));
  const fromPlacement = summarizeSeats({ seats: seatsFromPlacedPlayers(seatable), divisions });

  // s1 is aged 8 and plays U8 (band 7 to 8). Move them to a U12 team, as the roster editor can.
  const moved = teams.map((team) => ({
    ...team,
    players: team.players.filter((player) => player.id !== 's1'),
  }));
  const s1 = teams.flatMap((team) => team.players).find((player) => player.id === 's1');
  const u12 = moved.find((team) => team.division === 'U12');
  u12.players = [...u12.players, s1];

  const fromRosters = summarizeSeats({ seats: rosterSeats(moved), divisions });
  assert.notDeepEqual(plain(fromRosters.byDivision), plain(fromPlacement.byDivision));
  // Where they sit now: one more play-up in U12 (age 8 under 11), moved out of U8 and into U12, and
  // across programs, so junior loses a seat and senior gains one.
  assert.equal(
    fromRosters.byDivision.get('U12').playingUp,
    fromPlacement.byDivision.get('U12').playingUp + 1
  );
  assert.equal(
    fromRosters.byDivision.get('U8').seated,
    fromPlacement.byDivision.get('U8').seated - 1
  );
  assert.equal(
    fromRosters.byProgram.get('senior').movedIn,
    fromPlacement.byProgram.get('senior').movedIn + 1
  );
  assert.equal(
    fromRosters.byProgram.get('junior').movedOut,
    fromPlacement.byProgram.get('junior').movedOut + 1
  );
});
