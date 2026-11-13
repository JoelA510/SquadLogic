/** `rekeyReview` (F11-3 review R1): the staged review matched again after a 409 GAME_IDENTITY. */
import { describe, expect, it } from 'vitest';
import { rekeyReview } from '../frontend/src/utils/gameReviewRekey.js';

const g = (id, home, away, week, persisted = true, slot = `s-${week}`) => ({
  id,
  persisted,
  homeTeamId: home,
  awayTeamId: away,
  weekIndex: week,
  gameSlotId: slot,
});

describe('rekeyReview', () => {
  it('keeps an id that still exists, and a new game stays new', () => {
    const saved = [g('a', 't1', 't2', 1)];
    const review = [g('a', 't1', 't2', 2), g('review-x', 't3', 't4', 1, false)];
    const { review: next, changed } = rekeyReview(review, saved);
    expect(changed).toBe(false);
    expect(next.map((x) => [x.id, x.persisted])).toEqual([
      ['a', true],
      ['review-x', false],
    ]);
  });

  it('a vanished id is matched to the saved game of its pair, or becomes a new game', () => {
    const saved = [g('b', 't2', 't1', 1)]; // the pair is now saved as b (a was replaced elsewhere)
    const review = [g('a', 't1', 't2', 1), g('c', 't5', 't6', 1)];
    const { review: next, changed } = rekeyReview(review, saved);
    expect(changed).toBe(true);
    expect(next[0]).toMatchObject({ id: 'b', persisted: true });
    expect(next[1].persisted).toBe(false);
    expect(next[1].id).not.toBe('c');
  });

  it('no saved game is claimed twice', () => {
    const saved = [g('b', 't1', 't2', 1)];
    const review = [g('b', 't1', 't2', 1), g('gone', 't1', 't2', 2)];
    const { review: next } = rekeyReview(review, saved);
    expect(next.filter((x) => x.id === 'b')).toHaveLength(1);
    expect(next[1].persisted).toBe(false);
  });
});
