/**
 * The owner's decisions of 2026-10-27 on the Phase B teaming questions
 * (docs/changes/2026-10-22-phase-b-teaming.md, "Owner decisions (2026-10-27)"), in the core:
 *
 *   - the league-wide averages leave out players who cannot be placed (blocked by eligibility,
 *     or waitlisted), and a waitlisted player is seated nowhere;
 *   - what the generator does with a coach linked to two children of one division;
 *   - boys and girls of a co-ed division pair as buddies.
 *
 * Blocked players are annotated by the real pipeline (`prepareTeamingInput`), as the Teams page
 * does. A waitlisted player carries `status: 'waitlist'`, as the page sets it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TEAM_GENERATION } from '../packages/core/src/constants.js';
import { WeightedAttributeEvaluator } from '../packages/core/src/evaluators/WeightedAttributeEvaluator.js';
import { cannotBePlaced, isWaitlisted } from '../packages/core/src/playUp.js';
import { generateTeams } from '../packages/core/src/teamGeneration.js';
import { prepareTeamingInput } from '../packages/core/src/teamingPipeline.js';

const U10 = [{ id: 'U10', name: 'U10', min_age: 10, max_age: 10 }];
const IN_BAND_DOB = '2016-05-01'; // natural age 10 in 2026
const PLAY_DOWN_DOB = '2013-05-01'; // natural age 13: blocked

function prepare(players, coaches = []) {
  return prepareTeamingInput({
    players,
    coaches,
    divisions: U10,
    seasonYear: 2026,
    cutoffMode: 'birth_year',
  }).players;
}

const config = (maxRosterSize = 4) => ({
  U10: { id: 'U10', teamsCount: 1, slotsPerWeek: 0, maxRosterSize },
});
/** @returns {any} */
const kid = (id, extra = {}) => ({ id, division: 'U10', dob: IN_BAND_DOB, ...extra });
const seatedIds = (result) =>
  result.teamsByDivision.U10.flatMap((team) => team.players.map((p) => String(p.id)));
const overflowOf = (result, reason) =>
  (result.overflowByDivision.U10 ?? []).filter((entry) => entry.reason === reason);

describe('the league-wide averages leave out players who cannot be placed', () => {
  afterEach(() => vi.restoreAllMocks());

  /** The `globalStats` the weighted evaluator is handed: the generator's org means and ranges. */
  function globalStatsOf(players) {
    const spy = vi.spyOn(WeightedAttributeEvaluator.prototype, 'evaluate');
    generateTeams({ players, divisionConfigs: config(4), seed: 'means' });
    const calls = spy.mock.calls;
    expect(calls.length).toBeGreaterThan(0); // the evaluator ran: a check that saw nothing is no check
    const stats = calls[0][0].globalStats;
    // Every call is handed the same league-wide stats.
    for (const [context] of calls) expect(context.globalStats).toEqual(stats);
    return stats;
  }

  // Eight players of skill 2 and 4 (mean 3), and, beyond them, a very skilled player who is
  // blocked (100) and one who is waitlisted (50).
  const placeable = () =>
    Array.from({ length: 8 }, (_, i) => kid(`p${i}`, { skillRating: i % 2 === 0 ? 2 : 4 }));

  it('a league with nobody blocked or waitlisted: the means are over every player', () => {
    // Players carrying a status other than the waitlist's are in, and so is an unannotated one.
    const players = placeable().map((p, i) => (i === 0 ? { ...p, status: 'active' } : p));
    const stats = globalStatsOf(prepare(players));
    expect(stats.orgMeans.skill_rating).toBe(3);
    expect(stats.minMax.skill_rating).toEqual({ min: 2, max: 4 });
  });

  it('a blocked player is left out of the means and the range', () => {
    const players = [...placeable(), kid('down', { dob: PLAY_DOWN_DOB, skillRating: 100 })];
    const prepared = prepare(players);
    expect(cannotBePlaced(prepared.find((p) => p.id === 'down'))).toBe(true);
    const stats = globalStatsOf(prepared);
    expect(stats.orgMeans.skill_rating).toBe(3);
    expect(stats.minMax.skill_rating).toEqual({ min: 2, max: 4 });
  });

  it('a waitlisted player is left out of the means and the range', () => {
    const players = [...placeable(), kid('wait', { skillRating: 50, status: 'waitlist' })];
    const stats = globalStatsOf(prepare(players));
    expect(stats.orgMeans.skill_rating).toBe(3);
    expect(stats.minMax.skill_rating).toEqual({ min: 2, max: 4 });
  });

  it('custom attributes are left out the same way', () => {
    const players = [
      ...placeable().map((p) => ({ ...p, custom_attributes: { speed: 10 } })),
      kid('wait', { status: 'waitlist', custom_attributes: { speed: 1000 } }),
    ];
    const stats = globalStatsOf(prepare(players));
    expect(stats.orgMeans.speed).toBe(10);
    expect(stats.minMax.speed).toEqual({ min: 10, max: 10 });
  });

  it('only the waitlist status is the waitlist', () => {
    expect(isWaitlisted({ status: 'waitlist' })).toBe(true);
    for (const status of ['active', 'inactive', 'pending', undefined, null, 'waitlisted']) {
      expect(isWaitlisted({ status })).toBe(false);
    }
    expect(isWaitlisted(null)).toBe(false);
  });
});

describe('a waitlisted player is seated nowhere, and is not dropped silently', () => {
  it('is in overflow with the reason, on no team, and adds no team', () => {
    // Eight placeable players and three waitlisted, rosters of four: two teams, not three.
    const input = [
      ...Array.from({ length: 8 }, (_, i) => kid(`p${i}`, { skillRating: i })),
      ...['w1', 'w2', 'w3'].map((id) => kid(id, { status: 'waitlist' })),
    ];
    const result = generateTeams({
      players: prepare(input),
      divisionConfigs: config(4),
      seed: 'wait',
    });
    expect(result.teamsByDivision.U10).toHaveLength(2);
    expect(seatedIds(result).sort()).toEqual(Array.from({ length: 8 }, (_, i) => `p${i}`).sort());
    const entries = overflowOf(result, TEAM_GENERATION.REASON_Waitlisted);
    expect(entries.map((entry) => entry.players.map((p) => p.id))).toEqual([
      ['w1'],
      ['w2'],
      ['w3'],
    ]);
    expect(entries[0].metadata).toEqual({ coachId: null });
    expect(result.overflowSummaryByDivision.U10.byReason).toEqual({
      waitlisted: { units: 3, players: 3 },
    });
  });

  it('a division of nothing but waitlisted players builds no team', () => {
    const input = ['w1', 'w2'].map((id) => kid(id, { status: 'waitlist' }));
    const result = generateTeams({
      players: prepare(input),
      divisionConfigs: config(4),
      seed: 'wait',
    });
    expect(result.teamsByDivision.U10).toEqual([]);
    expect(overflowOf(result, 'waitlisted')).toHaveLength(2);
  });

  it('a coach whose only child is waitlisted anchors no team; the entry names the coach', () => {
    const input = [
      ...Array.from({ length: 4 }, (_, i) => kid(`p${i}`)),
      kid('wait', { status: 'waitlist' }),
    ];
    const prepared = prepare(input, [{ id: 'coach-a', children: [{ player_id: 'wait' }] }]);
    expect(prepared.find((p) => p.id === 'wait').coachId).toBe('coach-a');
    const result = generateTeams({ players: prepared, divisionConfigs: config(4), seed: 'wait' });
    expect(result.teamsByDivision.U10.map((team) => team.coachId)).toEqual([null]);
    expect(overflowOf(result, 'waitlisted')[0].metadata).toEqual({ coachId: 'coach-a' });
  });

  it('a mutual buddy of a waitlisted player is placed alone, and the request says why', () => {
    const input = [
      kid('a', { buddyId: 'wait' }),
      kid('wait', { status: 'waitlist', buddyId: 'a' }),
      ...Array.from({ length: 3 }, (_, i) => kid(`p${i}`)),
    ];
    const result = generateTeams({
      players: prepare(input),
      divisionConfigs: config(4),
      seed: 'wait',
    });
    expect(seatedIds(result)).toContain('a');
    expect(result.buddyDiagnosticsByDivision.U10.unmatchedRequests).toEqual([
      { playerId: 'a', requestedBuddyId: 'wait', reason: 'buddy-not-placed' },
    ]);
  });

  it('a player both blocked and waitlisted is reported as blocked, once', () => {
    const input = [
      kid('both', { dob: PLAY_DOWN_DOB, status: 'waitlist' }),
      ...Array.from({ length: 4 }, (_, i) => kid(`p${i}`)),
    ];
    const result = generateTeams({
      players: prepare(input),
      divisionConfigs: config(4),
      seed: 'wait',
    });
    expect(overflowOf(result, 'eligibility-blocked')).toHaveLength(1);
    expect(overflowOf(result, 'waitlisted')).toHaveLength(0);
  });
});

describe('a younger player who requested to play up, with a coach’s child as the buddy', () => {
  const YOUNG_DOB = '2018-05-01'; // natural age 8 in U10: a play-up
  const pair = (childExtra, youngExtra = { play_up_requested: true }) => [
    kid('child', {
      firstName: 'Cara',
      lastName: 'Coach',
      buddy_request: 'Pia Younger',
      ...childExtra,
    }),
    kid('young', {
      firstName: 'Pia',
      lastName: 'Younger',
      dob: YOUNG_DOB,
      buddy_request: 'Cara Coach',
      ...youngExtra,
    }),
    ...Array.from({ length: 4 }, (_, i) =>
      kid(`f${i}`, { firstName: `Fill${String.fromCharCode(97 + i)}`, lastName: 'Lane' })
    ),
  ];
  const run = (players) => {
    const roster = players.map((p) => ({ ...p, division: 'U10' }));
    const prepared = prepareTeamingInput({
      players,
      roster,
      coaches: [{ id: 'coach-a', player_id: 'child' }],
      divisions: U10,
      seasonYear: 2026,
      cutoffMode: 'birth_year',
    });
    return {
      prepared: prepared.players,
      diagnostics: prepared.diagnostics,
      result: generateTeams({
        players: prepared.players,
        divisionConfigs: config(4),
        seed: 'route-b',
      }),
    };
  };
  const teamOf = (result, id) =>
    result.teamsByDivision.U10.find((team) => team.players.some((p) => p.id === id));

  it('is placed with the coach’s child and listed, with the buddy in the division', () => {
    const { prepared, diagnostics, result } = run(pair({}));
    expect(prepared.find((p) => p.id === 'young').placement).toBe('play_up');
    expect(teamOf(result, 'young')).toBeDefined();
    expect(teamOf(result, 'young').id).toBe(teamOf(result, 'child').id);
    const entry = diagnostics.playUp.listing.find((e) => e.playerId === 'young');
    expect(entry).toMatchObject({ requested: true, buddyId: 'child', buddyInPlayedDivision: true });
  });

  it('a waitlisted coach child is not placed, and the requester is placed alone, not blocked', () => {
    const { prepared, result } = run(pair({ status: 'waitlist' }));
    const young = prepared.find((p) => p.id === 'young');
    expect(young.placement).toBe('play_up');
    expect(young.needsReview).toBe(true);
    expect(seatedIds(result)).toContain('young');
    expect(seatedIds(result)).not.toContain('child');
    expect(overflowOf(result, TEAM_GENERATION.REASON_EligibilityBlocked)).toEqual([]);
    expect(
      overflowOf(result, TEAM_GENERATION.REASON_Waitlisted).map((e) => e.players[0].id)
    ).toEqual(['child']);
    expect(result.buddyDiagnosticsByDivision.U10.unmatchedRequests).toEqual([
      { playerId: 'young', requestedBuddyId: 'child', reason: 'buddy-not-placed' },
    ]);
  });

  it('a coach child no division can hold is held out, and the requester is placed alone', () => {
    const { prepared, result } = run(pair({ dob: PLAY_DOWN_DOB }));
    expect(prepared.find((p) => p.id === 'child').placement).toBe('no_division');
    expect(prepared.find((p) => p.id === 'young').placement).toBe('play_up');
    expect(seatedIds(result)).toContain('young');
    expect(overflowOf(result, TEAM_GENERATION.REASON_EligibilityBlocked)).toHaveLength(1);
  });

  it('without the request, with no age division to move to, the player is held out, listed', () => {
    const { prepared, diagnostics, result } = run(pair({}, { play_up_requested: false }));
    expect(prepared.find((p) => p.id === 'young').placement).toBe('no_division');
    expect(seatedIds(result)).not.toContain('young');
    expect(diagnostics.playUp.listing.find((e) => e.playerId === 'young').kind).toBe('no-division');
  });
});

describe('a coach linked to two children of one division (the generator today)', () => {
  const coach = { id: 'coach-a', children: [{ player_id: 'c1' }, { player_id: 'c2' }] };
  const others = (n) => Array.from({ length: n }, (_, i) => kid(`p${i}`, { skillRating: i }));

  it('anchors one team, and both children are seated on it', () => {
    const prepared = prepare([kid('c1'), kid('c2'), ...others(6)], [coach]);
    expect(prepared.filter((p) => p.coachId === 'coach-a').map((p) => p.id)).toEqual(['c1', 'c2']);
    const result = generateTeams({ players: prepared, divisionConfigs: config(4), seed: 'sib' });
    const coachTeams = result.teamsByDivision.U10.filter((team) => team.coachId === 'coach-a');
    expect(coachTeams).toHaveLength(1);
    expect(coachTeams[0].players.map((p) => p.id)).toEqual(expect.arrayContaining(['c1', 'c2']));
  });

  it('when the coach team is full, the child that does not fit is not placed, "coach-capacity"', () => {
    // Three children, rosters of two: the third is in overflow, not on another team.
    const three = { id: 'coach-a', children: ['c1', 'c2', 'c3'].map((id) => ({ player_id: id })) };
    const prepared = prepare([kid('c1'), kid('c2'), kid('c3'), ...others(4)], [three]);
    const result = generateTeams({ players: prepared, divisionConfigs: config(2), seed: 'sib' });
    const coachTeam = result.teamsByDivision.U10.find((team) => team.coachId === 'coach-a');
    expect(coachTeam.players).toHaveLength(2);
    const entries = overflowOf(result, TEAM_GENERATION.REASON_CoachCapacity);
    expect(entries).toHaveLength(1);
    expect(coachTeam.players.map((p) => p.id)).not.toContain(entries[0].players[0].id);
    expect(['c1', 'c2', 'c3']).toContain(entries[0].players[0].id);
  });
});

describe('buddies in a co-ed division (U4, say) are boy and girl', () => {
  it('the generator pairs a boy and a girl of one division who name each other', () => {
    const boy = {
      id: 'b',
      division: 'U4',
      gender: 'm',
      firstName: 'Ben',
      lastName: 'Ortiz',
      buddy_request: 'Gia Ortiz',
    };
    const girl = {
      id: 'g',
      division: 'U4',
      gender: 'f',
      firstName: 'Gia',
      lastName: 'Ortiz',
      buddy_request: 'Ben Ortiz',
    };
    const rest = Array.from({ length: 6 }, (_, i) => ({
      id: `x${i}`,
      division: 'U4',
      gender: i % 2 ? 'f' : 'm',
      firstName: `Kid${String.fromCharCode(97 + i)}`,
      lastName: 'Lane',
      skillRating: i,
    }));
    const roster = [boy, girl, ...rest];
    const prepared = prepareTeamingInput({
      players: roster,
      roster,
      divisions: [],
      seasonYear: 2026,
    }).players;
    expect(prepared.find((p) => p.id === 'b').buddyId).toBe('g');
    const result = generateTeams({
      players: prepared,
      divisionConfigs: { U4: { id: 'U4', teamsCount: 2, slotsPerWeek: 0, maxRosterSize: 4 } },
      seed: 'coed',
    });
    const teamOf = (id) =>
      result.teamsByDivision.U4.find((team) => team.players.some((p) => p.id === id)).id;
    expect(teamOf('b')).toBe(teamOf('g'));
  });
});
