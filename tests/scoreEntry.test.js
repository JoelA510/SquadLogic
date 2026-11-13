/** `utils/scoreEntry.js` (F11-3 review R7): a score is a whole number, 0 or more, or empty; anything else is held, in words. */
import { describe, expect, it } from 'vitest';
import { parseScore, scoreRefusalText, typeScore } from '../frontend/src/utils/scoreEntry.js';

describe('parseScore', () => {
  it.each([
    ['', { ok: true, value: null }],
    [null, { ok: true, value: null }],
    ['0', { ok: true, value: 0 }],
    [3, { ok: true, value: 3 }],
    [' 12 ', { ok: true, value: 12 }],
  ])('%j is %j', (input, expected) => expect(parseScore(input)).toEqual(expected));

  it.each([-1, '-1', 2.5, '2.5', 'abc', '1e2', Number.NaN])('%j is not a score', (input) => {
    expect(parseScore(input).ok).toBe(false);
  });
});

describe('typeScore', () => {
  const saved = { score_home: null, score_away: null };
  it('a negative or partial number is held, not sent, and said', () => {
    const typed = typeScore(saved, undefined, 'score_home', -2);
    expect(typed.send).toBe(false);
    expect(typed.invalid).toBe(true);
    const both = typeScore(saved, typed.entry, 'score_away', 1);
    expect(both.send).toBe(false);
  });
  it('CONTROL: two whole numbers are sent', () => {
    const first = typeScore(saved, undefined, 'score_home', 2);
    expect(typeScore(saved, first.entry, 'score_away', '0')).toMatchObject({
      send: true,
      entry: { score_home: 2, score_away: 0 },
    });
  });
});

describe('scoreRefusalText', () => {
  it('a negative score the database refuses (23514) is said in words', () => {
    expect(scoreRefusalText({ code: '23514', message: 'p_score_home must be non-negative' })).toBe(
      'The score was not saved. A score is a whole number, 0 or more. Nothing was changed.'
    );
  });
});
