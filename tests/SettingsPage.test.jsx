import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SettingsPage from '../frontend/src/pages/SettingsPage.jsx';

// Mocked like the sibling component tests: the real module starts the lazy
// mock-client import (`supabaseReady`) on load, and nothing here awaits it, so
// it can outlive this file's jsdom environment (EnvironmentTeardownError).
vi.mock('../frontend/src/lib/supabaseClient.js', () => ({ supabase: {} }));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    permissions: ['manage_global_settings', 'manage_organization'],
    currentOrganization: { id: 'org-1', name: 'North League' },
    currentSeasonSetting: { id: 'season-1', name: 'Spring 2026' },
  }),
}));

vi.mock('../frontend/src/components/settings/GeneralSettings.jsx', () => ({
  default: () => <div>General Settings Panel</div>,
}));

vi.mock('../frontend/src/components/settings/InvitesSettings.jsx', () => ({
  default: () => <div>Invites Settings Panel</div>,
}));

vi.mock('../frontend/src/components/settings/FeatureFlagSettings.jsx', () => ({
  default: () => <div>Feature Configuration Panel</div>,
}));

vi.mock('../frontend/src/components/settings/AuditLogSettings.jsx', () => ({
  default: () => <div>Audit Log Settings Panel</div>,
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <SettingsPage />
    </MemoryRouter>
  );
}

describe('SettingsPage', () => {
  it('exposes organization settings sections as keyboard-navigable tabs', () => {
    renderPage();

    const tablist = screen.getByRole('tablist', { name: 'Organization settings tabs' });
    const generalTab = screen.getByRole('tab', { name: 'General' });
    const invitesTab = screen.getByRole('tab', { name: 'Invites' });
    const featuresTab = screen.getByRole('tab', { name: 'Features' });
    const auditLogTab = screen.getByRole('tab', { name: 'Audit Log' });

    expect(tablist).toContainElement(generalTab);
    expect(generalTab).toHaveAttribute('type', 'button');
    expect(generalTab).toHaveAttribute('aria-selected', 'true');
    expect(invitesTab).toHaveAttribute('aria-selected', 'false');

    fireEvent.keyDown(tablist, { key: 'ArrowRight' });

    expect(invitesTab).toHaveAttribute('aria-selected', 'true');
    expect(invitesTab).toHaveFocus();

    fireEvent.keyDown(tablist, { key: 'End' });

    expect(auditLogTab).toHaveAttribute('aria-selected', 'true');
    expect(auditLogTab).toHaveFocus();
    expect(screen.getByRole('tabpanel', { name: 'Audit Log' })).toHaveTextContent(
      'Audit Log Settings Panel'
    );

    fireEvent.keyDown(tablist, { key: 'Home' });

    expect(generalTab).toHaveAttribute('aria-selected', 'true');
    expect(generalTab).toHaveFocus();

    fireEvent.keyDown(tablist, { key: 'ArrowLeft' });

    expect(auditLogTab).toHaveAttribute('aria-selected', 'true');
    expect(auditLogTab).toHaveFocus();

    fireEvent.keyDown(tablist, { key: 'ArrowRight' });

    expect(generalTab).toHaveAttribute('aria-selected', 'true');
    expect(generalTab).toHaveFocus();

    fireEvent.click(featuresTab);

    expect(featuresTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Features' })).toHaveTextContent(
      'Feature Configuration Panel'
    );
  });
});
