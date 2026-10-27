import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FeatureFlagSettings from '../frontend/src/components/settings/FeatureFlagSettings.jsx';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';
import { FeatureFlagSchema } from '../frontend/src/constants/featureFlags.js';

const mocks = vi.hoisted(() => ({
  updateFeatureFlags: vi.fn(),
  rpc: vi.fn(),
  teamsRows: [],
  featureFlags: {},
}));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    featureFlags: mocks.featureFlags,
    updateFeatureFlags: mocks.updateFeatureFlags,
    loading: false,
    currentOrganization: { id: MOCK_ORG_ID },
  }),
}));

vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({
    user: { id: 'user-1', profile: { id: 'profile-1' }, email: 'admin@example.com' },
    isImpersonating: false,
  }),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    rpc: mocks.rpc,
    from: () => ({
      select: () => ({
        eq: () => Promise.resolve({ data: mocks.teamsRows, error: null }),
      }),
    }),
  },
}));

describe('FeatureFlagSettings (FeatureControls)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.featureFlags = {};
    mocks.teamsRows = [];
    mocks.updateFeatureFlags.mockResolvedValue({ success: true });
    mocks.rpc.mockResolvedValue({ error: null });
  });

  it('renders the feature catalog with defaults (Years Played on, Rating off)', () => {
    render(<FeatureFlagSettings />);
    expect(screen.getByRole('switch', { name: 'Years Played' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('switch', { name: 'Player Rating' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
    expect(screen.getByRole('switch', { name: 'Waitlist' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('persists a toggle change through updateFeatureFlags and audits it', async () => {
    render(<FeatureFlagSettings />);
    fireEvent.click(screen.getByRole('switch', { name: 'Player Rating' }));
    await waitFor(() => expect(mocks.updateFeatureFlags).toHaveBeenCalled());
    expect(mocks.updateFeatureFlags.mock.calls[0][0]).toMatchObject({ player_rating: true });
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith(
        'record_audit_event',
        expect.objectContaining({ p_action: 'settings.flags_updated' })
      )
    );
  });

  it('switches the division format directly when no teams exist', async () => {
    render(<FeatureFlagSettings />);
    fireEvent.click(screen.getByRole('button', { name: /Co-ed \(combined\)/ }));
    await waitFor(() => expect(mocks.updateFeatureFlags).toHaveBeenCalled());
    expect(mocks.updateFeatureFlags.mock.calls[0][0]).toMatchObject({ gender_model: 'coed' });
  });

  it('prompts before switching format when teams already exist', async () => {
    mocks.teamsRows = [{ id: 'team-1' }];
    render(<FeatureFlagSettings />);
    // let the teamsExist effect resolve before interacting
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /Co-ed \(combined\)/ }));
    expect(screen.getByRole('dialog', { name: 'Switch to co-ed divisions' })).toBeInTheDocument();
    expect(mocks.updateFeatureFlags).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Future placements only' }));
    await waitFor(() => expect(mocks.updateFeatureFlags).toHaveBeenCalled());
    expect(mocks.updateFeatureFlags.mock.calls[0][0]).toMatchObject({ gender_model: 'coed' });
  });

  // Phase B6: the league's Spread Coaching Leads setting, on by default, read through the schema.
  it('offers Spread Coaching Leads, on by default, and turns it off through the audited path', async () => {
    mocks.featureFlags = FeatureFlagSchema.parse({});
    render(<FeatureFlagSettings />);
    const spread = screen.getByRole('switch', { name: 'Spread Coaching Leads' });
    expect(spread).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(spread);
    await waitFor(() => expect(mocks.updateFeatureFlags).toHaveBeenCalled());
    expect(mocks.updateFeatureFlags.mock.calls[0][0]).toEqual({
      teaming_spread_coaching_leads: false,
    });
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith(
        'record_audit_event',
        expect.objectContaining({
          p_action: 'settings.flags_updated',
          p_metadata: expect.objectContaining({ flags: { teaming_spread_coaching_leads: false } }),
        })
      )
    );
  });

  it('reads a stored-off Spread Coaching Leads as off, and the schema refuses a non-boolean', () => {
    expect(FeatureFlagSchema.parse({ teaming_spread_coaching_leads: 'no' })).toEqual({});
    mocks.featureFlags = FeatureFlagSchema.parse({ teaming_spread_coaching_leads: false });
    render(<FeatureFlagSettings />);
    expect(screen.getByRole('switch', { name: 'Spread Coaching Leads' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  // Owner, 2026-10-27: Spread Coaching Leads is shown but disabled, with the reason, while
  // Coaching Interest is off; its stored value is left as it was.
  describe('Spread Coaching Leads needs Coaching Interest', () => {
    const spreadSwitch = () => screen.getByRole('switch', { name: 'Spread Coaching Leads' });

    it('is disabled, shown (not hidden), with the reason visible and associated, while Coaching Interest is off', () => {
      mocks.featureFlags = FeatureFlagSchema.parse({ coaching_interest: false });
      render(<FeatureFlagSettings />);
      const spread = spreadSwitch();
      expect(spread).toBeDisabled();
      const reason = document.getElementById(spread.getAttribute('aria-describedby') ?? 'none');
      expect(reason).not.toBeNull();
      expect(reason).toBeVisible();
      expect(reason).toHaveTextContent(
        'Needs Coaching Interest turned on, so it has no effect now. Your setting here is kept.'
      );
      // Coaching Interest itself stays usable, and nothing else is described as needing it.
      expect(screen.getByRole('switch', { name: 'Coaching Interest' })).not.toBeDisabled();
      expect(screen.getByRole('switch', { name: 'Buddy Requests' })).not.toHaveAttribute(
        'aria-describedby'
      );
    });

    it('does not change the stored value: a click does nothing, and a stored on stays shown on', () => {
      mocks.featureFlags = FeatureFlagSchema.parse({
        coaching_interest: false,
        teaming_spread_coaching_leads: true,
      });
      render(<FeatureFlagSettings />);
      const spread = spreadSwitch();
      expect(spread).toHaveAttribute('aria-checked', 'true');
      fireEvent.click(spread);
      expect(mocks.updateFeatureFlags).not.toHaveBeenCalled();
    });

    it('turning Coaching Interest off writes that one flag only, and leaves the setting alone', async () => {
      mocks.featureFlags = FeatureFlagSchema.parse({ teaming_spread_coaching_leads: true });
      render(<FeatureFlagSettings />);
      expect(spreadSwitch()).not.toBeDisabled();
      expect(spreadSwitch()).not.toHaveAttribute('aria-describedby');
      fireEvent.click(screen.getByRole('switch', { name: 'Coaching Interest' }));
      await waitFor(() => expect(mocks.updateFeatureFlags).toHaveBeenCalled());
      expect(mocks.updateFeatureFlags.mock.calls[0][0]).toEqual({
        teaming_spread_coaching_leads: true,
        coaching_interest: false,
      });
    });

    it('is enabled again, and described no more, once Coaching Interest is on', () => {
      mocks.featureFlags = FeatureFlagSchema.parse({ coaching_interest: true });
      render(<FeatureFlagSettings />);
      expect(spreadSwitch()).not.toBeDisabled();
      expect(spreadSwitch()).not.toHaveAttribute('aria-describedby');
      expect(screen.queryByText(/Needs Coaching Interest turned on/)).not.toBeInTheDocument();
    });
  });

  it('keeps legacy advanced flags togglable', async () => {
    mocks.featureFlags = { advanced_fairness: true };
    render(<FeatureFlagSettings />);
    const fairness = screen.getByRole('switch', { name: 'Advanced Fairness Evaluation' });
    expect(fairness).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(fairness);
    await waitFor(() => expect(mocks.updateFeatureFlags).toHaveBeenCalled());
    expect(mocks.updateFeatureFlags.mock.calls[0][0]).toMatchObject({ advanced_fairness: false });
  });
});
