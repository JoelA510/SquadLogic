/**
 * The pointer from Data Import to the practice preferences import
 * (docs/changes/2026-11-02-preference-followups.md, item 2; no migration).
 *
 * Practice preferences are not a type on Data Import: a preference file is imported on the Practice
 * preferences page, in its Import a file tab. The card says so and links to that tab. What this file
 * holds, and the plant that turns each red:
 *   - the card is on Data Import, for an admin, with one link to `?tab=import` (plant: remove the
 *     `<PracticePreferencesPointer />` from `ImportPage`; or point the link anywhere else);
 *   - it is not offered to a role that cannot reach the page (plant: drop the permission test);
 *   - it follows the page's own NAV entry: hidden when the entry names a feature flag the league has
 *     off, shown when on, and a missing entry renders nothing and is caught here (plant: ignore
 *     `entry.feature`);
 *   - the link works: it lands on the Practice preferences page already on its Import a file tab, and
 *     an unknown `?tab=` is ignored (plant: stop reading `?tab=` in `CoachPreferencesPage`).
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import CoachPreferencesPage from '../frontend/src/pages/CoachPreferencesPage.jsx';
import ImportPage from '../frontend/src/pages/ImportPage.jsx';
import PracticePreferencesPointer from '../frontend/src/components/preferences/PracticePreferencesPointer.jsx';
import ToastHost from '../frontend/src/components/ui/ToastHost.jsx';
import { NAV } from '../frontend/src/constants/navigation.js';
import { FEATURE_FLAGS } from '../frontend/src/constants/featureFlags.js';
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
// The data panel is not what is under test, and it needs the import context and a file API.
vi.mock('../frontend/src/components/ImportPanel.jsx', () => ({
  default: () => <section data-testid="import-panel">Data Ingestion</section>,
}));

const asRole = (role, featureFlags = {}) => {
  vi.mocked(useOrganization).mockReturnValue(
    /** @type {any} */ ({
      currentOrganization: { id: ORG },
      currentSeasonSetting: { id: SEASON, status: 'active', name: 'Fall 2026' },
      orgMember: { role },
      featureFlags,
    })
  );
  vi.mocked(useAuth).mockReturnValue(/** @type {any} */ ({ user: { id: 'user-admin' } }));
};

/** The `practice-preferences` entry of the real NAV, which these tests read and, for two, edit in place. */
const entry = () =>
  /** @type {any[]} */ (NAV)
    .flatMap((node) => (node.type === 'group' ? node.items : [node]))
    .find((item) => item.id === 'practice-preferences');

const renderAt = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ToastHost>
        <Routes>
          <Route path="/import" element={<ImportPage />} />
          <Route path="/coaches/practice-preferences" element={<CoachPreferencesPage />} />
        </Routes>
      </ToastHost>
    </MemoryRouter>
  );

beforeEach(() => {
  const tables = freshTables();
  vi.mocked(supabase.from).mockImplementation(
    /** @type {any} */ ((table) => makeFrom(tables, {})(table))
  );
  vi.mocked(supabase.rpc).mockReset();
  vi.mocked(supabase.rpc).mockResolvedValue(/** @type {any} */ ({ data: {}, error: null }));
});

describe('the card on Data Import', () => {
  it('is there for an admin, names where preferences are imported and has one link to that tab', () => {
    asRole('admin');
    renderAt('/import');
    const card = screen.getByRole('region', {
      name: 'Practice preferences are imported on their own page',
    });
    expect(card).toHaveTextContent('Import a file tab');
    expect(card).toHaveTextContent('shows what the file will do before it does it');
    expect(card).toHaveTextContent('stays pending until you accept it');
    const links = within(card).getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName('Open Practice preferences, Import a file tab');
    expect(links[0]).toHaveAttribute('href', '/coaches/practice-preferences?tab=import');
    // It sits under the data panel, not instead of it.
    expect(screen.getByTestId('import-panel')).toBeInTheDocument();
  });

  it('is there for staff too, who hold the same permission', () => {
    asRole('staff');
    renderAt('/import');
    expect(screen.getByTestId('practice-preferences-pointer')).toBeInTheDocument();
  });

  it('is not offered to a role that cannot reach the page', () => {
    // No such role signs in; the card still must not appear for one the page would turn away.
    asRole('member');
    renderAt('/import');
    expect(screen.getByTestId('import-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('practice-preferences-pointer')).not.toBeInTheDocument();
    expect(screen.queryByText(/imported on their own page/)).not.toBeInTheDocument();
  });

  it('is not offered with no role loaded yet', () => {
    asRole(undefined);
    renderAt('/import');
    expect(screen.queryByTestId('practice-preferences-pointer')).not.toBeInTheDocument();
  });
});

describe('the card follows the page it points to', () => {
  let live;
  let original;
  beforeEach(() => {
    // The very object the component reads, kept by reference: a test renames it, so it cannot be found by id again.
    live = entry();
    original = { ...live };
  });
  afterEach(() => {
    // Put the real entry back exactly, so no other test in this file sees an edit.
    for (const key of Object.keys(live)) delete live[key];
    Object.assign(live, original);
  });

  it('finds the page in the navigation (so the card cannot vanish unseen if it is renamed)', () => {
    expect(entry()).toMatchObject({
      id: 'practice-preferences',
      path: '/coaches/practice-preferences',
      permission: 'decide_practice_preference',
    });
    // Today nothing gates the page by a feature flag, and the route has none either.
    expect(entry().feature).toBeUndefined();
  });

  it('is hidden while a feature flag on the page’s entry is off, and shown when it is on', () => {
    live.feature = FEATURE_FLAGS.HEAT_FORECAST;
    asRole('admin', { [FEATURE_FLAGS.HEAT_FORECAST]: false });
    const { unmount } = render(
      <MemoryRouter>
        <PracticePreferencesPointer />
      </MemoryRouter>
    );
    expect(screen.queryByTestId('practice-preferences-pointer')).not.toBeInTheDocument();
    unmount();

    asRole('admin', { [FEATURE_FLAGS.HEAT_FORECAST]: true });
    render(
      <MemoryRouter>
        <PracticePreferencesPointer />
      </MemoryRouter>
    );
    expect(screen.getByTestId('practice-preferences-pointer')).toBeInTheDocument();
  });

  it('renders nothing when the entry cannot be found', () => {
    live.id = 'renamed-practice-preferences';
    asRole('admin');
    render(
      <MemoryRouter>
        <PracticePreferencesPointer />
      </MemoryRouter>
    );
    expect(screen.queryByTestId('practice-preferences-pointer')).not.toBeInTheDocument();
  });
});

describe('the link', () => {
  it('opens the Practice preferences page on its Import a file tab', async () => {
    asRole('admin');
    renderAt('/import');
    fireEvent.click(
      screen.getByRole('link', { name: 'Open Practice preferences, Import a file tab' })
    );
    await screen.findByTestId('admin-preferences-view');
    expect(screen.getByRole('tab', { name: 'Import a file' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(
      await screen.findByRole('heading', { name: 'Import a preference file' })
    ).toBeInTheDocument();
  });

  it('opens on the usual tab with no tab named, and ignores one it does not know', async () => {
    asRole('admin');
    for (const path of [
      '/coaches/practice-preferences',
      '/coaches/practice-preferences?tab=bogus',
    ]) {
      const { unmount } = renderAt(path);
      await screen.findByTestId('admin-preferences-view');
      // The default fixtures hold one pending must, so the page opens on Pending musts.
      expect(screen.getByRole('tab', { name: /^Pending musts/ })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      expect(screen.getByRole('tab', { name: 'Import a file' })).toHaveAttribute(
        'aria-selected',
        'false'
      );
      unmount();
    }
  });

  it('can open on any of the four tabs', async () => {
    asRole('admin');
    for (const [tab, label] of [
      ['pending', /^Pending musts/],
      ['rules', 'Rules'],
      ['conflicts', /^Conflicts/],
      ['import', 'Import a file'],
    ]) {
      const { unmount } = renderAt(`/coaches/practice-preferences?tab=${tab}`);
      await screen.findByTestId('admin-preferences-view');
      expect(screen.getByRole('tab', { name: label })).toHaveAttribute('aria-selected', 'true');
      unmount();
    }
  });
});
