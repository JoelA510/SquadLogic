import { describe, expect, it } from 'vitest';
import { applyRosterDirectory, countUnnamedPlayers } from '../frontend/src/utils/rosterPeople.js';
import { coachLabel } from '../frontend/src/utils/teamCoaches.js';
import { movePlayerToTeam, reorderWithinTeam } from '../frontend/src/utils/rosterMoves.js';

const directory = (players = [], coaches = []) => ({
  players: new Map(players),
  coaches: new Map(coaches),
});

const team = (over = {}) => ({
  id: 't1',
  name: 'U4A',
  division: 'U4',
  coachId: 'c1',
  assistantCoachIds: ['c2'],
  players: [
    { id: 'p1', name: 'Unknown Player', skill: undefined },
    { id: 'p2', name: 'Unknown Player', skill: undefined },
  ],
  ...over,
});

describe('applyRosterDirectory', () => {
  it('names players and coaches from the directory (the demo league: ids only)', () => {
    const [result] = applyRosterDirectory(
      [team()],
      directory(
        [
          ['p1', { name: 'Avery Alder', rating: 3 }],
          ['p2', { name: 'Blake Birch', rating: null }],
        ],
        [
          ['c1', 'Coach Elm'],
          ['c2', 'Coach Fern'],
        ]
      )
    );
    expect(result.players.map((p) => p.name)).toEqual(['Avery Alder', 'Blake Birch']);
    // A rating is the skill when the run carries none; with none, the row stays unrated.
    expect(result.players.map((p) => p.skill)).toEqual(['3', undefined]);
    // It also travels as `rating`, and the skill it filled is marked as a rating, not a tier.
    expect(result.players.map((p) => p.rating)).toEqual([3, undefined]);
    expect(result.players.map((p) => p.skillIsRating)).toEqual([true, undefined]);
    expect(coachLabel(result)).toBe('Coaches: Coach Elm, Coach Fern');
  });

  it('a skill the run carries is kept and is not marked as a rating, whatever the record rates', () => {
    const [result] = applyRosterDirectory(
      [team({ players: [{ id: 'p1', name: 'A B', skill: 'advanced' }] })],
      directory([['p1', { name: 'A B', rating: 2 }]])
    );
    expect(result.players[0]).toMatchObject({ skill: 'advanced', rating: 2 });
    expect(result.players[0].skillIsRating).toBeUndefined();
  });

  // Codex, P2 on #684: with the Skill Tier option on the record's tier is the entry's skill, with the
  // generator's contract (`withDurableIdentity`): a stored tier wins over the file's, a null or blank
  // one keeps the file's. With the option off nothing of the tier is read into the entry.
  describe('the stored skill tier', () => {
    const entry = (over = {}) => ({ id: 'p1', name: 'A B', skill: 'novice', ...over });
    const run = (player, known, options) =>
      applyRosterDirectory(
        [team({ players: [player] })],
        directory([['p1', { name: 'A B', rating: null, ...known }]]),
        options
      )[0].players[0];

    it("wins over the file's tier when the option is on", () => {
      expect(run(entry(), { skillTier: 'advanced' }, { skillTier: true }).skill).toBe('advanced');
    });

    it('wins over a persisted skill number, and over a rating filled in as the skill', () => {
      expect(run(entry({ skill: 5 }), { skillTier: 'novice' }, { skillTier: true }).skill).toBe(
        'novice'
      );
      const filled = run(
        entry({ skill: undefined }),
        { rating: 3, skillTier: 'developing' },
        {
          skillTier: true,
        }
      );
      expect(filled.skill).toBe('developing');
      expect(filled.skillIsRating).toBeUndefined();
    });

    it("a null or blank stored tier keeps the file's", () => {
      expect(run(entry(), { skillTier: null }, { skillTier: true }).skill).toBe('novice');
      expect(run(entry(), { skillTier: '' }, { skillTier: true }).skill).toBe('novice');
      expect(run(entry(), { skillTier: 'platinum' }, { skillTier: true }).skill).toBe('novice');
    });

    it('is not read into the entry at all when the option is off (the default)', () => {
      expect(run(entry(), { skillTier: 'advanced' }, { skillTier: false }).skill).toBe('novice');
      expect(run(entry(), { skillTier: 'advanced' }).skill).toBe('novice');
    });

    it('returns the same objects when the tier changes nothing', () => {
      const teams = [team({ players: [entry({ skill: 'advanced' })] })];
      const dir = directory([['p1', { name: 'A B', rating: null, skillTier: 'advanced' }]]);
      const once = applyRosterDirectory(teams, dir, { skillTier: true });
      expect(applyRosterDirectory(once, dir, { skillTier: true })).toBe(once);
    });
  });

  it('POSITIVE CONTROL: the same team without the directory reads as the owner saw it', () => {
    const [result] = applyRosterDirectory([team()], directory());
    expect(result.players[0].name).toBe('Unknown Player');
    expect(coachLabel(result)).toBe('Coaches: 2 on file, 2 names not loaded');
  });

  it('the durable name wins over an import name, and an unknown id keeps what it had', () => {
    const [result] = applyRosterDirectory(
      [
        team({
          players: [
            { id: 'p1', name: 'Old Name' },
            { id: 'p9', name: 'Kept Name' },
          ],
        }),
      ],
      directory([['p1', { name: 'New Name', rating: null }]])
    );
    expect(result.players.map((p) => p.name)).toEqual(['New Name', 'Kept Name']);
  });

  it('returns the same objects when nothing changes (memoised rows are not redrawn)', () => {
    const teams = [team()];
    expect(applyRosterDirectory(teams, directory())).toBe(teams);
    const once = applyRosterDirectory(teams, directory([['p1', { name: 'A B', rating: null }]]));
    const twice = applyRosterDirectory(once, directory([['p1', { name: 'A B', rating: null }]]));
    expect(twice).toBe(once);
  });

  it('counts roster entries no player record answers for', () => {
    const [result] = applyRosterDirectory(
      [team()],
      directory([['p1', { name: 'Avery Alder', rating: null }]])
    );
    expect(countUnnamedPlayers([result])).toBe(1);
  });
});

describe('movePlayerToTeam', () => {
  const teams = [
    { id: 'a', name: 'A', players: [{ id: 'p1' }, { id: 'p2' }] },
    { id: 'b', name: 'B', players: [{ id: 'p3' }] },
    { id: 'c', name: 'C', players: [] },
  ];

  it('moves a player, marks it manual, and leaves other teams untouched', () => {
    const next = movePlayerToTeam(teams, 'p1', 'b');
    expect(next[0].players.map((p) => p.id)).toEqual(['p2']);
    expect(next[1].players.map((p) => [p.id, p.assignment_source])).toEqual([
      ['p3', undefined],
      ['p1', 'manual'],
    ]);
    expect(next[2]).toBe(teams[2]);
    // The input is not mutated.
    expect(teams[0].players).toHaveLength(2);
  });

  it('a move to the same team, an unknown team or an unknown player is no change', () => {
    expect(movePlayerToTeam(teams, 'p1', 'a')).toBe(teams);
    expect(movePlayerToTeam(teams, 'p1', 'zzz')).toBe(teams);
    expect(movePlayerToTeam(teams, 'nobody', 'b')).toBe(teams);
  });

  it('reorders within a team', () => {
    const next = reorderWithinTeam(teams, 'a', 0, 1);
    expect(next[0].players.map((p) => p.id)).toEqual(['p2', 'p1']);
    expect(reorderWithinTeam(teams, 'a', 0, 0)).toBe(teams);
  });
});
