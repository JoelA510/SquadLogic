/**
 * The oracle of the game save's omission check (`tests/helpers/publishedOmissions.js`; moved out of core by F11-3 task
 * C7): its cases, as they were in `tests/gamePublished.test.js`.
 */
import { describe, expect, it } from 'vitest';
import { publishedOmissions } from './helpers/publishedOmissions.js';

describe('publishedOmissions', () => {
  const game = (id, home, away, slot, week, published = false) => ({
    id,
    home_team_id: home,
    away_team_id: away,
    game_slot_id: slot,
    week_index: week,
    published,
  });
  const saved = [
    game('g3', 'h3', 'a3', 's3', 1, true),
    game('g1', 'h1', 'a1', 's1', 1, true),
    game('g2', 'h2', 'a2', 's2', 1, false),
  ];

  it('lists the Published games the payload does not carry, in id order', () => {
    expect(publishedOmissions(saved, []).map((row) => row.id)).toEqual(['g1', 'g3']);
    expect(
      publishedOmissions(saved, [
        { home_team_id: 'h1', away_team_id: 'a1', game_slot_id: 's1', week_index: 1 },
      ]).map((row) => row.id)
    ).toEqual(['g3']);
  });

  it('a game named by its id is carried wherever it is sent (20261120010000); one named only elsewhere is not', () => {
    // g1 is sent by id to another slot and week: present (the guard then judges the move, as the database does).
    const byId = [
      { id: 'g1', home_team_id: 'h1', away_team_id: 'a1', game_slot_id: 'sX', week_index: 9 },
    ];
    expect(publishedOmissions(saved, byId).map((row) => row.id)).toEqual(['g3']);
    // The same place without the id is another tuple: g1 is still omitted.
    const byPlaceOnly = [
      { home_team_id: 'h1', away_team_id: 'a1', game_slot_id: 'sX', week_index: 9 },
    ];
    expect(publishedOmissions(saved, byPlaceOnly).map((row) => row.id)).toEqual(['g1', 'g3']);
    // An id compares without regard to case, as a uuid does; an empty or non-string id carries nothing.
    expect(
      publishedOmissions(saved, [{ id: 'G1' }, { id: '' }, { id: 7 }]).map((row) => row.id)
    ).toEqual(['g3']);
  });

  it('an unpublished game left out is not an omission', () => {
    const carried = [saved[0], saved[1]].map((row) => ({ ...row }));
    expect(publishedOmissions(saved, carried)).toEqual([]);
  });

  it('reads the payload in either spelling, and a slot under its other name', () => {
    expect(
      publishedOmissions(saved, [
        { homeTeamId: 'h1', awayTeamId: 'a1', gameSlotId: 's1', weekIndex: 1 },
        { home_team_id: 'H3', away_team_id: 'A3', slot_id: 's3', week_index: 1 },
      ])
    ).toEqual([]);
  });

  it('a game moved to another slot or week is another key, so the original is omitted', () => {
    const moved = [
      { home_team_id: 'h1', away_team_id: 'a1', game_slot_id: 's9', week_index: 1 },
      { home_team_id: 'h3', away_team_id: 'a3', game_slot_id: 's3', week_index: 2 },
    ];
    expect(publishedOmissions(saved, moved).map((row) => row.id)).toEqual(['g1', 'g3']);
  });

  it('a Published game whose key is incomplete is not an omission: no save can carry it, as in the database', () => {
    // The database excludes such a game from the check (a NULL part matches nothing, so every season-less save
    // would be refused for it for good); the guard trigger still holds it in place.
    const broken = [{ ...game('g9', 'h9', 'a9', null, 1, true) }];
    expect(publishedOmissions(broken, [])).toEqual([]);
    expect(
      publishedOmissions(broken, [
        { home_team_id: 'h9', away_team_id: 'a9', game_slot_id: null, week_index: 1 },
      ])
    ).toEqual([]);
    // Beside a complete one, only the complete one is listed.
    expect(publishedOmissions([...broken, ...saved], []).map((row) => row.id)).toEqual([
      'g1',
      'g3',
    ]);
  });

  it('nothing Published, or nothing saved, is nothing omitted', () => {
    expect(publishedOmissions([game('g', 'h', 'a', 's', 1, false)], [])).toEqual([]);
    expect(publishedOmissions([], [])).toEqual([]);
    expect(publishedOmissions(undefined, undefined)).toEqual([]);
  });
});
