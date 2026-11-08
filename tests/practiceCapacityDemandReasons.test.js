// @vitest-environment node
/**
 * Every reason the capacity panel can give for "no slot open" is a report code with its own words,
 * and every code is reachable (schedule expansion, PR 13, fix round 3; Codex, #711).
 *
 * The first three reviews of the panel each found the same shape: the reason was re-derived from
 * counts and a setting instead of from what refused each live slot, so a code fell through to a
 * sentence that was true of another one. `reservationRefusal` has two reasons
 * (`RESERVATION_REASON`), the panel's first draft said "reserved to another division" for both, and
 * a division whose OWN reservation had expired was sent to the wrong fix. This file is the census
 * that stops the next one:
 *
 * - every reservation reason of the run is a report code (the codes are built from
 *   `RESERVATION_REASON`, so a reason added there is a code here at once);
 * - every report code has panel words, with a practice length set and without one, and no two codes
 *   share a sentence (a census that cannot fail is not one: it is run on a map made to fail);
 * - every report code is reached by a constructed league (declared is not enforced).
 */
import { describe, it, expect } from 'vitest';

import {
  CAPACITY_NO_SLOT_REASON,
  CAPACITY_VERDICT,
  buildCapacityDemand,
} from '@squadlogic/core/practice/index.js';
import {
  NO_SLOT_REASON_WORDS,
  describeNoSlotReason,
} from '@squadlogic/core/practice/capacityDemandText.js';
import { RESERVATION_REASON } from '@squadlogic/core/practiceScheduling.js';
import { PRACTICE_UNPLACED_REASON } from '@squadlogic/core/practiceUnplacedReasons.js';

const CODES = Object.values(CAPACITY_NO_SLOT_REASON);

/** The codes whose words are missing or empty, in either form. Pure, so the test can run it on a map made to fail. */
const reasonsWithoutWords = (reasons, words) =>
  reasons.filter((reason) => {
    const entry = words[reason];
    return (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      entry.some((text) => typeof text !== 'string' || text.trim() === '')
    );
  });

describe('every reservation reason is a report code with words', () => {
  it('reads the reasons from the run: there are reasons to census', () => {
    expect(Object.values(RESERVATION_REASON).length).toBeGreaterThanOrEqual(2);
  });

  it('every reservation reason of the run is a report code', () => {
    for (const reason of Object.values(RESERVATION_REASON)) {
      expect(CODES, reason).toContain(reason);
    }
  });

  it('the length and date reasons of the run are report codes too', () => {
    expect(CODES).toContain(PRACTICE_UNPLACED_REASON.PRACTICE_LENGTH);
    expect(CODES).toContain(PRACTICE_UNPLACED_REASON.NO_LIVE_DATE);
  });

  it('every report code has words, with a practice length set and without one', () => {
    expect(reasonsWithoutWords(CODES, NO_SLOT_REASON_WORDS)).toEqual([]);
    for (const code of CODES) {
      for (const minutes of [null, 60]) {
        const words = describeNoSlotReason(code, minutes);
        expect(words.length, `${code} / ${minutes}`).toBeGreaterThan(20);
        expect(words, `${code} / ${minutes}`).not.toBe(code);
        expect(words.endsWith('.'), `${code} / ${minutes}`).toBe(true);
      }
    }
  });

  it('the census can fail: a reservation reason the map does not know is reported, and so is an empty entry', () => {
    const withNewReason = [
      ...Object.values(RESERVATION_REASON),
      'a-reservation-reason-added-later',
    ];
    expect(reasonsWithoutWords(withNewReason, NO_SLOT_REASON_WORDS)).toEqual([
      'a-reservation-reason-added-later',
    ]);
    const hollow = {
      ...NO_SLOT_REASON_WORDS,
      [RESERVATION_REASON.OUTSIDE_DIVISION_RESERVATION]: ['', 'only one form'],
    };
    expect(reasonsWithoutWords(CODES, hollow)).toEqual([
      RESERVATION_REASON.OUTSIDE_DIVISION_RESERVATION,
    ]);
    const missingOne = { ...NO_SLOT_REASON_WORDS };
    delete missingOne[CAPACITY_NO_SLOT_REASON.RESERVATIONS_MIXED];
    expect(reasonsWithoutWords(CODES, missingOne)).toEqual([
      CAPACITY_NO_SLOT_REASON.RESERVATIONS_MIXED,
    ]);
  });

  it('each distinct reason has its own sentence: none is shared, with a length or without', () => {
    for (const minutes of [null, 60]) {
      const sentences = CODES.map((code) => describeNoSlotReason(code, minutes));
      expect(new Set(sentences).size, `minutes ${minutes}`).toBe(CODES.length);
    }
  });

  it("a code this build does not know is said as written, never as another code's sentence", () => {
    expect(describeNoSlotReason('not-a-code', null)).toBe('not-a-code');
    expect(describeNoSlotReason(undefined, 60)).toBe('undefined');
  });
});

describe('every no-slot reason is reachable', () => {
  const LIVE_FROM = '2026-10-05';
  const SEASON = { start: '2026-09-07', end: '2026-11-29' };
  const slot = (id, dayOfWeek, over = {}) => ({
    id,
    dayOfWeek,
    startTime: '17:00:00',
    endTime: '18:00:00',
    capacity: 1,
    validFrom: '2026-09-01',
    validUntil: '2026-11-30',
    divisionId: null,
    ...over,
  });
  const expired = { validUntil: '2026-09-29' };

  /** One league per report code: a division of 60 minutes, one team, these slots. */
  const CASES = {
    [CAPACITY_NO_SLOT_REASON.NO_LIVE_DATE]: [slot('old', 'tue', expired)],
    [CAPACITY_NO_SLOT_REASON.PRACTICE_LENGTH]: [slot('short', 'tue', { endTime: '17:45:00' })],
    [CAPACITY_NO_SLOT_REASON.RESERVED_FOR_ANOTHER_DIVISION]: [
      slot('theirs', 'tue', { divisionId: 'someone-else' }),
    ],
    [CAPACITY_NO_SLOT_REASON.OUTSIDE_DIVISION_RESERVATION]: [
      slot('own-old', 'tue', { divisionId: 'd', ...expired }),
      slot('open', 'wed'),
    ],
    [CAPACITY_NO_SLOT_REASON.RESERVATIONS_MIXED]: [
      slot('theirs', 'tue', { divisionId: 'someone-else' }),
      slot('own-old', 'wed', { divisionId: 'd', ...expired }),
      slot('open', 'thu'),
    ],
  };

  const reasonOf = (slots) =>
    buildCapacityDemand({
      liveFrom: LIVE_FROM,
      season: SEASON,
      divisions: [{ id: 'd', name: 'D', practicesPerWeek: 1, practiceMinutes: 60 }],
      teams: [{ id: 't', divisionId: 'd' }],
      slots,
      assignments: [],
    }).divisions[0].verdict;

  it('has a league for every report code (a code with none is declared and never shown)', () => {
    for (const code of CODES) expect(CASES[code], `a league for ${code}`).toBeDefined();
  });

  it.each(CODES)('%s is the reason of its own league, and of no other', (code) => {
    const verdict = reasonOf(CASES[code]);
    expect(verdict).toMatchObject({ kind: CAPACITY_VERDICT.NO_SLOT, reason: code });
    for (const other of CODES) {
      if (other !== code) expect(reasonOf(CASES[other]).reason).not.toBe(code);
    }
  });
});
