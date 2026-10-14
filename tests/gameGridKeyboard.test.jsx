/**
 * Plan item M4.3 on the real page: a game is moved with the keyboard alone,
 * through the page's own move handler, and focus follows it.
 *
 * `tests/GameCard.test.jsx` drives the grid's sensors and the "Move to"
 * control against a stand-in handler; this file mounts `GameSchedulingPage`
 * with its real grid and cards, so the control is proven to reach the page's
 * one move path (the one a drop takes) and to stage what a drop stages.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createChainMock } from './helpers/index.js';

const TABLES = vi.hoisted(() => ({
  fields: [
    { id: 'v1', name: 'North Field', location_id: 'loc-1', active: true },
    { id: 'v2', name: 'South Field', location_id: 'loc-1', active: true },
  ],
  game_slots: [
    {
      id: 'gs-1',
      field_id: 'v1',
      start: '2026-04-04T15:00:00Z',
      end: '2026-04-04T16:00:00Z',
      week_index: 1,
      capacity: 1,
    },
    {
      id: 'gs-2',
      field_id: 'v1',
      start: '2026-04-04T16:30:00Z',
      end: '2026-04-04T17:30:00Z',
      week_index: 1,
      capacity: 1,
    },
  ],
  locations: [{ id: 'loc-1', effective_to: null }],
}));

// One object for every render, as the real hook's state is: a fresh
// `assignments` array per render would re-run the page's sync effect forever.
const DASHBOARD = vi.hoisted(() => ({
  loading: { team: false, practice: false, game: false },
  error: null,
  errors: { team: null, practice: null, game: null },
  team: { teams: [] },
  practice: {},
  game: {
    summary: null,
    snapshot: null,
    warnings: [],
    generatedAt: '2026-04-01T00:00:00Z',
    runId: 'run-g',
    assignments: [
      {
        id: 'ga-1',
        slotId: 'gs-1',
        fieldId: 'v1',
        homeTeamId: 'lions',
        awayTeamId: 'bulls',
        start: '2026-04-04T15:00:00Z',
        end: '2026-04-04T16:00:00Z',
        division: 'U10',
        assignmentSource: 'auto',
      },
    ],
  },
}));

vi.mock('../frontend/src/hooks/useDashboardData.js', () => ({
  useDashboardData: () => DASHBOARD,
}));
const ORGANIZATION = vi.hoisted(() => ({
  currentOrganization: { id: 'org-1', name: 'Smoke FC' },
  currentSeasonSetting: { id: 'season-1', timezone: 'America/Los_Angeles' },
  featureFlags: {},
  permissions: ['manage_schedule'],
  loading: false,
  seasonSettingsLoading: false,
}));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ORGANIZATION,
}));
vi.mock('../frontend/src/hooks/useAutoRunOnNavigate.js', () => ({
  useAutoRunOnNavigate: () => {},
}));
vi.mock('../frontend/src/hooks/useFieldClosures.js', () => ({
  useFieldClosures: () => ({ closures: [], loading: false, error: null, refresh: () => {} }),
}));
vi.mock('../frontend/src/hooks/useFeatures.js', () => ({
  useFeatures: () => ({ genderModel: 'mixed', isEnabled: () => false }),
}));
vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    from: (table) => createChainMock({ data: TABLES[table] ?? [], error: null }),
    rpc: async () => ({ data: null, error: null }),
    auth: { getSession: async () => ({ data: { session: null }, error: null }) },
  },
}));

const { default: GameSchedulingPage } =
  await import('../frontend/src/pages/GameSchedulingPage.jsx');

async function renderEditableGrid() {
  render(
    <MemoryRouter>
      <GameSchedulingPage />
    </MemoryRouter>
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Enter Manual Override' }));
  // Meta-assertion: the real grid and the seeded game are on screen, so a
  // case below cannot pass over an empty page.
  await screen.findByTestId('game-schedule-grid');
  return screen.getByTestId('drop-zone-v1:gs-1');
}

describe('GameSchedulingPage :: a game moved with the keyboard (M4.3)', () => {
  it('stages the move through the page handler and keeps focus on the moved game', async () => {
    const from = await renderEditableGrid();
    expect(within(from).getByTestId('game-card-ga-1')).toBeInTheDocument();

    const select = within(from).getByRole('combobox', { name: /^Move lions vs bulls, now at/ });
    const target = [...select.querySelectorAll('option')].find((option) =>
      option.textContent.startsWith('South Field')
    );
    // The South Field cell at the first slot's time, offered by name.
    expect(target?.value).toBe('v2:gs-1');

    select.focus();
    fireEvent.change(select, { target: { value: target.value } });
    await act(async () => {
      fireEvent.click(within(from).getByRole('button', { name: 'Move' }));
    });

    const to = screen.getByTestId('drop-zone-v2:gs-1');
    expect(within(to).getByTestId('game-card-ga-1')).toBeInTheDocument();
    expect(within(from).queryByTestId('game-card-ga-1')).not.toBeInTheDocument();
    // What a drop stages: a manual move, waiting for Apply.
    expect(within(to).getByTestId('manual-badge')).toBeInTheDocument();
    expect(
      screen.getByText('Manual game move staged. Apply the schedule to persist it.')
    ).toBeInTheDocument();
    // Focus followed the game to its new cell instead of falling to the body.
    expect(
      within(to).getByRole('combobox', { name: /^Move lions vs bulls, now at South/ })
    ).toHaveFocus();
  });

  it('names the By Team buttons as a group, with no orphaned label', async () => {
    render(
      <MemoryRouter>
        <GameSchedulingPage />
      </MemoryRouter>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'By Team' }));
    const group = screen.getByRole('group', { name: 'Select Team' });
    const lions = within(group).getByRole('button', { name: 'lions' });
    expect(lions).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(lions);
    expect(within(group).getByRole('button', { name: 'lions' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(document.querySelector('label:not([for])')).toBeNull();
  });
});
