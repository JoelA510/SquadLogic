import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SeasonModule from '../frontend/src/components/settings/modules/SeasonModule.jsx';

const mocks = vi.hoisted(() => ({
  updateCurrentSeason: vi.fn(),
  updateTimezone: vi.fn(),
  rpc: vi.fn(),
  refetchOrgs: vi.fn(),
  /** Mutable so each test can pose a different season row. */
  org: {
    currentOrganization: { id: 'org-1' },
    currentSeasonSetting: { id: 'season-1', organization_id: 'org-1', timezone: null },
  },
  auth: { isImpersonating: false },
}));

vi.mock('../frontend/src/contexts/ThemeContext.jsx', () => ({
  useTheme: () => ({
    currentSeason: '2025',
    updateCurrentSeason: mocks.updateCurrentSeason,
    availableSeasons: ['2025', '2026'],
    timezone: 'America/Los_Angeles',
    updateTimezone: mocks.updateTimezone,
  }),
}));

vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({
    user: {
      id: 'user-1',
      email: 'admin@example.com',
      profile: { id: 'profile-1', organization_id: 'org-1' },
    },
    isImpersonating: mocks.auth.isImpersonating,
  }),
}));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: mocks.org.currentOrganization,
    currentSeasonSetting: mocks.org.currentSeasonSetting,
    refetchOrgs: mocks.refetchOrgs,
  }),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    rpc: mocks.rpc,
  },
}));

/** The control, by the accessible name the label gives it. */
function timezoneSelect() {
  return /** @type {HTMLSelectElement} */ (screen.getByLabelText('Timezone'));
}

describe('SeasonModule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rpc.mockResolvedValue({ error: null });
    mocks.auth.isImpersonating = false;
    mocks.org.currentOrganization = { id: 'org-1' };
    mocks.org.currentSeasonSetting = { id: 'season-1', organization_id: 'org-1', timezone: null };
  });

  it('exposes season format and quick-select choices with pressed state', () => {
    render(<SeasonModule />);

    const formatGroup = screen.getByRole('group', { name: 'Season Naming Format' });
    const singleYear = screen.getByRole('button', { name: /Single Year/ });
    const dualYear = screen.getByRole('button', { name: /Dual Year/ });

    expect(formatGroup).toContainElement(singleYear);
    expect(singleYear).toHaveAttribute('type', 'button');
    expect(singleYear).toHaveAttribute('aria-pressed', 'true');
    expect(dualYear).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(dualYear);

    expect(dualYear).toHaveAttribute('aria-pressed', 'true');
    expect(singleYear).toHaveAttribute('aria-pressed', 'false');

    const season2026 = screen.getByRole('button', { name: 'Select 2026 as current season' });
    expect(season2026).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(season2026);

    expect(season2026).toHaveAttribute('aria-pressed', 'true');
    expect(mocks.updateCurrentSeason).toHaveBeenCalledWith('2026');
  });
});

/**
 * The timezone control, rendered rather than read.
 *
 * `season_settings.timezone` holds **any** IANA name -- `initialize_new_tenant`
 * stores whatever the admin's browser reported and 20260913000000's backfill
 * copies `organizations.contact_info` verbatim -- while this select offered
 * five. A season on `Europe/London` rendered the control blank, and `!timezone`
 * is false so the "Not set" hint did not fire either: an empty select over a
 * season with a perfectly good clock.
 *
 * Read from the DOM, not from the source text. A source check ("does the file
 * mention an injected option") passes on an option rendered under a condition
 * that never fires, which is the shape this whole review is about.
 */
describe('SeasonModule timezone select: every stored zone renders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rpc.mockResolvedValue({ error: null });
    mocks.auth.isImpersonating = false;
    mocks.org.currentOrganization = { id: 'org-1' };
    mocks.org.currentSeasonSetting = { id: 'season-1', organization_id: 'org-1', timezone: null };
  });

  it('renders a zone the shortlist does not carry, and selects it', () => {
    mocks.org.currentSeasonSetting.timezone = 'Europe/London';
    render(<SeasonModule />);

    const select = timezoneSelect();
    // The defect, stated as the DOM: before the fix this was `''`, because the
    // browser cannot select a value no option carries.
    expect(select.value).toBe('Europe/London');
    expect(screen.getByRole('option', { name: 'Europe/London' })).toBeInTheDocument();
    // ...and the empty-state hint must NOT be offered for a season that has a
    // clock, which is the half `!timezone` already got right.
    expect(screen.queryByRole('option', { name: /Not set/ })).toBeNull();
  });

  it.each([
    ['Pacific/Chatham', 'a half-hour-offset zone'],
    ['Africa/Nairobi', 'a zone with no US shortlist entry'],
  ])('renders %s (%s)', (zone) => {
    mocks.org.currentSeasonSetting.timezone = zone;
    render(<SeasonModule />);
    expect(timezoneSelect().value).toBe(zone);
  });

  it('does not duplicate a zone the shortlist already carries', () => {
    mocks.org.currentSeasonSetting.timezone = 'America/Denver';
    render(<SeasonModule />);

    expect(timezoneSelect().value).toBe('America/Denver');
    const denver = screen
      .getAllByRole('option')
      .filter((option) => /** @type {HTMLOptionElement} */ (option).value === 'America/Denver');
    expect(denver).toHaveLength(1);
    // The friendly label wins over the bare IANA name for a listed zone.
    expect(denver[0]).toHaveTextContent('Mountain Time (US & Canada)');
  });

  it('still names the empty state for a season with no clock', () => {
    mocks.org.currentSeasonSetting.timezone = null;
    render(<SeasonModule />);

    expect(timezoneSelect().value).toBe('');
    expect(screen.getByRole('option', { name: /Not set/ })).toBeInTheDocument();
  });
});

/**
 * One audit row for one change.
 *
 * The RPC has audited since 20260913000000, and under impersonation this
 * control fired a second `record_audit_event` of the SAME action beside it --
 * two rows, neither complete. The client now sends the one fact the server
 * cannot derive and writes nothing itself.
 */
describe('SeasonModule timezone change: one writer, one audit row', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rpc.mockResolvedValue({ error: null });
    mocks.auth.isImpersonating = false;
    mocks.org.currentOrganization = { id: 'org-1' };
    mocks.org.currentSeasonSetting = {
      id: 'season-1',
      organization_id: 'org-1',
      timezone: 'UTC',
    };
  });

  it('calls only the writer RPC when the admin is acting as themselves', async () => {
    render(<SeasonModule />);
    fireEvent.change(timezoneSelect(), { target: { value: 'America/Chicago' } });
    await vi.waitFor(() => expect(mocks.refetchOrgs).toHaveBeenCalled());

    const names = mocks.rpc.mock.calls.map(([name]) => name);
    expect(names).toEqual(['admin_set_season_timezone']);
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({
      p_organization_id: 'org-1',
      p_season_settings_id: 'season-1',
      p_timezone: 'America/Chicago',
      p_actor_context: {},
    });
  });

  it('carries the impersonation target INTO the writer, not into a second row', async () => {
    mocks.auth.isImpersonating = true;
    render(<SeasonModule />);
    fireEvent.change(timezoneSelect(), { target: { value: 'America/Chicago' } });
    await vi.waitFor(() => expect(mocks.refetchOrgs).toHaveBeenCalled());

    const names = mocks.rpc.mock.calls.map(([name]) => name);
    // The defect, stated as a list: this used to be
    // ['admin_set_season_timezone', 'record_audit_event'].
    expect(names).toEqual(['admin_set_season_timezone']);
    expect(names).not.toContain('record_audit_event');
    expect(mocks.rpc.mock.calls[0][1].p_actor_context).toEqual({
      target_user_id: 'profile-1',
    });
  });

  it('does not refetch or audit anything when the writer refuses', async () => {
    mocks.rpc.mockResolvedValue({ error: { message: 'Unknown IANA timezone: Nope/Nowhere' } });
    mocks.auth.isImpersonating = true;
    render(<SeasonModule />);
    fireEvent.change(timezoneSelect(), { target: { value: 'America/Chicago' } });

    expect(await screen.findByRole('alert')).toHaveTextContent('Unknown IANA timezone');
    expect(mocks.refetchOrgs).not.toHaveBeenCalled();
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual(['admin_set_season_timezone']);
  });
});
