/**
 * `frontend/src/utils/practicePreferenceRows.js` is the JavaScript twin of the parsing in
 * `finalize_practice_preference_import_job` (migration 20261112010000). These are the inputs
 * `supabase/tests/practice_preference_import.sql` feeds the SQL, with the answers it asserts, plus
 * the separators and clock spellings the SQL reads: if the two ever disagree, one of the two files
 * is red.
 */
import { describe, expect, it } from 'vitest';

import {
  parseDate,
  parsePreferenceRow,
  parseStartMinutes,
  payloadText,
} from '../frontend/src/utils/practicePreferenceRows.js';

const PARK = '00000000-0000-4000-8000-0000000000c1';
const NORTH = '00000000-0000-4000-8000-0000000000c2';
const locations = [
  { id: PARK, name: 'Imp Park' },
  { id: NORTH, name: 'Imp Fields, North' },
];
const parse = (payload) =>
  parsePreferenceRow({ email: 'p@example.test', ...payload }, { locations });
const rule = (payload) => {
  const parsed = parse(payload);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.rule;
};

describe('a staged row read as a rule', () => {
  it('reads "Tuesday and Thursday" and "5:00 PM; 6pm" as sets, in week and clock order, and a must as asked', () => {
    expect(
      rule({ request_level: 'Must', weekdays: 'Tuesday and Thursday', start_times: '5:00 PM; 6pm' })
    ).toMatchObject({
      requestedLevel: 'must',
      weekdays: ['TUE', 'THU'],
      startMinutes: [1020, 1080],
    });
    // The same rule written the other way round is the same rule.
    expect(rule({ weekdays: 'Thu, Tue', start_times: '17:00, 18:00' })).toMatchObject({
      weekdays: ['TUE', 'THU'],
      startMinutes: [1020, 1080],
    });
  });

  it('reads the clock as written: 12am is 0, 12:30 pm is 750, 5:05 p.m. is 1025, 17 is 1020; 25:00 is unreadable', () => {
    expect(rule({ start_times: '12am, 12:30 pm, 5:05 p.m.' }).startMinutes).toEqual([0, 750, 1025]);
    expect(parseStartMinutes('17')).toBe(1020);
    expect(parseStartMinutes('5:00 pm')).toBe(1020);
    for (const bad of ['25:00', '13pm', '0am', '5:60', 'noon', '']) {
      expect(parseStartMinutes(bad), bad).toBeNull();
    }
    expect(parse({ start_times: '12am, 25:00' })).toEqual({
      ok: false,
      message: 'Unreadable start time in the start times column',
    });
  });

  it('reads a venue by name, a name with a comma as one name, several separated by ; or |, an unknown one as an error', () => {
    expect(rule({ venues: 'Imp Park' }).venueIds).toEqual([PARK]);
    expect(rule({ venues: 'Imp Fields, North' }).venueIds).toEqual([NORTH]);
    expect(rule({ venues: 'imp park | Imp Fields, North' }).venueIds).toEqual([PARK, NORTH]);
    expect(parse({ venues: 'Imp Park; Somewhere Else' })).toEqual({
      ok: false,
      message: 'Unknown venue: no location of this organization has that name',
    });
  });

  it('reads a window in two date forms, and refuses an impossible, an unreadable or a reversed one', () => {
    expect(
      rule({ weekdays: 'Mon', effective_from: '2099-01-05', effective_to: '1/31/2099' })
    ).toMatchObject({
      effectiveFrom: '2099-01-05',
      effectiveTo: '2099-01-31',
    });
    expect(rule({ weekdays: 'Mon', valid_from: '2099-01-05' }).effectiveFrom).toBe('2099-01-05');
    expect(parseDate('2099-02-30')).toBeNull();
    expect(parseDate('13/1/2099')).toBeNull();
    expect(parse({ weekdays: 'Mon', effective_from: '2099-02-30' }).ok).toBe(false);
    expect(
      parse({ weekdays: 'Mon', effective_from: '2099-02-01', effective_to: '2099-01-01' }).message
    ).toBe('The effective until date is before the effective from date');
  });

  it('refuses an unknown level, priority and day, a row with no condition and a row with no email, each by its own message', () => {
    expect(parse({ weekdays: 'Mon', request_level: 'whenever' }).message).toBe(
      'Unknown request level: use prefer or must'
    );
    expect(parse({ weekdays: 'Mon', coach_priority: 'urgent' }).message).toBe(
      'Unknown priority: use high, medium or low'
    );
    expect(parse({ weekdays: 'Funday' }).message).toBe('Unknown day in the days column');
    expect(parse({ team_name: 'Imp A3' }).message).toBe(
      'The row names no day, start time or venue'
    );
    expect(parsePreferenceRow({ weekdays: 'Mon' }, { locations }).message).toBe(
      'The row has no coach email'
    );
  });

  it('defaults to prefer, reads the priority in any case, the email trimmed and lower-cased, and the team in three spellings', () => {
    expect(rule({ weekdays: 'Mon' }).requestedLevel).toBe('prefer');
    expect(rule({ weekdays: 'Mon', coach_priority: 'MED' }).coachPriority).toBe('medium');
    expect(
      parsePreferenceRow({ email: ' IMP-R@Example.test ', weekdays: 'Mon' }, { locations }).rule
        .email
    ).toBe('imp-r@example.test');
    expect(rule({ weekdays: 'Mon', 'team name': 'A' }).team).toBe('A');
    expect(rule({ weekdays: 'Mon', team: 'B' }).team).toBe('B');
    expect(rule({ weekdays: 'Mon', team_name: 'C', team: 'B' }).team).toBe('C');
  });

  it('payloadText takes the first non-blank of its keys', () => {
    expect(payloadText({ a: '  ', b: ' x ' }, 'a', 'b')).toBe('x');
    expect(payloadText({}, 'a')).toBeNull();
  });
});
