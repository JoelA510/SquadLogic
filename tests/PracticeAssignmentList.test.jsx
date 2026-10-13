import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PracticeAssignmentList from '../frontend/src/components/PracticeAssignmentList.jsx';

const assignment = {
  id: 'practice-assignment-1',
  source: 'auto',
  effectiveDateRange: '[2026-03-01,2026-05-31)',
  teams: {
    name: 'Blue Tigers',
    divisions: {
      name: 'U10',
    },
  },
  practiceSlots: {
    dayOfWeek: 'monday',
    startTime: '17:30:00',
    endTime: '18:30:00',
    fields: {
      name: 'Main Field',
    },
  },
};

describe('PracticeAssignmentList', () => {
  it('labels unlocked lock controls and toggles them to manual source', () => {
    const onToggleLock = vi.fn();

    render(<PracticeAssignmentList assignments={[assignment]} onToggleLock={onToggleLock} />);

    const lockButton = screen.getByRole('button', {
      name: 'Manual choice: Blue Tigers',
    });
    expect(lockButton).toHaveAttribute('type', 'button');
    expect(lockButton).toHaveAttribute('aria-pressed', 'false');
    // Provenance, not a lock (ruling 2, plan Q1): no title promises an unlock.
    expect(lockButton).toHaveAttribute('title', 'Mark as manual choice');
    expect(lockButton.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(lockButton);
    expect(onToggleLock).toHaveBeenCalledWith('practice-assignment-1', 'manual');
  });

  it('labels locked controls and toggles them back to auto source', () => {
    const onToggleLock = vi.fn();
    const lockedAssignment = {
      ...assignment,
      source: 'manual',
    };

    render(<PracticeAssignmentList assignments={[lockedAssignment]} onToggleLock={onToggleLock} />);

    const unlockButton = screen.getByRole('button', {
      name: 'Manual choice: Blue Tigers',
    });
    expect(unlockButton).toHaveAttribute('aria-pressed', 'true');
    expect(unlockButton).toHaveAttribute('title', 'Mark as automatic');
    expect(document.body.textContent).not.toMatch(/allow algorithm to change|unlock slot/i);

    fireEvent.click(unlockButton);
    expect(onToggleLock).toHaveBeenCalledWith('practice-assignment-1', 'auto');
  });

  it('explains disabled lock controls when edit permission is unavailable', () => {
    render(<PracticeAssignmentList assignments={[assignment]} />);

    const disabledButton = screen.getByRole('button', {
      name: 'Manual choice mark for Blue Tigers requires schedule edit permission',
    });
    expect(disabledButton).toBeDisabled();
    expect(disabledButton).toHaveAttribute(
      'title',
      'Changing the manual-choice mark requires schedule edit permission'
    );
  });
});
