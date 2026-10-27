/**
 * Phase B5 (docs/changes/2026-10-22-phase-b-teaming.md): TeamBuilder reads the league's stored
 * `buddy_rule` through `useFeatures` and applies it to its "buddies met" tile and to its
 * auto-balance, matching names through the resolver as Team Analysis does. The organization's
 * stored flags are the input; the tile and the audited per-player moves are the output.
 */
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createChainMock } from './helpers/index.js';

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

// Two one-way requests, neither reciprocated: Bea names Cal plainly, and Gus names Zoë Müller
// in another form ("Last, First", no accents). Rated so that, dealt without buddies, each
// requester lands on the other team from the player named.
const PLAYERS = [
  player('cal', 'Cal', 'Three', 6),
  player('zoe', 'Zoë', 'Müller', 5),
  player('bea', 'Bea', 'Two', 4, { buddy_request: 'Cal Three' }),
  player('gus', 'Gus', 'Four', 3, { buddy_request: 'MULLER, zoe' }),
  player('p5', 'Pat', 'Five', 2),
  player('p6', 'Lou', 'Six', 1),
];

// Stable across renders, as the real hooks' state is.
const DIVISIONS = [{ id: DIVISION_ID, name: 'U10' }];
const ORGANIZATION = { id: ORG_ID };
const updateFeatureFlags = vi.fn();
const organization = { value: /** @type {any} */ (null) };
const TEAMS = [
  { id: 't1', name: 'Team One', division_id: DIVISION_ID, organization_id: ORG_ID },
  { id: 't2', name: 'Team Two', division_id: DIVISION_ID, organization_id: ORG_ID },
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

const BASE_FLAGS = { buddy_requests: true, player_rating: true, coaching_interest: false };

/**
 * Render, read the tile, run auto-balance, and return the team each player was moved to (`moves`
 * players are placed: the board's, which is every player unless the league shows divisions apart).
 */
async function balance(flags, moves = playersData.players.length) {
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
  const tile = (await screen.findByText('buddies met')).closest('.metric-tile');
  const tileText = tile?.textContent?.replace(/\s+/g, ' ').trim();
  fireEvent.click(screen.getByRole('button', { name: /auto-balance/i }));
  await waitFor(() => expect(mocks.updatePlayer).toHaveBeenCalledTimes(moves));
  const teamOf = Object.fromEntries(
    mocks.updatePlayer.mock.calls.map(([playerId, patch]) => [playerId, patch.team_id])
  );
  return { tileText, teamOf };
}

describe('TeamBuilder applies the stored buddy rule', () => {
  beforeEach(() => {
    Object.assign(playersData, { players: PLAYERS, divisions: DIVISIONS });
    world.teams = TEAMS;
    mocks.updatePlayer.mockReset().mockResolvedValue({ success: true });
    mocks.rpc.mockReset().mockResolvedValue({ data: null, error: null });
  });

  it('defaults to mutual: one-way requests are not honoured or counted', async () => {
    const { tileText, teamOf } = await balance({ ...BASE_FLAGS });
    expect(tileText).toBe('0/0 buddies met');
    expect(teamOf.bea).not.toBe(teamOf.cal);
    expect(teamOf.gus).not.toBe(teamOf.zoe);
  });

  it('a stored mutual reads the same as the default', async () => {
    const { tileText, teamOf } = await balance({ ...BASE_FLAGS, buddy_rule: 'mutual' });
    expect(tileText).toBe('0/0 buddies met');
    expect(teamOf.bea).not.toBe(teamOf.cal);
  });

  it('a stored one_way_best_effort honours both requests, the name variant included', async () => {
    const { tileText, teamOf } = await balance({
      ...BASE_FLAGS,
      buddy_rule: 'one_way_best_effort',
    });
    expect(tileText).toBe('0/2 buddies met');
    expect(teamOf.bea).toBe(teamOf.cal);
    expect(teamOf.gus).toBe(teamOf.zoe);
    expect(mocks.rpc).toHaveBeenCalledWith(
      'record_audit_event',
      expect.objectContaining({ p_action: 'teams.auto_balanced' })
    );
  });

  // Co-ed buddies (owner, 2026-10-27): "In a division that is co-ed, buddies can be boy/girl
  // (such as U4 in the sample set), but buddies aren't accepted for other gender-specific
  // divisions."
  const U10_BOYS_AND_GIRLS = {
    divisions: [
      { id: 'd-u10b', name: 'U10B' },
      { id: 'd-u10g', name: 'U10G' },
    ],
    // Ann (a boy, U10B) and Bo (a girl, U10G) name each other. Rated so that, dealt without
    // the pair, they land on different teams (ann 5, bo 4: a serpentine deal).
    players: [
      player('ann', 'Ann', 'Ross', 5, { division_id: 'd-u10b', buddy_request: 'Bo Hale' }),
      player('bo', 'Bo', 'Hale', 4, { division_id: 'd-u10g', buddy_request: 'Ann Ross' }),
      player('kit', 'Kit', 'Lane', 3, { division_id: 'd-u10b' }),
      player('max', 'Max', 'Dorn', 1, { division_id: 'd-u10g' }),
    ],
  };
  const U10_TEAMS = [
    { id: 't1', name: 'Team One', division_id: 'd-u10b', organization_id: ORG_ID },
    { id: 't2', name: 'Team Two', division_id: 'd-u10g', organization_id: ORG_ID },
  ];

  it('a co-ed board folding two divisions pairs a boy and a girl who name each other', async () => {
    Object.assign(playersData, U10_BOYS_AND_GIRLS);
    world.teams = U10_TEAMS;
    const { tileText, teamOf } = await balance({ ...BASE_FLAGS, gender_model: 'coed' });
    expect(tileText).toBe('0/2 buddies met');
    expect(teamOf.ann).toBe(teamOf.bo);
    // The pair is one unit: the other two are not dealt with them.
    expect(teamOf.kit).toBe(teamOf.max);
    expect(teamOf.kit).not.toBe(teamOf.ann);
  });

  it('two gender-specific divisions shown separately pair nobody across them', async () => {
    // The same league under the Boys / Girls model: U10B is its own board, so Ann's request
    // names someone on another board and nothing is paired or counted.
    Object.assign(playersData, U10_BOYS_AND_GIRLS);
    world.teams = U10_TEAMS;
    const { tileText, teamOf } = await balance({ ...BASE_FLAGS, gender_model: 'split' }, 2);
    expect(tileText).toBe('0/0 buddies met');
    expect(Object.keys(teamOf).sort()).toEqual(['ann', 'kit']);
  });

  it('a single co-ed division (U4) pairs a boy and a girl who name each other', async () => {
    Object.assign(playersData, {
      divisions: [{ id: 'd-u4', name: 'U4' }],
      players: [
        player('ann', 'Ann', 'Ross', 5, {
          division_id: 'd-u4',
          gender: 'm',
          buddy_request: 'Bo Hale',
        }),
        player('bo', 'Bo', 'Hale', 4, {
          division_id: 'd-u4',
          gender: 'f',
          buddy_request: 'Ann Ross',
        }),
        player('kit', 'Kit', 'Lane', 3, { division_id: 'd-u4', gender: 'm' }),
        player('max', 'Max', 'Dorn', 1, { division_id: 'd-u4', gender: 'f' }),
      ],
    });
    world.teams = [
      { id: 't1', name: 'Team One', division_id: 'd-u4', organization_id: ORG_ID },
      { id: 't2', name: 'Team Two', division_id: 'd-u4', organization_id: ORG_ID },
    ];
    const { tileText, teamOf } = await balance({ ...BASE_FLAGS });
    expect(tileText).toBe('0/2 buddies met');
    expect(teamOf.ann).toBe(teamOf.bo);
  });
});
