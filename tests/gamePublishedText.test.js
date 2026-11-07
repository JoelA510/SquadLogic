/**
 * PR 3 of the schedule expansion (docs/changes/2026-11-03-schedule-expansion.md, 3.3, 3.4 and 3.6): the sentences the
 * Games page says about the Published switch, held to the words the owner chose ("Published", "Allow changes") and to
 * what is TRUE of identity: the save keys a game on (home, away, slot, week) and writes no id, so a game moved to
 * another slot or week is a new record that starts not Published (lesson 95). No sentence here promises that a flag, a
 * date or a history follows a move.
 */
import { describe, expect, it } from 'vitest';
import {
  NOTE_HELPER_TEXT,
  PUBLISHED_OUTCOME_UNKNOWN,
  cancelRefusal,
  describeBulkCount,
  describeHistoryRow,
  describeMarkFailure,
  describeSetFailure,
  describeStaleCheckFailure,
  describeStaleSchedule,
  describeSetResult,
  matchupOf,
  moveRefusal,
  movedGameNote,
  movedGamesNote,
  reasonLabel,
  stagedMoveNote,
} from '../frontend/src/utils/gamePublishedText.js';
import { movedHistoryGames } from '../frontend/src/utils/gamePublishedScope.js';
import { GAME_PUBLISH_REASONS } from '../packages/core/src/gamePublished.js';

const when = (value) => `at ${value}`;

describe('the words', () => {
  it('the note’s helper text is the owner’s, verbatim', () => {
    expect(NOTE_HELPER_TEXT).toBe(
      'Optional. Do not enter player names or other personal information.'
    );
  });

  it('names a matchup by team names, else ids', () => {
    expect(
      matchupOf({ homeTeamName: 'A', awayTeamName: 'B', homeTeamId: 'x', awayTeamId: 'y' })
    ).toEqual({
      home: 'A',
      away: 'B',
    });
    expect(matchupOf({ homeTeamId: 'x', awayTeamId: 'y' })).toEqual({ home: 'x', away: 'y' });
    expect(matchupOf({ home_team_id: 'x', away_team_id: 'y' })).toEqual({ home: 'x', away: 'y' });
    expect(matchupOf(null)).toEqual({ home: 'Home', away: 'Away' });
  });

  it('every reason has a label, and an unknown code is shown as it came', () => {
    for (const reason of GAME_PUBLISH_REASONS) expect(reasonLabel(reason.code)).toBe(reason.label);
    expect(reasonLabel('something-else')).toBe('something-else');
    expect(reasonLabel(null)).toBe('');
  });

  it('refuses a move and a cancel of a Published game in the same words, naming "Allow changes"', () => {
    const g = { homeTeamName: 'A', awayTeamName: 'B' };
    expect(moveRefusal(g)).toBe(
      'A vs B was not moved: it is Published. Use Allow changes on it first.'
    );
    expect(cancelRefusal(g)).toBe(
      'A vs B was not cancelled: it is Published. Use Allow changes on it first, then cancel it.'
    );
    for (const sentence of [moveRefusal(g), cancelRefusal(g)]) {
      expect(sentence).not.toMatch(/\block|override|unlock/i);
    }
  });
});

describe('a moved game is a new record, and nothing promises otherwise', () => {
  it('says it once in the dialog: saved as a new game, starts not Published, history stays with the old record', () => {
    expect(movedGameNote).toMatch(/saved as a new game/);
    expect(movedGameNote).toMatch(/starts not Published/);
    expect(movedGameNote).toMatch(/publish it again/);
    expect(movedGameNote).toMatch(/history stays with the old record/);
  });

  it('says it when a move of a game with a history is staged, and when the schedule is applied', () => {
    expect(stagedMoveNote({ homeTeamName: 'A', awayTeamName: 'B' })).toBe(
      'Manual game move staged. Apply the schedule to persist it. A vs B will be saved as a new game, which starts not Published.'
    );
    expect(movedGamesNote(1)).toBe(
      ' 1 moved game was saved as a new game: it starts not Published, so publish it again.'
    );
    expect(movedGamesNote(3)).toBe(
      ' 3 moved games were saved as new games: they start not Published, so publish them again.'
    );
  });

  it('no sentence says a flag, a date or a history survives, or follows, a move', () => {
    const all = [
      movedGameNote,
      stagedMoveNote({ homeTeamName: 'A', awayTeamName: 'B' }),
      movedGamesNote(1),
      movedGamesNote(2),
      moveRefusal({}),
      cancelRefusal({}),
    ].join(' ');
    expect(all).not.toMatch(
      /stays? Published|remains? Published|keeps? (its|the) (history|flag)|follows/i
    );
  });
});

describe('which saved games a staged schedule leaves behind (their history stays with the old record)', () => {
  const saved = (id, extra = {}) => ({
    id,
    homeTeamId: 'h',
    awayTeamId: 'a',
    slotId: `s-${id}`,
    weekIndex: 1,
    published: false,
    ...extra,
  });
  const HISTORY = { publishedAt: '2026-10-01T00:00:00Z' };

  it('a game with a history whose slot is gone from the staged schedule is left behind', () => {
    const before = [saved('g1', HISTORY), saved('g2', HISTORY), saved('g3')];
    // g1 stays where it was; g2 is moved to another slot; g3 has no history to leave.
    const staged = [
      saved('g1', HISTORY),
      { ...saved('g2', HISTORY), slotId: 's-elsewhere' },
      saved('g3'),
    ];
    expect(movedHistoryGames(staged, before).map((g) => g.id)).toEqual(['g2']);
  });

  it('a week change is a new record too, and the other tuple parts count', () => {
    const before = [saved('g1', HISTORY)];
    expect(movedHistoryGames([{ ...saved('g1', HISTORY), weekIndex: 2 }], before)).toHaveLength(1);
    expect(movedHistoryGames([{ ...saved('g1', HISTORY), homeTeamId: 'z' }], before)).toHaveLength(
      1
    );
  });

  it('a change of field, start or end alone, with the same slot and week, keeps the row: not left behind', () => {
    const before = [saved('g1', { ...HISTORY, fieldId: 'f1', start: '2026-10-03T13:00:00Z' })];
    const staged = [saved('g1', { ...HISTORY, fieldId: 'f2', start: '2026-10-03T14:00:00Z' })];
    expect(movedHistoryGames(staged, before)).toEqual([]);
  });

  it('a Published game the staged schedule still holds is not left behind; one it lacks is', () => {
    const before = [saved('g1', { published: true }), saved('g2', { published: true })];
    expect(movedHistoryGames([saved('g1', { published: true })], before).map((g) => g.id)).toEqual([
      'g2',
    ]);
  });

  it('is judged on the saved side: a regenerated game with a fresh id does not hide the one it replaced', () => {
    const before = [saved('g1', HISTORY)];
    const staged = [{ ...saved('review-1'), slotId: 's-new', persisted: false }];
    expect(movedHistoryGames(staged, before).map((g) => g.id)).toEqual(['g1']);
  });

  it('reads the snake spelling of a row', () => {
    const before = [
      {
        id: 'g1',
        home_team_id: 'h',
        away_team_id: 'a',
        game_slot_id: 's1',
        week_index: 1,
        published_at: 'x',
      },
    ];
    expect(
      movedHistoryGames([{ homeTeamId: 'h', awayTeamId: 'a', slotId: 's1', weekIndex: 1 }], before)
    ).toEqual([]);
    expect(movedHistoryGames([], before)).toHaveLength(1);
  });
});

describe('the answer to a call', () => {
  it('says what changed, and what was already so', () => {
    expect(describeSetResult({ changed: 3, unchanged: 0 }, true)).toBe('Published 3 games.');
    expect(describeSetResult({ changed: 1, unchanged: 2 }, true)).toBe(
      'Published 1 game. 2 were already Published.'
    );
    expect(describeSetResult({ changed: 1, unchanged: 1 }, true)).toBe(
      'Published 1 game. 1 was already Published.'
    );
    expect(describeSetResult({ changed: 2, unchanged: 0 }, false)).toBe(
      'Changes allowed for 2 games.'
    );
    expect(describeSetResult({ changed: 1, unchanged: 1 }, false)).toBe(
      'Changes allowed for 1 game. 1 was not Published.'
    );
  });

  it('a call that changed nothing says so, not "Published 0 games"', () => {
    expect(describeSetResult({ changed: 0, unchanged: 2 }, true)).toBe(
      'Nothing changed. 2 were already Published.'
    );
  });

  it('keeps the database’s words, and says how far a split call got', () => {
    expect(describeSetFailure(new Error('game x does not exist in this organization'))).toBe(
      'game x does not exist in this organization'
    );
    expect(
      describeSetFailure(
        Object.assign(new Error('Access denied'), { done: { calls: 1, of: 2, changed: 2400 } })
      )
    ).toBe(
      'Access denied 1 of 2 calls were saved before it stopped, changing 2400 games; the rest were not changed.'
    );
    expect(
      describeSetFailure(
        Object.assign(new Error('Access denied'), { done: { calls: 0, of: 2, changed: 0 } })
      )
    ).toBe('Access denied');
    expect(describeSetFailure(/** @type {any} */ ({}))).toBe('The change was not saved.');
  });

  it('a lost answer is never described as "the rest were not changed": it is not known', () => {
    const lost = Object.assign(
      new Error('TypeError: Failed to fetch, so it is not known whether the change was saved.'),
      {
        code: PUBLISHED_OUTCOME_UNKNOWN,
        done: { calls: 0, of: 1, changed: 0 },
      }
    );
    expect(describeSetFailure(lost)).toBe(lost.message);
    const lostLater = Object.assign(
      new Error('The request failed, so it is not known whether the change was saved.'),
      {
        code: PUBLISHED_OUTCOME_UNKNOWN,
        done: { calls: 1, of: 2, changed: 2400 },
      }
    );
    expect(describeSetFailure(lostLater)).toBe(
      'The request failed, so it is not known whether the change was saved. 1 of 2 calls were saved before it, changing 2400 games.'
    );
    expect(describeSetFailure(lostLater)).not.toMatch(/were not changed/);
  });

  it('the Exports panel says a refused marking was NOT done, and a lost answer is not known', () => {
    const refused = Object.assign(new Error('Access denied'), {
      done: { calls: 0, of: 1, changed: 0 },
    });
    expect(describeMarkFailure(refused, 3)).toBe(
      'The 3 games were NOT marked Published: Access denied Mark them from the Game Scheduling page.'
    );
    expect(describeMarkFailure(refused, 1)).toBe(
      'The 1 game was NOT marked Published: Access denied Mark it from the Game Scheduling page.'
    );
    const lost = Object.assign(
      new Error('TypeError: Failed to fetch, so it is not known whether the change was saved.'),
      {
        code: PUBLISHED_OUTCOME_UNKNOWN,
        done: { calls: 0, of: 1, changed: 0 },
      }
    );
    const said = describeMarkFailure(lost, 3);
    expect(said).toMatch(/^It is not known whether the 3 games were marked Published/);
    expect(said).toMatch(/Game Scheduling page to see which are Published/);
    expect(said).not.toMatch(/NOT marked/);
  });

  it('a game that is no longer in the saved schedule is said plainly, with nothing published', () => {
    expect(describeStaleSchedule(1, 1)).toBe(
      '1 of the 1 game is no longer in the saved schedule: it was changed after this page read it. Nothing was published. The saved schedule is read again.'
    );
    expect(describeStaleSchedule(2, 40)).toMatch(
      /^2 of the 40 games are no longer in the saved schedule/
    );
    expect(describeStaleCheckFailure(new Error('read refused'))).toBe(
      'The saved schedule could not be read to check these games (read refused), so nothing was published. Try again.'
    );
    expect(describeStaleCheckFailure({})).toMatch(/the read failed/);
  });

  it('counts a bulk call before it is sent, and says when it goes in several', () => {
    expect(describeBulkCount({ eligible: 0, calls: 0, verb: 'Publish' })).toBeNull();
    expect(describeBulkCount({ eligible: 1, calls: 1, verb: 'Publish' })).toBe('Publish 1 game.');
    expect(describeBulkCount({ eligible: 574, calls: 1, verb: 'Publish' })).toBe(
      'Publish 574 games.'
    );
    expect(describeBulkCount({ eligible: 3000, calls: 2, verb: 'Publish' })).toBe(
      'Publish 3000 games, sent in 2 calls of at most 2,400.'
    );
  });
});

describe('a game’s history, as a person reads it', () => {
  const base = { id: 'r1', created_at: '2026-10-05T10:00:00Z', actor_name: 'Synthetic Admin' };

  it('allowing changes shows the reason, the note and how the games were chosen', () => {
    const entry = describeHistoryRow(
      {
        ...base,
        action: 'game.publish_overridden',
        metadata: {
          reason_code: 'coach-request',
          note: 'Asked for a later start',
          scope: { kind: 'division', value: 'U10 Boys' },
        },
      },
      when
    );
    expect(entry).toEqual({
      id: 'r1',
      when: 'at 2026-10-05T10:00:00Z',
      who: 'Synthetic Admin',
      title: 'Changes allowed',
      details: [
        'Reason: Coach request',
        'Note: Asked for a later start',
        'Chosen as: division U10 Boys',
      ],
    });
  });

  it('publishing shows how the games were chosen, and how many were in that call', () => {
    expect(
      describeHistoryRow(
        {
          ...base,
          action: 'game.published_set',
          metadata: { published: true, scope: { kind: 'all' }, count: 4 },
        },
        when
      )
    ).toMatchObject({
      title: 'Published',
      details: ['Chosen as: all saved games', '4 games in that call'],
    });
    expect(
      describeHistoryRow(
        {
          ...base,
          action: 'game.published_set',
          metadata: { published: true, scope: { kind: 'selection' }, count: 1 },
        },
        when
      )
    ).toMatchObject({ details: ['Chosen as: selected games'] });
  });

  it('a call row that turned the flag off is not shown: the game’s own row says the same with its reason', () => {
    expect(
      describeHistoryRow(
        {
          ...base,
          action: 'game.published_set',
          metadata: { published: false, reason_code: 'other' },
        },
        when
      )
    ).toBeNull();
  });

  it('a row with no actor name is "Unknown User", and an unknown action is not shown', () => {
    expect(
      describeHistoryRow(
        {
          ...base,
          actor_name: '',
          action: 'game.publish_overridden',
          metadata: { reason_code: 'other' },
        },
        when
      ).who
    ).toBe('Unknown User');
    expect(
      describeHistoryRow({ ...base, action: 'game.cancelled', metadata: {} }, when)
    ).toBeNull();
  });
});
