// @vitest-environment node
/**
 * The Practice daylight outlook's words (duration-phase wiring, PR B,
 * `docs/changes/2026-11-02-duration-phases-wiring.md`, task B3): the exact
 * sentences an admin reads, so a change of wording is a change someone made.
 *
 * Owner, 2026-11-02: a sunset condition is a warning, never a refusal. So the
 * vocabulary is pinned both ways: what is said (a date is "kept as scheduled"
 * and "flagged") and what is never said of a practice (blocked, refused, lost,
 * held out, TIME TBD).
 *
 * **Where the expectations come from.** The rows are the synthetic estate in
 * `tests/helpers/practiceDaylightRows.js`. Every limit a sentence quotes is
 * re-derived below from core's sunset helper (the report's own number is not
 * trusted), the clock change from the zone, and every date by plain calendar
 * arithmetic. The one sentence the stored rows cannot produce (an overlap-only
 * flag needs an operator duration pin, which has no storage) is built from the
 * module's own output on a rig, as `practiceDurationPhases.test.js` builds it.
 * Plant (shown red, then reverted): the overlap sentence replaced by the past-sunset one, so an
 * overlap-only flag reads as past sunset (the overlap tests go red).
 */

import { describe, expect, it } from 'vitest';

import { buildAvailabilityCalendar } from '@squadlogic/core/availability/index.js';
import { buildFacilityGraph } from '@squadlogic/core/facility/index.js';
import {
  PRACTICE_COMPRESSION_STRATEGY,
  buildPracticeSlotSet,
  derivePracticeDurationPhases,
} from '@squadlogic/core/practice/index.js';
import {
  deriveSeasonClockEvents,
  sunsetEnforcementMinutes,
  sunsetOnDate,
} from '@squadlogic/core/timing/index.js';

import {
  OUTLOOK_BANNER,
  OUTLOOK_VERDICT,
  buildDaylightOutlook,
  clock,
  clockChangeNote,
  dayFormatterFor,
  describeFlaggedDate,
  describeRules,
  describeSummary,
  describeUnknown,
  describeVerdict,
  formatDay,
} from '../frontend/src/utils/daylightOutlook.js';
import { ID, SEASON, assignment, estateRows, uuid } from './helpers/practiceDaylightRows.js';

const ZONE = 'America/New_York';
const outlook = buildDaylightOutlook({ rows: estateRows(), season: SEASON });
const rowOf = (slotId) => outlook.rows.find((r) => r.slotId === slotId);

describe('dates and clocks', () => {
  it('writes a clock as HH:MM and a date as its weekday, day and month', () => {
    expect(clock(0)).toBe('00:00');
    expect(clock(16 * 60 + 5)).toBe('16:05');
    expect(formatDay('2026-09-22')).toBe('Tue 22 Sep');
    expect(formatDay('2026-11-01')).toBe('Sun 1 Nov');
    expect(formatDay('2027-01-05', { year: true })).toBe('Tue 5 Jan 2027');
  });

  it('prints the year only when the season crosses a new year', () => {
    const within = dayFormatterFor({ from: '2026-09-01', to: '2026-11-30' });
    const across = dayFormatterFor({ from: '2026-11-02', to: '2027-02-28' });
    expect(within('2026-11-03')).toBe('Tue 3 Nov');
    expect(across('2026-11-03')).toBe('Tue 3 Nov 2026');
    expect(across('2027-01-05')).toBe('Tue 5 Jan 2027');
  });
});

describe('the clock change a date follows', () => {
  const day = dayFormatterFor({ from: '2026-01-01', to: '2026-12-31' });
  const events = deriveSeasonClockEvents({
    from: '2026-01-01',
    to: '2026-12-31',
    timeZone: ZONE,
  }).events;

  it('is read from the zone: this year the clocks went forward on 8 Mar and back on 1 Nov', () => {
    expect(events.map((e) => [e.name, e.date])).toEqual([
      ['dst-start', '2026-03-08'],
      ['dst-end', '2026-11-01'],
    ]);
  });

  it('names the change on the first practice date after it, and on no other', () => {
    expect(clockChangeNote('2026-11-03', events, day)).toBe(
      'The clocks go back on Sun 1 Nov, which moves sunset about an hour earlier.'
    );
    // The week before, the same week as the change itself (the 1st is a Sunday), the week after.
    expect(clockChangeNote('2026-10-27', events, day)).toBeNull();
    expect(clockChangeNote('2026-11-01', events, day)).toBe(
      'The clocks go back on Sun 1 Nov, which moves sunset about an hour earlier.'
    );
    expect(clockChangeNote('2026-11-10', events, day)).toBeNull();
    expect(clockChangeNote('2026-03-10', events, day)).toBe(
      'The clocks go forward on Sun 8 Mar, which moves sunset about an hour later.'
    );
  });

  it('says minutes, not an hour, for a zone that moves its clock by half an hour', () => {
    const lordHowe = deriveSeasonClockEvents({
      from: '2026-09-01',
      to: '2026-10-31',
      timeZone: 'Australia/Lord_Howe',
    }).events;
    expect(lordHowe).toHaveLength(1);
    expect(clockChangeNote(lordHowe[0].date, lordHowe, day)).toBe(
      `The clocks go forward on ${day(lordHowe[0].date)}, which moves sunset about 30 minutes later.`
    );
  });
});

describe('the estate, in words', () => {
  it('opens with the summary and the rules, and says nothing is applied', () => {
    expect(outlook.summary).toBe(
      '8 practice slots on unlit ground, 86 practice dates from Tue 1 Sep to Mon 30 Nov ' +
        '(America/New_York). 1 practice slot on lit ground is not judged.'
    );
    expect(outlook.rules).toBe(
      'Each slot is shortened first, in 10-minute steps to no less than 40 minutes, then started ' +
        'earlier when that would break the minimum, never before school ends at 16:00 and never ' +
        'into another practice on the same field. The school-day end only bounds Monday, Tuesday, ' +
        'Wednesday and Thursday, so on other days a practice is shortened but not started ' +
        'earlier. There is no setting to choose another approach per slot, and permits, field ' +
        'size and capacity are not checked.'
    );
    expect(OUTLOOK_BANNER).toBe(
      'Proposed, not applied. Nothing on this page changes a practice, an assignment or a ' +
        'calendar: it shows how each practice on unlit ground could be retimed to end by sunset, ' +
        'so you can decide. A date that no shortening or earlier start saves is kept as scheduled ' +
        'and flagged, never blocked.'
    );
  });

  it('lists the slots worst first, then by the week, and counts them in a partition', () => {
    expect(outlook.rows.map((r) => [r.verdict.key, r.title, r.ground])).toEqual([
      ['flagged', 'Tuesday 18:00 to 19:00', 'Field 1 (Central Park)'],
      ['flagged', 'Wednesday 17:00 to 18:00', 'Field 1 (Central Park)'],
      ['flagged', 'Wednesday 18:00 to 19:00', 'Field 2 B (Central Park)'],
      ['unknown', 'Thursday 17:00 to 18:00', 'Field 3 (Far Park)'],
      ['retimed', 'Monday 18:00 to 19:00', 'Field 5 (Central Park)'],
      ['exempt', 'Tuesday 18:00 to 19:00', 'Field 2 A (Central Park)'],
      ['ok', 'Monday 15:00 to 16:00', 'Field 1 (Central Park)'],
      ['no-dates', 'Saturday 10:00 to 11:00', 'Field 1 (Central Park)'],
    ]);
    expect(outlook.counts.byVerdict).toEqual({
      flagged: 3,
      unknown: 1,
      retimed: 1,
      exempt: 1,
      ok: 1,
      'no-dates': 1,
    });
  });

  it('a slot that goes dark: every proposed change in words, from the first date it is needed', () => {
    const row = rowOf(ID.dark);
    expect(row.teams).toBe('Lions, Tigers');
    expect(row.plan).toBe('As planned: 18:00 to 19:00 (60 min).');
    expect(row.phases.map((p) => p.text)).toEqual([
      'From Tue 22 Sep: 50 min, 18:00 to 18:50. The latest it may end is 18:56.',
      'From Tue 29 Sep: 40 min, 18:00 to 18:40. The latest it may end is 18:45.',
      // The minimum is reached: shortening more would go below it, so the start moves instead.
      'From Tue 6 Oct: shortening would go below the 40-minute minimum, so it starts at 17:50 instead, keeping 40 min, 17:50 to 18:30. The latest it may end is 18:34.',
      'From Tue 13 Oct: shortening would go below the 40-minute minimum, so it starts at 17:40 instead, keeping 40 min, 17:40 to 18:20. The latest it may end is 18:23.',
      'From Tue 20 Oct: shortening would go below the 40-minute minimum, so it starts at 17:30 instead, keeping 40 min, 17:30 to 18:10. The latest it may end is 18:13.',
      'From Tue 27 Oct: shortening would go below the 40-minute minimum, so it starts at 17:20 instead, keeping 40 min, 17:20 to 18:00. The latest it may end is 18:03.',
      // The first Tuesday after the clocks went back: sunset is an hour earlier, and the sentence says why.
      'From Tue 3 Nov: shortening would go below the 40-minute minimum, so it starts at 16:10 instead, keeping 40 min, 16:10 to 16:50. The latest it may end is 16:55. The clocks go back on Sun 1 Nov, which moves sunset about an hour earlier.',
      'From Tue 10 Nov: shortening would go below the 40-minute minimum, so it starts at 16:00 instead, keeping 40 min, 16:00 to 16:40. The latest it may end is 16:47.',
    ]);
    expect(row.verdict).toEqual({
      key: 'flagged',
      label: 'Flagged on 1 date',
      tone: 'warning',
      headline:
        'As planned it would end past sunset from Tue 22 Sep. On 1 date no shortening or earlier ' +
        'start keeps it inside daylight, the first being Tue 24 Nov. Those dates are kept as ' +
        'scheduled and flagged.',
    });
  });

  it('a date no retiming saves: kept as scheduled and flagged, with each reason', () => {
    expect(rowOf(ID.dark).flagged.items.map((i) => i.text)).toEqual([
      'Tue 24 Nov: it runs 16:00 to 16:40, after the latest it may end (16:37). Starting at 15:50 is before school ends (16:00). It is kept as scheduled and flagged.',
    ]);
    // The minimum is broken as well as the school-day floor, and the date follows the clock change.
    const floor = rowOf(ID.floor);
    expect(floor.verdict.label).toBe('Flagged on 4 dates');
    expect(floor.flagged.first).toBe('2026-11-04');
    expect(floor.flagged.items.map((i) => i.text)).toEqual([
      'Wed 4 Nov: it runs 17:00 to 18:00, after the latest it may end (16:54). Shortening would go below the 40-minute minimum. Starting at 15:50 is before school ends (16:00). It is kept as scheduled and flagged. The clocks go back on Sun 1 Nov, which moves sunset about an hour earlier.',
      'Wed 11 Nov: it runs 17:00 to 18:00, after the latest it may end (16:46). Shortening would go below the 40-minute minimum. Starting at 15:40 is before school ends (16:00). It is kept as scheduled and flagged.',
      'Wed 18 Nov: it runs 17:00 to 18:00, after the latest it may end (16:41). Shortening would go below the 40-minute minimum. Starting at 15:40 is before school ends (16:00). It is kept as scheduled and flagged.',
      'Wed 25 Nov: it runs 17:00 to 18:00, after the latest it may end (16:37). Shortening would go below the 40-minute minimum. Starting at 15:30 is before school ends (16:00). It is kept as scheduled and flagged.',
    ]);
  });

  it('quotes the limit core’s sunset helper gives for that venue and date, to the minute', () => {
    // The estate's one coordinate pair, derived here and not read from the report.
    const limitOn = (date) =>
      sunsetEnforcementMinutes(
        sunsetOnDate({ date, latitude: 40, longitude: -75, timeZone: ZONE })
      );
    const quoted = [];
    for (const slotId of [ID.dark, ID.floor, ID.retimed, ID.partial]) {
      const row = rowOf(slotId);
      for (const phase of row.phases) {
        quoted.push([phase.date, phase.text.match(/latest it may end is (\d\d:\d\d)/)[1]]);
      }
      for (const item of row.flagged?.items ?? []) {
        quoted.push([item.date, item.text.match(/may end \((\d\d:\d\d)\)/)[1]]);
      }
    }
    expect(quoted.length).toBeGreaterThan(20);
    for (const [date, limit] of quoted) expect([date, limit]).toEqual([date, clock(limitOn(date))]);
  });

  it('a slot under an approved lighting window says how many dates are not judged', () => {
    expect(rowOf(ID.exempt).verdict).toEqual({
      key: 'exempt',
      label: 'Under portable lighting',
      tone: 'info',
      headline: 'Every date is under an approved lighting window, so none is judged.',
    });
    expect(rowOf(ID.exempt).exempt).toBe(
      '13 dates are under an approved lighting window and are not judged.'
    );
    expect(rowOf(ID.partial).exempt).toBe(
      '2 dates are under an approved lighting window and are not judged.'
    );
    // 6 to 19 Oct holds two Wednesdays, the 7th and the 14th: the phases skip them.
    expect(rowOf(ID.partial).phases.map((p) => p.date)).not.toContain('2026-10-07');
    expect(rowOf(ID.partial).phases.map((p) => p.date)).not.toContain('2026-10-14');
  });

  it('a windows the module would not apply is named, in words', () => {
    expect(outlook.notes).toEqual([
      'An approved lighting window for Friday 18:00 on Field 4 (Bright Park) from Tue 6 Oct to Mon 12 Oct is not applied: it is on lit ground, where nothing is judged.',
    ]);
  });

  it('a slot at a venue with no coordinates: sunset unknown, never fine, and how to fix it', () => {
    const row = rowOf(ID.unknown);
    expect(row.verdict).toEqual({
      key: 'unknown',
      label: 'Sunset unknown',
      tone: 'warning',
      headline: 'No sunset is known on 13 dates, so it cannot be shown to end by sunset.',
    });
    expect(row.unknown).toBe(
      'Sunset unknown on 13 dates: Far Park has no coordinates. It cannot be shown to end by ' +
        'sunset, so it is flagged and never read as fine.'
    );
    expect(row.fixes).toEqual([
      {
        kind: 'coordinates',
        text: 'Set the coordinates of Far Park: the sunset is then worked out for every date.',
        link: 'fields',
      },
    ]);
  });

  it('what could fix a slot is listed as candidates, with the lighting window and the lit field', () => {
    const fixes = rowOf(ID.floor).fixes;
    expect(fixes.map((f) => [f.kind, f.link, f.text])).toEqual([
      ['lit-field', null, 'A lit field: Field 4 (Bright Park). Only the lighting is checked.'],
      [
        'lighting-override',
        'lighting',
        'Portable lighting: an approved window from Wed 4 Nov to Wed 25 Nov exempts those dates.',
      ],
    ]);
  });

  it('a slot that stays in daylight, retimed or not, says so, and has nothing to fix', () => {
    expect(rowOf(ID.ok).verdict.headline).toBe('It ends by sunset on every date as planned.');
    expect(rowOf(ID.ok).fixesNote).toBe('Nothing to fix.');
    expect(rowOf(ID.retimed).verdict).toEqual({
      key: 'retimed',
      label: 'Retime to stay in daylight',
      tone: 'info',
      headline:
        'As planned it would end past sunset from Mon 21 Sep; the changes below keep it inside ' +
        'daylight on every date.',
    });
    expect(rowOf(ID.retimed).fixesNote).toBe('The proposed changes are enough.');
    expect(rowOf(ID.noDates).verdict.headline).toBe(
      'Its weekday never falls inside its dates and the season, so there is nothing to judge.'
    );
  });
});

describe('variants of the estate: the teams, a venue with no stated lighting, the first day of the season', () => {
  const rowsWith = (change) => change(estateRows());

  it('lists a team for the part of the season it has the slot, and no team that has it outside the season', () => {
    const bears = uuid(404);
    const rows = rowsWith((r) => ({
      ...r,
      teams: [...r.teams, { id: bears, organization_id: SEASON.organization_id, name: 'Bears' }],
      practiceAssignments: [
        // Lions leave after 19 Oct (the range ends 20 Oct, exclusive), Tigers arrive on 6 Oct, Bears are next season's.
        {
          ...assignment(uuid(611), uuid(402), ID.dark),
          effective_date_range: '[2026-09-01,2026-10-20)',
        },
        {
          ...assignment(uuid(612), uuid(401), ID.dark),
          effective_date_range: '[2026-10-06,2026-12-01)',
        },
        {
          ...assignment(uuid(613), bears, ID.dark),
          effective_date_range: '[2026-12-01,2027-02-01)',
        },
        // A team on the slot for the whole of it carries no dates, and one with two stretches shows both.
        assignment(uuid(614), uuid(403), ID.ok),
        {
          ...assignment(uuid(615), uuid(402), ID.floor),
          effective_date_range: '[2026-09-01,2026-09-15)',
        },
        {
          ...assignment(uuid(616), uuid(402), ID.floor),
          effective_date_range: '[2026-10-27,2026-12-01)',
        },
      ],
    }));
    const built = buildDaylightOutlook({ rows, season: SEASON });
    const teams = (slotId) => built.rows.find((r) => r.slotId === slotId).teams;
    expect(teams(ID.dark)).toBe('Lions (until Mon 19 Oct), Tigers (from Tue 6 Oct)');
    expect(teams(ID.ok)).toBe('Hawks');
    expect(teams(ID.floor)).toBe('Lions (until Mon 14 Sep), Lions (from Tue 27 Oct)');
    expect(teams(ID.unknown)).toBe('no team assigned');
  });

  it('says a venue whose lighting is not stated is judged as unlit, and still counts it as unlit', () => {
    const rows = rowsWith((r) => ({
      ...r,
      locations: r.locations.map((l) =>
        l.name === 'Far Park' ? { ...l, lighting_available: null } : l
      ),
    }));
    const built = buildDaylightOutlook({ rows, season: SEASON });
    expect(built.notes).toContain(
      "1 practice slot is at a venue whose lighting is not stated, so it is judged as unlit, as the daylight rule does. State the venue's lighting on Fields & Venues."
    );
    // Judged exactly as before (the estate's own row for it is unknown, never fine), and not lit.
    expect(built.counts.slots).toBe(8);
    expect(built.counts.litSlots).toBe(1);
    expect(built.rows.find((r) => r.slotId === ID.unknown).verdict.key).toBe('unknown');
    // The estate as it stands has no such venue, so no such note.
    expect(outlook.notes.some((n) => /lighting is not stated/.test(n))).toBe(false);
  });

  it('names a clock change that falls on the first day of the season', () => {
    // 2026-11-01 is the day the clocks went back, and the season's first date: a Sunday practice.
    const rows = rowsWith((r) => ({
      ...r,
      practiceSlots: r.practiceSlots
        .filter((slot) => slot.id === ID.ok)
        .map((slot) => ({
          ...slot,
          day_of_week: 'sun',
          start_time: '17:00:00',
          end_time: '18:00:00',
          valid_from: null,
          valid_until: null,
        })),
      practiceAssignments: [],
      lightingOverrides: [],
    }));
    const built = buildDaylightOutlook({
      rows,
      season: { ...SEASON, season_start: '2026-11-01', season_end: '2026-11-29' },
    });
    const first = built.rows[0].flagged.items[0];
    expect(first.date).toBe('2026-11-01');
    expect(first.text).toMatch(
      /^Sun 1 Nov: it runs 17:00 to 18:00, after the latest it may end \(16:5\d\)\./
    );
    expect(first.text).toMatch(
      /The clocks go back on Sun 1 Nov, which moves sunset about an hour earlier\.$/
    );
  });

  it('says why no earlier start is proposed on a day the school-day end does not bound', () => {
    // The same Sunday practice, with a school-day end set: it bounds Monday to Thursday only.
    const rows = rowsWith((r) => ({
      ...r,
      practiceSlots: r.practiceSlots
        .filter((slot) => slot.id === ID.ok)
        .map((slot) => ({
          ...slot,
          day_of_week: 'sun',
          start_time: '17:00:00',
          end_time: '18:00:00',
        })),
      practiceAssignments: [],
      lightingOverrides: [],
    }));
    const text = buildDaylightOutlook({ rows, season: SEASON }).rows[0].flagged.items[0].text;
    expect(text).toContain(
      'The school-day end only bounds Monday, Tuesday, Wednesday and Thursday, so no earlier start is proposed on this day.'
    );
    expect(text).not.toMatch(/no school-day end/);
    // With no school-day end at all, it says that instead.
    const none = buildDaylightOutlook({ rows, season: { ...SEASON, school_day_end: null } });
    expect(none.rows[0].flagged.items[0].text).toContain(
      'The season has no school-day end, so an earlier start is not proposed.'
    );
  });
});

describe('an overlap is worded as an overlap, never as past sunset', () => {
  // The rig of `practiceDurationPhases.test.js` ("a shifted slot is re-checked every night"):
  // B moves into the room A's operator pin frees, and when A is pinned back, B's move would
  // overlap A. The stored rows cannot reach it (a pin has no storage), so the entry is the
  // module's own, from its public API.
  const graph = buildFacilityGraph({
    venues: [{ id: 'dark', name: 'Dark Park', lit: false }],
    surfaces: [{ id: 'dark/f', venueId: 'dark', name: 'F', sizes: ['7v7'], lined: ['7v7'] }],
  });
  const rigSlot = (id, startMinutes) => ({
    id,
    surfaceId: 'dark/f',
    weekday: 'TUE',
    startMinutes,
    durationMinutes: 60,
    validFrom: '2026-10-06',
    validUntil: '2026-10-20',
    capacity: 1,
    revisionId: 'r',
    label: null,
  });
  const scheduleFor = (limits) =>
    derivePracticeDurationPhases({
      slotSet: buildPracticeSlotSet({
        slots: [rigSlot('A', 16 * 60), rigSlot('B', 17 * 60)],
        assignments: ['A', 'B'].map((id) => ({ id: `a-${id}`, slotId: id, teamId: `T-${id}` })),
        source: 'rig',
      }),
      graph,
      calendar: buildAvailabilityCalendar({
        timeZone: ZONE,
        sunsets: Object.entries(limits).map(([date, sunsetMinutes]) => ({ date, sunsetMinutes })),
      }),
      window: { from: '2026-10-06', to: '2026-10-20' },
      strategies: { B: PRACTICE_COMPRESSION_STRATEGY.SHIFT_EARLIER },
      earliestStartMinutes: 15 * 60,
      overrides: [
        { slotId: 'A', effectiveFrom: '2026-10-06', durationMinutes: 40, reason: 'club asked' },
        { slotId: 'A', effectiveFrom: '2026-10-13', durationMinutes: 60, reason: 'club asked' },
      ],
    });
  const ctx = {
    day: dayFormatterFor({ from: '2026-10-06', to: '2026-10-20' }),
    minimumDurationMinutes: 40,
    clockChanges: [],
  };
  const flaggedOfB = (schedule) => schedule.slotPhases.find((s) => s.slotId === 'B').flagged;

  it('inside daylight: another practice is on this field at that time', () => {
    const entries = flaggedOfB(
      scheduleFor({
        '2026-10-06': 17 * 60 + 50,
        '2026-10-13': 17 * 60 + 50,
        '2026-10-20': 17 * 60 + 50,
      })
    );
    expect(entries.map((e) => e.date)).toEqual(['2026-10-13', '2026-10-20']);
    // The module raises the past-sunset finding for it; the entry sits inside daylight.
    for (const entry of entries) {
      expect(entry.code).toBe('PRACTICE_PAST_SUNSET');
      expect(entry.shiftRefused).toBe('overlap');
      expect(entry.startMinutes + entry.durationMinutes).toBeLessThanOrEqual(entry.limitMinutes);
    }
    const sentences = entries.map((entry) => describeFlaggedDate(entry, ctx));
    expect(sentences[0]).toBe(
      'Tue 13 Oct: another practice is on this field at that time. The earlier start proposed ' +
        'for it (16:50 to 17:50) would overlap one that ends 17:00. It is kept as scheduled and flagged.'
    );
    for (const sentence of sentences) {
      expect(sentence).toMatch(/another practice is on this field at that time/);
      expect(sentence).not.toMatch(/sunset|after the latest/i);
    }
    expect(
      describeVerdict(
        OUTLOOK_VERDICT.FLAGGED,
        {
          flagged: 2,
          overlapOnly: 2,
          firstFlaggedDate: '2026-10-13',
          unknown: 0,
          firstPhaseDate: null,
        },
        ctx.day
      )
    ).toEqual({
      key: 'flagged',
      label: 'Flagged on 2 dates',
      tone: 'warning',
      headline:
        'On 2 dates another practice is on the field at the time its earlier start needs, the ' +
        'first being Tue 13 Oct. Those dates are kept as scheduled and flagged.',
    });
  });

  it('past sunset as well: the overlap is still the reason, and the sunset is added to it', () => {
    const entries = flaggedOfB(
      scheduleFor({
        '2026-10-06': 17 * 60 + 50,
        '2026-10-13': 17 * 60 + 40,
        '2026-10-20': 17 * 60 + 50,
      })
    );
    const first = entries.find((e) => e.date === '2026-10-13');
    expect(first.startMinutes + first.durationMinutes).toBeGreaterThan(first.limitMinutes);
    expect(describeFlaggedDate(first, ctx)).toBe(
      'Tue 13 Oct: another practice is on this field at that time. The earlier start proposed ' +
        'for it (16:50 to 17:50) would overlap one that ends 17:00. It also ends after the latest ' +
        'it may end (17:40). It is kept as scheduled and flagged.'
    );
  });

  it('a mix of both is counted apart in the verdict', () => {
    expect(
      describeVerdict(
        OUTLOOK_VERDICT.FLAGGED,
        {
          flagged: 3,
          overlapOnly: 1,
          firstFlaggedDate: '2026-10-06',
          unknown: 0,
          firstPhaseDate: null,
        },
        ctx.day
      ).headline
    ).toBe(
      'It is flagged on 3 dates: 2 dates that no shortening or earlier start keeps inside ' +
        'daylight and 1 date where another practice is on the field at that time. The first is ' +
        'Tue 6 Oct. Those dates are kept as scheduled and flagged.'
    );
  });
});

describe('the smaller sentences', () => {
  it('names each cause of an unknown sunset, in words', () => {
    expect(
      describeUnknown({
        dates: 1,
        causes: [{ venue: 'Far Park', cause: 'sunset-not-computable' }],
      })
    ).toBe(
      'Sunset unknown on 1 date: no sunset can be computed for Far Park on some dates. It cannot ' +
        'be shown to end by sunset, so it is flagged and never read as fine.'
    );
    expect(describeUnknown({ dates: 2, causes: [] })).toBe(
      'Sunset unknown on 2 dates: no sunset is known there. It cannot be shown to end by sunset, ' +
        'so it is flagged and never read as fine.'
    );
  });

  it('says so when the season has no school-day end, instead of inventing one', () => {
    expect(
      describeRules({
        minimumDurationMinutes: 40,
        durationStepMinutes: 10,
        earliestStartMinutes: null,
        earliestStartDays: 'Monday and Tuesday',
      })
    ).toBe(
      'Each slot is shortened first, in 10-minute steps to no less than 40 minutes. The season has ' +
        'no school-day end set, so starting earlier is not proposed. There is no setting to choose ' +
        'another approach per slot, and permits, field size and capacity are not checked.'
    );
  });

  it('counts slots, dates and lit slots in one sentence', () => {
    const day = dayFormatterFor({ from: '2026-09-01', to: '2026-11-30' });
    expect(
      describeSummary(
        { slots: 1, dates: 1, litSlots: 0 },
        { from: '2026-09-01', to: '2026-11-30' },
        ZONE,
        day
      )
    ).toBe(
      '1 practice slot on unlit ground, 1 practice date from Tue 1 Sep to Mon 30 Nov (America/New_York).'
    );
  });

  it('formats a half-field and a field alike, from the rows', () => {
    expect(rowOf(ID.exempt).ground).toBe('Field 2 A (Central Park)');
    expect(rowOf(ID.ok).ground).toBe('Field 1 (Central Park)');
  });
});

describe('the vocabulary: a sunset condition is a warning, never a refusal', () => {
  const everyString = (value, found = []) => {
    if (typeof value === 'string') found.push(value);
    else if (Array.isArray(value)) value.forEach((v) => everyString(v, found));
    else if (value && typeof value === 'object')
      Object.values(value).forEach((v) => everyString(v, found));
    return found;
  };
  const NEVER = /\b(blocked|refused|refuse|refusal|lost|held out|hold-out|time tbd|truncat)/i;

  it('says nothing of a practice that is blocked, refused, lost or held out', () => {
    const strings = everyString(outlook);
    expect(strings.length).toBeGreaterThan(80);
    expect(strings.filter((text) => NEVER.test(text))).toEqual([]);
    // ... the one place those words appear is the banner, to say it is never so.
    expect(NEVER.test(OUTLOOK_BANNER)).toBe(true);
    expect(OUTLOOK_BANNER).toMatch(/never blocked/);
  });

  it('can fail: the check finds the words in a sentence that uses them', () => {
    expect(NEVER.test('Wed 4 Nov: the practice is blocked until it ends by sunset.')).toBe(true);
    expect(NEVER.test('Starting at 15:50 is refused by the school-day floor.')).toBe(true);
  });

  it('says every flagged date is kept as scheduled and flagged', () => {
    const flagged = outlook.rows.flatMap((r) => r.flagged?.items ?? []);
    expect(flagged.length).toBe(6);
    for (const item of flagged) expect(item.text).toMatch(/kept as scheduled and flagged/);
    for (const row of outlook.rows.filter((r) => r.verdict.key === 'flagged')) {
      expect(row.verdict.headline).toMatch(/kept as scheduled and flagged/);
    }
  });
});
