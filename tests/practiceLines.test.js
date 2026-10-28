/**
 * The per-team practice counts the Auto-Scheduler panel shows (Phase D PR B, B3): a team given 1 of
 * its 2 practices is listed with the reason for the missing one instead of vanishing from the
 * report. The subject set is the function's `practices.teams`, never the placements.
 */
import { describe, expect, it } from 'vitest';

import { practiceLines } from '../frontend/src/utils/practiceLines.js';

const names = { a: 'Hawks', b: 'Bears' };

describe('practiceLines', () => {
  it('lists a team given 1 of 2 practices with the reason, though it has a placement', () => {
    const lines = practiceLines(
      {
        practices: {
          teams: [
            { teamId: 'a', target: 2, held: 0, placed: 1, missing: 1 },
            { teamId: 'b', target: 2, held: 0, placed: 2, missing: 0 },
          ],
        },
        unassigned: [{ teamId: 'a', unitId: 'a#2', reason: 'not-enough-days', target: 2 }],
      },
      names
    );
    expect(lines).toEqual([
      {
        teamId: 'a',
        name: 'Hawks',
        have: 1,
        target: 2,
        reasons: ["the division's slots fall on fewer weekdays than its practices a week"],
      },
      { teamId: 'b', name: 'Bears', have: 2, target: 2, reasons: [] },
    ]);
  });

  it('counts the rows a team already holds', () => {
    const [line] = practiceLines(
      { practices: { teams: [{ teamId: 'a', target: 3, held: 2, placed: 1, missing: 0 }] } },
      names
    );
    expect(line).toMatchObject({ have: 3, target: 3 });
  });

  it('names a team at one a week whose division length no slot matches, and no other', () => {
    const lines = practiceLines(
      {
        practices: { teams: [] },
        unassigned: [
          { teamId: 'a', reason: 'practice-length' },
          { teamId: 'b', reason: 'no-slot-available' },
        ],
      },
      names
    );
    expect(lines).toEqual([
      {
        teamId: 'a',
        name: 'Hawks',
        have: 0,
        target: 1,
        reasons: ["no practice slot is exactly as long as the division's practice"],
      },
    ]);
  });

  it('shows nothing for a function that sends no practices block', () => {
    expect(practiceLines({ unassigned: [] }, names)).toEqual([]);
    expect(practiceLines(null, names)).toEqual([]);
  });
});
