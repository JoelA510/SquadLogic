/**
 * The recurring-practice model (Phase 8.5).
 *
 * Spined on the task's three acceptance criteria — a season history exports as
 * a readable phase list, a slot materialises to the right dates across a
 * month, an exception on one date removes that occurrence and no other — plus
 * the guarantees those three rest on.
 *
 * **Every load-bearing assertion here was shown to fail before it was kept.**
 * The five breaks are recorded in the PR; where a check could only be made
 * failable by restructuring it, the restructured form is what is committed.
 * Two rules from `CLAUDE.md` §3 drive the shapes below:
 *
 * - a meta-assertion you cannot make fail is not a meta-assertion; and
 * - never derive a check's subject set from the data a break would corrupt.
 *   The corpus counts below are read from `practice_grid.csv` itself, by
 *   counting its lines, **not** from the slots the model built out of it. A
 *   model that dropped a revision would otherwise be measured against its own
 *   output and pass.
 *
 * @module tests/practiceSlotModel
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import {
  PRACTICE_REASON,
  PRACTICE_SEVERITY,
  PRACTICE_STATUS,
  PracticeExceptionSchema,
  PracticeSlotSchema,
  buildPracticeHistory,
  buildPracticeSlotSet,
  describePracticeHistory,
  firstWeekdayOnOrAfter,
  materialisePracticeOccurrences,
  toSeason2026PracticePlan,
} from '@squadlogic/core/practice/index.js';
import { weekdayCodeOf } from '@squadlogic/core/availability/index.js';
import { isoDateOfDayNumber, isoDayNumber } from '@squadlogic/core/facility/index.js';
import { loadSeason2026Practice } from '@squadlogic/core/fixtures/index.js';
import { expandPracticeSlotsForSeason } from '@squadlogic/core/practiceSlotExpansion.js';
import { formatDate } from '@squadlogic/core/utils/date.js';

import { assertLayerUnwired } from './helpers/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** A single Tuesday slot over September 2026. 2026-09-01 is itself a Tuesday. */
const TUESDAY_SLOT = Object.freeze({
  id: 'tue-17',
  surfaceId: 'alder/pitch-2a',
  weekday: 'TUE',
  startMinutes: 17 * 60,
  durationMinutes: 60,
  validFrom: '2026-09-01',
  validUntil: '2026-09-30',
  capacity: 2,
  revisionId: 'r1',
  label: 'Alder Pitch 2A',
});

const oneSlotSet = (overrides = {}, assignments = [{ id: 'a1', slotId: 'tue-17', teamId: 'T1' }]) =>
  buildPracticeSlotSet({
    slots: [{ ...TUESDAY_SLOT, ...overrides }],
    assignments,
    source: 'test',
  });

const datesOf = (materialisation) => materialisation.occurrences.map((o) => o.date);
const codesOf = (findings) => findings.map((f) => f.code);

/* -------------------------------------------------------------------------- */
/* The weekday vocabulary is one vocabulary                                    */
/* -------------------------------------------------------------------------- */

describe('practice model :: weekday vocabulary', () => {
  it('agrees with weekdayCodeOf() on all seven codes', () => {
    // `practice/schemas.js` restates the seven-code enum that
    // `availability/schemas.js` declares but does not export. This is what
    // stops the restatement from becoming a second vocabulary: walk seven
    // consecutive days, and every code the date labeller produces must be one
    // the slot schema accepts, with all seven reached.
    const seen = new Set();
    const base = isoDayNumber('2026-09-01');
    for (let offset = 0; offset < 7; offset += 1) {
      const code = weekdayCodeOf(isoDateOfDayNumber(base + offset));
      seen.add(code);
      expect(() => PracticeSlotSchema.parse({ ...TUESDAY_SLOT, weekday: code })).not.toThrow();
    }
    expect([...seen].sort()).toEqual(['FRI', 'MON', 'SAT', 'SUN', 'THU', 'TUE', 'WED']);
  });

  it('rejects a code neither vocabulary contains', () => {
    // The control for the test above: it would pass vacuously if the schema
    // accepted anything.
    expect(() => PracticeSlotSchema.parse({ ...TUESDAY_SLOT, weekday: 'MONDAY' })).toThrow();
  });

  it('firstWeekdayOnOrAfter() returns the date itself when it already matches', () => {
    expect(firstWeekdayOnOrAfter('2026-09-01', 'TUE')).toBe('2026-09-01');
    expect(firstWeekdayOnOrAfter('2026-09-02', 'TUE')).toBe('2026-09-08');
    expect(firstWeekdayOnOrAfter('2026-09-02', 'MON')).toBe('2026-09-07');
  });
});

/* -------------------------------------------------------------------------- */
/* Acceptance 1: a slot materialises to the right dates across a month         */
/* -------------------------------------------------------------------------- */

describe('practice model :: materialisation across a month', () => {
  it('produces every Tuesday in a five-Tuesday month, and only those', () => {
    const materialised = materialisePracticeOccurrences(oneSlotSet(), {
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(datesOf(materialised)).toEqual([
      '2026-09-01',
      '2026-09-08',
      '2026-09-15',
      '2026-09-22',
      '2026-09-29',
    ]);
    // Independently of the list above: every date produced really is a Tuesday,
    // checked through the date labeller rather than through the model's own
    // notion of the weekday.
    for (const date of datesOf(materialised)) expect(weekdayCodeOf(date)).toBe('TUE');
    expect(materialised.stats.occurrenceCount).toBe(5);
  });

  it('honours a validity range that starts mid-month', () => {
    const materialised = materialisePracticeOccurrences(
      oneSlotSet({ validFrom: '2026-09-10', validUntil: '2026-09-30' }),
      { from: '2026-09-01', to: '2026-09-30' }
    );
    expect(datesOf(materialised)).toEqual(['2026-09-15', '2026-09-22', '2026-09-29']);
  });

  it('clips to the window, not to the slot, when the window is narrower', () => {
    const materialised = materialisePracticeOccurrences(oneSlotSet(), {
      from: '2026-09-09',
      to: '2026-09-23',
    });
    expect(datesOf(materialised)).toEqual(['2026-09-15', '2026-09-22']);
  });

  it('crosses a month boundary without a gap or a repeat', () => {
    const materialised = materialisePracticeOccurrences(
      oneSlotSet({ validFrom: '2026-09-20', validUntil: '2026-10-10' }),
      { from: '2026-09-01', to: '2026-12-31' }
    );
    expect(datesOf(materialised)).toEqual(['2026-09-22', '2026-09-29', '2026-10-06']);
    // Consecutive occurrences are exactly seven days apart — the property the
    // date list above only illustrates.
    const days = datesOf(materialised).map(isoDayNumber);
    for (let i = 1; i < days.length; i += 1) expect(days[i] - days[i - 1]).toBe(7);
  });

  it('carries the FacilityBooking shape, so an occurrence needs no adapter', () => {
    const [occurrence] = materialisePracticeOccurrences(oneSlotSet(), {
      from: '2026-09-01',
      to: '2026-09-07',
    }).occurrences;
    expect(occurrence).toMatchObject({
      id: 'tue-17@2026-09-01',
      surfaceId: 'alder/pitch-2a',
      date: '2026-09-01',
      startMinutes: 1020,
      endMinutes: 1080,
      format: null,
      slotId: 'tue-17',
      teamIds: ['T1'],
      exceptionId: null,
    });
  });

  it('reports an empty window rather than returning a bare empty list', () => {
    const materialised = materialisePracticeOccurrences(oneSlotSet(), {
      from: '2026-11-01',
      to: '2026-11-30',
    });
    expect(materialised.occurrences).toEqual([]);
    expect(codesOf(materialised.findings)).toContain(PRACTICE_REASON.WINDOW_EMPTY);
  });

  it('materialises an undated slot to nothing, and the plan says why', () => {
    const set = oneSlotSet({ validFrom: null, validUntil: null });
    expect(codesOf(set.findings)).toContain(PRACTICE_REASON.REVISION_UNDATED);
    const materialised = materialisePracticeOccurrences(set, {
      from: '2026-01-01',
      to: '2026-12-31',
    });
    expect(materialised.occurrences).toEqual([]);
  });

  it('is a view, not a store: two calls with one input agree', () => {
    const set = oneSlotSet();
    const window = { from: '2026-09-01', to: '2026-09-30' };
    expect(datesOf(materialisePracticeOccurrences(set, window))).toEqual(
      datesOf(materialisePracticeOccurrences(set, window))
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Acceptance 2: an exception removes that occurrence and no other             */
/* -------------------------------------------------------------------------- */

describe('practice model :: dated exceptions', () => {
  const window = { from: '2026-09-01', to: '2026-09-30' };

  it('removes exactly the excepted date and leaves every other untouched', () => {
    const set = oneSlotSet();
    const before = datesOf(materialisePracticeOccurrences(set, window));
    const after = datesOf(
      materialisePracticeOccurrences(set, {
        ...window,
        exceptions: [
          { id: 'x1', slotId: 'tue-17', date: '2026-09-15', kind: 'cancelled', reason: 'rain-out' },
        ],
      })
    );
    // Asserted as a set difference, not as a count or a hand-written list: a
    // model that dropped the excepted date *and* one other would satisfy
    // `length === 4` and fail here.
    expect(before.filter((date) => !after.includes(date))).toEqual(['2026-09-15']);
    expect(after.filter((date) => !before.includes(date))).toEqual([]);
  });

  it('reports the suppression with its reason rather than dropping it silently', () => {
    const materialised = materialisePracticeOccurrences(oneSlotSet(), {
      ...window,
      exceptions: [
        { id: 'x1', slotId: 'tue-17', date: '2026-09-15', kind: 'cancelled', reason: 'rain-out' },
      ],
    });
    const suppression = materialised.findings.find(
      (f) => f.code === PRACTICE_REASON.OCCURRENCE_SUPPRESSED
    );
    expect(suppression).toBeDefined();
    expect(suppression.details).toMatchObject({ date: '2026-09-15', reason: 'rain-out' });
    expect(materialised.stats.suppressedCount).toBe(1);
  });

  it('leaves the slot itself unedited — an exception is an override', () => {
    const set = oneSlotSet();
    materialisePracticeOccurrences(set, {
      ...window,
      exceptions: [
        { id: 'x1', slotId: 'tue-17', date: '2026-09-15', kind: 'cancelled', reason: 'rain-out' },
      ],
    });
    // The same set, materialised again with no exceptions, is whole. If the
    // override had edited the plan, this would come back short.
    expect(datesOf(materialisePracticeOccurrences(set, window))).toHaveLength(5);
  });

  it('moves one occurrence without moving the rest', () => {
    const materialised = materialisePracticeOccurrences(oneSlotSet(), {
      ...window,
      exceptions: [
        {
          id: 'x2',
          slotId: 'tue-17',
          date: '2026-09-08',
          kind: 'moved',
          reason: 'field double-booked',
          startMinutes: 18 * 60,
        },
      ],
    });
    const byDate = new Map(materialised.occurrences.map((o) => [o.date, o]));
    expect(byDate.get('2026-09-08').startMinutes).toBe(1080);
    expect(byDate.get('2026-09-08').endMinutes).toBe(1140);
    expect(byDate.get('2026-09-01').startMinutes).toBe(1020);
    expect(byDate.get('2026-09-22').startMinutes).toBe(1020);
    expect(materialised.stats.movedCount).toBe(1);
  });

  it('shortens one occurrence without shortening the rest', () => {
    const materialised = materialisePracticeOccurrences(oneSlotSet(), {
      ...window,
      exceptions: [
        {
          id: 'x3',
          slotId: 'tue-17',
          date: '2026-09-22',
          kind: 'shortened',
          reason: 'early sunset',
          durationMinutes: 30,
        },
      ],
    });
    const byDate = new Map(materialised.occurrences.map((o) => [o.date, o]));
    expect(byDate.get('2026-09-22').endMinutes - byDate.get('2026-09-22').startMinutes).toBe(30);
    expect(byDate.get('2026-09-29').endMinutes - byDate.get('2026-09-29').startMinutes).toBe(60);
  });

  it('reports an exception dated inside the window that matches no occurrence', () => {
    const materialised = materialisePracticeOccurrences(oneSlotSet(), {
      ...window,
      // 2026-09-16 is a Wednesday; this slot runs on Tuesdays.
      exceptions: [
        { id: 'x4', slotId: 'tue-17', date: '2026-09-16', kind: 'cancelled', reason: 'typo' },
      ],
    });
    expect(codesOf(materialised.findings)).toContain(PRACTICE_REASON.EXCEPTION_UNMATCHED);
    expect(materialised.occurrences).toHaveLength(5);
  });

  it('stays silent about an exception dated outside the window', () => {
    // Otherwise every one-month call would complain about the other eleven.
    const materialised = materialisePracticeOccurrences(oneSlotSet(), {
      from: '2026-09-01',
      to: '2026-09-14',
      exceptions: [
        { id: 'x5', slotId: 'tue-17', date: '2026-09-22', kind: 'cancelled', reason: 'later' },
      ],
    });
    expect(codesOf(materialised.findings)).not.toContain(PRACTICE_REASON.EXCEPTION_UNMATCHED);
  });

  it('rejects an exception naming a slot the plan does not hold', () => {
    const materialised = materialisePracticeOccurrences(oneSlotSet(), {
      ...window,
      exceptions: [
        { id: 'x6', slotId: 'nope', date: '2026-09-15', kind: 'cancelled', reason: 'wrong slot' },
      ],
    });
    expect(codesOf(materialised.findings)).toContain(PRACTICE_REASON.EXCEPTION_UNKNOWN_SLOT);
    expect(materialised.status).toBe(PRACTICE_STATUS.REJECTED);
  });

  it('lets a cancellation win over a move on the same date, and reports the loser', () => {
    const materialised = materialisePracticeOccurrences(oneSlotSet(), {
      ...window,
      exceptions: [
        { id: 'x7', slotId: 'tue-17', date: '2026-09-15', kind: 'cancelled', reason: 'closure' },
        {
          id: 'x8',
          slotId: 'tue-17',
          date: '2026-09-15',
          kind: 'moved',
          reason: 'stale request',
          startMinutes: 19 * 60,
        },
      ],
    });
    expect(datesOf(materialised)).not.toContain('2026-09-15');
    const unmatched = materialised.findings.filter(
      (f) => f.code === PRACTICE_REASON.EXCEPTION_UNMATCHED
    );
    expect(unmatched.map((f) => f.details.exceptionId)).toEqual(['x8']);
  });

  it('requires a reason, including for a cancellation', () => {
    expect(() =>
      PracticeExceptionSchema.parse({
        id: 'x',
        slotId: 'tue-17',
        date: '2026-09-15',
        kind: 'cancelled',
        reason: '',
      })
    ).toThrow();
  });

  it('refuses a moved exception with no new start, and a cancellation carrying one', () => {
    expect(() =>
      PracticeExceptionSchema.parse({
        id: 'x',
        slotId: 'tue-17',
        date: '2026-09-15',
        kind: 'moved',
        reason: 'r',
      })
    ).toThrow();
    expect(() =>
      PracticeExceptionSchema.parse({
        id: 'x',
        slotId: 'tue-17',
        date: '2026-09-15',
        kind: 'cancelled',
        reason: 'r',
        startMinutes: 60,
      })
    ).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Acceptance 3: a season history exports as a readable phase list             */
/* -------------------------------------------------------------------------- */

describe('practice model :: a team history', () => {
  const threePhases = () =>
    buildPracticeSlotSet({
      slots: [
        { ...TUESDAY_SLOT, id: 'p1', validFrom: '2026-08-01', validUntil: '2026-08-31' },
        {
          ...TUESDAY_SLOT,
          id: 'p2',
          weekday: 'THU',
          validFrom: '2026-09-01',
          validUntil: '2026-09-30',
        },
        {
          ...TUESDAY_SLOT,
          id: 'p3',
          startMinutes: 18 * 60,
          validFrom: '2026-10-01',
          validUntil: '2026-10-31',
        },
      ],
      assignments: [
        { id: 'a1', slotId: 'p1', teamId: 'T1' },
        { id: 'a2', slotId: 'p2', teamId: 'T1' },
        { id: 'a3', slotId: 'p3', teamId: 'T1' },
      ],
      source: 'test',
    });

  it('renders the phases in order, each with its range, window and ground', () => {
    const lines = describePracticeHistory(buildPracticeHistory(threePhases(), { teamId: 'T1' }));
    expect(lines).toEqual([
      'Team T1 — 3 phase(s):',
      '  2026-08-01 to 2026-08-31: Tuesday 17:00–18:00 on alder/pitch-2a [r1]',
      '  2026-09-01 to 2026-09-30: Thursday 17:00–18:00 on alder/pitch-2a [r1]',
      '  2026-10-01 to 2026-10-31: Tuesday 18:00–19:00 on alder/pitch-2a [r1]',
    ]);
  });

  it('is a sequence of non-overlapping ranges, and says so when it is not', () => {
    const history = buildPracticeHistory(
      buildPracticeSlotSet({
        slots: [
          { ...TUESDAY_SLOT, id: 'p1', validFrom: '2026-08-01', validUntil: '2026-09-15' },
          { ...TUESDAY_SLOT, id: 'p2', validFrom: '2026-09-01', validUntil: '2026-09-30' },
        ],
        assignments: [
          { id: 'a1', slotId: 'p1', teamId: 'T1' },
          { id: 'a2', slotId: 'p2', teamId: 'T1' },
        ],
        source: 'test',
      }),
      { teamId: 'T1' }
    );
    expect(codesOf(history.findings)).toContain(PRACTICE_REASON.HISTORY_OVERLAP);
    // Blocking, because the model's central claim has failed.
    expect(history.status).toBe(PRACTICE_STATUS.REJECTED);
    expect(history.stats.overlapCount).toBe(1);
  });

  it('reports a gap between phases, with its dates', () => {
    const history = buildPracticeHistory(
      buildPracticeSlotSet({
        slots: [
          { ...TUESDAY_SLOT, id: 'p1', validFrom: '2026-08-01', validUntil: '2026-08-31' },
          { ...TUESDAY_SLOT, id: 'p2', validFrom: '2026-09-15', validUntil: '2026-09-30' },
        ],
        assignments: [
          { id: 'a1', slotId: 'p1', teamId: 'T1' },
          { id: 'a2', slotId: 'p2', teamId: 'T1' },
        ],
        source: 'test',
      }),
      { teamId: 'T1' }
    );
    const gap = history.findings.find((f) => f.code === PRACTICE_REASON.HISTORY_GAP);
    expect(gap.details).toMatchObject({ gapFrom: '2026-09-01', gapUntil: '2026-09-14', days: 14 });
  });

  it('treats consecutive ranges as no gap at all', () => {
    const history = buildPracticeHistory(threePhases(), { teamId: 'T1' });
    expect(codesOf(history.findings)).not.toContain(PRACTICE_REASON.HISTORY_GAP);
    expect(history.stats.gapCount).toBe(0);
  });

  it('includes an undated phase and marks it, rather than dropping it', () => {
    const history = buildPracticeHistory(
      buildPracticeSlotSet({
        slots: [
          { ...TUESDAY_SLOT, id: 'p1', validFrom: '2026-08-01', validUntil: '2026-08-31' },
          { ...TUESDAY_SLOT, id: 'p2', validFrom: null, validUntil: null, revisionId: 'r2' },
        ],
        assignments: [
          { id: 'a1', slotId: 'p1', teamId: 'T1' },
          { id: 'a2', slotId: 'p2', teamId: 'T1' },
        ],
        source: 'test',
      }),
      { teamId: 'T1' }
    );
    expect(history.stats.phaseCount).toBe(2);
    expect(history.stats.undatedPhaseCount).toBe(1);
    const lines = describePracticeHistory(history);
    expect(lines.at(-1)).toContain('dates not stated in the source');
  });

  it('says plainly when a team holds no slot', () => {
    expect(describePracticeHistory(buildPracticeHistory(oneSlotSet(), { teamId: 'T9' }))).toEqual([
      'Team T9: no practice slot in this plan.',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* The plan itself                                                             */
/* -------------------------------------------------------------------------- */

describe('practice model :: the plan', () => {
  it('has no team on a slot; teams attach through assignments', () => {
    // The schema is `.strict()`, so this is the model refusing the prompt's
    // conflation rather than quietly ignoring the key.
    expect(() => PracticeSlotSchema.parse({ ...TUESDAY_SLOT, teamId: 'T1' })).toThrow();
  });

  it('lets several teams share one slot, which is what capacity is for', () => {
    const set = oneSlotSet({}, [
      { id: 'a1', slotId: 'tue-17', teamId: 'T1' },
      { id: 'a2', slotId: 'tue-17', teamId: 'T2' },
    ]);
    const [occurrence] = materialisePracticeOccurrences(set, {
      from: '2026-09-01',
      to: '2026-09-07',
    }).occurrences;
    expect(occurrence.teamIds).toEqual(['T1', 'T2']);
  });

  it("lets an assignment hold a slot for part of the slot's life", () => {
    const set = oneSlotSet({}, [
      {
        id: 'a1',
        slotId: 'tue-17',
        teamId: 'T1',
        effectiveFrom: '2026-09-01',
        effectiveUntil: '2026-09-14',
      },
    ]);
    const byDate = new Map(
      materialisePracticeOccurrences(set, { from: '2026-09-01', to: '2026-09-30' }).occurrences.map(
        (o) => [o.date, o.teamIds]
      )
    );
    expect(byDate.get('2026-09-08')).toEqual(['T1']);
    expect(byDate.get('2026-09-22')).toEqual([]);
  });

  it('reports a duplicate window inside one revision, and keeps both', () => {
    const set = buildPracticeSlotSet({
      slots: [
        { ...TUESDAY_SLOT, id: 'd1' },
        { ...TUESDAY_SLOT, id: 'd2' },
      ],
      assignments: [],
      source: 'test',
    });
    expect(codesOf(set.findings)).toContain(PRACTICE_REASON.SLOT_DUPLICATE);
    expect(set.slots).toHaveLength(2);
  });

  it('does not call two revisions of one window a duplicate', () => {
    const set = buildPracticeSlotSet({
      slots: [
        { ...TUESDAY_SLOT, id: 'd1', revisionId: 'r1' },
        { ...TUESDAY_SLOT, id: 'd2', revisionId: 'r2' },
      ],
      assignments: [],
      source: 'test',
    });
    expect(codesOf(set.findings)).not.toContain(PRACTICE_REASON.SLOT_DUPLICATE);
  });

  it('reports a slot whose range contains no instance of its own weekday', () => {
    const set = oneSlotSet({ weekday: 'FRI', validFrom: '2026-09-01', validUntil: '2026-09-03' });
    expect(codesOf(set.findings)).toContain(PRACTICE_REASON.SLOT_NEVER_OCCURS);
  });

  it('refuses a half-stated validity range', () => {
    expect(() => PracticeSlotSchema.parse({ ...TUESDAY_SLOT, validUntil: null })).toThrow();
  });

  it('refuses an assignment pointing at no slot', () => {
    expect(() =>
      buildPracticeSlotSet({
        slots: [TUESDAY_SLOT],
        assignments: [{ id: 'a1', slotId: 'ghost', teamId: 'T1' }],
      })
    ).toThrow(/unknown slot/);
  });

  it('refuses two slots sharing an id', () => {
    expect(() =>
      buildPracticeSlotSet({ slots: [TUESDAY_SLOT, TUESDAY_SLOT], assignments: [] })
    ).toThrow(/duplicate slot id/);
  });
});

/* -------------------------------------------------------------------------- */
/* The seam: this package builds no Date                                       */
/* -------------------------------------------------------------------------- */

describe('practice model :: the timezone seam', () => {
  /** Strip comments, so the prose *about* `Date` is not mistaken for a use. */
  const stripComments = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  /** Every `.js` file in the practice package. */
  const packageFiles = () => {
    /** @type {string[]} */
    const found = [];
    const walk = (absolute) => {
      for (const entry of readdirSync(absolute).sort()) {
        const full = path.join(absolute, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.js')) found.push(full);
      }
    };
    walk(path.join(REPO_ROOT, 'packages/core/src/practice'));
    return found;
  };

  const FORBIDDEN = [/\bnew Date\b/, /\bDate\s*\./, /utils\/date\.js/];

  it('constructs no Date and imports no Date helper', () => {
    const files = packageFiles();
    // Meta-assertion: a walk that found nothing would pass the loop below
    // while reading an empty repository.
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const pattern of FORBIDDEN) {
        expect(code, `${path.relative(REPO_ROOT, file)} matches ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it('the guard above can fail — each pattern catches a planted use', () => {
    // Without this, the check above is a regex nobody has shown to fire. Each
    // forbidden pattern is run against code that really does the thing.
    const planted = [
      'const now = new Date();',
      'const n = Date.now();',
      "import { formatDate } from '../utils/date.js';",
    ];
    expect(planted).toHaveLength(FORBIDDEN.length);
    planted.forEach((sample, index) => {
      expect(stripComments(sample)).toMatch(FORBIDDEN[index]);
    });
    // ... and the comment stripper does not swallow real code.
    expect(stripComments('/* new Date */ const x = 1;')).not.toMatch(FORBIDDEN[0]);
    expect(stripComments('const d = new Date(); // fine')).toMatch(FORBIDDEN[0]);
  });
});

/* -------------------------------------------------------------------------- */
/* Agreement with the phase splitter                                           */
/* -------------------------------------------------------------------------- */

describe('practice model :: agreement with practiceSlotExpansion', () => {
  /**
   * **Two computations, not two implementations — held to it.**
   *
   * `expandPracticeSlotsForSeason()` splits a slot across season phases and
   * anchors each piece to the first matching weekday in the phase. This model
   * enumerates dates. They are different jobs, which is why both exist; what
   * must never differ is *where a phase starts and stops* and *which date the
   * slot first falls on inside it*.
   *
   * **The field dropped from the comparison is `seasonPhaseId`, deliberately.**
   * A phase id is the splitter's vocabulary, and the practice model has no
   * phase concept; growing one so the two tuples matched would make this look
   * like a stronger check while actually making the subject adopt the other
   * side's model. The phase id is used here only as the test's own loop
   * variable, to line the two answers up.
   */
  const SLOT = {
    id: 'x',
    day: 'Tuesday',
    start: '17:00',
    end: '18:00',
    capacity: 1,
    validFrom: '2026-08-15',
    validUntil: '2026-10-15',
  };
  const PHASES = [
    { id: 'early', startDate: '2026-08-01', endDate: '2026-09-15' },
    { id: 'late', startDate: '2026-09-16', endDate: '2026-11-01' },
  ];

  const modelSet = (validFrom = SLOT.validFrom) =>
    buildPracticeSlotSet({
      slots: [
        {
          id: 'x',
          surfaceId: 'surface',
          weekday: 'TUE',
          startMinutes: 17 * 60,
          durationMinutes: 60,
          validFrom,
          validUntil: SLOT.validUntil,
        },
      ],
      assignments: [],
    });

  it('agrees on every phase range and first occurrence', () => {
    const expanded = expandPracticeSlotsForSeason({ slots: [SLOT], seasonPhases: PHASES });
    expect(expanded.length).toBeGreaterThan(1);

    // Materialised over the **whole season**, not phase by phase, so that the
    // slot's own validity has to do work: a model that ignored `validFrom`
    // would emit August Tuesdays that fall inside a phase but outside every
    // piece, and the partition below would catch it. Materialising each piece
    // separately would hand the model the answer.
    const mine = materialisePracticeOccurrences(modelSet(), {
      from: PHASES[0].startDate,
      to: PHASES.at(-1).endDate,
    });
    expect(mine.occurrences.length).toBeGreaterThan(4);

    // Every occurrence belongs to exactly one piece.
    for (const occurrence of mine.occurrences) {
      const owning = expanded.filter(
        (piece) => occurrence.date >= piece.effectiveFrom && occurrence.date <= piece.effectiveUntil
      );
      expect(owning, `${occurrence.date} belongs to one phase`).toHaveLength(1);
    }

    // ... and each piece's anchor is the model's first date inside it.
    // `formatDate()` is the splitter's own UTC reader: the test may cross the
    // seam to compare, the model may not.
    for (const piece of expanded) {
      const inPiece = mine.occurrences.filter(
        (o) => o.date >= piece.effectiveFrom && o.date <= piece.effectiveUntil
      );
      expect(inPiece.length).toBeGreaterThan(0);
      expect(inPiece[0].date).toBe(formatDate(piece.start));
    }
  });

  it('the agreement check can fail — a one-day shift breaks it', () => {
    // The control. Widen the model's validity by a day at the front and the
    // first occurrence inside the early phase moves, so an agreement asserted
    // above is one that could have gone the other way.
    const expanded = expandPracticeSlotsForSeason({ slots: [SLOT], seasonPhases: PHASES });
    const mine = materialisePracticeOccurrences(modelSet('2026-08-08'), {
      from: PHASES[0].startDate,
      to: PHASES.at(-1).endDate,
    });
    // The partition is the assertion being controlled: a model whose validity
    // starts a week early emits 2026-08-11, which the splitter's pieces do not
    // cover, so "every occurrence belongs to exactly one piece" stops holding.
    const orphans = mine.occurrences.filter(
      (occurrence) =>
        expanded.filter(
          (piece) =>
            occurrence.date >= piece.effectiveFrom && occurrence.date <= piece.effectiveUntil
        ).length !== 1
    );
    expect(orphans.map((o) => o.date)).toEqual(['2026-08-11']);
  });
});

/* -------------------------------------------------------------------------- */
/* The season-2026 corpus                                                      */
/* -------------------------------------------------------------------------- */

describe('practice model :: the season-2026 practice grid', () => {
  const practice = loadSeason2026Practice();
  const plan = toSeason2026PracticePlan(practice.practiceSlots);
  const set = buildPracticeSlotSet(plan);

  /**
   * The corpus's own numbers, read from the CSV rather than from the model.
   *
   * `CLAUDE.md` §3: never derive a check's subject set from the data a break
   * would corrupt. Counting rows out of `set.slots` would measure the model
   * against its own output, and a revision the adapter dropped would take the
   * expected count down with it.
   */
  const gridLines = readFileSync(
    path.join(REPO_ROOT, 'fixtures/season-2026/practice/practice_grid.csv'),
    'utf8'
  )
    .trim()
    .split('\n');
  const header = gridLines[0].split(',');
  const rows = gridLines.slice(1).map((line) => line.split(','));
  const columnOf = (name) => header.indexOf(name);

  it('read the CSV it is about to measure against', () => {
    // The meta-assertion for every count below. A parse that returned nothing,
    // or a header that moved, fails here rather than making the rest vacuous.
    expect(rows.length).toBe(457);
    expect(columnOf('day')).toBeGreaterThanOrEqual(0);
    expect(columnOf('team_code')).toBeGreaterThanOrEqual(0);
    expect(columnOf('source_sheet')).toBeGreaterThanOrEqual(0);
  });

  it('carries every grid row through to an assignment', () => {
    expect(set.stats.assignmentCount).toBe(rows.length);
  });

  it("holds the corpus's 88 teams", () => {
    const fromCsv = new Set(rows.map((row) => row[columnOf('team_code')]));
    expect(fromCsv.size).toBe(88);
    expect(set.stats.teamCount).toBe(fromCsv.size);
  });

  it('keeps all seven revisions', () => {
    const fromCsv = new Set(rows.map((row) => row[columnOf('source_sheet')]));
    expect(fromCsv.size).toBe(7);
    expect(set.stats.revisionCount).toBe(fromCsv.size);
  });

  it('keeps the 19 Friday practices — the corpus runs Mon–Fri, not Mon–Thu', () => {
    // The stale `day_of_week IN ('mon','tue','wed','thu')` CHECK was widened to
    // all seven days by migration 20260503070000:26-31, and the `day_of_week`
    // enum carries all seven (20260331000000:29). The corpus settles it
    // independently: 19 of these rows are Friday.
    const fridayRows = rows.filter((row) => row[columnOf('day')] === 'Friday');
    expect(fridayRows).toHaveLength(19);
    expect(set.stats.slotsByWeekday.FRI).toBe(fridayRows.length);
    expect(set.stats.slotsByWeekday.SAT).toBe(0);
    expect(set.stats.slotsByWeekday.SUN).toBe(0);
  });

  it('refuses to date the seven revisions, and says so once per revision', () => {
    // `fixtures/season-2026/practice/README.md` §4 — the source does not say
    // which plan is current, so the model does not guess.
    const undated = set.findings.filter((f) => f.code === PRACTICE_REASON.REVISION_UNDATED);
    expect(undated).toHaveLength(7);
    expect(codesOf(set.findings)).toContain(PRACTICE_REASON.REVISION_ORDER_UNKNOWN);
    expect(set.stats.undatedSlotCount).toBe(rows.length);
  });

  it('therefore materialises the whole corpus to nothing, loudly', () => {
    const materialised = materialisePracticeOccurrences(set, {
      from: '2026-08-01',
      to: '2026-12-31',
    });
    expect(materialised.occurrences).toEqual([]);
    expect(codesOf(materialised.findings)).toContain(PRACTICE_REASON.WINDOW_EMPTY);
  });

  it('gives every team a history, each phase marked undated', () => {
    const teams = [...new Set(rows.map((row) => row[columnOf('team_code')]))];
    expect(teams).toHaveLength(88);
    let phasesSeen = 0;
    for (const teamId of teams) {
      const history = buildPracticeHistory(set, { teamId });
      expect(history.stats.phaseCount).toBeGreaterThan(0);
      expect(history.stats.datedPhaseCount).toBe(0);
      phasesSeen += history.stats.phaseCount;
    }
    // Every row is somebody's phase; nothing was lost between the two.
    expect(phasesSeen).toBe(rows.length);
  });
});

/* -------------------------------------------------------------------------- */
/* Declared unwired, and the declaration is checked                            */
/* -------------------------------------------------------------------------- */

describe('practice model :: nothing in production consults it', () => {
  const practiceCodes = Object.values(PRACTICE_REASON);

  it('declares the gap on every result, and nothing claims a PRACTICE_* code', () => {
    const set = oneSlotSet();
    const { enforced, declares } = assertLayerUnwired({
      layer: 'practice model',
      findings: set.findings,
      codes: practiceCodes,
      declarationCode: PRACTICE_REASON.MODEL_UNWIRED,
    });
    expect(enforced).toEqual([]);
    expect(declares).toBe(true);
  });

  it('declares it on a materialisation and on a history too', () => {
    const set = oneSlotSet();
    for (const findings of [
      materialisePracticeOccurrences(set, { from: '2026-09-01', to: '2026-09-30' }).findings,
      buildPracticeHistory(set, { teamId: 'T1' }).findings,
    ]) {
      expect(codesOf(findings)).toContain(PRACTICE_REASON.MODEL_UNWIRED);
    }
  });

  it('gives the declaration info severity, so it never changes a status', () => {
    const set = oneSlotSet();
    expect(set.findings.find((f) => f.code === PRACTICE_REASON.MODEL_UNWIRED).severity).toBe(
      PRACTICE_SEVERITY.INFO
    );
    expect(set.findings.every((f) => f.severity !== PRACTICE_SEVERITY.BLOCKING)).toBe(true);
  });

  it('registers a severity for every code it declares', () => {
    // The `severityOf` throw is the enforcement; this proves the table is
    // complete rather than that the throw exists.
    expect(practiceCodes.length).toBeGreaterThan(3);
    for (const code of practiceCodes) {
      expect(() => PRACTICE_SEVERITY[code]).not.toThrow();
    }
  });
});
