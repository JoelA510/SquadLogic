/**
 * The team portal applies saved practice exceptions (8.6 3b PR 12c;
 * `docs/PHASE_8_6_PR12_READERS_PLAN.md` §4 R2/R3, §6 W4 portal, W12, W13).
 *
 * The `teamPortalPracticeTbd.test.jsx` precedent, one step further out: the
 * page renders with the REAL `useTeamPortal` hook over a fake client that
 * serves a synthetic seed, so the hook's second read is on the path under
 * test (W12's plant, "drop the second read", lives in the hook, not in
 * `expandPractices`).
 *
 * **Subject sets come from the seed**, never from the rendered page: an
 * independent oracle (a UTC `Date` walk sharing no code with core) turns the
 * seeded rows and exceptions into the events a family must see. An exercise
 * meter measures, from the seed alone, that each case the plan names is
 * present, and is proven able to fail by moving every window off every row.
 */

import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanup, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TeamRecordPage from '../frontend/src/pages/TeamRecordPage.jsx';
import {
  PORTAL_PRACTICE_EXCEPTIONS_SELECT,
  PRACTICE_CHANGES_UNREAD_TEXT,
} from '../frontend/src/hooks/useTeamPortal.js';
import { PRACTICE_TBD_CAUSES } from '@squadlogic/core/utils/practiceOccurrences.js';

const mocks = vi.hoisted(() => ({ client: null }));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ teamId: 'team-1' }),
  Link: ({ children, ...props }) => <a {...props}>{children}</a>,
}));

vi.mock('../frontend/src/hooks/usePermission.js', () => ({
  usePermission: () => ({
    can: () => false,
    role: 'parent',
    PERMISSIONS: { MANAGE_ALL_TEAMS: 'manage_all_teams' },
  }),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    from: (table) => mocks.client.from(table),
    rpc: (name, params) => mocks.client.rpc(name, params),
    auth: { getUser: () => mocks.client.getUser() },
    channel: () => {
      const channel = { on: () => channel, subscribe: () => channel };
      return channel;
    },
    removeChannel: () => {},
  },
}));

// --- The seed (synthetic: no real venue, club or person). -------------------

const ground = (location, field) => ({ name: field, location: { name: location } });
const MON = {
  day_of_week: 'mon',
  start_time: '17:00:00',
  end_time: '18:30:00',
  field: ground('Test Park', 'Field A'),
};
const WED = {
  day_of_week: 'wed',
  start_time: '16:00:00',
  end_time: '17:00:00',
  field: ground('Test Park', 'Field C'),
};
const FRI = {
  day_of_week: 'fri',
  start_time: '18:00:00',
  end_time: '19:00:00',
  field: ground('Sample Commons', 'Field D'),
};
const THU_MOVED = {
  day_of_week: 'thu',
  start_time: '18:15:00',
  end_time: '19:15:00',
  field: ground('Example Grounds', 'Field B'),
};

const ROWS = [
  { id: 'pa-mon', team_id: 'team-1', effective_date_range: '[2026-11-02,2026-12-01)', slot: MON },
  // Ends on 2026-11-18: the tail window below starts the next day (plan §2).
  { id: 'pa-wed', team_id: 'team-1', effective_date_range: '[2026-11-04,2026-11-19)', slot: WED },
  { id: 'pa-fri', team_id: 'team-1', effective_date_range: '[2026-11-06,2026-11-28)', slot: FRI },
];

const exception = (id, assignmentId, window, kind, extra = {}) => ({
  id,
  organization_id: 'org-1',
  team_id: 'team-1',
  assignment_id: assignmentId,
  window,
  kind,
  tbd_reason: null,
  cause_kind: 'retirement',
  withdrawn_at: null,
  slot: null,
  ...extra,
});

const EXCEPTIONS = [
  // A move to another weekday, inside the row: Monday 11-09 becomes Thursday 11-12.
  exception('ex-move', 'pa-mon', '[2026-11-09,2026-11-16)', 'relocated', { slot: THU_MOVED }),
  // A mid-range TIME TBD: Monday 11-23.
  exception('ex-mid', 'pa-mon', '[2026-11-23,2026-11-24)', 'time_tbd', {
    tbd_reason: 'no-legal-slot-at-venue',
  }),
  // A tail TIME TBD after the row's range (the §2 defect): Wednesdays 11-25, 12-02, 12-09.
  exception('ex-tail', 'pa-wed', '[2026-11-19,2026-12-10)', 'time_tbd', {
    tbd_reason: 'contended',
  }),
  // Withdrawn: Monday 11-02 must stay the series.
  exception('ex-withdrawn', 'pa-mon', '[2026-11-02,2026-11-03)', 'time_tbd', {
    tbd_reason: 'declined',
    withdrawn_at: '2026-10-30T12:00:00Z',
  }),
  // An open upper bound: Fridays from 11-20 are suppressed, one undated entry.
  exception('ex-open', 'pa-fri', '[2026-11-20,)', 'time_tbd', { tbd_reason: 'contended' }),
];

// --- The oracle: from the seed alone, no core code. -------------------------

const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const DAY_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ms = (iso) => Date.parse(`${iso}T00:00:00Z`);
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const addDays = (date, n) => iso(ms(date) + n * 864e5);

/** `[a,b)` / `[a,b]` / `[a,)` as inclusive `{ first, last }`; `last` null when open. */
function bounds(literal) {
  const m = /^\[(\d{4}-\d{2}-\d{2}),(\d{4}-\d{2}-\d{2})?([)\]])$/.exec(literal);
  if (!m) throw new Error(`unreadable test range ${literal}`);
  if (!m[2]) return { first: m[1], last: null };
  return { first: m[1], last: m[3] === ')' ? addDays(m[2], -1) : m[2] };
}

function walk(day, first, last) {
  const out = [];
  for (let t = ms(first); t <= ms(last); t += 864e5) {
    if (new Date(t).getUTCDay() === DAY_INDEX[day]) out.push(iso(t));
  }
  return out;
}

const place = (slot) => `${slot.field.location.name} - ${slot.field.name}`;

/** What a family must see, per row, from the seed. The seed has no overlapping windows. */
function oracle(rows, exceptions) {
  const out = [];
  for (const row of rows) {
    const range = bounds(row.effective_date_range);
    let series = walk(row.slot.day_of_week, range.first, range.last);
    for (const e of exceptions) {
      if (e.assignment_id !== row.id || e.withdrawn_at != null) continue;
      const w = bounds(e.window);
      if (w.last === null) {
        series = series.filter((d) => d < w.first);
        out.push({ id: row.id, kind: 'undated', code: 'PRACTICE_EXCEPTION_WINDOW_OPEN' });
        continue;
      }
      series = series.filter((d) => d < w.first || d > w.last);
      if (e.kind === 'time_tbd') {
        for (const d of walk(row.slot.day_of_week, w.first, w.last)) {
          out.push({ id: row.id, kind: 'tbd', date: d, code: e.tbd_reason });
        }
      } else {
        const from = w.first > range.first ? w.first : range.first;
        const until = w.last < range.last ? w.last : range.last;
        for (const d of walk(e.slot.day_of_week, from, until)) {
          out.push({ id: row.id, kind: 'moved', date: d, slot: e.slot, replaces: row.slot });
        }
      }
    }
    for (const d of series) out.push({ id: row.id, kind: 'series', date: d, slot: row.slot });
  }
  return out;
}

/**
 * The exercise meter, measured on the seed: each case sits where it must
 * relative to its own row. Tail means the window starts the day after the
 * row's last day (the builder's `[D, until]` after a row closed at D-1).
 */
function exerciseOf(rows, exceptions) {
  const counts = { relocated: 0, midTbd: 0, tailTbd: 0, withdrawn: 0, openUpper: 0 };
  for (const e of exceptions) {
    const row = rows.find((r) => r.id === e.assignment_id);
    if (!row) continue;
    const range = bounds(row.effective_date_range);
    const w = bounds(e.window);
    const touches = w.first <= range.last && (w.last === null || w.last >= range.first);
    if (e.withdrawn_at != null) {
      if (touches) counts.withdrawn += 1;
      continue;
    }
    if (w.last === null) {
      if (touches) counts.openUpper += 1;
    } else if (e.kind === 'relocated') {
      if (w.first >= range.first && w.last <= range.last) counts.relocated += 1;
    } else if (w.first >= range.first && w.last < range.last) {
      counts.midTbd += 1;
    } else if (w.first === addDays(range.last, 1)) {
      counts.tailTbd += 1;
    }
  }
  return counts;
}

const shiftWindows = (exceptions, days) =>
  exceptions.map((e) => {
    const w = bounds(e.window);
    const last = w.last === null ? '' : addDays(w.last, days + 1);
    return { ...e, window: `[${addDays(w.first, days)},${last})` };
  });

// --- The fake client: honours eq, is and range; `fail` makes a table err. ---

function fakeClient(db, { fail = [], user = 'parent-1' } = {}) {
  const from = (table) => {
    const filters = [];
    let single = false;
    let span = null;
    const q = {
      select: () => q,
      eq: (col, val) => (filters.push((r) => String(r[col]) === String(val)), q),
      is: (col, val) => (filters.push((r) => (val === null ? r[col] == null : r[col] === val)), q),
      or: () => q,
      order: () => q,
      range: (lo, hi) => ((span = [lo, hi]), q),
      single: () => ((single = true), q),
      then: (resolve, reject) => {
        if (fail.includes(table)) {
          return Promise.resolve({ data: null, error: { message: `${table} unreadable` } }).then(
            resolve,
            reject
          );
        }
        let rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (span) rows = rows.slice(span[0], span[1] + 1);
        const data = single ? (rows[0] ?? null) : structuredClone(rows);
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return q;
  };
  return {
    from,
    rpc: () => Promise.resolve({ data: [], error: null }),
    getUser: () => Promise.resolve({ data: { user: { id: user } } }),
  };
}

const PLAYER = { id: 'player-1', first_name: 'Sam', last_name: 'Sample' };

function dbOf(exceptions = EXCEPTIONS) {
  return {
    teams: [{ id: 'team-1', name: 'Tigers', organization_id: 'org-1', division: null }],
    team_players: [{ team_id: 'team-1', player: PLAYER }],
    games: [],
    practice_assignments: ROWS,
    practice_exceptions: exceptions,
    event_rsvps: [],
    profile_players: [{ profile_id: 'parent-1', player_id: 'player-1' }],
    team_messages: [],
  };
}

const longDate = (date) =>
  new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
const hhmm = (time) => time.substring(0, 5);

/** @param {Element} node @returns {HTMLElement} the schedule card around it */
const panelOf = (node) => /** @type {HTMLElement} */ (node.closest('.glass-panel'));

/** The card (`.glass-panel`) holding `text`, exactly once. */
const cardWith = (text) => panelOf(screen.getByText(text));

async function renderPortal(options) {
  mocks.client = fakeClient(options?.db ?? dbOf(), options);
  render(<TeamRecordPage />);
  await screen.findByRole('heading', { name: 'Team Schedule' });
  // The schedule has rendered its events once any practice heading is up.
  await screen.findAllByRole('heading', { level: 3 });
}

const EXPECTED = oracle(ROWS, EXCEPTIONS);
const byKind = (kind) => EXPECTED.filter((e) => e.kind === kind);

beforeEach(() => {
  mocks.client = null;
});

describe('the seed exercises every case (meta)', () => {
  it('holds a relocated, a mid-range TBD, a tail TBD, a withdrawn and an open-upper window', () => {
    expect(exerciseOf(ROWS, EXCEPTIONS)).toEqual({
      relocated: 1,
      midTbd: 1,
      tailTbd: 1,
      withdrawn: 1,
      openUpper: 1,
    });
  });

  it('the meter can fail: every window moved off every row reads zero', () => {
    expect(exerciseOf(ROWS, shiftWindows(EXCEPTIONS, 1100))).toEqual({
      relocated: 0,
      midTbd: 0,
      tailTbd: 0,
      withdrawn: 0,
      openUpper: 0,
    });
  });

  it('the oracle is not the bare series: the seed changes what a family sees', () => {
    expect(byKind('moved').length).toBeGreaterThan(0);
    expect(byKind('tbd').length).toBeGreaterThan(0);
    expect(byKind('undated').length).toBeGreaterThan(0);
    const bare = oracle(ROWS, []);
    expect(bare.every((e) => e.kind === 'series')).toBe(true);
    expect(bare.length).not.toBe(byKind('series').length);
  });

  it('reads the columns and embed the plan names, hinted as the feed hints it', () => {
    for (const column of ['id', 'assignment_id', 'window', 'kind', 'tbd_reason', 'withdrawn_at']) {
      expect(PORTAL_PRACTICE_EXCEPTIONS_SELECT).toMatch(new RegExp(`\\b${column}\\b`));
    }
    expect(PORTAL_PRACTICE_EXCEPTIONS_SELECT).toContain(
      'slot:practice_slots!practice_slot_id(day_of_week, start_time, end_time, field:fields(name, location:locations(name)))'
    );
  });
});

describe('team portal: saved practice exceptions are applied (W12, W4 portal)', () => {
  it('every event the seed implies is shown, and no other practice', async () => {
    await renderPortal();
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    const count = (text) => headings.filter((h) => h === text).length;
    expect(count('Practice')).toBe(byKind('series').length);
    expect(count('Practice (moved)')).toBe(byKind('moved').length);
    expect(count('TIME TBD - Practice')).toBe(byKind('tbd').length + byKind('undated').length);
    // Each timed series date, on its own date line.
    for (const e of byKind('series')) {
      expect(screen.getAllByText(longDate(e.date)).length, e.date).toBeGreaterThan(0);
    }
  });

  it('a tail TIME TBD shows one dated entry per weekday in its window, with its reason', async () => {
    await renderPortal();
    const tail = EXCEPTIONS.find((e) => e.id === 'ex-tail');
    const row = ROWS.find((r) => r.id === tail.assignment_id);
    const w = bounds(tail.window);
    const dates = walk(row.slot.day_of_week, w.first, w.last);
    // Meta: every one of them is after the row's own range.
    expect(dates.length).toBe(3);
    expect(dates.every((d) => d > bounds(row.effective_date_range).last)).toBe(true);
    for (const d of dates) {
      const text = `Time TBD on ${longDate(d)}: ${PRACTICE_TBD_CAUSES[tail.tbd_reason]}`;
      expect(within(cardWith(text)).getByText('TIME TBD')).toBeInTheDocument();
    }
  });

  it('every dated TIME TBD reads "Time TBD on <date>: <reason>" from the shared wording', async () => {
    await renderPortal();
    for (const e of byKind('tbd')) {
      expect(PRACTICE_TBD_CAUSES[e.code], e.code).toEqual(expect.any(String));
      expect(cardWith(`Time TBD on ${longDate(e.date)}: ${PRACTICE_TBD_CAUSES[e.code]}`)).not.toBe(
        null
      );
    }
    for (const e of byKind('undated')) {
      expect(cardWith(`Date and time TBD: ${PRACTICE_TBD_CAUSES[e.code]}`)).not.toBe(null);
    }
  });

  it('a moved practice shows its new time and place and one "Moved from" line', async () => {
    await renderPortal();
    for (const e of byKind('moved')) {
      const card = cardWith(longDate(e.date));
      expect(within(card).getByText('Practice (moved)')).toBeInTheDocument();
      expect(
        within(card).getByText(`${hhmm(e.slot.start_time)} - ${hhmm(e.slot.end_time)}`)
      ).toBeInTheDocument();
      expect(within(card).getByText(place(e.slot))).toBeInTheDocument();
      const from = `Moved from ${DAY_NAME[DAY_INDEX[e.replaces.day_of_week]]} ${hhmm(
        e.replaces.start_time
      )}, ${place(e.replaces)}`;
      expect(within(card).getAllByText(/^Moved from /)).toHaveLength(1);
      expect(within(card).getByText(from)).toBeInTheDocument();
    }
  });

  it('RSVP is hidden on TIME TBD dates and moved practices, and shown on the series', async () => {
    await renderPortal();
    // Meta: the parent does RSVP somewhere, so an absence below is not vacuous.
    for (const e of byKind('series')) {
      const cards = screen.getAllByText(longDate(e.date)).map(panelOf);
      expect(
        cards.some((c) => within(c).queryAllByTitle('Going').length === 1),
        e.date
      ).toBe(true);
    }
    for (const e of byKind('tbd')) {
      const card = cardWith(`Time TBD on ${longDate(e.date)}: ${PRACTICE_TBD_CAUSES[e.code]}`);
      expect(within(card).queryAllByTitle('Going'), e.date).toHaveLength(0);
      expect(within(card).getByText('RSVP opens once a time is set')).toBeInTheDocument();
    }
    // Until 12d: the RSVP rule does not yet accept a moved practice's new date.
    for (const e of byKind('moved')) {
      const card = cardWith(longDate(e.date));
      expect(within(card).queryAllByTitle('Going'), e.date).toHaveLength(0);
      expect(
        within(card).getByText('RSVP for a moved practice is not open yet')
      ).toBeInTheDocument();
    }
  });

  it('a coach sees the same schedule as a parent', async () => {
    const details = () =>
      screen
        .getAllByRole('heading', { level: 3 })
        .map((h) => panelOf(h).querySelector('.space-y-2').textContent);
    await renderPortal({ user: 'parent-1' });
    const parent = details();
    cleanup();
    await renderPortal({ user: 'coach-1' });
    expect(screen.queryAllByTitle('Going')).toHaveLength(0);
    expect(details()).toEqual(parent);
    expect(parent.length).toBe(EXPECTED.length);
  });
});

describe('team portal: a failed exceptions read is said, never silent (W13 portal, Q5)', () => {
  it('shows the practices as their series and an alert saying the changes are unread', async () => {
    await renderPortal({ fail: ['practice_exceptions'] });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(PRACTICE_CHANGES_UNREAD_TEXT);
    const bare = oracle(ROWS, []);
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings.filter((h) => h === 'Practice')).toHaveLength(bare.length);
  });

  it('shows no such alert when the read succeeds (meta)', async () => {
    await renderPortal();
    expect(screen.queryByText(PRACTICE_CHANGES_UNREAD_TEXT)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it("says the feed's sentence, word for word", () => {
    const feed = readFileSync(
      path.resolve(__dirname, '../supabase/functions/_shared/calendar/icsFeed.ts'),
      'utf8'
    );
    expect(feed).toContain(`'${PRACTICE_CHANGES_UNREAD_TEXT}'`);
  });
});
