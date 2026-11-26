import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSeasonTeamingInput } from '../frontend/src/hooks/useSeasonTeamingInput.js';

const state = vi.hoisted(() => ({ season: 'fall', file: null, history: false, read: vi.fn() }));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: 'club' },
    currentSeasonSetting: { id: state.season },
  }),
}));
vi.mock('../frontend/src/contexts/ImportContext.jsx', () => ({
  useImport: () => ({ importedData: state.file, playerImportFromHistory: state.history }),
}));
vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    from: () => {
      const filters = {};
      const query = {
        select: () => query,
        eq: (key, value) => {
          filters[key] = value;
          return query;
        },
        order: () => query,
        range: (start, end) => state.read(filters, start, end),
      };
      return query;
    },
  },
}));

beforeEach(() => {
  state.season = 'fall';
  state.file = null;
  state.history = false;
  state.read.mockReset();
});

describe('saved registrations as teaming input', () => {
  it('keeps an old unscoped import out of generation when the selected season is empty', async () => {
    state.history = true;
    state.file = { totalRows: 1, data: [{ first_name: 'From another season' }] };
    state.read.mockResolvedValue({ data: [] });
    const { result } = renderHook(useSeasonTeamingInput);
    await waitFor(() => expect(state.read).toHaveBeenCalledOnce());
    expect(result.current.importedData).toBeNull();
  });
  it('reads beyond one page using the selected club and season, preserving player and division identity', async () => {
    state.read.mockImplementation(async (filters, start) => {
      expect(filters).toEqual({ organization_id: 'club', season_settings_id: 'fall' });
      return {
        data: Array.from({ length: start === 0 ? 1000 : 1 }, (_, i) => ({
          id: String(start + i),
          division_id: 'd',
          divisions: { name: 'U10' },
          status: 'waitlist',
        })),
      };
    });
    const { result } = renderHook(useSeasonTeamingInput);
    await waitFor(() => expect(result.current.importedData?.totalRows).toBe(1001));
    expect(result.current.importedData.data[1000]).toMatchObject({
      id: '1000',
      division_id: 'd',
      division_name: 'U10',
      status: 'waitlist',
    });
  });

  it('keeps earlier registrations when a later file contains only one player and applies only matching hints', async () => {
    state.file = {
      scope: 'club/fall',
      data: [{ registration_id: 'late', dob: '2017-02-02', first_name: 'Old' }],
    };
    state.read.mockResolvedValueOnce({
      data: [
        {
          id: 'p1',
          external_registration_id: 'early',
          buddy_request: ' LATE ',
          divisions: { name: 'Youth' },
        },
        {
          id: 'p2',
          first_name: 'Saved',
          external_registration_id: 'late',
          divisions: { name: 'Youth' },
        },
      ],
    });
    const { result } = renderHook(useSeasonTeamingInput);
    await waitFor(() => expect(result.current.importedData?.totalRows).toBe(2));
    expect(result.current.importedData.data[0]).not.toHaveProperty('dob');
    expect(result.current.importedData.data[0].buddy_id).toBe('p2');
    expect(result.current.importedData.data[1]).toMatchObject({
      id: 'p2',
      first_name: 'Saved',
      dob: '2017-02-02',
    });
  });

  it('uses the same registration aliases and first matching data row as the player finalizer', async () => {
    state.file = {
      scope: 'club/fall',
      data: [
        { player_id: 'reg-a', dob: '2016-01-02' },
        { registration_id: 'reg-a', dob: '2019-01-02' },
        { gotsport_id: 'reg-b', dob: '2017-04-03' },
      ],
    };
    state.read.mockResolvedValue({
      data: [
        { id: 'a', external_registration_id: 'reg-a' },
        { id: 'b', external_registration_id: 'reg-b' },
      ],
    });
    const { result } = renderHook(useSeasonTeamingInput);
    await waitFor(() => expect(result.current.importedData?.totalRows).toBe(2));
    expect(result.current.importedData.data.map((row) => row.dob)).toEqual([
      '2016-01-02',
      '2017-04-03',
    ]);
  });

  it('ignores an old file and a delayed old-season read on a switch and surfaces a failed new-season read', async () => {
    let release;
    state.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const { result, rerender } = renderHook(useSeasonTeamingInput);
    state.file = { scope: 'club/fall', totalRows: 35, data: [] };
    state.season = 'spring';
    state.read.mockResolvedValueOnce({ error: { message: 'read refused' } });
    rerender();
    await waitFor(() => expect(result.current.rosterError).toContain('read refused'));
    await act(async () => release({ data: [{ id: 'old', divisions: { name: 'U10' } }] }));
    expect(result.current.importedData).toBeNull();
    expect(result.current.rosterError).toContain('read refused');
  });
});
