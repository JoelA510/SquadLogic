/**
 * A completed season is read-only on the practice preferences page (Phase D C2), as E3b made it on
 * the scheduling pages: every control that writes is off and the page says why, instead of letting
 * the database refuse (`season_completed`, 22023). The Pending musts and Conflicts tabs are checked
 * in `pendingMusts.test.jsx` and `preferenceConflicts.test.jsx`; this file holds the Rules and Import
 * tabs, the note's words, and the control (the same page on the active season).
 *
 * Plant: drop `readOnly` from the rules list's Add button -> the Add case goes red.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import CoachPreferencesPage from '../frontend/src/pages/CoachPreferencesPage.jsx';
import ToastHost from '../frontend/src/components/ui/ToastHost.jsx';
import { supabase } from '../frontend/src/lib/supabaseClient.js';
import { useOrganization } from '../frontend/src/contexts/OrganizationContext.jsx';
import { useAuth } from '../frontend/src/contexts/AuthContext.jsx';
import { ORG, SEASON, freshTables, makeFrom } from './helpers/preferenceTables.js';

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({ useOrganization: vi.fn() }));
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({ useAuth: vi.fn() }));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const WRITES = [
  'admin_add_practice_preference',
  'admin_edit_practice_preference',
  'admin_remove_practice_preference',
  'admin_decide_must_preference',
  'admin_accept_all_musts',
  'create_import_job',
];

const renderAs = async (status, tab) => {
  vi.mocked(useOrganization).mockReturnValue(
    /** @type {any} */ ({
      currentOrganization: { id: ORG },
      currentSeasonSetting: { id: SEASON, status, name: 'Spring 2026' },
      orgMember: { role: 'admin' },
    })
  );
  vi.mocked(useAuth).mockReturnValue(/** @type {any} */ ({ user: { id: 'user-admin' } }));
  render(
    <MemoryRouter>
      <ToastHost>
        <CoachPreferencesPage />
      </ToastHost>
    </MemoryRouter>
  );
  await screen.findByTestId('admin-preferences-view');
  fireEvent.click(screen.getByRole('tab', { name: tab }));
};

beforeEach(() => {
  const tables = freshTables();
  vi.mocked(supabase.from).mockImplementation(
    /** @type {any} */ ((table) => makeFrom(tables, {})(table))
  );
  vi.mocked(supabase.rpc).mockReset();
  vi.mocked(supabase.rpc).mockResolvedValue(/** @type {any} */ ({ data: {}, error: null }));
});

describe('the Rules tab of a completed season', () => {
  it('says why, and turns Add, Edit and Remove off', async () => {
    await renderAs('completed', 'Rules');
    expect(screen.getByTestId('season-readonly-note')).toHaveTextContent(
      'This season is completed and read-only: its practice preferences cannot be imported, decided, added, edited or removed.'
    );
    expect(screen.getByRole('button', { name: 'Add a rule…' })).toBeDisabled();
    const rowButtons = screen.getAllByRole('button', { name: /^(Edit|Remove) / });
    expect(rowButtons.length).toBeGreaterThan(0);
    for (const button of rowButtons) expect(button).toBeDisabled();
    // Reading is not read-only: the filters and the rules are there.
    expect(screen.getByLabelText('Team')).toBeEnabled();
    expect(screen.getByRole('table')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add a rule…' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    for (const name of WRITES)
      expect(supabase.rpc).not.toHaveBeenCalledWith(name, expect.anything());
  });

  it('the control: an active season has the note off and the controls on', async () => {
    await renderAs('active', 'Rules');
    expect(screen.queryByTestId('season-readonly-note')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a rule…' })).toBeEnabled();
    for (const button of screen.getAllByRole('button', { name: /^(Edit|Remove) / })) {
      expect(button).toBeEnabled();
    }
  });

  it('a draft season is not read-only', async () => {
    await renderAs('draft', 'Rules');
    expect(screen.queryByTestId('season-readonly-note')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a rule…' })).toBeEnabled();
  });
});

describe('the Import tab of a completed season', () => {
  it('turns the file control off and says the season takes no import', async () => {
    await renderAs('completed', 'Import a file');
    expect(await screen.findByLabelText('Choose a CSV file')).toBeDisabled();
    expect(screen.getByTestId('preference-import-readonly')).toHaveTextContent(
      'This season is completed and takes no import'
    );
    for (const name of WRITES)
      expect(supabase.rpc).not.toHaveBeenCalledWith(name, expect.anything());
  });

  it('the control: an active season takes a file', async () => {
    await renderAs('active', 'Import a file');
    expect(await screen.findByLabelText('Choose a CSV file')).toBeEnabled();
    expect(screen.queryByTestId('preference-import-readonly')).not.toBeInTheDocument();
  });
});
