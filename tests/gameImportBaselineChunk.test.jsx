// @vitest-environment jsdom
//
// A published import can request a baseline. If its code cannot load, the admin can retry with the
// same preview and mappings before the database applies the games.
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileCsv, ORG, seedGameImportWorld } from './helpers/gameImportWorld.js';

vi.setConfig({ testTimeout: 30000 });

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase, supabaseReady: Promise.resolve() };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: '0a000000-0000-4000-8000-000000000001', name: 'Placeholder League' },
    currentSeasonSetting: {
      id: '0a000000-0000-4000-8000-000000000002',
      name: 'Fall 2026',
      status: 'active',
      timezone: 'America/Los_Angeles',
    },
  }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn() },
}));
// The chunk's request fails the first time it is made, and loads after that (a dropped connection, not a lost file).
const LOADS = vi.hoisted(() => ({ n: 0 }));
vi.mock('../frontend/src/components/import/ImportBaseline.jsx', async (importOriginal) => {
  LOADS.n += 1;
  if (LOADS.n === 1) throw new Error('Failed to fetch dynamically imported module');
  return importOriginal();
});

const { default: ScheduleImportPanel } =
  await import('../frontend/src/components/import/ScheduleImportPanel.jsx');
const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');

const step = () => screen.getByTestId('schedule-import-step').textContent;
const choose = (name, value) =>
  fireEvent.change(screen.getByRole('combobox', { name: `What ${name} is` }), {
    target: { value },
  });

beforeEach(() => seedGameImportWorld());
afterEach(() => vi.clearAllMocks());

describe('a baseline chunk that cannot be loaded', () => {
  it('keeps the preview on a failed load, then applies once and records after retry', async () => {
    render(<ScheduleImportPanel />);
    fireEvent.change(screen.getByTestId('schedule-import-file'), {
      target: { files: [new File([fileCsv()], 'schedule.csv', { type: 'text/csv' })] },
    });
    await waitFor(() => expect(step()).toMatch(/2 of 4/));
    choose('Visiting Club A (U05 Boys)', 'outside');
    choose('Field 9 (Venue A)', 'create');
    choose('U07 Girls', 'create');
    choose('U07G Team 01 (U07 Girls)', 'create');
    choose('U07G Team 02 (U07 Girls)', 'create');
    fireEvent.click(screen.getByRole('button', { name: 'Preview the import' }));
    await waitFor(() => expect(step()).toMatch(/3 of 4/));
    fireEvent.click(screen.getByLabelText('Create the 5 records listed above'));
    const readGames = () =>
      mockSupabase.from('game_assignments').select('id, start, end').eq('organization_id', ORG);
    const original = await readGames();
    expect(original.error).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and import' }));
    await screen.findByText(/No games were imported. The publication baseline tool could not load/);
    expect(step()).toMatch(/3 of 4/);
    expect(screen.queryByTestId('schedule-import-applied')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Create the 5 records listed above')).toBeChecked();
    expect(LOADS.n).toBe(1);
    expect(await readGames()).toEqual(original);

    fireEvent.click(screen.getByRole('button', { name: 'Confirm and import' }));
    await waitFor(() => expect(step()).toMatch(/4 of 4/), { timeout: 10000 });
    await waitFor(
      () =>
        expect(screen.getByTestId('schedule-import-baseline').textContent).toMatch(
          /as published baseline v1, for "Changes since publication"/
        ),
      { timeout: 10000 }
    );
    expect(LOADS.n).toBe(2);
    const { data } = await mockSupabase
      .from('publication_baselines')
      .select('id')
      .eq('organization_id', '0a000000-0000-4000-8000-000000000001');
    expect(data).toHaveLength(1);
  });
});
