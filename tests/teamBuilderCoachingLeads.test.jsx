/**
 * Phase B6 (docs/changes/2026-10-22-phase-b-teaming.md): TeamBuilder's auto-balance reads the
 * league's settings through `useFeatures` instead of its own toggles: coaching leads are spread
 * (one rule with the generator, `coachingLeads.js`) when Spread Coaching Leads and Coaching
 * Interest are on, the default. The organization's stored flags are the input; the audited
 * per-player moves are the output. The harness is `teamBuilderBuddyRule.test.jsx`'s.
 */
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createChainMock } from './helpers/index.js';
import { FeatureFlagSchema } from '../frontend/src/constants/featureFlags.js';

const ORG_ID = '3d0f4a1e-6b2c-4e8d-9a7f-1c2b3d4e5f60';
const DIVISION_ID = 'd-u10';

const mocks = vi.hoisted(() => ({
  updatePlayer: vi.fn(),
  rpc: vi.fn(),
}));

/** @returns {any} */
const player = (id, first, last, rating, overrides = {}) => ({
  id,
  organization_id: '3d0f4a1e-6b2c-4e8d-9a7f-1c2b3d4e5f60',
  division_id: 'd-u10',
  first_name: first,
  last_name: last,
  rating,
  status: 'active',
  team_id: null,
  ...overrides,
});

// One experienced player and three coaching leads, all rookies. Dealt by experience alone, the
// experienced player takes one team and the three leads split two and one over the others.
const PLAYERS = [
  player('vet', 'Val', 'Eight', null, { years_played: 8 }),
  player('l1', 'Lee', 'One', null, { years_played: 0, willing_to_coach: true }),
  player('l2', 'Lou', 'Two', null, { years_played: 0, willing_to_coach: true }),
  player('l3', 'Liv', 'Three', null, { years_played: 0, willing_to_coach: true }),
];

// Stable across renders, as the real hooks' state is.
const DIVISIONS = [{ id: DIVISION_ID, name: 'U10' }];
const ORGANIZATION = { id: ORG_ID };
const updateFeatureFlags = vi.fn();
const organization = { value: /** @type {any} */ (null) };
const TEAMS = [
  { id: 't1', name: 'Team One', division_id: DIVISION_ID, organization_id: ORG_ID },
  { id: 't2', name: 'Team Two', division_id: DIVISION_ID, organization_id: ORG_ID },
  { id: 't3', name: 'Team Three', division_id: DIVISION_ID, organization_id: ORG_ID },
];
const world = { teams: TEAMS };
const playersData = {
  players: PLAYERS,
  divisions: DIVISIONS,
  loading: false,
  updatePlayer: (...args) => mocks.updatePlayer(...args),
};

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => organization.value,
}));

vi.mock('../frontend/src/hooks/usePlayersData.js', () => ({
  usePlayersData: () => playersData,
}));

const toast = vi.fn();
vi.mock('../frontend/src/components/ui/ToastHost.jsx', () => ({
  __esModule: true,
  default: ({ children }) => children,
  useToast: () => toast,
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => {
  return {
    supabase: {
      rpc: (...args) => mocks.rpc(...args),
      from: (table) =>
        createChainMock({
          data: table === 'teams' ? world.teams : [],
          error: null,
        }),
    },
  };
});

const { default: TeamBuilderPage } = await import('../frontend/src/pages/TeamBuilderPage.jsx');

/** Render, run auto-balance, and return the leads on each team (sorted) and the toolbar. */
async function balance(flags) {
  organization.value = {
    currentOrganization: ORGANIZATION,
    featureFlags: flags,
    updateFeatureFlags,
    loading: false,
  };
  render(
    <MemoryRouter initialEntries={['/teams/builder']}>
      <TeamBuilderPage />
    </MemoryRouter>
  );
  await screen.findByRole('button', { name: /auto-balance/i });
  const toolbar = screen.getByLabelText('Division').parentElement?.textContent ?? '';
  fireEvent.click(screen.getByRole('button', { name: /auto-balance/i }));
  await waitFor(() => expect(mocks.updatePlayer).toHaveBeenCalledTimes(playersData.players.length));
  const teamOf = Object.fromEntries(
    mocks.updatePlayer.mock.calls.map(([playerId, patch]) => [playerId, patch.team_id])
  );
  const leads = Object.fromEntries(TEAMS.map((team) => [team.id, 0]));
  for (const p of PLAYERS) if (p.willing_to_coach) leads[teamOf[p.id]] += 1;
  return { leads: Object.values(leads).sort(), teamOf, toolbar };
}

describe('TeamBuilder spreads coaching leads by the league setting', () => {
  beforeEach(() => {
    world.teams = TEAMS;
    mocks.updatePlayer.mockReset().mockResolvedValue({ success: true });
    mocks.rpc.mockReset().mockResolvedValue({ data: null, error: null });
  });

  it('by default, spreads the leads one per team and says so', async () => {
    const { leads, toolbar } = await balance(FeatureFlagSchema.parse({}));
    expect(leads).toEqual([1, 1, 1]);
    expect(toolbar).toContain('Coaching leads: spread evenly');
    // The two toggles are gone: the league's settings decide.
    expect(screen.queryByLabelText('Spread coach parents')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Keep buddies together')).not.toBeInTheDocument();
    // The audit row says which settings the deal used.
    expect(mocks.rpc).toHaveBeenCalledWith(
      'record_audit_event',
      expect.objectContaining({
        p_action: 'teams.auto_balanced',
        p_metadata: expect.objectContaining({
          buddy_requests: true,
          buddy_rule: 'mutual',
          spread_coaching_leads: true,
        }),
      })
    );
    // Each lead is marked on the board.
    expect(screen.getAllByTitle('Coaching lead: a parent volunteers to coach')).toHaveLength(3);
  });

  it('with the setting stored off, deals the leads as ordinary players', async () => {
    const { leads, toolbar } = await balance(
      FeatureFlagSchema.parse({ teaming_spread_coaching_leads: false })
    );
    expect(leads).toEqual([0, 1, 2]);
    expect(toolbar).toContain('Coaching leads: not spread');
  });

  it('with Coaching Interest off, does not spread them either', async () => {
    const { leads, toolbar } = await balance(FeatureFlagSchema.parse({ coaching_interest: false }));
    expect(leads).toEqual([0, 1, 2]);
    expect(toolbar).not.toContain('Coaching leads');
  });
});
