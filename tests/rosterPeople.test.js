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
    expect(coachLabel(result)).toBe('Coaches: Coach Elm, Coach Fern');
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
