/**
 * 8.6 3b PR 12d: RSVP follows the applied practice calendar -- the mock arm
 * (docs/PHASE_8_6_PR12_READERS_PLAN.md §4 R7, §6 W14, §10 Q4).
 *
 * One case table, three arms:
 * - `tests/fixtures/rsvpAppliedCalendarCases.json` is the table and its seed;
 * - `docs/sql/20261005000000_smoke.sql` (the local harness) and
 *   `supabase/tests/rsvp_applied_practice_calendar.sql` (pgTAP) restate the
 *   seed and carry the case rows between `case-table:begin`/`:end` markers;
 * - this file pins those rows equal to the JSON, runs the MOCK
 *   `upsert_team_event_rsvp` over the same seed, and holds every expectation
 *   to the 12a helper (`applyPracticeExceptions`): a date is accepted exactly
 *   when the helper shows it as a timed practice of that row.
 *
 * The subject set is the JSON's case list, never the RPC's answers; every
 * meta-assertion below has a negative control that makes it fail.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyPracticeExceptions } from '../packages/core/src/utils/practiceExceptions.js';
import {
  practiceRangeBounds,
  practiceRangeLowerBound,
} from '../packages/core/src/utils/practiceOccurrences.js';
import { getMockData, mockSupabase as supabase } from '../frontend/src/lib/mockSupabaseClient.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TABLE = JSON.parse(
  readFileSync(path.join(REPO, 'tests/fixtures/rsvpAppliedCalendarCases.json'), 'utf8')
);
const ORG = 'org-1';
const PARENT = 'mock-parent-id';
const ROW_KEYS = Object.keys(TABLE.rows);

const ids = (key) => ({
  team: `team-d12-${key}`,
  player: `player-d12-${key}`,
  assignment: `pa-d12-${key}`,
  slot: `slot-d12-${TABLE.rows[key].day}`,
});

/** The text between one SQL file's case-table markers. */
function caseBlock(file) {
  const src = readFileSync(path.join(REPO, file), 'utf8');
  const begin = src.indexOf('-- case-table:begin');
  const end = src.indexOf('-- case-table:end');
  expect(begin, `${file} has a case-table:begin marker`).toBeGreaterThan(-1);
  expect(end, `${file} has a case-table:end marker`).toBeGreaterThan(begin);
  return src.slice(begin, end);
}

/**
 * The pgTAP suite's cases: one assertion statement each. The row key, the
 * date and the outcome are read from the CALL (the function, its SQLSTATE,
 * the date it sends, the row it selects), and the description must agree
 * with them, so a label cannot drift from what the statement runs.
 */
const PGTAP_CASE =
  /^SELECT (lives_ok|throws_ok)\(r\.call \|\| '''(\d{4}-\d{2}-\d{2})''::date, ''attending''\)'(?:, '(\d{5})', NULL)?, 'case ([ABC]) (\d{4}-\d{2}-\d{2}) (accept|\d{5})'\) FROM d12_rows r WHERE r\.row_key = '([ABC])';$/;

function pgtapCases(file) {
  const lines = caseBlock(file)
    .split('\n')
    .filter((line) => line.startsWith('SELECT '));
  return lines.map((line) => {
    const m = PGTAP_CASE.exec(line);
    expect(m, `unparsed pgTAP case: ${line}`).not.toBe(null);
    const [, fn, date, code, tagRow, tagDate, tagExpect, row] = m;
    const outcome = fn === 'lives_ok' ? 'accept' : code;
    expect([tagRow, tagDate, tagExpect], line).toEqual([row, date, outcome]);
    return { row, date, expect: outcome };
  });
}

/** The smoke's cases: its VALUES rows, as { row, date, expect }. */
function sqlCases(file) {
  const rows = [
    ...caseBlock(file).matchAll(/'([ABC])',\s*'(\d{4}-\d{2}-\d{2})',\s*'(accept|22023|42501)'/g),
  ];
  return rows.map(([, row, date, expectCode]) => ({ row, date, expect: expectCode }));
}

/** Meta: the seed exercises every window kind the table claims to. */
function seedExercises(exceptions) {
  const live = exceptions.filter((e) => !e.withdrawn);
  return (
    live.some((e) => e.kind === 'relocated' && practiceRangeBounds(e.window) !== null) &&
    live.some((e) => e.kind === 'time_tbd' && practiceRangeBounds(e.window) !== null) &&
    exceptions.some((e) => e.withdrawn) &&
    live.some((e) => practiceRangeBounds(e.window) === null && practiceRangeLowerBound(e.window)) &&
    live.some((e) => practiceRangeLowerBound(e.window) === null)
  );
}

/** The 12a helper's rows and exceptions for the seed. */
function helperInput() {
  const slot = (day) => ({ day_of_week: day, start_time: '17:00', end_time: '18:30' });
  return {
    rows: ROW_KEYS.map((key) => ({
      id: ids(key).assignment,
      effective_date_range: TABLE.rows[key].range,
      slot: slot(TABLE.rows[key].day),
    })),
    exceptions: TABLE.exceptions.map((e) => ({
      id: e.id,
      assignment_id: ids(e.row).assignment,
      window: e.window,
      kind: e.kind,
      practice_slot_id: e.slotDay ? `slot-d12-${e.slotDay}` : null,
      tbd_reason: e.tbdReason ?? null,
      cause_kind: 'retirement',
      withdrawn_at: e.withdrawn ? '2026-09-01T00:00:00Z' : null,
      slot: e.slotDay ? slot(e.slotDay) : null,
    })),
  };
}

/**
 * The seed as mock rows, every one carrying `organization_id`, written through
 * the sanctioned `window.__saveMockDB__` (tests/mockDeleteTombstones.test.js).
 */
function seedMock(exceptions = TABLE.exceptions, extra = {}) {
  const days = new Set([
    ...Object.values(TABLE.rows).map((r) => r.day),
    ...exceptions.map((e) => e.slotDay).filter(Boolean),
  ]);
  window.__saveMockDB__({
    ...extra,
    teams: ROW_KEYS.map((key) => ({
      id: ids(key).team,
      organization_id: ORG,
      name: `D12 Team ${key}`,
    })),
    players: ROW_KEYS.map((key) => ({
      id: ids(key).player,
      organization_id: ORG,
      first_name: `Sample${key}`,
      last_name: 'Player',
    })),
    team_players: ROW_KEYS.map((key) => ({
      team_id: ids(key).team,
      player_id: ids(key).player,
      organization_id: ORG,
    })),
    profile_players: ROW_KEYS.map((key) => ({
      id: `pp-d12-${key}`,
      profile_id: PARENT,
      player_id: ids(key).player,
      organization_id: ORG,
    })),
    practice_slots: [...days].map((day) => ({
      id: `slot-d12-${day}`,
      organization_id: ORG,
      day_of_week: day,
      start_time: '17:00',
      end_time: '18:30',
    })),
    practice_assignments: ROW_KEYS.map((key) => ({
      id: ids(key).assignment,
      organization_id: ORG,
      team_id: ids(key).team,
      practice_slot_id: ids(key).slot,
      effective_date_range: TABLE.rows[key].range,
    })),
    practice_exceptions: exceptions.map((e) => ({
      id: `pe-d12-${e.id}`,
      organization_id: ORG,
      season_settings_id: 'season-1',
      team_id: ids(e.row).team,
      assignment_id: ids(e.row).assignment,
      window: e.window,
      kind: e.kind,
      practice_slot_id: e.slotDay ? `slot-d12-${e.slotDay}` : null,
      tbd_reason: e.tbdReason ?? null,
      cause_kind: 'retirement',
      withdrawn_at: e.withdrawn ? '2026-09-01T00:00:00Z' : null,
    })),
  });
}

/** The mock RPC's outcome for one case: 'accept', or the refusal's SQLSTATE. */
async function outcome({ row, date }) {
  const { error } = await supabase.rpc('upsert_team_event_rsvp', {
    p_team_id: ids(row).team,
    p_player_id: ids(row).player,
    p_reference_id: ids(row).assignment,
    p_event_type: 'practice',
    p_occurrence_date: date,
    p_status: 'attending',
  });
  if (error === null) return 'accept';
  if (error.code === '22023') return '22023';
  // The mock's series refusal carries no code; its message is the SQL's 42501 text.
  return /Event reference is outside the requested team/.test(error.message) ? '42501' : error;
}

describe('RSVP follows the applied practice calendar (W14, mock arm)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.__saveMockDB__({});
    sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: PARENT } }));
  });

  it('the smoke and the pgTAP carry exactly the JSON case table', () => {
    const expected = TABLE.cases.map(({ row, date, expect: code }) => ({
      row,
      date,
      expect: code,
    }));
    expect(expected).toHaveLength(16);
    expect(sqlCases('docs/sql/20261005000000_smoke.sql')).toEqual(expected);
    expect(pgtapCases('supabase/tests/rsvp_applied_practice_calendar.sql')).toEqual(expected);
    // Negative control: a pgTAP label that disagrees with its call parses, and
    // the agreement check above would refuse it.
    const forged =
      "SELECT lives_ok(r.call || '''2026-09-08''::date, ''attending'')', 'case A 2026-09-08 22023') FROM d12_rows r WHERE r.row_key = 'A';";
    const m = PGTAP_CASE.exec(forged);
    expect(m).not.toBe(null);
    expect(m[6]).not.toBe(m[1] === 'lives_ok' ? 'accept' : m[3]);
  });

  it('the seed exercises every window kind, and that meta-assertion can fail', () => {
    expect(seedExercises(TABLE.exceptions)).toBe(true);
    // Negative controls: remove each kind in turn and the assertion goes red.
    const without = [
      (e) => !(e.kind === 'relocated' && !e.withdrawn && practiceRangeBounds(e.window)),
      (e) => !(e.kind === 'time_tbd' && !e.withdrawn && practiceRangeBounds(e.window)),
      (e) => !e.withdrawn,
      (e) =>
        !(
          !e.withdrawn &&
          practiceRangeBounds(e.window) === null &&
          practiceRangeLowerBound(e.window)
        ),
      (e) => practiceRangeLowerBound(e.window) !== null,
    ];
    for (const keep of without) expect(seedExercises(TABLE.exceptions.filter(keep))).toBe(false);
    // Every case expectation is exercised at least once.
    expect(new Set(TABLE.cases.map((c) => c.expect))).toEqual(
      new Set(['accept', '22023', '42501'])
    );
  });

  it('every expectation agrees with the 12a helper: accepted iff shown as a timed practice', () => {
    const { occurrences } = applyPracticeExceptions(helperInput());
    for (const c of TABLE.cases) {
      const shown = occurrences.some(
        (o) =>
          o.assignmentId === ids(c.row).assignment &&
          o.date === c.date &&
          (o.kind === 'series' || o.kind === 'relocated')
      );
      expect(shown, `${c.row} ${c.date}: ${c.label}`).toBe(c.expect === 'accept');
    }
  });

  it('the mock RPC answers every case as the SQL does', async () => {
    seedMock();
    const got = [];
    for (const c of TABLE.cases) got.push({ ...c, got: await outcome(c) });
    expect(got.map((c) => `${c.row} ${c.date} ${c.got}`)).toEqual(
      TABLE.cases.map((c) => `${c.row} ${c.date} ${c.expect}`)
    );
  });

  it('stored RSVPs on dates that became TIME TBD or moved are neither deleted nor rewritten (Q4)', async () => {
    const stored = [
      { date: '2026-10-13', status: 'attending' },
      { date: '2026-09-22', status: 'maybe' },
    ].map(({ date, status }) => ({
      id: `rsvp-d12-${date}`,
      organization_id: ORG,
      team_id: ids('A').team,
      player_id: ids('A').player,
      reference_id: ids('A').assignment,
      event_type: 'practice',
      occurrence_date: date,
      status,
      updated_at: '2026-09-01T00:00:00.000Z',
    }));
    seedMock(TABLE.exceptions, { event_rsvps: stored });
    for (const c of TABLE.cases) await outcome(c);
    const after = getMockData('event_rsvps');
    for (const row of stored) expect(after.find((r) => r.id === row.id)).toEqual(row);
    const accepted = TABLE.cases.filter((c) => c.expect === 'accept').length;
    expect(after.filter((r) => String(r.team_id).startsWith('team-d12-'))).toHaveLength(
      stored.length + accepted
    );
  });

  it('a withdrawn exception has no effect: with every exception withdrawn, the series rule alone answers', async () => {
    seedMock(TABLE.exceptions.map((e) => ({ ...e, withdrawn: true })));
    // A's relocated date is off the series weekday; its TBD date is on it.
    expect(await outcome({ row: 'A', date: '2026-09-17' })).toBe('42501');
    expect(await outcome({ row: 'A', date: '2026-10-06' })).toBe('accept');
    expect(await outcome({ row: 'C', date: '2026-09-16' })).toBe('accept');
  });
});
