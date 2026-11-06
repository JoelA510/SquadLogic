// @vitest-environment node
/**
 * The Play-up section's sentence and its announcement count SEATS, by the division each listed
 * player plays in (play-down plan, 2026-11-03, PR 2, task B2), not the kind each was listed as. A
 * player listed as an unrequested "play-up" plays in their own age division, so they are moved, not
 * playing up; counted by the kind they would be a play-up, which is a count of where they registered.
 *
 * Every expected figure below is worked out from the listing and the bands written here, never read
 * back from the function under test.
 *
 *   U10 is for ages 9 to 10 and U12 for ages 11 to 12.
 */
import { describe, expect, it } from 'vitest';
import {
  playUpAnnouncement,
  playUpSentence,
  summarizePlayUpReview,
} from '../frontend/src/utils/playUpReview.js';

const divisions = [
  { id: 'U10', name: 'U10', min_age: 9, max_age: 10 },
  { id: 'U12', name: 'U12', min_age: 11, max_age: 12 },
];

/** One line of the listing, as `applyPlayUpEligibility` writes it. */
const entry = (playerId, kind, fields) => ({
  playerId,
  name: `Player ${playerId}`,
  kind,
  requested: false,
  naturalAge: 10,
  registeredDivision: 'U12',
  registeredDivisionName: 'U12',
  playedDivision: 'U12',
  playedDivisionName: 'U12',
  coachId: null,
  ...fields,
});

/**
 * a  age 10 registered U12, asked      plays U12                   a play-up (10 is under 11), requested
 * b  age 9  registered U12, asked      plays U12                   a play-up, requested
 * c  age 10 registered U12             plays U10, their own age    moved: in band, not a play-up
 * d  age 9  registered U12             plays U10                   moved
 * e  age 12 registered U10             plays U12, their own age    moved: a play-down by registration,
 *                                                                  not playing down
 * f  age 10 registered U10, asked      plays U10                   asked, nothing to honour
 * g  age 10 registered U12, asked      plays U12, no age (null)    asked, and not checked
 * h  age 18 registered U12             no division can hold them   not placed
 */
const results = () => ({
  playUpByDivision: {
    U12: [
      entry('a', 'play-up', { requested: true }),
      entry('b', 'play-up', { requested: true, naturalAge: 9 }),
      entry('c', 'play-up', { playedDivision: 'U10', playedDivisionName: 'U10' }),
      entry('d', 'play-up', { naturalAge: 9, playedDivision: 'U10', playedDivisionName: 'U10' }),
      entry('e', 'play-down', {
        naturalAge: 12,
        registeredDivision: 'U10',
        registeredDivisionName: 'U10',
      }),
      entry('g', 'requested-age-unknown', { requested: true, naturalAge: null }),
      entry('h', 'no-division', { naturalAge: 18, playedDivision: null, playedDivisionName: null }),
    ],
    U10: [
      entry('f', 'requested-own-division', {
        requested: true,
        registeredDivision: 'U10',
        registeredDivisionName: 'U10',
        playedDivision: 'U10',
        playedDivisionName: 'U10',
      }),
    ],
  },
  waitlistExceptionsByDivision: {
    U12: [{ playerId: 'w', name: 'Wendy', childId: 'k', childName: 'Kid', coachId: 'c1' }],
  },
});

describe('the sentence counts seats, not the kind each player was listed as', () => {
  it('says who plays up, who was moved, who asked, who could not be compared and who was not placed', () => {
    const summary = summarizePlayUpReview(results(), divisions);
    expect(summary?.flags).toEqual({
      playingUp: 2,
      playingUpRequested: 2,
      playingDown: 0,
      moved: 3,
      askedToPlayUp: 2,
      notChecked: 1,
      notPlaced: 1,
    });
    expect(playUpSentence(summary)).toBe(
      '2 playing up (2 requested), 0 playing down, 3 moved to their own age division, 2 asked to play up from their own division, 1 not checked (no age, or no age band), 1 not placed (no division can hold them), 1 taken off the waitlist'
    );
  });

  it('does not call an unrequested play-up or a play-down by registration a play-up or play-down', () => {
    // c, d and e were listed as "play-up", "play-up" and "play-down". Counted by kind that is two
    // play-ups and a play-down; by seat they all play in band.
    const kinds = results().playUpByDivision.U12.filter((e) => e.kind !== 'no-division');
    expect(kinds.filter((e) => e.kind === 'play-up').length).toBe(4);
    expect(kinds.filter((e) => e.kind === 'play-down').length).toBe(1);
    const summary = summarizePlayUpReview(results(), divisions);
    expect(summary?.flags?.playingUp).toBe(2);
    expect(summary?.flags?.playingDown).toBe(0);
  });

  it('says a play-down when a listed player plays below their age, and counts it', () => {
    // Only a roster edit or a setting can put someone there; the count must still see it.
    const summary = summarizePlayUpReview(
      {
        playUpByDivision: {
          U10: [
            entry('x', 'play-down', {
              naturalAge: 12,
              registeredDivision: 'U10',
              registeredDivisionName: 'U10',
              playedDivision: 'U10',
              playedDivisionName: 'U10',
            }),
          ],
        },
      },
      divisions
    );
    expect(summary?.flags).toMatchObject({ playingDown: 1, playingUp: 0 });
    expect(playUpSentence(summary)).toBe('0 playing up, 1 playing down');
  });

  it('reads zero as zero, and an empty section as nothing', () => {
    const onlyMoved = summarizePlayUpReview(
      {
        playUpByDivision: {
          U12: [entry('c', 'play-up', { playedDivision: 'U10', playedDivisionName: 'U10' })],
        },
      },
      divisions
    );
    expect(playUpSentence(onlyMoved)).toBe(
      '0 playing up, 0 playing down, 1 moved to their own age division'
    );
    expect(summarizePlayUpReview({ playUpByDivision: { U12: [] } }, divisions)).toBeNull();
    expect(playUpSentence(null)).toBe('');
    expect(playUpAnnouncement(null)).toBe('');
  });

  it('is never a clean zero when the divisions are not known: it says it has not checked', () => {
    const summary = summarizePlayUpReview(results(), null);
    expect(summary?.flags).toBeNull();
    expect(playUpSentence(summary)).toBe(
      "play-up and play-down not checked yet (the season's divisions are not loaded), 1 taken off the waitlist"
    );
    // The rows are listed all the same.
    expect(summary?.divisions.flatMap((division) => division.entries)).toHaveLength(8);
  });

  it('counts a division the season does not list as not checked, never as in band', () => {
    const summary = summarizePlayUpReview(results(), [divisions[0]]);
    // U12 is unknown: a, b, g and e (played U12) cannot be compared. c and d play U10 (listed): moved.
    expect(summary?.flags).toMatchObject({ playingUp: 0, playingDown: 0, notChecked: 4 });
  });

  it('is one seat for a player listed under two divisions, and never throws for a listing with no division', () => {
    const twice = summarizePlayUpReview(
      {
        playUpByDivision: {
          U12: [entry('a', 'play-up', { requested: true })],
          U10: [entry('a', 'play-up', { requested: true })],
        },
      },
      divisions
    );
    expect(twice?.flags?.playingUp).toBe(1);

    const lost = summarizePlayUpReview(
      {
        playUpByDivision: {
          U12: [
            entry('z', 'no-division', {
              registeredDivision: null,
              playedDivision: null,
              naturalAge: 30,
            }),
          ],
        },
      },
      divisions
    );
    expect(lost?.flags?.notPlaced).toBe(1);
  });

  it('announces the same sentence the section prints', () => {
    const summary = summarizePlayUpReview(results(), divisions);
    expect(playUpAnnouncement(summary)).toBe(`Play-up section: ${playUpSentence(summary)}.`);
  });

  it('keeps the rows, the coach names and the waitlist list as they were', () => {
    const withCoach = results();
    withCoach.coachNamesById = { c1: 'Casey Coach' };
    const summary = summarizePlayUpReview(withCoach, divisions);
    expect(summary?.divisions.map((division) => division.division)).toEqual(['U12', 'U10']);
    expect(summary?.divisions[0].takenOffWaitlist[0]).toMatchObject({
      playerId: 'w',
      coachName: 'Casey Coach',
    });
    expect(summary?.totals).toEqual({ takenOffWaitlist: 1 });
  });
});
