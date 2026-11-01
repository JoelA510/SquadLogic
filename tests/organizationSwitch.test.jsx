/**
 * An admin in more than one organization (docs/changes/2026-10-27-admin-only.md, F5).
 *
 * The server has no "active organization": every policy and RPC takes the row's or the argument's
 * organization, so the app must always name the one the admin is working in. Three things are held
 * here:
 *   1. a switch moves every read to the new organization (the season read, and a page's own read);
 *   2. a redeemed invite lands in the redeemed organization, not the old one;
 *   3. every audit call from Account and Season settings names the ACTIVE organization, not
 *      `profiles.organization_id` (which is null on every production profile).
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORG_A = '11111111-1111-4111-8111-aaaaaaaaaaaa';
const ORG_B = '22222222-2222-4222-8222-bbbbbbbbbbbb';

const mocks = vi.hoisted(() => ({
  user: /** @type {any} */ (null),
  rpc: vi.fn(),
  seasonReads: /** @type {string[]} */ ([]),
  updatePassword: vi.fn(),
}));

vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ user: mocks.user, updatePassword: mocks.updatePassword }),
}));

vi.mock('../frontend/src/contexts/ThemeContext.jsx', () => ({
  useTheme: () => ({
    timezone: 'UTC',
    updateTimezone: vi.fn(),
  }),
}));

vi.mock('../frontend/src/components/settings/modules/ProgramsSection.jsx', () => ({
  default: () => null,
}));

vi.mock('../frontend/src/components/settings/modules/SeasonsSection.jsx', () => ({
  default: () => null,
}));

vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    setUser: vi.fn(),
    setDemoContext: vi.fn(),
  },
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => {
  const members = [
    {
      organization_id: '11111111-1111-4111-8111-aaaaaaaaaaaa',
      profile_id: 'admin-1',
      role: 'admin',
      organizations: { id: '11111111-1111-4111-8111-aaaaaaaaaaaa', name: 'Org A' },
    },
    {
      organization_id: '22222222-2222-4222-8222-bbbbbbbbbbbb',
      profile_id: 'admin-1',
      role: 'staff',
      organizations: { id: '22222222-2222-4222-8222-bbbbbbbbbbbb', name: 'Org B' },
    },
  ];
  return {
    supabase: {
      rpc: (name, params) => mocks.rpc(name, params),
      from: (table) => ({
        select: () => ({
          eq: (column, value) => {
            if (table === 'organization_members')
              return Promise.resolve({ data: members, error: null });
            // season_settings: eq('organization_id', id).order(...)
            mocks.seasonReads.push(String(value));
            return {
              order: () =>
                Promise.resolve({
                  data: [
                    {
                      id: `season-of-${value}`,
                      organization_id: value,
                      name: `Season of ${value}`,
                      status: 'active',
                      created_at: '2026-01-01T00:00:00Z',
                    },
                  ],
                  error: null,
                }),
            };
          },
        }),
      }),
    },
  };
});

const { OrganizationProvider, useOrganization } =
  await import('../frontend/src/contexts/OrganizationContext.jsx');
const { useFacilityPermits } = await import('../frontend/src/hooks/useFacilityPermits.js');

/** Mounts the real provider and returns a ref to what a page would read from it. */
/** @param {(value: any) => React.ReactNode} [extra] */
async function mountProvider(extra = () => null) {
  /** @type {{ current: any }} */
  const seen = { current: null };
  function Probe() {
    const value = useOrganization();
    React.useEffect(() => {
      seen.current = value;
    });
    return extra(value);
  }
  render(
    <OrganizationProvider>
      <Probe />
    </OrganizationProvider>
  );
  await waitFor(() => expect(seen.current?.loading).toBe(false));
  await waitFor(() => expect(seen.current?.seasonSettingsLoading).toBe(false));
  return seen;
}

beforeEach(() => {
  localStorage.clear();
  mocks.user = { id: 'admin-1', email: 'admin@example.test', profile: { organization_id: null } };
  mocks.seasonReads = [];
  mocks.rpc.mockReset();
  mocks.rpc.mockResolvedValue({ data: { permits: [], today: '2026-10-27' }, error: null });
});

afterEach(() => {
  localStorage.clear();
});

describe('an admin of two organizations switches between them', () => {
  it('lists both, starts in the first, and moves the season read, the role and the stored choice on a switch', async () => {
    const seen = await mountProvider();
    expect(seen.current.organizations.map((m) => m.organization_id)).toEqual([ORG_A, ORG_B]);
    expect(seen.current.currentOrganization.id).toBe(ORG_A);
    expect(seen.current.orgMember.role).toBe('admin');
    expect(seen.current.currentSeasonSetting.id).toBe(`season-of-${ORG_A}`);

    await act(async () => {
      await seen.current.switchOrganization(ORG_B);
    });
    expect(seen.current.currentOrganization.id).toBe(ORG_B);
    // The role is the membership's in THAT organization (staff here, an admin in the other).
    expect(seen.current.orgMember.role).toBe('staff');
    expect(seen.current.currentSeasonSetting.id).toBe(`season-of-${ORG_B}`);
    expect(mocks.seasonReads).toEqual([ORG_A, ORG_B]);
    expect(localStorage.getItem('squadlogic_active_org')).toBe(ORG_B);
  });

  it('carries the switched organization into a page read (the permits page’s)', async () => {
    function Reader() {
      useFacilityPermits();
      return null;
    }
    const seen = await mountProvider(() => <Reader />);
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('get_facility_permits', { p_organization_id: ORG_A })
    );

    await act(async () => {
      await seen.current.switchOrganization(ORG_B);
    });
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('get_facility_permits', { p_organization_id: ORG_B })
    );
    // And no read after the switch still names the old organization.
    const firstB = mocks.rpc.mock.calls.findIndex(
      ([, params]) => params?.p_organization_id === ORG_B
    );
    expect(
      mocks.rpc.mock.calls.slice(firstB).every(([, params]) => params.p_organization_id === ORG_B)
    ).toBe(true);
  });

  it('keeps the stored organization on a plain refetch', async () => {
    localStorage.setItem('squadlogic_active_org', ORG_B);
    const seen = await mountProvider();
    expect(seen.current.currentOrganization.id).toBe(ORG_B);
    await act(async () => {
      seen.current.refetchOrgs();
    });
    await waitFor(() => expect(seen.current.loading).toBe(false));
    expect(seen.current.currentOrganization.id).toBe(ORG_B);
  });

  it('lands in the redeemed organization when the refetch is given its id (an invite redeemed while in another)', async () => {
    const seen = await mountProvider();
    expect(seen.current.currentOrganization.id).toBe(ORG_A);

    await act(async () => {
      seen.current.refetchOrgs(ORG_B);
    });
    await waitFor(() => expect(seen.current.currentOrganization?.id).toBe(ORG_B));
    await waitFor(() => expect(seen.current.currentSeasonSetting?.id).toBe(`season-of-${ORG_B}`));
    expect(localStorage.getItem('squadlogic_active_org')).toBe(ORG_B);
  });

  it('ignores a refetch handed something that is not an id (a click event)', async () => {
    const seen = await mountProvider();
    await act(async () => {
      seen.current.refetchOrgs({ type: 'click' });
    });
    await waitFor(() => expect(seen.current.loading).toBe(false));
    expect(seen.current.currentOrganization.id).toBe(ORG_A);
    expect(localStorage.getItem('squadlogic_active_org')).toBe(ORG_A);
  });
});

describe('audit calls name the active organization, never the profile’s', () => {
  // `profiles.organization_id` is null on every production profile (checked read-only), so an audit
  // addressed by it was skipped; for an admin of two it would name the wrong one at best.
  const PROFILE_ORG = '99999999-9999-4999-8999-999999999999';

  /** Renders `ui` inside the real provider, switched to Org B. */
  async function inOrgB(ui) {
    mocks.user = {
      id: 'admin-1',
      email: 'admin@example.test',
      profile: { id: 'admin-1', organization_id: PROFILE_ORG },
    };
    localStorage.setItem('squadlogic_active_org', ORG_B);
    render(<OrganizationProvider>{ui}</OrganizationProvider>);
    await screen.findByTestId('ready');
  }

  function Ready({ children }) {
    const { currentOrganization, seasonSettingsLoading } = useOrganization();
    return currentOrganization && !seasonSettingsLoading ? (
      <div data-testid="ready">{children}</div>
    ) : null;
  }

  it('Season settings: the season format buttons audit Org B', async () => {
    const { default: SeasonModule } =
      await import('../frontend/src/components/settings/modules/SeasonModule.jsx');
    await inOrgB(
      <Ready>
        <SeasonModule />
      </Ready>
    );
    mocks.rpc.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /dual/i }));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith(
        'record_audit_event',
        expect.objectContaining({
          p_organization_id: ORG_B,
          p_action: 'settings.season_format_updated',
        })
      )
    );

    const audited = mocks.rpc.mock.calls.filter(([name]) => name === 'record_audit_event');
    expect(audited.length).toBeGreaterThanOrEqual(1);
    expect(audited.every(([, params]) => params.p_organization_id === ORG_B)).toBe(true);
    expect(audited.some(([, params]) => params.p_organization_id === PROFILE_ORG)).toBe(false);
  });

  it('Season settings: the timezone writer is addressed to Org B', async () => {
    const { default: SeasonModule } =
      await import('../frontend/src/components/settings/modules/SeasonModule.jsx');
    await inOrgB(
      <Ready>
        <SeasonModule />
      </Ready>
    );
    mocks.rpc.mockClear();
    fireEvent.change(screen.getByLabelText('Timezone'), { target: { value: 'America/Chicago' } });
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith(
        'admin_set_season_timezone',
        expect.objectContaining({
          p_organization_id: ORG_B,
          p_season_settings_id: `season-of-${ORG_B}`,
        })
      )
    );
  });

  it('Account settings: the password change is handed the active organization', async () => {
    mocks.updatePassword.mockResolvedValue({ error: null });
    const { default: AccountModule } =
      await import('../frontend/src/components/settings/modules/AccountModule.jsx');
    await inOrgB(
      <Ready>
        <AccountModule />
      </Ready>
    );
    fireEvent.change(screen.getByLabelText('New Password'), {
      target: { value: 'a-long-enough-password' },
    });
    fireEvent.change(screen.getByLabelText('Confirm New Password'), {
      target: { value: 'a-long-enough-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update Password' }));
    await waitFor(() =>
      expect(mocks.updatePassword).toHaveBeenCalledWith('a-long-enough-password', {
        organizationId: ORG_B,
      })
    );
    // One writer: the page does not audit a second time beside updatePassword.
    expect(mocks.rpc.mock.calls.filter(([name]) => name === 'record_audit_event')).toEqual([]);
  });
});
