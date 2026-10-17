/**
 * The import page's "Continue" keeps the applied import and moves on (Wave 3,
 * remediation plan, "Discovered during execution", 2026-10-14).
 *
 * The handler passed the import to its caller and then called
 * `resetImport('all')` in the same click, which cleared every imported dataset
 * in `ImportContext`. So `/teams` opened without the import the operator had
 * just applied, while the side navigation (which resets nothing) kept it.
 *
 * Mounted on the real `ImportProvider`, `ImportPage` and `ImportPanel`; only the
 * Supabase client and the organization are stand-ins. The import reaches the
 * context the way a reload after an applied import brings it back: the
 * `imports` row the provider rehydrates from, with "completed" remembered in
 * `localStorage`.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ImportProvider, useImport } from '../frontend/src/contexts/ImportContext.jsx';
import ImportPage from '../frontend/src/pages/ImportPage.jsx';

const IDS = vi.hoisted(() => ({
  organization: '7d1f9a52-3c4b-4e8a-9a51-0c2f6b1d9e01',
  user: '7d1f9a52-3c4b-4e8a-9a51-0c2f6b1d9e02',
}));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: IDS.organization },
    orgMember: { id: 'member', role: 'admin' },
  }),
}));

/** Fictitious rows: three players in one division. */
const PLAYERS = [
  { first_name: 'Ada', last_name: 'One', division: 'U9 Coed' },
  { first_name: 'Bea', last_name: 'Two', division: 'U9 Coed' },
  { first_name: 'Cy', last_name: 'Three', division: 'U9 Coed' },
];

/** A PostgREST-style builder: every method chains, awaiting it gives the rows. */
function query(rows) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    then: (resolve) => resolve({ data: rows, error: null }),
  };
  return builder;
}

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    rpc: vi.fn(async () => ({ data: null, error: null })),
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: IDS.user } }, error: null })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
    from: vi.fn((table) =>
      query(
        table === 'imports'
          ? [
              {
                id: 'import-1',
                import_type: 'players',
                user_id: IDS.user,
                organization_id: IDS.organization,
                data: { totalRows: PLAYERS.length, validRows: PLAYERS.length, data: PLAYERS },
              },
            ]
          : []
      )
    ),
    channel: vi.fn(() => {
      const channel = { on: vi.fn(() => channel), subscribe: vi.fn() };
      return channel;
    }),
    removeChannel: vi.fn(),
    functions: { invoke: vi.fn() },
  },
}));

/** What the context holds, shown on every route. */
function ContextImport() {
  const { importedData, importedPlayers } = useImport();
  return (
    <div>
      <p data-testid="imported-rows">{importedData?.data?.length ?? 0}</p>
      <p data-testid="imported-players">{importedPlayers?.data?.length ?? 0}</p>
    </div>
  );
}

function renderImportPage() {
  return render(
    <MemoryRouter initialEntries={['/import']}>
      <ImportProvider>
        <Routes>
          <Route path="/import" element={<ImportPage />} />
          <Route path="/teams" element={<h1>Teams</h1>} />
        </Routes>
        <ContextImport />
      </ImportProvider>
    </MemoryRouter>
  );
}

/** The applied import is in the context: the meta-assertion each case starts from. */
async function expectImportInContext() {
  await waitFor(() => expect(screen.getByTestId('imported-rows')).toHaveTextContent('3'));
  expect(screen.getByTestId('imported-players')).toHaveTextContent('3');
}

describe('Import "Continue" keeps the applied import', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('importStatus', 'completed');
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('opens the teams page with the import still in the context', async () => {
    renderImportPage();
    await expectImportInContext();

    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Teams' })).toBeInTheDocument();
    await expectImportInContext();
    // Continue is not "Upload Another File": the applied status is kept too.
    expect(localStorage.getItem('importStatus')).toBe('completed');
  });

  it('"Upload Another File" is still the reset (the counters can read zero)', async () => {
    renderImportPage();
    await expectImportInContext();

    fireEvent.click(await screen.findByRole('button', { name: 'Upload Another File' }));

    await waitFor(() => expect(screen.getByTestId('imported-rows')).toHaveTextContent('0'));
    expect(screen.getByTestId('imported-players')).toHaveTextContent('0');
    expect(screen.queryByRole('heading', { name: 'Teams' })).not.toBeInTheDocument();
  });
});
