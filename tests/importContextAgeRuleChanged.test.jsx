import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { ImportProvider, useImport } from '../frontend/src/contexts/ImportContext.jsx';
import { getMockData, mockSupabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

/**
 * A player file whose season changed its age rule between the validation and the apply (Phase E3b;
 * Codex's finding on #680): the database refuses it (`age_rule_changed`) and the import log says
 * what to do. Run through the real import flow, the Edge Function's mock (which stamps the job
 * before it reads the rule) and the mock finalizer; the rule is changed under the flow just before
 * the finalize call, which is the window the stamp exists for. Control: the same file with no change.
 */
const mocks = vi.hoisted(() => ({ parse: vi.fn() }));

vi.mock('papaparse', () => ({ default: { parse: mocks.parse } }));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: MOCK_ORG_ID },
    orgMember: { id: 'member-1' },
  }),
}));

const HEADERS = ['first_name', 'last_name', 'date_of_birth', 'external_registration_id'];
const ROWS = [
  {
    first_name: 'Zed',
    last_name: 'Stamp',
    date_of_birth: '2018-05-01',
    external_registration_id: 'AR-1',
  },
];

const activeSeason = () =>
  getMockData('season_settings').find(
    (s) => String(s.organization_id) === String(MOCK_ORG_ID) && s.status === 'active'
  );

describe('ImportContext :: the season changed its age rule after the file was checked', () => {
  beforeEach(async () => {
    sessionStorage.clear();
    window.__MOCK_DB__ = undefined;
    mocks.parse.mockReset();
    mocks.parse.mockImplementation((_file, options) => {
      options.complete({ data: ROWS, meta: { fields: HEADERS } });
    });
    await mockSupabase.auth.signInWithPassword({
      email: 'admin@example.com',
      password: 'test-password-123',
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const run = async () => {
    const wrapper = ({ children }) => <ImportProvider>{children}</ImportProvider>;
    const { result } = renderHook(() => useImport(), { wrapper });
    await act(async () => {
      await result.current.startImport(new File(['x'], 'players.csv'), 'players');
    });
    return result;
  };

  it('tells the admin to validate the file again, and writes no player', async () => {
    const realRpc = mockSupabase.rpc.bind(mockSupabase);
    vi.spyOn(mockSupabase, 'rpc').mockImplementation(async (name, params) => {
      if (name === 'finalize_import_job') {
        const season = activeSeason();
        window.__saveMockDB__({
          ...window.__MOCK_DB__,
          season_settings: getMockData('season_settings').map((s) =>
            s.id === season.id
              ? { ...s, age_cutoff_mode: 'custom', age_cutoff_month: 3, age_cutoff_day: 1 }
              : s
          ),
        });
      }
      return realRpc(name, params);
    });
    const before = getMockData('players').length;
    const result = await run();
    await waitFor(() => {
      const messages = result.current.importLogs.map((entry) => entry.message);
      expect(
        messages.some((m) =>
          m.includes(
            "The season's age rules changed since this file was checked; validate it again."
          )
        )
      ).toBe(true);
    });
    expect(getMockData('players')).toHaveLength(before);
    expect(result.current.importStatus).toBe('error');
  });

  it('CONTROL: with no change the same file applies', async () => {
    const before = getMockData('players').length;
    const result = await run();
    await waitFor(() => {
      const messages = result.current.importLogs.map((entry) => entry.message);
      expect(messages.some((m) => m.startsWith('Roster database updated: 1 inserted'))).toBe(true);
    });
    expect(getMockData('players')).toHaveLength(before + 1);
  });
});
