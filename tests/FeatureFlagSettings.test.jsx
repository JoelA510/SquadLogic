import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import FeatureFlagSettings from '../frontend/src/components/settings/FeatureFlagSettings.jsx';
import FeaturesSetupPage from '../frontend/src/pages/FeaturesSetupPage.jsx';
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

  // E3c (owner, 2026-10-27): the skill tier is an option an admin turns on, at set-up or later in
  // Settings; both screens are this panel, drawn from the catalog.
  it('offers Skill Tier, off by default, and turns it on through the audited path', async () => {
    mocks.featureFlags = FeatureFlagSchema.parse({});
    render(<FeatureFlagSettings />);
    const tier = screen.getByRole('switch', { name: 'Skill Tier' });
    expect(tier).toHaveAttribute('aria-checked', 'false');
    // It adds a column, as Years Played and Player Rating do.
    expect(
      within(screen.getByText('Skill Tier').parentElement).getByText('Grid column')
    ).toBeInTheDocument();
    fireEvent.click(tier);
    await waitFor(() => expect(mocks.updateFeatureFlags).toHaveBeenCalled());
    expect(mocks.updateFeatureFlags.mock.calls[0][0]).toEqual({ skill_tier: true });
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith(
        'record_audit_event',
        expect.objectContaining({
          p_action: 'settings.flags_updated',
          p_metadata: expect.objectContaining({ flags: { skill_tier: true } }),
        })
      )
    );
  });

  it('shows Skill Tier on when stored on, and off again through the same switch', async () => {
    mocks.featureFlags = FeatureFlagSchema.parse({ skill_tier: true });
    render(<FeatureFlagSettings />);
    const tier = screen.getByRole('switch', { name: 'Skill Tier' });
    expect(tier).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(tier);
    await waitFor(() => expect(mocks.updateFeatureFlags).toHaveBeenCalled());
    expect(mocks.updateFeatureFlags.mock.calls[0][0]).toEqual({ skill_tier: false });
  });

  it('offers Skill Tier in the set-up step, "Choose your tools", too', () => {
    mocks.featureFlags = FeatureFlagSchema.parse({});
    render(
      <MemoryRouter>
        <FeaturesSetupPage />
      </MemoryRouter>
    );
    expect(screen.getByRole('heading', { name: 'Choose your tools' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Skill Tier' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
    // Years Played still starts on there.
    expect(screen.getByRole('switch', { name: 'Years Played' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  // Play-down (owner, 2026-11-03): off unless an admin turns it on, at set-up or later in Settings;
  // both screens are this panel, drawn from the catalog.
  it('offers Play-down, off by default, in plain words, and turns it on through the audited path', async () => {
    mocks.featureFlags = FeatureFlagSchema.parse({});
    render(<FeatureFlagSettings />);
    const playDown = screen.getByRole('switch', { name: 'Play-down' });
    expect(playDown).toHaveAttribute('aria-checked', 'false');
    // What turning it on does, and what it leaves alone, without refusal language.
    const card = screen.getByText('Play-down').parentElement;
    expect(card).toHaveTextContent('placed in their own age division unless this is on');
    expect(card).toHaveTextContent('play in the division they registered for');
    expect(card).toHaveTextContent('Teams already reviewed, published or locked are not changed');
    expect(card).not.toHaveTextContent(/not permitted|not allowed|refuse|blocked/i);
    // It adds no grid column.
    expect(within(card).queryByText('Grid column')).not.toBeInTheDocument();
    fireEvent.click(playDown);
    await waitFor(() => expect(mocks.updateFeatureFlags).toHaveBeenCalled());
    expect(mocks.updateFeatureFlags.mock.calls[0][0]).toEqual({ play_down: true });
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith(
        'record_audit_event',
        expect.objectContaining({
          p_action: 'settings.flags_updated',
          p_metadata: expect.objectContaining({ flags: { play_down: true } }),
        })
      )
    );
  });

  it('shows Play-down on when stored on, off again through the same switch, and off for a stored non-boolean', async () => {
    expect(FeatureFlagSchema.parse({ play_down: 'yes' })).toEqual({});
    mocks.featureFlags = FeatureFlagSchema.parse({ play_down: 'yes' });
    const { unmount } = render(<FeatureFlagSettings />);
    expect(screen.getByRole('switch', { name: 'Play-down' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
    unmount();

    mocks.featureFlags = FeatureFlagSchema.parse({ play_down: true });
    render(<FeatureFlagSettings />);
    const playDown = screen.getByRole('switch', { name: 'Play-down' });
    expect(playDown).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(playDown);
    await waitFor(() => expect(mocks.updateFeatureFlags).toHaveBeenCalled());
    expect(mocks.updateFeatureFlags.mock.calls[0][0]).toEqual({ play_down: false });
  });

  it('offers Play-down in the set-up step, "Choose your tools", too, off', () => {
    mocks.featureFlags = FeatureFlagSchema.parse({});
    render(
      <MemoryRouter>
        <FeaturesSetupPage />
      </MemoryRouter>
    );
    expect(screen.getByRole('switch', { name: 'Play-down' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
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
