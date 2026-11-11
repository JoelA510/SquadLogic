/**
 * F11-2 task B3 (docs/changes/2026-11-06-games-table-source-of-truth.md, "The held rule"): a game with a score is held
 * where it is, like a Published one, and the Games page refuses to move or cancel it in the friendly half of the guard
 * (the database refuses regardless: supabase/tests/game_scores.sql). Beside PR 3's tests/gameGridPublishedGuards.test.jsx,
 * whose scaffold this file shares: the real page over the real mock client, the page's own `moveGame` and `onDragEnd`.
 *
 * The page learns which games are scored from `useGameAssignments` (one read of `game_scores`), and asks core's
 * `isHeld`, the one JS twin of the database's predicate. Each refusal sits beside a control: the same game with no score
 * is staged, so a guard that refused everything fails. `ga-2` is a game of the world that is NOT Published.
 */
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG, SEASON, TZ, seedWorld } from './helpers/publishedGamesWorld.js';
import { cancelRefusal, moveRefusal } from '../frontend/src/utils/gamePublishedText.js';
import { holdReason, isHeld } from '../packages/core/src/gameIdentity.js';

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

const {
  default: GameSchedulingPage,
  cancelGameAssignment,
  describeKeptPublished,
} = await import('../frontend/src/pages/GameSchedulingPage.jsx');
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

async function openGrid(scoredIds = []) {
  seedWorld({ scoredIds });
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

describe('a scored game is not moved', () => {
  const drop = (id) =>
    act(() => {
      DND.props.onDragEnd({ active: { id }, over: { id: 'f-north:gs-7' } });
    });

  it('"Move to" is refused in the words of a scored game, and nothing is staged', async () => {
    await openGrid(['ga-2']);
    fireEvent.click(screen.getByText('keyboard-move ga-2'));
    expect(statusLine()).toHaveTextContent(
      /was not moved: it has a score\. Clear its score first\./
    );
    expect(statusLine()).not.toHaveTextContent(/Published/);
    expect(stagedBanner()).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /apply schedule/i })).not.toBeInTheDocument();
  });

  it('control: the same game with no score is staged to the same cell', async () => {
    await openGrid();
    fireEvent.click(screen.getByText('keyboard-move ga-2'));
    expect(await screen.findByText(/Manual game move staged/)).toBeInTheDocument();
  });

  it('a drop is refused with the same sentence', async () => {
    await openGrid(['ga-2']);
    await drop('ga-2');
    expect(statusLine()).toHaveTextContent(
      /was not moved: it has a score\. Clear its score first\./
    );
    expect(stagedBanner()).not.toBeInTheDocument();
  });

  it('a Published game that also has a score is refused as Published (changes must be allowed first)', async () => {
    await openGrid(['ga-1']);
    fireEvent.click(screen.getByText('keyboard-move ga-1'));
    expect(statusLine()).toHaveTextContent(
      /was not moved: it is Published\. Use Allow changes on it first\./
    );
  });

  it('the sentences are the ones the helper writes, from the one predicate', () => {
    const scored = { published: false, scored: true, homeTeamName: 'A', awayTeamName: 'B' };
    expect(isHeld(scored)).toBe(true);
    expect(holdReason(scored)).toBe('scored');
    expect(holdReason({ published: true, scored: true })).toBe('published');
    expect(holdReason({ published: false, scored: false })).toBe(null);
    // Only a boolean true is a score: the flag comes from a read, and a string is not one.
    expect(isHeld({ published: false, scored: 'true' })).toBe(false);
    expect(moveRefusal(scored)).toBe(
      'A vs B was not moved: it has a score. Clear its score first.'
    );
    expect(cancelRefusal(scored)).toBe(
      'A vs B was not cancelled: it has a score. Clear its score first, then cancel it.'
    );
  });
});

describe('a scored game is not cancelled', () => {
  const scored = {
    id: 'ga-2',
    published: false,
    scored: true,
    homeTeamName: 'E',
    awayTeamName: 'F',
  };
  const plain = {
    id: 'ga-2',
    published: false,
    scored: false,
    homeTeamName: 'E',
    awayTeamName: 'F',
  };
  const deps = () => ({
    confirm: vi.fn(() => true),
    rpc: vi.fn(async () => ({ error: null })),
    say: vi.fn(),
    fail: vi.fn(),
    onCancelled: vi.fn(),
  });

  it('says so, asks no confirmation, sends nothing, removes nothing', async () => {
    const d = deps();
    await cancelGameAssignment(scored, d);
    expect(d.say).toHaveBeenCalledWith(
      'E vs F was not cancelled: it has a score. Clear its score first, then cancel it.'
    );
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.rpc).not.toHaveBeenCalled();
    expect(d.onCancelled).not.toHaveBeenCalled();
  });

  it('control: the same game with no score is confirmed and cancelled', async () => {
    const d = deps();
    await cancelGameAssignment(plain, d);
    expect(d.confirm).toHaveBeenCalledTimes(1);
    expect(d.rpc).toHaveBeenCalledTimes(1);
    expect(d.onCancelled).toHaveBeenCalledTimes(1);
  });
});

describe('what a regeneration says it kept', () => {
  it('counts the Published games and the games held by a score apart', () => {
    expect(describeKeptPublished(3)).toBe('3 Published games kept as they are.');
    expect(describeKeptPublished(1, 0)).toBe('1 Published game kept as it is.');
    expect(describeKeptPublished(0, 1)).toBe('1 game with a score kept as it is.');
    expect(describeKeptPublished(2, 4)).toBe(
      '2 Published games kept as they are. 4 games with a score kept as they are.'
    );
  });
});
