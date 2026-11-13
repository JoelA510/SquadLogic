// @vitest-environment jsdom
//
// G5: the recorder of an import's publication baseline is a lazy chunk of the import panel. A chunk that cannot be
// loaded (a deploy that replaced it, a dropped connection) is said as a failed recording, the import stands and the
// result's buttons come back: it never throws in render, and never holds the screen.
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileCsv, seedGameImportWorld } from './helpers/gameImportWorld.js';

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
// The chunk's request fails.
vi.mock('../frontend/src/components/import/ImportBaseline.jsx', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

const { default: ScheduleImportPanel } =
  await import('../frontend/src/components/import/ScheduleImportPanel.jsx');

const step = () => screen.getByTestId('schedule-import-step').textContent;
const choose = (name, value) =>
  fireEvent.change(screen.getByRole('combobox', { name: `What ${name} is` }), {
    target: { value },
  });

beforeEach(() => seedGameImportWorld());
afterEach(() => vi.clearAllMocks());

describe('a baseline chunk that cannot be loaded', () => {
  it('is said as a failed recording, the import stands, and the roll back is offered', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and import' }));
    await waitFor(() => expect(step()).toMatch(/4 of 4/));

    const notice = await screen.findByTestId('schedule-import-baseline');
    expect(notice.getAttribute('role')).toBe('alert');
    // (the loader's own error is in the brackets; vitest words a failed mock factory its own way)
    expect(notice.textContent).toMatch(
      /^The import is applied, but no publication baseline was recorded: this page could not load what records it \(.+\)\. Reload the page/
    );
    expect(screen.getByTestId('schedule-import-applied').textContent).toMatch(/Imported:/);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Roll back this import' })).toBeEnabled()
    );

    // and the roll back's look-up of the baseline, from the same chunk, says it could not check
    fireEvent.click(screen.getByRole('button', { name: 'Roll back this import' }));
    expect((await screen.findByTestId('schedule-import-baseline-rolled-back')).textContent).toMatch(
      /Whether a publication baseline was recorded from this import could not be checked/
    );
  });
});
