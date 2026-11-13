/**
 * The Edge function's practice import held to core (plan `docs/changes/2026-11-03-schedule-expansion.md` 4.11.2 to
 * 4.11.6; PR 11, task L1). The Vitest twin of `supabase/functions/_shared/tests/practice-import_test.ts`, which CI
 * runs under Deno (twice, under `TZ=UTC` and `TZ=America/Los_Angeles`) and which cannot be run where Deno is absent.
 *
 * `supabase/functions/_shared/practice-import.ts` is a second copy of core's practice parse and staging, because an
 * Edge Function cannot import `packages/core`. What holds it to core:
 *
 * 1. **The table is core's.** `practice-import.vectors.json` is built here from core and must equal the checked-in
 *    file (`WRITE_PRACTICE_VECTORS=1` rewrites it), so a table core no longer reproduces fails.
 * 2. **The table reaches every outcome** of the stage: each row refusal, each file refusal, each status and the
 *    staged flag; a header alias of plan 4.11.2 (`Venue`, `Half`, `Side`); days in every accepted form.
 * 3. **The mirror reproduces the table and agrees with core on the shipped fixtures**, to the last key of every
 *    staged row, and under three other host zones (no instant is converted, so the host zone must not matter).
 * 4. **Only the allowlist is staged**: every staged key is an allowlisted key of `practice_schedule`, and a dropped
 *    column's values appear nowhere.
 * 5. **Timed in the mode CI runs** (lesson 59): the whole cap, 2,400 rows, staged in one request, well under the
 *    2 s of CPU a request gets, and a 500-row slice for comparison with the games chunk.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PRACTICE_IMPORT_COLUMNS,
  PRACTICE_IMPORT_FILE_REFUSALS,
  PRACTICE_IMPORT_ROW_REFUSALS,
  PRACTICE_STAGED_FLAGS,
  PRACTICE_STAGED_KEYS,
  stagePracticeFile as coreStage,
  stagedPracticeRowToParsed,
} from '../packages/core/src/practiceImport/index.js';
import { sanitizeImportText } from '../frontend/src/utils/importRows.js';
import {
  PRACTICE_SCHEDULE_IMPORT_KEYS,
  isAllowedImportKey,
} from '../frontend/src/utils/importAllowlist.js';
import * as edge from '../supabase/functions/_shared/practice-import.ts';
import { sanitizeImportText as edgeSanitize } from '../supabase/functions/_shared/import-rows.ts';
import { loadPracticeFixture } from './helpers/practiceFixtureLoad.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TABLE_PATH = 'supabase/functions/_shared/tests/fixtures/practice-import.vectors.json';
const plain = (value) => JSON.parse(JSON.stringify(value));
const OTHER_ZONES = ['Asia/Tokyo', 'America/St_Johns', 'Pacific/Kiritimati'];
const SEASON = { startDate: '2026-09-07', endDate: '2027-03-31' };
const HEAD = [
  'Team',
  'Division',
  'Day',
  'Start',
  'End',
  'Location',
  'Field',
  'Subunit',
  'Valid From',
  'Valid Until',
  'Capacity',
  'Use',
];
/** A row of the template's columns, from a few cells. */
const row = (cells) => ({
  Team: 'U10B-01',
  Division: 'U10 Boys',
  Day: 'Tue',
  Start: '16:00',
  End: '17:00',
  Location: 'Venue A',
  Field: 'Field 1',
  Subunit: '',
  'Valid From': '',
  'Valid Until': '',
  Capacity: '',
  Use: '',
  ...cells,
});

/** The named vectors: each a small file that reaches one or more outcomes. Placeholder values only. */
function vectorInputs() {
  const v = (name, rows, extra = {}) => ({
    name,
    headers: HEAD,
    rows,
    season: SEASON,
    dates: null,
    ...extra,
  });
  return [
    v('a placement, an open slot and a hold', [
      row({}),
      row({ Team: '', Division: '', Start: '17:00', End: '18:00' }),
      row({ Team: '', Division: '', Use: 'hold', Start: '18:00', End: '19:00' }),
    ]),
    v('days in every accepted form', [
      ...[
        'Mon',
        'monday',
        'TUE',
        'tues',
        'Tuesday',
        'wed',
        'Weds',
        'wednesday',
        'thu',
        'Thur',
        'thurs',
        'Thursday',
        'fri',
        'Friday',
        'sat',
        'Saturday',
        'sun',
        'SUNDAY',
        ' Mon ',
      ].map((Day, i) => row({ Day, Team: `U10B-${String(i + 10)}` })),
      row({ Day: 'Mo', Team: 'U10B-90' }),
      row({ Day: '', Team: 'U10B-91' }),
    ]),
    v('times in both forms, midnight and noon', [
      row({ Start: '4:00 PM', End: '5:00 PM' }),
      row({ Team: 'U10B-02', Start: '12:30 PM', End: '1:15 PM' }),
      row({ Team: 'U10B-03', Start: '12:00 AM', End: '12:45 AM' }),
      row({ Team: 'U10B-04', Start: '16:00', End: '12:00 AM' }),
      row({ Team: 'U10B-05', Start: '25:00' }),
      row({ Team: 'U10B-06', Start: '' }),
      row({ Team: 'U10B-07', End: '4pm-ish' }),
      row({ Team: 'U10B-08', Start: '17:00', End: '16:30' }),
    ]),
    v(
      'Length instead of End, and both',
      [
        { ...row({}), Length: '45' },
        { ...row({ Team: 'U10B-02', End: '' }), Length: '60' },
        { ...row({ Team: 'U10B-03', End: '17:00' }), Length: '30' },
        { ...row({ Team: 'U10B-04', End: '' }), Length: 'an hour' },
        { ...row({ Team: 'U10B-05', End: '', Start: '23:30' }), Length: '45' },
        { ...row({ Team: 'U10B-06', End: '' }), Length: '' },
      ],
      { headers: [...HEAD, 'Length'] }
    ),
    v('capacity', [
      row({ Capacity: '2' }),
      row({ Team: 'U10B-02', Capacity: '0' }),
      row({ Team: 'U10B-03', Capacity: '-1' }),
      row({ Team: 'U10B-04', Capacity: 'two' }),
      row({ Team: 'U10B-05', Capacity: '40000' }),
    ]),
    v('dates: the row, the season, out of the window, reversed, unreadable', [
      row({ 'Valid From': '2026-10-01', 'Valid Until': '11/30/2026' }),
      row({ Team: 'U10B-02', 'Valid From': '2026-08-01' }),
      row({ Team: 'U10B-03', 'Valid Until': '2027-05-01' }),
      row({ Team: 'U10B-04', 'Valid From': '2026-12-01', 'Valid Until': '2026-11-01' }),
      row({ Team: 'U10B-05', 'Valid From': '13/04/2026' }),
      row({ Team: 'U10B-06', 'Valid Until': 'soon' }),
    ]),
    v('the confirm step’s dates stand in for blank cells', [row({}), row({ Team: 'U10B-02' })], {
      dates: { validFrom: '2026-10-05', validUntil: '2026-12-18' },
    }),
    v('no dates anywhere', [row({})], { season: { startDate: null, endDate: null } }),
    v('Use: hold with a team, an unknown Use', [
      row({ Use: 'hold' }),
      row({ Team: '', Division: '', Use: 'closed' }),
    ]),
    v('blank ground and a placement’s blank division', [
      row({ Division: '' }),
      row({ Team: 'U10B-02', Location: '' }),
      row({ Team: 'U10B-03', Field: '' }),
      row({ Team: '', Division: '', Location: ' ' }),
    ]),
    v('a team label in two divisions, the same practice twice, a stray space', [
      row({ Team: 'Lions', Division: 'U10 Boys' }),
      row({ Team: 'Lions', Division: 'U12 Boys', Day: 'Thu' }),
      row({ Team: 'U10B-02' }),
      row({ Team: ' U10B-02  ', Division: 'U10  Boys' }),
    ]),
    v('a division on an open slot reserves nothing', [row({ Team: '', Division: 'U10 Boys' })]),
    v(
      'header aliases: Venue, Half',
      [
        {
          Team: 'U10B-01',
          Division: 'U10 Boys',
          Day: 'Wed',
          Start: '16:00',
          End: '17:00',
          Venue: 'Venue B',
          Field: 'Field 2',
          Half: 'A',
        },
      ],
      { headers: ['Team', 'Division', 'Day', 'Start', 'End', 'Venue', 'Field', 'Half'] }
    ),
    v(
      'header alias: Side',
      [
        {
          Team: 'U10B-01',
          Division: 'U10 Boys',
          Day: 'Wed',
          Start: '16:00',
          End: '17:00',
          Location: 'Venue B',
          Field: 'Field 2',
          Side: 'B',
        },
      ],
      { headers: ['Team', 'Division', 'Day', 'Start', 'End', 'Location', 'Field', 'Side'] }
    ),
    v(
      'only the allowlisted columns are read',
      [
        {
          ...row({ Team: '<b>U10B-01</b>' }),
          Coach: 'Placeholder Coach',
          'Coach Email': 'coach.placeholder@example.com',
          Notes: 'call the placeholder number',
        },
      ],
      { headers: [...HEAD, 'Coach', 'Coach Email', 'Notes'] }
    ),
    v('a missing column', [{ Day: 'Mon', Start: '16:00', End: '17:00', Field: 'Field 1' }], {
      headers: ['Day', 'Start', 'End', 'Field'],
    }),
    v('neither End nor Length', [row({})], {
      headers: HEAD.filter((h) => h !== 'End'),
    }),
    v('a Team column with no Division', [row({})], {
      headers: HEAD.filter((h) => h !== 'Division'),
    }),
    v('the same column twice by an alias', [row({})], { headers: [...HEAD, 'Venue'] }),
    v(
      'too many rows',
      Array.from({ length: 2401 }, (_, i) => row({ Team: `T-${i}` }))
    ),
  ];
}

/** Core's stage of a vector, as the mock's `import-validation` calls it. */
const coreOf = (v) =>
  plain(
    coreStage({
      headers: v.headers,
      rows: v.rows,
      season: v.season,
      dates: v.dates,
      clean: sanitizeImportText,
    })
  );
const edgeOf = (v) =>
  plain(
    edge.stagePracticeFile({
      headers: v.headers,
      rows: v.rows,
      season: v.season,
      dates: v.dates,
      clean: edgeSanitize,
    })
  );

/** The table: every vector with what core stages for it. The too-many-rows input is described, not written out. */
function buildTable() {
  return {
    note: 'Generated by tests/practiceImportEdgeParity.test.js from core (WRITE_PRACTICE_VECTORS=1). Do not edit.',
    vectors: vectorInputs().map((v) => ({
      ...v,
      rows: v.name === 'too many rows' ? { repeat: v.rows[0], count: v.rows.length } : v.rows,
      expected: coreOf(v),
    })),
  };
}
const serialise = (table) => `${JSON.stringify(table, null, 2)}\n`;
/** A vector as the stage takes it (the too-many-rows rows expanded). */
const inputOf = (v) =>
  Array.isArray(v.rows)
    ? v
    : { ...v, rows: Array.from({ length: v.rows.count }, () => ({ ...v.rows.repeat })) };

if (process.env.WRITE_PRACTICE_VECTORS === '1') {
  writeFileSync(path.join(REPO, TABLE_PATH), serialise(buildTable()));
}
const TABLE_TEXT = readFileSync(path.join(REPO, TABLE_PATH), 'utf8');
const TABLE = JSON.parse(TABLE_TEXT);

/** Run `fn` with the host zone set to `tz`, and put it back. */
function underZone(tz, fn) {
  const original = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn(new Date(Date.UTC(2026, 0, 1, 12)).getHours());
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

describe('the vector table is core’s', () => {
  it('equals what core produces now, byte for byte (WRITE_PRACTICE_VECTORS=1 rewrites it)', () => {
    expect(serialise(buildTable())).toBe(TABLE_TEXT);
  });

  it('reaches every outcome of the stage (a table that reached half would compare half)', () => {
    const codes = new Set();
    for (const v of TABLE.vectors) {
      if (v.expected.refusal) codes.add(`file:${v.expected.refusal.code}`);
      for (const s of v.expected.staged) {
        codes.add(s.normalized_payload ? s.normalized_payload.status : s.validation_errors[0].code);
        for (const f of s.normalized_payload?.flags ?? []) codes.add(f);
      }
    }
    // The row refusals the parse can give; the four the mapping or the database judge are not the stage's.
    const parseRefusals = PRACTICE_IMPORT_ROW_REFUSALS.filter(
      (c) => !['unknown-team', 'unknown-subunit', 'slot-overlaps-another'].includes(c)
    );
    const wanted = [
      ...parseRefusals,
      ...PRACTICE_IMPORT_FILE_REFUSALS.map((c) => `file:${c}`),
      'placement',
      'open',
      'hold',
      ...PRACTICE_STAGED_FLAGS,
    ];
    expect(wanted.filter((code) => !codes.has(code))).toEqual([]);
  });

  it('reads days in every accepted form, and refuses the rest', () => {
    const v = TABLE.vectors.find((x) => x.name === 'days in every accepted form');
    const days = v.expected.staged.map(
      (s) => s.normalized_payload?.day ?? s.validation_errors[0].code
    );
    expect(days).toEqual([
      'mon',
      'mon',
      'tue',
      'tue',
      'tue',
      'wed',
      'wed',
      'wed',
      'thu',
      'thu',
      'thu',
      'thu',
      'fri',
      'fri',
      'sat',
      'sat',
      'sun',
      'sun',
      'mon',
      'bad-day',
      'bad-day',
    ]);
  });

  it('reads the header aliases of plan 4.11.2 (Venue for Location, Half and Side for Subunit)', () => {
    const venue = TABLE.vectors.find((x) => x.name === 'header aliases: Venue, Half');
    expect(venue.expected.staged[0].normalized_payload).toMatchObject({
      location: 'Venue B',
      subunit: 'A',
    });
    expect(venue.expected.staged[0].raw_payload).toEqual(
      expect.objectContaining({ Location: 'Venue B', Subunit: 'A' })
    );
    const side = TABLE.vectors.find((x) => x.name === 'header alias: Side');
    expect(side.expected.staged[0].normalized_payload.subunit).toBe('B');
  });

  it('stages nothing of a column the allowlist does not hold, and no markup', () => {
    const v = TABLE.vectors.find((x) => x.name === 'only the allowlisted columns are read');
    const secrets = [
      'Placeholder Coach',
      'coach.placeholder@example.com',
      'call the placeholder',
      '<b>',
    ];
    // CONTROL: the input carries them, so their absence below is the allowlist's doing.
    for (const secret of secrets) expect(JSON.stringify(v.rows)).toContain(secret);
    for (const secret of secrets) expect(JSON.stringify(v.expected)).not.toContain(secret);
    expect(v.expected.summary.dropped_columns).toEqual(['Coach', 'Coach Email', 'Notes']);
    expect(Object.keys(v.expected.staged[0].raw_payload).sort()).toEqual(
      HEAD.filter((h) =>
        /** @type {string[]} */ (Object.values(PRACTICE_IMPORT_COLUMNS)).includes(h)
      ).sort()
    );
  });

  it('every staged key is an allowlisted key of practice_schedule, and core stages exactly them', () => {
    expect([...PRACTICE_STAGED_KEYS]).toEqual([...PRACTICE_SCHEDULE_IMPORT_KEYS]);
    for (const v of TABLE.vectors) {
      for (const s of v.expected.staged) {
        if (!s.normalized_payload) continue;
        const keys = Object.keys(s.normalized_payload);
        expect(keys).toEqual([...PRACTICE_SCHEDULE_IMPORT_KEYS]);
        expect(keys.every((k) => isAllowedImportKey('practice_schedule', k))).toBe(true);
      }
    }
  });

  it('a staged row reads back as the row it was (what the mapping step reads)', () => {
    const v = TABLE.vectors.find((x) => x.name === 'a placement, an open slot and a hold');
    const back = v.expected.staged.map((s) => stagedPracticeRowToParsed(s));
    expect(back.map((r) => [r.rowKey, r.status, r.teamLabel, r.day, r.startTime])).toEqual([
      ['row-1', 'placement', 'U10B-01', 'tue', '16:00'],
      ['row-2', 'open', '', 'tue', '17:00'],
      ['row-3', 'hold', '', 'tue', '18:00'],
    ]);
  });
});

describe('the Edge mirror stages what core stages', () => {
  it('every vector, key for key', () => {
    for (const v of TABLE.vectors) expect(edgeOf(inputOf(v)), v.name).toEqual(v.expected);
  });

  const seen = new Set();
  for (const tz of OTHER_ZONES) {
    it(`every vector again with the host zone ${tz} (no instant is converted)`, () => {
      underZone(tz, (noonHour) => {
        seen.add(noonHour);
        for (const v of TABLE.vectors) {
          expect(edgeOf(inputOf(v)), `${tz}: ${v.name}`).toEqual(v.expected);
          expect(coreOf(inputOf(v)), `core under ${tz}: ${v.name}`).toEqual(v.expected);
        }
      });
    }, 15_000);
  }

  it('the zones above really differed: three different host readings of one instant', () => {
    expect(seen.size).toBe(OTHER_ZONES.length);
  });

  it('the shipped fixtures, whole, as the browser sends them: the schedule and every refusal reason', () => {
    const fx = loadPracticeFixture();
    /** @type {Array<[{ headers: string[], rows: Array<Record<string, string>> }, any]>} */
    const files = [
      [fx.schedule, fx.season],
      [fx.invalid, fx.invalidSeason],
    ];
    for (const [file, season] of files) {
      const input = { headers: file.headers, rows: file.rows, season, dates: null };
      const core = coreOf(input);
      // CONTROL: the fixture staged rows, and the invalid file refused some.
      expect(core.refusal).toBeNull();
      expect(core.staged.length).toBe(file.rows.length);
      expect(edgeOf(input)).toEqual(core);
    }
    const invalid = coreOf({
      headers: fx.invalid.headers,
      rows: fx.invalid.rows,
      season: fx.invalidSeason,
      dates: null,
    });
    expect(invalid.summary.refused).toBeGreaterThan(10);
  });

  it('a date of the confirm step that is not a date is the caller’s defect in both copies', () => {
    const v = {
      headers: HEAD,
      rows: [row({})],
      season: SEASON,
      dates: { validFrom: '2026-02-31' },
    };
    expect(() => coreOf(v)).toThrow(TypeError);
    expect(() => edgeOf(v)).toThrow(TypeError);
  });
});

describe('timed in the mode CI runs (lesson 59)', () => {
  const fx = loadPracticeFixture();
  // The whole cap: the fixture's rows repeated to 2,400, each a distinct team so the file-wide checks do real work.
  const big = Array.from({ length: 2400 }, (_, i) => ({
    ...fx.schedule.rows[i % fx.schedule.rows.length],
    Team: fx.schedule.rows[i % fx.schedule.rows.length].Team
      ? `${fx.schedule.rows[i % fx.schedule.rows.length].Team}-${Math.floor(i / fx.schedule.rows.length)}`
      : '',
  }));

  it('2,400 rows stage in one request well inside the 2 s of CPU a request gets', () => {
    const input = { headers: fx.schedule.headers, rows: big, season: fx.season, dates: null };
    const t0 = performance.now();
    const out = edgeOf(input);
    const whole = performance.now() - t0;
    const t1 = performance.now();
    edgeOf({ ...input, rows: big.slice(0, 500) });
    const chunk = performance.now() - t1;
    // CONTROL: it staged every row.
    expect(out.staged.length).toBe(2400);
    // Printed for the PR description; the bound is a quarter of the budget, under coverage.
    console.info(
      `practice stage: 2,400 rows ${whole.toFixed(1)} ms, 500 rows ${chunk.toFixed(1)} ms`
    );
    expect(whole).toBeLessThan(500);
  });
});
