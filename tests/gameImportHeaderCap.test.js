/**
 * The games import and a wide file (the follow-up PR 11 recorded in `docs/changes/2026-11-03-schedule-expansion.md`,
 * review round of #732, C5; reworked by the review of #734).
 *
 * The header row was cut to its first 200 columns by position, so a column the import reads past the 200th (a Game ID,
 * a Week, a Home Team) was dropped while its values stayed in the rows. Refusing a wide file would be wrong too: a
 * registration platform's export can be wide, and such a file imported before. So:
 *
 * - **The browser sends only the columns the import reads, found by name** (`splitScheduleImportHeaders`, which cleans
 *   a header as the stage does). A Home Team at column 230 of 250 is read; a file of 201 columns imports.
 * - **More than 200 headers SENT** cannot happen through the client today (the import reads eleven names); the client
 *   refuses it in words before a job is made, and every layer behind it refuses it too: the request shape (a 400, which
 *   the mock answers as the Edge does), the stage in core and the Edge mirror, counted as sent with a blank header
 *   included, and the parse. Each is tested alone here; the parse's own 200/201 test is in
 *   `tests/scheduleImportParse.test.js`, the Edge parity over the named vectors is `tests/gameImportEdgeParity.test.js`.
 */
import { describe, expect, it, vi } from 'vitest';
import { startGameImport } from '../frontend/src/utils/gameImportClient.js';
import { handleGameImportFunction } from '../frontend/src/lib/mockGameImport.js';
import {
  splitScheduleImportHeaders,
  stageScheduleChunk,
} from '../packages/core/src/scheduleImport/staging.js';
import { sanitizeImportText } from '../frontend/src/utils/importRows.js';
import * as edge from '../supabase/functions/_shared/schedule-import.ts';

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
const row = {
  'Game ID': 'G-1',
  Date: '2026-09-12',
  'Start Time': '09:00',
  'End Time': '10:00',
  Venue: 'Venue A',
  Field: 'Field 1',
  Division: 'U05 Boys',
  'Home Team': 'U05B Team 01',
  'Away Team': 'U05B Team 02',
  Week: '1',
};
const SEASON = { timeZone: 'America/Los_Angeles', startDate: '2026-09-07', endDate: '2027-03-31' };
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
      throw new Error('startGameImport read a table');
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
            ok: 1,
            tbd: 0,
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
  startGameImport(client, {
    organizationId: 'org-1',
    seasonSettingsId: 'season-1',
    fileName: 'wide.csv',
    headers,
    rows,
  });
/** The one request the start sent. */
const sentBody = (client) => /** @type {any} */ (client.functions.invoke.mock.calls[0])[1].body;

describe('which headers the browser sends: the ones the import reads, by name', () => {
  it('finds a column wherever it stands, cleans a header as the stage does, and drops blanks unnamed', () => {
    const headers = [...wide(250, 'Home Team', 230), '', '  ', '<b>Notes</b>'];
    headers[0] = ' game  ID '; // another spacing and case of a column it reads
    headers[1] = '<b>Date</b>'; // markup the stage strips before it reads the name
    const { read, dropped } = splitScheduleImportHeaders(headers, sanitizeImportText);
    expect(read).toHaveLength(HEADERS.length);
    expect(read).toContain('Home Team');
    expect(read).toContain(' game  ID ');
    expect(read).toContain('<b>Date</b>');
    expect(dropped).toHaveLength(240 + 1);
    expect(dropped).toContain('Extra 249');
    expect(dropped).toContain('Notes');
    expect(dropped).not.toContain('');
  });
});

describe('the client: a wide file imports, read by name, and never cut', () => {
  it('a 250-column file with Home Team at column 230 imports and sends the Home Team', async () => {
    const client = recordingClient();
    const headers = wide(250, 'Home Team', 230);
    const { summary } = await start(client, headers, [wideRow(headers)]);
    expect(client.rpc.mock.calls[0][0]).toBe('create_import_job');
    const body = sentBody(client);
    expect([...body.headers].sort()).toEqual([...HEADERS].sort());
    expect(body.rows[0]['Home Team']).toBe('U05B Team 01');
    // nothing the import does not read leaves the browser, and every dropped column is named
    expect(JSON.stringify(body)).not.toContain('unread');
    expect(summary.dropped_columns).toHaveLength(240);
    expect(summary.dropped_columns).toContain('Extra 239');
  });

  it('a 201-column file whose columns past 200 are not read imports', async () => {
    const client = recordingClient();
    const headers = [...HEADERS, ...filler(191)];
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

  it('more than 200 columns to SEND is refused in words, with no create_import_job and no Edge call', async () => {
    // Only a column given many times over reaches it: 201 spellings of one name the import reads.
    const client = recordingClient();
    const headers = Array.from({ length: 201 }, (_, i) => `Date${' '.repeat(i + 1)}`);
    await expect(start(client, headers, [])).rejects.toMatchObject({
      code: 'too-many-columns',
      message: expect.stringMatching(/201 columns; one import reads at most 200/),
    });
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.functions.invoke).not.toHaveBeenCalled();
  });
});

describe('the stage, in core and in the Edge mirror: more than 200 headers SENT is refused, never cut', () => {
  const stages = {
    core: (headers) =>
      stageScheduleChunk({
        headers,
        rows: [row],
        season: SEASON,
        rowOffset: 0,
        clean: sanitizeImportText,
      }),
    edge: (headers) => edge.stageGameChunk({ headers, rows: [row], season: SEASON, rowOffset: 0 }),
  };
  for (const [name, stage] of Object.entries(stages)) {
    it(`${name}: 201 headers stage nothing and say why, blanks counted; 200 keep the Game ID at 200`, () => {
      const over = stage(wide(201, 'Game ID', 201));
      expect(over.refusal).toMatchObject({ code: 'too-many-columns' });
      expect(over.refusal.message).toMatch(/201 columns; one import reads at most 200/);
      expect(over.staged).toEqual([]);
      // counted as sent: two blanks make 201, as the request shape counts them
      const blanks = stage([...wide(199, 'Game ID', 199), '', '  ']);
      expect(blanks.refusal).toMatchObject({ code: 'too-many-columns' });
      expect(blanks.refusal.message).toMatch(/^The file has 201 columns/);
      const at200 = stage(wide(200, 'Game ID', 200));
      expect(at200.refusal).toBeNull();
      expect(at200.staged).toHaveLength(1);
      expect(at200.staged[0].raw_payload['Game ID']).toBe('G-1');
    });
  }
});

describe('the mock answers more than 200 headers as the Edge request shape does: a 400', () => {
  const ctx = { currentUserId: 'user-1', isOrgAdmin: () => true };
  const call = (headers) =>
    handleGameImportFunction(
      { import_jobs: [] },
      { import_type: 'games', organization_id: 'org-1', import_job_id: 'job-1', headers, rows: [] },
      ctx
    );
  it('201 headers are "Invalid payload" with status 400; 200 pass the shape and reach the job lookup', async () => {
    const over = call(wide(201, 'Game ID', 201));
    expect(over.data).toBeNull();
    expect(over.error.context.status).toBe(400);
    expect(await over.error.context.json()).toEqual({
      status: 'error',
      message: 'Invalid payload',
    });
    expect(over.wrote).toBe(false);
    // CONTROL: the shape takes 200, so the answer is the next check's (no such job)
    const at200 = call(wide(200, 'Game ID', 200));
    expect(at200.error.context.status).toBe(404);
  });
});
