/**
 * The manual roster editor, rendered: readable cards, and a way to move a player that is not a
 * drag (AGENTS.md section 9). Structure is checked here (no clipped or nested-scroll boxes, a
 * named handle and Move control per player, a labelled dialog); contrast and the axe scan of the
 * live page, in both themes, are in tests/e2e/features/roster_editor.feature.
 */
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import RosterManager from '../frontend/src/components/teaming/RosterManager.jsx';

const longName = 'Maximilian Bartholomew Featherstonehaugh-Cholmondeley';

const makeTeams = () => [
  {
    id: 't1',
    name: 'U4A',
    division: 'U4',
    coachId: 'c1',
    coachName: 'Coach Elm',
    players: [
      { id: 'p1', name: longName, skill: '3', assignment_source: 'auto' },
      { id: 'p2', name: 'Blake Birch', isCoachingLead: true },
    ],
  },
  { id: 't2', name: 'U4B', division: 'U4', players: [{ id: 'p3', name: 'Casey Cedar' }] },
  { id: 't3', name: 'U5 Girls 1', division: 'U5 Girls', players: [] },
];

describe('RosterManager view', () => {
  it('shows each player in full with their skill, and no card has a scroll box of its own', () => {
    render(<RosterManager initialTeams={makeTeams()} onTeamsChange={() => {}} />);
    const card = screen.getByTestId('player-card-p1');
    expect(within(card).getByText(longName)).toBeInTheDocument();
    expect(within(card).getByText('Skill: 3')).toBeInTheDocument();
    // A player with no skill on file is unrated, not an invented tier.
    expect(within(screen.getByTestId('player-card-p2')).getByText('Skill: Unrated')).toBeVisible();
    for (const column of screen.getAllByTestId(/^team-column-/)) {
      expect(column.className).not.toMatch(/overflow|h-\[/);
      expect(column.querySelector('[style*="overflow"], [style*="height"]')).toBeNull();
    }
    expect(screen.getByText('2 Players')).toBeInTheDocument();
    expect(screen.getByText('1 Player')).toBeInTheDocument();
  });

  it('gives every player a named drag handle and a named Move button, and every team a heading', () => {
    render(<RosterManager initialTeams={makeTeams()} onTeamsChange={() => {}} />);
    expect(screen.getByRole('button', { name: `Drag ${longName}` })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: `Move ${longName} to another team` })
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'U4A' })).toBeInTheDocument();
    // No control nested inside a control.
    for (const handle of screen.getAllByRole('button', { name: /^Drag / })) {
      expect(handle.querySelector('button, a, input, select')).toBeNull();
    }
  });

  it('moves a player with the keyboard-reachable dialog, marks it manual and reports it', () => {
    const onTeamsChange = vi.fn();
    render(<RosterManager initialTeams={makeTeams()} onTeamsChange={onTeamsChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Move Casey Cedar to another team' }));
    const dialog = screen.getByRole('dialog', { name: 'Move Casey Cedar' });
    const select = within(dialog).getByLabelText('Destination team');
    expect(select).toHaveFocus();
    // The current team cannot be chosen, and the move waits for a choice.
    expect(within(dialog).getByRole('option', { name: /U4B.*current team/ })).toBeDisabled();
    const move = within(dialog).getByRole('button', { name: 'Move player' });
    expect(move).toBeDisabled();

    fireEvent.change(select, { target: { value: 't3' } });
    expect(move).toBeEnabled();
    fireEvent.click(move);

    expect(screen.queryByRole('dialog')).toBeNull();
    const moved = within(screen.getByTestId('team-column-t3')).getByTestId('player-card-p3');
    expect(within(moved).getByText('manual')).toBeInTheDocument();
    expect(within(screen.getByTestId('team-column-t2')).queryByTestId('player-card-p3')).toBeNull();
    // Focus follows the player to their new card, so a keyboard user keeps their place.
    expect(within(moved).getByRole('button', { name: /^Move Casey Cedar/ })).toHaveFocus();
    expect(onTeamsChange).toHaveBeenCalledTimes(1);
    const saved = onTeamsChange.mock.calls[0][0];
    expect(saved.find((t) => t.id === 't3').players.map((p) => p.id)).toEqual(['p3']);
    expect(screen.getByText('Moved Casey Cedar from U4B to U5 Girls 1')).toBeInTheDocument();
  });

  it('Cancel moves nobody', () => {
    const onTeamsChange = vi.fn();
    render(<RosterManager initialTeams={makeTeams()} onTeamsChange={onTeamsChange} />);
    fireEvent.click(screen.getByRole('button', { name: `Move ${longName} to another team` }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onTeamsChange).not.toHaveBeenCalled();
  });

  it('filters the cards by division without losing the others from the Move choices', () => {
    render(<RosterManager initialTeams={makeTeams()} onTeamsChange={() => {}} />);
    fireEvent.change(screen.getByLabelText('Show division'), { target: { value: 'U5 Girls' } });
    expect(screen.queryByTestId('team-column-t1')).toBeNull();
    expect(screen.getByTestId('team-column-t3')).toBeInTheDocument();
    expect(screen.getByText('No players yet. Drop a player here, or use Move.')).toBeVisible();
  });
});
