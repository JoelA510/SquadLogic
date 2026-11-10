/**
 * The Edge function's games import held to core (plan `docs/changes/2026-11-03-schedule-expansion.md`, PR 6, tasks F1
 * and F7). The Vitest twin of `supabase/functions/_shared/tests/schedule-import_test.ts`, which CI runs under Deno and
 * which cannot be run where Deno is absent.
 *
 * `supabase/functions/_shared/schedule-import.ts` is a second copy of core's parse, staging and confirm counts,
 * because an Edge Function cannot import `packages/core`. Three things hold it to core:
 *
 * 1. **The table is core's.** `schedule-import.vectors.json` is regenerated here and must equal the checked-in file,
 *    so a table core no longer reproduces fails (a stale table cannot sit green).
 * 2. **The mirror reproduces the table**, and both copies agree on the shipped fixtures (574 games and every refusal
 *    reason), to the last key of every staged row.
 * 3. **The host zone is never read**: the same answers under three other `TZ` values, with the named instants
 *    written out here (a spring-forward gap, a fall-back hour, a half-hour zone, a southern-hemisphere zone).
 *
 * The plant (the conversion reads the host zone) is in the PR description: with `timeZone` dropped from the mirror's
 * formatter the named instants and the other-zone runs go red.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SCHEDULE_IMPORT_CHUNK_LIMITS,
  SCHEDULE_IMPORT_CONFIRM_MAX_KEYS,
  SCHEDULE_IMPORT_LIMITS,
  SCHEDULE_IMPORT_STAGED_FLAGS,
  diffScheduleImportConfirmCounts,
  isScheduleImportConfirmCounts,
  scheduleImportConfirmCounts,
  scheduleLabelKey,
  stageScheduleChunk,
} from '../packages/core/src/scheduleImport/index.js';
import * as edge from '../supabase/functions/_shared/schedule-import.ts';
import {
  SCHEDULE_IMPORT_VECTORS_PATH,
  buildScheduleImportVectors,
  serialiseScheduleImportVectors,
} from '../scripts/generate-schedule-import-vectors.mjs';
import { loadScheduleFixture } from './helpers/scheduleFixtureLoad.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TABLE_TEXT = readFileSync(path.join(REPO, SCHEDULE_IMPORT_VECTORS_PATH), 'utf8');
const TABLE = JSON.parse(TABLE_TEXT);
const plain = (value) => JSON.parse(JSON.stringify(value));
const OTHER_ZONES = ['Asia/Tokyo', 'America/St_Johns', 'Pacific/Kiritimati'];

/** Run `fn` with the host zone set to `tz`, and put it back. */
function underZone(tz, fn) {
  const original = process.env.TZ;
  process.env.TZ = tz;
  try {
    // The control that the switch took: the host's own reading of one instant moves with it.
    return fn(new Date(Date.UTC(2026, 0, 1, 12)).getHours());
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

describe('the vector table is core’s', () => {
  it('equals what core produces now, byte for byte (regenerate it when core changes)', () => {
    expect(serialiseScheduleImportVectors(buildScheduleImportVectors())).toBe(TABLE_TEXT);
  });

  it('reaches every outcome the Edge stage can give (a table that reached half would compare half)', () => {
    const codes = new Set();
    for (const v of TABLE.vectors) {
      if (v.expected.refusal) codes.add(`file:${v.expected.refusal.code}`);
      for (const s of v.expected.staged) {
        codes.add(s.normalized_payload ? s.normalized_payload.status : s.validation_errors[0].code);
        for (const f of s.normalized_payload?.flags ?? []) codes.add(f);
      }
      for (const w of v.expected.summary.warnings) codes.add(w.code);
    }
    const wanted = [
      ...Object.values(edge.GAME_IMPORT_REASON).filter(
        (code) =>
          ![
            'missing-column',
            'duplicate-column',
            'too-many-rows',
            'no-season-clock',
            'imported-without-time',
          ].includes(code)
      ),
      'ok',
      'tbd',
      'file:too-many-rows',
      'file:missing-column',
      'file:no-season-clock',
      'file:missing-week',
    ];
    // `duplicate-column` is reached below (a header row is not a row vector); `missing-week` as a row needs a file
    // that has the column, also below.
    expect(wanted.filter((code) => !codes.has(code))).toEqual(['missing-week']);
    expect(TABLE.vectors.length).toBeGreaterThanOrEqual(18);
  });

  it('stages nothing of a column the allowlist does not hold, and no markup', () => {
    const v = TABLE.vectors.find((x) => x.name.startsWith('only the allowlisted columns'));
    // CONTROL: the input carries them, so their absence below is the allowlist's doing.
    const input = JSON.stringify(v.rows);
    for (const secret of [
      'coach.placeholder@example.com',
      'never read',
      '4v4',
      'call the placeholder',
      '<b>',
    ])
      expect(input).toContain(secret);
    const out = JSON.stringify(v.expected);
    for (const secret of [
      'coach.placeholder@example.com',
      'never read',
      '4v4',
      'call the placeholder',
      '<b>',
    ])
      expect(out).not.toContain(secret);
    expect(v.expected.summary.dropped_columns).toEqual(['Notes', 'Coach Email', 'Format']);
    expect(Object.keys(v.expected.staged[0].raw_payload).sort()).toEqual(
      [
        'Away Team',
        'Date',
        'Division',
        'End Time',
        'Field',
        'Game ID',
        'Home Team',
        'Start Time',
        'Venue',
        'Week',
      ].sort()
    );
    expect(v.expected.staged[0].normalized_payload.venue).toBe('Venue A');
  });
});

describe('the Edge mirror stages what core stages', () => {
  const run = (v) =>
    plain(
      edge.stageGameChunk({
        headers: v.headers,
        rows: v.rows,
        season: v.season,
        rowOffset: v.rowOffset,
      })
    );

  it('every vector, key for key', () => {
    for (const v of TABLE.vectors) expect(run(v), v.name).toEqual(v.expected);
  });

  it('every vector again under three other host zones (the host zone is not read)', () => {
    const seen = new Set();
    for (const tz of OTHER_ZONES) {
      underZone(tz, (noonHour) => {
        seen.add(noonHour);
        for (const v of TABLE.vectors) {
          expect(run(v), `${tz}: ${v.name}`).toEqual(v.expected);
          // and core itself, the canonical one
          expect(
            plain(
              stageScheduleChunk({
                headers: v.headers,
                rows: v.rows,
                season: v.season,
                rowOffset: v.rowOffset,
              })
            ),
            `core under ${tz}: ${v.name}`
          ).toEqual(v.expected);
        }
      });
    }
    // The zones really differed: three different host readings of one instant.
    expect(seen.size).toBe(3);
  });

  it('the shipped fixtures: 574 games and every refusal reason, in chunks of 500 as the browser sends them', () => {
    const fixture = loadScheduleFixture();
    for (const file of [fixture.schedule, fixture.invalid]) {
      let total = 0;
      for (
        let offset = 0;
        offset < file.rows.length;
        offset += SCHEDULE_IMPORT_CHUNK_LIMITS.MAX_CHUNK_ROWS
      ) {
        const input = {
          headers: file.headers,
          rows: file.rows.slice(offset, offset + SCHEDULE_IMPORT_CHUNK_LIMITS.MAX_CHUNK_ROWS),
          season: fixture.season,
          rowOffset: offset,
        };
        const fromCore = plain(stageScheduleChunk(input));
        expect(plain(edge.stageGameChunk(input))).toEqual(fromCore);
        expect(fromCore.refusal).toBeNull();
        total += fromCore.staged.length;
      }
      expect(total).toBe(file.rows.length);
    }
    expect(fixture.schedule.rows.length).toBeGreaterThan(500); // the second chunk was exercised
  });

  it('a header given twice, and a blank Week with no season start, in both copies', () => {
    const v = TABLE.vectors[0];
    const twice = { headers: [...v.headers, 'date'], rows: v.rows, season: v.season, rowOffset: 0 };
    expect(plain(edge.stageGameChunk(twice))).toEqual(plain(stageScheduleChunk(twice)));
    expect(edge.stageGameChunk(twice).refusal?.code).toBe('duplicate-column');
    const noStart = {
      headers: v.headers,
      rows: v.rows,
      season: { timeZone: 'America/Los_Angeles', startDate: null, endDate: null },
      rowOffset: 0,
    };
    expect(plain(edge.stageGameChunk(noStart))).toEqual(plain(stageScheduleChunk(noStart)));
    expect(edge.stageGameChunk(noStart).staged[0].validation_errors[0].code).toBe('missing-week');
  });

  it('agrees with core on the limits, the staged flags and the label key', () => {
    expect(edge.GAME_IMPORT_LIMITS.MAX_ROWS).toBe(SCHEDULE_IMPORT_LIMITS.MAX_ROWS);
    expect(edge.GAME_IMPORT_LIMITS.MAX_GAME_ID_LENGTH).toBe(
      SCHEDULE_IMPORT_LIMITS.MAX_GAME_ID_LENGTH
    );
    expect(edge.GAME_IMPORT_LIMITS.MAX_CHUNK_ROWS).toBe(
      SCHEDULE_IMPORT_CHUNK_LIMITS.MAX_CHUNK_ROWS
    );
    expect(edge.GAME_IMPORT_LIMITS.MAX_CELL_LENGTH).toBe(
      SCHEDULE_IMPORT_CHUNK_LIMITS.MAX_CELL_LENGTH
    );
    expect(edge.GAME_IMPORT_LIMITS.MAX_HEADERS).toBe(SCHEDULE_IMPORT_CHUNK_LIMITS.MAX_HEADERS);
    expect([...edge.GAME_IMPORT_STAGED_FLAGS]).toEqual([...SCHEDULE_IMPORT_STAGED_FLAGS]);
    expect(edge.GAME_IMPORT_CONFIRM_MAX_KEYS).toBe(SCHEDULE_IMPORT_CONFIRM_MAX_KEYS);
    for (const label of ['  Blue  Jays ', 'BLUE\tJAYS', '', null, undefined, 'İstanbul'])
      expect(edge.scheduleLabelKey(label)).toBe(scheduleLabelKey(label));
  });
});

describe('named instants on the season clock (written here, not read from either copy)', () => {
  const HEADERS = TABLE.vectors[0].headers;
  const one = (stage, timeZone, date, start, end) => {
    const got = stage({
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
      ? `${s.normalized_payload.start} ${s.normalized_payload.end} [${s.normalized_payload.flags.join(',')}]`
      : s.validation_errors[0].code;
  };
  const CASES = [
    [
      'a US spring-forward Sunday: the wall time does not exist',
      'America/Los_Angeles',
      '2027-03-14',
      '02:30',
      '03:30',
      'time-in-dst-gap',
    ],
    [
      'a US fall-back Sunday: the first occurrence, flagged',
      'America/Los_Angeles',
      '2026-11-01',
      '01:30',
      '02:30',
      '2026-11-01T01:30:00-07:00 2026-11-01T02:30:00-08:00 [time-ambiguous]',
    ],
    [
      'a half-hour offset',
      'Asia/Kolkata',
      '2026-09-12',
      '18:45',
      '19:45',
      '2026-09-12T18:45:00+05:30 2026-09-12T19:45:00+05:30 []',
    ],
    [
      'the southern hemisphere, in its summer',
      'Australia/Sydney',
      '2026-12-12',
      '09:00',
      '10:00',
      '2026-12-12T09:00:00+11:00 2026-12-12T10:00:00+11:00 []',
    ],
    [
      'the southern hemisphere, its gap in October',
      'Australia/Sydney',
      '2026-10-04',
      '02:30',
      '03:30',
      'time-in-dst-gap',
    ],
    [
      'a southern half-hour zone in winter',
      'Australia/Adelaide',
      '2026-09-12',
      '09:00',
      '10:00',
      '2026-09-12T09:00:00+09:30 2026-09-12T10:00:00+09:30 []',
    ],
  ];

  for (const [name, tz, date, start, end, want] of CASES) {
    it(`${name} (${tz} ${date} ${start})`, () => {
      for (const host of [undefined, ...OTHER_ZONES]) {
        const check = () => {
          expect(one(edge.stageGameChunk, tz, date, start, end), `edge, host ${host}`).toBe(want);
          expect(one(stageScheduleChunk, tz, date, start, end), `core, host ${host}`).toBe(want);
        };
        if (host === undefined) check();
        else underZone(host, check);
      }
    });
  }
});

describe('a 500-row chunk is read well inside one request’s CPU (lesson 42; timed in the mode CI runs, lesson 59)', () => {
  it('stages 500 rows in under 1.5 s, in the mirror and in core', () => {
    const fixture = loadScheduleFixture();
    const input = {
      headers: fixture.schedule.headers,
      rows: fixture.schedule.rows.slice(0, 500),
      season: fixture.season,
      rowOffset: 0,
    };
    expect(input.rows).toHaveLength(500);
    for (const stage of [edge.stageGameChunk, stageScheduleChunk]) {
      const started = performance.now();
      const out = stage(input);
      const elapsed = performance.now() - started;
      expect(out.staged).toHaveLength(500);
      expect(elapsed).toBeLessThan(1500);
    }
  });
});

describe('the confirm counts (F7): one list, in core and in the mirror', () => {
  const result = (over = {}) => ({
    dry_run: true,
    arrive_published: true,
    nothing_to_apply: false,
    rows: { staged: 21, refused: 6, skipped: 1, games: 13, time_tbd: 1 },
    refused_by_reason: { 'bad-date': 2, 'unknown-team': 4 },
    games: {
      inserted: 9,
      updated: 2,
      unchanged: 1,
      repointed: 5,
      skipped: { 'skipped-published': 1 },
    },
    time_tbd: { inserted: 1, updated: 0, unchanged: 0, removed: 0, converted: 0 },
    created: { divisions: 1, venues: 0, fields: 1, teams: 2, outside_teams: 3, slots: 9 },
    reused: { slots: 2 },
    not_in_file: { count: 4, ids: ['a'] },
    warnings: [{ type: 'field-overlap' }, { type: 'field-overlap' }, { type: 'week-differs' }],
    listed: { refused: [], skipped: [], skipped_games: [] },
    ...over,
  });

  it('is every count the confirm screen shows, by name', () => {
    expect(scheduleImportConfirmCounts(result())).toEqual({
      arrive_published: true,
      nothing_to_apply: false,
      'rows.staged': 21,
      'rows.refused': 6,
      'rows.skipped': 1,
      'rows.games': 13,
      'rows.time_tbd': 1,
      'refused_by_reason.bad-date': 2,
      'refused_by_reason.unknown-team': 4,
      'games.inserted': 9,
      'games.updated': 2,
      'games.unchanged': 1,
      'games.skipped.skipped-published': 1,
      'time_tbd.inserted': 1,
      'time_tbd.updated': 0,
      'time_tbd.unchanged': 0,
      'time_tbd.removed': 0,
      'time_tbd.converted': 0,
      'created.divisions': 1,
      'created.venues': 0,
      'created.fields': 1,
      'created.teams': 2,
      'created.outside_teams': 3,
      'created.slots': 9,
      not_in_file: 4,
      'warnings.field-overlap': 2,
      'warnings.week-differs': 1,
    });
  });

  it('the mirror gives the same counts, the same verdict on a confirm, and the same differences', () => {
    const cases = [
      result(),
      result({ warnings: [] }),
      result({ games: { inserted: 8, updated: 3, unchanged: 1, repointed: 6, skipped: {} } }),
      result({ arrive_published: false }),
      result({ refused_by_reason: {} }),
      {},
      null,
    ];
    for (const a of cases) {
      expect(edge.gameImportConfirmCounts(a)).toEqual(scheduleImportConfirmCounts(a));
      for (const b of cases) {
        expect(
          edge.diffGameImportConfirmCounts(
            edge.gameImportConfirmCounts(a),
            edge.gameImportConfirmCounts(b)
          )
        ).toEqual(
          diffScheduleImportConfirmCounts(
            scheduleImportConfirmCounts(a),
            scheduleImportConfirmCounts(b)
          )
        );
      }
    }
    for (const candidate of [
      scheduleImportConfirmCounts(result()),
      {},
      null,
      { arrive_published: true, nothing_to_apply: false },
      { ...scheduleImportConfirmCounts(result()), 'rows.staged': '21' },
      { ...scheduleImportConfirmCounts(result()), extra: NaN },
      Object.fromEntries([
        ...Object.entries(scheduleImportConfirmCounts(result())),
        ...Array.from({ length: 120 }, (_, i) => [`warnings.w${i}`, 1]),
      ]),
    ]) {
      expect(edge.isGameImportConfirmCounts(candidate)).toBe(
        isScheduleImportConfirmCounts(candidate)
      );
    }
    expect(isScheduleImportConfirmCounts(scheduleImportConfirmCounts(result()))).toBe(true);
    expect(isScheduleImportConfirmCounts({})).toBe(false);
  });

  it('a count that is not shown does not make a preview stale; one that is shown does (it can fail)', () => {
    const base = scheduleImportConfirmCounts(result());
    expect(
      diffScheduleImportConfirmCounts(
        base,
        scheduleImportConfirmCounts(result({ reused: { slots: 99 } }))
      )
    ).toEqual([]);
    expect(
      diffScheduleImportConfirmCounts(
        base,
        scheduleImportConfirmCounts(result({ created: { ...result().created, outside_teams: 4 } }))
      )
    ).toEqual(['created.outside_teams']);
    // a warning that went away reads as zero, and differs from one
    expect(
      diffScheduleImportConfirmCounts(base, scheduleImportConfirmCounts(result({ warnings: [] })))
    ).toEqual(['warnings.field-overlap', 'warnings.week-differs']);
  });
});

describe('the Edge function uses the mirror, and is its only stage for games', () => {
  const INDEX = readFileSync(
    path.join(REPO, 'supabase/functions/import-validation/index.ts'),
    'utf8'
  );
  it('imports the stage and the confirm from the shared module', () => {
    expect(INDEX).toMatch(/from '\.\.\/_shared\/schedule-import\.ts'/);
    for (const name of ['stageGameChunk', 'applyGameImportConfirmed', 'isGameImportConfirmCounts'])
      expect(INDEX).toContain(name);
    // the season comes from the JOB's season, never the request
    expect(INDEX).toMatch(/season_start/);
    expect(INDEX).not.toMatch(/body\.season\b/);
  });
});
