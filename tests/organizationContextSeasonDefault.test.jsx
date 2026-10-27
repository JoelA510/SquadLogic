import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Nothing is live before activation (Phase E1; plan docs/changes/2026-10-22-phase-e-seasons.md,
 * point 1 and point 7): the organization's current season is its one ACTIVE season, never the
 * newest row, a stored choice is an id in its own key, and a draft is shown only to an admin or
 * staff member who chose it. The first two cases below fail on the code before E1
 * (`OrganizationContext` ordered by created_at and fell back to `data[0]`, and matched a stored
 * value by name too).
 */
const mocks = vi.hoisted(() => ({ user: null, role: 'coach', seasons: [] }));

vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ user: mocks.user }),
}));

const ORG = 'org-1';
const OLD_ACTIVE = {
  id: 'season-active',
  organization_id: ORG,
  name: '2026 Season',
  status: 'active',
  created_at: '2026-01-01T00:00:00Z',
};
const NEW_DRAFT = {
  id: 'season-draft',
  organization_id: ORG,
  name: '2027 Season',
  status: 'draft',
  created_at: '2026-09-01T00:00:00Z',
};
const COMPLETED = {
  id: 'season-done',
  organization_id: ORG,
  name: '2025 Season',
  status: 'completed',
  created_at: '2025-01-01T00:00:00Z',
};

async function mount() {
  vi.resetModules();
  vi.doMock('../frontend/src/lib/supabaseClient.js', () => ({
    supabase: {
      rpc: vi.fn(async () => ({ data: { status: 'no_match' }, error: null })),
      from: (table) => ({
        select: () => ({
          eq: () => {
            if (table === 'organization_members') {
              return Promise.resolve({
                data: [
                  {
                    organization_id: ORG,
                    profile_id: 'user-1',
                    role: mocks.role,
                    organizations: { id: ORG, name: 'Org One' },
                  },
                ],
                error: null,
              });
            }
            // season_settings: eq('organization_id').order('created_at')
            return {
              order: () => Promise.resolve({ data: mocks.seasons, error: null }),
            };
          },
        }),
      }),
    },
  }));
  const { OrganizationProvider, useOrganization } =
    await import('../frontend/src/contexts/OrganizationContext.jsx');
  /** @type {{ current: any }} */
  const seen = { current: null };
  function Probe({ onValue }) {
    const value = useOrganization();
    React.useEffect(() => {
      onValue(value);
    });
    return null;
  }
  mocks.user = { id: 'user-1' };
  render(
    <OrganizationProvider>
      <Probe
        onValue={(value) => {
          seen.current = value;
        }}
      />
    </OrganizationProvider>
  );
  await waitFor(() => expect(seen.current?.seasonSettingsLoading).toBe(false));
  await waitFor(() => expect(seen.current?.currentOrganization?.id).toBe(ORG));
  return seen;
}

beforeEach(() => {
  localStorage.clear();
  mocks.role = 'coach';
  mocks.seasons = [NEW_DRAFT, OLD_ACTIVE, COMPLETED];
});

afterEach(() => {
  vi.doUnmock('../frontend/src/lib/supabaseClient.js');
  vi.restoreAllMocks();
});

describe('the current season (E1)', () => {
  it('is the active season, not the newest: a draft created later does not become current', async () => {
    mocks.role = 'admin';
    const seen = await mount();
    expect(seen.current.currentSeasonSetting.id).toBe('season-active');
  });

  it("is not chosen by a stored name that equals the draft's name (the legacy shared key)", async () => {
    mocks.role = 'admin';
    // The old key held a name and was shared with Settings > Season's free-text label.
    localStorage.setItem('squadlogic-current-season', '2027 Season');
    const seen = await mount();
    expect(seen.current.currentSeasonSetting.id).toBe('season-active');
  });

  it('honours a stored draft id for an admin', async () => {
    mocks.role = 'admin';
    localStorage.setItem('squadlogic-current-season-id', 'season-draft');
    const seen = await mount();
    expect(seen.current.currentSeasonSetting.id).toBe('season-draft');
  });

  it('honours a stored draft id for staff, who are admins here', async () => {
    mocks.role = 'staff';
    localStorage.setItem('squadlogic-current-season-id', 'season-draft');
    const seen = await mount();
    expect(seen.current.currentSeasonSetting.id).toBe('season-draft');
  });

  it('falls back to the active season for a coach whose stored id is a draft', async () => {
    mocks.role = 'coach';
    localStorage.setItem('squadlogic-current-season-id', 'season-draft');
    const seen = await mount();
    expect(seen.current.currentSeasonSetting.id).toBe('season-active');
  });

  it('lists the active season first, drafts for admins only', async () => {
    mocks.role = 'admin';
    let seen = await mount();
    expect(seen.current.availableSeasons.map((s) => s.id)).toEqual([
      'season-active',
      'season-draft',
      'season-done',
    ]);
    mocks.role = 'coach';
    seen = await mount();
    expect(seen.current.availableSeasons.map((s) => s.id)).toEqual([
      'season-active',
      'season-done',
    ]);
  });

  it('has no current season when the organization has none active, whatever else exists', async () => {
    mocks.role = 'admin';
    mocks.seasons = [NEW_DRAFT, COMPLETED];
    const seen = await mount();
    expect(seen.current.currentSeasonSetting).toBeNull();
  });

  it('switchSeason stores the id and never the name', async () => {
    mocks.role = 'admin';
    const seen = await mount();
    await act(async () => {
      seen.current.switchSeason(NEW_DRAFT);
    });
    expect(localStorage.getItem('squadlogic-current-season-id')).toBe('season-draft');
    expect(localStorage.getItem('squadlogic-current-season')).toBeNull();
    expect(seen.current.currentSeasonSetting.id).toBe('season-draft');
  });

  it('works when storage is unavailable: the active season is shown', async () => {
    mocks.role = 'admin';
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => {
      if (key === 'squadlogic-current-season-id') throw new Error('blocked');
      return null;
    });
    const seen = await mount();
    expect(seen.current.currentSeasonSetting.id).toBe('season-active');
    getItem.mockRestore();
  });
});
