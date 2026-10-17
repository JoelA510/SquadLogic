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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    {
      id: 'gs-3',
      field_id: 'v2',
      start: '2026-04-04T15:00:00Z',
      end: '2026-04-04T16:00:00Z',
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
      {
        id: 'ga-2',
        slotId: 'gs-2',
        fieldId: 'v1',
        homeTeamId: 'wolves',
        awayTeamId: 'comets',
        start: '2026-04-04T16:30:00Z',
        end: '2026-04-04T17:30:00Z',
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

/**
 * jsdom has no layout. The grid's geometry: a column per field (240px apart),
 * a row per slot in the page's order (120px apart), each card inset in its cell.
 */
const COLUMNS = { v1: 0, v2: 240 };
const ROWS = { 'gs-1': 0, 'gs-2': 120, 'gs-3': 240 };

function rectOf(element) {
  // The drag overlay starts where the game being dragged is (the only one
  // these cases drag): dnd-kit reads the overlay, not the card, while dragging.
  if (element.getAttribute?.('data-testid') === 'game-card-preview') {
    const dragged = document.querySelector('[data-testid="game-card-ga-1"]');
    return dragged ? rectOf(dragged) : rectOf(document.body);
  }
  const zone = element.closest?.('[data-testid^="drop-zone-"]');
  const [fieldId, slotId] = (zone?.getAttribute('data-testid') ?? '')
    .replace('drop-zone-', '')
    .split(':');
  const testId = element.getAttribute?.('data-testid') ?? '';
  let box = { left: 0, top: 0, width: 0, height: 0 };
  if (zone && testId.startsWith('drop-zone-')) {
    box = { left: COLUMNS[fieldId], top: ROWS[slotId], width: 200, height: 100 };
  } else if (zone && testId.startsWith('game-card-')) {
    box = { left: COLUMNS[fieldId] + 10, top: ROWS[slotId] + 24, width: 180, height: 60 };
  }
  return {
    ...box,
    x: box.left,
    y: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
    toJSON: () => box,
  };
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

/** Pick up a game from its grip, press `keys`, and drop it. */
async function keyboardDrag(matchup, keys) {
  const handle = screen.getByRole('button', { name: `Drag ${matchup}` });
  handle.focus();
  fireEvent.keyDown(handle, { code: 'Space' });
  await settle();
  for (const code of keys) {
    fireEvent.keyDown(handle, { code });
    await settle();
  }
  fireEvent.keyDown(handle, { code: 'Space' });
  await settle();
}

const STAGED = 'Manual game move staged. Apply the schedule to persist it.';

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
  let rectSpy;
  beforeEach(() => {
    rectSpy = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockImplementation(function boundingRect() {
        return rectOf(this);
      });
  });
  afterEach(() => rectSpy.mockRestore());

  it('stages a Move to through the page handler and keeps focus on the moved game', async () => {
    const from = await renderEditableGrid();
    expect(within(from).getByTestId('game-card-ga-1')).toBeInTheDocument();

    const select = within(from).getByRole('combobox', { name: /^Move lions vs bulls, now at/ });
    select.focus();
    fireEvent.focus(select);
    // The one empty booking: South Field's gs-3. North Field's gs-2 holds a
    // game, and the grid's cross cells (South Field at gs-1's time) are another
    // field's booking.
    const offered = [...select.querySelectorAll('option')].map((option) => option.value);
    expect(offered).toEqual(['', 'v2:gs-3']);
    const target = { value: 'v2:gs-3' };
    fireEvent.change(select, { target: { value: target.value } });
    await act(async () => {
      fireEvent.click(within(from).getByRole('button', { name: 'Move' }));
    });

    const to = screen.getByTestId('drop-zone-v2:gs-3');
    expect(within(to).getByTestId('game-card-ga-1')).toBeInTheDocument();
    expect(within(from).queryByTestId('game-card-ga-1')).not.toBeInTheDocument();
    // What a drop stages: a manual move, waiting for Apply.
    expect(within(to).getByTestId('manual-badge')).toBeInTheDocument();
    expect(screen.getByText(STAGED)).toBeInTheDocument();
    // Focus followed the game to its new cell instead of falling to the body.
    expect(
      within(to).getByRole('combobox', { name: /^Move lions vs bulls, now at South/ })
    ).toHaveFocus();
  });

  it('stages a keyboard drag through the same handler', async () => {
    await renderEditableGrid();
    await keyboardDrag('lions vs bulls', ['ArrowRight']);
    const to = screen.getByTestId('drop-zone-v2:gs-1');
    expect(within(to).getByTestId('game-card-ga-1')).toBeInTheDocument();
    expect(within(to).getByTestId('manual-badge')).toBeInTheDocument();
    expect(screen.getByText(STAGED)).toBeInTheDocument();
  });

  it('refuses a drop on a cell that already has a game, and says why', async () => {
    const from = await renderEditableGrid();
    // Down from gs-1 on North Field is gs-2, which holds wolves vs comets.
    await keyboardDrag('lions vs bulls', ['ArrowDown']);
    expect(within(from).getByTestId('game-card-ga-1')).toBeInTheDocument();
    const occupied = screen.getByTestId('drop-zone-v1:gs-2');
    expect(within(occupied).getByTestId('game-card-ga-2')).toBeInTheDocument();
    expect(within(occupied).queryByTestId('game-card-ga-1')).not.toBeInTheDocument();
    expect(
      screen.getByText('lions vs bulls was not moved: that slot already has wolves vs comets.')
    ).toBeInTheDocument();
    // The screen reader's announcement agrees with the status line.
    expect(
      screen.getByText(/^lions vs bulls was not moved: North Field, .+ already has a game\.$/)
    ).toBeInTheDocument();
  });

  it('stages nothing when a game is picked up and put back', async () => {
    const from = await renderEditableGrid();
    await keyboardDrag('lions vs bulls', []);
    expect(within(from).getByTestId('game-card-ga-1')).toBeInTheDocument();
    expect(within(from).queryByTestId('manual-badge')).not.toBeInTheDocument();
    expect(screen.queryByText(STAGED)).not.toBeInTheDocument();
  });

  it('tells the view tabs apart by selection state and an underline, not colour alone', async () => {
    render(
      <MemoryRouter>
        <GameSchedulingPage />
      </MemoryRouter>
    );
    const views = await screen.findByRole('tablist', { name: 'Game schedule views' });
    const full = within(views).getByRole('tab', { name: 'Full Schedule' });
    const byTeam = within(views).getByRole('tab', { name: 'By Team' });
    expect(full).toHaveAttribute('aria-selected', 'true');
    expect(byTeam).toHaveAttribute('aria-selected', 'false');
    // `.page-tab.active` is the underline (page.css); only the selected tab has it.
    expect(full).toHaveClass('page-tab', 'active');
    expect(byTeam).toHaveClass('page-tab');
    expect(byTeam).not.toHaveClass('active');
    // The selected tab controls the panel, which is named for it.
    const panel = screen.getByRole('tabpanel', { name: 'Full Schedule' });
    expect(full).toHaveAttribute('aria-controls', panel.id);
    expect(within(panel).getByTestId('game-schedule-list')).toBeInTheDocument();

    // Arrow keys move the selection (the primitive's roving tabindex).
    fireEvent.keyDown(views, { key: 'ArrowRight' });
    expect(within(views).getByRole('tab', { name: 'By Team' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByRole('tabpanel', { name: 'By Team' })).toBeInTheDocument();
  });

  it('names the By Team buttons as a group, with no orphaned label', async () => {
    render(
      <MemoryRouter>
        <GameSchedulingPage />
      </MemoryRouter>
    );
    fireEvent.click(await screen.findByRole('tab', { name: 'By Team' }));
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
