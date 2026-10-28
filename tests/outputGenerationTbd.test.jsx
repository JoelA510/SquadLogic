// The master export lists what is not scheduled yet (Phase D, E; plan
// docs/changes/2026-10-27-phase-d-scheduling.md, section E): a practice a team is still short of and
// a game the scheduler could not place are rows with Start TIME TBD, Field LOCATION TBD and the
// reason, in the master CSV and XLSX, and on the page. Driven through the real panel and the real
// mock client (`get_schedule_tbd` is its admin read); a list that cannot be read stops the files.
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../frontend/src/lib/mockSeedIds.js';
import { seedMockDb } from './helpers/seedMockDb.js';
import { readXlsx } from './helpers/readXlsx.js';

const SEASON = vi.hoisted(() => ({
  id: /** @type {string | null} */ ('5eed5ea5-0000-4000-8000-000000000001'),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase, supabaseReady: Promise.resolve() };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: '5eed0000-0000-4000-8000-000000000001', name: 'Mock League' },
    currentSeasonSetting: SEASON.id ? { id: SEASON.id } : null,
  }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn() },
}));

const { default: OutputGenerationPanel } =
  await import('../frontend/src/components/OutputGenerationPanel.jsx');
const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');

const teams = [
  { id: 't1', name: 'Team A', division: 'U8 Coed' },
  { id: 't2', name: 'Team B', division: 'U8 Coed' },
];
const practiceAssignments = [
  {
    teamId: 't1',
    start: '2026-04-06T17:30:00Z',
    end: '2026-04-06T18:30:00Z',
    fieldId: 'Field 1',
    slotId: 's1',
  },
];

/** The list as the writers leave it: Team A two practices short, one game not placed. */
const TBD_ROWS = [
  {
    id: 'tbd-1',
    organization_id: MOCK_ORG_ID,
    season_settings_id: MOCK_SEASON_ID,
    kind: 'practice',
    division_id: 'u8-div-id',
    team_id: 't1',
    missing_count: 2,
    reason: 'no-slot-available',
  },
  {
    id: 'tbd-2',
    organization_id: MOCK_ORG_ID,
    season_settings_id: MOCK_SEASON_ID,
    kind: 'game',
    division_id: 'u8-div-id',
    home_team_id: 't2',
    away_team_id: 't1',
    week_index: 3,
    reason: 'coach-scheduling-conflict',
  },
];

let saved;
beforeEach(() => {
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'mock-admin-id' } }));
  SEASON.id = MOCK_SEASON_ID;
  saved = [];
  let current = null;
  URL.createObjectURL = vi.fn((blob) => {
    current = blob;
    return 'blob:export';
  });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() {
    saved.push({ name: this.download, blob: current });
  });
});
afterEach(() => vi.restoreAllMocks());

function renderPanel() {
  render(
    <OutputGenerationPanel
      teams={teams}
      practiceAssignments={practiceAssignments}
      supabaseClient={mockSupabase}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Generate CSVs' }));
}

describe('the master export lists what is not scheduled yet', () => {
  it('writes the TIME TBD rows into the master CSV and XLSX, and lists them on the page', async () => {
    seedMockDb({ schedule_tbd: TBD_ROWS });
    renderPanel();

    const status = await screen.findByTestId('output-generation-status');
    await waitFor(() => expect(status).toHaveTextContent('CSVs generated successfully.'));
    // Said once, in words, with the count of rows: 2 practices and 1 game.
    expect(status).toHaveTextContent(
      '2 practices and 1 game not scheduled yet are in the files as TIME TBD, with the reason.'
    );
    // And no longer said to be left out: nothing here is an assignment with a broken time.
    expect(status).not.toHaveTextContent('are not in these files');
    expect(screen.getByText('Master Schedule: 5 rows')).toBeInTheDocument();

    // The page lists them, with the names the read joined in.
    const list = screen.getByTestId('schedule-tbd-list');
    const lines = within(list)
      .getAllByTestId('schedule-tbd-row')
      .map((item) => item.textContent);
    expect(lines).toEqual([
      "Team B v Team A, week 3 (U8 Coed): a coach's other games leave no free time",
      'Team A (U8 Coed): 2 practices not scheduled: no slot was free for it',
    ]);

    // The master CSV.
    fireEvent.click(screen.getByRole('button', { name: 'Download Master CSV' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    const csv = await saved[0].blob.text();
    const csvLines = csv.replace(/^﻿/, '').split('\n');
    expect(csvLines).toHaveLength(6);
    const tbd = csvLines.filter((line) => line.includes('TIME TBD,,LOCATION TBD'));
    expect(tbd).toHaveLength(4);
    expect(tbd.filter((line) => line.includes(',Practice,,,TIME TBD'))).toHaveLength(2);
    expect(tbd.some((line) => /Team B,U8 Coed,.*,Game,Team A,Home,TIME TBD/.test(line))).toBe(true);
    expect(tbd.some((line) => /Team A,U8 Coed,.*,Game,Team B,Away,TIME TBD/.test(line))).toBe(true);

    // The master XLSX holds the same rows.
    fireEvent.click(screen.getByRole('button', { name: 'Download Master XLSX' }));
    await waitFor(() => expect(saved).toHaveLength(2));
    const sheet = readXlsx(new Uint8Array(await saved[1].blob.arrayBuffer()));
    expect(sheet.rows).toHaveLength(6);
    const startColumn = sheet.rows[0].indexOf('Start');
    const fieldColumn = sheet.rows[0].indexOf('Field');
    const notesColumn = sheet.rows[0].indexOf('Notes');
    const tbdRows = sheet.rows.slice(1).filter((row) => row[startColumn] === 'TIME TBD');
    expect(tbdRows).toHaveLength(4);
    for (const row of tbdRows) {
      expect(row[fieldColumn]).toBe('LOCATION TBD');
      expect(row[notesColumn]).toMatch(/not scheduled/);
    }
  });

  it('with nothing short, no sentence and no list', async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId('output-generation-status')).toHaveTextContent(
        'CSVs generated successfully.'
      )
    );
    expect(screen.getByTestId('output-generation-status')).not.toHaveTextContent('TIME TBD');
    expect(screen.queryByTestId('schedule-tbd-list')).toBeNull();
    expect(screen.getByText('Master Schedule: 1 rows')).toBeInTheDocument();
  });

  it('a list that cannot be read stops the files and says so (an unread list is not an empty one)', async () => {
    seedMockDb({ schedule_tbd: TBD_ROWS });
    // Not an admin of the season's organization: the read is refused 42501.
    sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'someone-else' } }));
    renderPanel();
    const status = await screen.findByTestId('output-generation-status');
    await waitFor(() => expect(status).toHaveTextContent('Generation failed'));
    expect(status).toHaveTextContent(/not scheduled yet could not be read.*Access denied/);
    expect(screen.queryByText('Generated Files')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download Master CSV' })).toBeNull();
  });

  it('a row that is not a TIME TBD item stops the files too', async () => {
    seedMockDb({ schedule_tbd: [{ ...TBD_ROWS[0], missing_count: null }] });
    renderPanel();
    const status = await screen.findByTestId('output-generation-status');
    await waitFor(() => expect(status).toHaveTextContent('could not be read'));
    expect(screen.queryByText('Generated Files')).toBeNull();
  });

  it('a season with no id has nothing to read: the read is not made', async () => {
    SEASON.id = null;
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId('output-generation-status')).toHaveTextContent(
        'CSVs generated successfully.'
      )
    );
    expect(rpc).not.toHaveBeenCalled();
  });
});
