/**
 * After a practice save whose outcome is unknown (`PERSISTENCE_TIMEOUT`), the
 * practice page reads the season again (follow-up to M2.5, found in PR 2-C's
 * review: the page kept the schedule from before the save, so a save that
 * landed after the client gave up left stale UI, and the next run's locked set
 * was built from the old read).
 *
 * The harness is `gridLockedOverrideMessage.test.jsx`'s: the real page, the
 * real practice reads, the real mock client, the real grid. The save is the
 * client stood in for with the error the real client throws at the deadline
 * (`practicePersistenceClient.test.js` proves that shape); a save that LANDED
 * is stood in for by writing its row to the mock database while the page is
 * waiting. The re-read is shown by the grid: once the review is discarded, the
 * landed practice is listed only if the page read the season again.
 */

import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedMockDb } from './helpers/seedMockDb.js';

const ORG = 'org-ptimeout';
const SEASON = 'season-ptimeout';
const RUN1 = '00000000-0000-4000-8000-000000000031';

const ROSTER = vi.hoisted(() => [
  { id: 'team-a', name: 'Synthetic Hawks', division: 'U10' },
  { id: 'team-b', name: 'Synthetic Owls', division: 'U10' },
  // No saved practice: staging it replaces nothing, so no prompt opens.
  { id: 'team-d', name: 'Synthetic Wrens', division: 'U10' },
]);
/** What the stubbed save does, per test. */
const SAVE = vi.hoisted(() => ({ impl: /** @type {any} */ (null) }));

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase, supabaseReady: Promise.resolve() };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', async () => {
  const { ROLE_PERMISSIONS: perms, ROLES: roles } =
    await import('../frontend/src/constants/permissions.js');
  const value = {
    currentOrganization: { id: 'org-ptimeout', name: 'Synthetic FC' },
    currentSeasonSetting: { id: 'season-ptimeout', timezone: 'America/New_York' },
    featureFlags: {},
    permissions: perms[roles.ADMIN],
    loading: false,
    seasonSettingsLoading: false,
  };
  return { useOrganization: () => value };
});
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ session: null, user: { id: 'admin-ptimeout' } }),
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
// The override panel is stubbed: it stages one fixed (team, slot) through the
// page's own handler. The grid list is the real one.
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
const { PERSISTENCE_TIMEOUT, PERSISTENCE_UNREADABLE_RESPONSE } =
  await import('../frontend/src/lib/persistenceRequest.js');

const SLOTS = [
  { id: 'slot-mon', day_of_week: 'monday', start_time: '17:00:00', end_time: '18:30:00' },
  { id: 'slot-tue', day_of_week: 'tuesday', start_time: '18:00:00', end_time: '19:00:00' },
  { id: 'slot-fri', day_of_week: 'friday', start_time: '17:00:00', end_time: '18:00:00' },
].map((s) => ({ ...s, capacity: 4, valid_from: '2026-09-07', valid_until: '2026-11-30' }));

const row = (id, team, slot, source = 'auto') => ({
  id,
  team_id: team,
  practice_slot_id: slot,
  slot_id: slot,
  effective_date_range: '[2026-09-07,2026-12-01)',
  run_id: RUN1,
  source,
  assigned_via: source,
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
    divisions: [{ id: 'div-pt', organization_id: ORG, season_settings_id: SEASON, name: 'U10' }],
    teams: ROSTER.map((t) => ({
      id: t.id,
      name: t.name,
      organization_id: ORG,
      division_id: 'div-pt',
    })),
    fields: [{ id: 'field-pt', name: 'Field PT', organization_id: ORG, location_id: 'loc-pt' }],
    practice_slots: SLOTS.map((s) => ({ ...s, field_id: 'field-pt', organization_id: ORG })),
    practice_assignments: [
      row('00000000-0000-4000-8000-0000000000a3', 'team-a', 'slot-mon'),
      row('00000000-0000-4000-8000-0000000000b3', 'team-b', 'slot-tue', 'manual'),
    ],
  });
}

/** What the save leaves behind when it lands: Wrens' Friday practice. */
function landTheSave() {
  seedMockDb({
    practice_assignments: [row('00000000-0000-4000-8000-0000000000d3', 'team-d', 'slot-fri')],
  });
}

beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(mockSupabase.auth, 'getSession').mockResolvedValue(
    /** @type {any} */ ({ data: { session: { access_token: 'token-ptimeout' } }, error: null })
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Stage Synthetic Wrens onto Friday and Apply. */
async function stageAndApply(save) {
  SAVE.impl = save;
  seed();
  render(
    <MemoryRouter>
      <PracticeSchedulingPage />
    </MemoryRouter>
  );
  await waitFor(() => expect(screen.getAllByText('Synthetic Hawks').length).toBeGreaterThan(0));
  fireEvent.click(await screen.findByRole('button', { name: /enter manual override/i }));
  fireEvent.click(await screen.findByRole('button', { name: 'Stage Wrens' }));
  const apply = await screen.findByRole('button', { name: /apply schedule/i });
  await waitFor(() => expect(apply).toBeEnabled());
  fireEvent.click(apply);
}

const UNKNOWN_OUTCOMES = {
  // The two errors whose message says the outcome is not known (`persistenceRequest.js`).
  timeout: () =>
    Object.assign(
      new Error(
        'The practice schedule save did not answer within 160 seconds, so it is not known whether the changes were saved. Check the saved schedule before applying again.'
      ),
      { code: PERSISTENCE_TIMEOUT, status: null }
    ),
  'unreadable 2xx': () =>
    Object.assign(
      new Error(
        'The practice schedule save returned a response that could not be read (HTTP 200), so it is not known whether the changes were saved. Check the saved schedule before applying again.'
      ),
      { code: PERSISTENCE_UNREADABLE_RESPONSE, status: 200 }
    ),
};

describe('the practice page after a save whose outcome is unknown', () => {
  for (const [outcome, unknown] of Object.entries(UNKNOWN_OUTCOMES)) {
    it(`reads the season again, and lists the save that landed (${outcome})`, async () => {
      await stageAndApply(async () => {
        landTheSave();
        throw unknown();
      });
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'it is not known whether the changes were saved'
      );
      fireEvent.click(screen.getByRole('button', { name: /discard review/i }));
      await waitFor(() => expect(screen.getAllByText('Synthetic Wrens').length).toBeGreaterThan(0));
    });
  }

  it('control: after a refusal the page does not re-read, so a row written meanwhile is not listed', async () => {
    // The same landed row, but a refusal: its outcome is known, nothing is
    // re-read, and Wrens stays unlisted after Discard. This is what makes the
    // case above evidence of the re-read and not of some other source of the name.
    await stageAndApply(async () => {
      landTheSave();
      throw Object.assign(new Error('Access denied'), { code: null, status: 403 });
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Access denied');
    fireEvent.click(screen.getByRole('button', { name: /discard review/i }));
    await waitFor(() => expect(screen.getAllByText('Synthetic Hawks').length).toBeGreaterThan(0));
    // Give a re-read the chance to land before saying it did not.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryAllByText('Synthetic Wrens')).toHaveLength(0);
  });
});
