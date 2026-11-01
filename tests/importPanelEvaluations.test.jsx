import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ImportPanel from '../frontend/src/components/ImportPanel.jsx';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

/**
 * The evaluations import on the import screen (E3c of docs/changes/2026-10-27-season-enrollment.md):
 * a fifth card with its own explanation, a preview that marks a bad cell, a file with no value
 * column sent to the column mapper, a check-then-confirm flow with the server's counts between
 * (never a one-click apply), and a result with no roll back.
 */

const mocks = vi.hoisted(() => ({
  parse: vi.fn(),
  importState: null,
  startImport: vi.fn(),
  applyDeferredImport: vi.fn(),
  cancelDeferredImport: vi.fn(),
  resetImport: vi.fn(),
  setNotifyOnComplete: vi.fn(),
  rollbackImport: vi.fn(),
}));

vi.mock('papaparse', () => ({ default: { parse: mocks.parse } }));
vi.mock('../frontend/src/contexts/ImportContext.jsx', () => ({
  useImport: () => mocks.importState,
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: MOCK_ORG_ID },
    currentSeasonSetting: { id: 'season-1', name: 'Spring 2026', status: 'active' },
  }),
}));
vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: { auth: { getUser: vi.fn() }, rpc: vi.fn() },
}));

const PREVIEW = {
  dry_run: true,
  status: 'preview',
  staged_rows: 6,
  matched_rows: 3,
  updated_players: 2,
  unchanged_players: 1,
  unmatched_rows: 2,
  unmatched: [
    { source_row_number: 4, registration_id: 'NOBODY-1' },
    { source_row_number: 5, registration_id: '0001' },
  ],
  invalid_rows: 1,
  invalid: [
    { source_row_number: 6, field: 'rating', message: 'Rating must be a whole number from 1 to 5' },
  ],
  duplicate_rows: 0,
  duplicates: [],
  validation_error_rows: 0,
};

const parseAs = (fields, data) =>
  mocks.parse.mockImplementation((_file, options) => {
    options.complete({ data, meta: { fields } });
  });

const chooseEvaluations = () =>
  fireEvent.click(screen.getByRole('button', { name: /^evaluations\b/i }));
const upload = (name = 'evaluations.csv') => {
  const file = new File(['x'], name, { type: 'text/csv' });
  fireEvent.change(screen.getByLabelText(/browse files/i), { target: { files: [file] } });
  return file;
};

describe('ImportPanel: the evaluations import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.importState = {
      isImporting: false,
      progress: 0,
      importStatus: 'idle',
      startImport: mocks.startImport,
      applyDeferredImport: mocks.applyDeferredImport,
      cancelDeferredImport: mocks.cancelDeferredImport,
      resetImport: mocks.resetImport,
      notifyOnComplete: false,
      setNotifyOnComplete: mocks.setNotifyOnComplete,
      importedPlayers: null,
      importedCoaches: null,
      importedEvaluations: null,
      importedFields: null,
      importedFieldAvailability: null,
      rollbackImport: mocks.rollbackImport,
      telemetryLogs: [],
      importLogs: [],
      activeJob: null,
    };
    parseAs(
      ['Registration ID', 'Years Played', 'Skill Tier', 'Rating'],
      [{ 'Registration ID': 'GS-1', 'Years Played': '2', 'Skill Tier': 'developing', Rating: '3' }]
    );
  });

  it('offers the type beside the others and explains what it does in the season', () => {
    render(<ImportPanel onImport={vi.fn()} />);
    const card = screen.getByRole('button', { name: /^evaluations\b/i });
    expect(card).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(card);
    expect(card).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Updates the players already in Spring 2026.')).toBeInTheDocument();
    expect(screen.getByText(/no player is\s+created/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /download evaluations template/i })
    ).toBeInTheDocument();
  });

  it('checks the file and previews the changes: no Validate Only, no one-click import', async () => {
    render(<ImportPanel onImport={vi.fn()} />);
    chooseEvaluations();
    const file = upload();
    await screen.findByText('evaluations.csv');
    expect(screen.queryByRole('button', { name: /validate only/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start import/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /preview changes/i }));
    await waitFor(() => expect(mocks.startImport).toHaveBeenCalledWith(file, 'evaluations'));
  });

  it('marks a cell out of range in the preview', async () => {
    parseAs(
      ['Registration ID', 'Years Played'],
      [{ 'Registration ID': 'GS-1', 'Years Played': '31' }]
    );
    render(<ImportPanel onImport={vi.fn()} />);
    chooseEvaluations();
    upload();
    await screen.findByText('evaluations.csv');
    const cell = screen.getByText('31').closest('td');
    expect(cell).toHaveClass('cell-error');
  });

  it('sends a file with an id and no value column to the column mapper', async () => {
    parseAs(['Registration ID'], [{ 'Registration ID': 'GS-1' }]);
    render(<ImportPanel onImport={vi.fn()} />);
    chooseEvaluations();
    upload();
    expect(await screen.findByRole('heading', { name: 'Map your columns' })).toBeInTheDocument();
    expect(screen.getByText(/still need: one of the value columns/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^continue/i })).toBeDisabled();
  });

  it('shows the server counts before the confirm, and applies or cancels as evaluations', async () => {
    mocks.importState = {
      ...mocks.importState,
      importStatus: 'ready_to_apply',
      progress: 100,
      importedEvaluations: {
        importJobId: 'job-1',
        validationErrors: [
          {
            row: 7,
            field: 'years_played',
            message: 'Years played must be a whole number from 0 to 30',
          },
        ],
        persistence: { preview: PREVIEW },
      },
      activeJob: { warning_summary: { deferred_apply: { import_type: 'evaluations' } } },
    };
    render(<ImportPanel onImport={vi.fn()} />);
    const summary = screen.getByTestId('evaluation-summary');
    expect(
      within(summary).getByRole('heading', { name: 'What this import will change' })
    ).toBeInTheDocument();
    expect(within(summary).getByTestId('evaluation-updated')).toHaveTextContent('2');
    expect(within(summary).getByTestId('evaluation-unchanged')).toHaveTextContent('1');
    expect(within(summary).getByTestId('evaluation-unmatched')).toHaveTextContent('2');
    // One row refused upstream (a row number, however many cells) and one by the finalizer.
    expect(within(summary).getByTestId('evaluation-invalid')).toHaveTextContent('2');
    expect(within(summary).getByText('Row 4: NOBODY-1')).toBeInTheDocument();
    expect(
      within(summary).getByText('Row 7: Years played must be a whole number from 0 to 30')
    ).toBeInTheDocument();
    expect(
      within(summary).getByText(/Only players already in Spring 2026 are updated/)
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /apply evaluations import/i }));
    await waitFor(() => expect(mocks.applyDeferredImport).toHaveBeenCalledWith('evaluations'));
    fireEvent.click(screen.getByRole('button', { name: /cancel deferred import/i }));
    await waitFor(() => expect(mocks.cancelDeferredImport).toHaveBeenCalledWith('evaluations'));
  });

  it('says so when the preview could not be read, and still lets the finalizer decide', () => {
    mocks.importState = {
      ...mocks.importState,
      importStatus: 'ready_to_apply',
      progress: 100,
      importedEvaluations: { importJobId: 'job-1', persistence: { previewError: 'boom' } },
      activeJob: { warning_summary: { deferred_apply: { import_type: 'evaluations' } } },
    };
    render(<ImportPanel onImport={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
    expect(screen.getByRole('button', { name: /apply evaluations import/i })).toBeEnabled();
  });

  it('shows what was changed after the apply, with no roll back', () => {
    const { rerender } = render(<ImportPanel onImport={vi.fn()} />);
    chooseEvaluations();
    // The same panel, once the apply has finished (its type choice is local to it).
    mocks.importState = {
      ...mocks.importState,
      importStatus: 'completed_with_warnings',
      progress: 100,
      importedEvaluations: {
        importJobId: 'job-1',
        persistence: {
          durable: true,
          result: { ...PREVIEW, dry_run: false, status: 'completed_with_warnings' },
        },
      },
    };
    rerender(<ImportPanel onImport={vi.fn()} />);
    const summary = screen.getByTestId('evaluation-summary');
    expect(
      within(summary).getByRole('heading', { name: 'What this import changed' })
    ).toBeInTheDocument();
    expect(within(summary).getByText('Players updated')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /roll back/i })).not.toBeInTheDocument();
  });
});
