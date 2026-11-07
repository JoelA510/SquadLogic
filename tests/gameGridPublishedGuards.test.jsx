/**
 * PR 3 task C4 of the schedule expansion (docs/changes/2026-11-03-schedule-expansion.md, 3.3 and 3.6): the Games page
 * refuses to move or cancel a Published game, in the friendly half of the guard (the database refuses regardless, with
 * a trigger: supabase/tests/game_published.sql).
 *
 * - `moveGameTo` is the one handler a drop and the keyboard "Move to" both call. A Published game is refused with a
 *   sentence and nothing is staged. The card shows no grip and no "Move to" (tests/gameCardPublished.test.jsx), so on
 *   the real grid there is nothing to press; these tests reach the handler the way a stale card, a drop from another
 *   source, or a future control would, through the page's own `GameMoveContext` and its own `onDragEnd`.
 * - Cancel asks for "Allow changes" first. The list's cancel button is not reachable for any role today (the list is
 *   shown only when the grid is not, and the button only in edit mode, which opens the grid), so the handler's logic
 *   is a function of its own, `cancelGameAssignment`, driven directly; the page wires it to the same status line.
 *
 * Each refusal sits beside a control that the unpublished twin passes, so a guard that refused everything fails.
 * The plant of this PR "the guard removed from `moveGameTo`" turns the Published cases red.
 */
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG, SEASON, TZ, seedWorld } from './helpers/publishedGamesWorld.js';
import { cancelRefusal, moveRefusal } from '../frontend/src/utils/gamePublishedText.js';
import { publishedOmissions } from '../packages/core/src/gamePublished.js';
import { getMockData } from '../frontend/src/lib/mockSupabaseClient.js';

const ROLE = vi.hoisted(() => ({ value: /** @type {any} */ (null) }));
/** What the page handed `DndContext`, so a test can finish a drag the way the library does. */
const DND = vi.hoisted(() => ({ props: /** @type {any} */ (null) }));

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase: client } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: client, supabaseReady: Promise.resolve() };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ROLE.value,
}));
vi.mock('../frontend/src/hooks/useTeamSummary.js', async () => {
  const { ROSTER } = await import('./helpers/publishedGamesWorld.js');
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
vi.mock('../frontend/src/hooks/usePracticeSummary.js', () => ({
  usePracticeSummary: () => ({
    practiceSummary: null,
    practiceReadinessSnapshot: null,
    generatedAt: null,
    loading: false,
    error: null,
    runId: null,
    refetch: () => {},
  }),
}));
vi.mock('../frontend/src/hooks/useCurrentPracticeSchedule.js', () => ({
  useCurrentPracticeSchedule: () => ({
    assignments: [],
    loading: false,
    error: null,
    refetch: () => {},
  }),
}));
vi.mock('../frontend/src/hooks/useFieldClosures.js', () => ({
  useFieldClosures: () => ({ closures: [], loading: false, error: null, refresh: () => {} }),
}));
vi.mock('../frontend/src/hooks/useAutoRunOnNavigate.js', () => ({
  useAutoRunOnNavigate: () => {},
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), log: vi.fn(), info: vi.fn() },
}));
/** What the page handed the save, in order: the arguments of every `persistGameScheduleReview`. */
const SAVES = vi.hoisted(() => ({ calls: /** @type {any[]} */ ([]) }));
vi.mock('../frontend/src/utils/gamePersistenceClient.js', () => ({
  persistGameScheduleReview: async (args) => {
    SAVES.calls.push(args);
    return { runId: 'run-new' };
  },
}));
// The page's DndContext, recorded: `onDragEnd` is what the library calls when a drop lands.
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return {
    ...actual,
    DndContext: (props) => {
      DND.props = props;
      return <actual.DndContext {...props} />;
    },
  };
});
// A grid that offers the page's move handler as plain buttons, one per game and one per target cell: the same call the
// keyboard "Move to" makes (`GameMoveContext.moveGame`), with no card in between to hide the control.
vi.mock('../frontend/src/components/scheduling/GameScheduleGrid.jsx', async () => {
  const { GameMoveContext } = await import('../frontend/src/components/scheduling/GameCard.jsx');
  const React = await import('react');
  return {
    default: function StubGrid({ assignments }) {
      const move = React.useContext(GameMoveContext);
      return (
        <div data-testid="game-schedule-grid">
          {assignments.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => move.moveGame(String(a.id), 'f-north:gs-7', { focusMoved: false })}
            >
              keyboard-move {a.id}
            </button>
          ))}
        </div>
      );
    },
  };
});

const { default: GameSchedulingPage, cancelGameAssignment } =
  await import('../frontend/src/pages/GameSchedulingPage.jsx');
const { ROLE_PERMISSIONS, ROLES } = await import('../frontend/src/constants/permissions.js');

beforeEach(() => {
  sessionStorage.clear();
  DND.props = null;
  SAVES.calls.length = 0;
  ROLE.value = {
    currentOrganization: { id: ORG, name: 'Synthetic FC' },
    currentSeasonSetting: { id: SEASON, timezone: TZ, status: 'active' },
    featureFlags: {},
    permissions: ROLE_PERMISSIONS[ROLES.ADMIN],
    loading: false,
    seasonSettingsLoading: false,
  };
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function openGrid() {
  seedWorld();
  render(
    <MemoryRouter>
      <GameSchedulingPage />
    </MemoryRouter>
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Enter Manual Override' }));
  await screen.findByTestId('game-schedule-grid');
  await waitFor(() => expect(screen.getByText('keyboard-move ga-1')).toBeInTheDocument());
}

const statusLine = () => screen.getByText(/was not moved|was not cancelled|move staged/);
const stagedBanner = () => screen.queryByText(/staged for review/);

describe('a Published game is not moved by "Move to" (the keyboard path)', () => {
  it('is refused with the sentence, and nothing is staged', async () => {
    await openGrid();
    fireEvent.click(screen.getByText('keyboard-move ga-1'));
    expect(statusLine()).toHaveTextContent(
      'Synthetic Comets vs Synthetic Rockets was not moved: it is Published. Use Allow changes on it first.'
    );
    expect(stagedBanner()).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /apply schedule/i })).not.toBeInTheDocument();
  });

  it('control: a game that is not Published is staged to the same cell', async () => {
    await openGrid();
    fireEvent.click(screen.getByText('keyboard-move ga-2'));
    expect(await screen.findByText(/Manual game move staged/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /apply schedule/i })).toBeInTheDocument();
  });

  it('control: a game with changes allowed is staged, and the line says it will be a new game', async () => {
    await openGrid();
    fireEvent.click(screen.getByText('keyboard-move ga-3'));
    const line = await screen.findByText(/Manual game move staged/);
    expect(line).toHaveTextContent('will be saved as a new game, which starts not Published');
  });

  it('a game that is not Published moved plainly does not get that sentence (it has no history to leave behind)', async () => {
    await openGrid();
    fireEvent.click(screen.getByText('keyboard-move ga-2'));
    const line = await screen.findByText(/Manual game move staged/);
    expect(line).not.toHaveTextContent(/new game/);
  });
});

describe('a Published game is not moved by a drop (the pointer and keyboard-drag path)', () => {
  const drop = (id) =>
    act(() => {
      DND.props.onDragEnd({ active: { id }, over: { id: 'f-north:gs-7' } });
    });

  it('is refused with the same sentence and nothing is staged', async () => {
    await openGrid();
    drop('ga-5');
    expect(statusLine()).toHaveTextContent(
      'Synthetic Planets vs Synthetic Stars was not moved: it is Published. Use Allow changes on it first.'
    );
    expect(stagedBanner()).not.toBeInTheDocument();
  });

  it('control: the same drop of a game that is not Published is staged', async () => {
    await openGrid();
    drop('ga-4');
    expect(await screen.findByText(/Manual game move staged/)).toBeInTheDocument();
  });

  it('a Published game dropped back on its own cell is "put back", not a refusal (nothing was attempted)', async () => {
    await openGrid();
    act(() => {
      DND.props.onDragEnd({ active: { id: 'ga-1' }, over: { id: 'f-north:gs-1' } });
    });
    expect(screen.queryByText(/was not moved/)).not.toBeInTheDocument();
  });

  it('the refusal sentence is the one the helper writes', () => {
    expect(moveRefusal({ homeTeamName: 'A', awayTeamName: 'B' })).toBe(
      'A vs B was not moved: it is Published. Use Allow changes on it first.'
    );
  });
});

describe('cancel asks for "Allow changes" first', () => {
  const published = { id: 'ga-1', published: true, homeTeamName: 'A', awayTeamName: 'B' };
  const changesAllowed = {
    id: 'ga-3',
    published: false,
    publishedAt: '2026-10-01T00:00:00Z',
    homeTeamName: 'C',
    awayTeamName: 'D',
  };
  const plain = { id: 'ga-2', published: false, homeTeamName: 'E', awayTeamName: 'F' };

  function deps(overrides = {}) {
    return {
      confirm: vi.fn(() => true),
      rpc: vi.fn(async () => ({ error: null })),
      say: vi.fn(),
      fail: vi.fn(),
      onCancelled: vi.fn(),
      ...overrides,
    };
  }

  it('a Published game: says so, asks no confirmation, sends nothing, removes nothing', async () => {
    const d = deps();
    await cancelGameAssignment(published, d);
    expect(d.say).toHaveBeenCalledWith(cancelRefusal(published));
    expect(d.say.mock.calls[0][0]).toBe(
      'A vs B was not cancelled: it is Published. Use Allow changes on it first, then cancel it.'
    );
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.rpc).not.toHaveBeenCalled();
    expect(d.onCancelled).not.toHaveBeenCalled();
  });

  it.each([
    ['a game that is not Published', plain],
    ['a game with changes allowed', changesAllowed],
  ])('control: %s is confirmed, cancelled and removed as before', async (_label, game) => {
    const d = deps();
    await cancelGameAssignment(game, d);
    expect(d.confirm).toHaveBeenCalledTimes(1);
    expect(d.rpc).toHaveBeenCalledWith('admin_cancel_game_assignment', {
      p_assignment_id: game.id,
    });
    expect(d.onCancelled).toHaveBeenCalledWith(game.id);
    expect(d.say).not.toHaveBeenCalled();
  });

  it('a confirmation declined sends nothing', async () => {
    const d = deps({ confirm: vi.fn(() => false) });
    await cancelGameAssignment(plain, d);
    expect(d.rpc).not.toHaveBeenCalled();
    expect(d.onCancelled).not.toHaveBeenCalled();
  });

  it('the database refusing a Published game (a stale card) is shown in its words and nothing is removed', async () => {
    const d = deps({
      rpc: vi.fn(async () => ({
        error: {
          message: 'game ga-9 is Published and cannot be cancelled: allow changes to it first',
        },
      })),
    });
    await cancelGameAssignment(plain, d);
    expect(d.fail).toHaveBeenCalledWith(
      'game ga-9 is Published and cannot be cancelled: allow changes to it first'
    );
    expect(d.onCancelled).not.toHaveBeenCalled();
  });
});

describe('applying a move of a game that has a history says it is a new game', () => {
  it('a game with changes allowed, moved and applied: the status line says it starts not Published', async () => {
    await openGrid();
    fireEvent.click(screen.getByText('keyboard-move ga-3'));
    const apply = await screen.findByRole('button', { name: /apply schedule/i });
    await waitFor(() => expect(apply).toBeEnabled());
    fireEvent.click(apply);
    expect(
      await screen.findByText(/Game schedule applied through the persistence workflow\./)
    ).toHaveTextContent(
      '1 moved game was saved as a new game: it starts not Published, so publish it again.'
    );
  });

  // What the E2E feature used to read from the captured request (a payload assertion is not a DOM assertion): the page
  // hands the save the moved game at its new slot and week, and every Published game exactly where it was, which is
  // what the database's omission check requires (`publishedOmissions` is its twin).
  it('the save carries the moved game at its new slot and week, and every Published game where it was', async () => {
    await openGrid();
    const saved = getMockData('game_assignments');
    fireEvent.click(screen.getByText('keyboard-move ga-3'));
    const apply = await screen.findByRole('button', { name: /apply schedule/i });
    await waitFor(() => expect(apply).toBeEnabled());
    fireEvent.click(apply);
    await screen.findByText(/Game schedule applied through the persistence workflow\./);
    expect(SAVES.calls).toHaveLength(1);
    const sent = SAVES.calls[0].assignments;
    // All six games are in the save: a game left out is not a deleted game, it is a refused save when Published.
    expect(sent).toHaveLength(6);
    const matchup = (home, away) =>
      sent.filter((a) => a.homeTeamId === home && a.awayTeamId === away);
    // ga-3 (team-2 v team-3, saved on f-south, slot gs-3, week 2) moved to f-north / gs-7 (week 3).
    const [moved] = matchup('team-2', 'team-3');
    expect(moved).toMatchObject({ fieldId: 'f-north', slotId: 'gs-7', weekIndex: 3 });
    // A move to another slot or week is another matchup tuple: a NEW row, not an update of ga-3 (lesson 95).
    const ga3 = saved.find((g) => g.id === 'ga-3');
    expect([ga3.game_slot_id, ga3.week_index]).not.toEqual([moved.slotId, moved.weekIndex]);
    // The Published games (ga-1: team-1 v team-2; ga-5: team-4 v team-6) are saved where they were.
    expect(matchup('team-1', 'team-2')[0]).toMatchObject({
      fieldId: 'f-north',
      slotId: 'gs-1',
      weekIndex: 1,
    });
    expect(matchup('team-4', 'team-6')[0]).toMatchObject({
      fieldId: 'f-south',
      slotId: 'gs-5',
      weekIndex: 2,
    });
    // The oracle is the database's omission check: none left out. And it can fail: leave one Published game out.
    expect(publishedOmissions(saved, sent)).toEqual([]);
    const withoutGa1 = sent.filter(
      (a) => !(a.homeTeamId === 'team-1' && a.awayTeamId === 'team-2')
    );
    expect(publishedOmissions(saved, withoutGa1).map((g) => g.id)).toEqual(['ga-1']);
  });

  it('control: a game that was never published, moved and applied, has no such sentence', async () => {
    await openGrid();
    fireEvent.click(screen.getByText('keyboard-move ga-2'));
    const apply = await screen.findByRole('button', { name: /apply schedule/i });
    await waitFor(() => expect(apply).toBeEnabled());
    fireEvent.click(apply);
    const line = await screen.findByText(
      /Game schedule applied through the persistence workflow\./
    );
    expect(line).not.toHaveTextContent(/new game/);
  });
});
