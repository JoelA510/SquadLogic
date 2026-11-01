/**
 * A preserved player who is waitlisted later stays on their reviewed roster and is listed
 * (docs/changes/2026-11-01-followups-f1.md, item 2; the Phase B plan's "Not built" of #671).
 *
 * A blocked player on a reviewed roster stays and is listed in `eligibilityHolds` (B2, owner
 * decision 3). A waitlisted one is held out of a late placement but, rostered, used to stay with
 * nothing saying so. Same contract: nobody moves, the admin is told. Blocked players are annotated
 * by the real pipeline (`prepareTeamingInput`), never forged.
 */
import { describe, expect, it } from 'vitest';

import { TEAM_GENERATION } from '../packages/core/src/constants.js';
import { generateTeams } from '../packages/core/src/teamGeneration.js';
import { prepareTeamingInput } from '../packages/core/src/teamingPipeline.js';

const U10 = [{ id: 'U10', name: 'U10', min_age: 10, max_age: 10 }];
const IN_BAND_DOB = '2016-05-01'; // natural age 10 in 2026
const PLAY_DOWN_DOB = '2013-05-01'; // natural age 13: no division holds it

const TEAM_A = '0b2e0000-0000-4000-8000-0000000000a1';
const TEAM_B = '0b2e0000-0000-4000-8000-0000000000a2';

const config = (id) => ({ id, teamsCount: 1, slotsPerWeek: 0, maxRosterSize: 4 });
const kid = (id, extra = {}) => ({ id, division: 'U10', dob: IN_BAND_DOB, ...extra });
const waitlisted = (id, extra = {}) => kid(id, { status: 'waitlist', ...extra });

function prepare(players) {
  return prepareTeamingInput({
    players,
    coaches: [],
    divisions: U10,
    seasonYear: 2026,
    cutoffMode: 'birth_year',
  }).players;
}

/** A reviewed roster: Team A (open) and Team B (locked), each holding the named players. */
function snapshot(teamA, teamB) {
  return {
    status: 'review',
    runId: 'run-f1',
    teamsByDivision: {
      U10: [
        {
          id: TEAM_A,
          name: 'Team A',
          division: 'U10',
          coachId: null,
          players: teamA.map((id) => ({ id, assignment_source: 'auto' })),
        },
        {
          id: TEAM_B,
          name: 'Team B',
          division: 'U10',
          coachId: null,
          locked: true,
          players: teamB.map((id) => ({ id, assignment_source: 'auto' })),
        },
      ],
    },
  };
}

const rerun = (players, existingSnapshot, extra = {}) =>
  generateTeams({
    players: prepare(players),
    divisionConfigs: { U10: config('U10') },
    seed: 'f1',
    existingSnapshot,
    generationMode: 'review',
    ...extra,
  });

const seatedIds = (result) =>
  (result.teamsByDivision.U10 ?? []).flatMap((team) => team.players.map((p) => String(p.id)));
const overflowIds = (result) =>
  (result.overflowByDivision.U10 ?? []).flatMap((entry) => entry.players.map((p) => String(p.id)));
const holds = (result) => result.changeDiagnosticsByDivision.U10.eligibilityHolds;

/** Every input player is seated or in overflow exactly once (enumerated from the input). */
function expectConserved(result, input) {
  expect([...seatedIds(result), ...overflowIds(result)].sort()).toEqual(
    input.map((p) => String(p.id)).sort()
  );
}

describe('a preserved player who is waitlisted later', () => {
  it('stays on their reviewed team, with the team UUID, and is listed as a hold', () => {
    const input = [kid('a1'), waitlisted('w1'), kid('a2'), kid('b1')];
    const result = rerun(input, snapshot(['a1', 'w1', 'a2'], ['b1']));

    const teams = result.teamsByDivision.U10;
    expect(teams.map((team) => team.id)).toEqual([TEAM_A, TEAM_B]);
    expect(teams[0].players.map((p) => p.id)).toEqual(['a1', 'w1', 'a2']);
    expect(holds(result)).toEqual([
      {
        playerId: 'w1',
        teamId: TEAM_A,
        placement: 'in_band',
        reviewReason: null,
        waitlisted: true,
      },
    ]);
    // Held, not overflowed: the roster is not reshuffled and the waitlist reason is for late players.
    expect(overflowIds(result)).toEqual([]);
    expectConserved(result, input);
  });

  it('is listed on a locked team too', () => {
    const input = [kid('a1'), kid('b1'), waitlisted('w2')];
    const result = rerun(input, snapshot(['a1'], ['b1', 'w2']));

    expect(result.teamsByDivision.U10[1].players.map((p) => p.id)).toEqual(['b1', 'w2']);
    expect(holds(result).map((hold) => [hold.playerId, hold.teamId, hold.waitlisted])).toEqual([
      ['w2', TEAM_B, true],
    ]);
    expectConserved(result, input);
  });

  it('is one blocked entry, with no waitlist mark, when they are also blocked', () => {
    const input = [
      kid('a1'),
      { ...waitlisted('both'), dob: PLAY_DOWN_DOB },
      { ...kid('blocked-only'), dob: PLAY_DOWN_DOB },
      kid('b1'),
    ];
    const result = rerun(input, snapshot(['a1', 'both', 'blocked-only'], ['b1']));

    expect(holds(result)).toEqual([
      {
        playerId: 'both',
        teamId: TEAM_A,
        placement: 'no_division',
        reviewReason: 'no suitable division holds natural age 13',
      },
      {
        playerId: 'blocked-only',
        teamId: TEAM_A,
        placement: 'no_division',
        reviewReason: 'no suitable division holds natural age 13',
      },
    ]);
    expect(holds(result).some((hold) => 'waitlisted' in hold)).toBe(false);
    expectConserved(result, input);
  });

  it('is not a hold once they are taken off the waitlist (status active)', () => {
    const input = [kid('a1'), kid('w1', { status: 'active' }), kid('b1')];
    const result = rerun(input, snapshot(['a1', 'w1'], ['b1']));
    expect(holds(result)).toEqual([]);
  });
});

describe('a late waitlisted player is still held out, and is no hold', () => {
  it('overflows with the waitlisted reason and leaves the holds empty', () => {
    const input = [kid('a1'), kid('b1'), waitlisted('late-w'), kid('late-ok')];
    const result = rerun(input, snapshot(['a1'], ['b1']));

    expect(seatedIds(result)).not.toContain('late-w');
    expect(seatedIds(result)).toContain('late-ok');
    const entries = result.overflowByDivision.U10.filter(
      (entry) => entry.reason === TEAM_GENERATION.REASON_Waitlisted
    );
    expect(entries.map((entry) => entry.players.map((p) => p.id))).toEqual([['late-w']]);
    expect(holds(result)).toEqual([]);
    expectConserved(result, input);
  });
});

describe('a fresh run has no holds at all', () => {
  it('leaves a waitlisted player out of every team, with no change diagnostics', () => {
    const input = [kid('x1'), kid('x2'), waitlisted('w1')];
    const result = generateTeams({
      players: prepare(input),
      divisionConfigs: { U10: config('U10') },
      seed: 'f1',
    });
    expect(result.changeDiagnosticsByDivision).toBeUndefined();
    expect(seatedIds(result)).not.toContain('w1');
    expectConserved(result, input);
  });
});
