/**
 * `fieldAdmin/consequences.js` — the reading behind 8.4 PR 3's two acceptance
 * criteria.
 *
 * Three things are checked here and they are different in kind:
 *
 *  1. **The date arithmetic**, against values stated in this file rather than
 *     computed by the code under test. `Date` is banned in `packages/core`, so
 *     the weekday and round-trip cases are the only thing standing between the
 *     module and an off-by-one that no environment would ever reveal.
 *  2. **The conflict reading**, with a positive control for every assertion
 *     that could otherwise pass on an empty universe. A run reporting
 *     `conflictsFound: 0` must be distinguishable from a run that compared
 *     nothing, so every case asserts `meta.pairsCompared` too.
 *  3. **The reason vocabulary, on three arms**, each compared with the literal
 *     stated below and never with each other. The migration's CHECK, the mock
 *     client's guard and the module's exported list are three separate
 *     statements of one set; PR 2's rounds established that comparing two arms
 *     with each other lets an identical defect in both pass unseen.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import {
  BLACKOUT_DB_REASON,
  CLOSURE_SOURCE,
  ISO_DAY_NAMES,
  findBlackoutConflicts,
  fromDayNumber,
  isoDayOfWeek,
  isoDayOfWeekName,
  minuteWindowsOverlap,
  repairProposal,
  toDayNumber,
} from '@squadlogic/core/fieldAdmin/index.js';
import { FIELD_ADMIN_REASON, FIELD_ADMIN_SEVERITY } from '@squadlogic/core/fieldAdmin/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The six reasons, stated here and nowhere else in this file. Every arm below
 * is compared with THIS, so two arms carrying the same wrong set still fail.
 */
const THE_SIX = ['maintenance', 'weather', 'event', 'permit', 'closed', 'other'];

const closure = (overrides = {}) => ({
  id: 'c1',
  source: CLOSURE_SOURCE.ADMIN,
  closesFieldId: 'field-1',
  closesLocationId: null,
  blackoutFrom: '2026-09-14',
  blackoutUntil: '2026-09-18',
  startMinutes: null,
  endMinutes: null,
  ...overrides,
});

const game = (overrides = {}) => ({
  kind: 'game',
  id: 'g1',
  fieldId: 'field-1',
  label: 'U12 Red v U12 Blue',
  onDate: '2026-09-16',
  startMinutes: 16 * 60,
  endMinutes: 17 * 60,
  ...overrides,
});

const practice = (overrides = {}) => ({
  kind: 'practice',
  id: 'p1',
  fieldId: 'field-1',
  label: 'U12 Red practice',
  dayOfWeek: 3,
  startMinutes: 16 * 60,
  endMinutes: 17 * 60,
  validFrom: '2026-08-01',
  validUntil: '2026-11-30',
  ...overrides,
});

const FIELDS = [
  { id: 'field-1', locationId: 'loc-1' },
  { id: 'field-2', locationId: 'loc-1' },
  { id: 'field-3', locationId: 'loc-2' },
];

const run = (overrides = {}) =>
  findBlackoutConflicts({ closures: [], fields: FIELDS, dated: [], recurring: [], ...overrides });

describe('consequences :: dates without a Date', () => {
  it('reads the ISO weekday of dates whose weekday is stated here', () => {
    // Stated, not derived. A table computed from the module would agree with
    // any consistent off-by-one the module happens to carry.
    const KNOWN = /** @type {Array<[string, number]>} */ ([
      ['1970-01-01', 4], // Thursday, day number 0 — the anchor the formula uses
      ['2026-09-14', 1], // Monday
      ['2026-09-16', 3], // Wednesday
      ['2026-09-20', 7], // Sunday
      ['2024-02-29', 4], // Thursday, a leap day
      ['2026-03-01', 7], // Sunday, the day after a non-leap February
      ['1999-12-31', 5], // Friday
    ]);
    expect(KNOWN.length).toBeGreaterThan(0);
    for (const [iso, dow] of KNOWN) {
      expect([iso, isoDayOfWeek(iso)]).toEqual([iso, dow]);
    }
  });

  it('round-trips a day number through both directions across a leap boundary', () => {
    const DATES = ['2024-02-28', '2024-02-29', '2024-03-01', '2026-01-01', '2026-12-31'];
    for (const iso of DATES) {
      expect(fromDayNumber(toDayNumber(iso))).toBe(iso);
    }
    // Consecutive dates are consecutive day numbers — the property the weekly
    // step in findBlackoutConflicts() depends on.
    expect(toDayNumber('2024-03-01') - toDayNumber('2024-02-29')).toBe(1);
    expect(toDayNumber('2024-02-29') - toDayNumber('2024-02-28')).toBe(1);
  });

  it('names a practice day column value, and refuses one it should not hold', () => {
    expect(ISO_DAY_NAMES.map(isoDayOfWeekName)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(isoDayOfWeekName('Wednesday')).toBe(3);
    // **Null is a refusal, never a zero.** A caller reading an unknown day as
    // Monday would report conflicts on ground nobody booked.
    for (const bad of ['', 'xyz', null, undefined, 7]) {
      expect(isoDayOfWeekName(/** @type {any} */ (bad))).toBeNull();
    }
  });
});

describe('consequences :: minute windows', () => {
  it('treats a null pair on either side as the whole day', () => {
    expect(
      minuteWindowsOverlap(
        { startMinutes: null, endMinutes: null },
        { startMinutes: 0, endMinutes: 1 }
      )
    ).toBe(true);
    expect(
      minuteWindowsOverlap(
        { startMinutes: 0, endMinutes: 1 },
        { startMinutes: null, endMinutes: null }
      )
    ).toBe(true);
  });

  it('does not overlap on touching ends, matching bookingsOverlapInTime()', () => {
    const a = { startMinutes: 960, endMinutes: 1020 }; // 16:00–17:00
    expect(minuteWindowsOverlap(a, { startMinutes: 1020, endMinutes: 1080 })).toBe(false);
    expect(minuteWindowsOverlap(a, { startMinutes: 900, endMinutes: 960 })).toBe(false);
    expect(minuteWindowsOverlap(a, { startMinutes: 1019, endMinutes: 1080 })).toBe(true);
  });
});

describe('consequences :: what a blackout closes', () => {
  it('reports a dated game inside the window, and counts what it compared', () => {
    const { findings, meta } = run({ closures: [closure()], dated: [game()] });
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe(FIELD_ADMIN_REASON.BLACKOUT_BLOCKS_BOOKING);
    expect(findings[0].severity).toBe(FIELD_ADMIN_SEVERITY.BLOCKING);
    expect(findings[0].details).toMatchObject({
      bookingKind: 'game',
      bookingId: 'g1',
      firstDate: '2026-09-16',
      occurrences: 1,
      timesKnown: true,
    });
    // **The meta-assertion.** Without it, a run that examined nothing reports
    // the same empty list as a run that found nothing.
    expect(meta.pairsCompared).toBe(1);
    expect(meta.conflictsFound).toBe(1);
  });

  it('leaves a game outside the date window alone — and proves it compared it', () => {
    const { findings, meta } = run({
      closures: [closure()],
      dated: [game({ onDate: '2026-09-19' })],
    });
    expect(findings).toEqual([]);
    // The positive control for the assertion above: the pair WAS compared, so
    // the empty list is an answer rather than an absence.
    expect(meta.pairsCompared).toBe(1);
    expect(meta.conflictsFound).toBe(0);
  });

  it('is inclusive on both ends of the date range', () => {
    for (const onDate of ['2026-09-14', '2026-09-18']) {
      expect(run({ closures: [closure()], dated: [game({ onDate })] }).findings).toHaveLength(1);
    }
    for (const onDate of ['2026-09-13', '2026-09-19']) {
      expect(run({ closures: [closure()], dated: [game({ onDate })] }).findings).toEqual([]);
    }
  });

  it('honours a timed closure against a timed booking on the same date', () => {
    const timed = closure({ startMinutes: 17 * 60, endMinutes: 19 * 60 });
    // 16:00–17:00 ends exactly as the closure opens: not a conflict.
    expect(run({ closures: [timed], dated: [game()] }).findings).toEqual([]);
    // 16:30–17:30 crosses it.
    expect(
      run({
        closures: [timed],
        dated: [game({ startMinutes: 16 * 60 + 30, endMinutes: 17 * 60 + 30 })],
      }).findings
    ).toHaveLength(1);
  });

  it('reports a booking whose clock cannot be read, and says so rather than dropping it', () => {
    const { findings, meta } = run({
      closures: [closure({ startMinutes: 17 * 60, endMinutes: 19 * 60 })],
      dated: [game({ startMinutes: null, endMinutes: null })],
    });
    // `public.field_bookings` counts an undated slot as affected rather than
    // omitting it; an unclocked booking gets the same treatment here.
    expect(findings).toHaveLength(1);
    expect(findings[0].details.timesKnown).toBe(false);
    expect(meta.bookingsWithoutTimes).toBe(1);
  });

  it('counts recurring occurrences without walking the range', () => {
    // 2026-09-14 is a Monday, so the Wednesdays in 09-14..09-18 are one.
    const one = run({ closures: [closure()], recurring: [practice()] });
    expect(one.findings[0].details).toMatchObject({
      firstDate: '2026-09-16',
      occurrences: 1,
      bookingKind: 'practice',
    });

    // Three whole weeks hold three Wednesdays.
    const three = run({
      closures: [closure({ blackoutFrom: '2026-09-14', blackoutUntil: '2026-10-04' })],
      recurring: [practice()],
    });
    expect(three.findings[0].details).toMatchObject({
      firstDate: '2026-09-16',
      occurrences: 3,
    });
  });

  it('clips a recurring booking to its own validity window', () => {
    // The slot stops before the closure opens: nothing recurs inside it.
    const { findings, meta } = run({
      closures: [closure()],
      recurring: [practice({ validUntil: '2026-09-01' })],
    });
    expect(findings).toEqual([]);
    expect(meta.pairsCompared).toBe(1);

    // An open-ended slot is bounded by the closure alone.
    expect(
      run({
        closures: [closure()],
        recurring: [practice({ validFrom: null, validUntil: null })],
      }).findings
    ).toHaveLength(1);
  });

  it('reaches every surface of a venue-scoped closure, and no surface of another venue', () => {
    const venueWide = closure({ closesFieldId: null, closesLocationId: 'loc-1' });
    const { findings, meta } = run({
      closures: [venueWide],
      dated: [
        game({ id: 'on-field-1', fieldId: 'field-1' }),
        game({ id: 'on-field-2', fieldId: 'field-2' }),
        game({ id: 'other-venue', fieldId: 'field-3' }),
      ],
    });
    expect(findings.map((f) => f.details.bookingId).sort()).toEqual(['on-field-1', 'on-field-2']);
    // The third pair was rejected by SCOPE, before any date was read, so it is
    // correctly absent from the compared count.
    expect(meta.pairsCompared).toBe(2);
    expect(meta.fieldsKnown).toBe(3);
  });

  it('does not claim a field the registry does not hold', () => {
    // **The subject set comes from the registry, never from the bookings.** A
    // booking on ground the field list has lost is not silently folded into the
    // venue's closure — it is left unreported, and `fieldsKnown` says how much
    // ground the run actually knew about.
    const { findings, meta } = findBlackoutConflicts({
      closures: [closure({ closesFieldId: null, closesLocationId: 'loc-1' })],
      fields: [],
      dated: [game()],
      recurring: [],
    });
    expect(findings).toEqual([]);
    expect(meta.fieldsKnown).toBe(0);
    expect(meta.pairsCompared).toBe(0);
  });

  it('reads a half-specified booking clock as no clock, on both booking kinds', () => {
    // **Review finding.** `game_slots.start_time` and `end_time` are
    // independently nullable, and `minuteWindowsOverlap` reads a single null as
    // ALL DAY -- so a 09:00 slot with no end time was a BLOCKING conflict
    // against an 18:00-20:00 closure it does not touch, reported with
    // `timesKnown: true` because that flag looked only at the start.
    const evening = closure({ startMinutes: 18 * 60, endMinutes: 20 * 60 });

    const halfOpen = run({
      closures: [evening],
      dated: [game({ startMinutes: 9 * 60, endMinutes: null })],
    });
    // It is still reported -- a booking whose clock cannot be read is judged on
    // its date, as `public.field_bookings` judges an undated slot -- but it no
    // longer claims to have compared times.
    expect(halfOpen.findings).toHaveLength(1);
    expect(halfOpen.findings[0].details.timesKnown).toBe(false);
    expect(halfOpen.meta.bookingsWithoutTimes).toBe(1);

    // The positive control: a FULLY specified 09:00-10:00 slot is left alone.
    expect(
      run({
        closures: [evening],
        dated: [game({ startMinutes: 9 * 60, endMinutes: 10 * 60 })],
      }).findings
    ).toEqual([]);

    // The same on the recurring arm.
    const recurringHalf = run({
      closures: [evening],
      recurring: [practice({ startMinutes: null, endMinutes: 10 * 60 })],
    });
    expect(recurringHalf.findings).toHaveLength(1);
    expect(recurringHalf.findings[0].details.timesKnown).toBe(false);
  });

  it('counts timeless bookings in bookings, not in closure pairs', () => {
    // **Review finding.** The counter was incremented inside the per-closure
    // loop, so one timeless booking against three closures reported 3 -- a
    // number the docblock sells as proof of what was examined, reading as a
    // booking count and being something else.
    const { meta } = run({
      closures: [
        closure({ id: 'c1' }),
        closure({ id: 'c2' }),
        closure({ id: 'c3', blackoutFrom: '2027-01-01', blackoutUntil: '2027-01-02' }),
      ],
      dated: [game({ startMinutes: null, endMinutes: null })],
    });
    expect(meta.bookingsWithoutTimes).toBe(1);
    // The anchor: three pairs really were compared, so the 1 above is a
    // different unit rather than a smaller loop.
    expect(meta.pairsCompared).toBe(3);
  });

  it('carries the source so an import-derived closure is distinguishable', () => {
    const { findings } = run({
      closures: [closure({ source: CLOSURE_SOURCE.IMPORT })],
      dated: [game()],
    });
    expect(findings[0].details.closureSource).toBe(CLOSURE_SOURCE.IMPORT);
  });

  it('refuses a closure row the database could not hold', () => {
    expect(() => run({ closures: [closure({ blackoutUntil: '2026-09-01' })] })).toThrow(
      /blackoutUntil/
    );
    expect(() => run({ closures: [closure({ startMinutes: 60, endMinutes: null })] })).toThrow(
      /both-or-neither/
    );
    // `fieldLocationId` is the view's OTHER column and is never a scope; the
    // schema is strict so it cannot be passed in by mistake.
    expect(() => run({ closures: [{ ...closure(), fieldLocationId: 'loc-1' }] })).toThrow();
  });
});

describe('consequences :: the repair that does not exist', () => {
  it('names its unavailability instead of returning an empty proposal', () => {
    const proposal = repairProposal({ affectedCount: 3 });
    expect(proposal.available).toBe(false);
    expect(proposal.finding.code).toBe(FIELD_ADMIN_REASON.REPAIR_PROPOSAL_UNAVAILABLE);
    expect(proposal.finding.severity).toBe(FIELD_ADMIN_SEVERITY.COMPROMISE);
    expect(proposal.finding.details).toEqual({ affectedCount: 3, blockedOn: '8.6' });
    // The message has to say the thing a blank panel would not: that silence
    // here is not the same as "no repair is needed".
    expect(proposal.finding.message).toMatch(/not a statement that no repair is needed/i);
  });
});

describe('consequences :: the reason vocabulary, on three arms', () => {
  it('exports exactly the six this file states', () => {
    expect([...BLACKOUT_DB_REASON]).toEqual(THE_SIX);
  });

  it('matches the CHECK constraint in the migration', () => {
    const sql = readFileSync(
      path.join(ROOT, 'supabase/migrations/20260906000100_field_blackouts.sql'),
      'utf8'
    );
    const match = sql.match(/CHECK \(reason IN \(([^)]*)\)\)/);
    // Meta-assertion: a migration this failed to parse would make the
    // comparison below vacuous, which is the whole failure mode this file is
    // written against.
    expect(match).not.toBeNull();
    const fromSql = /** @type {RegExpMatchArray} */ (match)[1]
      .split(',')
      .map((cell) => cell.trim().replace(/^'|'$/g, ''));
    expect(fromSql).toEqual(THE_SIX);
  });

  it('matches the guard the mock client applies', () => {
    const source = readFileSync(path.join(ROOT, 'frontend/src/lib/mockSupabaseClient.js'), 'utf8');
    const match = source.match(/const REASONS = \[([^\]]*)\]/);
    expect(match).not.toBeNull();
    const fromMock = /** @type {RegExpMatchArray} */ (match)[1]
      .split(',')
      .map((cell) => cell.trim().replace(/^'|'$/g, ''))
      .filter(Boolean);
    expect(fromMock).toEqual(THE_SIX);
  });
});
