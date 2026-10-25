import { describe, expect, it } from 'vitest';
import {
  balanceSignalKind,
  playerSignal,
  teamBalanceMetrics,
  boardBuddyLinks,
  buddyStats,
  serpentineAssign,
} from '../packages/core/src/balanceSignals.js';
import { prepareTeamingInput } from '../packages/core/src/teamingPipeline.js';
import {
  normalizeGender,
  planCoedMerge,
  planGenderSplit,
} from '../packages/core/src/coedTransition.js';

/** @returns {any} */
const player = (id, overrides = {}) => ({
  id,
  first_name: `P${id}`,
  last_name: 'Test',
  gender: 'm',
  ...overrides,
});

describe('balanceSignals', () => {
  it('selects the signal kind from the feature config', () => {
    expect(balanceSignalKind({ player_rating: true, years_played: true })).toBe('rating');
    expect(balanceSignalKind({ years_played: true })).toBe('years');
    expect(balanceSignalKind({})).toBe('size');
  });

  it('computes player signals per kind (years = yearsPlayed + 1)', () => {
    expect(playerSignal({ rating: 4 }, 'rating')).toBe(4);
    expect(playerSignal({ years_played: 2 }, 'years')).toBe(3);
    expect(playerSignal({ years_played: 0 }, 'years')).toBe(1);
    expect(playerSignal({}, 'size')).toBe(1);
  });

  it('computes team metrics', () => {
    const metrics = teamBalanceMetrics([
      player(1, { gender: 'm', rating: 4, years_played: 2 }),
      player(2, { gender: 'f', rating: 2, years_played: 0 }),
    ]);
    expect(metrics).toMatchObject({ size: 2, boys: 1, girls: 1, avgRating: 3, avgYears: 1 });
  });

  it('tracks buddy satisfaction by shared team, under the league buddy rule', () => {
    const players = [
      player('a', { first_name: 'Sam', last_name: 'Lee', buddy_request: 'Kim Cho', team_id: 't1' }),
      player('b', { first_name: 'Kim', last_name: 'Cho', team_id: 't1' }),
      player('c', { first_name: 'Joy', last_name: 'Wu', buddy_request: 'Sam Lee', team_id: 't2' }),
      player('d', { first_name: 'Ana', last_name: 'Iz', buddy_request: 'Nobody Here' }),
    ];
    // Mutual (the default): no request is reciprocated, so none is honoured or counted.
    expect(buddyStats(players)).toEqual({ requested: 0, satisfied: 0 });
    // One-way best effort: a's request is honoured (Kim listed no buddy) and met; c's is not
    // honoured (Sam listed a buddy of their own); d's names nobody.
    expect(buddyStats(players, { buddyRule: 'one_way_best_effort' })).toEqual({
      requested: 1,
      satisfied: 1,
    });
  });

  it('serpentine-assigns with buddies kept together and coach parents spread', () => {
    const players = [
      player(1, { rating: 5, willing_to_coach: true }),
      player(2, { rating: 5, willing_to_coach: true }),
      player(3, {
        rating: 4,
        first_name: 'Ben',
        last_name: 'Kay',
        buddy_request: 'Lia Ray',
      }),
      player(4, { rating: 1, first_name: 'Lia', last_name: 'Ray', buddy_request: 'Ben Kay' }),
      player(5, { rating: 3 }),
      player(6, { rating: 2 }),
    ];
    const teams = [{ id: 't1' }, { id: 't2' }];
    const assignments = serpentineAssign({
      players,
      teams,
      signalKind: 'rating',
      respectBuddies: true,
      respectCoach: true,
    });

    expect(assignments).toHaveLength(6);
    const teamOf = Object.fromEntries(assignments.map((a) => [a.playerId, a.teamId]));
    // buddy pair shares a team
    expect(teamOf[3]).toBe(teamOf[4]);
    // coach parents land on different teams
    expect(teamOf[1]).not.toBe(teamOf[2]);
    // signal totals are balanced within one unit
    const totals = { t1: 0, t2: 0 };
    assignments.forEach((a) => {
      const p = players.find((entry) => entry.id === a.playerId);
      totals[a.teamId] += Number(p?.rating) || 0;
    });
    expect(Math.abs(totals.t1 - totals.t2)).toBeLessThanOrEqual(2);
  });

  it('returns no assignments when there are no teams', () => {
    expect(serpentineAssign({ players: [player(1)], teams: [] })).toEqual([]);
  });
});

/**
 * Phase B5 (docs/changes/2026-10-22-phase-b-teaming.md): TeamBuilder's buddy logic matches
 * names through `resolveBuddyRequests` and applies the league's `buddy_rule`, as Team
 * Analysis does (B1). Ratings are chosen so that two players dealt apart land on different
 * teams: the top two units of a serpentine deal always split.
 */
describe('TeamBuilder buddies: the resolver and the league buddy rule', () => {
  const RULES = ['mutual', 'one_way_best_effort'];
  const TEAMS = [{ id: 't1' }, { id: 't2' }];
  const assign = (players, buddyRule, overrides = {}) =>
    Object.fromEntries(
      serpentineAssign({
        players,
        teams: TEAMS,
        signalKind: 'rating',
        respectBuddies: true,
        respectCoach: false,
        buddyRule,
        ...overrides,
      }).map((x) => [x.playerId, x.teamId])
    );

  // Two players named Sam Lee; Ada names "Sam Lee".
  const namesakes = (overrides = {}) => [
    player('ada', { first_name: 'Ada', last_name: 'One', buddy_request: 'Sam Lee', rating: 5 }),
    player('sam1', { first_name: 'Sam', last_name: 'Lee', rating: 4, ...overrides.sam1 }),
    player('sam2', { first_name: 'Sam', last_name: 'Lee', rating: 3, ...overrides.sam2 }),
    player('x', { rating: 1 }),
  ];

  for (const rule of RULES) {
    it(`two players of one name: an unsettled request pairs nobody (${rule})`, () => {
      const teamOf = assign(namesakes(), rule);
      // Neither Sam Lee is paired with Ada: the two Sams split from her as single units.
      expect(teamOf.ada).not.toBe(teamOf.sam1);
      expect(teamOf.ada).not.toBe(teamOf.sam2);
      const placed = namesakes().map((p) => ({ ...p, team_id: teamOf[p.id] }));
      expect(buddyStats(placed, { buddyRule: rule })).toEqual({ requested: 0, satisfied: 0 });
    });

    it(`two players of one name: the one who names the requester back is paired (${rule})`, () => {
      // sam1, listed first, names Ada: reciprocity settles the tie, and the pair is mutual
      // under either rule. (A last-listed-wins name index would pick sam2.)
      const players = namesakes({
        sam1: { buddy_request: 'Ada One', rating: 3 },
        sam2: { rating: 4 },
      });
      const teamOf = assign(players, rule);
      expect(teamOf.ada).toBe(teamOf.sam1);
      expect(teamOf.ada).not.toBe(teamOf.sam2);
      const placed = players.map((p) => ({ ...p, team_id: teamOf[p.id] }));
      expect(buddyStats(placed, { buddyRule: rule })).toEqual({ requested: 2, satisfied: 2 });
    });
  }

  // Bea names Cal; Cal names nobody. Cal is rated higher, so is dealt first.
  const oneWay = () => [
    player('cal', { first_name: 'Cal', last_name: 'Three', rating: 5 }),
    player('dee', { rating: 4 }),
    player('bea', { first_name: 'Bea', last_name: 'Two', buddy_request: 'Cal Three', rating: 3 }),
    player('eve', { rating: 1 }),
  ];

  it('mutual (the default): a one-way request is not honoured or counted', () => {
    for (const teamOf of [assign(oneWay(), 'mutual'), assign(oneWay(), undefined)]) {
      expect(teamOf.bea).not.toBe(teamOf.cal);
    }
    const placed = oneWay().map((p) => ({ ...p, team_id: 't1' }));
    expect(buddyStats(placed)).toEqual({ requested: 0, satisfied: 0 });
    expect(buddyStats(placed, { buddyRule: 'mutual' })).toEqual({ requested: 0, satisfied: 0 });
  });

  it('one_way_best_effort: honoured best effort when the named player listed no buddy', () => {
    // The named player is dealt first; the requester is steered to their team.
    const teamOf = assign(oneWay(), 'one_way_best_effort');
    expect(teamOf.bea).toBe(teamOf.cal);
    // The requester dealt first: the named player is steered to the requester's team.
    const reversed = oneWay().map((p) =>
      p.id === 'bea' ? { ...p, rating: 5 } : p.id === 'cal' ? { ...p, rating: 3 } : p
    );
    const teamOfReversed = assign(reversed, 'one_way_best_effort');
    expect(teamOfReversed.cal).toBe(teamOfReversed.bea);
    const placed = oneWay().map((p) => ({ ...p, team_id: teamOf[p.id] }));
    expect(buddyStats(placed, { buddyRule: 'one_way_best_effort' })).toEqual({
      requested: 1,
      satisfied: 1,
    });
    // A name in another form still resolves: accents, case and "Last, First".
    const accented = oneWay().map((p) =>
      p.id === 'cal'
        ? { ...p, first_name: 'Zoë', last_name: 'Müller' }
        : p.id === 'bea'
          ? { ...p, buddy_request: 'MULLER, zoe' }
          : p
    );
    const teamOfAccented = assign(accented, 'one_way_best_effort');
    expect(teamOfAccented.bea).toBe(teamOfAccented.cal);
  });

  it('one_way_best_effort: never a unit, so the coach spread can part the two', () => {
    // Both volunteer to coach: spread one per team, the one-way request gives way. The
    // requester is listed first, so a request that formed a unit would hold them together.
    const players = oneWay()
      .map((p) => (p.id === 'bea' || p.id === 'cal' ? { ...p, willing_to_coach: true } : p))
      .sort((a, b) => (a.id === 'bea' ? -1 : b.id === 'bea' ? 1 : 0));
    const teamOf = assign(players, 'one_way_best_effort', { respectCoach: true });
    expect(teamOf.bea).not.toBe(teamOf.cal);
  });

  it('one_way_best_effort: not honoured when the named player listed another buddy', () => {
    // Bea names Cal; Cal names Eve (one-way too, and Eve listed nobody, so it is honoured).
    const players = oneWay().map((p) => (p.id === 'cal' ? { ...p, buddy_request: 'Eve Four' } : p));
    const eve = players.find((p) => p.id === 'eve');
    Object.assign(eve, { first_name: 'Eve', last_name: 'Four' });
    const teamOf = assign(players, 'one_way_best_effort');
    expect(teamOf.cal).toBe(teamOf.eve);
    expect(teamOf.bea).not.toBe(teamOf.cal);
    const placed = players.map((p) => ({ ...p, team_id: teamOf[p.id] }));
    expect(buddyStats(placed, { buddyRule: 'one_way_best_effort' })).toEqual({
      requested: 1,
      satisfied: 1,
    });
  });

  it('buddy codes pair as Team Analysis pairs them, grouped across the roster', () => {
    const board = oneWay().map((p) => {
      const { buddy_request: _ignored, ...rest } = p;
      return { ...rest, division: 'U10', team_id: 't1' };
    });
    const coded = board.map((p) =>
      p.id === 'dee'
        ? { ...p, mutual_buddy_code: 'K9' }
        : p.id === 'eve'
          ? { ...p, mutual_buddy_code: 'k9' }
          : p
    );
    for (const rule of RULES) {
      // Two board players share a code (case ignored): a mutual pair under either rule.
      expect(buddyStats(coded, { buddyRule: rule })).toEqual({ requested: 2, satisfied: 2 });
      const teamOf = assign(
        coded.map((p) => (p.id === 'dee' ? { ...p, rating: 5 } : p)),
        rule
      );
      expect(teamOf.dee).toBe(teamOf.eve);
    }
    // A third holder in another division: the code pairs nobody (`cross-division-buddy`
    // and `duplicate-buddy-code` in the pipeline), so the board does not pair it either.
    const roster = [...coded, player('far', { division: 'U12', mutual_buddy_code: 'K9' })];
    expect(buddyStats(coded, { roster })).toEqual({ requested: 0, satisfied: 0 });
  });

  it("one_way_best_effort: many requests naming one player do not pile onto that player's team", () => {
    // Six players name Cal, who listed nobody: every request is honoured, but steering them
    // all to Cal's team would make it 7 against 3.
    const players = [
      player('cal', { first_name: 'Cal', last_name: 'Three' }),
      ...Array.from({ length: 6 }, (_, i) =>
        player(`r${i}`, {
          first_name: `Req${'abcdef'[i]}`,
          last_name: 'Kid',
          buddy_request: 'Cal Three',
        })
      ),
      ...Array.from({ length: 3 }, (_, i) => player(`o${i}`)),
    ];
    const teamOf = assign(players, 'one_way_best_effort', { signalKind: 'size' });
    const sizes = Object.values(teamOf).reduce(
      (acc, team) => ({ ...acc, [team]: (acc[team] || 0) + 1 }),
      {}
    );
    expect(Math.abs(sizes.t1 - sizes.t2)).toBeLessThanOrEqual(1);
    // Still best effort: some requesters are with Cal.
    const withCal = players.filter((p) => p.id.startsWith('r') && teamOf[p.id] === teamOf.cal);
    expect(withCal.length).toBeGreaterThan(0);
    expect(boardBuddyLinks(players, { buddyRule: 'one_way_best_effort' }).oneWay.size).toBe(6);
  });

  it("one_way_best_effort: steers when the named player's team is no larger than the deal's pick", () => {
    // Before Bea is dealt: t1 holds Big alone (total 10), t2 Cal and Sid (6), t3 Pia and Quin
    // (5). The deal picks t3; Cal's t2 holds no more players, so Bea joins Cal there, though
    // t1 is the smallest team.
    const players = [
      player('big', { rating: 10 }),
      player('cal', { first_name: 'Cal', last_name: 'Three', rating: 4 }),
      player('pia', { rating: 3 }),
      player('quin', { rating: 2 }),
      player('sid', { rating: 2 }),
      player('bea', { first_name: 'Bea', last_name: 'Two', buddy_request: 'Cal Three', rating: 1 }),
    ];
    const teams = [{ id: 't1' }, { id: 't2' }, { id: 't3' }];
    expect(assign(players, 'mutual', { teams }).bea).toBe('t3');
    const teamOf = assign(players, 'one_way_best_effort', { teams });
    expect(teamOf.cal).toBe('t2');
    expect(teamOf.bea).toBe('t2');
  });

  it('finds the same buddies as the Team Analysis pipeline', () => {
    // Every board above, under both rules, and boards whose roster reaches beyond them: the
    // mutual pairs are the pipeline's reciprocal buddyIds, and the honoured one-way requests
    // are its honoured one-way outcomes.
    const u10 = (board) => board.map((p) => ({ ...p, division: 'U10' }));
    const cases = [
      namesakes(),
      namesakes({ sam1: { buddy_request: 'Ada One' } }),
      oneWay(),
      oneWay()
        .map((p) => (p.id === 'cal' ? { ...p, buddy_request: 'Eve Four' } : p))
        .map((p) => (p.id === 'eve' ? { ...p, first_name: 'Eve', last_name: 'Four' } : p)),
      oneWay().map((p) =>
        p.id === 'bea' || p.id === 'eve' ? { ...p, mutual_buddy_code: 'Q7' } : p
      ),
      oneWay().map((p) =>
        p.id === 'dee'
          ? { ...p, mutual_buddy_code: 'K9', buddy_request: 'Bea Two' }
          : p.id === 'eve'
            ? { ...p, mutual_buddy_code: 'k9' }
            : p
      ),
    ].map((board) => ({ board: u10(board), extra: [] }));
    const coded = u10(oneWay()).map((p) =>
      p.id === 'dee' || p.id === 'eve' ? { ...p, mutual_buddy_code: 'Z1' } : p
    );
    cases.push(
      // Two board players and a U12 player share a code: three holders, no pair.
      { board: coded, extra: [player('far', { division: 'U12', mutual_buddy_code: 'z1' })] },
      // One board player and a U12 player share a code: cross-division, no pair.
      {
        board: u10(oneWay()).map((p) => (p.id === 'dee' ? { ...p, mutual_buddy_code: 'Z2' } : p)),
        extra: [player('far', { division: 'U12', mutual_buddy_code: 'Z2' })],
      },
      // A request naming a U12 player (cross-division), and one naming a U10 player who is
      // not on the board (a waitlisted player, say): not found.
      {
        board: u10(oneWay()).map((p) => (p.id === 'bea' ? { ...p, buddy_request: 'Gil Far' } : p)),
        extra: [player('gil', { first_name: 'Gil', last_name: 'Far', division: 'U12' })],
      },
      {
        board: u10(oneWay()).map((p) => (p.id === 'bea' ? { ...p, buddy_request: 'Hal Off' } : p)),
        extra: [player('hal', { first_name: 'Hal', last_name: 'Off', division: 'U10' })],
      }
    );
    const sorted = (map) => [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
    const compared = { mutual: 0, oneWay: 0 };
    const statuses = new Set();
    const codeDiagnostics = new Set();
    for (const { board, extra } of cases) {
      const roster = extra.length > 0 ? [...board, ...extra] : undefined;
      for (const buddyRule of RULES) {
        const prepared = prepareTeamingInput({
          players: board,
          roster,
          buddyRule,
          seasonYear: 2026,
        });
        const byId = new Map(prepared.players.map((p) => [String(p.id), p]));
        const mutual = new Map();
        for (const [id, p] of byId) {
          const buddyId = p.buddyId === undefined ? undefined : String(p.buddyId);
          if (buddyId && String(byId.get(buddyId)?.buddyId) === id) mutual.set(id, buddyId);
        }
        const oneWayLinks = new Map(
          prepared.diagnostics.buddyRequests
            .filter((outcome) => outcome.outcome === 'one-way' && outcome.honoured)
            .map((outcome) => [outcome.playerId, String(outcome.targetId)])
        );
        const links = boardBuddyLinks(board, { roster, buddyRule });
        expect(sorted(links.mutual)).toEqual(sorted(mutual));
        expect(sorted(links.oneWay)).toEqual(sorted(oneWayLinks));
        compared.mutual += mutual.size;
        compared.oneWay += oneWayLinks.size;
        prepared.diagnostics.buddyRequests.forEach((r) => statuses.add(r.status));
        prepared.diagnostics.buddyLinking.forEach((d) => codeDiagnostics.add(d.code));
      }
    }
    // The comparison examined links of both kinds, and the off-board paths, not only empty maps.
    expect(compared.mutual).toBeGreaterThan(0);
    expect(compared.oneWay).toBeGreaterThan(0);
    for (const status of ['ambiguous', 'cross-division', 'not-found']) {
      expect(statuses).toContain(status);
    }
    expect(codeDiagnostics).toContain('duplicate-buddy-code');
    expect(codeDiagnostics).toContain('cross-division-buddy');
  });

  it('one_way_best_effort: a requester a buddy code pairs keeps the code pair', () => {
    // Bea names Cal (who listed nobody), but a code pairs Bea with Eve: one buddy per player,
    // so the code pair holds and the one-way request is not honoured, as in the pipeline.
    const players = oneWay().map((p) =>
      p.id === 'bea' || p.id === 'eve' ? { ...p, mutual_buddy_code: 'Q7' } : p
    );
    const teamOf = assign(players, 'one_way_best_effort');
    expect(teamOf.bea).toBe(teamOf.eve);
    expect(teamOf.bea).not.toBe(teamOf.cal);
    const placed = players.map((p) => ({ ...p, team_id: teamOf[p.id] }));
    expect(buddyStats(placed, { buddyRule: 'one_way_best_effort' })).toEqual({
      requested: 2,
      satisfied: 2,
    });
  });
});

describe('coedTransition', () => {
  const divisions = [
    { id: 'd-u8b', name: 'U8B', gender_policy: 'boys' },
    { id: 'd-u8g', name: 'U8G', gender_policy: 'girls' },
    { id: 'd-u10', name: 'U10 Coed', gender_policy: 'coed' },
  ];

  it('plans a co-ed merge per age group with summed team counts', () => {
    const players = [
      player('p1', { division_id: 'd-u8b' }),
      player('p2', { division_id: 'd-u8b' }),
      player('p3', { division_id: 'd-u8g', gender: 'f' }),
    ];
    const teams = [
      { id: 't1', division_id: 'd-u8b' },
      { id: 't2', division_id: 'd-u8g' },
    ];
    const { merges } = planCoedMerge({ divisions, players, teams });
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({
      age: 8,
      divisionUpsert: { name: 'U8', gender_policy: 'coed' },
      teamCount: 2,
    });
    expect(merges[0].sourceDivisionIds.sort()).toEqual(['d-u8b', 'd-u8g']);
    expect(merges[0].playerIds.sort()).toEqual(['p1', 'p2', 'p3']);
  });

  it('plans a gender split with proportional teams and each gender ≥ 1', () => {
    const players = [
      ...Array.from({ length: 9 }, (_, i) => player(`b${i}`, { division_id: 'd-u10' })),
      ...Array.from({ length: 3 }, (_, i) =>
        player(`g${i}`, { division_id: 'd-u10', gender: 'f' })
      ),
    ];
    const teams = [
      { id: 't1', division_id: 'd-u10' },
      { id: 't2', division_id: 'd-u10' },
      { id: 't3', division_id: 'd-u10' },
    ];
    const { splits } = planGenderSplit({ divisions, players, teams });
    expect(splits).toHaveLength(1);
    const [split] = splits;
    expect(split.sourceDivisionId).toBe('d-u10');
    const boys = split.targets.find((t) => t.divisionUpsert.gender_policy === 'boys');
    const girls = split.targets.find((t) => t.divisionUpsert.gender_policy === 'girls');
    expect(boys.divisionUpsert.name).toBe('U10B');
    expect(girls.divisionUpsert.name).toBe('U10G');
    expect(boys.playerIds).toHaveLength(9);
    expect(girls.playerIds).toHaveLength(3);
    // 3 teams, 75%/25% headcount → 2 + 1 with each gender ≥ 1
    expect(boys.teamCount).toBe(2);
    expect(girls.teamCount).toBe(1);
    expect(boys.teamCount + girls.teamCount).toBe(3);
  });

  it('gives each gender at least one team even when the source had a single team', () => {
    const players = [
      ...Array.from({ length: 12 }, (_, i) => player(`b${i}`, { division_id: 'd-u10' })),
      ...Array.from({ length: 2 }, (_, i) =>
        player(`g${i}`, { division_id: 'd-u10', gender: 'f' })
      ),
    ];
    const teams = [{ id: 't1', division_id: 'd-u10' }];
    const { splits } = planGenderSplit({ divisions, players, teams });
    const boys = splits[0].targets.find((t) => t.divisionUpsert.gender_policy === 'boys');
    const girls = splits[0].targets.find((t) => t.divisionUpsert.gender_policy === 'girls');
    expect(boys.teamCount).toBeGreaterThanOrEqual(1);
    expect(girls.teamCount).toBeGreaterThanOrEqual(1);
  });

  it('keeps preferred-name buddy requests together in serpentineAssign', () => {
    const players = [
      player('a', {
        first_name: 'Samantha',
        last_name: 'Brown',
        preferred_name: 'Sam',
        buddy_request: 'Kim Cho',
        rating: 5,
      }),
      // Rated so that, dealt apart, a and b would land on different teams.
      player('b', { first_name: 'Kim', last_name: 'Cho', buddy_request: 'Sam Brown', rating: 4 }),
      player('c', { rating: 3 }),
      player('d', { rating: 1 }),
    ];
    const assignments = serpentineAssign({
      players,
      teams: [{ id: 't1' }, { id: 't2' }],
      signalKind: 'rating',
      respectBuddies: true,
      respectCoach: false,
    });
    const teamOf = Object.fromEntries(assignments.map((x) => [x.playerId, x.teamId]));
    expect(teamOf.a).toBe(teamOf.b);
  });

  it('skips age groups that are already co-ed only', () => {
    const { merges } = planCoedMerge({
      divisions: [{ id: 'd-u10', name: 'U10 Coed' }],
      players: [],
      teams: [],
    });
    expect(merges).toEqual([]);
  });

  it('normalizes raw imported gender text', () => {
    expect(normalizeGender('Male')).toBe('m');
    expect(normalizeGender('M')).toBe('m');
    expect(normalizeGender('boy')).toBe('m');
    expect(normalizeGender('Female')).toBe('f');
    expect(normalizeGender('F')).toBe('f');
    expect(normalizeGender('Girl')).toBe('f');
    expect(normalizeGender('')).toBe(null);
    expect(normalizeGender(null)).toBe(null);
    expect(normalizeGender('x')).toBe(null);
  });

  it('splits divisions whose players carry raw imported gender values', () => {
    const divisions = [{ id: 'd-u10', name: 'U10', gender_policy: 'coed' }];
    const players = [
      player('b1', { division_id: 'd-u10', gender: 'Male' }),
      player('b2', { division_id: 'd-u10', gender: 'Boy' }),
      player('g1', { division_id: 'd-u10', gender: 'Female' }),
      player('g2', { division_id: 'd-u10', gender: 'GIRL' }),
    ];
    const { splits } = planGenderSplit({ divisions, players, teams: [] });
    expect(splits).toHaveLength(1);
    const boys = splits[0].targets.find((t) => t.divisionUpsert.gender_policy === 'boys');
    const girls = splits[0].targets.find((t) => t.divisionUpsert.gender_policy === 'girls');
    expect(boys.playerIds.sort()).toEqual(['b1', 'b2']);
    expect(girls.playerIds.sort()).toEqual(['g1', 'g2']);
  });
});
