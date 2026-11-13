// @vitest-environment jsdom
//
// One guard alone: the Games tab's own early reading of the file (core's parse of the headers the browser would SEND)
// refuses more than 200 of them, in words, on step 1. The client is replaced by a spy here, so the client's own check
// (tested alone in tests/gameImportHeaderCap.test.js) cannot be the guard that held: if the panel's parse lets the file
// through, `startGameImport` is called and this test goes red. Through the client the guards cannot be told apart,
// because both say the same sentence (`describeTooManyColumns`).
//
// More than 200 headers to send needs a column the import reads given more than 200 times (the import reads eleven
// names); the CSV reader renames only an exact repeat, so 201 spellings of `Date` (each with more trailing spaces)
// reach the parse as 201 headers it reads.
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { seedGameImportWorld } from './helpers/gameImportWorld.js';

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
      season_start: '2026-09-07',
      season_end: '2027-03-31',
      timezone: 'America/Los_Angeles',
    },
  }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn() },
}));
const start = vi.hoisted(() => vi.fn());
vi.mock('../frontend/src/utils/gameImportClient.js', async (original) => ({
  ...(await original()),
  startGameImport: start,
}));

const { default: ScheduleImportPanel } =
  await import('../frontend/src/components/import/ScheduleImportPanel.jsx');

beforeEach(() => {
  seedGameImportWorld();
});
afterEach(() => {
  vi.clearAllMocks();
});

it('the panel’s own parse refuses 201 headers it would send, in words, on step 1, and never starts the import', async () => {
  render(<ScheduleImportPanel />);
  const headers = Array.from({ length: 201 }, (_, i) => `Date${' '.repeat(i)}`);
  const csv = [headers.join(','), headers.map(() => '2026-09-12').join(',')].join('\n');
  fireEvent.change(screen.getByTestId('schedule-import-file'), {
    target: { files: [new File([csv], 'many.csv', { type: 'text/csv' })] },
  });
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toMatch(/The file has 201 columns; one import reads at most 200/);
  expect(screen.getByTestId('schedule-import-step').textContent).toMatch(/1 of 4/);
  expect(start).not.toHaveBeenCalled();
});

it('CONTROL: 200 of them pass the cap (the parse then refuses the repeat), so the cap above is what refused', async () => {
  render(<ScheduleImportPanel />);
  const headers = Array.from({ length: 200 }, (_, i) => `Date${' '.repeat(i)}`);
  const csv = [headers.join(','), headers.map(() => '2026-09-12').join(',')].join('\n');
  fireEvent.change(screen.getByTestId('schedule-import-file'), {
    target: { files: [new File([csv], 'many.csv', { type: 'text/csv' })] },
  });
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toMatch(/more than once/);
  expect(start).not.toHaveBeenCalled();
});
