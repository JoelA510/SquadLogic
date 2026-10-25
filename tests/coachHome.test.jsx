// The coach's home, as a coach (plan docs/changes/2026-10-22-admin-focus.md,
// R6; migration 20261028010000), driven through the real page, hooks and the
// mock client's twin of the SQL: their teams, their own schedule (games and
// practices, from today, across every team they coach), and the teams and
// coaches of their divisions, names only. The expectations are enumerated from
// the seed below and the mock's base seed (Mock Coach leads Team A in U8 Coed;
// Team B there is Casey Rivera's; Tigers there has no coach), never from what
// the page rendered.
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedMockDb } from './helpers/seedMockDb.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

const mocks = vi.hoisted(() => ({
  impersonating: false,
  rpcFailures: /** @type {string[]} */ ([]),
}));

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...props }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  Navigate: ({ to }) => <div data-testid="navigate">{to}</div>,
  useLocation: () => ({ state: null }),
  useNavigate: () => vi.fn(),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return {
    supabase: {
      from: (table) => mockSupabase.from(table),
      rpc: (name, params) =>
        mocks.rpcFailures.includes(name)
          ? Promise.resolve({ data: null, error: { code: '500', message: `${name} failed` } })
          : mockSupabase.rpc(name, params),
    },
    supabaseReady: Promise.resolve(),
  };
});

vi.mock('../frontend/src/hooks/usePermission.js', () => ({
  usePermission: () => ({
    can: () => false,
    role: mocks.impersonating ? 'admin' : 'coach',
    PERMISSIONS: {},
  }),
}));

vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () =>
    mocks.impersonating
      ? {
          user: { id: 'mock-admin-id', profile: { id: 'mock-coach-id', role: 'coach' } },
          isImpersonating: true,
        }
      : { user: { id: 'mock-coach-id' }, isImpersonating: false },
}));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({ currentOrganization: { id: MOCK_ORG_ID }, featureFlags: {} }),
}));

vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn() },
}));

const { default: DashboardPage } = await import('../frontend/src/pages/DashboardPage.jsx');
const { default: MyTeamPage } = await import('../frontend/src/pages/MyTeamPage.jsx');
const { COACH_SCHEDULE_LIMIT } =
  await import('../frontend/src/components/coach/CoachScheduleCard.jsx');

const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/** Team A's future game, a past one, and a weekly practice from today for four weeks. */
function seedSchedule({ practiceWeeks = 4 } = {}) {
  const from = day(0);
  const until = day(practiceWeeks * 7 - 1);
  seedMockDb({
    game_slots: [
      {
        id: 'gs-future',
        organization_id: MOCK_ORG_ID,
        field_id: 'v1',
        slot_date: day(5),
        start_time: '10:00:00',
        end_time: '11:00:00',
      },
      {
        id: 'gs-past',
        organization_id: MOCK_ORG_ID,
        field_id: 'v1',
        slot_date: day(-10),
        start_time: '09:00:00',
        end_time: '10:00:00',
      },
    ],
    games: [
      {
        id: 'game-future',
        organization_id: MOCK_ORG_ID,
        home_team_id: 't2',
        away_team_id: 't1',
        game_slot_id: 'gs-future',
      },
      {
        id: 'game-past',
        organization_id: MOCK_ORG_ID,
        home_team_id: 't1',
        away_team_id: 't2',
        game_slot_id: 'gs-past',
      },
    ],
    practice_slots: [
      {
        id: 'ps-coach',
        organization_id: MOCK_ORG_ID,
        field_id: 'v1',
        day_of_week: 'thu',
        start_time: '17:30',
        end_time: '18:30',
        valid_from: from,
        valid_until: until,
      },
    ],
    practice_assignments: [
      {
        id: 'pa-coach',
        organization_id: MOCK_ORG_ID,
        team_id: 't1',
        slot_id: 'ps-coach',
        practice_slot_id: 'ps-coach',
        source: 'auto',
        effective_date_range: `[${from},${until}]`,
      },
    ],
    // A team and coach in U10 Girls, a division the coach coaches nothing in.
    teams: [
      { id: 't-u10', name: 'Comets', division_id: 'u10-div-id', organization_id: MOCK_ORG_ID },
    ],
    coaches: [
      { id: 'c-u10', organization_id: MOCK_ORG_ID, full_name: 'Uma Elsewhere', status: 'active' },
    ],
    team_coach_assignments: [
      {
        id: 'tca-u10',
        organization_id: MOCK_ORG_ID,
        team_id: 't-u10',
        coach_id: 'c-u10',
        role: 'lead',
        effective_from: '2026-01-01',
        effective_to: null,
        started_via: 'backfill',
      },
    ],
  });
}

const division = () => screen.getByRole('region', { name: 'Your division' });

beforeEach(() => {
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'mock-coach-id' } }));
  mocks.impersonating = false;
  mocks.rpcFailures = [];
});

afterEach(() => {
  sessionStorage.clear();
});

describe('the coach home', () => {
  it('lists the coach’s own games and practices from today, and none of the past', async () => {
    seedSchedule();
    render(<DashboardPage />);
    const events = await within(
      await screen.findByRole('region', { name: 'Your schedule' })
    ).findAllByTestId('coach-schedule-event');
    const texts = events.map((li) => li.textContent);
    // The future game (Team A away at Team B), named from Team A's side; the
    // base seed's two slotless Team A games are listed as not set yet.
    const games = texts.filter((t) => /^GameTeam A: vs Team B/.test(t));
    expect(games.filter((t) => t.includes('10:00 - 11:00'))).toHaveLength(1);
    expect(games.filter((t) => t.includes('Date and time not set yet'))).toHaveLength(2);
    expect(games).toHaveLength(3);
    expect(texts.some((t) => t.includes('09:00 - 10:00'))).toBe(false);
    // Four Thursdays in four weeks from today.
    expect(
      texts.filter((t) => /^PracticeTeam A: Practice/.test(t) && t.includes('17:30 - 18:30'))
    ).toHaveLength(4);
  });

  it('lists a game with no slot yet last, saying so, never as an invalid date', async () => {
    // The base seed's two Team A games have no slot.
    render(<DashboardPage />);
    const events = await within(
      await screen.findByRole('region', { name: 'Your schedule' })
    ).findAllByTestId('coach-schedule-event');
    expect(events.length).toBeGreaterThan(0);
    for (const li of events) {
      expect(li.textContent).not.toMatch(/Invalid Date|undefined/);
    }
    expect(events.at(-1).textContent).toContain('Date and time not set yet');
  });

  it('shows the next ten dated events and counts the rest, with a link to each team', async () => {
    seedSchedule({ practiceWeeks: 12 });
    render(<DashboardPage />);
    const region = await screen.findByRole('region', { name: 'Your schedule' });
    await within(region).findAllByTestId('coach-schedule-event');
    const dated = within(region)
      .getAllByTestId('coach-schedule-event')
      .filter((li) => !li.textContent.includes('not set yet'));
    expect(dated).toHaveLength(COACH_SCHEDULE_LIMIT);
    // 1 game and 12 practices are dated: 3 more than the ten shown.
    expect(within(region).getByText(/3 more later in the season/)).toBeInTheDocument();
    expect(within(region).getByRole('link', { name: 'Team A' })).toHaveAttribute(
      'href',
      '/team/t1'
    );
  });

  it('says the schedule could not be loaded when a read fails, not that there is none', async () => {
    seedSchedule();
    const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
    const realFrom = mockSupabase.from.bind(mockSupabase);
    const spy = vi.spyOn(mockSupabase, 'from').mockImplementation((table) =>
      table === 'practice_assignments'
        ? /** @type {any} */ ({
            select: () => ({
              eq: () => Promise.resolve({ data: null, error: { message: 'boom' } }),
            }),
          })
        : realFrom(table)
    );
    try {
      render(<DashboardPage />);
      expect(
        await screen.findByText('Your schedule could not be loaded. Try again shortly.')
      ).toBeInTheDocument();
      expect(screen.queryByText('No upcoming games or practices.')).not.toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it('lists a game between two of the coach’s teams once, named by both', async () => {
    seedSchedule();
    seedMockDb({
      team_coach_assignments: [
        {
          id: 'tca-tigers-too',
          organization_id: MOCK_ORG_ID,
          team_id: '00000000-0000-0000-0000-000000000001',
          coach_id: 'mock-coach-id',
          role: 'lead',
          effective_from: '2026-01-01',
          effective_to: null,
          started_via: 'backfill',
        },
      ],
      game_slots: [
        {
          id: 'gs-derby',
          organization_id: MOCK_ORG_ID,
          field_id: 'v1',
          slot_date: day(3),
          start_time: '08:00:00',
          end_time: '09:00:00',
        },
      ],
      games: [
        {
          id: 'game-derby',
          organization_id: MOCK_ORG_ID,
          home_team_id: 't1',
          away_team_id: '00000000-0000-0000-0000-000000000001',
          game_slot_id: 'gs-derby',
        },
      ],
    });
    render(<DashboardPage />);
    const events = await within(
      await screen.findByRole('region', { name: 'Your schedule' })
    ).findAllByTestId('coach-schedule-event');
    const derby = events.filter((li) => li.textContent.includes('08:00 - 09:00'));
    expect(derby).toHaveLength(1);
    expect(derby[0]).toHaveTextContent('Team A vs Tigers');
  });

  it('keeps the teams that loaded when one team’s schedule fails, and names that team', async () => {
    seedSchedule();
    seedMockDb({
      team_coach_assignments: [
        {
          id: 'tca-tigers-too',
          organization_id: MOCK_ORG_ID,
          team_id: '00000000-0000-0000-0000-000000000001',
          coach_id: 'mock-coach-id',
          role: 'lead',
          effective_from: '2026-01-01',
          effective_to: null,
          started_via: 'backfill',
        },
      ],
    });
    const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
    const realFrom = mockSupabase.from.bind(mockSupabase);
    const spy = vi.spyOn(mockSupabase, 'from').mockImplementation((table) => {
      const real = realFrom(table);
      if (table !== 'practice_assignments') return real;
      return /** @type {any} */ ({
        select: (...args) => {
          const chain = real.select(...args);
          return {
            eq: (column, value) =>
              String(value) === '00000000-0000-0000-0000-000000000001'
                ? Promise.resolve({ data: null, error: { message: 'boom' } })
                : chain.eq(column, value),
          };
        },
      });
    });
    try {
      render(<DashboardPage />);
      expect(
        await screen.findByText('The schedule of Tigers could not be loaded. Try again shortly.')
      ).toBeInTheDocument();
      const events = within(screen.getByRole('region', { name: 'Your schedule' })).getAllByTestId(
        'coach-schedule-event'
      );
      expect(events.some((li) => /^PracticeTeam A: Practice/.test(li.textContent))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('lists the teams of the coach’s division with their coaches, names only', async () => {
    seedSchedule();
    render(<DashboardPage />);
    const table = await within(
      await screen.findByRole('region', { name: 'Your division' })
    ).findByTestId('division-teams');
    expect(within(table).getByText('U8 Coed')).toBeInTheDocument();
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      'Team A (your team)Mock Coach',
      'Team BCasey Rivera',
      'TigersNo coach assigned',
    ]);
    // Nothing of U10 Girls, where the coach coaches nothing.
    expect(within(division()).queryByText('Comets')).not.toBeInTheDocument();
    expect(within(division()).queryByText('Uma Elsewhere')).not.toBeInTheDocument();
    // No contact detail anywhere on the home (the seed's coaches have emails and phones).
    expect(document.body.textContent).not.toMatch(/@|555-01/);
    expect(document.querySelector('a[href^="mailto:"], a[href^="tel:"]')).toBeNull();
  });

  it('says the division could not be loaded when its read fails', async () => {
    mocks.rpcFailures = ['get_my_division_teams'];
    render(<DashboardPage />);
    expect(
      await screen.findByText("Your division's teams could not be loaded. Try again shortly.")
    ).toBeInTheDocument();
  });

  it('in an admin’s role preview, reads the previewed coach’s division, not the admin’s', async () => {
    mocks.impersonating = true;
    sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'mock-admin-id' } }));
    render(<DashboardPage />);
    const table = await within(
      await screen.findByRole('region', { name: 'Your division' })
    ).findByTestId('division-teams');
    expect(
      within(table)
        .getByText(/\(your team\)/)
        .closest('tr')
    ).toHaveTextContent('Team A');
  });

  it('links to no admin page: no schedule pages, standings, scores or lighting', async () => {
    seedSchedule();
    render(<DashboardPage />);
    await within(await screen.findByRole('region', { name: 'Your schedule' })).findAllByTestId(
      'coach-schedule-event'
    );
    const hrefs = [...document.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    for (const admin of [
      '/schedule/practice',
      '/schedule/game',
      '/standings',
      '/scores',
      '/schedule/practice-lighting',
    ]) {
      expect(hrefs).not.toContain(admin);
    }
    expect(hrefs).toContain('/coaches/practice-preferences');
  });
});

describe('My Team', () => {
  it('takes a coach of one team to that team', async () => {
    render(<MyTeamPage />);
    expect(await screen.findByTestId('navigate')).toHaveTextContent('/team/t1');
  });

  it('takes a coach of several teams, or none, home', async () => {
    seedMockDb({
      team_coach_assignments: [
        {
          id: 'tca-tigers',
          organization_id: MOCK_ORG_ID,
          team_id: '00000000-0000-0000-0000-000000000001',
          coach_id: 'mock-coach-id',
          role: 'lead',
          effective_from: '2026-01-01',
          effective_to: null,
          started_via: 'backfill',
        },
      ],
    });
    const { unmount } = render(<MyTeamPage />);
    expect(await screen.findByTestId('navigate')).toHaveTextContent(/^\/$/);
    unmount();
    sessionStorage.setItem(
      '__MOCK_SESSION__',
      JSON.stringify({ user: { id: 'mock-outsider-id' } })
    );
    render(<MyTeamPage />);
    await waitFor(() => expect(screen.getByTestId('navigate')).toHaveTextContent(/^\/$/));
  });

  it('goes home when the coach’s teams cannot be read', async () => {
    mocks.rpcFailures = ['get_my_coached_team_ids'];
    render(<MyTeamPage />);
    expect(await screen.findByTestId('navigate')).toHaveTextContent(/^\/$/);
  });
});
