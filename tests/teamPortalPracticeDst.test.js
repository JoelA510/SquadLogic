/**
 * The team portal places a practice on the season clock, date by date, as the
 * calendar feed does (found in PR #607; the remediation plan's "Discovered
 * during execution").
 *
 * A weekly Sunday 02:30 series over [2026-03-01, 2026-03-29) in
 * America/Los_Angeles crosses the spring-forward date, 03-08, when 02:30 does
 * not exist. The feed put 03-01, 03-15 and 03-22 on the calendar and reported
 * 03-08 as TIME TBD (`WALL_TIME_NONEXISTENT`); `expandPractices` ignored the
 * zone ("not needed") and showed 03-08 at 02:30.
 *
 * **The subject set is the series' dates, walked on the UTC calendar from the
 * range** -- not the feed's or the portal's output -- and the parity test holds
 * the portal to the feed's actual `buildFeedEvents` output, event by event. The
 * wall reading of a feed instant is read back with `Intl`, which shares no code
 * with core's `resolveZonedInstant` or its Deno twin.
 */

import { describe, expect, it } from 'vitest';

import { PORTAL_TEAM_SELECT, expandPractices } from '../frontend/src/hooks/useTeamPortal.js';
import {
  PRACTICE_TIME_NOTE_CAUSES,
  PRACTICE_TIME_TBD_CAUSES,
  placePracticeTime,
} from '@squadlogic/core/timing/index.js';
import {
  NOTE_CAUSES,
  UNPLACEABLE_CAUSES,
  buildFeedEvents,
} from '../supabase/functions/_shared/calendar/icsFeed.ts';

const LA = 'America/Los_Angeles';

const SLOT = {
  day_of_week: 'sun',
  start_time: '02:30:00',
  end_time: '04:00:00',
  field: { name: 'Field A', location: { name: 'Test Park' } },
};

const portalRow = (id, range, slot = SLOT) => ({ id, effective_date_range: range, slot });
/** The feed's select embeds the slot as `practice_slots` with `fields`/`locations`. */
const feedRow = (id, range, slot = SLOT) => ({
  id,
  effective_date_range: range,
  practice_slots: {
    ...slot,
    fields: { name: slot.field.name, locations: { name: slot.field.location.name } },
  },
});

/** Every Sunday in [lower, upper), walked on the UTC calendar from the range alone. */
function sundaysIn(lower, upper) {
  const ms = (iso) => Date.parse(`${iso}T00:00:00Z`);
  const out = [];
  for (let t = ms(lower); t < ms(upper); t += 86_400_000) {
    if (new Date(t).getUTCDay() === 0) out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** `YYYYMMDDTHHMMSSZ` (the feed's DTSTART) to the wall `{date, time}` in `zone`, via Intl. */
function wallReading(icsInstant, zone) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(icsInstant);
  const at = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

const SPRING = '[2026-03-01,2026-03-29)';
const FALL = '[2026-10-25,2026-11-15)';

/** Both readers over one series; keyed by date. */
function bothReaders(range, timezone, slot = SLOT) {
  const portal = new Map(
    expandPractices([portalRow('pa-1', range, slot)], [], timezone).map((e) => [e.date, e])
  );
  const feed = new Map(
    buildFeedEvents({
      teamName: 'Tigers',
      timezone,
      practices: [feedRow('pa-1', range, slot)],
    }).map((e) => [e.kind === 'timed' ? wallReading(e.dtstart, timezone).date : e.date, e])
  );
  return { portal, feed };
}

describe('team portal: a practice is placed on the season clock per date', () => {
  it('meta: the spring series has four Sundays and 03-08 is the gap one', () => {
    expect(sundaysIn('2026-03-01', '2026-03-29')).toEqual([
      '2026-03-01',
      '2026-03-08',
      '2026-03-15',
      '2026-03-22',
    ]);
  });

  it('the spring-forward date is TIME TBD with its reason, not 02:30', () => {
    const events = expandPractices([portalRow('pa-1', SPRING)], [], LA);
    expect(events.map((e) => e.date)).toEqual(sundaysIn('2026-03-01', '2026-03-29'));

    const gap = events.find((e) => e.date === '2026-03-08');
    expect(gap).toMatchObject({
      type: 'practice',
      timeTbd: true,
      startTime: null,
      endTime: null,
      reasonCode: 'WALL_TIME_NONEXISTENT',
      reason: UNPLACEABLE_CAUSES.WALL_TIME_NONEXISTENT,
      description: 'TIME TBD - Practice',
      location: 'Test Park - Field A',
    });

    // Every other date keeps its wall time.
    for (const date of ['2026-03-01', '2026-03-15', '2026-03-22']) {
      expect(
        events.find((e) => e.date === date),
        date
      ).toMatchObject({
        startTime: '02:30:00',
        endTime: '04:00:00',
        description: 'Practice',
      });
      expect(events.find((e) => e.date === date).timeTbd, date).toBeUndefined();
    }
  });

  it('the fall-back date is placed at its wall time with the feed note, as the feed does', () => {
    const events = expandPractices(
      [portalRow('pa-1', FALL, { ...SLOT, start_time: '01:30:00', end_time: '03:00:00' })],
      [],
      LA
    );
    expect(events.map((e) => e.date)).toEqual(['2026-10-25', '2026-11-01', '2026-11-08']);
    for (const e of events) expect(e.timeTbd, e.date).toBeUndefined();

    const ambiguous = events.find((e) => e.date === '2026-11-01');
    expect(ambiguous).toMatchObject({ startTime: '01:30:00', endTime: '03:00:00' });
    expect(ambiguous.timingNotes).toEqual([NOTE_CAUSES.WALL_TIME_AMBIGUOUS]);
    // Ordinary dates carry no note.
    expect(events.find((e) => e.date === '2026-10-25').timingNotes).toBeUndefined();
  });

  it('an ordinary date keeps its wall time and carries no note', () => {
    const [only] = expandPractices(
      [
        portalRow('pa-1', '[2026-05-03,2026-05-04)', {
          ...SLOT,
          start_time: '17:00:00',
          end_time: '18:30:00',
        }),
      ],
      [],
      LA
    );
    expect(only).toMatchObject({ date: '2026-05-03', startTime: '17:00:00', endTime: '18:30:00' });
    expect(only.timeTbd).toBeUndefined();
    expect(only.timingNotes).toBeUndefined();
  });

  it('control: a zone with no daylight saving shows every date at 02:30', () => {
    const events = expandPractices([portalRow('pa-1', SPRING)], [], 'America/Phoenix');
    expect(events).toHaveLength(4);
    for (const e of events) {
      expect(e, e.date).toMatchObject({ startTime: '02:30:00', endTime: '04:00:00' });
      expect(e.timeTbd, e.date).toBeUndefined();
    }
  });

  it('no timezone, or an unknown one, makes every date TIME TBD with the feed reason', () => {
    for (const [zone, code] of [
      [null, 'SEASON_TIMEZONE_MISSING'],
      [undefined, 'SEASON_TIMEZONE_MISSING'],
      ['Mars/Olympus_Mons', 'SEASON_TIMEZONE_UNKNOWN'],
    ]) {
      const events = expandPractices([portalRow('pa-1', SPRING)], [], zone);
      expect(events, String(zone)).toHaveLength(4);
      for (const e of events) {
        expect(e, `${zone} ${e.date}`).toMatchObject({
          timeTbd: true,
          reasonCode: code,
          reason: UNPLACEABLE_CAUSES[code],
        });
      }
    }
  });

  it('a moved practice whose new time does not exist that date is TIME TBD too', () => {
    const exceptions = [
      {
        id: 'ex-1',
        assignment_id: 'pa-1',
        window: '[2026-03-08,2026-03-09)',
        kind: 'relocated',
        tbd_reason: null,
        cause_kind: 'field-change',
        withdrawn_at: null,
        slot: {
          day_of_week: 'sun',
          start_time: '02:15:00',
          end_time: '03:45:00',
          field: { name: 'Field B', location: { name: 'Other Park' } },
        },
      },
    ];
    const events = expandPractices([portalRow('pa-1', SPRING)], exceptions, LA);
    const moved = events.find((e) => e.date === '2026-03-08');
    expect(moved).toMatchObject({
      timeTbd: true,
      reasonCode: 'WALL_TIME_NONEXISTENT',
      location: 'Other Park - Field B',
      exceptionId: 'ex-1',
    });
    // It still says it was moved, and from where.
    expect(moved.kind).toBe('relocated');
    expect(moved.movedFrom).toMatchObject({ dayOfWeek: 'sun', startTime: '02:30:00' });
  });

  it("asks for the season timezone with the team (the hook's read)", () => {
    const season = /season:season_settings \(([^)]*)\)/.exec(PORTAL_TEAM_SELECT);
    expect(season, 'the team select embeds the season').not.toBeNull();
    expect(season[1]).toMatch(/\btimezone\b/);
  });

  it("wording is the feed's, code for code", () => {
    for (const [code, cause] of Object.entries(PRACTICE_TIME_TBD_CAUSES)) {
      expect(cause, code).toBe(UNPLACEABLE_CAUSES[code]);
    }
    for (const [code, cause] of Object.entries(PRACTICE_TIME_NOTE_CAUSES)) {
      expect(cause, code).toBe(NOTE_CAUSES[code]);
    }
    // A fall-back-night slot with an unreadable end is refused for the end, not the ambiguity.
    const refused = placePracticeTime({
      date: '2026-11-01',
      startTime: '01:30:00',
      endTime: 'not a time',
      timeZone: LA,
    });
    expect(refused).toMatchObject({ placed: false, code: 'WALL_TIME_UNREADABLE' });
  });
});

describe('team portal and calendar feed agree, date by date', () => {
  /** @type {Array<[string, string, string|null, typeof SLOT]>} */
  const cases = [
    ['spring-forward series in America/Los_Angeles', SPRING, LA, SLOT],
    [
      'fall-back series in America/Los_Angeles',
      FALL,
      LA,
      { ...SLOT, start_time: '01:30:00', end_time: '03:00:00' },
    ],
    ['spring series, no-DST zone control', SPRING, 'America/Phoenix', SLOT],
    ['spring series, no timezone', SPRING, null, SLOT],
  ];

  for (const [name, range, zone, slot] of cases) {
    it(name, () => {
      const [lower, upper] = /^\[([^,]+),([^)]+)\)$/.exec(range).slice(1);
      const expectedDates = sundaysIn(lower, upper);
      const { portal, feed } = bothReaders(range, zone, slot);

      // Meta: both readers produced the whole series (a reader that dropped a date cannot pass).
      expect([...portal.keys()].sort()).toEqual(expectedDates);
      expect([...feed.keys()].sort()).toEqual(expectedDates);

      for (const date of expectedDates) {
        const p = portal.get(date);
        const f = feed.get(date);
        if (f.kind === 'timed') {
          expect(p.timeTbd, `${date} portal timed`).toBeUndefined();
          // The feed's instant, read back on the wall, is the time the portal shows.
          expect(wallReading(f.dtstart, zone), date).toEqual({ date, time: p.startTime });
          expect(wallReading(f.dtend, zone), date).toEqual({ date, time: p.endTime });
          expect(p.timingNotes ?? [], date).toEqual(f.notes.map((code) => NOTE_CAUSES[code]));
        } else {
          expect(p.timeTbd, `${date} portal TIME TBD`).toBe(true);
          expect(p.reasonCode, date).toBe(f.code);
          expect(p.reason, date).toBe(UNPLACEABLE_CAUSES[f.code]);
        }
      }
    });
  }

  it('meta: the spring case has a TIME TBD date and the fall case a noted one in the feed', () => {
    const spring = bothReaders(SPRING, LA).feed;
    expect([...spring.values()].filter((e) => e.kind === 'unplaceable').map((e) => e.date)).toEqual(
      ['2026-03-08']
    );
    const fall = bothReaders(FALL, LA, {
      ...SLOT,
      start_time: '01:30:00',
      end_time: '03:00:00',
    }).feed;
    expect(/** @type {any} */ (fall.get('2026-11-01')).notes).toEqual(['WALL_TIME_AMBIGUOUS']);
  });
});
