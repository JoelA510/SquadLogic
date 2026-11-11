/**
 * The games import, in the runtime it is deployed to (plan `docs/changes/2026-11-03-schedule-expansion.md`, PR 6,
 * tasks F1 and F7). `tests/gameImportEdgeParity.test.js` (Vitest) holds `../schedule-import.ts` equal to core over the
 * same table; this file asks the Deno build the same vectors, and the confirm's preview-stale check.
 *
 * `scripts/deno-mirror-tests.sh` runs every file here under `TZ=UTC` and `TZ=America/Los_Angeles`: the expected
 * instants are absolute, so a parse that read the host zone would fail one of the two runs.
 * Placeholder values only.
 */

import { assert, assertEquals } from 'https://deno.land/std@0.203.0/assert/mod.ts';
import {
  applyGameImportConfirmed,
  diffGameImportConfirmCounts,
  GAME_IMPORT_LIMITS,
  GAME_IMPORT_PREVIEW_STALE,
  gameImportConfirmCounts,
  type GameImportRpc,
  isGameImportConfirmCounts,
  stageGameChunk,
} from '../schedule-import.ts';
import table from './fixtures/schedule-import.vectors.json' with { type: 'json' };

interface Vector {
  name: string;
  season: { timeZone: string | null; startDate: string | null; endDate: string | null };
  headers: string[];
  rowOffset: number;
  rows: Array<Record<string, string>>;
  expected: {
    refusal: { code: string } | null;
    staged: Array<{
      normalized_payload: { status: string; flags: string[] } | null;
      validation_errors: Array<{ code: string }>;
    }>;
    summary: { warnings: Array<{ code: string }> };
  };
}
const VECTORS = (table as { vectors: Vector[] }).vectors;

Deno.test('the table reaches every outcome (a table that reached half would compare half)', () => {
  assert(VECTORS.length >= 18);
  const codes = new Set<string>();
  for (const v of VECTORS) {
    if (v.expected.refusal) codes.add(`file:${v.expected.refusal.code}`);
    for (const s of v.expected.staged) {
      codes.add(s.normalized_payload ? s.normalized_payload.status : s.validation_errors[0].code);
      for (const f of s.normalized_payload?.flags ?? []) codes.add(f);
    }
    for (const w of v.expected.summary.warnings) codes.add(w.code);
  }
  for (const code of [
    'ok',
    'tbd',
    'time-in-dst-gap',
    'time-ambiguous',
    'week-differs',
    'bad-time',
    'bad-week',
    'bad-date',
    'bad-game-id',
    'end-not-after-start',
    'same-team',
    'outside-season-window',
    'duplicate-row',
    'game-id-reused',
    'file:too-many-rows',
    'file:missing-column',
    'file:no-season-clock',
    'file:missing-week',
  ])
    assert(codes.has(code), `no vector reaches ${code}`);
});

for (const vector of VECTORS) {
  Deno.test(`stages what core stages: ${vector.name}`, () => {
    const got = stageGameChunk({
      headers: vector.headers,
      rows: vector.rows,
      season: vector.season,
      rowOffset: vector.rowOffset,
    });
    assertEquals(JSON.parse(JSON.stringify(got)), vector.expected);
  });
}

Deno.test('named instants: the season clock decides, written out (not read from the table)', () => {
  const HEADERS = [
    'Game ID',
    'Date',
    'Start Time',
    'End Time',
    'Venue',
    'Field',
    'Division',
    'Home Team',
    'Away Team',
    'Week',
  ];
  const one = (timeZone: string, date: string, start: string, end: string) => {
    const got = stageGameChunk({
      headers: HEADERS,
      rows: [
        {
          'Game ID': 'N-1',
          Date: date,
          'Start Time': start,
          'End Time': end,
          Venue: 'Venue A',
          Field: 'Field 1',
          Division: 'U05 Boys',
          'Home Team': 'U05B Team 01',
          'Away Team': 'U05B Team 02',
          Week: '',
        },
      ],
      season: { timeZone, startDate: '2026-09-07', endDate: '2027-04-30' },
      rowOffset: 0,
    });
    const s = got.staged[0];
    return s.normalized_payload
      ? `${s.normalized_payload.start} ${s.normalized_payload.end} [${(s.normalized_payload.flags as string[]).join(',')}]`
      : s.validation_errors[0].code;
  };
  // a US spring-forward Sunday: the wall time does not exist
  assertEquals(one('America/Los_Angeles', '2027-03-14', '02:30', '03:30'), 'time-in-dst-gap');
  // a US fall-back Sunday: the first occurrence, flagged
  assertEquals(
    one('America/Los_Angeles', '2026-11-01', '01:30', '02:30'),
    '2026-11-01T01:30:00-07:00 2026-11-01T02:30:00-08:00 [time-ambiguous]'
  );
  // a half-hour offset
  assertEquals(
    one('Asia/Kolkata', '2026-09-12', '18:45', '19:45'),
    '2026-09-12T18:45:00+05:30 2026-09-12T19:45:00+05:30 []'
  );
  // the southern hemisphere: summer time in December, the gap in October
  assertEquals(
    one('Australia/Sydney', '2026-12-12', '09:00', '10:00'),
    '2026-12-12T09:00:00+11:00 2026-12-12T10:00:00+11:00 []'
  );
  assertEquals(one('Australia/Sydney', '2026-10-04', '02:30', '03:30'), 'time-in-dst-gap');
});

Deno.test(
  'a chunk past the request limit is the caller’s to refuse; the file limit is counted from the offset',
  () => {
    assertEquals(GAME_IMPORT_LIMITS.MAX_CHUNK_ROWS, 500);
    assertEquals(GAME_IMPORT_LIMITS.MAX_ROWS, 2400);
  }
);

// ------------------------------------------------------------------------------------------------ F7: the confirm

const result = (over: Record<string, unknown> = {}) => ({
  dry_run: true,
  arrive_published: true,
  nothing_to_apply: false,
  rows: { staged: 3, refused: 0, skipped: 0, games: 3, time_tbd: 0 },
  refused_by_reason: {},
  games: { inserted: 3, updated: 0, unchanged: 0, repointed: 2, skipped: {} },
  time_tbd: { inserted: 0, updated: 0, unchanged: 0, removed: 0, converted: 0 },
  created: { divisions: 0, venues: 0, fields: 0, teams: 0, outside_teams: 0, slots: 3 },
  reused: { slots: 0 },
  not_in_file: { count: 2, ids: [] },
  warnings: [],
  ...over,
});

/** A database that answers the dry run with `previews` in turn, and records every call. */
function fakeRpc(previews: unknown[]): { rpc: GameImportRpc; calls: Array<[string, boolean]> } {
  const calls: Array<[string, boolean]> = [];
  let i = 0;
  const rpc: GameImportRpc = (name, params) => {
    calls.push([name, params.p_dry_run === true]);
    if (params.p_dry_run === true) {
      return Promise.resolve({ data: previews[Math.min(i++, previews.length - 1)], error: null });
    }
    return Promise.resolve({ data: { ...result(), dry_run: false }, error: null });
  };
  return { rpc, calls };
}

Deno.test('F7 control: an unchanged schedule applies (one dry run, then the apply)', async () => {
  const confirmed = gameImportConfirmCounts(result());
  assert(isGameImportConfirmCounts(confirmed));
  const { rpc, calls } = fakeRpc([result()]);
  const out = await applyGameImportConfirmed({ rpc, jobId: 'job', confirmed });
  assertEquals(out.kind, 'applied');
  assertEquals(calls, [
    ['apply_game_import_job', true],
    ['apply_game_import_job', false],
  ]);
});

Deno.test(
  'F7: the schedule changed between preview and confirm: refused, both sets of counts, nothing written',
  async () => {
    const confirmed = gameImportConfirmCounts(result());
    // another admin saved a game onto one of the places: one row is now an update, and one more game is not in the file
    const now = result({
      games: { inserted: 2, updated: 1, unchanged: 0, repointed: 3, skipped: {} },
      not_in_file: { count: 3, ids: [] },
    });
    const { rpc, calls } = fakeRpc([now]);
    const out = await applyGameImportConfirmed({ rpc, jobId: 'job', confirmed });
    assertEquals(out.kind, 'stale');
    if (out.kind !== 'stale') throw new Error('unreachable');
    assertEquals(out.code, GAME_IMPORT_PREVIEW_STALE);
    assertEquals(out.differing, ['games.inserted', 'games.updated', 'not_in_file']);
    assertEquals(out.confirmed['games.inserted'], 3);
    assertEquals(out.current['games.inserted'], 2);
    // the apply was never called: only the dry run
    assertEquals(calls, [['apply_game_import_job', true]]);
  }
);

Deno.test(
  'F7: a count the screen does not show is not compared; one it shows is, down to a warning',
  () => {
    const a = gameImportConfirmCounts(result());
    assertEquals(
      diffGameImportConfirmCounts(a, gameImportConfirmCounts(result({ reused: { slots: 9 } }))),
      []
    );
    assertEquals(
      diffGameImportConfirmCounts(
        a,
        gameImportConfirmCounts(result({ warnings: [{ type: 'field-overlap' }] }))
      ),
      ['warnings.field-overlap']
    );
    assertEquals(
      diffGameImportConfirmCounts(a, gameImportConfirmCounts(result({ arrive_published: false }))),
      ['arrive_published']
    );
  }
);

Deno.test(
  'F7: a confirm with no counts is not a confirm, and a finished job answers with what it stored',
  async () => {
    assertEquals(isGameImportConfirmCounts({}), false);
    assertEquals(isGameImportConfirmCounts({ arrive_published: true }), false);
    assertEquals(isGameImportConfirmCounts(null), false);
    assertEquals(
      isGameImportConfirmCounts({ ...gameImportConfirmCounts(result()), 'rows.staged': 'three' }),
      false
    );
    const { rpc, calls } = fakeRpc([{ ...result(), dry_run: false, replayed: true }]);
    const out = await applyGameImportConfirmed({
      rpc,
      jobId: 'job',
      confirmed: gameImportConfirmCounts(result({ rows: { staged: 99 } })),
    });
    assertEquals(out.kind, 'applied');
    assertEquals(calls.length, 1);
  }
);

Deno.test(
  'F7: a database refusal of the dry run or of the apply is passed on, never read as success',
  async () => {
    const refusing: GameImportRpc = () =>
      Promise.resolve({
        data: null,
        error: { code: '22023', message: 'no', details: 'season_completed' },
      });
    const out = await applyGameImportConfirmed({
      rpc: refusing,
      jobId: 'job',
      confirmed: gameImportConfirmCounts(result()),
    });
    assertEquals(out.kind, 'error');
    if (out.kind !== 'error') throw new Error('unreachable');
    assertEquals(out.stage, 'preview');
    assertEquals(out.error.details, 'season_completed');
  }
);
