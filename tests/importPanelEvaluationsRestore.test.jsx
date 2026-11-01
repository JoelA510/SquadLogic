import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import ImportPanel from '../frontend/src/components/ImportPanel.jsx';
import { ImportProvider, useImport } from '../frontend/src/contexts/ImportContext.jsx';
import { getMockData, mockSupabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../frontend/src/lib/mockSeedIds.js';

/**
 * Reload-and-confirm (Codex, P2 on #684): an evaluations import waits for its confirm, the page is
 * reloaded, and the import screen starts again with its own default type (players). The restored
 * job's type must stay the screen's type through the apply, or the result (the counts and the list of
 * rows that were not valid) disappears the moment it exists. This runs the real provider and the
 * real screen against the mock client; only the file parser and the signed-in role are stubbed.
 */
const mocks = vi.hoisted(() => ({ parse: vi.fn(), role: undefined }));

vi.mock('papaparse', () => ({ default: { parse: mocks.parse } }));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => {
  const season = { id: '', name: 'Seed Season', status: 'active' };
  return {
    useOrganization: () => ({
      currentOrganization: { id: MOCK_ORG_ID },
      orgMember: { id: 'member-1', role: mocks.role },
      currentSeasonSetting: { ...season, id: MOCK_SEASON_ID },
      availableSeasons: [{ ...season, id: MOCK_SEASON_ID }],
    }),
  };
});

const HEADERS = ['Registration ID', 'Years Played', 'Skill Tier', 'Rating'];
const FILE_ROWS = [
  { 'Registration ID': 'EVR-1', 'Years Played': '4', 'Skill Tier': 'advanced', Rating: '5' },
  { 'Registration ID': 'EVR-2', 'Years Played': '', 'Skill Tier': '', Rating: '2' },
  { 'Registration ID': 'NOBODY-9', 'Years Played': '1', 'Skill Tier': '', Rating: '' },
  { 'Registration ID': 'EVR-1x', 'Years Played': '99', 'Skill Tier': '', Rating: '' },
];

describe('ImportPanel: an evaluations import restored after a reload', () => {
  beforeEach(async () => {
    sessionStorage.clear();
    window.__MOCK_DB__ = undefined;
    mocks.parse.mockReset();
    mocks.role = undefined;
    mocks.parse.mockImplementation((_file, options) => {
      options.complete({ data: FILE_ROWS, meta: { fields: HEADERS } });
    });
    await mockSupabase.auth.signInWithPassword({
      email: 'admin@example.com',
      password: 'test-password-123',
    });
    window.__saveMockDB__({
      ...window.__MOCK_DB__,
      players: [
        ...getMockData('players'),
        ...['EVR-1', 'EVR-2'].map((reg) => ({
          id: `restore-${reg}`,
          organization_id: MOCK_ORG_ID,
          season_settings_id: MOCK_SEASON_ID,
          first_name: 'Ev',
          last_name: reg,
          external_registration_id: reg,
          years_played: null,
          skill_tier: null,
          rating: null,
        })),
      ],
    });
  });

  it('keeps the counts and the not-valid list on screen after the apply', async () => {
    // The first page: check the file, and stop at "ready to apply".
    const first = renderHook(() => useImport(), {
      wrapper: ({ children }) => <ImportProvider>{children}</ImportProvider>,
    });
    await act(async () => {
      await first.result.current.startImport(new File(['x'], 'ev.csv'), 'evaluations');
    });
    await waitFor(() => expect(first.result.current.importStatus).toBe('ready_to_apply'));
    first.unmount();

    // A new page: the screen's own type is its default, and only the server's job says evaluations.
    mocks.role = 'admin';
    render(
      <ImportProvider>
        <ImportPanel />
      </ImportProvider>
    );
    expect(await screen.findByText('Import Ready to Apply')).toBeInTheDocument();
    const before = await screen.findByTestId('evaluation-summary');
    expect(within(before).getByTestId('evaluation-updated')).toHaveTextContent('2');

    fireEvent.click(screen.getByRole('button', { name: /^Apply Evaluations Import/ }));
    expect(await screen.findByText('Import Applied with Warnings')).toBeInTheDocument();

    // The result is still the evaluations result: its counts, and the row import-validation refused.
    const after = screen.getByTestId('evaluation-summary');
    expect(within(after).getByText('What this import changed')).toBeInTheDocument();
    expect(within(after).getByTestId('evaluation-updated')).toHaveTextContent('2');
    expect(within(after).getByTestId('evaluation-unmatched')).toHaveTextContent('1');
    expect(within(after).getByTestId('evaluation-invalid')).toHaveTextContent('1');
    expect(within(after).getByTestId('evaluation-invalid-list')).toHaveTextContent('Row 4');
    // And the values were applied to the season's players.
    expect(
      getMockData('players').find((p) => p.external_registration_id === 'EVR-1')
    ).toMatchObject({ years_played: 4, rating: 5 });
  });
});
