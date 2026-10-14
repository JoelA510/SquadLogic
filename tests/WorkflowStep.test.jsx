import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import WorkflowStep from '../frontend/src/components/WorkflowStep.jsx';

describe('WorkflowStep', () => {
  it('allows active expanded content to overflow for nested panels and tooltips', () => {
    render(
      <WorkflowStep
        title="Data Import"
        description="Upload CSVs."
        status="active"
        onClick={() => {}}
      >
        <div>Expanded child</div>
      </WorkflowStep>
    );

    const step = screen.getByTestId('workflow-step-data-import');
    expect(step).toHaveClass('min-w-0', 'overflow-visible');

    const expandedGrid = step.querySelector('.grid');
    expect(expandedGrid).toHaveClass('min-w-0', 'overflow-visible', 'grid-rows-[1fr]');

    const expandedContent = screen.getByText('Expanded child').parentElement;
    expect(expandedContent).toHaveClass('min-w-0');
    expect(expandedContent?.parentElement).toHaveClass('min-w-0', 'overflow-visible');
  });

  it('keeps inactive expanded content clipped for the collapsed animation', () => {
    render(
      <WorkflowStep
        title="Data Import"
        description="Upload CSVs."
        status="pending"
        onClick={() => {}}
      >
        <div>Collapsed child</div>
      </WorkflowStep>
    );

    const step = screen.getByTestId('workflow-step-data-import');
    expect(step).toHaveClass('min-w-0', 'overflow-visible');

    const expandedGrid = step.querySelector('.grid');
    expect(expandedGrid).toHaveClass('overflow-hidden', 'grid-rows-[0fr]');

    const collapsedContent = screen.getByText('Collapsed child').parentElement;
    expect(collapsedContent?.parentElement).toHaveClass('min-w-0', 'overflow-hidden');
  });

  // M4.2: the card's click handler was mouse-only; a keyboard user could not open a step.
  it('opens a step from a focusable heading button, once per press', () => {
    const onClick = vi.fn();
    render(
      <WorkflowStep
        title="Data Import"
        description="Upload CSVs."
        status="pending"
        onClick={onClick}
      >
        <div>Collapsed child</div>
      </WorkflowStep>
    );

    const control = screen.getByRole('button', { name: 'Data Import' });
    expect(control.closest('h2')).not.toBeNull();
    expect(control).toHaveAttribute('aria-expanded', 'false');
    control.focus();
    expect(control).toHaveFocus();
    // Enter and Space on a native button arrive as a click; the card's own handler must not
    // run the step change a second time.
    fireEvent.click(control);
    expect(onClick).toHaveBeenCalledTimes(1);
    // The rest of the card still works for the mouse.
    fireEvent.click(screen.getByText('Upload CSVs.'));
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('disables the heading button of a locked step', () => {
    const onClick = vi.fn();
    render(
      <WorkflowStep
        title="Data Import"
        description="Upload CSVs."
        status="locked"
        onClick={onClick}
      >
        <div>Locked child</div>
      </WorkflowStep>
    );

    const control = screen.getByRole('button', { name: 'Data Import' });
    expect(control).toBeDisabled();
    fireEvent.click(control);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('marks the active step expanded', () => {
    render(
      <WorkflowStep
        title="Data Import"
        description="Upload CSVs."
        status="active"
        onClick={() => {}}
      >
        <div>Expanded child</div>
      </WorkflowStep>
    );
    expect(screen.getByRole('button', { name: 'Data Import' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });
});
