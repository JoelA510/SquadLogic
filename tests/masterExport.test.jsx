/**
 * `generateMasterExport` (frontend/src/utils/masterExport.js), the one maker of the master export rows (PR 6b of the
 * schedule expansion, task G5a). The page's whole output is pinned by tests/exportMasterRowsCharacterization.test.jsx;
 * this file holds the plan's own test for G5a (the function's rows equal to the page's for one seeded league, so a
 * second caller that calls it records the rows the page's upload records) and each way the function stops.
 *
 * The real mock client for the two reads, as the panel's tests use it.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../frontend/src/lib/mockSeedIds.js';
import { seedMockDb } from './helpers/seedMockDb.js';

const REC = vi.hoisted(() => ({ baselines: /** @type {Array<Record<string, any>>} */ ([]) }));

vi.mock('../frontend/src/config.js', async (importOriginal) => ({
  .../** @type {object} */ (await importOriginal()),
  IS_MOCK_MODE: false,
}));
vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase, supabaseReady: Promise.resolve() };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: '5eed0000-0000-4000-8000-000000000001', name: 'Mock League' },
    currentSeasonSetting: { id: '5eed5ea5-0000-4000-8000-000000000001', status: 'active' },
  }),
}));
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'mock-admin-id' } }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn() },
}));
vi.mock('../packages/core/src/storageSupabase.js', async (importOriginal) => ({
  .../** @type {object} */ (await importOriginal()),
  uploadScheduleExport: vi.fn(async ({ path }) => ({ path })),
}));
vi.mock('../frontend/src/hooks/usePublicationBaselines.js', async (importOriginal) => ({
  .../** @type {object} */ (await importOriginal()),
  usePublicationBaselines: () => ({
    baselines: [],
    loading: false,
    error: null,
    publishBaseline: async (payload) => {
      REC.baselines.push(payload);
      return { baseline_version: 1 };
    },
    compareWithBaseline: async () => null,
  }),
}));

const { default: OutputGenerationPanel } =
  await import('../frontend/src/components/OutputGenerationPanel.jsx');
const { generateMasterExport } = await import('../frontend/src/utils/masterExport.js');
const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');

const DIV = 'dddd0000-0000-4000-8000-000000000011';
const row = (id, name, extra = {}) => ({
  id,
  organization_id: MOCK_ORG_ID,
  division_id: DIV,
  name,
  is_external: false,
  ...extra,
});
const TEAMS = [
  { id: 't-1', name: 'Synthetic Comets', division: 'U12' },
  { id: 't-2', name: 'Synthetic Rockets', division: 'U12' },
];
const game = (id, home, away, start) => ({
  id,
  homeTeamId: home,
  awayTeamId: away,
  start,
  end: start.replace('T13', 'T14'),
  fieldId: 'field-1',
  slotId: `slot-${id}`,
});
const GAMES = [
  game('g-1', 't-1', 't-2', '2026-10-10T13:00:00Z'),
  game('g-2', 't-2', 't-club', '2026-10-17T13:00:00Z'),
];

function seedLeague() {
  seedMockDb({
    divisions: [
      { id: DIV, organization_id: MOCK_ORG_ID, season_settings_id: MOCK_SEASON_ID, name: 'U12' },
    ],
    teams: [
      row('t-1', 'Synthetic Comets'),
      row('t-2', 'Synthetic Rockets'),
      row('t-club', 'Gulls FC', { is_external: true }),
    ],
    schedule_tbd: [
      {
        id: 'tbd-1',
        organization_id: MOCK_ORG_ID,
        season_settings_id: MOCK_SEASON_ID,
        division_id: DIV,
        kind: 'game',
        home_team_id: 't-1',
        away_team_id: 't-club',
        week_index: 3,
        reason: 'no-slot-available',
      },
    ],
  });
}

const params = (extra = {}) => ({
  organizationId: MOCK_ORG_ID,
  seasonSettingsId: MOCK_SEASON_ID,
  seasonCompleted: false,
  teams: TEAMS,
  teamSummary: null,
  practiceAssignments: [],
  gameAssignments: GAMES,
  ...extra,
});

beforeEach(() => {
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'mock-admin-id' } }));
  REC.baselines = [];
});
afterEach(() => vi.restoreAllMocks());

describe('generateMasterExport makes the rows the Exports page records as its baseline', () => {
  it('for one seeded league, its rows equal the rows the page uploads and records', async () => {
    seedLeague();
    render(
      <OutputGenerationPanel teams={TEAMS} gameAssignments={GAMES} supabaseClient={mockSupabase} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Generate CSVs' }));
    const status = await screen.findByTestId('output-generation-status');
    await waitFor(() => expect(status).toHaveTextContent('CSVs generated successfully.'));
    // Not marking: this test is about the rows, and the Published read is the other test file's.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mark these games Published' }));
    fireEvent.click(screen.getByRole('button', { name: 'Upload to Storage' }));
    await waitFor(() => expect(REC.baselines).toHaveLength(1));

    const made = await generateMasterExport(mockSupabase, params());
    expect(made.status).toBe('generated');
    if (made.status !== 'generated') return;
    expect(made.exports.master.rows).toEqual(REC.baselines[0].rows);
    // Not vacuous: own v own (two rows), own v the outside club (one), and the TIME TBD game (one).
    expect(made.exports.master.rows).toHaveLength(4);
    expect(made.payload.gameIds).toEqual(['g-1', 'g-2']);
    expect(made.tbd.items).toHaveLength(1);
  });

  it('tells the caller the TIME TBD list as soon as it is read, before the directory read', async () => {
    seedLeague();
    const order = [];
    const from = mockSupabase.from.bind(mockSupabase);
    vi.spyOn(mockSupabase, 'from').mockImplementation((table) => {
      order.push(`from:${table}`);
      return from(table);
    });
    await generateMasterExport(
      mockSupabase,
      params({ onTbdRead: (list) => order.push(`tbd:${list.items.length}`) })
    );
    const told = order.indexOf('tbd:1');
    expect(told).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('from:divisions')).toBeGreaterThan(told);
  });
});

describe('each way it stops', () => {
  it('a TIME TBD list that cannot be read: tbd-failed, with the error', async () => {
    seedLeague();
    vi.spyOn(mockSupabase, 'rpc').mockImplementation(async () => ({
      data: null,
      error: { message: 'list refused', code: '42501' },
    }));
    const made = await generateMasterExport(mockSupabase, params());
    expect(made.status).toBe('tbd-failed');
    expect(made.status === 'tbd-failed' && made.error.message).toBe('list refused');
  });

  it('nothing placed and nothing on the list: nothing-scheduled, and no directory read', async () => {
    const from = vi.spyOn(mockSupabase, 'from');
    const made = await generateMasterExport(mockSupabase, params({ gameAssignments: [] }));
    expect(made.status).toBe('nothing-scheduled');
    expect(from).not.toHaveBeenCalled();
  });

  it('a directory that cannot be read: directory-failed, naming the table', async () => {
    seedLeague();
    const from = mockSupabase.from.bind(mockSupabase);
    vi.spyOn(mockSupabase, 'from').mockImplementation((table) => {
      if (table === 'teams') throw new Error('teams are unreadable');
      return from(table);
    });
    const made = await generateMasterExport(mockSupabase, params());
    expect(made).toMatchObject({
      status: 'directory-failed',
      table: 'teams',
      message: 'teams are unreadable',
    });
  });

  it('assignments of which none can be written, and an empty list: nothing-writable, with the counts', async () => {
    const made = await generateMasterExport(
      mockSupabase,
      params({
        seasonSettingsId: null,
        gameAssignments: [game('g-x', 't-1', 't-nobody', '2026-10-10T13:00:00Z')],
      })
    );
    expect(made.status).toBe('nothing-writable');
    expect(made.status === 'nothing-writable' && made.payload.omitted).toEqual({ games: 1 });
  });
});
