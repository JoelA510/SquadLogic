/**
 * Demo mode, the import notice (plan docs/changes/2026-10-22-demo-mode.md, D4): in a demo, trying
 * to import a file opens a dialog instead of the file picker, and no file is read.
 *
 *  - the picker never opens (the input's click is cancelled), nothing is parsed or sent, on the
 *    browse link, by the keyboard and by a drop;
 *  - the dialog has both links (create an account, run your own), traps and restores focus;
 *  - the hosted-service line appears only with VITE_OFFICIAL_SITE_URL, and never on the official
 *    origin itself;
 *  - control: outside a demo the same input parses the file, so the interception is not a page
 *    that cannot import at all.
 */
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  organization: { id: 'org-1', name: 'League', demo_expires_at: null },
  official: undefined,
  parse: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('../frontend/src/env.js', async (importOriginal) => ({
  ...(await importOriginal()),
  get OFFICIAL_SITE_URL() {
    return state.official;
  },
}));

vi.mock('papaparse', () => ({ default: { parse: (...args) => state.parse(...args) } }));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({ currentOrganization: state.organization, organizations: [] }),
}));
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ signOut: state.signOut, session: null }),
}));
vi.mock('../frontend/src/contexts/ImportContext.jsx', () => ({
  useImport: () => ({
    isImporting: false,
    progress: 0,
    importStatus: 'idle',
    startImport: vi.fn(),
    applyDeferredImport: vi.fn(),
    cancelDeferredImport: vi.fn(),
    resetImport: vi.fn(),
    notifyOnComplete: false,
    setNotifyOnComplete: vi.fn(),
    importedPlayers: null,
    importedCoaches: null,
    importedFields: null,
    importedFieldAvailability: null,
    rollbackImport: vi.fn(),
    telemetryLogs: [],
    importLogs: [],
    activeJob: null,
  }),
}));
vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

import ImportPanel from '../frontend/src/components/ImportPanel.jsx';

const DEMO_ORG = {
  id: 'demo-1',
  name: 'Demo league',
  demo_expires_at: new Date(Date.now() + 20 * 60_000).toISOString(),
};

function renderPanel() {
  return render(
    <MemoryRouter>
      <ImportPanel />
    </MemoryRouter>
  );
}

const csv = () => new File(['first_name,last_name\nA,B\n'], 'players.csv', { type: 'text/csv' });

beforeEach(() => {
  state.organization = DEMO_ORG;
  state.official = undefined;
  state.parse.mockReset();
  state.signOut.mockReset();
});

afterEach(() => cleanup());

describe('the file picker in a demo', () => {
  // A browser dispatches this same click for Enter or Space on the focused input, so the keyboard
  // path is this one.
  it('opens the notice and cancels the picker when the browse link or input is activated', async () => {
    renderPanel();
    const input = document.querySelector('input[type="file"]');
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });

    input.dispatchEvent(clickEvent);

    expect(clickEvent.defaultPrevented).toBe(true);
    const dialog = await screen.findByRole('dialog', {
      name: 'Importing is turned off in the demo',
    });
    expect(dialog).toBeInTheDocument();
    expect(state.parse).not.toHaveBeenCalled();
  });

  it('opens the notice on a drop and reads nothing', async () => {
    renderPanel();
    const zone = screen
      .getByText('Drag and drop your CSV file here')
      .closest('div[class*="border-dashed"]');

    fireEvent.drop(zone, { dataTransfer: { files: [csv()] } });

    expect(
      await screen.findByRole('dialog', { name: 'Importing is turned off in the demo' })
    ).toBeInTheDocument();
    expect(state.parse).not.toHaveBeenCalled();
  });

  it('opens the notice if a file arrives through the input anyway, and reads nothing', async () => {
    renderPanel();
    const input = document.querySelector('input[type="file"]');

    fireEvent.change(input, { target: { files: [csv()] } });

    expect(
      await screen.findByRole('dialog', { name: 'Importing is turned off in the demo' })
    ).toBeInTheDocument();
    expect(state.parse).not.toHaveBeenCalled();
  });

  it('control: outside a demo the same drop parses the file and shows no notice', async () => {
    state.organization = { id: 'org-1', name: 'League', demo_expires_at: null };
    renderPanel();
    const zone = screen
      .getByText('Drag and drop your CSV file here')
      .closest('div[class*="border-dashed"]');

    fireEvent.drop(zone, { dataTransfer: { files: [csv()] } });

    await waitFor(() => expect(state.parse).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('the notice', () => {
  async function openNotice() {
    renderPanel();
    const input = /** @type {HTMLInputElement} */ (document.querySelector('input[type="file"]'));
    input.focus();
    input.click();
    return {
      input,
      dialog: await screen.findByRole('dialog', { name: 'Importing is turned off in the demo' }),
    };
  }

  it('offers both ways on: an account here, and a SquadLogic of your own', async () => {
    const { dialog } = await openNotice();

    expect(
      within(dialog).getByRole('button', { name: 'Create an account here' })
    ).toBeInTheDocument();
    const own = within(dialog).getByRole('link', { name: 'Run your own SquadLogic' });
    expect(own).toHaveAttribute(
      'href',
      expect.stringMatching(/\/docs\/operations\/self-hosting\.md$/)
    );
    expect(own).toHaveAttribute('target', '_blank');
    expect(own).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(dialog).toHaveTextContent('placeholder data only');
  });

  it('Create an account here signs the visitor out of the demo', async () => {
    const { dialog } = await openNotice();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create an account here' }));

    expect(state.signOut).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('keeps focus inside, and gives it back to the input on close', async () => {
    const { input, dialog } = await openNotice();
    const focusable = /** @type {HTMLElement[]} */ ([
      ...dialog.querySelectorAll('a[href], button:not([disabled])'),
    ]);

    expect(dialog.contains(document.activeElement)).toBe(true);
    // Tab from the last control wraps to the first; Shift+Tab from the first wraps to the last.
    focusable.at(-1).focus();
    fireEvent.keyDown(document.activeElement, { key: 'Tab' });
    expect(document.activeElement).toBe(focusable[0]);
    fireEvent.keyDown(document.activeElement, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(focusable.at(-1));

    fireEvent.keyDown(document.activeElement, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(input);
  });

  describe('the hosted-service line', () => {
    it('is absent without VITE_OFFICIAL_SITE_URL', async () => {
      state.official = undefined;
      const { dialog } = await openNotice();
      expect(dialog).not.toHaveTextContent('also hosted at');
    });

    it('names the hosted service when it is set and is not this origin', async () => {
      state.official = 'https://hosted.squadlogic.invalid/';
      const { dialog } = await openNotice();
      expect(dialog).toHaveTextContent('SquadLogic is also hosted at hosted.squadlogic.invalid.');
      expect(
        within(dialog).getByRole('link', { name: 'hosted.squadlogic.invalid' })
      ).toHaveAttribute('href', 'https://hosted.squadlogic.invalid/');
    });

    it('is never shown on the official origin itself', async () => {
      state.official = `${window.location.origin}/`;
      const { dialog } = await openNotice();
      expect(dialog).not.toHaveTextContent('also hosted at');
    });
  });
});
