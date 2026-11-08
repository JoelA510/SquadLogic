/**
 * The capacity-versus-demand panel on the Practices page (schedule expansion, PR 13, task N1):
 * where it sits, and that it reads again whenever the page re-reads the season's saved practices.
 *
 * The harness is `practiceApplyTimeoutReread.test.jsx`'s: the real page, the real mock client, a
 * save stood in for with the error the real client throws at its deadline, and the save that
 * LANDED stood in for by writing its row while the page waits. Here the capacity panel is the real
 * one. What it shows after the save is the proof of the refresh: the panel's `Held` counts the
 * landed row only if it read again (lesson 97: a write that makes no new run leaves a read that is
 * not keyed to it stale).
 *
 * "Today" is a fake clock (the `Date` alone), so the seeded slots' dates are live.
 */
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedMockDb } from './helpers/seedMockDb.js';

const ORG = 'org-pcap';
const SEASON = 'season-pcap';
const RUN1 = '00000000-0000-4000-8000-000000000041';

const ROSTER = vi.hoisted(() => [
  { id: 'team-a', name: 'Synthetic Hawks', division: 'U10' },
  { id: 'team-b', name: 'Synthetic Owls', division: 'U10' },
  { id: 'team-d', name: 'Synthetic Wrens', division: 'U10' },
]);
const SAVE = vi.hoisted(() => ({ impl: /** @type {any} */ (null) }));

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase, supabaseReady: Promise.resolve() };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', async () => {
  const { ROLE_PERMISSIONS: perms, ROLES: roles } =
    await import('../frontend/src/constants/permissions.js');
  const value = {
    currentOrganization: { id: 'org-pcap', name: 'Synthetic FC' },
    currentSeasonSetting: {
      id: 'season-pcap',
      timezone: 'America/New_York',
      season_start: '2026-09-07',
      season_end: '2026-11-30',
    },
    featureFlags: {},
    permissions: perms[roles.ADMIN],
    loading: false,
    seasonSettingsLoading: false,
  };
  return { useOrganization: () => value };
});
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ session: null, user: { id: 'admin-pcap' } }),
}));
vi.mock('../frontend/src/hooks/useTeamSummary.js', () => {
  const value = {
    summary: { teams: ROSTER },
    loading: false,
    error: null,
    status: 'completed',
    progress: 100,
    generatedAt: '2026-09-01',
  };
  return { useTeamSummary: () => value };
});
vi.mock('../frontend/src/hooks/useGameSummary.js', () => ({
  useGameSummary: () => ({
    gameSummary: null,
    gameReadinessSnapshot: null,
    generatedAt: null,
    loading: false,
    error: null,
    runId: null,
  }),
}));
vi.mock('../frontend/src/hooks/useGameAssignments.js', () => ({
  useGameAssignments: () => ({ assignments: [], loading: false, error: null }),
}));
vi.mock('../frontend/src/hooks/useAutoScheduler.js', () => {
  const idle = {
    status: 'idle',
    result: null,
    progress: null,
    error: null,
    trigger: async () => {},
    cancel: () => {},
    reset: () => {},
  };
  return { useAutoScheduler: () => idle };
});
vi.mock('../frontend/src/hooks/useAutoRunOnNavigate.js', () => ({
  useAutoRunOnNavigate: () => {},
}));
vi.mock('../frontend/src/hooks/useFieldClosures.js', () => ({
  useFieldClosures: () => ({ closures: [], loading: false, error: null, refresh: () => {} }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), log: vi.fn(), info: vi.fn() },
}));
vi.mock('../frontend/src/components/PracticeOverridePanel.jsx', () => ({
  default: ({ onStageAssignment }) => (
    <button type="button" onClick={() => onStageAssignment('team-d', 'slot-fri')}>
      Stage Wrens
    </button>
  ),
}));
const stub = (name) => ({ default: () => <div data-testid={`stub-${name}`} /> });
vi.mock('../frontend/src/components/PracticeReadinessPanel.jsx', () => stub('readiness'));
vi.mock('../frontend/src/components/EvaluationPanel.jsx', () => stub('evaluation'));
vi.mock('../frontend/src/utils/practicePersistenceClient.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return { ...actual, persistPracticeScheduleReview: (...args) => SAVE.impl(...args) };
});

const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
const { default: PracticeSchedulingPage } =
  await import('../frontend/src/pages/PracticeSchedulingPage.jsx');
const { PERSISTENCE_TIMEOUT } = await import('../frontend/src/lib/persistenceRequest.js');

const SLOTS = [
  { id: 'slot-mon', day_of_week: 'mon', start_time: '17:00:00', end_time: '18:30:00' },
  { id: 'slot-tue', day_of_week: 'tue', start_time: '18:00:00', end_time: '19:00:00' },
  { id: 'slot-fri', day_of_week: 'fri', start_time: '17:00:00', end_time: '18:00:00' },
].map((s) => ({ ...s, capacity: 4, valid_from: '2026-09-07', valid_until: '2026-11-30' }));

const row = (id, team, slot) => ({
  id,
  team_id: team,
  practice_slot_id: slot,
  slot_id: slot,
  effective_date_range: '[2026-09-07,2026-12-01)',
  run_id: RUN1,
  source: 'auto',
  assigned_via: 'auto',
  organization_id: ORG,
});

function seed() {
  seedMockDb({
    scheduler_runs: [
      {
        id: RUN1,
        organization_id: ORG,
        run_type: 'practice',
        status: 'completed',
        completed_at: '2026-09-01T12:00:00Z',
        season_settings_id: SEASON,
        results: {},
      },
    ],
    divisions: [
      {
        id: 'div-pcap',
        organization_id: ORG,
        season_settings_id: SEASON,
        name: 'U10',
        practices_per_week: 1,
        practice_minutes: null,
      },
    ],
    teams: ROSTER.map((t) => ({
      id: t.id,
      name: t.name,
      organization_id: ORG,
      division_id: 'div-pcap',
    })),
    fields: [{ id: 'field-pcap', name: 'Field P', organization_id: ORG, location_id: 'loc-pcap' }],
    practice_slots: SLOTS.map((s) => ({ ...s, field_id: 'field-pcap', organization_id: ORG })),
    practice_assignments: [
      row('00000000-0000-4000-8000-0000000000a4', 'team-a', 'slot-mon'),
      row('00000000-0000-4000-8000-0000000000b4', 'team-b', 'slot-tue'),
    ],
  });
}

/** What the save leaves behind when it lands: Wrens' Friday practice. */
function landTheSave() {
  seedMockDb({
    practice_assignments: [row('00000000-0000-4000-8000-0000000000d4', 'team-d', 'slot-fri')],
  });
}

let divisionReads = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-05T17:00:00Z'));
  sessionStorage.clear();
  divisionReads = 0;
  const from = mockSupabase.from.bind(mockSupabase);
  vi.spyOn(mockSupabase, 'from').mockImplementation((table) => {
    if (table === 'divisions') divisionReads += 1;
    return from(table);
  });
  vi.spyOn(mockSupabase.auth, 'getSession').mockResolvedValue(
    /** @type {any} */ ({ data: { session: { access_token: 'token-pcap' } }, error: null })
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <PracticeSchedulingPage />
    </MemoryRouter>
  );

/** The U10 card's figures, by label. */
function u10() {
  const card = screen
    .getAllByTestId('capacity-row')
    .find((r) => r.querySelector('h3').textContent.trim() === 'U10');
  return Object.fromEntries(
    [...card.querySelectorAll('dl > div')].map((pair) => [
      pair.querySelector('dt').textContent.trim(),
      pair.querySelector('dd').textContent.replace(/\s+/g, ' ').trim(),
    ])
  );
}

describe('the capacity panel on the Practices page', () => {
  it('is at the top of the page, above the auto-scheduler, and reads the season’s teams, slots and saved practices', async () => {
    seed();
    renderPage();
    const panel = await screen.findByTestId('capacity-list');
    expect(panel).toBeInTheDocument();
    const heading = screen.getByRole('heading', {
      name: 'Before you run: slots against what each division needs',
    });
    const scheduler = await screen.findByRole('heading', { name: 'Intelligent Auto-Scheduler' });
    // The panel comes first in the page, not after the grid it informs.
    expect(
      heading.compareDocumentPosition(scheduler) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    // Three teams of one a week, two of them holding a practice; Friday is free.
    expect(u10()).toMatchObject({
      Teams: '3',
      'Wanted a week': '3',
      Held: '2',
      'Still needed': '1',
      'Slots it may use': '3 slots: Mon, Tue, Fri',
      // 12 places, two taken by the saved practices.
      'Room left': '10 of 12',
      'Verdict (upper bound)': '9 to spare',
    });
  });

  it('reads again after a save whose outcome is unknown, and shows the practice that landed', async () => {
    seed();
    SAVE.impl = async () => {
      landTheSave();
      throw Object.assign(
        new Error(
          'The practice schedule save did not answer within 160 seconds, so it is not known whether the changes were saved. Check the saved schedule before applying again.'
        ),
        { code: PERSISTENCE_TIMEOUT, status: null }
      );
    };
    renderPage();
    await screen.findByTestId('capacity-list');
    expect(u10().Held).toBe('2');
    const readsBefore = divisionReads;

    fireEvent.click(await screen.findByRole('button', { name: /enter manual override/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stage Wrens' }));
    const apply = await screen.findByRole('button', { name: /apply schedule/i });
    await waitFor(() => expect(apply).toBeEnabled());
    fireEvent.click(apply);

    // The page re-reads the season; the panel reads with it, and never serves the rows of before.
    await waitFor(() => expect(divisionReads).toBeGreaterThan(readsBefore));
    await waitFor(() => expect(u10().Held).toBe('3'));
    expect(u10()).toMatchObject({
      'Still needed': '0',
      'Room left': '9 of 12',
      'Verdict (upper bound)': '9 to spare',
    });
    const held = within(screen.getByTestId('capacity-total'))
      .getByText('Held')
      .closest('div')
      .querySelector('dd');
    expect(held.textContent).toBe('3');
  });
});
