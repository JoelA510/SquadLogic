/**
 * Team priorities and coaching leads (Phase B6, docs/changes/2026-10-22-phase-b-teaming.md):
 * the rule in `packages/core/src/coachingLeads.js`, through the generator (`generateTeams`, with
 * the Teams page's pipeline where buddies matter) and TeamBuilder's auto-balance
 * (`serpentineAssign`). A lead is a player whose parent volunteers to coach; a lead is not a
 * coach and anchors no team.
 */
import { describe, expect, it, vi } from 'vitest';
import { generateTeams } from '../packages/core/src/teamGeneration.js';
import { serpentineAssign } from '../packages/core/src/balanceSignals.js';
import { prepareTeamingInput } from '../packages/core/src/teamingPipeline.js';
import {
  LEAD_COMPENSATION_FACTOR,
  SPREAD_COACHING_LEADS_FLAG,
  countLeads,
  isCoachingLeadAnswer,
  leadCompensation,
} from '../packages/core/src/coachingLeads.js';
import { FEATURE_DEFAULTS, FEATURE_FLAGS } from '../frontend/src/constants/featureFlags.js';

vi.spyOn(console, 'log').mockImplementation(() => {});

const DIV = 'U10';
/** @returns {any} */
const kid = (id, years, overrides = {}) => ({
  id,
  division: DIV,
  firstName: `First${id}`,
  lastName: `Last${id}`,
  name: `First${id} Last${id}`,
  years_played: years,
  ...overrides,
});
const lead = (id, years, overrides = {}) => kid(id, years, { isCoachingLead: true, ...overrides });

const YEARS = { years_played: true };
const generate = (players, { teams = 3, max = 12, flags = YEARS, seed = 'b6' } = {}) =>
  generateTeams({
    players,
    seed,
    featureFlags: flags,
    divisionConfigs: /** @type {any} */ ({
      [DIV]: { id: DIV, maxRosterSize: max, teamCountOverride: teams },
    }),
  });
const rostersOf = (result) => result.teamsByDivision[DIV];
const leadsPerTeam = (result) => rostersOf(result).map((team) => countLeads(team.players));
const meanYears = (team) =>
  team.players.reduce((total, p) => total + p.years_played, 0) / team.players.length;

describe('the setting and the answers', () => {
  it('is the registry key, on by default', () => {
    expect(FEATURE_FLAGS.TEAMING_SPREAD_COACHING_LEADS).toBe(SPREAD_COACHING_LEADS_FLAG);
    expect(FEATURE_DEFAULTS[SPREAD_COACHING_LEADS_FLAG]).toBe(true);
  });

  it("reads a coaching answer as the import's finalizer stores it", () => {
    for (const yes of ['Yes', ' y ', 'TRUE', '1', 'Maybe', 'Head Coach', 'volunteer', true]) {
      expect(isCoachingLeadAnswer(yes)).toBe(true);
    }
    for (const no of ['No', 'n', '', '0', 'false', 'N/A', null, undefined, false]) {
      expect(isCoachingLeadAnswer(no)).toBe(false);
    }
  });

  it('counts one lead as one average player, and nothing when balancing by size only', () => {
    expect(LEAD_COMPENSATION_FACTOR).toBe(1);
    expect(leadCompensation([1, 2, 3, 6], { signalKind: 'years' })).toBe(3);
    expect(leadCompensation([1, 2, 3, 6], { signalKind: 'size' })).toBe(0);
    expect(leadCompensation([], { signalKind: 'years' })).toBe(0);
  });
});

describe('the generator', () => {
  it('a lead is not a coach: no team is anchored by one', () => {
    const players = [lead('a', 1), lead('b', 1), lead('c', 1), ...range(9, (i) => kid(`k${i}`, 1))];
    const result = generateTeams({
      players,
      seed: 'b6',
      featureFlags: YEARS,
      divisionConfigs: /** @type {any} */ ({
        [DIV]: { id: DIV, maxRosterSize: 14, targetTeamSize: 12 },
      }),
    });
    expect(rostersOf(result)).toHaveLength(1);
    expect(rostersOf(result)[0].coachId).toBeNull();
  });

  it('three teams and four leads give 2/1/1, never 3/1/0', () => {
    // The leads are the least experienced, so a deal by experience alone would stack them.
    const players = [
      lead('l1', 0),
      lead('l2', 0),
      lead('l3', 0),
      lead('l4', 0),
      ...range(8, (i) => kid(`k${i}`, 8 - i)),
    ];
    // Full rosters of four: dealt after the rest, the leads would go wherever room was left.
    for (const seed of ['s1', 's2', 's3', 's4', 's5']) {
      expect(leadsPerTeam(generate(players, { seed, max: 4 })).sort()).toEqual([1, 1, 2]);
    }
  });

  it('spreads by lead count, not by load: six leads, one experienced, give 2/2/2', () => {
    // By load alone the experienced lead's team looks full, and the rookies' teams take three.
    const players = [
      lead('vet', 12),
      ...range(5, (i) => lead(`r${i}`, 0)),
      ...range(9, (i) => kid(`k${i}`, i % 5)),
    ];
    for (const seed of ['s1', 's2', 's3']) {
      expect(leadsPerTeam(generate(players, { seed })).sort()).toEqual([2, 2, 2]);
    }
  });

  it("a coach's child who is a lead counts on the coach's team", () => {
    const players = [
      lead('child', 2, { coachId: 'coach-1' }),
      lead('l2', 2),
      lead('l3', 2),
      lead('l4', 2),
      ...range(8, (i) => kid(`k${i}`, i)),
    ];
    const result = generate(players);
    const coached = rostersOf(result).find((team) => team.coachId === 'coach-1');
    expect(coached.players.map((p) => p.id)).toContain('child');
    expect(leadsPerTeam(result).sort()).toEqual([1, 1, 2]);
  });

  it('two leads who are mutual buddies stay together, even when that is uneven', () => {
    const players = [
      lead('ann', 1, { buddyId: 'bo' }),
      lead('bo', 1, { buddyId: 'ann' }),
      lead('cy', 1),
      ...range(9, (i) => kid(`k${i}`, i)),
    ];
    for (const seed of ['s1', 's2', 's3']) {
      const result = generate(players, { seed });
      const teamOf = (id) => rostersOf(result).find((t) => t.players.some((p) => p.id === id)).id;
      expect(teamOf('ann')).toBe(teamOf('bo'));
      expect(teamOf('cy')).not.toBe(teamOf('ann'));
      expect(leadsPerTeam(result).sort()).toEqual([0, 1, 2]);
    }
  });

  it('places units holding leads first, so a pair of leads still finds room', () => {
    // Two rosters of three. The pair is the least experienced: dealt last, after the four
    // others had split two and two, it would fit nowhere.
    const players = [
      lead('ann', 0, { buddyId: 'bo' }),
      lead('bo', 0, { buddyId: 'ann' }),
      ...range(4, (i) => kid(`k${i}`, 4 + i)),
    ];
    const result = generate(players, { teams: 2, max: 3 });
    expect(result.overflowByDivision[DIV]).toEqual([]);
    expect(leadsPerTeam(result).sort()).toEqual([0, 2]);
  });

  it('compensates: the team with fewer leads has the higher mean experience', () => {
    // Two teams, three leads: one team holds two. The leads are as experienced as the rest.
    const players = [
      lead('l1', 4),
      lead('l2', 4),
      lead('l3', 4),
      ...range(9, (i) => kid(`k${i}`, i)),
    ];
    for (const seed of ['s1', 's2', 's3', 's4']) {
      const [a, b] = rostersOf(generate(players, { teams: 2, seed }));
      const [fewer, more] = countLeads(a.players) < countLeads(b.players) ? [a, b] : [b, a];
      expect(countLeads(fewer.players)).toBe(1);
      expect(meanYears(fewer)).toBeGreaterThan(meanYears(more));
    }
  });

  it('with the setting off, leads are ordinary players: the same teams as without the flag', () => {
    const players = [
      lead('l1', 0),
      lead('l2', 0),
      lead('l3', 0),
      lead('l4', 0),
      ...range(8, (i) => kid(`k${i}`, 8 - i)),
    ];
    const off = { ...YEARS, [SPREAD_COACHING_LEADS_FLAG]: false };
    const ids = (result) => rostersOf(result).map((team) => team.players.map((p) => p.id));
    const withoutLeads = players.map(({ isCoachingLead: _lead, ...rest }) => rest);
    expect(ids(generate(players, { flags: off }))).toEqual(ids(generate(withoutLeads)));
    // And the setting is what changed it: on, the same input is dealt by the lead rule.
    expect(ids(generate(players))).not.toEqual(ids(generate(players, { flags: off })));
  });

  it('with no lead in the division, the setting changes nothing', () => {
    const players = range(12, (i) => kid(`k${i}`, i % 5, { skillRating: (i * 7) % 5 }));
    const ids = (result) => rostersOf(result).map((team) => team.players.map((p) => p.id));
    expect(ids(generate(players))).toEqual(
      ids(generate(players, { flags: { ...YEARS, [SPREAD_COACHING_LEADS_FLAG]: false } }))
    );
  });

  it('with no player carrying the signal, spreads the leads and leaves skill to the evaluators', () => {
    // Years Played is the league's signal, but the import carried none: the skill tier still
    // balances the rest, as it does in a division without leads.
    const tiers = [5, 5, 5, 5, 5, 5, 1, 1, 1, 1, 1, 1];
    const players = tiers.map((skillRating, i) =>
      (i % 3 === 0 ? lead : kid)(`p${i}`, undefined, { skillRating })
    );
    for (const p of players) delete p.years_played;
    const spreadOf = (result) => {
      const skill = rostersOf(result).map((team) => team.skillTotal);
      return Math.max(...skill) - Math.min(...skill);
    };
    const result = generate(players, { teams: 3, max: 4 });
    expect(leadsPerTeam(result).sort()).toEqual([1, 1, 2]);
    // No worse balanced by skill than the same division with no lead in it.
    const withoutLeads = players.map(({ isCoachingLead: _lead, ...rest }) => rest);
    expect(spreadOf(result)).toBeLessThanOrEqual(spreadOf(generate(withoutLeads, { max: 4 })));
  });

  describe('the buddy rule, with leads spread', () => {
    // Una (a lead) asks for Vic, who listed no buddy. Leads are dealt first, one per team; Vic,
    // the most experienced of the rest, is dealt next, and by experience alone joins Wes, whose
    // team has the lower load.
    const roster = () => [
      lead('una', 9, { firstName: 'Una', lastName: 'Ames', buddy_request: 'Vic Bell' }),
      kid('vic', 10, { firstName: 'Vic', lastName: 'Bell' }),
      lead('wes', 0),
      ...range(9, (i) => kid(`k${i}`, (i % 4) + 1)),
    ];
    const teamed = (buddyRule) => {
      const prepared = prepareTeamingInput({ players: roster(), buddyRule, seasonYear: 2026 });
      const result = generate(prepared.players, { teams: 2 });
      const teamOf = (id) => rostersOf(result).find((t) => t.players.some((p) => p.id === id)).id;
      return { teamOf, leads: leadsPerTeam(result) };
    };

    it('mutual (the default) ignores a one-way request', () => {
      const { teamOf, leads } = teamed('mutual');
      expect(teamOf('una')).not.toBe(teamOf('vic'));
      expect(leads.sort()).toEqual([1, 1]);
    });

    it('one_way_best_effort honours it when the named player listed no buddy', () => {
      const { teamOf, leads } = teamed('one_way_best_effort');
      expect(teamOf('una')).toBe(teamOf('vic'));
      expect(leads.sort()).toEqual([1, 1]);
    });
  });

  it('on a rerun, a late lead joins a team with the fewest leads and nobody preserved moves', () => {
    const first = generate([lead('l1', 1), lead('l2', 1), ...range(7, (i) => kid(`k${i}`, i))], {
      teams: 3,
    });
    const snapshot = {
      status: 'published',
      runId: 'run-1',
      teamsByDivision: {
        [DIV]: rostersOf(first).map((team) => ({
          id: `uuid-${team.id}`,
          name: team.name,
          division: DIV,
          players: team.players.map((p) => ({ id: p.id })),
        })),
      },
    };
    const late = lead('late', 1);
    const everyone = [...rostersOf(first).flatMap((t) => t.players), late];
    const rerun = generateTeams({
      players: everyone,
      seed: 'b6',
      featureFlags: YEARS,
      existingSnapshot: snapshot,
      generationMode: 'review',
      divisionConfigs: /** @type {any} */ ({
        [DIV]: { id: DIV, maxRosterSize: 12, teamCountOverride: 3 },
      }),
    });
    const before = new Map(
      rostersOf(first).map((t) => [`uuid-${t.id}`, t.players.map((p) => p.id)])
    );
    const leadless = rostersOf(first).find((t) => countLeads(t.players) === 0);
    for (const team of rostersOf(rerun)) {
      expect(team.players.map((p) => p.id).filter((id) => id !== 'late')).toEqual(
        before.get(team.id)
      );
    }
    const lateTeam = rostersOf(rerun).find((t) => t.players.some((p) => p.id === 'late'));
    expect(lateTeam.id).toBe(`uuid-${leadless.id}`);
  });
});

describe("TeamBuilder's auto-balance", () => {
  /** @returns {any} */
  const board = (id, years, overrides = {}) => ({ id, years_played: years, ...overrides });
  const deal = (players, teams, overrides = {}) => {
    const teamOf = Object.fromEntries(
      serpentineAssign({ players, teams, signalKind: 'years', ...overrides }).map((a) => [
        a.playerId,
        a.teamId,
      ])
    );
    const leads = Object.fromEntries(teams.map((t) => [t.id, 0]));
    for (const p of players) if (p.willing_to_coach) leads[teamOf[p.id]] += 1;
    return { teamOf, leads: Object.values(leads).sort() };
  };
  const TEAMS3 = [{ id: 't1' }, { id: 't2' }, { id: 't3' }];

  it('three teams and four leads give 2/1/1', () => {
    const players = [
      ...range(4, (i) => board(`l${i}`, 0, { willing_to_coach: true })),
      ...range(8, (i) => board(`k${i}`, 8 - i)),
    ];
    expect(deal(players, TEAMS3).leads).toEqual([1, 1, 2]);
  });

  it('spreads by lead count, not by load: six leads, one experienced, give 2/2/2', () => {
    const players = [
      board('vet', 12, { willing_to_coach: true }),
      ...range(5, (i) => board(`r${i}`, 0, { willing_to_coach: true })),
      ...range(9, (i) => board(`k${i}`, i % 5)),
    ];
    expect(deal(players, TEAMS3).leads).toEqual([2, 2, 2]);
  });

  it('two leads who are mutual buddies stay together', () => {
    const players = [
      board('ann', 1, {
        willing_to_coach: true,
        first_name: 'Ann',
        last_name: 'Ames',
        division: 'd',
        buddy_request: 'Bo Bell',
      }),
      board('bo', 1, {
        willing_to_coach: true,
        first_name: 'Bo',
        last_name: 'Bell',
        division: 'd',
        buddy_request: 'Ann Ames',
      }),
      board('cy', 1, { willing_to_coach: true, division: 'd' }),
      ...range(6, (i) => board(`k${i}`, i, { division: 'd' })),
    ];
    const { teamOf, leads } = deal(players, TEAMS3);
    expect(teamOf.ann).toBe(teamOf.bo);
    expect(leads).toEqual([0, 1, 2]);
  });

  it('compensates: the team with fewer leads has the higher mean experience', () => {
    const players = [
      ...range(3, (i) => board(`l${i}`, 4, { willing_to_coach: true })),
      ...range(9, (i) => board(`k${i}`, i)),
    ];
    const teams = [{ id: 't1' }, { id: 't2' }];
    const { teamOf } = deal(players, teams);
    const stats = teams.map((t) => {
      const members = players.filter((p) => teamOf[p.id] === t.id);
      return {
        leads: members.filter((p) => p.willing_to_coach).length,
        mean: members.reduce((sum, p) => sum + p.years_played, 0) / members.length,
      };
    });
    const [fewer, more] = stats[0].leads < stats[1].leads ? stats : [stats[1], stats[0]];
    expect(fewer.leads).toBe(1);
    expect(fewer.mean).toBeGreaterThan(more.mean);
  });

  it('with the setting off, leads are ordinary players', () => {
    const players = [
      ...range(4, (i) => board(`l${i}`, 0, { willing_to_coach: true })),
      ...range(8, (i) => board(`k${i}`, 8 - i)),
    ];
    const plain = players.map(({ willing_to_coach: _lead, ...rest }) => rest);
    expect(deal(players, TEAMS3, { respectCoach: false }).teamOf).toEqual(
      deal(plain, TEAMS3).teamOf
    );
  });
});

/** `[f(0), …, f(n - 1)]` */
function range(n, f) {
  return Array.from({ length: n }, (_, i) => f(i));
}
