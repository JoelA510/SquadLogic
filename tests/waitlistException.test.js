/**
 * The waitlist exception (owner, 2026-10-27, docs/changes/2026-10-27-play-up-by-request.md):
 * a buddy does not take a player off the waitlist, unless a coach asked for them -- the buddy,
 * under the league's buddy rule, of a coach's linked child. Run through the real pipeline
 * (`prepareTeamingInput`) and the real generator, as the Teams page does; no state is forged.
 */
import { describe, expect, it } from 'vitest';
import { generateTeams } from '../packages/core/src/teamGeneration.js';
import { prepareTeamingInput } from '../packages/core/src/teamingPipeline.js';
import { applyWaitlistException } from '../packages/core/src/waitlistException.js';
import { TEAM_GENERATION } from '../packages/core/src/constants.js';

const SEASON = 2026;
const DIVISIONS = [
  { id: 'U10B', name: 'U10 Boys', min_age: 10, max_age: 10, gender_policy: 'boys' },
  { id: 'U9B', name: 'U9 Boys', min_age: 9, max_age: 9, gender_policy: 'boys' },
];

const kid = (id, first, last, extra = {}) => ({
  id,
  division: 'U10B',
  firstName: first,
  lastName: last,
  name: `${first} ${last}`,
  dob: '2016-05-01',
  ...extra,
});
const fillers = (n) => Array.from({ length: n }, (_, i) => kid(`f${i}`, `Fill${i}`, 'Er'));
const COACH = { id: 'coachA', player_id: 'child' };

/** @param {any[]} players @param {{ coaches?: any[], buddyRule?: string, maxRosterSize?: number }} [options] */
function run(players, { coaches = [COACH], buddyRule, maxRosterSize = 8 } = {}) {
  const prepared = prepareTeamingInput({
    players,
    coaches,
    divisions: DIVISIONS,
    seasonYear: SEASON,
    cutoffMode: 'birth_year',
    ...(buddyRule ? { buddyRule } : {}),
  });
  const generated = generateTeams({
    players: prepared.players.filter((p) => p.division === 'U10B'),
    divisionConfigs: { U10B: { id: 'U10B', slotsPerWeek: 0, teamsCount: 2, maxRosterSize } },
    seed: 'waitlist-exception',
  });
  const teamOf = (id) =>
    generated.teamsByDivision.U10B.find((team) => team.players.some((p) => p.id === id));
  const overflowReason = (id) =>
    (generated.overflowByDivision.U10B ?? []).find((e) => e.players.some((p) => p.id === id))
      ?.reason;
  return { prepared, generated, teamOf, overflowReason };
}

describe('a waitlisted buddy of a coach’s child', () => {
  const players = () => [
    kid('child', 'Cara', 'Coach', { buddy_request: 'Wendy Wait' }),
    kid('wait', 'Wendy', 'Wait', { status: 'waitlist', buddy_request: 'Cara Coach' }),
    ...fillers(8),
  ];

  it('comes off the waitlist and is placed on the coach’s team with the child, and is listed', () => {
    const { prepared, teamOf, overflowReason } = run(players());
    expect(prepared.diagnostics.waitlistExceptions).toEqual([
      {
        playerId: 'wait',
        name: 'Wendy Wait',
        childId: 'child',
        childName: 'Cara Coach',
        coachId: 'coachA',
        division: 'U10B',
      },
    ]);
    const wait = prepared.players.find((p) => p.id === 'wait');
    expect(wait.status).toBe('active');
    expect(wait.takenOffWaitlist).toEqual({ childId: 'child', coachId: 'coachA' });
    expect(overflowReason('wait')).toBeUndefined();
    const team = teamOf('wait');
    expect(team).toBeDefined();
    expect(team.id).toBe(teamOf('child').id);
    expect(team.coachId).toBe('coachA');
  });

  it('stays waitlisted when the child’s coach is not active (no link in the run)', () => {
    const { prepared, overflowReason, teamOf } = run(players(), { coaches: [] });
    expect(prepared.diagnostics.waitlistExceptions).toEqual([]);
    expect(prepared.players.find((p) => p.id === 'wait').status).toBe('waitlist');
    expect(overflowReason('wait')).toBe(TEAM_GENERATION.REASON_Waitlisted);
    expect(teamOf('wait')).toBeUndefined();
  });

  it('stays waitlisted when the child is on the waitlist too', () => {
    const waitlistedChild = players().map((p) =>
      p.id === 'child' ? { ...p, status: 'waitlist' } : p
    );
    const { prepared, overflowReason } = run(waitlistedChild);
    expect(prepared.diagnostics.waitlistExceptions).toEqual([]);
    expect(overflowReason('wait')).toBe(TEAM_GENERATION.REASON_Waitlisted);
  });
});

describe('any other buddy of a waitlisted player does nothing', () => {
  it('a mutual buddy who is not a coach’s child leaves both where they were', () => {
    const { prepared, overflowReason, teamOf } = run([
      kid('pal', 'Pal', 'One', { buddy_request: 'Wendy Wait' }),
      kid('wait', 'Wendy', 'Wait', { status: 'waitlist', buddy_request: 'Pal One' }),
      kid('child', 'Cara', 'Coach'),
      ...fillers(8),
    ]);
    expect(prepared.diagnostics.waitlistExceptions).toEqual([]);
    expect(overflowReason('wait')).toBe(TEAM_GENERATION.REASON_Waitlisted);
    expect(teamOf('pal')).toBeDefined();
  });

  it('a waitlisted player with no buddy and no coach link stays out', () => {
    const { prepared, overflowReason } = run([
      kid('wait', 'Wendy', 'Wait', { status: 'waitlist' }),
      kid('child', 'Cara', 'Coach'),
      ...fillers(8),
    ]);
    expect(prepared.diagnostics.waitlistExceptions).toEqual([]);
    expect(overflowReason('wait')).toBe(TEAM_GENERATION.REASON_Waitlisted);
  });

  it('a waitlisted coach’s own child is not a buddy exception', () => {
    const { prepared, overflowReason } = run(
      [kid('child', 'Cara', 'Coach', { status: 'waitlist' }), ...fillers(8)],
      { coaches: [COACH] }
    );
    expect(prepared.diagnostics.waitlistExceptions).toEqual([]);
    expect(overflowReason('child')).toBe(TEAM_GENERATION.REASON_Waitlisted);
  });

  it('a request nobody returns is no link under the mutual rule', () => {
    const { prepared, overflowReason } = run([
      kid('child', 'Cara', 'Coach'),
      kid('wait', 'Wendy', 'Wait', { status: 'waitlist', buddy_request: 'Cara Coach' }),
      ...fillers(8),
    ]);
    expect(prepared.diagnostics.waitlistExceptions).toEqual([]);
    expect(overflowReason('wait')).toBe(TEAM_GENERATION.REASON_Waitlisted);
  });
});

describe('under the one-way best-effort rule a honoured request counts, from either side', () => {
  it('the waitlisted player asks for the child', () => {
    const { prepared, teamOf } = run(
      [
        kid('child', 'Cara', 'Coach'),
        kid('wait', 'Wendy', 'Wait', { status: 'waitlist', buddy_request: 'Cara Coach' }),
        ...fillers(8),
      ],
      { buddyRule: 'one_way_best_effort' }
    );
    expect(prepared.diagnostics.waitlistExceptions.map((e) => e.playerId)).toEqual(['wait']);
    expect(teamOf('wait').id).toBe(teamOf('child').id);
  });

  it('the child asks for the waitlisted player', () => {
    const { prepared, teamOf } = run(
      [
        kid('child', 'Cara', 'Coach', { buddy_request: 'Wendy Wait' }),
        kid('wait', 'Wendy', 'Wait', { status: 'waitlist' }),
        ...fillers(8),
      ],
      { buddyRule: 'one_way_best_effort' }
    );
    expect(prepared.diagnostics.waitlistExceptions.map((e) => e.playerId)).toEqual(['wait']);
    expect(teamOf('wait').id).toBe(teamOf('child').id);
  });
});

describe('one waitlisted player for each coach’s child', () => {
  const ONE_WAY = { buddyRule: 'one_way_best_effort' };

  it('takes one of two waitlisted players who name the same child, and the roster holds', () => {
    // A roster of two: the child and one buddy. Both Ws name Cara; the child lists no buddy, so
    // both requests are honoured one-way, and only one may be taken.
    const players = [
      kid('child', 'Cara', 'Coach'),
      kid('w2', 'Zed', 'Waiting', { status: 'waitlist', buddy_request: 'Cara Coach' }),
      kid('w1', 'Amy', 'Waiting', { status: 'waitlist', buddy_request: 'Cara Coach' }),
      ...fillers(4),
    ];
    for (const order of [players, [...players].reverse()]) {
      const { prepared, teamOf, overflowReason } = run(order, { ...ONE_WAY, maxRosterSize: 2 });
      expect(prepared.diagnostics.waitlistExceptions.map((e) => e.playerId)).toEqual(['w1']);
      expect(prepared.players.find((p) => p.id === 'w2').status).toBe('waitlist');
      expect(overflowReason('w2')).toBe(TEAM_GENERATION.REASON_Waitlisted);
      expect(teamOf('w1').id).toBe(teamOf('child').id);
      expect(teamOf('child').players).toHaveLength(2);
      // The child is paired with the one taken, and nobody else.
      expect(prepared.players.find((p) => p.id === 'child').buddyId).toBe('w1');
    }
  });

  it('the child’s own request wins over another waitlisted player naming them', () => {
    const players = [
      kid('child', 'Cara', 'Coach', { buddy_request: 'Zed Waiting' }),
      kid('w1', 'Amy', 'Waiting', { status: 'waitlist', buddy_request: 'Cara Coach' }),
      kid('w2', 'Zed', 'Waiting', { status: 'waitlist' }),
      ...fillers(4),
    ];
    const { prepared } = run(players, { ...ONE_WAY, maxRosterSize: 2 });
    expect(prepared.diagnostics.waitlistExceptions.map((e) => e.playerId)).toEqual(['w2']);
  });
});

describe('every link that points at a waitlisted player counts, in any row order', () => {
  it('a coach’s child among several players who name them grants the exception', () => {
    // Under the one-way rule the waitlisted player lists no buddy, so each request that names
    // them is honoured; the coach's child is not the first to name them.
    const players = [
      kid('x', 'Xavier', 'Other', { buddy_request: 'Wendy Waiting' }),
      kid('child', 'Cara', 'Coach', { buddy_request: 'Wendy Waiting' }),
      kid('wait', 'Wendy', 'Waiting', { status: 'waitlist' }),
      ...fillers(6),
    ];
    for (const order of [players, [...players].reverse()]) {
      const { prepared, teamOf } = run(order, { buddyRule: 'one_way_best_effort' });
      const exceptions = prepared.diagnostics.waitlistExceptions;
      expect(exceptions.map((e) => [e.playerId, e.childId])).toEqual([['wait', 'child']]);
      expect(teamOf('wait').id).toBe(teamOf('child').id);
    }
  });

  it('a waitlisted player already paired with someone else is not taken', () => {
    const { prepared } = run([
      kid('x', 'Xavier', 'Other', { buddy_request: 'Wendy Waiting' }),
      kid('wait', 'Wendy', 'Waiting', { status: 'waitlist', buddy_request: 'Xavier Other' }),
      kid('child', 'Cara', 'Coach', { buddy_request: 'Wendy Waiting' }),
      ...fillers(6),
    ]);
    expect(prepared.diagnostics.waitlistExceptions).toEqual([]);
  });
});

describe('the division played in', () => {
  it('a waitlisted buddy who plays in another division is not taken off', () => {
    // Wendy is 9, registered up, no request: she plays in U9B, the child in U10B.
    const { prepared } = run([
      kid('child', 'Cara', 'Coach', { buddy_request: 'Wendy Wait' }),
      kid('wait', 'Wendy', 'Wait', {
        status: 'waitlist',
        dob: '2017-05-01',
        buddy_request: 'Cara Coach',
      }),
      ...fillers(8),
    ]);
    expect(prepared.diagnostics.waitlistExceptions).toEqual([]);
    expect(prepared.players.find((p) => p.id === 'wait').status).toBe('waitlist');
  });
});

describe('applyWaitlistException', () => {
  it('returns the same players when nobody is waitlisted', () => {
    const players = [kid('a', 'A', 'One'), kid('b', 'B', 'Two')];
    const out = applyWaitlistException({ players });
    expect(out.players).toBe(players);
    expect(out.exceptions).toEqual([]);
  });

  it('refuses a non-array', () => {
    expect(() => applyWaitlistException({ players: null })).toThrow(TypeError);
  });
});
