/**
 * The Skill Tier option (E3c of docs/changes/2026-10-27-season-enrollment.md; owner, 2026-10-27):
 * a player's skill tier shows only when an admin turns it on, at set-up or later in Settings, and
 * then shows on the player page and as a column in the Players grid and the team roster. Years
 * played shows in the same three places by default, and stays out of them when it is turned off.
 *
 * Every page here reads the flags the way the app does: the stored flags through
 * `FeatureFlagSchema`, then `useFeatures` (defaults applied), then the page's own gate.
 */
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PlayersPage from '../frontend/src/pages/PlayersPage.jsx';
import PlayerRecordPage from '../frontend/src/pages/PlayerRecordPage.jsx';
import TeamRecordPage from '../frontend/src/pages/TeamRecordPage.jsx';
import {
  FEATURE_DEFAULTS,
  FEATURE_FLAGS,
  FeatureFlagSchema,
} from '../frontend/src/constants/featureFlags.js';
import { skillTierLabel, skillTierRank } from '../frontend/src/constants/skillTier.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

const mocks = vi.hoisted(() => ({
  /** The flags the organization has stored; a test sets what it turned on or off. */
  stored: /** @type {Record<string, unknown>} */ ({}),
  /** Every table the page read, in order. */
  reads: /** @type {string[]} */ ([]),
  /** What the `players` tier read answers with. */
  tierResult: /** @type {{ data: any, error: any }} */ ({ data: [], error: null }),
  tierIds: /** @type {string[]} */ ([]),
  playerRows: /** @type {any[]} */ ([]),
  portal: /** @type {any} */ (null),
}));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: MOCK_ORG_ID },
    currentSeasonSetting: { id: 'season-1', status: 'active' },
    featureFlags: FeatureFlagSchema.parse(mocks.stored),
    loading: false,
  }),
}));

vi.mock('../frontend/src/hooks/useDemo.js', () => ({
  useDemo: () => ({ isDemo: false, expiresAtMs: null }),
}));

vi.mock('../frontend/src/hooks/usePlayersData.js', () => ({
  usePlayersData: () => ({
    players: mocks.playerRows,
    divisions: [{ id: 'd1', name: 'U8B' }],
    loading: false,
    error: null,
    refetch: vi.fn(),
    updatePlayer: vi.fn(),
    bulkUpdatePlayers: vi.fn(),
    createPlayer: vi.fn(),
    deletePlayers: vi.fn(),
  }),
}));

vi.mock('../frontend/src/hooks/useTeamPortal.js', () => ({
  PRACTICE_CHANGES_UNREAD_TEXT: 'Practice changes',
  useTeamPortal: () => mocks.portal,
}));

vi.mock('../frontend/src/hooks/usePermission.js', () => ({
  usePermission: () => ({
    can: () => true,
    role: 'admin',
    PERMISSIONS: { MANAGE_ALL_TEAMS: 'manage_all_teams' },
  }),
}));

vi.mock('../frontend/src/components/ui/ToastHost.jsx', () => ({
  __esModule: true,
  default: ({ children }) => children,
  useToast: () => vi.fn(),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
    from: (table) => {
      mocks.reads.push(table);
      // The player page's reads end in `.limit()` or are awaited; the roster's tier read ends in
      // `.in()`. Each answers from the table it was asked of.
      const rows = table === 'players' ? mocks.playerRows : [];
      const builder = {
        select: () => builder,
        eq: () => builder,
        or: () => builder,
        order: () => builder,
        in: (_column, ids) => {
          mocks.tierIds = ids;
          return Promise.resolve(mocks.tierResult);
        },
        limit: () => Promise.resolve({ data: rows, error: null }),
        then: (resolve) => resolve({ data: rows, error: null }),
      };
      return builder;
    },
  },
}));

const PLAYERS = [
  {
    id: 'p1',
    first_name: 'Alex',
    last_name: 'Smith',
    gender: 'm',
    division_id: 'd1',
    status: 'active',
    years_played: 2,
    rating: 3,
    skill_tier: 'advanced',
    jersey_number: 7,
    willing_to_coach: false,
    buddy_request: null,
    organization_id: MOCK_ORG_ID,
  },
  {
    id: 'p2',
    first_name: 'Mia',
    last_name: 'Lopez',
    gender: 'f',
    division_id: 'd1',
    status: 'active',
    years_played: 0,
    rating: null,
    skill_tier: null,
    jersey_number: null,
    willing_to_coach: true,
    buddy_request: null,
    organization_id: MOCK_ORG_ID,
  },
];

beforeEach(() => {
  mocks.stored = {};
  mocks.reads = [];
  mocks.tierIds = [];
  mocks.tierResult = {
    data: [
      { id: 'p1', skill_tier: 'advanced' },
      { id: 'p2', skill_tier: null },
    ],
    error: null,
  };
  mocks.playerRows = PLAYERS.map((player) => ({ ...player }));
  mocks.portal = {
    loading: false,
    error: null,
    team: { id: 'team-1', name: 'Tigers', division: { name: 'U8B', season: {} } },
    roster: [
      { id: 'p1', first_name: 'Alex', last_name: 'Smith', years_played: 2, jersey_number: 7 },
      { id: 'p2', first_name: 'Mia', last_name: 'Lopez', years_played: null, jersey_number: null },
    ],
    rosterUnavailable: null,
    events: [],
    practiceChangesUnread: false,
  };
});

describe('the option itself', () => {
  it('is a boolean flag that starts off, kept by the schema and dropped when it is not a boolean', () => {
    expect(FEATURE_FLAGS.SKILL_TIER).toBe('skill_tier');
    // No default: absent is off. Years Played is the one that starts on.
    expect(Object.hasOwn(FEATURE_DEFAULTS, FEATURE_FLAGS.SKILL_TIER)).toBe(false);
    expect(FEATURE_DEFAULTS[FEATURE_FLAGS.YEARS_PLAYED]).toBe(true);
    expect(FeatureFlagSchema.parse({ skill_tier: true })).toEqual({ skill_tier: true });
    expect(FeatureFlagSchema.parse({ skill_tier: false })).toEqual({ skill_tier: false });
    expect(FeatureFlagSchema.parse({ skill_tier: 'yes' })).toEqual({});
  });

  it('names a tier, and puts the tiers in order', () => {
    expect(skillTierLabel('advanced')).toBe('Advanced');
    expect(skillTierLabel(' Novice ')).toBe('Novice');
    expect(skillTierLabel('gold')).toBeNull();
    expect(skillTierLabel(null)).toBeNull();
    expect(skillTierRank('novice')).toBeLessThan(skillTierRank('developing'));
    expect(skillTierRank('developing')).toBeLessThan(skillTierRank('advanced'));
    expect(skillTierRank(null)).toBe(-1);
  });
});

describe('the Players grid', () => {
  const renderGrid = () =>
    render(
      <MemoryRouter initialEntries={['/players']}>
        <PlayersPage />
      </MemoryRouter>
    );

  it('has no tier column until the option is on, and shows Years played by default', () => {
    renderGrid();
    expect(screen.getByText('Alex Smith')).toBeInTheDocument();
    expect(screen.getByText('Yrs')).toBeInTheDocument();
    expect(screen.queryByText('Tier')).not.toBeInTheDocument();
    // The tier is not on the page at all: not as a column, and not as a value.
    expect(screen.queryByText('Advanced')).not.toBeInTheDocument();
  });

  it('shows a Tier column, in words, with the option on', () => {
    mocks.stored = { skill_tier: true };
    renderGrid();
    expect(screen.getByText('Tier')).toBeInTheDocument();
    expect(screen.getByText('Advanced')).toBeInTheDocument();
    // A player with no tier shows a dash, not an invented one.
    expect(screen.getByText('Yrs')).toBeInTheDocument();
  });

  it('shows the tier column read-only: the admin RPCs take no tier', () => {
    mocks.stored = { skill_tier: true };
    renderGrid();
    // A cell of an editable column opens an editor on a double click (see the Buddy request cell
    // in PlayersPage.test.jsx); the tier cell opens none.
    fireEvent.doubleClick(screen.getByText('Advanced'));
    expect(screen.queryByRole('textbox', { name: 'Tier' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Tier' })).toBeNull();
    expect(screen.queryByRole('spinbutton', { name: 'Tier' })).toBeNull();
    // Control: a years cell does open its editor, so the double click above can open one.
    fireEvent.doubleClick(screen.getByText('2'));
    expect(screen.getByRole('spinbutton', { name: 'Yrs' })).toBeInTheDocument();
  });

  it('leaves Years played out when it is turned off, and the tier does not come back with it', () => {
    mocks.stored = { years_played: false, skill_tier: true };
    renderGrid();
    expect(screen.queryByText('Yrs')).not.toBeInTheDocument();
    expect(screen.getByText('Tier')).toBeInTheDocument();
  });
});

describe('the player page', () => {
  const renderPage = () =>
    render(
      <MemoryRouter initialEntries={['/players/p1']}>
        <Routes>
          <Route path="/players/:playerId" element={<PlayerRecordPage />} />
        </Routes>
      </MemoryRouter>
    );

  beforeEach(() => {
    // The page reads its player, divisions and teams from tables; one player.
    mocks.playerRows = [{ ...PLAYERS[0] }];
  });

  it('has no Skill tier field until the option is on, and shows Years played by default', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Alex Smith' });
    expect(screen.getByRole('button', { name: /^Edit Years played:/ })).toBeInTheDocument();
    expect(screen.queryByText('Skill tier')).not.toBeInTheDocument();
    expect(screen.queryByText('Advanced')).not.toBeInTheDocument();
  });

  it('shows the Skill tier, as a read-only field, with the option on', async () => {
    mocks.stored = { skill_tier: true };
    renderPage();
    await screen.findByRole('heading', { name: 'Alex Smith' });
    // Named by its content, with no "Edit": the field is shown, not edited here.
    expect(screen.getByRole('button', { name: 'Skill tier: Advanced' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit Skill tier/ })).not.toBeInTheDocument();
  });

  it('leaves Years played out when it is turned off', async () => {
    mocks.stored = { years_played: false, skill_tier: true };
    renderPage();
    await screen.findByRole('heading', { name: 'Alex Smith' });
    expect(screen.queryByText('Years played')).not.toBeInTheDocument();
    expect(screen.getByText('Skill tier')).toBeInTheDocument();
  });
});

describe('the team roster', () => {
  const openRoster = async () => {
    render(
      <MemoryRouter initialEntries={['/teams/team-1']}>
        <Routes>
          <Route path="/teams/:teamId" element={<TeamRecordPage />} />
        </Routes>
      </MemoryRouter>
    );
    fireEvent.click(await screen.findByRole('tab', { name: /Roster/ }));
  };

  it('shows Years played by default and reads no tier until the option is on', async () => {
    await openRoster();
    expect(await screen.findByTestId('roster-years-p1')).toHaveTextContent('Years played: 2');
    // A player with no years on file shows a dash.
    expect(screen.getByTestId('roster-years-p2')).toHaveTextContent('Years played: —');
    expect(screen.queryByTestId('roster-tier-p1')).not.toBeInTheDocument();
    // The tier is not even read: no request for players went out.
    expect(mocks.reads).not.toContain('players');
  });

  it('shows each player’s Skill tier, read for the roster’s players, with the option on', async () => {
    mocks.stored = { skill_tier: true };
    await openRoster();
    await waitFor(() =>
      expect(screen.getByTestId('roster-tier-p1')).toHaveTextContent('Skill tier: Advanced')
    );
    expect(screen.getByTestId('roster-tier-p2')).toHaveTextContent('Skill tier: —');
    expect(mocks.tierIds.sort()).toEqual(['p1', 'p2']);
    expect(screen.getByTestId('roster-years-p1')).toHaveTextContent('Years played: 2');
  });

  it('says so when the tiers cannot be read, and does not show the dash as an answer', async () => {
    mocks.stored = { skill_tier: true };
    mocks.tierResult = { data: null, error: { code: '500', message: 'down' } };
    await openRoster();
    await waitFor(() =>
      expect(screen.getByTestId('roster-tier-p1')).toHaveTextContent('Skill tier: Unavailable')
    );
  });

  it('leaves Years played out when it is turned off, and the tier stays', async () => {
    mocks.stored = { years_played: false, skill_tier: true };
    await openRoster();
    await waitFor(() => expect(screen.getByTestId('roster-tier-p1')).toBeInTheDocument());
    expect(screen.queryByTestId('roster-years-p1')).not.toBeInTheDocument();
  });
});
