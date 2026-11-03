// @vitest-environment node
/**
 * Flipping a setting, or clearing a request, must not move a player off a roster that already
 * exists (play-down plan, 2026-11-03, PR 3, task C3, owner decision 3).
 *
 * Team generation never reshuffles a reviewed, published or locked roster
 * (docs/architecture/incremental-teaming-hardening.md). The placement could: a re-run asks it where
 * each player plays now, and a player the rule now places in another division is absent from this
 * division's players, which the reconciliation reads as a player who left (`droppedPlayersRemoved`).
 * So a cleared play-up request, or the play-down setting turned on or off, removed a rostered player
 * from the roster they were on. (Written first against the code before this change: the cleared
 * request below removed Pia from her U12 team, `droppedPlayersRemoved` 1.)
 *
 * Everything goes through the real pipeline (`prepareTeamingInput`) and the real generator, and the
 * rosters are the ones a first run made, saved in the shape the page persists and read back by the
 * helper the Teams page uses (`heldSeatsFromSnapshot`). No test sets `heldSeat` or `placement` by hand.
 */
import { describe, expect, it } from 'vitest';

import { generateTeams } from '../packages/core/src/teamGeneration.js';
import { seatsFromPlacedPlayers, summarizeSeats } from '../packages/core/src/playUpSeats.js';
import { prepareTeamingInput } from '../packages/core/src/teamingPipeline.js';
import {
  buildExistingSnapshotForRerun,
  heldSeatsFromSnapshot,
} from '../frontend/src/utils/teamReviewPersistence.js';

const SEASON = 2026;
const AGE_10 = '2016-05-01';
const AGE_12 = '2014-05-01';
const DIVISIONS = [
  { id: 'U10', name: 'U10', min_age: 10, max_age: 10 },
  { id: 'U12', name: 'U12', min_age: 12, max_age: 12 },
  { id: 'U14', name: 'U14', min_age: 14, max_age: 14 },
];

const config = (id) => ({ id, teamsCount: 1, slotsPerWeek: 0, maxRosterSize: 6 });
const kid = (id, division, dob, extra = {}) => ({ id, division, dob, ...extra });
const kids = (division, dob, prefix, count) =>
  Array.from({ length: count }, (_, i) => kid(`${prefix}${i + 1}`, division, dob));

/** The pipeline as the page runs it, with the rosters already saved (`saved`, or none). */
function prepare(players, saved, options = {}) {
  return prepareTeamingInput({
    players,
    divisions: DIVISIONS,
    seasonYear: SEASON,
    cutoffMode: 'birth_year',
    heldSeats: saved ? heldSeatsFromSnapshot(saved) : undefined,
    ...options,
  });
}

/** One division's run: the pipeline places everyone, the division is given the players who play in it. */
function run(division, players, saved, options = {}) {
  const prepared = prepare(players, saved, options.pipeline);
  const result = generateTeams({
    players: prepared.players.filter((player) => String(player.division) === division),
    divisionConfigs: { [division]: config(division) },
    seed: 'c3',
    ...(saved
      ? {
          existingSnapshot: buildExistingSnapshotForRerun(saved, { divisionKey: division }),
          generationMode: 'review',
        }
      : {}),
  });
  return { prepared, result };
}

/** What the page persists for a run of one division, merged over what was saved before. */
function save(division, result, before = null) {
  const teams = result.teamsByDivision[division];
  const teamRows = teams.map((team) => ({
    id: team.id,
    division,
    name: team.name,
    players: team.players.map((player) => ({ id: player.id })),
  }));
  const teamPlayerRows = teams.flatMap((team) =>
    team.players.map((player) => ({
      team_id: team.id,
      player_id: player.id,
      role: 'player',
      source: 'auto',
    }))
  );
  return {
    lastRunId: `run-${division}`,
    runHistory: [{ status: 'review' }],
    payload: { teamRows, teamPlayerRows },
    payloadByDivision: {
      ...(before?.payloadByDivision ?? {}),
      [division]: { teamRows, teamPlayerRows },
    },
  };
}

const seatedIds = (result, division) =>
  (result.teamsByDivision[division] ?? []).flatMap((team) => team.players.map((p) => String(p.id)));
const teamOf = (result, division, id) =>
  (result.teamsByDivision[division] ?? []).find((team) =>
    team.players.some((p) => String(p.id) === id)
  );
const dropped = (result, division) =>
  result.changeDiagnosticsByDivision[division].droppedPlayersRemoved;
const listed = (prepared, id) => prepared.diagnostics.playUp.listing.find((e) => e.playerId === id);

describe('a cleared play-up request does not move a player off the roster they are on', () => {
  // Pia is 10 and registered in U12 with a request, so a first run seats her on a U12 team. The
  // request is then cleared: the rule would play her in U10, her own age division.
  const league = (requested) => [
    kid('pia', 'U12', AGE_10, requested ? { play_up_requested: 'yes' } : {}),
    ...kids('U12', AGE_12, 'u12-', 4),
    ...kids('U10', AGE_10, 'u10-', 4),
  ];

  it('with the request cleared she stays on her reviewed team, nobody is dropped, and she is flagged', () => {
    const first = run('U12', league(true));
    const reviewed = first.result.teamsByDivision.U12;
    expect(seatedIds(first.result, 'U12')).toContain('pia');
    const saved = save('U12', first.result);

    const again = run('U12', league(false), saved);
    expect(teamOf(again.result, 'U12', 'pia')?.id).toBe(teamOf(first.result, 'U12', 'pia').id);
    expect(again.result.teamsByDivision.U12.map((t) => t.id)).toEqual(reviewed.map((t) => t.id));
    expect(dropped(again.result, 'U12')).toBe(0);
    expect(seatedIds(again.result, 'U12').sort()).toEqual(seatedIds(first.result, 'U12').sort());
    // Flagged: still listed as a play-up, on the roster she is on, with what the rule would do now.
    expect(listed(again.prepared, 'pia')).toMatchObject({
      kind: 'play-up',
      requested: false,
      registeredDivision: 'U12',
      playedDivision: 'U12',
      playedDivisionName: 'U12',
      heldSeat: true,
      ruleDivision: 'U10',
      ruleDivisionName: 'U10',
    });
    // Counted where she plays: playing up in U12, not moved to U10.
    const { byDivision } = summarizeSeats({
      seats: seatsFromPlacedPlayers(again.prepared.players),
      divisions: DIVISIONS,
    });
    expect(byDivision.get('U12').playingUp).toBe(1);
    expect(byDivision.get('U12').movedOut).toBe(0);
    expect(byDivision.get('U10').movedIn).toBe(0);
  });

  it('the division the rule would use does not seat her a second time', () => {
    const first = run('U12', league(true));
    const saved = save('U12', first.result);
    const u10 = run('U10', league(false), saved);
    expect(seatedIds(u10.result, 'U10')).not.toContain('pia');
    expect(seatedIds(u10.result, 'U10').sort()).toEqual(['u10-1', 'u10-2', 'u10-3', 'u10-4']);
  });

  it('is the held seat that does it: without it, the same re-run removes her (what main did)', () => {
    const first = run('U12', league(true));
    const saved = save('U12', first.result);
    const without = run('U12', league(false), saved, { pipeline: { heldSeats: new Map() } });
    expect(seatedIds(without.result, 'U12')).not.toContain('pia');
    expect(dropped(without.result, 'U12')).toBe(1);
    expect(listed(without.prepared, 'pia')).not.toHaveProperty('heldSeat');
    expect(listed(without.prepared, 'pia').playedDivision).toBe('U10');
  });

  it('a request still on file changes nothing, and lists no held seat', () => {
    const first = run('U12', league(true));
    const saved = save('U12', first.result);
    const again = run('U12', league(true), saved);
    expect(dropped(again.result, 'U12')).toBe(0);
    expect(listed(again.prepared, 'pia')).not.toHaveProperty('heldSeat');
  });
});

describe('the play-down setting turned off, or on, after rosters exist', () => {
  // Jake is 12 and registered in U10: a play-down. With the setting on he plays in U10; off, in U12.
  const league = () => [
    kid('jake', 'U10', AGE_12),
    ...kids('U10', AGE_10, 'u10-', 4),
    ...kids('U12', AGE_12, 'u12-', 4),
  ];

  it('turned off: a play-down already on a U10 roster stays there, nobody is dropped, he is flagged', () => {
    const first = run('U10', league(), null, { pipeline: { allowPlayDown: true } });
    // The setting on seats him where he registered, listed and counted as playing down.
    expect(seatedIds(first.result, 'U10')).toContain('jake');
    expect(listed(first.prepared, 'jake')).toMatchObject({
      kind: 'play-down',
      playedDivision: 'U10',
    });
    expect(listed(first.prepared, 'jake')).not.toHaveProperty('heldSeat');
    const saved = save('U10', first.result);

    const off = run('U10', league(), saved, { pipeline: { allowPlayDown: false } });
    expect(teamOf(off.result, 'U10', 'jake')?.id).toBe(teamOf(first.result, 'U10', 'jake').id);
    expect(dropped(off.result, 'U10')).toBe(0);
    expect(listed(off.prepared, 'jake')).toMatchObject({
      kind: 'play-down',
      registeredDivision: 'U10',
      playedDivision: 'U10',
      heldSeat: true,
      ruleDivision: 'U12',
    });
    expect(off.prepared.players.find((p) => p.id === 'jake').reviewReason).toBe(
      'already on a roster in U10, which a new run does not reshuffle; the rule would now place them in U12'
    );
    // Still counted as the seat he holds: playing down in U10, not moved to U12.
    const { byDivision } = summarizeSeats({
      seats: seatsFromPlacedPlayers(off.prepared.players),
      divisions: DIVISIONS,
    });
    expect(byDivision.get('U10').playingDown).toBe(1);
    expect(byDivision.get('U12').movedIn).toBe(0);
    // And U12's run does not seat him as well.
    const u12 = run('U12', league(), saved, { pipeline: { allowPlayDown: false } });
    expect(seatedIds(u12.result, 'U12')).not.toContain('jake');
  });

  it('turned on: a player already on a U12 roster stays there, nobody is dropped, he is flagged', () => {
    const first = run('U12', league(), null, { pipeline: { allowPlayDown: false } });
    // The setting off seats him in his own age division, listed as moved.
    expect(seatedIds(first.result, 'U12')).toContain('jake');
    const saved = save('U12', first.result);

    const on = run('U12', league(), saved, { pipeline: { allowPlayDown: true } });
    expect(teamOf(on.result, 'U12', 'jake')?.id).toBe(teamOf(first.result, 'U12', 'jake').id);
    expect(dropped(on.result, 'U12')).toBe(0);
    expect(listed(on.prepared, 'jake')).toMatchObject({
      kind: 'play-down',
      registeredDivision: 'U10',
      playedDivision: 'U12',
      heldSeat: true,
      ruleDivision: 'U10',
    });
    // U10's run, with the setting now on, does not take him back from the roster he is on.
    const u10 = run('U10', league(), saved, { pipeline: { allowPlayDown: true } });
    expect(seatedIds(u10.result, 'U10')).not.toContain('jake');
  });

  it('a new player, on no roster, is placed by the setting as it stands', () => {
    const first = run('U10', league(), null, { pipeline: { allowPlayDown: true } });
    const saved = save('U10', first.result);
    const late = [...league(), kid('late', 'U10', AGE_12)];
    const off = run('U10', late, saved, { pipeline: { allowPlayDown: false } });
    // Held: jake. Not held: the late arrival, who plays in U12 as the rule says.
    expect(seatedIds(off.result, 'U10')).toContain('jake');
    expect(seatedIds(off.result, 'U10')).not.toContain('late');
    expect(listed(off.prepared, 'late')).toMatchObject({ playedDivision: 'U12' });
    expect(listed(off.prepared, 'late')).not.toHaveProperty('heldSeat');
  });
});

describe('what is not held', () => {
  const league = () => [
    kid('jake', 'U10', AGE_12),
    ...kids('U10', AGE_10, 'u10-', 4),
    ...kids('U12', AGE_12, 'u12-', 4),
  ];
  const rosterOf = (division, ids) => ({
    lastRunId: 'run-x',
    runHistory: [{ status: 'review' }],
    payload: {
      teamRows: [{ id: `${division}-T01`, division, players: ids.map((id) => ({ id })) }],
      teamPlayerRows: ids.map((id) => ({
        team_id: `${division}-T01`,
        player_id: id,
        role: 'player',
        source: 'auto',
      })),
    },
    payloadByDivision: {},
  });

  it('a roster the rule could not have given the player (moved by hand) is left to the re-run', () => {
    // Jake, a 12-year-old registered in U10, was moved by hand to a U14 roster: neither the division
    // he registered in nor his own age division, so no setting put him there.
    const saved = rosterOf('U14', ['jake']);
    const { prepared } = run('U10', league(), saved);
    const jake = prepared.players.find((p) => p.id === 'jake');
    expect(jake.division).toBe('U12');
    expect(listed(prepared, 'jake')).not.toHaveProperty('heldSeat');
  });

  it('an in-band player on another roster (a registration that changed) is not held', () => {
    // Ari is 10 and registered in U10, in band; a saved U12 roster is not a rule outcome for her.
    const players = [...league(), kid('ari', 'U10', AGE_10)];
    const { prepared } = run('U10', players, rosterOf('U12', ['ari']));
    expect(prepared.players.find((p) => p.id === 'ari').division).toBe('U10');
    expect(listed(prepared, 'ari')).toBeUndefined();
  });

  it('a saved roster in a division this season does not have holds nobody', () => {
    const { prepared } = run('U10', league(), rosterOf('U99', ['jake']));
    expect(prepared.players.find((p) => p.id === 'jake').division).toBe('U12');
  });

  it('nothing saved holds nobody, and the held seats are a Map or nothing', () => {
    expect(heldSeatsFromSnapshot(null).size).toBe(0);
    expect(heldSeatsFromSnapshot({ payload: { teamRows: [] }, payloadByDivision: {} }).size).toBe(
      0
    );
    for (const heldSeats of [undefined, null, new Map()]) {
      const { players } = prepare(league(), null, { heldSeats });
      expect(players.find((p) => p.id === 'jake').division).toBe('U12');
    }
    expect(() => prepare(league(), null, { heldSeats: { jake: 'U10' } })).toThrow(TypeError);
  });

  it('reads every division’s roster, in the order of their keys, the first one winning', () => {
    const saved = {
      payload: { teamRows: [] },
      payloadByDivision: {
        U12: { teamRows: [{ id: 'a', division: 'U12', players: [{ id: 'x' }, { id: 'y' }] }] },
        U10: { teamRows: [{ id: 'b', division: 'U10', players: [{ id: 'x' }] }] },
      },
    };
    expect([...heldSeatsFromSnapshot(saved)]).toEqual([
      ['x', 'U10'],
      ['y', 'U12'],
    ]);
  });
});
