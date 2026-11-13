/**
 * The games import's header cap (the follow-up PR 11 recorded in `docs/changes/2026-11-03-schedule-expansion.md`,
 * review round of #732, C5): a file of more than 200 columns is refused, never cut. Cutting it by position dropped a
 * column the import reads (a Game ID, a Week, an End Time) while its values stayed in the rows, so the game was staged
 * without its key, or with a derived week, and nothing said so.
 *
 * - The client refuses before `create_import_job`: no job is made and the Edge function is never asked.
 * - Core's stage and the Edge mirror's refuse a header row of 201 and read every column of one of 200 (no slice).
 *   The parse's own 200/201 test is in `tests/scheduleImportParse.test.js`; the Edge parity over the named vectors is
 *   `tests/gameImportEdgeParity.test.js`.
 */
import { describe, expect, it, vi } from 'vitest';
import { startGameImport } from '../frontend/src/utils/gameImportClient.js';
import { stageScheduleChunk } from '../packages/core/src/scheduleImport/staging.js';
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
/** The header row with the Game ID moved to column `at` (filler columns before it). */
const gameIdAt = (at) => {
  const headers = [
    ...HEADERS.filter((h) => h !== 'Game ID'),
    ...Array.from({ length: at - HEADERS.length }, (_, i) => `Extra ${i}`),
    'Game ID',
  ];
  expect(headers).toHaveLength(at);
  return headers;
};

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
const start = (client, headers) =>
  startGameImport(client, {
    organizationId: 'org-1',
    seasonSettingsId: 'season-1',
    fileName: 'wide.csv',
    headers,
    rows: [row],
  });

describe('the client: a file of more than 200 columns is refused before a job is made', () => {
  it('refuses a Game ID at column 201 in words, with no create_import_job and no Edge call', async () => {
    const client = recordingClient();
    await expect(start(client, gameIdAt(201))).rejects.toMatchObject({
      code: 'too-many-columns',
      message: expect.stringMatching(/201 columns; one import reads at most 200/),
    });
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.functions.invoke).not.toHaveBeenCalled();
  });

  it('CONTROL: at column 200 the job is made and the whole header row is sent, the Game ID with it', async () => {
    const client = recordingClient();
    await start(client, gameIdAt(200));
    expect(client.rpc.mock.calls[0][0]).toBe('create_import_job');
    expect(client.functions.invoke).toHaveBeenCalledTimes(1);
    const body = /** @type {any} */ (client.functions.invoke.mock.calls[0])[1].body;
    expect(body.headers).toHaveLength(200);
    expect(body.headers.at(-1)).toBe('Game ID');
    expect(body.rows[0]['Game ID']).toBe('G-1');
  });
});

describe('the stage, in core and in the Edge mirror: refused at 201, every column read at 200', () => {
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
    it(`${name}: 201 columns stage nothing and say why; 200 keep the Game ID`, () => {
      const over = stage(gameIdAt(201));
      expect(over.refusal).toMatchObject({ code: 'too-many-columns' });
      expect(over.refusal.message).toMatch(/201 columns; one import reads at most 200/);
      expect(over.staged).toEqual([]);
      const at200 = stage(gameIdAt(200));
      expect(at200.refusal).toBeNull();
      expect(at200.staged).toHaveLength(1);
      expect(at200.staged[0].raw_payload['Game ID']).toBe('G-1');
    });
  }
});
