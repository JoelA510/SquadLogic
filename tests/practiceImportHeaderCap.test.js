/**
 * The practice import and a wide file (the follow-up #734 left open in `docs/changes/2026-11-03-schedule-expansion.md`:
 * whether the practice import should read by name, as the games import does, rather than refuse a file of more than
 * 200 columns).
 *
 * PR 11 (Codex's C5 on #732) stopped the practice header row being cut at 200 columns by refusing a file of more than
 * 200 columns as the file wrote it. That refusal also caught a wide export whose extra columns the import never reads.
 * The contract is now #734's:
 *
 * - **The browser sends only the columns the import reads, found by name** (`preparePracticeImportFile`, which cleans
 *   the header row once, as the stage does, and keys each row by the cleaned names). A Team at column 230 of 250 is read; a file of 201 columns imports.
 * - **More than 200 headers SENT** cannot happen through the client today (the import reads thirteen names and three
 *   aliases); the client refuses it in words before a job is made, and every layer behind it refuses it too: the
 *   request shape (a 400, which the mock answers as the Edge does), the stage in core and the Edge mirror, counted as
 *   sent with a blank header included, and the parse. Each is tested alone here; the parse's own 200/201 test is in
 *   `tests/practiceImportParse.test.js`, the Edge parity over the named vectors is `tests/practiceImportEdgeParity.test.js`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { startPracticeImport } from '../frontend/src/utils/practiceImportClient.js';
import { handlePracticeImportFunction } from '../frontend/src/lib/mockPracticeImport.js';
import {
  PRACTICE_IMPORT_STAGE_LIMITS,
  preparePracticeImportFile,
  stagePracticeFile,
} from '../packages/core/src/practiceImport/staging.js';
import { PRACTICE_IMPORT_LIMITS } from '../packages/core/src/practiceImport/reasonCodes.js';
import { sanitizeImportText } from '../frontend/src/utils/importRows.js';
import * as edge from '../supabase/functions/_shared/practice-import.ts';
import { sanitizeImportText as edgeSanitize } from '../supabase/functions/_shared/import-rows.ts';

const HEADERS = [
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
const row = {
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
};
const SEASON = { startDate: '2026-09-07', endDate: '2027-03-31' };
const filler = (n, from = 0) => Array.from({ length: n }, (_, i) => `Extra ${from + i}`);

/** A header row of `width` columns with `column` at `at` (1-based) and every other column of the template first. */
function wide(width, column, at) {
  const rest = HEADERS.filter((h) => h !== column);
  const headers = [...rest, ...filler(at - 1 - rest.length), column];
  headers.push(...filler(width - headers.length, at));
  expect(headers).toHaveLength(width);
  expect(headers.indexOf(column)).toBe(at - 1);
  return headers;
}
/** The row of a wide file: the template's cells, and a value under every filler column. */
const wideRow = (headers) =>
  Object.fromEntries(headers.map((h) => [h, Object.hasOwn(row, h) ? row[h] : `unread ${h}`]));

/** A client that records every call and answers as a working backend would. */
function recordingClient() {
  return {
    // The start reads no table; a read here would be a change worth seeing.
    from: vi.fn(() => {
      throw new Error('startPracticeImport read a table');
    }),
    rpc: vi.fn(async (name) =>
      name === 'create_import_job'
        ? { data: { id: 'job-1' }, error: null }
        : { data: null, error: null }
    ),
    functions: {
      invoke: vi.fn(async () => ({
        data: {
          status: 'success',
          summary: {
            rows: 1,
            placements: 1,
            open: 0,
            holds: 0,
            refused: 0,
            flagged: 0,
            by_reason: {},
            dropped_columns: [],
            warnings: [],
            refused_rows: [],
          },
        },
        error: null,
      })),
    },
  };
}
const start = (client, headers, rows) =>
  startPracticeImport(client, {
    organizationId: 'org-1',
    seasonSettingsId: 'season-1',
    fileName: 'wide.csv',
    headers,
    rows,
    dates: null,
  });
/** The one request the start sent. */
const sentBody = (client) => /** @type {any} */ (client.functions.invoke.mock.calls[0])[1].body;

describe('one name for the cap', () => {
  it('the stage limit and the parse limit are one number, MAX_COLUMNS, and MAX_HEADERS is gone', () => {
    expect(PRACTICE_IMPORT_STAGE_LIMITS.MAX_COLUMNS).toBe(PRACTICE_IMPORT_LIMITS.MAX_COLUMNS);
    expect(edge.PRACTICE_IMPORT_LIMITS.MAX_COLUMNS).toBe(PRACTICE_IMPORT_LIMITS.MAX_COLUMNS);
    expect(Object.keys(PRACTICE_IMPORT_STAGE_LIMITS)).not.toContain('MAX_HEADERS');
    expect(Object.keys(edge.PRACTICE_IMPORT_LIMITS)).not.toContain('MAX_HEADERS');
  });
});

describe('which headers the browser sends: the ones the import reads, by name, cleaned once', () => {
  const prepare = (headers, rows = [wideRow(headers)]) =>
    preparePracticeImportFile({ headers, rows, clean: sanitizeImportText });

  it('finds a column wherever it stands, sends it under its CLEANED name, and drops blanks unnamed', () => {
    const headers = [...wide(250, 'Team', 230), '', '  ', '<b>Notes</b>'];
    headers[0] = ' division  '; // another spacing and case of a column it reads
    headers[1] = '<b>Day</b>'; // markup the stage strips before it reads the name
    headers[headers.indexOf('Location')] = 'Venue'; // the aliases are read as well
    headers[headers.indexOf('Subunit')] = ' HALF ';
    const rows = [{ ...wideRow(headers), ' division  ': 'U10 Boys', '<b>Day</b>': 'Tue' }];
    const out = prepare(headers, rows);
    expect(out.refusal).toBeNull();
    expect(out.headers).toHaveLength(HEADERS.length);
    // the names sent are the cleaned ones, the stage's own reading of them, never the raw text
    expect(out.headers).toContain('Team');
    expect(out.headers).toContain('division');
    expect(out.headers).toContain('Day');
    expect(out.headers).not.toContain('<b>Day</b>');
    // the aliases are read as well (Venue for Location, Half for Subunit)
    expect(out.headers).toContain('Venue');
    expect(out.headers).toContain('HALF');
    // each row is keyed by those names, its cells as the file wrote them, and nothing else
    expect(Object.keys(out.rows[0]).sort()).toEqual([...out.headers].sort());
    expect(out.rows[0].Day).toBe('Tue');
    expect(out.rows[0].division).toBe('U10 Boys');
    expect(out.rows[0].Team).toBe('U10B-01');
    expect(out.dropped).toHaveLength(238 + 1);
    expect(out.dropped).toContain('Extra 249');
    expect(out.dropped).toContain('Notes');
    expect(out.dropped).not.toContain('');
  });

  it('two headers that clean to one column are refused as duplicate-column, in the parse’s words', () => {
    for (const pair of [
      ['Team', '<i>Team</i>'],
      ['Team', ' team '],
      ['Location', 'Venue'],
    ]) {
      const out = prepare([...HEADERS.filter((h) => !pair.includes(h)), ...pair]);
      expect(out.refusal, pair.join(' + ')).toMatchObject({ code: 'duplicate-column' });
      expect(out.refusal.message).toMatch(/more than once \(or two names for it\)/);
      expect(out.rows).toEqual([]);
    }
  });

  it('more than 200 headers it reads is refused, in words about the repeat (not the file’s width)', () => {
    const out = prepare(
      Array.from({ length: 201 }, (_, i) => `Team${' '.repeat(i)}`),
      []
    );
    expect(out.refusal).toMatchObject({ code: 'too-many-columns' });
    expect(out.refusal.message).toBe(
      'The file has 201 columns the import reads; one import takes at most 200. A column it reads is given more than once: remove the repeats and choose the file again.'
    );
  });

  it('refuses input that is not a header row, rows, or a cleaner', () => {
    expect(() =>
      // @ts-expect-error a string is not a header row
      preparePracticeImportFile({ headers: 'Team', rows: [], clean: sanitizeImportText })
    ).toThrow(TypeError);
    expect(() =>
      // @ts-expect-error an object is not rows
      preparePracticeImportFile({ headers: HEADERS, rows: {}, clean: sanitizeImportText })
    ).toThrow(TypeError);
    expect(() =>
      // @ts-expect-error the cleaner is required
      preparePracticeImportFile({ headers: HEADERS, rows: [] })
    ).toThrow(TypeError);
  });

  it('the stage reads what the browser sends exactly as it read the file: every vector of the parity table', () => {
    const table = JSON.parse(
      readFileSync(
        path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          '../supabase/functions/_shared/tests/fixtures/practice-import.vectors.json'
        ),
        'utf8'
      )
    );
    let compared = 0;
    for (const v of table.vectors) {
      if (!Array.isArray(v.rows) || v.expected.refusal) continue;
      const sent = prepare(v.headers, v.rows);
      expect(sent.refusal, v.name).toBeNull();
      for (const [name, stage] of Object.entries({
        core: (h, r) => stagePracticeFile({ ...v, headers: h, rows: r, clean: sanitizeImportText }),
        edge: (h, r) => edge.stagePracticeFile({ ...v, headers: h, rows: r, clean: edgeSanitize }),
      })) {
        const out = JSON.parse(JSON.stringify(stage(sent.headers, sent.rows)));
        expect(out.refusal, `${name}: ${v.name}`).toBeNull();
        expect(out.staged, `${name}: ${v.name}`).toEqual(v.expected.staged);
        expect([...sent.dropped, ...out.summary.dropped_columns], v.name).toEqual(
          v.expected.summary.dropped_columns
        );
      }
      compared += 1;
    }
    // CONTROL: the table's accepted files were compared, not none of them
    expect(compared).toBeGreaterThan(10);
  });
});

describe('the client: a wide file imports, read by name, and never cut', () => {
  it('a 250-column file with Team at column 230 imports and sends the Team', async () => {
    const client = recordingClient();
    const headers = wide(250, 'Team', 230);
    const { summary } = await start(client, headers, [wideRow(headers)]);
    expect(client.rpc.mock.calls[0][0]).toBe('create_import_job');
    const body = sentBody(client);
    expect([...body.headers].sort()).toEqual([...HEADERS].sort());
    expect(body.rows[0].Team).toBe('U10B-01');
    // nothing the import does not read leaves the browser, and every dropped column is named
    expect(JSON.stringify(body)).not.toContain('unread');
    expect(summary.dropped_columns).toHaveLength(238);
    expect(summary.dropped_columns).toContain('Extra 237');
    expect(summary.dropped_columns).toContain('Extra 249');
  });

  it('a 201-column file whose columns past 200 are not read imports', async () => {
    const client = recordingClient();
    const headers = [...HEADERS, ...filler(189)];
    expect(headers).toHaveLength(201);
    await start(client, headers, [wideRow(headers)]);
    expect(client.rpc.mock.calls[0][0]).toBe('create_import_job');
    expect(sentBody(client).headers).toEqual(HEADERS);
  });

  it('blank headers are neither sent nor named', async () => {
    const client = recordingClient();
    const headers = [...HEADERS, '', '   ', 'Notes'];
    const { summary } = await start(client, headers, [wideRow(headers)]);
    expect(sentBody(client).headers).toEqual(HEADERS);
    expect(summary.dropped_columns).toEqual(['Notes']);
  });

  it('a column the function names as dropped is kept beside the browser’s own, once', async () => {
    const client = recordingClient();
    client.functions.invoke.mockResolvedValueOnce({
      data: {
        status: 'success',
        summary: {
          ...(await recordingClient().functions.invoke()).data.summary,
          dropped_columns: ['Notes', 'Other'],
        },
      },
      error: null,
    });
    const { summary } = await start(
      client,
      [...HEADERS, 'Notes'],
      [wideRow([...HEADERS, 'Notes'])]
    );
    expect(summary.dropped_columns).toEqual(['Notes', 'Other']);
  });

  it('Team and <i>Team</i> are refused as duplicate-column before a job is made or the function is called', async () => {
    const client = recordingClient();
    const headers = [...HEADERS, '<i>Team</i>'];
    await expect(start(client, headers, [wideRow(headers)])).rejects.toMatchObject({
      code: 'duplicate-column',
      message: expect.stringMatching(/"Team" more than once/),
    });
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.functions.invoke).not.toHaveBeenCalled();
  });

  it('a header it reads whose raw text is over 500 characters is sent by its cleaned name, never as raw text', async () => {
    const client = recordingClient();
    const long = `<span title="${'x'.repeat(600)}">Team</span>`;
    const padded = `Division${' '.repeat(600)}`;
    expect(long.length).toBeGreaterThan(500);
    const headers = [long, padded, ...HEADERS.filter((h) => h !== 'Team' && h !== 'Division')];
    const rows = [{ ...row, [long]: 'U10B-01', [padded]: 'U10 Boys' }];
    await start(client, headers, rows);
    const body = sentBody(client);
    // every header sent fits the request shape's 500 characters (Zod's `.max`), and the cells went with them
    expect(body.headers.every((h) => h.length <= 500)).toBe(true);
    expect(body.headers).toContain('Team');
    expect(body.headers).toContain('Division');
    expect(body.rows[0].Team).toBe('U10B-01');
    expect(body.rows[0].Division).toBe('U10 Boys');
  });

  it('more than 200 columns to SEND is refused in words, with no create_import_job and no Edge call', async () => {
    // Only a column given many times over reaches it: 201 spellings of one name the import reads.
    const client = recordingClient();
    const headers = Array.from({ length: 201 }, (_, i) => `Team${' '.repeat(i + 1)}`);
    await expect(start(client, headers, [])).rejects.toMatchObject({
      code: 'too-many-columns',
      message: expect.stringMatching(
        /^The file has 201 columns the import reads; one import takes at most 200\. A column it reads is given more than once/
      ),
    });
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.functions.invoke).not.toHaveBeenCalled();
  });
});

describe('the stage, in core and in the Edge mirror: more than 200 headers SENT is refused, never cut', () => {
  const stages = {
    core: (headers) =>
      stagePracticeFile({
        headers,
        rows: [wideRow(headers)],
        season: SEASON,
        dates: null,
        clean: sanitizeImportText,
      }),
    edge: (headers) =>
      edge.stagePracticeFile({
        headers,
        rows: [wideRow(headers)],
        season: SEASON,
        dates: null,
        clean: edgeSanitize,
      }),
  };
  for (const [name, stage] of Object.entries(stages)) {
    it(`${name}: 201 headers stage nothing and say why, blanks counted; 200 keep the Team at 200`, () => {
      const over = stage(wide(201, 'Team', 201));
      expect(over.refusal).toMatchObject({ code: 'too-many-columns' });
      expect(over.refusal.message).toMatch(/201 columns; one import reads at most 200/);
      expect(over.staged).toEqual([]);
      // counted as sent: two blanks make 201, as the request shape counts them
      const blanks = stage([...wide(199, 'Team', 199), '', '  ']);
      expect(blanks.refusal).toMatchObject({ code: 'too-many-columns' });
      expect(blanks.refusal.message).toMatch(/^The file has 201 columns/);
      const at200 = stage(wide(200, 'Team', 200));
      expect(at200.refusal).toBeNull();
      expect(at200.staged).toHaveLength(1);
      expect(at200.staged[0].raw_payload.Team).toBe('U10B-01');
      expect(at200.staged[0].normalized_payload.status).toBe('placement');
    });
  }
});

describe('the mock answers more than 200 headers as the Edge request shape does: a 400', () => {
  const ctx = { currentUserId: 'user-1', isOrgAdmin: () => true };
  const call = (headers) =>
    handlePracticeImportFunction(
      { import_jobs: [] },
      {
        import_type: 'practice_schedule',
        action: 'stage',
        organization_id: 'org-1',
        import_job_id: 'job-1',
        headers,
        rows: [],
        dates: null,
      },
      ctx
    );
  it('201 headers are "Invalid payload" with status 400; 200 pass the shape and reach the job lookup', async () => {
    const over = call(wide(201, 'Team', 201));
    expect(over.data).toBeNull();
    expect(over.error.context.status).toBe(400);
    expect(await over.error.context.json()).toEqual({
      status: 'error',
      message: 'Invalid payload',
    });
    expect(over.wrote).toBe(false);
    // CONTROL: the shape takes 200, so the answer is the next check's (no such job)
    const at200 = call(wide(200, 'Team', 200));
    expect(at200.error.context.status).toBe(404);
  });
});
