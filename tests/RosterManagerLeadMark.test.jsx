/**
 * The roster editor marks a coaching lead beside the player's name (Phase B6,
 * docs/changes/2026-10-22-phase-b-teaming.md): a mark only, read from the run's rosters by the
 * Teams page (`isCoachingLead`). A lead is not a coach.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { describe, expect, it } from 'vitest';

import { SortablePlayer } from '../frontend/src/components/teaming/RosterManager.jsx';

const card = (player) =>
  render(
    <DndContext>
      <SortablePlayer player={player} />
    </DndContext>
  );

describe('RosterManager :: the Lead mark', () => {
  it('marks a coaching lead, in the text and in the card name', () => {
    card({ id: 'p1', name: 'Ada One', skill: 'developing', isCoachingLead: true });
    expect(screen.getByText('lead')).toHaveAttribute(
      'title',
      'Coaching lead: a parent volunteers to coach'
    );
    expect(screen.getByTestId('player-card-p1')).toHaveAttribute(
      'aria-label',
      'Ada One, Skill: developing, coaching lead'
    );
  });

  it('POSITIVE CONTROL: a player who is not a lead carries no mark', () => {
    card({ id: 'p2', name: 'Bea Two', skill: 'developing' });
    expect(screen.queryByText('lead')).toBeNull();
    expect(screen.getByTestId('player-card-p2')).toHaveAttribute(
      'aria-label',
      'Bea Two, Skill: developing'
    );
  });
});
