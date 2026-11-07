// @vitest-environment node
/**
 * The practice clash rule (task G2b of PR 7; plan 4.11.4): two of one coach's practices on one weekday at overlapping
 * times on shared dates. Written once, in core, so the coach schedule and (later) the practice import's
 * `coach-conflict` flag state one rule. A practice is never compared with a game: a weekly series against a dated
 * event is stated on the page, not checked.
 *
 * Every expectation is written out from the cases below. The rule's edges: the same weekday, back-to-back is not an
 * overlap, a shared date is needed (ranges that never meet do not clash, a range that touches on one date does), and
 * a row that cannot be read is named, never judged clean.
 */
import { describe, expect, it } from 'vitest';

import {
  coachPracticeClashes,
  practicesClash,
} from '../packages/core/src/reports/practiceClash.js';

const practice = (id, extra = {}) => ({
  id,
  teamId: 't-1',
  range: '[2026-09-08,2026-11-20)',
  dayOfWeek: 'tue',
  startTime: '17:00:00',
  endTime: '18:30:00',
  validFrom: '2026-09-01',
  validUntil: '2026-11-30',
  fieldId: 'f-a1',
  fieldName: 'Field A1',
  ...extra,
});

describe('practicesClash', () => {
  it('is a clash on one weekday, with overlapping times, on dates both are live', () => {
    const result = practicesClash(
      practice('a'),
      practice('b', { startTime: '18:00:00', endTime: '19:00:00' })
    );
    expect(result.judged).toBe(true);
    expect(result.clash).toBe(true);
    // 2026-09-08 to 2026-11-19 is 11 Tuesdays.
    expect(result.sharedDates).toBe(11);
    expect(result.firstDate).toBe('2026-09-08');
  });

  it('is not a clash on different weekdays, however the times fall', () => {
    const result = practicesClash(practice('a'), practice('b', { dayOfWeek: 'wed' }));
    expect(result).toMatchObject({ judged: true, clash: false });
  });

  it('is not a clash when one ends as the other starts', () => {
    const result = practicesClash(
      practice('a'),
      practice('b', { startTime: '18:30:00', endTime: '19:30:00' })
    );
    expect(result).toMatchObject({ judged: true, clash: false });
  });

  it('is a clash when one practice sits wholly inside the other', () => {
    const result = practicesClash(
      practice('a'),
      practice('b', { startTime: '17:15:00', endTime: '17:45:00' })
    );
    expect(result.clash).toBe(true);
  });

  it('is not a clash when the date ranges never meet', () => {
    const early = practice('a', { range: '[2026-09-08,2026-10-06)' });
    const late = practice('b', { range: '[2026-10-06,2026-11-20)' });
    expect(practicesClash(early, late)).toMatchObject({
      judged: true,
      clash: false,
      sharedDates: 0,
    });
  });

  it('is a clash when the ranges touch on one live date', () => {
    // [..., 2026-10-07) ends on Tue 2026-10-06; the second starts Tue 2026-10-06.
    const early = practice('a', { range: '[2026-09-08,2026-10-07)' });
    const late = practice('b', { range: '[2026-10-06,2026-11-20)' });
    expect(practicesClash(early, late)).toMatchObject({
      judged: true,
      clash: true,
      sharedDates: 1,
      firstDate: '2026-10-06',
    });
  });

  it('is not a clash when the ranges overlap only on days that are not the weekday', () => {
    // Wed 2026-10-07 to Mon 2026-10-12 holds no Tuesday: the half-open bound leaves out Tue 2026-10-13.
    const a = practice('a', { range: '[2026-10-07,2026-10-13)' });
    const b = practice('b', { range: '[2026-10-07,2026-10-13)' });
    expect(practicesClash(a, b)).toMatchObject({ judged: true, clash: false, sharedDates: 0 });
  });

  it('limits a series to its slot validity as well as its range', () => {
    const a = practice('a', { validUntil: '2026-09-20' });
    const b = practice('b', { range: '[2026-09-22,2026-11-20)' });
    expect(practicesClash(a, b)).toMatchObject({ judged: true, clash: false });
  });

  it('reads a row with no range as live for its whole slot validity, and an open range likewise', () => {
    const noRange = practice('a', { range: null });
    const open = practice('b', { range: '[2026-11-03,)' });
    const result = practicesClash(noRange, open);
    expect(result).toMatchObject({ judged: true, clash: true, firstDate: '2026-11-03' });
    // Tuesdays 3, 10, 17, 24 of November: the validity ends on the 30th.
    expect(result.sharedDates).toBe(4);
  });

  it('says it could not judge a row it cannot read, and never calls it clean', () => {
    for (const bad of [
      practice('x', { range: 'garbage' }),
      practice('x', { dayOfWeek: null }),
      practice('x', { startTime: null }),
      practice('x', { endTime: 'late' }),
      practice('x', { startTime: '19:00:00', endTime: '18:00:00' }),
    ]) {
      const result = practicesClash(practice('a'), bad);
      expect(result.judged).toBe(false);
      expect(result.clash).toBe(false);
      expect(typeof result.why).toBe('string');
    }
  });
});

describe('coachPracticeClashes', () => {
  it('finds every clashing pair among a coach’s practices, once, and names the ones it could not judge', () => {
    const rows = [
      practice('a'),
      practice('b', { teamId: 't-4', startTime: '18:00:00', endTime: '19:00:00' }),
      practice('c', { teamId: 't-4', dayOfWeek: 'wed' }),
      practice('d', { teamId: 't-4', startTime: '18:15:00', endTime: '18:45:00' }),
      practice('e', { range: 'garbage' }),
    ];
    const { clashes, unjudged } = coachPracticeClashes(rows);
    expect(clashes.map((c) => [c.a, c.b].join('+')).sort()).toEqual(['a+b', 'a+d', 'b+d']);
    expect(unjudged).toEqual(['e']);
  });

  it('is empty for no practices and for one, and does not mutate its input', () => {
    expect(coachPracticeClashes([])).toEqual({ clashes: [], unjudged: [] });
    const one = [practice('a')];
    const copy = JSON.parse(JSON.stringify(one));
    expect(coachPracticeClashes(one)).toEqual({ clashes: [], unjudged: [] });
    expect(one).toEqual(copy);
  });
});
