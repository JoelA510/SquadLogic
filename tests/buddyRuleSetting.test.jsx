/**
 * The league's buddy rule (`buddy_rule`, Phase B1): a string setting added the way
 * `gender_model` is. The schema keeps exactly `mutual` and `one_way_best_effort`, the
 * default is `mutual`, the feature settings page offers a selector, and a stored value reads
 * back as itself through the settings page and through OrganizationContext's audited
 * persistence path (`update_org_feature_flags`).
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUDDY_RULE_KEY,
  BUDDY_RULE_OPTIONS,
  FEATURE_DEFAULTS,
  FeatureFlagSchema,
} from '../frontend/src/constants/featureFlags.js';
import { BUDDY_RULES } from '../packages/core/src/buddyLinking.js';
import { createChainMock } from './helpers/index.js';

const mocks = vi.hoisted(() => ({
  user: /** @type {any} */ (null),
  rpc: vi.fn(),
  storedFlags: /** @type {any} */ ({}),
}));

vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ user: mocks.user, isImpersonating: false }),
}));

const ORG_ID = '7c1d2e3f-4a5b-4c6d-8e7f-901a2b3c4d5e';

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    rpc: (...args) => mocks.rpc(...args),
    from: (table) => {
      if (table === 'organization_members') {
        return createChainMock({
          data: [
            {
              organization_id: ORG_ID,
              role: 'admin',
              organizations: { id: ORG_ID, name: 'Test FC', feature_flags: mocks.storedFlags },
            },
          ],
          error: null,
        });
      }
      return createChainMock({ data: [], error: null });
    },
  },
}));

const { OrganizationProvider, useOrganization } =
  await import('../frontend/src/contexts/OrganizationContext.jsx');
const { useFeatures } = await import('../frontend/src/hooks/useFeatures.js');
const { default: FeatureFlagSettings } =
  await import('../frontend/src/components/settings/FeatureFlagSettings.jsx');

describe('FeatureFlagSchema: buddy_rule', () => {
  it('keeps each known rule as itself', () => {
    for (const rule of ['mutual', 'one_way_best_effort']) {
      expect(FeatureFlagSchema.parse({ buddy_rule: rule })).toEqual({ buddy_rule: rule });
    }
  });

  it('refuses any other value rather than coercing it', () => {
    for (const value of ['Mutual', 'one-way', 'one_way', ' mutual', '', true, false]) {
      expect(FeatureFlagSchema.parse({ buddy_rule: value, buddy_requests: true })).toEqual({
        buddy_requests: true,
      });
    }
  });

  it('defaults to mutual and offers exactly the core rules', () => {
    expect(FEATURE_DEFAULTS[BUDDY_RULE_KEY]).toBe('mutual');
    expect([...BUDDY_RULE_OPTIONS].sort()).toEqual(Object.values(BUDDY_RULES).sort());
  });
});

/** Shows what the app reads, and lets a test persist through the real context. */
function Probe({ onReady }) {
  const { buddyRule } = useFeatures();
  const organization = useOrganization();
  onReady(organization);
  return <output aria-label="buddy rule">{buddyRule}</output>;
}

function renderWithProvider(children) {
  return render(<OrganizationProvider>{children}</OrganizationProvider>);
}

describe('buddy_rule through OrganizationContext and the settings page', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.user = { id: 'user-1', email: 'admin@example.com' };
    mocks.rpc.mockReset();
    mocks.rpc.mockImplementation(async (name) =>
      name.startsWith('link_my_')
        ? { data: { status: 'no_match' }, error: null }
        : { data: null, error: null }
    );
  });

  afterEach(() => {
    mocks.storedFlags = {};
  });

  it('reads an absent setting as mutual', async () => {
    mocks.storedFlags = { buddy_requests: true };
    renderWithProvider(<Probe onReady={() => {}} />);
    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'buddy rule' })).toHaveTextContent('mutual')
    );
  });

  it('reads a stored one_way_best_effort back as itself, and persists a change through the audited RPC', async () => {
    mocks.storedFlags = { buddy_rule: 'one_way_best_effort' };
    /** @type {any} */
    let organization = null;
    renderWithProvider(
      <Probe
        onReady={(value) => {
          organization = value;
        }}
      />
    );
    const shown = () => screen.getByRole('status', { name: 'buddy rule' });
    await waitFor(() => expect(shown()).toHaveTextContent('one_way_best_effort'));

    let saved;
    await act(async () => {
      saved = await organization.updateFeatureFlags({ buddy_rule: 'mutual' });
    });
    expect(saved).toEqual({ success: true });
    expect(mocks.rpc).toHaveBeenCalledWith('update_org_feature_flags', {
      p_org_id: ORG_ID,
      p_flags: { buddy_rule: 'mutual' },
    });
    expect(shown()).toHaveTextContent(/^mutual$/);

    // A value outside the two is refused on the way out too: it never reaches the RPC.
    await act(async () => {
      await organization.updateFeatureFlags({ buddy_rule: 'sometimes', buddy_requests: true });
    });
    expect(mocks.rpc).toHaveBeenLastCalledWith('update_org_feature_flags', {
      p_org_id: ORG_ID,
      p_flags: { buddy_requests: true },
    });
  });

  it('shows the stored rule in the settings selector and saves a new choice, audited', async () => {
    mocks.storedFlags = { buddy_rule: 'one_way_best_effort' };
    renderWithProvider(<FeatureFlagSettings />);
    const select = await screen.findByRole('combobox', { name: 'Buddy rule' });
    await waitFor(() => expect(select).toHaveValue('one_way_best_effort'));
    expect(screen.getByText(/also placed together where the roster allows/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.change(select, { target: { value: 'mutual' } });
    });
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('update_org_feature_flags', {
        p_org_id: ORG_ID,
        p_flags: { buddy_rule: 'mutual' },
      })
    );
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith(
        'record_audit_event',
        expect.objectContaining({
          p_action: 'settings.flags_updated',
          p_metadata: expect.objectContaining({ flags: { buddy_rule: 'mutual' } }),
        })
      )
    );
    await waitFor(() => expect(select).toHaveValue('mutual'));
  });
});
