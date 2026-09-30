/**
 * The seeded team for the calendar feed's practice-exception witnesses
 * (8.6 3b PR 12b; `docs/PHASE_8_6_PR12_READERS_PLAN.md` §6, W4, W11, W13).
 *
 * Shared by the Deno arm (`ics-feed_test.ts`) and the Vitest arm
 * (`tests/calendarFeed.test.js`), so both hold the shipped code to the same
 * seed. Not a test file itself (no `_test` suffix), so discovery does not run
 * it alone. Import-free, like the modules it tests. Synthetic names only.
 *
 * ## Three independent parts
 *
 * - **The seed**: rows as the database would hold them, including rows the
 *   feed must NOT apply (a withdrawn exception, one of another organization).
 * - **The oracle** ({@link expectedFeed}): what the feed must show, derived
 *   from the seed by its own UTC `Date` walk. It shares no code with the twin
 *   (`practiceExceptions.ts`, which does day-number arithmetic and constructs
 *   no `Date`) or with `icsFeed.ts`. Subject sets come from the seeded rows,
 *   never from the feed's output.
 * - **The fake client** ({@link fakeClient}): serves the seed through the
 *   builder surface `teamFeed.ts` calls, honouring every `eq` filter, so a
 *   read that drops a filter or reads the wrong table shows in the output.
 *
 * {@link exerciseOf} is the meta-assertion: it measures, from the seed alone,
 * that each case the plan names is present AND positioned against its row the
 * way that case needs. {@link shiftWindows} is its constructed failure: every
 * window moved off every row, which must take every count to zero.
 */

// Seeded PostgREST rows, read loosely by the oracle and the fake.
// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rec = Record<string, any>;

export const TEAM = { id: 'team-t1', name: 'Test Tigers', organization_id: 'org-o1' };
export const TIMEZONE = 'America/Los_Angeles';

const field = (name: string, location: string) => ({ name, locations: { name: location } });

export interface FeedSeed {
  team: typeof TEAM;
  timezone: string | null;
  practices: Rec[];
  exceptions: Rec[];
}

/** Three rows, each positioned for its exceptions below. */
const PRACTICES: Rec[] = [
  {
    id: 'asg-a1',
    team_id: TEAM.id,
    effective_date_range: '[2026-09-01,2026-10-01)',
    practice_slots: {
      day_of_week: 'tue',
      start_time: '17:00:00',
      end_time: '18:30:00',
      fields: field('Field 2B', 'Synthetic South'),
    },
  },
  {
    id: 'asg-a2',
    team_id: TEAM.id,
    effective_date_range: '[2026-09-01,2026-11-20)',
    practice_slots: {
      day_of_week: 'thu',
      start_time: '18:00:00',
      end_time: '19:30:00',
      fields: field('Field 1A', 'Synthetic North'),
    },
  },
  {
    id: 'asg-a3',
    team_id: TEAM.id,
    effective_date_range: '[2026-09-05,2026-12-01)',
    practice_slots: {
      day_of_week: 'sat',
      start_time: '09:00:00',
      end_time: '10:30:00',
      fields: field('Field 4D', 'Synthetic East'),
    },
  },
];

const exception = (over: Rec): Rec => ({
  team_id: TEAM.id,
  organization_id: TEAM.organization_id,
  practice_slot_id: null,
  tbd_reason: null,
  cause_kind: null,
  withdrawn_at: null,
  slot: null,
  ...over,
});

const EXCEPTIONS: Rec[] = [
  // The §2 defect: row ends Sep 30 (D-1), TIME TBD over [D, until].
  exception({
    id: 'exc-tail',
    assignment_id: 'asg-a1',
    window: '[2026-10-01,2026-11-01)',
    kind: 'time_tbd',
    tbd_reason: 'past-sunset',
    cause_kind: 'daylight',
  }),
  // Mid-range TIME TBD: two Thursdays inside the row.
  exception({
    id: 'exc-mid',
    assignment_id: 'asg-a2',
    window: '[2026-09-14,2026-09-28)',
    kind: 'time_tbd',
    tbd_reason: 'contended',
    cause_kind: 'retirement',
  }),
  // Relocated to another weekday: Thursdays out, Wednesdays in.
  exception({
    id: 'exc-move',
    assignment_id: 'asg-a2',
    window: '[2026-10-05,2026-10-19)',
    kind: 'relocated',
    practice_slot_id: 'slot-s9',
    cause_kind: 'blackout',
    slot: {
      day_of_week: 'wed',
      start_time: '17:30:00',
      end_time: '19:00:00',
      fields: field('Field 3C', 'Synthetic West'),
    },
  }),
  // Relocated on the same day to a later time: the UID must not change (Q1).
  exception({
    id: 'exc-sameday',
    assignment_id: 'asg-a3',
    window: '[2026-09-12,2026-09-13)',
    kind: 'relocated',
    practice_slot_id: 'slot-s8',
    cause_kind: 'blackout',
    slot: {
      day_of_week: 'sat',
      start_time: '11:00:00',
      end_time: '12:30:00',
      fields: field('Field 4D', 'Synthetic East'),
    },
  }),
  // Withdrawn: its Thursday stays a plain practice.
  exception({
    id: 'exc-withdrawn',
    assignment_id: 'asg-a2',
    window: '[2026-10-26,2026-11-02)',
    kind: 'time_tbd',
    tbd_reason: 'declined',
    withdrawn_at: '2026-09-20T00:00:00Z',
  }),
  // Open upper bound: every Saturday from Nov 7 is superseded, with no day to show (Q7).
  exception({
    id: 'exc-open',
    assignment_id: 'asg-a3',
    window: '[2026-11-07,)',
    kind: 'time_tbd',
    tbd_reason: 'sunset-unknown',
    cause_kind: 'daylight',
  }),
  // Another organization's row naming this team's assignment. The database's
  // FKs do not tie the two organization ids together, so this defends the
  // read's organization filter; it is not claimed as a reachable state.
  exception({
    id: 'exc-decoy-org',
    organization_id: 'org-other',
    assignment_id: 'asg-a2',
    window: '[2026-11-09,2026-11-16)',
    kind: 'time_tbd',
    tbd_reason: 'contended',
  }),
];

export const SEED: FeedSeed = {
  team: TEAM,
  timezone: TIMEZONE,
  practices: PRACTICES,
  exceptions: EXCEPTIONS,
};

// ------------------------------------------------------------------ the oracle

const DOW: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const DAY_MS = 86_400_000;
const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const msOf = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/** `[a,b)` or `[a,)`, the only spellings the seed uses: inclusive first, last or null. */
export function seedRange(range: string): { first: string; last: string | null } {
  const m = /^\[(\d{4}-\d{2}-\d{2}),(\d{4}-\d{2}-\d{2})?\)$/.exec(range);
  if (!m) throw new Error(`seed range not in the seed's spelling: ${range}`);
  return { first: m[1], last: m[2] ? toIso(msOf(m[2]) - DAY_MS) : null };
}

/** Every date on `day` in `[first, last]`, by a UTC walk. */
export function seedWeekdays(day: string, first: string, last: string): string[] {
  const out: string[] = [];
  for (let t = msOf(first); t <= msOf(last); t += DAY_MS) {
    if (new Date(t).getUTCDay() === DOW[day]) out.push(toIso(t));
  }
  return out;
}

/** The exceptions this team's feed must apply: live, and this team's and organization's. */
export const liveExceptions = (seed: FeedSeed) =>
  seed.exceptions.filter(
    (e) =>
      e.withdrawn_at == null &&
      e.team_id === seed.team.id &&
      e.organization_id === seed.team.organization_id
  );

export interface ExpectedVevent {
  summary: string;
  allDay: boolean;
  /** For a TIME TBD: the code its DESCRIPTION must name. */
  code?: string;
}

export function expectedFeed(seed: FeedSeed): {
  vevents: Map<string, ExpectedVevent>;
  undated: number;
  total: number;
  noTime: number;
} {
  const team = seed.team.name;
  const vevents = new Map<string, ExpectedVevent>();
  const live = liveExceptions(seed);
  let undated = 0;
  for (const row of seed.practices) {
    const range = seedRange(row.effective_date_range);
    const last = range.last as string;
    const day = row.practice_slots.day_of_week;
    const mine = live
      .filter((e) => e.assignment_id === row.id)
      .map((e) => ({ e, ...seedRange(e.window) }));
    const open = mine.filter((x) => x.last === null);
    undated += open.length;
    const openFrom = open.length ? open.map((x) => x.first).sort()[0] : null;
    const closed = mine.filter((x) => x.last !== null) as Array<{
      e: Rec;
      first: string;
      last: string;
    }>;
    const tbd = (date: string, code: string) =>
      vevents.set(`${row.id}_${date}`, {
        summary: `TIME TBD - Practice - ${team}`,
        allDay: true,
        code,
      });

    for (const date of seedWeekdays(day, range.first, last)) {
      if (openFrom && date >= openFrom) continue;
      const over = closed.find((x) => date >= x.first && date <= x.last);
      if (over?.e.kind === 'time_tbd') tbd(date, over.e.tbd_reason);
      else if (!over)
        vevents.set(`${row.id}_${date}`, { summary: `Practice - ${team}`, allDay: false });
    }
    for (const x of closed) {
      if (x.e.kind === 'time_tbd') {
        // Not clipped to the row: this is the tail case (plan §3 rule 4).
        for (const date of seedWeekdays(day, x.first, x.last)) tbd(date, x.e.tbd_reason);
      } else {
        const from = x.first > range.first ? x.first : range.first;
        const until = x.last < last ? x.last : last;
        for (const date of seedWeekdays(x.e.slot.day_of_week, from, until)) {
          vevents.set(`${row.id}_${date}`, {
            summary: `Practice (moved) - ${team}`,
            allDay: false,
          });
        }
      }
    }
  }
  const allDay = [...vevents.values()].filter((v) => v.allDay).length;
  return { vevents, undated, total: vevents.size + undated, noTime: allDay + undated };
}

// --------------------------------------------------------- the exercise meter

/**
 * How many seeded exceptions sit where each witnessed case needs them, from
 * the seed alone. Every count must be at least one for the witnesses to mean
 * anything.
 */
export function exerciseOf(seed: FeedSeed): Record<string, number> {
  const counts = { relocated: 0, midTbd: 0, tailTbd: 0, withdrawn: 0, openUpper: 0 };
  for (const e of seed.exceptions) {
    const row = seed.practices.find((r) => r.id === e.assignment_id);
    if (!row || e.organization_id !== seed.team.organization_id) continue;
    const range = seedRange(row.effective_date_range);
    const last = range.last as string;
    const w = seedRange(e.window);
    const series = seedWeekdays(row.practice_slots.day_of_week, range.first, last);
    const covers = (d: string) => d >= w.first && (w.last === null || d <= w.last);
    const coversSeries = series.some(covers);
    const inside = w.first >= range.first && w.last !== null && w.last <= last;
    if (e.withdrawn_at != null) {
      if (coversSeries) counts.withdrawn += 1;
    } else if (w.last === null) {
      if (w.first >= range.first && w.first <= last && coversSeries) counts.openUpper += 1;
    } else if (e.kind === 'relocated') {
      if (inside && coversSeries) counts.relocated += 1;
    } else if (w.first === toIso(msOf(last) + DAY_MS)) {
      if (seedWeekdays(row.practice_slots.day_of_week, w.first, w.last).length > 0) {
        counts.tailTbd += 1;
      }
    } else if (inside && coversSeries) {
      counts.midTbd += 1;
    }
  }
  return counts;
}

/** The meta-plant: every window moved `days` off, and so off every row. */
export function shiftWindows(seed: FeedSeed, days: number): FeedSeed {
  const shift = (iso: string) => toIso(msOf(iso) + days * DAY_MS);
  return {
    ...seed,
    exceptions: seed.exceptions.map((e) => {
      const m = /^\[([^,]*),([^)]*)\)$/.exec(e.window) as RegExpExecArray;
      return { ...e, window: `[${shift(m[1])},${m[2] ? shift(m[2]) : ''})` };
    }),
  };
}

// ------------------------------------------------------------ reading the ICS

export interface ParsedVevent {
  uid: string;
  summary: string;
  allDay: boolean;
  dtstart: string;
  description: string;
  status: string | null;
  location: string | null;
}

/** The VCALENDAR, unfolded, as its CALDESC and its VEVENTs. */
export function parseIcs(ics: string): { caldesc: string; vevents: ParsedVevent[] } {
  const lines = ics.replace(/\r\n /g, '').split('\r\n');
  const caldesc = (lines.find((l) => l.startsWith('X-WR-CALDESC:')) ?? '').slice(13);
  const vevents: ParsedVevent[] = [];
  let cur: Rec | null = null;
  for (const l of lines) {
    if (l === 'BEGIN:VEVENT') cur = {};
    else if (l === 'END:VEVENT' && cur) {
      vevents.push({
        uid: String(cur.UID ?? '').replace(/@squadlogic\.app$/, ''),
        summary: cur.SUMMARY ?? '',
        allDay: 'DTSTART;VALUE=DATE' in cur,
        dtstart: cur['DTSTART;VALUE=DATE'] ?? cur.DTSTART ?? '',
        description: cur.DESCRIPTION ?? '',
        status: cur.STATUS ?? null,
        location: cur.LOCATION ?? null,
      });
      cur = null;
    } else if (cur) {
      const at = l.indexOf(':');
      cur[l.slice(0, at)] = l.slice(at + 1);
    }
  }
  return { caldesc, vevents };
}

/**
 * Every way the rendered calendar departs from the oracle, as sentences.
 * Empty means the feed shows exactly what the seed says it must.
 */
export function feedProblems(ics: string, seed: FeedSeed): string[] {
  const want = expectedFeed(seed);
  const { caldesc, vevents } = parseIcs(ics);
  const problems: string[] = [];
  const got = new Map(vevents.map((v) => [v.uid, v]));
  if (got.size !== vevents.length) problems.push('duplicate UIDs');
  for (const [uid, w] of want.vevents) {
    const g = got.get(uid);
    if (!g) {
      problems.push(`missing VEVENT ${uid}`);
      continue;
    }
    if (g.summary !== w.summary) problems.push(`${uid}: SUMMARY ${g.summary} != ${w.summary}`);
    if (g.allDay !== w.allDay) problems.push(`${uid}: all-day ${g.allDay} != ${w.allDay}`);
    if (w.allDay && g.status !== 'TENTATIVE') problems.push(`${uid}: not TENTATIVE`);
    if (w.code && !g.description.includes(`(${w.code})`)) {
      problems.push(`${uid}: DESCRIPTION does not name ${w.code}`);
    }
  }
  for (const uid of got.keys()) if (!want.vevents.has(uid)) problems.push(`extra VEVENT ${uid}`);
  // The renderer writes the count only when it is not zero.
  if (want.noTime > 0) {
    const count = `${want.noTime} of ${want.total} events have no confirmed time`;
    if (!caldesc.includes(count)) problems.push(`CALDESC lacks "${count}": ${caldesc}`);
  } else if (/events have no confirmed time/.test(caldesc)) {
    problems.push(`CALDESC counts events with no time, and the seed has none: ${caldesc}`);
  }
  if (/CANCELLED/.test(ics)) problems.push('a VEVENT was sent as CANCELLED');
  return problems;
}

// ------------------------------------------------------------ the fake client

/**
 * The builder surface `teamFeed.ts` and `readSeasonTimezone` call, over the
 * seed. `fail` names tables whose read returns an error.
 */
export function fakeClient(seed: FeedSeed, opts: { fail?: string[] } = {}) {
  const tables: Record<string, Rec[]> = {
    season_settings: [
      { id: 'season-1', organization_id: seed.team.organization_id, timezone: seed.timezone },
    ],
    games: [],
    practice_assignments: seed.practices,
    practice_exceptions: seed.exceptions,
  };
  const calls: Array<{ table: string; select: string; eq: Array<[string, unknown]> }> = [];
  return {
    calls,
    from(table: string) {
      const call = { table, select: '', eq: [] as Array<[string, unknown]> };
      calls.push(call);
      const result = (single: boolean) => {
        if (opts.fail?.includes(table)) {
          return { data: null, error: { message: `${table}: synthetic read failure` } };
        }
        const rows = (tables[table] ?? []).filter((r) => call.eq.every(([c, v]) => r[c] === v));
        return single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
      };
      const builder: Rec = {
        select(columns: string) {
          call.select = columns;
          return builder;
        },
        eq(column: string, value: unknown) {
          call.eq.push([column, value]);
          return builder;
        },
        or() {
          return builder;
        },
        order() {
          return builder;
        },
        limit() {
          return builder;
        },
        maybeSingle() {
          return Promise.resolve(result(true));
        },
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
          return Promise.resolve(result(false)).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}
