import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import GameConflictBanner from '../frontend/src/components/scheduling/GameConflictBanner.jsx';

const HARD_CONFLICTS = [
  {
    type: 'field-overlap',
    message: 'Field v1 has overlapping games',
    details: { fieldId: 'v1', conflicts: [] },
  },
  {
    type: 'coach-conflict',
    message: 'Coach coach-a has overlapping games across teams',
    details: { coachId: 'coach-a', conflicts: [] },
  },
];

const SOFT_WARNINGS = [
  {
    type: 'unscheduled-matchups',
    message: '2 matchup(s) could not be scheduled (no-slot: 2).',
    details: { total: 2 },
  },
  {
    type: 'shared-slot-imbalance',
    message: 'Shared slot gs-5 has uneven division distribution',
    details: {},
  },
];

const ALL_WARNINGS = [...HARD_CONFLICTS, ...SOFT_WARNINGS];

describe('GameConflictBanner', () => {
  test('renders nothing when warnings is empty', () => {
    const { container } = render(<GameConflictBanner warnings={[]} />);
    expect(container.firstChild).toBeNull();
  });

  test('renders nothing when warnings is null', () => {
    const { container } = render(<GameConflictBanner warnings={null} />);
    expect(container.firstChild).toBeNull();
  });

  test('renders the banner with correct conflict count', () => {
    render(<GameConflictBanner warnings={ALL_WARNINGS} />);
    expect(screen.getByTestId('game-conflict-banner')).toBeInTheDocument();
    expect(screen.getByText(/2 Conflicts Detected/)).toBeInTheDocument();
    expect(screen.getByText('4 total issues')).toBeInTheDocument();
  });

  test('shows "Warning" header when only soft warnings present', () => {
    render(<GameConflictBanner warnings={SOFT_WARNINGS} />);
    expect(screen.getByText(/2 Warnings/)).toBeInTheDocument();
  });

  test('shows singular "Conflict" for exactly one hard conflict', () => {
    render(<GameConflictBanner warnings={[HARD_CONFLICTS[0]]} />);
    expect(screen.getByText(/1 Conflict Detected/)).toBeInTheDocument();
  });

  test('renders all conflict items with correct test IDs', () => {
    render(<GameConflictBanner warnings={ALL_WARNINGS} />);
    expect(screen.getAllByTestId('conflict-item-field-overlap')).toHaveLength(1);
    expect(screen.getAllByTestId('conflict-item-coach-conflict')).toHaveLength(1);
    expect(screen.getAllByTestId('conflict-item-unscheduled-matchups')).toHaveLength(1);
    expect(screen.getAllByTestId('conflict-item-shared-slot-imbalance')).toHaveLength(1);
  });

  test('displays human-readable type labels', () => {
    render(<GameConflictBanner warnings={HARD_CONFLICTS} />);
    expect(screen.getByText('Field Overlap')).toBeInTheDocument();
    expect(screen.getByText('Coach Conflict')).toBeInTheDocument();
  });

  test('displays warning messages', () => {
    render(<GameConflictBanner warnings={ALL_WARNINGS} />);
    expect(screen.getByText('Field v1 has overlapping games')).toBeInTheDocument();
    expect(
      screen.getByText('Coach coach-a has overlapping games across teams')
    ).toBeInTheDocument();
  });

  test('hard conflicts render before soft warnings', () => {
    render(<GameConflictBanner warnings={ALL_WARNINGS} />);
    const items = screen.getByTestId('conflict-list').children;
    // First two should be hard conflicts
    expect(items[0]).toHaveAttribute('data-testid', 'conflict-item-field-overlap');
    expect(items[1]).toHaveAttribute('data-testid', 'conflict-item-coach-conflict');
    // Last two should be soft warnings
    expect(items[2]).toHaveAttribute('data-testid', 'conflict-item-unscheduled-matchups');
    expect(items[3]).toHaveAttribute('data-testid', 'conflict-item-shared-slot-imbalance');
  });

  test('a home-away-imbalance is a labelled advisory, not a conflict', () => {
    const imbalance = {
      type: 'home-away-imbalance',
      message: 'Team A hosts 3 of its 3 games (0 away)',
      details: { teamId: 'A', homeGames: 3, awayGames: 0, totalGames: 3, unscheduledGames: 0 },
    };
    // Alone, it is a warning: no "Conflict" in the header.
    const { unmount } = render(<GameConflictBanner warnings={[imbalance]} />);
    expect(screen.getByText(/1 Warning/)).toBeInTheDocument();
    expect(screen.queryByText(/Conflicts? Detected/)).not.toBeInTheDocument();
    expect(screen.getByText('Home/Away')).toBeInTheDocument();
    unmount();
    // Beside a hard conflict it is not counted as one, and sorts after it.
    render(<GameConflictBanner warnings={[imbalance, ...HARD_CONFLICTS]} />);
    expect(screen.getByText(/2 Conflicts Detected/)).toBeInTheDocument();
    const items = screen.getByTestId('conflict-list').children;
    expect(items[2]).toHaveAttribute('data-testid', 'conflict-item-home-away-imbalance');
  });

  test('collapse/expand toggle hides and shows conflict list', () => {
    render(<GameConflictBanner warnings={ALL_WARNINGS} />);
    // List should be visible initially
    expect(screen.getByTestId('conflict-list')).toBeInTheDocument();

    // Click the header button to collapse
    fireEvent.click(screen.getByText(/2 Conflicts Detected/));
    expect(screen.queryByTestId('conflict-list')).not.toBeInTheDocument();

    // Click again to expand
    fireEvent.click(screen.getByText(/2 Conflicts Detected/));
    expect(screen.getByTestId('conflict-list')).toBeInTheDocument();
  });

  test('calls onConflictClick with warning when a conflict item is clicked', () => {
    const onClick = vi.fn();
    render(<GameConflictBanner warnings={HARD_CONFLICTS} onConflictClick={onClick} />);

    fireEvent.click(screen.getByTestId('conflict-item-field-overlap'));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith(HARD_CONFLICTS[0]);
  });

  test('conflict items are not clickable when onConflictClick is not provided', () => {
    render(<GameConflictBanner warnings={HARD_CONFLICTS} />);
    const item = screen.getByTestId('conflict-item-field-overlap');
    expect(item).toBeDisabled();
  });

  test('has role="alert" for accessibility', () => {
    render(<GameConflictBanner warnings={HARD_CONFLICTS} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
