/**
 * `applyPracticeExceptions` (8.6 3b PR 12a, plan §3, witnesses W1-W8, W10).
 *
 * Every subject set below is enumerated from the SEED -- the rows and the
 * exception rows handed in -- never from the helper's output, and every
 * expected date is computed by this file's own oracle (UTC calendar
 * arithmetic, independent of `practiceOccurrences.js`). A seeded exception the
 * helper skipped is therefore reported as missing, not silently absent.
 *
 * Runs in America/Los_Angeles on purpose (W10): an arm that read a wall date
 * through a host-zone `Date` would pass at UTC and fail here.
 */

process.env.TZ = 'America/Los_Angeles';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  PRACTICE_EXCEPTION_CODE,
  PRACTICE_EXCEPTION_TBD_REASONS,
  applyPracticeExceptions,
} from '@squadlogic/core/utils/practiceExceptions.js';
import {
  PRACTICE_OCCURRENCE_REFUSAL,
  PRACTICE_TBD_CAUSES,
} from '@squadlogic/core/utils/practiceOccurrences.js';
import { PRACTICE_TBD_REASON } from '../packages/core/src/practice/index.js';
import { UNPLACEABLE_CAUSES } from '../supabase/functions/_shared/calendar/icsFeed.ts';

// ---------------------------------------------------------------- the oracle

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const utc = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const shift = (date, days) => iso(utc(date) + days * 86400000);
/** Inclusive bounds of a canonical `[a,b)` literal, or null. */
const oracleBounds = (literal) => {
  const m = /^\[(\d{4}-\d{2}-\d{2}),(\d{4}-\d{2}-\d{2})\)$/.exec(String(literal));
  return m ? { first: m[1], last: shift(m[2], -1) } : null;
};
const openLower = (literal) => /^\[(\d{4}-\d{2}-\d{2}),\)$/.exec(String(literal))?.[1] ?? null;
const weekdays = (day, first, last) => {
  const out = [];
  for (let t = utc(first); t <= utc(last); t += 86400000) {
    if (DAYS[new Date(t).getUTCDay()] === day) out.push(iso(t));
  }
  return out;
};
const within = (d, w) => d >= w.first && d <= w.last;

// ------------------------------------------------------------------ the seed

const slot = (day, start, ground) => ({
  day_of_week: day,
  start_time: start,
  end_time: '19:00:00',
  field: { name: ground, location: { name: 'Synthetic Park' } },
});
const exc = (fields) => ({
  practice_slot_id: null,
  tbd_reason: null,
  cause_kind: null,
  slot: null,
  withdrawn_at: null,
  ...fields,
});

/** One team. Synthetic ids and grounds only. */
const SEED = {
  rows: [
    {
      id: 'pa-a',
      effective_date_range: '[2026-09-01,2026-09-30)',
      slot: slot('tue', '17:30:00', 'Field 1'),
    },
    {
      id: 'pa-b',
      effective_date_range: '[2026-09-01,2026-11-25)',
      slot: slot('wed', '17:00:00', 'Field 2'),
    },
    {
      id: 'pa-c',
      effective_date_range: '[2026-09-01,2026-10-28)',
      slot: slot('mon', '17:00:00', 'Field 3'),
    },
    {
      id: 'pa-d',
      effective_date_range: '[2026-09-01,2026-09-30)',
      slot: slot('fri', '17:00:00', 'Field 4'),
    },
    {
      id: 'pa-e',
      effective_date_range: '[2026-09-03,2026-09-25)',
      slot: slot('thu', '17:00:00', 'Field 5'),
    },
    // The successor row a tail window can shadow (Q10, D3).
    {
      id: 'pa-f',
      effective_date_range: '[2026-10-13,2026-11-25)',
      slot: slot('tue', '18:00:00', 'Field 6'),
    },
  ],
  exceptions: [
    // Tail TIME TBD: the row ends 2026-09-29, the window starts 2026-09-30 (§2).
    exc({
      id: 'pe-tail',
      assignment_id: 'pa-a',
      window: '[2026-09-30,2026-10-28)',
      kind: 'time_tbd',
      tbd_reason: 'past-sunset',
      cause_kind: 'daylight',
    }),
    // Mid-range TIME TBD.
    exc({
      id: 'pe-mid',
      assignment_id: 'pa-b',
      window: '[2026-09-15,2026-09-30)',
      kind: 'time_tbd',
      tbd_reason: 'contended',
      cause_kind: 'retirement',
    }),
    // Relocated to another weekday, time and ground.
    exc({
      id: 'pe-rel',
      assignment_id: 'pa-b',
      window: '[2026-10-05,2026-10-21)',
      kind: 'relocated',
      practice_slot_id: 'ps-thu',
      slot: slot('thu', '16:00:00', 'Field 7'),
      cause_kind: 'blackout',
    }),
    // Withdrawn, handed in unfiltered: it must never apply (W2).
    exc({
      id: 'pe-wd',
      assignment_id: 'pa-b',
      window: '[2026-10-26,2026-11-10)',
      kind: 'time_tbd',
      tbd_reason: 'declined',
      withdrawn_at: '2026-09-20T12:00:00Z',
    }),
    // Open upper: everything from 2026-11-10 on has no confirmed time.
    exc({
      id: 'pe-open',
      assignment_id: 'pa-b',
      window: '[2026-11-10,)',
      kind: 'time_tbd',
      tbd_reason: 'past-sunset',
      cause_kind: 'daylight',
    }),
    // Relocated to a slot that did not come back: its dates are TIME TBD, never dropped.
    exc({
      id: 'pe-miss',
      assignment_id: 'pa-c',
      window: '[2026-09-14,2026-09-29)',
      kind: 'relocated',
      practice_slot_id: 'ps-gone',
      slot: null,
      cause_kind: 'blackout',
    }),
    // Relocated on the same weekday: a new time and ground.
    exc({
      id: 'pe-same',
      assignment_id: 'pa-d',
      window: '[2026-09-11,2026-09-19)',
      kind: 'relocated',
      practice_slot_id: 'ps-fri',
      slot: slot('fri', '18:30:00', 'Field 8'),
      cause_kind: 'blackout',
    }),
    // Unreadable window: the whole row is TIME TBD.
    exc({
      id: 'pe-bad',
      assignment_id: 'pa-e',
      window: 'not-a-range',
      kind: 'time_tbd',
      tbd_reason: 'contended',
    }),
  ],
};

const rowOf = (seed, id) => seed.rows.find((r) => r.id === id);
const seriesOf = (row) => {
  const b = oracleBounds(row.effective_date_range);
  return weekdays(row.slot.day_of_week, b.first, b.last);
};
const liveOf = (seed) => seed.exceptions.filter((e) => e.withdrawn_at == null);

/** What the oracle says one live exception's dates are, from the seed. */
function expectedDatesOf(seed, e) {
  const row = rowOf(seed, e.assignment_id);
  const range = oracleBounds(row.effective_date_range);
  const w = oracleBounds(e.window);
  if (w === null) return [];
  if (e.kind === 'time_tbd') return weekdays(row.slot.day_of_week, w.first, w.last);
  if (e.slot === null) return seriesOf(row).filter((d) => within(d, w));
  const first = w.first > range.first ? w.first : range.first;
  const last = w.last < range.last ? w.last : range.last;
  return weekdays(e.slot.day_of_week, first, last);
}

/** The exercise checks (plan §6): each must be satisfiable, and each must be able to fail. */
function exercised(seed, out) {
  const carrying = (id) => out.occurrences.filter((o) => o.exceptionId === id);
  const live = liveOf(seed);
  return {
    relocated: live.some(
      (e) => e.kind === 'relocated' && carrying(e.id).some((o) => o.kind === 'relocated')
    ),
    midRange: live.some((e) => {
      const range = oracleBounds(rowOf(seed, e.assignment_id).effective_date_range);
      return e.kind === 'time_tbd' && carrying(e.id).some((o) => within(o.date, range));
    }),
    tail: live.some((e) => {
      const range = oracleBounds(rowOf(seed, e.assignment_id).effective_date_range);
      const w = oracleBounds(e.window);
      return (
        e.kind === 'time_tbd' &&
        w !== null &&
        w.first === shift(range.last, 1) &&
        carrying(e.id).some((o) => o.date > range.last)
      );
    }),
    withdrawn: seed.exceptions.some((e) => {
      if (e.withdrawn_at == null) return false;
      const w = oracleBounds(e.window);
      const inWindow = seriesOf(rowOf(seed, e.assignment_id)).filter((d) => w && within(d, w));
      return (
        inWindow.length > 0 &&
        inWindow.every((d) =>
          out.occurrences.some(
            (o) => o.assignmentId === e.assignment_id && o.date === d && o.kind === 'series'
          )
        )
      );
    }),
    open: live.some((e) => {
      const lower = openLower(e.window);
      if (lower === null) return false;
      const row = rowOf(seed, e.assignment_id);
      return seriesOf(row).some((d) => d >= lower);
    }),
  };
}

/** The meta-plant: every window moved off every row, to a year no row reaches. */
function movedOffRows(seed) {
  return {
    rows: seed.rows,
    exceptions: seed.exceptions.map((e) => {
      if (openLower(e.window) !== null) return { ...e, window: '[2031-01-01,)' };
      if (oracleBounds(e.window) === null) return e;
      return { ...e, window: '[2031-03-02,2031-03-30)' };
    }),
  };
}

const OUT = applyPracticeExceptions(SEED);

describe('applyPracticeExceptions: the seed exercises what it claims (meta)', () => {
  it('has a live relocated, mid-range TBD, tail TBD, withdrawn and open window, all exercised', () => {
    expect(exercised(SEED, OUT)).toEqual({
      relocated: true,
      midRange: true,
      tail: true,
      withdrawn: true,
      open: true,
    });
  });

  it('each exercise check turns red when every window is moved off every row', () => {
    const moved = movedOffRows(SEED);
    expect(exercised(moved, applyPracticeExceptions(moved))).toEqual({
      relocated: false,
      midRange: false,
      tail: false,
      withdrawn: false,
      open: false,
    });
  });
});

describe('applyPracticeExceptions: witnesses', () => {
  it('W1: every live exception is applied exactly once', () => {
    const live = liveOf(SEED);
    expect(live).toHaveLength(7);
    for (const e of live) {
      const dated = OUT.occurrences.filter((o) => o.exceptionId === e.id).map((o) => o.date);
      const undated = OUT.undated.filter((u) => u.exceptionId === e.id);
      if (openLower(e.window) !== null || oracleBounds(e.window) === null) {
        expect(dated, e.id).toEqual([]);
        expect(undated, e.id).toHaveLength(1);
      } else {
        const expected = expectedDatesOf(SEED, e);
        expect(expected.length, `${e.id} has dates to apply`).toBeGreaterThan(0);
        expect(dated, e.id).toEqual(expected);
        expect(undated, e.id).toEqual([]);
      }
    }
    expect(OUT.meta).toMatchObject({
      rowsRead: 6,
      exceptionsRead: 8,
      exceptionsLive: 7,
      exceptionsWithdrawn: 1,
      exceptionsApplied: 7,
    });
  });

  it('W2: a withdrawn exception never applies, though the caller passed it unfiltered', () => {
    const withdrawn = SEED.exceptions.filter((e) => e.withdrawn_at != null);
    expect(withdrawn).toHaveLength(1);
    for (const e of withdrawn) {
      expect(OUT.occurrences.filter((o) => o.exceptionId === e.id)).toEqual([]);
      expect(OUT.undated.filter((u) => u.exceptionId === e.id)).toEqual([]);
      expect(OUT.findings.filter((f) => f.exceptionId === e.id)).toEqual([]);
    }
  });

  it('W3: no series date survives inside a live window', () => {
    let checked = 0;
    for (const e of liveOf(SEED)) {
      const w = oracleBounds(e.window);
      const lower = openLower(e.window);
      const row = rowOf(SEED, e.assignment_id);
      for (const d of seriesOf(row)) {
        const inside = w ? within(d, w) : lower !== null ? d >= lower : true;
        if (!inside) continue;
        checked += 1;
        const survivor = OUT.occurrences.find(
          (o) => o.assignmentId === row.id && o.date === d && o.kind === 'series'
        );
        expect(survivor, `${e.id} ${d}`).toBeUndefined();
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('W4: a tail TIME TBD window shows one dated TBD per weekday in the window', () => {
    const e = SEED.exceptions.find((x) => x.id === 'pe-tail');
    const w = oracleBounds(e.window);
    const expected = weekdays('tue', w.first, w.last);
    expect(expected).toEqual(['2026-10-06', '2026-10-13', '2026-10-20', '2026-10-27']);
    const got = OUT.occurrences.filter((o) => o.exceptionId === 'pe-tail');
    expect(got.map((o) => o.date)).toEqual(expected);
    expect(got.every((o) => o.kind === 'time_tbd' && o.code === 'past-sunset')).toBe(true);
    expect(got.every((o) => o.causeKind === 'daylight')).toBe(true);
    expect(PRACTICE_TBD_CAUSES[got[0].code]).toBeTruthy();
  });

  it('W5: a relocated practice carries the new slot, and names the one it replaces', () => {
    let checked = 0;
    for (const e of liveOf(SEED).filter((x) => x.kind === 'relocated' && x.slot)) {
      const row = rowOf(SEED, e.assignment_id);
      for (const o of OUT.occurrences.filter((x) => x.exceptionId === e.id)) {
        checked += 1;
        expect(o.kind).toBe('relocated');
        expect(o.slot).toEqual(e.slot);
        expect(DAYS[new Date(utc(o.date)).getUTCDay()]).toBe(e.slot.day_of_week);
        expect(o.replaces).toEqual(row.slot);
        expect(o.causeKind).toBe(e.cause_kind);
      }
    }
    // pe-rel: Thursdays 2026-10-08 and -15; pe-same: Fridays 2026-09-11 and -18.
    expect(checked).toBe(2 + 2);
  });

  it('W6: nothing is dropped -- the output count per row is the oracle count from the seed', () => {
    for (const row of SEED.rows) {
      const live = liveOf(SEED).filter((e) => e.assignment_id === row.id);
      const got = OUT.occurrences.filter((o) => o.assignmentId === row.id);
      if (live.some((e) => oracleBounds(e.window) === null && openLower(e.window) === null)) {
        expect(got, row.id).toEqual([]);
        expect(
          OUT.undated.filter((u) => u.assignmentId === row.id),
          row.id
        ).toHaveLength(1);
        continue;
      }
      const lower = live.map((e) => openLower(e.window)).find((x) => x !== null) ?? null;
      const windows = live.map((e) => oracleBounds(e.window)).filter(Boolean);
      const series = seriesOf(row).filter((d) => lower === null || d < lower);
      const kept = series.filter((d) => !windows.some((w) => within(d, w)));
      const added = live
        .filter((e) => oracleBounds(e.window))
        .reduce(
          (n, e) => n + expectedDatesOf(SEED, e).filter((d) => lower === null || d < lower).length,
          0
        );
      expect(got.length, row.id).toBe(kept.length + added);
      expect(
        got.filter((o) => o.kind === 'series').map((o) => o.date),
        row.id
      ).toEqual(kept);
    }
    // pe-miss: the relocated slot did not come back, so its dates are TIME TBD.
    const missing = OUT.occurrences.filter((o) => o.exceptionId === 'pe-miss');
    expect(missing.map((o) => o.date)).toEqual(['2026-09-14', '2026-09-21', '2026-09-28']);
    expect(missing.every((o) => o.code === PRACTICE_OCCURRENCE_REFUSAL.SLOT_MISSING)).toBe(true);
  });

  it('W7: an open or unreadable window never shows a timed practice', () => {
    const open = SEED.exceptions.find((e) => e.id === 'pe-open');
    const lower = openLower(open.window);
    const timedAfter = OUT.occurrences.filter(
      (o) => o.assignmentId === 'pa-b' && o.date >= lower && o.kind !== 'time_tbd'
    );
    expect(seriesOf(rowOf(SEED, 'pa-b')).filter((d) => d >= lower).length).toBeGreaterThan(0);
    expect(timedAfter).toEqual([]);
    expect(OUT.undated.filter((u) => u.exceptionId === 'pe-open')).toEqual([
      { assignmentId: 'pa-b', exceptionId: 'pe-open', code: PRACTICE_EXCEPTION_CODE.WINDOW_OPEN },
    ]);
    expect(OUT.occurrences.filter((o) => o.assignmentId === 'pa-e')).toEqual([]);
    expect(OUT.undated.filter((u) => u.assignmentId === 'pa-e')).toEqual([
      {
        assignmentId: 'pa-e',
        exceptionId: 'pe-bad',
        code: PRACTICE_EXCEPTION_CODE.WINDOW_UNREADABLE,
      },
    ]);
    const codes = OUT.findings.map((f) => `${f.code}:${f.exceptionId}`);
    expect(codes).toContain(`${PRACTICE_EXCEPTION_CODE.WINDOW_OPEN}:pe-open`);
    expect(codes).toContain(`${PRACTICE_EXCEPTION_CODE.WINDOW_UNREADABLE}:pe-bad`);
  });

  it('W8: overlapping live windows are loud (a DEFENCE of a state the EXCLUDE constraint makes unreachable, not coverage of a real path)', () => {
    const rows = [SEED.rows[1]];
    const exceptions = [
      exc({
        id: 'pe-x',
        assignment_id: 'pa-b',
        window: '[2026-09-01,2026-09-24)',
        kind: 'relocated',
        slot: slot('thu', '16:00:00', 'Field 7'),
      }),
      exc({
        id: 'pe-y',
        assignment_id: 'pa-b',
        window: '[2026-09-15,2026-10-01)',
        kind: 'time_tbd',
        tbd_reason: 'contended',
      }),
    ];
    const out = applyPracticeExceptions({ rows, exceptions });
    // Overlap 2026-09-15..23: Wednesday 16 and 23 (series/TBD), Thursday 17 (relocated).
    const inOverlap = out.occurrences.filter(
      (o) => o.date >= '2026-09-15' && o.date <= '2026-09-23'
    );
    expect(inOverlap.map((o) => o.date)).toEqual(['2026-09-16', '2026-09-17', '2026-09-23']);
    expect(inOverlap.every((o) => o.code === PRACTICE_EXCEPTION_CODE.CONFLICT)).toBe(true);
    expect(inOverlap.every((o) => o.exceptionId === null)).toBe(true);
    expect(out.findings.filter((f) => f.code === PRACTICE_EXCEPTION_CODE.CONFLICT)).toEqual([
      { code: PRACTICE_EXCEPTION_CODE.CONFLICT, assignmentId: 'pa-b', exceptionId: 'pe-x' },
      { code: PRACTICE_EXCEPTION_CODE.CONFLICT, assignmentId: 'pa-b', exceptionId: 'pe-y' },
    ]);
  });

  it('rule 8: an exception naming an unread row is a finding, never applied', () => {
    const out = applyPracticeExceptions({
      rows: [SEED.rows[0]],
      exceptions: [SEED.exceptions[1]],
    });
    expect(out.findings).toEqual([
      { code: PRACTICE_EXCEPTION_CODE.ROW_UNREAD, assignmentId: 'pa-b', exceptionId: 'pe-mid' },
    ]);
    expect(out.occurrences.every((o) => o.kind === 'series')).toBe(true);
    expect(out.meta.exceptionsApplied).toBe(0);
  });

  it('rule 9: a TIME TBD date on which another row of the team is timed is shadowed, both kept', () => {
    const shadowed = OUT.findings.filter((f) => f.code === PRACTICE_EXCEPTION_CODE.TBD_SHADOWED);
    const successor = seriesOf(rowOf(SEED, 'pa-f'));
    const expected = expectedDatesOf(SEED, SEED.exceptions[0]).filter((d) => successor.includes(d));
    expect(expected).toEqual(['2026-10-13', '2026-10-20', '2026-10-27']);
    expect(shadowed.map((f) => f.date)).toEqual(expected);
    for (const d of expected) {
      expect(
        OUT.occurrences
          .filter((o) => o.date === d)
          .map((o) => o.kind)
          .sort()
      ).toEqual(['series', 'time_tbd']);
    }
  });

  it('rule 6b: an exception with no withdrawn_at key, or outside the CHECK, never shows timed', () => {
    const row = SEED.rows[0];
    const base = { id: 'pe-u', assignment_id: 'pa-a', window: '[2026-09-08,2026-09-16)' };
    for (const e of [
      { ...base, kind: 'time_tbd', tbd_reason: 'past-sunset' }, // no withdrawn_at key
      { ...base, kind: 'cancelled', withdrawn_at: null },
      { ...base, kind: 'time_tbd', tbd_reason: 'free text', withdrawn_at: null },
    ]) {
      const out = applyPracticeExceptions({ rows: [row], exceptions: [e] });
      const inWindow = out.occurrences.filter(
        (o) => o.date >= '2026-09-08' && o.date <= '2026-09-15'
      );
      expect(inWindow.map((o) => `${o.date}:${o.code}`)).toEqual([
        `2026-09-08:${PRACTICE_EXCEPTION_CODE.UNREADABLE}`,
        `2026-09-15:${PRACTICE_EXCEPTION_CODE.UNREADABLE}`,
      ]);
    }
  });
});

describe('applyPracticeExceptions: zone-free and worded (W10, §3 Wording)', () => {
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const DATE_USE = /\bnew Date\b|\bDate\.(?:now|UTC|parse)\b|\.get(?:UTC)?Day\(|toLocale\w*\(/;

  it('W10: neither arm constructs or reads a Date', () => {
    for (const file of [
      'packages/core/src/utils/practiceExceptions.js',
      'supabase/functions/_shared/calendar/practiceExceptions.ts',
    ]) {
      const src = stripComments(readFileSync(path.join(process.cwd(), file), 'utf8'));
      expect(src.length, file).toBeGreaterThan(2000);
      expect(DATE_USE.test(src), file).toBe(false);
    }
    // The detector itself fires on the spellings it claims to catch.
    for (const planted of ['new Date(d)', 'Date.UTC(1)', 'x.getDay()', 'd.toLocaleDateString()']) {
      expect(DATE_USE.test(planted), planted).toBe(true);
    }
  });

  it('the tbd_reason list is core PRACTICE_TBD_REASON (itself pinned to the CHECK and the Edge enum)', () => {
    expect([...PRACTICE_EXCEPTION_TBD_REASONS].sort()).toEqual(
      [...Object.values(PRACTICE_TBD_REASON)].sort()
    );
  });

  it('every TIME TBD code has one family-facing sentence, the same in the portal and the feed', () => {
    const codes = [
      ...PRACTICE_EXCEPTION_TBD_REASONS,
      ...Object.values(PRACTICE_OCCURRENCE_REFUSAL),
      PRACTICE_EXCEPTION_CODE.WINDOW_OPEN,
      PRACTICE_EXCEPTION_CODE.WINDOW_UNREADABLE,
      PRACTICE_EXCEPTION_CODE.CONFLICT,
      PRACTICE_EXCEPTION_CODE.UNREADABLE,
    ];
    expect(codes).toHaveLength(8 + 3 + 4);
    for (const code of codes) {
      expect(typeof PRACTICE_TBD_CAUSES[code], code).toBe('string');
      expect(PRACTICE_TBD_CAUSES[code], code).toBe(UNPLACEABLE_CAUSES[code]);
    }
    expect(Object.keys(PRACTICE_TBD_CAUSES).sort()).toEqual([...codes].sort());
    // Every code the helper can put on a TIME TBD occurrence or undated entry is worded.
    const emitted = new Set([
      ...OUT.occurrences.filter((o) => o.kind === 'time_tbd').map((o) => o.code),
      ...OUT.undated.map((u) => u.code),
    ]);
    for (const code of emitted) expect(PRACTICE_TBD_CAUSES[code], code).toBeTruthy();
  });
});
